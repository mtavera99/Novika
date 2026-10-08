"use strict";

// ==========================================================================
// QUE ESTA PREGUNTANDO EL CLIENTE
//
// Modulo puro. Sin I/O, sin IA, sin catalogo.
//
// POR QUE EXISTE
//
// Antes el cerebro sabia en que PASO DE LA VENTA estaba -faltan datos, hay
// resumen, esta confirmado- y contestaba segun el paso. Eso produce
// conversaciones como esta, que es real y salio de probar la activacion:
//
//   clienta: "Quiero un cinturón. ¿Cuánto vale con envío?"
//   bot:     "Para continuar me falta la ciudad, la dirección de entrega."
//
// El paso de la venta era correcto -faltaban datos- y la respuesta era
// inservible: le pide los datos a alguien que acaba de preguntar el precio.
//
// Para contestar primero lo que preguntan hay que SABER que preguntaron. Eso
// es lo que hace este modulo: clasifica el mensaje en temas, sin decidir que
// se responde. Quien responde es el cerebro, con datos del catalogo.
//
// DOS REGLAS DE DISEÑO
//
// 1. UN TEMA NO RECONOCIDO NO ES UN ERROR. Si no se reconoce nada, el cerebro
//    sigue su camino normal. Este modulo solo puede MEJORAR una respuesta,
//    nunca bloquearla.
//
// 2. PREGUNTAR NO ES COMPRAR, Y ESA DISTINCION ES LO MAS VALIOSO DE AQUI.
//    Documentado en la referencia de BIKERPRO: el bot contestaba cada duda
//    informativa pidiendo ademas nombre, celular y direccion, y el cliente
//    que estaba averiguando se sentia perseguido y se iba. La diferencia
//    entre "¿tiene garantia?" y "lo quiero" tiene que estar en codigo, no en
//    una instruccion al modelo.
// ==========================================================================

const { aplanar } = require("./texto");

/**
 * Temas que el cliente puede preguntar.
 *
 * Cada tema se responde desde el catalogo o desde el cotizador. Si un tema no
 * tiene dato aprobado, el cerebro dice que lo confirma una persona: por eso
 * aqui no hay ninguna respuesta escrita, solo la clasificacion.
 */
const TEMAS = {
  PRECIO: "precio",
  ENVIO: "envio",
  PAGO: "pago",
  COLOR: "color",
  TALLA: "talla",
  MEDIDAS: "medidas",
  GARANTIA: "garantia",
  /** Como se hace efectiva / que cubre: el PLAZO esta confirmado, esto no. */
  GARANTIA_TRAMITE: "garantia_tramite",
  ENTREGA: "tiempo_de_entrega",
  MATERIAL: "material",
  USO: "uso",
  CONFIANZA: "confianza",
  FOTOS: "fotos",
};

/**
 * Patrones por tema, sobre el texto APLANADO (minusculas, sin tildes).
 *
 * Se escriben sin tildes a proposito: el cliente escribe desde el movil y el
 * teclado las pone solas, asi que comparar contra el texto crudo haria que
 * "¿cuánto vale?" no coincidiera con `cuanto vale`. Ese error ya se cometio
 * una vez en los alias del catalogo.
 */
