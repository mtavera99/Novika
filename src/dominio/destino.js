"use strict";

// ==========================================================================
// DESTINO: CIUDAD, DEPARTAMENTO Y DIRECCION
//
// Modulo puro. Sin I/O.
//
// Tres reglas, y las tres vienen de errores que cuestan plata:
//
//   1. UNA FRASE NO ES UNA CIUDAD.
//      El modelo, si se le deja, extrae "a mi casa" como direccion y "por
//      aqui cerca" como ciudad. Un pedido con eso en la guia es una
//      devolucion. Aqui una ciudad solo se confirma si se resuelve contra la
//      lista; una direccion, solo si tiene forma de direccion.
//
//   2. CIUDAD AMBIGUA NO SE ADIVINA.
//      En Colombia hay varias "Santa Rosa", varios "San Pedro". Si el nombre
//      resuelve a mas de un departamento, NO se elige: se devuelve la lista
//      para preguntar. Elegir es despachar a otro departamento.
//
//   3. MARCAR, NO BLOQUEAR.
//      Una ciudad que no esta en la lista no tumba el pedido: lo marca para
//      revision. La lista esta incompleta por definicion y perder una venta
//      real por un municipio que falta es el peor resultado posible.
//
// SOBRE LA LISTA: es una semilla de las ciudades principales, marcada como
// incompleta. Son datos geograficos publicos, no politica comercial: aqui NO
// hay cobertura, ni tarifas, ni tiempos de entrega. Eso lo define el dueno y
// vive en el catalogo.
// ==========================================================================

const { aplanar } = require("./texto");

/**
 * Semilla de ciudades principales -> departamento.
 *
 * INCOMPLETA A PROPOSITO. Lo que no esta aqui no se rechaza: se marca para
 * revision humana. Pendiente: cargar el listado completo de municipios.
 */
const CIUDADES_SEMILLA = {
  bogota: ["Bogotá D.C."],
  "bogota dc": ["Bogotá D.C."],
  medellin: ["Antioquia"],
  cali: ["Valle del Cauca"],
  barranquilla: ["Atlántico"],
  cartagena: ["Bolívar"],
  cucuta: ["Norte de Santander"],
  bucaramanga: ["Santander"],
  pereira: ["Risaralda"],
  "santa marta": ["Magdalena"],
  ibague: ["Tolima"],
  manizales: ["Caldas"],
  villavicencio: ["Meta"],
  pasto: ["Nariño"],
  monteria: ["Córdoba"],
  neiva: ["Huila"],
  armenia: ["Quindío"],
  popayan: ["Cauca"],
  sincelejo: ["Sucre"],
  valledupar: ["Cesar"],
  tunja: ["Boyacá"],
  riohacha: ["La Guajira"],
  florencia: ["Caquetá"],
  quibdo: ["Chocó"],
  yopal: ["Casanare"],
  arauca: ["Arauca"],
  mocoa: ["Putumayo"],
  leticia: ["Amazonas"],
  soacha: ["Cundinamarca"],
  bello: ["Antioquia"],
  itagui: ["Antioquia"],
  envigado: ["Antioquia"],
  palmira: ["Valle del Cauca"],
  buenaventura: ["Valle del Cauca"],
  soledad: ["Atlántico"],
  malambo: ["Atlántico"],
  floridablanca: ["Santander"],
  giron: ["Santander"],
  piedecuesta: ["Santander"],
  dosquebradas: ["Risaralda"],
  tulua: ["Valle del Cauca"],
  zipaquira: ["Cundinamarca"],
  facatativa: ["Cundinamarca"],
  chia: ["Cundinamarca"],
  girardot: ["Cundinamarca"],
  duitama: ["Boyacá"],
  sogamoso: ["Boyacá"],
  apartado: ["Antioquia"],
  turbo: ["Antioquia"],
  maicao: ["La Guajira"],
  ipiales: ["Nariño"],
  tumaco: ["Nariño"],
  "san andres": ["Archipiélago de San Andrés"],
  // ⚠️ ESTE ENTRO POR UN CASI-INCIDENTE DE DESPACHO (08-oct).
  //
  // Una clienta de "San Andrés de Sotavento, Córdoba" quedo registrada con
  // ciudad "San Andres": el archipielago. Son dos destinos a 700 km, uno de
  // ellos con flete aereo, y el pedido iba a salir mal.
  //
  // La proteccion general esta en `extraer.ciudadEn`, que ya no deja que un
  // nombre corto se coma uno compuesto. Este se añade ADEMAS para que el
  // municipio resuelva su departamento sin pasar por revision humana.
  "san andres de sotavento": ["Córdoba"],

  // Homonimos reales: el mismo nombre en varios departamentos. NO se eligen.
  "santa rosa": ["Bolívar", "Cauca", "Antioquia"],
  "san pedro": ["Valle del Cauca", "Sucre", "Antioquia"],
  "la union": ["Valle del Cauca", "Nariño", "Antioquia", "Sucre"],
  "san jose": ["Caldas", "Norte de Santander"],
  "el carmen": ["Norte de Santander", "Chocó"],
  rionegro: ["Antioquia", "Santander"],
  "puerto rico": ["Caquetá", "Meta"],
  albania: ["La Guajira", "Caquetá", "Santander"],
};

