"use strict";

// ==========================================================================
// LEER LA FICHA DE UN CLIENTE PARA MOSTRARLA
//
// --------------------------------------------------------------------------
// EL DEFECTO QUE ARREGLA
// --------------------------------------------------------------------------
//
// El panel mostraba "[object Object]" donde iba el nombre del cliente.
// Visto desde el celular: el titulo del chat, la tarjeta del cliente y la
// ciudad, todos con esa cadena.
//
// La causa: supuse que `ficha.nombre` era texto. No lo es. Cada campo de la
// ficha es un objeto con estado explicito, y eso es deliberado
// (src/dominio/campos.js):
//
//   { valor, estado, origen, cuando, ... }
//
//   vacio      -> nadie ha dicho nada
//   candidato  -> alguien lo propuso -cliente, IA, anuncio- y NO esta validado
//   confirmado -> paso una validacion determinista
//   rechazado  -> se propuso y fallo la validacion
//
// --------------------------------------------------------------------------
// POR QUE NO BASTA CON PONER `.valor`
// --------------------------------------------------------------------------
//
// Esa habria sido la correccion de una linea, y habria sido peor que el
// error visible. "[object Object]" molesta pero no engana a nadie. Mostrar
// el `.valor` de un campo CANDIDATO como si fuera el nombre del cliente si
// engana: el panel diria "Ana Perez" con la misma tipografia para un dato
// que el modelo propuso y nadie valido.
//
// Y ese es justo el limite que el dominio existe para marcar: "La IA
// propone. El codigo confirma. Esa frontera tiene que existir en la
// ESTRUCTURA DE DATOS, no solo en la intencion de quien programa". Un panel
// que la borra al pintar la deshace entera, porque es donde una persona
// decide.
//
// Asi que aqui se devuelve el valor Y su estado, y la vista marca lo que no
// esta confirmado. Un operador que ve "Ana Perez (sin confirmar)" sabe que
// tiene que preguntar antes de despachar.
// ==========================================================================

const campos = require("../dominio/campos");

/** Qué se muestra cuando no hay nada. */
const SIN_DATO = "—";

/**
 * Lee un campo de la ficha.
 *
 * Tolera las dos formas a proposito: el objeto con estado -lo normal- y
 * texto plano. El texto plano aparece en los contactos que crea la venta
 * manual y en datos de antes de que la ficha tuviera estados; tratarlo como
 * un fallo dejaria esas pantallas vacias sin motivo. Un texto plano se
 * considera confirmado, porque lo escribio una persona.
 */
function leer(ficha, nombre) {
  const campo = ficha && ficha[nombre];

  if (campo === null || campo === undefined || campo === "") {
    return { valor: null, texto: SIN_DATO, estado: campos.ESTADO_CAMPO.VACIO, confirmado: false, hay: false };
  }

  // Texto (o numero) plano.
  if (typeof campo !== "object") {
    const texto = String(campo).trim();
    if (!texto) {
      return { valor: null, texto: SIN_DATO, estado: campos.ESTADO_CAMPO.VACIO, confirmado: false, hay: false };
    }
    return {
      valor: texto,
      texto,
      estado: campos.ESTADO_CAMPO.CONFIRMADO,
      confirmado: true,
      hay: true,
      origen: campos.ORIGENES.PERSONA,
    };
  }

  const estado = campo.estado || campos.ESTADO_CAMPO.VACIO;
  const bruto = campo.valor;
  // `valor` puede ser un numero (cantidad) o venir anidado por error. Si no
  // es un primitivo, NO se interpola: eso es lo que produjo
  // "[object Object]". Se dice que no se entiende.
  const esPrimitivo = bruto !== null && bruto !== undefined && typeof bruto !== "object";
  const valor = esPrimitivo ? String(bruto).trim() : null;

  if (!valor) {
    return {
      valor: null,
      texto: SIN_DATO,
      estado,
      confirmado: false,
      hay: false,
      origen: campo.origen || null,
      porQue: campo.porQue || null,
    };
  }

  return {
    valor,
    texto: valor,
    estado,
    confirmado: estado === campos.ESTADO_CAMPO.CONFIRMADO,
    hay: true,
    origen: campo.origen || null,
    porQue: campo.porQue || null,
  };
}

/** Solo el texto. Para cuando no hay sitio para marcar el estado. */
function texto(ficha, nombre) {
  return leer(ficha, nombre).texto;
}

/**
 * El valor solo si esta CONFIRMADO. null si no.
 *
 * Para lo que no puede equivocarse: a quien se le escribe, a donde se
 * despacha. Es el mismo criterio que usa el dominio.
 */
function confirmado(ficha, nombre) {
  const c = leer(ficha, nombre);
  return c.confirmado ? c.valor : null;
}

/**
 * Nombre para mostrar, con su estado.
 *
 * Nunca devuelve una cadena vacia: una fila sin nombre no se puede pulsar
 * ni leer, y "(sin nombre)" al menos dice que el dato falta.
 */
function nombreParaMostrar(ficha) {
  const n = leer(ficha, "nombre");
  return { texto: n.hay ? n.valor : "(sin nombre)", confirmado: n.confirmado, hay: n.hay };
}

/**
 * Los campos que hacen falta para despachar, con su estado.
 *
 * Es lo que el operador necesita ver de un vistazo: que le falta a este
 * cliente para que su pedido pueda salir.
 */
function paraDespachar(ficha) {
  return campos.CAMPOS.filter((c) => require("../dominio/pedido").REQUERIDOS_PARA_DESPACHAR.includes(c)).map(
    (nombre) => ({ nombre, ...leer(ficha, nombre) })
  );
}

module.exports = { SIN_DATO, leer, texto, confirmado, nombreParaMostrar, paraDespachar };
