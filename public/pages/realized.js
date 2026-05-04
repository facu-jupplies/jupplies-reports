// ─── Resultado Real ──────────────────────────────────────────────────────────
// Dashboard que consulta Simla en vivo y muestra los % de confirmación y
// entrega REALES (basados en el estado actual de cada pedido), por contraste
// con el reporte diario que es especulativo.

let _realizedData = null;
let _realizedSort = { col: 'total', asc: false };

function _firstOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function loadRealized() {
  const el = document.getElementById('realized-content');
  if (!el) return;

  const fromEl = document.getElementById('realized-from');
  const toEl   = document.getElementById('realized-to');
  if (fromEl && !fromEl.value) fromEl.value = _firstOfMonth();
  if (toEl   && !toEl.value)   toEl.value   = today();

  // Si todavía no se buscó, mostrar empty state
  if (!_realizedData) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="icon">📈</div>
        <div class="msg">Seleccioná un rango y hacé click en "Cargar"</div>
        <div class="hint">Consulta Simla en vivo · puede tardar 5-15 segundos según el rango</div>
      </div>`;
  }
}

async function fetchRealized() {
  const from = document.getElementById('realized-from').value;
  const to   = document.getElementById('realized-to').value;
  if (!from || !to) return alert('Seleccioná las fechas');
  if (from > to) return alert('La fecha "desde" no puede ser posterior a "hasta"');

  const el = document.getElementById('realized-content');
  el.innerHTML = `
    <div class="loading" style="padding:40px;text-align:center">
      <div style="font-size:36px;margin-bottom:12px">⏳</div>
      <div style="font-weight:600;margin-bottom:4px">Consultando Simla…</div>
      <div style="font-size:12px;color:var(--md)">
        Trayendo pedidos del ${from} al ${to} y clasificando por estado real
      </div>
    </div>`;

  try {
    const data = await API.getRealizedReport(from, to);
    _realizedData = data;
    _renderRealized();
  } catch (err) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">⚠️</div>
      <div class="msg">Error al cargar</div>
      <div class="hint">${err.message}</div>
    </div>`;
  }
}

