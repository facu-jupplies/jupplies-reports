/**
 * Servicio Simla CRM — stock y costos de producto.
 * Consulta la API de Simla para obtener purchasePrice y stock
 * de los productos maestros (product.name === offer.article).
 */

const { getDb } = require('../db');

const SIMLA_BASE = 'https://fulfillment.simla.com/api/v5';

// Cache en memoria: { data: Map, timestamp: number }
let _productCache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hora

function getSimlaApiKey() {
  const db = getDb();
  return db.prepare("SELECT value FROM app_settings WHERE key = 'simla_api_key'").pluck().get() || '';
}

/**
 * Obtiene todos los productos maestros de Simla con purchasePrice y stock.
 * Producto maestro = product.name === offer.article (el que refleja stock real).
 *
 * @returns {Map<string, {cost: number, stock: number}>} SKU → { cost, stock }
 */
async function fetchSimlaProducts() {
  // Devolver cache si es válido
  if (_productCache.data && (Date.now() - _productCache.timestamp) < CACHE_TTL) {
    return _productCache.data;
  }

  const apiKey = getSimlaApiKey();
  if (!apiKey) throw new Error('Simla API key no configurada. Ir a Configuración.');

  const skuMap = new Map();
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${SIMLA_BASE}/store/products?apiKey=${apiKey}&limit=100&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Simla API error ${res.status}`);

    const data = await res.json();
    if (!data.success) throw new Error(data.errorMsg || 'Error Simla API');

    totalPages = data.pagination?.totalPageCount || 1;

    for (const product of (data.products || [])) {
      for (const offer of (product.offers || [])) {
        const article = (offer.article || '').trim().toUpperCase();
        if (!article) continue;

        // Producto maestro: product.name coincide con el article de la offer
        const isMaster = product.name?.trim().toUpperCase() === article;

        if (isMaster && offer.purchasePrice > 0) {
          skuMap.set(article, {
            cost: offer.purchasePrice,
            stock: Math.max(offer.quantity || 0, skuMap.get(article)?.stock || 0),
            weight: offer.weight || skuMap.get(article)?.weight || 0,
            length: offer.length || skuMap.get(article)?.length || 0,
            width: offer.width || skuMap.get(article)?.width || 0,
            height: offer.height || skuMap.get(article)?.height || 0,
          });
        } else if (isMaster && !skuMap.has(article)) {
          skuMap.set(article, {
            cost: 0, stock: offer.quantity || 0,
            weight: offer.weight || 0, length: offer.length || 0,
            width: offer.width || 0, height: offer.height || 0,
          });
        } else if (!skuMap.has(article) && offer.purchasePrice > 0) {
          skuMap.set(article, {
            cost: offer.purchasePrice, stock: offer.quantity || 0,
            weight: offer.weight || 0, length: offer.length || 0,
            width: offer.width || 0, height: offer.height || 0,
          });
        }
      }
    }

    page++;
  }

  console.log(`[Simla] ${skuMap.size} productos maestros cargados (${totalPages} páginas)`);

  _productCache = { data: skuMap, timestamp: Date.now() };
  return skuMap;
}

/**
 * Obtiene stock y costo de un SKU específico.
 * Usa cache; si no está en cache, intenta fetch.
 */
async function getSimlaSkuInfo(sku) {
  const map = await fetchSimlaProducts();
  return map.get(sku.toUpperCase()) || null;
}

/**
 * Devuelve el mapa completo SKU → { cost, stock } como objeto plano.
 * Para enviar al frontend vía API.
 */
async function getSimlaStockMap() {
  const map = await fetchSimlaProducts();
  const result = {};
  for (const [sku, data] of map) {
    result[sku] = data;
  }
  return result;
}

/**
 * Sincroniza costos de Simla → tabla local skus.
 * Actualiza skus.cost con el purchasePrice del producto maestro.
 * Solo actualiza SKUs que ya existen en la tabla local.
 *
 * @returns {number} cantidad de SKUs actualizados
 */
/**
 * Calcula el costo de envío España con Correos Express.
 * Peso facturable = max(peso_real_kg, L_m × A_m × H_m × 170)
 */
function calcShippingES(weight, length, width, height) {
  if (!weight && !length) return 0;
  // Dimensiones en cm → metros
  const volWeight = (length / 100) * (width / 100) * (height / 100) * 170;
  const billable = Math.max(weight || 0, volWeight);
  if (billable <= 0) return 0;

  // Tarifa Correos Express España
  if (billable <= 1)  return 2.88;
  if (billable <= 3)  return 3.27;
  if (billable <= 5)  return 3.51;
  if (billable <= 7)  return 4.18;
  if (billable <= 10) return 4.98;
  if (billable <= 15) return 6.18;
  if (billable <= 20) return 7.54;
  if (billable <= 25) return 8.97;
  if (billable <= 30) return 10.93;
  if (billable <= 40) return 13.88;
  // Más de 40kg: base 40kg + €0.33/kg extra
  return 13.88 + (billable - 40) * 0.33;
}

/**
 * Sincroniza datos de Simla → tabla local skus.
 * Actualiza: cost, weight, length, width, height, stock, shipping_es, shipping_tts
 * Agrega SKUs nuevos que están en Simla pero no en la DB local.
 * NO toca: grupo, is_upsell (esos son manuales).
 */
async function syncSimlaCosts() {
  const simlaMap = await fetchSimlaProducts();
  const db = getDb();

  const localSkus = db.prepare('SELECT sku FROM skus').all();
  const localSet = new Set(localSkus.map(s => s.sku));

  const stmtUpdate = db.prepare(`
    UPDATE skus SET cost = ?, weight = ?, length = ?, width = ?, height = ?,
    stock = ?, shipping_es = ?, shipping_tts = 3.10, updated_at = datetime('now')
    WHERE sku = ?
  `);

  const stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO skus (sku, cost, weight, length, width, height, stock, shipping_es, shipping_tts, grupo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3.10, '', datetime('now'))
  `);

  let updated = 0, inserted = 0;
  const syncAll = db.transaction(() => {
    for (const [sku, simla] of simlaMap) {
      if (simla.cost <= 0 && simla.stock <= 0) continue; // skip empty entries

      const shippingES = calcShippingES(simla.weight, simla.length, simla.width, simla.height);

      if (localSet.has(sku)) {
        stmtUpdate.run(simla.cost, simla.weight, simla.length, simla.width, simla.height,
          simla.stock, shippingES, sku);
        updated++;
      } else {
        stmtInsert.run(sku, simla.cost, simla.weight, simla.length, simla.width, simla.height,
          simla.stock, shippingES);
        inserted++;
      }
    }
  });

  syncAll();
  console.log(`[Simla] Sync: ${updated} actualizados, ${inserted} nuevos`);
  return { updated, inserted };
}

