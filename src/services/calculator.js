/**
 * Motor de cálculo de rentabilidad — portado de la app HTML original.
 * Todas las fórmulas son idénticas a la app actual.
 */

const { getDb } = require('../db');

/**
 * Detecta el grupo de SKU a partir del nombre de campaña.
 * Matching estricto: el prefijo debe aparecer como token completo (entre separadores),
 * no como substring de otra palabra. Evita falsos positivos como "CAM" en "CAMPAIGN".
 */
function inferGroupFromCampaignName(campaignName) {
  if (!campaignName) return null;
  // Normalizar: mayúsculas, espacios y guiones bajos → guión
  const upper = campaignName.toUpperCase().replace(/[\s_]+/g, '-');

  const db = getDb();
  const groups = db.prepare('SELECT DISTINCT grupo FROM skus WHERE grupo IS NOT NULL AND grupo != ""').pluck().all();

  // Ordenar por longitud desc → preferir matches más específicos (BURRO-BB antes que BURRO)
  groups.sort((a, b) => b.length - a.length);

  for (const grupo of groups) {
    const prefix = grupo.replace(/-$/, ''); // "ESNT-" → "ESNT"
    if (prefix.length < 3) continue;       // descartar prefijos ambiguos de 1-2 chars
    // El prefijo debe ser un token completo: precedido por inicio o guión, seguido por guión o fin
    const re = new RegExp('(^|-)' + prefix + '(-|$)');
    if (re.test(upper)) return grupo;
  }

  return null;
}

/**
 * Parsea un campo SKU con posible formato multi-SKU:
 * "SKU-A" → [{sku: "SKU-A", qty: 1}]
 * "SKU-A;SKU-B*2" → [{sku: "SKU-A", qty: 1}, {sku: "SKU-B", qty: 2}]
 */
function parseSku(raw) {
  if (!raw) return [];
  const parts = String(raw).trim().split(';');
  const result = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(.+?)\*(\d+)$/);
    if (match) {
      result.push({ sku: match[1].trim().toUpperCase(), qty: parseInt(match[2]) });
    } else {
      result.push({ sku: trimmed.toUpperCase(), qty: 1 });
    }
  }
  return result;
}

/**
 * Calcula el costo de envío para un pedido con múltiples líneas de SKU.
 * Lógica: máximo envío entre los SKUs + 10% por unidad adicional.
 */
function calcShippingForOrder(skuLines, skuMap) {
  let maxShipping = 0;
  let totalUnits = 0;

  for (const { sku, qty } of skuLines) {
    const skuData = skuMap[sku];
    if (!skuData) continue;
    const shipping = skuData.shipping_es || 0;
    if (shipping > maxShipping) maxShipping = shipping;
    totalUnits += qty;
  }

  if (totalUnits <= 1) return maxShipping;
  return maxShipping * (1 + 0.1 * (totalUnits - 1));
}

/**
 * Calcula métricas de rentabilidad para un día.
 * @param {Object} params
 * @param {Array}  params.orders    - filas de la tabla orders agrupadas por order_name
 * @param {Array}  params.adSpend   - filas de ad_spend del día
 * @param {Object} params.settings  - parámetros globales (cod_confirmation_rate, etc.)
 * @returns {Object} métricas calculadas
 */
