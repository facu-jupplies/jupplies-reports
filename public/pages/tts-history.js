// ─── TikTok Shop — Historial (estilo Sellerboard) ─────────────────────────────

// Estado global del historial
let _ttsHistPeriods = {};       // { key: { summary, grupos, totals } }
let _ttsHistActive  = 'yesterday'; // período seleccionado para la tabla

// ── Rangos de fecha ───────────────────────────────────────────────────────────

function periodRanges() {
  const t  = today();
  const y  = yesterday();
  const { from: mf, to: mt } = thisMonthRange();
  const { from: pmf, to: pmt } = prevMonthRange();
  return {
    today:     { from: t,   to: t,   label: 'Hoy',          sub: fd(t),  color: '#2563eb' },
    yesterday: { from: y,   to: y,   label: 'Ayer',         sub: fd(y),  color: '#0d9488' },
    month:     { from: mf,  to: mt,  label: 'Este mes',     sub: fd(mf) + ' – ' + fd(mt), color: '#16a34a' },
    prevmonth: { from: pmf, to: pmt, label: 'Mes anterior', sub: fd(pmf) + ' – ' + fd(pmt), color: '#1e40af' },
  };
}

// ── Agregación ────────────────────────────────────────────────────────────────

function aggregatePeriod(summary, grupos) {
  const tot = (summary || []).reduce((acc, d) => {
    acc.gmv              += d.gmv              || 0;
    acc.net_profit       += d.net_profit       || 0;
    acc.gross_profit     += d.gross_profit     || 0;
    acc.orders           += d.orders           || 0;
    acc.orders_propio    += d.orders_propio    || 0;
    acc.orders_paid_afil += d.orders_paid_afil || 0;
    acc.orders_org_afil  += d.orders_org_afil  || 0;
    acc.gmv_max_spend    += d.gmv_max_spend    || 0;
    acc.commission_cost  += d.commission_cost  || 0;
    acc.cogs             += d.cogs             || 0;
    acc.shipping         += d.shipping         || 0;
    acc.iva              += d.iva              || 0;
    acc.tiktok_platform  += d.tiktok_platform  || 0;
    acc.days             += 1;
    return acc;
  }, {
    gmv: 0, net_profit: 0, gross_profit: 0, orders: 0,
    orders_propio: 0, orders_paid_afil: 0, orders_org_afil: 0,
    gmv_max_spend: 0, commission_cost: 0, cogs: 0, shipping: 0,
    iva: 0, tiktok_platform: 0, days: 0,
  });

  tot.margin_pct      = tot.gmv  > 0 ? (tot.net_profit / tot.gmv)  * 100 : 0;
  tot.margin_pct_cogs = tot.cogs > 0 ? (tot.net_profit / tot.cogs) * 100 : 0;
  tot.cpa  = (tot.orders_propio + tot.orders_paid_afil) > 0 && tot.gmv_max_spend > 0
    ? tot.gmv_max_spend / (tot.orders_propio + tot.orders_paid_afil) : 0;
  tot.acos = tot.gmv         > 0 ? (tot.gmv_max_spend / tot.gmv) * 100 : 0;
  tot.aov  = tot.orders      > 0 ? tot.gmv / tot.orders : 0;

  // Grupos acumulados
  const grupoMap = {};
  for (const g of (grupos || [])) {
    const key = g.grupo;
    if (!grupoMap[key]) {
      grupoMap[key] = {
        grupo: g.grupo, display_name: g.display_name || g.grupo,
        orders: 0, orders_propio: 0, orders_paid_afil: 0, orders_org_afil: 0,
        revenue: 0, cogs: 0, shipping: 0, iva: 0, tiktok_platform: 0,
        commission_cost: 0, gmv_max_spend: 0, net_profit: 0, gross_profit: 0,
      };
    }
    const a = grupoMap[key];
    a.orders           += g.orders           || 0;
    a.orders_propio    += g.orders_propio    || 0;
    a.orders_paid_afil += g.orders_paid_afil || 0;
    a.orders_org_afil  += g.orders_org_afil  || 0;
    a.revenue          += g.revenue          || 0;
    a.cogs             += g.cogs             || 0;
    a.shipping         += g.shipping         || 0;
    a.iva              += g.iva              || 0;
    a.tiktok_platform  += g.tiktok_platform  || 0;
    a.commission_cost  += g.commission_cost  || 0;
    a.gmv_max_spend    += g.gmv_max_spend    || 0;
    a.net_profit       += g.net_profit       || 0;
    a.gross_profit     += g.gross_profit     || 0;
  }

  const gruposAgg = Object.values(grupoMap).map(g => ({
    ...g,
    margin_pct:      g.revenue > 0 ? (g.net_profit / g.revenue) * 100 : 0,
    margin_pct_cogs: g.cogs    > 0 ? (g.net_profit / g.cogs)    * 100 : 0,
    roi:             g.cogs    > 0 ? (g.net_profit / g.cogs)    * 100 : 0,
    cpa: (g.orders_propio + g.orders_paid_afil) > 0 && g.gmv_max_spend > 0
      ? g.gmv_max_spend / (g.orders_propio + g.orders_paid_afil) : 0,
    acos: g.revenue > 0 && g.gmv_max_spend > 0 ? (g.gmv_max_spend / g.revenue) * 100 : 0,
    aov:  g.orders  > 0 ? g.revenue / g.orders : 0,
  })).sort((a, b) => b.net_profit - a.net_profit);

  return { tot, days: summary || [], gruposAgg };
}

