// ╔══════════════════════════════════════════════════════════════════════╗
// ║ Página: Creadores TTS — mapeo cliente Simla ↔ handle TikTok          ║
// ║ Análogo a Campañas → SKU. Se hace UNA VEZ, se aplica a todas         ║
// ║ las muestras pasadas y futuras.                                      ║
// ╚══════════════════════════════════════════════════════════════════════╝

let _mappingsData = null;

async function loadTTSMappings() {
  const el = document.getElementById('page-tts-mappings');
  if (!el) return;
  el.classList.add('ttsm-scope');
  el.innerHTML = `
  <div class="ttsm-topbar">
    <div class="ttsm-title">
      <h1>Creadores TTS</h1>
      <span class="ttsm-sub">Enlazá una vez cliente Simla ↔ handle TikTok · se aplica a todas las muestras pasadas y futuras</span>
    </div>
    <div class="ttsm-filters">
      <button class="ttsm-btn ttsm-btn-sm" onclick="loadTTSMappings()">Refrescar</button>
    </div>
  </div>
  <div id="ttsmap-body"><div class="ttsm-loading">Cargando...</div></div>`;

  try {
    const res = await fetch('/api/tts/mappings');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    _mappingsData = data;
    renderMappingsBody(data);
  } catch (err) {
    document.getElementById('ttsmap-body').innerHTML =
      `<div class="ttsm-empty"><div class="ttsm-empty-icon">⚠️</div>Error: ${err.message}</div>`;
  }
}

