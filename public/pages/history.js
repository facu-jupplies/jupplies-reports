// ─── Dashboard Shopify ──────────────────────────────────────────────────────────

let _histPeriods = {};
let _histActive  = 'yesterday';
let _histSkuLimit = 20;

// ── Rangos ───────────────────────────────────────────────────────────────────

function histPeriodRanges() {
  const y = yesterday();
  const { from: mf, to: mt } = thisMonthRange();
  const { from: pmf, to: pmt } = prevMonthRange();
  return {
    yesterday: { from: y,   to: y,   label: 'Ayer',         sub: fd(y),  color: '#0d9488' },
    month:     { from: mf,  to: mt,  label: 'Este mes',     sub: fd(mf) + ' – ' + fd(mt), color: '#16a34a' },
    prevmonth: { from: pmf, to: pmt, label: 'Mes anterior', sub: fd(pmf) + ' – ' + fd(pmt), color: '#1e40af' },
  };
}

// ── Carga ────────────────────────────────────────────────────────────────────

async function loadHistory() {
  const ranges = histPeriodRanges();
  const el = document.getElementById('history-content');
  el.innerHTML = '<div class="loading">Cargando períodos...</div>';

  try {
    // Fetch los 3 períodos + custom si tiene fechas
    const fetches = Object.entries(ranges).map(async ([key, r]) => {
      const data = await API.getPeriodReport(r.from, r.to);
      return { key, data };
    });

    // Custom range
    const cf = document.getElementById('hist-custom-from')?.value;
    const ct = document.getElementById('hist-custom-to')?.value;
    if (cf && ct && _histActive === 'custom') {
      fetches.push((async () => {
        const data = await API.getPeriodReport(cf, ct);
        return { key: 'custom', data };
      })());
    }

    const results = await Promise.allSettled(fetches);

    _histPeriods = {};
    for (const res of results) {
      if (res.status === 'fulfilled') {
        const { key, data } = res.value;
        _histPeriods[key] = data;
      }
    }

    renderHistFull();
  } catch (err) {
    showError(el, err.message);
  }
}

async function loadHistCustom() {
  const cf = document.getElementById('hist-custom-from')?.value;
  const ct = document.getElementById('hist-custom-to')?.value;
  if (!cf || !ct) return;

  _histActive = 'custom';

  try {
    const data = await API.getPeriodReport(cf, ct);
    _histPeriods.custom = data;
  } catch (err) {
    _histPeriods.custom = null;
  }

  renderHistFull();
}

// ── Render principal ─────────────────────────────────────────────────────────

