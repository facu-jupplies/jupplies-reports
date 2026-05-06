// ╔══════════════════════════════════════════════════════════════════════╗
// ║ Muestras TTS — 2 paneles:                                            ║
// ║ Panel A (arriba): afiliados con muestras en el período + sus ventas  ║
// ║ Panel B (abajo):  mapeos pendientes Nombre Simla → @handle TikTok    ║
// ╚══════════════════════════════════════════════════════════════════════╝

let _samplesState = {
  from: null,
  to:   null,
  affiliatesData: null,
  mappingsData:   null,
  // Sort por columna: { col: 'facturacion'|'roas_total'|..., dir: 'asc'|'desc' }
  // null = default (date_desc)
  sortCol: null,
  sortDir: 'desc',
  search: '',
  // Toggle: cuando ON, oculta afiliados con orders_matched=0 y todas las
  // métricas T se reemplazan por las matched (ventas del grupo de muestra).
  matchedOnly: false,
  allHandles: [],  // lista de todos los handles conocidos para autocomplete
  expanded: new Set(),  // handles de filas expandidas inline
  // Filtros del panel B (mapeos)
  mappingsSearch:    '',
  mappingsSort:      'recent',     // recent | samples | name | handle
  mappingsCollapsed: true,         // panel "asignados" colapsado por defecto si hay >20
  // Navegación list ↔ detail
  viewMode: 'list',            // 'list' | 'detail'
  selectedHandle: null,
  detailData: null,
};

// ─── Formatters ─────────────────────────────────────────────────────────
const ttsmEur  = n => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n || 0);
const ttsmPct  = n => n == null ? '—' : `${(n).toFixed(1).replace('.', ',')}%`;
const ttsmInt  = n => (Number(n) || 0).toLocaleString('es-ES');
const ttsmDate = s => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }).replace('.', '') : '—';

// "hace 2 horas" / "hace 3 días" / "hace un momento"
function ttsmRelative(isoStr) {
  if (!isoStr) return null;
  // SQLite datetime('now') es UTC sin zona; tratamos como UTC.
  const t = isoStr.includes('T') ? new Date(isoStr) : new Date(isoStr.replace(' ', 'T') + 'Z');
  const diffMs = Date.now() - t.getTime();
  if (isNaN(diffMs) || diffMs < 0) return null;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60)        return 'hace un momento';
  const min = Math.floor(sec / 60);
  if (min < 60)        return `hace ${min} min`;
  const hr  = Math.floor(min / 60);
  if (hr < 24)         return `hace ${hr} h`;
  const d   = Math.floor(hr / 24);
  if (d < 30)          return `hace ${d} día${d !== 1 ? 's' : ''}`;
  const mo  = Math.floor(d / 30);
  return `hace ${mo} mes${mo !== 1 ? 'es' : ''}`;
}

function escAttr(s) {
  return (s == null ? '' : String(s))
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}

// ─── Normalización de grupos a familia ────────────────────────────────────
// El SKU/grupo tiene variantes de color, talle y cantidades que rompen el match
// directo entre muestra recibida y producto vendido. Normalizamos en 3 niveles:
//
//   groupFamily: corta `;` (suffix combos como ;PATAS), quita `*N` (cantidades)
//                y `-` final. Ej: "BANE-TER-GR;PATAS" → "BANE-TER-GR"
//
//   groupRoot:   adicional, quita el último componente -XY/-XYZ (2-3 letras
//                MAYÚSCULAS) — típico de colores y variantes cortas (-GR, -RO,
//                -AA, -BB, -NEG, -BLA). Ej: "BANE-TER-GR" → "BANE-TER".
//                Riesgo: si el SKU termina en abreviatura legítima (ej -GYM),
//                igual la corta. Lo aceptamos como heurística — los false
//                positives son raros y solo afectan al "received" verde/gris.
//
//   matchesGroupFamily(a, b): true si a≡b en cualquier nivel, o si uno es
//                prefijo a nivel componente del otro (ej "BANE" ↔ "BANE-TER-RO").
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
  // Quitar último componente si es 2-3 letras mayúsculas (variante/color)
  // Sólo si lo que queda es razonable (>= 3 chars)
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
  // Prefijo a nivel componente: "BANE" ↔ "BANE-TER-X"
  if (fa && fb && (fb.startsWith(fa + '-') || fa.startsWith(fb + '-'))) return true;
  if (ra && rb && (rb.startsWith(ra + '-') || ra.startsWith(rb + '-'))) return true;
  return false;
}

// ─── Entry ──────────────────────────────────────────────────────────────
function loadTTSSamples() {
  if (!_samplesState.from) {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    _samplesState.from = `${y}-${m}-01`;
    _samplesState.to   = today.toISOString().slice(0, 10);
  }
  // Siempre volvemos al listado al entrar
  _samplesState.viewMode = 'list';
  _samplesState.selectedHandle = null;
  renderShell();
  refreshAll();
}

function renderShell() {
  const el = document.getElementById('page-tts-samples');
  if (!el) return;
  el.classList.remove('ttsm-scope');

  if (_samplesState.viewMode === 'detail') {
    renderDetailShell();
  } else {
    renderListShell();
  }
}

function renderListShell() {
  const el = document.getElementById('page-tts-samples');
  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-title">🎁 Muestras TTS</div>
      <div class="page-subtitle">
        Afiliados con muestras + mapeos Nombre Simla → TikTok
        <span style="cursor:help;color:var(--md);font-size:11px;margin-left:6px"
              title="Las muestras vienen de Simla (pedidos con tag &quot;Free sample&quot;).&#10;Las ventas vienen de los CSVs de afiliados que subís en la pestaña TTS.&#10;El @handle se asigna manualmente (debajo) o automáticamente desde comentarios Simla.">ⓘ</span>
      </div>
      <div id="ttsm-last-sync" style="font-size:11px;color:var(--md);margin-top:2px"></div>
    </div>
    <div class="flex gap-8 items-center">
      <div class="form-group">
        <label>Desde</label>
        <input type="date" id="ttsm-from" value="${_samplesState.from}"
               onchange="ttsmApplyFilter()" style="width:140px">
      </div>
      <div class="form-group">
        <label>Hasta</label>
        <input type="date" id="ttsm-to" value="${_samplesState.to}"
               onchange="ttsmApplyFilter()" style="width:140px">
      </div>
      <div style="margin-top:16px;display:flex;gap:6px">
        <button class="btn btn-primary" onclick="ttsmScanSimla()"
                title="Pega a la API de Simla, detecta pedidos con tag &quot;Free sample&quot; en el rango de fechas, y los guarda en la DB local.&#10;Ejecutalo cuando hayas mandado nuevas muestras desde Simla.">
          🔄 Sync Simla → muestras
        </button>
        <button class="btn btn-secondary" onclick="document.getElementById('ttsm-csv-input').click()"
                title="Subí 1 o más CSVs de afiliados de TikTok. Detecta las fechas automáticamente y persiste en tts_affiliate_orders.">
          📤 Subir CSV ventas
        </button>
        <input type="file" id="ttsm-csv-input" accept=".csv,text/csv" multiple style="display:none"
               onchange="ttsmUploadCSVs(this.files); this.value=''">
      </div>
    </div>
  </div>

  <div id="ttsm-affiliates"><div class="loading">Cargando afiliados...</div></div>
  <div id="ttsm-mappings" style="margin-top:20px"><div class="loading">Cargando mapeos...</div></div>`;
}

// ─── Navegación ─────────────────────────────────────────────────────────
function openAffiliateDetail(handle) {
  _samplesState.viewMode = 'detail';
  _samplesState.selectedHandle = handle;
  _samplesState.detailData = null;
  renderShell();
  fetchDetail();
}

function backToList() {
  _samplesState.viewMode = 'list';
  _samplesState.selectedHandle = null;
  _samplesState.detailData = null;
  renderShell();
  refreshAll();
}

function ttsmApplyFilter() {
  _samplesState.from = document.getElementById('ttsm-from').value;
  _samplesState.to   = document.getElementById('ttsm-to').value;
  refreshAll();
}

async function refreshAll() {
  await Promise.all([
    fetchAffiliates(),
    fetchMappings(),
  ]);
}

async function ttsmScanSimla() {
  const from = document.getElementById('ttsm-from').value;
  const to   = document.getElementById('ttsm-to').value;
  if (!from || !to) { alert('Definí el rango primero'); return; }
  const btn = event.target.closest('button');
  const orig = btn.textContent;
  btn.textContent = '⏳ Escaneando...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/tts/samples/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error');
    alert(`Escaneo OK\nDetectadas: ${json.detected}\nNuevas: ${json.inserted}\nActualizadas: ${json.updated}`);
    refreshAll();
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

// ─── Subir CSVs de afiliados desde la UI ────────────────────────────────
// Acepta múltiples archivos. Cada uno se parsea y persiste agrupado por
// fecha (los CSVs de TikTok suelen traer varios días en un solo export).
async function ttsmUploadCSVs(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const btn = event.target.closest('button') ||
              document.querySelector('button[onclick*="ttsm-csv-input"]');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Subiendo...'; }

  const summary = { ok: 0, errors: 0, byDate: {}, totalRows: 0, range: { from: null, to: null } };
  try {
    for (const file of files) {
      try {
        const csvText = await file.text();
        const res = await fetch('/api/tts/affiliate-orders/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csvText, filename: file.name }),
        });
        const json = await res.json();
        if (!res.ok) {
          summary.errors++;
          console.warn(`[upload] ${file.name}: ${json.error}`);
          continue;
        }
        summary.ok++;
        summary.totalRows += json.totalRows || 0;
        for (const [d, n] of Object.entries(json.byDate || {})) {
          summary.byDate[d] = (summary.byDate[d] || 0) + n;
        }
        if (json.dateRange?.from) {
          if (!summary.range.from || json.dateRange.from < summary.range.from) summary.range.from = json.dateRange.from;
          if (!summary.range.to   || json.dateRange.to   > summary.range.to)   summary.range.to   = json.dateRange.to;
        }
      } catch (e) {
        summary.errors++;
        console.warn(`[upload] ${file.name}: ${e.message}`);
      }
    }
    const dates = Object.keys(summary.byDate).sort();
    const lines = [
      `✅ ${summary.ok}/${files.length} archivos importados`,
      summary.errors > 0 ? `❌ ${summary.errors} errores (ver consola)` : '',
      `${summary.totalRows} ventas cargadas en ${dates.length} día${dates.length === 1 ? '' : 's'}`,
      summary.range.from ? `Rango: ${summary.range.from} → ${summary.range.to}` : '',
    ].filter(Boolean);
    alert(lines.join('\n'));
    refreshAll();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// PANEL A — Afiliados con muestras en el período
// ═══════════════════════════════════════════════════════════════════════

async function fetchAffiliates() {
  try {
    const params = new URLSearchParams({ from: _samplesState.from, to: _samplesState.to });
    const res = await fetch(`/api/tts/samples/affiliates?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    _samplesState.affiliatesData = data;
    renderAffiliatesPanel(data);
    // Mostrar última sync (sólo lo ven en la lista, no en el detalle)
    const lastSyncEl = document.getElementById('ttsm-last-sync');
    if (lastSyncEl) {
      const rel = ttsmRelative(data.last_scan_at);
      lastSyncEl.innerHTML = rel
        ? `📡 Última sync con Simla: <strong>${rel}</strong> <span style="color:var(--md);font-size:10px">(${data.last_scan_at})</span>`
        : `<span style="color:var(--or)">⚠ Sin muestras escaneadas en este rango — apretá <strong>Sync Simla</strong> para traerlas</span>`;
    }
  } catch (err) {
    document.getElementById('ttsm-affiliates').innerHTML =
      `<div class="empty-state"><div class="icon">⚠️</div><div class="msg">Error afiliados: ${err.message}</div></div>`;
  }
}

