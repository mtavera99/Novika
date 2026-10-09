"use strict";

// ==========================================================================
// PREPARACION DE LA RESPUESTA
//
// Modulo casi puro: recibe hechos ya calculados y produce texto.
//
// Dos cosas pasan aqui, y el orden es el que importa:
//
//   1. SE CONSTRUYE UN TEXTO DETERMINISTA con los datos autorizados. Este
//      texto no depende del modelo y siempre existe. Es el que se usa si
//      algo falla.
//
//   2. SI LA IA PROPUSO UN BORRADOR, SE REVISA. Tiene que pasar dos filtros:
//
//        - importes: ninguna cifra de dinero que el cotizador no calculo;
//        - claims: ninguna frase de la lista de prohibidos del producto.
//
//      Si falla cualquiera, SE DESCARTA EL BORRADOR COMPLETO y se usa el
//      determinista. No se corrige, no se recorta: un texto que intenta
//      afirmar algo prohibido es un texto en el que no se puede confiar, y
//      arreglar la frase mala deja las demas sin revisar.
//
// Por que el filtro de claims importa tanto en NOVIKA: el primer producto es
// para dolor menstrual. Ahi el riesgo no es exagerar un precio, es hacer una
// promesa medica. "Cura los colicos" no es una venta agresiva: es una
// devolucion y, potencialmente, un problema regulatorio.
// ==========================================================================

const { revisarImportes } = require("../dominio/cotizador");
const { aplanar } = require("../dominio/texto");
const preguntas = require("../dominio/preguntas");
const contestar = require("./contestar");
const voz = require("./voz");

const BLOQUEOS = {
  IMPORTE_NO_AUTORIZADO: "importe_no_autorizado",
  CLAIM_PROHIBIDO: "claim_prohibido",
  SIN_BORRADOR: "sin_borrador",
  /** El producto se reconoce pero no tiene ficha: el modelo no redacta. */
  PRODUCTO_SIN_FICHA: "producto_sin_ficha",
  /**
   * La pregunta tiene respuesta en el catalogo, con su tono y sus pruebas.
   * No es un bloqueo por riesgo: es que ya habia una respuesta mejor.
   */
  CUBIERTO_POR_EL_CATALOGO: "cubierto_por_el_catalogo",
  /** Dice que el pedido salio y el pedido no ha salido. */
  DESPACHO_SIN_RESPALDO: "despacho_sin_respaldo",
  /**
   * El texto determinista salio VACIO y se sustituyo. Es un aviso, no un
   * riesgo: si aparece, hay una combinacion de reglas que da cero y el
   * cliente habria recibido silencio.
   */
  TEXTO_VACIO_EVITADO: "texto_vacio_evitado",
};

// ==========================================================================
// DECIR QUE SALIO, SOLO SI SALIO
//
// La primera version metio "tu pedido ya salio" en `claimsProhibidos`, y
// eso prohibe LA FRASE — tambien cuando es verdad. Marco lo corrigio: el
// control debe impedir promesas SIN RESPALDO, no prohibir la palabra. Si un
// pedido salio de verdad, el bot tiene que poder decirlo, porque es la
// pregunta en la que mas se desconfia de una tienda por WhatsApp.
//
// Asi que esto no mira el vocabulario: compara lo que el texto AFIRMA con
// el estado real del pedido. Un dato con respaldo pasa; el mismo dato sin
// respaldo se bloquea. La diferencia no esta en las palabras, esta en los
// hechos.
//
// El respaldo es fuerte: `despacho.guia` solo se escribe cuando una persona
// despacha desde el panel, y el dominio no deja marcar despachado sin guia.
// ==========================================================================
const AFIRMA_QUE_SALIO = [
  /\b(ya|fue)\s+(salio|despachado|despachamos|enviado|enviamos)\b/,
  /\bya\s+(va|viene)\s+en\s+camino\b/,
  /\bya\s+(esta|quedo)\s+despachad[oa]\b/,
  /\bse\s+despacho\s+ya\b/,
  /\bya\s+te\s+lo\s+(mandamos|enviamos|despachamos)\b/,
];

/**
 * ¿El texto dice que el pedido salio sin que haya salido?
 *
 * @param {string} texto
 * @param {object|null} pedido  con `estado` y, si salio, `guia`
 */
function revisarDespacho(texto, pedido) {
  const plano = aplanar(texto);
  if (!plano) return { ok: true };
  if (!AFIRMA_QUE_SALIO.some((re) => re.test(plano))) return { ok: true };

  // Lo afirma. Solo vale si de verdad salio.
  const salio = pedido && pedido.estado === "despachado";
  if (salio) return { ok: true };

  return {
    ok: false,
    motivo: pedido
      ? `dice que el pedido salio y su estado es "${pedido.estado}"`
      : "dice que un pedido salio y no hay ningun pedido",
  };
}

/**
 * Interruptor de vuelta atras: con IA_REDACTA_SIEMPRE=1, el borrador del
 * modelo vuelve a tener prioridad siempre que pase los filtros. Existe para
 * poder comparar los dos comportamientos sin desplegar nada.
 */
const PREFERIR_LA_IA = String(process.env.IA_REDACTA_SIEMPRE || "") === "1";

/**
 * ¿El texto afirma algo de la lista de prohibidos del producto?
 *
 * Se compara sobre el texto aplanado (sin tildes, minusculas) para que
 * "cura los cólicos" y "CURA LOS COLICOS" cuenten igual.
 */
/**
 * Marcas de que una frase ADMITE no saber el dato en vez de afirmarlo.
 *
 * "La garantía te la confirmo" y "la garantía es de un año" mencionan las dos
 * la garantia, y son opuestas: la primera es honesta y la segunda es un dato
 * inventado. Sin esta distincion las dos se bloqueaban igual.
 */
const ADMITE_NO_SABER = [
  /\bconfirm/, // confirmo, confirmar, te la confirmo
  /\bno\s+(tengo|se|sabria|te\s+puedo\s+decir)\b/,
  /\bno\s+quiero\s+darte\b/,
  /\b(averiguo|reviso|consulto|pregunto)\b/,
  /\bte\s+(escribo|aviso|digo)\b/,
  /\bno\s+esta\s+(publicado|confirmado)\b/,
];

/** ¿Esta frase coincide con una clave de la lista? */
function mencionaClave(frasePlana, clave) {
  const k = aplanar(clave);
  if (!k) return false;
  // Para frases largas se busca la frase; para terminos de una palabra, la
  // palabra con limites, para no marcar "embarazo" dentro de otra palabra.
  if (k.includes(" ")) return frasePlana.includes(k);
  return new RegExp(`\\b${k}\\b`).test(frasePlana);
}

/**
 * ¿El texto afirma algo de la lista de prohibidos del producto?
 *
 * DOS LISTAS CON DOS REGLAS DISTINTAS, Y LA DIFERENCIA IMPORTA:
 *
 *   claimsProhibidos   -> frases que NO pueden aparecer nunca. "Cura los
 *                         cólicos" no se salva con ningun contexto.
 *
 *   sinDatoConfirmado  -> TEMAS sobre los que no se puede AFIRMAR. Mencionar
 *                         el tema para decir que no se sabe es correcto; es
 *                         justo lo que se le pide al bot que haga.
 *
 * Antes las dos listas se trataban igual, y eso bloqueaba la respuesta
 * correcta: el texto "La garantía te la confirmo con el equipo" contiene "la
 * garantia", que esta en sinDatoConfirmado, asi que se marcaba como claim
 * prohibido. Consecuencia real: cualquier borrador del modelo que manejara
 * bien una duda se descartaba, y el cliente recibia el texto seco de
 * respaldo. El filtro estaba castigando la honestidad.
 *
 * Se evalua FRASE POR FRASE, no sobre el texto entero: si no, un mensaje que
 * admite una cosa ("la garantía te la confirmo") podria colar una afirmacion
 * sobre otra ("y llega en dos días") amparandose en la palabra "confirmo" de
 * la frase anterior.
 */
function revisarClaims(texto, producto) {
  const prohibidos = (producto && producto.claimsProhibidos) || [];
  const temasSinDato = (producto && producto.sinDatoConfirmado) || [];
  if (!prohibidos.length && !temasSinDato.length) return { ok: true, encontrados: [] };

  const encontrados = [];
  const completo = aplanar(texto);

  // Los prohibidos se miran sobre el texto completo: una promesa partida en
  // dos frases sigue siendo una promesa.
  for (const claim of prohibidos) {
    if (mencionaClave(completo, claim)) encontrados.push(claim);
  }

  // LAS PROMESAS DE TIEMPO, POR PATRON Y NO POR FRASE EXACTA.
  const prometeTiempo = PROMESAS_DE_TIEMPO.find((re) => re.test(completo));
  if (prometeTiempo) encontrados.push("promesa de tiempo de respuesta");

  // Los temas sin dato, frase por frase.
  const frases = String(texto ?? "")
    .split(/[.!?\n]+/)
    .map((f) => aplanar(f))
    .filter(Boolean);

  for (const tema of temasSinDato) {
    for (const frase of frases) {
      if (!mencionaClave(frase, tema)) continue;
      const admite = ADMITE_NO_SABER.some((re) => re.test(frase));
      if (!admite) {
        encontrados.push(tema);
        break;
      }
    }
  }

  return { ok: encontrados.length === 0, encontrados: [...new Set(encontrados)] };
}

// --------------------------------------------------------------------------
// NO SE PROMETE CUANDO SE CONTESTA. Y SE COMPRUEBA POR PATRON.
//
// --------------------------------------------------------------------------
// POR QUE NO BASTA LA LISTA DE FRASES DEL CATALOGO
// --------------------------------------------------------------------------
//
// `claimsProhibidos` compara TEXTO EXACTO. Se le añadieron "te confirmo en
// un momento", "te respondo enseguida" y compañia... y esto fue lo que le
// llego a Marco DESPUES, desde su propio numero:
//
//   Marco  · "Buenas"
//   NOVIKA · "Déjame confirmarlo bien con el equipo y te escribo en un
//             momentico."
//
// "momentico" no estaba en la lista, y "te escribo" tampoco casaba con "te
// escribe". La lista tapaba las cuatro frases vistas, no el ERROR.
//
// El propio documento de traspaso lo avisaba: "estas dos ultimas se
// escaparon una vez por buscar la palabra exacta". Se arreglo el sintoma.
//
// En castellano colombiano hay infinitas formas: momentico, momentito,
// ratico, ratito, minuticos, ahorita, ya mismo. Cada conjugacion es otra
// variante. Una lista de frases nunca gana esa carrera.
//
// POR QUE IMPORTA: no hay nadie de guardia. Si una clienta escribe un
// domingo a las 11 de la noche, "en un momentico" es mentira, y la
// siguiente cosa que hace es esperar. Lo que SI es verdad -y tranquiliza
// igual- es que la pregunta queda anotada y responde una persona por aqui.
//
// ⚠️ Los PLAZOS DE ENTREGA no entran aqui: "1 a 3 dias habiles" sale del
// catalogo, es un dato aprobado y no promete una RESPUESTA inmediata.
// --------------------------------------------------------------------------
const INMEDIATEZ =
  "(?:enseguida|en\\s+seguida|ya\\s+mismo|ahora\\s+mismo|ahorita|de\\s+inmediato|inmediatamente|" +
  "en\\s+un\\s+(?:momento|momentico|momentito|rato|ratico|ratito|instante|segundo|segundito|minuto|minutico)|" +
  "en\\s+unos?\\s+(?:momentos?|minutos?|minuticos?|ratos?)|en\\s+breve|en\\s+nada)";

const RESPONDER_ALGO =
  "(?:te\\s+(?:escribo|escribimos|escribe|escriben|aviso|avisamos|avisa|avisan|contesto|contestamos|" +
  "contesta|contestan|respondo|respondemos|responde|responden|confirmo|confirmamos|confirma|confirman|" +
  "cuento|contamos|digo|decimos)|te\\s+l[oa]s?\\s+(?:confirmo|confirmamos|cuento|contamos|aviso|avisamos|digo|decimos))";

const PROMESAS_DE_TIEMPO = [
  // "te escribo en un momentico", "te confirmo enseguida"
  new RegExp(`\\b${RESPONDER_ALGO}\\b[^.!?]{0,40}\\b${INMEDIATEZ}\\b`),
  // "en un momentico te escribo", "ya mismo te confirmo"
  new RegExp(`\\b${INMEDIATEZ}\\b[^.!?]{0,40}\\b${RESPONDER_ALGO}\\b`),
  // "dame un momento y te confirmo": la misma promesa pedida al reves.
  new RegExp(`\\bdame\\s+un\\s+(?:momento|momentico|minuto|segundo|ratico)\\b`),
];

