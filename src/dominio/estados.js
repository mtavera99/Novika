"use strict";

// ==========================================================================
// MAQUINA DE ESTADOS DE LA CONVERSACION
//
// Modulo puro. Sin I/O.
//
// Los estados son EXPLICITOS y se guardan. No se infieren leyendo los
// mensajes con expresiones regulares.
//
// Esa diferencia no es de estilo. En BIKERPRO las etapas se deducian del
// texto, y un detector demasiado laxo -buscaba cualquier cifra con formato
// de precio- marco como "cotizado" el 97,1% de las conversaciones cuando la
// realidad era 54,2%. Durante semanas eso escondio la segunda fuga de
// ingresos mas grande del negocio. Un estado inferido mal no da error: da un
// numero tranquilizador y falso.
//
// CONFIRMADO es el estado que mas importa. Es TRANSACCIONAL: una vez dentro,
// un "si", "ok", "gracias" o "listo" no puede volver a cotizar ni crear otro
// pedido. Solo salen de ahi transiciones explicitas y nombradas
// (modificacion, cancelacion, posventa).
// ==========================================================================

const ESTADOS = {
  NUEVO: "nuevo",                            // primer contacto, nada aun
  EXPLORANDO: "explorando",                  // conversa; producto puede ser desconocido
  PRODUCTO_IDENTIFICADO: "producto_identificado",
  INTERESADO: "interesado",                  // hay señal de compra
  COTIZADO: "cotizado",                      // hay cotizacion calculada y mostrada
  CAPTURANDO_DATOS: "capturando_datos",      // faltan datos del destinatario
  PENDIENTE_CONFIRMACION: "pendiente_confirmacion", // resumen mostrado, esperando si/no
  CONFIRMADO: "confirmado",                  // TRANSACCIONAL: existe un pedido
  MODIFICANDO: "modificando",                // pidio cambiar algo de un pedido confirmado
  CANCELADO: "cancelado",
  POSVENTA: "posventa",                      // pregunta por un pedido ya hecho
  ESCALADO: "escalado",                      // lo atiende una persona
};

/**
 * EL CAMINO DE LA VENTA: estados previos a que exista un pedido.
 *
 * Dentro de este camino se puede ir a cualquier parte, adelante y atras, y
 * eso es deliberado:
 *
 *   ADELANTE a saltos, porque un cliente real dice todo de golpe:
 *   "quiero el cinturon, soy Ana, Medellin, Calle 45 # 23-10". Eso cubre
 *   producto, datos y cotizacion en un mensaje. Una maquina que obligue a
 *   pasar por cada escalon tendria que inventarse turnos intermedios, y el
 *   primer intento de esto hacia justo eso: rechazaba la transicion, dejaba
 *   la conversacion en "nuevo" y el resumen nunca llegaba.
 *
 *   ATRAS, porque "mejor que sean dos" obliga a recotizar, y eso es volver
 *   de PENDIENTE_CONFIRMACION a COTIZADO. Es legitimo mientras no haya
 *   pedido.
 *
 * Lo que NO es libre es salir de aqui: a CONFIRMADO solo se llega desde
 * PENDIENTE_CONFIRMACION, y volver atras desde CONFIRMADO no se puede.
 */
const CAMINO_DE_VENTA = [
  ESTADOS.NUEVO,
  ESTADOS.EXPLORANDO,
  ESTADOS.PRODUCTO_IDENTIFICADO,
  ESTADOS.INTERESADO,
  ESTADOS.COTIZADO,
  ESTADOS.CAPTURANDO_DATOS,
  ESTADOS.PENDIENTE_CONFIRMACION,
];

/** Desde cualquier sitio se puede cancelar o escalar a una persona. */
const SALIDAS_SIEMPRE = [ESTADOS.CANCELADO, ESTADOS.ESCALADO];