function renderMappingsBody(d) {
  const body = document.getElementById('ttsmap-body');
  const totalMuestrasUnmapped = d.unmapped.reduce((s, c) => s + c.sample_count, 0);
  const totalCostUnmapped     = d.unmapped.reduce((s, c) => s + c.total_cost, 0);

  body.innerHTML = `
  <div class="ttsm-content">

    <!-- Aviso superior -->
    ${d.unmapped.length === 0 ? `
    <div class="ttsm-banner" style="background:#eaf7ee;border-color:#bce3cf;color:#1a7a4f;border-radius:6px">
      <span class="ttsm-dot" style="background:#21a366"></span>
      <strong>Todos los clientes Simla tienen handle TikTok asignado</strong>
    </div>
    ` : `
    <div class="ttsm-banner" style="border-radius:6px">
      <span class="ttsm-dot"></span>
      <span><strong>${d.unmapped.length} clientes</strong> sin handle TikTok ·
            <strong>${totalMuestrasUnmapped} muestras</strong> afectadas ·
            <strong>${ttsmEur(totalCostUnmapped)}</strong> en costos sin atribuir</span>
      <span style="margin-left:auto;font-size:11px">ventana de atribución: ${d.attribution_window_days} días</span>
    </div>
    `}

    ${d.unmapped.length > 0 ? `
    <!-- Sin asignar -->
    <div class="ttsm-panel" style="border-color:#f3d9c1">
      <div class="ttsm-section-title" style="background:#fff8f1">
        <h2 style="color:#8a4b1f">⚠ Por asignar <span class="ttsm-count">${d.unmapped.length} clientes</span></h2>
      </div>
      <div class="ttsm-scroll">
        <table class="ttsm-tbl dense">
          <thead>
            <tr>
              <th>Cliente Simla</th>
              <th class="ttsm-num">Muestras</th>
              <th>Grupos enviados</th>
              <th class="ttsm-num">Coste</th>
              <th>Último envío</th>
              <th style="min-width:260px">Candidatos</th>
              <th style="min-width:190px">Handle TikTok</th>
            </tr>
          </thead>
          <tbody>
            ${d.unmapped.map((u, i) => renderUnmappedRow(u, i)).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ` : ''}

    <!-- Asignados -->
    <div class="ttsm-panel">
      <div class="ttsm-section-title">
        <h2>Clientes asignados <span class="ttsm-count">${d.mapped.length}</span></h2>
      </div>
      ${d.mapped.length === 0 ? `
        <div class="ttsm-empty" style="padding:40px">
          Aún no hay asignaciones. Al asignar un handle arriba se agregan acá.
        </div>
      ` : `
      <div class="ttsm-scroll">
        <table class="ttsm-tbl dense">
          <thead>
            <tr>
              <th>Cliente Simla</th>
              <th>Handle TikTok</th>
              <th class="ttsm-num">Muestras</th>
              <th>Grupos</th>
              <th class="ttsm-num">Coste total</th>
              <th>Periodo</th>
              <th style="min-width:140px">Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${d.mapped.map((m, i) => renderMappedRow(m, i)).join('')}
          </tbody>
        </table>
      </div>
      `}
    </div>

  </div>`;
}

function renderUnmappedRow(u, i) {
  const cands = u.candidates || [];
  const candsHtml = cands.length === 0
    ? '<span class="ttsm-subtle" style="font-size:11px">sin candidatos en ventana</span>'
    : cands.slice(0, 4).map(c => `
        <button class="ttsm-btn ttsm-btn-xs" style="margin:1px"
                onclick="saveMapping('${escMap(u.customer_name)}', '${escMap(u.customer_phone)}', '${escMap(u.customer_email)}', '${c.tiktok_username}')"
                title="${c.orders} ventas · ${ttsmEur(c.revenue)}">
          <span class="ttsm-mono">@${c.tiktok_username}</span>
          <span class="ttsm-subtle" style="margin-left:3px">${c.orders}</span>
        </button>`).join('');

  const grupos = u.grupos.slice(0, 3).map(g => `<span class="ttsm-chip ttsm-chip-orange">${g}</span>`).join(' ');
  const grupMore = u.grupos.length > 3 ? `<span class="ttsm-subtle" style="font-size:10px;margin-left:4px">+${u.grupos.length - 3}</span>` : '';

  return `
  <tr>
    <td>
      <div style="font-weight:550">${u.customer_name || '—'}</div>
      ${u.customer_phone ? `<div class="ttsm-subtle ttsm-mono" style="font-size:10.5px">${u.customer_phone}</div>` : ''}
    </td>
    <td class="ttsm-num"><strong>${u.sample_count}</strong></td>
    <td>
      <div style="display:flex;flex-wrap:wrap;gap:3px;align-items:center">${grupos}${grupMore}</div>
    </td>
    <td class="ttsm-num ttsm-mono">${ttsmEur(u.total_cost)}</td>
    <td class="ttsm-subtle">${ttsmDate(u.last_sample)}</td>
    <td>${candsHtml}</td>
    <td>
      <div style="display:inline-flex;gap:4px;align-items:center">
        <input class="ttsm-input ttsm-input-sm" placeholder="@handle" id="ttsmap-input-${i}" style="width:110px">
        <button class="ttsm-btn ttsm-btn-xs ttsm-btn-accent"
                onclick="saveMappingManual(${i}, '${escMap(u.customer_name)}', '${escMap(u.customer_phone)}', '${escMap(u.customer_email)}')">
          Asignar
        </button>
      </div>
    </td>
  </tr>`;
}

function renderMappedRow(m, i) {
  const grupos = m.grupos.slice(0, 3).map(g => `<span class="ttsm-chip ttsm-chip-orange">${g}</span>`).join(' ');
  const grupMore = m.grupos.length > 3 ? `<span class="ttsm-subtle" style="font-size:10px;margin-left:4px">+${m.grupos.length - 3}</span>` : '';
  return `
  <tr>
    <td>
      <div style="font-weight:550">${m.customer_name || '—'}</div>
      ${m.customer_phone ? `<div class="ttsm-subtle ttsm-mono" style="font-size:10.5px">${m.customer_phone}</div>` : ''}
    </td>
    <td>
      <input class="ttsm-input ttsm-input-sm ttsm-mono" id="ttsmap-edit-${i}" value="${m.tiktok_username}"
             style="width:150px"
             onchange="saveMapping('${escMap(m.customer_name)}', '${escMap(m.customer_phone)}', '${escMap(m.customer_email)}', this.value)">
    </td>
    <td class="ttsm-num"><strong>${m.sample_count}</strong></td>
    <td>
      <div style="display:flex;flex-wrap:wrap;gap:3px;align-items:center">${grupos}${grupMore}</div>
    </td>
    <td class="ttsm-num ttsm-mono">${ttsmEur(m.total_cost)}</td>
    <td class="ttsm-subtle" style="font-size:11px">
      ${ttsmDate(m.first_sample)} → ${ttsmDate(m.last_sample)}
    </td>
    <td>
      <button class="ttsm-btn ttsm-btn-xs" onclick="openDebugCustomer('${escMap(m.customer_name)}')">Debug</button>
      <button class="ttsm-btn ttsm-btn-xs ttsm-btn-ghost" style="color:#c0392b"
              onclick="deleteMapping('${escMap(m.customer_name)}', '${escMap(m.customer_phone)}')">
        Quitar
      </button>
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
        customer_phone: customer_phone === 'null' || customer_phone === '' ? null : customer_phone,
        customer_email: customer_email === 'null' || customer_email === '' ? null : customer_email,
        tiktok_username: cleanHandle,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error');
    loadTTSMappings();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function saveMappingManual(index, customer_name, customer_phone, customer_email) {
  const input = document.getElementById(`ttsmap-input-${index}`);
  const handle = (input.value || '').trim();
  if (!handle) { alert('Escribí un handle'); return; }
  await saveMapping(customer_name, customer_phone, customer_email, handle);
}

async function deleteMapping(customer_name, customer_phone) {
  if (!confirm(`¿Quitar el mapeo de ${customer_name}?\nLas muestras quedan sin handle asignado.`)) return;
  try {
    const res = await fetch('/api/tts/mappings', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name,
        customer_phone: customer_phone === 'null' || customer_phone === '' ? null : customer_phone,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Error');
    loadTTSMappings();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function openDebugCustomer(customer_name) {
  try {
    const res = await fetch(`/api/tts/mappings/debug/${encodeURIComponent(customer_name)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');

    const summary = `
      Cliente: ${data.customer_name}
      Handles asignados: ${data.handles.join(', ') || '(ninguno)'}
      Grupos de muestras: ${data.grupos.join(', ') || '(ninguno)'}

      Muestras (${data.samples.length}):
      ${data.samples.map(s => `  · ${s.sent_date} · ${s.grupo} · ${s.sku} · handle=${s.tiktok_username || 'NULL'}`).join('\n') || '  (sin muestras)'}

      Ventas afiliadas del handle (últimas ${data.handle_sales_last_200.length}):
      ${data.handle_sales_last_200.slice(0, 20).map(o => `  · ${o.order_date} · ${o.grupo} · €${o.revenue} · ${o.comm_type} · ${o.order_status}`).join('\n') || '  (sin ventas del handle)'}
      ${data.handle_sales_last_200.length > 20 ? `... +${data.handle_sales_last_200.length - 20} más` : ''}

      Ventas del grupo (últimas 10):
      ${data.grupo_sales_last_100.slice(0, 10).map(o => `  · ${o.order_date} · @${o.tiktok_username} · ${o.grupo} · €${o.revenue}`).join('\n') || '  (sin ventas del grupo)'}

      Stats tts_affiliate_orders:
      Total filas: ${data.tts_affiliate_orders_total}
      Rango fechas: ${data.tts_affiliate_orders_date_range[0]} → ${data.tts_affiliate_orders_date_range[1]}
    `.replace(/\n      /g, '\n').trim();

    alert(summary);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// Helper: escapa para inline onclick/onchange
function escMap(s) {
  return (s == null ? '' : String(s))
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}
