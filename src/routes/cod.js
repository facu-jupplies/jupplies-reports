const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// GET /api/cod?status=pending&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/', (req, res) => {
  const db = getDb();
  const { status, from, to } = req.query;

  let sql = 'SELECT c.*, o.line_sku FROM cod_tracking c LEFT JOIN orders o ON o.order_name = c.order_name WHERE 1=1';
  const params = [];

  if (status) { sql += ' AND c.status = ?'; params.push(status); }
  if (from)   { sql += ' AND c.order_date >= ?'; params.push(from); }
  if (to)     { sql += ' AND c.order_date <= ?'; params.push(to); }

  sql += ' ORDER BY c.order_date DESC LIMIT 500';

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// GET /api/cod/summary — resumen de estados
router.get('/summary', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count, SUM(order_total) as total_amount
    FROM cod_tracking
    GROUP BY status
  `).all();

  const summary = { pending: 0, confirmed: 0, delivered: 0, paid: 0, refused: 0, returned: 0 };
  const amounts  = { ...summary };

  for (const r of rows) {
    summary[r.status] = r.count;
    amounts[r.status] = r.total_amount;
  }

  res.json({ counts: summary, amounts });
});

// GET /api/cod/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const { from, to } = req.query;

  const params = [];
  let df = '';
  if (from) { df += ' AND c.order_date >= ?'; params.push(from); }
  if (to)   { df += ' AND c.order_date <= ?'; params.push(to); }

  // 1. Estado COD
  const statusRows = db.prepare(`
    SELECT status, COUNT(*) as cnt, COALESCE(SUM(order_total), 0) as amount
    FROM cod_tracking c WHERE 1=1 ${df}
    GROUP BY status
  `).all(...params);

  const STATUSES = ['pending','confirmed','delivered','paid','refused','returned'];
  const counts  = Object.fromEntries(STATUSES.map(s => [s, 0]));
  const amounts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of statusRows) {
    if (r.status in counts) { counts[r.status] = r.cnt; amounts[r.status] = r.amount; }
  }

  const totalOrders  = STATUSES.reduce((a, s) => a + counts[s], 0);
  const totalAmount  = STATUSES.reduce((a, s) => a + amounts[s], 0);
  const inTransit    = counts.pending + counts.confirmed + counts.delivered;
  const inTransitAmt = amounts.pending + amounts.confirmed + amounts.delivered;
  const lost         = counts.refused + counts.returned;
  const lostAmt      = amounts.refused + amounts.returned;
  const convRate     = totalOrders > 0 ? (counts.paid / totalOrders * 100) : 0;

  // 2. Días promedio hasta resolución
  const resRow = db.prepare(`
    SELECT AVG(JULIANDAY(resolved_at) - JULIANDAY(order_date)) as avg_days
    FROM cod_tracking c WHERE resolved_at IS NOT NULL ${df}
  `).get(...params);

  // 3. Desglose por SKU/grupo (un SKU por pedido, sin duplicar order_total)
  const skuRows = db.prepare(`
    SELECT
      COALESCE(sk.grupo, sub.line_sku, 'Sin SKU') as grupo,
      COUNT(DISTINCT c.order_name) as orders,
      COALESCE(SUM(c.order_total), 0) as amount
    FROM cod_tracking c
    LEFT JOIN (
      SELECT order_name, MIN(line_sku) as line_sku FROM orders GROUP BY order_name
    ) sub ON sub.order_name = c.order_name
    LEFT JOIN skus sk ON sk.sku = sub.line_sku
    WHERE 1=1 ${df}
    GROUP BY COALESCE(sk.grupo, sub.line_sku, 'Sin SKU')
    ORDER BY amount DESC
    LIMIT 8
  `).all(...params);

  // 4. Métodos de pago — todos los pedidos del período
  const pmParams = [];
  let pmf = '';
  if (from) { pmf += ' AND date >= ?'; pmParams.push(from); }
  if (to)   { pmf += ' AND date <= ?'; pmParams.push(to); }

  const pmRows = db.prepare(`
    SELECT payment_type, COUNT(*) as cnt, SUM(order_total) as amount
    FROM (
      SELECT order_name, payment_type, MAX(order_total) as order_total
      FROM orders WHERE 1=1 ${pmf}
      GROUP BY order_name, payment_type
    ) GROUP BY payment_type
  `).all(...pmParams);

  const paymentMethods = { cod: { count: 0, amount: 0 }, card: { count: 0, amount: 0 } };
  for (const r of pmRows) {
    const key = r.payment_type === 'cod' ? 'cod' : 'card';
    paymentMethods[key] = { count: r.cnt, amount: r.amount || 0 };
  }

  // 5. Ad spend por plataforma
  const adRows = db.prepare(`
    SELECT platform, SUM(spend) as spend, SUM(conversions) as conversions, SUM(purchase_value) as purchase_value
    FROM ad_spend WHERE 1=1 ${pmf}
    GROUP BY platform
  `).all(...pmParams);

  const adByPlatform = {};
  for (const r of adRows) {
    adByPlatform[r.platform] = { spend: r.spend || 0, conversions: r.conversions || 0, purchaseValue: r.purchase_value || 0 };
  }
  const totalAdSpend = Object.values(adByPlatform).reduce((a, p) => a + p.spend, 0);

  res.json({
    period: { from, to },
    cod: { totalOrders, totalAmount, counts, amounts, inTransit, inTransitAmt, lost, lostAmt, convRate, avgDays: resRow?.avg_days || 0 },
    skuRows,
    paymentMethods,
    adByPlatform,
    totalAdSpend,
  });
});

// PATCH /api/cod/:order_name — actualizar estado de un pedido COD
router.patch('/:order_name', (req, res) => {
  const db = getDb();
  const { status, simla_order_id } = req.body;
  const orderName = req.params.order_name;

  const VALID = ['pending', 'confirmed', 'delivered', 'paid', 'refused', 'returned'];
  if (!VALID.includes(status)) {
    return res.status(400).json({ error: `Estado inválido. Válidos: ${VALID.join(', ')}` });
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE cod_tracking
    SET status = ?,
        simla_order_id = COALESCE(?, simla_order_id),
        confirmed_at = CASE WHEN ? IN ('confirmed','delivered','paid') AND confirmed_at IS NULL THEN ? ELSE confirmed_at END,
        delivered_at = CASE WHEN ? IN ('delivered','paid') AND delivered_at IS NULL THEN ? ELSE delivered_at END,
        resolved_at  = CASE WHEN ? IN ('paid','refused','returned') AND resolved_at IS NULL THEN ? ELSE resolved_at END,
        updated_at = ?
    WHERE order_name = ?
  `).run(
    status, simla_order_id || null,
    status, now,
    status, now,
    status, now,
    now, orderName
  );

  res.json({ ok: true });
});

module.exports = router;
