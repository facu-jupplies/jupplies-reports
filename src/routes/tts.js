const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');

function round(n, decimals = 2) {
  return Math.round((n || 0) * Math.pow(10, decimals)) / Math.pow(10, decimals);
}
const {
  classifyOrders,
  allocateGMVMax,
  buildPL,
  buildSummary,
} = require('../services/ttsService');
const { fetchSimlaTTSOrders } = require('../services/simlaService');

// ─── POST /api/tts/report ─────────────────────────────────────────────────────
// Carga y calcula el P&L de TikTok Shop para una fecha.
// Body: {
//   date,
//   affiliateRows: [{orderId, commPctStandard, commPctAds, commReal, commRealAds, orderStatus, fullyRefunded}],
//   gmvCampaigns:  { campaignName: spend },
//   settings:      { iva_pct, tts_platform_pct }   (opcional — usa defaults de DB si no se pasan)
// }
router.post('/report', async (req, res) => {
  try {
    const { date, affiliateRows = [], gmvCampaigns = {}, settings: bodySettings = {} } = req.body;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Parámetro date requerido en formato YYYY-MM-DD' });
    }

    const db = getDb();

    // Cargar settings desde DB (con fallback a body)
    const dbSettings = {};
    const rows = db.prepare('SELECT key, value FROM app_settings').all();
    for (const r of rows) dbSettings[r.key] = r.value;

    const ivaPct  = parseFloat(bodySettings.iva_pct          || dbSettings.tts_iva_pct      || 21);
    const ttsPct  = parseFloat(bodySettings.tts_platform_pct || dbSettings.tts_platform_pct || 9);

    // Cargar mapa de SKUs desde DB
    const allSkus = db.prepare('SELECT * FROM skus').all();
    const skuMap  = {};
    for (const s of allSkus) skuMap[s.sku] = s;

    // 1. Obtener pedidos TTS de Simla (fuente de verdad — con SKUs reales)
    const { fetchSimlaOrders } = require('../services/simlaService');
    const simlaOrders = await fetchSimlaOrders(date, 'tik-tok-shop');

    // 2. Construir pedidos desde Simla (ya tienen SKU, revenue, COGS)
    let orders = [];
    for (const so of simlaOrders) {
      const primarySku = so.items[0]?.sku || '';
      const skuData = skuMap[primarySku]
        || skuMap[primarySku.replace(/-[A-Z0-9]+$/, '-')]
        || skuMap[primarySku.replace(/-[A-Z0-9]+$/, '')];

      let cogs = 0, maxShipping = 0;
      for (const item of so.items) {
        const sd = skuMap[item.sku] || skuMap[item.sku.replace(/-[A-Z0-9]+$/, '-')] || skuMap[item.sku.replace(/-[A-Z0-9]+$/, '')];
        if (sd) {
          cogs += (sd.cost || 0) * item.quantity;
          if ((sd.shipping_es || 0) > maxShipping) maxShipping = sd.shipping_es;
        }
      }
      const totalUnits = so.items.reduce((s, i) => s + i.quantity, 0);
      const shipping = maxShipping > 0 ? maxShipping * (1 + Math.max(0, totalUnits - 1) * 0.1) : 0;

      orders.push({
        order_name:    so.name,
        tikTokOrderId: so.externalId,
        status:        'valid',
        revenue:       round(so.totalPrice),
        cogs:          round(cogs),
        shipping:      round(shipping),
        grupo:         skuData?.grupo || primarySku || 'SIN GRUPO',
        primary_sku:   primarySku,
        order_type:    'organico',
        commission_cost: 0,
        gmv_max_spend: 0,
      });
    }

    // Enriquecer affiliateRows con SKUs de Simla (para classifyOrders por SKU)
    // El CSV no tiene SKU, pero Simla sí — inyectar SKUs por producto
    const simlaTTSMap = await fetchSimlaTTSOrders(date).catch(() => ({}));
    for (const af of affiliateRows) {
      if (af.skus && af.skus.length > 0) continue;
      // Buscar en Simla por externalId (Shopify ID, no TikTok ID — puede no matchear)
      const simlaMatch = simlaTTSMap[String(af.orderId).trim()];
      if (simlaMatch) {
        af.skus = simlaMatch.skus;
        af.sellerSku = simlaMatch.skus[0];
      }
    }

    console.log(`[TTS] Simla: ${orders.length} pedidos | CSV afiliados: ${affiliateRows.length} | GMV campañas: ${Object.keys(gmvCampaigns).length}`);

    // 3. Clasificar por tipo usando matching por SKU
    orders = classifyOrders(orders, affiliateRows);

    // 4. Asignar gasto GMV Max
    orders = allocateGMVMax(orders, gmvCampaigns, skuMap);

    // 5. Calcular P&L por grupo
    const pl = buildPL(orders, ivaPct, ttsPct);

    // 6. Resumen global
    const summary = buildSummary(pl);

    res.json({ pl, summary, orders });
  } catch (err) {
    console.error('[TTS /report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/history/save ───────────────────────────────────────────────
// Guarda un día de TTS en el historial.
// Body: { date, summary: {...}, grupos: [...] }
router.post('/history/save', (req, res) => {
  try {
    const db = getDb();
    const { date, summary, grupos } = req.body;

    if (!date || !summary) {
      return res.status(400).json({ error: 'Se requiere date y summary' });
    }

    const now = new Date().toISOString();

    const upsertSummary = db.prepare(`
      INSERT INTO tts_history (
        date, gmv, net_profit, gross_profit, margin_pct, orders,
        orders_propio, orders_paid_afil, orders_org_afil,
        gmv_max_spend, commission_cost, cogs, shipping,
        iva, tiktok_platform, seller_discount, cpa, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        gmv              = excluded.gmv,
        net_profit       = excluded.net_profit,
        gross_profit     = excluded.gross_profit,
        margin_pct       = excluded.margin_pct,
        orders           = excluded.orders,
        orders_propio    = excluded.orders_propio,
        orders_paid_afil = excluded.orders_paid_afil,
        orders_org_afil  = excluded.orders_org_afil,
        gmv_max_spend    = excluded.gmv_max_spend,
        commission_cost  = excluded.commission_cost,
        cogs             = excluded.cogs,
        shipping         = excluded.shipping,
        iva              = excluded.iva,
        tiktok_platform  = excluded.tiktok_platform,
        seller_discount  = excluded.seller_discount,
        cpa              = excluded.cpa,
        updated_at       = excluded.updated_at
    `);

    const upsertGrupo = db.prepare(`
      INSERT INTO tts_history_grupos (
        date, grupo, display_name, orders, orders_propio, orders_paid_afil, orders_org_afil,
        revenue, cogs, shipping, iva, tiktok_platform, commission_cost,
        gmv_max_spend, seller_discount, gross_profit, net_profit, margin_pct, cpa
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, grupo) DO UPDATE SET
        display_name     = excluded.display_name,
        orders           = excluded.orders,
        orders_propio    = excluded.orders_propio,
        orders_paid_afil = excluded.orders_paid_afil,
        orders_org_afil  = excluded.orders_org_afil,
        revenue          = excluded.revenue,
        cogs             = excluded.cogs,
        shipping         = excluded.shipping,
        iva              = excluded.iva,
        tiktok_platform  = excluded.tiktok_platform,
        commission_cost  = excluded.commission_cost,
        gmv_max_spend    = excluded.gmv_max_spend,
        seller_discount  = excluded.seller_discount,
        gross_profit     = excluded.gross_profit,
        net_profit       = excluded.net_profit,
        margin_pct       = excluded.margin_pct,
        cpa              = excluded.cpa
    `);

    const saveAll = db.transaction(() => {
      upsertSummary.run(
        date,
        summary.gmv          || 0,
        summary.net_profit   || 0,
        summary.gross_profit || 0,
        summary.margin_pct   || 0,
        summary.orders     || 0,
        summary.orders_propio    || 0,
        summary.orders_paid_afil || 0,
        summary.orders_org_afil  || 0,
        summary.gmv_max_spend    || 0,
        summary.commission_cost  || 0,
        summary.cogs             || 0,
        summary.shipping         || 0,
        summary.iva              || 0,
        summary.tiktok_platform  || 0,
        summary.seller_discount  || 0,
        summary.cpa              || 0,
        now
      );

      if (Array.isArray(grupos)) {
        for (const g of grupos) {
          upsertGrupo.run(
            date,
            g.grupo            || '',
            g.display_name     || g.grupo || '',
            g.orders           || 0,
            g.orders_propio    || 0,
            g.orders_paid_afil || 0,
            g.orders_org_afil  || 0,
            g.revenue          || 0,
            g.cogs             || 0,
            g.shipping         || 0,
            g.iva              || 0,
            g.tiktok_platform  || 0,
            g.commission_cost  || 0,
            g.gmv_max_spend    || 0,
            g.seller_discount  || 0,
            g.gross_profit     || 0,
            g.net_profit       || 0,
            g.margin_pct       || 0,
            g.cpa              || 0
          );
        }
      }
    });

    saveAll();
    res.json({ ok: true });
  } catch (err) {
    console.error('[TTS /history/save]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/tts/history/:date ───────────────────────────────────────────
// Elimina un día completo del historial TTS (summary + grupos).
router.delete('/history/:date', (req, res) => {
  try {
    const db   = getDb();
    const { date } = req.params;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Fecha inválida. Usar formato YYYY-MM-DD' });
    }

    const del = db.transaction(() => {
      db.prepare('DELETE FROM tts_history        WHERE date = ?').run(date);
      db.prepare('DELETE FROM tts_history_grupos WHERE date = ?').run(date);
    });
    del();

    console.log(`[TTS /history DELETE] Eliminado: ${date}`);
    res.json({ ok: true, deleted: date });
  } catch (err) {
    console.error('[TTS /history DELETE]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tts/history ─────────────────────────────────────────────────────
// Obtiene el historial de días TTS en un rango.
// Query: from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/history', (req, res) => {
  try {
    const db = getDb();
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: 'Se requieren los parámetros from y to' });
    }

    const summary = db.prepare(`
      SELECT * FROM tts_history
      WHERE date BETWEEN ? AND ?
      ORDER BY date ASC
    `).all(from, to);

    const grupos = db.prepare(`
      SELECT * FROM tts_history_grupos
      WHERE date BETWEEN ? AND ?
      ORDER BY date ASC, net_profit DESC
    `).all(from, to);

    res.json({ summary, grupos });
  } catch (err) {
    console.error('[TTS /history]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
