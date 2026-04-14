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
          // Producto maestro con precio: siempre gana
          skuMap.set(article, {
            cost: offer.purchasePrice,
            stock: Math.max(offer.quantity || 0, skuMap.get(article)?.stock || 0),
          });
        } else if (isMaster && !skuMap.has(article)) {
          // Producto maestro sin precio: guardar al menos el stock
          skuMap.set(article, {
            cost: 0,
            stock: offer.quantity || 0,
          });
        } else if (!skuMap.has(article) && offer.purchasePrice > 0) {
          // Fallback: si no hay maestro, usar el primer listing con precio
          skuMap.set(article, {
            cost: offer.purchasePrice,
            stock: offer.quantity || 0,
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
async function syncSimlaCosts() {
  const simlaMap = await fetchSimlaProducts();
  const db = getDb();

  const localSkus = db.prepare('SELECT sku, cost FROM skus').all();
  const stmt = db.prepare('UPDATE skus SET cost = ?, updated_at = datetime("now") WHERE sku = ?');

  let updated = 0;
  const updateAll = db.transaction(() => {
    for (const local of localSkus) {
      const simla = simlaMap.get(local.sku);
      if (simla && simla.cost > 0 && Math.abs(simla.cost - local.cost) > 0.01) {
        stmt.run(simla.cost, local.sku);
        updated++;
      }
    }
  });

  updateAll();
  if (updated > 0) console.log(`[Simla] Sincronizados ${updated} costos de producto`);
  return updated;
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
