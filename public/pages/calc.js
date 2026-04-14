// ─── Calculadoras PVP y CPA ───────────────────────────────────
// SKUs compartidos entre ambas calculadoras
let _calcSkus = [];
const _IVA = 1.21;

async function loadCalcData() {
  if (_calcSkus.length > 0) return; // ya cargados
  try { _calcSkus = await API.getSkus(); } catch (e) { _calcSkus = []; }
}

// ── Utilities ─────────────────────────────────────────────────
const _g  = id => document.getElementById(id);
const _gf = (id, def = 0) => { const v = parseFloat(_g(id)?.value); return isNaN(v) ? def : v; };
const _fce = n => '€' + Math.abs(n).toFixed(2);
const _fcp = n => n.toFixed(1) + '%';

function setText(id, txt) { const el = _g(id); if (el) el.textContent = txt; }

function _getEnvCobrado(pvp, pref) {
  const base  = _gf(pref + 'env-base', 3);
  const extra = _gf(pref + 'env-extra', 2);
  const um    = _gf(pref + 'env-um', 26);
  if (pvp >= um) return 0;
  if (pvp < 10)  return base + extra;
  return base;
}

function _webPvp(ctot, minP, cpa, pref) {
  const ideal = (ctot + minP + cpa) * _IVA;
  const um = _gf(pref + 'env-um', 26);
  if (ideal >= um) return { store: ideal, total: ideal, env: 0 };
  const env = _getEnvCobrado(ideal, pref);
  return { store: Math.max(ideal - env, 0), total: ideal, env };
}

function _ttsFormula(tikP, affP, ctot, minP, cpaAds) {
  const den = (1 / _IVA) - (tikP + affP) / 100;
  if (den <= 0) return { pvp: 0, tikC: 0, affC: 0, ben: 0 };
  const pvp  = (ctot + minP + cpaAds) / den;
  const tikC = pvp * tikP / 100;
  const affC = pvp * affP / 100;
  return { pvp, tikC, affC, ben: pvp / _IVA - tikC - affC - cpaAds - ctot };
}

function _setRoi(id, cpa, pvp) {
  const el = _g(id); if (!el) return;
  if (cpa <= 0 || pvp <= 0) { el.textContent = '—'; el.style.color = 'var(--md)'; return; }
  const r = pvp / cpa;
  el.textContent = r.toFixed(2) + 'x';
  el.style.color = r >= 3 ? 'var(--gr)' : r >= 2 ? '#e8a000' : 'var(--re)';
}

function _setBadge(id, profit, minP) {
  const el = _g(id); if (!el) return;
  const r = minP > 0 ? profit / minP : 0;
  if (r >= 0.95) { el.className = 'cc-sb cc-s-ok'; el.textContent = '✓ Rentable · ' + _fce(profit); }
  else if (r >= 0.5) { el.className = 'cc-sb cc-s-wn'; el.textContent = '⚠ Ajustado · ' + _fce(profit); }
  else { el.className = 'cc-sb cc-s-bad'; el.textContent = '✗ Bajo mínimo · ' + _fce(profit); }
}

function _setCpaBadge(id, cpa, minP, cost) {
  const el = _g(id); if (!el) return;
  const minCpa = cost * 0.2;
  if (cpa >= minCpa) { el.className = 'cc-sb cc-s-ok'; el.textContent = 'CPA máx: ' + _fce(cpa); }
  else if (cpa > 0)  { el.className = 'cc-sb cc-s-wn'; el.textContent = 'CPA máx bajo: ' + _fce(cpa); }
  else               { el.className = 'cc-sb cc-s-bad'; el.textContent = 'Sin margen para CPA'; }
}

function _setEnvTag(id, env) {
  const el = _g(id); if (!el) return;
  if (env > 0) { el.className = 'cc-env-tag cc-pship'; el.textContent = 'Sin envío gratis'; }
  else         { el.className = 'cc-env-tag cc-free';  el.textContent = '✓ Envío incluido'; }
}

// ── SKU Search ─────────────────────────────────────────────────
function _skuSearch(pref) {
  const q  = _g(pref + 'sku-search')?.value?.trim() || '';
  const dd = _g(pref + 'sku-dd');
  if (!q || !dd) { dd?.classList.remove('cc-open'); return; }
  const matches = _calcSkus.filter(s => s.sku.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  if (!matches.length) { dd.classList.remove('cc-open'); return; }
  dd.innerHTML = matches.map(s => {
    const cost = (+s.cost).toFixed(2);
    const es   = (+s.shipping_es).toFixed(2);
    const int_ = (+s.shipping_int).toFixed(2);
    return `<div class="cc-sku-opt" onclick="_skuLoad('${s.sku}','${pref}')">
      <span class="cc-sc">${s.sku}</span>
      <span class="cc-si">€${cost} · ES €${es} · INT €${int_}</span>
    </div>`;
  }).join('');
  dd.classList.add('cc-open');
}

function _skuLoad(skuCode, pref) {
  const s = _calcSkus.find(x => x.sku === skuCode);
  if (!s) return;
  _g(pref + 'sku-dd')?.classList.remove('cc-open');
  _g(pref + 'sku-search').value = '';
  _g(pref + 'cost').value     = s.cost       || 0;
  _g(pref + 'envio').value    = s.shipping_es || 0;
  _g(pref + 'envio-int').value = s.shipping_int || 0;
  const panel = _g(pref + 'sku-active');
  if (panel) {
    panel.style.display = 'block';
    setText(pref + 'sku-active-code', s.sku);
    setText(pref + 'sku-active-costs',
      'Coste €' + (+s.cost).toFixed(2) +
      ' · ES €'  + (+s.shipping_es).toFixed(2) +
      ' · INT €' + (+s.shipping_int).toFixed(2));
  }
  if (pref === 'pvpc-') pvpcCalc();
  else cpacCalc();
}

function pvpcSkuSearch() { _skuSearch('pvpc-'); }
function cpacSkuSearch() { _skuSearch('cpac-'); }

document.addEventListener('click', e => {
  if (!e.target.closest('#pvpc-sku-search') && !e.target.closest('#pvpc-sku-dd'))
    _g('pvpc-sku-dd')?.classList.remove('cc-open');
  if (!e.target.closest('#cpac-sku-search') && !e.target.closest('#cpac-sku-dd'))
    _g('cpac-sku-dd')?.classList.remove('cc-open');
});

// ══════════════════════════════════════════════════════════════
//  CALCULADORA PVP   (CPA → PVP mínimo)
// ══════════════════════════════════════════════════════════════
let _pvpcMargen = 60;

function pvpcSetM(m) {
  _pvpcMargen = m;
  document.querySelectorAll('.pvpc-mb').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.m) === m));
  _g('pvpc-mc').value = '';
  pvpcCalc();
}

function pvpcTogglePaid(r) {
  const chk = _g('pvpc-paid-tog' + (r === 'fr' ? '-fr' : ''));
  _g('pvpc-paid-flds-' + r)?.classList.toggle('cc-on', chk?.checked);
  _g('pvpc-paid-' + r + '-sec')?.style && (_g('pvpc-paid-' + r + '-sec').style.display = chk?.checked ? 'block' : 'none');
  pvpcCalc();
}