/** Formato de moneda colombiana. Solo para cifras ya calculadas. */
function pesos(n) {
  return `$${Number(n).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

/**
 * Lineas de condiciones -envio y cobro- que acompañan a un total.
 *
 * Salen de `cotizacion.condiciones`, que el cotizador copia del catalogo. Si
 * el producto no declara una condicion, NO se escribe nada: no hay texto por
 * defecto. Dos motivos concretos:
 *
 *   - "Envío incluido" dicho por costumbre, sobre un producto cuya politica
 *     es "fijo", es un flete que el cliente no espera pagar y una discusion
 *     en la puerta.
 *   - En contraentrega, si el mensaje NO dice que paga al recibir, el
 *     cliente puede entender que ya debe transferir. Decirlo es parte del
 *     cierre, no un adorno.
 *
 * Ninguna etiqueta puede traer cifras -el esquema lo impide-, asi que estas
 * lineas nunca activan el filtro de importes no autorizados.
 */
function lineasDeCondiciones(cotizacion) {
  const c = (cotizacion && cotizacion.condiciones) || null;
  if (!c) return [];

  const partes = [];
  // Solo cuando el envio va realmente incluido. Con envio > 0 ya se desglosa
  // arriba como una linea de importe, y repetirlo seria confuso.
  if (c.envioIncluido && !cotizacion.envio) partes.push("Envío incluido");
  if (c.pagoEtiqueta) partes.push(c.pagoEtiqueta);

  return partes.length ? [partes.join(" · ")] : [];
}

// --------------------------------------------------------------------------
// ENUMERAR EN CASTELLANO
//
// "nombre, ciudad y dirección" en vez de "nombre, ciudad, dirección". Es un
// detalle de una linea y es la diferencia entre un mensaje escrito por una
// persona y una lista de campos de formulario.
// --------------------------------------------------------------------------
function enumerar(lista, conjuncion = "y") {
  const xs = (lista || []).filter(Boolean);
  if (xs.length <= 1) return xs[0] || "";
  return `${xs.slice(0, -1).join(", ")} ${conjuncion} ${xs[xs.length - 1]}`;
}

function mayuscula(texto) {
  const t = String(texto || "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * Compone el mensaje final: une las piezas, arregla la mayuscula inicial y
 * pone UN emoji como maximo.
 *
 * Las piezas vienen en minuscula a proposito -"el cinturón te queda en..."-
 * para poder llevar delante una apertura de vendedor ("Claro que sí,"). La
 * mayuscula se decide aqui, cuando ya se sabe con que empieza el mensaje.
 */
function componer(partes, { emoji = null } = {}) {
  const texto = mayuscula(voz.unir(partes));
  return emoji ? voz.conEmoji(texto, emoji) : texto;
}

/**
 * La linea comercial: cuanto vale, con que condiciones.
 *
 * UNA sola frase para precio, envio y pago. Antes cada tema producia su
 * propia frase y "¿cuánto vale con envío?" devolvia tres oraciones seguidas
 * diciendo casi lo mismo. El cliente lee una linea, no un parrafo.
 *
 * Todas las cifras vienen de la cotizacion. Las condiciones vienen del
 * catalogo a traves de `cotizacion.condiciones`: si el producto no las
 * declara, no se escriben.
 */
function lineaComercial(cotizacion, producto, { asumida = false } = {}) {
  if (!cotizacion) return "";
  const nombre = (producto && producto.nombreCorto) || cotizacion.productoNombre || "el producto";
  const varias = cotizacion.cantidad > 1;

  // ----------------------------------------------------------------------
  // "UNA UNIDAD" CUANDO LA CANTIDAD ES ASUMIDA, NO DICHA
  //
  // Si el cliente todavia no dijo cuantas quiere, el precio que se le
  // informa es el de UNA, y hay que decirlo con esa palabra. Llamarlo "el
  // cinturón te queda en..." cuando pensaba pedir tres le hace creer que ese
  // es el total de su pedido, y la sorpresa aparece en el resumen.
  //
  // Cuando la cantidad SI la dijo, se usa el nombre del producto: repetir
  // "una unidad" a quien ya dijo que quiere una suena a formulario.
  // ----------------------------------------------------------------------
  const sujeto = varias ? voz.unidades(cotizacion.cantidad) : asumida ? "una unidad" : nombre;

  const condiciones = [];
  const c = cotizacion.condiciones || {};
  if (c.envioIncluido && !cotizacion.envio) condiciones.push("envío incluido");
  else if (cotizacion.envio > 0) condiciones.push(`envío ${pesos(cotizacion.envio)}`);
  if (c.pagoMetodo === "contraentrega") condiciones.push("pagas al recibir");

  const cola = condiciones.length ? `, con ${enumerar(condiciones)}` : "";
  // Sin mayuscula: esta frase puede ir detras de una apertura ("Claro que
  // sí, el cinturón te queda en..."). La decide `componer`.
  return `${sujeto} te ${varias ? "quedan" : "queda"} en ${pesos(cotizacion.total)}${cola}.`;
}

// --------------------------------------------------------------------------
// EL CLIENTE ACABA DE DAR UN DATO: HAY QUE CERRAR, NO INTERROGAR
//
// DE DONDE SALE: Marco vio a una clienta escribir "Palmira" y recibir
// "¿Cuántos quieres? Y para despachártelo me pasas la dirección." Sus
// palabras: "todo tosco".
//
// Y tenia razon por cuatro motivos a la vez: no acusaba recibo del dato que
// acababa de dar, no usaba "Palmira" para nada, disparaba dos preguntas
// sueltas, y sobre todo NO CERRABA.
//
// LO QUE BIKERPRO MIDIO SOBRE 1.815 COTIZACIONES REALES, y es el dato que
// mas pesa de toda su operacion:
//
//   como cerro el mensaje          veces   avanzaron
//   pidio los DATOS de despacho      473     50,7%   <- el mejor
//   pidio confirmar                  154     40,9%
//   pregunto algo abierto             87     25,3%
//   pregunto TALLA o COLOR         1.192     24,8%   <- el peor, y el mas usado
//
// Pedir los datos convirtio EL DOBLE que seguir preguntando. Y lo que mas
// se usaba era lo que peor funcionaba.
//
// LA DIFERENCIA CON BIKERPRO, que importa: alli la ciudad DESBLOQUEA el
// precio -el envio va por destino- asi que darla permite dar el total. Aqui
// el envio va incluido y el precio ya se dijo. Lo que se adapta es el
// MOVIMIENTO: quien escribe su ciudad esta comprando, y ese es el momento
// de pedir lo que falta de una, como parte normal del proceso.
//
// Se acusa recibo CON EL DATO EN LA MANO -"a Palmira te llega en 1 a 3 dias
// habiles"- porque repetirle su ciudad demuestra que se le leyo. Y el plazo
// ahi no es un adorno: es la pregunta que viene detras.
// --------------------------------------------------------------------------
function cerrarTrasElDato({ datosAportados, ciudadConfirmada, faltan, producto, cantidadInformada, yaSePidieron = false }) {
  const dioLaCiudad = (datosAportados || []).includes("ciudad");
  const partes = [];

  if (dioLaCiudad && ciudadConfirmada) {
    // El plazo DE SU CIUDAD: Bogota 1 a 2 dias habiles, el resto 1 a 3.
    const t = contestar.plazoDeEntrega(producto, ciudadConfirmada);
    partes.push(
      t && t.texto
        ? `¡Perfecto! A ${ciudadConfirmada} te llega en ${t.texto}.`
        : `¡Perfecto! Anoto ${ciudadConfirmada} para el envío.`
    );
  } else {
    partes.push("¡Perfecto, gracias!");
  }

  // Y TODO lo que falta en la MISMA pedida, no de a uno. Pedir un dato,
  // esperar, pedir el siguiente es lo que convierte una venta en un
  // formulario.
  partes.push(pedirLoQueFalta(faltan, { cantidadInformada, comoProceso: true, yaSePidieron }));
  return partes;
}

/**
 * EL ARRANQUE: que decirle a quien solo saluda.
 *
 * Un "hola" pelado no es una pregunta, asi que no hay nada que responder; y
 * tampoco es una señal de compra, asi que pedirle la direccion es atropellarlo.
 * Lo que corresponde es presentar el producto.
 *
 * Adelanta las dudas que mas se repiten -cuanto vale, como llega, como se
 * paga, de que talla y color es- para ahorrarle dos o tres mensajes. La
 * mecanica esta tomada de la referencia de BIKERPRO, donde el arranque fijo
 * existe justamente porque es el mensaje de mas trafico de la operacion y no
 * conviene improvisarlo. Los DATOS son los de NOVIKA: salen del catalogo.
 *
 * Termina sin pedir nada. Deja la puerta abierta y se calla.
 */
function arranque(cotizacion, producto, { asumida = false } = {}) {
  // ==========================================================================
  // EL PRIMER MENSAJE, REESCRITO EL 2026-10-09
  //
  // ⚠️ ES EL MENSAJE QUE MAS VECES SE ENVIA Y DONDE MAS GENTE SE CAIA.
  //
  // Medido en el panel: de 25 chats, 10 clientes recibieron este mensaje y
  // NO VOLVIERON A ESCRIBIR. Y el embudo lo confirma: 18 de 25 se quedan
  // justo despues de ver el producto.
  //
  // Terminaba en "Te paso las fotos para que lo veas 🙌". Eso no es un
  // cierre: es un aviso. El cliente lee, le llegan cinco fotos, y no hay
  // nada que contestar — asi que no contesta.
  //
  // Marco lo pidio explicito: "el mensaje siempre debe terminar con una
  // pregunta facil". Y la pregunta mas facil que existe aqui es la ciudad:
  //
  //   · se contesta con una palabra;
  //   · no compromete a nada, asi que no asusta;
  //   · nos deja el dato que necesitamos para el plazo de entrega;
  //   · y mueve la conversacion al Paso 2 del flujo de venta.
  //
  // Tambien entra la OFERTA DE DOS desde el primer mensaje. Antes solo salia
  // si la preguntaban o ante una objecion de precio, y es el unico escalon
  // donde bajarle el costo al cliente nos deja MAS plata: la segunda unidad
  // no paga publicidad otra vez.
  //
  // Las CIFRAS salen del cotizador, como siempre: `lineaComercial` y
  // `ofertaDeDos`. Aqui no se escribe ningun importe a mano.
  // ==========================================================================
  const partes = ["¡Hola!"];

  if (cotizacion) partes.push(lineaComercial(cotizacion, producto, { asumida }));

  // La pareja, de entrada. Una sola frase y con la cifra puesta: ofrecer
  // "te paso el precio de dos" obliga a un turno mas.
  //
  // ⚠️ SOLO SI HAY COTIZACION, Y NO ES UNA FORMALIDAD.
  //
  // Sin cotizacion -producto en borrador, o antes de poder cotizar- NO puede
  // aparecer NINGUNA cifra: no hay ningun importe autorizado en ese turno, y
  // una cifra suelta ahi es justo lo que `revisarImportes` existe para
  // cazar. Lo destapo la prueba "SIN cotización, ningún texto nombra una
  // cifra", que es de las que protegen de cobrar mal.
  const dos = cotizacion ? ofertaDeDosAutorizada(producto) : null;
  if (dos) partes.push(`Si llevas dos, te quedan en ${contestar.pesos(dos.total)} las dos juntas.`);

  // UNA caracteristica, no dos: el mensaje ya trae precio, condiciones y
  // oferta. Mas que eso es el muro de texto que la gente deja de leer.
  const rasgos = ((producto && producto.caracteristicasAutorizadas) || []).slice(0, 1);
  if (rasgos.length) partes.push(`${mayuscula(enumerar(rasgos))}.`);

  if (producto && (producto.imagenes || []).length) partes.push("Te mando unas fotos.");

  // Y EL CIERRE, que es el cambio que importa.
  partes.push("¿Para qué ciudad sería? Así te digo cuánto se demora.");

  return componer(partes, { emoji: "compra" });
}

/**
 * La oferta de dos, solo si el cotizador dice que conviene.
 *
 * Envoltorio sobre `contestar.ofertaDeDos` para no repetir el guardia en
 * cada sitio. Si la tabla de precios cambia y la pareja deja de convenir, la
 * frase desaparece sola: nunca se afirma un ahorro que no existe.
 */
function ofertaDeDosAutorizada(producto) {
  try {
    return contestar.ofertaDeDos(producto);
  } catch {
    return null;
  }
}

// ==========================================================================
// MENSAJES QUE NO SON TEXTO
//
// EL DEFECTO, MEDIDO EN DOS CHATS REALES: los clientes que mandan stickers,
// emojis o audios recibian "Perdón, no quiero repetirme. Dime concretamente
// qué necesitas" — y se iban los dos.
//
// Un audio no es un cliente confuso: es un cliente que habla en vez de
// escribir, que en Colombia es lo normal. Y un sticker es alguien
// reaccionando, no alguien atascado.
//
// Marco dio los textos; aqui se respetan con un solo cambio: NO se dice
// "enseguida". Es una promesa de tiempo y esta en `claimsProhibidos` desde
// que el bot prometio "te confirmo enseguida" a las dos de la mañana. "De
// una" dice lo mismo, es mas colombiano, y no promete a nadie de guardia.
// ==========================================================================
const SIN_TEXTO = {
  audio: "¡Uy! Por aquí no alcanzo a escuchar audios 🙈 ¿Me lo escribes y te ayudo de una?",
  video: "¡Uy! Por aquí no alcanzo a ver videos 🙈 ¿Me lo escribes y te ayudo de una?",
  image: "¡Gracias! 🙌 ¿Me cuentas por escrito en qué te ayudo?",
  document: "¡Gracias! 🙌 ¿Me cuentas por escrito en qué te ayudo?",
};

/**
 * Respuesta a un mensaje sin texto utilizable.
 *
 * @param {string|null} tipoDeMedia  audio, image, sticker, video, document
 * @param {string[]} faltan          para retomar el paso pendiente
 * @returns {string|null} null si este mensaje SI tiene texto que contestar
 */
function respuestaSinTexto(tipoDeMedia, faltan = []) {
  if (!tipoDeMedia) return null;
  if (SIN_TEXTO[tipoDeMedia]) return SIN_TEXTO[tipoDeMedia];

  // Sticker, emoji o reaccion: se responde con calidez y se retoma el paso
  // donde iba el pedido. Marco lo pidio con este ejemplo exacto:
  // "😊 ¿Para qué ciudad sería tu cinturón?"
  if (tipoDeMedia === "sticker") return `😊 ${siguientePasoCorto(faltan)}`;
  return null;
}

/**
 * Retoma el pedido donde iba, con una frase completa.
 *
 * La usa el cerebro como ULTIMA RED cuando el texto saldria identico al
 * mensaje anterior. Marco lo prohibio sin excepciones -"enviar el mismo
 * mensaje dos veces seguidas"- y su caso 12 es un "Hola" seguido de un
 * "Hola?" recibiendo el mismo saludo calcado.
 *
 * Lo que hace falta ahi no es otra forma de saludar: es retomar el paso del
 * pedido, que es lo que la conversacion necesita para avanzar.
 */
function retomarElPaso(faltan = [], nombreCliente = null) {
  // El nombre llega YA CONFIRMADO desde el cerebro, que es el unico que
  // sabe si lo esta. El redactor no toca la ficha: llamar a alguien por un
  // nombre que nadie valido es peor que no nombrarlo.
  const pila = voz.nombreDePila(nombreCliente);
  return voz.unir([pila ? `¡Claro, ${pila}!` : "¡Claro!", siguientePasoCorto(faltan)]);
}

/**
 * El siguiente paso, en UNA pregunta corta.
 *
 * Para los mensajes donde no hay nada que contestar -un sticker, un emoji-
 * pero si hay una conversacion que mover. Pide UN dato, el primero que
 * falte, en vez de los cuatro: a quien manda una carita no se le contesta
 * con un formulario.
 */
function siguientePasoCorto(faltan = []) {
  const lista = Array.isArray(faltan) ? faltan : [];
  if (lista.includes("ciudad")) return "¿Para qué ciudad sería tu cinturón?";
  if (lista.includes("direccion")) return "¿A qué dirección te lo mandamos?";
  if (lista.includes("nombre")) return "¿A nombre de quién lo dejo?";
  if (lista.includes("telefono")) return "¿Me pasas tu número de celular para la transportadora?";
  if (lista.includes("cantidad")) return "¿Lo quieres de 1 o de 2?";
  return "¿Te lo aparto?";
}

/**
 * Lo que falta para despachar, pedido como lo pediria una persona.
 *
 * `cantidadInformada` evita el peor efecto de pedir la cantidad: si la
 * clienta pregunto "¿cuánto me salen dos?" y se le acaba de responder por
 * dos, volver a preguntarle cuantas quiere es no haberla leido.
 */
function pedirLoQueFalta(faltan, { cantidadInformada = null, comoProceso = false, yaSePidieron = false } = {}) {
  const nombres = {
    nombre: "tu nombre completo",
    // "TU NUMERO DE CELULAR", no "un numero de contacto".
    //
    // Marco lo pidio asi -"siempre requerir el numero de celular para los
    // pedidos"- y la palabra importa: "un numero de contacto" admite un
    // fijo, y la transportadora llama al celular. Ademas es la palabra que
    // usa el cliente.
    //
    // El dato NO es opcional: `REQUERIDOS_PARA_DESPACHAR` lo exige, asi que
    // un pedido sin celular no se construye. Normalmente llega solo desde
    // WhatsApp; se PREGUNTA cuando no hay, que es el caso de los clientes
    // con nombre de usuario (BSUID `CO.…`) — tres de los quince chats del
    // 07-oct eran de esos.
    telefono: "tu número de celular",
    ciudad: "la ciudad",
    departamento: "el departamento",
    direccion: "la dirección",
    referencia: "un punto de referencia",
  };

  const pide = (faltan || []).filter((f) => f !== "cantidad").map((f) => nombres[f] || f);
  // Si ya se le informo el precio de N unidades, la cantidad esta dicha: lo
  // que falta es que confirme, no que la repita.
  const yaSeSabeCuantas = Number(cantidadInformada) > 1;
  const faltaCantidad = (faltan || []).includes("cantidad") && !yaSeSabeCuantas;

  // ----------------------------------------------------------------------
  // "COMO PROCESO": la pedida suena a tramite normal, no a interrogatorio
  //
  // Es la forma que BIKERPRO midio como la mejor: todo junto, en una sola
  // pedida, y presentado como el paso que falta para despachar — no como
  // una lista de requisitos.
  //
  // VA ANTES QUE `yaSeSabeCuantas` A PROPOSITO. Al reves, una venta de dos
  // unidades se saltaba este camino y repetia siempre la misma frase:
  //
  //   clienta: "soy Marco y vivo en Palmira, mandame dos"
  //   bot:     "Si te llevas las dos, me pasas la dirección..."
  //   clienta: "Calle 45 # 23-10, mi celular es 3058742138"
  //   bot:     "Si te llevas las dos, me pasas la dirección..."   <- igual
  //
  // Ese estribillo palabra por palabra es lo que Marco veia como un robot.
  // ----------------------------------------------------------------------
  // ----------------------------------------------------------------------
  // NO SE PROMETE DESPACHO, Y MENOS "HOY"
  //
  // Todas estas frases decian "para despachártelo hoy", "te las despacho de
  // una", "¿te lo despacho?". Marco lo paro en seco: despachar hoy exige
  // horario, disponibilidad y capacidad de despacho CONFIRMADOS, y no hay
  // ninguno de los tres en el catalogo. El bot estaba prometiendo una
  // operacion que no controla.
  //
  // Y es la misma clase de promesa que ya esta en `claimsProhibidos` para
  // el modelo —"te lo despacho hoy mismo"— que el codigo se saltaba porque
  // los claims solo se revisan sobre el borrador de la IA. El candado
  // vigilaba al modelo mientras el determinista decia lo mismo.
  //
  // "Preparar tu pedido" es lo que SI hacemos y no compromete a nadie:
  // tomamos los datos y lo dejamos listo. Cuando salga, se avisa.
  // ----------------------------------------------------------------------
  const invitar = yaSeSabeCuantas ? INVITAR_PLURAL : INVITAR;

  if (comoProceso) {
    const todo = [...pide];
    if (faltaCantidad) todo.push("si quieres uno o dos");
    if (!todo.length) return invitar;
    return `Para preparar tu pedido me pasas ${enumerar(todo)} 🙌`;
  }

  if (yaSeSabeCuantas) {
    return pide.length
      ? `Si te llevas las dos, me pasas ${enumerar(pide)} y lo dejo listo 🙌`
      : invitar;
  }

  if (faltaCantidad && !pide.length) return "¿Cuántos quieres?";
  if (faltaCantidad) return `¿Cuántos quieres? Y para preparar tu pedido me pasas ${enumerar(pide)} 🙌`;
  if (!pide.length) return invitar;

  // ----------------------------------------------------------------------
  // NO SE PIDE DOS VECES CON LAS MISMAS PALABRAS
  //
  // EL BUCLE QUE VIO MARCO, literal, del 08-oct:
  //
  //   bot:     "...me pasas la dirección"
  //   clienta: "Barrio buenos aires"
  //   bot:     "Para preparar tu pedido me pasas la dirección"   <- IGUAL
  //   clienta: "No entiendo"
  //
  // Ella SI contesto. Lo que paso es que su direccion no traia numero -en
  // un pueblo la direccion es el barrio- y el extractor la descarto. Pero
  // repetir la peticion palabra por palabra no le dice QUE le falta: le
  // dice que no la leimos. Con razon escribio "No entiendo".
  //
  // La segunda vez se pide distinto y concreto: lo que de verdad necesita
  // el mensajero para encontrarla.
  // ----------------------------------------------------------------------
  if (yaSePidieron && pide.length === 1 && pide[0] === nombres.direccion) {
    return (
      "Me falta poder ubicarte bien: dime el barrio y, si tienes, la calle con el número, " +
      "o un punto de referencia (una tienda, una esquina, el color de la casa) 🙌"
    );
  }

  return `Para preparar tu pedido me pasas ${enumerar(pide)} 🙌`;
}

// --------------------------------------------------------------------------
// LOS TEMAS QUE SE RESPONDEN CON LA LINEA COMERCIAL
//
// Precio, envio y pago son el mismo hecho mirado de tres formas, y los tres
// los contesta `lineaComercial`. Se agrupan para no decir tres veces lo
// mismo en el mismo mensaje.
// --------------------------------------------------------------------------
const TEMAS_COMERCIALES = [preguntas.TEMAS.PRECIO, preguntas.TEMAS.ENVIO, preguntas.TEMAS.PAGO];

// --------------------------------------------------------------------------
// EL CIERRE QUE INVITA SIN PRESIONAR
//
// Vive en UNA constante porque estaba escrito a mano en tres sitios, y al
// ponerle el emoji dos de ellos se quedaron sin el: el mensaje de "¿cuánto
// vale?" seguia acabando en seco. Es el mismo defecto de las dos listas de
// "pregunta de precio" separadas, en pequeño.
//
// Lleva emoji porque es la frase que CIERRA la mayoria de los mensajes de
// venta. El segundo emoji -el del tema- lo coloca `voz.conEmoji` al final de
// la primera frase, nunca pegado a este.
// --------------------------------------------------------------------------
/**
 * Para quien dijo algo que no es una pregunta ni una compra.
 *
 * "Me gusta", "A ve r", "Por favor", un sticker. Interes o ruido, pero no un
 * "lo quiero" — y antes los cuatro recibian los cuatro campos del
 * formulario.
 *
 * Da DOS salidas y las dos son faciles: seguir preguntando o avanzar. Quien
 * esta mirando necesita exactamente eso, no un interrogatorio.
 */
const RETOMAR = "¿Te lo aparto, o quieres que te cuente algo más de cómo funciona?";

const INVITAR = "¿Quieres que te ayude a pedirlo? 🙌";
const INVITAR_PLURAL = "¿Quieres que te ayude a pedirlos? 🙌";

/**
 * Los importes de la oferta de dos, para el filtro de importes.
 *
 * La respuesta a una objecion de precio ofrece la pareja CON SU PRECIO, y
 * esa cifra sale del cotizador. Si no se autoriza, `revisarImportes`
 * bloquearia el borrador del modelo por repetir un precio que el propio bot
 * acaba de decir — y el bloqueo se registraria como "importe no
 * autorizado", que es exactamente la alarma que NO debe sonar por algo
 * correcto.
 */
function importesDeLaOfertaDeDos(producto) {
  const dos = contestar.ofertaDeDos(producto);
  return (dos && dos.importesAutorizados) || [];
}

/**
 * Que esta haciendo el cliente en este turno.
 *
 * Vive aqui y se exporta para que el cerebro y el texto usen LA MISMA
 * decision. Si cada uno la calculara por su cuenta, el texto podria pedir los
 * datos y el cerebro anotar que no los pidio -o al reves-, y la conversacion
 * siguiente arrancaria con una memoria que no corresponde a lo que el cliente
 * leyo.
 */
function analizarTurno(mensajeCliente) {
  const lectura = preguntas.leer(mensajeCliente);
  const preguntoComercial = lectura.temas.some((t) => TEMAS_COMERCIALES.includes(t));
  return {
    lectura,
    preguntoComercial,
    // Preguntar no es comprar: si solo esta averiguando algo que no es
    // precio, envio ni pago, no se le piden los datos de entrega.
    soloAveriguando: lectura.pregunta && !lectura.compra && !preguntoComercial,
  };
}

/**
 * Texto determinista segun la situacion.
 *
 * NO contiene ni un dato comercial escrito a mano: todo sale de la
 * cotizacion o del catalogo. Si manana cambia un precio, aqui no se toca
 * nada.
 *
 * LA ESTRUCTURA DE TODO MENSAJE DE VENTA, Y EL ORDEN ES EL PUNTO:
 *
 *   1. saludo .................. solo la primera vez
 *   2. la respuesta a lo que preguntó .... PRIMERO, siempre
 *   3. el siguiente paso ....... solo si procede
 *
 * El paso 2 antes del 3 es la correccion de fondo. La conversacion que
 * provoco este cambio:
 *
 *   clienta: "Quiero un cinturón. ¿Cuánto vale con envío?"
 *   bot:     "Para continuar me falta la ciudad, la dirección de entrega."
 *
 * El bot TENIA el precio calculado -49.900, envio incluido- y contesto
 * pidiendo la direccion. Pedirle los datos a quien acaba de preguntar el
 * precio es la forma mas rapida de perder la venta.
 *
 * Y el paso 3 es CONDICIONAL, que es la otra mitad. Si el turno es una duda
 * informativa -garantia, medidas, material- se responde la duda y NADA MAS.
 * Documentado en la referencia de BIKERPRO: contestar cada duda pidiendo
 * ademas nombre, celular y direccion hace que el cliente que estaba
 * averiguando se sienta perseguido y se vaya.
 *
 * @param {object} e
 * @param {string} [e.mensajeCliente] el texto del turno, para saber que pregunto
 * @param {object} [e.memoria] {saludado, datosPedidos, pasoPropuesto}
 */
function textoDeterminista({
  situacion,
  // El tipo de media del mensaje del cliente: audio, image, sticker…
  // Un audio o un sticker no se contestan con el flujo de venta normal.
  tipoDeMedia = null,
  // Cuantas veces se ha contestado ya cada tema en esta conversacion.
  // Sirve para no soltar el mismo parrafo dos veces ante la misma duda
  // reformulada. Lo lleva el cerebro, en la conversacion persistida.
  vecesPorTema = {},
  // Cuantas veces ha objetado el precio en esta conversacion. Viaja desde
  // el cerebro, que es quien lleva la cuenta en la conversacion persistida.
  vezDeLaObjecion = 1,
  // El motivo del escalado, cuando hay uno. Cambia SOLO el texto de la rama
  // "escalado": un reclamo de garantia, un cliente enfadado y alguien que
  // pide hablar con una persona no se contestan con la misma frase.
  motivoEscalado = null,
  cotizacion = null,
  cotizacionInformativa = null,
  faltan = [],
  opciones = [],
  pedido = null,
  producto = null,
  mensajeCliente = "",
  memoria = {},
  nombreCliente = null,
  datosAportados = [],
  ciudadConfirmada = null,
  datosDeEntrega = null,
  cantidadSinTarifa = null,
  fotosYaEnviadas = false,
  pideReenvioDeFotos = false,
  huboSenalDeCompra = false,
}) {
  // ------------------------------------------------------------------
  // UN AUDIO O UN STICKER SE CONTESTAN ANTES DE TODO LO DEMAS
  //
  // Va primero porque el resto de la funcion razona sobre el TEXTO del
  // cliente, y aqui no hay texto. Sin esta rama, un audio caia en "no
  // pregunto nada" y recibia el formulario de datos — o, a la segunda, el
  // "no quiero repetirme" que se llevo a dos clientes por delante.
  // ------------------------------------------------------------------
  const sinTexto = respuestaSinTexto(tipoDeMedia, faltan);
  if (sinTexto && !String(mensajeCliente || "").trim()) return sinTexto;

  const { lectura, preguntoComercial, soloAveriguando } = analizarTurno(mensajeCliente);

  // El saludo va UNA vez por conversacion. Repetir "¡Hola!" en cada mensaje
  // es la marca mas reconocible de un bot.
  const saludo = !memoria.saludado && (lectura.saludo || !memoria.datosPedidos) && lectura.saludo ? "¡Hola!" : "";

  switch (situacion) {
    case "producto_desconocido":
      return componer([saludo, "Cuéntame qué producto te interesa y te ayudo con el precio y el envío."]);

    // ----------------------------------------------------------------------
    // PRODUCTO EN BORRADOR: se sabe cual es, pero no tiene ficha.
    //
    // Este texto es DETERMINISTA y no pasa por el modelo a proposito. El
    // cliente acaba de preguntar un precio; es justo el momento en el que un
    // modelo rellena el hueco con una cifra plausible. Aqui no hay hueco que
    // rellenar: no se nombra ningun importe, ningun plazo y ninguna
    // caracteristica, porque ninguno esta aprobado.
    //
    // Y NO vuelve a preguntar que producto es. Preguntar lo que el cliente ya
    // respondio es la forma mas rapida de que deje de escribir.
    // ----------------------------------------------------------------------
    case "producto_en_borrador": {
      const nombre = (producto && (producto.nombreCorto || producto.nombre)) || null;
      const lo = nombre ? nombre : "ese producto";
      // Mismo candado del 10-oct: si ya las tiene, la deduplicacion no las
      // reenvia y prometerlas es prometer algo que no llega.
      const hayFotos = Boolean(producto && (producto.imagenes || []).length) && !fotosYaEnviadas;
      return componer([
        saludo,
        `¡Claro que sí! ${mayuscula(lo)} lo tenemos.`,
        hayFotos ? "Te paso las fotos para que lo veas." : "",
        "El precio y el envío te los confirma una persona del equipo: todavía no los tengo publicados y no quiero darte un dato equivocado.",
      ]);
    }

    case "producto_ambiguo":
      return opciones.length
        ? `¿Cuál te interesa, ${enumerar(opciones, "o")}?`
        : "¿Me confirmas cuál producto te interesa?";

    case "cotizacion": {
      // SIN PROMETER PLAZO. Decia "Dame un momento y te confirmo", que es
      // la misma promesa que el filtro bloquea en el borrador del modelo:
      // el candado vigilaba a la IA mientras el codigo decia lo mismo. No
      // hay nadie de guardia, asi que "un momento" puede ser la noche
      // entera. Lo cazo la prueba de esta bateria.
      if (!cotizacion) return "Déjame revisarlo bien y te confirmo por aquí 🙌";
      // Pasa por `componer` como todos: `lineaComercial` devuelve la frase
      // en minuscula para poder llevar una apertura delante, y este caso la
      // usaba directa. La prueba que recorre todas las situaciones lo cazo.
      return componer([voz.apertura(lectura.temas), lineaComercial(cotizacion, producto)], {
        emoji: voz.claveDeEmoji(lectura.temas) || "atencion",
      });
    }

    // ----------------------------------------------------------------------
    // FALTAN DATOS: el caso mas frecuente, y donde estaba el defecto
    // ----------------------------------------------------------------------
    case "faltan_datos": {
      // ------------------------------------------------------------------
      // LA COTIZACION REAL TAMBIEN SIRVE PARA INFORMAR EL PRECIO
      //
      // AQUI ESTABA EL DEFECTO QUE REPORTO MARCO. El texto solo miraba
      // `cotizacionInformativa`, que se calcula unicamente cuando falta la
      // cantidad. Con "Quiero un cinturón. ¿Cuánto vale con envío?" la
      // cantidad SE IDENTIFICA -es "un"-, asi que:
      //
      //   · `faltan` = ["ciudad","direccion"]  -> sin "cantidad"
      //   · no se calculaba informativa        -> quedaba null
      //   · PERO `cotizacion` ya traia el total de 49.900
      //
      // ...y el mensaje salia sin precio. La condicion
      // `faltan.includes("cantidad")` no estaba mal para lo que hacia; el
      // error fue creer que la informativa era la UNICA fuente de precio
      // para este texto. Con la cantidad conocida hay algo mejor: la
      // cotizacion de verdad.
      // ------------------------------------------------------------------
      const cot = cotizacion || cotizacionInformativa;

      // Solo saludo, y es la primera vez: se presenta el producto y no se le
      // pide nada. Ver `arranque`.
      if (lectura.soloSaludo && !memoria.saludado) {
        return arranque(cot, producto, { asumida: !cotizacion && Boolean(cotizacionInformativa) });
      }

      // ------------------------------------------------------------------
      // UN SALUDO EN UN CHAT VIEJO SE CONTESTA. NO SE CALLA.
      //
      // EL DEFECTO MAS GRAVE DE TODA LA SESION, y era el que Marco veia en
      // su chat de pruebas sin poder explicarlo:
      //
      //   Marco  · "Hola buenas noches"
      //   NOVIKA · (NADA)        bloqueo=texto_vacio
      //
      // El bot no estaba "plano": estaba MUDO. Y no era que los cambios no
      // llegaran a su chat —llegaban— sino justo lo contrario: su chat
      // tiene toda la memoria acumulada, y cada marcador suprime una parte
      // del mensaje para no repetirse:
      //
      //   saludado        -> no se presenta el producto
      //   precioInformado -> no se dice el precio
      //   pasoPropuesto   -> no se deja la puerta abierta
      //
      // Cada supresion es correcta por separado. Las tres juntas, sobre un
      // saludo -que no trae temas ni señal de compra- dejan el mensaje sin
      // UNA SOLA frase, y el emisor lo bloquea por vacio.
      //
      // Le pasa a cualquier cliente que vuelva a saludar al dia siguiente,
      // que es de los momentos mas valiosos que hay: alguien que ya nos
      // conoce y vuelve. Se le contestaba con silencio.
      //
      // La rama `ya_confirmado` SI lo tenia resuelto. Esta no.
      // ------------------------------------------------------------------
      if (lectura.soloSaludo) {
        const quien = voz.nombreDePila(nombreCliente);
        return componer([quien ? `¡Hola, ${quien}!` : "¡Hola!", "¿En qué te puedo ayudar?"], {
          emoji: "saludo",
        });
      }

      // ------------------------------------------------------------------
      // A QUIEN DA LAS GRACIAS NO SE LE PIDE LA DIRECCION
      //
      // Estaba en la lista de defectos conocidos y sin arreglar, y Marco lo
      // volvio a ver probando desde su numero el 08-oct:
      //
      //   Marco · "Gracias"
      //   bot   · "¿Cuántos quieres? Y para preparar tu pedido me pasas la
      //            dirección"
      //
      // Un "gracias" no es una señal de compra ni una pregunta: es cortesia,
      // y muchas veces un cierre de conversacion. Se responde con cortesia y
      // se deja la puerta abierta UNA vez, sin pedir nada.
      // ------------------------------------------------------------------
      // ------------------------------------------------------------------
      // SE LO ESTA PENSANDO: NO SE INSISTE
      //
      // "ahí le aviso" recibia "para preparar tu pedido me pasas tu nombre
      // completo y la dirección": justo la insistencia que espanta a quien
      // esta dudando.
      //
      // La regla de BIKERPRO para esta intencion es explicita: no insistir
      // con el mismo mensaje ni inventar urgencia. Lo que funciona es
      // dejar algo concreto y sin costo de decidir — y aqui lo hay, porque
      // paga al recibir.
      // ------------------------------------------------------------------
      if (lectura.seLoPiensa) {
        const partesP = ["¡Claro, sin afán!"];
        if (cot && cot.condiciones && cot.condiciones.pagoMetodo === "contraentrega") {
          partesP.push("Y recuerda que pagas cuando lo recibes, así que no arriesgas nada.");
        }
        partesP.push("Aquí estoy cuando quieras.");
        return componer(partesP, { emoji: "atencion" });
      }

      if (lectura.soloAgradece) {
        const quien = voz.nombreDePila(nombreCliente);
        return componer(
          [
            quien ? `¡Con gusto, ${quien}!` : "¡Con gusto!",
            memoria.pasoPropuesto ? "Cualquier cosa me escribes por aquí." : "¿Te lo aparto?",
          ],
          { emoji: "saludo" }
        );
      }

      const partes = [];
      if (saludo) partes.push(saludo);

      // ------------------------------------------------------------------
      // RECONOCER ANTES DE RESPONDER
      //
      // Marco: "responde como muy plano, muy robot, muy seco". La causa
      // concreta era que TODA respuesta empezaba con el dato -"Tiene
      // garantía de 1 mes", "La correa es graduable"- y una persona que
      // vende empieza reconociendo lo que le preguntaron.
      //
      // La apertura sale del TEMA, asi que es estable -la misma pregunta
      // abre igual- y a la vez distinta entre preguntas distintas, que es
      // lo que rompe la monotonia sin hacer el bot impredecible.
      // ------------------------------------------------------------------
      if (!saludo) partes.push(voz.apertura(lectura.temas));

      // La cantidad es ASUMIDA cuando no hay cotizacion real: ahi el precio
      // que se informa es el de una unidad, y hay que decirlo con esa
      // palabra para que nadie lo lea como el total de su pedido.
      const asumida = !cotizacion && Boolean(cotizacionInformativa);

      // ---- 1.5 PIDIO INFORMACION: SE LE CUENTA, Y NO SE LE PIDE NADA ----
      //
      // El primer mensaje de un cliente de publicidad era exactamente este,
      // y recibia una peticion de nombre, ciudad y direccion. Lo que pide es
      // que le cuenten: se presenta el producto con sus condiciones -las del
      // catalogo, por el cotizador- y se deja la puerta abierta a preguntar.
      //
      // Es el mismo texto del arranque, y a proposito: ya esta redactado,
      // probado, y menciona las fotos (que el cerebro manda al verlo). Un
      // texto nuevo aqui seria otra frase que mantener en dos sitios.
      if (lectura.pideInformacion && !lectura.compra) {
        return arranque(cot, producto, { asumida });
      }

      // ---- 2. RESPONDER LO QUE PREGUNTO ----
      //
      // PREGUNTA POR UNA CANTIDAD QUE NO TIENE TARIFA.
      //
      // La tabla cubre 1 y 2. A "¿cuánto cuestan tres?" esto contestaba
      // "una unidad te queda en $49.900" — el precio de UNA a una pregunta
      // por TRES. Es justo el error que no se puede cometer: la clienta
      // puede leerlo como que tres le salen a 49.900.
      //
      // No se interpola -extrapolar el tercer escalon seria inventar un
      // descuento que nadie aprobo- y tampoco se contesta por otra
      // cantidad. Se dice que ese precio lo confirma una persona, y queda
      // la tarea. Es la unica respuesta honesta que no pierde la venta.
      if (cantidadSinTarifa) {
        partes.push(
          `el precio por ${voz.unidades(cantidadSinTarifa)} no lo tengo aprobado todavía. ` +
            `Lo dejo anotado para el equipo y te confirman por aquí: no quiero darte una cifra equivocada.`
        );
        return componer(partes, { emoji: "atencion" });
      }

      if (preguntoComercial) {
        if (cot) {
          partes.push(lineaComercial(cot, producto, { asumida }));
        } else {
          // ----------------------------------------------------------------
          // SIN COTIZACION NO SE SABE EL IMPORTE. EL RESTO SI SE SABE.
          //
          // Esto era un `loConfirmo("El precio")` para CUALQUIER pregunta
          // comercial, y costo una venta el 08-oct:
          //
          //   clienta: "Algo contra entrega"
          //   bot:     "el precio no te lo quiero decir a medias..."
          //
          // Ni contesto lo que pregunto -el metodo de pago, que esta
          // aprobado en la ficha- ni era verdad, porque el bot le habia
          // dicho el precio dos mensajes antes.
          //
          // El envio y el pago son POLITICAS: las contesta el catalogo sin
          // cotizar. Solo el PRECIO necesita una cifra, y solo el precio
          // admite no saberse.
          // ----------------------------------------------------------------
          const comerciales = lectura.temas.filter((t) => TEMAS_COMERCIALES.includes(t));
          const politicas = contestar.aTemas(
            comerciales.filter((t) => t !== preguntas.TEMAS.PRECIO),
            { producto, cotizacion: null, vezDeLaObjecion, vecesPorTema, fotosYaEnviadas, ciudadConfirmada },
            { maximo: 2 }
          );
          if (politicas.texto) partes.push(politicas.texto);
          if (comerciales.includes(preguntas.TEMAS.PRECIO)) {
            partes.push(contestar.loConfirmo("El precio", "lo"));
          }
        }
      }

      // Las demas dudas -garantia, medidas, color, material...- las responde
      // el catalogo. Van despues del precio porque el precio es lo que se
      // pregunta primero cuando se preguntan las dos cosas.
      const otros = lectura.temas.filter(
        (t) => !TEMAS_COMERCIALES.includes(t) && t !== preguntas.TEMAS.FOTOS
      );
      // `yaDijoLasCondiciones`: si arriba entro la linea comercial, el
      // mensaje YA dice "con envio incluido y pagas al recibir". La
      // respuesta a la objecion de precio usa esas dos condiciones como
      // argumento, y sin este aviso las repetia en el mismo mensaje.
      const resto = contestar.aTemas(
        otros,
        { producto, cotizacion: cot, yaDijoLasCondiciones: Boolean(preguntoComercial && cot), vezDeLaObjecion, vecesPorTema, fotosYaEnviadas, ciudadConfirmada },
        { maximo: 2 }
      );
      if (resto.texto) partes.push(resto.texto);

      // ---- PIDIO FOTOS ----
      //
      // El tema FOTOS esta excluido de `aTemas` -las fotos se MANDAN, no se
      // describen- y se quedaba sin frase ninguna. A "¿me mandas fotos?" el
      // mensaje entero era su apertura:
      //
      //   clienta: "me mandas fotos?"
      //   bot:     "¡Claro!"
      //
      // Y encima sin fotos, porque ya se habian mandado al saludar y la
      // deduplicacion -con razon- no reenvia cinco imagenes. El resultado
      // es un "¡Claro!" suelto que parece que el bot se colgo.
      //
      // La deduplicacion no se toca; lo que faltaba era decirlo.
      //
      // SOLO SI EL PRODUCTO TIENE IMAGENES. Prometer fotos que no existen
      // deja al cliente esperando algo que no va a llegar, y es un candado
      // que ya estaba probado: la prueba lo cazo en cuanto añadi la frase.
      const tieneImagenes = Boolean(producto && (producto.imagenes || []).length);
      if (pideReenvioDeFotos && tieneImagenes) {
        // Dijo que no le llegaron. Se reenvian de verdad -el cerebro fuerza
        // la deduplicacion- asi que el texto lo acompaña en vez de volver a
        // ofrecer lo que ya esta pasando.
        partes.push("te las mando otra vez ahora mismo.");
      } else if (lectura.temas.includes(preguntas.TEMAS.FOTOS) && tieneImagenes) {
        partes.push(
          fotosYaEnviadas
            ? "te las mandé aquí arriba; si no te cargaron, dime y te las paso otra vez."
            : "te paso las fotos para que lo veas bien."
        );
      }

      // Si no pregunto nada y todavia no sabe el precio, se le dice. Es la
      // primera cosa que querria saber.
      if (!preguntoComercial && !resto.texto && cot && !memoria.precioInformado) {
        partes.push(lineaComercial(cot, producto, { asumida }));
      }

      // ---- 2.5 SI ACABA DE DAR UN DATO, SE CIERRA ----
      //
      // Va antes que el resto de las ramas porque aportar un dato de entrega
      // es la señal mas fuerte de que la venta avanza: mas que una pregunta
      // y mas que un "me interesa".
      // ------------------------------------------------------------------
      // PERO DAR UN DATO NO ES ACEPTAR UNA COMPRA
      //
      // EL CASO REAL: un cliente pidio informacion y respondio "Palmira".
      // El bot lo leyo como que avanzaba la venta y pidio el resto:
      //
      //   cliente: "Palmira"
      //   bot:     "¡Perfecto! A Palmira te llega en 1 a 3 días hábiles.
      //             Para preparar tu pedido me pasas tu nombre completo, la
      //             dirección y si quieres uno o dos 🙌"
      //
      // Marco: "dar una ciudad no equivale a aceptar una compra". Y tiene
      // razon: muchas veces la ciudad se da para saber si LLEGA alli, que
      // es una pregunta, no un paso de la venta.
      //
      // ESTO NO DESHACE EL CIERRE, QUE SIGUE SIENDO LO QUE MAS CONVIERTE
      // (50,7% frente a 24,8% en los datos de BIKERPRO). Lo que cambia es
      // la condicion: hace falta que el cliente haya mostrado intencion de
      // comprar ALGUNA VEZ en la conversacion. Quien dijo "lo quiero" y
      // luego escribe su ciudad esta comprando; quien pidio informacion y
      // escribe su ciudad esta preguntando si le llega.
      //
      // Sin esa señal se acusa recibo del dato y se le da lo UTIL -el plazo
      // a su ciudad- sin pedirle nada mas. Sigue siendo una buena respuesta,
      // y la puerta queda abierta.
      // ------------------------------------------------------------------
      if ((datosAportados || []).length && !lectura.pregunta) {
        // ------------------------------------------------------------------
        // CONTESTAR LA PREGUNTA DEL BOT **ES** AVANZAR LA VENTA
        //
        // AQUI SE PERDIO LA VENTA DEL 08-OCT, y en el mensaje mas tonto:
        //
        //   bot:     "¿Cuántos quieres? Y para preparar tu pedido me pasas
        //             la ciudad y la dirección"
        //   clienta: "Solo 1"
        //   bot:     "¡Perfecto, gracias!"        <- y ahi se murio
        //
        // Le faltaba el nombre y la direccion, y no se los pidio. La
        // clienta contesto LO QUE EL BOT LE HABIA PREGUNTADO y recibio un
        // acuse de recibo sin siguiente paso. Dos mensajes despues escribio
        // "Ayuda con pedido" — tuvo que pedir ella que la ayudaran a
        // comprar.
        //
        // Dos señales que valen tanto como un "lo quiero", y ninguna rompe
        // la regla de PR #9 ("dar una ciudad no es comprar"):
        //
        //   · LA CANTIDAD. Nadie dice "solo 1" para informarse. Elegir
        //     cuantas quiere es decidir, no preguntar — a diferencia de la
        //     ciudad, que muchas veces es "¿me llega allá?".
        //   · QUE EL BOT YA HUBIERA PEDIDO LOS DATOS (`datosPedidos`). Si
        //     se los pidio el bot, contestarlos es responder, y seguir el
        //     cierre es atender; quedarse en "gracias" es colgarle.
        // ------------------------------------------------------------------
        // ⚠️ MARCO CAMBIO ESTA REGLA EL 2026-10-10, Y SU MEDICION MANDA.
        //
        // Aqui habia un atajo: si el UNICO dato aportado era la ciudad -un
        // dato "neutro"- se contestaba el plazo y se volvia SIN PEDIR NADA.
        // La idea era la regla del PR #9, "dar una ciudad no es comprar",
        // porque muchas veces la ciudad es en realidad "¿me llega allá?".
        //
        // El precio de ese atajo, en el panel de Marco:
        //
        //   Duitama:  "Duitama boyaca"
        //   bot:      "¡Perfecto! A Duitama te llega en 1 a 3 días
        //              hábiles según la ciudad 🙌"
        //             (y ahi se acabo la conversacion)
        //
        //   Santiago: "Bogotá"  ->  el mismo mensaje, y tampoco siguio.
        //
        // Dos conversaciones muertas justo donde el cliente acababa de
        // contestar LA PREGUNTA QUE HACE EL PROPIO BOT en su primer mensaje
        // ("¿Para qué ciudad sería?"). Preguntar la ciudad y luego tratar la
        // respuesta como si no comprometiera a nada deja al cliente sin
        // saber que sigue — y en un chat de ventas, eso es colgarle.
        //
        // AHORA LA CIUDAD TAMBIEN AVANZA LA VENTA: el mensaje lleva el plazo
        // Y la lista de lo que falta, en un solo mensaje. Es exactamente lo
        // que ya hacia `cerrarTrasElDato`, asi que el arreglo es BORRAR el
        // atajo, no escribir un camino nuevo.
        //
        // LO QUE SIGUE PROTEGIDO, y es la parte de la regla del PR #9 que de
        // verdad importa: esta rama exige `!lectura.pregunta`. "¿Llega a
        // Palmira?" NO entra aqui y sigue recibiendo solo la cobertura. Lo
        // que cambia es la ciudad dicha COMO DATO, que es otra cosa.
        // ------------------------------------------------------------------
        return componer(
          [
            ...partes,
            ...cerrarTrasElDato({
              datosAportados,
              ciudadConfirmada,
              faltan,
              producto,
              cantidadInformada: cot && cot.cantidad,
              yaSePidieron: memoria.datosPedidos,
            }),
          ],
          { emoji: "atencion" }
        );
      }

      // ---- 3. EL SIGUIENTE PASO, SOLO SI PROCEDE ----
      //
      // Una duda informativa NO autoriza a pedir los datos de entrega. Se
      // piden cuando hay señal de compra, cuando la duda era comercial -ahi
      // el siguiente paso es natural- o cuando el cliente no pregunto nada.
      // ----------------------------------------------------------------
      // PREGUNTO ALGO QUE EL CATALOGO NO CUBRE
              //
      // Va ANTES de pedir datos, porque es el caso que se colaba. `lectura
      // .pregunta` exige un tema reconocido, asi que una duda no catalogada
      // caia en "no pregunto nada" y recibia la pedida de datos:
      //
      //   clienta: "oye y esto me lo puedo poner dormida toda la noche?"
      //   bot:     "¿Cuántos quieres? Y para despachártelo me pasas..."
      //
      // Se contesta lo unico honesto -no lo sabemos, lo confirma una
      // persona- y la tarea queda registrada en el cerebro. Decir "no lo
      // sé" con calidez vende mas que contestar otra cosa: la clienta que
      // pregunta por seguridad y recibe un formulario se va.
      // ----------------------------------------------------------------
      if (!lectura.compra && !lectura.temas.length && lectura.pareceUnaPregunta && !lectura.soloSaludo) {
        // ----------------------------------------------------------------
        // UN "?" NO ES UNA PREGUNTA QUE NO SEPAMOS: ES UNA QUE NO SE OYO
        //
        // Medido el 09-oct. Un cliente escribio literalmente "?" y recibio
        // *«Esa no te la quiero contestar a medias. La dejo anotada para el
        // equipo»*. No hay ninguna "esa": no pregunto nada todavia. Y
        // ademas abria una tarea con la pregunta "?" dentro, que es ruido
        // puro en la bandeja.
        //
        // Un mensaje que NO TIENE PALABRAS -o tiene una sola, del tipo
        // "como?", "ah?", "y?"- es alguien que no entendio o que se quedo a
        // medias. Lo que toca es reorientar, no admitir un hueco que no
        // existe.
        // ----------------------------------------------------------------
        const palabras = String(mensajeCliente || "")
          .replace(/[^\p{L}\p{N}\s]/gu, " ")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (palabras.length <= 1) {
          partes.push("Cuéntame qué quieres saber del cinturón y te ayudo: precio, envío, garantía… lo que necesites.");
          return componer(partes, { emoji: "saludo" });
        }

        partes.push(
          "Esa no te la quiero contestar a medias. La dejo anotada para el equipo: " +
            "una persona la revisa y te responde por aquí."
        );
        return componer(partes, { emoji: "atencion" });
      }

      if (lectura.compra || (!lectura.pregunta && !lectura.soloSaludo)) {
        // ----------------------------------------------------------------
        // EL FORMULARIO NO PUEDE SER LA RESPUESTA POR DEFECTO
        //
        // Esta rama se come TODO lo que no es una pregunta reconocida ni un
        // saludo, y el resultado era pedirle los cuatro datos a cualquiera.
        // Del panel de produccion del 08-oct, todos mensajes reales:
        //
        //   "Me gusta"         -> "¿Cuántos quieres? Y para preparar tu
        //                          pedido me pasas la ciudad y la dirección"
        //   "A ve r"           -> lo mismo
        //   "Por favor"        -> lo mismo
        //   "Interapidisimo"   -> lo mismo
        //   un sticker         -> lo mismo, y al segundo "no quiero
        //                          repetirme"
        //
        // Cinco clientes distintos recibiendo el mismo formulario por decir
        // cosas que no son un "lo quiero". "Me gusta" es interes, no una
        // compra: lo que toca ahi es un micro-cierre de una sola pregunta,
        // no cuatro campos.
        //
        // La condicion: solo se piden los datos a quien YA dio una señal de
        // compra -en este turno o antes- o a quien ya esta en la captura.
        // Al resto se le ofrece el paso siguiente y se le deja hablar.
        // ----------------------------------------------------------------
        // ⚠️ `memoria.datosPedidos` NO ENTRA AQUI, Y ES LA PARTE SUTIL.
        //
        // Significa "ya se le pidieron los datos una vez", no "el cliente
        // quiere comprar". Usarlo como permiso creaba un bucle perfecto:
        // basta que el bot haya pedido los datos UNA vez -y con el mensaje
        // del anuncio eso pasa en el primer turno, porque pregunta el
        // precio- para que a partir de ahi cualquier sticker vuelva a
        // recibir el formulario. El permiso lo da la INTENCION del cliente.
        const puedePedirDatos = lectura.compra || huboSenalDeCompra || datosAportados.length > 0;

        if (!puedePedirDatos) {
          partes.push(RETOMAR);
        } else {
          // Y si DIJO QUE LO QUIERE, se celebra antes de pedirle nada. Antes
          // "lo quiero" recibia "Para despacharlo me pasas la ciudad y la
          // dirección": ni un "perfecto". Es el momento mas importante de la
          // conversacion y se trataba como un tramite.
          if (lectura.compra && !preguntoComercial) partes.push("¡Perfecto!");
          partes.push(
            pedirLoQueFalta(faltan, {
              cantidadInformada: cot && cot.cantidad,
              yaSePidieron: Boolean(memoria.datosPedidos),
            })
          );
        }
      } else if (preguntoComercial) {
        // ----------------------------------------------------------------
        // PREGUNTO EL PRECIO, PERO NO DIJO QUE LO QUIERA
        //
        // Aqui NO se le piden los cuatro datos de golpe. Se le pregunta si
        // le sirve, que es una sola cosa y facil de contestar. La mecanica
        // viene de la referencia de BIKERPRO -"el microcierre"-: pedir los
        // datos a quien acaba de ver el precio y todavia no dijo nada
        // suena a presion, y el que esta decidiendo se va.
        //
        // Cuando conteste que si, el turno siguiente SI tiene señal de
        // compra y ahi se piden los datos.
        // ----------------------------------------------------------------
        partes.push(INVITAR);
      } else if (!memoria.pasoPropuesto) {
        // ----------------------------------------------------------------
        // SE CIERRA CON UNA PREGUNTA, NO CON UN AVISO
        //
        // Decia "Cuando quieras lo preparamos." y ahi se moria el turno: es
        // una puerta abierta que no pide nada, pero tampoco invita a nada.
        // La regla de tono de BIKERPRO es explicita y es la que falta aqui:
        // "SIEMPRE termina con una pregunta que avanza la venta".
        //
        // "¿Te lo aparto?" avanza y no promete despacho ni plazo: apartar
        // es lo que SI hacemos -queda su ficha con lo que pidio- y es la
        // misma palabra que ya usa `loConfirmo`.
        // ----------------------------------------------------------------
        // ⚠️ SALVO EN EL ULTIMO ESCALON DE LA OBJECION DE PRECIO.
        //
        // Ahi el mensaje acaba de decir "déjame pasarle tu caso a una
        // persona del equipo", y pegarle detras "¿te lo aparto?" deja un
        // mensaje que se contradice solo: pasa el caso y a la vez sigue
        // cerrando. Es el unico sitio donde la regla de "termina siempre
        // con una pregunta" esta mal.
        const enManosDeUnaPersona =
          vezDeLaObjecion >= 3 && lectura.temas.includes(preguntas.TEMAS.OBJECION_PRECIO);
        if (!enManosDeUnaPersona) partes.push("¿Te lo aparto? 🙌");
      } else if (lectura.temas.length && !partes.some((x) => /\?/.test(String(x || "")))) {
        // ------------------------------------------------------------
        // LA REGLA DE ORO DE MARCO: NINGUN MENSAJE SE QUEDA SUELTO
        //
        // "Cada mensaje tuyo termina con UNA pregunta o UNA acción clara que
        // acerque al pedido."
        //
        // El hueco estaba en `memoria.pasoPropuesto`: una vez propuesto el
        // siguiente paso, el bot dejaba de cerrar. Y como el PRIMER mensaje
        // ya propone un paso, en la practica todas las respuestas a dudas
        // posteriores salian sin cierre. Su caso 17:
        //
        //   cliente · "En q colores tiene"
        //   bot     · "Sí, viene únicamente en color rosado 💗"
        //
        // Correcto, amable… y ahi se muere la conversacion. No hay nada que
        // contestar.
        //
        // Solo aplica cuando se CONTESTO UN TEMA y el mensaje no trae ya una
        // pregunta: no se le añade un cierre a quien se esta despidiendo, ni
        // dos preguntas al mismo mensaje.
        partes.push("¿Te lo aparto? 🙌");
      }

      // El emoji sale del tema que se respondio: uno, al final, y solo si
      // el mensaje no trae ya alguno.
      return componer(partes, { emoji: voz.claveDeEmoji(lectura.temas) || (lectura.compra ? "compra" : "atencion") });
    }

    case "resumen": {
      // SIN PROMETER PLAZO. Decia "Dame un momento y te confirmo", que es
      // la misma promesa que el filtro bloquea en el borrador del modelo:
      // el candado vigilaba a la IA mientras el codigo decia lo mismo. No
      // hay nadie de guardia, asi que "un momento" puede ser la noche
      // entera. Lo cazo la prueba de esta bateria.
      if (!cotizacion) return "Déjame revisarlo bien y te confirmo por aquí 🙌";
      // ------------------------------------------------------------------
      // EL RESUMEN LLEVA EL NOMBRE COMERCIAL COMPLETO
      //
      // En una frase suelta se usa el nombre corto ("el cinturón térmico te
      // queda en..."), pero el resumen es el documento que la clienta
      // CONFIRMA y que queda copiado en el pedido. Ahi va el nombre con el
      // que se vende: "Cinturón térmico NOVIKA". Un pedido que dice "el
      // cinturón térmico" es mas pobre para quien despacha y para cualquier
      // reclamo posterior.
      // ------------------------------------------------------------------
      const nombre = cotizacion.productoNombre || (producto && producto.nombre) || "Producto";

      // ------------------------------------------------------------------
      // Y LLEVA A DONDE VA, QUE ES LO QUE SE ESTABA CONFIRMANDO A CIEGAS
      //
      // El cuadro decia producto, cantidad, total y condiciones. NO decia
      // el nombre, la ciudad ni la direccion, asi que la clienta confirmaba
      // un envio sin ver el destino. Una direccion mal entendida se
      // despachaba y nadie lo notaba hasta que el paquete volvia.
      //
      // Y produjo un segundo defecto, mas visible: corregir la direccion no
      // cambiaba NI UNA LETRA del mensaje, asi que la guarda anti-eco veia
      // el mismo texto y contestaba "dime qué necesitas" a quien acababa de
      // corregirla. El dato correcto se habia guardado bien; lo que fallaba
      // era que no se le mostraba.
      //
      // Se muestran solo los datos CONFIRMADOS. Uno propuesto por el modelo
      // y sin validar no puede aparecer en el cuadro que ella aprueba.
      // ------------------------------------------------------------------
      const entrega = [];
      const d = datosDeEntrega || {};
      const aQuien = [d.nombre, d.ciudad].filter(Boolean).join(" · ");
      if (aQuien) entrega.push(`Para: ${aQuien}`);
      if (d.direccion) entrega.push(`Dirección: ${d.direccion}`);

      return [
        "Confirmemos tu pedido:",
        // "1 unidad(es)" era lo mas robot del cuadro, y estaba justo donde
        // la clienta decide pagar. BIKERPRO lo tiene documentado como error
        // propio: no se copian los parentesis de la plantilla.
        `${nombre} · ${voz.unidades(cotizacion.cantidad)}`,
        `Total: ${pesos(cotizacion.total)}`,
        ...lineasDeCondiciones(cotizacion),
        ...entrega,
        "",
        '¿Está todo bien? Respóndeme "sí" y lo dejo listo ✅',
      ].join("\n");
    }

    // ----------------------------------------------------------------------
    // CONFIRMADO: el mensaje mas importante de toda la conversacion
    //
    // Es el que lee alguien que acaba de decidir gastarse su plata. "Tu
    // pedido quedó registrado con el número X" es un acuse de recibo; una
    // persona agradece, usa el nombre y deja la puerta abierta.
    //
    // El nombre solo si esta CONFIRMADO: llamar a alguien por un nombre que
    // el modelo propuso y nadie valido es peor que no nombrarlo.
    // ----------------------------------------------------------------------
    case "confirmado": {
      const quien = voz.nombreDePila(nombreCliente);
      const saluda = quien ? `¡Listo, ${quien}!` : "¡Listo!";
      return componer(
        [
          saluda,
          "Gracias por tu compra.",
          pedido ? `Tu pedido quedó con el número ${pedido.id}.` : "Tu pedido quedó registrado.",
          "Te avisamos en cuanto salga, y cualquier cosa me escribes por aquí.",
        ],
        { emoji: "confirmado" }
      );
    }

    // ----------------------------------------------------------------------
    // YA CONFIRMADO: ES POSVENTA, NO UN ECO
    //
    // ESTE ERA EL DEFECTO MAS GRAVE QUE QUEDABA, Y SE VIO EN PRODUCCION:
    //
    //   Marco: "Ese tiene garantía?"
    //   bot:   "Tu pedido NOV-... ya está confirmado. Si necesitas cambiar
    //           algo, dime qué y lo revisamos."
    //   Marco: "Pregunto si tiene garantía"
    //   bot:   (el mismo texto)
    //   Marco: "Si"
    //   bot:   (el mismo texto otra vez)
    //
    // Tras un pedido confirmado, el estado queda BLINDADO -con razon: un
    // "si" no puede recotizar ni crear otro pedido- y esta situacion
    // devolvia la misma frase a CUALQUIER cosa que escribiera el cliente.
    // La conversacion quedaba muerta para siempre: ninguna duda se
    // respondia, y un "¿cuánto vale otro?" -una venta adicional- recibia
    // tambien el eco.
    //
    // El blindaje no era el problema; el problema era creer que "no
    // recotizar" significa "no conversar". Quien ya compro es quien MAS
    // merece que le contesten: son garantias, cambios de direccion y
    // seguimientos.
    //
    // Ahora se responde primero su duda, con los mismos datos del catalogo
    // que en el resto de la conversacion, y el pedido se menciona solo
    // cuando viene al caso. Lo que NO cambia: de aqui no sale ninguna
    // cotizacion ni ningun pedido nuevo.
    // ----------------------------------------------------------------------
    case "ya_confirmado": {
      const quien = voz.nombreDePila(nombreCliente);

      // ------------------------------------------------------------------
      // UN SALUDO SE CONTESTA SALUDANDO
      //
      // En la captura de Marco: escribio "Hola" y recibio "Tu pedido
      // NOV-... ya está confirmado y te avisamos cuando salga". Nadie
      // saluda y recibe el estado de su pedido; eso es un cajero
      // automatico. Y encima el "Buenas noches" siguiente caia en la
      // guarda anti-eco -mismo texto- y acababa en "perdón, no quiero
      // repetirme".
      //
      // El numero de pedido se dice cuando pregunta POR EL, no cuando
      // dice buenas noches.
      // ------------------------------------------------------------------
      if (lectura.soloSaludo) {
        return componer(
          [quien ? `¡Hola, ${quien}!` : "¡Hola!", "¿En qué te puedo ayudar?"],
          { emoji: "saludo" }
        );
      }

      const partes = [];
      if (saludo) partes.push(saludo);

      // La apertura, igual que en el resto de la conversacion. Esta rama se
      // habia quedado sin ella: "Tiene garantía de 1 mes..." en vez de
      // "¡Claro que sí! Tiene 1 mes de garantía...".
      if (!saludo) partes.push(voz.apertura(lectura.temas));

      // Su duda, respondida. El precio se puede decir -es informativo- pero
      // NO crea oferta: el estado sigue blindado.
      //
      // Y SE CONTESTA POR LA CANTIDAD QUE PREGUNTA, no por la del pedido.
      // Con un pedido de 1 confirmado, "¿que valen dos?" se contestaba con
      // el precio de una — o no se contestaba. `cotizacionInformativa` trae
      // la cotizacion de lo que pregunto, cuando el catalogo la tiene.
      // Y si pregunta por una cantidad sin tarifa, se dice — nunca se
      // contesta con el precio del pedido que ya tiene.
      if (cantidadSinTarifa) {
        partes.push(
          `el precio por ${voz.unidades(cantidadSinTarifa)} no lo tengo aprobado todavía. ` +
            `Lo dejo anotado para el equipo y te confirman por aquí: no quiero darte una cifra equivocada.`
        );
        return componer(partes, { emoji: "atencion" });
      }

      // Si pregunta un PRECIO, la linea comercial lo dice todo en una
      // frase: cuanto, el envio y como paga. Antes salian dos frases
      // sueltas diciendo lo mismo en dos tiempos.
      const cotParaResponder = cotizacionInformativa || cotizacion;
      // SOLO el tema PRECIO, no todos los comerciales. `TEMAS_COMERCIALES`
      // incluye ENVIO, y "¿qué precio tiene el envío?" es tema ENVIO: con
      // la condicion ancha volvia a soltar el precio del producto, que es
      // exactamente el defecto que ya se habia corregido.
      const preguntoPrecio = lectura.temas.includes(preguntas.TEMAS.PRECIO);

      let respuesta = { texto: "" };
      if (preguntoPrecio && cotParaResponder) {
        partes.push(lineaComercial(cotParaResponder, producto));
        respuesta = { texto: "ya respondido" };
        // Y las dudas que NO sean comerciales, detras.
        const otras = lectura.temas.filter((t) => !TEMAS_COMERCIALES.includes(t));
        const extra = contestar.aTemas(otras, { producto, cotizacion: cotParaResponder, vezDeLaObjecion, vecesPorTema, fotosYaEnviadas, ciudadConfirmada }, { maximo: 1 });
        if (extra.texto) partes.push(extra.texto);
      } else {
        respuesta = contestar.aTemas(lectura.temas, { producto, cotizacion: cotParaResponder, vezDeLaObjecion, vecesPorTema, fotosYaEnviadas, ciudadConfirmada }, { maximo: 2 });
        if (respuesta.texto) partes.push(respuesta.texto);
      }

      // ------------------------------------------------------------------
      // EL NUMERO DE PEDIDO, SOLO SI PREGUNTA POR SU PEDIDO
      //
      // La condicion era "pregunta por entrega o envio", y eso incluye
      // "¿cuánto cuestan 2 con envío?", que no pregunta nada de su compra:
      //
      //   clienta: "y cuánto cuestan 2 con envío"
      //   bot:     "...$85.000. El envío va incluido... Tu pedido NOV-...
      //             ya está confirmado y te avisamos en cuanto salga."
      //
      // Esa ultima frase no la pidio nadie. Mezcla una consulta NUEVA -que
      // es una venta- con el estado de una compra vieja, y entierra lo que
      // si importa. Ahora hace falta una señal explicita: "¿ya salió?",
      // "mi pedido", "mi guía".
      // ------------------------------------------------------------------
      // ------------------------------------------------------------------
      // SI YA SALIO, SE DICE QUE YA SALIO
      //
      // Decia "te avisamos en cuanto salga" SIEMPRE, incluso con el pedido
      // ya despachado y con guia. A quien pregunta "¿ya salió mi pedido?"
      // dos dias despues del despacho se le contestaba que le avisaremos
      // cuando salga: es falso, y encima es la pregunta en la que mas se
      // desconfia de una tienda por WhatsApp.
      //
      // El dato existe y esta respaldado -`despacho.guia` solo se escribe
      // cuando una persona despacha de verdad desde el panel, y el dominio
      // no deja marcar despachado sin guia- asi que decirlo no es una
      // promesa: es un hecho con su numero de rastreo.
      //
      // ES LA DISTINCION QUE PEDIA MARCO: lo que no se puede es PROMETER un
      // despacho que no ha pasado. Contar uno que ya paso es justo lo
      // contrario, y callarlo era otra forma de dejar al cliente a ciegas.
      // ------------------------------------------------------------------
      if (!respuesta.texto || lectura.porSuPedido) {
        const salio = pedido && pedido.estado === "despachado";
        const guia = (pedido && pedido.guia) || null;
        const transportadora = (pedido && pedido.transportadora) || null;

        if (salio && guia) {
          partes.push(
            `Tu pedido ${pedido.id} ya salió${transportadora ? ` por ${transportadora}` : ""}, ` +
              `con la guía ${guia}.`
          );
        } else if (salio) {
          partes.push(`Tu pedido ${pedido.id} ya salió.`);
        } else if (pedido) {
          partes.push(`Tu pedido ${pedido.id} está confirmado y te avisamos en cuanto salga.`);
        } else {
          partes.push("Tu pedido está confirmado.");
        }
      }

      // Si pidio otro, se le dice que lo gestiona una persona. NO se abre un
      // pedido nuevo por iniciativa del bot: BIKERPRO documento un pedido
      // falso creado asi, y casi se despacho un paquete que nadie pidio.
      //
      // ------------------------------------------------------------------
      // Y SE QUITO EL ESTRIBILLO "Cualquier otra cosa de tu pedido, dime".
      //
      // Salia detras de CADA respuesta de posventa. En la captura de Marco
      // aparece tres veces seguidas, una por mensaje. Amable la primera
      // vez, robotico a la tercera: es la misma regla de "no fuerces una
      // pregunta comercial en cada respuesta", aplicada a la posventa.
      //
      // Un vendedor responde la duda y se calla. Si el cliente quiere otra
      // cosa, la pregunta.
      // ------------------------------------------------------------------
      // ------------------------------------------------------------------
      // SOLO SI QUIERE OTRO DE VERDAD, Y NO POR PREGUNTAR UN PRECIO
      //
      // La condicion incluia el tema PRECIO, y eso convirtio la frase en
      // otro estribillo. Salia en los tres mensajes seguidos de la clienta:
      //
      //   "Que valen dos?"                  -> ...le digo a una persona
      //   "Que valen dos unidades?"         -> ...le digo a una persona
      //   "Quiero saber cuánto valen dos"   -> ...le digo a una persona
      //
      // Preguntar un precio no es pedir otro. Quien pregunta quiere SABER,
      // y ya se le contesto arriba; ofrecerle un gestor humano en cada
      // respuesta es insistir, no atender.
      //
      // Cuando SI dice que quiere otro, se le dice — y queda anotado como
      // tarea pendiente de verdad, con su motivo y su pregunta. La frase
      // sin el registro detras era una promesa vacia.
      // ------------------------------------------------------------------
      if (lectura.compra || lectura.quiereOtro) {
        partes.push("Para pedir otro te ayuda una persona del equipo; ya le paso tu mensaje.");
      }

      // Por `componer` como todos: unia con join y salia en minuscula
      // ("el cinturón térmico te queda en $49.900. el envío va incluido").
      // Lo cazo la prueba que recorre todas las situaciones.
      return componer(partes, { emoji: voz.claveDeEmoji(lectura.temas) || "atencion" });
    }

    case "cancelado":
      return "Listo, lo cancelamos sin ningún problema. Si cambias de opinión me escribes y lo armamos de nuevo 🙌";

    // ----------------------------------------------------------------------
    // DECLINA: DIJO QUE NO, Y NO HAY NINGUN PEDIDO QUE CANCELAR
    //
    // Antes este caso no existia: caia en "escalado", le decia "esto lo
    // revisa una persona" y PAUSABA EL BOT 12 HORAS. A quien habia dicho
    // "no gracias". No hay nada que revisar y no hay por que callarse.
    //
    // Lo que si hay es una venta que todavia puede pasar: en contraentrega
    // el "no por ahora" se vuelve compra con mucha frecuencia, porque el
    // cliente no arriesga plata. Asi que se cierra bien, se recuerda la
    // unica condicion que de verdad quita el miedo -pagar al recibir- y se
    // deja la puerta abierta SIN presionar y SIN pedir datos.
    //
    // Y no termina en pregunta, a proposito. Es la unica rama donde el
    // cierre con pregunta esta mal: a quien acaba de decir que no, otra
    // pregunta se le lee como insistencia.
    // ----------------------------------------------------------------------
    case "declina": {
      const pagaAlRecibir = contestar.pagaAlRecibir(producto);
      return componer(
        [
          "Tranquila, sin problema.",
          pagaAlRecibir
            ? "Si más adelante lo quieres, aquí estoy: recuerda que pagas al recibir, así que no arriesgas nada."
            : "Si más adelante lo quieres, aquí estoy.",
        ],
        { emoji: "saludo" }
      );
    }

    // ----------------------------------------------------------------------
    // ESCALADO: se pasa a una persona. Y SE RESPONDE LO QUE PREGUNTO IGUAL.
    //
    // "Dame un momento, te confirmo en seguida" era lo unico que salia, y
    // dejaba al cliente sin nada. Si la duda se puede contestar con el
    // catalogo, se contesta, y ademas se avisa de que sigue una persona.
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // ESCALADO: SE AVISA UNA VEZ Y SE CALLA
    //
    // Lo que pasaba en el chat de Marco, leido del panel de produccion:
    //
    //   Marco  · "Buenas"
    //   NOVIKA · "Déjame confirmarlo bien con el equipo y te escribo en un
    //             momentico."
    //   Marco  · "Confirmar que?"
    //   NOVIKA · "Perdón, no quiero repetirme. Dime concretamente qué
    //             necesitas y lo reviso con el equipo."
    //   Marco  · "Empecemos de nuevo"
    //   NOVIKA · "Déjame confirmarlo bien con el equipo…"
    //   Marco  · "Hola"
    //   NOVIKA · "Perdón, no quiero repetirme…"
    //
    // DOS PROTECCIONES PELEANDO ENTRE ELLAS. Esta rama solo tenia una
    // frase, asi que la repetia siempre; la guarda anti-eco la veia
    // repetida y la cambiaba por "no quiero repetirme"; al turno siguiente
    // volvia la primera. Y asi para siempre.
    //
    // ASI LO HACE BIKERPRO, y es la referencia que Marco lleva pidiendo:
    // cuando el bot no puede resolver, avisa UNA vez y marca `##HANDOFF##`.
    // A partir de ahi deja de responder y contesta una persona. Un bot que
    // insiste sin aportar nada es peor que un bot callado: el silencio se
    // entiende como "me estan mirando el caso", y el bucle como "esto esta
    // roto".
    //
    // Aqui el silencio lo produce la PAUSA que pone el cerebro: el emisor
    // la comprueba antes de escribir, asi que no hay forma de que se cuele
    // otro mensaje. El cliente queda en la bandeja marcado para atender.
    //
    // Y SE RESPONDE LO QUE SE SEPA ANTES DE CALLARSE. Si pregunto algo que
    // el catalogo cubre, se le contesta: callarse teniendo el dato es tirar
    // la venta, no protegerla.
    // ----------------------------------------------------------------------
    case "escalado": {
      // ------------------------------------------------------------------
      // LOS TRES ESCALADOS QUE SI LO SON TIENEN TEXTO PROPIO
      //
      // La frase generica -"esto lo reviso con una persona del equipo"- es
      // correcta para un hueco de catalogo. Para un reclamo, para alguien
      // enfadado o para quien pidio hablar con una persona, es exactamente
      // la frase equivocada: suena a tramite justo donde el cliente
      // necesita sentir que alguien se hizo cargo.
      //
      // Y NO SE VENDE EN NINGUNO DE LOS TRES. En el reclamo, ademas, no se
      // repite el argumento de la garantia: al cliente que la esta
      // reclamando ya se le vendio una vez.
      // ------------------------------------------------------------------
      if (motivoEscalado === "reclamo_de_garantia") {
        const comoSeTramita = producto && producto.garantiaComoSeTramita;
        return componer(
          [
            "Uy, qué pena que te haya llegado así.",
            comoSeTramita
              ? "Eso lo gestiona directamente una persona del equipo: ya le paso tu mensaje para que te ayude con el cambio."
              : "Eso lo gestiona una persona del equipo: ya le paso tu mensaje.",
            "Si puedes, mándame una foto de cómo llegó por aquí mismo, que así lo resuelven más rápido.",
          ],
          { emoji: null }
        );
      }
      if (motivoEscalado === "cliente_molesto") {
        // Sin emoji y sin una sola palabra de venta. Un 🙌 delante de
        // alguien que amenaza con denunciar se lee como burla.
        return componer(
          [
            "Te entiendo, y siento que hayas tenido esta experiencia.",
            "Prefiero que esto lo vea una persona del equipo y no yo: ya le paso tu mensaje y te responde por aquí.",
          ],
          { emoji: null }
        );
      }
      if (motivoEscalado === "pidio_una_persona") {
        return componer(
          [
            "¡Claro que sí!",
            "Ya le aviso a una persona del equipo para que te ayude con esto.",
            // Y SE SIGUE ATENDIENDO. Marco: "no pausar el flujo de venta".
            // El bot avisa, pero no se retira de la conversacion.
            "Mientras tanto, si quieres te voy dejando el pedido listo.",
          ],
          { emoji: "atencion" }
        );
      }
      if (motivoEscalado === "pedido_mayorista") {
        // Es el lead mas grande que entra por aqui: quien revende compra
        // todos los meses. Se le habla como a un socio, no como a un
        // problema — y NO se le suelta una cifra, porque la tabla cubre una
        // y dos unidades y el precio de mayorista no existe en el catalogo.
        return componer(
          [
            "¡Qué bueno que preguntes!",
            "Para esa cantidad te paso con una persona del equipo, que es quien maneja los precios al por mayor.",
            "Ya le aviso y te responde por aquí.",
          ],
          { emoji: "atencion" }
        );
      }

      const resto = contestar.aTemas(lectura.temas, { producto, cotizacion, vezDeLaObjecion, vecesPorTema, fotosYaEnviadas, ciudadConfirmada }, { maximo: 2 });
      return componer([
        saludo || voz.apertura(lectura.temas),
        resto.texto,
        // Sin plazo: no hay nadie de guardia y prometer "un momentico" a
        // las dos de la mañana es mentir. Lo que si es verdad es que queda
        // en la bandeja de una persona.
        "Esto lo reviso con una persona del equipo y te responde por aquí.",
      ],
      // Con emoji. Es el ultimo mensaje antes de que el bot se calle, y
      // salia completamente seco: justo donde el cliente necesita sentir
      // que lo estan atendiendo y no que el chat se rompio.
      { emoji: "atencion" });
    }

    case "sin_respuesta_automatica":
    default:
      return "Lo reviso con el equipo y te responden por aquí 🙌";
  }
}