const PATRONES = [
  // ---- Precio ----
  [TEMAS.PRECIO, /\bcuanto\s+(vale|cuesta|sale|es|seria|me\s+sale|saldria)\b/],
  [TEMAS.PRECIO, /\ben\s+cuanto\b/],
  [TEMAS.PRECIO, /\b(que|cual\s+es\s+el)\s+precio\b/],
  [TEMAS.PRECIO, /\bprecios?\b/],
  [TEMAS.PRECIO, /\bvalor\b/],
  [TEMAS.PRECIO, /\bcuanto\b.*\bcon\s+envio\b/],

  // ---- Envio ----
  // "como es el envio", "hacen envios", "envian a", "domicilio", "flete".
  [TEMAS.ENVIO, /\benvi(o|os|an|a)\b/],
  [TEMAS.ENVIO, /\bdomicilio\b/],
  [TEMAS.ENVIO, /\bflete\b/],
  [TEMAS.ENVIO, /\bmandan?\s+a\b/],
  [TEMAS.ENVIO, /\bllega\s+a\b/],

  // ---- Pago ----
  [TEMAS.PAGO, /\bcontra\s*entrega\b/],
  [TEMAS.PAGO, /\bcontraentrega\b/],
  [TEMAS.PAGO, /\b(como|cuando)\s+(se\s+)?pag(a|o|ar)\b/],
  [TEMAS.PAGO, /\bpago\s+(al|contra)\b/],
  [TEMAS.PAGO, /\b(acepta|aceptan|reciben|puedo\s+pagar)\b.*\b(nequi|daviplata|transferencia|tarjeta|efectivo)\b/],
  [TEMAS.PAGO, /\b(nequi|daviplata|transferencia)\b/],
  [TEMAS.PAGO, /\bpago\s+anticipado\b/],

  // ---- Color ----
  [TEMAS.COLOR, /\bcolor(es)?\b/],
  [TEMAS.COLOR, /\bviene\s+en\s+\w+/],
  [TEMAS.COLOR, /\b(rosado|rosa|negro|blanco|azul|rojo|verde|morado|gris)\b/],

  // ---- Talla ----
  [TEMAS.TALLA, /\btallas?\b/],
  [TEMAS.TALLA, /\bes\s+unitalla\b/],
  [TEMAS.TALLA, /\bque\s+tamano\b/],
  [TEMAS.TALLA, /\b(es|hay)\s+talla\s+unica\b/],

  // ---- Medidas y ajuste: el tema sensible de este producto ----
  // Marco fue explicito: no hay medidas del ajuste y no se promete que sirva
  // para cualquier contorno. Se clasifica aparte de TALLA para poder dar la
  // respuesta honesta en vez de la del dato aprobado.
  [TEMAS.MEDIDAS, /\bme\s+(sirve|queda|servira|quedara)\b/],
  [TEMAS.MEDIDAS, /\b(contorno|cintura|abdomen|barriga|cadera)\b/],
  [TEMAS.MEDIDAS, /\bcuanto\s+(mide|estira|ajusta)\b/],
  [TEMAS.MEDIDAS, /\b(medidas?|centimetros|cm)\b/],
  [TEMAS.MEDIDAS, /\buso\s+talla\b/],
  [TEMAS.MEDIDAS, /\bsoy\s+(gordita|gorda|delgada|grande|pequena)\b/],

  // ---- Garantia: el plazo ----
  [TEMAS.GARANTIA, /\bgarantia\b/],

  // ---- Garantia: el tramite y la cobertura ----
  // Se separa del plazo porque son dos datos distintos: el plazo lo
  // confirmo Marco (1 mes) y el tramite NO esta definido. Responder "1 mes"
  // a "¿cómo la hago efectiva?" contesta otra pregunta.
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+(la\s+)?(hago|hacer)\s+efectiva\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+(reclamo|la\s+reclamo|pido\s+la\s+garantia)\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+funciona\s+la\s+garantia\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bque\s+cubre\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bquien\s+paga\s+(el\s+)?(envio\s+de\s+)?(la\s+)?(devoluci|cambio)/],
  [TEMAS.GARANTIA, /\bsi\s+(sale|viene)\s+(malo|dañado|danado|defectuoso)\b/],
  [TEMAS.GARANTIA, /\b(puedo|se\s+puede)\s+(devolver|cambiar)\b/],
  [TEMAS.GARANTIA, /\bdevoluci(on|ones)\b/],

  // ---- Tiempo de entrega ----
  [TEMAS.ENTREGA, /\bcuando\s+(llega|lo\s+recibo|me\s+llega)\b/],
  [TEMAS.ENTREGA, /\bcuanto\s+(tarda|demora|se\s+demora)\b/],
  [TEMAS.ENTREGA, /\bcuantos\s+dias\b/],
  [TEMAS.ENTREGA, /\bdemora\b/],

  // ---- Material ----
  [TEMAS.MATERIAL, /\bmaterial\b/],
  [TEMAS.MATERIAL, /\bde\s+que\s+(esta\s+hecho|es)\b/],
  [TEMAS.MATERIAL, /\b(tela|cuero|plastico|algodon)\b/],

  // ---- Como funciona / para que sirve ----
  [TEMAS.USO, /\bcomo\s+(funciona|se\s+usa|se\s+pone|lo\s+uso)\b/],
  [TEMAS.USO, /\bpara\s+que\s+sirve\b/],
  [TEMAS.USO, /\bes\s+recargable\b/],
  [TEMAS.USO, /\b(bateria|pila|cable|usb|enchuf)\w*/],
  [TEMAS.USO, /\bniveles?\s+de\s+(calor|temperatura|intensidad)\b/],
  [TEMAS.USO, /\bcalienta\b/],

  // ---- Desconfianza ----
  [TEMAS.CONFIANZA, /\bes\s+(real|confiable|seguro|estafa)\b/],
  [TEMAS.CONFIANZA, /\bson\s+(reales|confiables|seguros)\b/],
  [TEMAS.CONFIANZA, /\bno\s+es\s+estafa\b/],
  [TEMAS.CONFIANZA, /\bdonde\s+(estan|quedan|es)\b/],
  [TEMAS.CONFIANZA, /\btienen\s+(tienda|local|direccion)\b/],

  // ---- Fotos ----
  [TEMAS.FOTOS, /\bfotos?\b/],
  [TEMAS.FOTOS, /\bimagen(es)?\b/],
  [TEMAS.FOTOS, /\bver(lo|la)?\b/],
];

/**
 * Señales de que el cliente QUIERE COMPRAR, no solo averiguar.
 *
 * Es la lista que autoriza a pedir los datos de entrega. Tiene que ser
 * explicita: "lo quiero", "me sirve", "dale". Una duda no entra aqui.
 */