// ==========================================================================
// LOS 1.037 MUNICIPIOS DEL DANE
//
// ⚠️ LA LISTA ESCRITA A MANO COSTO TRES VENTAS EN UNA SOLA NOCHE.
//
// `CIUDADES_SEMILLA` tenia ~60 entradas y estaba incompleta a proposito: la
// regla era "marcar, no bloquear". Pero el panel del 09-oct mostro el precio:
//
//   "A orocue"            -> no reconocio la ciudad
//   "Málaga Santander"    -> no reconocio la ciudad
//   "Ciénaga guacamayal"  -> no reconocio la ciudad
//
// En los tres el bot salto a "¿Te lo aparto...?" sin dar el plazo ni pedir
// datos, y a la clienta de Orocue le volvio a preguntar la ciudad DESPUES de
// que ya la habia dado. Adivinar cuales de los 1.100 municipios del pais
// merecian estar en una lista a mano era la decision equivocada.
//
// Ahora la lista es la oficial: DIVIPOLA del DANE. Se regenera con
// `node herramientas/traer-municipios.js`.
//
// --------------------------------------------------------------------------
// LA SEMILLA NO SE BORRA, Y GANA
// --------------------------------------------------------------------------
//
// Se funde ENCIMA del listado del DANE, no debajo, porque contiene decisiones
// que el DANE no puede tener:
//
//   · "san andres de sotavento" resuelto a Córdoba, para que no se despache
//     al archipielago a 700 km con flete aereo;
//   · homonimos AMPLIADOS a mano. El DANE da los municipios que existen;
//     la semilla añade los que ya se han visto confundir en chats reales.
//     Un homonimo de mas solo cuesta una pregunta; uno de menos despacha al
//     departamento equivocado.
// ==========================================================================
const DEL_DANE = require("./municipios-co.json").municipios;

const CIUDADES = { ...DEL_DANE, ...CIUDADES_SEMILLA };

/**
 * Los nombres de DEPARTAMENTO, aplanados.
 *
 * ⚠️ HACEN FALTA PORQUE OCHO DE ELLOS SON TAMBIEN NOMBRES DE MUNICIPIO:
 *    caldas, nariño, cordoba, boyaca, risaralda, bolivar, sucre y arauca.
 *
 * Y la gente escribe "Ciudad Departamento" todo el tiempo: "Duitama Boyacá",
 * "Málaga Santander". Con el listado completo cargado, "Duitama boyaca"
 * empezo a verse como DOS ciudades -Duitama y el municipio de Boyacá- y
 * `ciudadEn` devolvia null por ambiguo: el cliente daba su ciudad bien
 * escrita y el bot le volvia a preguntar.
 *
 * Con esta lista se distingue "dos ciudades de verdad" de "una ciudad y su
 * departamento", que es lo normal.
 */
const DEPARTAMENTOS = new Set(
  Object.values(CIUDADES)
    .flat()
    .map((d) =>
      String(d)
        .toLocaleLowerCase("es")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z\s]/g, "")
        .trim()
    )
    .filter(Boolean)
);

/**
 * Ya NO esta incompleta: son los 1.037 nombres de municipio del DANE.
 *
 * Se conserva la bandera porque lo que sigue siendo verdad es que hay
 * destinos que NO son municipios -corregimientos, veredas, barrios- y esos
 * se siguen aceptando marcados para revision. Ver `resolverCiudad`.
 */
const LISTA_INCOMPLETA = true;

