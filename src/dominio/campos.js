"use strict";

// ==========================================================================
// DATOS CANDIDATOS vs DATOS CONFIRMADOS
//
// Modulo puro. Sin I/O.
//
// La IA propone. El codigo confirma. Esa frontera tiene que existir en la
// ESTRUCTURA DE DATOS, no solo en la intencion de quien programa: si el
// valor que propuso el modelo y el valor verificado viven en el mismo campo,
// tarde o temprano alguien lee el primero creyendo que es el segundo.
//
// Aqui cada dato es un objeto con estado explicito:
//
//   vacio      -> nadie ha dicho nada
//   candidato  -> alguien lo propuso (cliente, IA, referral) y NO esta validado
//   confirmado -> paso una validacion determinista
//
// Y la pieza clave: valorConfirmado() devuelve null si el dato no esta
// confirmado. No devuelve el candidato "por si sirve". Quien necesita un
// hecho recibe null y tiene que decidir que hacer con esa ausencia, que es
// exactamente lo que queremos que pase.
//
// Tambien existe el estado "rechazado": un candidato que fallo la
// validacion. Se conserva con el motivo, porque "el cliente dijo algo que no
// supimos validar" es informacion util para una persona; borrarlo convierte
// un dato problematico en un dato ausente.
// ==========================================================================

const ESTADO_CAMPO = {
  VACIO: "vacio",
  CANDIDATO: "candidato",
  CONFIRMADO: "confirmado",
  RECHAZADO: "rechazado",
};

const ORIGENES = {
  CLIENTE: "cliente",   // lo escribio el cliente y lo extrajo una heuristica
  IA: "ia",             // lo propuso el modelo
  REFERRAL: "referral", // vino del anuncio de Meta
  CODIGO: "codigo",     // lo calculo o derivo el sistema
  PERSONA: "persona",   // lo puso un humano desde el panel
};

/** Campos que componen un pedido. Lista cerrada. */
const CAMPOS = [
  "nombre",
  "telefono",
  "documento",
  "ciudad",
  "departamento",
  "direccion",
  "referencia",
  "productoId",
  "variante",
  "cantidad",
];

function campoVacio() {
  return { valor: null, estado: ESTADO_CAMPO.VACIO, origen: null, motivo: null, historial: [] };
}

/** Ficha nueva: todos los campos vacios y explicitos. */
function fichaVacia() {
  const ficha = {};
  for (const nombre of CAMPOS) ficha[nombre] = campoVacio();
  return ficha;
}

function anotar(campo, entrada) {
  const historial = [...(campo.historial || []), entrada];
  // El historial se acota: es trazabilidad, no un registro contable. El
  // registro contable es el diario.
  return historial.slice(-10);
}

/**
 * Propone un valor. NO lo confirma.
 *
 * Este es el unico camino por el que entra algo que dijo la IA.
 */
function proponer(campo, valor, origen, cuando = new Date().toISOString()) {
  const previo = campo || campoVacio();

  // Un candidato nunca pisa un dato ya confirmado. Si el cliente quiere
  // cambiar algo confirmado, eso es una modificacion explicita y pasa por
  // reabrir(), no por una propuesta silenciosa del modelo.
  if (previo.estado === ESTADO_CAMPO.CONFIRMADO) {
    return {
      ...previo,
      historial: anotar(previo, { accion: "propuesta_ignorada", valor, origen, cuando, porQue: "ya estaba confirmado" }),
    };
  }

  if (valor === null || valor === undefined || valor === "") {
    return previo;
  }

  return {
    valor,
    estado: ESTADO_CAMPO.CANDIDATO,
    origen,
    motivo: null,
    historial: anotar(previo, { accion: "propuesto", valor, origen, cuando }),
  };
}

/**
 * Confirma un candidato tras validarlo.
 *
 * @param {object} campo
 * @param {(valor:any) => {ok: boolean, valor?: any, motivo?: string}} validar
 */
function confirmar(campo, validar, cuando = new Date().toISOString()) {
  const previo = campo || campoVacio();
  if (previo.estado === ESTADO_CAMPO.CONFIRMADO) return previo;
  if (previo.estado === ESTADO_CAMPO.VACIO) return previo;

  const r = validar(previo.valor);
  if (!r || !r.ok) {
    return {
      ...previo,
      estado: ESTADO_CAMPO.RECHAZADO,
      motivo: (r && r.motivo) || "no paso la validacion",
      historial: anotar(previo, { accion: "rechazado", valor: previo.valor, motivo: r && r.motivo, cuando }),
    };
  }

  // La validacion puede normalizar: "bogota" -> "Bogota D.C.". Se guarda el
  // valor normalizado, que es el que se usa para despachar.
  const valorFinal = r.valor !== undefined ? r.valor : previo.valor;
  return {
    valor: valorFinal,
    estado: ESTADO_CAMPO.CONFIRMADO,
    origen: previo.origen,
    motivo: null,
    historial: anotar(previo, { accion: "confirmado", valor: valorFinal, cuando }),
  };
}

/**
 * Reabre un campo confirmado para poder modificarlo. Explicito a proposito:
 * sin esto, cambiar un dato confirmado seria imposible; con esto, requiere
 * decirlo y queda en el historial.
 */
function reabrir(campo, porQue, cuando = new Date().toISOString()) {
  const previo = campo || campoVacio();
  return {
    ...previo,
    estado: previo.valor === null ? ESTADO_CAMPO.VACIO : ESTADO_CAMPO.CANDIDATO,
    historial: anotar(previo, { accion: "reabierto", porQue, cuando }),
  };
}

/** El valor SOLO si esta confirmado. Si no, null. Sin excepciones. */
function valorConfirmado(campo) {
  return campo && campo.estado === ESTADO_CAMPO.CONFIRMADO ? campo.valor : null;
}

/** El candidato sin confirmar, para poder preguntarle al cliente. */
function valorCandidato(campo) {
  return campo && campo.estado === ESTADO_CAMPO.CANDIDATO ? campo.valor : null;
}

function estaConfirmado(campo) {
  return Boolean(campo && campo.estado === ESTADO_CAMPO.CONFIRMADO);
}

/**
 * De los campos requeridos, cuales NO estan confirmados.
 *
 * Devuelve nombres, no booleanos, para que el mensaje al cliente pueda decir
 * exactamente que falta en vez de un "faltan datos" generico.
 */
function faltantes(ficha, requeridos) {
  return (requeridos || []).filter((nombre) => !estaConfirmado(ficha && ficha[nombre]));
}

/** Los campos rechazados con su motivo. Para que una persona los revise. */
function rechazados(ficha) {
  return Object.entries(ficha || {})
    .filter(([, campo]) => campo && campo.estado === ESTADO_CAMPO.RECHAZADO)
    .map(([nombre, campo]) => ({ campo: nombre, valor: campo.valor, motivo: campo.motivo }));
}

/** Instantanea plana de solo lo confirmado. Es lo que se despacha. */
function soloConfirmado(ficha) {
  const salida = {};
  for (const [nombre, campo] of Object.entries(ficha || {})) {
    const v = valorConfirmado(campo);
    if (v !== null) salida[nombre] = v;
  }
  return salida;
}

module.exports = {
  ESTADO_CAMPO,
  ORIGENES,
  CAMPOS,
  campoVacio,
  fichaVacia,
  proponer,
  confirmar,
  reabrir,
  valorConfirmado,
  valorCandidato,
  estaConfirmado,
  faltantes,
  rechazados,
  soloConfirmado,
};
