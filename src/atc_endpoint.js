const https = require('https');
const SIMLA_API = 'https://fulfillment.simla.com/api/v5';
const SIMLA_KEY = 'HLJGMavFx6otUkxIrkW0HAHcNCBMtbzy';

const CONFIRMED = new Set(['upsell','falta-preparar','falta-preparar-pagados','pagado','grabado','grabado-snt-v','sin-recepcion','sin-recepcion-snt-v','sin-recepcion-amz','sin-recepcion-amz-snt-v','sin-recepcion-miravia','sin-recepcion-miravia-snt-v','delegacion-destino','en-reparto','almacenado','devuelta-pendiente','no-localizado','entregado-de-rcn','en-arrastre','tramo-origen','transito','transito-1','mal-transitado','tramo-destino','reparto-fallido','nuevo-reparto','entregado','reexpedido','alm-regulador','destruido','destruido-1','transferido-proveedor','anulado','proveedor','entregado-en-punto-concertado','recepcionado-en-oficina','paralizado','depositado-en-oficina','disponible-en-oficina','devuelto-en-oficina','rehusado-rcn','rehusado-recibido','rehusado-erroneos','rehusado-recibido-rec','rehusado-destruccion','complete','marketplace-sin-descontar','marketplace','seguro-lott-correos','recanalizacion','amazon','miravia-preparado','recibido-almacen','reposicion','devolucion','reembolso-recibido-alm','reembolsado','reembolsado-parcial','reembolso-resenas','preparado','send-to-delivery','delivering','entregado-2','assembling','send-to-assembling','assembling-complete','redirect','cerrado-definitivamente','con-incidencia','devuelta','fallo-al-sacar-etiqueta','2-send-to-assembling','bot','rehusados-contabilizados']);
const DELIVERED = new Set(['complete','entregado','entregado-2','pagado','reembolsado','reembolsado-parcial','devolucion','reembolso-recibido-alm','reembolso-resenas','reposicion','recibido-almacen']);
const DEVUELTA_PEND = new Set(['devuelta-pendiente','devuelto-en-oficina']);
const REHUSADO = new Set(['rehusado-rcn','rehusado-recibido','rehusado-erroneos','rehusado-recibido-rec','rehusado-destruccion','rehusados-contabilizados']);
const CANCEL = new Set(['cancel-other','no-call','prices-did-not-suit','already-buyed','delyvery-did-not-suit','otros','no-product','sin-respuesta-1','sin-respuesta-2','sin-respuesta-3','sin-respuesta-4','sin-respuesta-5','sin-respuesta-final','islas-canarias-ceuta-melilla','error-de-descontar-el-stock']);
const STATUS_NAMES = {'new':'Nuevo','upsell':'Upsell','falta-preparar':'Falta preparar','pagado':'Pagado','entregado':'ENTREGADO','entregado-2':'Entregado 2','complete':'Completado','rehusado-recibido':'Rehusado recibido','rehusado-recibido-rec':'REHUSADO RECIBIDO REC','rehusado-rcn':'REHUSADO RCN','cancel-other':'Cancelado','sin-respuesta-1':'Sin Respuesta 1','sin-respuesta-2':'Sin Respuesta 2','sin-respuesta-3':'Sin Respuesta 3','en-reparto':'EN REPARTO','delegacion-destino':'DELEGACION DESTINO','almacenado':'ALMACEN ESTACIONADO','nuevo-reparto':'NUEVO REPARTO','devuelta-pendiente':'DEVUELTO','transito-1':'TRANSITO','tramo-destino':'TRAMO DESTINO','preparado':'Preparado','reparto-fallido':'REPARTO FALLIDO','reembolsado-parcial':'Reembolsado parcial','reembolsado':'Reembolsado','devolucion':'Devolucion pendiente','reexpedido':'REEXPEDIDO','disponible-en-oficina':'DISPONIBLE EN OFICINA','devuelto-en-oficina':'DEVUELTO EN OFICINA','en-arrastre':'EN ARRASTRE','mal-transitado':'MAL TRANSITADO','depositado-en-oficina':'DEPOSITADO EN OFICINA','pospuesto-1':'Pospuesto','vllamar':'Primera llamada','segunda-llamada':'Segunda llamada','tercera-llamada':'Tercera llamada','sms-whatsapp':'SMS','whatsapp':'WhatsApp','esperando-stock':'Esperando Stock','no-product':'Fuera de stock','no-localizado':'NO LOCALIZADO','recibido-almacen':'Recibido Almacen','grabado':'GRABADO','sin-recepcion':'SIN RECEPCION','tramo-origen':'TRAMO ORIGEN','client-confirmed':'Confirmado cliente'};

