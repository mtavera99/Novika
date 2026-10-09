"use strict";

// ==========================================================================
// GUIAS DE LA TRANSPORTADORA — a quien le corresponde cada etiqueta
//
// QUE RESUELVE: el dueno genera las guias en la plataforma de la
// transportadora y le entregan UN PDF con todas las etiquetas pegadas. Hay
// que partirlo, averiguar de quien es cada hoja, y mandarle a cada cliente
// la suya. A mano son veinte minutos y un error de vez en cuando.
//
// --------------------------------------------------------------------------
// ESTE MODULO ES PURO: NO ABRE EL PDF
// --------------------------------------------------------------------------
//
// Aqui vive SOLO la decision -de quien es esta etiqueta-, trabajando sobre
// el texto ya extraido. Leer y partir el PDF vive en `pdf.js`.
//
// La separacion es deliberada y es una correccion a BIKERPRO, donde leer el
// archivo y decidir el destinatario estan en la misma funcion. La auditoria
// de este repositorio (`docs/PANEL-DE-BIKERPRO-A-NOVIKA.md`) concluyo que
// portar aquel parser era "escribir codigo que no se puede verificar",
// porque hacia falta un PDF real de la transportadora para probar cualquier
// cosa.
//
// Partido en dos, el 95% del riesgo -a quien se le manda- se prueba con
// lineas de texto escritas a mano, hoy, sin ningun PDF. Lo que de verdad
// necesita un archivo real es solo la extraccion del texto.
//
// ==========================================================================
// POR QUE EL PAREO NO ES SOLO POR TELEFONO
// ==========================================================================
//
// Porque el cliente a veces da en la guia un numero distinto al de su
// WhatsApp: el del marido, el de la mama, el del vecino que recibe. Pareando
// solo por telefono esas guias no se podrian mandar, o peor, se mandarian
// mal.
//
// Y equivocarse aqui no es un error cosmetico. LA ETIQUETA LLEVA NOMBRE,
// DIRECCION Y TELEFONO IMPRESOS: mandarle a un cliente la guia de otro es
// filtrarle datos personales de un tercero a un desconocido. Es de las pocas
// cosas de este sistema que no se arreglan pidiendo perdon.
//
// De ahi la forma: varias senales, un puntaje, y dos candados. Sin certeza
// NO SE ENVIA y se explica por que. Es mejor que el dueno mande dos guias a
// mano que una al cliente equivocado.
// ==========================================================================

// --- Pesos de cada senal --------------------------------------------------
//
// El celular vale mas que el nombre porque es unico. El nombre se repite
// -hay dos "Jorge" en la misma semana- y la ciudad se repite muchisimo, asi
// que sola no dice nada.
const PESOS = {
  /** El telefono que el cliente dio para la entrega. */
  telefonoDelPedido: 50,
  /** El numero desde el que escribe por WhatsApp, si es otro. */
  telefonoDelChat: 50,
  /** Repartido entre las palabras del nombre. */
  nombre: 45,
  /** Los numeros de la direccion: calle, carrera, placa, apartamento. */
  direccion: 40,
  ciudad: 10,
};

// --- Los dos candados -----------------------------------------------------
//
// MINIMO: por debajo de 50 no se envia. 50 = un telefono exacto, o el nombre
//   completo mas alguna otra senal. Menos que eso es adivinar.
//
// MARGEN: el mejor candidato tiene que superar al segundo por 20 puntos. Si
//   dos pedidos quedan parecidos -dos hermanos en la misma casa, dos pedidos
//   de la misma cuadra- NO se manda. El empate es justo el caso donde el
//   error es mas probable y mas caro.
const MINIMO = 50;
const MARGEN = 20;

/**
 * Palabras que aparecen en cualquier etiqueta y no distinguen a nadie.
 *
 * Sin esta lista, "DE" o "LA" dentro de un nombre sumarian puntos contra
 * cualquier pedido, y el puntaje dejaria de significar algo.
 */
const RUIDO = new Set([
  "DE", "DEL", "LA", "LAS", "LOS", "EL", "Y", "SAN", "SANTA",
  "SENOR", "SENORA", "SRA", "SR", "DR", "DRA",
]);