// ── Carga de datos ────────────────────────────────────────────────────────────

async function loadTTSHistoryAll() {
  const ranges = periodRanges();
  const el = document.getElementById('tts-history-content');
  el.innerHTML = '<div class="loading">⏳ Cargando períodos...</div>';

  // 4 fetches en paralelo
  const results = await Promise.allSettled(
    Object.entries(ranges).map(async ([key, r]) => {
      const data = await API.ttsGetHistory(r.from, r.to);
      return { key, ...aggregatePeriod(data.summary, data.grupos) };
    })
  );

  _ttsHistPeriods = {};
  for (const res of results) {
    if (res.status === 'fulfilled') {
      const { key, ...data } = res.value;
      _ttsHistPeriods[key] = data;
    }
  }

  renderTTSHistoryFull();
}

// ── Render completo ───────────────────────────────────────────────────────────

function renderTTSHistoryFull() {
  const el = document.getElementById('tts-history-content');
  const ranges = periodRanges();

  const cards = Object.entries(ranges).map(([key, r]) => {
    const d = _ttsHistPeriods[key];
    return renderPeriodCard(key, r, d, key === _ttsHistActive);
  }).join('');

  el.innerHTML = `
    <!-- ── 4 tarjetas de período ── -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      ${cards}
    </div>

    <!-- ── Tabla del período seleccionado ── -->
    <div id="tts-hist-table-wrap">
      ${renderHistTable(ranges[_ttsHistActive], _ttsHistPeriods[_ttsHistActive])}
    </div>
  `;
}

// ── Tarjeta de período (estilo Sellerboard) ───────────────────────────────────