function fetchPage(dateFrom, page) {
  return new Promise(function(resolve, reject) {
    var qs = 'apiKey=' + SIMLA_KEY + '&limit=100&page=' + page + '&filter[createdAtFrom]=' + encodeURIComponent(dateFrom);
    https.get(SIMLA_API + '/orders?' + qs, function(r) {
      var d = ''; r.on('data', function(c) { d += c; });
      r.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function getVal(o) { return Math.round((o.totalSumm || 0) * 100) / 100; }

function processOrders(orders) {
  var daily = {};
  orders.forEach(function(o) {
    var day = (o.createdAt || '').slice(0, 10);
    var st = o.status || '?';
    var val = getVal(o);
    var sname = STATUS_NAMES[st] || st;
    if (!daily[day]) daily[day] = {total_n:0,total_v:0,conf_n:0,conf_v:0,cancel_n:0,cancel_v:0,pend_n:0,pend_v:0,deliv_n:0,deliv_v:0,devuel_n:0,devuel_v:0,rehus_n:0,rehus_v:0,transit_n:0,transit_v:0,pend_statuses:{},transit_statuses:{}};
    var d = daily[day];
    d.total_n++; d.total_v += val;
    if (CONFIRMED.has(st)) {
      d.conf_n++; d.conf_v += val;
      if (DELIVERED.has(st)) { d.deliv_n++; d.deliv_v += val; }
      else if (DEVUELTA_PEND.has(st)) { d.devuel_n++; d.devuel_v += val; }
      else if (REHUSADO.has(st)) { d.rehus_n++; d.rehus_v += val; }
      else { d.transit_n++; d.transit_v += val; if(!d.transit_statuses[sname])d.transit_statuses[sname]={n:0,v:0};d.transit_statuses[sname].n++;d.transit_statuses[sname].v+=val; }
    } else if (CANCEL.has(st)) { d.cancel_n++; d.cancel_v += val; }
    else { d.pend_n++; d.pend_v += val; if(!d.pend_statuses[sname])d.pend_statuses[sname]={n:0,v:0};d.pend_statuses[sname].n++;d.pend_statuses[sname].v+=val; }
  });
  Object.values(daily).forEach(function(d) {
    ['total_v','conf_v','cancel_v','pend_v','deliv_v','devuel_v','rehus_v','transit_v'].forEach(function(k){d[k]=Math.round(d[k]*100)/100});
    Object.values(d.pend_statuses||{}).forEach(function(s){s.v=Math.round(s.v*100)/100});
    Object.values(d.transit_statuses||{}).forEach(function(s){s.v=Math.round(s.v*100)/100});
  });
  return daily;
}

module.exports = function(app) {
  // SSE endpoint for progress
  app.get('/api/atc/refresh', function(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    var daysBack = parseInt(req.query.days) || 45;
    var now = new Date();
    var from = new Date(now.getTime() - daysBack * 86400000);
    var dateFrom = from.toISOString().slice(0,10) + ' 00:00:00';
    var shopify = [];

    fetchPage(dateFrom, 1).then(function(firstPage) {
      var totalCount = firstPage.pagination.totalCount;
      var totalPages = Math.ceil(totalCount / 100);
      (firstPage.orders || []).forEach(function(o) { if (o.site === '000-amz') shopify.push(o); });

      res.write('data: ' + JSON.stringify({type:'progress',page:1,totalPages:totalPages,shopify:shopify.length}) + '\n\n');

      var p = 2;
      function nextPage() {
        if (p > totalPages) {
          var daily = processOrders(shopify);
          res.write('data: ' + JSON.stringify({type:'done',daily:daily,orderCount:shopify.length}) + '\n\n');
          res.end();
          return;
        }
        fetchPage(dateFrom, p).then(function(page) {
          (page.orders || []).forEach(function(o) { if (o.site === '000-amz') shopify.push(o); });
          if (p % 5 === 0 || p === totalPages) {
            res.write('data: ' + JSON.stringify({type:'progress',page:p,totalPages:totalPages,shopify:shopify.length}) + '\n\n');
          }
          p++;
          nextPage();
        }).catch(function(err) {
          res.write('data: ' + JSON.stringify({type:'error',message:err.message}) + '\n\n');
          res.end();
        });
      }
      nextPage();
    }).catch(function(err) {
      res.write('data: ' + JSON.stringify({type:'error',message:err.message}) + '\n\n');
      res.end();
    });
  });
};