const SENALES_DE_COMPRA = [
  // ----------------------------------------------------------------------
  // EL PLURAL TAMBIEN ES UNA SEÑAL DE COMPRA
  //
  // Esto solo cubria singular -"lo quiero", "la quiero"- y el combo de dos
  // era casi imposible de cerrar hablando:
  //
  //   clienta: "¿cuánto me salen dos?"
  //   bot:     "2 unidades te quedan en $85.000..."
  //   clienta: "las quiero"
  //   bot:     "¿Cuántos quieres?"     <- no lo leyo como compra
  //
  // "las quiero", "me las llevo" y "las dos" son justo lo que dice quien
  // compra dos. Sin el plural, el precio del combo no servia para nada.
  // ----------------------------------------------------------------------
  /\b(lo|la|los|las)\s+(quiero|llevo|compro|necesito)\b/,
  /\bme\s+(lo|la|los|las)\s+(llevo|quedo)\b/,
  /\b(quiero|llevo|dame|mandame|enviame)\s+(los|las)\s+dos\b/,
  /\bquiero\s+(uno|una|un|dos|tres|comprarlo|comprarla|pedirlo|pedirla|ese|esa|el|la)\b/,
  /\b(dale|hagale|hagamoslo|de\s+una|despachalo|despachelo)\b/,
  /\b(como\s+)?(hago|hacemos)\s+para\s+(pedir|comprar|que\s+me\s+llegue)\b/,
  /\b(mandem?el[oa]|envielo|enviamelo|envienmelo|despachenlo)\b/,
  /\bvoy\s+a\s+(llevar|comprar|pedir)\b/,
  /\bcomo\s+pido\b/,
  /\bquiero\s+(hacer|realizar)\s+(el|un)\s+pedido\b/,
];

// --------------------------------------------------------------------------
// SEÑALES DEBILES: LAS QUE CAMBIAN DE SENTIDO CON UN SIGNO DE PREGUNTA
//
// "me sirve" afirmando es una señal de compra clarisima. "¿me sirve?" es la
// duda mas frecuente de un producto que se pone en el cuerpo, y es lo
// CONTRARIO: el cliente todavia no sabe si le queda.
//
// Estaban en la lista de arriba y produjeron esto, que salio al probar el
// dialogo completo:
//
//   clienta: "¿me sirve a mí? uso talla XL"
//   bot:     "...¿Cuántos quieres? Y para despacharlo me pasas la ciudad y
//             la dirección."
//
// Le pidio la direccion a alguien que acababa de preguntar si el producto le
// iba a quedar. Por eso estas solo cuentan como compra cuando la frase NO es
// una pregunta.
// --------------------------------------------------------------------------
const SENALES_DEBILES = [
  /\b(me\s+)?(sirve|interesa|conviene|parece\s+bien)\b/,
  // "las dos" suelto es una señal DEBIL, no fuerte: afirmando es aceptar el
  // combo ("las dos"), pero preguntando es pedir su precio ("¿cuánto
  // cuestan las dos?"). Aqui solo vale sin interrogacion.
  // El lookbehind excluye la hora: "a las dos de la tarde".
  /(?<!\ba\s)\blas\s+dos\b/,
  /\b(listo|perfecto|vale|bueno)\b/,
];

/** Saludos puros: no preguntan nada. */
const SALUDOS = [
  /^(hola|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|hey|que\s+tal|saludos|buen\s+dia)\b/,
];

/**
 * ¿Qué pregunta este mensaje?
 *
 * @returns {{temas: string[], pregunta: boolean, compra: boolean,
 *            saludo: boolean, soloSaludo: boolean}}
 */
function leer(texto) {
  const plano = aplanar(texto);
  const crudo = String(texto ?? "");

  const temas = [];
  for (const [tema, re] of PATRONES) {
    if (re.test(plano) && !temas.includes(tema)) temas.push(tema);
  }

  const saludo = SALUDOS.some((re) => re.test(plano));
  const interrogacion = /\?/.test(crudo);
  const compra =
    SENALES_DE_COMPRA.some((re) => re.test(plano)) ||
    // Las debiles solo valen si el cliente NO esta preguntando.
    (!interrogacion && SENALES_DEBILES.some((re) => re.test(plano)));

  // Un signo de interrogacion es una señal fuerte, pero no la unica: mucha
  // gente pregunta sin escribirlo ("cuanto vale").
  const interroga = interrogacion || temas.length > 0;

  return {
    temas,
    pregunta: interroga && temas.length > 0,
    compra,
    saludo,
    // Un "hola" pelado: ni pregunta ni compra. Merece un arranque, no un
    // interrogatorio.
    soloSaludo: saludo && temas.length === 0 && !compra && plano.split(/\s+/).length <= 4,
  };
}

/**
 * ¿Es un turno puramente informativo?
 *
 * Preguntar no es comprar. Si es informativo, el cerebro responde la duda y
 * NO pide los datos de entrega: pedirlos ahi es lo que hace que el cliente
 * que estaba averiguando se sienta perseguido.
 */
function esInformativo(texto) {
  const r = leer(texto);
  return r.pregunta && !r.compra;
}

module.exports = { TEMAS, leer, esInformativo, SENALES_DE_COMPRA, SENALES_DEBILES, PATRONES };
