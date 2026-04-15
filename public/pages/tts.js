// ─── TikTok Shop — Reporte del día ────────────────────────────────────────────

let _ttsAffiliateRows = [];   // filas parseadas del CSV de afiliados
let _ttsGMVCampaigns  = {};   // { campaignName: spend } del XLSX GMV Max
let _ttsLastResult    = null; // último resultado calculado (para guardar en historial)

// ── Strip de días TTS con multiselect + rango ───────────────────────────────

let _ttsDaysStripMonth = null;
let _ttsSelectedDays = new Set();   // días seleccionados individualmente
let _ttsRangeFrom = '';             // rango desde
let _ttsRangeTo = '';               // rango hasta
let _ttsSavedDates = new Set();     // cache de fechas guardadas
let _ttsSelectionMode = 'none';     // 'none' | 'days' | 'range'

async function loadTTSDaysStrip() {
  const el = document.getElementById('tts-days-strip');
  if (!el) return;

  const now = new Date();
  if (!_ttsDaysStripMonth) {
    _ttsDaysStripMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  try {
    const savedDates = await API.ttsGetDates();
    _ttsSavedDates = new Set(savedDates);
    _renderTTSStrip();
  } catch (err) {
    el.innerHTML = '';
  }
}

function _renderTTSStrip() {
  const el = document.getElementById('tts-days-strip');
  if (!el) return;

  const now = new Date();
  const todayStr = today();
  const MNAMES = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

  // Month tabs
  const months = [];
  const startYear = 2026, startMonth = 1;
  const endYear = now.getFullYear(), endMonth = now.getMonth() + 1;
  for (let y = startYear; y <= endYear; y++) {
    for (let m = (y === startYear ? startMonth : 1); m <= (y === endYear ? endMonth : 12); m++)
      months.push(`${y}-${String(m).padStart(2, '0')}`);
  }

  const tabs = months.map(ym => {
    const [, m] = ym.split('-').map(Number);
    const active = ym === _ttsDaysStripMonth;
    const count = [..._ttsSavedDates].filter(d => d.startsWith(ym)).length;
    return `<div onclick="_ttsDaysStripMonth='${ym}';_renderTTSStrip()"
      style="padding:4px 10px;border-radius:5px;font-size:11px;font-weight:${active?'700':'500'};background:${active?'#fe2c55':count>0?'var(--wh,#fff)':'transparent'};color:${active?'#fff':'var(--md)'};border:1px solid ${active?'transparent':'var(--lt2)'};cursor:pointer;white-space:nowrap">
      ${MNAMES[m]}${count > 0 ? ' <span style="font-size:9px;opacity:.7">'+count+'d</span>' : ''}
    </div>`;
  }).join('');

  // Day chips
  const [selY, selM] = _ttsDaysStripMonth.split('-').map(Number);
  const lastDay = new Date(selY, selM, 0).getDate();
  const monthDays = [];
  for (let d = 1; d <= lastDay; d++) {
    const ds = `${selY}-${String(selM).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (ds < todayStr) monthDays.push(ds);
  }

  const chips = monthDays.map(ds => {
    const saved = _ttsSavedDates.has(ds);
    const dayNum = parseInt(ds.split('-')[2]);
    const isSelected = _ttsSelectedDays.has(ds);
    const isInRange = _ttsSelectionMode === 'range' && _ttsRangeFrom && _ttsRangeTo && ds >= _ttsRangeFrom && ds <= _ttsRangeTo && saved;

    let bg, color, icon;
    if (isSelected || isInRange) {
      bg = '#2563eb'; color = '#fff'; icon = '●';
    } else if (saved) {
      bg = 'rgba(26,122,66,.12)'; color = 'var(--gr)'; icon = '✓';
    } else {
      bg = 'rgba(239,68,68,.08)'; color = '#ef4444'; icon = '✕';
    }

    const onclick = saved ? `toggleTTSDay('${ds}')` : '';
    const cursor = saved ? 'pointer' : 'default';
    const opacity = saved ? '1' : '0.5';

    return `<div ${onclick ? 'onclick="'+onclick+'"' : ''} title="${fd(ds)}${saved?' — guardado':' — sin guardar'}"
      style="display:flex;flex-direction:column;align-items:center;gap:1px;padding:3px 5px;border-radius:5px;background:${bg};min-width:28px;cursor:${cursor};opacity:${opacity};transition:background .1s">
      <span style="font-size:8px;font-weight:700;color:${color}">${icon}</span>
      <span style="font-size:10px;font-weight:600;color:${color}">${dayNum}</span>
    </div>`;
  }).join('');

  // Selection info
  const selCount = _ttsSelectionMode === 'days' ? _ttsSelectedDays.size
    : _ttsSelectionMode === 'range' ? [..._ttsSavedDates].filter(d => d >= _ttsRangeFrom && d <= _ttsRangeTo).length
    : 0;

  const selInfo = selCount > 0
    ? `<div style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:11px">
        <span style="color:var(--bl,#2563eb);font-weight:600">● ${selCount} día${selCount>1?'s':''} seleccionado${selCount>1?'s':''}</span>
        <button onclick="clearTTSSelection()" style="font-size:10px;padding:2px 8px;border:1px solid var(--lt2);border-radius:4px;background:transparent;cursor:pointer;color:var(--md)">✕ Limpiar</button>
      </div>`
    : '';

  // Range inputs
  const rangeHtml = `
    <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
      <span style="font-size:10px;color:var(--md);font-weight:600">Rango:</span>
      <input type="date" id="tts-range-from" value="${_ttsRangeFrom}"
        style="padding:3px 6px;border:1.5px solid var(--lt2);border-radius:5px;font-size:11px;width:125px">
      <span style="color:var(--md);font-size:11px">→</span>
      <input type="date" id="tts-range-to" value="${_ttsRangeTo}"
        style="padding:3px 6px;border:1.5px solid var(--lt2);border-radius:5px;font-size:11px;width:125px">
      <button onclick="applyTTSRange()" style="padding:3px 10px;border:none;border-radius:5px;background:#fe2c55;color:#fff;font-size:10px;font-weight:700;cursor:pointer">Aplicar</button>
    </div>`;

  const missing = monthDays.filter(d => !_ttsSavedDates.has(d));
  const statusText = monthDays.length === 0 ? ''
    : missing.length > 0
      ? `<span style="color:#ef4444;font-size:11px;font-weight:600">${missing.length} sin guardar</span>`
      : `<span style="color:var(--gr);font-size:11px;font-weight:600">✓ Completo</span>`;

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
      <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--md)">Días guardados TTS</span>
      ${statusText}
    </div>
    <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap">${tabs}</div>
    <div style="display:flex;gap:3px;flex-wrap:wrap">${chips}</div>
    ${selInfo}
    ${rangeHtml}
  `;
}

function toggleTTSDay(date) {
  // Clear range mode, switch to days mode
  _ttsSelectionMode = 'days';
  _ttsRangeFrom = '';
  _ttsRangeTo = '';

  if (_ttsSelectedDays.has(date)) {
    _ttsSelectedDays.delete(date);
  } else {
    _ttsSelectedDays.add(date);
  }

  if (_ttsSelectedDays.size === 0) _ttsSelectionMode = 'none';

  _renderTTSStrip();
  loadTTSAggregated();
}

function applyTTSRange() {
  const from = document.getElementById('tts-range-from')?.value;
  const to = document.getElementById('tts-range-to')?.value;
  if (!from || !to) return;

  // Clear individual selection, switch to range mode
  _ttsSelectedDays.clear();
  _ttsRangeFrom = from;
  _ttsRangeTo = to;
  _ttsSelectionMode = 'range';

  _renderTTSStrip();
  loadTTSAggregated();
}

function clearTTSSelection() {
  _ttsSelectedDays.clear();
  _ttsRangeFrom = '';
  _ttsRangeTo = '';
  _ttsSelectionMode = 'none';

  _renderTTSStrip();
  document.getElementById('tts-content').innerHTML = `
    <div class="empty-state">
      <div class="icon">🛒</div>
      <div class="msg">Seleccioná días o un rango para ver el reporte</div>
      <div class="hint">Clickeá los días verdes arriba o usá el rango de fechas</div>
    </div>`;
}

async function loadTTSAggregated() {
  const el = document.getElementById('tts-content');
  // Limpiar datos de afiliados del CSV anterior (evita mezclar días)
  _ttsAffiliateRows = [];

  // Determine which dates to load
  let datesToLoad = [];
  if (_ttsSelectionMode === 'days') {
    datesToLoad = [..._ttsSelectedDays].sort();
  } else if (_ttsSelectionMode === 'range') {
    datesToLoad = [..._ttsSavedDates].filter(d => d >= _ttsRangeFrom && d <= _ttsRangeTo).sort();
  }

  if (datesToLoad.length === 0) return;

  el.innerHTML = '<div class="loading">Cargando reporte...</div>';

  try {
    const minDate = datesToLoad[0];
    const maxDate = datesToLoad[datesToLoad.length - 1];
    const data = await API.ttsGetHistory(minDate, maxDate);

    // Filter to only selected dates
    const dateSet = new Set(datesToLoad);
    const filteredSummary = data.summary.filter(d => dateSet.has(d.date));
    const filteredGrupos = data.grupos.filter(g => dateSet.has(g.date));

    if (filteredSummary.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="icon">📅</div><div class="msg">Sin datos para los días seleccionados</div></div>`;
      return;
    }

    // Aggregate using existing function from tts-history.js
    const agg = aggregatePeriod(filteredSummary, filteredGrupos);

    // Convert to format compatible with renderTTSReport
    // Map gruposAgg fields to match what renderTTSReport expects
    const pl = agg.gruposAgg.map(g => ({
      ...g,
      gmv_max_spend: g.gmv_max_spend || 0,
      seller_discount: g.seller_discount || 0,
    }));

    const summary = {
      orders: agg.tot.orders,
      orders_propio: agg.tot.orders_propio,
      orders_paid_afil: agg.tot.orders_paid_afil,
      orders_org_afil: agg.tot.orders_org_afil,
      gmv: agg.tot.gmv,
      cogs: agg.tot.cogs,
      shipping: agg.tot.shipping,
      iva: agg.tot.iva,
      tiktok_platform: agg.tot.tiktok_platform,
      commission_cost: agg.tot.commission_cost,
      gmv_max_spend: agg.tot.gmv_max_spend,
      seller_discount: 0,
      gross_profit: agg.tot.gross_profit,
      net_profit: agg.tot.net_profit,
      margin_pct: agg.tot.margin_pct,
      margin_pct_cogs: agg.tot.margin_pct_cogs,
      cpa: agg.tot.cpa,
    };

    const dateLabel = datesToLoad.length === 1
      ? datesToLoad[0]
      : datesToLoad.length + ' días seleccionados';

    _ttsLastResult = { date: dateLabel, result: { pl, summary, orders: [] } };
    _ttsPLData = pl;
    _ttsSortCol = 'net_profit';
    _ttsSortAsc = false;
    renderTTSReport(dateLabel, { pl, summary, orders: [] });
  } catch (err) {
    showError(el, err.message);
  }
}

// ── Helpers de normalización ─────────────────────────────────────────────────

function normalizeStr(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// ── Parsing CSV de afiliados ──────────────────────────────────────────────────

function detectSeparator(firstLine) {
  const tabs      = (firstLine.match(/\t/g)  || []).length;
  const semis     = (firstLine.match(/;/g)   || []).length;
  const commas    = (firstLine.match(/,/g)   || []).length;
  if (tabs  >= semis && tabs  >= commas) return '\t';
  if (semis >= commas)                  return ';';
  return ',';
}

// Parser CSV correcto que respeta campos entre comillas (maneja comas dentro de nombres de producto)
function parseCSVRow(line, sep) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === sep && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

function parseTTSAffiliateCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 2) return [];

  const sep    = detectSeparator(lines[0]);
  const header = parseCSVRow(lines[0], sep).map(h => h.replace(/^"|"$/g, '').trim());

  // Mapear encabezados a campos internos
  const headerNorm = header.map(normalizeStr);
  console.log('[TTS CSV] Columnas detectadas:', header);

  function findCol(keywords) {
    // Busca el primer encabezado que contenga todas las keywords
    return headerNorm.findIndex(h => keywords.every(kw => h.includes(kw)));
  }

  const colOrderId       = findCol(['pedido']);
  const colCommPctStd    = findCol(['estandar']);
  const colCommPctAds    = (() => {
    return headerNorm.findIndex(h => h.includes('porcentaje') && h.includes('anuncio'));
  })();
  const colCommEstimated    = headerNorm.findIndex(h => h.includes('estimada') && !h.includes('anuncio') && h.includes('comision'));
  const colCommAdsEstimated = headerNorm.findIndex(h => h.includes('estimada') && h.includes('anuncio'));
  const colCommReal         = headerNorm.findIndex(h => h.includes('real') && !h.includes('anuncio') && !h.includes('base') && h.includes('comision'));
  const colCommRealAds      = headerNorm.findIndex(h => h.includes('real') && h.includes('anuncio') && !h.includes('base'));
  const colStatus        = findCol(['estado', 'pedido']);
  const colRefunded      = findCol(['totalidad']);

  // Columnas extendidas: revenue, SKU, quantity (presentes en el export de TikTok pero opcionales)
  // "Importe liquidado del pedido" / "Monto liquidado"
  // ─── Revenue: "Importe del pago" / "Importe liquidado" / "Settlement amount"
  const colSettlement = (() => {
    let i = headerNorm.findIndex(h => h.includes('liquidado'));
    if (i !== -1) return i;
    i = headerNorm.findIndex(h => h.includes('settlement'));
    if (i !== -1) return i;
    // "Importe del pago" (TikTok affiliate CSV real)
    i = headerNorm.findIndex(h => h.includes('importe') && h.includes('pago'));
    if (i !== -1) return i;
    // "Importe del pedido" / "Monto del pedido"
    return headerNorm.findIndex(h =>
      (h.includes('importe') || h.includes('monto') || h.includes('amount')) &&
      (h.includes('pedido') || h.includes('order')) &&
      !h.includes('comision') && !h.includes('commission')
    );
  })();
  // ─── Precio unitario: "Precio" (fallback si no hay settlement)
  const colPrice = headerNorm.findIndex(h => h === 'precio' || h === 'price');
  // ─── Nombre del producto → usado como grupo si no hay Seller SKU
  const colProductName = headerNorm.findIndex(h => h.includes('nombre') && h.includes('producto'));
  // ─── SKU del vendedor (puede no existir en el CSV de TikTok)
  const colSellerSku = (() => {
    let i = headerNorm.findIndex(h => h.includes('sku') && (h.includes('vendedor') || h.includes('seller')));
    if (i !== -1) return i;
    // NO usar "ID de SKU" como fallback — es un ID interno de TikTok, no el código vendedor
    return -1;
  })();
  // ─── Creador y tipo de contenido
  const colCreator = headerNorm.findIndex(h => h.includes('creador') || h.includes('creator'));
  const colContentType = headerNorm.findIndex(h => h.includes('tipo') && h.includes('contenido'));
  const colContentId = headerNorm.findIndex(h => h.startsWith('id') && h.includes('contenido'));
  // ─── Cantidad
  const colQuantity = headerNorm.findIndex(h =>
    h === 'cantidad' || h === 'quantity' || h.includes('unidades') || h === 'qty'
  );

  console.log('[TTS CSV] Columnas detectadas — settlement:', colSettlement, '(col ' + header[colSettlement] + ')',
    '| productName:', colProductName, '| sellerSku:', colSellerSku, '| price:', colPrice, '| qty:', colQuantity);

  if (colOrderId === -1) {
    console.warn('[TTS CSV] No se encontró la columna de ID de pedido');
    return [];
  }

  // Paso 1: parsear todas las filas (una por producto)
  const rawRows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = parseCSVRow(line, sep).map(c => c.replace(/^"|"$/g, '').trim());
    const get  = idx => (idx >= 0 && idx < cols.length) ? cols[idx] : '';

    const orderId = get(colOrderId);
    if (!orderId) continue;

    const commEstimated    = parseFloat(get(colCommEstimated).replace(',', '.'))    || 0;
    const commAdsEstimated = parseFloat(get(colCommAdsEstimated).replace(',', '.')) || 0;
    const commReal         = parseFloat(get(colCommReal).replace(',', '.'))         || 0;
    const commRealAds      = parseFloat(get(colCommRealAds).replace(',', '.'))      || 0;

    // Revenue: usar "Importe del pago" si existe, si no "Precio" × cantidad
    const rawSettlement = parseFloat((get(colSettlement) || '0').replace(',', '.')) || 0;
    const rawPrice      = parseFloat((get(colPrice) || '0').replace(',', '.'))     || 0;
    const qty           = parseInt(get(colQuantity)) || 1;
    const lineRevenue   = rawSettlement > 0 ? rawSettlement : (rawPrice * qty);

    rawRows.push({
      orderId:          orderId,
      commPctStandard:  parseFloat(get(colCommPctStd).replace(',', '.'))  || 0,
      commPctAds:       parseFloat(get(colCommPctAds).replace(',', '.'))  || 0,
      commReal:         commReal    || commEstimated,
      commRealAds:      commRealAds || commAdsEstimated,
      orderStatus:      get(colStatus),
      fullyRefunded:    get(colRefunded).toLowerCase() === 'true' || get(colRefunded) === '1' || get(colRefunded).toLowerCase() === 'sí' || get(colRefunded).toLowerCase() === 'si',
      // Campos extendidos
      settlementAmount: lineRevenue,
      sellerSku:        (get(colSellerSku) || '').trim().toUpperCase(),
      productName:      (get(colProductName) || '').trim(),
      creatorName:      (get(colCreator) || '').trim(),
      contentType:      (get(colContentType) || '').trim(),
      contentId:        (get(colContentId) || '').trim(),
      quantity:         qty,
    });
  }

  // Paso 2: agregar por orderId
  // TikTok exporta UNA FILA POR PRODUCTO — un pedido con 2 productos aparece 2 veces.
  // Sumamos comisiones y acumulamos SKUs; el settlementAmount es por pedido (tomar del primer row).
  const byOrder = {};
  for (const row of rawRows) {
    const id = String(row.orderId).trim();
    if (!byOrder[id]) {
      byOrder[id] = {
        ...row,
        skus:          row.sellerSku ? [row.sellerSku] : [],
        totalQuantity: row.quantity || 1,
        // settlementAmount ya está en row (del primer producto = valor del pedido completo)
      };
    } else {
      // Productos adicionales: sumar comisiones, acumular SKUs, NO sumar settlementAmount
      byOrder[id].commReal    += row.commReal;
      byOrder[id].commRealAds += row.commRealAds;
      byOrder[id].totalQuantity += row.quantity || 0;
      if (row.fullyRefunded) byOrder[id].fullyRefunded = true;
      if (row.sellerSku && !byOrder[id].skus.includes(row.sellerSku)) {
        byOrder[id].skus.push(row.sellerSku);
      }
    }
  }

  return Object.values(byOrder);
}

function onTTSAffiliateFile(input) {
  const file = input.files[0];
  if (!file) return;

  const status = document.getElementById('tts-affiliate-status');
  status.textContent = 'Leyendo...';

  file.text().then(text => {
    _ttsAffiliateRows = parseTTSAffiliateCSV(text);
    const withSku      = _ttsAffiliateRows.filter(r => r.sellerSku).length;
    const withRevenue  = _ttsAffiliateRows.filter(r => r.settlementAmount > 0).length;
    const hasSkuCol    = withSku > 0;
    const hasRevCol    = withRevenue > 0;
    const details = [];
    if (hasSkuCol)    details.push(`${withSku} con SKU`);
    if (hasRevCol)    details.push(`${withRevenue} con importe`);
    if (!hasSkuCol)   details.push('⚠ sin col. SKU');
    if (!hasRevCol)   details.push('⚠ sin col. importe');
    status.textContent = `✓ ${_ttsAffiliateRows.length} pedidos (${details.join(', ')})`;
    status.style.color = (hasSkuCol && hasRevCol) ? 'var(--gr,#1a7a42)' : '#b87800';
  }).catch(err => {
    status.textContent = 'Error al leer CSV';
    status.style.color = 'var(--re,#c0392b)';
    console.error('[TTS CSV]', err);
  });
}

// ── Parsing XLSX GMV Max (client-side via xlsx.js CDN) ────────────────────────

function parseTTSGMVXLSX(arrayBuffer) {
  try {
    const data     = new Uint8Array(arrayBuffer);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const jsonRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    // Detectar columnas
    const headers     = jsonRows.length > 0 ? Object.keys(jsonRows[0]) : [];
    const headersNorm = headers.map(normalizeStr);
    console.log('[TTS XLSX] Headers detectados:', headers);

    // "Nombre de la campaña" → buscar "campaña"/"campana" + "nombre", evitar "nombre de cuenta"
    const colCamp = (() => {
      // Prioridad: columna que tenga "campan" (campaña/campaña) + "nombre"
      let i = headersNorm.findIndex(h => h.includes('nombre') && (h.includes('campan') || h.includes('campa')));
      if (i !== -1) return i;
      // Fallback: solo "campaña"/"campana"
      i = headersNorm.findIndex(h => h.includes('campan') || h.includes('campa'));
      if (i !== -1) return i;
      // Último recurso: "nombre"
      return headersNorm.findIndex(h => h.includes('nombre'));
    })();

    // "Coste" total → TikTok exporta varias columnas con "coste":
    // "Coste por clic", "Coste por pedido", "Coste" (total spend), etc.
    // Hay que seleccionar la columna de gasto total, no las métricas derivadas.
    const colCost = (() => {
      // Prioridad 1: columna exactamente "coste" o "gasto"
      let i = headersNorm.findIndex(h => h === 'coste' || h === 'gasto');
      if (i !== -1) return i;
      // Prioridad 2: "coste total" o "gasto total"
      i = headersNorm.findIndex(h => (h.includes('coste') || h.includes('gasto')) && h.includes('total'));
      if (i !== -1) return i;
      // Prioridad 3: "coste" sin "por" (excluye "coste por clic", "coste por pedido", etc.)
      i = headersNorm.findIndex(h => (h.includes('coste') || h.includes('costo')) && !h.includes(' por ') && !h.includes(' per '));
      if (i !== -1) return i;
      // Último recurso
      return headersNorm.findIndex(h => h.includes('coste') || h.includes('costo'));
    })();

    console.log('[TTS XLSX] Columna campaña:', headers[colCamp], '| Columna coste:', headers[colCost]);

    if (colCamp === -1 || colCost === -1) {
      console.warn('[TTS XLSX] No se encontraron columnas de campaña/coste. Headers:', headers);
      return {};
    }

    const campCol = headers[colCamp];
    const costCol = headers[colCost];

    const result = {};
    for (const row of jsonRows) {
      const name  = String(row[campCol] || '').trim();
      const spend = parseFloat(String(row[costCol] || '').replace(',', '.')) || 0;
      if (name && spend > 0) {
        result[name] = (result[name] || 0) + spend;
      }
    }
    return result;
  } catch (err) {
    console.error('[TTS XLSX]', err);
    return {};
  }
}

function onTTSGMVFile(input) {
  const file = input.files[0];
  if (!file) return;

  const status = document.getElementById('tts-gmv-status');
  status.textContent = 'Leyendo...';

  file.arrayBuffer().then(buf => {
    _ttsGMVCampaigns = parseTTSGMVXLSX(buf);
    const count = Object.keys(_ttsGMVCampaigns).length;
    status.textContent = `✓ ${count} campaña${count !== 1 ? 's' : ''} cargadas`;
    status.style.color = 'var(--green, #22c55e)';
  }).catch(err => {
    status.textContent = 'Error al leer XLSX';
    status.style.color = 'var(--red, #ef4444)';
    console.error('[TTS XLSX]', err);
  });
}

// ── Smart Upload Zone ─────────────────────────────────────────────────────────

let _ttsDetectedDate = null;
let _ttsUploadState  = 'idle'; // 'idle' | 'processing' | 'ready'

function renderTTSUploadZone() {
  const zone = document.getElementById('tts-upload-zone');
  if (!zone) return;

  // Ensure date has a default
  const dateEl = document.getElementById('tts-date');
  if (dateEl && !dateEl.value) dateEl.value = today();

  // Load days strip
  loadTTSDaysStrip();

  _ttsUploadState = 'idle';
  _ttsDetectedDate = null;

  zone.innerHTML = `
  <div id="tts-dropzone"
    style="border:2px dashed var(--border,#e2e8f0);border-radius:10px;padding:14px 16px;text-align:center;cursor:pointer;transition:border-color .2s,background .2s;background:var(--lt2,#f8fafc)"
    ondragover="event.preventDefault();document.getElementById('tts-dropzone').style.borderColor='#fe2c55';document.getElementById('tts-dropzone').style.background='rgba(254,44,85,.04)'"
    ondragleave="document.getElementById('tts-dropzone').style.borderColor='';document.getElementById('tts-dropzone').style.background=''"
    ondrop="event.preventDefault();document.getElementById('tts-dropzone').style.borderColor='';document.getElementById('tts-dropzone').style.background='';handleTTSFileDrop(event)"
    onclick="if(event.target.tagName!=='A'&&event.target.tagName!=='BUTTON')document.getElementById('tts-multi-input').click()">
    <input type="file" id="tts-multi-input" accept=".csv,.xlsx,.xls" multiple style="display:none"
      onchange="handleTTSFileInput(this)">
    <div id="tts-zone-content"></div>
  </div>
  <div id="tts-manual-fallback" style="display:none;margin-top:10px;padding:12px 16px;background:var(--lt2);border-radius:8px;border:1px solid var(--border,#e2e8f0)">
    <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--md)">📅 Cargar sin archivos</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input type="date" id="tts-manual-date" style="width:150px">
      <button class="btn btn-primary btn-sm" onclick="triggerTTSManual()">⬇ Cargar día</button>
      <button class="btn btn-secondary btn-sm" onclick="toggleTTSManual(false)">✕</button>
    </div>
  </div>`;

  _refreshTTSZone();
}

function _ttsZoneHTML() {
  if (_ttsUploadState === 'processing') {
    return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0">
      <div style="display:flex;gap:5px">
        <span style="width:8px;height:8px;background:#fe2c55;border-radius:50%;animation:pulse .8s ease-in-out 0s infinite"></span>
        <span style="width:8px;height:8px;background:#fe2c55;border-radius:50%;animation:pulse .8s ease-in-out .2s infinite"></span>
        <span style="width:8px;height:8px;background:#fe2c55;border-radius:50%;animation:pulse .8s ease-in-out .4s infinite"></span>
      </div>
      <div style="font-weight:600;font-size:14px;color:var(--fg)">Procesando archivos…</div>
      <div style="font-size:11px;color:var(--md)">Detectando fecha y leyendo datos</div>
    </div>`;
  }

  if (_ttsUploadState === 'ready') {
    const dateVal = _ttsDetectedDate || document.getElementById('tts-date').value;
    let dateDisplay = '—';
    if (dateVal) {
      try {
        dateDisplay = new Date(dateVal + 'T12:00:00').toLocaleDateString('es-ES',
          { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
        dateDisplay = dateDisplay.charAt(0).toUpperCase() + dateDisplay.slice(1);
      } catch(e) { dateDisplay = dateVal; }
    }
    const hasAfil = _ttsAffiliateRows.length > 0;
    const hasGMV  = Object.keys(_ttsGMVCampaigns).length > 0;
    return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:10px">
      <div style="font-size:13px;font-weight:700;color:var(--fg)">📅 ${dateDisplay}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        ${hasAfil
          ? `<span style="padding:3px 12px;border-radius:12px;background:rgba(34,197,94,.13);color:#16a34a;font-size:11px;font-weight:600">✓ ${_ttsAffiliateRows.length} pedidos afiliados</span>`
          : `<span style="padding:3px 12px;border-radius:12px;background:rgba(148,163,184,.1);color:var(--md);font-size:11px">— Sin CSV afiliados</span>`}
        ${hasGMV
          ? `<span style="padding:3px 12px;border-radius:12px;background:rgba(34,197,94,.13);color:#16a34a;font-size:11px;font-weight:600">✓ ${Object.keys(_ttsGMVCampaigns).length} campañas GMV</span>`
          : `<span style="padding:3px 12px;border-radius:12px;background:rgba(148,163,184,.1);color:var(--md);font-size:11px">— Sin XLSX campañas</span>`}
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();autoGenerateTTSReport()">⬇ Generar reporte</button>
        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();resetTTSUpload()">↺ Cambiar archivos</button>
      </div>
    </div>`;
  }

  // idle — compact version
  return `
  <div style="font-size:13px;font-weight:700;margin-bottom:6px;color:var(--fg)">📂 Importar día nuevo</div>
  <div style="font-size:11px;color:var(--md);margin-bottom:8px">CSV Afiliados + XLSX GMV Max</div>
  <div style="display:inline-flex;gap:6px;align-items:center;padding:6px 14px;background:rgba(254,44,85,.12);border-radius:16px;color:#fe2c55;font-size:11px;font-weight:700;pointer-events:none">
    📁 Seleccionar archivos
  </div>
  <div style="margin-top:8px;font-size:10px;color:var(--md)">
    <a href="#" onclick="event.stopPropagation();toggleTTSManual(true)" style="color:var(--md);text-decoration:underline dotted;text-underline-offset:2px">Fecha manual →</a>
  </div>`;
}

function _refreshTTSZone() {
  const c = document.getElementById('tts-zone-content');
  if (c) c.innerHTML = _ttsZoneHTML();
}

function toggleTTSManual(show) {
  const fb = document.getElementById('tts-manual-fallback');
  if (!fb) return;
  fb.style.display = show ? 'block' : 'none';
  if (show) {
    const md = document.getElementById('tts-manual-date');
    if (md) md.value = document.getElementById('tts-date').value || today();
    if (md) md.focus();
  }
}

function triggerTTSManual() {
  const md = document.getElementById('tts-manual-date');
  if (!md || !md.value) return alert('Seleccioná una fecha');
  document.getElementById('tts-date').value = md.value;
  toggleTTSManual(false);
  loadTTSReport();
}

function resetTTSUpload() {
  _ttsAffiliateRows = [];
  _ttsGMVCampaigns  = {};
  _ttsDetectedDate  = null;
  _ttsUploadState   = 'idle';
  _refreshTTSZone();
  document.getElementById('tts-content').innerHTML = `
    <div class="empty-state">
      <div class="icon">🛒</div>
      <div class="msg">Arrastrá tus archivos para generar el reporte</div>
      <div class="hint">CSV de afiliados + XLSX de campañas GMV Max · la fecha se detecta sola</div>
    </div>`;
}

function handleTTSFileDrop(event) {
  if (event.dataTransfer.files.length) handleTTSFiles(event.dataTransfer.files);
}

function handleTTSFileInput(input) {
  if (input.files.length) handleTTSFiles(input.files);
  input.value = ''; // reset so same files can be re-selected
}

async function handleTTSFiles(fileList) {
  _ttsUploadState = 'processing';
  _refreshTTSZone();

  let csvFile = null, xlsxFile = null;
  for (const file of fileList) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.csv'))                          csvFile  = file;
    else if (name.endsWith('.xlsx') || name.endsWith('.xls')) xlsxFile = file;
  }

  let detectedDate = null;

  // ── CSV afiliados ──────────────────────────────────────────────────────────
  if (csvFile) {
    try {
      const text = await csvFile.text();
      _ttsAffiliateRows = parseTTSAffiliateCSV(text);
      const d = _extractDateFromAffiliateCsv(text);
      if (d) detectedDate = d;
    } catch (e) { console.error('[TTS Upload] CSV error:', e); }
  }

  // ── XLSX campañas ──────────────────────────────────────────────────────────
  if (xlsxFile) {
    try {
      const buf = await xlsxFile.arrayBuffer();
      _ttsGMVCampaigns = parseTTSGMVXLSX(buf);
      if (!detectedDate) {
        const d = _extractDateFromGMVFilename(xlsxFile.name);
        if (d) detectedDate = d;
      }
    } catch (e) { console.error('[TTS Upload] XLSX error:', e); }
  }

  // ── Aplicar fecha detectada ────────────────────────────────────────────────
  if (detectedDate) {
    _ttsDetectedDate = detectedDate;
    document.getElementById('tts-date').value = detectedDate;
  }

  _ttsUploadState = 'ready';
  _refreshTTSZone();

  // Auto-generar si tenemos al menos un archivo
  if (csvFile || xlsxFile) autoGenerateTTSReport();
}

function _extractDateFromAffiliateCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 2) return null;

  const sep        = detectSeparator(lines[0]);
  const headerNorm = parseCSVRow(lines[0], sep)
    .map(h => normalizeStr(h.replace(/^"|"$/g, '')));

  // Columna "Fecha/hora de creación" → contiene 'fecha' + ('creaci' o 'hora')
  let colDate = headerNorm.findIndex(h => h.includes('fecha') && (h.includes('creaci') || h.includes('hora')));
  if (colDate === -1) colDate = headerNorm.findIndex(h => h.includes('fecha'));
  if (colDate === -1) return null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const val = (parseCSVRow(line, sep)[colDate] || '').replace(/^"|"$/g, '').trim();
    const d = _parseCsvDateCell(val);
    if (d) return d;
  }
  return null;
}

function _parseCsvDateCell(val) {
  // "DD/MM/YYYY HH:MM:SS" or "DD/MM/YYYY"
  const m = val.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // "YYYY-MM-DD"
  const m2 = val.match(/(\d{4}-\d{2}-\d{2})/);
  if (m2) return m2[1];
  return null;
}

function _extractDateFromGMVFilename(filename) {
  // "Product campaign data 2026-04-05 - 2026-04-05.xlsx" → last date = end date
  const matches = filename.match(/\d{4}-\d{2}-\d{2}/g);
  return matches ? matches[matches.length - 1] : null;
}

async function autoGenerateTTSReport() {
  const date = document.getElementById('tts-date').value;
  if (!date) { toggleTTSManual(true); return; }
  await loadTTSReport();
}

// ── Cargar reporte ────────────────────────────────────────────────────────────

async function loadTTSReport() {
  const date = document.getElementById('tts-date').value;
  if (!date) return alert('Seleccioná una fecha primero');

  const el = document.getElementById('tts-content');
  el.innerHTML = '<div class="loading">⏳ Obteniendo pedidos desde Simla... (puede tardar)</div>';

  try {
    const result = await API.ttsReport({
      date,
      affiliateRows: _ttsAffiliateRows,
      gmvCampaigns:  _ttsGMVCampaigns,
    });

    _ttsLastResult = { date, result };
    _ttsPLData   = result.pl || [];
    _ttsSortCol  = 'net_profit';
    _ttsSortAsc  = false;
    renderTTSReport(date, result);
  } catch (err) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">⚠️</div>
      <div class="msg">Error al cargar</div>
      <div class="hint">${err.message}</div>
    </div>`;
  }
}

// ── Renderizar reporte ────────────────────────────────────────────────────────

function marginColor(pct) {
  if (pct >= 20) return 'green';
  if (pct >= 10) return 'orange';
  return 'red';
}

// ─── Motor SVG: donut chart ───────────────────────────────────────────────────
// slices: [{ label, value, color }]
// opts: { cx, cy, r, innerR, size, centerLabel, centerSub }
function buildSvgDonut(slices, opts = {}) {
  const { cx = 72, cy = 72, r = 60, innerR = 36, size = 144,
          centerLabel = '', centerSub = '' } = opts;
  const total = slices.reduce((s, sl) => s + (sl.value || 0), 0) || 1;
  let startAngle = -Math.PI / 2;
  let paths = '', txtLabels = '';

  for (const s of slices) {
    const angle    = (s.value / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const pct      = Math.round((s.value / total) * 100);

    // Camino del sector completo (de centro a arco)
    const x1 = cx + r * Math.cos(startAngle), y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle),   y2 = cy + r * Math.sin(endAngle);
    const large = angle > Math.PI ? 1 : 0;
    paths += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z"
      fill="${s.color}" stroke="#fff" stroke-width="1.5"/>`;

    // % dentro del sector (solo si ≥ 8%)
    if (pct >= 8) {
      const mid = startAngle + angle / 2;
      const lr  = (r + innerR) / 2;           // radio medio entre interior y exterior
      const lx  = cx + lr * Math.cos(mid);
      const ly  = cy + lr * Math.sin(mid);
      txtLabels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}"
        text-anchor="middle" dominant-baseline="middle"
        fill="#fff" font-size="10" font-weight="700">${pct}%</text>`;
    }
    startAngle = endAngle;
  }

  // Agujero central (efecto donut)
  const hole = `<circle cx="${cx}" cy="${cy}" r="${innerR}" fill="var(--card-bg,#fff)"/>`;

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
    ${paths}${hole}${txtLabels}
    ${centerLabel ? `<text x="${cx}" y="${cy - 5}" text-anchor="middle" fill="var(--fg,#1e293b)" font-size="16" font-weight="700">${centerLabel}</text>` : ''}
    ${centerSub   ? `<text x="${cx}" y="${cy + 13}" text-anchor="middle" fill="var(--md,#94a3b8)" font-size="9">${centerSub}</text>` : ''}
  </svg>`;
}

// ─── Gráfico 1: Donut de distribución de pedidos por origen ──────────────────
function ttsPieOrderTypes(summary) {
  const total  = summary.orders || 1;
  const slices = [
    { label: 'Propio',     emoji: '🏠', value: summary.orders_propio,    color: '#3b82f6' },
    { label: 'Paid Afil.', emoji: '🎯', value: summary.orders_paid_afil, color: '#f59e0b' },
    { label: 'Org. Afil.', emoji: '🤝', value: summary.orders_org_afil,  color: '#8b5cf6' },
  ].filter(s => s.value > 0);

  const svg = buildSvgDonut(slices, {
    cx: 72, cy: 72, r: 62, innerR: 38, size: 144,
    centerLabel: String(total), centerSub: 'pedidos',
  });

  const legend = slices.map(s => {
    const pct = Math.round((s.value / total) * 100);
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--lt2)">
      <span style="width:13px;height:13px;border-radius:3px;background:${s.color};flex-shrink:0"></span>
      <span style="flex:1;font-size:12px">${s.emoji} ${s.label}</span>
      <strong style="font-size:14px;font-weight:700">${s.value}</strong>
      <span style="font-size:11px;color:var(--md);min-width:34px;text-align:right">${pct}%</span>
    </div>`;
  }).join('');

  return `<div style="display:flex;gap:18px;align-items:center">
    <div style="flex-shrink:0">${svg}</div>
    <div style="flex:1">${legend}</div>
  </div>`;
}

// ─── Gráfico 2: Barra apilada horizontal — estructura P&L ────────────────────
function ttsPLStackedBar(summary) {
  const total = summary.gmv || 1;
  const parts = [
    { label: 'IVA',         short: 'IVA',   value: summary.iva,                     color: '#f87171' },
    { label: 'COGS',        short: 'COGS',  value: summary.cogs,                    color: '#fb923c' },
    { label: 'Envíos',      short: 'Env.',  value: summary.shipping,                color: '#fbbf24' },
    { label: 'Com. TikTok', short: 'TTS',   value: summary.tiktok_platform,         color: '#f59e0b' },
    { label: 'Ads',         short: 'Ads',   value: summary.gmv_max_spend,           color: '#60a5fa' },
    { label: 'Afiliados',   short: 'Afil.', value: summary.commission_cost,         color: '#a78bfa' },
    { label: 'Beneficio',   short: 'Ben.',  value: Math.max(0, summary.net_profit), color: '#4ade80' },
  ].filter(p => p.value > 0);

  const segments = parts.map(p => {
    const pct    = (p.value / total * 100);
    const pctStr = pct.toFixed(1);
    const showTxt = pct >= 7;
    return `<div style="position:relative;width:${pctStr}%;background:${p.color};height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden" title="${p.label}: ${pctStr}%">
      ${showTxt ? `<span style="font-size:9px;font-weight:700;color:#fff;white-space:nowrap">${pctStr}%</span>` : ''}
    </div>`;
  }).join('');

  const legendGrid = parts.map(p => {
    const pct = (p.value / total * 100).toFixed(1);
    return `<div style="display:flex;align-items:center;gap:6px">
      <span style="width:10px;height:10px;border-radius:2px;background:${p.color};flex-shrink:0"></span>
      <span style="font-size:11px;color:var(--md)">${p.label}</span>
      <strong style="font-size:11px;margin-left:auto;padding-left:8px">${pct}%</strong>
    </div>`;
  }).join('');

  return `
    <div style="height:30px;border-radius:8px;overflow:hidden;display:flex;box-shadow:inset 0 0 0 1px rgba(0,0,0,.07)">
      ${segments}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 18px;margin-top:10px">
      ${legendGrid}
    </div>`;
}

// ─── Gráfico 3: Barras horizontales por SKU/Grupo ─────────────────────────────
function ttsBarSkuRevenue(pl, summary) {
  const COLORS = ['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899'];
  const total  = summary.gmv || 1;
  const clean  = name => (name || '').replace(/-+$/, '');   // quitar guiones finales
  const sorted = [...pl].sort((a, b) => b.revenue - a.revenue);
  const top    = sorted.slice(0, 9);
  const otherR = sorted.slice(9).reduce((s, g) => s + g.revenue, 0);

  const makeRow = (name, revenue, color, i) => {
    const pct    = (revenue / total * 100);
    const pctStr = pct.toFixed(1);
    return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="width:82px;font-size:11px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0" title="${name}">${name}</div>
      <div style="flex:1;background:rgba(0,0,0,.06);border-radius:4px;height:14px;overflow:hidden">
        <div style="width:${pctStr}%;background:${color};height:100%;border-radius:4px"></div>
      </div>
      <div style="font-size:12px;font-weight:700;color:${color};min-width:38px;text-align:right">${pctStr}%</div>
      <div style="font-size:11px;color:var(--md);min-width:58px;text-align:right">${fe(revenue)}</div>
    </div>`;
  };

  const rows = top.map((g, i) => makeRow(clean(g.display_name || g.grupo), g.revenue, COLORS[i % COLORS.length], i)).join('');
  const otherRow = otherR > 0 ? makeRow('Otros', otherR, '#94a3b8', 9) : '';

  return `<div>${rows}${otherRow}</div>`;
}

let _ttsPLData      = [];
let _ttsSortCol     = 'net_profit';
let _ttsSortAsc     = false;
let _ttsAcosUniform = false;   // true cuando el gasto no está mapeado a grupos
let _ttsGlobalAcos  = 0;

function _acosCell(g) {
  const acos = g.revenue > 0 && g.gmv_max_spend > 0
    ? (g.gmv_max_spend / g.revenue * 100) : 0;
  if (acos <= 0) return '—';
  if (_ttsAcosUniform) {
    return `<span style="padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600;background:rgba(148,163,184,.15);color:#94a3b8" title="Promedio global — campañas no mapeadas a grupos">≈${fp(acos)}</span>`;
  }
  const c  = acos <= 15 ? '#16a34a' : acos <= 30 ? '#b45309' : '#dc2626';
  const bg = acos <= 15 ? 'rgba(34,197,94,.13)' : acos <= 30 ? 'rgba(245,158,11,.13)' : 'rgba(239,68,68,.13)';
  return `<span style="padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;background:${bg};color:${c}">${fp(acos)}</span>`;
}

function renderTTSPLRows(rows) {
  return rows.map(g => {
    const mc = marginColor(g.margin_pct);
    return `<tr>
      <td style="font-weight:600">${g.display_name || g.grupo}</td>
      <td style="text-align:right">${g.orders}</td>
      <td style="text-align:right">${g.orders_propio}</td>
      <td style="text-align:right">${g.orders_paid_afil}</td>
      <td style="text-align:right">${g.orders_org_afil}</td>
      <td style="text-align:right">${fe(g.revenue)}</td>
      <td style="text-align:right" class="text-red">${fe(g.cogs)}</td>
      <td style="text-align:right" class="text-red">${fe(g.shipping)}</td>
      <td style="text-align:right" class="text-red">${fe(g.tiktok_platform)}</td>
      <td style="text-align:right" class="text-red">${fe(g.gmv_max_spend)}</td>
      <td style="text-align:right">${_acosCell(g)}</td>
      <td style="text-align:right">${g.cpa > 0 ? fe(g.cpa) : '—'}</td>
      <td style="text-align:right" class="text-red">${fe(g.commission_cost)}</td>
      <td style="text-align:right;font-weight:700" class="${g.net_profit >= 0 ? 'text-green' : 'text-red'}">${fe(g.net_profit)}</td>
      <td style="text-align:right">
        <span style="padding:2px 8px;border-radius:4px;font-size:12px;font-weight:700;
          background:${mc === 'green' ? 'rgba(34,197,94,.15)' : mc === 'orange' ? 'rgba(245,158,11,.15)' : 'rgba(239,68,68,.15)'};
          color:${mc === 'green' ? '#16a34a' : mc === 'orange' ? '#b45309' : '#dc2626'}">
          ${fp(g.margin_pct)}
        </span>
      </td>
    </tr>`;
  }).join('');
}

function sortTTSPL(col) {
  if (_ttsSortCol === col) {
    _ttsSortAsc = !_ttsSortAsc;
  } else {
    _ttsSortCol = col;
    _ttsSortAsc = false;
  }

  const sorted = [..._ttsPLData].sort((a, b) => {
    const va = a[col] ?? a['grupo'], vb = b[col] ?? b['grupo'];
    if (typeof va === 'string') return _ttsSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return _ttsSortAsc ? (va - vb) : (vb - va);
  });

  const tbody = document.getElementById('tts-pl-tbody');
  if (tbody) tbody.innerHTML = renderTTSPLRows(sorted);

  // Actualizar flechas
  document.querySelectorAll('#tts-pl-tbl thead th').forEach(th => {
    const arrow = th.querySelector('.sort-arrow');
    if (!arrow) return;
    if (th.dataset.sort === col) {
      arrow.textContent = _ttsSortAsc ? ' ▲' : ' ▼';
    } else {
      arrow.textContent = '';
    }
  });
}

function _buildTopAffiliates(limit = 10) {
  if (_ttsAffiliateRows.length === 0) {
    return `<div style="font-size:12px;color:var(--md);padding:10px 0;text-align:center">Sin datos de afiliados</div>`;
  }

  // Agrupar por creador
  const creators = {};
  for (const af of _ttsAffiliateRows) {
    const name = af.creatorName || 'Desconocido';
    const noApto = (af.orderStatus || '').toLowerCase().includes('no apt');
    const refunded = af.fullyRefunded;
    if (refunded) continue;

    if (!creators[name]) creators[name] = { orders: 0, revenue: 0, commission: 0, paid: 0, organic: 0, noApto: 0, contentType: af.contentType || '', videos: {} };
    creators[name].orders++;
    creators[name].revenue += af.settlementAmount || 0;
    // Track ventas por video
    if (af.contentId) {
      if (!creators[name].videos[af.contentId]) creators[name].videos[af.contentId] = 0;
      creators[name].videos[af.contentId]++;
    }

    if (noApto) { creators[name].noApto++; continue; }

    const comm = (parseFloat(af.commReal) || 0) + (parseFloat(af.commRealAds) || 0);
    creators[name].commission += comm;

    if (parseFloat(af.commPctAds) > 0) creators[name].paid++;
    else if (parseFloat(af.commPctStandard) > 0) creators[name].organic++;
  }

  const sorted = Object.entries(creators)
    .map(([name, d]) => {
      // Top video = el que más ventas generó
      const topVideo = Object.entries(d.videos).sort((a, b) => b[1] - a[1])[0];
      return { name, ...d, topVideoId: topVideo?.[0] || '', topVideoSales: topVideo?.[1] || 0 };
    })
    .sort((a, b) => b.orders - a.orders)
    .slice(0, limit);

  if (sorted.length === 0) {
    return `<div style="font-size:12px;color:var(--md);padding:10px 0;text-align:center">Sin afiliados activos</div>`;
  }

  const rows = sorted.map((c, i) => {
    const typeLabel = c.paid > 0 && c.organic > 0 ? '🎯+🤝'
      : c.paid > 0 ? '🎯 Paid' : '🤝 Org.';
    const typeColor = c.paid > 0 ? '#f59e0b' : '#8b5cf6';
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0;${i > 0 ? 'border-top:1px solid var(--lt2);' : ''}">
        <div style="width:16px;height:16px;border-radius:50%;background:${typeColor};color:#fff;font-size:8px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i + 1}</div>
        <div style="flex:1;min-width:0">
          <a href="https://www.tiktok.com/@${encodeURIComponent(c.name)}" target="_blank" style="font-size:10px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;color:var(--dk);text-decoration:none" class="tts-link">${c.name}</a>
          <div style="font-size:8px;color:var(--md)">${typeLabel}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:11px;font-weight:700">${c.orders}</div>
          <div style="font-size:9px;color:var(--md)">${fe(c.revenue)}</div>
        </div>
      </div>`;
  }).join('');

  const totalCreators = Object.keys(creators).length;
  const expandAfil = totalCreators > limit ? `
    <div style="text-align:center;margin-top:4px">
      <span onclick="document.getElementById('tts-top-afil').style.maxHeight='none';this.remove();"
        style="font-size:10px;color:#fe2c55;cursor:pointer;font-weight:600">Ver ${totalCreators - limit} más ▾</span>
    </div>` : '';

  return rows + expandAfil;
}