function renderPeriodCard(key, range, data, active) {
  const isActive = active;
  const border   = isActive ? `2px solid ${range.color}` : '2px solid transparent';
  const opacity  = data && data.tot.days > 0 ? 1 : 0.5;

  if (!data || data.tot.days === 0) {
    return `
      <div class="card" style="border:${border};opacity:${opacity};cursor:pointer;padding:0;overflow:hidden"
           onclick="selectHistPeriod('${key}')">
        <div style="background:${range.color};padding:8px 12px">
          <div style="font-size:13px;font-weight:700;color:#fff">${range.label}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.75)">${range.sub}</div>
        </div>
        <div style="padding:12px;font-size:12px;color:var(--md);text-align:center">Sin datos</div>
      </div>`;
  }

  const { tot } = data;
  const mc = tot.margin_pct >= 20 ? '#22c55e' : tot.margin_pct >= 10 ? '#f59e0b' : '#ef4444';

  const row = (label, value, cls='') =>
    `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">
       <span style="color:var(--md)">${label}</span>
       <span class="${cls}" style="font-weight:600">${value}</span>
     </div>`;

  return `
    <div class="card" style="border:${border};cursor:pointer;padding:0;overflow:hidden;transition:border .15s"
         onclick="selectHistPeriod('${key}')">
      <!-- Header coloreado -->
      <div style="background:${range.color};padding:9px 12px">
        <div style="font-size:13px;font-weight:700;color:#fff">${range.label}</div>
        <div style="font-size:10px;color:rgba(255,255,255,.75)">${range.sub}</div>
      </div>

      <!-- Datos principales -->
      <div style="padding:10px 12px">
        <div style="margin-bottom:6px">
          <div style="font-size:10px;font-weight:600;color:var(--md);text-transform:uppercase;letter-spacing:.4px">Facturación</div>
          <div style="font-size:20px;font-weight:700;line-height:1.1">${fe(tot.gmv)}</div>
        </div>
        <div style="font-size:11px;color:var(--md);margin-bottom:8px">
          ${tot.days > 1 ? `~${fe(tot.gmv / tot.days)}/día · ` : ''}${tot.orders} ped.
          <span style="margin-left:4px;font-size:10px">🏠${tot.orders_propio} 🎯${tot.orders_paid_afil} 🤝${tot.orders_org_afil}</span>
        </div>

        <div style="border-top:1px solid var(--lt2);padding-top:7px">
          ${row('Costos publ.',    fe(tot.gmv_max_spend),   'text-red')}
          ${row('Com. afiliados', fe(tot.commission_cost),  'text-red')}
        </div>

        <div style="border-top:1px solid var(--lt2);padding-top:7px;margin-top:4px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-size:10px;font-weight:600;color:var(--md);text-transform:uppercase;letter-spacing:.4px">Beneficio neto</div>
              <div style="font-size:18px;font-weight:700;color:${tot.net_profit >= 0 ? mc : '#ef4444'}">${fe(tot.net_profit)}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:16px;font-weight:700;color:${mc}">${fp(tot.margin_pct)}</div>
              <div style="font-size:10px;color:var(--md)">margen</div>
            </div>
          </div>
        </div>

        <!-- Expandir detalles -->
        <div style="margin-top:8px;border-top:1px solid var(--lt2);padding-top:6px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:11px;color:${range.color};font-weight:600;cursor:pointer"
                  onclick="event.stopPropagation();toggleHistDetail('${key}')">Detalles ▾</span>
            ${data.days.length === 1 ? `
              <button onclick="event.stopPropagation();deleteTTSDay('${data.days[0].date}')"
                title="Eliminar ${fd(data.days[0].date)} del historial"
                style="font-size:10px;padding:2px 7px;border:1px solid rgba(239,68,68,.4);border-radius:4px;background:rgba(239,68,68,.08);cursor:pointer;color:#dc2626;font-weight:600">
                🗑 Borrar día
              </button>` : (data.days.length > 1 ? `
              <span style="font-size:10px;color:var(--md)">${data.days.length} días — ver tabla ↓</span>` : '')}
          </div>
          <div id="hist-detail-${key}" style="display:none;margin-top:6px">
            ${row('− IVA',             fe(tot.iva),              'text-red')}
            ${row('− COGS',            fe(tot.cogs),             'text-red')}
            ${row('− Envíos',          fe(tot.shipping),         'text-red')}
            ${row('− Com. plat. TTS',  fe(tot.tiktok_platform),  'text-red')}
            ${row('= Gross profit',    fe(tot.gross_profit),     tot.gross_profit >= 0 ? 'text-green' : 'text-red')}
            ${row('− Ads (GMV Max)',   fe(tot.gmv_max_spend),    'text-red')}
            ${row('− Afiliados',       fe(tot.commission_cost),  'text-red')}
            ${row('Margen s/COGS',     fp(tot.margin_pct_cogs),  '')}
          </div>
        </div>
      </div>
    </div>`;
}

function toggleHistDetail(key) {
  const el = document.getElementById('hist-detail-' + key);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  // Actualizar flecha
  const btn = el.previousElementSibling;
  if (btn) btn.textContent = open ? `Detalles ▾` : `Detalles ▴`;
}

function selectHistPeriod(key) {
  _ttsHistActive = key;
  const ranges = periodRanges();
  // Re-renderizar cards (actualizar bordes activos)
  const cards = Object.entries(ranges).map(([k, r]) =>
    renderPeriodCard(k, r, _ttsHistPeriods[k], k === key)
  ).join('');
  const cardsWrap = document.querySelector('#tts-history-content > div:first-child');
  if (cardsWrap) cardsWrap.innerHTML = cards;
  // Actualizar tabla
  const tableWrap = document.getElementById('tts-hist-table-wrap');
  if (tableWrap) tableWrap.innerHTML = renderHistTable(ranges[key], _ttsHistPeriods[key]);
}

