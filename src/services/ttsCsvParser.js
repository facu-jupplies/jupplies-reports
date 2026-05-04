/**
 * Parser CSV de TikTok Affiliate (versión backend, espejo de parseTTSAffiliateCSV
 * en public/pages/tts.js). Mantenido por separado porque el frontend se carga
 * vía <script> y no puede importar módulos de Node.
 *
 * Si tocás algo acá, también tocá tts.js para mantener la paridad.
 */

function normalizeStr(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim();
}

function detectSeparator(firstLine) {
  const tabs   = (firstLine.match(/\t/g) || []).length;
  const semis  = (firstLine.match(/;/g)  || []).length;
  const commas = (firstLine.match(/,/g)  || []).length;
  if (tabs  >= semis && tabs  >= commas) return '\t';
  if (semis >= commas)                  return ';';
  return ',';
}

function parseCSVRow(line, sep) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === sep && !inQuotes) { result.push(current.trim()); current = ''; }
    else current += c;
  }
  result.push(current.trim());
  return result;
}

function parseTTSAffiliateCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  if (lines.length < 2) return [];

  const sep    = detectSeparator(lines[0]);
  const header = parseCSVRow(lines[0], sep).map(h => h.replace(/^"|"$/g, '').trim());
  const headerNorm = header.map(normalizeStr);

  const findCol = (kws) => headerNorm.findIndex(h => kws.every(kw => h.includes(kw)));

  const colOrderId       = findCol(['pedido']);
  const colCommPctStd    = findCol(['estandar']);
  const colCommPctAds    = headerNorm.findIndex(h => h.includes('porcentaje') && h.includes('anuncio'));
  const colCommEstimated    = headerNorm.findIndex(h => h.includes('estimada') && !h.includes('anuncio') && h.includes('comision'));
  const colCommAdsEstimated = headerNorm.findIndex(h => h.includes('estimada') && h.includes('anuncio'));
  const colCommReal         = headerNorm.findIndex(h => h.includes('real') && !h.includes('anuncio') && !h.includes('base') && h.includes('comision'));
  const colCommRealAds      = headerNorm.findIndex(h => h.includes('real') && h.includes('anuncio') && !h.includes('base'));
  const colStatus        = findCol(['estado', 'pedido']);
  const colRefunded      = findCol(['totalidad']);

  const colSettlement = (() => {
    let i = headerNorm.findIndex(h => h.includes('liquidado'));
    if (i !== -1) return i;
    i = headerNorm.findIndex(h => h.includes('settlement'));
    if (i !== -1) return i;
    i = headerNorm.findIndex(h => h.includes('importe') && h.includes('pago'));
    if (i !== -1) return i;
    return headerNorm.findIndex(h =>
      (h.includes('importe') || h.includes('monto') || h.includes('amount')) &&
      (h.includes('pedido') || h.includes('order')) &&
      !h.includes('comision') && !h.includes('commission')
    );
  })();
  const colPrice = headerNorm.findIndex(h => h === 'precio' || h === 'price');
  const colProductName = headerNorm.findIndex(h => h.includes('nombre') && h.includes('producto'));
  const colSellerSku = (() => {
    let i = headerNorm.findIndex(h => h.includes('sku') && (h.includes('vendedor') || h.includes('seller')));
    return i !== -1 ? i : -1;
  })();
  const colCreator = headerNorm.findIndex(h => h.includes('creador') || h.includes('creator'));
  const colContentType = headerNorm.findIndex(h => h.includes('tipo') && h.includes('contenido'));
  const colContentId = headerNorm.findIndex(h => h.startsWith('id') && h.includes('contenido'));
  const colQuantity = headerNorm.findIndex(h =>
    h === 'cantidad' || h === 'quantity' || h.includes('unidades') || h === 'qty'
  );

  // Columna de fecha de creación del pedido — necesaria para CSVs multi-día
  const colCreatedAt = headerNorm.findIndex(h =>
    (h.includes('fecha') && h.includes('creaci')) ||
    (h.includes('hora')  && h.includes('creaci')) ||
    h.includes('created')
  );

  if (colOrderId === -1) {
    return { rows: [], header, error: 'No se encontró columna de ID de pedido' };
  }

  // Paso 1: parsear todas las filas
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

    const rawSettlement = parseFloat((get(colSettlement) || '0').replace(',', '.')) || 0;
    const rawPrice      = parseFloat((get(colPrice) || '0').replace(',', '.'))      || 0;
    const qty           = parseInt(get(colQuantity)) || 1;
    const lineRevenue   = rawSettlement > 0 ? rawSettlement : (rawPrice * qty);

    const refRaw = (get(colRefunded) || '').toLowerCase();
    // Parsear fecha de creación: "DD/MM/YYYY HH:MM:SS" o "YYYY-MM-DD HH:MM:SS"
    let orderDate = null;
    const rawDate = get(colCreatedAt);
    if (rawDate) {
      let m = rawDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) orderDate = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
      else {
        m = rawDate.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) orderDate = `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
      }
    }
    rawRows.push({
      orderId,
      orderDateRaw:     rawDate,
      orderDate,                  // YYYY-MM-DD inferido del CSV (puede ser null)
      commPctStandard:  parseFloat(get(colCommPctStd).replace(',', '.'))  || 0,
      commPctAds:       parseFloat(get(colCommPctAds).replace(',', '.'))  || 0,
      commReal:         commReal    || commEstimated,
      commRealAds:      commRealAds || commAdsEstimated,
      orderStatus:      get(colStatus),
      fullyRefunded:    refRaw === 'true' || refRaw === '1' || refRaw === 'sí' || refRaw === 'si',
      settlementAmount: lineRevenue,
      sellerSku:        (get(colSellerSku) || '').trim().toUpperCase(),
      productName:      (get(colProductName) || '').trim(),
      creatorName:      (get(colCreator) || '').trim(),
      contentType:      (get(colContentType) || '').trim(),
      contentId:        (get(colContentId) || '').trim(),
      quantity:         qty,
    });
  }

  // Paso 2: emit 1 fila por producto, isPrimary=true en el primer producto del pedido
  const seen = new Set();
  const skusByOrder = {};
  const totalQtyByOrder = {};
  for (const row of rawRows) {
    const id = String(row.orderId).trim();
    if (!skusByOrder[id]) skusByOrder[id] = [];
    if (row.sellerSku && !skusByOrder[id].includes(row.sellerSku)) skusByOrder[id].push(row.sellerSku);
    totalQtyByOrder[id] = (totalQtyByOrder[id] || 0) + (row.quantity || 0);
  }

  const out = [];
  for (const row of rawRows) {
    const id = String(row.orderId).trim();
    const isPrimary = !seen.has(id);
    seen.add(id);
    out.push({
      ...row,
      isPrimary,
      skus: skusByOrder[id],
      totalQuantity: totalQtyByOrder[id],
      settlementAmount: isPrimary ? row.settlementAmount : 0,
    });
  }
  return { rows: out, header };
}

module.exports = { parseTTSAffiliateCSV, normalizeStr, detectSeparator, parseCSVRow };
