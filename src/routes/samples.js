const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const {
  scanSamples,
  computeAttribution,
  suggestHandles,
  getSamplesWithAttribution,
  getAttributionWindowDays,
} = require('../services/samplesService');

function round(n, decimals = 2) {
  return Math.round(((n || 0) + Number.EPSILON) * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

// ─── Normalización de grupos a familia (match received ↔ vendido) ──────────
// Variantes de color/talle/cantidad rompen el match exact. Normalizamos
// progresivamente: family (corta `;`, `*N`, trailing `-`), root (quita color
// 2-3 letras al final), prefix-component. Ver tts-samples.js para detalles.
function groupFamily(g) {
  if (!g) return '';
  let s = String(g).toUpperCase().trim();
  if (s.includes(';')) s = s.split(';')[0];
  s = s.replace(/\*\d+$/, '');
  while (s.endsWith('-')) s = s.slice(0, -1);
  return s;
}
function groupRoot(g) {
  const fam = groupFamily(g);
  if (!fam) return '';
  const m = fam.match(/^(.+?)-([A-Z]{2,3})$/);
  if (m && m[1].length >= 3) return m[1];
  return fam;
}
function matchesGroupFamily(a, b) {
  if (!a || !b) return false;
  const fa = groupFamily(a), fb = groupFamily(b);
  if (fa === fb && fa) return true;
  const ra = groupRoot(a),   rb = groupRoot(b);
  if (ra === rb && ra) return true;
  if (fa && fb && (fb.startsWith(fa + '-') || fa.startsWith(fb + '-'))) return true;
  if (ra && rb && (rb.startsWith(ra + '-') || ra.startsWith(rb + '-'))) return true;
  return false;
}

// ─── GET /api/tts/samples/affiliates ────────────────────────────────────
// Lista simple: afiliados que RECIBIERON muestras en el período [from, to],
// con los SKUs/productos recibidos y sus ventas generadas en ese mismo período.
router.get('/affiliates', (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ error: 'from requerido (YYYY-MM-DD)' });
    }
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'to requerido (YYYY-MM-DD)' });
    }

    const db = getDb();

    // 1. Muestras con handle asignado en el período — base del listado.
    //    all_skus contiene TODOS los SKUs del pedido (separados por coma), para
    //    los casos donde una muestra lleva varios productos juntos en un envío.
    const samplesRows = db.prepare(`
      SELECT tiktok_username,
             COUNT(*)                                      AS samples_received,
             COALESCE(SUM(units), 0)                       AS units_received,
             COALESCE(SUM(cogs + shipping_cost), 0)        AS samples_cost,
             MIN(sent_date)                                AS first_sample_date,
             MAX(sent_date)                                AS last_sample_date,
             GROUP_CONCAT(COALESCE(all_skus, sku))         AS skus_received_raw,
             GROUP_CONCAT(DISTINCT grupo)                  AS grupos_received,
             GROUP_CONCAT(DISTINCT customer_name)          AS customer_names
      FROM tts_samples
      WHERE tiktok_username IS NOT NULL AND tiktok_username != ''
        AND sent_date BETWEEN ? AND ?
      GROUP BY tiktok_username
    `).all(from, to);

    // 2. Muestras sin asignar (huérfanas) — solo para contar y mostrar el warning
    const unassignedAgg = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(cogs + shipping_cost), 0) AS cost
      FROM tts_samples
      WHERE (tiktok_username IS NULL OR tiktok_username = '')
        AND sent_date BETWEEN ? AND ?
    `).get(from, to);

    // 3. Ventas en el período, agrupadas por handle
    // Traemos las filas crudas (no agregadas) sólo de los handles con muestras del
    // período. Necesitamos cada fila para separar matched / no-matched a nivel
    // grupo familia (matchesGroupFamily), lógica que SQL no puede hacer.
    const handlesArr = samplesRows.map(r => r.tiktok_username).filter(Boolean);
    const placeholders = handlesArr.map(() => '?').join(',');
    const rawSales = handlesArr.length === 0 ? [] : db.prepare(`
      SELECT tiktok_username, sku, grupo, revenue, commission, comm_type, video_id
        FROM tts_affiliate_orders
       WHERE order_date BETWEEN ? AND ?
         AND tiktok_username IN (${placeholders})
         AND (order_status IS NULL OR order_status NOT LIKE '%aptos%')
         AND (fully_refunded IS NULL OR fully_refunded = 0)
    `).all(from, to, ...handlesArr);

    // Agregamos en JS por (handle), separando matched vs no-matched.
    // Match: el grupo de la venta pertenece a la familia de algún grupo recibido
    // por ESE handle en el período (matchesGroupFamily ignora colores/variantes).
    const handleReceivedGrupos = {};
    for (const sr of samplesRows) {
      handleReceivedGrupos[sr.tiktok_username] =
        (sr.grupos_received || '').split(',').map(g => g.trim()).filter(Boolean);
    }

    const salesByHandle = {};
    for (const sale of rawSales) {
      const h = sale.tiktok_username;
      if (!salesByHandle[h]) salesByHandle[h] = {
        orders: 0, revenue: 0, commission: 0,
        orders_matched: 0, revenue_matched: 0, commission_matched: 0,
        orders_paid: 0, orders_org: 0,
        videos_set: new Set(),
        videos_matched_set: new Set(),
        skus_sold: new Set(), grupos_sold: new Set(),
      };
      const agg = salesByHandle[h];
      const isMatched = (handleReceivedGrupos[h] || []).some(rg => matchesGroupFamily(rg, sale.grupo));

      agg.orders     += 1;
      agg.revenue    += sale.revenue || 0;
      agg.commission += sale.commission || 0;
      if      (sale.comm_type === 'paid') agg.orders_paid += 1;
      else if (sale.comm_type === 'org')  agg.orders_org  += 1;
      if (sale.video_id) agg.videos_set.add(sale.video_id);
      if (sale.sku)   agg.skus_sold.add(sale.sku);
      if (sale.grupo) agg.grupos_sold.add(sale.grupo);

      if (isMatched) {
        agg.orders_matched     += 1;
        agg.revenue_matched    += sale.revenue || 0;
        agg.commission_matched += sale.commission || 0;
        if (sale.video_id) agg.videos_matched_set.add(sale.video_id);
      }
    }

    // 4. Mapa handle → customer_name desde creator_mapping (fallback: nombre de la muestra)
    const handleToName = {};
    const mappingRows = db.prepare(`
      SELECT tiktok_username, simla_customer_name, simla_customer_phone
      FROM creator_mapping
      WHERE confirmed = 1
    `).all();
    for (const m of mappingRows) {
      if (!handleToName[m.tiktok_username]) {
        handleToName[m.tiktok_username] = {
          name:  m.simla_customer_name,
          phone: m.simla_customer_phone,
        };
      }
    }

    // 5. Construir lista de afiliados (solo los que RECIBIERON muestras en el período).
    //
    // Métricas cada una en versión total y matched:
    //   - facturación / comisión / orders / videos
    //   - matched = sólo ventas de productos del mismo grupo familia que la muestra
    //
    // ROAS = facturación / inversión (bruto, sin descontar comisión).
    //   inversion = costo muestra (cogs+envío). NO incluye comisiones porque
    //   la comisión sale del propio revenue del pedido, no es capital extra.
    //
    // dias_desde_envio: días entre la última muestra enviada y hoy. Útil para
    //   afiliados sin ventas — saber hace cuánto se mandó la muestra.
    const todayDateStr = new Date().toISOString().slice(0, 10);
    const dayDiff = (a, b) => {
      if (!a || !b) return null;
      const ms = new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z');
      return Math.round(ms / 86400000);
    };

    const affiliates = samplesRows.map(s => {
      const h = s.tiktok_username;
      const sales = salesByHandle[h] || {};
      const customerName = handleToName[h]?.name
        || (s.customer_names || '').split(',')[0]
        || null;

      const facturacion         = sales.revenue              || 0;
      const facturacionMatched  = sales.revenue_matched      || 0;
      const commission          = sales.commission           || 0;
      const commissionMatched   = sales.commission_matched   || 0;
      const orders              = sales.orders               || 0;
      const ordersMatched       = sales.orders_matched       || 0;
      const samplesCost         = s.samples_cost             || 0;
      const videos              = sales.videos_set?.size     || 0;
      const videosMatched       = sales.videos_matched_set?.size || 0;

      // ROAS bruto = facturación / inversión muestras
      const roasTotal   = samplesCost > 0 ? round(facturacion        / samplesCost, 2) : null;
      const roasMatched = samplesCost > 0 ? round(facturacionMatched / samplesCost, 2) : null;

      // SKUs recibidos: concatenación de all_skus, deduplicado
      const skusReceivedSet = new Set(
        (s.skus_received_raw || '').split(',').map(x => (x || '').trim()).filter(Boolean)
      );

      const lastSampleDate = s.last_sample_date;
      const daysSinceLast  = dayDiff(lastSampleDate, todayDateStr);

      return {
        tiktok_username:   h,
        customer_name:     customerName,
        customer_phone:    handleToName[h]?.phone || null,
        first_sample_date: s.first_sample_date,
        last_sample_date:  lastSampleDate,
        days_since_last_sample: daysSinceLast,
        samples_received:  s.samples_received || 0,
        units_received:    s.units_received   || 0,
        samples_cost:      round(samplesCost),
        skus_received:     [...skusReceivedSet],
        grupos_received:   (s.grupos_received || '').split(',').filter(Boolean),
        // Total
        orders,
        orders_paid:       sales.orders_paid || 0,
        orders_org:        sales.orders_org  || 0,
        videos,
        facturacion:       round(facturacion),
        commission:        round(commission),
        // Matched (sólo ventas del grupo familia recibido)
        orders_matched:    ordersMatched,
        videos_matched:    videosMatched,
        facturacion_matched: round(facturacionMatched),
        commission_matched:  round(commissionMatched),
        // SKUs vendidos
        skus_sold:         [...(sales.skus_sold   || [])],
        grupos_sold:       [...(sales.grupos_sold || [])],
        // Inversión + ROAS
        inversion:         round(samplesCost),  // sólo muestras (out-of-pocket)
        roas_total:        roasTotal,
        roas_matched:      roasMatched,
        // Compat con código viejo
        inversion_total:   round(samplesCost + commission),
        roia:              samplesCost > 0
          ? round(((facturacion - commission - samplesCost) / samplesCost) * 100, 1)
          : null,
      };
    });

    // Ordenar por fecha de primera muestra DESC (más reciente primero)
    affiliates.sort((a, b) => (b.first_sample_date || '').localeCompare(a.first_sample_date || ''));

    // 6. Totales simples
    const totals = affiliates.reduce((acc, a) => {
      acc.affiliates    += 1;
      acc.samples       += a.samples_received;
      acc.samples_cost  += a.samples_cost;
      acc.orders        += a.orders;
      acc.orders_paid   += a.orders_paid;
      acc.orders_org    += a.orders_org;
      acc.facturacion   += a.facturacion;
      acc.commission    += a.commission;
      return acc;
    }, {
      affiliates: 0, samples: 0, samples_cost: 0,
      orders: 0, orders_paid: 0, orders_org: 0,
      facturacion: 0, commission: 0,
    });
    totals.samples_cost  = round(totals.samples_cost);
    totals.facturacion   = round(totals.facturacion);
    totals.commission    = round(totals.commission);
    totals.inversion_total = round(totals.samples_cost + totals.commission);
    totals.roia = totals.inversion_total > 0
      ? round(((totals.facturacion - totals.inversion_total) / totals.inversion_total) * 100, 1)
      : null;
    totals.unassigned_samples      = unassignedAgg.n || 0;
    totals.unassigned_samples_cost = round(unassignedAgg.cost || 0);

    // Última sync: el updated_at más reciente de tts_samples del rango.
    // Le sirve al usuario para saber si los datos están actualizados sin
    // tener que apretar el botón de Sync.
    const lastScan = db.prepare(`
      SELECT MAX(updated_at) AS last
        FROM tts_samples
       WHERE sent_date BETWEEN ? AND ?
    `).get(from, to);

    res.json({
      period: { from, to },
      affiliates,
      totals,
      last_scan_at: lastScan?.last || null,
    });
  } catch (err) {
    console.error('[affiliates report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tts/samples/affiliates/:handle ────────────────────────────
// Detalle de un afiliado: muestras recibidas, ventas detalladas, timeline
// para gráfico con eventos (muestras) + barras/líneas (ventas diarias).
router.get('/affiliates/:handle', (req, res) => {
  try {
    const { handle } = req.params;
    const { from, to } = req.query;
    if (!handle)    return res.status(400).json({ error: 'handle requerido' });
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ error: 'from requerido' });
    if (!to   || !/^\d{4}-\d{2}-\d{2}$/.test(to))   return res.status(400).json({ error: 'to requerido' });

    const db = getDb();
    const h  = handle.toLowerCase().trim().replace(/^@/, '');

    // 1. Muestras: TODAS las del afiliado (sin filtro de fechas).
    //    Las muestras son atemporales para este afiliado — si recibió una en
    //    enero, sigue siendo dueño de ese costo y de su atribución.
    //    El campo `in_period` marca cuáles cayeron en el rango filtrado.
    const samples = db.prepare(`
      SELECT id, sent_date, approved_date, simla_order_num, simla_order_id,
             sku, all_skus, grupo, product_name, units,
             cogs, shipping_cost, customer_name
      FROM tts_samples
      WHERE tiktok_username = ?
      ORDER BY sent_date ASC
    `).all(h);
    for (const s of samples) {
      s.in_period = (s.sent_date >= from && s.sent_date <= to);
    }

    // 2. Ventas en el período
    const sales = db.prepare(`
      SELECT order_date, csv_order_id, sku, grupo, product_name,
             revenue, commission, comm_type, video_id, content_type, order_status
      FROM tts_affiliate_orders
      WHERE tiktok_username = ?
        AND order_date BETWEEN ? AND ?
        AND (order_status IS NULL OR order_status NOT LIKE '%aptos%')
        AND (fully_refunded IS NULL OR fully_refunded = 0)
      ORDER BY order_date ASC
    `).all(h, from, to);

    // Marcar cada venta como matched (mismo grupo familia que alguna muestra)
    // o no-matched (producto distinto, no atribuible a la muestra).
    const receivedGrupos = samples.map(s => (s.grupo || '').toUpperCase()).filter(Boolean);
    const isVentaMatched = (saleGrupo) =>
      receivedGrupos.some(rg => matchesGroupFamily(rg, saleGrupo));
    for (const s of sales) {
      s.is_matched = isVentaMatched(s.grupo);
    }

    // 3. Timeline: un punto por día, con muestras (eventos) y ventas agregadas
    //    sale_grupos: { GRUPO: { org, paid, revenue } } por día — para tooltip por producto
    const dailyMap = {};
    const start = new Date(from + 'T00:00:00Z');
    const end   = new Date(to   + 'T00:00:00Z');
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      dailyMap[iso] = {
        date: iso,
        samples: 0, sample_grupos: [], sample_skus: [],
        orders: 0, orders_org: 0, orders_paid: 0,
        revenue: 0, commission: 0,
        sale_grupos: {},  // grupo → { org, paid, revenue }
      };
    }
    for (const s of samples) {
      const d = s.sent_date;
      if (dailyMap[d]) {
        dailyMap[d].samples += 1;
        // Para tooltip preferimos el grupo (más legible), fallback a SKUs
        if (s.grupo) dailyMap[d].sample_grupos.push(s.grupo);
        const skus = s.all_skus ? s.all_skus.split(',').filter(Boolean) : (s.sku ? [s.sku] : []);
        for (const k of skus) dailyMap[d].sample_skus.push(k);
      }
    }
    for (const s of sales) {
      const d = s.order_date;
      if (dailyMap[d]) {
        dailyMap[d].orders += 1;
        if      (s.comm_type === 'org')  dailyMap[d].orders_org  += 1;
        else if (s.comm_type === 'paid') dailyMap[d].orders_paid += 1;
        dailyMap[d].revenue    += s.revenue || 0;
        dailyMap[d].commission += s.commission || 0;
        const g = s.grupo || 'SIN GRUPO';
        if (!dailyMap[d].sale_grupos[g]) dailyMap[d].sale_grupos[g] = { org: 0, paid: 0, revenue: 0 };
        if      (s.comm_type === 'org')  dailyMap[d].sale_grupos[g].org  += 1;
        else if (s.comm_type === 'paid') dailyMap[d].sale_grupos[g].paid += 1;
        dailyMap[d].sale_grupos[g].revenue += s.revenue || 0;
      }
    }
    const timeline = Object.values(dailyMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({
        ...d,
        revenue: round(d.revenue),
        commission: round(d.commission),
        // Convertir sale_grupos a array ordenado por pedidos desc
        sale_grupos: Object.entries(d.sale_grupos)
          .map(([grupo, v]) => ({ grupo, org: v.org, paid: v.paid, revenue: round(v.revenue) }))
          .sort((a, b) => (b.org + b.paid) - (a.org + a.paid)),
      }));

    // 4. Totales del afiliado:
    //    - Muestras: total de todo el histórico (todas) + costos.
    //    - Ventas: divididas en MATCHED (mismo grupo familia que las muestras)
    //      y NO-MATCHED (otros productos que el afiliado vende sin que
    //      tu muestra tenga relación causal).
    //    - 2 ROIA:
    //      · ROIA matched (honesto): sólo ventas matched / inversión muestras
    //      · ROIA total (optimista): todas las ventas atribuidas al afiliado
    let totalCogs = 0, totalShip = 0;
    for (const s of samples) {
      totalCogs += s.cogs || 0;
      totalShip += s.shipping_cost || 0;
    }
    const samplesCost = totalCogs + totalShip;

    const matchedSales   = sales.filter(s => s.is_matched);
    const unmatchedSales = sales.filter(s => !s.is_matched);

    const totalRevenue       = sales.reduce((s, r) => s + (r.revenue || 0), 0);
    const totalCommission    = sales.reduce((s, r) => s + (r.commission || 0), 0);
    const matchedRevenue     = matchedSales.reduce((s, r) => s + (r.revenue || 0), 0);
    const matchedCommission  = matchedSales.reduce((s, r) => s + (r.commission || 0), 0);
    const unmatchedRevenue   = unmatchedSales.reduce((s, r) => s + (r.revenue || 0), 0);

    const beneficioNetoTotal   = totalRevenue   - totalCommission   - samplesCost;
    const beneficioNetoMatched = matchedRevenue - matchedCommission - samplesCost;

    const roiaTotal = samplesCost > 0
      ? round((beneficioNetoTotal / samplesCost) * 100, 1)
      : null;
    // ROIA matched solo tiene sentido si hubo ventas del grupo de la muestra
    const roiaMatched = samplesCost > 0 && matchedSales.length > 0
      ? round((beneficioNetoMatched / samplesCost) * 100, 1)
      : null;

    // 5. Productos vendidos agregados (por grupo) — match received↔vendido
    //    a nivel FAMILIA. Ej recv "BANE-TER-GR;PATAS" matchea con
    //    vendido "BANE-TER-RO;PATAS" (misma línea, distinto color).
    const soldByGroupMap = {};
    for (const s of sales) {
      const g = s.grupo || 'SIN GRUPO';
      if (!soldByGroupMap[g]) soldByGroupMap[g] = {
        grupo: g,
        units: 0, orders: 0,
        orders_org: 0, orders_paid: 0,
        revenue: 0, commission: 0,
      };
      const r = soldByGroupMap[g];
      r.units   += 1;
      r.orders  += 1;
      if      (s.comm_type === 'org')  r.orders_org  += 1;
      else if (s.comm_type === 'paid') r.orders_paid += 1;
      r.revenue    += s.revenue || 0;
      r.commission += s.commission || 0;
    }
    const soldByGroup = Object.values(soldByGroupMap).map(r => ({
      ...r,
      revenue:    round(r.revenue),
      commission: round(r.commission),
      received:   isVentaMatched(r.grupo),
    })).sort((a, b) => b.units - a.units);

    // 6. Videos del período: lista de cada video_id con sus ventas, producto
    //    principal y flag matched (si vendió grupo de muestra recibida).
    const videosMap = {};
    for (const s of sales) {
      if (!s.video_id) continue;
      if (!videosMap[s.video_id]) videosMap[s.video_id] = {
        video_id:    s.video_id,
        sales:       0,
        revenue:     0,
        commission:  0,
        orders_org:  0,
        orders_paid: 0,
        first_date:  s.order_date,
        last_date:   s.order_date,
        products:    {},
        grupos:      new Set(),
      };
      const v = videosMap[s.video_id];
      v.sales      += 1;
      v.revenue    += s.revenue || 0;
      v.commission += s.commission || 0;
      if      (s.comm_type === 'org')  v.orders_org  += 1;
      else if (s.comm_type === 'paid') v.orders_paid += 1;
      if (s.product_name) v.products[s.product_name] = (v.products[s.product_name] || 0) + 1;
      if (s.grupo) v.grupos.add(s.grupo);
      if (s.order_date < v.first_date) v.first_date = s.order_date;
      if (s.order_date > v.last_date)  v.last_date  = s.order_date;
    }
    const videos = Object.values(videosMap).map(v => {
      const topProdEntry = Object.entries(v.products).sort((a, b) => b[1] - a[1])[0];
      const grupos       = [...v.grupos];
      const isMatched    = grupos.some(g => isVentaMatched(g));
      return {
        video_id:     v.video_id,
        sales:        v.sales,
        revenue:      round(v.revenue),
        commission:   round(v.commission),
        orders_org:   v.orders_org,
        orders_paid:  v.orders_paid,
        first_date:   v.first_date,
        last_date:    v.last_date,
        top_product:  topProdEntry?.[0] || '',
        product_count: Object.keys(v.products).length,
        grupos,
        is_matched:   isMatched,
      };
    }).sort((a, b) => b.sales - a.sales);

    // 5. Nombre real desde creator_mapping (o de las muestras)
    const mapRow = db.prepare(`
      SELECT simla_customer_name FROM creator_mapping
      WHERE tiktok_username = ? AND confirmed = 1 LIMIT 1
    `).get(h);
    const customerName = mapRow?.simla_customer_name || samples[0]?.customer_name || null;

    const samplesInPeriod = samples.filter(s => s.in_period).length;

    res.json({
      period: { from, to },
      handle: h,
      customer_name: customerName,
      totals: {
        // Muestras: TODO el histórico del afiliado
        samples:           samples.length,
        samples_in_period: samplesInPeriod,
        units:             samples.reduce((s, r) => s + (r.units || 1), 0),
        samples_cost:      round(samplesCost),
        cogs:              round(totalCogs),
        shipping:          round(totalShip),
        // Ventas: del período filtrado
        orders:            sales.length,
        orders_matched:    matchedSales.length,
        orders_unmatched:  unmatchedSales.length,
        orders_org:        sales.filter(s => s.comm_type === 'org').length,
        orders_paid:       sales.filter(s => s.comm_type === 'paid').length,
        videos:            new Set(sales.map(s => s.video_id).filter(Boolean)).size,
        facturacion:           round(totalRevenue),
        facturacion_matched:   round(matchedRevenue),
        facturacion_unmatched: round(unmatchedRevenue),
        commission:            round(totalCommission),
        commission_matched:    round(matchedCommission),
        // Inversión + ROIAs
        inversion:             round(samplesCost),  // muestras out-of-pocket
        beneficio_neto:        round(beneficioNetoTotal),
        beneficio_neto_matched: round(beneficioNetoMatched),
        roia_total:            roiaTotal,    // todas las ventas (optimista)
        roia_matched:          roiaMatched,  // sólo grupo de muestra (honesto)
        // Compat con código viejo
        roia:                  roiaTotal,
      },
      samples,
      sales,
      sold_by_group: soldByGroup,
      videos,
      timeline,
    });
  } catch (err) {
    console.error('[affiliate detail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/samples/scan ──────────────────────────────────────────
// Escanea Simla en un rango, detecta muestras gratuitas (shopify_tags="Free sample")
// y las upserea en tts_samples.
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
router.post('/scan', async (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ error: 'from requerido (YYYY-MM-DD)' });
    }
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'to requerido (YYYY-MM-DD)' });
    }
    const result = await scanSamples(from, to);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[samples /scan]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tts/samples?from=&to=&type= ───────────────────────────────
// Devuelve muestras del rango con atribución + agregados + sugerencias de unassigned.
router.get('/', (req, res) => {
  try {
    const { from, to, type } = req.query;
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ error: 'from requerido (YYYY-MM-DD)' });
    }
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'to requerido (YYYY-MM-DD)' });
    }

    const db = getDb();
    const samples = getSamplesWithAttribution(from, to, type || null);
    const windowDays = getAttributionWindowDays();

    // ── Agregado por handle DEDUPLICADO ──
    // Si un creator recibió N muestras, todas las muestras "comparten" sus ventas:
    // sumamos 1 sola vez. Ventana = [min approved_date] a [max approved_date + window].
    const handleMeta = {}; // handle → { start, count }
    for (const s of samples) {
      if (!s.tiktok_username) continue;
      const h = s.tiktok_username;
      const startDate = s.approved_date || s.sent_date;
      if (!handleMeta[h]) {
        handleMeta[h] = { start: startDate, lastSampleDate: startDate, count: 0 };
      }
      handleMeta[h].count += 1;
      if (startDate < handleMeta[h].start) handleMeta[h].start = startDate;
      if (startDate > handleMeta[h].lastSampleDate) handleMeta[h].lastSampleDate = startDate;
    }

    // Helper para sumar días
    const addDays = (dateStr, d) => {
      const t = new Date(dateStr + 'T00:00:00Z');
      t.setUTCDate(t.getUTCDate() + d);
      return t.toISOString().slice(0, 10);
    };

    // Query unificada por handle
    const handleAgg = {}; // handle → { orders, revenue, commission, videos, orders_paid, orders_org }
    for (const [handle, meta] of Object.entries(handleMeta)) {
      const startDate = meta.start;
      const endDate   = addDays(meta.lastSampleDate, windowDays);
      const row = db.prepare(`
        SELECT COUNT(*)                                            AS orders,
               COALESCE(SUM(revenue), 0)                           AS revenue,
               COALESCE(SUM(commission), 0)                        AS commission,
               COUNT(DISTINCT video_id)                            AS videos,
               SUM(CASE WHEN comm_type='paid' THEN 1 ELSE 0 END)   AS orders_paid,
               SUM(CASE WHEN comm_type='org'  THEN 1 ELSE 0 END)   AS orders_org
        FROM tts_affiliate_orders
        WHERE tiktok_username = ?
          AND order_date BETWEEN ? AND ?
          AND (order_status IS NULL OR order_status NOT LIKE '%aptos%')
          AND (fully_refunded IS NULL OR fully_refunded = 0)
      `).get(handle, startDate, endDate);
      handleAgg[handle] = {
        orders:      row.orders || 0,
        revenue:     row.revenue || 0,
        commission:  row.commission || 0,
        videos:      row.videos || 0,
        orders_paid: row.orders_paid || 0,
        orders_org:  row.orders_org || 0,
      };
    }

    // ── Agregados globales (deduplicados por handle) ──
    const summary = {
      total_samples:      samples.length,
      total_cost:         0,
      total_revenue:      0,
      total_commission:   0,
      total_orders:       0,
      total_videos:       0,
      converting_samples: 0,
    };
    for (const s of samples) {
      summary.total_cost += (s.cogs || 0) + (s.shipping_cost || 0) + (s.refunded_amount || 0);
      if ((s.attribution?.orders || 0) > 0) summary.converting_samples += 1;
    }
    // Revenue/orders/commission/videos: UNA VEZ por handle único
    for (const agg of Object.values(handleAgg)) {
      summary.total_orders     += agg.orders;
      summary.total_revenue    += agg.revenue;
      summary.total_commission += agg.commission;
      summary.total_videos     += agg.videos;
    }

    // ROI = (revenue − commission − costo_muestras) / costo_muestras
    const netGain = summary.total_revenue - summary.total_commission - summary.total_cost;
    summary.roi          = summary.total_cost > 0 ? round((netGain / summary.total_cost) * 100, 1) : 0;
    summary.conversion_rate = summary.total_samples > 0
      ? round((summary.converting_samples / summary.total_samples) * 100, 1)
      : 0;
    summary.total_cost       = round(summary.total_cost);
    summary.total_revenue    = round(summary.total_revenue);
    summary.total_commission = round(summary.total_commission);

    // ── Ranking por producto (grupo) ──
    // Como dedup por handle no aplica directo acá (una muestra pertenece a UN grupo),
    // mantenemos attribution por muestra. Sí puede inflar si hay 2 muestras del mismo
    // handle en grupos distintos — en ese caso el revenue del creador se atribuye a
    // ambos grupos.
    const byGrupoMap = {};
    for (const s of samples) {
      const g = s.grupo || 'SIN GRUPO';
      if (!byGrupoMap[g]) byGrupoMap[g] = {
        grupo: g, product_name: s.product_name || g,
        samples: 0, cost: 0, orders: 0, revenue: 0, commission: 0, converting: 0,
      };
      const r = byGrupoMap[g];
      r.samples += 1;
      r.cost    += (s.cogs || 0) + (s.shipping_cost || 0) + (s.refunded_amount || 0);
      const a = s.attribution || {};
      r.orders     += a.orders || 0;
      r.revenue    += a.revenue || 0;
      r.commission += a.commission || 0;
      if ((a.orders || 0) > 0) r.converting += 1;
    }
    const byGrupo = Object.values(byGrupoMap).map(r => ({
      ...r,
      cost:       round(r.cost),
      revenue:    round(r.revenue),
      commission: round(r.commission),
      roi:        r.cost > 0 ? round(((r.revenue - r.commission - r.cost) / r.cost) * 100, 1) : 0,
      conversion_rate: r.samples > 0 ? round((r.converting / r.samples) * 100, 1) : 0,
    })).sort((a, b) => b.samples - a.samples);

    // ── Ranking por creador (DEDUPLICADO: una fila por handle con handleAgg) ──
    const byCreatorMap = {};
    for (const s of samples) {
      const u = s.tiktok_username || '(sin asignar)';
      if (!byCreatorMap[u]) byCreatorMap[u] = {
        tiktok_username: u,
        samples: 0, cost: 0,
        orders: 0, revenue: 0, commission: 0, videos: 0,
        converting: 0, grupos: new Set(),
      };
      const r = byCreatorMap[u];
      r.samples += 1;
      r.cost    += (s.cogs || 0) + (s.shipping_cost || 0) + (s.refunded_amount || 0);
      if (s.grupo) r.grupos.add(s.grupo);
      if ((s.attribution?.orders || 0) > 0) r.converting += 1;
    }
    // Inyectar las métricas del handleAgg (ventas reales del creador, deduplicadas)
    for (const [handle, r] of Object.entries(byCreatorMap)) {
      if (handle === '(sin asignar)') continue;
      const agg = handleAgg[handle];
      if (agg) {
        r.orders     = agg.orders;
        r.revenue    = agg.revenue;
        r.commission = agg.commission;
        r.videos     = agg.videos;
      }
    }
    const byCreator = Object.values(byCreatorMap).map(r => ({
      tiktok_username: r.tiktok_username,
      samples:    r.samples,
      cost:       round(r.cost),
      orders:     r.orders,
      revenue:    round(r.revenue),
      commission: round(r.commission),
      videos:     r.videos,
      converting: r.converting,
      grupos:     [...r.grupos],
      roi:        r.cost > 0 ? round(((r.revenue - r.commission - r.cost) / r.cost) * 100, 1) : 0,
    })).sort((a, b) => b.revenue - a.revenue);

    // ── Muestras sin asignar handle: AGRUPAR por cliente ──
    // Si una persona recibió 3 muestras, aparece 1 fila con las 3 → 1 asignación las cubre.
    const unassignedSamples = samples.filter(s => !s.tiktok_username);
    const groupMap = {};
    for (const s of unassignedSamples) {
      const key = `${s.customer_name || ''}|${s.customer_phone || ''}`;
      if (!groupMap[key]) {
        groupMap[key] = {
          customer_name:  s.customer_name,
          customer_phone: s.customer_phone,
          customer_email: s.customer_email,
          samples: [],
          grupos:  new Set(),
          total_cost: 0,
          // Usamos el primer sample para sugerencias (grupo principal)
          representative: s,
        };
      }
      groupMap[key].samples.push(s);
      if (s.grupo) groupMap[key].grupos.add(s.grupo);
      groupMap[key].total_cost += (s.cogs || 0) + (s.shipping_cost || 0);
    }
    const unassigned = Object.values(groupMap).map(g => {
      // Sugerencias: combinar candidatos de todos los grupos únicos
      const allCandidates = {};
      for (const s of g.samples) {
        for (const c of suggestHandles(s)) {
          if (!allCandidates[c.tiktok_username]) {
            allCandidates[c.tiktok_username] = { ...c };
          } else {
            allCandidates[c.tiktok_username].orders  += c.orders;
            allCandidates[c.tiktok_username].revenue += c.revenue;
          }
        }
      }
      const candidates = Object.values(allCandidates)
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 6);

      return {
        customer_name:  g.customer_name,
        customer_phone: g.customer_phone,
        customer_email: g.customer_email,
        sample_count:   g.samples.length,
        grupos:         [...g.grupos],
        total_cost:     round(g.total_cost),
        sample_ids:     g.samples.map(s => s.id),
        representative_id: g.representative.id,
        samples:        g.samples.map(s => ({
          id:            s.id,
          simla_order_num: s.simla_order_num,
          sent_date:     s.sent_date,
          grupo:         s.grupo,
          sku:           s.sku,
          cogs:          s.cogs,
          shipping_cost: s.shipping_cost,
        })),
        candidates,
      };
    }).sort((a, b) => b.sample_count - a.sample_count);

    // ── Serie diaria para gráficos ──
    // Por día: muestras enviadas + ventas_org + ventas_paid atribuidas a handles
    // que están asignados a muestras del período.
    const dailyMap = {};
    for (const s of samples) {
      const d = s.sent_date;
      if (!dailyMap[d]) dailyMap[d] = {
        date: d, samples: 0, cost: 0, revenue: 0,
        sales_org: 0, sales_paid: 0,
      };
      dailyMap[d].samples += 1;
      dailyMap[d].cost    += (s.cogs || 0) + (s.shipping_cost || 0);
      dailyMap[d].revenue += (s.attribution?.revenue) || 0;
    }

    // Agregar ventas atribuidas diarias (contando filas de tts_affiliate_orders
    // con handle asignado a muestras del período, dentro de la ventana de atribución)
    const assignedHandles = [...new Set(samples.map(s => s.tiktok_username).filter(Boolean))];
    if (assignedHandles.length > 0) {
      const windowDays = getAttributionWindowDays();
      // Buscar ventas entre el primer sent_date y el último sent_date + ventana
      const sampleDates = samples.map(s => s.approved_date || s.sent_date).filter(Boolean);
      if (sampleDates.length > 0) {
        sampleDates.sort();
        const salesFrom = sampleDates[0];
        const salesToDate = new Date(sampleDates[sampleDates.length - 1] + 'T00:00:00Z');
        salesToDate.setUTCDate(salesToDate.getUTCDate() + windowDays);
        const salesTo = salesToDate.toISOString().slice(0, 10);

        // Contamos TODAS las ventas de los handles asignados en la ventana
        // (sin filtrar por grupo — ver computeAttribution para la justificación).
        const placeholders = assignedHandles.map(() => '?').join(',');
        const salesRows = db.prepare(`
          SELECT order_date,
                 SUM(CASE WHEN comm_type = 'org'  THEN 1 ELSE 0 END) AS sales_org,
                 SUM(CASE WHEN comm_type = 'paid' THEN 1 ELSE 0 END) AS sales_paid
          FROM tts_affiliate_orders
          WHERE tiktok_username IN (${placeholders})
            AND order_date BETWEEN ? AND ?
            AND (order_status IS NULL OR order_status NOT LIKE '%aptos%')
            AND (fully_refunded IS NULL OR fully_refunded = 0)
          GROUP BY order_date
        `).all(...assignedHandles, salesFrom, salesTo);

        for (const sr of salesRows) {
          const d = sr.order_date;
          if (!dailyMap[d]) dailyMap[d] = {
            date: d, samples: 0, cost: 0, revenue: 0,
            sales_org: 0, sales_paid: 0,
          };
          dailyMap[d].sales_org  += sr.sales_org || 0;
          dailyMap[d].sales_paid += sr.sales_paid || 0;
        }
      }
    }

    // Rellenar el rango completo from..to con días vacíos
    const daily = [];
    const start = new Date(from + 'T00:00:00Z');
    const end   = new Date(to   + 'T00:00:00Z');
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const entry = dailyMap[iso] || {
        date: iso, samples: 0, cost: 0, revenue: 0,
        sales_org: 0, sales_paid: 0,
      };
      daily.push({
        date:       entry.date,
        samples:    entry.samples || 0,
        sales_org:  entry.sales_org || 0,
        sales_paid: entry.sales_paid || 0,
        cost:       round(entry.cost || 0),
        revenue:    round(entry.revenue || 0),
      });
    }

    // ── Diagnóstico: estado de tts_affiliate_orders ──
    // Si está vacío o no cubre el período, la atribución no va a funcionar.
    const affOrdersTotal = db.prepare('SELECT COUNT(*) AS c FROM tts_affiliate_orders').get().c;
    const affDateRange = db.prepare(
      'SELECT MIN(order_date) AS min_date, MAX(order_date) AS max_date FROM tts_affiliate_orders'
    ).get();
    const diagnostic = {
      affiliate_orders_total: affOrdersTotal,
      affiliate_orders_date_range: [affDateRange.min_date || null, affDateRange.max_date || null],
      handles_with_sales: (() => {
        if (Object.keys(handleMeta).length === 0) return [];
        const placeholders = Object.keys(handleMeta).map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT tiktok_username, COUNT(*) AS n
          FROM tts_affiliate_orders
          WHERE tiktok_username IN (${placeholders})
          GROUP BY tiktok_username
        `).all(...Object.keys(handleMeta));
        return rows;
      })(),
    };

    res.json({
      samples, summary, byGrupo, byCreator, unassigned, daily,
      attribution_window_days: getAttributionWindowDays(),
      diagnostic,
    });
  } catch (err) {
    console.error('[samples GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/samples/:id/assign ───────────────────────────────────
// Asigna un handle TikTok a una muestra y guarda el mapeo para reusar.
// Body: { tiktok_username: 'handle' }
router.post('/:id/assign', (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const handle = (req.body.tiktok_username || '').toLowerCase().trim();

    if (!id || !handle) return res.status(400).json({ error: 'id y tiktok_username requeridos' });

    const sample = db.prepare('SELECT * FROM tts_samples WHERE id = ?').get(id);
    if (!sample) return res.status(404).json({ error: 'muestra no encontrada' });

    // 1. Actualizar la muestra clickeada
    db.prepare(`
      UPDATE tts_samples
      SET tiktok_username = ?, auto_assigned = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(handle, id);

    // 2. CASCADA: aplicar el mismo handle a TODAS las muestras sin asignar
    //    del mismo customer (matching por name + phone).
    let cascaded = 0;
    if (sample.customer_name) {
      const result = db.prepare(`
        UPDATE tts_samples
        SET tiktok_username = ?, auto_assigned = 1, updated_at = datetime('now')
        WHERE tiktok_username IS NULL
          AND customer_name   = ?
          AND (customer_phone = ? OR (? IS NULL AND customer_phone IS NULL))
          AND id != ?
      `).run(handle, sample.customer_name, sample.customer_phone, sample.customer_phone, id);
      cascaded = result.changes || 0;
    }

    // 3. Guardar mapping para reutilizar en futuras muestras al mismo customer
    if (sample.customer_name) {
      try {
        db.prepare(`
          INSERT INTO creator_mapping (
            simla_customer_name, simla_customer_email, simla_customer_phone,
            tiktok_username, confirmed, source
          ) VALUES (?, ?, ?, ?, 1, 'manual')
          ON CONFLICT(simla_customer_name, tiktok_username) DO UPDATE SET
            confirmed = 1, source = 'manual'
        `).run(sample.customer_name, sample.customer_email, sample.customer_phone, handle);
      } catch (_) { /* ignorar si ya existe */ }
    }

    res.json({ ok: true, id, tiktok_username: handle, cascaded });
  } catch (err) {
    console.error('[samples assign]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/samples/:id/unassign ─────────────────────────────────
// Desasigna el handle (lo pone en NULL) para volver a sugerir.
router.post('/:id/unassign', (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    db.prepare(`
      UPDATE tts_samples
      SET tiktok_username = NULL, auto_assigned = 0, updated_at = datetime('now')
      WHERE id = ?
    `).run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[samples unassign]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/tts/samples/:id/mark-reimbursable ─────────────────────────
// Marca una muestra como reembolsable (el afiliado pagó X y luego le devolvimos).
// Body: { original_price, refunded_amount }
router.post('/:id/mark-reimbursable', (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const { original_price = 0, refunded_amount = 0 } = req.body;
    db.prepare(`
      UPDATE tts_samples
      SET sample_type     = 'reimbursable',
          original_price  = ?,
          refunded_amount = ?,
          refunded_at     = CASE WHEN ? > 0 THEN datetime('now') ELSE refunded_at END,
          updated_at      = datetime('now')
      WHERE id = ?
    `).run(parseFloat(original_price) || 0, parseFloat(refunded_amount) || 0,
           parseFloat(refunded_amount) || 0, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[samples mark-reimbursable]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/tts/samples/:id/candidates ────────────────────────────────
// Devuelve candidatos (handles que vendieron el grupo en la ventana) para asignar.
router.get('/:id/candidates', (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const sample = db.prepare('SELECT * FROM tts_samples WHERE id = ?').get(id);
    if (!sample) return res.status(404).json({ error: 'muestra no encontrada' });
    const candidates = suggestHandles(sample);
    res.json({ candidates });
  } catch (err) {
    console.error('[samples candidates]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/tts/samples/:id ────────────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    db.prepare('DELETE FROM tts_samples WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[samples delete]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/tts/samples/:id/notes ─────────────────────────────────────
router.put('/:id/notes', (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const notes = req.body.notes || '';
    db.prepare("UPDATE tts_samples SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(notes, id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[samples notes]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
