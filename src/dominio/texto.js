"use strict";

// ==========================================================================
// NORMALIZACION DE TEXTO
//
// Modulo puro. Sin I/O, sin IA, sin process.env.
//
// Aqui vive una leccion caro aprendida en BIKERPRO: su funcion de limpieza
// quitaba las tildes antes de comparar, asi que "si" (condicional) y "si"
// (afirmativo) colapsaban en la misma cadena. El mensaje de un cliente que
// decia "si mandaron el pedido gracias" -una PREGUNTA- hizo match con el
// patron de afirmacion y genero un segundo pedido por el mismo importe.
//
// Por eso aqui la normalizacion devuelve SIEMPRE las dos versiones: la
// aplanada, util para buscar palabras, y la original, que es la unica que
// sabe si el cliente escribio "si" o "si". Quien decide algo transaccional
// tiene que poder consultar las dos.
// ==========================================================================

/** Quita tildes y diacriticos. "cinturon termico" <- "cinturón térmico" */
function sinTildes(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Forma canonica para buscar: minusculas, sin tildes, sin signos, con los
 * espacios colapsados. Se conservan los digitos porque las cantidades
 * importan ("quiero 2").
 */
function aplanar(texto) {
  return sinTildes(texto)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Las dos vistas de un mensaje, juntas y explicitas.
 *
 * @returns {{crudo: string, plano: string, minusculas: string, vacio: boolean,
 *            tieneTildeAfirmativa: boolean, palabras: string[]}}
 */
function vistas(texto) {
  const crudo = String(texto ?? "");
  const minusculas = crudo.toLowerCase();
  return {
    crudo,
    minusculas,
    plano: aplanar(crudo),
    vacio: crudo.trim() === "",
    // Si el cliente se tomo la molestia de poner la tilde, "si" es
    // inequivocamente afirmativo. Sin tilde puede ser condicional.
    //
    // Sin \b a proposito: en JavaScript \b se define sobre \w, que es
    // ASCII, asi que "i" acentuada no cuenta como caracter de palabra y
    // /\bsí\b/ NO coincide con "sí". Es el tipo de detalle que hace que una
    // comprobacion parezca estar y no este.
    tieneTildeAfirmativa: /sí/i.test(crudo),
    palabras: aplanar(crudo).split(" ").filter(Boolean),
  };
}

/** ¿Aparece alguno de estos patrones? Devuelve el primero que coincide. */
function primeraCoincidencia(texto, patrones) {
  for (const p of patrones) {
    const re = p instanceof RegExp ? p : new RegExp(p, "i");
    const m = String(texto).match(re);
    if (m) return { patron: re, coincidencia: m[0], posicion: m.index };
  }
  return null;
}

/**
 * Cantidad escrita en palabras o digitos. Devuelve null si no hay ninguna:
 * no asume 1. Asumir una cantidad es cobrar lo que el cliente no pidio.
 */
const NUMEROS_EN_PALABRAS = {
  un: 1, uno: 1, una: 1,
  dos: 2, par: 2,
  tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, docena: 12,
};

/**
 * Todas las cantidades mencionadas, en orden de aparicion.
 *
 * Devolver TODAS y no una es deliberado: "queria dos, mejor uno" tiene dos
 * señales en conflicto, y quien decide necesita verlas para resolver por
 * posicion (gana la correccion mas tardia) o para no resolver nada.
 */
/** Numerales de varias palabras. Se resuelven ANTES de los de una. */
const NUMEROS_COMPUESTOS = [
  { re: /\bun[ao]?\s+docena\b/g, valor: 12 },
  { re: /\bmedia\s+docena\b/g, valor: 6 },
  { re: /\bun\s+par\b/g, valor: 2 },
];

function cantidadesEn(texto) {
  let { plano } = vistas(texto);
  const encontradas = [];

  // "un par" vale 2, no 1. Si se buscaran primero las palabras sueltas,
  // "un" ganaria por posicion y se cotizaria la mitad del pedido. Los
  // compuestos se registran y se tapan con guiones para que lo que queda no
  // vuelva a leerse.
  for (const { re, valor } of NUMEROS_COMPUESTOS) {
    let c;
    const copia = new RegExp(re.source, "g");
    while ((c = copia.exec(plano)) !== null) {
      encontradas.push({ valor, posicion: c.index, origen: "compuesto" });
    }
    plano = plano.replace(new RegExp(re.source, "g"), (coincidencia) => "-".repeat(coincidencia.length));
  }

  const reDigitos = /\b(\d{1,3})\b/g;
  let m;
  while ((m = reDigitos.exec(plano)) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 999) encontradas.push({ valor: n, posicion: m.index, origen: "digito" });
  }

  for (const [palabra, valor] of Object.entries(NUMEROS_EN_PALABRAS)) {
    const re = new RegExp(`\\b${palabra}\\b`, "g");
    while ((m = re.exec(plano)) !== null) {
      encontradas.push({ valor, posicion: m.index, origen: "palabra" });
    }
  }

  return encontradas.sort((a, b) => a.posicion - b.posicion);
}

// --------------------------------------------------------------------------
// ¿EL CLIENTE ESTA PIDIENDO VER EL PRODUCTO?
//
// Hace falta porque el envio de fotos no puede depender de en que punto de
// la venta estemos. Antes se mandaban solo mientras el producto estaba en
// borrador; al activarlo, el mismo mensaje -"muestrame fotos del
// cinturon"- cae en la captura de datos y no salia ninguna foto.
//
// Deliberadamente NO entra "como es": el mensaje real que fallaba decia
// "...y como es el envio", y eso es una pregunta de logistica, no una
// peticion de imagenes. Un falso positivo aqui manda cinco fotos a quien
// pregunto por el flete.
// --------------------------------------------------------------------------
const PIDE_IMAGENES = [
  /\bfotos?\b/,
  /\bimagen(es)?\b/,
  /\bfotograf\w*/,
  /\b(muestra|muestrame|mostrar|ensena|ensename|ensenar)\b/,
  /\b(quiero|puedo|podria|se\s+puede|quisiera)\s+(ver|verlo|verla)\b/,
  /\bver\s+(el|la|los|las)\s+\w+/,
];

/** ¿El texto pide ver fotos del producto? */
function pideFotos(texto) {
  const plano = aplanar(texto);
  return PIDE_IMAGENES.some((re) => re.test(plano));
}

// ==========================================================================
// ¿PREGUNTA POR EL PRECIO?
//
// FUENTE UNICA. Esta lista la usan los dos sitios que necesitan saberlo:
// `preguntas.js` para clasificar el tema PRECIO, y el cerebro para decidir
// si repite una cifra que ya dijo. Antes habia DOS listas, cada una con sus
// propios huecos, y se fueron separando con el tiempo.
//
// EL FALLO QUE SE VIO EN PRODUCCION, con un pedido ya confirmado:
//
//   cliente: "Que valen dos?"
//   bot:     "Tu pedido NOV-... ya está confirmado"
//   cliente: "Que valen dos unidades?"
//   bot:     "Perdón, no quiero repetirme. Dime concretamente qué necesitas"
//   cliente: "Quiero saber cuánto valen dos unidades"
//   bot:     "Tu pedido NOV-... ya está confirmado"
//
// Tres intentos de COMPRAR MAS, los tres perdidos, y ninguno por falta de
// dato: el precio de dos esta en el catalogo. El detector solo conocia el
// SINGULAR -"cuanto vale"- y no "valen", "cuestan" ni "a como". Quien
// pregunta por dos unidades escribe en plural, que era justo el hueco.
//
// Por eso van sin tildes: se comparan contra el texto aplanado, porque el
// teclado del movil pone las tildes solo a veces.
// ==========================================================================
const PREGUNTA_PRECIO = [
  // "cuanto vale", "cuanto valen", "cuantos cuestan", "cuanto me salen dos".
  // Con las ERRATAS DE DEDO que de verdad llegan por WhatsApp: la b por la
  // v -"cuanto bale" es de las mas comunes en Colombia- y la k por la c.
  // No es un capricho ortografico: es LA pregunta que mas se hace, y
  // perderla por una letra es perder la venta entera.
  /\b(cuanto|cuantos|cuantas|kuanto|kuantos)\s+(me\s+|te\s+|le\s+)?(vale|valen|bale|balen|cuesta|cuestan|kuesta|kuestan|sale|salen|saldria|saldrian|seria|serian|es|son)\b/,
  // "¿y el par?", "¿y los dos?": preguntar el precio del combo sin nombrar
  // el verbo. Va anclado para no confundirlo con "me llevo los dos".
  /^\s*y\s+(el\s+par|los\s+dos|las\s+dos|por\s+dos)\s*\??\s*$/,
  // "¿en cuánto me lo deja?" es precio. "¿EN CUÁNTO ME LLEGARÍA?" es el
  // plazo de entrega, y sin el lookahead caia aqui: el bot le contestaba el
  // PRECIO a quien preguntaba cuándo le llega.
  /\ben\s+cuanto\b(?!\s+(?:me\s+|lo\s+|la\s+|nos\s+)?(?:lleg|recib|tarda|demora|sale|saldria))/,
  /\bcuanto\s+(por|serian\s+por)\b/,
  // "que vale", "que valen dos", "que cuestan", "que precio tiene".
  /\bque\s+(me\s+)?(vale|valen|cuesta|cuestan|sale|salen)\b/,
  /\bque\s+precio\b/,
  /\bprecios?\b/,
  /\bvalor\b/,
  // "QUE COSTO TIENE". Es preguntar el precio, y NO se reconocia: la lista
  // solo conocia el verbo ("cuesta", "cuestan"), no el sustantivo.
  //
  // Costo medido: el 08-oct una clienta de Bogota lo escribio tal cual y
  // recibio "esa no te la quiero contestar a medias, la dejo anotada para
  // el equipo" — el bot se nego a decir el precio que ya habia dicho dos
  // mensajes antes. Esa venta no se cerro.
  //
  // `costo` y no `cost\w*`: "costoso" es una OBJECION de precio, que se
  // contesta distinto, y tiene su propio patron.
  /\bcostos?\b/,
  // El plural suelto: "valen mucho?", "cuestan 85?". Se admite sin "cuanto"
  // delante porque "valen"/"cuestan" casi no tienen otro uso — a diferencia
  // de "vale", que en Colombia es "de acuerdo" y por eso NO entra solo.
  /\b(valen|cuestan)\b/,
  // "a como el cinturon", "a como los dos": en Colombia es preguntar precio.
  /\ba\s+como\b/,

  // ----------------------------------------------------------------------
  // LA PREGUNTA CONDICIONAL POR OTRA CANTIDAD: "y si llevo dos?"
  //
  // Es la respuesta natural a "te paso el precio de las dos si quieres", y
  // no era NADA: el extractor se quedaba con el "dos" como cantidad de la
  // ficha y la clienta recibia "¡Perfecto, gracias!" sin una sola cifra,
  // justo despues de que el bot le ofreciera pasarsela. Una promesa que el
  // bot no cumplia.
  //
  // ⚠️ Anclada a formas que NO se confunden con un SI ROTUNDO. `aplanar` se
  // come la coma, asi que "si, me llevo dos" y "si me llevo dos" llegan
  // aqui IDENTICAS. Por eso se exige el "y" delante ("y si llevo dos"), el
  // subjuntivo ("si llevara dos") o el gerundio ("llevando dos"), que son
  // hipoteticos sin ambiguedad posible. Un "si llevo dos" pelado se queda
  // fuera A PROPOSITO: vale mas perder la pregunta que cotizarle a quien
  // estaba diciendo que si.
  /\by\s+si\s+(?:me\s+)?(?:llevo|pido|compro)\s+(?:\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|par)\b/,
  /\bsi\s+(?:me\s+)?(?:llevara|llevaria|pidiera|comprara)\s+(?:\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|par)\b/,
  /\bllevando\s+(?:\d{1,2}|dos|tres|cuatro|cinco|seis)\b/,
];

function preguntaPrecio(texto) {
  const plano = aplanar(texto);
  return PREGUNTA_PRECIO.some((re) => re.test(plano));
}

module.exports = {
  sinTildes,
  aplanar,
  vistas,
  primeraCoincidencia,
  cantidadesEn,
  pideFotos,
  preguntaPrecio,
  PIDE_IMAGENES,
  PREGUNTA_PRECIO,
  NUMEROS_EN_PALABRAS,
  NUMEROS_COMPUESTOS,
};