function renderAffiliatesPanel(d) {
  const el = document.getElementById('ttsm-affiliates');
  const t = d.totals;

  if (d.affiliates.length === 0) {
    el.innerHTML = `
    <div class="empty-state" style="padding:40px 20px">
      <div class="icon">🎁</div>
      <div class="msg">No hay afiliados con muestras en el período</div>
      <div class="hint">Probá un rango más amplio o apretá "Sync Simla → muestras"</div>
    </div>`;
    return;
  }

  // ROIA neto coherente con la vista de detalle (sin contar comisión como inversión)
  const inversion     = t.samples_cost || 0;
  const beneficioNeto = (t.facturacion || 0) - (t.commission || 0) - inversion;
  const roiaNet       = inversion > 0 && t.orders > 0
    ? Math.round((beneficioNeto / inversion) * 1000) / 10
    : null;
  const roiaStyle = roiaNet == null ? 'color:var(--md)' :
                    (roiaNet >= 50 ? 'color:var(--gr)' :
                    (roiaNet >= 0  ? 'color:var(--bl)' : 'color:var(--re)'));
  const roiaCardClass = roiaNet == null ? '' : (roiaNet >= 0 ? 'green' : 'red');
  const noSales = t.orders === 0;

  el.innerHTML = `
  <!-- KPI cards -->
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:12px">
    <div class="kpi-card orange">
      <div class="kpi-label">🎁 Muestras</div>
      <div class="kpi-value">${ttsmInt(t.samples)}</div>
      <div class="kpi-sub">${ttsmInt(t.affiliates)} afiliados · ${ttsmEur(t.samples_cost)}</div>
    </div>
    <div class="kpi-card blue">
      <div class="kpi-label">🛒 Pedidos atribuidos</div>
      <div class="kpi-value">${ttsmInt(t.orders)}</div>
      <div class="kpi-sub">${noSales ? 'esperando ventas (90d)' : `${t.orders_org} org · ${t.orders_paid} paid`}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">💰 Facturación</div>
      <div class="kpi-value">${ttsmEur(t.facturacion)}</div>
      <div class="kpi-sub">− Comisión afil.: ${ttsmEur(t.commission)}</div>
    </div>
    <div class="kpi-card" title="Lo que sale de tu bolsillo: solo muestras (cogs + envío)">
      <div class="kpi-label">📊 Inversión</div>
      <div class="kpi-value">${ttsmEur(inversion)}</div>
      <div class="kpi-sub">muestras (cogs + envío)</div>
    </div>
    <div class="kpi-card ${roiaCardClass}"
         title="ROIA neto: (Facturación − Comisión − Inversión) / Inversión">
      <div class="kpi-label">📈 ROIA neto</div>
      <div class="kpi-value" style="${roiaStyle}">${roiaNet == null ? '—' : ttsmPct(roiaNet)}</div>
      <div class="kpi-sub">${noSales ? 'pendiente' : 'benef. neto: ' + ttsmEur(beneficioNeto)}</div>
    </div>
  </div>

  <!-- Controles -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px">
    <div class="section-title" style="margin:0">Afiliados con muestras · ${d.affiliates.length}</div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="text" placeholder="Buscar..." id="ttsm-search"
             value="${_samplesState.search}" oninput="_samplesState.search=this.value;rerenderAffiliatesTable()"
             style="padding:5px 10px;font-size:12px;border:1px solid var(--lt2);border-radius:4px;width:180px">
      <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;padding:4px 10px;border:1px solid var(--lt2);border-radius:4px;background:${_samplesState.matchedOnly ? 'rgba(33,163,102,.12)' : 'var(--wh)'};font-weight:${_samplesState.matchedOnly ? '600' : '400'}"
             title="Filtra afiliados sin ventas matched (mismo grupo familia que la muestra). Las cifras pasan a mostrar sólo las ventas matched.">
        <input type="checkbox" ${_samplesState.matchedOnly ? 'checked' : ''}
               onchange="_samplesState.matchedOnly=this.checked;rerenderAffiliatesTable()"
               style="margin:0">
        🎯 Solo coincidencia
      </label>
    </div>
  </div>

  <div class="table-wrap" id="ttsm-affil-table">${renderAffiliatesTable(d.affiliates)}</div>`;
}

function rerenderAffiliatesTable() {
  if (!_samplesState.affiliatesData) return;
  const wrap = document.getElementById('ttsm-affil-table');
  if (wrap) wrap.innerHTML = renderAffiliatesTable(_samplesState.affiliatesData.affiliates);
}

// Sort por click en header de columna. Click toggle asc/desc, doble click vuelve a default.
function ttsmSort(col) {
  if (_samplesState.sortCol === col) {
    _samplesState.sortDir = _samplesState.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    _samplesState.sortCol = col;
    _samplesState.sortDir = 'desc';
  }
  rerenderAffiliatesTable();
}

// Devuelve el valor a comparar para una columna dada.
function _affilSortValue(a, col) {
  switch (col) {
    case 'date':       return a.first_sample_date || '';
    case 'handle':     return (a.tiktok_username || '').toLowerCase();
    case 'pedidos':    return _samplesState.matchedOnly ? a.orders_matched      : a.orders;
    case 'videos':     return _samplesState.matchedOnly ? a.videos_matched      : a.videos;
    case 'facturacion':return _samplesState.matchedOnly ? a.facturacion_matched : a.facturacion;
    case 'inversion':  return a.inversion;
    case 'roas':       {
      const v = _samplesState.matchedOnly ? a.roas_matched : a.roas_total;
      return v == null ? -Infinity : v;
    }
    case 'days':       return a.days_since_last_sample == null ? -Infinity : a.days_since_last_sample;
    default:           return a.first_sample_date || '';
  }
}

function sortAffiliates(rows) {
  const col = _samplesState.sortCol || 'date';
  const dir = _samplesState.sortDir;
  const copy = rows.slice();
  const byHandle = (a, b) => (a.tiktok_username || '').localeCompare(b.tiktok_username || '');
  copy.sort((a, b) => {
    const va = _affilSortValue(a, col);
    const vb = _affilSortValue(b, col);
    let cmp;
    if (typeof va === 'string') cmp = va.localeCompare(vb);
    else                        cmp = (va || 0) - (vb || 0);
    if (cmp === 0) return byHandle(a, b);
    return dir === 'desc' ? -cmp : cmp;
  });
  return copy;
}

function filterAffiliates(rows, q) {
  const query = (q || '').toLowerCase().trim();
  let out = rows;
  // Toggle "Solo coincidencia": esconde afiliados sin ventas matched
  if (_samplesState.matchedOnly) {
    out = out.filter(a => (a.orders_matched || 0) > 0);
  }
  if (query) {
    out = out.filter(a =>
      (a.tiktok_username || '').toLowerCase().includes(query) ||
      (a.customer_name   || '').toLowerCase().includes(query) ||
      a.skus_received.some(s => (s || '').toLowerCase().includes(query)) ||
      (a.skus_sold || []).some(s => (s || '').toLowerCase().includes(query))
    );
  }
  return out;
}