/** Frases que NO son una ciudad aunque el modelo las proponga. */
const NO_SON_CIUDAD = [
  /^(mi|la|el)\s+(casa|apartamento|apto|oficina|trabajo|finca)/,
  /^(aca|aqui|alla|ahi)\b/,
  /^(por\s+)?(aqui|aca|alla)\s+cerca/,
  /^(donde|lo\s+que|como)\b/,
  /^(si|no|ok|listo|gracias|hola|buenas)\b/,
  /^(el\s+)?mismo\b/,
  /^(contraentrega|contra\s+entrega|efectivo|nequi|transferencia)\b/,
  /^\d+$/, // un numero suelto no es una ciudad
];

/** Frases que NO son una direccion. */
// ==========================================================================
// LA OFICINA DE LA TRANSPORTADORA ES UNA DIRECCION VALIDA
//
// ⚠️ LO AUTORIZO MARCO EL 2026-10-09: «recuerda que nosotros tambien podemos
//    llevar a la oficina inter rapidisimo o a la oficina de coordinadora».
//
// Hasta hoy "oficina de interrapidisimo" se RECHAZABA con "una direccion sin
// ningun numero no sirve para despachar", que es exactamente al reves: un
// envio a oficina es el caso en el que menos falta hace una nomenclatura.
//
// ES LA SALIDA DE LA REGLA DURA. Marco pidio el mismo dia que sin direccion
// utilizable no se cree el pedido; sin esta alternativa, eso convierte a todo
// cliente sin nomenclatura en una venta perdida.
//
// OJO: `NO_SON_DIRECCION` rechaza "mi oficina" / "la oficina" a secas -el
// sitio de trabajo del cliente, que no identifica nada-, y eso se mantiene.
// Lo que se acepta es la oficina DE UNA TRANSPORTADORA, con su nombre.
// ==========================================================================
const TRANSPORTADORAS_CONOCIDAS =
  "interrapidisimo|inter\\s*rapidisimo|interapidisimo|coordinadora|servientrega|envia|tcc|deprisa|redex|saferbo";

// "oficina de interrapidisimo", "en la oficina interrapidisimo", "envio a
// oficina de servientrega", y tambien las formas sin la palabra "oficina":
// "la recojo en interrapidisimo", "la reclamo en coordinadora". Esa ultima
// es como lo dice la gente, y sin ella el bot le seguia pidiendo la
// direccion a quien ya habia dicho donde la recoge.
const OFICINA_DE_TRANSPORTADORA = new RegExp(
  `\\b(oficina|sucursal|agencia|punto|bodega)\\b[^.]{0,20}\\b(${TRANSPORTADORAS_CONOCIDAS})\\b` +
    `|\\b(${TRANSPORTADORAS_CONOCIDAS})\\b[^.]{0,20}\\b(oficina|sucursal|agencia|punto)\\b` +
    `|\\b(recoj[oa]|recoger|recogerl[oa]|retir[oa]|retirar|reclam[oa]|reclamar|paso\\s+por)\\b[^.]{0,25}\\b(${TRANSPORTADORAS_CONOCIDAS})\\b` +
    // Y al reves, que es como lo dijo un cliente de prueba: "la dejo en
    // coordinadora y la recojo ahi". El verbo va DETRAS del nombre.
    `|\\b(${TRANSPORTADORAS_CONOCIDAS})\\b[^.]{0,30}\\b(recoj[oa]|recoger|recogerl[oa]|retir[oa]|retirar|reclam[oa]|reclamar)\\b`
);

/** ¿Pide que se deje en una oficina, sin decir cual? "en la oficina", "la recojo". */
const QUIERE_OFICINA_SIN_DECIR_CUAL =
  /\b(en|a)\s+(la\s+)?(oficina|sucursal|agencia)\b|\b(recoj[oa]|recoger|retiro|retirar)\b.*\b(oficina|sucursal|agencia)\b/;