/**
 * Invalida el cache de productos (para forzar refresh).
 */
function invalidateCache() {
  _productCache = { data: null, timestamp: 0 };
}

/**
 * Obtiene pedidos de Simla para una fecha y canal.
 * Reemplaza a Shopify CLI para pedidos web y Windsor para TTS.
 *
 * @param {string} date   YYYY-MM-DD
 * @param {string} site   Canal: '000-amz' (Shopify), 'tik-tok-shop' (TTS), 'jup-amazon', etc.
 * @returns {Array} pedidos normalizados con SKU, cantidad, precio, tipo de pago
 */
/**
 * @param {string} date YYYY-MM-DD
 * @param {string} site Canal de Simla
 * @param {Object} opts Opciones
 * @param {boolean} opts.recoverCancelledPrice Si true, cancelados usan initialPrice (para Shopify COD). Si false, cancelados = €0 (para TTS).
 */
async function fetchSimlaOrders(date, site = '000-amz', opts = {}) {
  const { recoverCancelledPrice = (site === '000-amz') } = opts;
  const apiKey = getSimlaApiKey();
  if (!apiKey) throw new Error('Simla API key no configurada. Ir a Configuración.');

  const orders = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${SIMLA_BASE}/orders?apiKey=${apiKey}&limit=100&filter%5BcreatedAtFrom%5D=${date}+00%3A00%3A00&filter%5BcreatedAtTo%5D=${date}+23%3A59%3A59&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Simla API error ${res.status}`);

    const data = await res.json();
    if (!data.success) throw new Error(data.errorMsg || 'Error Simla API');

    totalPages = data.pagination?.totalPageCount || 1;

    for (const order of (data.orders || [])) {
      if (order.site !== site) continue;

      // Cancelados: Simla pone totalSumm=0, pero el precio original está en items[].initialPrice
      // Los incluimos con el precio original para que la facturación bruta sea correcta
      // (el % de efectividad COD ya descuenta los que no se cobran)
      const isCancelled = (order.status || '').toLowerCase().includes('cancel');
      // Shopify web: recuperar precio original de cancelados (para métricas COD)
      // TTS: cancelados = €0 (la facturación real es lo que dice Simla)
      const originalTotal = (isCancelled && recoverCancelledPrice)
        ? (order.items || []).reduce((s, i) => s + (i.initialPrice || 0) * (i.quantity || 1), 0)
        : 0;

      // Detectar COD vs Tarjeta:
      // En Simla, todos los pedidos Shopify llegan como type "cash".
      // La diferencia: status "paid" = tarjeta (ya cobrado), "not-paid" = COD (pendiente).
      // También se chequea el comment por "COD" como fallback.
      const payment = Object.values(order.payments || {})[0];
      const isCod = payment
        ? (payment.status === 'not-paid' || (payment.comment || '').toLowerCase().includes('cod'))
        : false;

      orders.push({
        name:           order.number,
        externalId:     order.externalId,
        totalPrice:     isCancelled ? originalTotal : (order.totalSumm || 0),
        paymentType:    isCod ? 'cod' : 'card',
        status:         order.status,
        cancelled:      isCancelled,
        createdAt:      order.createdAt,
        items: (order.items || []).map(item => ({
          sku:      (item.offer?.article || '').trim().toUpperCase(),
          quantity: item.quantity || 1,
          price:    item.initialPrice || 0,
        })),
      });
    }
    page++;
  }

  console.log(`[Simla] ${orders.length} pedidos ${site} para ${date} (${totalPages} páginas)`);
  return orders;
}

/**
 * Obtiene pedidos TTS de Simla para una fecha.
 * Devuelve mapa externalId → { skus: string[], totalSumm: number }
 * para enriquecer pedidos TTS con SKUs reales.
 */
async function fetchSimlaTTSOrders(date) {
  const apiKey = getSimlaApiKey();
  if (!apiKey) return {};

  const orderMap = {};
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${SIMLA_BASE}/orders?apiKey=${apiKey}&limit=100&filter%5BcreatedAtFrom%5D=${date}+00%3A00%3A00&filter%5BcreatedAtTo%5D=${date}+23%3A59%3A59&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) break;

    const data = await res.json();
    if (!data.success) break;

    totalPages = data.pagination?.totalPageCount || 1;

    for (const order of (data.orders || [])) {
      if (order.site !== 'tik-tok-shop') continue;
      if ((order.status || '').toLowerCase().includes('cancel')) continue;
      const extId = String(order.externalId || '').trim();
      if (!extId) continue;

      const skus = (order.items || [])
        .map(i => (i.offer?.article || '').trim().toUpperCase())
        .filter(Boolean);

      orderMap[extId] = {
        skus,
        totalSumm: order.totalSumm || 0,
        number: order.number,
      };
    }
    page++;
  }

  console.log(`[Simla] ${Object.keys(orderMap).length} pedidos TTS encontrados para ${date}`);
  return orderMap;
}

/**
 * Construye mapa nombre_producto → SKU desde pedidos TTS en Simla.
 * Usa los items de pedidos para vincular displayName con offer.article.
 * Se usa para matchear las comisiones del CSV de afiliados con SKUs reales.
 */
async function buildTTSProductNameMap(dateFrom, dateTo) {
  const apiKey = getSimlaApiKey();
  if (!apiKey) return {};

  const nameToSku = {};
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const url = `${SIMLA_BASE}/orders?apiKey=${apiKey}&limit=100&filter%5BcreatedAtFrom%5D=${dateFrom}+00%3A00%3A00&filter%5BcreatedAtTo%5D=${dateTo}+23%3A59%3A59&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    if (!data.success) break;
    totalPages = data.pagination?.totalPageCount || 1;

    for (const order of (data.orders || [])) {
      if (order.site !== 'tik-tok-shop') continue;
      for (const item of (order.items || [])) {
        const name = (item.offer?.displayName || '').trim();
        const sku = (item.offer?.article || '').trim().toUpperCase();
        if (name && sku) nameToSku[name] = sku;
      }
    }
    page++;
  }

  console.log(`[Simla] ${Object.keys(nameToSku).length} mapeos nombre→SKU para TTS`);
  return nameToSku;
}

module.exports = {
  fetchSimlaProducts,
  fetchSimlaOrders,
  fetchSimlaTTSOrders,
  buildTTSProductNameMap,
  getSimlaSkuInfo,
  getSimlaStockMap,
  syncSimlaCosts,
  invalidateCache,
};
