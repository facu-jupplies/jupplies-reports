/**
 * Servicio TikTok Shop — motor P&L para pedidos de TTS via Shopify/Windsor.
 * Portado desde engine.py.
 */

const { parseSku, inferGroupFromCampaignName } = require('./calculator');

const WINDSOR_BASE = 'https://connectors.windsor.ai';

// Windsor conector tiktok_shop: solo expone order_id y order_status
// (no tiene SKU, precio ni datos de afiliados — eso viene del CSV del usuario)
const WINDSOR_FIELDS_TIKTOK = 'date,order_id,order_status';

function round(n, decimals = 2) {
  return Math.round(((n || 0) + Number.EPSILON) * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

/**
 * Obtiene pedidos TTS desde el conector tiktok_shop de Windsor.
 * Solo devuelve order_id + order_status (Windsor no expone SKU/precio en este conector).
 * El revenue y SKU se enriquecen desde el CSV de afiliados en buildOrders().
 *
 * @param {string} date           YYYY-MM-DD
 * @param {string} apiKey         Windsor API key
 * @param {string} tiktokAccount  Windsor account ID (e.g. "ESESLCDL7L87")
 * @returns {Array} filas crudas de Windsor [{date, order_id, order_status}]
 */
async function fetchTTSOrders(date, apiKey, tiktokAccount) {
  const store = `tiktok_shop__${tiktokAccount}`;
  const url = new URL(`${WINDSOR_BASE}/all`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('select_accounts', store);
  url.searchParams.set('fields', WINDSOR_FIELDS_TIKTOK);
  url.searchParams.set('date_from', date);
  url.searchParams.set('date_to', date);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Windsor TTS error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

/**
 * Parsea el campo line_item__discount_allocations de Windsor.
 * Windsor devuelve formato Python-like:
 *   [{'allocatedAmountSet': {'shopMoney': {'amount': '2.56', 'currencyCode': 'EUR'}, ...}}]
 * Suma todos los allocatedAmountSet.shopMoney.amount de la lista.
 * Este importe es el descuento real aplicado por TikTok vouchers a esta línea.
 */
function parseDiscountAllocations(raw) {
  if (!raw || raw === '[]' || raw.trim() === '') return 0;
  try {
    // Buscar todos los valores shopMoney.amount en el string (formato Python-like de Windsor)
    const re = /'shopMoney':\s*\{[^}]*'amount':\s*'([\d.]+)'/g;
    let total = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      total += parseFloat(m[1]) || 0;
    }
    if (total > 0) return total;

    // Fallback: convertir comillas simples Python → JSON e intentar parsear
    const clean = raw
      .replace(/'/g, '"')
      .replace(/\bNone\b/g, 'null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false');
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed)) {
      return parsed.reduce((s, d) => {
        const amt = d?.allocatedAmountSet?.shopMoney?.amount;
        return s + (parseFloat(amt) || 0);
      }, 0);
    }
  } catch (_) { /* ignorar errores de parseo */ }
  return 0;
}

/**
 * Extrae el TikTok Order ID del campo order_tags.
 * Formato esperado de tag: "TikTokOrderID:XXXXXXXXX"
 */
function extractTikTokOrderId(tagsRaw) {
  if (!tagsRaw) return null;
  const match = String(tagsRaw).match(/TikTokOrderID[:\s]+(\d+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Construye array de pedidos a partir de filas del conector tiktok_shop de Windsor.
 * Windsor solo aporta order_id + order_status; el revenue y SKU vienen del CSV de afiliados.
 *
 * @param {Array}  windsorRows       [{date, order_id, order_status}] del conector tiktok_shop
 * @param {Object} skuMap            Mapa sku → skuData (tabla skus)
 * @param {Object} affiliateByOrder  Mapa orderId → fila enriquecida del CSV de afiliados
 *                                   (con campos: skus[], settlementAmount, totalQuantity, ...)
 * @returns {Array} pedidos normalizados
 */
function buildOrders(windsorRows, skuMap, affiliateByOrder = {}) {
  // Indexar Windsor por order_id para consultar status
  const windsorStatus = {};
  for (const row of windsorRows) {
    const id = String(row.order_id || '').trim();
    if (id) windsorStatus[id] = (row.order_status || '').toUpperCase();
  }

  // Fuente principal: CSV de afiliados (tiene todos los pedidos)
  // Windsor solo aporta el status (CANCELLED vs válido)
  // Si no hay CSV, usar Windsor como fallback
  const sourceIds = Object.keys(affiliateByOrder).length > 0
    ? Object.keys(affiliateByOrder)
    : Object.keys(windsorStatus);

  const orders = [];

  for (const orderId of sourceIds) {
    if (!orderId) continue;

    // Status: Windsor si está, sino 'valid' (el CSV no tiene cancelados)
    const wsStatus = windsorStatus[orderId];
    const isCancelled = wsStatus === 'CANCELLED';
    const status = isCancelled ? 'cancelled' : 'valid';

    const af = affiliateByOrder[orderId];

    let revenue    = 0;
    let cogs       = 0;
    let maxShipping = 0;
    let totalUnits = 1;
    let primarySku = '';
    let grupo      = '';

    if (af) {
      totalUnits = af.totalQuantity || 1;

      const skuList = (af.skus && af.skus.length > 0)
        ? af.skus
        : (af.sellerSku ? [af.sellerSku] : []);

      for (const rawSku of skuList) {
        const sku     = rawSku.toUpperCase().trim();
        if (!sku) continue;
        const skuData = skuMap[sku]
          || skuMap[sku.replace(/-[A-Z0-9]+$/, '-')]
          || skuMap[sku.replace(/-[A-Z0-9]+$/, '')];

        if (skuData) {
          const skuQty = Math.max(1, Math.round(totalUnits / skuList.length));
          cogs += (skuData.cost || 0) * skuQty;
          if ((skuData.shipping_es || 0) > maxShipping) maxShipping = skuData.shipping_es || 0;
          if (!primarySku) {
            primarySku = sku;
            grupo      = skuData.grupo || sku;
          }
        } else {
          if (!primarySku) {
            primarySku = sku;
            grupo      = sku;
          }
        }
      }

      revenue = af.settlementAmount > 0 ? af.settlementAmount : 0;

      if (!primarySku && af.sellerSku) {
        primarySku = af.sellerSku.toUpperCase();
        grupo      = primarySku;
      }
    }

    const shipping = maxShipping > 0
      ? maxShipping * (1 + Math.max(0, totalUnits - 1) * 0.1)
      : 0;

    orders.push({
      order_name:      orderId,
      tikTokOrderId:   orderId,
      status,
      revenue:         round(revenue),
      cogs:            round(cogs),
      shipping:        round(shipping),
      grupo:           grupo || 'SIN GRUPO',
      primary_sku:     primarySku,
      order_type:      'organico',
      commission_cost: 0,
      gmv_max_spend:   0,
    });
  }

  // También agregar pedidos de Windsor que NO están en el CSV (orgánicos sin afiliado)
  for (const [id, wsStatus] of Object.entries(windsorStatus)) {
    if (affiliateByOrder[id]) continue; // ya procesado
    if (wsStatus === 'CANCELLED') continue;

    orders.push({
      order_name: id, tikTokOrderId: id, status: 'valid',
      revenue: 0, cogs: 0, shipping: 0,
      grupo: 'SIN GRUPO', primary_sku: '',
      order_type: 'organico', commission_cost: 0, gmv_max_spend: 0,
    });
  }

  return orders;
}

// parseDiscountAllocations y extractTikTokOrderId están definidas arriba (líneas 51-88).
// Se mantienen por si se necesitan en el futuro.

/**
 * Clasifica pedidos por tipo.
 *
 * Como los IDs de TikTok (CSV) y Simla no matchean, usamos totales globales:
 * del CSV contamos cuántos son paid_afiliado, afiliado org, y propio,
 * y la comisión total. Luego distribuimos entre los pedidos de Simla.
 */
function classifyOrders(orders, affiliateRows) {
  if (!affiliateRows || affiliateRows.length === 0) return orders;

  // 1. Del CSV, contar totales: cuántos paid_afil, org_afil + comisiones totales
  let totalPaidAfil = 0, totalOrgAfil = 0, totalOrganico = 0;
  let commTotalPaidAfil = 0, commTotalOrgAfil = 0;

  for (const af of affiliateRows) {
    const commPctAds      = parseFloat(af.commPctAds)      || 0;
    const commPctStandard = parseFloat(af.commPctStandard)  || 0;
    const commReal        = parseFloat(af.commReal)         || 0;
    const commRealAds     = parseFloat(af.commRealAds)      || 0;
    const refunded = af.fullyRefunded === true || String(af.fullyRefunded || '').toLowerCase() === 'true';
    const noApto = String(af.orderStatus || '').toLowerCase().includes('no apt');

    if (refunded || noApto) continue;

    if (commPctAds > 0) {
      totalPaidAfil++;
      commTotalPaidAfil += commReal + commRealAds;
    } else if (commPctStandard > 0) {
      totalOrgAfil++;
      commTotalOrgAfil += commReal;
    } else {
      totalOrganico++;
    }
  }

  const totalCSV = totalPaidAfil + totalOrgAfil + totalOrganico;
  console.log(`[TTS classify] CSV: ${totalCSV} (paid_afil:${totalPaidAfil} org_afil:${totalOrgAfil} propio:${totalOrganico}) | Simla: ${orders.filter(o=>o.status==='valid').length} | Comm: paid €${commTotalPaidAfil.toFixed(2)} org €${commTotalOrgAfil.toFixed(2)}`);

  // Comisión promedio por pedido
  const avgCommPaidAfil = totalPaidAfil > 0 ? commTotalPaidAfil / totalPaidAfil : 0;
  const avgCommOrgAfil  = totalOrgAfil  > 0 ? commTotalOrgAfil  / totalOrgAfil  : 0;

  // 2. Asignar tipo: los primeros N pedidos = paid_afil, siguientes M = org_afil, resto = propio
  let paidLeft = totalPaidAfil;
  let orgLeft  = totalOrgAfil;

  return orders.map(order => {
    if (order.status !== 'valid') return order;

    if (paidLeft > 0) {
      paidLeft--;
      return { ...order, order_type: 'paid_afiliado', commission_cost: round(avgCommPaidAfil) };
    }
    if (orgLeft > 0) {
      orgLeft--;
      return { ...order, order_type: 'afiliado', commission_cost: round(avgCommOrgAfil) };
    }
    return { ...order, order_type: 'organico', commission_cost: 0 };
  });
}

/**
 * Asigna el gasto de campañas GMV Max a los pedidos proporcionalmente al revenue.
 *
 * gmvCampaigns: { campaignName: spend }
 */
function allocateGMVMax(orders, gmvCampaigns, skuMap) {
  if (!gmvCampaigns || Object.keys(gmvCampaigns).length === 0) return orders;

  // Separar campañas en: las que matchean un grupo SKU, y las que no (sin_grupo)
  const campaignAllocations = {}; // grupo → spend de campañas que matchearon
  let unassignedSpend = 0;        // spend de campañas que NO matchearon ningún grupo

  for (const [campaignName, spend] of Object.entries(gmvCampaigns)) {
    const spend_ = parseFloat(spend) || 0;
    if (spend_ <= 0) continue;

    const grupo = inferGroupFromCampaignName(campaignName);
    if (grupo) {
      campaignAllocations[grupo] = (campaignAllocations[grupo] || 0) + spend_;
    } else {
      // Campaña sin grupo identificado → acumular para distribución global
      unassignedSpend += spend_;
      console.log(`[GMVMax] Campaña sin grupo → spread global: "${campaignName}" (€${spend_})`);
    }
  }

  const updatedOrders = orders.map(o => ({ ...o }));
  const validOrders = updatedOrders.filter(o => o.status === 'valid');

  // 1. Distribuir spend de campañas con grupo → proporcional al revenue del grupo
  for (const [campaignGrupo, totalSpend] of Object.entries(campaignAllocations)) {
    const matchingOrders = validOrders.filter(o => {
      const g = o.grupo || '';
      const prefix = campaignGrupo.replace(/-$/, '');
      return (
        g === campaignGrupo ||
        g.replace(/-$/, '') === prefix ||
        g.startsWith(campaignGrupo)
      );
    });

    const totalRev = matchingOrders.reduce((s, o) => s + o.revenue, 0);
    if (totalRev <= 0) {
      // Campaña con spend pero sin pedidos del grupo → distribuir globalmente
      unassignedSpend += totalSpend;
      continue;
    }

    for (const order of matchingOrders) {
      order.gmv_max_spend += round((order.revenue / totalRev) * totalSpend);
    }
  }

  // 2. Distribuir spend sin grupo → proporcional al revenue entre TODOS los pedidos válidos
  if (unassignedSpend > 0 && validOrders.length > 0) {
    const totalRevAll = validOrders.reduce((s, o) => s + o.revenue, 0);
    if (totalRevAll > 0) {
      for (const order of validOrders) {
        order.gmv_max_spend += round((order.revenue / totalRevAll) * unassignedSpend);
      }
    }
  }

  return updatedOrders;
}

/**
 * Construye el P&L agrupado por grupo, solo para pedidos válidos.
 *
 * @param {Array}  orders          Array de pedidos (con classifyOrders y allocateGMVMax aplicados)
 * @param {number} ivaPct          IVA en % (e.g. 21)
 * @param {number} ttsCommissionPct Comisión plataforma TikTok en % (e.g. 9)
 * @returns {Array} filas P&L por grupo, ordenadas por net_profit desc
 */
function buildPL(orders, ivaPct, ttsCommissionPct) {
  const iva   = ivaPct           / 100;
  const ttsPC = ttsCommissionPct / 100;

  const grupoStats = {};

  function getStat(grupo) {
    if (!grupoStats[grupo]) {
      grupoStats[grupo] = {
        grupo,
        skus:             new Set(), // SKUs únicos para calcular display_name
        orders:           0,
        orders_propio:    0,
        orders_paid_afil: 0,
        orders_org_afil:  0,
        revenue:          0,
        cogs:             0,
        shipping:         0,
        iva:              0,
        tiktok_platform:  0,
        commission_cost:  0,
        gmv_max_spend:    0,
        seller_discount:  0,
        gross_profit:     0,
        net_profit:       0,
      };
    }
    return grupoStats[grupo];
  }

  for (const order of orders) {
    if (order.status !== 'valid') continue;

    const g = getStat(order.grupo || 'SIN GRUPO');
    if (order.primary_sku) g.skus.add(order.primary_sku);

    // Calcular componentes P&L del pedido
    const rev         = order.revenue;
    const ivaAmt      = rev - rev / (1 + iva);
    const ttsPlatform = rev * ttsPC;
    const grossProfit = rev - ivaAmt - order.cogs - order.shipping - ttsPlatform;
    const netProfit   = grossProfit - order.commission_cost - order.gmv_max_spend;

    g.orders           += 1;
    g.revenue          += rev;
    g.cogs             += order.cogs;
    g.shipping         += order.shipping;
    g.iva              += ivaAmt;
    g.tiktok_platform  += ttsPlatform;
    g.commission_cost  += order.commission_cost;
    g.gmv_max_spend    += order.gmv_max_spend;
    g.seller_discount  += 0; // descuentos no disponibles via Windsor TTS
    g.gross_profit     += grossProfit;
    g.net_profit       += netProfit;

    if (order.order_type === 'organico')        g.orders_propio    += 1;
    if (order.order_type === 'paid_afiliado')   g.orders_paid_afil += 1;
    if (['afiliado', 'afiliado_no_apto'].includes(order.order_type)) g.orders_org_afil += 1;
  }

  // Calcular métricas derivadas y redondear
  const result = Object.values(grupoStats).map(g => {
    const paidOrders = g.orders_propio + g.orders_paid_afil;
    const cpa = paidOrders > 0 && g.gmv_max_spend > 0 ? round(g.gmv_max_spend / paidOrders) : 0;
    const margin_pct      = g.revenue > 0 ? round((g.net_profit / g.revenue) * 100, 2) : 0;
    const margin_pct_cogs = g.cogs    > 0 ? round((g.net_profit / g.cogs)    * 100, 2) : 0;

    // display_name: si solo hay 1 SKU en el grupo → mostrar el SKU; si hay varios → mostrar el grupo
    const skuArr = [...g.skus];
    const display_name = skuArr.length === 1 ? skuArr[0] : g.grupo;

    return {
      grupo:            g.grupo,
      display_name,
      orders:           g.orders,
      orders_propio:    g.orders_propio,
      orders_paid_afil: g.orders_paid_afil,
      orders_org_afil:  g.orders_org_afil,
      revenue:          round(g.revenue),
      cogs:             round(g.cogs),
      shipping:         round(g.shipping),
      iva:              round(g.iva),
      tiktok_platform:  round(g.tiktok_platform),
      commission_cost:  round(g.commission_cost),
      gmv_max_spend:    round(g.gmv_max_spend),
      seller_discount:  round(g.seller_discount),
      gross_profit:     round(g.gross_profit),
      net_profit:       round(g.net_profit),
      margin_pct,
      margin_pct_cogs,
      cpa,
    };
  });

  // Ordenar por net_profit desc
  return result.sort((a, b) => b.net_profit - a.net_profit);
}

/**
 * Construye el resumen global a partir del array P&L.
 */
function buildSummary(pl) {
  const totals = pl.reduce((acc, g) => {
    acc.orders           += g.orders;
    acc.orders_propio    += g.orders_propio;
    acc.orders_paid_afil += g.orders_paid_afil;
    acc.orders_org_afil  += g.orders_org_afil;
    acc.gmv              += g.revenue;
    acc.cogs             += g.cogs;
    acc.shipping         += g.shipping;
    acc.iva              += g.iva;
    acc.tiktok_platform  += g.tiktok_platform;
    acc.commission_cost  += g.commission_cost;
    acc.gmv_max_spend    += g.gmv_max_spend;
    acc.seller_discount  += g.seller_discount;
    acc.gross_profit     += g.gross_profit;
    acc.net_profit       += g.net_profit;
    return acc;
  }, {
    orders: 0, orders_propio: 0, orders_paid_afil: 0, orders_org_afil: 0,
    gmv: 0, cogs: 0, shipping: 0, iva: 0, tiktok_platform: 0,
    commission_cost: 0, gmv_max_spend: 0, seller_discount: 0,
    gross_profit: 0, net_profit: 0,
  });

  const paidOrders = totals.orders_propio + totals.orders_paid_afil;
  const cpa        = paidOrders > 0 && totals.gmv_max_spend > 0
    ? round(totals.gmv_max_spend / paidOrders)
    : 0;
  const margin_pct      = totals.gmv  > 0 ? round((totals.net_profit / totals.gmv)  * 100, 2) : 0;
  const margin_pct_cogs = totals.cogs > 0 ? round((totals.net_profit / totals.cogs) * 100, 2) : 0;

  return {
    orders:           totals.orders,
    orders_propio:    totals.orders_propio,
    orders_paid_afil: totals.orders_paid_afil,
    orders_org_afil:  totals.orders_org_afil,
    gmv:              round(totals.gmv),
    cogs:             round(totals.cogs),
    shipping:         round(totals.shipping),
    iva:              round(totals.iva),
    tiktok_platform:  round(totals.tiktok_platform),
    commission_cost:  round(totals.commission_cost),
    gmv_max_spend:    round(totals.gmv_max_spend),
    seller_discount:  round(totals.seller_discount),
    gross_profit:     round(totals.gross_profit),
    net_profit:       round(totals.net_profit),
    margin_pct,
    margin_pct_cogs,
    cpa,
  };
}

module.exports = {
  fetchTTSOrders,
  buildOrders,
  classifyOrders,
  allocateGMVMax,
  buildPL,
  buildSummary,
};