// ==========================================================================
// NO REPETIR PALABRA POR PALABRA LO ULTIMO QUE SE DIJO
//
// En la captura de produccion el mismo texto salio TRES veces seguidas, y
// reproduciendolo salio cinco. Aunque la situacion se arregle, esto tiene
// que existir aparte: un bot que repite el mismo parrafo es un bot roto a
// ojos del cliente, y la causa puede ser cualquier rama futura.
//
// DOS NIVELES, Y EL SEGUNDO ES EL QUE IMPORTA:
//
//   1. Si el texto es idéntico al anterior, se cambia por uno que pide
//      concretar. Puede que el cliente escribiera algo que no entendimos.
//
//   2. Si YA se dijo eso y volveria a repetirse, el bot no esta avanzando.
//      Ahi se para y se pasa a una persona, en vez de seguir dando vueltas.
//      Es la misma decision que BIKERPRO documento como "bucle cortado".
// ==========================================================================

// ⚠️ ESTAS DOS FRASES LAS PROHIBIO MARCO EXPRESAMENTE EL 2026-10-09:
//    "no quiero repetirme" y "dime concretamente qué necesitas".
//
// Y tenia razon: suenan a reproche. El cliente no hizo nada mal -reformulo,
// o mando un sticker, o insistio porque la respuesta anterior no le servia-
// y recibia una frase que le echa la culpa. En dos chats reales el cliente
// se fue justo despues de leerla.
//
// Lo que sustituye tiene que hacer DOS cosas que la frase vieja no hacia:
// reconocer que el bot no se explico bien (no que el cliente no se explico),
// y dejar algo concreto que hacer.
const PEDIR_CONCRETAR =
  "Perdón, creo que no te entendí bien 🙈 ¿Me lo escribes de otra forma? " +
  "O si quieres te dejo el pedido listo y me cuentas: precio, envío, garantía… lo que necesites.";
