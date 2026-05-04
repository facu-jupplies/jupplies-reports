const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { calcDayMetrics, calcSkuMetrics } = require('../services/calculator');
const { buildRealizedReport } = require('../services/realizedService');

function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

// GET /api/reports/day?date=YYYY-MM-DD
router.get('/day', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date requerido' });

  const db = getDb();
  const orders  = db.prepare('SELECT * FROM orders  WHERE date = ?').all(date);
  const adSpend = db.prepare('SELECT * FROM ad_spend WHERE date = ?').all(date);

  if (orders.length === 0 && adSpend.length === 0) {
    return res.json({ date, empty: true, orders: [], adSpend: [], metrics: null, skuMetrics: [] });
  }

  const settings   = getSettings();
  const metrics    = calcDayMetrics({ orders, adSpend, settings });
  const skuMetrics = calcSkuMetrics({ orders, adSpend, settings });

  res.json({ date, metrics, skuMetrics, orders_count: orders.length, ads_count: adSpend.length });
});

// GET /api/reports/history?from=YYYY-MM-DD&to=YYYY-MM-DD
// Devuelve lista de días con métricas resumidas
router.get('/history', (req, res) => {
  const { from, to } = req.query;
  const db = getDb();

  let whereClause = '';
  const params = [];
  if (from && to) {
    whereClause = 'WHERE o.date BETWEEN ? AND ?';
    params.push(from, to);
  } else if (from) {
    whereClause = 'WHERE o.date >= ?';
    params.push(from);
  }

  // Obtener todos los datos del rango en 2 queries (en vez de N+1)
  const allOrders = db.prepare(`
    SELECT o.* FROM orders o ${whereClause} ORDER BY o.date DESC
  `).all(...params);

  const adParams = [...params]; // mismos params para ads
  const allAds = db.prepare(`
    SELECT a.* FROM ad_spend a ${whereClause.replace(/o\./g, 'a.')}
  `).all(...adParams);

  // Agrupar por fecha
  const ordersByDate = {};
  for (const o of allOrders) {
    if (!ordersByDate[o.date]) ordersByDate[o.date] = [];
    ordersByDate[o.date].push(o);
  }
  const adsByDate = {};
  for (const a of allAds) {
    if (!adsByDate[a.date]) adsByDate[a.date] = [];
    adsByDate[a.date].push(a);
  }

  const settings = getSettings();
  const dates = Object.keys(ordersByDate).sort().reverse().slice(0, 90);
  const result = dates.map(date => {
    const m = calcDayMetrics({ orders: ordersByDate[date] || [], adSpend: adsByDate[date] || [], settings });
    return { date, ...m };
  });

  res.json(result);
});

// GET /api/reports/period?from=YYYY-MM-DD&to=YYYY-MM-DD
// Métricas agregadas para un rango de fechas
router.get('/period', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from y to requeridos' });

  const db = getDb();
  const orders  = db.prepare('SELECT * FROM orders  WHERE date BETWEEN ? AND ?').all(from, to);
  const adSpend = db.prepare('SELECT * FROM ad_spend WHERE date BETWEEN ? AND ?').all(from, to);

  const settings   = getSettings();
  const metrics    = calcDayMetrics({ orders, adSpend, settings });
  const skuMetrics = calcSkuMetrics({ orders, adSpend, settings });

  // Días individuales para la tabla de detalle
  const days = [...new Set(orders.map(o => o.date))].sort();
  const dayDetail = days.map(date => {
    const dayOrders  = orders.filter(o => o.date === date);
    const dayAds     = adSpend.filter(a => a.date === date);
    const m = calcDayMetrics({ orders: dayOrders, adSpend: dayAds, settings });
    return { date, ...m };
  });

  res.json({ from, to, metrics, skuMetrics, dayDetail });
});

// GET /api/reports/monthly?year=2026&month=3&mode=projected|real
router.get('/monthly', (req, res) => {
  const { year, month, mode = 'projected' } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year y month requeridos' });

  const y = parseInt(year), m = parseInt(month);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;

  const db = getDb();
  const orders  = db.prepare('SELECT * FROM orders  WHERE date BETWEEN ? AND ?').all(from, to);
  const adSpend = db.prepare('SELECT * FROM ad_spend WHERE date BETWEEN ? AND ?').all(from, to);
  const codRows = db.prepare('SELECT * FROM cod_tracking WHERE order_date BETWEEN ? AND ?').all(from, to);

  const settings = getSettings();

  // Modo real: usar datos de Simla si están disponibles
  let metrics, skuMetrics;

  if (mode === 'real') {
    // TODO: calcRealMonthMetrics no existe aún — usar calcDayMetrics como fallback
    // para evitar crash cuando se pide mode=real desde el frontend.
    metrics    = calcDayMetrics({ orders, adSpend, settings });
    skuMetrics = calcSkuMetrics({ orders, adSpend, settings });
  } else {
    metrics    = calcDayMetrics({ orders, adSpend, settings });
    skuMetrics = calcSkuMetrics({ orders, adSpend, settings });
  }

  // Resumen COD
  const codSummary = {
    total:    codRows.length,
    pending:  codRows.filter(c => c.status === 'pending').length,
    confirmed: codRows.filter(c => c.status === 'confirmed').length,
    delivered: codRows.filter(c => c.status === 'delivered').length,
    paid:     codRows.filter(c => c.status === 'paid').length,
    refused:  codRows.filter(c => c.status === 'refused').length,
    returned: codRows.filter(c => c.status === 'returned').length,
  };

  res.json({ year: y, month: m, from, to, mode, metrics, skuMetrics, codSummary });
});

// GET /api/reports/realized?from=YYYY-MM-DD&to=YYYY-MM-DD&site=000-amz
// Reporte REAL desde Simla (estados actuales, no especulativo).
router.get('/realized', async (req, res) => {
  const { from, to, site = '000-amz' } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from y to requeridos' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Formato de fecha inválido (YYYY-MM-DD)' });
  }
  try {
    const data = await buildRealizedReport({ from, to, site });
    res.json(data);
  } catch (err) {
    console.error('[reports/realized]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
