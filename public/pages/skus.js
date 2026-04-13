// ─── Base de datos SKUs ────────────────────────────────

let _skusData = [];
let _skuSortCol = 'sku';
let _skuSortDir = 1;

async function loadSkus() {
  _skusData = await API.getSkus();
  renderSkus();
}

function renderSkus() {
  const search = (document.getElementById('sku-search')?.value || '').toLowerCase();
  const el = document.getElementById('skus-content');

  let filtered = _skusData.filter(s =>
    s.sku.toLowerCase().includes(search) ||
    (s.grupo || '').toLowerCase().includes(search)
  );

  if (filtered.length === 0) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">📦</div>
      <div class="msg">Sin SKUs${search ? ` para "${search}"` : ''}</div>
      <div class="hint">Importá el CSV o añadí SKUs manualmente.</div>
    </div>`;
    return;
  }

  // Sort
  filtered = [...filtered].sort((a, b) => {
    let av = a[_skuSortCol] ?? '', bv = b[_skuSortCol] ?? '';
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return -_skuSortDir;
    if (av > bv) return  _skuSortDir;
    return 0;
  });

  function thSort(col, label) {
    const active = _skuSortCol === col;
    const arrow = active ? (_skuSortDir === 1 ? ' ↑' : ' ↓') : '';
    return `<th onclick="skuSort('${col}')" style="cursor:pointer;user-select:none;white-space:nowrap">${label}<span style="color:var(--or)">${arrow}</span></th>`;
  }

  el.innerHTML = `
    <div style="font-size:12px;color:var(--md);margin-bottom:6px;padding:0 2px;display:flex;align-items:center;gap:8px">
      <span>
        ${filtered.length === _skusData.length
          ? `<strong>${_skusData.length}</strong> SKUs`
          : `<strong>${filtered.length}</strong> de <strong>${_skusData.length}</strong> SKUs`}
      </span>
      ${_skusData.filter(s => !s.grupo).length > 0
        ? `<span style="color:var(--or);font-size:11px">· ${_skusData.filter(s => !s.grupo).length} sin grupo asignado</span>`
        : ''}
    </div>
    <div class="table-wrap">
      <table style="font-size:13px;width:100%">
        <colgroup>
          <col style="width:25%">
          <col style="width:12%">
          <col style="width:8%">
          <col style="width:14%">
          <col style="width:14%">
          <col style="width:14%">
          <col style="width:80px">
        </colgroup>
        <thead>
          <tr>
            ${thSort('sku',          'SKU')}
            ${thSort('grupo',        'Grupo')}
            <th style="font-size:11px">Tipo</th>
            ${thSort('cost',         'Costo (€)')}
            ${thSort('shipping_es',  'Envío ES (€)')}
            ${thSort('shipping_int', 'Envío INT (€)')}
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(s => `
            <tr style="height:32px">
              <td style="padding:3px 10px;font-weight:700;color:var(--or)">${s.sku}</td>
              <td style="padding:3px 10px;color:#4a9eff;font-size:12px">${s.grupo || '<span style="opacity:.3">—</span>'}</td>
              <td style="padding:3px 8px">${s.is_upsell ? '<span style="background:#f59e0b;color:#fff;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700">UP</span>' : ''}</td>
              <td style="padding:3px 10px;text-align:right">${fe(s.cost)}</td>
              <td style="padding:3px 10px;text-align:right">${fe(s.shipping_es)}</td>
              <td style="padding:3px 10px;text-align:right">${fe(s.shipping_int)}</td>
              <td style="padding:3px 6px;text-align:center;white-space:nowrap">
                <button onclick="editSku('${s.sku}')" title="Editar"
                  style="background:none;border:none;cursor:pointer;font-size:13px;opacity:.55;padding:1px 4px">✏️</button>
                <button onclick="deleteSku('${s.sku}')" title="Eliminar"
                  style="background:none;border:none;cursor:pointer;font-size:14px;opacity:.6;padding:2px 5px">🗑</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function skuSort(col) {
  if (_skuSortCol === col) _skuSortDir *= -1;
  else { _skuSortCol = col; _skuSortDir = 1; }
  renderSkus();
}

function openSkuModal(sku = null) {
  const modal = document.getElementById('sku-modal');
  document.getElementById('sku-modal-title').textContent = sku ? 'Editar SKU' : 'Nuevo SKU';
  document.getElementById('sm-sku').value       = sku?.sku || '';
  document.getElementById('sm-sku').disabled    = !!sku;
  document.getElementById('sm-cost').value      = sku?.cost || '';
  document.getElementById('sm-ship-es').value   = sku?.shipping_es || '';
  document.getElementById('sm-ship-int').value  = sku?.shipping_int || '';
  document.getElementById('sm-grupo').value     = sku?.grupo || '';
  document.getElementById('sm-upsell').checked  = sku?.is_upsell ? true : false;
  modal.style.display = 'flex';
}

function closeSkuModal() {
  document.getElementById('sku-modal').style.display = 'none';
}

function editSku(skuCode) {
  const sku = _skusData.find(s => s.sku === skuCode);
  if (sku) openSkuModal(sku);
}

async function saveSku() {
  const data = {
    sku:          document.getElementById('sm-sku').value.trim(),
    cost:         document.getElementById('sm-cost').value,
    shipping_es:  document.getElementById('sm-ship-es').value,
    shipping_int: document.getElementById('sm-ship-int').value,
    grupo:        document.getElementById('sm-grupo').value.trim(),
    is_upsell:    document.getElementById('sm-upsell').checked ? 1 : 0,
  };

  if (!data.sku) return alert('El SKU es requerido');

  try {
    await API.saveSku(data);
    closeSkuModal();
    await loadSkus();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteSku(skuCode) {
  if (!confirm(`¿Eliminar el SKU ${skuCode}?`)) return;
  try {
    await API.deleteSku(skuCode);
    await loadSkus();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function deleteAllSkus() {
  if (!confirm(`¿Eliminar TODOS los ${_skusData.length} SKUs de la base de datos? Esta acción no se puede deshacer.`)) return;
  if (!confirm('¿Confirmás que querés borrar toda la base de SKUs?')) return;
  try {
    await API.deleteAllSkus();
    await loadSkus();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Cerrar modal al hacer click fuera
document.getElementById('sku-modal')?.addEventListener('click', function(e) {
  if (e.target === this) closeSkuModal();
});

async function importSkusCsv(input) {
  const file = input.files[0];
  if (!file) return;

  const text = await file.text();
  const rows = parseSkuCsv(text);

  if (rows.length === 0) {
    alert('No se encontraron SKUs en el CSV.\nVerificá que tenga columnas: SKU, Coste, EnvioES, EnvioInt, Grupo');
    return;
  }

  try {
    const result = await API.importSkuCsv(rows);
    alert(`Importados: ${result.imported} SKUs`);
    await loadSkus();
  } catch (err) {
    alert('Error: ' + err.message);
  }

  input.value = '';
}

function exportSkusCsv() {
  if (_skusData.length === 0) return alert('No hay SKUs para exportar.');
  const header = 'SKU,Coste,EnvioES,EnvioInt,Grupo,Upsell';
  const rows = _skusData.map(s =>
    `${s.sku},${s.cost},${s.shipping_es},${s.shipping_int},${s.grupo || ''},${s.is_upsell ? 1 : 0}`
  );
  const csv = [header, ...rows].join('\n');
  downloadCsv(csv, `jupplies-skus-${new Date().toISOString().slice(0,10)}.csv`);
}

function downloadSkuTemplate() {
  const csv = [
    'SKU,Coste,EnvioES,EnvioInt,Grupo,Upsell',
    'ESNT-BLA,4.50,3.20,0,ESNT-,0',
    'ESNT-NEG,4.50,3.20,0,ESNT-,0',
    'R-MOP,2.10,3.20,0,R-,1',
  ].join('\n');
  downloadCsv(csv, 'plantilla-skus.csv');
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function parseSkuCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim().replace(/"/g, ''));
    const row = {};
    header.forEach((h, j) => row[h] = cols[j] || '');

    const sku         = row['sku'] || '';
    const cost        = row['coste'] || row['cost'] || row['costo'] || '0';
    const shippingEs  = row['envioes'] || row['shipping_es'] || row['envio_es'] || '0';
    const shippingInt = row['envioint'] || row['shipping_int'] || row['envio_int'] || '0';
    const grupo       = row['grupo'] || row['group'] || '';
    const is_upsell   = row['upsell'] === '1' ? 1 : 0;

    if (!sku) continue;
    rows.push({ sku, cost, shipping_es: shippingEs, shipping_int: shippingInt, grupo, is_upsell });
  }

  return rows;
}