function calcDayMetrics({ orders, adSpend, settings }) {
  const confRate    = parseFloat(settings.cod_confirmation_rate) || 0.85;
  const delivRate   = parseFloat(settings.cod_delivery_rate)     || 0.83;
  const returnShip  = parseFloat(settings.return_shipping_cost)  || 4.00;
  const vatRate     = parseFloat(settings.vat_rate)              || 1.21;

  // Agrupar filas de orders por order_name para obtener pedidos únicos
  const orderMap = {};
  for (const row of orders) {
    if (!orderMap[row.order_name]) {
      orderMap[row.order_name] = {
        order_name:   row.order_name,
        date:         row.date,
        payment_type: row.payment_type,
        order_total:  row.order_total,
        lines:        [],
        product_cost: 0,
        shipping_cost: 0,
      };
    }
    const o = orderMap[row.order_name];
    o.lines.push({ sku: row.line_sku, qty: row.line_qty, price: row.line_price });
    o.product_cost  += row.product_cost  || 0;
    o.shipping_cost += row.shipping_cost || 0;
  }

  const allOrders = Object.values(orderMap);
  const cardOrders = allOrders.filter(o => o.payment_type === 'card');
  const codOrders  = allOrders.filter(o => o.payment_type === 'cod');

  // Revenue bruto
  const revCardBruto = cardOrders.reduce((s, o) => s + o.order_total, 0);
  const revCodBruto  = codOrders.reduce((s, o)  => s + o.order_total, 0);
  const revBruto     = revCardBruto + revCodBruto;

  // Revenue efectivo (COD ajustado por efectividad)
  const efec           = confRate * delivRate;
  const revCodEfectivo = revCodBruto * efec;
  const revEfectivo    = revCardBruto + revCodEfectivo;

  // Costos
  const cpCard     = cardOrders.reduce((s, o) => s + o.product_cost, 0);
  const cpCodBruto = codOrders.reduce((s, o)  => s + o.product_cost, 0);   // costo pleno (conservador)
  const cpCodPost  = codOrders.reduce((s, o)  => s + o.product_cost * efec, 0); // solo lo que se entrega
  const ceCard = cardOrders.reduce((s, o) => s + o.shipping_cost, 0);
  const ceCod  = codOrders.reduce((s, o)  => s + o.shipping_cost, 0);
  const cpTotalBruto = cpCard + cpCodBruto;
  const cpTotalPost  = cpCard + cpCodPost;
  const ceTotal = ceCard + ceCod;

  // Costo extra por rechazos COD
  // Pedidos que se confirmaron pero no se entregaron → pagan envío vuelta
  const rechazados = codOrders.length * confRate * (1 - delivRate);
  const costRechazos = rechazados * returnShip;

  // Gasto en anuncios
  const adsByPlatform = {};
  let totalAds = 0;
  for (const ad of adSpend) {
    adsByPlatform[ad.platform] = (adsByPlatform[ad.platform] || 0) + ad.spend;
    totalAds += ad.spend;
  }

  // Métricas finales
  // Estimado real: revenue efectivo / vatRate - CP efectivo
  // Margen sobre net revenue (sin IVA): lo que realmente queda de la facturación
  const netRevEfectivo = revEfectivo / vatRate;
  const gananciaPost   = netRevEfectivo - cpTotalPost - ceTotal - costRechazos - totalAds;
  const margenPctPost  = netRevEfectivo > 0 ? (gananciaPost / netRevEfectivo) * 100 : 0;
  const sobreCpPost    = cpTotalPost    > 0 ? (gananciaPost / cpTotalPost)    * 100 : 0;

  // Bruto (conservador): revenue 100% / vatRate - CP 100% (consistente, sin efec)
  const netRevBruto  = revBruto / vatRate;
  const ganancia     = netRevBruto - cpTotalBruto - ceTotal - costRechazos - totalAds;
  const margenPct    = netRevBruto > 0 ? (ganancia / netRevBruto) * 100 : 0;
  const sobreCpPct   = cpTotalBruto > 0 ? (ganancia / cpTotalBruto) * 100 : 0;

  const totalOrders = allOrders.length;
  const roas        = totalAds  > 0 ? revBruto     / totalAds : 0;
  const roasReal    = totalAds  > 0 ? revEfectivo  / totalAds : 0;
  const cpa         = totalOrders > 0 ? totalAds   / totalOrders : 0;
  const aov         = totalOrders > 0 ? revBruto   / totalOrders : 0;

  // Métricas PAID vs COD
  const pctCard   = revBruto > 0 ? revCardBruto / revBruto : 0;
  const pctCod    = revBruto > 0 ? revCodBruto  / revBruto : 0;
  // Tasa de cobro real sobre TODA la facturación (siempre > efec porque Paid=100%)
  const efecTotal = revBruto > 0 ? revEfectivo  / revBruto : 0;

  // Costo producto desglosado: Paid (100%) vs COD (×efec)
  const cpCard_ = round(cpCard);
  const cpCod_  = round(cpCodPost);

  // ROI = ganancia / costo producto efectivo
  const roi = cpTotalPost > 0 ? round(gananciaPost / cpTotalPost, 4) : 0;

  // CPA por plataforma (spend_platform / total_orders)
  const cpaByPlatform = {};
  for (const [plat, spend] of Object.entries(adsByPlatform)) {
    cpaByPlatform[plat] = totalOrders > 0 ? round(spend / totalOrders, 2) : 0;
  }

  return {
    // Revenue
    rev_bruto:      round(revBruto),
    rev_efectivo:   round(revEfectivo),
    rev_card_bruto: round(revCardBruto),
    rev_cod_bruto:  round(revCodBruto),
    rev_cod_efectivo: round(revCodEfectivo),
    // Pedidos
    orders_total: totalOrders,
    orders_card:  cardOrders.length,
    orders_cod:   codOrders.length,
    // Costos
    product_cost:       round(cpTotalPost),   // con efec en COD (igual que app vieja)
    product_cost_bruto: round(cpTotalBruto),  // 100% sin ajuste
    shipping_cost:  round(ceTotal),
    shipping_card:  round(ceCard),
    shipping_cod:   round(ceCod),
    cost_rechazos:  round(costRechazos),
    // Anuncios
    ads_total:      round(totalAds),
    ads_by_platform: Object.fromEntries(
      Object.entries(adsByPlatform).map(([k, v]) => [k, round(v)])
    ),
    // Clicks por plataforma
    clicks_by_platform: adSpend.reduce((acc, ad) => {
      acc[ad.platform] = (acc[ad.platform] || 0) + (ad.clicks || 0);
      return acc;
    }, {}),
    // Rentabilidad — principal = igual que app vieja (efec en revenue y CP de COD)
    net_revenue:  round(netRevEfectivo),
    ganancia:     round(gananciaPost),
    margen_pct:   round(margenPctPost, 2),
    sobre_cp_pct: round(sobreCpPost, 2),
    // Resultado conservador bruto (costo 100% sin ajuste efec)
    ganancia_bruto:     round(ganancia),
    margen_pct_bruto:   round(margenPct, 2),
    sobre_cp_pct_bruto: round(sobreCpPct, 2),
    // KPIs
    roas:      round(roas, 2),
    roas_real: round(roasReal, 2),
    cpa:       round(cpa, 2),
    aov:       round(aov, 2),
    // Parámetros usados
    conf_rate:  confRate,
    deliv_rate: delivRate,
    efec:       round(efec, 4),
    // PAID vs COD mix
    pct_card:   round(pctCard * 100, 2),
    pct_cod:    round(pctCod  * 100, 2),
    efec_total: round(efecTotal * 100, 2),
    // Costo producto desglosado
    cp_card: cpCard_,
    cp_cod:  cpCod_,
    // ROI y beneficio sobre fac. efectiva
    roi:                roi,
    beneficio_s_fac_ef: round(margenPctPost, 2),   // % ganancia / net_revenue efectivo
    // CPA por plataforma
    cpa_by_platform: cpaByPlatform,
  };
}

