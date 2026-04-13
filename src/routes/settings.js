const express = require('express');
const router = express.Router();
const { getDb } = require('../db');

// GET /api/settings — todos los settings
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = {};
  for (const r of rows) settings[r.key] = r.value;
  // No exponer la contraseña al frontend
  delete settings.app_password;
  res.json(settings);
});

// POST /api/settings — actualizar uno o varios
// Body: { cod_confirmation_rate: "0.85", windsor_api_key: "..." }
router.post('/', (req, res) => {
  const db = getDb();
  const now = new Date().toISOString();

  const ALLOWED = [
    'cod_confirmation_rate', 'cod_delivery_rate', 'return_shipping_cost',
    'vat_rate', 'windsor_api_key', 'windsor_store', 'app_user', 'app_password',
    'tts_shopify_store', 'tts_tiktok_account', 'tts_iva_pct', 'tts_platform_pct',
    'simla_api_key'
  ];

  const stmt = db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const updateMany = db.transaction((data) => {
    for (const [key, value] of Object.entries(data)) {
      if (ALLOWED.includes(key)) stmt.run(key, String(value), now);
    }
  });

  updateMany(req.body);
  res.json({ ok: true });
});

module.exports = router;