function _buildTopVideos(limit = 5) {
  if (_ttsAffiliateRows.length === 0) {
    return `<div style="font-size:11px;color:var(--md);padding:10px 0;text-align:center">Sin datos de videos</div>`;
  }

  // Agrupar por contentId
  const videos = {};
  for (const af of _ttsAffiliateRows) {
    if (af.fullyRefunded) continue;
    const vid = af.contentId;
    if (!vid) continue;

    if (!videos[vid]) videos[vid] = { creator: af.creatorName || '?', sales: 0, revenue: 0, contentType: af.contentType || '', products: {} };
    videos[vid].sales++;
    videos[vid].revenue += af.settlementAmount || 0;
    const prod = af.productName || af.sellerSku || '';
    if (prod) videos[vid].products[prod] = (videos[vid].products[prod] || 0) + 1;
  }

  const sorted = Object.entries(videos)
    .map(([id, d]) => {
      const topProduct = Object.entries(d.products).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      return { id, ...d, topProduct };
    })
    .sort((a, b) => b.sales - a.sales);

  const visible = sorted.slice(0, limit);
  const hasMore = sorted.length > limit;

  if (visible.length === 0) {
    return `<div style="font-size:11px;color:var(--md);padding:10px 0;text-align:center">Sin videos detectados</div>`;
  }

  const rows = visible.map((v, i) => `
    <div style="display:flex;align-items:center;gap:6px;padding:4px 0;${i > 0 ? 'border-top:1px solid var(--lt2);' : ''}">
      <div style="width:16px;height:16px;border-radius:50%;background:#fe2c55;color:#fff;font-size:8px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${i + 1}</div>
      <div style="flex:1;min-width:0">
        <a href="https://www.tiktok.com/@${encodeURIComponent(v.creator)}/video/${v.id}" target="_blank" style="font-size:10px;font-weight:600;color:var(--dk);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block" class="tts-link">${v.creator}</a>
        <div style="font-size:8px;color:var(--md);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${v.topProduct}">${v.topProduct || v.contentType}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:11px;font-weight:700">${v.sales} ven.</div>
        <div style="font-size:9px;color:var(--md)">${fe(v.revenue)}</div>
      </div>
    </div>`).join('');

  const expandBtn = hasMore ? `
    <div style="text-align:center;margin-top:4px">
      <span onclick="document.getElementById('tts-top-videos').style.maxHeight='none';this.remove();"
        style="font-size:10px;color:#fe2c55;cursor:pointer;font-weight:600">Ver ${sorted.length - limit} más ▾</span>
    </div>` : '';

  return rows + expandBtn;
}