/**
 * Calcula desglose de rentabilidad agrupado por GRUPO de SKU.
 *
 * NOTA sobre revenue:
 * Windsor devuelve line_item__price como el TOTAL de la línea (precio × unidades),
 * no como el precio unitario. Por eso usamos line.price directamente, sin multiplicar
 * por line.qty (eso causaría doble conteo).
 */
/**
 * Calcula desglose de rentabilidad agrupado por GRUPO de SKU.
 *
 * Lógica de UPSELL:
 * Los SKUs marcados como is_upsell=1 en la tabla skus NO tienen revenue propio.
 * Su facturación y costos se redistribuyen proporcionalmente entre los SKUs
 * principales del mismo pedido (los que generaron la venta).
 * Los upsells aparecen en el resultado con is_upsell=true y métricas en 0,
 * solo para informar que salieron ese día.
 */
function calcSkuMetrics({ orders, adSpend, settings }) {
  const confRate  = parseFloat(settings.cod_confirmation_rate) || 0.85;
  const delivRate = parseFloat(settings.cod_delivery_rate)     || 0.83;
  const vatRate   = parseFloat(settings.vat_rate)              || 1.21;
  const efec      = confRate * delivRate;

  // Agrupar filas de orders por order_name, respetando line_position para saber
  // cuál es el SKU principal (position=0) y cuáles son upsells (position>=1).
  const orderMap = {};
  for (const row of orders) {
    if (!orderMap[row.order_name]) {
      orderMap[row.order_name] = {
        order_name:   row.order_name,
        payment_type: row.payment_type,
        lines: []
      };
    }
    orderMap[row.order_name].lines.push({
      sku:           row.line_sku,
      qty:           row.line_qty,
      price:         row.line_price,
      product_cost:  row.product_cost,
      shipping_cost: row.shipping_cost,
      position:      row.line_position ?? 0,
    });
  }
  // Ordenar líneas de cada pedido por posición (garantiza que position=0 sea siempre el primero)
  for (const order of Object.values(orderMap)) {
    order.lines.sort((a, b) => a.position - b.position);
  }

  // Cargar grupos desde la DB
  const db = getDb();
  const dbSkus = db.prepare('SELECT sku, grupo FROM skus').all();
  const skuToGrupo = {};
  for (const s of dbSkus) {
    if (s.grupo) skuToGrupo[s.sku] = s.grupo;
  }

  function getGrupo(sku) {
    return skuToGrupo[sku] || sku;
  }

  // Acumular métricas por GRUPO
  const grupoStats = {};
  function getGrupoStat(grupo) {
    if (!grupoStats[grupo]) grupoStats[grupo] = {
      grupo, skus: new Set(), orderNames: new Set(),
      // ¿Solo aparece como upsell? Se marca true si nunca fue principal
      only_upsell: true,
      orders: 0, units: 0,
      upsell_units: 0,          // unidades que salieron como upsell de otros pedidos
      rev_bruto: 0, rev_efectivo: 0,
      product_cost: 0, shipping_cost: 0,
      ads: 0,
      // PAID vs COD split
      orders_card: 0, orders_cod: 0,
      rev_card_bruto: 0, rev_cod_bruto: 0,
    };
    return grupoStats[grupo];
  }

  for (const order of Object.values(orderMap)) {
    const mult = order.payment_type === 'cod' ? efec : 1;

    // lines[0] = SKU principal (el que el anuncio trajo al cliente)
    // lines[1+] = upsells (agregados al carrito después)
    const primaryLine  = order.lines[0];
    const upsellLines  = order.lines.slice(1);

    if (!primaryLine) continue;

    // Totales de upsell a redistribuir al SKU principal
    const totalUpsellRev  = upsellLines.reduce((s, l) => s + (l.price || 0), 0);
    const totalUpsellCost = upsellLines.reduce((s, l) => s + (l.product_cost  || 0), 0);
    const totalUpsellShip = upsellLines.reduce((s, l) => s + (l.shipping_cost || 0), 0);

    // --- SKU PRINCIPAL: absorbe el revenue y costo de los upsells ---
    const primaryGrupo = getGrupo(primaryLine.sku);
    const gp = getGrupoStat(primaryGrupo);
    gp.skus.add(primaryLine.sku);
    gp.only_upsell = false;   // tiene al menos un pedido donde fue principal

    if (!gp.orderNames.has(order.order_name)) {
      gp.orderNames.add(order.order_name);
      gp.orders++;
      if (order.payment_type === 'card') gp.orders_card++;
      else                               gp.orders_cod++;
    }
    gp.units += primaryLine.qty;

    const rev   = (primaryLine.price || 0) + totalUpsellRev;
    const pcost = (primaryLine.product_cost  || 0) + totalUpsellCost;
    const scost = (primaryLine.shipping_cost || 0) + totalUpsellShip;

    gp.rev_bruto    += rev;
    gp.rev_efectivo += rev * mult;
    gp.product_cost  += pcost * mult;
    gp.shipping_cost += scost;
    if (order.payment_type === 'card') gp.rev_card_bruto += rev;
    else                               gp.rev_cod_bruto  += rev;

    // --- UPSELLS: registrar solo unidades (badge informativo, métricas=0) ---
    for (const line of upsellLines) {
      const grupo = getGrupo(line.sku);
      const g = getGrupoStat(grupo);
      g.skus.add(line.sku);
      g.upsell_units += line.qty;
      // only_upsell permanece true hasta que aparezca como principal en otro pedido
    }
  }

  // Distribuir ADS por grupo → proporcional a unidades vendidas (solo grupos principales)
  const adByGroup = {};
  for (const ad of adSpend) {
    if (!ad.sku_group) continue;
    adByGroup[ad.sku_group] = (adByGroup[ad.sku_group] || 0) + ad.spend;
  }

  for (const [adGroup, spend] of Object.entries(adByGroup)) {
    const prefix = adGroup.replace(/-$/, '');
    const matchingGrupos = Object.values(grupoStats).filter(g =>
      !g.is_upsell && (
        g.grupo === adGroup ||                  // exacto: "BURRO-" === "BURRO-"
        g.grupo.replace(/-$/, '') === prefix || // sin guión final
        g.grupo.startsWith(adGroup)             // subgrupo: "SILLA-6-".startsWith("SILLA-") ✓
        // IMPORTANTE: startsWith usa el adGroup COMPLETO (con guión) para no matchear
        // grupos distintos: "CAM-" no matchea "CACOC-", "WC-" no matchea nada ajeno.
      )
    );

    const totalUnits = matchingGrupos.reduce((sum, g) => sum + g.units, 0);
    if (totalUnits === 0) {
      // Campaña con spend pero sin ventas de ese grupo hoy → "sin ventas"
      // Crear entrada informativa con solo el gasto
      const g = getGrupoStat(adGroup);
      g.is_sin_ventas = true;
      g.ads += spend;
      continue;
    }

    for (const g of matchingGrupos) {
      g.ads += spend * (g.units / totalUnits);
    }
  }

  // ADS sin grupo asignado: agrupar por campaña individual para visibilidad
  const untrackedByKey = {};
  for (const a of adSpend) {
    if (a.sku_group) continue;
    const key = `${a.platform}::${a.campaign_name}`;
    if (!untrackedByKey[key]) {
      untrackedByKey[key] = { platform: a.platform, campaign_name: a.campaign_name, spend: 0 };
    }
    untrackedByKey[key].spend += a.spend;
  }

  // Calcular ganancia y métricas finales por grupo
  const result = [];

  for (const g of Object.values(grupoStats)) {
    if (g.is_sin_ventas) continue; // se agregan abajo

    if (g.only_upsell) {
      // Solo apareció como upsell (nunca fue el SKU principal de ningún pedido)
      // Mostrar fila informativa al final con badge UPSELL y solo unidades
      result.push({
        sku:          g.grupo,
        skus:         [...g.skus].sort(),
        is_upsell:    true,
        orders:       0,
        units:        g.upsell_units,
        rev_bruto: 0, rev_efectivo: 0,
        product_cost: 0, shipping_cost: 0, ads: 0,
        ganancia: 0, margen_pct: 0, sobre_cp_pct: 0,
      });
      continue;
    }

    // Grupo con pedidos principales: métricas completas
    // Si además tuvo unidades como upsell en otros pedidos, se anota en upsell_units
    const netRev  = g.rev_efectivo / vatRate;
    const gan     = netRev - g.product_cost - g.shipping_cost - g.ads;
    const margen  = netRev > 0 ? (gan / netRev) * 100 : 0;   // sobre neto estimado (sin IVA)
    const sobreCp = g.product_cost > 0 ? (gan / g.product_cost) * 100 : 0;
    result.push({
      sku:           g.grupo,
      skus:          [...g.skus].sort(),
      is_upsell:     false,
      orders:        g.orders,
      units:         g.units,
      upsell_units:  g.upsell_units,   // unidades extra que salieron como upsell
      orders_card:   g.orders_card,
      orders_cod:    g.orders_cod,
      rev_bruto:     round(g.rev_bruto),
      rev_card_bruto: round(g.rev_card_bruto),
      rev_cod_bruto:  round(g.rev_cod_bruto),
      rev_efectivo:  round(g.rev_efectivo),
      product_cost:  round(g.product_cost),
      shipping_cost: round(g.shipping_cost),
      ads:           round(g.ads),
      ganancia:      round(gan),
      margen_pct:    round(margen, 2),
      sobre_cp_pct:  round(sobreCp, 2),
    });
  }

  // Filas "sin ventas" (campaña con gasto pero sin pedidos del grupo ese día)
  for (const g of Object.values(grupoStats)) {
    if (!g.is_sin_ventas) continue;
    result.push({
      sku:           g.grupo,
      skus:          [],
      is_sin_ventas: true,
      orders: 0, units: 0,
      rev_bruto: 0, rev_efectivo: 0,
      product_cost: 0, shipping_cost: 0,
      ads:      round(g.ads),
      ganancia: round(-g.ads),
      margen_pct: 0, sobre_cp_pct: 0,
    });
  }

  // Una fila por campaña sin grupo asignado (en vez de un agregado opaco)
  for (const u of Object.values(untrackedByKey)) {
    if (u.spend <= 0) continue;
    result.push({
      sku:           u.campaign_name,
      campaign_name: u.campaign_name,
      platform:      u.platform,
      skus:          [],
      is_sin_tracking: true,
      orders: 0, units: 0,
      rev_bruto: 0, rev_efectivo: 0,
      product_cost: 0, shipping_cost: 0,
      ads:      round(u.spend),
      ganancia: round(-u.spend),
      margen_pct: 0, sobre_cp_pct: 0,
    });
  }

  // Orden: principales por revenue desc → sin ventas/tracking → upsells al final
  return result.sort((a, b) => {
    const rankA = a.is_upsell ? 3 : (a.is_sin_ventas || a.is_sin_tracking) ? 2 : 0;
    const rankB = b.is_upsell ? 3 : (b.is_sin_ventas || b.is_sin_tracking) ? 2 : 0;
    if (rankA !== rankB) return rankA - rankB;
    return b.rev_bruto - a.rev_bruto;
  });
}

function round(n, decimals = 2) {
  return Math.round((n || 0) * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

module.exports = {
  calcDayMetrics,
  calcSkuMetrics,
  inferGroupFromCampaignName,
  parseSku,
  calcShippingForOrder,
};
