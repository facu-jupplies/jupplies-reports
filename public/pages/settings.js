// ─── Configuración ─────────────────────────────────────

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadSettings() {
  const el = document.getElementById('settings-content');
  el.innerHTML = '<div class="loading">Cargando...</div>';

  try {
    const s = await API.getSettings();

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:900px">

        <!-- Windsor API -->
        <div class="card">
          <div class="card-title">📡 Windsor.ai — Conexión</div>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div class="form-group">
              <label>API Key</label>
              <input type="text" id="cfg-windsor-key" value="${escHtml(s.windsor_api_key)}"
                placeholder="Tu API key de Windsor" style="font-family:monospace;font-size:12px">
            </div>
            <div class="form-group">
              <label>Store (cuenta Shopify en Windsor)</label>
              <input type="text" id="cfg-windsor-store" value="${escHtml(s.windsor_store)}"
                placeholder="shopify__tutienda.myshopify.com">
            </div>
            <button class="btn btn-primary btn-sm" style="width:fit-content" onclick="saveSettings(this)">
              💾 Guardar conexión
            </button>
          </div>
        </div>

        <!-- Parámetros COD -->
        <div class="card">
          <div class="card-title">🚚 Parámetros COD</div>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div class="form-group">
              <label>Tasa de confirmación (%)</label>
              <input type="number" id="cfg-conf" value="${Math.round((parseFloat(s.cod_confirmation_rate)||0.85)*100)}"
                min="0" max="100" step="1">
              <span class="text-xs">Porcentaje de clientes que aceptan la entrega (no rechazan)</span>
            </div>
            <div class="form-group">
              <label>Tasa de entrega (%)</label>
              <input type="number" id="cfg-deliv" value="${Math.round((parseFloat(s.cod_delivery_rate)||0.83)*100)}"
                min="0" max="100" step="1">
              <span class="text-xs">Porcentaje de pedidos confirmados que efectivamente se entregan</span>
            </div>
            <div class="form-group">
              <label>Costo envío devolución (€)</label>
              <input type="number" id="cfg-return" value="${parseFloat(s.return_shipping_cost)||4}"
                min="0" step="0.01">
              <span class="text-xs">Costo del envío de vuelta cuando hay rechazo</span>
            </div>
            <div class="text-xs" style="background:var(--lt);padding:8px 10px;border-radius:6px">
              Efectividad actual:
              <strong>${Math.round((parseFloat(s.cod_confirmation_rate)||0.85) * (parseFloat(s.cod_delivery_rate)||0.83) * 100)}%</strong>
              (${Math.round((parseFloat(s.cod_confirmation_rate)||0.85)*100)}% conf × ${Math.round((parseFloat(s.cod_delivery_rate)||0.83)*100)}% entrega)
            </div>
            <button class="btn btn-primary btn-sm" style="width:fit-content" onclick="saveSettings(this)">
              💾 Guardar parámetros
            </button>
          </div>
        </div>

        <!-- Acceso -->
        <div class="card">
          <div class="card-title">🔐 Acceso a la app</div>
          <div style="display:flex;flex-direction:column;gap:12px">
            <div class="form-group">
              <label>Usuario</label>
              <input type="text" id="cfg-user" value="${escHtml(s.app_user || 'admin')}">
            </div>
            <div class="form-group">
              <label>Nueva contraseña (dejar vacío para no cambiar)</label>
              <input type="password" id="cfg-pass" placeholder="••••••••">
            </div>
            <button class="btn btn-secondary btn-sm" style="width:fit-content" onclick="saveSettings(this)">
              💾 Guardar acceso
            </button>
          </div>
        </div>

        <!-- Info -->
        <div class="card">
          <div class="card-title">ℹ️ Información del sistema</div>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
            <div>Base de datos: <strong>jupplies.db</strong> (en carpeta del proyecto)</div>
            <div>Para hacer backup: copiar el archivo <code style="background:var(--lt);padding:2px 6px;border-radius:4px">jupplies.db</code></div>
            <hr style="border:none;border-top:1px solid var(--lt2);margin:4px 0">
            <div class="text-xs">Puerto: 3000 · Acceso local: <a href="http://localhost:3000" target="_blank">http://localhost:3000</a></div>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    showError(el, err.message);
  }
}

async function saveSettings(btn) {
  const data = {};

  const windsorKey   = document.getElementById('cfg-windsor-key')?.value;
  const windsorStore = document.getElementById('cfg-windsor-store')?.value;
  const conf  = document.getElementById('cfg-conf')?.value;
  const deliv = document.getElementById('cfg-deliv')?.value;
  const ret   = document.getElementById('cfg-return')?.value;
  const user  = document.getElementById('cfg-user')?.value;
  const pass  = document.getElementById('cfg-pass')?.value;

  if (windsorKey   !== undefined) data.windsor_api_key = windsorKey;
  if (windsorStore !== undefined) data.windsor_store   = windsorStore;
  if (conf  !== undefined) data.cod_confirmation_rate = (parseFloat(conf)  / 100).toString();
  if (deliv !== undefined) data.cod_delivery_rate      = (parseFloat(deliv) / 100).toString();
  if (ret   !== undefined) data.return_shipping_cost   = ret;
  if (user  !== undefined) data.app_user   = user;
  if (pass)                data.app_password = pass;

  try {
    await API.saveSettings(data);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✅ Guardado';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}