// ==========================================================================
// UN PUNTO DE REFERENCIA ES LO QUE HACE ENTREGABLE UNA ZONA SIN NOMENCLATURA
//
// En un pueblo o una vereda no hay carrera ni numero: la direccion ES el
// barrio MAS algo que el mensajero pueda encontrar. Esa diferencia es la que
// separa una venta de una llamada de rescate:
//
//   · "barrio centenario"                              -> nadie puede llegar
//   · "barrio Centenario al frente de Cristal Drogueria" -> se entrega
//
// El segundo es, textualmente, el que Marco tuvo que conseguir POR TELEFONO
// el 09-oct despues de que el bot aceptara el primero y cerrara el pedido.
//
// La lista son las mismas cosas que el propio bot pide cuando pide una
// referencia -"una tienda, una esquina, el color de la casa"-, asi que no es
// una lista arbitraria: es el espejo de lo que ya preguntamos.
// ==========================================================================
// Las palabras que el bot pide literalmente cuando pide una referencia: "una
// tienda, una esquina, el color de la casa". Es la señal mas clara, pero NO
// la unica — ver `tieneAlgoMasQueElBarrio`.
const PALABRA_DE_REFERENCIA =
  /\b(frente|enfrente|al\s+lado|contiguo|junto|cerca|diagonal|esquina|esquinera|detras|atras|arriba|abajo|encima|seguido|entrada|salida|subida|bajada)\b|\b(tienda|panaderia|drogueria|farmacia|iglesia|capilla|colegio|escuela|parque|cancha|polideportivo|hospital|alcaldia|plaza|mercado|granero|miscelanea|papeleria|billar|cafeteria|restaurante|hotel|estadero|porton|reja|casa|apartamento|apto|torre|bloque|interior|etapa|piso|local|puesto)\b/;

/**
 * ¿La direccion dice algo MAS que el nombre del barrio?
 *
 * ⚠️ ESTE CRITERIO SUSTITUYE A UNA LISTA DE VOCABULARIO, Y EL MOTIVO ES UN
 *    ERROR MIO DE HACE DIEZ MINUTOS.
 *
 * La primera version decidia solo con la lista de arriba, y rechazaba
 * "barrio pueblillo en la cantera la pintada" porque "cantera" no estaba en
 * ella. Esa direccion es la del chat de Popayan del 08-oct: una venta que ya
 * se perdio una vez por rechazarla. Una lista de sitios ("cantera", "trapiche",
 * "beneficiadero", "la Y", "el alto"...) nunca se termina de escribir.
 *
 * Lo que de verdad separa una direccion entregable de una que no lo es no es
 * el vocabulario: es si hay INFORMACION ADEMAS del barrio. Un mensajero no
 * puede encontrar una casa con "barrio centenario" y si puede con "barrio
 * pueblillo en la cantera la pintada", aunque ninguna de las dos traiga una
 * palabra de la lista.
 *
 * Se cuentan las palabras con contenido -quitando el marcador de zona y las
 * de relleno- y se piden TRES. Con dos o menos, lo que hay es un nombre de
 * barrio y nada mas: "barrio centenario" (1), "barrio buenos aires" (2).
 */
// ⚠️ SIN LA `g`, Y A PROPOSITO: SOLO SE QUITA EL PRIMER MARCADOR.
//
// Con la `g` se quitaban todos, y eso borraba justo la referencia en las
// direcciones rurales de dos niveles: "vereda La Esperanza finca El Mirador"
// se quedaba en "esperanza mirador" -dos palabras- y se rechazaba. Pero ahi
// "finca El Mirador" ES el punto de referencia: dice en cual de las fincas
// de la vereda. El primer marcador es el que no aporta nada; los siguientes
// si.
const MARCADOR_DE_ZONA = /\b(barrio|brr|vereda|vda|corregimiento|sector|finca|conjunto|urbanizacion|resguardo|invasion|comuna|manzana|mz|lote|km|kilometro)\b/;
const RELLENO = new Set("el la los las de del un una y o en con a al para por que es mi su este esta aqui".split(" "));

function tieneAlgoMasQueElBarrio(plano) {
  const conContenido = plano
    .replace(MARCADOR_DE_ZONA, " ")
    .split(/[^a-z0-9]+/)
    .filter((p) => p && !RELLENO.has(p));
  return conContenido.length >= 3;
}

/** ¿Se puede entregar en esta zona sin nomenclatura? */
function TIENE_PUNTO_DE_REFERENCIA_test(plano) {
  return PALABRA_DE_REFERENCIA.test(plano) || tieneAlgoMasQueElBarrio(plano);
}
const TIENE_PUNTO_DE_REFERENCIA = { test: TIENE_PUNTO_DE_REFERENCIA_test };

const NO_SON_DIRECCION = [
  /^(mi|la|el)\s+(casa|apartamento|apto|oficina|trabajo)\s*$/,
  /^(aca|aqui|alla|ahi|donde\s+siempre|la\s+misma)\s*$/,
  /^(el\s+)?mismo\s*$/,
  /^(si|no|ok|listo|gracias)\s*$/,
  /^(contraentrega|contra\s+entrega|efectivo)\s*$/,
];