function _renderRealized() {
  const el = document.getElementById('realized-content');
  if (!_realizedData) return;
  const { summary, byGrupo, from, to } = _realizedData;

  const fmtPct = (n) => (n || 0).toFixed(1) + '%';
  const dPct   = (real, conf) => {
    const diff = (real || 0) - (conf || 0);
    const sign = diff >= 0 ? '+' : '';
    const color = Math.abs(diff) < 1 ? 'var(--md)' : (diff >= 0 ? '#16a34a' : '#c0392b');
    return `<span style="color:${color};font-size:11px;font-weight:600">${sign}${diff.toFixed(1)}pp vs config</span>`;
  };
  // Delta en € (real − estimado): positivo verde, negativo rojo
  const dPctRaw = (diff, asEur = false) => {
    const sign = diff >= 0 ? '+' : '';
    const color = Math.abs(diff) < (asEur ? 5 : 1) ? 'var(--md)' : (diff >= 0 ? '#16a34a' : '#c0392b');
    const label = asEur ? fe(diff) : `${diff.toFixed(1)}pp`;
    return `<span style="color:${color};font-weight:600">${sign}${label}</span>`;
  };
  // Delta inline para tabla (compacto, sin "vs config")
  const dPctInline = (diff) => {
    if (Math.abs(diff || 0) < 0.5) return '';
    const sign = diff > 0 ? '+' : '';
    const color = diff > 0 ? '#16a34a' : '#c0392b';
    return `<span style="color:${color};font-size:10px;font-weight:600;margin-left:3px">${sign}${diff.toFixed(1)}</span>`;
  };

  const kpiCard = (title, value, sub, bg = '#fff', accent = 'var(--fg)') => `
    <div style="background:${bg};border-radius:12px;padding:16px 18px;box-shadow:0 1px 4px rgba(0,0,0,.06);flex:1;min-width:180px">
      <div style="font-size:10px;font-weight:700;color:var(--md);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${title}</div>
      <div style="font-size:26px;font-weight:800;color:${accent};line-height:1.1">${value}</div>
      <div style="font-size:11px;color:var(--md);margin-top:4px">${sub || ''}</div>
    </div>`;

  const funnelCard = (label, count, revenue, pct, color) => `
    <div style="background:#fff;border-left:4px solid ${color};border-radius:8px;padding:12px 14px;flex:1;min-width:140px;box-shadow:0 1px 3px rgba(0,0,0,.04)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:11px;font-weight:700;color:var(--md);text-transform:uppercase">${label}</span>
        <span style="font-size:11px;font-weight:600;color:${color}">${fmtPct(pct)}</span>
      </div>
      <div style="font-size:20px;font-weight:800;color:var(--fg)">${count}</div>
      <div style="font-size:11px;color:var(--md);margin-top:2px">${fe(revenue)}</div>
    </div>`;

  el.innerHTML = `
    <!-- KPIs principales -->
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      ${kpiCard('Pedidos totales', summary.total, `${from} → ${to}`)}
      ${kpiCard('% Confirmación REAL', fmtPct(summary.pct_confirmed), dPct(summary.pct_confirmed, summary.pct_confirmed_configured), '#fff', '#1a7a42')}
      ${kpiCard('% Cobro neto / conf', fmtPct(summary.cobro_neto_real), dPct(summary.cobro_neto_real, summary.pct_delivered_configured), '#fff', '#1a7a42')}
      ${kpiCard('Efectividad neta', fmtPct(summary.pct_paid), dPct(summary.pct_paid, summary.efectividad_configurada), '#fff5ed', '#ff6f4c')}
      ${kpiCard('€ Cobrado neto', fe(summary.revenue_paid), `vs estimado ${fe(summary.estimated.revenue_paid)} · ${dPctRaw(summary.delta.revenue_paid, true)}`, '#fff', '#1a7a42')}
    </div>

    <!-- Funnel breakdown -->
    <div style="margin-bottom:6px;font-size:13px;font-weight:700;color:var(--fg)">Funnel por estado</div>
    <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap">
      ${funnelCard('Cobrados',       summary.buckets.delivered_paid.count, summary.buckets.delivered_paid.revenue, summary.pct_paid,          '#16a34a')}
      ${funnelCard('Reembolsados',   summary.buckets.refunded.count,       summary.buckets.refunded.revenue,       summary.pct_refunded,      '#f59e0b')}
      ${funnelCard('En tránsito',    summary.buckets.transit.count,        summary.buckets.transit.revenue,        summary.pct_transit,       '#3b82f6')}
      ${funnelCard('Rehusados',      summary.buckets.rehusado.count,       summary.buckets.rehusado.revenue,       summary.pct_rehusado,      '#c0392b')}
      ${funnelCard('Devuelta pend.', summary.buckets.devuelta_pend.count,  summary.buckets.devuelta_pend.revenue,  summary.pct_devuelta_pend, '#ea580c')}
      ${funnelCard('Cancelados',     summary.buckets.cancel.count,         summary.buckets.cancel.revenue,         summary.pct_cancel,        '#94a3b8')}
      ${funnelCard('Pendientes',     summary.buckets.pending.count,        summary.buckets.pending.revenue,        summary.pct_pending,       '#a855f7')}
    </div>

    <!-- Costos directos de venta -->
    <div style="margin-bottom:6px;font-size:13px;font-weight:700;color:var(--fg)">Costos directos</div>
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      ${kpiCard(
        'Costo productos',
        fe(summary.cogs_paid),
        `${summary.revenue_paid > 0 ? (100 * summary.cogs_paid / summary.revenue_paid).toFixed(1) : 0}% sobre cobrado · ${summary.buckets.delivered_paid.count} entregados`,
        '#f8fafc', '#1a1a2e')}
      ${kpiCard(
        'Costo envíos',
        fe(summary.shipping_paid + summary.shipping_lost),
        `Ida ${fe(summary.shipping_paid)} · Pérdida ${fe(summary.shipping_lost)} (rehus/devol/reemb)`,
        '#f8fafc', '#1a1a2e')}
      ${kpiCard('IVA 21%', fe(summary.iva_owed), 'a pagar a Hacienda · sale del cobrado', '#f8fafc', '#475569')}
      ${kpiCard(
        'Gasto ADS',
        fe(summary.ads_total),
        `Meta ${fe(summary.ads_meta)} · TikTok ${fe(summary.ads_tiktok)}` + (summary.ads_unmapped > 0 ? ` · ${fe(summary.ads_unmapped)} multi-grupo (spread)` : ''),
        '#fef2f2', '#c0392b')}
    </div>

    <!-- Pérdidas / pendientes -->
    <div style="margin-bottom:6px;font-size:13px;font-weight:700;color:var(--fg)">Pérdidas y pendientes</div>
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      ${kpiCard('€ Reembolsado', fe(summary.revenue_refunded), `${summary.buckets.refunded.count} pedidos · entró y volvió`, '#fffbeb', '#b45309')}
      ${kpiCard('COGS reembolsado', fe(summary.cogs_lost), `${summary.buckets.refunded.count} pedidos · producto consumido`, '#fef2f2', '#c0392b')}
      ${kpiCard('Envío perdido', fe(summary.shipping_lost), `${summary.buckets.rehusado.count} rehus + ${summary.buckets.devuelta_pend.count} devol + ${summary.buckets.refunded.count} reemb · ida+vuelta`, '#fef2f2', '#c0392b')}
      ${kpiCard('€ En tránsito', fe(summary.revenue_transit), 'aún no cobrado', '#eff6ff', '#3b82f6')}
    </div>

    <!-- Resultado final -->
    <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;align-items:stretch">
      ${kpiCard('ROAS', summary.roas != null ? `${summary.roas}x` : '—', 'cobrado bruto / ads', '#fff', summary.roas != null && summary.roas >= 2 ? '#1a7a42' : '#c0392b')}
      ${kpiCard('Resultado NETO',
        fe(summary.net_result),
        `vs estimado ${fe(summary.estimated.net_result)} · ${dPctRaw(summary.delta.net_result, true)}`,
        summary.net_result >= 0 ? '#f0fdf4' : '#fef2f2',
        summary.net_result >= 0 ? '#1a7a42' : '#c0392b')}
    </div>

    <!-- Tabla por grupo -->
    <div class="card" style="padding:0;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--border,#e2e8f0)">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--fg)">Resultado real por grupo de producto</div>
          <div style="font-size:11px;color:var(--md)">${byGrupo.length} grupos · click en columna para ordenar</div>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:var(--lt2,#f8fafc);border-bottom:2px solid var(--border,#e2e8f0)">
              <th style="padding:10px 12px;text-align:left;cursor:pointer" onclick="_realizedSortBy('grupo')">Grupo</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('total')">Pedidos</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('pct_confirmed')">% Conf real</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('cobro_neto')">% Cobro / conf</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('pct_paid')">% Cobr / total</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('pct_refunded')">% Reemb.</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('pct_rehusado')">% Rehus.</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('pct_cancel')">% Cancel</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('revenue_paid')">€ Cobrado neto</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('cogs_paid')">€ COGS</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('shipping_lost')">€ Envío</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('ads')">€ ADS</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('roas')">ROAS</th>
              <th style="padding:10px 12px;text-align:right;cursor:pointer" onclick="_realizedSortBy('net_result')">€ Resultado</th>
            </tr>
          </thead>
          <tbody id="realized-tbody"></tbody>
        </table>
      </div>
    </div>
  `;

  _renderRealizedRows();
}