function pvpcCalc() {
  const cost    = _gf('pvpc-cost', 10);
  const envEs   = _gf('pvpc-envio', 3.3);
  const envInt  = _gf('pvpc-envio-int', 6);
  const pdev    = _gf('pvpc-pdev', 5);
  const cpaMeta = _gf('pvpc-cpa-meta', 10);
  const tikP    = _gf('pvpc-tik', 9);
  const affP    = _gf('pvpc-aff', 16);
  const affPP   = _gf('pvpc-aff-p', 5);
  const cpaTts  = _gf('pvpc-cpa-tts', 0);
  const tikPFr  = _gf('pvpc-tik-fr', 9);
  const affPFr  = _gf('pvpc-aff-fr', 16);
  const affPPFr = _gf('pvpc-aff-p-fr', 5);
  const cpaTtsFr = _gf('pvpc-cpa-tts-fr', 0);
  const paidEs  = _g('pvpc-paid-tog')?.checked;
  const paidFr  = _g('pvpc-paid-tog-fr')?.checked;
  const codC    = _gf('pvpc-cod-c', 85);
  const codE    = _gf('pvpc-cod-e', 83);
  const codEfec = (codC / 100) * (codE / 100);
  const devEs   = cost * pdev / 100;
  const devInt  = cost * pdev / 100;
  const ctotEs  = cost + envEs + devEs;
  const ctotInt = cost + envInt + devInt;
  const minP    = cost * _pvpcMargen / 100;

  setText('pvpc-cod-ef', _fcp(codEfec * 100));
  setText('pvpc-cod-ef-preview', _fcp(codEfec * 100));
  setText('pvpc-mpill', 'Ganancia mín: €' + minP.toFixed(2) + ' · Coste €' + cost.toFixed(2));

  // ── WEB TARJETA ──
  const w    = _webPvp(ctotEs, minP, cpaMeta, 'pvpc-');
  const wNet = w.total / _IVA;
  const wBen = wNet - cpaMeta - ctotEs;
  setText('pvpc-pvp-w', _fce(w.store));
  setText('pvpc-w-store', _fce(w.store));
  setText('pvpc-w-net', _fce(wNet));
  setText('pvpc-w-iva', '−' + _fce(w.total - wNet));
  setText('pvpc-w-cp',  '−' + _fce(cost));
  setText('pvpc-w-ce',  '−' + _fce(envEs));
  setText('pvpc-w-dev', '−' + _fce(devEs));
  setText('pvpc-w-dev-pct', pdev);
  setText('pvpc-w-ct',  '−' + _fce(ctotEs));
  setText('pvpc-w-cpa', cpaMeta > 0 ? '−' + _fce(cpaMeta) : '€0.00');
  setText('pvpc-w-ben', _fce(wBen));
  _setEnvTag('pvpc-w-etag', w.env);
  _setRoi('pvpc-w-roi', cpaMeta, w.total);
  _setBadge('pvpc-w-sb', wBen, minP);

  // ── WEB COD ──
  const codR    = codEfec > 0 ? codEfec : 0.01;
  const ctotEfec = ctotEs / codR;
  const c    = _webPvp(ctotEfec, minP, cpaMeta, 'pvpc-');
  const cNet = c.total / _IVA;
  const cBen = cNet - ctotEfec - cpaMeta;
  setText('pvpc-pvp-c', _fce(c.store));
  setText('pvpc-c-store', _fce(c.store));
  setText('pvpc-c-ef', _fcp(codEfec * 100));
  setText('pvpc-c-iva', '−' + _fce(c.total - cNet));
  setText('pvpc-c-cp',  '−' + _fce(cost));
  setText('pvpc-c-ce',  '−' + _fce(envEs));
  setText('pvpc-c-dev-prod', '−' + _fce(devEs));
  setText('pvpc-c-dev-pct', pdev);
  setText('pvpc-c-ct',  '−' + _fce(ctotEs));
  setText('pvpc-c-dev', '−' + _fce(ctotEfec - ctotEs));
  setText('pvpc-c-cpa', cpaMeta > 0 ? '−' + _fce(cpaMeta) : '€0.00');
  setText('pvpc-c-ben', _fce(cBen));
  _setEnvTag('pvpc-c-etag', c.env);
  _setRoi('pvpc-c-roi', cpaMeta, c.total);
  _setBadge('pvpc-c-sb', cBen, minP);

  // ── TTS ES Orgánico ──
  const tA = _ttsFormula(tikP, affP, ctotEs, minP, 0);
  setText('pvpc-pvp-t', _fce(tA.pvp));
  setText('pvpc-ta-pvp', _fce(tA.pvp));
  setText('pvpc-ta-tp', tikP);  setText('pvpc-ta-ap', affP);
  setText('pvpc-ta-tc', '−' + _fce(tA.tikC));
  setText('pvpc-ta-ac', '−' + _fce(tA.affC));
  setText('pvpc-ta-iva', '−' + _fce(tA.pvp - tA.pvp / _IVA));
  setText('pvpc-ta-cp',  '−' + _fce(cost));
  setText('pvpc-ta-ce',  '−' + _fce(envEs));
  setText('pvpc-ta-dev', '−' + _fce(devEs));
  setText('pvpc-ta-dev-pct', pdev);
  setText('pvpc-ta-ben', _fce(tA.ben));
  _setBadge('pvpc-t-sb', tA.ben, minP);

  // ── TTS ES Paid ──
  if (paidEs) {
    const tB = _ttsFormula(tikP, affPP, ctotEs, minP, cpaTts);
    setText('pvpc-tb-pvp-big', _fce(tB.pvp));
    setText('pvpc-tb-tp', tikP);  setText('pvpc-tb-ap', affPP);
    setText('pvpc-tb-tc', '−' + _fce(tB.tikC));
    setText('pvpc-tb-ac', '−' + _fce(tB.affC));
    setText('pvpc-tb-cpa', cpaTts > 0 ? '−' + _fce(cpaTts) : '€0.00');
    setText('pvpc-tb-iva', '−' + _fce(tB.pvp - tB.pvp / _IVA));
    setText('pvpc-tb-cp',  '−' + _fce(cost));
    setText('pvpc-tb-ce',  '−' + _fce(envEs));
    setText('pvpc-tb-dev', '−' + _fce(devEs));
    setText('pvpc-tb-dev-pct', pdev);
    setText('pvpc-tb-ben', _fce(tB.ben));
    _setRoi('pvpc-tb-roi', cpaTts, tB.pvp);
  }

  // ── TTS FR Orgánico ──
  const fA = _ttsFormula(tikPFr, affPFr, ctotInt, minP, 0);
  setText('pvpc-pvp-fr', _fce(fA.pvp));
  setText('pvpc-fra-pvp', _fce(fA.pvp));
  setText('pvpc-fra-tp', tikPFr);  setText('pvpc-fra-ap', affPFr);
  setText('pvpc-fra-tc', '−' + _fce(fA.tikC));
  setText('pvpc-fra-ac', '−' + _fce(fA.affC));
  setText('pvpc-fra-iva', '−' + _fce(fA.pvp - fA.pvp / _IVA));
  setText('pvpc-fra-cp',  '−' + _fce(cost));
  setText('pvpc-fra-ce',  '−' + _fce(envInt));
  setText('pvpc-fra-dev', '−' + _fce(devInt));
  setText('pvpc-fra-dev-pct', pdev);
  setText('pvpc-fra-ben', _fce(fA.ben));
  _setBadge('pvpc-fr-sb', fA.ben, minP);

  // ── TTS FR Paid ──
  if (paidFr) {
    const fB = _ttsFormula(tikPFr, affPPFr, ctotInt, minP, cpaTtsFr);
    setText('pvpc-frb-pvp-big', _fce(fB.pvp));
    setText('pvpc-frb-tp', tikPFr);  setText('pvpc-frb-ap', affPPFr);
    setText('pvpc-frb-tc', '−' + _fce(fB.tikC));
    setText('pvpc-frb-ac', '−' + _fce(fB.affC));
    setText('pvpc-frb-cpa', cpaTtsFr > 0 ? '−' + _fce(cpaTtsFr) : '€0.00');
    setText('pvpc-frb-iva', '−' + _fce(fB.pvp - fB.pvp / _IVA));
    setText('pvpc-frb-cp',  '−' + _fce(cost));
    setText('pvpc-frb-ce',  '−' + _fce(envInt));
    setText('pvpc-frb-dev', '−' + _fce(devInt));
    setText('pvpc-frb-dev-pct', pdev);
    setText('pvpc-frb-ben', _fce(fB.ben));
    _setRoi('pvpc-frb-roi', cpaTtsFr, fB.pvp);
  }

  // ── Health grid ──
  const hg = _g('pvpc-health-grid');
  if (hg) {
    hg.innerHTML = [
      { l: 'Web Tarjeta', p: wBen, pvp: w.total, c: 'var(--or)' },
      { l: 'Web COD',     p: cBen, pvp: c.total,  c: 'var(--gr)' },
      { l: 'TTS ES org.', p: tA.ben, pvp: tA.pvp,  c: '#333' },
      { l: 'TTS FR org.', p: fA.ben, pvp: fA.pvp,  c: 'var(--bl)' }
    ].map(x => {
      const pct = x.pvp > 0 ? (x.p / x.pvp * 100) : 0;
      const r   = minP > 0 ? x.p / minP : 0;
      const col = r >= 1 ? 'var(--gr)' : r >= 0.6 ? '#e8a000' : 'var(--re)';
      return `<div class="cc-kpi" style="border-left-color:${x.c}">
        <div class="kl">${x.l}</div>
        <div class="kv" style="color:${col}">${pct.toFixed(1)}%</div>
        <div class="ks">${_fce(x.p)} / PVP ${_fce(x.pvp)}</div>
      </div>`;
    }).join('');
  }
}

