"use strict";

// ==========================================================================
// EXTRACCION HEURISTICA
//
// Modulo puro. Sin I/O, sin IA.
//
// POR QUE EXISTE, SIENDO QUE LA IA YA EXTRAE CANDIDATOS: porque si la
// extraccion depende solo del modelo, un fallo del proveedor significa cero
// ventas. La prioridad 1 de este proyecto es no perder mensajes y la 2 es no
// perder ventas; un camino que se cae con la API de un tercero incumple las
// dos.
//
// Asi que hay dos fuentes de candidatos y se combinan: heuristica e IA.
// Ninguna de las dos CONFIRMA nada -eso lo hace dominio/destino.js-, solo
// proponen.
//
// La regla que gobierna este archivo: ANTE LA DUDA, NO PROPONER. Un campo
// vacio hace que el bot pregunte, que cuesta un mensaje. Un campo mal
// propuesto acaba en una guia equivocada, que cuesta el producto, el flete y
// el cliente.
// ==========================================================================

const { aplanar, cantidadesEn, NUMEROS_EN_PALABRAS } = require("./texto");
const { CIUDADES_SEMILLA } = require("./destino");

/** Tipos de via, para reconocer una direccion. */
// `barrio`, `corregimiento` y `sector` NO ESTABAN, y en los pueblos la
// direccion ES eso. Costo una venta el 08-oct en San Andres de Sotavento:
//
//   bot:     "...me pasas la dirección"
//   clienta: "Barrio buenos aires"
//   bot:     "Para preparar tu pedido me pasas la dirección"   <- IGUAL
//   clienta: "No entiendo"
//
// Sin `barrio` en esta lista, ese mensaje no era ni un INTENTO de dirección:
// caia en "no se reconoce ningun tipo de via" y el bot repetia la peticion
// palabra por palabra. Es el mismo bucle que ya documenta el bloque del
// nombre, unas lineas mas abajo.
const VIA = /\b(calle|cll|cl|carrera|cra|kra|kr|avenida|av|ave|diagonal|dg|diag|transversal|tv|trans|manzana|mz|circular|circunvalar|autopista|via|vereda|vda|barrio|brr|corregimiento|sector|km|kilometro|lote|finca|conjunto|urbanizacion)\b/;

/**
 * Las vias que identifican una ZONA, no una nomenclatura.
 *
 * Para estas NO se exige numero: "Barrio Buenos Aires" es una direccion
 * completa en medio pais, y exigirle un numero rechazaba al cliente que
 * estaba dando su direccion. Para "calle" o "carrera" el numero sigue
 * siendo obligatorio: sin el, el mensajero no puede entregar.
 */
const VIA_DE_ZONA = /^(vereda|vda|barrio|brr|corregimiento|sector|finca|conjunto|urbanizacion|manzana|mz)$/;

/**
 * Palabras que NO son el nombre de la zona.
 *
 * "barrio el" o "vereda la" no identifican nada; "barrio Buenos Aires" si.
 * Sin este filtro, un "vivo en el barrio" pasaria como direccion.
 */
const PALABRAS_VACIAS_DE_ZONA = new Set(["el", "la", "los", "las", "de", "del", "mi", "en", "un", "una", "es"]);

// ==========================================================================
// EL NOMBRE, CUANDO EL CLIENTE LO DICE
//
// EL DEFECTO QUE ESTO ARREGLA, y bloqueaba ventas enteras: el nombre NO se
// extraia nunca del texto. Ni "soy Luz Marina", ni "me llamo Pedro", ni un
// nombre suelto. Venia SOLO del perfil de WhatsApp.
//
// Y el nombre es obligatorio para despachar. Asi que cuando el perfil no lo
// trae -o trae algo generico- pasaba esto:
//
//   bot:     "...me pasas tu nombre completo y la dirección"
//   clienta: "soy Luz Marina, Calle 20 # 15-30"
//   bot:     "...me pasas tu nombre completo"     <- no lo leyo
//   clienta: "Luz Marina"
//   bot:     "...me pasas tu nombre completo"     <- bucle
//
// La venta se perdia pidiendo un dato que la clienta ya habia dado dos
// veces.
//
// SOLO CON MARCADOR EXPLICITO. "soy X", "me llamo X", "mi nombre es X".
// Un nombre SUELTO -"Luz Marina"- no se extrae a proposito: sin marcador es
// indistinguible de cualquier otro texto, y confundir una frase cualquiera
// con el nombre del destinatario acaba en una guia con un nombre inventado.
// Lo que el cliente escribe suelto lo recoge el perfil o se le pregunta.
//
// Y lo extraido se PROPONE, no se confirma: pasa por `validarNombre`, que
// ya rechaza numeros, saludos y cosas de menos de tres letras.
// ==========================================================================
const DICE_SU_NOMBRE = [
  /\b(?:soy|me\s+llamo|mi\s+nombre\s+es)\s+([^,.;\n]{3,60})/iu,
];