const digitos = (s) => String(s == null ? "" : s).replace(/\D/g, "");

/**
 * Un BSUID: el identificador de los clientes que escriben con NOMBRE DE
 * USUARIO de WhatsApp y no traen telefono.
 *
 * HAY QUE DETECTARLO ANTES DE CONVERTIRLO A DIGITOS. "CO.1098944123092301"
 * sin simbolos da "1098944123092301", que PARECE un telefono y no lo es. Si
 * eso entrara al pareo podria coincidir por casualidad con los numeros de
 * una etiqueta y mandarle la guia de otra persona.
 *
 * El 07-oct, tres de los quince chats del dia eran de estos clientes: no es
 * un caso raro.
 */
const RE_BSUID = /^[A-Za-z]{2}\.[A-Za-z0-9]{1,128}$/;
const esBsuid = (s) => RE_BSUID.test(String(s == null ? "" : s).trim());

/**
 * Los ultimos 10 digitos, que es como se compara un numero colombiano.
 * Asi "573001112233", "+57 300 111 2233" y "3001112233" son el mismo.
 */
function tel10(s) {
  const d = digitos(s);
  return d.length > 10 ? d.slice(-10) : d;
}

/**
 * Mayusculas, sin acentos y sin puntuacion.
 *
 * Hace comparable el texto de un PDF -que viene en mayusculas y sin tildes-
 * con lo que guardo el bot, que viene como lo escribio el cliente.
 */