// ══════════════════════════════════════════════════════════════
//  CALCULADORA CPA   (PVP → CPA máximo por canal)
// ══════════════════════════════════════════════════════════════
let _cpacMargen = 60;

function cpacSetM(m) {
  _cpacMargen = m;
  document.querySelectorAll('.cpac-mb').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.m) === m));
  _g('cpac-mc').value = '';
  cpacCalc();
}

function cpacTogglePaid(r) {
  const chk = _g('cpac-paid-tog' + (r === 'fr' ? '-fr' : ''));
  _g('cpac-paid-flds-' + r)?.classList.toggle('cc-on', chk?.checked);
  _g('cpac-paid-' + r + '-sec')?.style && (_g('cpac-paid-' + r + '-sec').style.display = chk?.checked ? 'block' : 'none');
  cpacCalc();
}

function cpacCalc() {
  const cost    = _gf('cpac-cost', 10);
  const envEs   = _gf('cpac-envio', 3.3);
  const envInt  = _gf('cpac-envio-int', 6);
  const pdev    = _gf('cpac-pdev', 5);
  const pvp     = _gf('cpac-pvp', 0);
  const tikP    = _gf('cpac-tik', 9);
  const affP    = _gf('cpac-aff', 16);
  const affPP   = _gf('cpac-aff-p', 5);
  const tikPFr  = _gf('cpac-tik-fr', 9);
  const affPFr  = _gf('cpac-aff-fr', 16);
  const affPPFr = _gf('cpac-aff-p-fr', 5);
  const paidEs  = _g('cpac-paid-tog')?.checked;
  const paidFr  = _g('cpac-paid-tog-fr')?.checked;
  const codC    = _gf('cpac-cod-c', 85);
  const codE    = _gf('cpac-cod-e', 83);
  const codEfec = (codC / 100) * (codE / 100);
  const devEs   = cost * pdev / 100;
  const devInt  = cost * pdev / 100;
  const ctotEs  = cost + envEs + devEs;
  const ctotInt = cost + envInt + devInt;
  const minP    = cost * _cpacMargen / 100;

  setText('cpac-cod-ef', _fcp(codEfec * 100));
  setText('cpac-cod-ef-preview', _fcp(codEfec * 100));
  setText('cpac-mpill', 'Ganancia mín: €' + minP.toFixed(2) + ' · Coste €' + cost.toFixed(2));

  const pvpNet = pvp > 0 ? pvp / _IVA : 0;
  const pvpIva = pvp > 0 ? pvp - pvpNet : 0;

  // ── WEB TARJETA — CPA máx ──
  const wCpa  = pvp > 0 ? Math.max(pvpNet - ctotEs - minP, 0) : 0;
  const wRoas = wCpa > 0 ? pvp / wCpa : 0;
  setText('cpac-pvp-w', pvp > 0 ? _fce(wCpa) : '—');
  setText('cpac-w-pvp', pvp > 0 ? _fce(pvp) : '—');
  setText('cpac-w-net', pvp > 0 ? _fce(pvpNet) : '—');
  setText('cpac-w-iva', pvp > 0 ? '−' + _fce(pvpIva) : '—');
  setText('cpac-w-cp',  pvp > 0 ? '−' + _fce(cost) : '—');
  setText('cpac-w-ce',  pvp > 0 ? '−' + _fce(envEs) : '—');
  setText('cpac-w-dev', pvp > 0 ? '−' + _fce(devEs) : '—');
  setText('cpac-w-dev-pct', pdev);
  setText('cpac-w-ct',  pvp > 0 ? '−' + _fce(ctotEs) : '—');
  setText('cpac-w-minp', pvp > 0 ? '−' + _fce(minP) : '—');
  setText('cpac-w-cpa', pvp > 0 ? _fce(wCpa) : '—');
  setText('cpac-w-roi', wRoas > 0 ? wRoas.toFixed(2) + 'x' : '—');
  _setEnvTag('cpac-w-etag', pvp > 0 ? _getEnvCobrado(pvp, 'cpac-') : 1);
  if (pvp > 0) _setCpaBadge('cpac-w-sb', wCpa, minP, cost);
  else { const el = _g('cpac-w-sb'); if (el) { el.className = 'cc-sb'; el.textContent = ''; } }

  // ── WEB COD — CPA máx ──
  const codR     = codEfec > 0 ? codEfec : 0.01;
  const ctotEfec = ctotEs / codR;
  const devExtra = ctotEfec - ctotEs;
  const cCpa  = pvp > 0 ? Math.max(pvpNet - ctotEfec - minP, 0) : 0;
  const cRoas = cCpa > 0 ? pvp / cCpa : 0;
  setText('cpac-pvp-c', pvp > 0 ? _fce(cCpa) : '—');
  setText('cpac-c-pvp', pvp > 0 ? _fce(pvp) : '—');
  setText('cpac-c-ef', _fcp(codEfec * 100));
  setText('cpac-c-iva', pvp > 0 ? '−' + _fce(pvpIva) : '—');
  setText('cpac-c-cp',  pvp > 0 ? '−' + _fce(cost) : '—');
  setText('cpac-c-ce',  pvp > 0 ? '−' + _fce(envEs) : '—');
  setText('cpac-c-dev-prod', pvp > 0 ? '−' + _fce(devEs) : '—');
  setText('cpac-c-dev-pct', pdev);
  setText('cpac-c-ct',  pvp > 0 ? '−' + _fce(ctotEs) : '—');
  setText('cpac-c-dev', pvp > 0 ? '−' + _fce(devExtra) : '—');
  setText('cpac-c-minp', pvp > 0 ? '−' + _fce(minP) : '—');
  setText('cpac-c-cpa', pvp > 0 ? _fce(cCpa) : '—');
  setText('cpac-c-roi', cRoas > 0 ? cRoas.toFixed(2) + 'x' : '—');
  if (pvp > 0) _setCpaBadge('cpac-c-sb', cCpa, minP, cost);
  else { const el = _g('cpac-c-sb'); if (el) { el.className = 'cc-sb'; el.textContent = ''; } }

  // ── TTS ES Orgánico — beneficio neto al PVP dado ──
  const tATikC = pvp > 0 ? pvp * tikP / 100 : 0;
  const tAAffC = pvp > 0 ? pvp * affP / 100 : 0;
  const tABen  = pvp > 0 ? pvpNet - tATikC - tAAffC - ctotEs : 0;
  setText('cpac-pvp-t', pvp > 0 ? _fce(tABen) : '—');
  setText('cpac-ta-pvp', pvp > 0 ? _fce(pvp) : '—');
  setText('cpac-ta-tp', tikP); setText('cpac-ta-ap', affP);
  setText('cpac-ta-tc', pvp > 0 ? '−' + _fce(tATikC) : '—');
  setText('cpac-ta-ac', pvp > 0 ? '−' + _fce(tAAffC) : '—');
  setText('cpac-ta-iva', pvp > 0 ? '−' + _fce(pvpIva) : '—');
  setText('cpac-ta-cp',  pvp > 0 ? '−' + _fce(cost) : '—');
  setText('cpac-ta-ce',  pvp > 0 ? '−' + _fce(envEs) : '—');
  setText('cpac-ta-dev', pvp > 0 ? '−' + _fce(devEs) : '—');
  setText('cpac-ta-dev-pct', pdev);
  setText('cpac-ta-ben', pvp > 0 ? _fce(tABen) : '—');
  if (pvp > 0) _setBadge('cpac-t-sb', tABen, minP);
  else { const el = _g('cpac-t-sb'); if (el) { el.className = 'cc-sb'; el.textContent = ''; } }

  // ── TTS ES Paid — CPA máx ──
  if (paidEs && pvp > 0) {
    const denPaid = (1 / _IVA) - (tikP + affPP) / 100;
    const tbCpa   = denPaid > 0 ? Math.max(pvp * denPaid - ctotEs - minP, 0) : 0;
    const tbTikC  = pvp * tikP / 100;
    const tbAffC  = pvp * affPP / 100;
    const tbBen   = pvpNet - tbTikC - tbAffC - tbCpa - ctotEs;
    const tbRoas  = tbCpa > 0 ? pvp / tbCpa : 0;
    setText('cpac-tb-pvp-big', _fce(tbCpa));
    setText('cpac-tb-tp', tikP); setText('cpac-tb-ap', affPP);
    setText('cpac-tb-tc', '−' + _fce(tbTikC));
    setText('cpac-tb-ac', '−' + _fce(tbAffC));
    setText('cpac-tb-iva', '−' + _fce(pvpIva));
    setText('cpac-tb-cp',  '−' + _fce(cost));
    setText('cpac-tb-ce',  '−' + _fce(envEs));
    setText('cpac-tb-dev', '−' + _fce(devEs));
    setText('cpac-tb-dev-pct', pdev);
    setText('cpac-tb-minp', '−' + _fce(minP));
    setText('cpac-tb-cpa', _fce(tbCpa));
    setText('cpac-tb-roi', tbRoas > 0 ? tbRoas.toFixed(2) + 'x' : '—');
    _setCpaBadge('cpac-tb-sb', tbCpa, minP, cost);
  }

  // ── TTS FR Orgánico ──
  const fATikC = pvp > 0 ? pvp * tikPFr / 100 : 0;
  const fAAffC = pvp > 0 ? pvp * affPFr / 100 : 0;
  const fABen  = pvp > 0 ? pvpNet - fATikC - fAAffC - ctotInt : 0;
  setText('cpac-pvp-fr', pvp > 0 ? _fce(fABen) : '—');
  setText('cpac-fra-pvp', pvp > 0 ? _fce(pvp) : '—');
  setText('cpac-fra-tp', tikPFr); setText('cpac-fra-ap', affPFr);
  setText('cpac-fra-tc', pvp > 0 ? '−' + _fce(fATikC) : '—');
  setText('cpac-fra-ac', pvp > 0 ? '−' + _fce(fAAffC) : '—');
  setText('cpac-fra-iva', pvp > 0 ? '−' + _fce(pvpIva) : '—');
  setText('cpac-fra-cp',  pvp > 0 ? '−' + _fce(cost) : '—');
  setText('cpac-fra-ce',  pvp > 0 ? '−' + _fce(envInt) : '—');
  setText('cpac-fra-dev', pvp > 0 ? '−' + _fce(devInt) : '—');
  setText('cpac-fra-dev-pct', pdev);
  setText('cpac-fra-ben', pvp > 0 ? _fce(fABen) : '—');
  if (pvp > 0) _setBadge('cpac-fr-sb', fABen, minP);
  else { const el = _g('cpac-fr-sb'); if (el) { el.className = 'cc-sb'; el.textContent = ''; } }

  // ── TTS FR Paid — CPA máx ──
  if (paidFr && pvp > 0) {
    const denPaidFr = (1 / _IVA) - (tikPFr + affPPFr) / 100;
    const fbCpa     = denPaidFr > 0 ? Math.max(pvp * denPaidFr - ctotInt - minP, 0) : 0;
    const fbTikC    = pvp * tikPFr / 100;
    const fbAffC    = pvp * affPPFr / 100;
    const fbBen     = pvpNet - fbTikC - fbAffC - fbCpa - ctotInt;
    const fbRoas    = fbCpa > 0 ? pvp / fbCpa : 0;
    setText('cpac-frb-pvp-big', _fce(fbCpa));
    setText('cpac-frb-tp', tikPFr); setText('cpac-frb-ap', affPPFr);
    setText('cpac-frb-tc', '−' + _fce(fbTikC));
    setText('cpac-frb-ac', '−' + _fce(fbAffC));
    setText('cpac-frb-iva', '−' + _fce(pvpIva));
    setText('cpac-frb-cp',  '−' + _fce(cost));
    setText('cpac-frb-ce',  '−' + _fce(envInt));
    setText('cpac-frb-dev', '−' + _fce(devInt));
    setText('cpac-frb-dev-pct', pdev);
    setText('cpac-frb-minp', '−' + _fce(minP));
    setText('cpac-frb-cpa', _fce(fbCpa));
    setText('cpac-frb-roi', fbRoas > 0 ? fbRoas.toFixed(2) + 'x' : '—');
    _setCpaBadge('cpac-frb-sb', fbCpa, minP, cost);
  }

  // ── Health grid ──
  const hg = _g('cpac-health-grid');
  if (hg && pvp > 0) {
    hg.innerHTML = [
      { l: 'Web Tarjeta · CPA máx', v: wCpa,  sub: 'ROAS mín: ' + (wRoas > 0 ? wRoas.toFixed(1) + 'x' : '—'), c: 'var(--or)' },
      { l: 'Web COD · CPA máx',     v: cCpa,  sub: 'ROAS mín: ' + (cRoas > 0 ? cRoas.toFixed(1) + 'x' : '—'), c: 'var(--gr)' },
      { l: 'TTS ES org. · Beneficio', v: tABen, sub: (tABen / pvp * 100).toFixed(1) + '% sobre PVP', c: '#333' },
      { l: 'TTS FR org. · Beneficio', v: fABen, sub: (fABen / pvp * 100).toFixed(1) + '% sobre PVP', c: 'var(--bl)' }
    ].map(x => {
      const col = x.v >= minP ? 'var(--gr)' : x.v > 0 ? '#e8a000' : 'var(--re)';
      return `<div class="cc-kpi" style="border-left-color:${x.c}">
        <div class="kl">${x.l}</div>
        <div class="kv" style="color:${col}">${_fce(x.v)}</div>
        <div class="ks">${x.sub}</div>
      </div>`;
    }).join('');
  } else if (hg) {
    hg.innerHTML = '<div style="font-size:12px;color:var(--md);padding:8px">Ingresá el PVP para ver el resumen.</div>';
  }
}

