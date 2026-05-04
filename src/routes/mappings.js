const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const { suggestHandles, getAttributionWindowDays } = require('../services/samplesService');

function round(n, decimals = 2) {
  return Math.round(((n || 0) + Number.EPSILON) * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// ─── GET /api/tts/mappings ─────────────────────────────────────────────
// Devuelve:
// - mapped:    clientes Simla que YA tienen handle asignado (agregados)
// - unmapped:  clientes Simla con muestras sin handle (para asignar)
// Agrupados por customer_name + customer_phone.
router.get('/', (req, res) => {
  try {
    const db = getDb();

    // Agregar muestras por cliente (name + phone)
    const rows = db.prepare(`
      SELECT
        customer_name,
        customer_phone,
        customer_email,
        tiktok_username,
        COUNT(*)                     AS sample_count,
        SUM(cogs + shipping_cost)    AS total_cost,
        MIN(sent_date)               AS first_sample,
        MAX(sent_date)               AS last_sample,
        GROUP_CONCAT(DISTINCT grupo) AS grupos_csv
      FROM tts_samples
      WHERE customer_name IS NOT NULL AND customer_name != ''
      GROUP BY customer_name, customer_phone
      ORDER BY sample_count DESC, last_sample DESC
    `).all();

    // Partir en mapped / unmapped según tiktok_username
    const mapped = [];
    const unmapped = [];

    for (const r of rows) {
      const entry = {
        customer_name:   r.customer_name,
        customer_phone:  r.customer_phone,
        customer_email:  r.customer_email,
        tiktok_username: r.tiktok_username,
        sample_count:    r.sample_count,
        total_cost:      round(r.total_cost || 0),
        first_sample:    r.first_sample,
        last_sample:     r.last_sample,
        grupos:          (r.grupos_csv || '').split(',').filter(Boolean),
      };
      if (r.tiktok_username) mapped.push(entry);
      else unmapped.push(entry);
    }

    // Sugerencias: para cada unmapped, buscar handles que más vendieron su grupo
    // Tomamos una muestra representativa del cliente para obtener sus grupos
    for (const u of unmapped) {
      const repSample = db.prepare(`
        SELECT * FROM tts_samples
        WHERE customer_name = ? AND (customer_phone = ? OR (? IS NULL AND customer_phone IS NULL))
          AND tiktok_username IS NULL
        ORDER BY sent_date DESC LIMIT 1
      `).get(u.customer_name, u.customer_phone, u.customer_phone);

      u.candidates = repSample ? suggestHandles(repSample).slice(0, 5) : [];
    }

    res.json({
      mapped,
      unmapped,
      attribution_window_days: getAttributionWindowDays(),
    });
  } catch (err) {
    console.error('[mappings GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/mappings ────────────────────────────────────────────
// Crea o actualiza un mapeo customer → handle.
// Body: { customer_name, customer_phone?, tiktok_username }
// Aplica a TODAS las muestras (pasadas y futuras) con el mismo customer.
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { customer_name, customer_phone, customer_email, tiktok_username } = req.body;

    if (!customer_name || !tiktok_username) {
      return res.status(400).json({ error: 'customer_name y tiktok_username son requeridos' });
    }

    const handle = String(tiktok_username).toLowerCase().trim().replace(/^@/, '');

    // 1. Upsert en creator_mapping
    try {
      db.prepare(`
        INSERT INTO creator_mapping (
          simla_customer_name, simla_customer_email, simla_customer_phone,
          tiktok_username, confirmed, source
        ) VALUES (?, ?, ?, ?, 1, 'manual')
        ON CONFLICT(simla_customer_name, tiktok_username) DO UPDATE SET
          confirmed = 1,
          source = 'manual',
          simla_customer_email = excluded.simla_customer_email,
          simla_customer_phone = excluded.simla_customer_phone
      `).run(customer_name, customer_email || null, customer_phone || null, handle);
    } catch (e) {
      console.warn('[mappings POST] creator_mapping upsert:', e.message);
    }

    // 2. Aplicar el handle a TODAS las muestras de ese customer (name + phone)
    const phoneClause = customer_phone
      ? 'AND customer_phone = ?'
      : 'AND (customer_phone IS NULL OR customer_phone = "")';
    const params = customer_phone
      ? [handle, customer_name, customer_phone]
      : [handle, customer_name];
    const result = db.prepare(`
      UPDATE tts_samples
      SET tiktok_username = ?,
          auto_assigned = 1,
          updated_at = datetime('now')
      WHERE customer_name = ? ${phoneClause}
    `).run(...params);

    console.log(`[mappings] ${customer_name} → @${handle}: ${result.changes} muestras actualizadas`);
    res.json({ ok: true, updated: result.changes, handle });
  } catch (err) {
    console.error('[mappings POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/tts/mappings ──────────────────────────────────────────
// Borra el mapeo de un cliente. Las muestras asociadas pierden el handle.
// Body: { customer_name, customer_phone? }
router.delete('/', (req, res) => {
  try {
    const db = getDb();
    const { customer_name, customer_phone } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'customer_name requerido' });

    // Borrar del creator_mapping
    db.prepare(`
      DELETE FROM creator_mapping
      WHERE simla_customer_name = ?
        AND (simla_customer_phone = ? OR (? IS NULL AND simla_customer_phone IS NULL))
    `).run(customer_name, customer_phone || null, customer_phone || null);

    // Desasignar muestras
    const phoneClause = customer_phone
      ? 'AND customer_phone = ?'
      : 'AND (customer_phone IS NULL OR customer_phone = "")';
    const params = customer_phone
      ? [customer_name, customer_phone]
      : [customer_name];
    const result = db.prepare(`
      UPDATE tts_samples
      SET tiktok_username = NULL,
          auto_assigned = 0,
          updated_at = datetime('now')
      WHERE customer_name = ? ${phoneClause}
    `).run(...params);

    res.json({ ok: true, unassigned: result.changes });
  } catch (err) {
    console.error('[mappings DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tts/mappings/debug/:customer ─────────────────────────────
// Para debuggear: muestra las ventas afiliadas del handle + grupos de las muestras.
router.get('/debug/:customer', (req, res) => {
  try {
    const db = getDb();
    const customerName = decodeURIComponent(req.params.customer);

    const samples = db.prepare(`
      SELECT id, sent_date, approved_date, tiktok_username, sku, grupo, cogs, shipping_cost
      FROM tts_samples
      WHERE customer_name = ?
      ORDER BY sent_date ASC
    `).all(customerName);

    const handles = [...new Set(samples.map(s => s.tiktok_username).filter(Boolean))];
    const grupos  = [...new Set(samples.map(s => s.grupo).filter(Boolean))];

    // Ventas afiliadas del handle (cualquier grupo) en el último año
    const handleSales = handles.length === 0 ? [] :
      db.prepare(`
        SELECT order_date, grupo, sku, revenue, commission, comm_type, video_id, order_status
        FROM tts_affiliate_orders
        WHERE tiktok_username IN (${handles.map(() => '?').join(',')})
        ORDER BY order_date DESC LIMIT 200
      `).all(...handles);

    // Ventas del mismo grupo por cualquier creator
    const grupoSales = grupos.length === 0 ? [] :
      db.prepare(`
        SELECT tiktok_username, order_date, grupo, revenue, commission
        FROM tts_affiliate_orders
        WHERE grupo IN (${grupos.map(() => '?').join(',')})
        ORDER BY order_date DESC LIMIT 100
      `).all(...grupos);

    // Cuántas filas hay en total en tts_affiliate_orders
    const affiliateOrdersTotal = db.prepare('SELECT COUNT(*) AS c FROM tts_affiliate_orders').get().c;
    const firstAffDate = db.prepare('SELECT MIN(order_date) AS d FROM tts_affiliate_orders').get().d;
    const lastAffDate  = db.prepare('SELECT MAX(order_date) AS d FROM tts_affiliate_orders').get().d;

    res.json({
      customer_name: customerName,
      samples,
      handles,
      grupos,
      handle_sales_last_200: handleSales,
      grupo_sales_last_100:  grupoSales,
      tts_affiliate_orders_total: affiliateOrdersTotal,
      tts_affiliate_orders_date_range: [firstAffDate, lastAffDate],
    });
  } catch (err) {
    console.error('[mappings debug]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tts/mappings/export ───────────────────────────────────────
// Backup CSV completo de creator_mapping. Descarga directa con timestamp
// en el nombre. Incluye todos los campos para poder restaurar 1:1.
router.get('/export', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT id, simla_customer_name, simla_customer_email, simla_customer_phone,
             tiktok_username, confirmed, source, created_at
      FROM creator_mapping
      ORDER BY id ASC
    `).all();

    // CSV con BOM (Excel detecta UTF-8) y comillas dobles + escape de comillas
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      // Siempre entrecomillamos: simple y a prueba de comas/saltos
      return `"${s.replace(/"/g, '""')}"`;
    };
    const headers = [
      'id','simla_customer_name','simla_customer_email','simla_customer_phone',
      'tiktok_username','confirmed','source','created_at',
    ];
    const lines = ['﻿' + headers.join(',')];
    for (const r of rows) lines.push(headers.map(h => escape(r[h])).join(','));

    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const filename = `creator_mapping_backup_${stamp}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('[mappings export]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/mappings/import ──────────────────────────────────────
// Restaura mapeos desde el CSV exportado. Body: { csv: "..." }
// Estrategia: UPSERT por (simla_customer_name, tiktok_username).
// Devuelve { inserted, updated, skipped, errors }.
router.post('/import', (req, res) => {
  try {
    const csv = req.body?.csv || '';
    if (!csv.trim()) return res.status(400).json({ error: 'csv requerido en el body' });

    // Parser CSV minimal: respeta comillas dobles con escape ""
    function parseCsv(text) {
      const rows = [];
      let row = [], cell = '', inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
          else if (c === '"') inQuotes = false;
          else cell += c;
        } else {
          if (c === '"') inQuotes = true;
          else if (c === ',') { row.push(cell); cell = ''; }
          else if (c === '\n' || c === '\r') {
            if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); row = []; cell = ''; }
            if (c === '\r' && text[i + 1] === '\n') i++;
          } else cell += c;
        }
      }
      if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
      return rows;
    }

    // Quitar BOM si viene
    const clean = csv.replace(/^﻿/, '');
    const rows = parseCsv(clean).filter(r => r.length > 1);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV vacío o sin filas de datos' });

    const headers = rows[0].map(h => h.trim());
    const idx = (name) => headers.indexOf(name);
    const iName  = idx('simla_customer_name');
    const iMail  = idx('simla_customer_email');
    const iPhone = idx('simla_customer_phone');
    const iUser  = idx('tiktok_username');
    const iConf  = idx('confirmed');
    const iSrc   = idx('source');
    if (iName < 0 || iUser < 0) {
      return res.status(400).json({ error: 'CSV inválido: faltan columnas simla_customer_name o tiktok_username' });
    }

    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO creator_mapping (
        simla_customer_name, simla_customer_email, simla_customer_phone,
        tiktok_username, confirmed, source
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(simla_customer_name, tiktok_username) DO UPDATE SET
        simla_customer_email = COALESCE(NULLIF(excluded.simla_customer_email, ''), creator_mapping.simla_customer_email),
        simla_customer_phone = COALESCE(NULLIF(excluded.simla_customer_phone, ''), creator_mapping.simla_customer_phone),
        confirmed            = MAX(creator_mapping.confirmed, excluded.confirmed),
        source               = COALESCE(NULLIF(excluded.source, ''), creator_mapping.source)
    `);

    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];
    const tx = db.transaction(() => {
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const name   = (row[iName]  || '').trim();
        const handle = (row[iUser]  || '').trim().replace(/^@/, '').toLowerCase();
        if (!name || !handle) { skipped++; continue; }
        const email = iMail  >= 0 ? (row[iMail]  || '').trim() : '';
        const phone = iPhone >= 0 ? (row[iPhone] || '').trim() : '';
        const conf  = iConf  >= 0 ? (parseInt(row[iConf], 10) || 0) : 1;
        const src   = iSrc   >= 0 ? ((row[iSrc] || '').trim() || 'manual') : 'manual';
        try {
          const existed = db.prepare(
            'SELECT id FROM creator_mapping WHERE simla_customer_name = ? AND tiktok_username = ?'
          ).get(name, handle);
          upsert.run(name, email || null, phone || null, handle, conf, src);
          if (existed) updated++; else inserted++;
        } catch (e) {
          errors.push({ row: r + 1, name, handle, error: e.message });
        }
      }
    });
    tx();

    res.json({ inserted, updated, skipped, errors, total_rows: rows.length - 1 });
  } catch (err) {
    console.error('[mappings import]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
