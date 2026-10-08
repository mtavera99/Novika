"use strict";

// ==========================================================================
// LA VOZ: QUE SUENE A UNA PERSONA QUE VENDE
//
// DE DONDE SALE: Marco probo el bot desde su numero y dijo que responde
// "muy plano, muy robot, muy seco, muy tosco", y que falta el tacto de
// vendedor de BIKERPRO: "mas atento, mas persuasivo".
//
// Tenia razon, y el diagnostico era concreto. El contenido estaba bien; la
// forma, no:
//
//   · TODA respuesta empezaba con el dato. "Tiene garantía de 1 mes",
//     "La correa es graduable", "La transportadora normalmente entrega".
//     Una persona primero RECONOCE lo que le preguntaron.
//   · Tercera persona para hablar del envio -"la transportadora"- que se
//     lee como un aviso legal y no como alguien atendiendo.
//   · Cero emojis. En un WhatsApp colombiano eso se lee frio.
//   · Nunca usaba el nombre del cliente, aunque ya lo tuviera confirmado.
//   · "1 unidad(es)": los parentesis de la plantilla, que es lo mas robot
//     que puede leer alguien que esta a punto de pagar.
//
// DOS REGLAS DE DISEÑO
//
// 1. DETERMINISTA, NO ALEATORIO. La variedad sale del TEMA y de la
//    SITUACION, no de un random. Un bot que responde distinto cada vez a lo
//    mismo no se puede probar, y aqui las pruebas son lo que impide que la
//    calidez se lleve por delante un precio.
//
// 2. LA CALIDEZ ENVUELVE EL DATO, NO LO TOCA. Las cifras siguen saliendo del
//    cotizador y las caracteristicas del catalogo, palabra por palabra. Aqui
//    solo se añade lo que va ANTES y DESPUES. Si una frase de este archivo
//    afirmara algo del producto, seria un dato inventado con buen tono.
// ==========================================================================

const { TEMAS } = require("../dominio/preguntas");

// --------------------------------------------------------------------------
// RECONOCER LO QUE PREGUNTO
//
// La apertura va por TEMA, asi que es estable -la misma pregunta abre
// igual- y a la vez variada entre temas distintos, que es lo que rompe la
// monotonia. Son aperturas de vendedor, no de formulario.
// --------------------------------------------------------------------------
const APERTURAS = {
  [TEMAS.PRECIO]: "Claro que sí,",
  [TEMAS.ENVIO]: "Te cuento:",
  [TEMAS.PAGO]: "Tranquila,",
  [TEMAS.GARANTIA]: "¡Claro que sí!",
  [TEMAS.GARANTIA_TRAMITE]: "Te explico:",
  [TEMAS.COLOR]: "Sí,",
  [TEMAS.TALLA]: "Sí,",
  // "¿me sirve a mi?" es la duda mas personal que llega: alguien contando
  // su cuerpo a un desconocido. Merece empatia antes del dato.
  [TEMAS.MEDIDAS]: "Te entiendo, es lo primero que uno mira.",
  [TEMAS.ENTREGA]: "Claro,",
  [TEMAS.MATERIAL]: "Te cuento:",
  [TEMAS.USO]: "Con gusto:",
  // Desconfiar de una tienda por WhatsApp es razonable. Se valida en vez
  // de defenderse.
  [TEMAS.CONFIANZA]: "Te entiendo perfectamente.",
  [TEMAS.FOTOS]: "¡Claro!",
};

/** La apertura del tema principal del turno. */
function apertura(temas) {
  for (const t of temas || []) {
    if (APERTURAS[t]) return APERTURAS[t];
  }
  return "";
}

// --------------------------------------------------------------------------
// UN EMOJI. UNO.
//
// Se añade al MENSAJE COMPUESTO, no a cada pieza: si cada frase trajera el
// suyo, un mensaje de tres frases saldria con tres emojis y eso se lee peor
// que ninguno. Hay una prueba de que nunca sale mas de uno.
// --------------------------------------------------------------------------
const EMOJIS = {
  [TEMAS.PRECIO]: "📦",
  [TEMAS.ENVIO]: "📦",
  [TEMAS.PAGO]: "📦",
  [TEMAS.ENTREGA]: "📦",
  [TEMAS.GARANTIA]: "😊",
  [TEMAS.COLOR]: "💗",
  [TEMAS.MEDIDAS]: "🙌",
  [TEMAS.CONFIANZA]: "🙌",
  confirmado: "🎉",
  resumen: "✅",
  compra: "🙌",
};

