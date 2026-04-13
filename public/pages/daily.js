// ─── Reporte del día ──────────────────────────────────

// Estado de tabla SKU (persiste entre sorts sin re-fetch)
let _skuRows        = [];
let _skuSort        = { col: null, dir: 1 };  // dir: 1=asc, -1=desc
let _skuTotalRevBruto = 0;  // para calcular % s/total en re-sort
let _simlaStock     = {};   // SKU → { cost, stock } de Simla

// Claves de sort por índice de columna (0-based) — 15 columnas
const SKU_SORT_KEYS = [
  s => (s.sku || '').toLowerCase(),           // 0  SKU
  s => (s.orders_card ?? 0) + (s.orders_cod ?? 0), // 1  Ped. Total
  s => s.orders_card   ?? -Infinity,          // 2  Ped. Card
  s => s.orders_cod    ?? -Infinity,          // 3  Ped. COD
  s => (s.units + (s.upsell_units || 0)),     // 4  Unidades
  s => s.rev_bruto     ?? -Infinity,          // 5  Fact. Total
  s => s.rev_card_bruto ?? -Infinity,         // 6  Fact. Paid
  s => s.rev_cod_bruto  ?? -Infinity,         // 7  Fact. COD
  s => s.rev_bruto      ?? -Infinity,         // 8  % s/total (sort by rev_bruto)
  s => s.product_cost   ?? -Infinity,         // 9  Costo Prod.
  s => s.shipping_cost  ?? -Infinity,         // 10 Costo Envío
  s => s.ads            ?? -Infinity,         // 11 ADS
  s => s.ganancia       ?? -Infinity,         // 12 Ganancia
  s => s.margen_pct     ?? -Infinity,         // 13 % Margen
  s => s.sobre_cp_pct   ?? -Infinity,         // 14 % sobre CP
];

function sortSkuTable(col) {
  if (_skuSort.col === col) {
    _skuSort.dir *= -1;
  } else {
    _skuSort.col = col;
    _skuSort.dir = -1;  // primera vez: mayor a menor
  }

  // Separar filas especiales (siempre al fondo)
  const normal   = _skuRows.filter(s => !s.is_upsell && !s.is_sin_ventas && !s.is_sin_tracking);
  const specials = _skuRows.filter(s =>  s.is_upsell ||  s.is_sin_ventas ||  s.is_sin_tracking);

  const keyFn = SKU_SORT_KEYS[col];
  normal.sort((a, b) => {
    const av = keyFn(a), bv = keyFn(b);
    if (av < bv) return  _skuSort.dir;
    if (av > bv) return -_skuSort.dir;
    return 0;
  });

  _skuRows = [...normal, ...specials];

  // Actualizar clases de encabezado
  const ths = document.querySelectorAll('#sku-tbl thead th');
  ths.forEach((th, i) => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (i === col) th.classList.add(_skuSort.dir === 1 ? 'sort-asc' : 'sort-desc');
  });

  // Re-renderizar solo el tbody (sin tocar el resto de la página)
  const tbody = document.querySelector('#sku-tbl tbody');
  if (tbody) tbody.innerHTML = renderSkuRows(_skuRows, _skuTotalRevBruto);
}