function construirTransiciones() {
  const t = {};

  for (const estado of CAMINO_DE_VENTA) {
    t[estado] = [...CAMINO_DE_VENTA, ...SALIDAS_SIEMPRE];
  }

  // A CONFIRMADO solo se llega respondiendo a un resumen. Ni desde
  // EXPLORANDO, ni desde COTIZADO: sin resumen mostrado no hay nada que
  // confirmar, y un pedido que el cliente no vio es un pedido mal guardado.
  t[ESTADOS.PENDIENTE_CONFIRMACION] = [...t[ESTADOS.PENDIENTE_CONFIRMACION], ESTADOS.CONFIRMADO];

  // --- CONFIRMADO: salidas explicitas unicamente ---
  // NO hay transicion a COTIZADO ni a CAPTURANDO_DATOS. Un pedido confirmado
  // no se recotiza por un mensaje suelto; se pasa por MODIFICANDO, que es un
  // estado con nombre y deja rastro en el historial del pedido.
  t[ESTADOS.CONFIRMADO] = [ESTADOS.CONFIRMADO, ESTADOS.MODIFICANDO, ESTADOS.POSVENTA, ...SALIDAS_SIEMPRE];

  t[ESTADOS.MODIFICANDO] = [ESTADOS.MODIFICANDO, ESTADOS.CONFIRMADO, ESTADOS.POSVENTA, ...SALIDAS_SIEMPRE];
  t[ESTADOS.POSVENTA] = [ESTADOS.POSVENTA, ESTADOS.CONFIRMADO, ESTADOS.MODIFICANDO, ...SALIDAS_SIEMPRE];

  // Tras cancelar se puede volver a vender: el cliente que se arrepiente de
  // cancelar no puede quedarse sin poder comprar.
  t[ESTADOS.CANCELADO] = [ESTADOS.CANCELADO, ...CAMINO_DE_VENTA, ESTADOS.ESCALADO];

  // ESCALADO es absorbente mientras una persona este dentro. Que el bot
  // retome por su cuenta seria pisarle la conversacion a quien atiende.
  t[ESTADOS.ESCALADO] = [ESTADOS.ESCALADO];

  // Se congelan para que nadie las modifique en caliente.
  for (const k of Object.keys(t)) t[k] = Object.freeze([...new Set(t[k])]);
  return Object.freeze(t);
}

const TRANSICIONES = construirTransiciones();

/** Estados en los que existe un pedido vivo. */
const ESTADOS_CON_PEDIDO = new Set([ESTADOS.CONFIRMADO, ESTADOS.MODIFICANDO, ESTADOS.POSVENTA]);

/** Estados en los que un mensaje NO puede disparar una cotizacion nueva. */
const ESTADOS_BLINDADOS = new Set([ESTADOS.CONFIRMADO, ESTADOS.MODIFICANDO, ESTADOS.POSVENTA, ESTADOS.ESCALADO]);

function esEstado(valor) {
  return Object.values(ESTADOS).includes(valor);
}

function puedeTransicionar(desde, hacia) {
  if (!esEstado(desde) || !esEstado(hacia)) return false;
  return (TRANSICIONES[desde] || []).includes(hacia);
}

/**
 * Aplica una transicion.
 *
 * Devuelve el resultado en vez de lanzar: una transicion invalida es un
 * fallo de logica que hay que registrar y escalar, no una excepcion que
 * tumbe el procesamiento del mensaje de un cliente.
 *
 * @returns {{ok: boolean, estado: string, motivo?: string}}
 */
function transicionar(desde, hacia, porQue = "") {
  if (!esEstado(hacia)) {
    return { ok: false, estado: desde, motivo: `"${hacia}" no es un estado conocido` };
  }
  if (!esEstado(desde)) {
    return { ok: false, estado: ESTADOS.NUEVO, motivo: `"${desde}" no es un estado conocido` };
  }
  if (!puedeTransicionar(desde, hacia)) {
    return {
      ok: false,
      estado: desde, // se queda donde estaba: nunca se avanza "por si acaso"
      motivo: `no se permite ${desde} -> ${hacia}${porQue ? ` (${porQue})` : ""}`,
    };
  }
  return { ok: true, estado: hacia };
}

/** ¿Hay un pedido vivo en este estado? */
function tienePedido(estado) {
  return ESTADOS_CON_PEDIDO.has(estado);
}

/**
 * ¿Esta blindado contra cotizar de nuevo?
 *
 * Es la respuesta en codigo a "un 'si' no puede volver a cotizar un pedido
 * confirmado". No depende de detectar bien la palabra: depende del estado.
 */
function estaBlindado(estado) {
  return ESTADOS_BLINDADOS.has(estado);
}

module.exports = {
  ESTADOS,
  TRANSICIONES,
  CAMINO_DE_VENTA,
  esEstado,
  puedeTransicionar,
  transicionar,
  tienePedido,
  estaBlindado,
};