/**
 * Palabras que no forman parte de un nombre.
 *
 * Se usan DOS veces y por eso estan en un solo sitio: si alguna de estas
 * abre la captura, no es un nombre ("soy de Cali", "soy la mama de Juan");
 * y si aparece en medio, ahi se corta porque empieza otra frase
 * ("soy Marco y vivo en Palmira").
 *
 * "de" solo vale como corte al principio: "Luz Marina de Jesus" es un
 * nombre de verdad, asi que en medio no se toca.
 */
const NO_ES_NOMBRE = String.raw`y|e|o|u|pero|que|de|del|la|el|los|las|una?|unos|unas|mi|mis|su|tu|para|por|muy|bien|nada|solo|solamente|yo|quien|cliente|interesad[oa]|vivo|vivimos|vive|estoy|soy|necesito|quiero|quisiera|desde|en|con|aqui|alla`;

/** Si la captura EMPIEZA por una de estas, no es un nombre. */
const NO_ES_NOMBRE_TRAS_MARCADOR = new RegExp(String.raw`^(?:${NO_ES_NOMBRE})\b`, "i");

/** Si aparece en MEDIO, ahi termina el nombre y empieza otra frase. */
const EMPIEZA_OTRA_FRASE = new RegExp(
  String.raw`\s+(?:${NO_ES_NOMBRE.split("|").filter((p) => p !== "de" && p !== "del").join("|")})\s+`,
  "i"
);