// ── Tabla de grupos del período ───────────────────────────────────────────────

function renderHistTable(range, data) {
  if (!data || data.tot.days === 0) {
    return `<div class="empty-state" style="padding:30px 0">
      <div class="icon">📅</div>
      <div class="msg">Sin datos para ${range.label}</div>
      <div class="hint">Cargá un reporte TTS y guardalo desde "Reporte TTS"</div>
    </div>`;
  }

  const { tot, gruposAgg, days } = data;

  const mcBadge = (pct) => {
    const c = pct >= 20 ? '#16a34a' : pct >= 10 ? '#b45309' : '#dc2626';
    const bg = pct >= 20 ? 'rgba(34,197,94,.13)' : pct >= 10 ? 'rgba(245,158,11,.13)' : 'rgba(239,68,68,.13)';
    return `<span style="padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${bg};color:${c}">${fp(pct)}</span>`;
  };

  const roiBadge = (roi) => {
    const c = roi >= 60 ? '#16a34a' : roi >= 30 ? '#b45309' : '#dc2626';
    const bg = roi >= 60 ? 'rgba(34,197,94,.13)' : roi >= 30 ? 'rgba(245,158,11,.13)' : 'rgba(239,68,68,.13)';
    return `<span style="padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${bg};color:${c}">${fp(roi)}</span>`;
  };

  // ACOS: ≤15% = bueno (verde), ≤30% = aceptable (naranja), >30% = alto (rojo)
  const acosBadge = (acos) => {
    const c  = acos <= 15 ? '#16a34a' : acos <= 30 ? '#b45309' : '#dc2626';
    const bg = acos <= 15 ? 'rgba(34,197,94,.13)' : acos <= 30 ? 'rgba(245,158,11,.13)' : 'rgba(239,68,68,.13)';
    return `<span style="padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${bg};color:${c}">${fp(acos)}</span>`;
  };

  // Badge gris cuando el ACOS es un promedio global (sin mapeo por campaña)
  const acosGlobalBadge = (acos) =>
    `<span style="padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600;background:rgba(148,163,184,.15);color:#94a3b8" title="Promedio global — campañas no mapeadas a grupos">≈${fp(acos)}</span>`;

  // Detectar si el ACOS es uniforme entre todos los grupos (= gasto sin mapear, distribuido por revenue)
  const gruposConAcos = gruposAgg.filter(g => g.acos > 0);
  const acosUniform   = gruposConAcos.length > 1 &&
    gruposConAcos.every(g => Math.abs(g.acos - tot.acos) < 0.3);

  const renderAcos = (acos) => acos <= 0 ? '—'
    : acosUniform ? acosGlobalBadge(acos)
    : acosBadge(acos);

  return `
    <!-- ── Título + días guardados ── -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <div class="section-title" style="margin:0">${range.label} — P&L por SKU / Grupo
        <span style="font-size:11px;font-weight:400;color:var(--md);margin-left:8px">${days.length} día${days.length !== 1 ? 's' : ''} guardado${days.length !== 1 ? 's' : ''}</span>
      </div>
      <div style="font-size:12px;color:var(--md)">${range.sub}</div>
    </div>

    <!-- ── Resumen rápido del período ── -->
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:12px">
      ${miniKpi('Facturación', fe(tot.gmv), tot.days > 1 ? '~'+fe(tot.gmv/tot.days)+'/día' : '')}
      ${miniKpi('Pedidos', tot.orders, '🏠'+tot.orders_propio+' 🎯'+tot.orders_paid_afil+' 🤝'+tot.orders_org_afil)}
      ${miniKpi('Ticket Medio', fe(tot.aov), tot.days > 1 ? tot.orders+' pedidos' : '')}
      ${miniKpi('Ads', fe(tot.gmv_max_spend), tot.acos > 0 ? 'ACOS '+fp(tot.acos) : (tot.cpa > 0 ? 'CPA '+fe(tot.cpa) : ''))}
      ${miniKpi('Afiliados', fe(tot.commission_cost), '')}
      ${miniKpiProfit('Beneficio', fe(tot.net_profit), fp(tot.margin_pct), tot.net_profit >= 0)}
    </div>

    <!-- ── Aviso ACOS no mapeado ── -->
    ${acosUniform ? `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:10px;background:rgba(245,158,11,.08);border:1.5px solid rgba(245,158,11,.3);border-radius:7px;font-size:12px;color:var(--md)">
      <span style="font-size:15px">⚠️</span>
      <div>
        <strong style="color:var(--fg)">ACOS por grupo no disponible</strong> — las campañas GMV Max no están mapeadas a grupos SKU.
        El gasto se distribuyó proporcionalmente por revenue → todos muestran el mismo ACOS global (<strong>${fp(tot.acos)}</strong>).
        <span style="color:#2563eb;cursor:pointer" onclick="showPage('campaigns')">Ir a Campañas → SKU para mapearlas →</span>
      </div>
    </div>` : ''}

    <!-- ── Tabla SKU / Grupo ── -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>SKU / Grupo</th>
            <th style="text-align:right">Ped.</th>
            <th style="text-align:right" title="Propio / Paid+Afil / Org.Afil">🏠 🎯 🤝</th>
            <th style="text-align:right">Ticket</th>
            <th style="text-align:right">Facturación</th>
            <th style="text-align:right">COGS</th>
            <th style="text-align:right">Envíos</th>
            <th style="text-align:right" title="Gasto en GMV Max">Ads</th>
            <th style="text-align:right" title="${acosUniform ? 'ACOS global — sin mapeo por campaña' : 'Advertising Cost of Sales = Ads / Facturación'}">
              ACOS%${acosUniform ? ' ⚠️' : ''}
            </th>
            <th style="text-align:right">Afiliados</th>
            <th style="text-align:right">Beneficio</th>
            <th style="text-align:right">Margen%</th>
            <th style="text-align:right" title="Beneficio neto / COGS">ROI</th>
          </tr>
        </thead>
        <tbody>
          ${gruposAgg.map(g => `<tr>
            <td style="font-weight:600">${g.display_name || g.grupo}</td>
            <td style="text-align:right">${g.orders}</td>
            <td style="text-align:right;font-size:11px;color:var(--md)">
              ${g.orders_propio} / ${g.orders_paid_afil} / ${g.orders_org_afil}
            </td>
            <td style="text-align:right;font-size:11px;color:var(--md)">${fe(g.aov)}</td>
            <td style="text-align:right">${fe(g.revenue)}</td>
            <td style="text-align:right" class="text-red">${fe(g.cogs)}</td>
            <td style="text-align:right" class="text-red">${fe(g.shipping)}</td>
            <td style="text-align:right" class="text-red">${g.gmv_max_spend > 0 ? fe(g.gmv_max_spend) : '—'}</td>
            <td style="text-align:right">${renderAcos(g.acos)}</td>
            <td style="text-align:right" class="text-red">${g.commission_cost > 0 ? fe(g.commission_cost) : '—'}</td>
            <td style="text-align:right;font-weight:700" class="${g.net_profit >= 0 ? 'text-green' : 'text-red'}">${fe(g.net_profit)}</td>
            <td style="text-align:right">${mcBadge(g.margin_pct)}</td>
            <td style="text-align:right">${roiBadge(g.roi)}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td class="font-bold">TOTAL</td>
            <td style="text-align:right">${tot.orders}</td>
            <td style="text-align:right;font-size:11px;color:var(--md)">${tot.orders_propio} / ${tot.orders_paid_afil} / ${tot.orders_org_afil}</td>
            <td style="text-align:right;font-size:11px;color:var(--md)">${fe(tot.aov)}</td>
            <td style="text-align:right">${fe(tot.gmv)}</td>
            <td style="text-align:right" class="text-red">${fe(tot.cogs)}</td>
            <td style="text-align:right" class="text-red">${fe(tot.shipping)}</td>
            <td style="text-align:right" class="text-red">${fe(tot.gmv_max_spend)}</td>
            <td style="text-align:right">${acosBadge(tot.acos)}</td>
            <td style="text-align:right" class="text-red">${fe(tot.commission_cost)}</td>
            <td style="text-align:right;font-weight:700" class="${tot.net_profit >= 0 ? 'text-green' : 'text-red'}">${fe(tot.net_profit)}</td>
            <td style="text-align:right">${mcBadge(tot.margin_pct)}</td>
            <td style="text-align:right">${roiBadge(tot.margin_pct_cogs)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <!-- ── Días guardados (colapsable) ── -->
    <div style="margin-top:14px">
      <div style="font-size:11px;font-weight:600;color:var(--md);cursor:pointer;margin-bottom:6px"
           onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none'">
        📅 Ver / gestionar días guardados (${days.length}) ▾
      </div>
      <div style="display:none" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th style="text-align:right">Fact.</th>
              <th style="text-align:right">Ped.</th>
              <th style="text-align:right">Ticket</th>
              <th style="text-align:right">Ads</th>
              <th style="text-align:right">ACOS%</th>
              <th style="text-align:right">Afiliados</th>
              <th style="text-align:right">Beneficio</th>
              <th style="text-align:right">Margen%</th>
              <th style="text-align:center">Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${days.map(d => {
              const dayAcos = d.gmv > 0 && d.gmv_max_spend > 0 ? (d.gmv_max_spend / d.gmv) * 100 : 0;
              const dayAov  = d.orders > 0 ? d.gmv / d.orders : 0;
              return `<tr>
                <td style="font-weight:600">${fd(d.date)}</td>
                <td style="text-align:right">${fe(d.gmv)}</td>
                <td style="text-align:right">${d.orders}</td>
                <td style="text-align:right;font-size:11px;color:var(--md)">${fe(dayAov)}</td>
                <td style="text-align:right" class="text-red">${fe(d.gmv_max_spend)}</td>
                <td style="text-align:right">${dayAcos > 0 ? acosBadge(dayAcos) : '—'}</td>
                <td style="text-align:right" class="text-red">${fe(d.commission_cost)}</td>
                <td style="text-align:right;font-weight:700" class="${d.net_profit >= 0 ? 'text-green' : 'text-red'}">${fe(d.net_profit)}</td>
                <td style="text-align:right">${mcBadge(d.margin_pct)}</td>
                <td style="text-align:center;white-space:nowrap">
                  <button onclick="goToTTSDay('${d.date}')"
                    style="font-size:11px;padding:3px 8px;border:1px solid var(--lt2);border-radius:4px;background:transparent;cursor:pointer;color:var(--md)">
                    Ver →
                  </button>
                  <button onclick="deleteTTSDay('${d.date}')"
                    title="Eliminar ${fd(d.date)} del historial"
                    style="font-size:11px;padding:3px 8px;border:1px solid rgba(239,68,68,.35);border-radius:4px;background:rgba(239,68,68,.07);cursor:pointer;color:#dc2626;margin-left:4px">
                    🗑 Borrar
                  </button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function miniKpi(label, value, sub) {
  return `<div class="kpi-card" style="padding:10px 12px">
    <div class="kpi-label" style="font-size:10px">${label}</div>
    <div class="kpi-value" style="font-size:18px">${value}</div>
    ${sub ? `<div class="kpi-sub" style="font-size:10px">${sub}</div>` : ''}
  </div>`;
}

function miniKpiProfit(label, value, pct, positive) {
  const color = positive ? (parseFloat(pct) >= 20 ? 'green' : 'orange') : 'red';
  return `<div class="kpi-card ${color}" style="padding:10px 12px">
    <div class="kpi-label" style="font-size:10px">${label}</div>
    <div class="kpi-value" style="font-size:18px">${value}</div>
    <div class="kpi-sub" style="font-size:10px">Margen: ${pct}</div>
  </div>`;
}

function goToTTSDay(date) {
  document.getElementById('tts-date').value = date;
  showPage('tts');
}

// ── Eliminar un día del historial ─────────────────────────────────────────────

async function deleteTTSDay(date) {
  const label = fd(date);
  if (!confirm(`¿Eliminar el historial del ${label}?\n\nEsta acción borra todos los datos guardados de ese día (P&L y grupos) y no se puede deshacer.`)) return;

  try {
    const res = await fetch(`/api/tts/history/${date}`, { method: 'DELETE' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Error desconocido');

    // Recargar todo el historial para reflejar el cambio
    await loadTTSHistoryAll();
  } catch (err) {
    alert('❌ Error al eliminar: ' + err.message);
  }
}

// Compatibilidad con el nav (loadTTSHistory se llama desde index.html al abrir la página)
function loadTTSHistory() {
  loadTTSHistoryAll();
}

// Mantener compatibilidad con setTTSPeriod (por si se llama desde algún botón)
function setTTSPeriod(period) {
  _ttsHistActive = period;
  loadTTSHistoryAll();
}
