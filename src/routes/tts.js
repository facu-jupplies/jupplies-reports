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
const { parseTTSAffiliateCSV } = require('../services/ttsCsvParser');

// ─── Helper: persistir filas del CSV de afiliados en tts_affiliate_orders ───
// Permite matchear con muestras gratis (pestaña "Muestras TTS") a posteriori.
// Se llama con skuMap ya resuelto. Idempotente por UNIQUE(csv_order_id, csv_sku_id).
function persistAffiliateOrders(db, date, affiliateRows, skuMap) {
  if (!Array.isArray(affiliateRows) || affiliateRows.length === 0) return 0;

  function resolveGrupo(rawSku) {
    if (!rawSku) return '';
    const sku = rawSku.toUpperCase().trim();
    const sd = skuMap[sku]
      || skuMap[sku.replace(/-[A-Z0-9]+$/, '-')]
      || skuMap[sku.replace(/-[A-Z0-9]+$/, '')];
    return (sd?.grupo || sku).toUpperCase();
  }

  const upsert = db.prepare(`
    INSERT INTO tts_affiliate_orders (
      order_date, csv_order_id, tiktok_username,
      product_name, product_id, csv_sku_id, sku, grupo,
      price, revenue, commission, comm_type,
      video_id, content_type, order_status, fully_refunded, is_primary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(csv_order_id, csv_sku_id) DO UPDATE SET
      order_date     = excluded.order_date,
      tiktok_username= excluded.tiktok_username,
      product_name   = excluded.product_name,
      product_id     = excluded.product_id,
      sku            = excluded.sku,
      grupo          = excluded.grupo,
      price          = excluded.price,
      revenue        = excluded.revenue,
      commission     = excluded.commission,
      comm_type      = excluded.comm_type,
      video_id       = excluded.video_id,
      content_type   = excluded.content_type,
      order_status   = excluded.order_status,
      fully_refunded = excluded.fully_refunded,
      is_primary     = excluded.is_primary
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const af of affiliateRows) {
      const orderId = String(af.orderId || '').trim();
      if (!orderId) continue;

      // Una fila por (orderId × producto). sellerSku identifica el producto dentro del pedido.
      // Para filas no-primary el frontend ya pone settlementAmount=0 (revenue del pedido va sólo
      // en la primera fila para no doble-contarlo).
      const sku = (af.sellerSku || af.skus?.[0] || '').toUpperCase().trim();
      const grupo = resolveGrupo(sku);

      const commPctAds      = parseFloat(af.commPctAds) || 0;
      const commPctStandard = parseFloat(af.commPctStandard) || 0;
      const commReal        = parseFloat(af.commReal) || 0;
      const commRealAds     = parseFloat(af.commRealAds) || 0;
      const commission      = commReal + commRealAds;
      const revenue         = parseFloat(af.settlementAmount) || 0;

      let commType = 'none';
      if (commPctAds > 0) commType = 'paid';
      else if (commPctStandard > 0) commType = 'org';

      const refunded = af.fullyRefunded === true || String(af.fullyRefunded || '').toLowerCase() === 'true';
      const isPrimary = af.isPrimary === false ? 0 : 1;

      const csvSkuId = sku || '__primary__';

      upsert.run(
        date, orderId, (af.creatorName || '').toLowerCase().trim(),
        af.productName || null, null, csvSkuId, sku || null, grupo || null,
        round(revenue), round(revenue), round(commission), commType,
        af.contentId || null, af.contentType || null,
        af.orderStatus || null, refunded ? 1 : 0, isPrimary,
      );
      count++;
    }
  });
  tx();

  return count;
}

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

    // 2. Construir pedidos desde Simla con parseSku para expandir multi-SKU
    const { parseSku } = require('../services/calculator');

    function findSkuData(rawSku) {
      const sku = rawSku.toUpperCase().trim();
      return skuMap[sku]
        || skuMap[sku.replace(/-[A-Z0-9]+$/, '-')]
        || skuMap[sku.replace(/-[A-Z0-9]+$/, '')];
    }

    let orders = [];
    for (const so of simlaOrders) {
      // Expandir todos los items con parseSku (maneja "BANE-TER-RO;PATAS" y "ESNT-BLA*1")
      const allParts = [];
      for (const item of so.items) {
        const parsed = parseSku(item.sku);
        if (parsed.length > 0) {
          for (const p of parsed) {
            allParts.push({ sku: p.sku, qty: p.qty * item.quantity });
          }
        } else if (item.sku) {
          allParts.push({ sku: item.sku.toUpperCase().trim(), qty: item.quantity });
        }
      }

      // El primer SKU es el principal
      const primarySku = allParts[0]?.sku || '';
      const skuData = findSkuData(primarySku);
      const grupo = skuData?.grupo || primarySku || 'SIN GRUPO';

      // Calcular COGS y shipping de todos los SKUs expandidos
      let cogs = 0, maxShipping = 0, totalUnits = 0;
      for (const part of allParts) {
        const sd = findSkuData(part.sku);
        if (sd) {
          cogs += (sd.cost || 0) * part.qty;
          if ((sd.shipping_es || 0) > maxShipping) maxShipping = sd.shipping_es;
        }
        totalUnits += part.qty;
      }
      const shipping = maxShipping > 0 ? maxShipping * (1 + Math.max(0, totalUnits - 1) * 0.1) : 0;

      orders.push({
        order_name:    so.name,
        tikTokOrderId: so.externalId,
        status:        'valid',
        revenue:       round(so.totalPrice),
        cogs:          round(cogs),
        shipping:      round(shipping),
        grupo,
        primary_sku:   primarySku,
        order_type:    'organico',
        commission_cost: 0,
        gmv_max_spend: 0,
      });
    }

    // Enriquecer affiliateRows con SKUs usando nombre de producto → SKU
    // El CSV tiene "productName" (nombre del producto en TikTok)
    // Simla tiene pedidos TTS con displayName → offer.article (SKU real)
    const { buildTTSProductNameMap } = require('../services/simlaService');
    const nameToSku = await buildTTSProductNameMap(date, date).catch(() => ({}));

    let enriched = 0;
    for (const af of affiliateRows) {
      if (af.skus && af.skus.length > 0) continue;
      // Matchear por nombre de producto (fuzzy: buscar el nombre del CSV como substring)
      const afName = (af.productName || '').trim();
      if (!afName) continue;

      // Buscar match exacto primero, luego substring
      let matchedSku = nameToSku[afName];
      if (!matchedSku) {
        // Substring match: el nombre del CSV puede estar truncado
        for (const [simlaName, sku] of Object.entries(nameToSku)) {
          if (simlaName.startsWith(afName.slice(0, 30)) || afName.startsWith(simlaName.slice(0, 30))) {
            matchedSku = sku;
            break;
          }
        }
      }

      if (matchedSku) {
        af.skus = [matchedSku];
        af.sellerSku = matchedSku;
        enriched++;
      }
    }

    const withSku = affiliateRows.filter(a => a.skus && a.skus.length > 0).length;
    const withoutSku = affiliateRows.filter(a => !a.skus || a.skus.length === 0);
    console.log(`[TTS] Simla: ${orders.length} pedidos | CSV: ${affiliateRows.length} (${enriched} enriquecidos, ${withSku} con SKU, ${withoutSku.length} SIN SKU) | GMV: ${Object.keys(gmvCampaigns).length}`);
    if (withoutSku.length > 0) {
      console.log('[TTS] CSV sin SKU (primeros 5):');
      for (const af of withoutSku.slice(0, 5)) {
        console.log('  orderId:', af.orderId?.slice(0,10), '| productName:', (af.productName||'').slice(0,50), '| comm:', af.commReal);
      }
    }

    // 3. Clasificar por tipo usando matching por GRUPO de producto
    //    (agrupa todas las variantes físicas bajo un mismo grupo; resuelve falsos
    //    negativos cuando Simla tiene variantes que el CSV no distingue)
    orders = classifyOrders(orders, affiliateRows, skuMap);

    // 4. Asignar gasto GMV Max
    orders = allocateGMVMax(orders, gmvCampaigns, skuMap);

    // 5. Calcular P&L por grupo
    const pl = buildPL(orders, ivaPct, ttsPct);

    // 6. Resumen global
    const summary = buildSummary(pl);

    // 7. Persistir filas crudas del CSV en tts_affiliate_orders
    //    (alimenta la pestaña de Muestras para atribuir ventas a los creadores)
    try {
      const persisted = persistAffiliateOrders(db, date, affiliateRows, skuMap);
      console.log(`[TTS] persistidos ${persisted} registros en tts_affiliate_orders para ${date}`);
    } catch (persistErr) {
      console.warn('[TTS] error persistiendo affiliate_orders:', persistErr.message);
    }

    res.json({ pl, summary, orders });
  } catch (err) {
    console.error('[TTS /report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/history/save ───────────────────────────────────────────────
// Guarda un día de TTS en el historial.
// Body: { date, summary: {...}, grupos: [...], affiliates: [...] }
router.post('/history/save', (req, res) => {
  try {
    const db = getDb();
    const { date, summary, grupos, affiliates } = req.body;

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

      // Guardar afiliados
      if (Array.isArray(affiliates) && affiliates.length > 0) {
        db.prepare('DELETE FROM tts_history_affiliates WHERE date = ?').run(date);
        const stmtAfil = db.prepare(`
          INSERT INTO tts_history_affiliates (date, creator_name, orders, orders_paid, orders_organic, revenue, commission, top_video_id, top_product)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const a of affiliates) {
          stmtAfil.run(date, a.name || '', a.orders || 0, a.paid || 0, a.organic || 0,
            a.revenue || 0, a.commission || 0, a.topVideoId || '', a.topProduct || '');
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

    const affiliates = db.prepare(`
      SELECT * FROM tts_history_affiliates
      WHERE date BETWEEN ? AND ?
      ORDER BY date ASC, orders DESC
    `).all(from, to);

    // Breakdown por (afiliado × video × producto) — desde tts_affiliate_orders.
    // Una fila por (creator × video). orders_primary cuenta sólo filas isPrimary
    // (el primer producto del pedido) — necesario para que totalSales del afiliado
    // sea pedidos únicos cuando un pedido tiene productos de varios videos.
    const affiliateVideos = db.prepare(`
      SELECT tiktok_username                                AS creator_name,
             video_id,
             COALESCE(MAX(product_name), '')                AS product_name,
             COALESCE(MAX(grupo), '')                       AS grupo,
             COUNT(*)                                       AS orders,
             SUM(CASE WHEN is_primary=1 THEN 1 ELSE 0 END)  AS orders_primary,
             SUM(CASE WHEN comm_type='paid' THEN 1 ELSE 0 END) AS orders_paid,
             SUM(CASE WHEN comm_type='org'  THEN 1 ELSE 0 END) AS orders_org,
             COALESCE(SUM(revenue), 0)                      AS revenue,
             COALESCE(SUM(commission), 0)                   AS commission
        FROM tts_affiliate_orders
       WHERE order_date BETWEEN ? AND ?
         AND (fully_refunded IS NULL OR fully_refunded = 0)
         AND (order_status IS NULL OR order_status NOT LIKE '%aptos%')
         AND tiktok_username IS NOT NULL AND tiktok_username != ''
       GROUP BY tiktok_username, video_id
       ORDER BY orders DESC
    `).all(from, to);

    res.json({ summary, grupos, affiliates, affiliate_videos: affiliateVideos });
  } catch (err) {
    console.error('[TTS /history]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/affiliate-orders/upload ───────────────────────────────
// Sube un CSV de afiliados (texto en body) y persiste en tts_affiliate_orders.
// Detecta fechas automáticamente — si el CSV tiene varios días, agrupa y
// persiste por día (igual que el script bulk-import-tts.js).
//
// Body: { csvText: '...contenido del CSV...', filename?: 'opcional para log' }
// Response: { ok, byDate: {date: count}, totalRows, multiDay }
router.post('/affiliate-orders/upload', (req, res) => {
  try {
    const { csvText, filename } = req.body || {};
    if (!csvText || typeof csvText !== 'string') {
      return res.status(400).json({ error: 'csvText requerido (string)' });
    }
    const parsed = parseTTSAffiliateCSV(csvText);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const rows = parsed.rows;
    if (rows.length === 0) return res.status(400).json({ error: 'CSV sin filas válidas' });

    // Agrupar por orderDate (cada fila trae su propia fecha del campo "Fecha/hora de creación")
    const groups = {};
    let withoutDate = 0;
    for (const r of rows) {
      const d = r.orderDate;
      if (!d) { withoutDate++; continue; }
      if (!groups[d]) groups[d] = [];
      groups[d].push(r);
    }
    if (Object.keys(groups).length === 0) {
      return res.status(400).json({ error: 'No se pudo detectar fechas en las filas del CSV' });
    }

    const db = getDb();
    // Mapa SKU → grupo (para resolver grupo por sku)
    const skusRaw = db.prepare('SELECT sku, grupo FROM skus').all();
    const skuMap = {};
    for (const s of skusRaw) skuMap[s.sku] = s;

    const groupDates = Object.keys(groups).sort();
    // Borrar todos los días afectados y reinsertar (idempotente por archivo).
    // No envolvemos en transaction exterior porque persistAffiliateOrders ya
    // abre la suya y este wrapper no soporta transacciones anidadas.
    const delStmt = db.prepare('DELETE FROM tts_affiliate_orders WHERE order_date = ?');
    const byDate = {};
    for (const d of groupDates) delStmt.run(d);
    for (const d of groupDates) {
      const inserted = persistAffiliateOrders(db, d, groups[d], skuMap);
      byDate[d] = inserted;
    }

    console.log(`[TTS upload] ${filename || '(sin nombre)'}: ${rows.length} filas, ${groupDates.length} días`);
    res.json({
      ok: true,
      filename: filename || null,
      totalRows: rows.length,
      withoutDate,
      multiDay: groupDates.length > 1,
      byDate,
      dateRange: { from: groupDates[0], to: groupDates[groupDates.length - 1] },
    });
  } catch (err) {
    console.error('[TTS /affiliate-orders/upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
