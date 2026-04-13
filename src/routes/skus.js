const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// GET /api/skus — listar todos
router.get('/', (req, res) => {
  const db = getDb();
  const skus = db.prepare('SELECT * FROM skus ORDER BY sku ASC').all();
  res.json(skus);
});

// GET /api/skus/:sku — obtener uno
router.get('/:sku', (req, res) => {
  const db = getDb();
  const sku = db.prepare('SELECT * FROM skus WHERE sku = ?').get(req.params.sku.toUpperCase());
  if (!sku) return res.status(404).json({ error: 'SKU no encontrado' });
  res.json(sku);
});

// POST /api/skus — crear o actualizar
router.post('/', (req, res) => {
  const db = getDb();
  const { sku, cost, shipping_es, shipping_int, grupo, is_upsell } = req.body;

  if (!sku) return res.status(400).json({ error: 'SKU requerido' });

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO skus (sku, cost, shipping_es, shipping_int, grupo, is_upsell, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET
      cost = excluded.cost,
      shipping_es = excluded.shipping_es,
      shipping_int = excluded.shipping_int,
      grupo = excluded.grupo,
      is_upsell = excluded.is_upsell,
      updated_at = excluded.updated_at
  `).run(
    sku.toUpperCase(),
    parseFloat(cost) || 0,
    parseFloat(shipping_es) || 0,
    parseFloat(shipping_int) || 0,
    (grupo || '').toUpperCase(),
    is_upsell ? 1 : 0,
    now
  );

  res.json({ ok: true });
});

// DELETE /api/skus/all — eliminar todos los SKUs
router.delete('/all', (req, res) => {
  const db = getDb();
  db.exec('DELETE FROM skus');
  res.json({ ok: true });
});

// DELETE /api/skus/:sku
router.delete('/:sku', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM skus WHERE sku = ?').run(req.params.sku.toUpperCase());
  res.json({ ok: true });
});

// POST /api/skus/import/csv — importar CSV masivo
// Body: { rows: [{sku, cost, shipping_es, shipping_int, grupo}] }
router.post('/import/csv', (req, res) => {
  const db = getDb();
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No hay filas para importar' });
  }

  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO skus (sku, cost, shipping_es, shipping_int, grupo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sku) DO UPDATE SET
      cost = excluded.cost,
      shipping_es = excluded.shipping_es,
      shipping_int = excluded.shipping_int,
      grupo = excluded.grupo,
      updated_at = excluded.updated_at
  `);

  const importMany = db.transaction((rows) => {
    let count = 0;
    for (const row of rows) {
      if (!row.sku) continue;
      stmt.run(
        row.sku.toUpperCase(),
        parseFloat(row.cost) || 0,
        parseFloat(row.shipping_es) || 0,
        parseFloat(row.shipping_int) || 0,
        (row.grupo || '').toUpperCase(),
        now
      );
      count++;
    }
    return count;
  });

  const count = importMany(rows);
  res.json({ ok: true, imported: count });
});

module.exports = router;