// ── HTML Render ───────────────────────────────────────────────

function _calcConfigHTML(p, isPvp) {
  const accent = isPvp ? 'var(--or)' : 'var(--bl)';
  const accentL = isPvp ? 'var(--or-l)' : 'var(--bl-l)';
  const calcFn = isPvp ? 'pvpcCalc()' : 'cpacCalc()';
  const setMFn = isPvp ? 'pvpcSetM' : 'cpacSetM';
  const togFn  = isPvp ? 'pvpcTogglePaid' : 'cpacTogglePaid';
  const skuFn  = isPvp ? 'pvpcSkuSearch()' : 'cpacSkuSearch()';

  const pvpInput = isPvp
    ? `<div class="cc-f"><label>CPA Meta</label><div class="cc-iw"><input type="number" id="${p}cpa-meta" value="10" min="0" step="0.5" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>`
    : `<div class="cc-f" style="background:${accentL};padding:8px;border-radius:7px;border:2px solid ${accent}"><label style="font-weight:700;color:${accent}">PVP fijo</label><div class="cc-iw"><input type="number" id="${p}pvp" value="0" min="0" step="0.5" oninput="${calcFn}" style="border-color:${accent};font-size:14px;width:80px"/><span class="cc-un">€</span></div></div>`;

  const paidEsExtra = isPvp
    ? `<div class="cc-f"><label>CPA TikTok ads</label><div class="cc-iw"><input type="number" id="${p}cpa-tts" value="0" min="0" step="0.5" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>`
    : '';
  const paidFrExtra = isPvp
    ? `<div class="cc-f"><label>CPA TikTok ads (FR)</label><div class="cc-iw"><input type="number" id="${p}cpa-tts-fr" value="0" min="0" step="0.5" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>`
    : '';

  return `<div class="card"><div class="card-header"><h3>Configuración</h3></div><div class="card-body"><div class="cc-gcfg">
  <div class="cc-fg">
    <div class="cc-gt" style="color:${accent};border-bottom-color:${accentL}">Producto</div>
    <div class="cc-sku-wrap"><input type="text" class="cc-sku-inp" id="${p}sku-search" placeholder="Buscar SKU..." autocomplete="off" oninput="${skuFn}" style="border-color:${accent};background:${accentL}"/><div class="cc-sku-dd" id="${p}sku-dd" style="border-color:${accent}"></div></div>
    <div class="cc-sku-active" id="${p}sku-active"><div class="cc-sku-active-top"><span class="cc-sku-active-lbl">SKU activo</span><button class="cc-sku-active-clr" onclick="document.getElementById('${p}sku-active').style.display='none'">✕</button></div><div class="cc-sku-active-code" id="${p}sku-active-code">—</div><div class="cc-sku-active-costs" id="${p}sku-active-costs">—</div></div>
    <div class="cc-f"><label>Coste producto</label><div class="cc-iw"><input type="number" id="${p}cost" value="10" min="0" step="0.01" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>
    <div class="cc-f"><label>Coste envío España</label><div class="cc-iw"><input type="number" id="${p}envio" value="3.30" min="0" step="0.1" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>
    <div class="cc-f"><label>Coste envío internacional</label><div class="cc-iw"><input type="number" id="${p}envio-int" value="6.00" min="0" step="0.1" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>
    <div class="cc-f"><label>% Devoluciones</label><div class="cc-iw"><input type="number" id="${p}pdev" value="5" min="0" step="1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
    ${pvpInput}
  </div>
  <div class="cc-fg">
    <div class="cc-gt" style="color:${accent};border-bottom-color:${accentL}">Web (tarjeta + COD)</div>
    <div>
      <div style="font-size:11px;color:var(--md);margin-bottom:4px">Margen mínimo sobre coste</div>
      <div class="cc-mbtns">
        <button class="cc-mb ${p}mb active" data-m="60" onclick="${setMFn}(60)">60%</button>
        <button class="cc-mb ${p}mb" data-m="80" onclick="${setMFn}(80)">80%</button>
        <button class="cc-mb ${p}mb" data-m="100" onclick="${setMFn}(100)">100%</button>
        <button class="cc-mb ${p}mb" data-m="120" onclick="${setMFn}(120)">120%</button>
      </div>
      <div class="cc-mc-row" style="margin-top:4px"><label>Otro:</label><input type="number" id="${p}mc" placeholder="75" min="0" step="1"/><span class="cc-un">%</span></div>
      <div class="cc-mpill" id="${p}mpill" style="margin-top:4px">—</div>
    </div>
    <div class="cc-ship-hdr" onclick="var b=document.getElementById('${p}ship-body');b.classList.toggle('cc-open')"><span class="cc-ship-hdr-lbl">Tarifas envío al cliente</span><span style="font-size:10px;color:var(--md)">▼</span></div>
    <div class="cc-ship-body" id="${p}ship-body">
      <div class="cc-cod-r"><label style="font-size:11px">Envío base (&gt;€10)</label><div class="cc-iw"><input type="number" id="${p}env-base" value="3" min="0" step="0.5" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>
      <div class="cc-cod-r"><label style="font-size:11px">Extra &lt;€10</label><div class="cc-iw"><input type="number" id="${p}env-extra" value="2" min="0" step="0.5" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>
      <div class="cc-cod-r"><label style="font-size:11px">Umbral envío gratis</label><div class="cc-iw"><input type="number" id="${p}env-um" value="26" min="0" step="0.5" oninput="${calcFn}"/><span class="cc-un">€</span></div></div>
    </div>
    <div class="cc-ship-hdr" onclick="var b=document.getElementById('${p}cod-body');b.classList.toggle('cc-open')" style="margin-top:3px"><span class="cc-ship-hdr-lbl" style="color:var(--gr)">Contrarreembolso (COD)</span><div style="display:flex;align-items:center;gap:8px"><span style="font-size:10.5px;font-weight:600;color:var(--gr)" id="${p}cod-ef-preview">70.6%</span><span style="font-size:10px;color:var(--md)">▼</span></div></div>
    <div class="cc-ship-body" id="${p}cod-body">
      <div class="cc-cod-r"><label>Tasa confirmación</label><div class="cc-iw"><input type="number" id="${p}cod-c" placeholder="85" min="0" max="100" step="1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
      <div class="cc-cod-r"><label>Tasa entrega</label><div class="cc-iw"><input type="number" id="${p}cod-e" placeholder="83" min="0" max="100" step="1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
      <div class="cc-cod-efec"><span>Efectividad real</span><strong id="${p}cod-ef">70.6%</strong></div>
    </div>
  </div>
  <div class="cc-fg">
    <div class="cc-gt d">TikTok Shop · España</div>
    <div class="cc-f"><label>Comisión TikTok</label><div class="cc-iw"><input type="number" id="${p}tik" value="9" min="0" step="0.1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
    <div style="font-size:10.5px;color:var(--md);font-weight:600;padding:2px 0">Orgánico</div>
    <div class="cc-f"><label>Afiliado orgánico</label><div class="cc-iw"><input type="number" id="${p}aff" value="16" min="0" step="0.1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
    <div style="font-size:10.5px;color:var(--md);font-weight:600;padding:3px 0 1px">Paid</div>
    <div class="cc-tog-row"><span class="cc-tl">Activar Paid</span><label class="cc-tog"><input type="checkbox" id="${p}paid-tog" onchange="${togFn}('es')"/><span class="cc-tog-sl"></span></label></div>
    <div class="cc-paid-flds" id="${p}paid-flds-es">
      <div class="cc-paid-note">Afiliado cobra % paid.</div>
      <div class="cc-f"><label>Afiliado paid</label><div class="cc-iw"><input type="number" id="${p}aff-p" value="5" min="0" step="0.1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
      ${paidEsExtra}
    </div>
  </div>
  <div class="cc-fg">
    <div class="cc-gt b">TikTok Shop · Francia</div>
    <div class="cc-f"><label>Comisión TikTok (FR)</label><div class="cc-iw"><input type="number" id="${p}tik-fr" value="9" min="0" step="0.1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
    <div style="font-size:10.5px;color:var(--md);font-weight:600;padding:2px 0">Orgánico</div>
    <div class="cc-f"><label>Afiliado orgánico (FR)</label><div class="cc-iw"><input type="number" id="${p}aff-fr" value="16" min="0" step="0.1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
    <div style="font-size:10.5px;color:var(--md);font-weight:600;padding:3px 0 1px">Paid</div>
    <div class="cc-tog-row"><span class="cc-tl">Activar Paid FR</span><label class="cc-tog"><input type="checkbox" id="${p}paid-tog-fr" onchange="${togFn}('fr')"/><span class="cc-tog-sl"></span></label></div>
    <div class="cc-paid-flds" id="${p}paid-flds-fr">
      <div class="cc-paid-note">Afiliado cobra % paid FR.</div>
      <div class="cc-f"><label>Afiliado paid (FR)</label><div class="cc-iw"><input type="number" id="${p}aff-p-fr" value="5" min="0" step="0.1" oninput="${calcFn}"/><span class="cc-un">%</span></div></div>
      ${paidFrExtra}
    </div>
  </div>
</div></div></div>`;
}