function renderHistFull() {
  const el = document.getElementById('history-content');
  const ranges = histPeriodRanges();

  const cards = Object.entries(ranges).map(([key, r]) => {
    const d = _histPeriods[key];
    return renderHistCard(key, r, d?.metrics, key === _histActive);
  }).join('');

  // Custom card — siempre visible como 4ta tarjeta
  const cf = document.getElementById('hist-custom-from')?.value || thisMonthRange().from;
  const ct = document.getElementById('hist-custom-to')?.value || today();
  const customData = _histPeriods.custom;
  const customActive = _histActive === 'custom';
  const customBorder = customActive ? '2.5px solid #7c3aed' : '2px solid transparent';
  const customM = customData?.metrics;

  const customCardHtml = `
    <div class="card" data-hist-period="custom" onclick="selectShopifyPeriod('custom')" style="border:${customBorder};cursor:pointer;padding:0;overflow:hidden;transition:border .15s"
>
      <div style="background:#7c3aed;padding:9px 12px">
        <div style="font-size:13px;font-weight:700;color:#fff">Personalizado</div>
        <div style="display:flex;gap:4px;align-items:center;margin-top:4px" onclick="event.stopPropagation()">
          <input type="date" id="hist-custom-from" value="${cf}"
            style="padding:3px 6px;border:1px solid rgba(255,255,255,.3);border-radius:4px;font-size:11px;width:120px;background:rgba(255,255,255,.15);color:#fff">
          <span style="color:rgba(255,255,255,.6);font-size:11px">→</span>
          <input type="date" id="hist-custom-to" value="${ct}"
            style="padding:3px 6px;border:1px solid rgba(255,255,255,.3);border-radius:4px;font-size:11px;width:120px;background:rgba(255,255,255,.15);color:#fff">
          <button onclick="event.stopPropagation();loadHistCustom()"
            style="padding:3px 8px;border:1px solid rgba(255,255,255,.4);border-radius:4px;background:rgba(255,255,255,.2);color:#fff;font-size:10px;font-weight:700;cursor:pointer">OK</button>
        </div>
      </div>
      <div style="padding:10px 12px">
        ${customM ? `
          <div style="margin-bottom:6px">
            <div style="font-size:10px;font-weight:600;color:var(--md);text-transform:uppercase;letter-spacing:.4px">Facturación</div>
            <div style="font-size:20px;font-weight:700;line-height:1.1">${fe(customM.rev_bruto)}</div>
          </div>
          <div style="font-size:11px;color:var(--md);margin-bottom:6px">
            ${customM.orders_total} ped. 💳${customM.orders_card} 💵${customM.orders_cod}
          </div>
          <div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0"><span style="color:var(--md)">Gasto ADS</span><span class="text-red" style="font-weight:600">${fe(customM.ads_total)}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0"><span style="color:var(--md)">ROAS</span><span style="font-weight:600" class="${customM.roas >= 3 ? 'text-green' : customM.roas >= 2 ? 'text-orange' : 'text-red'}">${(customM.roas||0).toFixed(2)}x</span></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0"><span style="color:var(--md)">CPA</span><span style="font-weight:600">${fe(customM.cpa)}</span></div>
          <div style="border-top:1px solid var(--lt2);padding-top:6px;margin-top:6px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div>
                <div style="font-size:10px;font-weight:600;color:var(--md);text-transform:uppercase">Resultado</div>
                <div style="font-size:18px;font-weight:700;color:${customM.ganancia >= 0 ? (customM.margen_pct >= 15 ? '#22c55e' : '#f59e0b') : '#ef4444'}">${fe(customM.ganancia)}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:16px;font-weight:700;color:${customM.ganancia >= 0 ? (customM.margen_pct >= 15 ? '#22c55e' : '#f59e0b') : '#ef4444'}">${fp(customM.margen_pct)}</div>
                <div style="font-size:10px;color:var(--md)">margen</div>
              </div>
            </div>
          </div>
        ` : `<div style="font-size:12px;color:var(--md);text-align:center;padding:10px 0">Elegí fechas y presioná OK</div>`}
      </div>
    </div>`;

  // Active period data
  const activeData = _histPeriods[_histActive];
  const activeRange = _histActive === 'custom'
    ? { from: cf, to: ct, label: 'Personalizado', sub: fd(cf) + ' – ' + fd(ct), color: '#7c3aed' }
    : ranges[_histActive];

  el.innerHTML = `
    <!-- Tarjetas de período -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      ${cards}
      ${customCardHtml}
    </div>

    <!-- Contenido del período activo -->
    <div id="hist-detail-wrap">
      ${activeData ? renderHistDetail(activeRange, activeData) : '<div class="empty-state"><div class="icon">📅</div><div class="msg">Seleccioná un período</div></div>'}
    </div>
  `;
}

// ── Tarjeta de período ───────────────────────────────────────────────────────