function _realizedSortBy(col) {
  if (_realizedSort.col === col) _realizedSort.asc = !_realizedSort.asc;
  else { _realizedSort.col = col; _realizedSort.asc = false; }
  _renderRealizedRows();
}

function _renderRealizedRows() {
  const tbody = document.getElementById('realized-tbody');
  if (!tbody || !_realizedData) return;

  const fmtPct = (n) => (n || 0).toFixed(1) + '%';
  const colorPct = (pct, hi = 80, mid = 60) => {
    if (pct >= hi)  return '#1a7a42';
    if (pct >= mid) return '#b87800';
    return '#c0392b';
  };

  const rows = [..._realizedData.byGrupo].sort((a, b) => {
    const av = a[_realizedSort.col], bv = b[_realizedSort.col];
    if (typeof av === 'string') {
      return _realizedSort.asc ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return _realizedSort.asc ? (av - bv) : (bv - av);
  });

  // helper: render delta inline in pp (oculto si <0.5)
  const dInline = (diff) => {
    if (Math.abs(diff || 0) < 0.5) return '';
    const sign = diff > 0 ? '+' : '';
    const color = diff > 0 ? '#16a34a' : '#c0392b';
    return `<span style="color:${color};font-size:10px;font-weight:600;margin-left:3px">${sign}${diff.toFixed(1)}</span>`;
  };
  tbody.innerHTML = rows.map(r => `
    <tr style="border-bottom:1px solid var(--border,#f1f5f9)">
      <td style="padding:8px 12px;font-weight:600;color:var(--fg)">${r.grupo}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:600">${r.total}</td>
      <td style="padding:8px 12px;text-align:right;color:${colorPct(r.pct_confirmed, 85, 70)};font-weight:600">${fmtPct(r.pct_confirmed)}${dInline(r.d_confirmed)}</td>
      <td style="padding:8px 12px;text-align:right;color:${colorPct(r.cobro_neto, 80, 65)};font-weight:600">${fmtPct(r.cobro_neto)}${dInline(r.d_cobro)}</td>
      <td style="padding:8px 12px;text-align:right;color:${colorPct(r.pct_paid, 70, 55)};font-weight:600">${fmtPct(r.pct_paid)}${dInline(r.d_paid)}</td>
      <td style="padding:8px 12px;text-align:right;color:${r.pct_refunded > 5 ? '#b45309' : 'var(--md)'}">${fmtPct(r.pct_refunded)}</td>
      <td style="padding:8px 12px;text-align:right;color:${r.pct_rehusado > 8 ? '#c0392b' : 'var(--md)'}">${fmtPct(r.pct_rehusado)}</td>
      <td style="padding:8px 12px;text-align:right;color:${r.pct_cancel > 15 ? '#c0392b' : 'var(--md)'}">${fmtPct(r.pct_cancel)}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;color:#1a7a42">${fe(r.revenue_paid)}</td>
      <td style="padding:8px 12px;text-align:right;color:var(--md)" title="COGS de los entregados pagados${r.cogs_refunded > 0 ? ` · COGS reemb perdidos: ${fe(r.cogs_refunded)}` : ''}">${fe(r.cogs_paid)}</td>
      <td style="padding:8px 12px;text-align:right;color:${r.shipping_lost > 0 ? '#c0392b' : 'var(--md)'}" title="Ida ${fe(r.shipping_paid)} · Perdido ${fe(r.shipping_lost)}">${fe((r.shipping_paid || 0) + (r.shipping_lost || 0))}${r.shipping_lost > 0 ? `<span style="color:#c0392b;font-size:10px;margin-left:3px">−${fe(r.shipping_lost)}</span>` : ''}</td>
      <td style="padding:8px 12px;text-align:right;color:${r.ads > 0 ? '#c0392b' : 'var(--md)'}" title="Directo ${fe(r.ads_direct)} · Spread (multi-grupo) ${fe(r.ads_spread)}">${r.ads > 0 ? fe(r.ads) : '—'}${r.ads_spread > 0 ? `<span style="color:var(--md);font-size:10px;margin-left:4px">·s</span>` : ''}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;color:${r.roas == null ? 'var(--md)' : r.roas >= 2 ? '#1a7a42' : '#c0392b'}">${r.roas == null ? '—' : r.roas + 'x'}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;color:${r.net_result >= 0 ? '#1a7a42' : '#c0392b'}">${fe(r.net_result)}</td>
    </tr>
  `).join('');
}