function _pvpResultsHTML(p) {
  return `<div class="cc-res4">
  <div class="cc-rc web">
    <div class="cc-rh"><div class="cc-ch-info"><div class="cc-ch-ico">W</div><div><div class="cc-ch-nm">Web · Tarjeta</div><div class="cc-ch-sb">Meta Ads</div><div class="cc-env-tag" id="${p}w-etag">—</div></div></div><div class="cc-pvp-wrap"><div class="cc-pvp-big" id="${p}pvp-w">—</div></div></div>
    <div class="cc-bd">
      <div class="cc-br"><span class="l">Precio en tienda</span><span class="r" id="${p}w-store">—</span></div>
      <div class="cc-br"><span class="l">Ingreso neto sin IVA</span><span class="r" id="${p}w-net">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}w-iva">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}w-cp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Envío ES</span><span class="r" id="${p}w-ce">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}w-dev-pct">5</span>%)</span><span class="r" id="${p}w-dev">—</span></div>
      <div class="cc-br neg tot-sub"><span class="l">− Total costes</span><span class="r" id="${p}w-ct">—</span></div>
      <div class="cc-br neg"><span class="l">− CPA Meta</span><span class="r" id="${p}w-cpa">—</span></div>
      <div class="cc-br pos tot"><span class="l">Beneficio neto</span><span class="r" id="${p}w-ben">—</span></div>
    </div>
    <div class="cc-roi-strip"><div class="rl"><strong>ROI Meta</strong>PVP ÷ CPA</div><div style="text-align:right"><div class="cc-roi-num" id="${p}w-roi">—</div><div class="cc-roi-sub">ROAS mín</div></div></div>
    <div class="cc-sbw"><div class="cc-sb" id="${p}w-sb"></div></div>
  </div>
  <div class="cc-rc cod">
    <div class="cc-rh"><div class="cc-ch-info"><div class="cc-ch-ico">C</div><div><div class="cc-ch-nm">Web · COD</div><div class="cc-ch-sb">Contrarreembolso</div><div class="cc-env-tag" id="${p}c-etag">—</div></div></div><div class="cc-pvp-wrap"><div class="cc-pvp-big" id="${p}pvp-c">—</div></div></div>
    <div class="cc-bd">
      <div class="cc-br"><span class="l">Precio en tienda</span><span class="r" id="${p}c-store">—</span></div>
      <div class="cc-br"><span class="l">Efectividad real</span><span class="r" id="${p}c-ef">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}c-iva">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}c-cp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Envío ES</span><span class="r" id="${p}c-ce">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}c-dev-pct">5</span>%)</span><span class="r" id="${p}c-dev-prod">—</span></div>
      <div class="cc-br neg tot-sub"><span class="l">− Total costes</span><span class="r" id="${p}c-ct">—</span></div>
      <div class="cc-br neg"><span class="l">− Coste no entrega</span><span class="r" id="${p}c-dev">—</span></div>
      <div class="cc-br neg"><span class="l">− CPA Meta</span><span class="r" id="${p}c-cpa">—</span></div>
      <div class="cc-br pos tot"><span class="l">Beneficio neto</span><span class="r" id="${p}c-ben">—</span></div>
    </div>
    <div class="cc-roi-strip"><div class="rl"><strong>ROI Meta</strong>PVP ÷ CPA</div><div style="text-align:right"><div class="cc-roi-num" id="${p}c-roi">—</div><div class="cc-roi-sub">ROAS mín</div></div></div>
    <div class="cc-sbw"><div class="cc-sb" id="${p}c-sb"></div></div>
  </div>
  <div class="cc-rc tts">
    <div class="cc-rh"><div class="cc-ch-info"><div class="cc-ch-ico">T</div><div><div class="cc-ch-nm">TikTok Shop</div><div class="cc-ch-sb">España</div></div></div><div class="cc-pvp-wrap"><div class="cc-pvp-big" id="${p}pvp-t">—</div></div></div>
    <div class="cc-stag org">Orgánico</div>
    <div class="cc-bd">
      <div class="cc-br"><span class="l">PVP org.</span><span class="r" id="${p}ta-pvp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − TikTok <span id="${p}ta-tp">9</span>%</span><span class="r" id="${p}ta-tc">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Afiliado <span id="${p}ta-ap">16</span>%</span><span class="r" id="${p}ta-ac">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}ta-iva">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}ta-cp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Envío ES</span><span class="r" id="${p}ta-ce">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}ta-dev-pct">5</span>%)</span><span class="r" id="${p}ta-dev">—</span></div>
      <div class="cc-br pos tot"><span class="l">Beneficio neto</span><span class="r" id="${p}ta-ben">—</span></div>
    </div>
    <div class="cc-sbw"><div class="cc-sb" id="${p}t-sb"></div></div>
    <div id="${p}paid-es-sec" class="cc-paid-sec">
      <div class="cc-sdiv"></div><div class="cc-stag paid-s">Paid</div>
      <div class="cc-ppb"><div><div class="cc-ppb-lbl">PVP mínimo paid</div></div><span class="cc-ppb-val" id="${p}tb-pvp-big">—</span></div>
      <div class="cc-bd">
        <div class="cc-br neg sub"><span class="l"> − TikTok <span id="${p}tb-tp">9</span>%</span><span class="r" id="${p}tb-tc">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Afiliado paid <span id="${p}tb-ap">5</span>%</span><span class="r" id="${p}tb-ac">—</span></div>
        <div class="cc-br neg"><span class="l">− CPA TTS</span><span class="r" id="${p}tb-cpa">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}tb-iva">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}tb-cp">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Envío ES</span><span class="r" id="${p}tb-ce">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}tb-dev-pct">5</span>%)</span><span class="r" id="${p}tb-dev">—</span></div>
        <div class="cc-br pos tot"><span class="l">Beneficio neto</span><span class="r" id="${p}tb-ben">—</span></div>
      </div>
      <div class="cc-roi-strip"><div class="rl"><strong>ROI TTS Paid</strong>PVP ÷ CPA</div><div style="text-align:right"><div class="cc-roi-num" id="${p}tb-roi">—</div><div class="cc-roi-sub">ROAS mín</div></div></div>
    </div>
  </div>
  <div class="cc-rc fr">
    <div class="cc-rh"><div class="cc-ch-info"><div class="cc-ch-ico">FR</div><div><div class="cc-ch-nm">TikTok Shop</div><div class="cc-ch-sb">Francia</div></div></div><div class="cc-pvp-wrap"><div class="cc-pvp-big" id="${p}pvp-fr" style="color:var(--bl)">—</div></div></div>
    <div class="cc-stag org">Orgánico</div>
    <div class="cc-bd">
      <div class="cc-br"><span class="l">PVP org. FR</span><span class="r" id="${p}fra-pvp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − TikTok <span id="${p}fra-tp">9</span>%</span><span class="r" id="${p}fra-tc">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Afiliado <span id="${p}fra-ap">16</span>%</span><span class="r" id="${p}fra-ac">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}fra-iva">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}fra-cp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Envío INT</span><span class="r" id="${p}fra-ce">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}fra-dev-pct">5</span>%)</span><span class="r" id="${p}fra-dev">—</span></div>
      <div class="cc-br pos tot"><span class="l">Beneficio neto</span><span class="r" id="${p}fra-ben">—</span></div>
    </div>
    <div class="cc-sbw"><div class="cc-sb" id="${p}fr-sb"></div></div>
    <div id="${p}paid-fr-sec" class="cc-paid-sec">
      <div class="cc-sdiv"></div><div class="cc-stag paid-s">Paid FR</div>
      <div class="cc-ppb" style="background:var(--bl)"><div><div class="cc-ppb-lbl">PVP mínimo paid FR</div></div><span class="cc-ppb-val" id="${p}frb-pvp-big">—</span></div>
      <div class="cc-bd">
        <div class="cc-br neg sub"><span class="l"> − TikTok <span id="${p}frb-tp">9</span>%</span><span class="r" id="${p}frb-tc">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Afiliado paid <span id="${p}frb-ap">5</span>%</span><span class="r" id="${p}frb-ac">—</span></div>
        <div class="cc-br neg"><span class="l">− CPA TTS (FR)</span><span class="r" id="${p}frb-cpa">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}frb-iva">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}frb-cp">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Envío INT</span><span class="r" id="${p}frb-ce">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}frb-dev-pct">5</span>%)</span><span class="r" id="${p}frb-dev">—</span></div>
        <div class="cc-br pos tot"><span class="l">Beneficio neto</span><span class="r" id="${p}frb-ben">—</span></div>
      </div>
      <div class="cc-roi-strip"><div class="rl"><strong>ROI TTS Paid FR</strong>PVP ÷ CPA</div><div style="text-align:right"><div class="cc-roi-num" id="${p}frb-roi">—</div><div class="cc-roi-sub">ROAS mín</div></div></div>
    </div>
  </div>
</div>
<div class="card" style="margin-top:16px"><div class="card-header"><h3>Rendimiento — beneficio sobre PVP</h3></div><div class="card-body"><div class="cc-kpi-grid" id="${p}health-grid"></div></div></div>`;
}