// Renderiza una flecha en el header indicando si la columna está activa
function _sortArrow(col) {
  if (_samplesState.sortCol !== col) return '<span style="color:var(--md);opacity:.4">⇅</span>';
  return _samplesState.sortDir === 'desc' ? '▼' : '▲';
}

// Helper: formatea ROAS como Nx con color según valor
function ttsmRoas(v) {
  if (v == null) return '—';
  return v.toFixed(2).replace('.', ',') + 'x';
}
function _roasStyle(v) {
  if (v == null) return 'color:var(--md)';
  if (v >= 5)  return 'color:var(--gr);font-weight:700';
  if (v >= 1)  return 'color:var(--bl);font-weight:600';
  return 'color:var(--re);font-weight:600';
}

function renderAffiliatesTable(rows) {
  if (!rows || rows.length === 0) return '<div style="padding:40px;text-align:center;color:var(--md)">Sin afiliados</div>';
  const filtered = filterAffiliates(rows, _samplesState.search);
  const sorted = sortAffiliates(filtered);

  // Header clickeable: cada th invoca ttsmSort(col).
  // Cuando matchedOnly está activo, las columnas T/C colapsan a sólo C
  // (porque "matched only" significa que estás viendo solo esa cifra).
  const matchedOnly = _samplesState.matchedOnly;
  const thStyle = 'cursor:pointer;user-select:none';

  return `
  <table style="width:100%;table-layout:auto">
    <thead>
      <tr>
        <th style="${thStyle}" onclick="ttsmSort('handle')">Afiliado ${_sortArrow('handle')}</th>
        <th>SKUs recibidos</th>
        <th>SKUs vendidos</th>
        <th class="text-right" style="${thStyle}" onclick="ttsmSort('pedidos')" title="Pedidos en el período. Cuando 'Solo coincidencia' está activo, sólo cuenta los del grupo de la muestra.">Pedidos ${_sortArrow('pedidos')}</th>
        <th class="text-right" style="${thStyle}" onclick="ttsmSort('videos')" title="Videos distintos del afiliado">Vids ${_sortArrow('videos')}</th>
        <th class="text-right" style="${thStyle}" onclick="ttsmSort('facturacion')" title="Facturación: ${matchedOnly ? 'sólo ventas matched' : 'total / matched (entre paréntesis las del grupo de muestra)'}">Facturación ${_sortArrow('facturacion')}</th>
        <th class="text-right" style="${thStyle}" onclick="ttsmSort('inversion')" title="Costo muestras (cogs + envío)">Inversión ${_sortArrow('inversion')}</th>
        <th class="text-right" style="${thStyle}" onclick="ttsmSort('roas')" title="ROAS = Facturación / Inversión. ${matchedOnly ? 'Sólo ventas matched.' : 'Total y matched.'}">ROAS ${_sortArrow('roas')}</th>
        <th class="text-right" style="${thStyle}" onclick="ttsmSort('days')" title="Días desde el último envío de muestra. Útil para evaluar afiliados sin ventas.">Envío ${_sortArrow('days')}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${sorted.map(renderAffiliateRow).join('')}
    </tbody>
  </table>`;
}

// Chip helper para SKUs con colores según match
function renderSkuChip(sku, variant) {
  const styles = {
    received: 'background:rgba(239,90,44,.1);color:#c3410f;border:1px solid rgba(239,90,44,.25)',
    sold_match: 'background:rgba(33,163,102,.12);color:#1a7a4f;border:1px solid rgba(33,163,102,.3)',
    sold_extra: 'background:rgba(100,116,139,.1);color:#475569;border:1px solid rgba(100,116,139,.25)',
  };
  const titles = {
    received: 'Recibió muestra de este SKU',
    sold_match: 'Vendió el mismo producto que recibió',
    sold_extra: 'Vende pero no recibió muestra de este SKU',
  };
  return `<span style="display:inline-block;padding:1px 6px;margin:1px 2px 1px 0;font-size:10px;${styles[variant]};border-radius:3px;font-family:monospace;white-space:nowrap" title="${titles[variant]}">${sku}</span>`;
}

const SKU_TRUNCATE = 2;  // mostrar hasta N SKUs en fila colapsada

function ttsmToggleRow(handle) {
  if (_samplesState.expanded.has(handle)) _samplesState.expanded.delete(handle);
  else _samplesState.expanded.add(handle);
  rerenderAffiliatesTable();
}

