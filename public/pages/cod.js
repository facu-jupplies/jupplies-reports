// ─── Seguimiento COD ──────────────────────────────────

const COD_STATUS_COLORS = {
  pending:   '#f59e0b',
  confirmed: '#3b82f6',
  delivered: '#8b5cf6',
  paid:      '#22c55e',
  refused:   '#ef4444',
  returned:  '#94a3b8',
};

const COD_STATUS_LABELS = {
  pending:   'Pendiente',
  confirmed: 'Confirmado',
  delivered: 'Entregado',
  paid:      'Cobrado',
  refused:   'Rechazado',
  returned:  'Devuelto',
};

// ── Cargar dashboard completo ──────────────────────────────────────────────────

async function loadCodDashboard() {
  const from   = document.getElementById('cod-from').value;
  const to     = document.getElementById('cod-to').value;
  const dashEl = document.getElementById('cod-dashboard');

  dashEl.innerHTML = '<div class="loading">⏳ Cargando...</div>';

  try {
    const data = await API.getCodDashboard({ from, to });
    renderCodDashboard(data, from, to);
    loadCodTable();
  } catch (err) {
    dashEl.innerHTML = `<div class="empty-state">
      <div class="icon">⚠️</div>
      <div class="msg">${err.message}</div>
    </div>`;
  }
}

// ── Renderizar dashboard ───────────────────────────────────────────────────────