function renderHistCard(key, range, m, active) {
  const border  = active ? `2.5px solid ${range.color}` : '2px solid transparent';

  if (!m) {
    return `
      <div class="card" data-hist-period="${key}" onclick="selectShopifyPeriod('${key}')" style="border:${border};opacity:.5;cursor:pointer;padding:0;overflow:hidden"
>
        <div style="background:${range.color};padding:8px 12px">
          <div style="font-size:13px;font-weight:700;color:#fff">${range.label}</div>
          <div style="font-size:10px;color:rgba(255,255,255,.75)">${range.sub}</div>
        </div>
        <div style="padding:14px;font-size:12px;color:var(--md);text-align:center">Sin datos</div>
      </div>`;
  }

  const mc = m.ganancia >= 0
    ? (m.margen_pct >= 15 ? '#22c55e' : m.margen_pct >= 8 ? '#f59e0b' : '#ef4444')
    : '#ef4444';

  const row = (label, value, cls = '') =>
    `<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0">
       <span style="color:var(--md)">${label}</span>
       <span class="${cls}" style="font-weight:600">${value}</span>
     </div>`;

  return `
    <div class="card" data-hist-period="${key}" style="border:${border};cursor:pointer;padding:0;overflow:hidden;transition:border .15s"
         onclick="selectShopifyPeriod('${key}')">
      <div style="background:${range.color};padding:9px 12px">
        <div style="font-size:13px;font-weight:700;color:#fff">${range.label}</div>
        <div style="font-size:10px;color:rgba(255,255,255,.75)">${range.sub}</div>
      </div>

      <div style="padding:10px 12px">
        <div style="margin-bottom:6px">
          <div style="font-size:10px;font-weight:600;color:var(--md);text-transform:uppercase;letter-spacing:.4px">Facturación</div>
          <div style="font-size:20px;font-weight:700;line-height:1.1">${fe(m.rev_bruto)}</div>
        </div>
        <div style="font-size:11px;color:var(--md);margin-bottom:6px">
          ${m.orders_total} ped. 💳${m.orders_card} 💵${m.orders_cod}
        </div>
        ${row('Gasto ADS', fe(m.ads_total), 'text-red')}
        ${row('ROAS', (m.roas||0).toFixed(2) + 'x', m.roas >= 3 ? 'text-green' : m.roas >= 2 ? 'text-orange' : 'text-red')}
        ${row('CPA', fe(m.cpa), '')}

        <div style="border-top:1px solid var(--lt2);padding-top:6px;margin-top:6px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-size:10px;font-weight:600;color:var(--md);text-transform:uppercase">Resultado</div>
              <div style="font-size:18px;font-weight:700;color:${mc}">${fe(m.ganancia)}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:16px;font-weight:700;color:${mc}">${fp(m.margen_pct)}</div>
              <div style="font-size:10px;color:var(--md)">margen</div>
            </div>
          </div>
        </div>

        <!-- Expandible -->
        <div style="border-top:1px solid var(--lt2);margin-top:6px;padding-top:5px">
          <div onclick="event.stopPropagation();toggleShopifyDetail('${key}')" style="cursor:pointer;font-size:11px;color:${range.color};font-weight:600;text-align:center;padding:2px 0">
            <span id="hist-arrow-${key}">▾</span> Detalles
          </div>
          <div id="hist-expand-${key}" style="display:none;margin-top:6px">
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--md);margin-bottom:4px">Facturación</div>
            ${row('Bruta', fe(m.rev_bruto), '')}
            ${row('Efectiva (ajust. COD)', fe(m.rev_efectivo), '')}
            ${row('COD bruto', fe(m.rev_cod_bruto), '')}
            ${row('COD efectivo', fe(m.rev_cod_efectivo), '')}
            ${row('Paid (tarjeta)', fe(m.rev_card_bruto), '')}
            <div style="height:6px"></div>
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--md);margin-bottom:4px">Costos</div>
            ${row('Costo producto', fe(m.product_cost), 'text-red')}
            ${row('Costo envíos', fe(m.shipping_cost), 'text-red')}
            ${row('Rechazos COD', fe(m.cost_rechazos), 'text-red')}
            ${row('Gasto ADS', fe(m.ads_total), 'text-red')}
            <div style="height:6px"></div>
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--md);margin-bottom:4px">KPIs</div>
            ${row('ROAS bruto', (m.roas||0).toFixed(2) + 'x', m.roas >= 3 ? 'text-green' : m.roas >= 2 ? 'text-orange' : 'text-red')}
            ${row('ROAS real', (m.roas_real||0).toFixed(2) + 'x', m.roas_real >= 3 ? 'text-green' : m.roas_real >= 2 ? 'text-orange' : 'text-red')}
            ${row('CPA', fe(m.cpa), '')}
            ${row('AOV (ticket medio)', fe(m.aov), '')}
            ${row('Margen s/bruta', fp(m.margen_pct), mc === '#22c55e' ? 'text-green' : mc === '#f59e0b' ? 'text-orange' : 'text-red')}
            ${row('Retorno s/CP', fp(m.sobre_cp_pct), m.sobre_cp_pct >= 60 ? 'text-green' : m.sobre_cp_pct >= 30 ? 'text-orange' : 'text-red')}
            <div style="height:6px"></div>
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--md);margin-bottom:4px">Mix de pago</div>
            ${row('% COD', fp(m.pct_cod), '')}
            ${row('% Paid', fp(m.pct_card), '')}
            ${row('Tasa cobro total', fp(m.efec_total), '')}
            ${row('Efec. COD (conf×entr)', fp((m.efec||0)*100), '')}
          </div>
        </div>
      </div>
    </div>`;
}