const PASAR_A_PERSONA =
  "Ya le aviso a una persona del equipo para que te ayude con esto 🙌 " +
  "Mientras tanto, si quieres te voy dejando el pedido listo.";

/**
 * El texto que se repetia era una ADMISION de que falta el dato.
 *
 * Se detecta sobre el texto anterior, igual que `contestar.prometeConfirmar`
 * y por el mismo motivo: la promesa esta en el texto. Aqui el patron es mas
 * corto a proposito -solo la parte que identifica la admision- porque lo
 * unico que hay que decidir es si repetirlo seria un muro.
 */
const PROMESA_REPETIDA = /no te l[oa]s? quiero (decir|contestar) a medias|l[oa]s? confirmo con el equipo/i;

/**
 * Lo que se dice cuando la clienta reformula una pregunta que no tenemos.
 *
 * Reconoce que ya quedo anotada -que es verdad: el cerebro abre la tarea- y
 * deja un paso concreto. Sin plazo, porque no hay nadie de guardia.
 */
/**
 * Lo que se dice cuando el resumen volveria a salir igual.
 *
 * Corto y con una sola cosa que hacer. Sin repetir el cuadro -que ya esta
 * en pantalla- y sin pedir que concrete nada: lo unico que falta es el "sí".
 */
const EMPUJON_AL_RESUMEN =
  'Te dejé el resumen aquí arriba 👆 Si está todo bien, respóndeme "sí" y lo dejo listo. ' +
  "Y si hay algo que corregir, dime qué y lo cambio.";