function normalizar(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9#\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Los numeros "de direccion": de 2 a 5 digitos.
 *
 * Calle 127, placa 80-45, apartamento 302. Se excluyen los largos porque
 * esos son guias, telefonos o el importe del recaudo, y se excluyen los de
 * un solo digito porque casi toda etiqueta tiene un 1 o un 2 en alguna
 * parte: serian falsos positivos constantes.
 */
function numerosDireccion(texto) {
  const out = new Set();
  for (const m of normalizar(texto).matchAll(/\b(\d{1,5})\b/g)) {
    const n = m[1];
    if (n.length >= 2) out.add(String(Number(n)));
  }
  return out;
}

/** Palabras utiles de un nombre: descarta ruido y palabras de 1-2 letras. */
function palabrasNombre(nombre) {
  return normalizar(nombre)
    .split(" ")
    .filter((p) => p.length >= 3 && !RUIDO.has(p));
}

/**
 * Las palabras con las que se puede reconocer un municipio.
 *
 * --------------------------------------------------------------------------
 * SE MIRAN TODAS LAS PALABRAS, NO SOLO LA PRIMERA
 * --------------------------------------------------------------------------
 *
 * Esto viene de un fallo medido en BIKERPRO el 28-sep que dejo una guia sin
 * enviar. Alli se usaba solo la primera palabra de la ciudad, y solo si
 * tenia 4 letras o mas.
 *
 * En "La Playa" la primera palabra es "LA": dos letras. La ciudad no se
 * comparaba NUNCA y se perdian sus 10 puntos. Con ocho municipios reales
 * -La Playa, El Cerrito, La Dorada, Los Patios, La Union, El Bagre, San
 * Gil, La Virginia- los ocho se quedaban en 45 puntos, justo debajo del
 * minimo de 50. Colombia tiene decenas de municipios con esa forma.
 *
 * Se aceptan palabras de 3 letras -"San GIL", "La CEJA"- pero se buscan con
 * limite de palabra exacto. La ciudad vale 10 puntos y por si sola nunca
 * llega al minimo, asi que un acierto por casualidad no manda nada.
 */
function palabrasCiudad(ciudad) {
  return normalizar(ciudad)
    .split(/[\s,]+/)
    .filter((p) => p.length >= 3 && !RUIDO.has(p));
}

/** Los telefonos propios impresos en la etiqueta, como set de 10 digitos. */
function telefonosRemitente(valor) {
  const lista = Array.isArray(valor) ? valor : String(valor == null ? "" : valor).split(/[,;]/);
  const set = new Set();
  for (const v of lista) {
    const t = tel10(v);
    if (t) set.add(t);
  }
  return set;
}

// ==========================================================================
// LEER UNA ETIQUETA
// ==========================================================================

/**
 * Saca de una etiqueta los datos con los que se puede identificar al cliente.
 *
 * Recibe las LINEAS de la pagina, no el texto entero pegado. La etiqueta se
 * lee por sus rotulos ("DESTINATARIO:", "DIRECCION:", "GUIA No."), y si se
 * junta todo en un solo chorro el nombre del destinatario se pega con el del
 * remitente y el parseo empieza a adivinar.
 *
 * No depende del formato exacto de una transportadora: busca rotulos y, si
 * no los encuentra, usa el texto completo como red.
 *
 * @param {string[]} lineas
 * @param {{telefonosRemitente?: string[]|string}} [opciones]
 */
function extraerCampos(lineas, opciones = {}) {
  const remitentes = telefonosRemitente(opciones.telefonosRemitente);
  const texto = (Array.isArray(lineas) ? lineas : []).join(" \n ");
  const plano = normalizar(texto);

  // --- Numero de guia ---
  //
  // Primero por rotulo. Los formatos vistos en exports reales:
  //   Interrapidisimo 240061604892 (12 digitos)
  //   Coordinadora     64532761837 (11)
  //   Servientrega      2220956331 (10, arranca en 2 asi que no choca con
  //                                 un celular, que arranca en 3)
  let guia = null;
  const porRotulo = plano.match(/GU[IÍ]A\s*(?:NO|N|NRO|NUM(?:ERO)?|#)?\s*\.?\s*:?\s*(\d{9,14})/);
  if (porRotulo) {
    guia = porRotulo[1];
  } else {
    // Red: el numero largo mas probable, descartando celulares (10 digitos
    // que empiezan en 3) y los telefonos propios.
    const candidatos = [...plano.matchAll(/\b(\d{9,14})\b/g)]
      .map((m) => m[1])
      .filter((n) => !(n.length === 10 && n.startsWith("3")))
      .filter((n) => !remitentes.has(tel10(n)));
    guia = candidatos.sort((a, b) => b.length - a.length)[0] || null;
  }

  // --- Telefonos del destinatario ---
  //
  // Todos los celulares colombianos de la etiqueta MENOS los propios, que
  // van impresos como remitente y tienen la misma forma que los demas.
  //
  // ------------------------------------------------------------------------
  // SE BUSCAN EN CUATRO FORMATOS, NO EN UNO
  // ------------------------------------------------------------------------
  //
  // En BIKERPRO se buscaba solo /\b(3\d{9})\b/, y eso pierde el telefono en
  // tres formatos que las transportadoras imprimen todo el tiempo:
  //
  //   "315 555 1234"   normalizar() CONSERVA los espacios: no coincide
  //   "315-555-1234"   y tambien conserva los guiones
  //   "573155551234"   el \b inicial lo rompe el "57" pegado
  //
  // Y un telefono vale 50 puntos: es la unica senal que por si sola alcanza
  // el minimo. Perderlo es la diferencia entre enviar la guia y dejar al
  // cliente esperando.
  const telefonos = new Set();
  const agregarTel = (crudo) => {
    const t = tel10(crudo);
    // 10 digitos que empiezan en 3: un celular colombiano. Nada mas entra.
    if (!/^3\d{9}$/.test(t)) return;
    if (remitentes.has(t)) return;
    telefonos.add(t);
  };
  // 1) Pegado, con o sin indicativo: 3155551234 · 573155551234
  for (const m of plano.matchAll(/\b(?:57)?(3\d{9})\b/g)) agregarTel(m[1]);
  // 2) Partido con espacios o guiones, en los cortes que se ven impresos:
  //    315 555 1234 · 315-555-1234 · 3155 551234 · 315 5551234
  for (const m of plano.matchAll(
    /(?:^|[^0-9])(?:57[\s-]?)?(3\d{2}[\s-]\d{3}[\s-]?\d{4}|3\d{2}[\s-]\d{7}|3\d{3}[\s-]\d{6})(?![0-9])/g
  )) {
    agregarTel(m[1]);
  }

  // --- Nombre del destinatario ---
  //
  // Del rotulo si esta. Si no, queda null y el pareo se apoya en que el
  // nombre del pedido aparezca en cualquier parte del texto.
  let nombre = null;
  const mNombre =
    texto.match(/DESTINATARIO\s*:?\s*([^\n]+)/i) ||
    texto.match(/(?:SE[ÑN]OR(?:A)?|RECIBE|CLIENTE)\s*:?\s*([^\n]+)/i);
  if (mNombre) {
    nombre = normalizar(mNombre[1]).replace(/\b(DIRECCION|TEL(?:EFONO)?|CIUDAD).*$/, "").trim() || null;
  }

  // --- Direccion ---
  let direccion = null;
  const mDir = texto.match(/DIRECCI[OÓ]N\s*:?\s*([^\n]+)/i);
  if (mDir) {
    direccion = normalizar(mDir[1]).replace(/\b(CIUDAD|TEL(?:EFONO)?|DEPTO).*$/, "").trim() || null;
  }

  // --- Ciudad ---
  let ciudad = null;
  const mCiudad = texto.match(/(?:CIUDAD|DESTINO)\s*:?\s*([^\n]+)/i);
  if (mCiudad) {
    ciudad = normalizar(mCiudad[1]).replace(/\b(DEPTO|DEPARTAMENTO|TEL(?:EFONO)?).*$/, "").trim() || null;
  }

  return {
    guia,
    telefonos: [...telefonos],
    nombre,
    direccion,
    ciudad,
    // Los numeros de la direccion si se encontro; si no, de toda la etiqueta.
    numeros: numerosDireccion(direccion || plano),
    plano,
  };
}

// ==========================================================================
// EMPAREJAR UNA ETIQUETA CON UN PEDIDO
// ==========================================================================

/** Los datos del pedido que se comparan, leidos de la forma de NOVIKA. */
function datosDe(pedido) {
  const d = (pedido && pedido.destinatario) || {};
  return {
    id: pedido && pedido.id,
    nombre: d.nombre || "",
    telefono: d.telefono || "",
    ciudad: d.ciudad || "",
    direccion: [d.direccion, d.referencia].filter(Boolean).join(" "),
    // La clave de la conversacion: un telefono, o un BSUID si el cliente
    // escribe con nombre de usuario.
    chat: (pedido && pedido.contactoId) || "",
  };
}

/**
 * Puntua que tan seguro es que esta etiqueta sea de este pedido.
 * @returns {{puntos:number, senales:string[]}}
 */
function puntuar(campos, pedido) {
  const p = datosDe(pedido);
  let puntos = 0;
  const senales = [];

  // --- Telefonos (50 cada uno) ---
  const telPedido = tel10(p.telefono);
  // Si el chat es un BSUID no hay telefono que comparar: se ignora, en vez
  // de convertirlo en digitos y crear un numero falso.
  const telChat = esBsuid(p.chat) ? "" : tel10(p.chat);
  const enEtiqueta = (t) => t && campos.telefonos.includes(t);

  if (enEtiqueta(telPedido)) {
    puntos += PESOS.telefonoDelPedido;
    senales.push("telefono del pedido");
  }
  // Solo suma si es OTRO numero. Si el cliente dio su mismo WhatsApp es una
  // sola senal, no dos: contarla doble infla la certeza sin mas evidencia.
  if (enEtiqueta(telChat) && telChat !== telPedido) {
    puntos += PESOS.telefonoDelChat;
    senales.push("numero de WhatsApp");
  }

  // --- Nombre (hasta 45, repartido entre sus palabras) ---
  //
  // Se busca en TODA la etiqueta, no solo en el rotulo del destinatario: hay
  // formatos donde el nombre aparece junto al remitente de la contraentrega.
  const palabras = palabrasNombre(p.nombre);
  if (palabras.length) {
    const donde = campos.nombre ? normalizar(campos.nombre) + " " + campos.plano : campos.plano;
    const halladas = palabras.filter((w) => new RegExp(`\\b${w}\\b`).test(donde));
    if (halladas.length) {
      puntos += Math.round((PESOS.nombre * halladas.length) / palabras.length);
      senales.push(
        halladas.length === palabras.length ? "nombre" : `nombre parcial (${halladas.length}/${palabras.length})`
      );
    }
  }

  // --- Numeros de la direccion (hasta 40) ---
  const numsPedido = numerosDireccion(p.direccion);
  if (numsPedido.size) {
    const coinciden = [...numsPedido].filter((n) => campos.numeros.has(n));
    if (coinciden.length) {
      // UN SOLO numero que coincide vale la mitad: "calle 80" coincide con
      // cualquier direccion que tenga un 80 en cualquier parte. Dos o mas ya
      // es una direccion, no una casualidad.
      const proporcion = coinciden.length / numsPedido.size;
      const bruto = PESOS.direccion * proporcion;
      puntos += Math.round(coinciden.length === 1 ? Math.min(bruto, PESOS.direccion / 2) : bruto);
      senales.push(`direccion ${coinciden.join("-")}`);
    }
  }

  // --- Ciudad (10) ---
  //
  // Vale poco a proposito: en la referencia de BIKERPRO una sola ciudad era
  // ~30% de los pedidos, asi que coincidir en ciudad casi no informa. Sirve
  // de desempate, no de prueba.
  const deCiudad = palabrasCiudad(p.ciudad);
  if (deCiudad.length) {
    // En el rotulo de ciudad si existe, y tambien en toda la etiqueta: hay
    // formatos donde el municipio va pegado al departamento o a la oficina.
    const donde = campos.ciudad ? normalizar(campos.ciudad) + " " + campos.plano : campos.plano;
    if (deCiudad.some((w) => new RegExp(`\\b${w}\\b`).test(donde))) {
      puntos += PESOS.ciudad;
      senales.push("ciudad");
    }
  }

  return { puntos, senales };
}

/**
 * Explica QUE SENAL FALTO para llegar al minimo.
 *
 * --------------------------------------------------------------------------
 * POR QUE ESTA FUNCION EXISTE
 * --------------------------------------------------------------------------
 *
 * En BIKERPRO el mensaje era: "no corresponde a ningun pedido (mejor
 * coincidencia 45 de 50 necesarios)". El dueno lo leyo y pregunto, con
 * razon: "no se por que, como que no la reconoce".
 *
 * Ese texto no dice CONTRA QUIEN casi coincidio ni QUE le falto, asi que no
 * hay nada que hacer con el. Un mensaje de error que no permite actuar es
 * una pantalla de ayuda que no ayuda.
 *
 * Diciendo las dos cosas, se arregla el dato en el pedido y la proxima vez
 * cruza solo.
 */
function porQueNoAlcanzo(campos, mejor) {
  if (!mejor || !mejor.pedido) return "";
  const p = datosDe(mejor.pedido);
  const faltas = [];
  const tiene = (s) => (mejor.senales || []).some((x) => x.startsWith(s));

  if (!tiene("telefono del pedido") && !tiene("numero de WhatsApp")) {
    const suyos = [tel10(p.telefono), esBsuid(p.chat) ? "" : tel10(p.chat)]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    faltas.push(
      campos.telefonos.length
        ? `el telefono de la etiqueta (${campos.telefonos.join(", ")}) no es el del pedido (${
            suyos.join(" ni ") || "el pedido no tiene telefono"
          })`
        : "en la etiqueta no se pudo leer ningun celular"
    );
  }
  if (!tiene("nombre")) faltas.push("el nombre del pedido no aparece en la etiqueta");
  else if (tiene("nombre parcial")) faltas.push("el nombre coincide solo en parte");

  if (!tiene("direccion")) {
    faltas.push(
      numerosDireccion(p.direccion).size
        ? "los numeros de la direccion no coinciden"
        : "el pedido no tiene direccion guardada"
    );
  }
  if (!tiene("ciudad")) {
    faltas.push(
      palabrasCiudad(p.ciudad).length
        ? `la ciudad del pedido (${p.ciudad}) no aparece en la etiqueta`
        : "el pedido no tiene ciudad guardada"
    );
  }
  return faltas.length ? ". Le falto: " + faltas.join("; ") : "";
}

/**
 * Elige el pedido de esta etiqueta, o explica por que no se puede.
 *
 * @returns {{pedido:object|null, certeza:number, senales:string[],
 *            motivo:string|null, segundo:number, mejores:Array}}
 */
function emparejar(campos, pedidos) {
  const lista = Array.isArray(pedidos) ? pedidos : [];
  const puntajes = lista
    .map((pedido) => ({ pedido, ...puntuar(campos, pedido) }))
    .sort((a, b) => b.puntos - a.puntos);

  const mejor = puntajes[0];
  const segundo = puntajes[1] ? puntajes[1].puntos : 0;

  // Los tres mas parecidos, para que el panel pueda ofrecerlos y el operador
  // elija a mano cuando el puntaje no alcanza. Sin esto, una guia que no
  // cruza no tiene NINGUNA salida mas que mandarla desde el WhatsApp del
  // celular, que es justo lo que este flujo viene a quitar.
  const mejores = puntajes
    .filter((x) => x.puntos > 0)
    .slice(0, 3)
    .map((x) => ({ pedidoId: x.pedido.id, puntos: x.puntos, senales: x.senales }));

  if (!mejor || mejor.puntos < MINIMO) {
    return {
      pedido: null,
      certeza: mejor ? Math.min(100, mejor.puntos) : 0,
      senales: (mejor && mejor.senales) || [],
      segundo,
      mejores,
      motivo: !lista.length
        ? "no hay pedidos guardados contra los que comparar"
        : !mejor || mejor.puntos === 0
          ? // Con 0 puntos NO se nombra a nadie. Decir "el mas parecido es
            // Jorge" cuando Jorge no coincide en nada es peor que no decir
            // nada: manda al operador a mirar un pedido que no tiene ninguna
            // relacion con esta etiqueta.
            "Esta etiqueta no se parece a ningun pedido guardado: ni el nombre, ni el telefono, " +
            "ni la ciudad. Puede ser un despacho que no paso por el bot. Si sabes de quien es, " +
            "asignala a mano."
          : `El mas parecido es ${datosDe(mejor.pedido).nombre || "?"} con ${mejor.puntos} de ${MINIMO} ` +
            `puntos, asi que no se envia solo` +
            porQueNoAlcanzo(campos, mejor) +
            ". Si sabes de quien es, asignala a mano.",
    };
  }

  if (mejor.puntos - segundo < MARGEN) {
    const enEmpate = puntajes.filter((x) => x.puntos >= MINIMO && mejor.puntos - x.puntos < MARGEN);

    // ----------------------------------------------------------------------
    // EL MATIZ QUE EVITA BLOQUEOS INUTILES
    //
    // El empate es peligroso cuando son PERSONAS DISTINTAS. Si el mismo
    // cliente hizo dos pedidos -pidio otra variante, o uno para un amigo-
    // sus dos pedidos empatan SIEMPRE, y ahi mandar la guia al unico numero
    // que tienen los dos no le filtra nada a nadie: es la misma persona.
    //
    // Sin este matiz, el cliente que compra dos veces es exactamente el que
    // nunca recibe su guia automaticamente. Se permite, y queda anotado en
    // las senales para que se sepa que paso.
    // ----------------------------------------------------------------------
    const destinos = new Set(enEmpate.map((x) => tel10(destinoDe(x.pedido))).filter(Boolean));
    if (destinos.size === 1) {
      return {
        pedido: mejor.pedido,
        certeza: Math.min(100, mejor.puntos),
        senales: [...mejor.senales, `empate con otro pedido del mismo cliente (${enEmpate.length})`],
        segundo,
        mejores,
        motivo: null,
      };
    }

    const empatados = enEmpate
      .slice(0, 3)
      .map((x) => datosDe(x.pedido).nombre || datosDe(x.pedido).telefono)
      .join(" / ");
    return {
      pedido: null,
      certeza: Math.min(100, mejor.puntos),
      senales: mejor.senales,
      segundo,
      mejores,
      motivo:
        `Empate entre ${empatados} (${mejor.puntos} contra ${segundo}). No se envia solo: mandarle ` +
        "a un cliente la direccion y el telefono de otro es filtrar datos personales. Si sabes " +
        "cual es, asignala a mano.",
    };
  }

  return {
    pedido: mejor.pedido,
    certeza: Math.min(100, mejor.puntos),
    senales: mejor.senales,
    segundo,
    mejores,
    motivo: null,
  };
}

// ==========================================================================
// PAREAR UN LOTE COMPLETO
// ==========================================================================

/**
 * Decide a quien le corresponde cada pagina. NO ENVIA NADA.
 *
 * Es la funcion que el panel usa para pintar la tabla de revision antes de
 * que el operador confirme. Pura: recibe el texto ya extraido y devuelve la
 * decision, asi que se prueba entera sin un PDF.
 *
 * @param {object} opciones
 * @param {string[][]} opciones.paginas   lineas de texto por pagina
 * @param {object[]}   opciones.pedidos   pedidos contra los que comparar
 * @param {string[]}   [opciones.telefonosRemitente]
 * @param {(guia:string) => object|null} [opciones.yaEnviada]
 *        para no volver a avisar una guia que ya salio
 * @returns {Array<object>} una fila por pagina
 */
function parear({ paginas, pedidos, telefonosRemitente: propios = [], yaEnviada = null }) {
  const filas = [];
  const guiasVistas = new Map();

  const paginasLista = Array.isArray(paginas) ? paginas : [];

  for (let i = 0; i < paginasLista.length; i++) {
    const campos = extraerCampos(paginasLista[i] || [], { telefonosRemitente: propios });
    const transportadora = transportadoraDe(campos.plano);

    const fila = {
      pagina: i + 1,
      guia: campos.guia,
      transportadora,
      etiqueta: {
        nombre: campos.nombre,
        direccion: campos.direccion,
        ciudad: campos.ciudad,
        telefonos: campos.telefonos,
      },
      pedido: null,
      certeza: 0,
      senales: [],
      motivo: null,
      enviar: false,
      asignable: false,
      mejores: [],
    };

    // Guia repetida DENTRO del mismo PDF: el operador imprimio dos veces la
    // misma etiqueta. No se ofrece asignarla a mano porque es la MISMA guia
    // de otra hoja, y asignarla seria mandarle dos veces lo mismo a alguien.
    if (campos.guia && guiasVistas.has(campos.guia)) {
      fila.motivo = `la guia ${campos.guia} ya venia en la pagina ${guiasVistas.get(campos.guia)} de este mismo PDF`;
      filas.push(fila);
      continue;
    }
    if (campos.guia) guiasVistas.set(campos.guia, i + 1);

    // Guia ya avisada en una corrida anterior. Tampoco se ofrece asignar: ya
    // salio, y reenviarla confunde al cliente.
    const previa = campos.guia && yaEnviada ? yaEnviada(campos.guia) : null;
    if (previa) {
      fila.yaEnviada = previa;
      fila.motivo = `ya se le envio${previa.nombre ? " a " + previa.nombre : ""}${
        previa.cuando ? " el " + previa.cuando : ""
      }`;
      filas.push(fila);
      continue;
    }

    const r = emparejar(campos, pedidos);
    fila.pedido = r.pedido;
    fila.certeza = r.certeza;
    fila.senales = r.senales;
    fila.motivo = r.motivo;
    fila.enviar = Boolean(r.pedido);
    fila.mejores = r.mejores || [];
    // Se puede asignar a mano SOLO si no se pudo parear sola. Las que ya
    // tienen dueno no necesitan que nadie elija.
    fila.asignable = !fila.enviar;
    filas.push(fila);
  }

  return filas;
}

/**
 * A que numero se le manda: SIEMPRE al WhatsApp con el que hablo el bot.
 *
 * El telefono impreso en la etiqueta puede ser de otra persona -la que
 * recibe el paquete-, y ahi el mensaje no llegaria, o peor, llegaria a un
 * desconocido con los datos del cliente dentro.
 */
function destinoDe(pedido) {
  const p = datosDe(pedido);
  const chat = String(p.chat || "").trim();
  // Cliente con nombre de usuario: se le responde por su BSUID, tal cual.
  if (esBsuid(chat)) return chat;
  return tel10(chat) ? digitos(chat) : digitos(p.telefono);
}

// ==========================================================================
// TRANSPORTADORA Y RASTREO
//
// Se reconoce leyendo la etiqueta, no configurando una: un lote puede venir
// mezclado, y el enlace de rastreo tiene que ser el de la transportadora que
// de verdad lleva ESE paquete.
//
// AVISO SOBRE LOS ENLACES: los tres se verificaron en BIKERPRO el
// 22-sep-2026. Importa porque van en un mensaje a un cliente real que esta
// esperando su pedido: un enlace roto justo ahi genera una llamada, no una
// queja silenciosa. Conviene volver a comprobarlos antes de encender el
// envio, y por eso `comoRastrear` existe: Interrapidisimo no tiene pagina
// propia de rastreo -el formulario esta en su home- asi que se manda el home
// y se le dice al cliente donde pegar el numero, en vez de inventar una ruta
// que devuelva 404.
// ==========================================================================
const TRANSPORTADORAS = {
  interrapidisimo: {
    nombre: "Interrapidisimo",
    patron: /INTER\s*RAPIDISIMO/,
    rastreo: "https://www.interrapidisimo.com/",
    comoRastrear: 'pega el numero en "Sigue tu envio"',
  },
  servientrega: {
    nombre: "Servientrega",
    patron: /SERVIENTREGA/,
    rastreo: "https://www.servientrega.com/wps/portal/rastreo-envio",
    comoRastrear: null,
  },
  coordinadora: {
    nombre: "Coordinadora",
    patron: /COORDINADORA/,
    rastreo: "https://coordinadora.com/rastreo/rastreo-de-guia/",
    comoRastrear: null,
  },
};

/** Que transportadora es, leido de la etiqueta. `null` si no se reconoce. */
function transportadoraDe(plano) {
  for (const [clave, t] of Object.entries(TRANSPORTADORAS)) {
    if (t.patron.test(plano || "")) return { clave, nombre: t.nombre, rastreo: t.rastreo, comoRastrear: t.comoRastrear };
  }
  return null;
}

const pesos = (n) => "$" + Number(n || 0).toLocaleString("es-CO");

/**
 * El mensaje que acompana al PDF de la guia.
 *
 * Va en el pie del documento y no en un mensaje aparte: asi el cliente
 * recibe UNA notificacion con todo, en vez de dos mensajes sueltos donde el
 * segundo puede llegar primero.
 *
 * NO PROMETE UNA FECHA DE ENTREGA. Ese dato no lo tenemos: lo decide la
 * transportadora, y prometerlo convierte un retraso suyo en un
 * incumplimiento nuestro. Se da el numero y el enlace, que es lo que
 * permite al cliente mirarlo el mismo.
 */
function textoParaCliente(pedido, guia, transportadora) {
  const p = datosDe(pedido);
  const lineas = ["*NOVIKA* — tu pedido ya va en camino 📦", ""];

  if (guia) lineas.push(`Guia: *${guia}*`);
  if (transportadora) {
    lineas.push(`Transportadora: ${transportadora.nombre}`);
    lineas.push(
      `Rastrealo aqui: ${transportadora.rastreo}` +
        (transportadora.comoRastrear ? ` (${transportadora.comoRastrear})` : "")
    );
  }
  lineas.push("");

  // El importe es lo que mas consultan al recibir, y decirlo aqui evita la
  // discusion con el mensajero en la puerta. Sale del SNAPSHOT del pedido,
  // no de una cotizacion nueva: si manana sube el precio, este pedido
  // conserva el suyo.
  const total = (pedido && pedido.cotizacion && pedido.cotizacion.total) || 0;
  if (total) lineas.push(`Pagas *${pesos(total)}* en efectivo al recibir.`);

  const destino = [p.direccion, p.ciudad].filter(Boolean).join(", ");
  if (destino) lineas.push(`Va a: ${destino}`);

  lineas.push("", "Cualquier cosa me escribes por aqui. Gracias por tu compra 🙌");
  return lineas.join("\n");
}

/** Nombre del archivo que ve el cliente en WhatsApp. */
function nombreArchivo(guia) {
  return `guia-${guia || "envio"}-novika.pdf`;
}

module.exports = {
  PESOS,
  MINIMO,
  MARGEN,
  RUIDO,
  TRANSPORTADORAS,
  digitos,
  esBsuid,
  tel10,
  normalizar,
  numerosDireccion,
  palabrasNombre,
  palabrasCiudad,
  telefonosRemitente,
  extraerCampos,
  datosDe,
  puntuar,
  porQueNoAlcanzo,
  emparejar,
  parear,
  destinoDe,
  transportadoraDe,
  textoParaCliente,
  nombreArchivo,
};
