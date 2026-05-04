/**
 * Realized Report Service — métricas REALES por estado de Simla.
 * Consulta la API en vivo y clasifica cada pedido con la lógica del documento
 * Simla_Logica_Estados.docx. A diferencia del reporte diario (especulativo,
 * basado en %conf × %entr configurados), acá se ven las cifras finales.
 */

const { getDb } = require('../db');
const { classify, getVal, CANCEL } = require('./simlaStates');

const SIMLA_BASE = 'https://fulfillment.simla.com/api/v5';

function getSimlaApiKey() {
  const db = getDb();
  return db.prepare("SELECT value FROM app_settings WHERE key = 'simla_api_key'").pluck().get() || '';
}

/**
 * Pagina y trae todos los pedidos creados en [from, to] (inclusive).
 * Usa paginación paralela de 10 páginas como recomienda el doc.
 */
async function fetchOrdersRange(from, to) {
  const apiKey = getSimlaApiKey();
  if (!apiKey) throw new Error('Simla API key no configurada. Ir a Configuración.');

  const fetchPage = async (page) => {
    const params = new URLSearchParams({
      apiKey,
      limit: '100',
      page: String(page),
      'filter[createdAtFrom]': `${from} 00:00:00`,
      'filter[createdAtTo]':   `${to} 23:59:59`,
    });
    const r = await fetch(`${SIMLA_BASE}/orders?${params}`);
    if (!r.ok) throw new Error(`Simla API error ${r.status} (page ${page})`);
    const d = await r.json();
    if (!d.success) throw new Error(d.errorMsg || 'Error Simla API');
    return d;
  };

  const first = await fetchPage(1);
  const totalPages = first.pagination?.totalPageCount || 1;

  let all = first.orders || [];

  const remaining = [];
  for (let p = 2; p <= totalPages; p++) remaining.push(p);

  const batchSize = 10;
  for (let i = 0; i < remaining.length; i += batchSize) {
    const batch = remaining.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(p => fetchPage(p).then(d => d.orders || []).catch(() => [])));
    for (const arr of results) all = all.concat(arr);
  }

  return all;
}

/**
 * Costo de producto por pedido: suma items[].purchasePrice * quantity.
 * Si purchasePrice falta, intenta resolver desde la tabla skus por SKU.
 */
function calcCogs(order, skuMap) {
  let cogs = 0;
  for (const it of (order.items || [])) {
    const qty = it.quantity || 1;
    let unit = it.purchasePrice || 0;
    if (!unit) {
      const sku = (it.offer?.article || '').trim().toUpperCase();
      const sd = skuMap.get(sku);
      if (sd) unit = sd.cost || 0;
    }
    cogs += unit * qty;
  }
  return cogs;
}

/**
 * Calcula envío del pedido desde la maestra de SKUs (skuMap.shipping_es).
 * Misma fórmula que el reporte diario: max shipping de los SKUs + 10% por
 * unidad adicional. Se usa porque Simla suele dejar delivery.netCost en 0
 * y solo lo completa después del despacho.
 */
function calcShipping(order, skuMap) {
  let maxShipping = 0;
  let totalUnits = 0;
  for (const it of (order.items || [])) {
    const qty = it.quantity || 1;
    const sku = (it.offer?.article || '').trim().toUpperCase();
    const sd  = skuMap.get(sku)
             || skuMap.get(sku.replace(/-[A-Z0-9]+$/, '-'))
             || skuMap.get(sku.replace(/-[A-Z0-9]+$/, ''));
    const ship = (sd?.shipping_es || 0);
    if (ship > maxShipping) maxShipping = ship;
    totalUnits += qty;
  }
  // Si Simla sí trae delivery.netCost, lo respetamos como fuente de verdad
  const netCost = order.delivery?.netCost || 0;
  if (netCost > 0) return netCost;
  if (totalUnits <= 1) return maxShipping;
  return maxShipping * (1 + 0.1 * (totalUnits - 1));
}

/**
 * Resuelve el grupo del pedido a partir del primer item (SKU principal).
 * Cae al SKU si no hay grupo asignado.
 */
function resolveGrupo(order, skuMap) {
  const firstSku = (order.items?.[0]?.offer?.article || '').trim().toUpperCase();
  if (!firstSku) return 'SIN GRUPO';
  const sd = skuMap.get(firstSku)
    || skuMap.get(firstSku.replace(/-[A-Z0-9]+$/, '-'))
    || skuMap.get(firstSku.replace(/-[A-Z0-9]+$/, ''));
  return (sd?.grupo || firstSku).toUpperCase();
}

