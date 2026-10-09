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
const { CIUDADES, DEPARTAMENTOS } = require("./destino");

/**
 * El detector de "esto es una pregunta", que vive en `preguntas.js`.
 *
 * ⚠️ SE CARGA PEREZOSAMENTE, Y A PROPOSITO. Hoy `preguntas` solo depende de
 * `texto`, asi que un `require` arriba no haria ciclo; pero este modulo es
 * el que mas abajo esta en la pila -lo usan el cerebro y el panel- y un
 * `require` diferido cuesta nada (Node cachea el modulo) y deja el grafo de
 * carga como estaba. Se usa en los dos candados de "una pregunta no es un
 * dato": el del nombre y el de la ciudad.
 */
const PALABRA_DE_PREGUNTA = () => require("./preguntas").PALABRA_DE_PREGUNTA;

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
// ⚠️ AMPLIADA EL 2026-10-09 CON LOS FORMATOS QUE PIDIO MARCO (A2).
//
// Faltaban los que la gente escribe de verdad: "Casa 4", "Apto 302",
// "Torre B", "Etapa 2", "Bloque 3", "Via a La Calera". Una direccion que el
// bot no reconoce es una venta que se queda pidiendo el mismo dato.
const VIA =
  /\b(calle|cll|cl|carrera|cra|kra|kr|avenida|av|ave|avda|diagonal|dg|diag|transversal|tv|tver|trans|manzana|mz|mza|circular|circunvalar|autopista|via|vereda|vda|barrio|brr|bar|corregimiento|cgto|sector|km|kilometro|lote|finca|parcela|conjunto|urbanizacion|urb|casa|apto|apartamento|apartaestudio|torre|bloque|etapa|interior|int|unidad\s+residencial|resguardo|invasion|comuna|localidad)\b/;

/**
 * Las vias que identifican una ZONA, no una nomenclatura.
 *
 * Para estas NO se exige numero: "Barrio Buenos Aires" es una direccion
 * completa en medio pais, y exigirle un numero rechazaba al cliente que
 * estaba dando su direccion. Para "calle" o "carrera" el numero sigue
 * siendo obligatorio: sin el, el mensajero no puede entregar.
 */