/**
 * Resuelve una ciudad.
 *
 * @param {string} texto
 * @param {string} [departamentoSugerido] para desambiguar homonimos
 * @returns {{ok: boolean, ciudad?: string, departamento?: string,
 *            ambigua?: boolean, opciones?: string[], revisar?: boolean, motivo?: string}}
 */
function resolverCiudad(texto, departamentoSugerido = null) {
  const plano = aplanar(texto);
  if (!plano) return { ok: false, motivo: "vacio" };

  if (NO_SON_CIUDAD.some((re) => re.test(plano))) {
    return { ok: false, motivo: `"${String(texto).slice(0, 40)}" no es el nombre de una ciudad` };
  }

  const departamentos = CIUDADES[plano];

  if (!departamentos) {
    // No esta en la semilla. NO se rechaza: la lista esta incompleta y
    // rechazar seria perder una venta por un municipio que falta. Se acepta
    // marcado para que una persona lo revise antes de despachar.
    return {
      ok: true,
      ciudad: titular(plano),
      departamento: departamentoSugerido || null,
      revisar: true,
      motivo: "la ciudad no esta en el listado conocido: revisar antes de despachar",
    };
  }

  if (departamentos.length === 1) {
    return { ok: true, ciudad: titular(plano), departamento: departamentos[0], revisar: false };
  }

  // Homonimo. Si el cliente ya dijo el departamento y encaja, se resuelve.
  if (departamentoSugerido) {
    const planoSug = aplanar(departamentoSugerido);
    const encaje = departamentos.find((d) => aplanar(d) === planoSug);
    if (encaje) return { ok: true, ciudad: titular(plano), departamento: encaje, revisar: false };
  }

  // Varios departamentos y ninguna pista: NO se elige.
  return {
    ok: false,
    ambigua: true,
    opciones: departamentos,
    motivo: `"${titular(plano)}" existe en ${departamentos.length} departamentos: hay que preguntar cual`,
  };
}