function nombreEn(textoCrudo, { seLoPidieron = false } = {}) {
  const crudo = String(textoCrudo ?? "");
  for (const re of DICE_SU_NOMBRE) {
    const m = crudo.match(re);
    if (!m) continue;
    const candidato = String(m[1] || "").trim();
    if (!candidato) continue;
    if (NO_ES_NOMBRE_TRAS_MARCADOR.test(candidato)) {
      return { valor: null, porQue: `"${candidato.slice(0, 20)}" tras el marcador no es un nombre` };
    }
    // Un nombre no lleva cifras: si las lleva, el cliente dijo otra cosa.
    if (/\d/.test(candidato)) {
      return { valor: null, porQue: "lo que sigue al marcador lleva numeros: no es un nombre" };
    }

    // El nombre suele venir pegado a lo siguiente sin una coma que lo
    // separe: "soy Marco y vivo en Palmira". Sin este corte el candidato
    // pasaba de cuatro palabras y se descartaba el mensaje entero, que es
    // justo como escribe la gente.
    const sinCola = candidato.split(EMPIEZA_OTRA_FRASE)[0].replace(/[\s,;.]+$/, "").trim();
    if (!sinCola) {
      return { valor: null, porQue: "tras el marcador no quedo nada utilizable" };
    }

    // Maximo cuatro palabras: mas que eso es una frase, no un nombre.
    const palabras = sinCola.split(/\s+/).filter(Boolean);
    if (palabras.length > 4) {
      return { valor: null, porQue: "demasiadas palabras para ser un nombre" };
    }
    return { valor: palabras.join(" "), porQue: "lo dijo con un marcador explicito" };
  }

  // ----------------------------------------------------------------------
  // EL NOMBRE A SECAS, PERO SOLO SI SE LE ACABA DE PEDIR
  //
  // ⚠️ VENTA PERDIDA MEDIDA (08-oct):
  //
  //   bot      · "...me pasas tu nombre completo y la dirección"
  //   cliente  · "Moisés Humanez"
  //   bot      · "Perdón, no quiero repetirme. Dime concretamente qué
  //               necesitas y lo reviso con el equipo."
  //
  // Exigir un marcador ("soy X", "me llamo X") es correcto cuando el nombre
  // llega SIN QUE NADIE LO PIDA: ahi "Buenos Aires" o "Interapidisimo" se
  // leerian como nombres. Pero cuando el bot ACABA DE PEDIR el nombre, lo
  // normal es contestar solo el nombre — nadie escribe "me llamo Moisés
  // Humanez" cuando le preguntan como se llama.
  //
  // Y el efecto era doble: ademas de no capturarlo, el texto de salida
  // quedaba identico al anterior y saltaba la guarda anti-eco, asi que el
  // cliente que dio su nombre recibia "dime concretamente qué necesitas".
  //
  // `seLoPidieron` lo pasa el cerebro, que es el unico que sabe si el turno
  // anterior pidio el nombre. El dominio sigue siendo puro: recibe el hecho,
  // no lo consulta.
  //
  // Los candados que se mantienen, porque aqui no hay marcador que ayude:
  //   · entre 1 y 4 palabras, todas de letras (nada de cifras ni signos);
  //   · ninguna palabra de `NO_ES_NOMBRE` (articulos, verbos, muletillas);
  //   · no puede ser una ciudad del listado -"Popayán" no es un nombre-;
  //   · no puede traer un tipo de via: eso es una direccion.
  // ----------------------------------------------------------------------
  if (seLoPidieron) {
    const limpio = crudo.replace(/[.,;:!¡?¿]/g, " ").replace(/\s+/g, " ").trim();
    const palabras = limpio.split(/\s+/).filter(Boolean);
    const plano = aplanar(limpio);
    const todasLetras = palabras.every((p) => /^[\p{L}'’-]{2,}$/u.test(p));
    const algunaProhibida = palabras.some((p) => NO_ES_NOMBRE_TRAS_MARCADOR.test(aplanar(p)));

    if (
      palabras.length >= 1 &&
      palabras.length <= 4 &&
      todasLetras &&
      !algunaProhibida &&
      !VIA.test(plano) &&
      !ciudadEn(limpio).valor
    ) {
      return { valor: palabras.join(" "), porQue: "contesto al nombre que se le acababa de pedir" };
    }
  }

  return { valor: null, porQue: "no dijo su nombre con un marcador" };
}

/** Señales de que el cliente esta diciendo una cantidad. */
const SENAL_CANTIDAD = /\b(quiero|quisiera|dame|deme|mandame|mandeme|enviame|envieme|necesito|llevo|llevame|pongame|ponme|serian|seran|son|me\s+das|me\s+manda|pido|pedir)\b/;

/** Señales de que pide UNO. "lo quiero", "me lo llevo", "quiero el ...". */
const SENAL_SINGULAR = /\b(lo|la)\s+(quiero|compro|llevo|tomo|necesito)\b|\bquiero\s+(el|la|uno|una)\b|\bme\s+lo\s+llevo\b|\bun[oa]?\s+(solo|sola|nada\s+mas)\b/;

/** Señales de plural sin numero: "quiero varios". No se adivina cuantos. */
const SENAL_PLURAL_VAGA = /\b(varios|varias|unos|unas|cuantos|algunos|muchos)\b/;

/** Palabras que NO pueden ser el inicio de una direccion aunque lleven numero. */
const FALSAS_DIRECCIONES = /\b(whatsapp|telefono|celular|cedula|documento|nit|numero\s+de\s+guia)\b/;

/**
 * Cantidad propuesta a partir del texto.
 *
 * @returns {{valor: number|null, porQue: string}}
 */
function cantidadEn(textoCrudo) {
  const plano = aplanar(textoCrudo);
  if (!plano) return { valor: null, porQue: "texto vacio" };

  // Una direccion esta llena de numeros. Si el mensaje parece una direccion,
  // no se lee ninguna cantidad de ahi.
  //
  // Esto no es precaucion teorica: la primera version proponia cualquier
  // numero entre 1 y 50, y "vivo en la calle 45" se convertia en 45
  // unidades. La direccion es justo donde mas numeros escribe un cliente.
  if (VIA.test(plano)) return { valor: null, porQue: "el mensaje parece una direccion: sus numeros no son cantidades" };
  if (FALSAS_DIRECCIONES.test(plano)) return { valor: null, porQue: "los numeros del mensaje son un identificador" };

  // ----------------------------------------------------------------------
  // "UNO" A SECAS TAMBIEN ES UNA CANTIDAD
  //
  // Esto solo aceptaba el DIGITO suelto ("1"), no la palabra. Y la palabra
  // es la respuesta natural a la pregunta que hace el propio bot:
  //
  //   bot:     "...me pasas la dirección y si quieres uno o dos"
  //   clienta: "uno"
  //   bot:     "¿Cuántos quieres?"      <- no la entendia
  //
  // Se atascaba ahi hasta que la guarda anti-eco cortaba la conversacion:
  // la venta se perdia respondiendo a su propia pregunta.
  //
  // SE EXIGE QUE EL MENSAJE SEA SOLO ESO, con cortesia alrededor como
  // mucho. Es lo que mantiene fuera el riesgo: "una" es tambien un
  // articulo, y en "una pregunta rapida" no es ninguna cantidad. Pedir que
  // el mensaje entero sea el numero deja fuera esos casos sin volver a la
  // heuristica que leia "calle 45" como 45 unidades.
  // ----------------------------------------------------------------------
  // "nada amas" es "nada más" escrito rapido desde el movil, y es literal de
  // un chat del 08-oct: la clienta contesto "1 nada amas" a "¿cuántos
  // quieres?" y el bot no leyo la cantidad.
  const CORTESIA =
    /\b(por\s+favor|porfa|porfavor|gracias|solo|solamente|unicamente|nada\s+a?mas|nomas|no\s+mas|mas|si|sip|ok|listo|dale|quiero|seria|serian)\b/g;
  let pelado = plano.replace(CORTESIA, " ").replace(/\s+/g, " ").trim();

  // ----------------------------------------------------------------------
  // "1 A BOGOTÁ" DICE LA CANTIDAD Y LA CIUDAD. SE PERDIAN LAS DOS.
  //
  // ⚠️ VENTA PERDIDA, MEDIDA (chat de Santiago, 08-oct):
  //
  //   bot      · "¿Cuántos quieres? Y para preparar tu pedido me pasas la
  //               ciudad y la dirección."
  //   cliente  · "1 a Bogotá"
  //   bot      · "¡Perfecto! A Bogota te llega en 1 a 3 días hábiles."
  //   cliente  · "Si"
  //   bot      · "¿Cuántos quieres? Y para preparar tu pedido me pasas la
  //               dirección."        <- le vuelve a preguntar lo que ya dijo
  //
  // Contestar DOS cosas en un mensaje es lo normal cuando se preguntan dos.
  // El mensaje no era "solo un numero", asi que la cantidad se caia, y el
  // cliente tuvo que decirla tres veces.
  //
  // El arreglo es seguro porque quita algo que NUNCA es una cantidad: el
  // nombre de una ciudad del listado, y la preposicion que la introduce.
  // Si lo que queda es exactamente el numero, era una cantidad.
  //
  // Y NO AFLOJA EL CANDADO DE LAS DIRECCIONES: un mensaje con tipo de via
  // ya devolvio null mucho antes de llegar aqui, asi que "calle 45" sigue
  // sin ser 45 unidades.
  // ----------------------------------------------------------------------
  const ciudadMencionada = ciudadEn(textoCrudo);
  if (ciudadMencionada.valor) {
    pelado = pelado
      .replace(new RegExp(`\\b${ciudadMencionada.valor.replace(/\s+/g, "\\s+")}\\b`, "g"), " ")
      .replace(/\b(a|para|en|hacia|hasta|pa)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const esSoloUnNumero =
    /^\s*\d{1,2}\s*$/.test(String(textoCrudo)) ||
    Object.keys(NUMEROS_EN_PALABRAS).includes(pelado) ||
    /^\d{1,2}$/.test(pelado);

  if (SENAL_CANTIDAD.test(plano) || esSoloUnNumero) {
    const numeros = cantidadesEn(textoCrudo).filter((n) => n.valor >= 1 && n.valor <= 20);
    if (numeros.length) {
      // Varias señales en conflicto ("queria dos, mejor uno"): gana la
      // ultima, que es la correccion del cliente.
      return { valor: numeros[numeros.length - 1].valor, porQue: "cantidad dicha explicitamente" };
    }
  }

  if (SENAL_PLURAL_VAGA.test(plano)) {
    // "quiero varios" no dice cuantos. Adivinar es cobrar mal.
    return { valor: null, porQue: "pide varios sin decir cuantos: hay que preguntar" };
  }

  if (SENAL_SINGULAR.test(plano)) {
    // "lo quiero", "quiero el cinturon": el cliente habla de UNO. No es una
    // invencion, es lo que dice la frase. Y si hubiera duda, la cantidad
    // menor nunca cobra de mas.
    return { valor: 1, porQue: "el cliente habla en singular" };
  }

  return { valor: null, porQue: "no hay ninguna señal de cantidad" };
}

/** Nombres de ciudad conocidos, los mas largos primero para que gane el especifico. */
const NOMBRES_DE_CIUDAD = Object.keys(CIUDADES_SEMILLA).sort((a, b) => b.length - a.length);

/**
 * Ciudad mencionada en el texto, si se reconoce alguna del listado.
 *
 * Solo propone nombres del listado: asi una frase como "por aqui cerca"
 * nunca llega a proponerse como ciudad. Lo que no esta en el listado lo
 * puede proponer la IA, y entonces destino.js lo acepta MARCADO para
 * revision.
 *
 * @returns {{valor: string|null, porQue: string}}
 */
function ciudadEn(textoCrudo) {
  const plano = aplanar(textoCrudo);
  if (!plano) return { valor: null, porQue: "texto vacio" };

  const encontradas = [];
  for (const nombre of NOMBRES_DE_CIUDAD) {
    const re = new RegExp(`\\b${nombre.replace(/\s+/g, "\\s+")}\\b`);
    const m = plano.match(re);
    if (m) encontradas.push({ nombre, posicion: m.index });
  }

  if (!encontradas.length) return { valor: null, porQue: "no se reconoce ninguna ciudad del listado" };

  // ----------------------------------------------------------------------
  // "SAN ANDRES DE SOTAVENTO" NO ES "SAN ANDRES"
  //
  // ⚠️ DEFECTO REAL, Y DE LOS CAROS: EL BOT IBA A DESPACHAR A OTRO
  //    DEPARTAMENTO.
  //
  // Chat del 08-oct. La clienta escribio "San andres de sotavento Córdoba",
  // que es un municipio de Córdoba, y la ficha quedo con ciudad "San
  // Andres" — el archipielago, a 700 km y con flete aereo. El \b de
  // `\bsan andres\b` cierra en el espacio, asi que casa DENTRO del nombre
  // largo; y como el nombre largo no estaba en la semilla, la deduplicacion
  // por longitud no tenia nada mejor que elegir.
  //
  // Colombia esta llena de municipios asi -San Vicente de Chucurí, Santa
  // Cruz de Lorica, San Juan de Urabá, Puerto Libertador...- y la semilla
  // esta incompleta A PROPOSITO. Asi que no basta con añadir este: hace
  // falta la regla general.
  //
  // Si detras del nombre que caso viene " de <algo>", el toponimo de verdad
  // es mas largo que lo que reconocimos. Se devuelve el nombre COMPLETO:
  // `destino.resolverCiudad` no lo encontrara en la semilla y lo aceptara
  // con `revisar: true`, que es exactamente el comportamiento correcto —la
  // venta no se pierde y una persona confirma el destino antes de la guia—.
  //
  // Devolver null seria peor: volveria a preguntar la ciudad a quien ya la
  // dio bien, que es el bucle que ya costo una venta ese mismo dia.
  // ----------------------------------------------------------------------
  const conCompuesto = encontradas.map((e) => {
    const resto = plano.slice(e.posicion + e.nombre.length);
    const m = resto.match(/^\s+de(?:\s+la|\s+los|\s+las|l)?\s+([a-z]+)(?:\s+([a-z]+))?/);
    if (!m) return e;
    // Solo se extiende con la primera palabra. "san andres de sotavento
    // cordoba" tiene el departamento detras, y meterlo en el nombre de la
    // ciudad lo imprimiria en la guia.
    return { ...e, nombre: `${e.nombre} de ${m[1]}`, compuesto: true };
  });
  encontradas.length = 0;
  encontradas.push(...conCompuesto);

  // Si se mencionan dos ciudades distintas, NO se elige. "soy de Cali pero
  // mandalo a Medellin" tiene dos, y escoger mal es despachar a otra ciudad.
  const distintas = new Set(
    encontradas.filter((e) => !encontradas.some((o) => o.nombre !== e.nombre && o.nombre.includes(e.nombre))).map((e) => e.nombre)
  );
  if (distintas.size > 1) {
    return { valor: null, porQue: `el mensaje menciona ${distintas.size} ciudades: hay que preguntar` };
  }

  return { valor: [...distintas][0], porQue: "ciudad del listado conocido" };
}

/**
 * Direccion mencionada en el texto.
 *
 * Se exige un tipo de via Y un numero. Lo que no cumpla eso no se propone:
 * "mi casa" tiene que llegar vacio para que el bot pregunte, no llegar como
 * candidato para que luego lo rechace la validacion.
 *
 * @returns {{valor: string|null, porQue: string}}
 */
function direccionEn(textoCrudo) {
  const crudo = String(textoCrudo ?? "").trim();
  const plano = aplanar(crudo);
  if (!plano) return { valor: null, porQue: "texto vacio" };

  // OJO: aqui NO se descarta el mensaje por mencionar un telefono o una
  // cedula.
  //
  // Antes si, y costaba la direccion justo cuando la clienta la daba bien:
  //
  //   clienta: "Calle 45 # 23-10, mi celular es 3058742138"
  //   bot:     "...me pasas la dirección"      <- la acababa de dar
  //
  // Es como escribe TODO el mundo los datos de despacho: direccion y
  // telefono en el mismo mensaje. El mensaje entero se tiraba por traer un
  // numero de contacto.
  //
  // Lo que protege de verdad contra una direccion inventada es la exigencia
  // de un TIPO DE VIA mas un NUMERO, que esta justo debajo; el telefono se
  // RECORTA mas abajo, que es lo que habia que hacer desde el principio.
  const m = plano.match(VIA);
  if (!m) return { valor: null, porQue: "no se reconoce ningun tipo de via" };
  if (!/\d/.test(plano.slice(m.index))) {
    // ------------------------------------------------------------------
    // UNA ZONA CON NOMBRE SI ES UNA DIRECCION. EL BOT LA PEDIA Y LA TIRABA.
    //
    // ⚠️ VENTA PERDIDA, MEDIDA, CON RESCATE MANUAL (08-oct).
    //
    //   clienta · "San andres de sotavento Córdoba"
    //   clienta · "Uno"
    //   clienta · "Barrio buenos aires"
    //   bot     · "Para preparar tu pedido me pasas la dirección 🙌"
    //   clienta · "No entiendo"
    //   bot     · (se callo 12 h)
    //
    // Y la contradiccion estaba escrita en nuestro propio texto: cuando
    // falta la direccion por segunda vez, el bot dice *«dime el barrio y,
    // si tienes, la calle con el número, o un punto de referencia»*. Le
    // pedia el barrio y luego no lo aceptaba porque no traia numero.
    //
    // En media Colombia -pueblos, veredas, corregimientos- la direccion ES
    // el barrio mas un punto de referencia; no hay nomenclatura. Exigir un
    // numero ahi es rechazar al cliente que si esta dando su direccion.
    //
    // La exigencia del numero se mantiene donde SI es esencial (calle,
    // carrera, diagonal: sin numero no se puede entregar). Para las vias de
    // ZONA basta un nombre propio detras — "barrio" solo, sin nombre, sigue
    // sin valer, igual que "mi casa".
    //
    // Y no deja el pedido a ciegas: `faltan` sigue su curso y el bot pide
    // el punto de referencia, que es lo que de verdad necesita el mensajero.
    // ------------------------------------------------------------------
    const esZona = VIA_DE_ZONA.test(m[0]);
    const nombreDeLaZona = plano
      .slice(m.index + m[0].length)
      .trim()
      .split(/\s+/)
      .filter((p) => p && !PALABRAS_VACIAS_DE_ZONA.has(p));
    if (!esZona || nombreDeLaZona.length === 0) {
      return { valor: null, porQue: "hay un tipo de via pero sin numero: no sirve para despachar" };
    }
  }

  // Se recorta sobre el texto CRUDO para conservar tildes y signos: la guia
  // la lee una persona, y "Calle 45 # 23-10" es mas util que "calle 45 23 10".
  const palabraVia = m[0];
  const inicio = crudo.toLowerCase().indexOf(palabraVia);
  if (inicio === -1) return { valor: crudo, porQue: "direccion reconocida" };

  let fragmento = crudo.slice(inicio).trim();

  // Se corta donde empieza otra cosa. "Calle 45 # 23-10, quiero 2" lleva la
  // direccion Y la cantidad; sin este corte, "quiero 2" acabaria impreso en
  // la guia de la transportadora.
  // Los identificadores se cortan CON O SIN "mi" delante: la gente escribe
  // "cel 3058742138" tanto como "mi celular es 3058742138", y un telefono
  // impreso en el campo de direccion de la guia es un error de despacho.
  const corte = fragmento.search(
    /[,;.]?\s*\b(quiero|quisiera|necesito|mandame|mandeme|enviame|envieme|dame|deme|llevo|pongame|gracias|soy|(mi\s+)?(telefono|celular|cel|tel|cedula|documento|nit|whatsapp|nombre)\b|numero\s+de\s+(guia|contacto|celular|telefono))\b/i
  );
  if (corte > 0) fragmento = fragmento.slice(0, corte).trim();

  // Si al final viene una ciudad del listado, se quita: la ciudad va en su
  // propio campo y repetirla en la direccion ensucia la guia.
  const ciudad = ciudadEn(fragmento);
  if (ciudad.valor) {
    const re = new RegExp(`[,;]?\\s*${ciudad.valor.replace(/\s+/g, "\\s+")}\\s*$`, "i");
    fragmento = fragmento.replace(re, "").trim();
  }

  fragmento = fragmento.replace(/[,;.\s]+$/, "").trim();

  if (fragmento.length < 8) return { valor: null, porQue: "lo reconocido es demasiado corto" };
  return { valor: fragmento, porQue: "direccion reconocida" };
}

/**
 * Todos los candidatos que se pueden sacar del texto sin modelo.
 *
 * @returns {{candidatos: object, porQue: object}}
 */
function deTexto(textoCrudo, { seLoPidieron = false } = {}) {
  const candidatos = {};
  const porQue = {};

  const cantidad = cantidadEn(textoCrudo);
  if (cantidad.valor !== null) {
    candidatos.cantidad = cantidad.valor;
  }
  porQue.cantidad = cantidad.porQue;

  const ciudad = ciudadEn(textoCrudo);
  if (ciudad.valor !== null) candidatos.ciudad = ciudad.valor;
  porQue.ciudad = ciudad.porQue;

  const direccion = direccionEn(textoCrudo);
  if (direccion.valor !== null) candidatos.direccion = direccion.valor;
  porQue.direccion = direccion.porQue;

  const nombre = nombreEn(textoCrudo, { seLoPidieron });
  if (nombre.valor !== null) candidatos.nombre = nombre.valor;
  porQue.nombre = nombre.porQue;

  return { candidatos, porQue };
}

/**
 * Combina los candidatos de la heuristica y los de la IA.
 *
 * LA HEURISTICA GANA cuando las dos proponen algo distinto para el mismo
 * campo. No por desconfianza general en el modelo, sino porque la
 * heuristica solo propone lo que ha reconocido contra una lista o un patron,
 * mientras el modelo propone lo que le parece. Donde la heuristica no llega
 * -documento, variante, ciudades fuera del listado, o un nombre dicho sin
 * marcador- el modelo es la unica fuente, y ahi se usa.
 */
function combinar(deHeuristica, deIA) {
  const salida = { ...(deIA || {}) };
  for (const [campo, valor] of Object.entries(deHeuristica || {})) {
    if (valor !== null && valor !== undefined && valor !== "") salida[campo] = valor;
  }
  return salida;
}

module.exports = { deTexto, cantidadEn, ciudadEn, direccionEn, nombreEn, combinar, VIA };