function toggleShopifyDetail(key) {
  const el = document.getElementById('hist-expand-' + key);
  const arrow = document.getElementById('hist-arrow-' + key);
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  if (arrow) arrow.textContent = open ? '▾' : '▴';
}

function selectShopifyPeriod(key) {
  if (key === _histActive) return; // ya seleccionado
  _histActive = key;
  _histSkuLimit = 20;

  const ranges = histPeriodRanges();
  const cf = document.getElementById('hist-custom-from')?.value || '';
  const ct = document.getElementById('hist-custom-to')?.value || '';

  // 1. Actualizar bordes de tarjetas
  document.querySelectorAll('[data-hist-period]').forEach(function(card) {
    var k = card.getAttribute('data-hist-period');
    var color = k === 'custom' ? '#7c3aed' : (ranges[k] ? ranges[k].color : '#999');
    card.style.border = k === key ? '2.5px solid ' + color : '2px solid transparent';
  });

  // 2. Re-renderizar detalle
  var activeData = _histPeriods[key];
  var activeRange = key === 'custom'
    ? { from: cf, to: ct, label: 'Personalizado', sub: fd(cf) + ' – ' + fd(ct), color: '#7c3aed' }
    : ranges[key];

  var wrap = document.getElementById('hist-detail-wrap');
  if (wrap) {
    wrap.innerHTML = activeData
      ? renderHistDetail(activeRange, activeData)
      : '<div class="empty-state"><div class="icon">📅</div><div class="msg">Sin datos para este período</div></div>';
  }
}

// ── Detalle del período: KPIs + P&L por SKU ──────────────────────────────────