function renderTTSReport(date, result) {
  const el = document.getElementById('tts-content');
  const { pl, summary } = result;

  if (!pl || pl.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">📭</div>
      <div class="msg">Sin pedidos TTS para ${fd(date)}</div>
      <div class="hint">Simla no devolvió datos de TikTok Shop para esta fecha.</div>
    </div>`;
    return;
  }

  const mColor = marginColor(summary.margin_pct);

  // Detectar ACOS uniforme (gasto distribuido globalmente sin mapeo a grupos)
  _ttsGlobalAcos  = summary.gmv > 0 && summary.gmv_max_spend > 0
    ? (summary.gmv_max_spend / summary.gmv * 100) : 0;
  const plConAcos = pl.filter(g => g.gmv_max_spend > 0 && g.revenue > 0);
  _ttsAcosUniform = plConAcos.length > 1 &&
    plConAcos.every(g => Math.abs((g.gmv_max_spend / g.revenue * 100) - _ttsGlobalAcos) < 0.3);

  // % de cada coste sobre facturación
  const pctOf = (v) => summary.gmv > 0 ? fp(v / summary.gmv * 100, 1) : '';

  // Helper: fila de coste — label | importe  %
  const costRow = (label, value, pct) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--lt2)">
       <span style="font-size:12px;color:var(--md)">${label}</span>
       <span style="font-size:13px;font-weight:600;color:#ef4444">${fe(value)}<span style="font-size:10px;font-weight:400;color:var(--md);margin-left:5px">${pct}</span></span>
     </div>`;

  // Objetivo de beneficio: 60% del COGS
  const TARGET_PCT = 60;
  const targetProfit = summary.cogs * (TARGET_PCT / 100);
  const targetDiff   = summary.net_profit - targetProfit;
  const targetMet    = targetDiff >= 0;
  // Barra de progreso — muestra % real (puede superar 100%)
  const barPctReal = targetProfit > 0 ? Math.round((summary.net_profit / targetProfit) * 100) : 0;
  const barPctClamped = Math.min(100, barPctReal); // para el ancho visual
  const barColor = targetMet ? '#22c55e' : (barPctReal >= 70 ? '#f59e0b' : '#ef4444');

  el.innerHTML = `
  <style>.tts-link{color:var(--dk);text-decoration:none}.tts-link:hover{color:#fe2c55!important}</style>
  <div id="tts-export-area">

    <!-- ── Fila 1: Facturación + Beneficio ── -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">

      <!-- FACTURACIÓN -->
      <div class="kpi-card" style="padding:16px 18px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
          <div>
            <div class="kpi-label">Facturación</div>
            <div class="kpi-value" style="font-size:30px;line-height:1.1">${fe(summary.gmv)}</div>
          </div>
          <div style="text-align:right;background:rgba(0,0,0,.08);border-radius:8px;padding:8px 14px">
            <div style="font-size:9px;font-weight:700;color:var(--md);text-transform:uppercase;letter-spacing:.5px">Pedidos</div>
            <div style="font-size:28px;font-weight:700;line-height:1.1">${summary.orders}</div>
            <div style="font-size:10px;color:var(--md)">${summary.cpa > 0 ? 'CPA ' + fe(summary.cpa) : ''}</div>
          </div>
        </div>
        <div style="border-top:1px solid var(--lt2);padding-top:8px">
          ${costRow('− IVA', summary.iva, pctOf(summary.iva))}
          ${costRow('− Comisión plataforma TikTok 9%', summary.tiktok_platform, pctOf(summary.tiktok_platform))}
          ${costRow('− Envíos', summary.shipping, pctOf(summary.shipping))}
          ${costRow('− COGS (coste de producto)', summary.cogs, pctOf(summary.cogs))}
          ${costRow('− Ads (GMV Max)', summary.gmv_max_spend, pctOf(summary.gmv_max_spend))}
          ${costRow('− Comisiones afiliados', summary.commission_cost, pctOf(summary.commission_cost))}
        </div>
      </div>

      <!-- BENEFICIO -->
      <div class="kpi-card ${mColor}" style="padding:16px 18px;display:flex;flex-direction:column;gap:12px">

        <!-- Neto + márgenes -->
        <div>
          <div class="kpi-label">Beneficio Neto</div>
          <div class="kpi-value" style="font-size:30px;line-height:1.1;margin-bottom:10px">${fe(summary.net_profit)}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div style="background:rgba(0,0,0,.12);border-radius:8px;padding:9px;text-align:center">
              <div style="font-size:9px;font-weight:700;opacity:.7;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Margen s/Facturación</div>
              <div style="font-size:22px;font-weight:700">${fp(summary.margin_pct)}</div>
            </div>
            <div style="background:rgba(0,0,0,.12);border-radius:8px;padding:9px;text-align:center">
              <div style="font-size:9px;font-weight:700;opacity:.7;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px">Margen s/COGS</div>
              <div style="font-size:22px;font-weight:700">${fp(summary.margin_pct_cogs)}</div>
            </div>
          </div>
        </div>

        <!-- Objetivo 60% COGS -->
        <div style="border-top:1px solid rgba(255,255,255,.15);padding-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
            <span style="font-size:11px;font-weight:600;opacity:.8">Objetivo (${TARGET_PCT}% del COGS)</span>
            <span style="font-size:13px;font-weight:700;opacity:.9">${fe(targetProfit)}</span>
          </div>
          <!-- Barra de progreso -->
          <div style="background:rgba(0,0,0,.2);border-radius:4px;height:8px;margin-bottom:6px;overflow:hidden;position:relative">
            <div style="height:100%;border-radius:4px;width:${barPctClamped}%;background:${barColor};transition:width .4s"></div>
            ${barPctReal > 100 ? `<div style="position:absolute;right:4px;top:-1px;font-size:8px;font-weight:700;color:#fff">${barPctReal}%</div>` : ''}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-size:11px;opacity:.7">${barPctReal}% del objetivo</span>
            <span style="font-size:12px;font-weight:700;color:${targetMet ? '#86efac' : '#fca5a5'}">
              ${targetMet ? '✓ Superado +' + fe(targetDiff) : '✗ Faltan ' + fe(Math.abs(targetDiff))}
            </span>
          </div>
        </div>

        <!-- Gross Profit info -->
        <div style="background:rgba(0,0,0,.1);border-radius:7px;padding:8px 10px;font-size:11px;opacity:.8;display:flex;justify-content:space-between">
          <span>Beneficio bruto (antes de ads y afiliados)</span>
          <strong>${fe(summary.gross_profit)}</strong>
        </div>

      </div>
    </div>

    <!-- ── 3 tarjetas: Estructura · Distribución · SKU Revenue ── -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;margin-bottom:12px">

      <!-- Columna 1: Top Afiliados -->
      <div class="card" style="padding:12px">
        <div class="card-title" style="font-size:11px;margin-bottom:6px">Top Afiliados</div>
        <div style="max-height:300px;overflow-y:auto" id="tts-top-afil">${_buildTopAffiliates(50)}</div>
      </div>

      <!-- Columna 2: Top Videos -->
      <div class="card" style="padding:12px">
        <div class="card-title" style="font-size:11px;margin-bottom:6px">Top Videos</div>
        <div style="max-height:300px;overflow-y:auto" id="tts-top-videos">${_buildTopVideos(50)}</div>
      </div>

      <!-- Columna 2: Distribución de pedidos + estructura P&L -->
      <div class="card">
        <div class="card-title">Distribución de pedidos</div>

        <!-- Donut: tipos de origen -->
        <div style="font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--md);margin-bottom:8px">Origen</div>
        ${ttsPieOrderTypes(summary)}

        <!-- Barra apilada: estructura P&L -->
        <div style="border-top:1px solid var(--lt2);margin:14px 0 10px"></div>
        <div style="font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--md);margin-bottom:8px">Estructura del ingreso</div>
        ${ttsPLStackedBar(summary)}

        ${_ttsAffiliateRows.length === 0 ? `
          <div style="margin-top:12px;padding:7px 9px;background:rgba(245,158,11,.08);border:1.5px solid rgba(245,158,11,.3);border-radius:6px;font-size:10px;color:var(--md)">
            ⚠️ Sin CSV de afiliados — todos clasificados como orgánicos.
          </div>` : ''}
        ${Object.keys(_ttsGMVCampaigns).length === 0 ? `
          <div style="margin-top:5px;padding:7px 9px;background:rgba(59,130,246,.08);border:1.5px solid rgba(59,130,246,.3);border-radius:6px;font-size:10px;color:var(--md)">
            ℹ️ Sin XLSX GMV Max — gasto ads = €0.
          </div>` : ''}
      </div>

      <!-- Columna 3: Facturación por SKU / Grupo (barras horizontales) -->
      <div class="card">
        <div class="card-title">Facturación por SKU / Grupo</div>
        <div style="font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--md);margin-bottom:12px">% sobre facturación total del día</div>
        ${ttsBarSkuRevenue(pl, summary)}
      </div>

    </div>

    ${_ttsAcosUniform && summary.gmv_max_spend > 0 ? `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;margin:0 0 10px;background:rgba(245,158,11,.08);border:1.5px solid rgba(245,158,11,.3);border-radius:7px;font-size:12px;color:var(--md)">
      <span style="font-size:15px">⚠️</span>
      <div>
        <strong style="color:var(--fg)">ACOS por grupo no disponible</strong> — el gasto GMV Max se distribuyó proporcionalmente por revenue.
        Todos los grupos muestran el mismo ACOS global (<strong>${fp(_ttsGlobalAcos)}</strong>).
      </div>
    </div>` : ''}

    <!-- ── P&L por SKU/grupo ── -->
    <div>
      <div class="section-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>P&L por SKU / grupo</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-secondary btn-sm" onclick="exportTTSJpg('${date}')">📷 Exportar JPG</button>
          <button class="btn btn-primary btn-sm" onclick="saveTTSHistory()">💾 Guardar historial</button>
        </div>
      </div>

      <div class="table-wrap" style="margin-top:8px">
        <table id="tts-pl-tbl">
          <thead>
            <tr>
              <th data-sort="display_name" style="cursor:pointer">SKU / Grupo <span class="sort-arrow"></span></th>
              <th data-sort="orders" style="text-align:right;cursor:pointer">Ped. <span class="sort-arrow"></span></th>
              <th data-sort="orders_propio" style="text-align:right;cursor:pointer" title="Orgánico propio">🏠<span class="sort-arrow"></span></th>
              <th data-sort="orders_paid_afil" style="text-align:right;cursor:pointer" title="Paid + Afiliado">🎯<span class="sort-arrow"></span></th>
              <th data-sort="orders_org_afil" style="text-align:right;cursor:pointer" title="Orgánico afiliado">🤝<span class="sort-arrow"></span></th>
              <th data-sort="revenue" style="text-align:right;cursor:pointer">Facturación <span class="sort-arrow"></span></th>
              <th data-sort="cogs" style="text-align:right;cursor:pointer">COGS <span class="sort-arrow"></span></th>
              <th data-sort="shipping" style="text-align:right;cursor:pointer">Envío <span class="sort-arrow"></span></th>
              <th data-sort="tiktok_platform" style="text-align:right;cursor:pointer">Com.TTS <span class="sort-arrow"></span></th>
              <th data-sort="gmv_max_spend" style="text-align:right;cursor:pointer">Ads <span class="sort-arrow"></span></th>
              <th style="text-align:right" title="${_ttsAcosUniform ? 'ACOS global — sin mapeo por campaña' : 'Advertising Cost of Sales = Ads / Facturación'}">
                ACOS%${_ttsAcosUniform ? ' ⚠️' : ''}
              </th>
              <th data-sort="cpa" style="text-align:right;cursor:pointer">CPA <span class="sort-arrow"></span></th>
              <th data-sort="commission_cost" style="text-align:right;cursor:pointer">Afil. <span class="sort-arrow"></span></th>
              <th data-sort="net_profit" style="text-align:right;cursor:pointer">Beneficio <span class="sort-arrow"></span></th>
              <th data-sort="margin_pct" style="text-align:right;cursor:pointer">Mg% <span class="sort-arrow"></span></th>
            </tr>
          </thead>
          <tbody id="tts-pl-tbody">
            ${renderTTSPLRows(pl)}
          </tbody>
          <tfoot>
            <tr>
              <td class="font-bold">TOTAL</td>
              <td style="text-align:right">${summary.orders}</td>
              <td style="text-align:right">${summary.orders_propio}</td>
              <td style="text-align:right">${summary.orders_paid_afil}</td>
              <td style="text-align:right">${summary.orders_org_afil}</td>
              <td style="text-align:right">${fe(summary.gmv)}</td>
              <td style="text-align:right" class="text-red">${fe(summary.cogs)}</td>
              <td style="text-align:right" class="text-red">${fe(summary.shipping)}</td>
              <td style="text-align:right" class="text-red">${fe(summary.tiktok_platform)}</td>
              <td style="text-align:right" class="text-red">${fe(summary.gmv_max_spend)}</td>
              <td style="text-align:right">
                ${_ttsGlobalAcos > 0 ? (() => {
                  const c  = _ttsGlobalAcos <= 15 ? '#16a34a' : _ttsGlobalAcos <= 30 ? '#b45309' : '#dc2626';
                  const bg = _ttsGlobalAcos <= 15 ? 'rgba(34,197,94,.13)' : _ttsGlobalAcos <= 30 ? 'rgba(245,158,11,.13)' : 'rgba(239,68,68,.13)';
                  return `<span style="padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700;background:${bg};color:${c}">${fp(_ttsGlobalAcos)}</span>`;
                })() : '—'}
              </td>
              <td style="text-align:right">${summary.cpa > 0 ? fe(summary.cpa) : '—'}</td>
              <td style="text-align:right" class="text-red">${fe(summary.commission_cost)}</td>
              <td style="text-align:right;font-weight:700" class="${summary.net_profit >= 0 ? 'text-green' : 'text-red'}">${fe(summary.net_profit)}</td>
              <td style="text-align:right">
                <span style="padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;
                  background:${marginColor(summary.margin_pct) === 'green' ? 'rgba(34,197,94,.15)' : marginColor(summary.margin_pct) === 'orange' ? 'rgba(245,158,11,.15)' : 'rgba(239,68,68,.15)'};
                  color:${marginColor(summary.margin_pct) === 'green' ? '#16a34a' : marginColor(summary.margin_pct) === 'orange' ? '#b45309' : '#dc2626'}">
                  ${fp(summary.margin_pct)}
                </span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

  </div><!-- #tts-export-area -->
  `;

  // Activar sorting en headers
  document.querySelectorAll('#tts-pl-tbl thead th[data-sort]').forEach(th => {
    th.addEventListener('click', () => sortTTSPL(th.dataset.sort));
  });
  const initArrow = document.querySelector('#tts-pl-tbl thead th[data-sort="net_profit"] .sort-arrow');
  if (initArrow) initArrow.textContent = ' ▼';
}

// ── Export JPG ────────────────────────────────────────────────────────────────

async function exportTTSJpg(date) {
  const area = document.getElementById('tts-export-area');
  if (!area) return;

  const btn = document.querySelector('button[onclick^="exportTTSJpg"]');
  const origText = btn ? btn.textContent : '';
  if (btn) btn.textContent = '⏳ Generando...';

  try {
    const canvas = await html2canvas(area, {
      backgroundColor: '#eeeef0',
      scale: 2,
      useCORS: true,
      logging: false,
    });
    const link = document.createElement('a');
    link.download = `TTS_${date}.jpg`;
    link.href = canvas.toDataURL('image/jpeg', 0.92);
    link.click();
  } catch (err) {
    alert('Error al exportar: ' + err.message);
  } finally {
    if (btn) btn.textContent = origText;
  }
}

// ── Guardar en historial ──────────────────────────────────────────────────────

async function saveTTSHistory() {
  if (!_ttsLastResult) return alert('Primero cargá un reporte');

  const { date, result } = _ttsLastResult;

  try {
    await API.ttsSaveHistory({
      date,
      summary: result.summary,
      grupos:  result.pl,
    });
    // Refresh strip para mostrar el día como guardado
    await loadTTSDaysStrip();
    // Auto-seleccionar el día guardado
    _ttsSelectedDays.add(date);
    _ttsSelectionMode = 'days';
    _renderTTSStrip();
  } catch (err) {
    alert('Error al guardar: ' + err.message);
  }
}