/** Expresion de los emojis que usamos, para contarlos y limpiarlos. */
const RE_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/** ¿Cuantos emojis tiene este texto? */
function cuantosEmojis(texto) {
  return (String(texto || "").match(RE_EMOJI) || []).length;
}

/**
 * Añade UN emoji al final, si el texto no trae ya alguno.
 *
 * No se fuerza en todos los mensajes: los de datos duros -un resumen con
 * importes, por ejemplo- quedan mejor limpios, y un emoji en cada mensaje
 * deja de significar nada.
 */
function conEmoji(texto, clave) {
  const t = String(texto || "").trimEnd();
  if (!t) return t;
  if (cuantosEmojis(t) > 0) return t;
  const emoji = EMOJIS[clave];
  if (!emoji) return t;
  // SIN el punto final delante del emoji. "tranquilidad. 😊" se lee a
  // formulario; "tranquilidad 😊" es como escribe la gente en WhatsApp. El
  // punto solo se quita si es el ultimo caracter: una interrogacion o una
  // admiracion SI se conservan ("¿te lo despacho? 📦").
  return `${t.replace(/\.$/, "")} ${emoji}`;
}

// --------------------------------------------------------------------------
// EL NOMBRE DE PILA
//
// Usar el nombre es lo que mas humaniza un mensaje, y lo mas facil de hacer
// mal. Dos cuidados:
//
//   · SOLO el primer nombre. "Listo, Marco Antonio Tavera Rodríguez" suena
//     a carta del banco.
//   · SOLO si esta CONFIRMADO. Un nombre que propuso el modelo y nadie
//     valido puede ser cualquier palabra de la frase del cliente, y llamar
//     a alguien por un nombre que no es suyo es peor que no nombrarlo.
// --------------------------------------------------------------------------
function nombreDePila(nombre) {
  const n = String(nombre || "").trim();
  if (!n) return "";
  const primero = n.split(/\s+/)[0];
  // Nada de una letra ni de cosas raras: en la duda, no se usa.
  if (primero.length < 3 || !/^[\p{L}]+$/u.test(primero)) return "";
  return primero.charAt(0).toUpperCase() + primero.slice(1).toLowerCase();
}

// --------------------------------------------------------------------------
// PLURALES DE VERDAD
//
// "1 unidad(es)" es lo mas robot que puede leer alguien que esta a punto de
// pagar, y estaba en el cuadro de confirmacion — justo donde decide. La
// referencia de BIKERPRO lo tiene documentado como error propio: "no copies
// los parentesis de la plantilla".
// --------------------------------------------------------------------------
function unidades(n) {
  const c = Number(n) || 0;
  return c === 1 ? "1 unidad" : `${c} unidades`;
}

/**
 * Une piezas en una frase.
 *
 * Y CAPITALIZA DESPUES DE PUNTO, SIGNO O INTERROGACION. Las piezas vienen
 * en minuscula para poder llevar una apertura delante, pero al unirlas
 * salia "¡Claro que sí! tiene 1 mes de garantía" — y una minuscula despues
 * de un signo de admiracion es exactamente el detalle que delata a una
 * maquina en un chat.
 */
function unir(partes) {
  const texto = (partes || [])
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.!?])\s*\1+/g, "$1")
    .trim();

  // Tras . ! ? y un espacio, la siguiente letra va en mayuscula.
  return texto.replace(/([.!?])\s+(\p{Ll})/gu, (_, signo, letra) => `${signo} ${letra.toUpperCase()}`);
}

module.exports = {
  APERTURAS,
  EMOJIS,
  apertura,
  conEmoji,
  cuantosEmojis,
  nombreDePila,
  unidades,
  unir,
  RE_EMOJI,
};
