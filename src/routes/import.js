const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { importDayFromWindsor, fetchWindsorAds, saveAdSpend, saveOrdersFromSimla } = require('../services/windsorService');
const { fetchSimlaOrders } = require('../services/simlaService');
const { parseSku, calcShippingForOrder } = require('../services/calculator');

// GET /api/import/day?date=YYYY-MM-DD
// Flujo principal: pedidos de Simla + ads de Windsor
router.get('/day', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Parámetro date requerido en formato YYYY-MM-DD' });
  }

  try {
    // Obtener pedidos de Simla y ads de Windsor en paralelo
    const [simlaResult, adsResult] = await Promise.allSettled([
      fetchSimlaOrders(date, '000-amz'),
      fetchWindsorAds(date),
    ]);

    // Simla es obligatorio
    if (simlaResult.status === 'rejected') {
      throw new Error('Error al obtener pedidos de Simla: ' + simlaResult.reason.message);
    }

    const simlaOrders = simlaResult.value;

    // Guardar pedidos
    const ordersResult = saveOrdersFromSimla(simlaOrders, date);

    // Ads son opcionales — si Windsor falla, seguimos con los pedidos
    let adsCount = 0;
    let adsWarning = null;
    if (adsResult.status === 'fulfilled') {
      const { metaRows, tiktokRows } = adsResult.value;
      const adsSaved = saveAdSpend(metaRows, tiktokRows, date);
      adsCount = adsSaved.count;
    } else {
      adsWarning = 'No se pudieron importar los anuncios: ' + adsResult.reason.message;
      console.warn('[import/day]', adsWarning);
    }

    res.json({
      ok: true,
      date,
      orders_imported: ordersResult.count,
      orders_skipped: ordersResult.skipped,
      ads_imported: adsCount,
      ads_warning: adsWarning,
    });
  } catch (err) {
    console.error('[import/day]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/import/windsor?date=YYYY-MM-DD (fallback — mantener por compatibilidad)
router.get('/windsor', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Parámetro date requerido en formato YYYY-MM-DD' });
  }

  try {
    const result = await importDayFromWindsor(date);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/import/csv/shopify
// Body JSON: { date: "YYYY-MM-DD", rows: [{order_name, payment_type, order_total, sku, qty, price}] }
router.post('/csv/shopify', (req, res) => {
  const db = getDb();
  const { date, rows } = req.body;

  if (!date || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Se requiere date y rows[]' });
  }

  const allSkus = db.prepare('SELECT * FROM skus').all();
  const skuMap = {};
  for (const s of allSkus) skuMap[s.sku] = s;

  const now = new Date().toISOString();

  const stmtOrder = db.prepare(`
    INSERT INTO orders (order_name, date, payment_type, order_total, line_sku, line_qty, line_price, product_cost, shipping_cost, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(order_name, line_sku) DO UPDATE SET
      date = excluded.date,
      payment_type = excluded.payment_type,
      order_total = excluded.order_total,
      line_qty = excluded.line_qty,
      line_price = excluded.line_price,
      product_cost = excluded.product_cost,
      shipping_cost = excluded.shipping_cost,
      updated_at = excluded.updated_at
  `);

  const stmtCod = db.prepare(`
    INSERT OR IGNORE INTO cod_tracking (order_name, order_date, order_total, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `);

  let count = 0;

  const insertAll = db.transaction(() => {
    for (const row of rows) {
      const { order_name, payment_type, order_total, sku, qty = 1, price = 0 } = row;
      if (!order_name || !sku) continue;

      const skuUpper  = sku.toUpperCase();
      const skuData   = skuMap[skuUpper];
      const productCost = skuData ? (skuData.cost * qty) : 0;
      const shipCost    = skuData ? skuData.shipping_es  : 0;
      const type        = (payment_type || 'card').toLowerCase() === 'cod' ? 'cod' : 'card';

      stmtOrder.run(
        order_name, date, type,
        parseFloat(order_total) || 0,
        skuUpper, parseInt(qty), parseFloat(price) || 0,
        productCost, shipCost,
        now, now
      );

      if (type === 'cod') {
        stmtCod.run(order_name, date, parseFloat(order_total) || 0, now, now);
      }
      count++;
    }
  });

  insertAll();
  res.json({ ok: true, imported: count });
});

// POST /api/import/csv/simla
// Body JSON: { rows: [{order_name, status, simla_order_id?}] }
router.post('/csv/simla', (req, res) => {
  const db = getDb();
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Se requiere rows[]' });
  }

  const VALID_STATUSES = ['pending', 'confirmed', 'delivered', 'paid', 'refused', 'returned'];
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    UPDATE cod_tracking
    SET status = ?,
        simla_order_id = COALESCE(?, simla_order_id),
        confirmed_at = CASE WHEN ? IN ('confirmed','delivered','paid') AND confirmed_at IS NULL THEN ? ELSE confirmed_at END,
        delivered_at = CASE WHEN ? IN ('delivered','paid') AND delivered_at IS NULL THEN ? ELSE delivered_at END,
        resolved_at  = CASE WHEN ? IN ('paid','refused','returned') AND resolved_at IS NULL THEN ? ELSE resolved_at END,
        updated_at = ?
    WHERE order_name = ?
  `);

  let matched = 0, notFound = [];

  const updateAll = db.transaction(() => {
    for (const row of rows) {
      const orderName  = (row.order_name || '').trim();
      const status     = (row.status || '').toLowerCase();
      const simlaId    = row.simla_order_id || null;

      if (!orderName || !VALID_STATUSES.includes(status)) continue;

      const result = stmt.run(
        status, simlaId,
        status, now,   // confirmed_at
        status, now,   // delivered_at
        status, now,   // resolved_at
        now,
        orderName
      );

      if (result.changes > 0) {
        matched++;
      } else {
        notFound.push(orderName);
      }
    }
  });

  updateAll();
  res.json({ ok: true, matched, not_found: notFound });
});

// GET /api/import/campaigns — listar mapeos campaña→grupo con opción de editar
// Incluye: campañas conocidas (campaign_sku_map) + campañas sin mapeo (solo en ad_spend)
router.get('/campaigns', (req, res) => {
  const db = getDb();
  const campaigns = db.prepare(`
    SELECT csm.id, csm.platform, csm.campaign_key, csm.sku_group, csm.is_manual,
           COALESCE(SUM(ads.spend), 0) as total_spend
    FROM campaign_sku_map csm
    LEFT JOIN ad_spend ads ON ads.platform = csm.platform AND ads.campaign_name = csm.campaign_key
    GROUP BY csm.id

    UNION ALL

    SELECT NULL as id, a.platform, a.campaign_name as campaign_key,
           NULL as sku_group, 0 as is_manual,
           SUM(a.spend) as total_spend
    FROM ad_spend a
    WHERE a.sku_group IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM campaign_sku_map m
        WHERE m.platform = a.platform AND m.campaign_key = a.campaign_name
      )
    GROUP BY a.platform, a.campaign_name

    ORDER BY total_spend DESC
  `).all();
  res.json(campaigns);
});

// POST /api/import/campaigns/map — crear nuevo mapeo para campaña sin id previo
router.post('/campaigns/map', (req, res) => {
  const db = getDb();
  const { platform, campaign_key, sku_group } = req.body;
  if (!platform || !campaign_key) return res.status(400).json({ error: 'platform y campaign_key requeridos' });

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO campaign_sku_map (platform, campaign_key, sku_group, is_manual, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(platform, campaign_key) DO UPDATE SET sku_group=excluded.sku_group, is_manual=1, updated_at=excluded.updated_at
  `).run(platform, campaign_key, sku_group || null, now);

  // Actualizar ad_spend existentes
  if (sku_group) {
    db.prepare(`
      UPDATE ad_spend SET sku_group = ?, is_manual_map = 1
      WHERE platform = ? AND campaign_name = ?
    `).run(sku_group, platform, campaign_key);
  }

  res.json({ ok: true });
});

// POST /api/import/campaigns/:id — actualizar mapeo campaña→grupo (manual)
router.post('/campaigns/:id', (req, res) => {
  const db = getDb();
  const { sku_group } = req.body;
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE campaign_sku_map SET sku_group = ?, is_manual = 1, updated_at = ? WHERE id = ?
  `).run(sku_group, now, req.params.id);

  // También actualizar los ad_spend existentes con esta campaña
  const map = db.prepare('SELECT * FROM campaign_sku_map WHERE id = ?').get(req.params.id);
  if (map) {
    db.prepare(`
      UPDATE ad_spend SET sku_group = ?, is_manual_map = 1
      WHERE platform = ? AND campaign_name = ?
    `).run(sku_group, map.platform, map.campaign_key);
  }

  res.json({ ok: true });
});

module.exports = router;