function _cpaResultsHTML(p) {
  return `<div class="cc-res4">
  <div class="cc-rc web">
    <div class="cc-rh"><div class="cc-ch-info"><div class="cc-ch-ico">W</div><div><div class="cc-ch-nm">Web · Tarjeta</div><div class="cc-ch-sb">CPA máximo</div><div class="cc-env-tag" id="${p}w-etag">—</div></div></div><div class="cc-pvp-wrap"><div class="cc-pvp-big" id="${p}pvp-w">—</div><div class="cc-pvp-note">CPA máx</div></div></div>
    <div class="cc-bd">
      <div class="cc-br"><span class="l">PVP fijo</span><span class="r" id="${p}w-pvp">—</span></div>
      <div class="cc-br"><span class="l">Ingreso neto sin IVA</span><span class="r" id="${p}w-net">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}w-iva">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}w-cp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Envío ES</span><span class="r" id="${p}w-ce">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}w-dev-pct">5</span>%)</span><span class="r" id="${p}w-dev">—</span></div>
      <div class="cc-br neg tot-sub"><span class="l">− Total costes</span><span class="r" id="${p}w-ct">—</span></div>
      <div class="cc-br neg"><span class="l">− Margen mínimo</span><span class="r" id="${p}w-minp">—</span></div>
      <div class="cc-br pos tot"><span class="l">= CPA máximo</span><span class="r" id="${p}w-cpa">—</span></div>
    </div>
    <div class="cc-roi-strip"><div class="rl"><strong>ROAS mínimo</strong>PVP ÷ CPA</div><div style="text-align:right"><div class="cc-roi-num" id="${p}w-roi">—</div></div></div>
    <div class="cc-sbw"><div class="cc-sb" id="${p}w-sb"></div></div>
  </div>
  <div class="cc-rc cod">
    <div class="cc-rh"><div class="cc-ch-info"><div class="cc-ch-ico">C</div><div><div class="cc-ch-nm">Web · COD</div><div class="cc-ch-sb">CPA máximo</div></div></div><div class="cc-pvp-wrap"><div class="cc-pvp-big" id="${p}pvp-c">—</div><div class="cc-pvp-note">CPA máx</div></div></div>
    <div class="cc-bd">
      <div class="cc-br"><span class="l">PVP fijo</span><span class="r" id="${p}c-pvp">—</span></div>
      <div class="cc-br"><span class="l">Efectividad real</span><span class="r" id="${p}c-ef">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}c-iva">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}c-cp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Envío ES</span><span class="r" id="${p}c-ce">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}c-dev-pct">5</span>%)</span><span class="r" id="${p}c-dev-prod">—</span></div>
      <div class="cc-br neg tot-sub"><span class="l">− Total costes</span><span class="r" id="${p}c-ct">—</span></div>
      <div class="cc-br neg"><span class="l">− Coste no entrega</span><span class="r" id="${p}c-dev">—</span></div>
      <div class="cc-br neg"><span class="l">− Margen mínimo</span><span class="r" id="${p}c-minp">—</span></div>
      <div class="cc-br pos tot"><span class="l">= CPA máximo</span><span class="r" id="${p}c-cpa">—</span></div>
    </div>
    <div class="cc-roi-strip"><div class="rl"><strong>ROAS mínimo</strong>PVP ÷ CPA</div><div style="text-align:right"><div class="cc-roi-num" id="${p}c-roi">—</div></div></div>
    <div class="cc-sbw"><div class="cc-sb" id="${p}c-sb"></div></div>
  </div>
  <div class="cc-rc tts">
    <div class="cc-rh"><div class="cc-ch-info"><div class="cc-ch-ico">T</div><div><div class="cc-ch-nm">TikTok Shop</div><div class="cc-ch-sb">España · Beneficio</div></div></div><div class="cc-pvp-wrap"><div class="cc-pvp-big" id="${p}pvp-t">—</div><div class="cc-pvp-note">Beneficio</div></div></div>
    <div class="cc-stag org">Orgánico</div>
    <div class="cc-bd">
      <div class="cc-br"><span class="l">PVP fijo</span><span class="r" id="${p}ta-pvp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − TikTok <span id="${p}ta-tp">9</span>%</span><span class="r" id="${p}ta-tc">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Afiliado <span id="${p}ta-ap">16</span>%</span><span class="r" id="${p}ta-ac">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}ta-iva">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}ta-cp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Envío ES</span><span class="r" id="${p}ta-ce">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}ta-dev-pct">5</span>%)</span><span class="r" id="${p}ta-dev">—</span></div>
      <div class="cc-br pos tot"><span class="l">Beneficio neto</span><span class="r" id="${p}ta-ben">—</span></div>
    </div>
    <div class="cc-sbw"><div class="cc-sb" id="${p}t-sb"></div></div>
    <div id="${p}paid-es-sec" class="cc-paid-sec">
      <div class="cc-sdiv"></div><div class="cc-stag paid-s">Paid — CPA máx</div>
      <div class="cc-ppb"><div><div class="cc-ppb-lbl">CPA máximo TTS paid</div></div><span class="cc-ppb-val" id="${p}tb-pvp-big">—</span></div>
      <div class="cc-bd">
        <div class="cc-br neg sub"><span class="l"> − TikTok <span id="${p}tb-tp">9</span>%</span><span class="r" id="${p}tb-tc">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Afiliado paid <span id="${p}tb-ap">5</span>%</span><span class="r" id="${p}tb-ac">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}tb-iva">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}tb-cp">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Envío ES</span><span class="r" id="${p}tb-ce">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}tb-dev-pct">5</span>%)</span><span class="r" id="${p}tb-dev">—</span></div>
        <div class="cc-br neg"><span class="l">− Margen mínimo</span><span class="r" id="${p}tb-minp">—</span></div>
        <div class="cc-br pos tot"><span class="l">= CPA máximo</span><span class="r" id="${p}tb-cpa">—</span></div>
      </div>
      <div class="cc-roi-strip"><div class="rl"><strong>ROAS mínimo</strong>PVP ÷ CPA</div><div style="text-align:right"><div class="cc-roi-num" id="${p}tb-roi">—</div></div></div>
      <div class="cc-sbw"><div class="cc-sb" id="${p}tb-sb"></div></div>
    </div>
  </div>
  <div class="cc-rc fr">
    <div class="cc-rh"><div class="cc-ch-info"><div class="cc-ch-ico">FR</div><div><div class="cc-ch-nm">TikTok Shop</div><div class="cc-ch-sb">Francia · Beneficio</div></div></div><div class="cc-pvp-wrap"><div class="cc-pvp-big" id="${p}pvp-fr" style="color:var(--bl)">—</div><div class="cc-pvp-note">Beneficio</div></div></div>
    <div class="cc-stag org">Orgánico</div>
    <div class="cc-bd">
      <div class="cc-br"><span class="l">PVP fijo FR</span><span class="r" id="${p}fra-pvp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − TikTok <span id="${p}fra-tp">9</span>%</span><span class="r" id="${p}fra-tc">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Afiliado <span id="${p}fra-ap">16</span>%</span><span class="r" id="${p}fra-ac">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}fra-iva">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}fra-cp">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Envío INT</span><span class="r" id="${p}fra-ce">—</span></div>
      <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}fra-dev-pct">5</span>%)</span><span class="r" id="${p}fra-dev">—</span></div>
      <div class="cc-br pos tot"><span class="l">Beneficio neto</span><span class="r" id="${p}fra-ben">—</span></div>
    </div>
    <div class="cc-sbw"><div class="cc-sb" id="${p}fr-sb"></div></div>
    <div id="${p}paid-fr-sec" class="cc-paid-sec">
      <div class="cc-sdiv"></div><div class="cc-stag paid-s">Paid FR — CPA máx</div>
      <div class="cc-ppb" style="background:var(--bl)"><div><div class="cc-ppb-lbl">CPA máximo TTS paid FR</div></div><span class="cc-ppb-val" id="${p}frb-pvp-big">—</span></div>
      <div class="cc-bd">
        <div class="cc-br neg sub"><span class="l"> − TikTok <span id="${p}frb-tp">9</span>%</span><span class="r" id="${p}frb-tc">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Afiliado paid <span id="${p}frb-ap">5</span>%</span><span class="r" id="${p}frb-ac">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − IVA 21%</span><span class="r" id="${p}frb-iva">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Producto</span><span class="r" id="${p}frb-cp">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Envío INT</span><span class="r" id="${p}frb-ce">—</span></div>
        <div class="cc-br neg sub"><span class="l"> − Dev. (<span id="${p}frb-dev-pct">5</span>%)</span><span class="r" id="${p}frb-dev">—</span></div>
        <div class="cc-br neg"><span class="l">− Margen mínimo</span><span class="r" id="${p}frb-minp">—</span></div>
        <div class="cc-br pos tot"><span class="l">= CPA máximo</span><span class="r" id="${p}frb-cpa">—</span></div>
      </div>
      <div class="cc-roi-strip"><div class="rl"><strong>ROAS mínimo</strong>PVP ÷ CPA</div><div style="text-align:right"><div class="cc-roi-num" id="${p}frb-roi">—</div></div></div>
      <div class="cc-sbw"><div class="cc-sb" id="${p}frb-sb"></div></div>
    </div>
  </div>
</div>
<div class="card" style="margin-top:16px"><div class="card-header"><h3>Resumen — CPA máximo por canal</h3></div><div class="card-body"><div class="cc-kpi-grid" id="${p}health-grid"></div></div></div>`;
}