function renderCodDashboard(data, from, to) {
  const dashEl = document.getElementById('cod-dashboard');
  const { cod, skuRows, paymentMethods, adByPlatform, totalAdSpend } = data;
  const { totalOrders, totalAmount, counts, amounts,
          inTransit, inTransitAmt, lost, lostAmt, convRate, avgDays } = cod;

  const periodLabel = from && to ? `${fd(from)} — ${fd(to)}`
                    : from       ? `Desde ${fd(from)}`
                    : to         ? `Hasta ${fd(to)}`
                    : 'Todo el período';

  // ── Helpers ────────────────────────────────────────────────────────────────
  const pctOf = (v) => totalAmount > 0 ? fp(v / totalAmount * 100, 1) : '0.0%';

  const statusRow = (label, amount, color) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--lt2)">
       <span style="font-size:12px;color:var(--md)">${label}</span>
       <span style="font-size:13px;font-weight:600;color:${color}">${fe(amount)}
         <span style="font-size:10px;font-weight:400;color:var(--md);margin-left:5px">${pctOf(amount)}</span>
       </span>
     </div>`;

  // ── Donut 1: distribución de estados ──────────────────────────────────────
  const statusSlices = ['pending','confirmed','delivered','paid','refused','returned']
    .filter(s => counts[s] > 0)
    .map(s => ({ label: COD_STATUS_LABELS[s], value: counts[s], color: COD_STATUS_COLORS[s] }));

  const statusDonut = buildSvgDonut(statusSlices, {
    cx: 72, cy: 72, r: 62, innerR: 38, size: 144,
    centerLabel: String(totalOrders), centerSub: 'pedidos',
  });

  const statusLegend = ['pending','confirmed','delivered','paid','refused','returned']
    .filter(s => counts[s] > 0)
    .map(s => {
      const pct = totalOrders > 0 ? Math.round(counts[s] / totalOrders * 100) : 0;
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--lt2)">
        <span style="width:10px;height:10px;border-radius:2px;background:${COD_STATUS_COLORS[s]};flex-shrink:0"></span>
        <span style="flex:1;font-size:11px">${COD_STATUS_LABELS[s]}</span>
        <strong style="font-size:13px">${counts[s]}</strong>
        <span style="font-size:10px;color:var(--md);min-width:32px;text-align:right">${pct}%</span>
      </div>`;
    }).join('');

  // ── Stacked bar: destino del importe COD ──────────────────────────────────
  const stackParts = [
    { label: 'Pendiente',  value: amounts.pending,  color: '#f59e0b' },
    { label: 'Confirmado', value: amounts.confirmed, color: '#3b82f6' },
    { label: 'Entregado',  value: amounts.delivered, color: '#8b5cf6' },
    { label: 'Cobrado',    value: amounts.paid,      color: '#22c55e' },
    { label: 'Rechazado',  value: amounts.refused,   color: '#ef4444' },
    { label: 'Devuelto',   value: amounts.returned,  color: '#94a3b8' },
  ].filter(p => p.value > 0);

  const stackBar = (() => {
    if (stackParts.length === 0) return '';
    const total    = totalAmount || 1;
    const segments = stackParts.map(p => {
      const pct    = (p.value / total * 100);
      const pctStr = pct.toFixed(1);
      const show   = pct >= 7;
      return `<div style="position:relative;width:${pctStr}%;background:${p.color};height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden" title="${p.label}: €${p.value.toFixed(2)} (${pctStr}%)">
        ${show ? `<span style="font-size:9px;font-weight:700;color:#fff;white-space:nowrap">${pctStr}%</span>` : ''}
      </div>`;
    }).join('');
    const legend = stackParts.map(p => {
      const pct = (p.value / total * 100).toFixed(1);
      return `<div style="display:flex;align-items:center;gap:6px">
        <span style="width:10px;height:10px;border-radius:2px;background:${p.color};flex-shrink:0"></span>
        <span style="font-size:11px;color:var(--md)">${p.label}</span>
        <strong style="font-size:11px;margin-left:auto;padding-left:8px">${pct}%</strong>
      </div>`;
    }).join('');
    return `
      <div style="height:28px;border-radius:8px;overflow:hidden;display:flex;box-shadow:inset 0 0 0 1px rgba(0,0,0,.07)">
        ${segments}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 14px;margin-top:8px">
        ${legend}
      </div>`;
  })();

  // ── Donut 2: métodos de pago ───────────────────────────────────────────────
  const pm      = paymentMethods;
  const pmTotal = (pm.cod?.count || 0) + (pm.card?.count || 0);
  const pmDonut = pmTotal > 0 ? buildSvgDonut(
    [
      { label: 'COD',  value: pm.cod?.count  || 0, color: '#f59e0b' },
      { label: 'PAID', value: pm.card?.count || 0, color: '#3b82f6' },
    ].filter(s => s.value > 0),
    { cx: 52, cy: 52, r: 44, innerR: 26, size: 104,
      centerLabel: String(pmTotal), centerSub: 'pedidos' }
  ) : `<div style="color:var(--md);font-size:12px;padding:8px 0">Sin datos</div>`;

  const pmLegend = pmTotal > 0 ? [
    pm.cod?.count  > 0 ? `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--lt2)">
      <span style="width:12px;height:12px;border-radius:3px;background:#f59e0b;flex-shrink:0"></span>
      <span style="flex:1;font-size:12px">💵 COD</span>
      <strong>${pm.cod.count}</strong>
      <span style="font-size:11px;color:var(--md);margin-left:6px">${fe(pm.cod.amount)}</span>
    </div>` : '',
    pm.card?.count > 0 ? `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--lt2)">
      <span style="width:12px;height:12px;border-radius:3px;background:#3b82f6;flex-shrink:0"></span>
      <span style="flex:1;font-size:12px">💳 PAID</span>
      <strong>${pm.card.count}</strong>
      <span style="font-size:11px;color:var(--md);margin-left:6px">${fe(pm.card.amount)}</span>
    </div>` : '',
  ].join('') : '';

  // ── Ad spend por plataforma ────────────────────────────────────────────────
  const PLAT_COLOR = { meta: '#1877f2', tiktok: '#ff0050', tiktokads: '#ff0050', tiktok_ads: '#ff0050' };
  const PLAT_EMOJI = { meta: '📘', tiktok: '🎵', tiktokads: '🎵', tiktok_ads: '🎵' };

  const adSection = (() => {
    const platforms = Object.entries(adByPlatform);
    if (platforms.length === 0)
      return `<div style="font-size:11px;color:var(--md);padding:6px 0">Sin datos de ADS para el período</div>`;
    return platforms.map(([plat, d]) => {
      const key  = plat.toLowerCase();
      const color = PLAT_COLOR[key] || '#64748b';
      const emoji = PLAT_EMOJI[key] || '📊';
      const roas  = d.spend > 0 && d.purchaseValue > 0 ? (d.purchaseValue / d.spend).toFixed(2) : '—';
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--lt2)">
        <span style="font-size:15px">${emoji}</span>
        <div style="flex:1">
          <div style="font-size:12px;font-weight:700;color:${color}">${plat}</div>
          <div style="font-size:10px;color:var(--md)">${d.conversions} conv. · ROAS ${roas}</div>
        </div>
        <strong style="font-size:13px;color:#ef4444">${fe(d.spend)}</strong>
      </div>`;
    }).join('');
  })();

  // ── SKU horizontal bars ────────────────────────────────────────────────────
  const SKU_COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16'];

  const skuBars = (() => {
    if (!skuRows || skuRows.length === 0)
      return `<div style="color:var(--md);font-size:12px;padding:8px 0">Sin datos de SKU</div>`;
    const total = totalAmount || 1;
    return skuRows.map((g, i) => {
      const pct    = (g.amount / total * 100);
      const pctStr = pct.toFixed(1);
      const color  = SKU_COLORS[i % SKU_COLORS.length];
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="width:82px;font-size:11px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0" title="${g.grupo}">${g.grupo}</div>
        <div style="flex:1;background:rgba(0,0,0,.06);border-radius:4px;height:14px;overflow:hidden">
          <div style="width:${pctStr}%;background:${color};height:100%;border-radius:4px"></div>
        </div>
        <div style="font-size:12px;font-weight:700;color:${color};min-width:38px;text-align:right">${pctStr}%</div>
        <div style="font-size:11px;color:var(--md);min-width:58px;text-align:right">${fe(g.amount)}</div>
      </div>`;
    }).join('');
  })();

  // ── Barra de progreso de cobro ─────────────────────────────────────────────
  const convBarPct   = Math.min(100, Math.round(convRate));
  const convBarColor = convRate >= 70 ? '#22c55e' : convRate >= 50 ? '#f59e0b' : '#ef4444';
  const convCard     = convRate >= 70 ? 'green'  : convRate >= 50 ? 'orange' : 'red';

  // ── Render ─────────────────────────────────────────────────────────────────
  dashEl.innerHTML = `
  <div id="cod-export-area">

    <!-- ── Cabecera ── -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:10px 14px;background:var(--lt2);border-radius:8px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">🚚</span>
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--md)">Seguimiento COD</div>
          <div style="font-size:20px;font-weight:800;line-height:1.15">${periodLabel}</div>
        </div>
      </div>
      <div style="text-align:right;font-size:11px;color:var(--md)">
        <div>Jupplies Reports</div>
        <div style="font-size:10px">${new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })}</div>
      </div>
    </div>

    <!-- ── Fila 1: KPI cards ── -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">

      <!-- Facturación COD bruta -->
      <div class="kpi-card" style="padding:16px 18px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
          <div>
            <div class="kpi-label">Facturación COD bruta</div>
            <div class="kpi-value" style="font-size:30px;line-height:1.1">${fe(totalAmount)}</div>
          </div>
          <div style="text-align:right;background:rgba(0,0,0,.08);border-radius:8px;padding:8px 14px">
            <div style="font-size:9px;font-weight:700;color:var(--md);text-transform:uppercase;letter-spacing:.5px">Pedidos</div>
            <div style="font-size:28px;font-weight:700;line-height:1.1">${totalOrders}</div>
            <div style="font-size:10px;color:var(--md)">${avgDays > 0 ? `~${avgDays.toFixed(1)}d resol.` : 'sin resoluciones'}</div>
          </div>
        </div>
        <div style="border-top:1px solid var(--lt2);padding-top:8px">
          ${statusRow('⏳ En tránsito (pend. + conf. + entregado)', inTransitAmt, 'var(--fg)')}
          ${statusRow('✅ Cobrado', amounts.paid, '#16a34a')}
          ${statusRow('❌ Rechazado', amounts.refused, '#dc2626')}
          ${statusRow('↩️ Devuelto', amounts.returned, '#64748b')}
        </div>
      </div>

      <!-- Tasa de cobro -->
      <div class="kpi-card ${convCard}" style="padding:16px 18px;display:flex;flex-direction:column;gap:12px">
        <div>
          <div class="kpi-label">Tasa de cobro</div>
          <div class="kpi-value" style="font-size:30px;line-height:1.1;margin-bottom:10px">${fp(convRate)}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div style="background:rgba(0,0,0,.12);border-radius:8px;padding:9px;text-align:center">
              <div style="font-size:9px;font-weight:700;opacity:.7;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Cobrados</div>
              <div style="font-size:22px;font-weight:700;line-height:1.2">${counts.paid}</div>
              <div style="font-size:10px;opacity:.7">${fe(amounts.paid)}</div>
            </div>
            <div style="background:rgba(0,0,0,.12);border-radius:8px;padding:9px;text-align:center">
              <div style="font-size:9px;font-weight:700;opacity:.7;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Perdidos</div>
              <div style="font-size:22px;font-weight:700;line-height:1.2">${lost}</div>
              <div style="font-size:10px;opacity:.7">${fe(lostAmt)}</div>
            </div>
          </div>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,.15);padding-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <span style="font-size:11px;font-weight:600;opacity:.8">Progreso hacia cobro completo</span>
            <span style="font-size:13px;font-weight:700;opacity:.9">${counts.paid} / ${totalOrders}</span>
          </div>
          <div style="background:rgba(0,0,0,.2);border-radius:4px;height:8px;margin-bottom:6px;overflow:hidden">
            <div style="height:100%;border-radius:4px;width:${convBarPct}%;background:${convBarColor};transition:width .4s"></div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:11px;opacity:.7">En tránsito: ${inTransit} (${fe(inTransitAmt)})</span>
            <span style="font-size:11px;font-weight:700;opacity:.8">${avgDays > 0 ? `Avg ${avgDays.toFixed(1)} días` : '—'}</span>
          </div>
        </div>
        <div style="background:rgba(0,0,0,.1);border-radius:7px;padding:8px 10px;font-size:11px;opacity:.8;display:flex;justify-content:space-between">
          <span>Importe cobrado (neto recibido)</span>
          <strong>${fe(amounts.paid)}</strong>
        </div>
      </div>
    </div>

    <!-- ── Fila 2: 3 gráficas ── -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">

      <!-- Columna 1: Donut estados + barra apilada -->
      <div class="card">
        <div class="card-title">Distribución por estado</div>
        <div style="display:flex;gap:14px;align-items:center">
          <div style="flex-shrink:0">${statusDonut}</div>
          <div style="flex:1">${statusLegend}</div>
        </div>
        <div style="border-top:1px solid var(--lt2);margin:12px 0 8px"></div>
        <div style="font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--md);margin-bottom:8px">Distribución del importe</div>
        ${stackBar}
      </div>

      <!-- Columna 2: Métodos de pago + Fuentes de tráfico -->
      <div class="card">
        <div class="card-title">Métodos de pago</div>
        <div style="font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--md);margin-bottom:10px">Todos los pedidos del período</div>
        <div style="display:flex;gap:14px;align-items:center;margin-bottom:14px">
          <div style="flex-shrink:0">${pmDonut}</div>
          <div style="flex:1">${pmLegend}</div>
        </div>

        <div style="border-top:1px solid var(--lt2);padding-top:12px">
          <div style="font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--md);margin-bottom:8px">Gasto ADS del período</div>
          ${adSection}
          ${totalAdSpend > 0 ? `
          <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:12px;padding-top:6px;border-top:1px solid var(--lt2)">
            <span style="color:var(--md)">Total ADS</span>
            <strong class="text-red">${fe(totalAdSpend)}</strong>
          </div>` : ''}
        </div>
      </div>

      <!-- Columna 3: Importe por SKU / Grupo -->
      <div class="card">
        <div class="card-title">Importe COD por SKU / Grupo</div>
        <div style="font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--md);margin-bottom:12px">% sobre importe total COD del período</div>
        ${skuBars}
      </div>

    </div>

  </div><!-- #cod-export-area -->

  <div style="display:flex;justify-content:flex-end;margin-bottom:6px">
    <button class="btn btn-secondary btn-sm" onclick="exportCodJpg('${periodLabel.replace(/'/g, "\\'")}')">📷 Exportar JPG</button>
  </div>
  `;
}