function renderHistDetail(range, data) {
  const m = data.metrics;
  const skuRows = data.skuMetrics || [];
  const dayDetail = data.dayDetail || [];
  if (!m) return '';

  const profitColor = m.ganancia >= 0 ? 'var(--gr)' : 'var(--re)';

  // Mini KPIs
  const mk = (label, value, sub, color) => `
    <div class="card" style="text-align:center;padding:10px 12px${color ? ';border-top:2px solid ' + color : ''}">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--md);margin-bottom:4px">${label}</div>
      <div style="font-family:'Poppins',sans-serif;font-size:18px;font-weight:800${color ? ';color:' + color : ''}">${value}</div>
      ${sub ? `<div style="font-size:10px;color:var(--md);margin-top:2px">${sub}</div>` : ''}
    </div>`;

  // SKU table
  const visibleSkus = skuRows.filter(s => !s.is_upsell && !s.is_sin_tracking).slice(0, _histSkuLimit);
  const hasMore = skuRows.filter(s => !s.is_upsell && !s.is_sin_tracking).length > _histSkuLimit;
  const totalRevBruto = m.rev_bruto || 1;

  return `
    <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:10px">
      <div class="section-title" style="margin:0">${range.label}</div>
      <div style="font-size:12px;color:var(--md)">${range.sub}</div>
    </div>

    <!-- Mini KPIs -->
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:14px">
      ${mk('Facturación', fe(m.rev_bruto), m.orders_total + ' pedidos', '')}
      ${mk('Pedidos', m.orders_total, '💳' + m.orders_card + ' 💵' + m.orders_cod, '')}
      ${mk('AOV', fe(m.aov), 'ticket medio', '')}
      ${mk('Gasto ADS', fe(m.ads_total), 'CPA ' + fe(m.cpa), 'var(--re)')}
      ${mk('ROAS', (m.roas||0).toFixed(2) + 'x', 'real ' + (m.roas_real||0).toFixed(2) + 'x', m.roas >= 3 ? 'var(--gr)' : m.roas >= 2 ? 'var(--or)' : 'var(--re)')}
      ${mk('Resultado', fe(m.ganancia), 'margen ' + fp(m.margen_pct), profitColor)}
    </div>

    <!-- P&L por SKU / Grupo -->
    <div class="section-title" style="margin-bottom:8px">P&L por SKU / Grupo — Top ${Math.min(_histSkuLimit, visibleSkus.length)}</div>
    <div class="table-wrap">
      <table style="table-layout:fixed;width:100%">
        <colgroup>
          <col style="width:18%">
          <col style="width:6%">
          <col style="width:4%">
          <col style="width:4%">
          <col style="width:6%">
          <col style="width:10%">
          <col style="width:6%">
          <col style="width:9%">
          <col style="width:8%">
          <col style="width:8%">
          <col style="width:9%">
          <col style="width:6%">
          <col style="width:6%">
        </colgroup>
        <thead>
          <tr>
            <th style="text-align:left">SKU / Grupo</th>
            <th style="text-align:right">Pedidos</th>
            <th style="text-align:right">💳</th>
            <th style="text-align:right">💵</th>
            <th style="text-align:right">Uds.</th>
            <th style="text-align:right">Facturación</th>
            <th style="text-align:right">%</th>
            <th style="text-align:right">Costo Prod.</th>
            <th style="text-align:right">Envío</th>
            <th style="text-align:right">ADS</th>
            <th style="text-align:right">Resultado</th>
            <th style="text-align:right">Margen</th>
            <th style="text-align:right">% s/CP</th>
          </tr>
        </thead>
        <tbody>
          ${visibleSkus.map(s => {
            const totalOrders = (s.orders_card || 0) + (s.orders_cod || 0);
            const pctTotal = ((s.rev_bruto / totalRevBruto) * 100).toFixed(1);
            // Mostrar nombre de grupo, sub-SKUs como tooltip
            const skuLabel = s.sku;
            return `<tr>
              <td style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${s.skus ? s.skus.join(' · ') : s.sku}">${skuLabel}</td>
              <td style="text-align:right;font-weight:700">${totalOrders || s.orders}</td>
              <td style="text-align:right;font-size:11px;color:var(--md)">${s.orders_card ?? ''}</td>
              <td style="text-align:right;font-size:11px;color:var(--md)">${s.orders_cod ?? ''}</td>
              <td style="text-align:right">${s.units + (s.upsell_units || 0)}</td>
              <td style="text-align:right;font-weight:600">${fe(s.rev_bruto)}</td>
              <td style="text-align:right;font-size:11px">${pctTotal}%</td>
              <td style="text-align:right" class="text-red">${fe(s.product_cost)}</td>
              <td style="text-align:right" class="text-red">${fe(s.shipping_cost)}</td>
              <td style="text-align:right" class="text-red">${fe(s.ads)}</td>
              <td style="text-align:right;font-weight:700" class="${s.ganancia >= 0 ? 'text-green' : 'text-red'}">${fe(s.ganancia)}</td>
              <td style="text-align:right">${fp(s.margen_pct)}</td>
              <td style="text-align:right" class="${pctClass(s.sobre_cp_pct)}">${fp(s.sobre_cp_pct)}</td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot>
          <tr>
            <td style="font-weight:700">TOTAL</td>
            <td style="text-align:right;font-weight:700">${m.orders_total}</td>
            <td style="text-align:right;font-size:11px">${m.orders_card}</td>
            <td style="text-align:right;font-size:11px">${m.orders_cod}</td>
            <td></td>
            <td style="text-align:right;font-weight:700">${fe(m.rev_bruto)}</td>
            <td style="text-align:right">100%</td>
            <td style="text-align:right" class="text-red">${fe(m.product_cost)}</td>
            <td style="text-align:right" class="text-red">${fe(m.shipping_cost)}</td>
            <td style="text-align:right" class="text-red">${fe(m.ads_total)}</td>
            <td style="text-align:right;font-weight:700" class="${m.ganancia >= 0 ? 'text-green' : 'text-red'}">${fe(m.ganancia)}</td>
            <td style="text-align:right">${fp(m.margen_pct)}</td>
            <td style="text-align:right" class="${pctClass(m.sobre_cp_pct)}">${fp(m.sobre_cp_pct)}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    ${hasMore ? `
    <div style="text-align:center;margin-top:10px">
      <button class="btn btn-secondary btn-sm" onclick="showMoreSkus()">Ver más (${skuRows.filter(s => !s.is_upsell && !s.is_sin_tracking).length - _histSkuLimit} restantes)</button>
    </div>` : ''}
  `;
}

function showMoreSkus() {
  _histSkuLimit += 50;
  const ranges = histPeriodRanges();
  const activeRange = _histActive === 'custom'
    ? { label: 'Personalizado', sub: fd(document.getElementById('hist-custom-from')?.value || '') + ' – ' + fd(document.getElementById('hist-custom-to')?.value || ''), color: '#7c3aed' }
    : ranges[_histActive];
  const wrap = document.getElementById('hist-detail-wrap');
  if (wrap && _histPeriods[_histActive]) {
    wrap.innerHTML = renderHistDetail(activeRange, _histPeriods[_histActive]);
  }
}

function goToDay(date) {
  document.getElementById('daily-date').value = date;
  showPage('daily');
  renderDayReport(date);
}

// ── Strip de días importados ─────────────────────────────────────────────────
// Muestra cada día del rango con check verde (importado) o X roja (faltante)

function _buildDaysStrip(range, dayDetail) {
  if (!range.from || !range.to) return '';

  const importedDates = new Set(dayDetail.map(d => d.date));
  const from = new Date(range.from + 'T12:00:00');
  const to   = new Date(range.to   + 'T12:00:00');
  const todayStr = today();

  const allDays = [];
  const d = new Date(from);
  while (d <= to) {
    const ds = d.toISOString().slice(0, 10);
    // No incluir hoy ni futuros (no tienen datos)
    if (ds < todayStr) {
      allDays.push(ds);
    }
    d.setDate(d.getDate() + 1);
  }

  if (allDays.length === 0 || allDays.length > 45) return ''; // no mostrar si es muy largo o vacío

  const missing = allDays.filter(d => !importedDates.has(d));

  const chips = allDays.map(ds => {
    const imported = importedDates.has(ds);
    const dayNum = ds.split('-')[2];
    const bg = imported ? 'rgba(26,122,66,.1)' : 'rgba(239,68,68,.1)';
    const color = imported ? 'var(--gr)' : '#ef4444';
    const icon = imported ? '✓' : '✕';
    const title = imported ? 'Importado' : 'Falta importar — click para cargar';
    const onclick = imported ? '' : `onclick="goToDay('${ds}')" style="cursor:pointer"`;
    return `<div ${onclick} title="${title}: ${fd(ds)}" style="display:flex;flex-direction:column;align-items:center;gap:1px;padding:3px 5px;border-radius:5px;background:${bg};min-width:28px;${imported ? '' : 'cursor:pointer'}">
      <span style="font-size:9px;font-weight:700;color:${color}">${icon}</span>
      <span style="font-size:10px;font-weight:600;color:${color}">${parseInt(dayNum)}</span>
    </div>`;
  }).join('');

  const missingWarning = missing.length > 0
    ? `<span style="color:#ef4444;font-size:11px;font-weight:600;margin-left:8px">${missing.length} día${missing.length > 1 ? 's' : ''} sin importar</span>`
    : `<span style="color:var(--gr);font-size:11px;font-weight:600;margin-left:8px">✓ Todos los días importados</span>`;

  return `
    <div style="margin-bottom:12px;padding:10px 14px;background:var(--wh);border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.04)">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--md)">Días en el período</span>
        ${missingWarning}
      </div>
      <div style="display:flex;gap:3px;flex-wrap:wrap">
        ${chips}
      </div>
    </div>
  `;
}