function renderAffiliateRow(a) {
  const isExpanded = _samplesState.expanded.has(a.tiktok_username);
  const receivedList = a.skus_received || [];
  const soldList     = a.skus_sold     || [];
  const matchedOnlyMode = _samplesState.matchedOnly;

  // Match a nivel familia (no exact): "BANE-TER-GR" recibido machea con
  // "BANE-TER-RO" vendido (mismo modelo, distinto color).
  const isSkuMatched = (skuVendido) =>
    receivedList.some(rec => matchesGroupFamily(rec, skuVendido));

  // ── SKUs recibidos (truncado o completo según expand) ──
  const recvToShow = isExpanded ? receivedList : receivedList.slice(0, SKU_TRUNCATE);
  const skusRecvHtml = recvToShow.map(sku => renderSkuChip(sku, 'received')).join('');
  const skuRecvMore = !isExpanded && receivedList.length > SKU_TRUNCATE
    ? `<span style="font-size:10px;color:var(--md);font-weight:600">+${receivedList.length - SKU_TRUNCATE}</span>`
    : '';
  const skusRecvEmpty = receivedList.length === 0
    ? '<span style="color:var(--md);font-size:11px">—</span>'
    : '';

  // ── SKUs vendidos: verde = misma familia que recibido, gris = otro producto.
  // Cuando matchedOnly está activo, ocultamos los grises (no atribuibles).
  const soldFiltered = matchedOnlyMode ? soldList.filter(isSkuMatched) : soldList;
  const soldToShow   = isExpanded ? soldFiltered : soldFiltered.slice(0, SKU_TRUNCATE);
  const skusSoldHtml = soldToShow.map(sku => {
    const matched = isSkuMatched(sku);
    return renderSkuChip(sku, matched ? 'sold_match' : 'sold_extra');
  }).join('');
  const skuSoldMore = !isExpanded && soldFiltered.length > SKU_TRUNCATE
    ? `<span style="font-size:10px;color:var(--md);font-weight:600">+${soldFiltered.length - SKU_TRUNCATE}</span>`
    : '';
  const skuSoldEmpty = soldFiltered.length === 0
    ? '<span style="color:var(--md);font-size:11px">—</span>'
    : '';

  const matchedOnly = _samplesState.matchedOnly;
  const inversionA  = a.inversion || a.samples_cost || 0;

  const toggleBtn = `
    <div style="display:flex;gap:3px;justify-content:flex-end">
      <button class="btn btn-secondary btn-sm"
              onclick="ttsmToggleRow('${a.tiktok_username}')"
              style="font-size:10px;padding:2px 6px"
              title="${isExpanded ? 'Mostrar menos SKUs' : 'Mostrar todos los SKUs'}">
        ${isExpanded ? '▲' : '▼'}
      </button>
      <button class="btn btn-primary btn-sm"
              onclick="openAffiliateDetail('${a.tiktok_username}')"
              style="font-size:10px;padding:2px 8px"
              title="Ver detalle del afiliado">
        Ver →
      </button>
    </div>`;

  // Bloque afiliado: handle + customer + fecha de envío en pequeño
  const afilCell = `
    <td>
      <div style="font-weight:600;font-family:'Poppins',sans-serif">@${a.tiktok_username}</div>
      ${a.customer_name ? `<div style="font-size:11px;color:var(--md);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.customer_name}</div>` : ''}
      <div style="font-size:10px;color:var(--md)">📦 ${ttsmDate(a.first_sample_date)}${a.samples_received > 1 ? ` · ${a.samples_received} muestras` : ''}</div>
    </td>`;

  // Días desde el envío. En color rojo si pasaron muchos sin venta.
  const days = a.days_since_last_sample;
  const daysCell = days == null
    ? '<span style="color:var(--md)">—</span>'
    : a.orders === 0 && days >= 7
      ? `<span style="color:var(--re);font-weight:600" title="Sin ventas tras ${days} días — revisar si el afiliado está activo">${days}d ⚠</span>`
      : `<span style="color:var(--md)">${days}d</span>`;

  // Si no tiene ventas atribuidas: misma estructura de columnas que las filas
  // con datos (sin colspan). Cada celda muestra "—" o el dato relevante para
  // mantener alineación visual con el resto de la tabla.
  if (a.orders === 0) {
    const dash = '<span style="color:var(--md)">—</span>';
    const waitingChip = `<span style="color:var(--md);font-size:11px;font-style:italic" title="Esperando ventas atribuidas en el período">⏳ esperando</span>`;
    return `
    <tr style="background:rgba(0,0,0,.015)">
      ${afilCell}
      <td style="vertical-align:top">${skusRecvHtml}${skuRecvMore}${skusRecvEmpty}</td>
      <td style="vertical-align:top">${dash}</td>
      <td class="text-right">${waitingChip}</td>
      <td class="text-right">${a.videos > 0 ? `<strong>${a.videos}</strong>` : dash}</td>
      <td class="text-right">${dash}</td>
      <td class="text-right">${ttsmEur(inversionA)}</td>
      <td class="text-right">${dash}</td>
      <td class="text-right" style="font-size:11px">${daysCell}</td>
      <td class="text-right">${toggleBtn}</td>
    </tr>`;
  }

  // Pedidos: total con split paid/org. Si matchedOnly, solo la cifra matched.
  const pedidosCell = matchedOnly
    ? `<strong>${a.orders_matched}</strong>`
    : `<strong>${a.orders}</strong>${a.orders_matched < a.orders
        ? ` <small style="color:var(--gr);font-size:10px" title="Ventas matched (mismo grupo de muestra)">· ${a.orders_matched}m</small>`
        : ''}
       <div style="font-size:9px;color:var(--md)">
         ${a.orders_paid > 0 ? a.orders_paid + 'p' : ''}${a.orders_paid>0 && a.orders_org>0 ? '/' : ''}${a.orders_org > 0 ? a.orders_org + 'o' : ''}
       </div>`;

  // Videos: total / matched
  const videosCell = matchedOnly
    ? `<strong>${a.videos_matched}</strong>`
    : a.videos_matched < a.videos
      ? `<strong>${a.videos}</strong> <small style="color:var(--gr);font-size:10px">·${a.videos_matched}m</small>`
      : `<strong>${a.videos}</strong>`;

  // Facturación: total / matched
  const factTotal   = a.facturacion;
  const factMatched = a.facturacion_matched;
  const facturacionCell = matchedOnly
    ? `<strong>${ttsmEur(factMatched)}</strong>`
    : factMatched < factTotal
      ? `<strong>${ttsmEur(factTotal)}</strong>
         <div style="font-size:10px;color:var(--gr);font-weight:600" title="Facturación matched (grupo muestra)">${ttsmEur(factMatched)} match</div>`
      : `<strong>${ttsmEur(factTotal)}</strong>`;

  // ROAS: total / matched. Estilo según valor.
  const roasT = a.roas_total;
  const roasM = a.roas_matched;
  const roasMain  = matchedOnly ? roasM : roasT;
  const roasCell = matchedOnly
    ? `<span style="${_roasStyle(roasM)}">${ttsmRoas(roasM)}</span>`
    : `<span style="${_roasStyle(roasT)}">${ttsmRoas(roasT)}</span>${
        (roasM != null && roasT != null && Math.abs(roasM - roasT) > 0.01)
          ? `<div style="font-size:10px;color:var(--gr)" title="ROAS matched (grupo muestra)">${ttsmRoas(roasM)} match</div>`
          : ''}`;

  return `
  <tr>
    ${afilCell}
    <td style="vertical-align:top">${skusRecvHtml}${skuRecvMore}${skusRecvEmpty}</td>
    <td style="vertical-align:top">${skusSoldHtml}${skuSoldMore}${skuSoldEmpty}</td>
    <td class="text-right">${pedidosCell}</td>
    <td class="text-right">${videosCell}</td>
    <td class="text-right">${facturacionCell}</td>
    <td class="text-right">${ttsmEur(inversionA)}</td>
    <td class="text-right">${roasCell}</td>
    <td class="text-right" style="font-size:11px">${daysCell}</td>
    <td class="text-right">${toggleBtn}</td>
  </tr>`;
}

// ═══════════════════════════════════════════════════════════════════════
// PANEL B — Mapeos Nombre Simla → @handle TikTok
// ═══════════════════════════════════════════════════════════════════════

async function fetchMappings() {
  try {
    const res = await fetch('/api/tts/mappings');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    _samplesState.mappingsData = data;

    // Guardar todos los handles conocidos para el autocomplete
    const handles = new Set();
    for (const m of data.mapped)   handles.add(m.tiktok_username);
    for (const u of data.unmapped) for (const c of (u.candidates || [])) handles.add(c.tiktok_username);
    _samplesState.allHandles = [...handles].sort();

    renderMappingsPanel(data);
  } catch (err) {
    document.getElementById('ttsm-mappings').innerHTML =
      `<div class="empty-state"><div class="icon">⚠️</div><div class="msg">Error mapeos: ${err.message}</div></div>`;
  }
}

function renderMappingsPanel(d) {
  const el = document.getElementById('ttsm-mappings');

  const unassignedSamples = d.unmapped.reduce((s, u) => s + u.sample_count, 0);
  const unassignedCost    = d.unmapped.reduce((s, u) => s + u.total_cost, 0);

  const datalist = `
    <datalist id="ttsm-handles-dl">
      ${_samplesState.allHandles.map(h => `<option value="${h}">`).join('')}
    </datalist>`;

  el.innerHTML = `
  ${datalist}

  <div style="margin-bottom:10px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
    <div>
      <div class="section-title" style="margin:0 0 4px 0">Mapeos Nombre Simla → @handle TikTok</div>
      <div style="font-size:11px;color:var(--md)">
        Asignás una vez y se aplica a todas las muestras pasadas y futuras del cliente. Independiente del filtro de fechas.
      </div>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      <a href="/api/tts/mappings/export"
         class="btn btn-secondary"
         style="font-size:12px;padding:6px 10px;text-decoration:none"
         title="Descarga un CSV con todos los mapeos confirmados (backup completo)">
        💾 Backup CSV
      </a>
      <button class="btn btn-secondary"
              style="font-size:12px;padding:6px 10px"
              onclick="ttsmRestoreMappingsClick()"
              title="Restaurar desde un CSV exportado anteriormente">
        📥 Restaurar
      </button>
      <input type="file" id="ttsm-restore-input" accept=".csv,text/csv" style="display:none"
             onchange="ttsmRestoreMappings(this.files[0])">
    </div>
  </div>

  ${d.unmapped.length > 0 ? `
    <div class="card" style="padding:0;border-left:3px solid var(--or);margin-bottom:12px">
      <div style="padding:10px 14px;background:rgba(245,158,11,.08);border-bottom:1px solid var(--lt2);font-size:12.5px">
        <strong style="color:#8a4b1f">⚠ ${d.unmapped.length} clientes sin handle TikTok</strong> ·
        ${unassignedSamples} muestras · ${ttsmEur(unassignedCost)} en costos huérfanos ·
        ventana ${d.attribution_window_days} días
      </div>
      <div style="max-height:420px;overflow-y:auto">
        <table style="width:100%">
          <thead>
            <tr>
              <th>Cliente Simla</th>
              <th class="text-right">Muestras</th>
              <th>Grupos</th>
              <th class="text-right">Costo</th>
              <th>Último envío</th>
              <th>Candidatos</th>
              <th style="min-width:200px">Asignar handle</th>
            </tr>
          </thead>
          <tbody>
            ${d.unmapped.map(renderUnmappedRow).join('')}
          </tbody>
        </table>
      </div>
    </div>
  ` : `
    <div style="padding:10px 14px;background:#eaf7ee;border:1.5px solid #bce3cf;border-radius:6px;color:#1a7a4f;font-size:13px;margin-bottom:12px">
      ✓ Todos los clientes Simla tienen handle TikTok asignado
    </div>
  `}

  ${d.mapped.length > 0 ? renderMappedSection(d.mapped) : ''}`;
}

// ─── Sección "Clientes asignados" con búsqueda + sort + colapsable ──────
function renderMappedSection(mapped) {
  const collapsed = _samplesState.mappingsCollapsed && mapped.length > 20;
  const filtered  = filterMapped(mapped, _samplesState.mappingsSearch);
  const sorted    = sortMapped(filtered, _samplesState.mappingsSort);

  return `
  <div class="card" style="padding:0;margin-bottom:12px">
    <div style="padding:10px 14px;border-bottom:1px solid var(--lt2);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <div>
        <strong style="font-size:13px">Clientes asignados · ${mapped.length}</strong>
        ${_samplesState.mappingsSearch ? `<small style="color:var(--md);margin-left:6px">${filtered.length} coinciden con "${_samplesState.mappingsSearch}"</small>` : ''}
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <input type="text" placeholder="Buscar cliente o @handle..." id="ttsm-map-search"
               value="${escAttr(_samplesState.mappingsSearch)}"
               oninput="_samplesState.mappingsSearch=this.value;rerenderMappedSection()"
               style="padding:5px 10px;font-size:12px;border:1px solid var(--lt2);border-radius:4px;width:220px">
        <select onchange="_samplesState.mappingsSort=this.value;rerenderMappedSection()"
                style="padding:4px 8px;font-size:12px;border:1px solid var(--lt2);border-radius:4px">
          <option value="recent"  ${_samplesState.mappingsSort==='recent'?'selected':''}>Más reciente</option>
          <option value="samples" ${_samplesState.mappingsSort==='samples'?'selected':''}>+ muestras</option>
          <option value="name"    ${_samplesState.mappingsSort==='name'?'selected':''}>Cliente A-Z</option>
          <option value="handle"  ${_samplesState.mappingsSort==='handle'?'selected':''}>Handle A-Z</option>
        </select>
        ${mapped.length > 20 ? `
          <button class="btn btn-secondary btn-sm" style="font-size:11px;padding:3px 8px"
                  onclick="_samplesState.mappingsCollapsed=!_samplesState.mappingsCollapsed;rerenderMappingsPanel()">
            ${collapsed ? '▼ Ver todos' : '▲ Colapsar'}
          </button>` : ''}
      </div>
    </div>
    <div id="ttsm-mapped-body" style="max-height:${collapsed ? '320px' : '600px'};overflow-y:auto">
      ${renderMappedTable(collapsed ? sorted.slice(0, 10) : sorted, mapped.length, collapsed)}
    </div>
  </div>`;
}

function renderMappedTable(rows, total, collapsed) {
  if (rows.length === 0) {
    return '<div style="padding:30px;text-align:center;color:var(--md);font-size:12px">Sin coincidencias</div>';
  }
  return `
  <table style="width:100%;font-size:12px">
    <thead style="position:sticky;top:0;background:var(--wh);z-index:1">
      <tr>
        <th>Cliente Simla</th>
        <th style="min-width:140px">Handle TikTok</th>
        <th class="text-right">Muestras</th>
        <th>Grupos recibidos</th>
        <th class="text-right">Costo</th>
        <th>Último envío</th>
        <th style="min-width:110px"></th>
      </tr>
    </thead>
    <tbody>${rows.map(renderMappedRow).join('')}</tbody>
  </table>
  ${collapsed && total > rows.length ? `
    <div style="padding:8px;text-align:center;font-size:11px;color:var(--md);border-top:1px solid var(--lt2);background:rgba(0,0,0,.02)">
      Mostrando ${rows.length} de ${total} · usá la búsqueda o tocá "Ver todos"
    </div>` : ''}`;
}

function rerenderMappedSection() {
  const data = _samplesState.mappingsData;
  if (!data) return;
  // Sólo re-renderizar la sección de mapeados (preserva el resto del panel)
  // Buscamos el contenedor actual y lo reemplazamos
  const container = document.querySelector('#ttsm-mappings .card:last-child');
  if (container) container.outerHTML = renderMappedSection(data.mapped);
  // Re-binding por innerHTML perdió event handlers, reaplicarlos no es necesario
  // (los onclick están inline)
}

function rerenderMappingsPanel() {
  if (_samplesState.mappingsData) renderMappingsPanel(_samplesState.mappingsData);
}

function filterMapped(rows, q) {
  const query = (q || '').toLowerCase().trim();
  if (!query) return rows;
  return rows.filter(m =>
    (m.customer_name || '').toLowerCase().includes(query) ||
    (m.tiktok_username || '').toLowerCase().includes(query) ||
    (m.customer_phone || '').includes(query) ||
    (m.grupos || []).some(g => (g || '').toLowerCase().includes(query))
  );
}

function sortMapped(rows, mode) {
  const copy = rows.slice();
  switch (mode) {
    case 'samples': copy.sort((a,b) => b.sample_count - a.sample_count); break;
    case 'name':    copy.sort((a,b) => (a.customer_name || '').localeCompare(b.customer_name || '')); break;
    case 'handle':  copy.sort((a,b) => (a.tiktok_username || '').localeCompare(b.tiktok_username || '')); break;
    default:        copy.sort((a,b) => (b.last_sample || '').localeCompare(a.last_sample || ''));
  }
  return copy;
}

function renderUnmappedRow(u) {
  const cands = u.candidates || [];
  const candsHtml = cands.length === 0
    ? '<span style="font-size:11px;color:var(--md)">sin candidatos</span>'
    : cands.slice(0, 3).map(c => `
        <button class="btn btn-secondary btn-sm" style="margin:1px;font-size:11px;padding:2px 6px"
                onclick="saveMapping('${escAttr(u.customer_name)}', '${escAttr(u.customer_phone)}', '${escAttr(u.customer_email)}', '${c.tiktok_username}')"
                title="${c.orders} ventas · ${ttsmEur(c.revenue)}">
          @${c.tiktok_username} <small style="opacity:.7">${c.orders}</small>
        </button>`).join('');

  const allGruposTitle = u.grupos.join(' · ');
  const grupos = u.grupos.slice(0, 3).map(g =>
    `<span style="display:inline-block;padding:1px 6px;margin:1px 3px 1px 0;font-size:10px;background:rgba(239,90,44,.12);color:#c3410f;border-radius:3px;font-family:monospace;white-space:nowrap">${g}</span>`
  ).join('');
  const grupMore = u.grupos.length > 3
    ? `<span style="font-size:10px;color:var(--md);font-weight:600;cursor:help" title="${escAttr(allGruposTitle)}">+${u.grupos.length - 3}</span>`
    : '';

  const inputId = `ttsm-unmap-${u.customer_name?.replace(/[^a-z0-9]/gi, '')}-${u.customer_phone || ''}`;

  return `
  <tr>
    <td>
      <div style="font-weight:600">${u.customer_name || '—'}</div>
      ${u.customer_phone ? `<div style="font-size:11px;color:var(--md);font-family:monospace">${u.customer_phone}</div>` : ''}
    </td>
    <td class="text-right"><strong>${u.sample_count}</strong></td>
    <td>${grupos}${grupMore}</td>
    <td class="text-right">${ttsmEur(u.total_cost)}</td>
    <td style="font-size:11px;color:var(--md)">${ttsmDate(u.last_sample)}</td>
    <td>${candsHtml}</td>
    <td>
      <div style="display:inline-flex;gap:4px;align-items:center">
        <input type="text" list="ttsm-handles-dl" placeholder="@handle" id="${inputId}"
               style="padding:4px 8px;font-size:12px;border:1px solid var(--lt2);border-radius:4px;width:120px">
        <button class="btn btn-primary btn-sm" style="font-size:11px;padding:3px 8px"
                onclick="saveMappingManual('${inputId}', '${escAttr(u.customer_name)}', '${escAttr(u.customer_phone)}', '${escAttr(u.customer_email)}')">
          Asignar
        </button>
      </div>
    </td>
  </tr>`;
}

function renderMappedRow(m) {
  // Chips de grupos: con margin claro y tooltip de la lista completa si hay >3
  const allGruposTitle = m.grupos.join(' · ');
  const grupos = m.grupos.slice(0, 3).map(g =>
    `<span style="display:inline-block;padding:1px 6px;margin:1px 3px 1px 0;font-size:10px;background:rgba(239,90,44,.12);color:#c3410f;border-radius:3px;font-family:monospace;white-space:nowrap">${g}</span>`
  ).join('');
  const grupMore = m.grupos.length > 3
    ? `<span style="font-size:10px;color:var(--md);font-weight:600;cursor:help" title="${escAttr(allGruposTitle)}">+${m.grupos.length - 3}</span>`
    : '';

  const inputId = `ttsm-edit-${m.customer_name?.replace(/[^a-z0-9]/gi, '')}-${m.customer_phone || ''}`;
  const periodTitle = m.first_sample === m.last_sample
    ? ttsmDate(m.last_sample)
    : `${ttsmDate(m.first_sample)} → ${ttsmDate(m.last_sample)}`;

  return `
  <tr>
    <td>
      <div style="font-weight:600">${m.customer_name || '—'}</div>
      ${m.customer_phone ? `<div style="font-size:11px;color:var(--md);font-family:monospace">${m.customer_phone}</div>` : ''}
    </td>
    <td>
      <input type="text" list="ttsm-handles-dl" id="${inputId}" value="${m.tiktok_username}"
             style="padding:4px 8px;font-size:12px;border:1px solid var(--lt2);border-radius:4px;width:140px;font-family:'Poppins',sans-serif;font-weight:600"
             onchange="saveMapping('${escAttr(m.customer_name)}', '${escAttr(m.customer_phone)}', '${escAttr(m.customer_email)}', this.value)">
    </td>
    <td class="text-right"><strong>${m.sample_count}</strong></td>
    <td>${grupos}${grupMore}</td>
    <td class="text-right">${ttsmEur(m.total_cost)}</td>
    <td style="font-size:11px;color:var(--md);white-space:nowrap" title="${periodTitle}">${ttsmDate(m.last_sample)}</td>
    <td style="white-space:nowrap">
      <button class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 6px"
              onclick="openDebugCustomer('${escAttr(m.customer_name)}')" title="Ver detalle del cliente">🔍</button>
      <button class="btn btn-secondary btn-sm" style="font-size:10px;padding:2px 6px;color:var(--re)"
              onclick="deleteMapping('${escAttr(m.customer_name)}', '${escAttr(m.customer_phone)}')" title="Quitar mapeo">✕</button>
    </td>
  </tr>`;
}

async function saveMapping(customer_name, customer_phone, customer_email, handle) {
  const cleanHandle = (handle || '').trim().replace(/^@/, '').toLowerCase();
  if (!cleanHandle) { alert('Escribí un handle'); return; }
  try {
    const res = await fetch('/api/tts/mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name,
        customer_phone: (!customer_phone || customer_phone === 'null') ? null : customer_phone,
        customer_email: (!customer_email || customer_email === 'null') ? null : customer_email,
        tiktok_username: cleanHandle,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error');
    refreshAll();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function saveMappingManual(inputId, customer_name, customer_phone, customer_email) {
  const input = document.getElementById(inputId);
  const handle = (input?.value || '').trim();
  if (!handle) { alert('Escribí un handle'); return; }
  await saveMapping(customer_name, customer_phone, customer_email, handle);
}

function ttsmRestoreMappingsClick() {
  document.getElementById('ttsm-restore-input').click();
}

async function ttsmRestoreMappings(file) {
  if (!file) return;
  const csv = await file.text();
  if (!csv.trim()) { alert('El archivo está vacío'); return; }
  if (!confirm(
    `Restaurar mapeos desde "${file.name}"?\n\n` +
    `Se mergea con los mapeos actuales (UPSERT por cliente+handle). ` +
    `No borra nada existente.`
  )) return;
  try {
    const res = await fetch('/api/tts/mappings/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error');
    alert(
      `Restauración OK\n` +
      `Total filas: ${json.total_rows}\n` +
      `Nuevas: ${json.inserted}\n` +
      `Actualizadas: ${json.updated}\n` +
      `Salteadas (sin nombre/handle): ${json.skipped}\n` +
      (json.errors?.length ? `Errores: ${json.errors.length} (ver consola)` : '')
    );
    if (json.errors?.length) console.warn('Errores import:', json.errors);
    document.getElementById('ttsm-restore-input').value = '';
    refreshAll();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteMapping(customer_name, customer_phone) {
  if (!confirm(`¿Quitar mapeo de ${customer_name}?\nLas muestras asociadas quedan sin handle.`)) return;
  try {
    const res = await fetch('/api/tts/mappings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name,
        customer_phone: (!customer_phone || customer_phone === 'null') ? null : customer_phone,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error');
    refreshAll();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// VISTA DETALLE AFILIADO
// ═══════════════════════════════════════════════════════════════════════

function renderDetailShell() {
  const el = document.getElementById('page-tts-samples');
  el.innerHTML = `
  <div class="page-header">
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn btn-secondary" onclick="backToList()" style="padding:6px 12px">← Volver</button>
      <div>
        <div class="page-title">@${_samplesState.selectedHandle}</div>
        <div class="page-subtitle" id="ttsm-detail-subtitle">Cargando...</div>
      </div>
    </div>
    <div class="flex gap-8 items-center">
      <div class="form-group">
        <label>Desde</label>
        <input type="date" id="ttsm-from" value="${_samplesState.from}"
               onchange="ttsmApplyFilterDetail()" style="width:140px">
      </div>
      <div class="form-group">
        <label>Hasta</label>
        <input type="date" id="ttsm-to" value="${_samplesState.to}"
               onchange="ttsmApplyFilterDetail()" style="width:140px">
      </div>
    </div>
  </div>

  <div id="ttsm-detail-body"><div class="loading">Cargando afiliado...</div></div>`;
}

function ttsmApplyFilterDetail() {
  _samplesState.from = document.getElementById('ttsm-from').value;
  _samplesState.to   = document.getElementById('ttsm-to').value;
  fetchDetail();
}

async function fetchDetail() {
  const body = document.getElementById('ttsm-detail-body');
  if (!body) return;
  body.innerHTML = '<div class="loading">Cargando afiliado...</div>';

  try {
    const params = new URLSearchParams({ from: _samplesState.from, to: _samplesState.to });
    const res = await fetch(`/api/tts/samples/affiliates/${encodeURIComponent(_samplesState.selectedHandle)}?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    _samplesState.detailData = data;
    renderDetailBody(data);
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><div class="msg">Error: ${err.message}</div></div>`;
  }
}

function renderDetailBody(d) {
  const body = document.getElementById('ttsm-detail-body');
  const t = d.totals;

  // Subtitle: aclara que muestras son del histórico total y ventas del período
  const sub = document.getElementById('ttsm-detail-subtitle');
  if (sub) {
    const inPeriod = t.samples_in_period || 0;
    const outPeriod = (t.samples || 0) - inPeriod;
    const samplesNote = outPeriod > 0
      ? ` · 🎁 ${t.samples} muestras totales (${inPeriod} en el período, ${outPeriod} antes)`
      : ` · 🎁 ${t.samples} muestra${t.samples === 1 ? '' : 's'} en el período`;
    sub.textContent = (d.customer_name ? `${d.customer_name} · ` : '') +
                      `Ventas: ${d.period.from} → ${d.period.to}` + samplesNote;
  }

  // ROIA matched (honesto) es la métrica principal. ROIA total como referencia.
  const roiaMatched = t.roia_matched;
  const roiaTotal   = t.roia_total;
  const roiaMatchedStyle = roiaMatched == null ? 'color:var(--md)' :
                    (roiaMatched >= 50 ? 'color:var(--gr);font-weight:700' :
                    (roiaMatched >= 0  ? 'color:var(--bl);font-weight:600' : 'color:var(--re);font-weight:700'));

  // Indicador de ventas matched: % sobre el total de pedidos
  const matchedPct = t.orders > 0
    ? Math.round((t.orders_matched / t.orders) * 100)
    : 0;

  body.innerHTML = `
  <!-- KPI cards: muestras (total) + pedidos + facturación + inversión + ROIA matched -->
  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:12px">
    <div class="kpi-card orange" title="Total histórico de muestras del afiliado, no sólo del período filtrado.">
      <div class="kpi-label">🎁 Muestras (total)</div>
      <div class="kpi-value">${ttsmInt(t.samples)}</div>
      <div class="kpi-sub">${ttsmInt(t.units)} unidades · ${ttsmEur(t.samples_cost)}</div>
    </div>
    <div class="kpi-card blue" title="Pedidos en el rango. Matched = mismo grupo familia que alguna muestra recibida (atribuible). No-matched = otros productos del afiliado.">
      <div class="kpi-label">🛒 Pedidos del período</div>
      <div class="kpi-value">${ttsmInt(t.orders)}</div>
      <div class="kpi-sub">
        <span style="color:var(--gr);font-weight:600">${t.orders_matched} matched</span>
        · ${t.orders_unmatched} otros · ${t.videos} videos
      </div>
    </div>
    <div class="kpi-card" title="Facturación de ventas matched (atribuibles a la muestra) vs total.">
      <div class="kpi-label">💰 Facturación matched</div>
      <div class="kpi-value">${ttsmEur(t.facturacion_matched)}</div>
      <div class="kpi-sub">
        Total período: ${ttsmEur(t.facturacion)}
        ${t.facturacion_unmatched > 0 ? `· otros: ${ttsmEur(t.facturacion_unmatched)}` : ''}
      </div>
    </div>
    <div class="kpi-card" title="Lo que sale de tu bolsillo: cogs + envío de las muestras. La comisión sale del revenue, no es capital extra.">
      <div class="kpi-label">📊 Inversión</div>
      <div class="kpi-value">${ttsmEur(t.inversion)}</div>
      <div class="kpi-sub">muestras (cogs + envío)</div>
    </div>
    <div class="kpi-card ${roiaMatched == null ? '' : (roiaMatched >= 0 ? 'green' : 'red')}"
         title="ROIA matched (honesto): sólo ventas del mismo grupo familia que las muestras enviadas. ROIA total: todas las ventas del afiliado en el período (incluye productos no relacionados con la muestra).">
      <div class="kpi-label">📈 ROIA matched</div>
      <div class="kpi-value" style="${roiaMatchedStyle}">${roiaMatched == null ? '—' : ttsmPct(roiaMatched)}</div>
      <div class="kpi-sub">
        ${roiaTotal != null ? `total: ${ttsmPct(roiaTotal)}` : '—'}
        ${matchedPct < 100 && t.orders > 0 ? `· ${matchedPct}% matched` : ''}
      </div>
    </div>
  </div>

  <!-- Chart -->
  <div class="card" style="padding:14px;margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div class="card-title">Timeline de actividad</div>
      <div style="display:flex;gap:14px;font-size:11px;color:var(--md)">
        <span><span style="display:inline-block;width:10px;height:10px;background:#ef5a2c;border-radius:2px;vertical-align:middle"></span> Ventas org</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:#f59e0b;border-radius:2px;vertical-align:middle"></span> Ventas paid</span>
        <span><span style="display:inline-block;width:14px;height:2px;background:#3b82f6;vertical-align:middle"></span> Revenue €</span>
        <span>📦 Muestra recibida</span>
      </div>
    </div>
    ${renderDetailChart(d.timeline)}
  </div>

  <!-- Comparativa: muestras recibidas (izq) vs productos vendidos (der) -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
    ${renderSamplesPanel(d)}
    ${renderSoldByGroupPanel(d)}
  </div>

  <!-- Videos del período: ranking de cada video con sus ventas + producto + match -->
  ${renderVideosPanel(d)}

  <!-- Ventas generadas — al final, scroll a partir de 15 filas -->
  ${renderSalesPanel(d)}`;
}

// ─── Videos del período ────────────────────────────────────────────────
// Lista todos los videos (contentId) que el afiliado usó para vender en el
// rango. Si vendió 3 videos distintos, aparecen los 3 — uno linkea a TikTok.
// Marca verde el video que vendió producto del mismo grupo familia que una
// muestra recibida (causal), gris si vende un producto sin relación.
function renderVideosPanel(d) {
  const videos = d.videos || [];
  if (videos.length === 0) {
    return ''; // sin videos no mostramos panel
  }
  const totalSales = videos.reduce((s, v) => s + v.sales, 0);
  const matchedCount = videos.filter(v => v.is_matched).length;

  return `
  <div class="card" style="padding:0;margin-bottom:12px">
    <div style="padding:10px 14px;border-bottom:1px solid var(--lt2)">
      <strong style="font-family:'Poppins',sans-serif;font-size:12px">🎬 Videos del período · ${videos.length}</strong>
      <small style="color:var(--md);margin-left:6px">
        ${matchedCount} matched (vendieron grupo de muestra) · ${videos.length - matchedCount} con otros productos
      </small>
    </div>
    <div class="table-wrap" style="margin:0;max-height:360px;overflow-y:auto">
      <table style="width:100%;font-size:12px">
        <thead style="position:sticky;top:0;background:var(--wh);z-index:1">
          <tr>
            <th style="min-width:140px">Video</th>
            <th>Producto principal</th>
            <th class="text-right">Ventas</th>
            <th class="text-right" title="Orgánico / Paid">Org/P</th>
            <th class="text-right">Revenue</th>
            <th class="text-right">Comisión</th>
            <th>Match</th>
          </tr>
        </thead>
        <tbody>
          ${videos.map(v => {
            const matchedLabel = v.is_matched
              ? '<span style="font-size:10px;padding:1px 6px;background:rgba(33,163,102,.12);color:#1a7a4f;border-radius:3px;font-weight:600" title="Vendió un producto del mismo grupo familia que alguna muestra recibida — atribuible">✓ matched</span>'
              : '<span style="font-size:10px;padding:1px 6px;background:rgba(100,116,139,.1);color:#475569;border-radius:3px" title="Vendió un producto que no tiene muestra asociada — el afiliado lo vende por otra razón">otro prod.</span>';
            const productLabel = v.product_count > 1
              ? `${v.top_product} <small style="color:var(--md)">+${v.product_count - 1}</small>`
              : v.top_product;
            const period = v.first_date === v.last_date
              ? ttsmDate(v.first_date)
              : `${ttsmDate(v.first_date)}→${ttsmDate(v.last_date)}`;
            return `
            <tr>
              <td>
                <a href="https://www.tiktok.com/@${encodeURIComponent(d.handle)}/video/${v.video_id}" target="_blank"
                   style="font-family:monospace;font-size:11px;color:var(--bl);text-decoration:none"
                   title="Abrir en TikTok · ${period}">
                  ${v.video_id.slice(-10)} ↗
                </a>
              </td>
              <td><small title="${v.top_product}">${productLabel}</small></td>
              <td class="text-right"><strong>${v.sales}</strong></td>
              <td class="text-right" style="font-size:11px;color:var(--md)">${v.orders_org}/${v.orders_paid}</td>
              <td class="text-right"><strong>${ttsmEur(v.revenue)}</strong></td>
              <td class="text-right">${ttsmEur(v.commission)}</td>
              <td>${matchedLabel}</td>
            </tr>`;
          }).join('')}
          <tr style="border-top:2px solid var(--lt2);background:rgba(0,0,0,.02)">
            <td><strong>Total</strong></td>
            <td></td>
            <td class="text-right"><strong>${totalSales}</strong></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`;
}

// ─── Muestras recibidas (agrupadas por GRUPO, TODO el histórico) ───────
function renderSamplesPanel(d) {
  // Agrupamos por grupo. Una muestra está "in_period" si su sent_date cae
  // dentro del rango filtrado — la marcamos con badge 🆕.
  const byGrupo = {};
  for (const s of d.samples) {
    const g = (s.grupo || s.sku || 'SIN GRUPO');
    if (!byGrupo[g]) byGrupo[g] = {
      grupo: g, units: 0, samples: 0, cost: 0,
      first_date: s.sent_date, last_date: s.sent_date,
      orders: [],
      has_in_period: false,
    };
    const r = byGrupo[g];
    r.samples += 1;
    r.units   += s.units || 1;
    r.cost    += (s.cogs || 0) + (s.shipping_cost || 0);
    if (s.sent_date && s.sent_date < r.first_date) r.first_date = s.sent_date;
    if (s.sent_date && s.sent_date > r.last_date)  r.last_date  = s.sent_date;
    if (s.in_period) r.has_in_period = true;
    r.orders.push(s.simla_order_num || s.simla_order_id);
  }
  const rows = Object.values(byGrupo).sort((a, b) => b.units - a.units);
  const totalUnits = rows.reduce((acc, r) => acc + r.units, 0);
  const totalCost  = rows.reduce((acc, r) => acc + r.cost,  0);
  const inPeriodCount  = (d.samples || []).filter(s => s.in_period).length;
  const outPeriodCount = (d.samples || []).length - inPeriodCount;

  return `
  <div class="card" style="padding:0">
    <div style="padding:10px 14px;border-bottom:1px solid var(--lt2)">
      <strong style="font-family:'Poppins',sans-serif;font-size:12px">📦 Muestras recibidas · ${d.samples.length} env. · ${rows.length} grupos</strong>
      ${outPeriodCount > 0
        ? `<small style="color:var(--md);margin-left:6px">${inPeriodCount} en el período · ${outPeriodCount} antes (atemporal)</small>`
        : ''}
    </div>
    <div class="table-wrap" style="margin:0;max-height:360px">
      <table style="width:100%;font-size:12px">
        <thead>
          <tr>
            <th>Grupo</th>
            <th class="text-right">Envíos</th>
            <th class="text-right">Unid.</th>
            <th class="text-right">Costo</th>
            <th>Período</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--md)">Sin muestras en el histórico</td></tr>'
            : rows.map(r => {
              const periodo = r.first_date === r.last_date
                ? ttsmDate(r.first_date)
                : `${ttsmDate(r.first_date)} → ${ttsmDate(r.last_date)}`;
              const ordersTitle = r.orders.slice(0, 8).join(', ') + (r.orders.length > 8 ? ` (+${r.orders.length - 8})` : '');
              const newBadge = r.has_in_period
                ? '<span style="font-size:9px;padding:1px 4px;margin-left:3px;background:#fef3c7;color:#92400e;border-radius:2px;font-weight:600" title="Hay envíos de este grupo dentro del rango filtrado">🆕</span>'
                : '';
              return `
              <tr title="Pedidos: ${ordersTitle}">
                <td>${renderSkuChip(r.grupo, 'received')}${newBadge}</td>
                <td class="text-right"><strong>${r.samples}</strong></td>
                <td class="text-right"><strong>${r.units}</strong></td>
                <td class="text-right">${ttsmEur(r.cost)}</td>
                <td style="font-size:11px;color:var(--md)">${periodo}</td>
              </tr>`;
            }).join('')}
          ${rows.length > 0 ? `
            <tr style="border-top:2px solid var(--lt2);background:rgba(0,0,0,.02)">
              <td><strong>Total</strong></td>
              <td class="text-right"><strong>${d.samples.length}</strong></td>
              <td class="text-right"><strong>${totalUnits}</strong></td>
              <td class="text-right"><strong>${ttsmEur(totalCost)}</strong></td>
              <td></td>
            </tr>` : ''}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ─── Productos vendidos por grupo (para macheo vs muestras) ────────────