const INSISTE_SIN_DATO =
  "Esa me la quedé debiendo, y ya está anotada para que te la confirme una persona del equipo. " +
  "Lo que sí te puedo decir es que pagas al recibir, así que puedes revisarlo con calma cuando llegue. " +
  "¿Te lo aparto mientras?";

// ==========================================================================
// ¿ESTE TEXTO LE HIZO UNA PREGUNTA DE CIERRE?
//
// ⚠️ SIN ESTO, EL BOT NO SABIA QUE ACABABA DE PREGUNTAR, y por eso no
//    entendia el "si". Era el agujero del 10-oct.
//
// La conversacion guardaba cuatro banderas -`saludado`, `precioInformado`,
// `datosPedidos`, `pasoPropuesto`- y NINGUNA decia "mi ultimo mensaje fue
// una pregunta de cierre". `pasoPropuesto` se le parece, pero es monotona:
// significa "alguna vez propuse un paso", no "lo acabo de preguntar", y se
// ponia a true en todos los turnos.
//
// Sin esa memoria, "Mándamelo" era un mensaje sin tema y sin dato: el
// redactor no tenia permiso para pedir datos y volvia a soltar la misma
// pregunta de cierre. El cliente decia si tres veces y el bot le contestaba
// "Perdón, creo que no te entendí bien".
//
// SE DETECTA SOBRE EL TEXTO YA PREPARADO, igual que `prometeConfirmar`. Es
// la misma decision de diseño y por el mismo motivo: una bandera que cada
// rama tiene que acordarse de devolver falla en silencio el dia que alguien
// añade una rama nueva. Mirando el texto, cualquier cierre futuro queda
// cubierto sin tocar nada.
//
// ⚠️ SI SE CAMBIA LA REDACCION DE UN CIERRE, HAY QUE TOCAR ESTE PATRON.
//    Lo vigila una prueba que recorre los cierres conocidos.
// ==========================================================================
const PREGUNTA_DE_CIERRE =
  /¿te\s+lo\s+aparto|¿te\s+l[oa]\s+dejo\s+list[oa]|¿te\s+l[oa]\s+preparo|¿te\s+l[oa]\s+dejo\s+apartad[oa]|¿quieres\s+que\s+te\s+ayude\s+a\s+pedirl[oa]|¿quieres\s+pedirl[oa]|¿l[oa]\s+pedimos|¿confirmamos|respóndeme\s+"sí"/i;