function renderSkuRows(rows, totalRevBruto) {
  const NC = 11; // number of columns
  return rows.map(s => {
    if (s.is_upsell) {
      return `<tr style="opacity:0.5">
        <td>${s.sku} <span style="background:#f59e0b;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:bold">UP</span></td>
        <td style="text-align:right">${s.units}</td>
        <td colspan="${NC - 2}" style="font-size:10px;color:var(--md);text-align:center">Costos atribuidos al SKU principal</td>
      </tr>`;
    }
    if (s.is_sin_ventas) return `<tr style="opacity:0.6;font-style:italic">
      <td style="color:var(--md)">${s.sku} <span style="font-size:10px">sin ventas</span></td>
      <td colspan="5">—</td>
      <td style="text-align:right" class="text-red">${fe(s.ads)}</td>
      <td>—</td>
      <td style="text-align:right" class="text-red">${fe(s.ganancia)}</td>
      <td colspan="2">—</td>
    </tr>`;
    if (s.is_sin_tracking) return `<tr style="opacity:0.55;font-style:italic">
      <td style="color:var(--md);font-size:11px">${platIcon(s.platform||'')} ${s.campaign_name||'?'} <a onclick="showPage('campaigns')" style="color:var(--or);cursor:pointer;font-size:10px">asignar →</a></td>
      <td colspan="5">—</td>
      <td style="text-align:right" class="text-red">${fe(s.ads)}</td>
      <td>—</td>
      <td style="text-align:right" class="text-red">${fe(s.ganancia)}</td>
      <td colspan="2">—</td>
    </tr>`;

    const totalOrders = (s.orders_card ?? 0) + (s.orders_cod ?? 0) || s.orders;
    const totalUnits = s.units + (s.upsell_units || 0);
    const cpa = totalOrders > 0 && s.ads > 0 ? s.ads / totalOrders : 0;

    // Stock de Simla (puede no estar cargado aún)
    const simla = _simlaStock[s.sku] || _simlaStock[s.skus?.[0]] || null;
    const stockLabel = simla ? `<span style="color:${simla.stock > 20 ? 'var(--gr)' : simla.stock > 0 ? 'var(--or)' : 'var(--re)'};font-weight:600">${simla.stock} uds</span>` : '';
    const costLabel = simla && simla.cost > 0 ? fe(simla.cost) : '';

    return `<tr>
      <td style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${s.skus ? s.skus.join(' · ') : s.sku}">
        <div style="font-weight:700">${s.sku}</div>
        <div style="font-size:10px;color:var(--md);margin-top:1px">
          ${costLabel ? 'COGS ' + costLabel : ''}${costLabel && stockLabel ? ' · ' : ''}${stockLabel ? 'Stock: ' + stockLabel : ''}
        </div>
      </td>
      <td style="text-align:right">
        <div style="font-weight:700;line-height:1.2">${totalOrders}</div>
        <div style="font-size:9px;color:var(--md);white-space:nowrap"><span style="color:var(--bl)">💳${s.orders_card ?? 0}</span> <span style="color:var(--gr)">💵${s.orders_cod ?? 0}</span></div>
      </td>
      <td style="text-align:right">${totalUnits}</td>
      <td style="text-align:right">
        <div style="font-weight:600;line-height:1.2">${fe(s.rev_bruto)}</div>
        <div style="font-size:9px;color:var(--md);white-space:nowrap">💵${fe(s.rev_cod_bruto??0)} 💳${fe(s.rev_card_bruto??0)}</div>
      </td>
      <td style="text-align:right" class="text-red">${fe(s.product_cost)}</td>
      <td style="text-align:right" class="text-red">${fe(s.shipping_cost)}</td>
      <td style="text-align:right" class="text-red">${fe(s.ads)}</td>
      <td style="text-align:right;font-size:11px">${cpa > 0 ? fe(cpa) : '—'}</td>
      <td style="text-align:right;font-weight:700" class="${s.ganancia >= 0 ? 'text-green' : 'text-red'}">${fe(s.ganancia)}</td>
      <td style="text-align:right">${fp(s.margen_pct)}</td>
      <td style="text-align:right" class="${pctClass(s.sobre_cp_pct)}">${fp(s.sobre_cp_pct)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="${NC}" style="text-align:center;color:var(--md);padding:20px">Sin datos de SKU</td></tr>`;
}

async function loadDay() {
  const date = document.getElementById('daily-date').value;
  if (!date) return alert('Seleccioná una fecha primero');

  const el = document.getElementById('daily-content');
  el.innerHTML = '<div class="loading">⏳ Importando pedidos de Simla... (puede tardar unos segundos)</div>';

  try {
    const result = await API.importDay(date);
    if (result.orders_imported === 0 && result.ads_imported === 0) {
      el.innerHTML = `<div class="empty-state">
        <div class="icon">📭</div>
        <div class="msg">Sin datos para ${fd(date)}</div>
        <div class="hint">Shopify no devolvió pedidos para esta fecha.</div>
      </div>`;
      return;
    }

    // Mostrar aviso si ads fallaron
    let adsWarningHtml = '';
    if (result.ads_warning) {
      adsWarningHtml = `<div style="padding:8px 14px;margin-bottom:10px;background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);border-radius:8px;font-size:12px;color:var(--md)">
        ⚠️ ${result.ads_warning}
      </div>`;
    }

    await renderDayReport(date, adsWarningHtml);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">⚠️</div>
      <div class="msg">Error al importar</div>
      <div class="hint">${err.message}</div>
    </div>`;
  }
}

// Mantener alias por si hay referencias externas
function loadDayWindsor() { loadDay(); }

// ── Strip de días importados con pestañas por mes ────────────────────────────

let _daysStripMonth = null; // YYYY-MM del mes activo en el strip

async function loadDaysStrip() {
  const el = document.getElementById('daily-days-strip');
  if (!el) return;

  // Determinar mes activo (default: mes actual)
  const now = new Date();
  if (!_daysStripMonth) {
    _daysStripMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  try {
    // Fetch todos los días desde Enero 2026 hasta hoy
    const allData = await API.getHistory('2026-01-01', today());
    const importedDates = new Set(allData.map(d => d.date));
    const todayStr = today();

    // Generar tabs de meses desde Enero 2026 hasta el mes actual
    const months = [];
    const startYear = 2026, startMonth = 1;
    const endYear = now.getFullYear(), endMonth = now.getMonth() + 1;
    for (let y = startYear; y <= endYear; y++) {
      const mStart = y === startYear ? startMonth : 1;
      const mEnd = y === endYear ? endMonth : 12;
      for (let m = mStart; m <= mEnd; m++) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
      }
    }

    const MONTH_NAMES = ['', 'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    // Tabs
    const tabs = months.map(ym => {
      const [y, m] = ym.split('-').map(Number);
      const label = MONTH_NAMES[m];
      const active = ym === _daysStripMonth;
      // Count days with data in this month
      const monthDays = allData.filter(d => d.date.startsWith(ym));
      const bg = active ? 'var(--or)' : monthDays.length > 0 ? 'var(--wh,#fff)' : 'transparent';
      const color = active ? '#fff' : 'var(--md)';
      const border = active ? 'none' : '1px solid var(--lt2)';
      return `<div onclick="_daysStripMonth='${ym}';loadDaysStrip()"
        style="padding:4px 10px;border-radius:5px;font-size:11px;font-weight:${active ? '700' : '500'};background:${bg};color:${color};border:${border};cursor:pointer;white-space:nowrap">
        ${label}${monthDays.length > 0 ? ` <span style="font-size:9px;opacity:.7">${monthDays.length}d</span>` : ''}
      </div>`;
    }).join('');

    // Chips del mes seleccionado
    const [selY, selM] = _daysStripMonth.split('-').map(Number);
    const lastDay = new Date(selY, selM, 0).getDate();
    const monthDays = [];
    for (let d = 1; d <= lastDay; d++) {
      const ds = `${selY}-${String(selM).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (ds < todayStr) monthDays.push(ds);
    }

    const missing = monthDays.filter(d => !importedDates.has(d));

    const chips = monthDays.map(ds => {
      const imported = importedDates.has(ds);
      const dayNum = ds.split('-')[2];
      const selected = ds === document.getElementById('daily-date').value;
      const bg = selected ? 'var(--or)' : imported ? 'rgba(26,122,66,.12)' : 'rgba(239,68,68,.12)';
      const color = selected ? '#fff' : imported ? 'var(--gr)' : '#ef4444';
      const icon = selected ? '▸' : imported ? '✓' : '✕';
      return `<div onclick="selectDayFromStrip('${ds}')" title="${fd(ds)}${imported ? ' — importado' : ' — sin importar'}"
        style="display:flex;flex-direction:column;align-items:center;gap:1px;padding:3px 5px;border-radius:5px;background:${bg};min-width:28px;cursor:pointer;transition:background .15s">
        <span style="font-size:8px;font-weight:700;color:${color}">${icon}</span>
        <span style="font-size:10px;font-weight:600;color:${color}">${parseInt(dayNum)}</span>
      </div>`;
    }).join('');

    const statusText = monthDays.length === 0
      ? `<span style="color:var(--md);font-size:11px">Mes futuro</span>`
      : missing.length > 0
        ? `<span style="color:#ef4444;font-size:11px;font-weight:600">${missing.length} día${missing.length > 1 ? 's' : ''} sin importar</span>`
        : `<span style="color:var(--gr);font-size:11px;font-weight:600">✓ Mes completo</span>`;

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--md)">Días importados</span>
        ${statusText}
      </div>
      <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap">
        ${tabs}
      </div>
      <div style="display:flex;gap:3px;flex-wrap:wrap">
        ${chips}
      </div>
    `;
  } catch (err) {
    el.innerHTML = '';
  }
}

function selectDayFromStrip(date) {
  document.getElementById('daily-date').value = date;
  loadDaysStrip(); // refresh strip to show selection
  renderDayReport(date);
}

async function renderDayReport(date, prefixHtml = '') {
  const el = document.getElementById('daily-content');
  el.innerHTML = '<div class="loading">Calculando métricas...</div>';

  try {
    const data = await API.getDayReport(date);
    if (data.empty) {
      el.innerHTML = `<div class="empty-state">
        <div class="icon">📭</div>
        <div class="msg">Sin datos para ${fd(date)}</div>
        <div class="hint">Importá el día usando Shopify o subí un CSV.</div>
      </div>`;
      return;
    }

    const m = data.metrics;
    _skuRows = data.skuMetrics || [];
    _skuSort = { col: null, dir: 1 };
    _skuTotalRevBruto = m.rev_bruto;
    const skuRows = _skuRows;

    // Cargar stock de Simla en background (no bloquea render)
    API.getSimlaStock().then(s => { _simlaStock = s || {}; }).catch(() => {});

    const totalClicks = Object.values(m.clicks_by_platform || {}).reduce((s, v) => s + v, 0);
    const ivaAmt      = m.rev_efectivo - m.net_revenue;
    const pctBruta    = m.rev_bruto    > 0 ? (m.ganancia / m.rev_bruto    * 100) : 0;
    const pctFacEf    = m.rev_efectivo > 0 ? (m.ganancia / m.rev_efectivo * 100) : 0;
    const cpcMedio    = totalClicks    > 0 ? m.ads_total / totalClicks : 0;
    const ratioPct    = totalClicks    > 0 ? m.orders_total / totalClicks * 100 : 0;
    const adsText     = Object.entries(m.ads_by_platform || {})
      .map(([p,v]) => `${platIcon(p)} ${p.charAt(0).toUpperCase()+p.slice(1)} ${fe(v)}`).join(' · ');

    el.innerHTML = prefixHtml + `
    <div id="daily-export-area">

    <!-- ── Cabecera ── -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding:10px 14px;background:var(--lt2);border-radius:8px">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">📊</span>
        <div>
          <div style="font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--md)">Reporte diario — Shopify</div>
          <div style="font-size:20px;font-weight:800;line-height:1.15">${fd(date)}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button class="btn btn-secondary btn-sm" onclick="exportDailyJpg('${date}')">📷 Exportar JPG</button>
        <div style="text-align:right;font-size:10px;color:var(--md)">
          <div>Jupplies Reports</div>
          <div>${new Date().toLocaleString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })}</div>
        </div>
      </div>
    </div>

    <!-- ══ FACTURACIÓN + RESULTADO ══ -->
    <div style="display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr 1fr;gap:10px;margin-bottom:10px">

      <!-- RESULTADO — primera posición, dato más importante -->
      <div class="card" style="text-align:center;padding:18px 16px;border-top:3px solid ${m.ganancia>=0?'var(--gr)':'var(--re)'};background:${m.ganancia>=0?'rgba(26,122,66,.04)':'rgba(192,57,43,.04)'}">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${m.ganancia>=0?'var(--gr)':'var(--re)'};margin-bottom:8px">Resultado del día</div>
        <div style="font-family:'Poppins',sans-serif;font-size:32px;font-weight:800;color:${m.ganancia>=0?'var(--gr)':'var(--re)'};line-height:1.05">${fe(m.ganancia)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:6px">ganancia neta estimada</div>
        <div style="width:100%;height:1px;background:var(--lt2);margin:10px 0"></div>
        <div style="display:flex;flex-direction:column;gap:6px;text-align:left;font-size:11px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="color:var(--md)">Margen neto (s/fac. efectiva − IVA)</span>
            <span style="padding:3px 10px;border-radius:5px;font-size:11px;font-weight:700;background:${m.margen_pct>=15?'rgba(26,122,66,.1)':m.margen_pct>=8?'rgba(255,111,76,.1)':'rgba(192,57,43,.1)'};color:${m.margen_pct>=15?'var(--gr)':m.margen_pct>=8?'var(--or)':'var(--re)'}">${fp(m.margen_pct)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="color:var(--md)">Retorno sobre costo producto</span>
            <span style="padding:3px 10px;border-radius:5px;font-size:11px;font-weight:700;background:${m.sobre_cp_pct>=60?'rgba(26,122,66,.1)':m.sobre_cp_pct>=30?'rgba(255,111,76,.1)':'rgba(192,57,43,.1)'};color:${m.sobre_cp_pct>=60?'var(--gr)':m.sobre_cp_pct>=30?'var(--or)':'var(--re)'}">${fp(m.sobre_cp_pct)}</span>
          </div>
        </div>
      </div>

      <!-- Facturación Bruta -->
      <div class="card" style="text-align:center;padding:18px 16px;border-top:3px solid var(--or);background:#fff8f5">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--or2);margin-bottom:8px">Facturación Bruta</div>
        <div style="font-family:'Poppins',sans-serif;font-size:26px;font-weight:800;color:var(--or);line-height:1.05">${fe(m.rev_bruto)}</div>
        <div style="font-size:11px;color:var(--md);margin-top:6px">${m.orders_total} pedidos</div>
        <div style="width:100%;height:1px;background:rgba(255,111,76,.15);margin:10px 0"></div>
        <div style="display:flex;justify-content:center;gap:12px">
          <div style="text-align:center"><div style="font-size:9px;font-weight:600;color:var(--gr)">COD</div><div style="font-size:13px;font-weight:700;color:var(--gr)">${fe(m.rev_cod_bruto)}</div><div style="font-size:10px;color:var(--md)">${m.orders_cod} ped.</div></div>
          <div style="width:1px;background:var(--lt2)"></div>
          <div style="text-align:center"><div style="font-size:9px;font-weight:600;color:var(--bl)">Paid</div><div style="font-size:13px;font-weight:700;color:var(--bl)">${fe(m.rev_card_bruto)}</div><div style="font-size:10px;color:var(--md)">${m.orders_card} ped.</div></div>
        </div>
      </div>

      <!-- Facturación Efectiva -->
      <div class="card" style="text-align:center;padding:18px 16px;border-top:3px solid var(--or);background:#fff8f5">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--or);margin-bottom:8px">Fac. Efectiva</div>
        <div style="font-family:'Poppins',sans-serif;font-size:26px;font-weight:800;color:var(--or);line-height:1.1">${fe(m.rev_efectivo)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:6px">Paid + COD × efectividad</div>
        <div style="width:100%;height:1px;background:rgba(255,111,76,.15);margin:10px 0"></div>
        <div style="font-size:10px;color:var(--md)">COD estimado efectivo</div>
        <div style="font-size:14px;font-weight:700;color:var(--gr);margin-top:2px">${fe(m.rev_cod_efectivo)}</div>
      </div>

      <!-- Efectividad COD -->
      <div class="card" style="text-align:center;padding:18px 16px;border-top:3px solid var(--gr)">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gr);margin-bottom:8px">Efectividad COD</div>
        <div style="font-family:'Poppins',sans-serif;font-size:28px;font-weight:800;color:var(--dk);line-height:1.05">${fp((m.efec||0)*100)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:6px">confirmados que se entregan</div>
        <div style="width:100%;height:1px;background:var(--lt2);margin:10px 0"></div>
        <div style="font-size:11px">Conf <b>${fp((m.conf_rate||0)*100)}</b> × Entr <b>${fp((m.deliv_rate||0)*100)}</b></div>
      </div>

      <!-- Mix de pago -->
      <div class="card" style="text-align:center;padding:18px 16px;border-top:3px solid var(--bl)">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--bl);margin-bottom:8px">Mix de pago</div>
        <div style="display:flex;justify-content:center;gap:14px;margin-top:4px">
          <div><div style="font-family:'Poppins',sans-serif;font-size:20px;font-weight:800;color:var(--gr);line-height:1.1">${fp(m.pct_cod)}</div><div style="font-size:10px;color:var(--md);margin-top:2px">COD</div></div>
          <div><div style="font-family:'Poppins',sans-serif;font-size:20px;font-weight:800;color:var(--bl);line-height:1.1">${fp(m.pct_card)}</div><div style="font-size:10px;color:var(--md);margin-top:2px">Paid</div></div>
        </div>
        <div style="margin-top:8px;height:8px;border-radius:4px;overflow:hidden;display:flex;background:var(--lt2)">
          <div style="width:${m.pct_cod}%;background:var(--gr);border-radius:4px 0 0 4px"></div>
          <div style="width:${m.pct_card}%;background:var(--bl);border-radius:0 4px 4px 0"></div>
        </div>
        <div style="font-size:10px;color:var(--md);margin-top:6px">Tasa cobro total: ${fp(m.efec_total)}</div>
      </div>

    </div>

    <!-- ══ COSTOS ══ -->
    <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:10px;margin-bottom:10px">

      <!-- Costo Productos -->
      <div class="card" style="text-align:center;padding:14px 12px;border-top:2px solid var(--re)">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--re);margin-bottom:6px">Costo Productos</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800;color:var(--re);line-height:1.1">${fe(m.product_cost)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:4px">${m.rev_bruto > 0 ? (m.product_cost / m.rev_bruto * 100).toFixed(1) : '—'}% sobre facturación bruta</div>
        <div style="width:100%;height:1px;background:rgba(192,57,43,.12);margin:8px 0"></div>
        <div style="font-size:10px;color:var(--md);display:flex;flex-direction:column;gap:2px">
          <div style="display:flex;justify-content:space-between"><span>Paid (100%)</span><span style="font-weight:600">${fe(m.cp_card)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>COD (${fp((m.efec||0)*100)} efec.)</span><span style="font-weight:600">${fe(m.cp_cod)}</span></div>
        </div>
      </div>

      <!-- Costo Envíos -->
      <div class="card" style="text-align:center;padding:14px 12px;border-top:2px solid var(--re)">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--re);margin-bottom:6px">Costo Envíos</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800;color:var(--re);line-height:1.1">${fe(m.shipping_cost + m.cost_rechazos)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:4px">${m.rev_bruto > 0 ? ((m.shipping_cost + m.cost_rechazos) / m.rev_bruto * 100).toFixed(1) : '—'}% sobre facturación bruta</div>
        <div style="width:100%;height:1px;background:rgba(192,57,43,.12);margin:8px 0"></div>
        <div style="font-size:10px;color:var(--md);display:flex;flex-direction:column;gap:2px">
          <div style="display:flex;justify-content:space-between"><span>Envíos ida</span><span style="font-weight:600">${fe((m.shipping_card ?? 0) + (m.shipping_cod ?? 0))}</span></div>
          <div style="display:flex;justify-content:space-between"><span>Rechazos COD (vuelta)</span><span style="font-weight:600;color:var(--re)">${fe(m.cost_rechazos)}</span></div>
        </div>
      </div>

      <!-- IVA -->
      <div class="card" style="text-align:center;padding:14px 12px;border-top:2px solid var(--re)">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--re);margin-bottom:6px">IVA 21%</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800;color:var(--re);line-height:1.1">${fe(ivaAmt)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:4px">${m.rev_bruto > 0 ? (ivaAmt / m.rev_bruto * 100).toFixed(1) : '—'}% sobre facturación bruta</div>
        <div style="width:100%;height:1px;background:rgba(192,57,43,.12);margin:8px 0"></div>
        <div style="font-size:10px;color:var(--md)">Sobre facturación efectiva</div>
      </div>

      <!-- ADS -->
      <div class="card" style="text-align:center;padding:14px 12px;border-top:2px solid var(--re)">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--re);margin-bottom:6px">Gasto ADS</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800;color:var(--re);line-height:1.1">${fe(m.ads_total)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:4px">${m.rev_bruto > 0 ? (m.ads_total / m.rev_bruto * 100).toFixed(1) : '—'}% sobre facturación bruta</div>
        <div style="width:100%;height:1px;background:rgba(192,57,43,.12);margin:8px 0"></div>
        <div style="font-size:10px;color:var(--md);display:flex;flex-direction:column;gap:2px">
          ${Object.entries(m.ads_by_platform || {}).map(([p,v]) => `<div style="display:flex;justify-content:space-between"><span>${platIcon(p)} ${p}</span><span style="font-weight:600">${fe(v)}</span></div>`).join('')}
        </div>
      </div>

    </div>

    <!-- ══ KPIs SECUNDARIOS ══ -->
    <div style="display:grid;grid-template-columns:repeat(6, 1fr);gap:8px;margin-bottom:10px">
      <div class="card" style="text-align:center;padding:12px 10px">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--md);margin-bottom:6px">ROAS Bruto</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800;color:${m.roas>=3?'var(--gr)':m.roas>=2?'var(--or)':'var(--re)'}">${m.roas.toFixed(2)}x</div>
        <div style="font-size:10px;color:var(--md);margin-top:3px">facturación bruta ÷ gasto ADS</div>
      </div>
      <div class="card" style="text-align:center;padding:12px 10px">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--md);margin-bottom:6px">ROAS Real</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800;color:${m.roas_real>=3?'var(--gr)':m.roas_real>=2?'var(--or)':'var(--re)'}">${m.roas_real.toFixed(2)}x</div>
        <div style="font-size:10px;color:var(--md);margin-top:3px">facturación efectiva ÷ gasto ADS</div>
      </div>
      <div class="card" style="text-align:center;padding:12px 10px">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--md);margin-bottom:6px">CPA</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800">${fe(m.cpa)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:3px">gasto ADS ÷ pedidos totales</div>
      </div>
      <div class="card" style="text-align:center;padding:12px 10px">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--md);margin-bottom:6px">AOV</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800">${fe(m.aov)}</div>
        <div style="font-size:10px;color:var(--md);margin-top:3px">ticket medio por pedido</div>
      </div>
      <div class="card" style="text-align:center;padding:12px 10px">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--md);margin-bottom:6px">CPC</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800">${cpcMedio > 0 ? fe(cpcMedio) : '—'}</div>
        <div style="font-size:10px;color:var(--md);margin-top:3px">gasto ADS ÷ clicks totales</div>
      </div>
      <div class="card" style="text-align:center;padding:12px 10px">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--md);margin-bottom:6px">Ratio</div>
        <div style="font-family:'Poppins',sans-serif;font-size:22px;font-weight:800">${ratioPct > 0 ? ratioPct.toFixed(2)+'%' : '—'}</div>
        <div style="font-size:10px;color:var(--md);margin-top:3px">pedidos ÷ clicks (conversión)</div>
      </div>
    </div>

    <!-- ══ P&L POR SKU ══ -->
    <div>
      <div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>P&amp;L por SKU / Grupo</span>
      </div>
      <div class="table-wrap" style="margin-top:8px">
        <table id="sku-tbl" style="table-layout:fixed;width:100%">
          <colgroup>
            <col style="width:18%">
            <col style="width:8%">
            <col style="width:5%">
            <col style="width:14%">
            <col style="width:9%">
            <col style="width:8%">
            <col style="width:8%">
            <col style="width:7%">
            <col style="width:10%">
            <col style="width:7%">
            <col style="width:6%">
          </colgroup>
          <thead>
            <tr>
              <th style="text-align:left" onclick="sortSkuTable(0)">SKU / Grupo</th>
              <th style="text-align:right" onclick="sortSkuTable(1)">Pedidos</th>
              <th style="text-align:right" onclick="sortSkuTable(4)">Uds.</th>
              <th style="text-align:right" onclick="sortSkuTable(5)">Facturación</th>
              <th style="text-align:right" onclick="sortSkuTable(9)">COGS</th>
              <th style="text-align:right" onclick="sortSkuTable(10)">Envío</th>
              <th style="text-align:right" onclick="sortSkuTable(11)">ADS</th>
              <th style="text-align:right">CPA</th>
              <th style="text-align:right" onclick="sortSkuTable(12)">Resultado</th>
              <th style="text-align:right" onclick="sortSkuTable(13)">Margen</th>
              <th style="text-align:right" onclick="sortSkuTable(14)">% s/CP</th>
            </tr>
          </thead>
          <tbody>
            ${renderSkuRows(skuRows, m.rev_bruto)}
          </tbody>
          <tfoot>
            <tr>
              <td style="font-weight:700">TOTAL</td>
              <td style="text-align:right"><span style="font-weight:700">${m.orders_total}</span> <span style="font-size:10px;color:var(--md)">💳${m.orders_card} · 💵${m.orders_cod}</span></td>
              <td style="text-align:right"></td>
              <td style="text-align:right;font-weight:700">${fe(m.rev_bruto)}</td>
              <td style="text-align:right" class="text-red">${fe(m.product_cost)}</td>
              <td style="text-align:right" class="text-red">${fe(m.shipping_cost)}</td>
              <td style="text-align:right" class="text-red">${fe(m.ads_total)}</td>
              <td style="text-align:right">${fe(m.cpa)}</td>
              <td style="text-align:right;font-weight:700" class="${m.ganancia >= 0 ? 'text-green' : 'text-red'}">${fe(m.ganancia)}</td>
              <td style="text-align:right">${fp(m.margen_pct)}</td>
              <td style="text-align:right" class="${pctClass(m.sobre_cp_pct)}">${fp(m.sobre_cp_pct)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    </div><!-- #daily-export-area -->

      <!-- Alerta de gasto sin tracking — fuera del área de exportación -->
      ${(() => {
        const untracked = skuRows.filter(s => s.is_sin_tracking);
        if (untracked.length === 0) return '';
        const totalUntracked = untracked.reduce((s, r) => s + r.ads, 0);
        const pctOfAds = m.ads_total > 0 ? (totalUntracked / m.ads_total * 100).toFixed(0) : 0;
        return `<div style="background:rgba(245,158,11,.08);border:1.5px solid rgba(245,158,11,.3);border-radius:8px;padding:10px 16px;margin-top:10px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:16px">⚠️</span>
          <div style="flex:1;min-width:200px">
            <span style="font-weight:700;color:var(--fg)">${fe(totalUntracked)}</span>
            <span style="font-size:13px;color:var(--md)"> en ${untracked.length} campaña${untracked.length > 1 ? 's' : ''} sin grupo SKU asignado (${pctOfAds}% del gasto ADS)</span>
          </div>
          <a onclick="showPage('campaigns')" style="font-size:12px;font-weight:600;color:#2563eb;cursor:pointer;text-decoration:underline;white-space:nowrap">
            🎯 Asignar grupos en Campañas →
          </a>
        </div>`;
      })()}
    `;
  } catch (err) {
    showError(el, err.message);
  }
}

function kpiCard(label, value, sub, color) {
  return `<div class="kpi-card ${color}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
}

