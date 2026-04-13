// ─── Campañas → Grupo SKU ─────────────────────────────

// Listas globales para validación y datalist (se cargan en loadCampaigns)
let _campaignGrupos    = [];
let _campaignSkusFallback = [];

async function loadCampaigns() {
  const el = document.getElementById('campaigns-content');
  el.innerHTML = '<div class="loading">Cargando campañas...</div>';

  try {
    const [campaigns, skus] = await Promise.all([API.getCampaigns(), API.getSkus()]);

    _campaignGrupos        = [...new Set(skus.map(s => s.grupo).filter(Boolean))].sort();
    _campaignSkusFallback  = skus.filter(s => !s.grupo).map(s => s.sku).sort();

    if (campaigns.length === 0) {
      el.innerHTML = `<div class="empty-state">
        <div class="icon">🎯</div>
        <div class="msg">Sin campañas registradas</div>
        <div class="hint">Importá un día desde Windsor para que aparezcan las campañas detectadas.</div>
      </div>`;
      return;
    }

    const sinGrupo     = campaigns.filter(c => !c.sku_group);
    const conGrupo     = campaigns.filter(c =>  c.sku_group);
    const totalSinGrupo = sinGrupo.reduce((s, c) => s + (c.total_spend || 0), 0);

    // Datalist global — una sola definición, todos los inputs la referencian
    const datalistHtml = `
      <datalist id="grupos-datalist">
        ${_campaignGrupos.map(g => `<option value="${g}">`).join('')}
        ${_campaignSkusFallback.map(s => `<option value="${s}">`).join('')}
      </datalist>`;

    el.innerHTML = `
      ${datalistHtml}

      <div class="card" style="margin-bottom:8px">
        <div class="text-xs">
          Las campañas se detectan automáticamente al importar desde Windsor.
          Asigná el grupo SKU correcto — el cambio aplica a todas las importaciones pasadas y futuras.
          <strong>Tip:</strong> escribí en el campo para filtrar grupos.
        </div>
      </div>

      ${sinGrupo.length > 0 ? `
        <div style="background:rgba(239,68,68,.07);border:1.5px solid rgba(239,68,68,.3);border-radius:10px;padding:14px 18px;margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <span style="font-size:18px">⚠️</span>
            <div>
              <div style="font-weight:700;font-size:14px;color:var(--red)">
                ${sinGrupo.length} campaña${sinGrupo.length > 1 ? 's' : ''} sin grupo SKU asignado
              </div>
              <div style="font-size:12px;color:var(--md);margin-top:2px">
                Gasto sin trackear: <strong style="color:var(--red)">${fe(totalSinGrupo)}</strong>
                — asigná el grupo para que aparezca en los reportes
              </div>
            </div>
          </div>
          <div class="table-wrap" style="margin:0">
            <table>
              <thead>
                <tr>
                  <th>Plataforma</th>
                  <th>Campaña</th>
                  <th>Asignar grupo SKU <span style="font-weight:400;opacity:.6">(escribí para buscar)</span></th>
                  <th class="text-right">Gasto total</th>
                </tr>
              </thead>
              <tbody>
                ${sinGrupo.map(c => `
                  <tr>
                    <td>${platIcon(c.platform)} ${c.platform}</td>
                    <td style="max-width:320px;word-break:break-word;font-weight:500">${c.campaign_key}</td>
                    <td>
                      <input type="text"
                             list="grupos-datalist"
                             placeholder="Escribí para buscar grupo..."
                             style="padding:5px 10px;border:1.5px solid var(--red);border-radius:5px;font-size:12px;width:200px;background:var(--bg);color:var(--tx)"
                             onchange="assignFromInput(this, ${c.id || 'null'}, '${escAttr(c.platform)}', '${escAttr(c.campaign_key)}')">
                    </td>
                    <td class="text-right text-red font-bold">${fe(c.total_spend)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : `
        <div style="background:rgba(22,163,74,.08);border:1.5px solid rgba(22,163,74,.25);border-radius:8px;padding:10px 16px;margin-bottom:14px;display:flex;align-items:center;gap:8px;font-size:13px">
          <span>✅</span> Todas las campañas tienen grupo SKU asignado
        </div>
      `}

      ${conGrupo.length > 0 ? `
        <div class="section-title" style="margin-bottom:8px">Campañas asignadas (${conGrupo.length})</div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plataforma</th>
                <th>Campaña</th>
                <th>Grupo asignado <span style="font-weight:400;opacity:.6">(escribí para cambiar)</span></th>
                <th>Origen</th>
                <th class="text-right">Gasto total</th>
              </tr>
            </thead>
            <tbody>
              ${conGrupo.map(c => `
                <tr>
                  <td>${platIcon(c.platform)} ${c.platform}</td>
                  <td style="max-width:300px;word-break:break-word">${c.campaign_key}</td>
                  <td>
                    <input type="text"
                           list="grupos-datalist"
                           value="${c.sku_group || ''}"
                           style="padding:5px 10px;border:1.5px solid var(--lt2);border-radius:5px;font-size:12px;width:160px;background:var(--bg);color:var(--tx)"
                           onchange="assignFromInput(this, ${c.id || 'null'}, '${escAttr(c.platform)}', '${escAttr(c.campaign_key)}')">
                  </td>
                  <td>
                    <span class="badge ${c.is_manual ? 'badge-confirmed' : 'badge-pending'}">
                      ${c.is_manual ? 'Manual' : 'Auto'}
                    </span>
                  </td>
                  <td class="text-right">${fe(c.total_spend)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}
    `;
  } catch (err) {
    showError(el, err.message);
  }
}

// Asigna desde input con datalist — valida contra la lista conocida
async function assignFromInput(input, id, platform, campaign_key) {
  const value = input.value.trim();

  // Validar que el valor es un grupo/SKU conocido (o vacío para quitar asignación)
  if (value && !_campaignGrupos.includes(value) && !_campaignSkusFallback.includes(value)) {
    input.style.border = '1.5px solid var(--red)';
    return; // valor no reconocido, no guardar
  }

  const originalBorder = input.style.border;
  try {
    if (id && id !== 'null') {
      await API.updateCampaign(id, value);
    } else {
      await API.mapNewCampaign(platform, campaign_key, value);
    }
    input.style.border = '1.5px solid var(--green)';
    setTimeout(() => {
      if (value) loadCampaigns();  // recargar para mover a la sección correcta
      else input.style.border = originalBorder;
    }, 500);
  } catch (err) {
    input.style.border = '1.5px solid var(--red)';
    alert('Error al guardar: ' + err.message);
  }
}

// Escapa atributos HTML para uso en onclick/onchange inline
function escAttr(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
