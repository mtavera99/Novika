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
  // Quien dice "esta muy caro" no quiere un "¡Claro que si!": quiere que
  // alguien le reconozca que es plata. Se valida y se explica, sin ponerse
  // a la defensiva y sin pedir disculpas por el precio.
  [TEMAS.OBJECION_PRECIO]: "Te entiendo, y te explico:",
};

/**
 * La apertura del tema principal del turno.
 *
 * ABRE POR EL TEMA QUE DE VERDAD SE CONTESTA, no por el primero que casó.
 * `contestar.aTemas` colapsa dos pares -MEDIDAS se come TALLA, y el tramite
 * de la garantia se come el plazo- y la apertura no lo sabia. El resultado:
 *
 *   clienta: "¿me sirve a mí? uso talla XL"
 *   bot:     "Sí, La correa es graduable..."
 *
 * Marcaba TALLA y MEDIDAS, abria con el "Sí," de TALLA y contestaba con la
 * frase de MEDIDAS. Y la apertura empatica que se escribio justo para esa
 * pregunta -"Te entiendo, es lo primero que uno mira."- no se usaba nunca,
 * porque TALLA va antes en la tabla de patrones.
 */
function apertura(temas) {
  for (const t of temasQueSeContestan(temas)) {
    if (APERTURAS[t]) return APERTURAS[t];
  }
  return "";
}

/**
 * Los temas en el orden en que DE VERDAD se contestan.
 *
 * Aplica los mismos colapsos que `contestar.aTemas`, y existe para que la
 * apertura y el emoji no se elijan por un tema que luego no se responde.
 *
 * El caso que lo obligo: "¿me sirve a mí? uso talla XL" marca TALLA y
 * MEDIDAS; se contesta con MEDIDAS, pero `temas[0]` era TALLA —que no tiene
 * emoji— y el mensaje salia SIN NINGUNO, justo en la duda mas frecuente del
 * producto. El mismo error producia "Sí, La correa es graduable".
 */
function temasQueSeContestan(temas) {
  let lista = [...(temas || [])];
  if (lista.includes(TEMAS.MEDIDAS)) lista = lista.filter((t) => t !== TEMAS.TALLA);
  if (lista.includes(TEMAS.GARANTIA_TRAMITE)) lista = lista.filter((t) => t !== TEMAS.GARANTIA);
  if (lista.includes(TEMAS.OBJECION_PRECIO)) {
    lista = lista.filter((t) => t !== TEMAS.ENVIO && t !== TEMAS.PAGO);
  }
  return lista;
}

/**
 * La clave de emoji del turno: el primer tema contestado que tenga uno.
 *
 * Recorre la lista en vez de quedarse en el primero, porque un tema sin
 * emoji dejaba el mensaje entero sin ninguno.
 */
function claveDeEmoji(temas) {
  for (const t of temasQueSeContestan(temas)) {
    if (EMOJIS[t]) return t;
  }
  return null;
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
  [TEMAS.OBJECION_PRECIO]: "💡",
  // Para los mensajes que NO responden un tema: cuando se admite que un
  // dato no se tiene, cuando pasa a una persona, cuando se acusa recibo de
  // un dato. Salian sin un solo emoji -con `emoji: null`- y son justo los
  // que mas frios se leen, porque la noticia ya no es la que el cliente
  // queria. Un 🙌 no promete nada y quita la sequedad.
  atencion: "🙌",
  // Para el saludo de quien vuelve. Es de los mensajes de mas trafico que
  // hay -alguien que ya nos conoce- y salia como un formulario: "¡Hola!
  // ¿En qué te puedo ayudar?", sin un solo emoji.
  saludo: "😊",
  confirmado: "🎉",
  resumen: "✅",
  compra: "🙌",
};

// --------------------------------------------------------------------------
// CUANTOS EMOJIS: UNO O DOS. NUNCA TRES.
//
// Esto era UNO, y Marco volvio a probar el bot y lo siguio viendo "muy
// seco, sin emojis, muy tipo robot". Con un solo emoji al final, un mensaje
// de tres frases se lee como un aviso con una pegatina.
//
// DOS no es un numero inventado: es la regla que BIKERPRO tiene escrita en
// su propio guion -"Emojis con moderación (1 o 2 por mensaje)"- y ese bot
// es el que Marco pone como ejemplo de buen tono.
//
// El tope SIGUE EXISTIENDO, y sigue siendo duro: tres emojis en un mensaje
// se leen peor que ninguno. Lo que cambia es el numero, no la regla.
// --------------------------------------------------------------------------
const TOPE_DE_EMOJIS = 2;

/** Expresion de los emojis que usamos, para contarlos y limpiarlos. */
const RE_EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

/** ¿Cuantos emojis tiene este texto? */
function cuantosEmojis(texto) {
  return (String(texto || "").match(RE_EMOJI) || []).length;
}

/**
 * Coloca un emoji al final de la PRIMERA frase del mensaje.
 *
 * Devuelve el texto intacto si no hay una segunda frase detras: un emoji al
 * final de la unica frase es lo que ya hace `conEmoji`, y repetirlo aqui
 * pondria dos seguidos.
 */