const VIA_DE_ZONA =
  /^(vereda|vda|barrio|brr|bar|corregimiento|cgto|sector|finca|parcela|conjunto|urbanizacion|urb|manzana|mz|mza|etapa|bloque|torre|resguardo|invasion|comuna|localidad)$/;

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
// ==========================================================================
// ⚠️ ESTA LISTA TENIA TRES MARCADORES Y COSTO UNA VENTA DE $85.000.
//
// Chat de Ailid, 09-oct 00:08. En un solo mensaje mando su nombre completo,
// dos telefonos y la direccion. El bot armo el resumen con "Ailid🥰" -el
// nombre de su PERFIL de WhatsApp- e ignoro el que ella escribio.
//
// Lo intento corregir CUATRO veces:
//
//   "A nombre de Nevis Sánchez López"
//   "Hay donde dice ailid, no es, es Nevis Johana Sánchez López"
//   "Es a nombre de Nevis Jhoana Sánchez López"
//   "Pero a nombre de Nevis Johana Sánchez López"
//
// Ninguna casaba: la lista solo tenia "soy", "me llamo" y "mi nombre es".
// "A nombre de" es LA forma de decirlo cuando el pedido va para alguien, y
// no estaba. Cansada escribio "No" -queriendo decir "no, el nombre esta
// mal"- y el bot se despidio.
//
// Acabo confirmando un pedido de 2 unidades con el nombre equivocado y
// despues pidiendo que lo cancelaran.
// ==========================================================================
const DICE_SU_NOMBRE = [
  /\b(?:soy|me\s+llamo|mi\s+nombre\s+es)\s+([^,.;\n/]{3,60})/iu,
  // "a nombre de X", "a nombre: X". El marcador del destinatario.
  /\ba\s+nombre\s+(?:de|del)?\s*:?\s*([^,.;\n/]{3,60})/iu,
  // "el nombre es X", "el nombre completo es X".
  /\bel\s+nombre\s+(?:completo\s+)?(?:es|seria|va\s+a\s+nombre\s+de)\s*:?\s*([^,.;\n/]{3,60})/iu,
  // "es para X", "va para X", "lo recibe X", "quien recibe es X".
  /\b(?:es|va)\s+para\s+([^,.;\n/]{3,60})/iu,
  /\b(?:lo\s+|la\s+)?recibe\s*:?\s*([^,.;\n/]{3,60})/iu,
  /\bdestinatario\s*:?\s*([^,.;\n/]{3,60})/iu,
  // "no es X, es Y" -> se queda con la Y, que es la correccion.
  //
  // Va DESPUES de los marcadores de arriba a proposito: si el mensaje trae
  // "a nombre de", ese es mas explicito. Esta forma es la de quien corrige
  // señalando el error, que es como escribio Ailid la segunda vez.
  // La parte del medio es OPCIONAL: "no es, es Nevis Johana" es literal del
  // chat de Ailid, y con `{2,40}` obligatorio no casaba.
  /\bno\s+es\s*[^,.;\n]{0,40},?\s+es\s+([^,.;\n/]{3,60})/iu,
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

/**
 * Palabras que NUNCA son un nombre de persona en un chat de ventas.
 *
 * Solo se usa en el camino SIN MARCADOR -el nombre a secas, cuando el bot
 * lo acaba de pedir-, que es el unico que no tiene un "soy" delante para
 * apoyarse. Ahi hace falta esta red: "Me gusta" se estaba guardando como
 * nombre del cliente.
 *
 * Son pronombres, muletillas, verbos de chat y las palabras del propio
 * negocio. Si falta alguna se añade: equivocarse aqui escribe un nombre
 * falso en la guia de la transportadora.
 */
const NO_SON_NOMBRE_SUELTO = new Set(
  (
    "me te se le lo la los las nos yo tu usted ustedes " +
    "gusta gustan gusto encanta quiero quiere queria necesito necesita sirve interesa " +
    "listo lista bueno buena buenas buenos hola holaa gracias si no ok oka okey okay vale dale " +
    "claro perfecto excelente genial chevere bien mal mucho poco mas menos ya ahi aqui alla " +
    "cuanto cuanta cuantos cuantas cuando donde como cual cuales que quien porque pues " +
    "favor porfa espera mire oiga oye señor señora senor senora amiga amigo " +
    "info informacion pedido pedir compra comprar envio envios precio valor costo " +
    "cinturon termico rosado color talla garantia foto fotos imagen " +
    "direccion barrio ciudad pueblo vereda calle carrera cra avenida " +
    "hoy manana ayer dias dia hora horas " +
    // LAS TRANSPORTADORAS. Un cliente del 08-oct contesto "Interapidisimo"
    // -preguntando por cual transportadora era- y se guardaba como su
    // nombre. Y es predecible que las escriban: el propio bot habla de "la
    // transportadora" y de la guia.
    "interrapidisimo interapidisimo inter servientrega coordinadora envia enviaa tcc deprisa " +
    "redex saferbo mensajeros transprensa domina"
  )
    .split(/\s+/)
    // ⚠️ LOS NUMEROS EN PALABRA, Y ES OTRO DEFECTO DE PRODUCCION DEL MISMO
    //    DIA (2026-10-09, `herramientas/revivir.js` caso de Mauricio).
    //
    // El bot pregunta "¿cuántos quieres?", la clienta contesta "uno", y
    // "uno" se guardaba como SU NOMBRE. En el panel quedaba «Para: Uno», y
    // encima pisaba el nombre de perfil de WhatsApp, que era el correcto
    // ("Mauricio Benítez"). Es la respuesta mas natural del mundo a la
    // pregunta que el propio bot acaba de hacer.
    //
    // No se escriben a mano: se toman del mapa que ya existe en `texto.js`
    // -el mismo que usa el cotizador para entender "quiero dos"-. Si
    // mañana se añade "quince" alli, este candado lo hereda. Una lista
    // copiada a mano es justo como nacieron los otros dos defectos de esta
    // tanda.
    .concat(Object.keys(require("./texto").NUMEROS_EN_PALABRAS))
);

/** Si aparece en MEDIO, ahi termina el nombre y empieza otra frase. */
const EMPIEZA_OTRA_FRASE = new RegExp(
  String.raw`\s+(?:${NO_ES_NOMBRE.split("|").filter((p) => p !== "de" && p !== "del").join("|")})\s+`,
  "i"
);

/**
 * ¿Este texto es SOLO un lugar, y por tanto no puede ser un nombre?
 *
 * ⚠️ ESTO ERA `!ciudadEn(limpio).valor` Y SE ROMPIO AL CARGAR LOS 1.037
 *    MUNICIPIOS DEL DANE. Es la regresion mas cara que produjo la lista
 *    completa, y conviene que quede escrita.
 *
 * El candado existia para que "Medellin" no se guardara como el NOMBRE del
 * cliente. Con 60 ciudades funcionaba. Con 1.037 resulta que MUCHOS
 * APELLIDOS COLOMBIANOS SON MUNICIPIOS: Garzón (Huila), Bolívar, Córdoba,
 * Mosquera, Ospina, Páez… Asi que "Alejandro león Garzón" contenia una
 * "ciudad" y dejaba de ser un nombre.
 *
 * El chat de Popayan -el que se arreglo ayer- volvio a romperse por esto.
 *
 * LA REGLA CORRECTA no es "contiene un lugar" sino "es SOLO lugares": si
 * TODAS las palabras son nombre de municipio o de departamento, el cliente
 * esta dando su destino; si alguna no lo es, esta dando su nombre.
 *
 *   "Popayán Cauca"           -> las dos son lugares  -> no es un nombre
 *   "Alejandro león Garzón"   -> "alejandro" no lo es -> SI es un nombre
 */
function esSoloUnLugar(texto) {
  const plano = aplanar(texto);
  if (!plano) return false;
  const palabras = plano.split(/\s+/).filter(Boolean);
  if (!palabras.length) return false;
  // El texto entero es el nombre de un municipio ("San Andres de Sotavento").
  if (CIUDADES[plano]) return true;
  return palabras.every((p) => Boolean(CIUDADES[p]) || DEPARTAMENTOS.has(p));
}

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
  //   cliente  · "Mauricio Benítez"
  //   bot      · "Perdón, no quiero repetirme. Dime concretamente qué
  //               necesitas y lo reviso con el equipo."
  //
  // Exigir un marcador ("soy X", "me llamo X") es correcto cuando el nombre
  // llega SIN QUE NADIE LO PIDA: ahi "Buenos Aires" o "Interapidisimo" se
  // leerian como nombres. Pero cuando el bot ACABA DE PEDIR el nombre, lo
  // normal es contestar solo el nombre — nadie escribe "me llamo
  // Mauricio Benítez" cuando le preguntan como se llama.
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
    // ------------------------------------------------------------------
    // ⚠️ Y SE PRUEBA LINEA POR LINEA. VENTA PERDIDA MEDIDA (chat de
    //    Popayan, 08-oct, encontrada por Marco el 10-oct).
    //
    // La clienta contesto los tres datos en UN SOLO MENSAJE, que es como
    // los contesta medio mundo cuando se los piden juntos:
    //
    //   bot      · "...me pasas tu nombre completo, la ciudad y la
    //               dirección"
    //   cliente  · "Alejandro león Garzón
    //               Popayán Cauca
    //               Barrio pueblillo en la cantera la pintada"
    //
    // La ciudad y la direccion SI se capturaron -sus patrones buscan dentro
    // del texto-. El nombre no, porque este bloque mira EL MENSAJE ENTERO
    // como un solo candidato: doce palabras, con una ciudad y un tipo de
    // via dentro, falla los cuatro candados a la vez.
    //
    // En el panel quedo "Destinatario: sin confirmar", y el bot se paso la
    // conversacion pidiendo un nombre que ya tenia escrito delante. Despues
    // le dijo "Perdón, creo que no te entendí bien" a una clienta que habia
    // contestado TODO. A las 21:36 seguia sin pedido.
    //
    // El mensaje completo se prueba PRIMERO, para no cambiar el
    // comportamiento de los mensajes de una sola linea; las lineas se
    // prueban despues, y gana la primera que pase los candados. Cada linea
    // pasa exactamente las mismas comprobaciones que antes: no se relaja
    // ningun candado, solo se aplican al trozo correcto.
    // ------------------------------------------------------------------
    // ⚠️ TAMBIEN SE PARTE POR "/", Y COSTO UNA VENTA DE $85.000.
    //
    // Chat de Ailid (09-oct). Mando TODO en un mensaje, separado con barras,
    // que es la otra forma en que la gente contesta cuando le piden varios
    // datos juntos:
    //
    //   "Nevis Johana Sánchez López / 3105177896 / 3235340018 /
    //    KR 101#29c-07 / Lagos de suba / BOGOTÁ"
    //
    // Con solo el salto de linea, el trozo era el mensaje entero: trece
    // palabras con cifras dentro, falla todos los candados, y el nombre se
    // perdio. La direccion y la ciudad si se capturaron, porque sus patrones
    // buscan DENTRO del texto.
    const trozos = [crudo];
    if (/[\r\n/]/.test(crudo)) {
      for (const linea of crudo.split(/\r?\n|\s*\/\s*/)) {
        if (linea.trim()) trozos.push(linea);
      }
    }

    for (const trozo of trozos) {
      const limpio = trozo.replace(/[.,;:!¡?¿]/g, " ").replace(/\s+/g, " ").trim();
      if (!limpio) continue;
      const palabras = limpio.split(/\s+/).filter(Boolean);
      const plano = aplanar(limpio);
      const todasLetras = palabras.every((p) => /^[\p{L}'’-]{2,}$/u.test(p));
      // ⚠️ LA LISTA LARGA, Y LA CAZO UNA PRUEBA DE ESTA MISMA SESION.
      //
      // La primera version solo filtraba con `NO_ES_NOMBRE`, que esta
      // pensada para lo que va DETRAS de un marcador ("soy X"). Sin
      // marcador no basta: "Me gusta" son dos palabras, todas letras, no es
      // ciudad y no lleva tipo de via — asi que se guardaba como NOMBRE DEL
      // CLIENTE, y el mensaje salia con "¡Perfecto, gracias!" como si
      // hubiera dado un dato.
      //
      // Es el riesgo propio de capturar un nombre sin marcador, y se paga
      // con esta lista: las palabras que la gente escribe en un chat de
      // ventas y que NUNCA son un nombre de persona.
      const algunaProhibida = palabras.some(
        (p) => NO_ES_NOMBRE_TRAS_MARCADOR.test(aplanar(p)) || NO_SON_NOMBRE_SUELTO.has(aplanar(p))
      );

      // ------------------------------------------------------------------
      // ⚠️ UNA PREGUNTA NO ES UN NOMBRE. DEFECTO DE PRODUCCION, ENCONTRADO
      //    EL 2026-10-09 CORRIENDO `herramientas/revivir.js santiago`.
      //
      // El chat de pruebas de Marco: el cliente, con la peticion de datos
      // ya hecha, escribe "Tienes cinturones" —o sea "¿tienes cinturones?",
      // una pregunta de stock—. Pasaba los cinco candados y se guardaba
      // como NOMBRE DEL CLIENTE. El resumen decia «Para: Tienes cinturones
      // · Bogota», el cierre «¡Listo, Tienes!», y ese nombre es el que iba
      // a la guia de la transportadora.
      //
      // Y encima PISABA el nombre de perfil de WhatsApp, que era correcto
      // ("Santiago"): en cuanto se confirma con origen CLIENTE, el perfil
      // ya no vuelve a rellenar y solo un marcador explicito lo corrige. El
      // chat entero arrastraba el nombre falso.
      //
      // POR QUE SE COLABA, QUE ES LO QUE IMPORTA: la lista
      // `NO_SON_NOMBRE_SUELTO` es de palabras exactas y se mantiene a mano.
      // Le faltaba el verbo "tienes" -y "venden", "manejan", "hay"- y
      // tampoco frenaba "cinturones", porque la lista tiene el SINGULAR
      // "cinturon" y la comparacion es `Set.has` de cadena exacta. Los
      // otros mensajes-pregunta del mismo chat si se frenaban, pero por
      // casualidad: "Tiene garantía" por "garantia", "No cargaron" por
      // "no". Ir añadiendo palabras una a una no arregla la clase de fallo.
      //
      // Asi que el candado es de clase, no de palabra: si la frase PARECE
      // UNA PREGUNTA, no es un dato. Se reutiliza el detector que ya existe
      // en `preguntas.js` -que es justo donde vive el saber de "esto es una
      // pregunta"- en vez de ampliar esta lista por sexta vez.
      //
      // El `require` va aqui dentro, como el de `texto` en `preguntas.js`:
      // `preguntas` solo depende de `texto`, asi que no hay ciclo.
      //
      // ES ASIMETRICO A PROPOSITO: si se rechaza un nombre de verdad, el
      // bot lo vuelve a pedir y se pierde un turno. Si se acepta una
      // pregunta, Marco despacha un paquete a nombre de "Tienes
      // cinturones". Ante la duda, se rechaza.
      // ------------------------------------------------------------------
      const pareceUnaPregunta = /\?/.test(trozo) || PALABRA_DE_PREGUNTA().test(plano);

      if (
        palabras.length >= 1 &&
        palabras.length <= 4 &&
        todasLetras &&
        !algunaProhibida &&
        !pareceUnaPregunta &&
        !VIA.test(plano) &&
        !esSoloUnLugar(limpio)
      ) {
        return { valor: palabras.join(" "), porQue: "contesto al nombre que se le acababa de pedir" };
      }
    }
  }

  return { valor: null, porQue: "no dijo su nombre con un marcador" };
}

/** Señales de que el cliente esta diciendo una cantidad. */
const SENAL_CANTIDAD = /\b(quiero|quisiera|dame|deme|mandame|mandeme|enviame|envieme|necesito|llevo|llevame|pongame|ponme|serian|seran|son|me\s+das|me\s+manda|pido|pedir)\b/;

/** Señales de que pide UNO. "lo quiero", "me lo llevo", "quiero el ...". */
const SENAL_SINGULAR = /\b(lo|la)\s+(quiero|compro|llevo|tomo|necesito)\b|\bquiero\s+(el|la|uno|una)\b|\bme\s+lo\s+llevo\b|\bun[oa]?\s+(solo|sola|nada\s+mas)\b/;

/**
 * "Los 2", "las dos", "los dos" — el ARTICULO delante del numero.
 *
 * ⚠️ NO SE RECONOCIA, y es como se acepta el combo despues de oir su precio.
 *
 * Chat de Ailid (09-oct): el bot le dijo "si llevas dos, te quedan en
 * $85.000", ella contesto "Los 2", y la cantidad quedo sin fijar. El pedido
 * salio de 1 unidad.
 *
 * `SENAL_CANTIDAD` exige un verbo ("quiero 2", "dame 2") y aqui no hay
 * ninguno: el verbo esta implicito porque el bot acababa de preguntar. El
 * articulo hace el mismo papel que el verbo.
 */
const SENAL_CON_ARTICULO = /^\s*(los|las)\s+(\d{1,2}|dos|tres|cuatro)\s*$/;

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

  // "Los 2" / "las dos": el articulo delante del numero es una cantidad.
  const conArticulo = pelado.match(SENAL_CON_ARTICULO) || plano.match(SENAL_CON_ARTICULO);
  if (conArticulo) {
    const n = NUMEROS_EN_PALABRAS[conArticulo[2]] || Number.parseInt(conArticulo[2], 10);
    if (Number.isFinite(n) && n >= 1 && n <= 50) {
      return { valor: n, porQue: `"${String(textoCrudo).trim()}" dice la cantidad con el articulo delante` };
    }
  }

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
// ==========================================================================
// LOS NOMBRES DE CIUDAD, COMPILADOS UNA SOLA VEZ
//
// ⚠️ ESTO SE COMPILABA EN CADA LLAMADA, Y LA LISTA PASO DE 60 A 1.037.
//
// `ciudadEn` construia un `new RegExp` por cada nombre, en cada llamada. Con
// la semilla de 60 era invisible; con el listado del DANE serian 1.037
// expresiones compiladas por llamada, y `ciudadEn` se llama VARIAS VECES por
// turno: es el guardia de `nombreEn`, de `cantidadEn` y de `direccionEn`.
//
// Compilar una vez al cargar el modulo lo deja en una tabla fija. El coste
// por turno pasa a ser recorrerla, que sobre un mensaje de chat es trivial.
//
// Siguen ordenados de mas largo a mas corto para que gane el toponimo
// especifico: "san andres de sotavento" antes que "san andres".
// ==========================================================================
const NOMBRES_DE_CIUDAD = Object.keys(CIUDADES).sort((a, b) => b.length - a.length);

/** Los mismos nombres con su patron ya compilado. Ver el comentario de arriba. */
const PATRONES_DE_CIUDAD = NOMBRES_DE_CIUDAD.map((nombre) => ({
  nombre,
  re: new RegExp(`\\b${nombre.replace(/\s+/g, "\\s+")}\\b`),
}));

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
/**
 * Frases que no son el nombre de una ciudad aunque lleguen como respuesta a
 * "¿para qué ciudad sería?". Espejo de `destino.NO_SON_CIUDAD`, aplicado
 * aqui para no PROPONER lo que alla se va a rechazar.
 */
const NO_ES_CIUDAD_SUELTA =
  /^(mi|la|el)\s+(casa|apartamento|apto|oficina|trabajo|finca)|^(aca|aqui|alla|ahi)\b|^(donde|lo\s+que|como|cuando|cuanto|que)\b|^(si|no|ok|listo|gracias|hola|buenas|bueno|vale|claro|dale)\b|^(el\s+)?mismo\b|^(contraentrega|contra\s+entrega|efectivo|nequi|transferencia|daviplata)\b|^(no\s+se|ninguna|cualquiera)\b/;

/**
 * Un "si" mal escrito no es una ciudad.
 *
 * ⚠️ LO CAZO EL SONDEO DE LAS 65 PREGUNTAS REALES, y es el efecto
 *    secundario de aceptar ciudades fuera del listado:
 *
 *   cliente · "sihh"
 *   bot     · "¡Perfecto! A Sihh te llega en 1 a 3 días hábiles"
 *
 * "sihh" es un "sí" escrito a toda prisa desde el movil. Cuatro letras,
 * todas minusculas, no esta en ninguna lista de rechazo: entraba como
 * toponimo. Y despachar a "Sihh" es despachar a ningun sitio.
 *
 * `NO_ES_CIUDAD_SUELTA` no lo pillaba porque sus patrones anclan con `\b`
 * detras de "si", y en "sihh" detras de "si" viene una letra. Esto cubre
 * las formas ESTIRADAS, que son las que escribe la gente: "siii", "sihh",
 * "noo", "okk", "ahh", "mmm", "jajaja".
 */
const RUIDO_DE_TECLADO =
  /^(s+i+h*s*|n+o+h*|o+k+s*|a+h+|e+h+|u+h+|m+h*m+h*|(ja|je|ji){2,}|y+a+|u+y+)$/;

function ciudadEn(textoCrudo, { seLaPidieron = false, yaHayCiudad = false } = {}) {
  const plano = aplanar(textoCrudo);
  if (!plano) return { valor: null, porQue: "texto vacio" };

  // ----------------------------------------------------------------------
  // UN BARRIO NO ES UNA CIUDAD, Y UNA DIRECCION TAMPOCO.
  //
  // ⚠️ ESTO LO REPORTO MARCO (punto 12) Y AL CARGAR LOS 1.037 MUNICIPIOS SE
  //    VOLVIO MUCHO PEOR: una direccion podia CAMBIAR la ciudad ya dada.
  //
  // Su caso: el cliente dijo "Medellín" y luego "Barrio bello oriente".
  // "Bello" es un municipio de Antioquia, asi que el bot le cambio la ciudad
  // a Bello — y Bello Oriente es un barrio de Medellín (Manrique).
  //
  // Y con la lista completa salio otro peor en el chat de Popayan:
  //
  //   cliente · "Popayán Cauca"
  //   cliente · "Barrio pueblillo en la cantera la pintada"
  //             -> "La Pintada" es un municipio de Antioquia
  //             -> la ciudad del pedido paso de Popayán a La Pintada
  //
  // Eso es un paquete cruzando el pais. La regla de Marco, literal: "si el
  // texto empieza con «barrio», es un barrio y nunca cambia la ciudad que el
  // cliente ya dio".
  //
  // Se aplica en DOS niveles:
  //   · si el texto ARRANCA con un marcador de zona, no es una ciudad nunca;
  //   · y si YA HAY CIUDAD confirmada, un texto que es una direccion no la
  //     cambia. Para corregir la ciudad se dice la ciudad, no la direccion.
  // ----------------------------------------------------------------------
  if (/^\s*(barrio|brr|bario|vereda|vda|corregimiento|sector|manzana|mz|conjunto|urbanizacion|etapa|torre|bloque)\b/.test(plano)) {
    return { valor: null, porQue: "empieza con un marcador de zona: es un barrio, no una ciudad" };
  }
  if (yaHayCiudad && VIA.test(plano)) {
    return { valor: null, porQue: "el texto es una direccion y ya hay ciudad: una direccion no cambia la ciudad" };
  }

  let encontradas = [];
  for (const { nombre, re } of PATRONES_DE_CIUDAD) {
    const m = plano.match(re);
    if (m) encontradas.push({ nombre, posicion: m.index });
  }

  if (!encontradas.length) {
    // --------------------------------------------------------------------
    // LA CIUDAD QUE NO ESTA EN EL LISTADO TAMBIEN ES UNA CIUDAD
    //
    // ⚠️ VENTA PERDIDA MEDIDA (panel del 10-oct):
    //
    //   bot     · "¿Para qué ciudad sería?"
    //   cliente · "Ciénaga guacamayal"
    //   bot     · "¿Te lo aparto, o quieres que te cuente...?"
    //
    // Guacamayal es un corregimiento de Zona Bananera (Magdalena). No esta
    // en `CIUDADES_SEMILLA` —que esta incompleta A PROPOSITO, son ~60
    // entradas de los 1.100 municipios del pais— asi que no se proponia
    // NADA, la ficha se quedaba sin ciudad y el turno no tenia ningun dato
    // nuevo. El cliente contesto la pregunta del bot y el bot le contesto
    // con otra cosa.
    //
    // `destino.resolverCiudad` YA SABE QUE HACER con una ciudad
    // desconocida: la acepta con `revisar: true` y una persona confirma el
    // destino antes de la guia. La regla del repositorio es "MARCAR, NO
    // BLOQUEAR". El hueco estaba AQUI: la heuristica no le daba nada que
    // resolver.
    //
    // POR QUE SOLO CUANDO SE LA ACABAN DE PEDIR: sin ese contexto, esto
    // leeria cualquier palabra suelta como una ciudad. Con el contexto, lo
    // normal es que la respuesta a "¿para qué ciudad sería?" sea una
    // ciudad.
    //
    // Y POR QUE ADEMAS PIDE QUE EL NOMBRE YA ESTE RESUELTO (o una pista
    // geografica): porque "Alejandro león Garzón" y "Ciénaga guacamayal"
    // son indistinguibles para una maquina —tres palabras, todas letras—.
    // Cuando el nombre todavia falta, el mensaje corto se lo queda el
    // NOMBRE, que es quien lo pedia primero. Asi dos reglas que miran lo
    // mismo no se pelean por el mismo mensaje.
    // --------------------------------------------------------------------
    if (!seLaPidieron) return { valor: null, porQue: "no se reconoce ninguna ciudad del listado" };

    // Se pela el marcador: "soy de X", "vivo en X", "para X", "municipio de X".
    const pelado = plano
      .replace(
        /^(soy\s+de|vivo\s+en|estoy\s+en|desde|para|en|hacia|a)\s+|^(el\s+)?(municipio|corregimiento|pueblo|vereda)\s+(de\s+)?/,
        ""
      )
      .replace(/[.,;!¡?¿]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const palabras = pelado.split(/\s+/).filter(Boolean);
    const esPalabraDeLugar = palabras.every((p) => /^[a-z'’-]{3,}$/.test(p));

    if (
      pelado &&
      palabras.length >= 1 &&
      palabras.length <= 4 &&
      esPalabraDeLugar &&
      // Ni muletillas, ni "mi casa", ni "aqui cerca": son las mismas
      // frases que `destino.NO_SON_CIUDAD` rechaza, y aqui no se proponen
      // para no hacerle gastar el viaje.
      !NO_ES_CIUDAD_SUELTA.test(pelado) &&
      !RUIDO_DE_TECLADO.test(pelado) &&
      !palabras.some((p) => NO_SON_NOMBRE_SUELTO.has(p)) &&
      // ------------------------------------------------------------------
      // ⚠️ UNA PREGUNTA NO ES UNA CIUDAD. EL MISMO DEFECTO QUE EN EL
      //    NOMBRE, POR LA MISMA PUERTA, ENCONTRADO EL MISMO DIA.
      //
      // «esa vaina kalienta?» -una clienta preguntando si calienta, con la
      // jerga y la errata de teclado que pidio Marco tolerar- se guardaba
      // como CIUDAD, y el bot contestaba: «A Esa Vaina Kalienta te llega en
      // 1 a 3 días hábiles». Se quedaba la pregunta sin responder Y con un
      // destino falso en la ficha.
      //
      // Este bloque acepta a proposito texto que NO esta en el listado del
      // DANE, y eso es correcto: "Guacamayal" es un corregimiento real y
      // rechazarlo costo una venta el 08-oct. Pero aceptar lo desconocido
      // no es aceptar cualquier cosa, y una pregunta nunca es un destino.
      //
      // Se usa el mismo detector que el candado del nombre, para que los
      // dos campos no se protejan con listas distintas.
      // ------------------------------------------------------------------
      !(/\?/.test(textoCrudo) || PALABRA_DE_PREGUNTA().test(plano)) &&
      // Una sola palabra de tres letras es casi siempre una muletilla, no un
      // municipio. Con dos o mas palabras se permiten, porque ahi el
      // conjunto ya parece un toponimo ("Zona Bananera", "San Juan").
      !(palabras.length === 1 && pelado.length < 4) &&
      // Una direccion no es una ciudad.
      !VIA.test(pelado)
    ) {
      return { valor: pelado, porQue: "la dio cuando se le pidio la ciudad, pero no esta en el listado: hay que revisarla" };
    }

    return { valor: null, porQue: "no se reconoce ninguna ciudad del listado" };
  }

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
  let distintas = new Set(
    encontradas.filter((e) => !encontradas.some((o) => o.nombre !== e.nombre && o.nombre.includes(e.nombre))).map((e) => e.nombre)
  );

  // --------------------------------------------------------------------
  // "DUITAMA BOYACA" ES UNA CIUDAD Y SU DEPARTAMENTO, NO DOS CIUDADES.
  //
  // ⚠️ ESTO APARECIO AL CARGAR LOS 1.037 MUNICIPIOS DEL DANE, y habria
  //    sido una regresion cara: la forma mas comun de dar la ciudad en
  //    Colombia es "Ciudad Departamento".
  //
  // Ocho nombres de municipio son tambien nombres de departamento -caldas,
  // nariño, cordoba, boyaca, risaralda, bolivar, sucre, arauca-. Con la
  // semilla de 60 entradas ninguno estaba; con el listado completo, "Duitama
  // boyaca" pasaba a verse como DOS ciudades y `ciudadEn` devolvia null por
  // ambiguo. El cliente escribia su ciudad perfectamente y el bot le volvia
  // a preguntar — que es justo el bucle que reporto Marco con Orocue.
  //
  // Si entre los nombres hay alguno que NO es departamento, ese es la ciudad
  // y el otro es su departamento. Solo cuando TODOS son nombres de
  // departamento, o ninguno lo es, se mantiene la ambigüedad.
  // --------------------------------------------------------------------
  if (distintas.size > 1) {
    const noSonDepartamento = [...distintas].filter((n) => !DEPARTAMENTOS.has(n));
    if (noSonDepartamento.length === 1) {
      distintas = new Set(noSonDepartamento);
      encontradas = encontradas.filter((e) => e.nombre === noSonDepartamento[0]);
    }
  }

  if (distintas.size > 1) {
    // ------------------------------------------------------------------
    // ANTES DE RENDIRSE: PROBAR SEGMENTO A SEGMENTO.
    //
    // ⚠️ SIN ESTO, EL MENSAJE QUE TRAE TODOS LOS DATOS JUNTOS PIERDE LA
    //    CIUDAD — y es el mensaje que mas datos aporta de toda la venta.
    //
    // Con los 1.037 municipios cargados, esto:
    //
    //   "Alejandro león Garzón
    //    Popayán Cauca
    //    Barrio pueblillo en la cantera la pintada"
    //
    // menciona DOS municipios: Popayán y La Pintada (Antioquia, dentro de la
    // direccion). El mensaje entero se leia como ambiguo y la ciudad se
    // perdia, asi que el bot volvia a pedirla a quien acababa de darla.
    //
    // La ambigüedad de verdad -"soy de Cali pero mándalo a Medellín"- es
    // entre DOS CIUDADES DICHAS COMO DESTINO. Un municipio que aparece
    // dentro de una direccion no es un destino alternativo: es parte de la
    // direccion.
    //
    // Asi que se parte el mensaje y se descartan los segmentos que son
    // direccion. Si queda UN solo candidato, ese es el destino. Si quedan
    // dos de verdad, se sigue preguntando.
    // ------------------------------------------------------------------
    // La COMA cuenta como separador, y hace falta: "lo quiero, soy Santiago,
    // Bogotá, Calle 62bis 67-12" es como de verdad escribe la gente cuando
    // suelta todo de una. Y "Santiago" es municipio de Putumayo, asi que sin
    // partir por comas ese mensaje tenia dos ciudades y perdia el destino.
    const segmentos = textoCrudo.split(/\r?\n|\s*[/;,]\s*/).filter((x) => x && x.trim());
    if (segmentos.length > 1) {
      const candidatos = new Set();
      for (const seg of segmentos) {
        const plan = aplanar(seg);
        if (!plan) continue;
        // Los segmentos que son direccion o zona no aportan destino.
        if (VIA.test(plan)) continue;
        if (/^\s*(barrio|brr|bario|vereda|vda|corregimiento|sector|manzana|mz|conjunto|urbanizacion)\b/.test(plan)) continue;
        // ⚠️ Y EL SEGMENTO TIENE QUE SER SOLO LUGARES.
        //
        // Sin esto, el segmento del NOMBRE aportaba una ciudad: "Alejandro
        // león Garzón" contiene Garzón (Huila), asi que seguian habiendo dos
        // candidatos y la ciudad se perdia igual. Es el mismo problema que
        // los apellidos que son municipios, visto desde el otro lado.
        //
        // "Popayán Cauca" es todo lugares -> aporta destino.
        // "Alejandro león Garzón" no -> es un nombre, no aporta destino.
        if (!esSoloUnLugar(seg)) continue;
        const dentro = ciudadEn(seg, { seLaPidieron: false });
        if (dentro.valor) candidatos.add(dentro.valor);
      }
      if (candidatos.size === 1) {
        const unica = [...candidatos][0];
        return { valor: unica, porQue: "ciudad del listado conocido, tomada del segmento que no es direccion" };
      }
    }

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

  // ----------------------------------------------------------------------
  // SI AL FINAL VIENE LA CIUDAD, SE QUITA: va en su propio campo, y
  // repetirla en la direccion ensucia la guia.
  //
  // ⚠️ ESTO SE HACIA CON UN REGEX Y FALLABA POR DOS MOTIVOS A LA VEZ,
  //    los dos visibles en el chat de Ailid del 09-oct:
  //
  //      "KR 101#29c-07 / Lagos de suba / BOGOTÁ"
  //
  //    1. el separador era "/" y el patron solo admitia "," o ";";
  //    2. `ciudad.valor` viene APLANADO ("bogota") y el texto traia
  //       "BOGOTÁ": la `i` del regex arregla las mayusculas, no las tildes.
  //
  //    Resultado: la direccion del pedido incluia la ciudad en mayusculas.
  //
  // Ahora se parte por los separadores y se compara el ULTIMO trozo ya
  // aplanado. Sin regex construido a mano, y funciona con cualquier
  // separador y con tildes.
  // ----------------------------------------------------------------------
  const partes = fragmento.split(/\s*[/,;]\s*/).filter((x) => x.trim());
  if (partes.length > 1) {
    const ultima = partes[partes.length - 1];
    const comoCiudad = ciudadEn(ultima);
    if (comoCiudad.valor && aplanar(ultima) === comoCiudad.valor) {
      partes.pop();
      fragmento = partes.join(" / ").trim();
    }
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
function deTexto(textoCrudo, { seLoPidieron = false, seLaPidieronCiudad = false, yaHayCiudad = false } = {}) {
  const candidatos = {};
  const porQue = {};

  const cantidad = cantidadEn(textoCrudo);
  if (cantidad.valor !== null) {
    candidatos.cantidad = cantidad.valor;
  }
  porQue.cantidad = cantidad.porQue;

  const ciudad = ciudadEn(textoCrudo, { seLaPidieron: seLaPidieronCiudad, yaHayCiudad });
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