// ── Export JPG ─────────────────────────────────────────────────────────────────

async function exportCodJpg(label) {
  const area = document.getElementById('cod-export-area');
  if (!area) return;

  const btn = document.querySelector('button[onclick^="exportCodJpg"]');
  const orig = btn ? btn.textContent : '';
  if (btn) btn.textContent = '⏳ Generando...';

  try {
    const canvas = await html2canvas(area, {
      backgroundColor: '#eeeef0',
      scale: 2,
      useCORS: true,
      logging: false,
    });
    const link = document.createElement('a');
    const safeName = label.replace(/[\/\\:*?"<>|]/g, '-');
    link.download = `COD_${safeName}.jpg`;
    link.href = canvas.toDataURL('image/jpeg', 0.92);
    link.click();
  } catch (err) {
    alert('Error al exportar: ' + err.message);
  } finally {
    if (btn) btn.textContent = orig;
  }
}

// ── Tabla filtrada de pedidos COD ──────────────────────────────────────────────

async function loadCodTable() {
  const from   = document.getElementById('cod-from').value;
  const to     = document.getElementById('cod-to').value;
  const status = document.getElementById('cod-status-filter').value;
  const el     = document.getElementById('cod-content');

  el.innerHTML = '<div class="loading">Cargando...</div>';

  try {
    const params = {};
    if (status) params.status = status;
    if (from)   params.from   = from;
    if (to)     params.to     = to;

    const rows = await API.getCod(params);

    if (rows.length === 0) {
      el.innerHTML = `<div class="empty-state">
        <div class="icon">🚚</div>
        <div class="msg">Sin pedidos COD${status ? ` con estado "${statusLabel(status)}"` : ''} en el período</div>
      </div>`;
      return;
    }

    el.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Pedido</th>
              <th>Fecha</th>
              <th>Importe</th>
              <th>Estado</th>
              <th>Días pend.</th>
              <th>SKU</th>
              <th>ID Simla</th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const daysPending = Math.floor((Date.now() - new Date(r.order_date).getTime()) / 86400000);
              const isResolved  = ['paid','refused','returned'].includes(r.status);
              return `
                <tr>
                  <td class="font-bold">${r.order_name}</td>
                  <td>${fd(r.order_date)}</td>
                  <td>${fe(r.order_total)}</td>
                  <td>
                    <span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:${COD_STATUS_COLORS[r.status]}22;color:${COD_STATUS_COLORS[r.status]}">
                      ${statusLabel(r.status)}
                    </span>
                  </td>
                  <td class="${!isResolved && daysPending > 14 ? 'text-red' : ''}">${daysPending}d</td>
                  <td style="font-size:11px;color:var(--md)">${r.line_sku || '—'}</td>
                  <td class="text-xs">${r.simla_order_id || '—'}</td>
                  <td>
                    <select style="padding:4px 8px;border:1px solid var(--lt2);border-radius:5px;font-size:12px;background:var(--card-bg);color:var(--fg)"
                      onchange="quickUpdateCod('${r.order_name}', this.value)">
                      <option value="">Cambiar estado...</option>
                      ${['pending','confirmed','delivered','paid','refused','returned']
                        .filter(s => s !== r.status)
                        .map(s => `<option value="${s}">${statusLabel(s)}</option>`).join('')}
                    </select>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    showError(el, err.message);
  }
}

// ── Actualización rápida de estado ────────────────────────────────────────────

async function quickUpdateCod(orderName, newStatus) {
  if (!newStatus) return;
  try {
    await API.updateCod(orderName, newStatus);
    // Refrescar solo la tabla (no el dashboard completo)
    loadCodTable();
    // Refrescar el dashboard en background
    const from = document.getElementById('cod-from').value;
    const to   = document.getElementById('cod-to').value;
    API.getCodDashboard({ from, to }).then(data => renderCodDashboard(data, from, to)).catch(() => {});
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ── Importar CSV de Simla ──────────────────────────────────────────────────────

async function uploadSimlaCsv(input) {
  const file = input.files[0];
  if (!file) return;

  const text = await file.text();
  const rows = parseSimlaCsv(text);

  if (rows.length === 0) {
    alert('No se encontraron pedidos en el CSV de Simla.\nVerificá que el archivo tenga columnas: order_name, status');
    return;
  }

  try {
    const result = await API.importSimlaCsv(rows);
    alert(`✓ Matcheados: ${result.matched}\nNo encontrados: ${result.not_found.length}${
      result.not_found.length > 0 ? '\n\n' + result.not_found.join(', ') : ''
    }`);
    loadCodDashboard();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function parseSimlaCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    const row  = {};
    header.forEach((h, j) => row[h] = cols[j] || '');

    const orderName = row['order_name'] || row['numero_pedido'] || row['order'] || row['pedido'] || '';
    const status    = row['status']     || row['estado']        || row['estado_pedido']            || '';
    const simlaId   = row['simla_id']   || row['id']            || '';

    if (!orderName || !status) continue;
    rows.push({ order_name: orderName.trim(), status: mapSimlaStatus(status), simla_order_id: simlaId });
  }

  return rows.filter(r => r.status);
}

function mapSimlaStatus(raw) {
  const s = raw.toLowerCase().trim();
  if (s.includes('entrega') || s.includes('deliver')) return 'delivered';
  if (s.includes('cobr')    || s.includes('paid')    || s.includes('pagad')) return 'paid';
  if (s.includes('rechaz')  || s.includes('refus'))                           return 'refused';
  if (s.includes('devolv')  || s.includes('return'))                          return 'returned';
  if (s.includes('confirm'))                                                   return 'confirmed';
  if (s.includes('pend'))                                                      return 'pending';
  return '';
}

function statusLabel(s) {
  return COD_STATUS_LABELS[s] || s;
}
