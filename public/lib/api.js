/**
 * Wrappers para llamadas al backend.
 * Todos los errores se propagan como excepciones con mensaje legible.
 */

async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Error ${res.status}`);
  }
  return data;
}

const API = {
  // SKUs
  getSkus:     ()       => apiFetch('/api/skus'),
  saveSku:     (sku)    => apiFetch('/api/skus', { method: 'POST', body: sku }),
  deleteSku:   (sku)    => apiFetch(`/api/skus/${encodeURIComponent(sku)}`, { method: 'DELETE' }),
  deleteAllSkus: () => apiFetch('/api/skus/all', { method: 'DELETE' }),
  importSkuCsv: (rows)  => apiFetch('/api/skus/import/csv', { method: 'POST', body: { rows } }),

  // Import
  importDay:     (date) => apiFetch(`/api/import/day?date=${date}`),
  importShopifyCsv: (date, rows) => apiFetch('/api/import/csv/shopify', { method: 'POST', body: { date, rows } }),
  importSimlaCsv:   (rows) => apiFetch('/api/import/csv/simla', { method: 'POST', body: { rows } }),
  getCampaigns:     ()     => apiFetch('/api/import/campaigns'),
  updateCampaign:   (id, sku_group) => apiFetch(`/api/import/campaigns/${id}`, { method: 'POST', body: { sku_group } }),
  mapNewCampaign:   (platform, campaign_key, sku_group) => apiFetch('/api/import/campaigns/map', { method: 'POST', body: { platform, campaign_key, sku_group } }),

  // Reports
  getDayReport:    (date)        => apiFetch(`/api/reports/day?date=${date}`),
  getHistory:      (from, to)    => apiFetch(`/api/reports/history?from=${from}&to=${to}`),
  getPeriodReport: (from, to)    => apiFetch(`/api/reports/period?from=${from}&to=${to}`),

  // COD
  getCod:      (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return apiFetch(`/api/cod${q ? '?' + q : ''}`);
  },
  getCodDashboard: (params = {}) => {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v))).toString();
    return apiFetch(`/api/cod/dashboard${q ? '?' + q : ''}`);
  },
  updateCod: (orderName, status, simlaId) =>
    apiFetch(`/api/cod/${encodeURIComponent(orderName)}`, {
      method: 'PATCH',
      body: { status, simla_order_id: simlaId },
    }),

  // Settings
  getSettings:  ()      => apiFetch('/api/settings'),
  saveSettings: (data)  => apiFetch('/api/settings', { method: 'POST', body: data }),

  // Simla
  getSimlaStock: () => apiFetch('/api/simla/stock'),
  syncSimlaCosts: () => apiFetch('/api/simla/sync', { method: 'POST' }),

  // TTS
  ttsGetDates:    ()           => apiFetch('/api/tts/dates'),
  ttsReport:      (data)       => apiFetch('/api/tts/report', { method: 'POST', body: data }),
  ttsSaveHistory: (data)       => apiFetch('/api/tts/history/save', { method: 'POST', body: data }),
  ttsGetHistory:  (from, to)   => apiFetch(`/api/tts/history?from=${from}&to=${to}`),
};

// Safe error display (prevents XSS from error messages)
function showError(el, msg) {
  const safe = String(msg).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  el.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><div class="msg">${safe}</div></div>`;
}

// Formatters
function fe(n) {
  return '€' + (n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fp(n, decimals = 1) {
  return (n || 0).toFixed(decimals) + '%';
}

function fd(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function pctClass(pct) {
  if (pct >= 60) return 'pct-green';
  if (pct >= 40) return 'pct-yellow';
  return 'pct-red';
}

// Fecha de hoy en YYYY-MM-DD
function today() {
  return new Date().toISOString().slice(0, 10);
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function thisMonthRange() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const to = today();
  return { from, to };
}

function prevMonthRange() {
  const now = new Date();
  now.setDate(1);
  now.setMonth(now.getMonth() - 1);
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2, '0')}-${lastDay}`;
  return { from, to };
}