function trasLaPrimeraFrase(texto, emoji) {
  // El primer punto, admiracion o interrogacion que tenga texto detras.
  const m = /^(.*?[.!?])\s+(\S.*)$/s.exec(texto);
  if (!m) return texto;
  const primera = m[1];
  // Si esa primera frase ya acaba en emoji, no se le añade otro al lado.
  //
  // ⚠️ Con `RE_EMOJI` NO: lleva la bandera `g` y `.test()` arrastra
  // `lastIndex`, asi que la misma comprobacion daria true y false
  // alternandose entre llamadas. Se cuenta, que es lo unico estable.
  if (cuantosEmojis(primera.slice(-3)) > 0) return texto;
  // Igual que al final: el punto se cae delante del emoji, los signos no.
  return `${primera.replace(/\.$/, "")} ${emoji} ${m[2]}`;
}

/**
 * Añade UN emoji al final, si el texto no trae ya alguno.
 *
 * No se fuerza en todos los mensajes: los de datos duros -un resumen con
 * importes, por ejemplo- quedan mejor limpios, y un emoji en cada mensaje
 * deja de significar nada.
 */
function conEmoji(texto, clave, { tope = TOPE_DE_EMOJIS } = {}) {
  const t = String(texto || "").trimEnd();
  if (!t) return t;
  const emoji = EMOJIS[clave];
  if (!emoji) return t;

  const ya = cuantosEmojis(t);
  if (ya >= tope) return t;

  // EL MISMO EMOJI DOS VECES NO SON DOS EMOJIS: ES UN DESCUIDO.
  //
  // Salio en la primera prueba del tono: el tema GARANTIA pone 😊 y el
  // cierre tambien, y el mensaje quedo "¡Claro que sí! 😊 Tiene 1 mes de
  // garantía... ¿Te lo aparto? 😊". Repetido se lee peor que uno solo.
  if (t.includes(emoji)) return t;

  // YA TRAE UNO -casi siempre en el cierre- Y CABE OTRO.
  //
  // El segundo NO se pega al lado del primero: "...pagas al recibir 🙌 📦"
  // son dos emojis juntos, que es justo lo que se lee a bot. Va al final de
  // la PRIMERA frase, que es donde lo pone un vendedor de verdad:
  //
  //   "...con envío incluido y pagas al recibir 📦 ¿Te lo aparto? 🙌"
  if (ya > 0) return trasLaPrimeraFrase(t, emoji);
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
//   · Y NO TODO LO QUE LLEGA EN EL CAMPO NOMBRE ES UN NOMBRE. Puede venir
//     del PERFIL de WhatsApp, donde la gente pone de todo. Salio probando:
//     la clienta escribio "soy Luz Marina" y el bot cerro con "¡Listo,
//     Cliente!", porque el perfil decia "Cliente". Eso suena a plantilla
//     mal rellenada justo en el mensaje del cierre.
// --------------------------------------------------------------------------
const NO_SON_NOMBRES = new Set([
  "cliente", "clienta", "usuario", "usuaria", "whatsapp", "user", "test",
  "prueba", "hola", "buenas", "amiga", "amigo", "señora", "senora", "señor", "senor",
  "info", "ventas", "none", "null", "undefined",
]);

function nombreDePila(nombre) {
  const n = String(nombre || "").trim();
  if (!n) return "";
  const primero = n.split(/\s+/)[0];
  // Nada de una letra ni de cosas raras: en la duda, no se usa.
  if (primero.length < 3 || !/^[\p{L}]+$/u.test(primero)) return "";
  if (NO_SON_NOMBRES.has(primero.toLowerCase())) return "";
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
  //
  // Y EL EMOJI NO CUENTA COMO LETRA: ahora un mensaje puede llevar un emoji
  // en medio -al final de la primera frase- y sin esto quedaba
  // "...pagas al recibir 📦 ¿te lo aparto?" con la minuscula detras del
  // emoji, que es el mismo descuido que delataba a la maquina cuando salia
  // "¡Claro que sí! tiene garantía".
  // Entre el signo y la letra pueden quedar DOS cosas que no son letras y
  // que no deben romper la mayuscula: el emoji de en medio y la apertura de
  // interrogacion o admiracion. Sin contemplar el "¿" salia
  // "...al recibir 📦 ¿te lo aparto?", y ese defecto ya existia antes del
  // emoji -"¡Claro que sí! ¿te lo aparto?"- solo que no se habia visto.
  return texto.replace(
    /([.!?])(\s+(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]+\s+)?[¿¡"']*)(\p{Ll})/gu,
    (_, signo, medio, letra) => `${signo}${medio}${letra.toUpperCase()}`
  );
}

module.exports = {
  APERTURAS,
  EMOJIS,
  TOPE_DE_EMOJIS,
  apertura,
  temasQueSeContestan,
  claveDeEmoji,
  conEmoji,
  cuantosEmojis,
  nombreDePila,
  NO_SON_NOMBRES,
  unidades,
  unir,
  RE_EMOJI,
};