/** ¿El texto que se va a enviar termina proponiendo el cierre? */
function prometeCierre(texto) {
  return PREGUNTA_DE_CIERRE.test(String(texto || ""));
}

/**
 * Evita el texto repetido.
 *
 * OJO CON UNA DISTINCION QUE LA PRIMERA VERSION NO HACIA:
 *
 * Si el cliente pregunta DOS VECES LO MISMO, repetir la respuesta correcta
 * no es un eco: es contestarle. La primera version comparaba solo el texto
 * de salida, asi que ante "¿tiene garantía?" y "pregunto si tiene garantía"
 * -la misma duda escrita de dos formas- la segunda recibia "perdón, no
 * quiero repetirme" en lugar de la respuesta. Peor que repetir.
 *
 * El eco de verdad es responder LO MISMO a preguntas DISTINTAS. Por eso la
 * guarda solo actua cuando los temas del turno cambian.
 *
 * Y HAY UN LIMITE QUE NO SE CRUZA: una pregunta RECONOCIDA nunca se
 * sustituye por "dime qué necesitas". Salio probando la repregunta:
 *
 *   clienta: "cuánto vale"              -> el precio
 *   clienta: "cuánto vale?"             -> el precio (pregunto otra vez)
 *   clienta: "pero cuánto vale con el envío"
 *   bot:     "Perdón, no quiero repetirme. Dime concretamente qué necesitas"
 *
 * Le pidio concretar a quien habia preguntado con toda claridad, y encima
 * en el tercer intento: justo cuando ya estaba perdiendo la paciencia. El
 * texto coincidia porque la respuesta correcta ERA la misma, y la guarda
 * leyo eso como un bot atascado.
 *
 * Esta guarda existe para que el bot no parezca roto repitiendose. Negarle
 * la respuesta a quien pregunta claro no lo arregla: lo empeora, porque
 * ademas suena a que no la entendimos. Si se sabe que pregunta, se
 * contesta — aunque la respuesta sea la misma de antes.
 *
 * @param {string} texto             el que se iba a enviar
 * @param {string|null} ultimoDicho  el ultimo texto que mando el negocio
 * @param {object} [opciones]
 * @param {boolean} [opciones.mismaPregunta] el cliente pregunto lo mismo
 * @param {boolean} [opciones.preguntaReconocida] se sabe que esta preguntando
 * @returns {{texto: string, repetido: boolean, escalar: boolean}}
 */