function adsBreakdown(byPlatform) {
  if (!byPlatform) return '';
  return Object.entries(byPlatform)
    .map(([p, v]) => `${p}: ${fe(v)}`).join(' · ');
}

function platIcon(plat) {
  const icons = { meta: '📘', tiktok: '🎵', google: '🔍' };
  return icons[plat] || '📣';
}

async function uploadShopifyCsv(input) {
  const file = input.files[0];
  if (!file) return;

  const date = document.getElementById('daily-date').value;
  if (!date) return alert('Seleccioná una fecha primero');

  const text = await file.text();
  const rows = parseShopifyCsv(text);

  if (rows.length === 0) return alert('No se encontraron pedidos en el CSV');

  try {
    const result = await API.importShopifyCsv(date, rows);
    alert(`Importados ${result.imported} registros`);
    await renderDayReport(date);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

function parseShopifyCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    const row = {};
    header.forEach((h, j) => row[h] = cols[j] || '');

    if (!row['name'] && !row['order_name']) continue;

    rows.push({
      order_name:   row['name'] || row['order_name'],
      payment_type: (row['financial status'] || row['payment_status'] || 'paid').toLowerCase() === 'pending' ? 'cod' : 'card',
      order_total:  parseFloat(row['total'] || row['order_total'] || 0),
      sku:          row['lineitem sku'] || row['sku'] || '',
      qty:          parseInt(row['lineitem quantity'] || row['quantity'] || 1),
      price:        parseFloat(row['lineitem price'] || row['price'] || 0),
    });
  }

  return rows.filter(r => r.sku);
}

// ── Export JPG ─────────────────────────────────────────────────────────────────

async function exportDailyJpg(date) {
  const area = document.getElementById('daily-export-area');
  if (!area) return;

  const btn = document.querySelector('button[onclick^="exportDailyJpg"]');
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
    link.download = `Reporte_${date}.jpg`;
    link.href = canvas.toDataURL('image/jpeg', 0.92);
    link.click();
  } catch (err) {
    alert('Error al exportar: ' + err.message);
  } finally {
    if (btn) btn.textContent = orig;
  }
}
