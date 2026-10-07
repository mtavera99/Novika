"use strict";

// ==========================================================================
// ATENCION HUMANA DE UNA CONVERSACION
//
// Quien manda en un chat: el bot o una persona. Y el historial que el panel
// necesita para mostrar la conversacion.
//
// --------------------------------------------------------------------------
// POR QUE SE PERSISTE Y NO VIVE EN MEMORIA
// --------------------------------------------------------------------------
//
// En Render un disco persistente DESACTIVA los despliegues sin
// interrupcion: cada despliegue reinicia el proceso. Si la pausa viviera en
// memoria, el bot volveria a contestar un chat que una persona habia tomado
// -y el cliente recibiria dos voces- sin que nadie toque un boton. Vive en
// los repositorios, con los pedidos y las conversaciones.
//
// --------------------------------------------------------------------------
// "ATENDIDO" NO SE GUARDA COMO UN SI/NO
// --------------------------------------------------------------------------
//
// BIKERPRO guardaba la marca y la borraba cuando el cliente volvia a
// escribir. Funciona, pero depende de acordarse de borrarla en cada camino
// que reciba un mensaje, y el dia que un camino nuevo se olvide, el chat
// queda silenciado para siempre: una venta perdida sin error.
//
// Aqui se guarda CUANDO se atendio, y "esta atendido" se CALCULA: lo esta
// si se atendio despues del ultimo mensaje del cliente. Si el cliente
// vuelve a escribir, reaparece solo, sin que nadie tenga que borrar nada.
// ==========================================================================

/** Cuantos mensajes se conservan por conversacion. */
const MAX_MENSAJES = 60;

const QUIEN = {
  CLIENTE: "cliente",
  BOT: "bot",
  OPERADOR: "operador",
};

/** Estado de atencion normalizado. Nunca devuelve undefined. */
function leer(conversacion) {
  const a = (conversacion && conversacion.atencion) || {};
  return {
    pausado: a.pausado === true,
    por: a.por || null,
    desde: a.desde || null,
    atendidoEn: a.atendidoEn || null,
    atendidoPor: a.atendidoPor || null,
  };
}

/** Mensajes normalizados, en orden. */
function mensajes(conversacion) {
  const m = (conversacion && conversacion.mensajes) || [];
  return Array.isArray(m) ? m : [];
}

/** El ultimo mensaje del cliente, o null. */
function ultimoDelCliente(conversacion) {
  const lista = mensajes(conversacion).filter((m) => m.de === QUIEN.CLIENTE);
  return lista.length ? lista[lista.length - 1] : null;
}

/**
 * ¿Esta atendido? Calculado, no guardado.
 *
 * Lo esta si se marco DESPUES del ultimo mensaje del cliente. Asi un
 * cliente que vuelve a escribir reaparece en la lista automaticamente.
 */
function estaAtendido(conversacion) {
  const { atendidoEn } = leer(conversacion);
  if (!atendidoEn) return false;
  const ultimo = ultimoDelCliente(conversacion);
  if (!ultimo || !ultimo.ts) return true;
  return Date.parse(atendidoEn) >= Date.parse(ultimo.ts);
}

/** Anade un mensaje al historial, recortando por el final. */
function anotarMensaje(conversacion, { de, texto, wamid = null, por = null, estado = null, ts = null }) {
  const lista = mensajes(conversacion);
  lista.push({
    de,
    texto: String(texto || ""),
    wamid: wamid || null,
    // `por` distingue al operador que escribio. `estado` guarda el resultado
    // REAL del envio: aceptado, bloqueado o fallido. Sin el, el panel
    // mostraria como dicho algo que nunca salio.
    por: por || null,
    estado: estado || null,
    ts: ts || new Date().toISOString(),
  });
  conversacion.mensajes = lista.slice(-MAX_MENSAJES);
  return conversacion;
}

/**
 * Toma el control: el bot se calla en este chat.
 *
 * Devuelve la conversacion guardada. Si no existe, no la inventa: tomar el
 * control de un chat que no existe no significa nada.
 */
async function tomarControl(repos, contactoId, { por = "operador" } = {}) {
  const conv = await repos.conversaciones.obtener(contactoId);
  if (!conv) return null;
  conv.atencion = {
    ...leer(conv),
    pausado: true,
    por,
    desde: new Date().toISOString(),
  };
  await repos.conversaciones.guardar(conv);
  return conv;
}

/** Devuelve el chat al bot. */
async function devolverAlBot(repos, contactoId) {
  const conv = await repos.conversaciones.obtener(contactoId);
  if (!conv) return null;
  conv.atencion = { ...leer(conv), pausado: false, por: null, desde: null };
  await repos.conversaciones.guardar(conv);
  return conv;
}

/** "Esto ya lo resolvi". Guarda la hora, no un si/no. */
async function marcarAtendido(repos, contactoId, { por = "operador" } = {}) {
  const conv = await repos.conversaciones.obtener(contactoId);
  if (!conv) return null;
  conv.atencion = {
    ...leer(conv),
    atendidoEn: new Date().toISOString(),
    atendidoPor: por,
  };
  await repos.conversaciones.guardar(conv);
  return conv;
}

/** Deshacer el "ya lo resolvi". */
async function desmarcarAtendido(repos, contactoId) {
  const conv = await repos.conversaciones.obtener(contactoId);
  if (!conv) return null;
  conv.atencion = { ...leer(conv), atendidoEn: null, atendidoPor: null };
  await repos.conversaciones.guardar(conv);
  return conv;
}

/**
 * ¿Esta pausada esta conversacion?
 *
 * Se LEE del almacen en cada llamada, sin cache. Es lo que cierra la
 * carrera con el proveedor de IA: el emisor pregunta esto justo antes de
 * enviar, cuando la IA ya respondio. Un valor cacheado al empezar el turno
 * no habria visto que el operador tomo el control mientras el modelo
 * pensaba, que es exactamente el defecto que tiene BIKERPRO.
 *
 * Ante un error de lectura devuelve TRUE -no enviar-: callarse de mas es
 * recuperable, escribirle a un cliente que ya esta hablando con una persona
 * no lo es.
 */
async function estaPausada(repos, contactoId) {
  if (!repos || !contactoId) return false;
  try {
    const conv = await repos.conversaciones.obtener(contactoId);
    if (!conv) return false;
    return leer(conv).pausado === true;
  } catch {
    return true;
  }
}

module.exports = {
  QUIEN,
  MAX_MENSAJES,
  leer,
  mensajes,
  ultimoDelCliente,
  estaAtendido,
  anotarMensaje,
  tomarControl,
  devolverAlBot,
  marcarAtendido,
  desmarcarAtendido,
  estaPausada,
};