function sinRepetir(texto, ultimoDicho, { mismaPregunta = false, preguntaReconocida = false } = {}) {
  const a = String(texto || "").trim();
  const b = String(ultimoDicho || "").trim();
  if (!a || !b || a !== b) return { texto: a, repetido: false, escalar: false };

  // ----------------------------------------------------------------------
  // ESTE BLOQUE VA ANTES QUE `mismaPregunta`, Y ES EL ORDEN QUE IMPORTA.
  //
  // El muro de "lo confirmo" se da sobre todo cuando la clienta REFORMULA
  // la misma duda -"Con cables para cargar" y "Trae cargador" marcan los dos
  // el tema ENERGIA-, asi que `mismaPregunta` es true y la guarda salia por
  // ahi antes de llegar aqui. Justo el caso que hay que cazar.
  // ----------------------------------------------------------------------

  // ----------------------------------------------------------------------
  // EL MURO DE "LO CONFIRMO" DOS VECES
  //
  // `preguntaReconocida` existe para no negarle la respuesta a quien
  // pregunta claro, y eso sigue bien. Pero hay un caso donde repetir
  // palabra por palabra es indefendible: cuando la respuesta repetida es
  // una ADMISION de que no tenemos el dato.
  //
  // Medido en produccion el 08-oct y reproducido el 09:
  //
  //   clienta · "Con cables para cargar"
  //   bot     · "Buena pregunta: en las fotos se ve el panel de control…
  //              Si funciona con batería o enchufado no te lo quiero decir
  //              a medias: lo confirmo con el equipo y te cuento…"
  //   clienta · "Trae cargador"
  //   bot     · (exactamente el mismo parrafo otra vez)
  //
  // La clienta reformulo porque la primera respuesta no le sirvio, y
  // recibio el mismo muro. Repetir una respuesta BUENA es contestar;
  // repetir un "no lo sé" es decirle que insistir no sirve de nada.
  //
  // No se escala y no se calla: se reconoce que ya quedo anotado y se le
  // deja algo que hacer, que es lo unico que mantiene la venta viva.
  if (PROMESA_REPETIDA.test(b)) {
    return { texto: INSISTE_SIN_DATO, repetido: true, escalar: false };
  }

  if (mismaPregunta) return { texto: a, repetido: false, escalar: false };
  if (preguntaReconocida) return { texto: a, repetido: false, escalar: false };

  // ----------------------------------------------------------------------
  // SI LO QUE SE REPETIA ERA EL RESUMEN, NO SE PIDE "CONCRETAR"
  //
  // ⚠️ ES EL PEOR SITIO POSIBLE PARA ESTA FRASE: el cuadro de confirmacion
  //    es el ultimo paso antes del pedido.
  //
  //   bot      · "Confirmemos tu pedido: … ¿Está todo bien? Respóndeme
  //               «sí» y lo dejo listo ✅"
  //   cliente  · "Mauricio Benítez"      (repite su nombre, por si acaso)
  //   bot      · "Perdón, no quiero repetirme. Dime concretamente qué
  //               necesitas y lo reviso con el equipo."
  //
  // El cliente manda algo que no aporta un dato nuevo -su nombre otra vez,
  // un "ahi esta", un punto de referencia que ya teniamos- y el resumen
  // saldria igual. La guarda lo lee como un bot atascado y suelta la frase
  // de concretar a quien estaba a UN "sí" de comprar.
  //
  // Lo correcto no es repetir el cuadro entero ni pedir que concrete: es
  // señalar que ya esta ahi arriba y pedir el si, que es el unico paso que
  // falta.
  if (/esta todo bien|está todo bien|confirmemos tu pedido/i.test(b)) {
    return { texto: EMPUJON_AL_RESUMEN, repetido: true, escalar: false };
  }


  // Ya se habia pedido concretar y seguimos en el mismo sitio: no hay una
  // tercera forma de decir lo mismo. Pasa a una persona.
  if (b === PEDIR_CONCRETAR) return { texto: PASAR_A_PERSONA, repetido: true, escalar: true };
  if (b === PASAR_A_PERSONA) return { texto: PASAR_A_PERSONA, repetido: true, escalar: true };

  return { texto: PEDIR_CONCRETAR, repetido: true, escalar: false };
}