// ── Tab switching ─────────────────────────────────────────────
function ccShowCalc(mode) {
  const pvpC = _g('cc-pvp-container');
  const cpaC = _g('cc-cpa-container');
  const tabP = _g('cc-tab-pvp');
  const tabC = _g('cc-tab-cpa');
  if (mode === 'pvp') {
    pvpC.style.display = 'block'; cpaC.style.display = 'none';
    tabP.className = 'cc-tab active-pvp'; tabC.className = 'cc-tab';
  } else {
    pvpC.style.display = 'none'; cpaC.style.display = 'block';
    tabP.className = 'cc-tab'; tabC.className = 'cc-tab active-cpa';
  }
}

// ── Render & Init ─────────────────────────────────────────────
let _calcRendered = false;

function renderCalc() {
  if (_calcRendered) return;
  _calcRendered = true;

  const pvpC = _g('cc-pvp-container');
  const cpaC = _g('cc-cpa-container');
  pvpC.innerHTML = _calcConfigHTML('pvpc-', true) + _pvpResultsHTML('pvpc-');
  cpaC.innerHTML = _calcConfigHTML('cpac-', false) + _cpaResultsHTML('cpac-');

  // Margen custom inputs
  _g('pvpc-mc')?.addEventListener('input', function() {
    const v = parseFloat(this.value);
    if (!isNaN(v) && v > 0) {
      _pvpcMargen = v;
      document.querySelectorAll('.pvpc-mb').forEach(b => b.classList.remove('active'));
    }
    pvpcCalc();
  });
  _g('cpac-mc')?.addEventListener('input', function() {
    const v = parseFloat(this.value);
    if (!isNaN(v) && v > 0) {
      _cpacMargen = v;
      document.querySelectorAll('.cpac-mb').forEach(b => b.classList.remove('active'));
    }
    cpacCalc();
  });

  pvpcCalc();
  cpacCalc();
  loadCalcData();
}

function loadCalc() {
  renderCalc();
}
