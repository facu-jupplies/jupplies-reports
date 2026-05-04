/**
 * Lógica EXACTA de clasificación de estados Simla (validada contra exports reales).
 * Fuente: Simla_Logica_Estados.docx (JUPPLIES).
 *
 * Categorías:
 *   - CONFIRMED: pedidos aprobados que se envían (incluye en tránsito y entregados)
 *   - DELIVERED: efectivamente entregados (lo que Simla muestra como "entregados")
 *   - DEVUELTA_PENDIENTE: devolución física sin procesar (NO cuenta como entregado)
 *   - REHUSADO: cliente rechazó en reparto
 *   - CANCEL: cancelados (Simla pone totalSumm=0)
 *   - PENDING: implícito (no CONFIRMED y no CANCEL → en proceso de llamada/WhatsApp)
 *
 * Funnel: TOTAL = DELIVERED + REHUSADO + DEVUELTA_PEND + TRANSIT + CANCEL + PENDING
 * Donde TRANSIT = CONFIRMED \ (DELIVERED ∪ REHUSADO ∪ DEVUELTA_PEND)
 */

const CONFIRMED = new Set([
  'upsell','falta-preparar','falta-preparar-pagados','pagado',
  'grabado','grabado-snt-v',
  'sin-recepcion','sin-recepcion-snt-v','sin-recepcion-amz',
  'sin-recepcion-amz-snt-v','sin-recepcion-miravia',
  'sin-recepcion-miravia-snt-v',
  'delegacion-destino','en-reparto','almacenado','devuelta-pendiente',
  'no-localizado','entregado-de-rcn','en-arrastre','tramo-origen',
  'transito','transito-1','mal-transitado','tramo-destino',
  'reparto-fallido','nuevo-reparto','entregado','reexpedido',
  'alm-regulador','destruido','destruido-1','transferido-proveedor',
  'anulado','proveedor','entregado-en-punto-concertado',
  'recepcionado-en-oficina','paralizado','depositado-en-oficina',
  'disponible-en-oficina','devuelto-en-oficina',
  'rehusado-rcn','rehusado-recibido','rehusado-erroneos',
  'rehusado-recibido-rec','rehusado-destruccion',
  'complete','marketplace-sin-descontar','marketplace',
  'seguro-lott-correos','recanalizacion','amazon','miravia-preparado',
  'recibido-almacen','reposicion','devolucion','reembolso-recibido-alm',
  'reembolsado','reembolsado-parcial','reembolso-resenas','preparado',
  'send-to-delivery','delivering','entregado-2','assembling',
  'send-to-assembling','assembling-complete','redirect',
  'cerrado-definitivamente','con-incidencia','devuelta',
  'fallo-al-sacar-etiqueta','2-send-to-assembling','bot',
  'rehusados-contabilizados',
]);

// DELIVERED_NET: pedidos efectivamente cobrados (la plata está en tu banco).
// Para tarjeta = cobro automático en checkout; para COD = cash depositado tras entrega.
const DELIVERED_NET = new Set([
  'complete','entregado','entregado-2','pagado',
]);

// REFUNDED: pedidos que entraron pero el dinero volvió al cliente.
// Simla los considera "entregados" para el funnel UI, pero financieramente
// son cobro 0 (con costos: producto sale y vuelve, doble shipping).
const REFUNDED = new Set([
  'reembolsado','reembolsado-parcial','devolucion',
  'reembolso-recibido-alm','reembolso-resenas','reposicion',
  'recibido-almacen',
]);

// DELIVERED (Simla UI): unión de los anteriores. Coincide con la métrica
// "entregados" del CRM. Para revenue real usar DELIVERED_NET.
const DELIVERED = new Set([...DELIVERED_NET, ...REFUNDED]);

const DEVUELTA_PENDIENTE = new Set([
  'devuelta-pendiente','devuelto-en-oficina',
]);

const REHUSADO = new Set([
  'rehusado-rcn','rehusado-recibido','rehusado-erroneos',
  'rehusado-recibido-rec','rehusado-destruccion','rehusados-contabilizados',
]);

const CANCEL = new Set([
  'cancel-other','no-call','prices-did-not-suit','already-buyed',
  'delyvery-did-not-suit','otros','no-product',
  'sin-respuesta-1','sin-respuesta-2','sin-respuesta-3',
  'sin-respuesta-4','sin-respuesta-5','sin-respuesta-final',
  // Decisión JUPPLIES: tratar como cancelados también
  'islas-canarias-ceuta-melilla','error-de-descontar-el-stock',
]);

/**
 * Clasifica un estado en una categoría exclusiva del funnel financiero.
 * 'delivered_paid' y 'refunded' son los dos sub-estados de DELIVERED:
 *   - delivered_paid: cobro real, la plata está en tu banco
 *   - refunded: ya devolviste el dinero (cobro neto = 0)
 * Sumados dan la métrica "entregados" que muestra Simla en su UI.
 * @returns {'delivered_paid'|'refunded'|'rehusado'|'devuelta_pend'|'transit'|'cancel'|'pending'}
 */
function classify(status) {
  const s = String(status || '').toLowerCase();
  if (DELIVERED_NET.has(s))      return 'delivered_paid';
  if (REFUNDED.has(s))           return 'refunded';
  if (REHUSADO.has(s))           return 'rehusado';
  if (DEVUELTA_PENDIENTE.has(s)) return 'devuelta_pend';
  if (CANCEL.has(s))             return 'cancel';
  if (CONFIRMED.has(s))          return 'transit';
  return 'pending';
}

/**
 * Valor del pedido respetando la lógica de cancelados Simla:
 * - totalSumm > 0 → ese valor (Simla es la verdad para pedidos no cancelados)
 * - cancelados (totalSumm = 0) → reconstruir desde items.initialPrice * quantity
 *   (para mostrar "facturación bruta original" antes del cancel)
 */
function getVal(order) {
  const ts = order.totalSumm || 0;
  if (ts > 0) return Math.round(ts * 100) / 100;
  const status = String(order.status || '').toLowerCase();
  if (CANCEL.has(status)) {
    const original = (order.items || []).reduce(
      (s, it) => s + (it.initialPrice || 0) * (it.quantity || 1), 0,
    );
    return Math.round(original * 100) / 100;
  }
  return 0;
}

module.exports = {
  CONFIRMED, DELIVERED, DELIVERED_NET, REFUNDED,
  DEVUELTA_PENDIENTE, REHUSADO, CANCEL,
  classify, getVal,
};