/**
 * Prepara la respuesta final.
 *
 * @returns {{texto: string, origen: "determinista"|"ia", bloqueos: object[]}}
 */
function preparar({
  situacion,
  tipoDeMedia = null,
  vecesPorTema = {},
  vezDeLaObjecion = 1,
  motivoEscalado = null,
  cotizacion = null,
  cotizacionInformativa = null,
  faltan = [],
  opciones = [],
  pedido = null,
  producto = null,
  borradorIA = null,
  mensajeCliente = "",
  memoria = {},
  nombreCliente = null,
  datosAportados = [],
  ciudadConfirmada = null,
  datosDeEntrega = null,
  cantidadSinTarifa = null,
  fotosYaEnviadas = false,
  pideReenvioDeFotos = false,
  huboSenalDeCompra = false,
}) {
  const determinista = textoDeterminista({
    situacion,
    tipoDeMedia,
    vecesPorTema,
    vezDeLaObjecion,
    motivoEscalado,
    cotizacion,
    cotizacionInformativa,
    faltan,
    opciones,
    pedido,
    producto,
    mensajeCliente,
    memoria,
    nombreCliente,
    datosAportados,
    ciudadConfirmada,
    datosDeEntrega,
    cantidadSinTarifa,
    fotosYaEnviadas,
    pideReenvioDeFotos,
    huboSenalDeCompra,
  });
  const bloqueos = [];

  // --------------------------------------------------------------------------
  // CON EL PRODUCTO EN BORRADOR, EL MODELO NO REDACTA.
  //
  // El cliente acaba de preguntar un precio que no existe. Es el momento
  // exacto en el que un modelo rellena el hueco con una cifra plausible, y
  // una cifra plausible es un cobro equivocado.
  //
  // El filtro de importes ya lo frenaria -sin cotizacion no hay importes
  // autorizados, asi que cualquier cifra se bloquea-, pero depender de eso
  // seria confiar en que el modelo se equivoque de una forma concreta.
  // Aqui no se le pide nada: el texto es el nuestro.
  // --------------------------------------------------------------------------
  if (situacion === "producto_en_borrador") {
    return { texto: determinista, origen: "determinista", bloqueos: [{ tipo: BLOQUEOS.PRODUCTO_SIN_FICHA }] };
  }

  if (!borradorIA || !String(borradorIA).trim()) {
    return { texto: determinista, origen: "determinista", bloqueos: [{ tipo: BLOQUEOS.SIN_BORRADOR }] };
  }

  // Los importes de la informativa tambien cuentan: si no, un borrador que
  // repite el precio correcto se bloquearia por decir la verdad.
  //
  // Y los de LA OFERTA DE DOS, por lo mismo. Ante una objecion de precio el
  // texto determinista ofrece la pareja CON SU PRECIO -Marco lo autorizo-, y
  // esa cifra sale del cotizador: sin autorizarla aqui, el candado
  // bloquearia al modelo por repetir un precio que el propio bot acaba de
  // decir.
  const autorizados = [
    ...((cotizacion && cotizacion.importesAutorizados) || []),
    ...((cotizacionInformativa && cotizacionInformativa.importesAutorizados) || []),
    ...importesDeLaOfertaDeDos(producto),
  ];
  const importes = revisarImportes(borradorIA, autorizados);
  if (!importes.ok) {
    bloqueos.push({
      tipo: BLOQUEOS.IMPORTE_NO_AUTORIZADO,
      detalle: importes.sospechosos.map((s) => s.valor),
    });
  }

  // ==========================================================================
  // NUNCA, POR NINGUN CAMINO, SE DEVUELVE UN TEXTO VACIO
  //
  // El saludo en un chat viejo producia una respuesta VACIA: tres marcadores
  // de memoria, cada uno suprimiendo correctamente su parte, y el mensaje se
  // quedaba sin una sola frase. El emisor lo bloqueaba por `texto_vacio` y
  // el cliente recibia silencio.
  //
  // Ese caso concreto ya esta arreglado arriba. Esto es la RED, y existe
  // porque el defecto no fue una rama olvidada: fue la SUMA de tres reglas
  // correctas. Mientras el texto se componga sumando y restando trozos,
  // alguna combinacion futura volvera a dar cero — y lo que no puede volver
  // a pasar es que el cliente se quede sin respuesta.
  //
  // Vale mas una frase floja que un silencio: el silencio parece que no
  // leimos el mensaje, y es lo unico que no se puede arreglar despues.
  // ==========================================================================
  if (!String(determinista || "").trim()) {
    const quien = voz.nombreDePila(nombreCliente);
    return {
      texto: quien
        ? `¡Hola, ${quien}! ¿En qué te puedo ayudar? 😊`
        : "¡Hola! ¿En qué te puedo ayudar? 😊",
      origen: "determinista",
      bloqueos: [{ tipo: BLOQUEOS.TEXTO_VACIO_EVITADO, detalle: `situacion "${situacion}"` }],
    };
  }

  const claims = revisarClaims(borradorIA, producto);
  if (!claims.ok) {
    bloqueos.push({ tipo: BLOQUEOS.CLAIM_PROHIBIDO, detalle: claims.encontrados });
  }

  // Afirmar que el pedido salio se comprueba CONTRA EL ESTADO, no contra una
  // lista de frases: el mismo texto es correcto si salio y mentira si no.
  const despacho = revisarDespacho(borradorIA, pedido);
  if (!despacho.ok) {
    bloqueos.push({ tipo: BLOQUEOS.DESPACHO_SIN_RESPALDO, detalle: despacho.motivo });
  }

  if (bloqueos.length) {
    // Borrador descartado completo. El cliente recibe el texto determinista.
    return { texto: determinista, origen: "determinista", bloqueos };
  }

  // ==========================================================================
  // CUANDO EL CATALOGO SABE RESPONDER, RESPONDE EL CATALOGO
  //
  // ESTA DECISION VA DESPUES DE LOS FILTROS, Y NO ANTES. La primera version
  // la puso antes -parecia mas eficiente: si el determinista iba a ganar,
  // para que revisar el borrador- y eso rompio una prueba que resulto tener
  // razon.
  //
  // El filtro de importes no sirve solo para BLOQUEAR: sirve para MEDIR
  // cuantas veces el modelo intenta inventar un precio. Saltandolo, el bot
  // habria seguido respondiendo bien y habriamos perdido la señal de que
  // Gemini empieza a inventar cifras. Esa metrica es de las pocas que avisan
  // ANTES de que pase algo caro.
  //
  // Asi que el borrador se revisa siempre y se registra siempre; lo que
  // cambia aqui es solo QUIEN redacta el mensaje que sale.
  //
  // EL HALLAZGO QUE OBLIGO A ESTO. Marco seguia viendo un bot plano DESPUES
  // de reescribir toda la voz, y la razon era que la voz casi no se usaba:
  // si el borrador del modelo pasaba los dos filtros, se enviaba el del
  // modelo. Con Gemini configurado, eso es casi siempre.
  //
  // La prueba estaba en su propia captura: "Hola, cuéntame en qué te puedo
  // ayudar con el cinturón térmico" no existe en este codigo. Lo escribio
  // Gemini — correcto, inofensivo y plano.
  //
  // EL REPARTO CORRECTO, Y NO ES "LA IA ES PEOR":
  //
  //   · Si el cliente pregunta algo que esta EN EL CATALOGO -precio, envio,
  //     pago, garantia, color, talla, entrega- la mejor respuesta ya existe,
  //     esta redactada con su tono y esta cubierta por pruebas. Pedirle al
  //     modelo que improvise sobre el mismo dato solo añade variabilidad,
  //     latencia y coste, y le da una oportunidad mas de equivocarse.
  //
  //   · Si pregunta algo que NO esta catalogado -una objecion rara, una
  //     charla, un caso que nadie previo- el determinista no tiene nada
  //     bueno que decir y el modelo SI. Ahi redacta el modelo.
  //
  // El filtro de importes y el de claims siguen aplicandose igual al
  // borrador que se use. Esto cambia QUIEN redacta, no que se revisa.
  //
  // Se puede volver atras sin desplegar: IA_REDACTA_SIEMPRE=1.
  // ==========================================================================
  const { lectura: loQuePregunto, preguntoComercial: esComercial } = analizarTurno(mensajeCliente);

  const elCatalogoLoCubre =
    // Preguntas con respuesta en el catalogo.
    loQuePregunto.temas.length > 0 ||
    esComercial ||
    // ------------------------------------------------------------------
    // Y LA INTENCION DE COMPRA, que faltaba y es el peor sitio donde
    // faltaba.
    //
    // "listo, lo quiero" no tiene ningun tema reconocido -no pregunta
    // nada- asi que no estaba cubierto, y lo redactaba el modelo. Es el
    // momento mas importante de la conversacion: el paso siguiente es
    // pedir los datos que faltan, calculados contra la ficha.
    //
    // Se vio con el modelo activo, en los tres escenarios de venta:
    //
    //   clienta: "listo, lo quiero"
    //   bot:     "Perfecto, actualizo tu dirección de entrega."
    //
    // No tiene sentido -no habia dirección que actualizar- y ademas no
    // pide nada, asi que la venta se queda parada ahi. Que falten datos
    // es un hecho del estado, no una opinion: lo sabe el codigo.
    // ------------------------------------------------------------------
    loQuePregunto.compra ||
    loQuePregunto.quiereOtro ||
    // Momentos de la venta con texto propio y probado: el arranque, el
    // cuadro de confirmacion, el cierre. Son los que NO conviene improvisar.
    loQuePregunto.soloSaludo ||
    ["resumen", "confirmado", "ya_confirmado", "cancelado", "producto_ambiguo"].includes(situacion);

  if (elCatalogoLoCubre && !PREFERIR_LA_IA) {
    return {
      texto: determinista,
      origen: "determinista",
      bloqueos: [{ tipo: BLOQUEOS.CUBIERTO_POR_EL_CATALOGO }],
    };
  }

  return { texto: borradorIA, origen: "ia", bloqueos: [] };
}

module.exports = {
  preparar,
  textoDeterminista,
  analizarTurno,
  arranque,
  sinRepetir,
  retomarElPaso,
  prometeCierre,
  PREGUNTA_DE_CIERRE,
  PEDIR_CONCRETAR,
  PASAR_A_PERSONA,
  revisarClaims,
  revisarDespacho,
  lineaComercial,
  pedirLoQueFalta,
  enumerar,
  BLOQUEOS,
  pesos,
};