/** "santa marta" -> "Santa Marta" */
function titular(plano) {
  return plano
    .split(" ")
    .map((p) => (p.length > 2 ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * ¿Esto tiene forma de direccion?
 *
 * No se comprueba que exista -eso no se puede saber desde aqui-, se
 * comprueba que tenga los elementos minimos para que una transportadora
 * pueda intentar la entrega: un tipo de via y un numero.
 */
const TIPOS_DE_VIA = /\b(calle|cll|cl|carrera|cra|kra|kr|avenida|av|ave|diagonal|dg|diag|transversal|tv|trans|manzana|mz|circular|circunvalar|autopista|via|vereda|km|kilometro)\b/;

/**
 * Una ZONA con nombre propio: "Barrio Buenos Aires", "Vereda La Esperanza".
 *
 * Es lo unico que se acepta como direccion SIN numero, y siempre marcado
 * para revision. Exige al menos una palabra detras que no sea un articulo:
 * "barrio" a secas no identifica nada, igual que "mi casa".
 *
 * Nace de una venta perdida real; el motivo completo esta en
 * `validarDireccion`.
 */
// ⚠️ EL ARTICULO OPCIONAL NO ESTABA, Y RECHAZABA DIRECCIONES BUENAS.
//
// "barrio el rosario frente al parque" NO pasaba: tras `barrio\s+` venia
// "el", y el `[a-z]{3,}` exige tres letras de golpe. Medio pais vive en un
// "barrio El Carmen" o una "vereda La Esperanza". El articulo se permite
// pero NO cuenta como nombre: detras tiene que venir una palabra de verdad,
// asi que "barrio el" a secas sigue fuera.
const ZONA_CON_NOMBRE =
  /\b(barrio|brr|vereda|vda|corregimiento|sector|finca|conjunto|urbanizacion|resguardo|invasion|comuna)\b\s+(?:(?:el|la|los|las|de|del)\s+)?[a-z]{3,}/;

function validarDireccion(texto) {
  const crudo = String(texto ?? "").trim();
  const plano = aplanar(crudo);

  if (!plano) return { ok: false, motivo: "vacio" };

  // ------------------------------------------------------------------
  // LA OFICINA DE LA TRANSPORTADORA VA PRIMERO, ANTES DE TODO LO DEMAS.
  //
  // Va arriba a proposito: no tiene que pasar por el filtro de longitud ni
  // por la exigencia de un numero, que es justo lo que la rechazaba. Un
  // envio a oficina es una direccion COMPLETA -la oficina mas la ciudad, que
  // se guarda aparte- y no necesita revision.
  // ------------------------------------------------------------------
  if (OFICINA_DE_TRANSPORTADORA.test(plano)) {
    return { ok: true, valor: crudo, revisar: false, aOficina: true };
  }

  if (NO_SON_DIRECCION.some((re) => re.test(plano))) {
    return { ok: false, motivo: `"${crudo.slice(0, 40)}" no es una direccion` };
  }

  // Quiere oficina pero no dice de cual transportadora. No es un rechazo: es
  // una pregunta con dos opciones concretas, y la hace el redactor.
  if (QUIERE_OFICINA_SIN_DECIR_CUAL.test(plano)) {
    return { ok: false, faltaOficina: true, motivo: "quiere recogerlo en una oficina, pero no dijo de cual" };
  }

  if (plano.length < 8) {
    return { ok: false, motivo: "demasiado corta para ser una direccion" };
  }

  const tieneVia = TIPOS_DE_VIA.test(plano);
  const tieneNumero = /\d/.test(plano);

  if (!tieneNumero) {
    // ------------------------------------------------------------------
    // UNA ZONA CON NOMBRE SE ACEPTA MARCADA. ANTES SE RECHAZABA.
    //
    // ⚠️ VENTA PERDIDA MEDIDA (08-oct, rescate manual hora y media despues).
    //
    // La clienta de San Andrés de Sotavento escribio "Barrio buenos aires" y
    // el bot le siguio pidiendo la direccion hasta que ella contesto "No
    // entiendo". Habia DOS candados en serie rechazandola: el extractor
    // -que exigia un numero detras del tipo de via- y este.
    //
    // Y el argumento para abrir este ya estaba escrito tres lineas mas
    // abajo, para el caso contrario: *"bloquear aqui pierde ventas en zonas
    // donde las direcciones no siguen el formato urbano"*. En un pueblo o
    // una vereda no hay nomenclatura: la direccion ES el barrio mas un punto
    // de referencia, y el propio bot se lo pide con esas palabras.
    //
    // Se acepta con `revisar: true`, que es el mecanismo que este modulo ya
    // usa para esto: la venta no se pierde y una persona confirma el destino
    // antes de generar la guia. Rechazar no protegia el despacho —el pedido
    // no llegaba a existir—, solo perdia el cliente.
    //
    // Sigue rechazandose lo que no identifica nada: "mi casa", "barrio" a
    // secas, "por aca". Eso lo cubren NO_SON_DIRECCION y la exigencia de un
    // nombre detras del tipo de via.
    // ------------------------------------------------------------------
    const esZonaConNombre = ZONA_CON_NOMBRE.test(plano);
    if (!esZonaConNombre) {
      return { ok: false, motivo: "una direccion sin ningun numero no sirve para despachar" };
    }
    // ------------------------------------------------------------------
    // ⚠️ AQUI CAMBIO LA REGLA EL 2026-10-09, Y LA PUSO MARCO.
    //
    // Antes TODA zona con nombre se aceptaba con `revisar: true`. Eso dejo
    // pasar "barrio centenario" como direccion final de un pedido de
    // Ipiales, el pedido se cerro, y Marco tuvo que LLAMAR al celular para
    // conseguir la direccion de verdad. Su regla, textual: «sin eso no
    // podemos dejar que el Bot lo tome como pedido porque si no no se va a
    // generar [la guia]».
    //
    // La distincion es el PUNTO DE REFERENCIA, no el formato urbano:
    //
    //   · "barrio centenario"                 -> nadie puede llegar. Se pide.
    //   · "barrio pueblillo en la cantera..." -> se entrega. Se acepta.
    //
    // SE RECHAZA, PERO NUNCA SE DEJA AL CLIENTE SIN SALIDA: quien solo da el
    // barrio recibe dos opciones concretas -un punto de referencia, o la
    // oficina de la transportadora-, no la misma pregunta otra vez. Repetir
    // la pregunta es lo que costo la venta del 08-oct en San Andres de
    // Sotavento, y por eso el rechazo viaja con `faltaReferencia`, para que
    // el redactor sepa que tiene que ofrecer las dos salidas.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // ⚠️ AQUI CHOCABAN DOS INSTRUCCIONES DE MARCO, Y EL CANDADO VA EN EL
    //    DESPACHO, NO EN LA ACEPTACION.
    //
    // Su caso 2 de los 20 originales: «"Barrio buenos aires" se acepta y no
    // se vuelve a pedir». Son tres pruebas, y salen de una venta perdida
    // medida: rechazarla dejo a la clienta de San Andres de Sotavento
    // contestando "No entiendo" hasta que se fue.
    //
    // Y el 09-oct: «sin eso no podemos dejar que el Bot lo tome como
    // pedido». La primera version de este parche devolvia ok:false, y
    // tumbaba esas tres pruebas.
    //
    // Su frase completa decide: «hay una regla basica para DESPACHAR un
    // pedido... si no, no se va a GENERAR [la guia]». El problema no es que
    // el pedido exista: es que se DESPACHE sin direccion utilizable. Y el
    // pedido existiendo es lo que le permitio rescatar la venta de Ipiales,
    // porque tenia el celular en el panel.
    //
    // Asi que: se ACEPTA -no se pierde el cliente ni se le repite la
    // pregunta- y se marca para revision, que es lo que IMPIDE DESPACHAR.
    // `faltaReferencia` viaja para que el redactor ofrezca las dos salidas
    // concretas, el punto de referencia o la oficina, en el mismo mensaje.
    // ------------------------------------------------------------------
    if (!TIENE_PUNTO_DE_REFERENCIA.test(plano)) {
      return {
        ok: true,
        valor: crudo,
        revisar: true,
        faltaReferencia: true,
        motivo: "solo el barrio: falta un punto de referencia o la oficina de la transportadora",
      };
    }
    return {
      ok: true,
      valor: crudo,
      revisar: true,
      motivo: "zona sin nomenclatura: hay que confirmar un punto de referencia antes de la guia",
    };
  }

  if (!tieneVia) {
    // Hay numeros pero no un tipo de via reconocible. Puede ser una vereda o
    // un conjunto. Se acepta MARCADA: bloquear aqui pierde ventas en zonas
    // donde las direcciones no siguen el formato urbano.
    return {
      ok: true,
      valor: crudo,
      revisar: true,
      motivo: "no se reconoce el tipo de via: revisar antes de generar la guia",
    };
  }

  return { ok: true, valor: crudo, revisar: false };
}

/**
 * Telefono colombiano para despacho.
 *
 * Candado duro, no marca: una transportadora exige telefono, asi que un
 * pedido sin telefono valido no se puede despachar. Es la unica validacion
 * de este modulo que bloquea en vez de marcar.
 */
function validarTelefono(texto) {
  const digitos = String(texto ?? "").replace(/\D/g, "");
  if (!digitos) return { ok: false, motivo: "vacio" };

  // Movil colombiano: 3XXXXXXXXX (10 digitos), con o sin el 57 delante.
  const sinPais = digitos.startsWith("57") && digitos.length === 12 ? digitos.slice(2) : digitos;

  if (sinPais.length !== 10) {
    return { ok: false, motivo: `${sinPais.length} digitos: un movil colombiano tiene 10` };
  }
  if (!sinPais.startsWith("3")) {
    return { ok: false, motivo: "un movil colombiano empieza por 3" };
  }
  if (/^(\d)\1{9}$/.test(sinPais)) {
    return { ok: false, motivo: "todos los digitos iguales: no es un numero real" };
  }

  return { ok: true, valor: sinPais };
}

/** Nombre de persona. Marca en vez de bloquear, salvo casos imposibles. */
// ==========================================================================
// PALABRAS QUE NUNCA SON UN NOMBRE DE PERSONA
//
// ⚠️ DEFECTO REAL, Y BLOQUEO UNA GUIA EN PRODUCCION (09-oct).
//
// Marco no podia despachar el pedido NOV-MV1GEEAT-E4E8F4D3: en el panel
// salia «Cliente: Sii» y el estado «en revision: solo un nombre: puede
// faltar el apellido», que impide despachar. O sea que una clienta de
// Ipiales con $49.900 pagados se quedo sin su paquete porque dijo que si.
//
// "Sii" es el "sí" con el que confirmo el pedido. Y se colaba por un fallo
// de una sola letra: la lista decia `/^(si|no|ok|...)\b/`, y el `\b` detras
// de "si" NO casa dentro de "sii" -las dos son letras, no hay frontera-.
// Asi que "si" se rechazaba y "sii", "siii" o "sip" pasaban.
//
// EL REPOSITORIO YA SABIA QUE "sii" ES UN SI: `confirmacion.js` lo trae como
// `/^(s+i+|sip|sisi|si\s+si)$/` desde hace dias, y `preguntas.js` tambien.
// Eran los candados del nombre los unicos que no lo sabian.
//
// SE ESCRIBE CON `s+i+` -no con "si|sii|siii"- porque enumerar repeticiones
// es una lista que siempre se queda corta: manana llega "siiii".
//
// OJO CON LOS NOMBRES QUE EMPIEZAN POR "SI": el patron esta anclado al
// final (`$`), asi que "Silvia", "Simon" y "Sixta" NO casan. Esa era la
// trampa de arreglarlo con un prefijo.
// ==========================================================================
const NO_ES_UN_NOMBRE =
  /^(s+i+|sip|sisi|no+|nop|nel|ok|oki+|okey|okay|vale|bueno|buena|listo|lista|gracias|hola|buenas|buenos|claro|dale|hagale|obvio|exacto|correcto|confirmo|confirmado|perfecto|excelente)$/;

function validarNombre(texto) {
  const crudo = String(texto ?? "").trim();
  const plano = aplanar(crudo);

  if (!plano) return { ok: false, motivo: "vacio" };
  if (plano.length < 3) return { ok: false, motivo: "demasiado corto" };
  if (/\d/.test(plano)) return { ok: false, motivo: "un nombre no lleva numeros" };

  const palabras = plano.split(" ").filter(Boolean);
  // Se mira la PRIMERA palabra, no el mensaje entero: asi caen tanto "Sii"
  // como "si claro por favor", y sigue pasando "Silvia Martinez".
  if (NO_ES_UN_NOMBRE.test(palabras[0] || "")) {
    return { ok: false, motivo: `"${crudo.slice(0, 30)}" no es un nombre` };
  }
  // ------------------------------------------------------------------
  // UN NOMBRE DE PILA BASTA. LO DECIDIO MARCO EL 2026-10-09.
  //
  // Textual: «al igual que el nombre, no es necesario el nombre completo,
  // pero sí un nombre por lo menos».
  //
  // Antes un nombre de una sola palabra se aceptaba con `revisar: true`, y
  // eso pone el pedido EN_REVISION, que IMPIDE DESPACHAR. O sea que "Duber"
  // -el nombre real del cliente de Ipiales- bloqueaba su propia guia por no
  // traer apellido, y hacia falta entrar al panel a desbloquearlo.
  //
  // El candado que importa sigue puesto, y es el de arriba: lo que no puede
  // guardarse es algo que NO ES UN NOMBRE ("Sii", "ok", "listo"). Eso se
  // rechaza de plano. Un nombre corto pero real no es un problema de
  // despacho: la transportadora prefiere nombre y apellido, pero entrega con
  // el nombre y el celular.
  // ------------------------------------------------------------------
  return { ok: true, valor: crudo, revisar: false };
}

/**
 * Si el texto pide recogerlo en la oficina de una transportadora, devuelve
 * "Oficina <Transportadora>" normalizado. Si no, null.
 *
 * Normalizar importa porque esto acaba impreso en una guia: el cliente
 * escribe "en la de inter", "oficina interrapidisimo", "la recojo en
 * Coordinadora", y las tres tienen que quedar iguales en la ficha.
 */
function oficinaEn(texto) {
  const plano = aplanar(texto);
  if (!OFICINA_DE_TRANSPORTADORA.test(plano)) return null;
  const COMO_SE_LLAMAN = [
    [/\binter\s*r?apidisimo\b/, "Interrapidísimo"],
    [/\bcoordinadora\b/, "Coordinadora"],
    [/\bservientrega\b/, "Servientrega"],
    [/\benvia\b/, "Envía"],
    [/\btcc\b/, "TCC"],
    [/\bdeprisa\b/, "Deprisa"],
    [/\bredex\b/, "Redex"],
    [/\bsaferbo\b/, "Saferbo"],
  ];
  for (const [re, nombre] of COMO_SE_LLAMAN) {
    if (re.test(plano)) return `Oficina ${nombre}`;
  }
  return null;
}

module.exports = {
  CIUDADES_SEMILLA,
  CIUDADES,
  DEPARTAMENTOS,
  LISTA_INCOMPLETA,
  NO_ES_UN_NOMBRE,
  oficinaEn,
  resolverCiudad,
  validarDireccion,
  validarTelefono,
  validarNombre,
  titular,
};