function renderSoldByGroupPanel(d) {
  const rows = d.sold_by_group || [];
  const totalUnits = rows.reduce((acc, r) => acc + r.units, 0);
  const totalRev   = rows.reduce((acc, r) => acc + r.revenue, 0);

  return `
  <div class="card" style="padding:0">
    <div style="padding:10px 14px;border-bottom:1px solid var(--lt2)">
      <strong style="font-family:'Poppins',sans-serif;font-size:12px">🛍️ Productos vendidos · ${rows.length} grupos</strong>
      <small style="color:var(--md);margin-left:6px">verde = recibió muestra · gris = vende sin muestra</small>
    </div>
    <div class="table-wrap" style="margin:0;max-height:360px">
      <table style="width:100%;font-size:12px">
        <thead>
          <tr>
            <th>Grupo</th>
            <th class="text-right" title="Pedidos">Ped.</th>
            <th class="text-right" title="Orgánico / Paid">Org/P</th>
            <th class="text-right">Revenue</th>
            <th class="text-right">Comisión</th>
          </tr>
        </thead>
        <tbody>
          ${rows.length === 0 ? '<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--md)">Sin ventas en el período</td></tr>'
            : rows.map(r => {
              const variant = r.received ? 'sold_match' : 'sold_extra';
              return `
              <tr>
                <td>${renderSkuChip(r.grupo, variant)}</td>
                <td class="text-right"><strong>${r.units}</strong></td>
                <td class="text-right" style="font-size:11px;color:var(--md)">${r.orders_org}/${r.orders_paid}</td>
                <td class="text-right"><strong>${ttsmEur(r.revenue)}</strong></td>
                <td class="text-right">${ttsmEur(r.commission)}</td>
              </tr>`;
            }).join('')}
          ${rows.length > 0 ? `
            <tr style="border-top:2px solid var(--lt2);background:rgba(0,0,0,.02)">
              <td><strong>Total</strong></td>
              <td class="text-right"><strong>${totalUnits}</strong></td>
              <td></td>
              <td class="text-right"><strong>${ttsmEur(totalRev)}</strong></td>
              <td></td>
            </tr>` : ''}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ─── Ventas generadas (detalle por pedido) ─────────────────────────────
function renderSalesPanel(d) {
  // Altura para ~15 filas: ~28px por fila + header ≈ 460px
  return `
  <div class="card" style="padding:0">
    <div style="padding:10px 14px;border-bottom:1px solid var(--lt2)">
      <strong style="font-family:'Poppins',sans-serif;font-size:12px">🛒 Ventas generadas · ${d.sales.length}</strong>
      ${d.sales.length > 15 ? `<small style="color:var(--md);margin-left:6px">mostrando 15 visibles · scroll para ver más</small>` : ''}
    </div>
    <div class="table-wrap" style="margin:0;max-height:460px;overflow-y:auto">
      <table style="width:100%;font-size:12px">
        <thead style="position:sticky;top:0;background:var(--wh);z-index:1">
          <tr>
            <th>Fecha</th>
            <th>SKU</th>
            <th>Grupo</th>
            <th>Tipo</th>
            <th>Video</th>
            <th class="text-right">Revenue</th>
            <th class="text-right">Comisión</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          ${d.sales.length === 0 ? '<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--md)">Sin ventas en el período</td></tr>'
            : d.sales.map(s => {
              const receivedSkus = new Set(d.samples.flatMap(x => x.all_skus ? x.all_skus.split(',').filter(Boolean) : [x.sku].filter(Boolean)));
              const skuVariant = receivedSkus.has(s.sku) ? 'sold_match' : 'sold_extra';
              const typeColor = s.comm_type === 'paid' ? '#f59e0b' : '#21a366';
              return `
              <tr>
                <td style="font-size:11px;color:var(--md)">${ttsmDate(s.order_date)}</td>
                <td>${s.sku ? renderSkuChip(s.sku, skuVariant) : '<span style="color:var(--md)">—</span>'}</td>
                <td><small>${s.grupo || '—'}</small></td>
                <td><span style="font-size:10px;padding:1px 6px;background:${typeColor}20;color:${typeColor};border-radius:3px;font-weight:600">${s.comm_type || '—'}</span></td>
                <td><small style="font-family:monospace;color:var(--md)">${s.video_id ? s.video_id.slice(-8) : '—'}</small></td>
                <td class="text-right"><strong>${ttsmEur(s.revenue)}</strong></td>
                <td class="text-right">${ttsmEur(s.commission)}</td>
                <td><small style="color:var(--md)">${s.order_status || '—'}</small></td>
              </tr>`;
            }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ─── Chart SVG: timeline con barras apiladas + línea revenue + eventos muestras ──
function renderDetailChart(timeline) {
  if (!timeline || timeline.length === 0) return '<div style="color:var(--md);text-align:center;padding:40px">Sin datos</div>';
  const w = 1200, h = 260;
  const padL = 40, padR = 50, padT = 30, padB = 32;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const step   = innerW / timeline.length;
  const barW   = Math.min(step * 0.65, 24);

  // Escalas
  const maxOrders  = Math.max(1, ...timeline.map(d => d.orders));
  const maxRevenue = Math.max(1, ...timeline.map(d => d.revenue));

  const grids = [0.25, 0.5, 0.75].map(t =>
    `<line x1="${padL}" x2="${w-padR}" y1="${padT + innerH * t}" y2="${padT + innerH * t}" stroke="#eeece7" stroke-dasharray="2 3"/>`
  ).join('');

  // Helper: desglose de grupos del día para tooltip
  const grupoBreakdown = (d) => {
    const sg = d.sale_grupos || [];
    if (sg.length === 0) return '';
    return '\n  ' + sg.slice(0, 6).map(g => {
      const tag = [];
      if (g.org)  tag.push(`${g.org} org`);
      if (g.paid) tag.push(`${g.paid} paid`);
      return `${g.grupo}: ${tag.join(' + ')} (${ttsmEur(g.revenue)})`;
    }).join('\n  ') + (sg.length > 6 ? `\n  +${sg.length - 6} grupos más` : '');
  };

  // Barras apiladas: org (naranja clarito) + paid (naranja oscuro)
  const bars = timeline.map((d, i) => {
    if (d.orders === 0) return '';
    const hOrg  = (d.orders_org  / maxOrders) * innerH;
    const hPaid = (d.orders_paid / maxOrders) * innerH;
    const x = padL + step * i + (step - barW) / 2;
    const yOrg  = padT + innerH - hOrg;
    const yPaid = yOrg - hPaid;
    const tipBase = `${ttsmDate(d.date)} · ${d.orders} ped (${d.orders_org}o / ${d.orders_paid}p) · ${ttsmEur(d.revenue)}${grupoBreakdown(d)}`;
    const hasOrg  = d.orders_org  > 0 ? `<rect x="${x.toFixed(1)}" y="${yOrg.toFixed(1)}"  width="${barW.toFixed(1)}" height="${hOrg.toFixed(1)}"  fill="#ef5a2c" rx="1.5"><title>${tipBase}</title></rect>` : '';
    const hasPaid = d.orders_paid > 0 ? `<rect x="${x.toFixed(1)}" y="${yPaid.toFixed(1)}" width="${barW.toFixed(1)}" height="${hPaid.toFixed(1)}" fill="#f59e0b" rx="1.5"><title>${tipBase}</title></rect>` : '';
    return hasOrg + hasPaid;
  }).join('');

  // Línea revenue
  const revPts = timeline.map((d, i) => {
    const x = padL + step * i + step / 2;
    const y = padT + innerH - (d.revenue / maxRevenue) * innerH;
    return [x, y];
  });
  const revPath = revPts.map((p, i) => `${i===0?'M':'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const revDots = timeline.map((d, i) => {
    if (d.revenue === 0) return '';
    const [x, y] = revPts[i];
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#3b82f6" stroke="#fff" stroke-width="1"><title>${ttsmDate(d.date)}: ${ttsmEur(d.revenue)}</title></circle>`;
  }).join('');

  // Eventos: marcadores verticales para días con muestras
  const sampleEvents = timeline.map((d, i) => {
    if (d.samples === 0) return '';
    const x = padL + step * i + step / 2;
    // Preferir grupos (más legible); fallback a SKUs
    const grupos = d.sample_grupos && d.sample_grupos.length > 0 ? d.sample_grupos : d.sample_skus;
    const productosTitle = grupos.length > 0 ? [...new Set(grupos)].join(', ') : '(sin grupo)';
    return `
      <line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT}" y2="${padT + innerH}" stroke="#c3410f" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.8"/>
      <text x="${x.toFixed(1)}" y="${padT - 8}" font-size="14" text-anchor="middle"><title>${ttsmDate(d.date)}: ${d.samples} muestra(s) · ${productosTitle}</title>📦</text>`;
  }).join('');

  // Etiquetas X (cada N días)
  const labelEvery = Math.max(1, Math.ceil(timeline.length / 14));
  const xLabels = timeline.map((d, i) => {
    if (i % labelEvery !== 0) return '';
    const dt = new Date(d.date + 'T00:00:00');
    const label = dt.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
    return `<text x="${padL + step*i + step/2}" y="${h-6}" font-size="9" fill="#9a9890" text-anchor="middle">${label}</text>`;
  }).join('');

  const yMid = Math.ceil(maxOrders / 2);
  return `
  <svg viewBox="0 0 ${w} ${h}" width="100%" style="display:block">
    ${grids}
    <line x1="${padL}" x2="${w-padR}" y1="${padT+innerH}" y2="${padT+innerH}" stroke="#d6d3cd"/>
    ${bars}
    <path d="${revPath}" fill="none" stroke="#3b82f6" stroke-width="2" opacity="0.85"/>
    ${revDots}
    ${sampleEvents}
    ${xLabels}
    <!-- Y izq (pedidos) -->
    <text x="6" y="${padT+8}" font-size="9" fill="#9a9890">${maxOrders} ped</text>
    <text x="6" y="${padT + innerH/2 + 3}" font-size="9" fill="#9a9890">${yMid}</text>
    <text x="6" y="${padT+innerH+4}" font-size="9" fill="#9a9890">0</text>
    <!-- Y der (revenue) -->
    <text x="${w-padR+4}" y="${padT+8}" font-size="9" fill="#3b82f6" font-weight="600">${ttsmEur0(maxRevenue)}</text>
    <text x="${w-padR+4}" y="${padT+innerH+4}" font-size="9" fill="#3b82f6">€0</text>
  </svg>`;
}

const ttsmEur0 = n => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n || 0);

async function openDebugCustomer(customer_name) {
  try {
    const res = await fetch(`/api/tts/mappings/debug/${encodeURIComponent(customer_name)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    const summary = `
Cliente: ${data.customer_name}
Handles: ${data.handles.join(', ') || '(ninguno)'}
Grupos de muestras: ${data.grupos.join(', ') || '(ninguno)'}

Muestras (${data.samples.length}):
${data.samples.map(s => `  · ${s.sent_date} · ${s.grupo} · ${s.sku} · handle=${s.tiktok_username || 'NULL'}`).join('\n') || '  (sin muestras)'}

Ventas del handle (últimas ${data.handle_sales_last_200.length}):
${data.handle_sales_last_200.slice(0, 10).map(o => `  · ${o.order_date} · ${o.grupo} · €${o.revenue} · ${o.comm_type} · ${o.order_status}`).join('\n') || '  (sin ventas)'}
${data.handle_sales_last_200.length > 10 ? `... +${data.handle_sales_last_200.length - 10} más` : ''}

Stats tts_affiliate_orders:
Total filas: ${data.tts_affiliate_orders_total}
Rango: ${data.tts_affiliate_orders_date_range[0]} → ${data.tts_affiliate_orders_date_range[1]}
    `.trim();
    alert(summary);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}
