/**
 * Servicio de Muestras Gratuitas TTS.
 *
 * Detección: pedidos en `site='tik-tok-shop'` cuyos `customFields.shopify_tags`
 * contienen "Free sample" o "SELLER_FUND_FREE_SAMPLE" (marcado automático por TikTok Shop).
 *
 * Atribución: cada muestra se liga a un handle TikTok; luego se consultan
 * las ventas afiliadas posteriores (tts_affiliate_orders) del mismo grupo.
 */

const { getDb } = require('../db');

const SIMLA_BASE = 'https://fulfillment.simla.com/api/v5';

// ─── Estados (del doc Simla_Logica_Estados.docx) ─────────────────────────
const CANCEL_STATUSES = new Set([
  'cancel-other','no-call','prices-did-not-suit','already-buyed',
  'delyvery-did-not-suit','otros','no-product',
  'sin-respuesta-1','sin-respuesta-2','sin-respuesta-3',
  'sin-respuesta-4','sin-respuesta-5','sin-respuesta-final',
  'islas-canarias-ceuta-melilla','error-de-descontar-el-stock',
]);

const REFUND_STATUSES = new Set([
  'reembolsado','reembolsado-parcial','reembolso-recibido-alm',
  'reembolso-resenas','devolucion',
]);

// CONFIRMED del doc: estados "aprobados que se envían"
const CONFIRMED_STATUSES = new Set([
  'upsell','falta-preparar','falta-preparar-pagados','pagado',
  'grabado','grabado-snt-v',
  'sin-recepcion','sin-recepcion-snt-v','sin-recepcion-amz',
  'sin-recepcion-amz-snt-v','sin-recepcion-miravia','sin-recepcion-miravia-snt-v',
  'delegacion-destino','en-reparto','almacenado','devuelta-pendiente',
  'no-localizado','entregado-de-rcn','en-arrastre','tramo-origen',
  'transito','transito-1','mal-transitado','tramo-destino',
  'reparto-fallido','nuevo-reparto','entregado','reexpedido',
  'alm-regulador','destruido','destruido-1','transferido-proveedor',
  'anulado','proveedor','entregado-en-punto-concertado',
  'recepcionado-en-oficina','paralizado','depositado-en-oficina',
  'disponible-en-oficina','devuelto-en-oficina',
  'rehusado-rcn','rehusado-recibido','rehusado-erroneos',
  'rehusado-recibido-rec','rehusado-destruccion',
  'complete','marketplace-sin-descontar','marketplace',
  'seguro-lott-correos','recanalizacion','amazon','miravia-preparado',
  'recibido-almacen','reposicion','devolucion','reembolso-recibido-alm',
  'reembolsado','reembolsado-parcial','reembolso-resenas','preparado',
  'send-to-delivery','delivering','entregado-2','assembling',
  'send-to-assembling','assembling-complete','redirect',
  'cerrado-definitivamente','con-incidencia','devuelta',
  'fallo-al-sacar-etiqueta','2-send-to-assembling','bot',
  'rehusados-contabilizados',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────
function round(n, decimals = 2) {
  return Math.round(((n || 0) + Number.EPSILON) * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function getSimlaApiKey() {
  const db = getDb();
  return db.prepare("SELECT value FROM app_settings WHERE key = 'simla_api_key'").pluck().get() || '';
}

function getAttributionWindowDays() {
  const db = getDb();
  const v = db.prepare("SELECT value FROM app_settings WHERE key = 'sample_attribution_window_days'").pluck().get();
  return parseInt(v || '90', 10);
}

function dateOnly(isoStr) {
  if (!isoStr) return null;
  const s = String(isoStr).trim();
  // "2026-04-20 17:31:09" o "2026-04-20T17:31:09Z"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function addDays(dateStr, days) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Detecta si un pedido de Simla es una muestra gratuita TikTok.
 * Regla: `customFields.shopify_tags` contiene "Free sample" o "SELLER_FUND_FREE_SAMPLE".
 */
function isFreeSample(order) {
  if (order.site !== 'tik-tok-shop') return false;
  const tags = order.customFields?.shopify_tags || '';
  return /\bFree sample\b/i.test(tags) || /SELLER_FUND_FREE_SAMPLE/i.test(tags);
}

/**
 * Extrae TikTokOrderID de los shopify_tags (formato "TikTokOrderID:XXX").
 */
function extractTikTokOrderId(tagsRaw) {
  if (!tagsRaw) return null;
  const m = String(tagsRaw).match(/TikTokOrderID[:\s]+(\d+)/i);
  return m ? m[1].trim() : null;
}

/**
 * Intenta extraer un @handle TikTok de textos libres (comments).
 */
function extractHandleFromText(txt) {
  if (!txt) return null;
  const m = String(txt).match(/@([a-zA-Z0-9._]{2,30})/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Obtiene pedidos Simla de un rango con paginación paralela (10 páginas a la vez).
 */
async function fetchSimlaOrdersRange(dateFrom, dateTo) {
  const apiKey = getSimlaApiKey();
  if (!apiKey) throw new Error('Simla API key no configurada');

  const params0 = new URLSearchParams({
    apiKey,
    limit: '100',
    page: '1',
    'filter[createdAtFrom]': `${dateFrom} 00:00:00`,
    'filter[createdAtTo]':   `${dateTo} 23:59:59`,
  });
  const res0 = await fetch(`${SIMLA_BASE}/orders?${params0}`);
  if (!res0.ok) throw new Error(`Simla API error ${res0.status}`);
  const data0 = await res0.json();
  if (!data0.success) throw new Error(data0.errorMsg || 'Error Simla');
  const totalPages = data0.pagination?.totalPageCount || 1;

  let allOrders = data0.orders || [];

  // Paralelizar páginas 2..N de a 10
  const remaining = [];
  for (let p = 2; p <= totalPages; p++) remaining.push(p);

  const batchSize = 10;
  for (let i = 0; i < remaining.length; i += batchSize) {
    const batch = remaining.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (p) => {
      const params = new URLSearchParams({
        apiKey,
        limit: '100',
        page: String(p),
        'filter[createdAtFrom]': `${dateFrom} 00:00:00`,
        'filter[createdAtTo]':   `${dateTo} 23:59:59`,
      });
      const r = await fetch(`${SIMLA_BASE}/orders?${params}`);
      if (!r.ok) return [];
      const d = await r.json();
      return d.orders || [];
    }));
    for (const arr of results) allOrders = allOrders.concat(arr);
  }

  return allOrders;
}

/**
 * Transforma un pedido Simla en un registro listo para insertar en tts_samples.
 */
function sampleFromOrder(order, skuMap = {}) {
  const items = order.items || [];
  const primaryItem = items[0] || {};
  const rawSku = (primaryItem.offer?.article || '').trim().toUpperCase();

  // Resolver grupo desde skuMap
  const skuData = skuMap[rawSku]
    || skuMap[rawSku.replace(/-[A-Z0-9]+$/, '-')]
    || skuMap[rawSku.replace(/-[A-Z0-9]+$/, '')];
  const grupo = skuData?.grupo || rawSku;

  // COGS: sumar purchasePrice de todos los items (fallback a skuMap.cost)
  // Además construir lista de TODOS los SKUs del pedido (1 pedido puede llevar varios)
  let cogs = 0;
  let totalUnits = 0;
  const allSkusSet = new Set();
  for (const it of items) {
    const qty = it.quantity || 1;
    totalUnits += qty;
    let unitCost = it.purchasePrice || 0;
    const sk = (it.offer?.article || '').trim().toUpperCase();
    if (sk) allSkusSet.add(sk);
    if (!unitCost) {
      const sd = skuMap[sk];
      unitCost = sd?.cost || 0;
    }
    cogs += unitCost * qty;
  }
  const allSkus = [...allSkusSet].join(',');

  // Shipping: preferir delivery.netCost real; si viene 0 (Simla a veces no lo completa
  // para muestras), usar shipping_es del SKU maestro como estimación.
  let shippingCost = order.delivery?.netCost || 0;
  if (shippingCost === 0 && skuData) {
    shippingCost = skuData.shipping_es || skuData.shipping_tts || 3.10;
  } else if (shippingCost === 0) {
    shippingCost = 3.10; // fallback default TTS
  }

  const tagsRaw = order.customFields?.shopify_tags || '';
  const tiktokOrderId = extractTikTokOrderId(tagsRaw);

  // Fecha de aprobación: si el status actual está en CONFIRMED, statusUpdatedAt es la aprobación
  const isConfirmed = CONFIRMED_STATUSES.has(order.status);
  const approvedDate = isConfirmed ? dateOnly(order.statusUpdatedAt) : null;

  // Intentar extraer handle de comments/customFields
  const commentsBlob = [
    order.customerComment, order.managerComment,
    JSON.stringify(order.customFields || {}),
  ].join(' ');
  const autoHandle = extractHandleFromText(commentsBlob);

  const customerName = [order.customer?.firstName, order.customer?.lastName]
    .filter(Boolean).join(' ').trim() || null;
  const customerAddr = order.customer?.address?.text
    || order.delivery?.address?.text || null;

  return {
    sample_type:       'free',
    sent_date:         dateOnly(order.createdAt),
    approved_date:     approvedDate,
    approved_status:   order.status,
    simla_order_id:    String(order.id),
    simla_order_num:   order.number || null,
    tiktok_order_id:   tiktokOrderId,
    customer_name:     customerName,
    customer_email:    order.customer?.email || order.email || null,
    customer_phone:    order.customer?.phones?.[0]?.number || order.phone || null,
    customer_address:  customerAddr,
    shopify_tags_raw:  tagsRaw,
    custom_fields_raw: JSON.stringify(order.customFields || {}),
    sku:               rawSku,
    all_skus:          allSkus,
    grupo,
    product_name:      primaryItem.offer?.name || null,
    units:             totalUnits || 1,
    cogs:              round(cogs),
    shipping_cost:     round(shippingCost),
    original_price:    round(primaryItem.initialPrice || 0),
    tiktok_username:   autoHandle,
    auto_assigned:     autoHandle ? 1 : 0,
  };
}

/**
 * Escanea Simla en un rango, detecta muestras, upsertea en tts_samples.
 * Aplica automáticamente los mapeos existentes (creator_mapping) para asignar
 * tiktok_username a muestras de clientes ya conocidos.
 */
async function scanSamples(dateFrom, dateTo) {
  const db = getDb();

  // Mapa SKU → skuData para resolver grupo/cost
  const skusRaw = db.prepare('SELECT * FROM skus').all();
  const skuMap = {};
  for (const s of skusRaw) skuMap[s.sku] = s;

  // Mapa customer_name+phone → tiktok_username (para auto-asignación)
  const mappingRows = db.prepare('SELECT simla_customer_name, simla_customer_phone, tiktok_username FROM creator_mapping WHERE confirmed = 1').all();
  const mappingByCustomer = {};
  for (const m of mappingRows) {
    const key = `${(m.simla_customer_name || '').toLowerCase()}|${(m.simla_customer_phone || '').trim()}`;
    mappingByCustomer[key] = m.tiktok_username;
  }

  const orders = await fetchSimlaOrdersRange(dateFrom, dateTo);
  const samples = orders.filter(isFreeSample).map(o => {
    const s = sampleFromOrder(o, skuMap);
    // Aplicar auto-mapping si existe
    if (!s.tiktok_username && s.customer_name) {
      const key = `${s.customer_name.toLowerCase()}|${(s.customer_phone || '').trim()}`;
      const handleFromMap = mappingByCustomer[key];
      if (handleFromMap) {
        s.tiktok_username = handleFromMap;
        s.auto_assigned = 1;
      }
    }
    return s;
  });

  // Upsert por simla_order_id
  const upsert = db.prepare(`
    INSERT INTO tts_samples (
      sample_type, sent_date, approved_date, approved_status,
      simla_order_id, simla_order_num, tiktok_order_id,
      customer_name, customer_email, customer_phone, customer_address,
      shopify_tags_raw, custom_fields_raw,
      sku, all_skus, grupo, product_name, units,
      cogs, shipping_cost, original_price,
      tiktok_username, auto_assigned,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(simla_order_id) DO UPDATE SET
      approved_date    = excluded.approved_date,
      approved_status  = excluded.approved_status,
      shopify_tags_raw = excluded.shopify_tags_raw,
      custom_fields_raw= excluded.custom_fields_raw,
      all_skus         = excluded.all_skus,
      cogs             = excluded.cogs,
      shipping_cost    = excluded.shipping_cost,
      -- Solo actualizar handle si estaba NULL (respetar asignaciones manuales)
      tiktok_username  = COALESCE(tts_samples.tiktok_username, excluded.tiktok_username),
      auto_assigned    = CASE WHEN tts_samples.tiktok_username IS NULL AND excluded.tiktok_username IS NOT NULL
                              THEN 1 ELSE tts_samples.auto_assigned END,
      updated_at       = datetime('now')
  `);

  let inserted = 0, updated = 0;
  const tx = db.transaction(() => {
    for (const s of samples) {
      const existing = db.prepare('SELECT id FROM tts_samples WHERE simla_order_id = ?').get(s.simla_order_id);
      upsert.run(
        s.sample_type, s.sent_date, s.approved_date, s.approved_status,
        s.simla_order_id, s.simla_order_num, s.tiktok_order_id,
        s.customer_name, s.customer_email, s.customer_phone, s.customer_address,
        s.shopify_tags_raw, s.custom_fields_raw,
        s.sku, s.all_skus, s.grupo, s.product_name, s.units,
        s.cogs, s.shipping_cost, s.original_price,
        s.tiktok_username, s.auto_assigned,
      );
      if (existing) updated++; else inserted++;
    }
  });
  tx();

  console.log(`[samples] scan ${dateFrom}..${dateTo}: scanned=${orders.length} tts=${orders.filter(o=>o.site==='tik-tok-shop').length} samples=${samples.length} new=${inserted} updated=${updated}`);
  return { scanned: orders.length, detected: samples.length, inserted, updated };
}

/**
 * Calcula atribución de ventas para una muestra.
 *
 * Criterio: TODAS las ventas del handle TikTok en la ventana de atribución
 * desde approved_date (o sent_date si no hay approved) cuentan como ROI de
 * la muestra — independientemente del grupo del producto vendido.
 *
 * Justificación: el objetivo de enviar una muestra es convertir al creador
 * en afiliado activo; cualquier venta que haga desde ese momento es
 * consecuencia directa de esa conversión.
 *
 * Como info adicional exponemos también `orders_same_product` /
 * `revenue_same_product` para ver qué % corresponde al producto enviado.
 */
function computeAttribution(sample, windowDays = null) {
  const db = getDb();
  const win = windowDays || getAttributionWindowDays();

  if (!sample.tiktok_username) {
    return {
      orders: 0, orders_paid: 0, orders_org: 0,
      orders_same_product: 0, revenue_same_product: 0,
      revenue: 0, commission: 0, videos: 0, first_sale_date: null,
    };
  }

  const startDate = sample.approved_date || sample.sent_date;
  const endDate   = addDays(startDate, win);

  // TODAS las ventas del handle en la ventana (cualquier grupo)
  const rows = db.prepare(`
    SELECT * FROM tts_affiliate_orders
    WHERE tiktok_username = ?
      AND order_date BETWEEN ? AND ?
      AND (order_status IS NULL OR order_status NOT LIKE '%aptos%')
      AND (fully_refunded IS NULL OR fully_refunded = 0)
  `).all(sample.tiktok_username, startDate, endDate);

  let revenue = 0, commission = 0, ordersPaid = 0, ordersOrg = 0;
  let ordersSameProduct = 0, revenueSameProduct = 0;
  const videoSet = new Set();
  let firstSale = null;

  const sampleGrupo = (sample.grupo || '').toUpperCase();
  const sampleSku   = (sample.sku   || '').toUpperCase();

  for (const r of rows) {
    revenue    += r.revenue || 0;
    commission += r.commission || 0;
    if (r.comm_type === 'paid') ordersPaid++;
    else if (r.comm_type === 'org') ordersOrg++;
    if (r.video_id) videoSet.add(r.video_id);
    if (!firstSale || r.order_date < firstSale) firstSale = r.order_date;

    // Marcar si la venta es del mismo producto que la muestra
    const rGrupo = (r.grupo || '').toUpperCase();
    const rSku   = (r.sku   || '').toUpperCase();
    if ((sampleGrupo && rGrupo === sampleGrupo) || (sampleSku && rSku === sampleSku)) {
      ordersSameProduct++;
      revenueSameProduct += r.revenue || 0;
    }
  }

  return {
    orders:               rows.length,
    orders_paid:          ordersPaid,
    orders_org:           ordersOrg,
    orders_same_product:  ordersSameProduct,
    revenue_same_product: round(revenueSameProduct),
    revenue:              round(revenue),
    commission:           round(commission),
    videos:               videoSet.size,
    first_sale_date:      firstSale,
  };
}

/**
 * Sugerencias de handle para una muestra sin asignar.
 * Lista los handles que más vendieron el mismo grupo en la ventana.
 */
function suggestHandles(sample, windowDays = null) {
  const db = getDb();
  const win = windowDays || getAttributionWindowDays();
  const startDate = sample.approved_date || sample.sent_date;
  const endDate   = addDays(startDate, win);

  const rows = db.prepare(`
    SELECT tiktok_username,
           COUNT(*)            AS orders,
           SUM(revenue)        AS revenue,
           SUM(commission)     AS commission,
           COUNT(DISTINCT video_id) AS videos,
           MIN(order_date)     AS first_sale
    FROM tts_affiliate_orders
    WHERE (grupo = ? OR sku = ?)
      AND order_date BETWEEN ? AND ?
      AND (order_status IS NULL OR order_status NOT LIKE '%aptos%')
      AND (fully_refunded IS NULL OR fully_refunded = 0)
    GROUP BY tiktok_username
    ORDER BY orders DESC
    LIMIT 8
  `).all(sample.grupo || '', sample.sku || '', startDate, endDate);

  return rows.map(r => ({
    tiktok_username: r.tiktok_username,
    orders:          r.orders,
    revenue:         round(r.revenue),
    commission:      round(r.commission),
    videos:          r.videos,
    first_sale:      r.first_sale,
  }));
}

/**
 * Agrega atribución a cada muestra y devuelve datos listos para la UI.
 */
function getSamplesWithAttribution(from, to, type = null) {
  const db = getDb();

  let sql = 'SELECT * FROM tts_samples WHERE sent_date BETWEEN ? AND ?';
  const params = [from, to];
  if (type && (type === 'free' || type === 'reimbursable')) {
    sql += ' AND sample_type = ?';
    params.push(type);
  }
  sql += ' ORDER BY sent_date DESC, id DESC';

  const samples = db.prepare(sql).all(...params);
  const enriched = samples.map(s => {
    const attr = computeAttribution(s);
    return { ...s, attribution: attr };
  });

  return enriched;
}

module.exports = {
  CANCEL_STATUSES,
  REFUND_STATUSES,
  CONFIRMED_STATUSES,
  isFreeSample,
  extractTikTokOrderId,
  extractHandleFromText,
  fetchSimlaOrdersRange,
  sampleFromOrder,
  scanSamples,
  computeAttribution,
  suggestHandles,
  getSamplesWithAttribution,
  getAttributionWindowDays,
};
