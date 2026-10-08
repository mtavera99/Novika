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

// ==========================================================================
// LO QUE QUEDA ESPERANDO A UNA PERSONA
//
// POR QUE EXISTE: el bot decia "le digo a una persona del equipo" y "te
// confirmo en seguida", y NO PASABA NADA. No habia lista, ni aviso, ni
// rastro. La frase sonaba bien y era una promesa vacia: el cliente esperaba
// una respuesta que nadie sabia que debia dar.
//
// Decir que una persona lo revisa sin dejar constancia es peor que decir
// "no lo sé": el cliente deja de preguntar y se queda esperando.
//
// Se guarda el MOTIVO y LA PREGUNTA TAL CUAL la escribio, porque quien lo
// atienda necesita las dos cosas: por que se escalo y que hay que
// contestar. Un "requiere atencion" pelado obliga a leer el chat entero.
//
// Y SE RESUELVE SOLO, con la misma idea que "atendido": no se guarda un
// si/no que alguien tenga que acordarse de borrar -el dia que un camino se
// olvide, la tarea queda colgada para siempre- sino CUANDO se pidio. Esta
// resuelta si una persona escribio o lo marco atendido despues.
// ==========================================================================

/** Motivos por los que algo queda esperando a una persona. */
const MOTIVOS_PENDIENTE = {
  /** Pregunto algo que no esta en el catalogo. */
  SIN_DATO: "sin_dato_en_catalogo",
  /** Quiere otra compra teniendo un pedido ya confirmado. */
  OTRA_COMPRA: "quiere_otra_compra",
  /** Quiere cambiar algo de un pedido confirmado. */
  CAMBIO_DE_PEDIDO: "cambio_de_pedido",
  /** El bot no supo y lo dijo. */
  NO_SUPO: "el_bot_no_supo",
};

/**
 * Anota que algo quedo esperando a una persona. Funcion PURA: modifica el
 * objeto y no guarda. Quien guarda es el que tiene el repositorio.
 *
 * No sobreescribe una pendiente sin resolver: la PRIMERA pregunta sin
 * contestar es la que importa, y pisarla con la ultima perderia justo la
 * que lleva mas tiempo esperando.
 */
function anotarPendiente(conversacion, { motivo, pregunta = "", ahora = Date.now() } = {}) {
  if (!conversacion || !motivo) return conversacion;
  const actual = pendienteDe(conversacion);
  if (actual.hay) return conversacion;
  conversacion.pendiente = {
    motivo,
    pregunta: String(pregunta || "").slice(0, 500),
    desde: new Date(ahora).toISOString(),
  };
  return conversacion;
}

/**
 * ¿Hay algo esperando a una persona?
 *
 * @returns {{hay: boolean, motivo: string|null, pregunta: string, desde: string|null}}
 */
function pendienteDe(conversacion) {
  const p = (conversacion && conversacion.pendiente) || null;
  const vacio = { hay: false, motivo: null, pregunta: "", desde: null };
  if (!p || !p.motivo || !p.desde) return vacio;

  const desde = new Date(p.desde).getTime();
  if (!Number.isFinite(desde)) return vacio;

  // Resuelta si una persona la atendio DESPUES de que se pidiera.
  const a = leer(conversacion);
  if (a.atendidoEn && new Date(a.atendidoEn).getTime() >= desde) return vacio;

  // O si un operador escribio en el chat despues.
  const hablo = mensajes(conversacion).some(
    (m) => m && m.de === QUIEN.OPERADOR && m.ts && new Date(m.ts).getTime() >= desde
  );
  if (hablo) return vacio;

  return { hay: true, motivo: p.motivo, pregunta: p.pregunta || "", desde: p.desde };
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
// --------------------------------------------------------------------------
// LA PAUSA CADUCA
//
// POR QUE: Marco encontro mensajes sin responder y tuvo que contestarlos a
// mano. Una de las causas era este circulo vicioso:
//
//   1. responde a mano desde el panel
//   2. el bot se pausa en ese chat -correcto: dos voces a la vez es peor-
//   3. la pausa NO se levantaba nunca
//   4. ese chat quedaba sin bot para siempre
//
// El paso 4 no lo sabia nadie. Y se acumula: cada chat atendido a mano es un
// chat que el bot ya no vuelve a atender, aunque se arregle todo lo demas.
//
// La pausa existe para que no hablen los dos A LA VEZ. Pasadas unas horas
// sin que la persona escriba, ya no hay simultaneidad que proteger: lo que
// hay es un cliente esperando.
//
// NO se levanta por tiempo si la persona sigue escribiendo: cada mensaje
// suyo renueva la pausa, porque `desde` se actualiza al tomar el control.
//
// 12 horas por defecto, configurable. Es prudente a proposito: cubre una
// noche entera, asi que un chat tomado a las 11 de la noche sigue siendo del
// operador a la mañana siguiente.
// --------------------------------------------------------------------------
const HORAS_DE_PAUSA = Number(process.env.HORAS_DE_PAUSA || 12);

/** ¿La pausa de esta conversacion ya caduco? */
function pausaCaducada(conv, { ahora = Date.now(), horas = HORAS_DE_PAUSA } = {}) {
  const a = leer(conv);
  if (!a.pausado) return false;
  // Sin fecha no se puede medir, y en la duda NO se levanta: callarse de
  // mas es recuperable, pisarle la conversacion a quien atiende no.
  if (!a.desde) return false;
  const desde = new Date(a.desde).getTime();
  if (!Number.isFinite(desde)) return false;
  return ahora - desde >= horas * 3600000;
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
async function estaPausada(repos, contactoId, { ahora = Date.now() } = {}) {
  if (!repos || !contactoId) return false;
  try {
    const conv = await repos.conversaciones.obtener(contactoId);
    if (!conv) return false;
    if (leer(conv).pausado !== true) return false;

    // Caducada: el bot retoma. Se LEVANTA la pausa en el almacen, no solo
    // se ignora, para que el panel deje de mostrar el chat como tomado y
    // para que quede constancia de cuando volvio el bot.
    if (pausaCaducada(conv, { ahora })) {
      conv.atencion = { ...leer(conv), pausado: false, por: null, desde: null, caducoEn: new Date(ahora).toISOString() };
      await repos.conversaciones.guardar(conv);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

module.exports = {
  QUIEN,
  MAX_MENSAJES,
  MOTIVOS_PENDIENTE,
  anotarPendiente,
  pendienteDe,
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
  pausaCaducada,
  HORAS_DE_PAUSA,
};
