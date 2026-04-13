/**
 * Servicio Windsor.ai — portado de la app HTML original.
 * Hace las llamadas a la API de Windsor desde el servidor (evita CORS).
 */

const { getDb } = require('../db');
const { parseSku, calcShippingForOrder } = require('./calculator');

const WINDSOR_BASE = 'https://connectors.windsor.ai';

const WINDSOR_FIELDS_SHOP  = 'date,line_item__price,line_item__quantity,line_item__sku,order_name,order_payment_gateways,order_total_price,source';
const WINDSOR_FIELDS_META  = 'action_values_offsite_conversion_fb_pixel_purchase,actions_offsite_conversion_fb_pixel_purchase,ad_name,adset_name,campaign,clicks,date,spend';
const WINDSOR_FIELDS_TIKTOK = 'campaign,clicks,conversions,date,source,spend';

function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

async function fetchWindsor(endpoint, params) {
  const url = new URL(`${WINDSOR_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Windsor error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

/**
 * Importa datos de Shopify + Meta + TikTok desde Windsor para una fecha dada.
 * Guarda los datos crudos en la base de datos y devuelve las filas procesadas.
 */
async function importDayFromWindsor(date) {
  const settings = getSettings();
  const apiKey   = settings.windsor_api_key;
  const store    = settings.windsor_store || 'shopify__jupplies.myshopify.com';

  if (!apiKey) throw new Error('Windsor API key no configurada. Ir a Configuración → API.');

  const [shopRows, metaRows, tiktokRows] = await Promise.all([
    fetchWindsor('all', {
      api_key: apiKey,
      select_accounts: store,
      fields: WINDSOR_FIELDS_SHOP,
      date_from: date,
      date_to: date,
    }),
    fetchWindsor('facebook', {
      api_key: apiKey,
      date_from: date,
      date_to: date,
      fields: WINDSOR_FIELDS_META,
    }),
    fetchWindsor('tiktok', {
      api_key: apiKey,
      date_from: date,
      date_to: date,
      fields: WINDSOR_FIELDS_TIKTOK,
    }),
  ]);

  // Guardar pedidos en DB
  const ordersResult = saveOrders(shopRows, date);

  // Guardar anuncios en DB
  const adsResult = saveAdSpend(metaRows, tiktokRows, date);

  return {
    date,
    orders_imported: ordersResult.count,
    orders_skipped:  ordersResult.skipped,
    ads_imported:    adsResult.count,
  };
}

function saveOrders(shopRows, date) {
  const db = getDb();

  // Construir mapa de SKUs para calcular costos
  const allSkus = db.prepare('SELECT * FROM skus').all();
  const skuMap = {};
  for (const s of allSkus) skuMap[s.sku] = s;

  // Agrupar filas por order_name para calcular shipping por pedido
  const orderGroups = {};
  for (const row of shopRows) {
    const name = row.order_name || '';
    if (!name) continue;
    if (!orderGroups[name]) {
      orderGroups[name] = {
        total: parseFloat(row.order_total_price) || 0,
        gateway: row.order_payment_gateways || '',
        lines: [],
      };
    }
    const rawSku = row.line_item__sku || '';
    const skuLines = parseSku(rawSku);
    const qty = parseInt(row.line_item__quantity) || 1;
    const price = parseFloat(row.line_item__price) || 0;

    for (const { sku, qty: skuQty } of skuLines) {
      // Windsor a veces devuelve la misma línea/SKU en múltiples filas (una por unidad).
      // Acumulamos qty y price; la posición (line_position) la fija el primer push.
      const existing = orderGroups[name].lines.find(l => l.sku === sku);
      if (existing) {
        existing.qty   += qty * skuQty;
        existing.price += price;
      } else {
        // position = índice de inserción: 0 = primer SKU del pedido (principal), 1+ = upsell
        const position = orderGroups[name].lines.length;
        orderGroups[name].lines.push({ sku, qty: qty * skuQty, price, position });
      }
    }
  }

  // Detectar si es COD
  function isCod(gateway) {
    const g = (gateway || '').toLowerCase();
    return g.includes('cod') || g.includes('contraree') || g.includes('cash') || g === 'pending';
  }

  const now = new Date().toISOString();
  const stmtOrder = db.prepare(`
    INSERT INTO orders (order_name, date, payment_type, order_total, line_sku, line_qty, line_price, product_cost, shipping_cost, line_position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_name, line_sku) DO UPDATE SET
      date = excluded.date,
      payment_type = excluded.payment_type,
      order_total = excluded.order_total,
      line_qty = excluded.line_qty,
      line_price = excluded.line_price,
      product_cost = excluded.product_cost,
      shipping_cost = excluded.shipping_cost,
      line_position = excluded.line_position,
      updated_at = excluded.updated_at
  `);

  const stmtCod = db.prepare(`
    INSERT OR IGNORE INTO cod_tracking (order_name, order_date, order_total, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `);

  let count = 0, skipped = 0;

  const insertAll = db.transaction(() => {
    for (const [orderName, order] of Object.entries(orderGroups)) {
      const paymentType = isCod(order.gateway) ? 'cod' : 'card';
      const shippingTotal = calcShippingForOrder(order.lines, skuMap);
      const shippingPerLine = order.lines.length > 0 ? shippingTotal / order.lines.length : 0;

      for (const line of order.lines) {
        const skuData    = skuMap[line.sku];
        const productCost = skuData ? (skuData.cost * line.qty) : 0;

        stmtOrder.run(
          orderName, date, paymentType, order.total,
          line.sku, line.qty, line.price,
          productCost, shippingPerLine, line.position,
          now, now
        );
        count++;
      }

      // Crear registro COD si aplica
      if (paymentType === 'cod') {
        stmtCod.run(orderName, date, order.total, now, now);
      }
    }
  });

  insertAll();
  return { count, skipped };
}

function saveAdSpend(metaRows, tiktokRows, date) {
  const db = getDb();

  // Recuperar mapeos existentes
  const maps = db.prepare('SELECT platform, campaign_key, sku_group FROM campaign_sku_map').all();
  const mapIndex = {};
  for (const m of maps) mapIndex[`${m.platform}::${m.campaign_key}`] = m.sku_group;

  const { inferGroupFromCampaignName } = require('./calculator');

  const now = new Date().toISOString();

  // Agrupa filas por campaña sumando spend/clicks/conversions
  // Windsor devuelve una fila por anuncio — necesitamos una por campaña
  function aggregateByCampaign(rows, spendKey, clicksKey, convsKey, convValueKey) {
    const agg = {};
    for (const row of rows) {
      const campaign = (row.campaign || '').trim();
      if (!campaign) continue;
      if (!agg[campaign]) {
        agg[campaign] = { campaign, spend: 0, clicks: 0, conversions: 0, purchase_value: 0 };
      }
      agg[campaign].spend          += parseFloat(row[spendKey])    || 0;
      agg[campaign].clicks         += parseInt(row[clicksKey])     || 0;
      agg[campaign].conversions    += parseInt(row[convsKey])      || 0;
      agg[campaign].purchase_value += parseFloat(row[convValueKey] || 0) || 0;
    }
    return Object.values(agg);
  }

  const metaAgg   = aggregateByCampaign(metaRows,   'spend', 'clicks',
    'actions_offsite_conversion_fb_pixel_purchase',
    'action_values_offsite_conversion_fb_pixel_purchase');
  const tiktokAgg = aggregateByCampaign(tiktokRows, 'spend', 'clicks', 'conversions', '');

  const stmt = db.prepare(`
    INSERT INTO ad_spend (date, platform, campaign_name, campaign_id, spend, clicks, conversions, purchase_value, sku_group, is_manual_map, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'windsor_api', ?)
    ON CONFLICT(date, platform, campaign_name) DO UPDATE SET
      spend = excluded.spend,
      clicks = excluded.clicks,
      conversions = excluded.conversions,
      purchase_value = excluded.purchase_value,
      sku_group = COALESCE(
        (SELECT sku_group FROM campaign_sku_map WHERE platform = excluded.platform AND campaign_key = excluded.campaign_name AND is_manual = 1),
        excluded.sku_group
      )
  `);

  // Ya no se usan mapeos automáticos — solo manuales (is_manual=1)

  let count = 0;

  const insertAll = db.transaction(() => {
    // Limpiar datos Windsor existentes del día para evitar campañas fantasma de importaciones previas
    db.prepare("DELETE FROM ad_spend WHERE date = ? AND source = 'windsor_api'").run(date);

    // Meta (ya agrupado por campaña)
    for (const row of metaAgg) {
      const campaign = row.campaign;
      if (row.spend === 0) continue;

      const mapKey = `meta::${campaign}`;
      const manual = mapIndex[mapKey] || null;
      // Solo usar mapeo manual — la auto-inferencia causaba falsos positivos (CAM-, TE-, ESC-)
      // Las campañas sin mapeo aparecen en "Sin tracking" hasta que el usuario las mapea

      stmt.run(date, 'meta', campaign, null, row.spend,
        row.clicks, row.conversions, row.purchase_value,
        manual, manual ? 1 : 0, now
      );
      count++;
    }

    // TikTok (ya agrupado por campaña)
    for (const row of tiktokAgg) {
      const campaign = row.campaign;
      if (row.spend === 0) continue;

      const mapKey = `tiktok::${campaign}`;
      const manual = mapIndex[mapKey] || null;

      stmt.run(date, 'tiktok', campaign, null, row.spend,
        row.clicks, row.conversions, 0,
        manual, manual ? 1 : 0, now
      );
      count++;
    }
  });

  insertAll();
  return { count };
}

/**
 * Obtiene SOLO los datos de anuncios desde Windsor (Meta + TikTok).
 * Usado por el nuevo flujo que trae pedidos directo de Shopify.
 */
async function fetchWindsorAds(date) {
  const settings = getSettings();
  const apiKey   = settings.windsor_api_key;

  if (!apiKey) {
    // Sin API key de Windsor → devolver vacío (ads se importan manualmente)
    return { metaRows: [], tiktokRows: [] };
  }

  const [metaRows, tiktokRows] = await Promise.all([
    fetchWindsor('facebook', {
      api_key: apiKey,
      date_from: date,
      date_to: date,
      fields: WINDSOR_FIELDS_META,
    }),
    fetchWindsor('tiktok', {
      api_key: apiKey,
      date_from: date,
      date_to: date,
      fields: WINDSOR_FIELDS_TIKTOK,
    }),
  ]);

  return { metaRows, tiktokRows };
}

/**
 * Guarda pedidos obtenidos directamente de Shopify GraphQL.
 * Mapea los nodes de GraphQL al mismo formato de la tabla orders.
 *
 * @param {Array} shopifyNodes  array de order nodes del GraphQL
 * @param {string} date         YYYY-MM-DD
 * @returns {{ count: number, skipped: number }}
 */
function saveOrdersFromShopify(shopifyNodes, date) {
  const db = getDb();

  // Mapa de SKUs para calcular costos
  const allSkus = db.prepare('SELECT * FROM skus').all();
  const skuMap = {};
  for (const s of allSkus) skuMap[s.sku] = s;

  // Agrupar líneas por order_name
  const orderGroups = {};
  for (const node of shopifyNodes) {
    const name = node.name;
    if (!name) continue;

    const total   = parseFloat(node.totalPriceSet?.shopMoney?.amount) || 0;
    const gateway = (node.paymentGatewayNames || []).join(', ');
    const financialStatus = node.displayFinancialStatus || '';

    if (!orderGroups[name]) {
      orderGroups[name] = { total, gateway, financialStatus, lines: [] };
    }

    // Cada lineItem ya es un SKU individual — no necesita parseSku()
    const lineItems = node.lineItems?.edges || [];
    for (const edge of lineItems) {
      const item = edge.node;
      const sku  = (item.sku || '').trim().toUpperCase();
      if (!sku) continue;

      const qty   = item.quantity || 1;
      const price = parseFloat(item.originalTotalSet?.shopMoney?.amount) || 0;

      // Acumular si el mismo SKU aparece más de una vez en el pedido
      const existing = orderGroups[name].lines.find(l => l.sku === sku);
      if (existing) {
        existing.qty   += qty;
        existing.price += price;
      } else {
        const position = orderGroups[name].lines.length;
        orderGroups[name].lines.push({ sku, qty, price, position });
      }
    }
  }

  // Detectar COD: financialStatus PENDING + gateway check
  function isCodShopify(order) {
    if (order.financialStatus === 'PENDING') return true;
    if (order.financialStatus === 'PAID') return false;
    const g = (order.gateway || '').toLowerCase();
    return g.includes('cod') || g.includes('cash') || g.includes('contraree') || g === 'pending';
  }

  const now = new Date().toISOString();
  const stmtOrder = db.prepare(`
    INSERT INTO orders (order_name, date, payment_type, order_total, line_sku, line_qty, line_price, product_cost, shipping_cost, line_position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_name, line_sku) DO UPDATE SET
      date = excluded.date,
      payment_type = excluded.payment_type,
      order_total = excluded.order_total,
      line_qty = excluded.line_qty,
      line_price = excluded.line_price,
      product_cost = excluded.product_cost,
      shipping_cost = excluded.shipping_cost,
      line_position = excluded.line_position,
      updated_at = excluded.updated_at
  `);

  const stmtCod = db.prepare(`
    INSERT OR IGNORE INTO cod_tracking (order_name, order_date, order_total, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `);

  let count = 0, skipped = 0;

  const insertAll = db.transaction(() => {
    for (const [orderName, order] of Object.entries(orderGroups)) {
      const paymentType = isCodShopify(order) ? 'cod' : 'card';
      const shippingTotal = calcShippingForOrder(order.lines, skuMap);
      const shippingPerLine = order.lines.length > 0 ? shippingTotal / order.lines.length : 0;

      for (const line of order.lines) {
        const skuData     = skuMap[line.sku];
        const productCost = skuData ? (skuData.cost * line.qty) : 0;

        stmtOrder.run(
          orderName, date, paymentType, order.total,
          line.sku, line.qty, line.price,
          productCost, shippingPerLine, line.position,
          now, now
        );
        count++;
      }

      if (paymentType === 'cod') {
        stmtCod.run(orderName, date, order.total, now, now);
      }
    }
  });

  insertAll();
  return { count, skipped };
}

/**
 * Guarda pedidos obtenidos de Simla API (formato normalizado de fetchSimlaOrders).
 * Soporta multi-SKU (ej: "FILGRI;R-FILGRI*2") via parseSku().
 */
function saveOrdersFromSimla(simlaOrders, date) {
  const db = getDb();

  const allSkus = db.prepare('SELECT * FROM skus').all();
  const skuMap = {};
  for (const s of allSkus) skuMap[s.sku] = s;

  // Agrupar por order_name y expandir multi-SKU
  const orderGroups = {};
  for (const order of simlaOrders) {
    const name = order.name;
    if (!name) continue;

    if (!orderGroups[name]) {
      orderGroups[name] = {
        total: order.totalPrice,
        paymentType: order.paymentType,
        lines: [],
      };
    }

    for (const item of (order.items || [])) {
      // Simla puede tener multi-SKU como "FILGRI;R-FILGRI*2"
      const skuParts = parseSku(item.sku);
      if (skuParts.length === 0) continue;

      for (const { sku, qty: skuQty } of skuParts) {
        const totalQty = item.quantity * skuQty;
        const existing = orderGroups[name].lines.find(l => l.sku === sku);
        if (existing) {
          existing.qty   += totalQty;
          existing.price += item.price;
        } else {
          const position = orderGroups[name].lines.length;
          orderGroups[name].lines.push({ sku, qty: totalQty, price: item.price, position });
        }
      }
    }
  }

  const now = new Date().toISOString();
  const stmtOrder = db.prepare(`
    INSERT INTO orders (order_name, date, payment_type, order_total, line_sku, line_qty, line_price, product_cost, shipping_cost, line_position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_name, line_sku) DO UPDATE SET
      date = excluded.date, payment_type = excluded.payment_type, order_total = excluded.order_total,
      line_qty = excluded.line_qty, line_price = excluded.line_price, product_cost = excluded.product_cost,
      shipping_cost = excluded.shipping_cost, line_position = excluded.line_position, updated_at = excluded.updated_at
  `);

  const stmtCod = db.prepare(`
    INSERT OR IGNORE INTO cod_tracking (order_name, order_date, order_total, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `);

  let count = 0, skipped = 0;

  const insertAll = db.transaction(() => {
    for (const [orderName, order] of Object.entries(orderGroups)) {
      const shippingTotal = calcShippingForOrder(order.lines, skuMap);
      const shippingPerLine = order.lines.length > 0 ? shippingTotal / order.lines.length : 0;

      for (const line of order.lines) {
        const skuData     = skuMap[line.sku];
        const productCost = skuData ? (skuData.cost * line.qty) : 0;

        stmtOrder.run(
          orderName, date, order.paymentType, order.total,
          line.sku, line.qty, line.price,
          productCost, shippingPerLine, line.position,
          now, now
        );
        count++;
      }

      if (order.paymentType === 'cod') {
        stmtCod.run(orderName, date, order.total, now, now);
      }
    }
  });

  insertAll();
  return { count, skipped };
}

module.exports = {
  importDayFromWindsor,
  fetchWindsorAds,
  saveAdSpend,
  saveOrdersFromShopify,
  saveOrdersFromSimla,
};