/**
 * Construye el reporte realizado para un rango de fechas y un canal.
 * @returns {{ summary, byGrupo, configured }}
 */
async function buildRealizedReport({ from, to, site = '000-amz' }) {
  const all = await fetchOrdersRange(from, to);
  const orders = all.filter(o => o.site === site);

  // Mapa de SKUs desde la DB local (para grupos y fallback de coste)
  const db = getDb();
  const skuRows = db.prepare('SELECT sku, grupo, cost, shipping_es FROM skus').all();
  const skuMap = new Map();
  for (const r of skuRows) skuMap.set(String(r.sku).toUpperCase(), r);

  // Settings (para comparar con configurado)
  const settingsRows = db.prepare('SELECT key, value FROM app_settings').all();
  const settings = {};
  for (const r of settingsRows) settings[r.key] = r.value;
  // Las tasas vienen guardadas como decimal (0.85) — convertir a %
  function readRate(key, defaultPct) {
    const raw = parseFloat(settings[key]);
    if (!isFinite(raw)) return defaultPct;
    return raw <= 1 ? raw * 100 : raw; // tolerar ambos formatos
  }
  const confRateConf = readRate('cod_confirmation_rate', 85);
  const deliRateConf = readRate('cod_delivery_rate',     83);

  // Acumuladores globales (delivered_paid y refunded separados)
  const buckets = {
    delivered_paid: { count: 0, revenue: 0, cogs: 0, shipping: 0 },
    refunded:       { count: 0, revenue: 0, cogs: 0, shipping: 0 },
    transit:        { count: 0, revenue: 0, cogs: 0, shipping: 0 },
    rehusado:       { count: 0, revenue: 0, cogs: 0, shipping: 0 },
    devuelta_pend:  { count: 0, revenue: 0, cogs: 0, shipping: 0 },
    cancel:         { count: 0, revenue: 0, cogs: 0, shipping: 0 },
    pending:        { count: 0, revenue: 0, cogs: 0, shipping: 0 },
  };

  // Acumuladores por grupo
  const byGrupo = new Map();
  function getGrupo(g) {
    if (!byGrupo.has(g)) {
      byGrupo.set(g, {
        grupo: g, total: 0,
        delivered_paid: 0, refunded: 0, transit: 0, rehusado: 0, devuelta_pend: 0, cancel: 0, pending: 0,
        revenue_paid: 0, revenue_refunded: 0, revenue_transit: 0,
        cogs_paid: 0, cogs_refunded: 0,
        shipping_paid: 0, shipping_lost: 0,
      });
    }
    return byGrupo.get(g);
  }

  for (const o of orders) {
    const cat   = classify(o.status);
    const value = getVal(o);
    const cogs  = calcCogs(o, skuMap);
    const ship  = calcShipping(o, skuMap);
    const grupo = resolveGrupo(o, skuMap);

    buckets[cat].count++;
    buckets[cat].revenue  += value;
    buckets[cat].cogs     += cogs;
    buckets[cat].shipping += ship;

    const g = getGrupo(grupo);
    g.total++;
    g[cat]++;

    if (cat === 'delivered_paid') {
      // Producto entregado y cobrado: costo de COGS y envío "ida" pagados.
      g.revenue_paid    += value;
      g.cogs_paid       += cogs;
      g.shipping_paid   += ship;
    } else if (cat === 'refunded') {
      // Plata entró y volvió. Producto consumido (no recuperable).
      // → COGS perdido + shipping ida+vuelta perdidos.
      g.revenue_refunded += value;
      g.cogs_refunded    += cogs;
      g.shipping_lost    += ship * 2;
    } else if (cat === 'transit') {
      g.revenue_transit += value;
      // (COGS y envío de transit no se descuentan hasta saber el desenlace)
    } else if (cat === 'rehusado' || cat === 'devuelta_pend') {
      // Producto vuelve al almacén → COGS recuperable, NO se pierde.
      // Solo se pierde el envío ida + vuelta.
      g.shipping_lost += ship * 2;
    }
  }

  const total = orders.length;
  // Funnel "entregados" (Simla UI) = delivered_paid + refunded
  const deliveredFunnel = buckets.delivered_paid.count + buckets.refunded.count;
  const confirmed = deliveredFunnel + buckets.transit.count + buckets.rehusado.count + buckets.devuelta_pend.count;

  // Costos agregados — definidos arriba para reutilizar en summary y netResult
  const shippingLostTotal = buckets.rehusado.shipping * 2
                          + buckets.devuelta_pend.shipping * 2
                          + buckets.refunded.shipping * 2;
  const cogsLostTotal     = buckets.refunded.cogs;

  // Métricas reales (sobre TOTAL, no sobre confirmed — así suman 100%)
  const pct = (n) => total ? +(100 * n / total).toFixed(2) : 0;

  const summary = {
    total,
    confirmed,
    pct_confirmed: pct(confirmed),
    // Funnel "entregados" Simla = paid + refunded (para cuadrar con su UI)
    pct_delivered: pct(deliveredFunnel),
    // Cobro NETO: solo lo que efectivamente quedó en banco
    pct_paid:      pct(buckets.delivered_paid.count),
    pct_refunded:  pct(buckets.refunded.count),
    pct_rehusado:  pct(buckets.rehusado.count),
    pct_devuelta_pend: pct(buckets.devuelta_pend.count),
    pct_transit:   pct(buckets.transit.count),
    pct_cancel:    pct(buckets.cancel.count),
    pct_pending:   pct(buckets.pending.count),

    // Efectividad real = entregados / confirmados (cuadra con UI Simla)
    efectividad_real: confirmed ? +(100 * deliveredFunnel / confirmed).toFixed(2) : 0,
    // Cobro neto / confirmados (sin contar reembolsos)
    cobro_neto_real:  confirmed ? +(100 * buckets.delivered_paid.count / confirmed).toFixed(2) : 0,

    // Comparación con configurado (especulativo)
    pct_confirmed_configured: confRateConf,
    pct_delivered_configured: deliRateConf,
    efectividad_configurada: +((confRateConf * deliRateConf) / 100).toFixed(2),

    // Económicos
    revenue_paid:      round2(buckets.delivered_paid.revenue), // ← lo que está en tu banco
    revenue_refunded:  round2(buckets.refunded.revenue),       // ← entró y volvió
    revenue_transit:   round2(buckets.transit.revenue),
    revenue_lost:      round2(buckets.rehusado.revenue + buckets.devuelta_pend.revenue + buckets.cancel.revenue),
    cogs_paid:         round2(buckets.delivered_paid.cogs),    // COGS de los entregados pagados
    cogs_refunded:     round2(buckets.refunded.cogs),          // COGS de reembolsados (producto perdido)
    cogs_lost:         round2(buckets.refunded.cogs),          // alias = solo refunded (ver doc)
    cogs_recoverable:  round2(buckets.rehusado.cogs + buckets.devuelta_pend.cogs), // vuelven al almacén
    shipping_paid:     round2(buckets.delivered_paid.shipping),
    shipping_lost:     round2(shippingLostTotal),

    buckets: {
      delivered_paid: { count: buckets.delivered_paid.count, revenue: round2(buckets.delivered_paid.revenue) },
      refunded:       { count: buckets.refunded.count,       revenue: round2(buckets.refunded.revenue) },
      transit:        { count: buckets.transit.count,        revenue: round2(buckets.transit.revenue) },
      rehusado:       { count: buckets.rehusado.count,       revenue: round2(buckets.rehusado.revenue) },
      devuelta_pend:  { count: buckets.devuelta_pend.count,  revenue: round2(buckets.devuelta_pend.revenue) },
      cancel:         { count: buckets.cancel.count,         revenue: round2(buckets.cancel.revenue) },
      pending:        { count: buckets.pending.count,        revenue: round2(buckets.pending.revenue) },
    },
  };

  // ── ADS SPEND ───────────────────────────────────────────────────────────
  // Suma gasto en ads del rango from→to desde la tabla ad_spend (poblada por
  // Windsor diariamente). Atribución:
  //   1. Mapeo directo: campañas con sku_group asignado → ese grupo
  //   2. Spread proporcional: campañas multi-producto (sin grupo) se reparten
  //      entre grupos según % de cobrado en el período. Misma lógica que el
  //      reporte diario aplica para GMV Max sin grupo.
  const adsRows = db.prepare(`
    SELECT
      COALESCE(NULLIF(sku_group, ''), '__sin_grupo__') AS grupo,
      platform,
      SUM(spend) AS spend
    FROM ad_spend
    WHERE date BETWEEN ? AND ?
    GROUP BY grupo, platform
  `).all(from, to);

  const adsDirectByGrupo = {};
  const adsSpreadByGrupo = {};
  let adsTotal = 0, adsMeta = 0, adsTiktok = 0, adsUnmapped = 0;
  for (const r of adsRows) {
    const spend = r.spend || 0;
    adsTotal += spend;
    if (r.platform === 'meta')   adsMeta   += spend;
    if (r.platform === 'tiktok') adsTiktok += spend;
    if (r.grupo === '__sin_grupo__') {
      adsUnmapped += spend;
      continue;
    }
    adsDirectByGrupo[r.grupo] = (adsDirectByGrupo[r.grupo] || 0) + spend;
  }

  // Spread del gasto sin grupo proporcional al cobrado neto por grupo
  if (adsUnmapped > 0) {
    let totalRev = 0;
    for (const g of byGrupo.values()) totalRev += g.revenue_paid;
    if (totalRev > 0) {
      for (const g of byGrupo.values()) {
        if (g.revenue_paid <= 0) continue;
        const share = (g.revenue_paid / totalRev) * adsUnmapped;
        adsSpreadByGrupo[g.grupo] = share;
      }
    }
  }

  // Total atribuido por grupo = directo + spread
  const adsByGrupo = {};
  const allGrupos = new Set([...Object.keys(adsDirectByGrupo), ...Object.keys(adsSpreadByGrupo)]);
  for (const grupo of allGrupos) {
    adsByGrupo[grupo] = (adsDirectByGrupo[grupo] || 0) + (adsSpreadByGrupo[grupo] || 0);
  }

  // ── RESULTADO NETO ──────────────────────────────────────────────────────
  // Pre-IVA revenue: el cobrado incluye 21% IVA que no es ingreso real.
  // (suponemos IVA=21 para Web — para TTS sería distinto pero este reporte
  // es solo para 000-amz/web).
  const ivaPct = 21;
  const revenuePreIva = buckets.delivered_paid.revenue / (1 + ivaPct/100);
  const ivaOwed       = buckets.delivered_paid.revenue - revenuePreIva;

  // Resultado neto:
  //   revenue (sin IVA) entregados pagados
  // − COGS de los entregados pagados (producto que se quedó el cliente)
  // − COGS de los reembolsados (producto consumido / no recuperable)
  // − envío ida (pagado en delivered_paid)
  // − envío ida+vuelta (rehusado, devuelta_pend, refunded)
  // − ads del período
  const netResult = revenuePreIva
                  - buckets.delivered_paid.cogs
                  - cogsLostTotal
                  - buckets.delivered_paid.shipping
                  - shippingLostTotal
                  - adsTotal;

  summary.ads_total    = round2(adsTotal);
  summary.ads_meta     = round2(adsMeta);
  summary.ads_tiktok   = round2(adsTiktok);
  summary.ads_unmapped = round2(adsUnmapped);
  summary.iva_pct      = ivaPct;
  summary.iva_owed     = round2(ivaOwed);
  summary.revenue_pre_iva = round2(revenuePreIva);
  summary.net_result   = round2(netResult);
  // ROAS bruto (cobrado total / ads). Si no hay ads, null.
  summary.roas         = adsTotal > 0 ? +(buckets.delivered_paid.revenue / adsTotal).toFixed(2) : null;

  // ── ESTIMADO con tasas configuradas (para delta real vs especulativo) ──
  // Tomamos el revenue bruto de TODOS los pedidos y aplicamos las tasas COD
  // configuradas. Así sale "qué resultado HABRÍAS tenido si los % se cumplieran".
  const totalRawRev   = orders.reduce((sum, o) => sum + getVal(o), 0);
  const totalRawCogs  = orders.reduce((sum, o) => sum + calcCogs(o, skuMap), 0);
  const totalRawShip  = orders.reduce((sum, o) => sum + (o.delivery?.netCost || 0), 0);

  const eConfRate = confRateConf / 100;
  const eDeliRate = deliRateConf / 100;

  // Revenue cobrado esperado = total × conf × deli
  const expRevenuePaid = totalRawRev * eConfRate * eDeliRate;
  const expRevenuePreIva = expRevenuePaid / (1 + ivaPct/100);
  // COGS esperado: pagamos COGS de los confirmados que se entregan
  // (los confirmados que NO se entregan también pierden COGS, simplificación: cogs total × conf × deli)
  const expCogs = totalRawCogs * eConfRate * eDeliRate;
  // Shipping esperado: envío ida para todos los confirmados, vuelta para los devueltos
  const expShipForward = totalRawShip * eConfRate;
  const expShipReturn  = totalRawShip * eConfRate * (1 - eDeliRate); // ida + vuelta = 2x ship
  const expShipping = expShipForward + expShipReturn;
  const expNet = expRevenuePreIva - expCogs - expShipping - adsTotal;

  summary.estimated = {
    revenue_paid: round2(expRevenuePaid),
    net_result:   round2(expNet),
    iva_owed:     round2(expRevenuePaid - expRevenuePreIva),
  };
  summary.delta = {
    pct_confirmed:    +(summary.pct_confirmed - confRateConf).toFixed(2),
    pct_paid_vs_deli: +(summary.cobro_neto_real - deliRateConf).toFixed(2),
    pct_efect_total:  +(summary.pct_paid - summary.efectividad_configurada).toFixed(2),
    revenue_paid:     round2(buckets.delivered_paid.revenue - expRevenuePaid),
    net_result:       round2(netResult - expNet),
  };

  // Tabla por grupo (ordenada por pedidos descendente)
  const byGrupoArr = [...byGrupo.values()].map(g => {
    const delFunnel = g.delivered_paid + g.refunded;
    const conf = delFunnel + g.transit + g.rehusado + g.devuelta_pend;
    const adsDirect = adsDirectByGrupo[g.grupo] || 0;
    const adsSpread = adsSpreadByGrupo[g.grupo] || 0;
    const ads = adsByGrupo[g.grupo] || 0;
    const grevPreIva = g.revenue_paid / (1 + ivaPct/100);
    // Resultado por grupo: misma fórmula que el total
    //   pre-IVA − COGS pagados − COGS reembolsados − envío pagado − envío perdido − ads
    const gNet = grevPreIva - g.cogs_paid - g.cogs_refunded - g.shipping_paid - g.shipping_lost - ads;
    const gRoas = ads > 0 ? +(g.revenue_paid / ads).toFixed(2) : null;
    return {
      ...g,
      pct_confirmed:   g.total ? +(100 * conf / g.total).toFixed(1) : 0,
      pct_paid:        g.total ? +(100 * g.delivered_paid / g.total).toFixed(1) : 0, // cobro neto / total
      pct_refunded:    g.total ? +(100 * g.refunded / g.total).toFixed(1) : 0,
      pct_delivered:   g.total ? +(100 * delFunnel / g.total).toFixed(1) : 0,        // entregados Simla / total
      pct_rehusado:    g.total ? +(100 * g.rehusado / g.total).toFixed(1) : 0,
      pct_cancel:      g.total ? +(100 * g.cancel / g.total).toFixed(1) : 0,
      efectividad:     conf ? +(100 * delFunnel / conf).toFixed(1) : 0,              // entregados / confirmados
      cobro_neto:      conf ? +(100 * g.delivered_paid / conf).toFixed(1) : 0,       // pagado / confirmados
      revenue_paid:    round2(g.revenue_paid),
      revenue_refunded:round2(g.revenue_refunded),
      revenue_transit: round2(g.revenue_transit),
      shipping_paid:   round2(g.shipping_paid),
      shipping_lost:   round2(g.shipping_lost),
      cogs_paid:       round2(g.cogs_paid),
      cogs_refunded:   round2(g.cogs_refunded),
      ads:             round2(ads),
      ads_direct:      round2(adsDirect),
      ads_spread:      round2(adsSpread),
      net_result:      round2(gNet),
      roas:            gRoas,
      // Deltas vs config (puntos porcentuales)
      d_confirmed:     g.total ? +(((100 * conf / g.total) - confRateConf)).toFixed(1) : 0,
      d_cobro:         conf ? +(((100 * g.delivered_paid / conf) - deliRateConf)).toFixed(1) : 0,
      d_paid:          g.total ? +((100 * g.delivered_paid / g.total) - (confRateConf * deliRateConf / 100)).toFixed(1) : 0,
    };
  }).sort((a, b) => b.total - a.total);

  return {
    from, to, site,
    fetched_total: all.length,
    summary,
    byGrupo: byGrupoArr,
  };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

module.exports = { buildRealizedReport, fetchOrdersRange };
