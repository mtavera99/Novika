"use strict";

// ==========================================================================
// NOVEDADES DE ENTREGA
//
// QUE RESUELVE: cuando la transportadora no logra entregar -no dieron con la
// direccion, no habia nadie, quedo para reclamar en oficina-, alguien tiene
// que avisarle al cliente HOY. Un paquete con una novedad sin gestionar se
// devuelve en pocos dias, y en contraentrega una devolucion cuesta el flete
// de ida, el de vuelta y la venta.
//
// En la referencia de BIKERPRO la devolucion estaba en el 19%, y su rechazo
// bajo -5,0%- no era suerte: era la gestion diaria de novedades a mano,
// cliente por cliente, desde el WhatsApp del celular. Esto es para que esa
// gestion no dependa de que alguien tenga tiempo.
//
// ==========================================================================
// EL PROBLEMA DE FONDO: LA VENTANA YA ESTA CERRADA
// ==========================================================================
//
// Una novedad aparece de uno a tres dias despues del pedido, asi que la
// ventana de 24 h de Meta esta cerrada CASI SIEMPRE. Con texto libre, Meta
// acepta el mensaje -responde ok- y no lo entrega.
//
// Por eso aqui se mira, cliente por cliente:
//
//   ventana abierta  ->  se le escribe normal
//   ventana cerrada  ->  hace falta una plantilla aprobada, y si no existe
//                        la fila se marca BLOQUEADA en vez de intentarlo y
//                        fallar en silencio
//
// Bloquear es la decision importante. Un envio que falla en silencio es peor
// que no enviar: el operador tacha al cliente de su lista creyendo que ya
// esta avisado.
//
// ==========================================================================
// Y NUNCA SE ADIVINA EL MOTIVO
// ==========================================================================
//
// Si el texto de la novedad no cae en una familia conocida, se marca como no
// reconocida y se escala. Escribirle al cliente un motivo inventado es peor
// que no escribirle: lo manda a resolver un problema que no tiene.
// ==========================================================================

const { TIPOS_DE_NOVEDAD } = require("../dominio/pedido");

/**
 * Las guias son numeros largos. 8 o mas digitos deja fuera los totales y las
 * fechas, pero NO los celulares: uno colombiano tiene 10 digitos. Esa
 * ambiguedad no se resuelve aqui, se resuelve en `revisar()` cruzando contra
 * las guias que ya conocemos.
 */
const RE_GUIA = /\b\d{8,}\b/g;

/** Un celular colombiano: 10 digitos que empiezan en 3. */
const esCelular = (n) => /^3\d{9}$/.test(String(n));

const aplanar = (s) =>
  String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

// ==========================================================================
// TIPOS DE NOVEDAD
//
// Las palabras salen de como las escriben las transportadoras colombianas.
//
// LAS SENALES SE ESCRIBEN A MANO, Y ESE ES SU RIESGO: en BIKERPRO faltaba
// "no se localiza direccion del destinatario" -el texto LITERAL de la
// plataforma, y el caso MAS FRECUENTE de todos-, asi que esas novedades
// caian en "motivo no reconocido" y el cliente no recibia nada. Se descubrio
// comparando la lista con la pantalla real, no por un error.
//
// De ahi que el panel muestre siempre las no reconocidas: son la senal de
// que falta una palabra en esta lista.
// ==========================================================================

const TIPOS = [
  {
    clave: TIPOS_DE_NOVEDAD.DIRECCION,
    nombre: "No dieron con la direccion",
    avisable: true,
    senales: [
      "direccion incompleta", "direccion errada", "direccion no encontrada", "no existe la direccion",
      "no reside", "no conocen", "no ubicada", "sin nomenclatura", "direccion incorrecta",
      "zona no cubierta", "barrio no encontrado",
      // El texto literal de la plataforma, y el caso mas comun. Cubre
      // tambien "no se localiza el destinatario": en los dos lo que
      // desatasca el reparto es pedir la direccion completa y un punto de
      // referencia, que es justo lo que dice este mensaje.
      "no se localiza",
    ],
    mensaje: ({ nombre }) =>
      `Hola${nombre ? " " + nombre : ""} 👋 Te escribo de NOVIKA. La transportadora salio a ` +
      `entregarte tu pedido pero no logro dar con la direccion 📦\n\n` +
      `¿Me confirmas la direccion completa y algun punto de referencia? Un negocio o una esquina ` +
      `cerca sirve. Con eso lo vuelven a intentar 🙌`,
  },
  {
    clave: TIPOS_DE_NOVEDAD.AUSENTE,
    nombre: "Fueron y no habia nadie",
    avisable: true,
    senales: [
      "no habia nadie", "destinatario ausente", "ausente", "cerrado", "casa cerrada",
      "intento de entrega", "no contesta", "no responde", "no atienden", "nadie recibe",
    ],
    mensaje: ({ nombre }) =>
      `Hola${nombre ? " " + nombre : ""} 👋 Te escribo de NOVIKA. Pasaron a entregarte tu pedido ` +
      `y no encontraron a nadie 📦\n\n` +
      `¿Que dia y en que horario te queda bien para que vuelvan? Si prefieres, dime y vemos si te ` +
      `lo pueden dejar en una oficina cerca 🙌`,
  },
  {
    clave: TIPOS_DE_NOVEDAD.OFICINA,
    nombre: "Quedo para reclamar en oficina",
    avisable: true,
    senales: [
      "reclame en oficina", "reclamar en oficina", "en oficina", "para recoger",
      "disponible para retiro", "retiro en oficina", "pendiente de retiro",
    ],
    /**
     * ----------------------------------------------------------------------
     * ESTE MENSAJE NO NOMBRA NI LA OFICINA NI LA TRANSPORTADORA
     * ----------------------------------------------------------------------
     *
     * Viene de un incidente real de BIKERPRO el 14-sep: el bot le prometio a
     * una clienta "la oficina de Servientrega en Potosi", y Servientrega NO
     * presta recogida en oficina. La clienta lo leyo.
     *
     * Ese dato solo puede venir de la novedad, nunca de nosotros. Cuando SI
     * viene en el archivo, se usa la plantilla con la oficina y el plazo
     * dentro. Cuando no viene, este texto pide al cliente que espere y el
     * operador lo completa: no se inventa una oficina.
     */
    mensaje: ({ nombre }) =>
      `Hola${nombre ? " " + nombre : ""} 👋 Te escribo de NOVIKA. Tu pedido llego a tu ciudad y ` +
      `quedo disponible para que lo reclames en una oficina de la transportadora 📦\n\n` +
      `Respondeme por aqui y te paso los datos exactos de la oficina y hasta cuando tienes para ` +
      `reclamarlo 🙌`,
    /**
     * Los datos que la plantilla de oficina necesita en sus variables.
     *
     * Si faltan, la fila queda BLOQUEADA pidiendolos, en vez de mandar una
     * plantilla con huecos. Meta rechaza una plantilla con menos parametros
     * de los que declara, y aunque la aceptara, "tu pedido esta en la
     * oficina de  para que lo reclames" no sirve de nada.
     */
    pide: ["oficina", "plazo"],
  },
  {
    clave: "rechazado",
    nombre: "El cliente lo rechazo",
    // NO se le escribe. Si rechazo el paquete, un mensaje automatico
    // molesta; y si fue un malentendido, hay que hablarlo, no mandar una
    // plantilla. Va al operador.
    avisable: false,
    senales: [
      "rehusado", "rechazado", "no lo quiso", "no acepta", "devolucion", "reexpedicion",
      "cancelado", "cancelada", "anulado",
    ],
  },
  {
    clave: "telemercadeo",
    nombre: "La transportadora pide confirmar los datos por telefono",
    // Tampoco se le escribe: "telemercadeo" significa que la transportadora
    // quiere que alguien LLAME para confirmar datos, pero no dice QUE dato
    // falta. Un mensaje generico aqui seria inventar el motivo, que es justo
    // lo que este modulo no hace. Se nombra bien para que se gestione.
    avisable: false,
    senales: ["telemercadeo", "tele mercadeo", "confirmar datos", "verificar datos"],
  },
];

const TIPO_DESCONOCIDO = {
  clave: "desconocida",
  nombre: "No se reconocio el motivo",
  avisable: false,
  senales: [],
};

/** Clasifica el texto de una novedad. Nunca adivina: si no reconoce, lo dice. */
function clasificar(texto) {
  const t = aplanar(texto);
  for (const tipo of TIPOS) {
    if (tipo.senales.some((s) => t.includes(s))) return tipo;
  }
  return TIPO_DESCONOCIDO;
}

/**
 * ¿Ese texto de direccion es en realidad una oficina de la transportadora?
 *
 * En los exports, las novedades de "reclame en oficina" traen la oficina en
 * la columna de direccion del destinatario. Se EXIGE que el texto lo diga:
 * una direccion de casa no entra, porque usarla como oficina mandaria al
 * cliente a recoger su paquete a su propia casa.
 */
function pareceOficina(texto) {
  const t = aplanar(texto);
  if (!t.trim()) return false;
  return /\b(oficina|sucursal|agencia|punto de retiro|inter\s?rapidisimo|servientrega|coordinadora|envia|tcc)\b/.test(
    t
  );
}

// ==========================================================================
// LEER LAS NOVEDADES
// ==========================================================================

/**
 * Saca las novedades de un texto pegado o de un archivo ya convertido.
 *
 * Trabaja LINEA POR LINEA: en cada una busca un numero de guia y toma el
 * resto como el motivo. Sirve igual para un CSV, para un pegado de la
 * pantalla con tabulaciones, o para una lista escrita a mano.
 */
function parsear(texto) {
  const filas = [];
  const vistas = new Set();

  for (const linea of String(texto || "").split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia) continue;

    const candidatos = limpia.match(RE_GUIA);
    if (!candidatos) continue;

    // ----------------------------------------------------------------------
    // UNA LINEA TRAE VARIOS NUMEROS LARGOS: GANA EL MAS LARGO
    //
    // La guia, el celular del cliente, el importe a recaudar y a veces un
    // numero de orden interno. Elegir "el primero" es adivinar, y en
    // BIKERPRO elegia el equivocado: una fila real traia 10104874 (orden
    // interno, 8 digitos) y 240062099941 (la guia, 12 digitos), y "el
    // primero que no parezca celular" se quedaba con el interno. La novedad
    // no cruzaba con ningun pedido.
    //
    // Una guia de transportadora tiene mas digitos que un numero de orden,
    // asi que gana el mas largo. Pero quien decide de verdad es `revisar()`,
    // que prefiere el candidato que coincida con una guia que YA CONOCEMOS:
    // eso no es adivinar, es cruzar contra nuestros propios datos.
    // ----------------------------------------------------------------------
    const noCelulares = candidatos.filter((n) => !esCelular(n));
    const porLargo = (noCelulares.length ? noCelulares : candidatos).slice().sort((a, b) => b.length - a.length);

    // Los marcadores que deja el lector de la hoja de calculo cuando
    // reconocio las columnas. Traen la oficina y la fecha limite, que sin
    // esto se perderian y dejarian cada novedad de oficina bloqueada
    // pidiendo a mano un dato que venia en el archivo.
    const marca = (campo) => {
      const m = limpia.match(new RegExp(`\\[\\[${campo}:\\s*([^\\]]+)\\]\\]`, "i"));
      return m ? m[1].trim() : "";
    };

    // Si el lector reconocio la columna de la guia, manda esa y no se
    // adivina nada.
    const marcada = marca("guia");
    const guia = marcada || porLargo[0];
    if (!guia || vistas.has(guia)) continue; // la misma guia no se procesa dos veces
    vistas.add(guia);

    const oficina = marca("oficina");
    const plazo = marca("plazo");
    const direccion = marca("direccion");

    // El motivo es la linea sin los numeros, sin marcadores y sin
    // separadores: lo que queda es texto que se puede clasificar.
    let motivo = limpia.replace(/\[\[[^\]]*\]\]/g, " ");
    for (const n of candidatos) motivo = motivo.split(n).join(" ");
    motivo = motivo.replace(/[;,\t|]+/g, " ").replace(/\s+/g, " ").trim();

    filas.push({
      guia,
      candidatos,
      motivo,
      ...(oficina ? { oficina } : {}),
      ...(plazo ? { plazo } : {}),
      ...(direccion ? { direccion } : {}),
    });
  }

  return filas;
}

/**
 * Busca el pedido de una novedad cuando la GUIA no cruza.
 *
 * Se exige coincidencia FUERTE y GANADOR UNICO:
 *
 *   · al menos 2 palabras del nombre -con "Mauricio" solo no alcanza: hay
 *     varios, y avisarle al Mauricio equivocado es peor que no avisar-
 *   · o 1 palabra del nombre MAS la ciudad, que es corroboracion
 *     independiente
 *   · y si dos pedidos empatan en el mejor puntaje, no se sugiere ninguno
 *
 * @returns {{pedido:object, porQue:string}|null}
 */
function buscarPorNombre(motivo, pedidos) {
  const texto = " " + aplanar(motivo).replace(/[^a-z0-9ñ]+/g, " ") + " ";
  const suelta = (p) => new RegExp(`(^|[^a-z0-9])${p}([^a-z0-9]|$)`).test(texto);

  let mejor = null;
  let empate = false;

  for (const p of pedidos || []) {
    const d = (p && p.destinatario) || {};

    const palabras = aplanar(d.nombre)
      .split(/[^a-z0-9ñ]+/)
      .filter((w) => w.length >= 4);
    if (!palabras.length) continue;

    const coinciden = palabras.filter(suelta);
    if (coinciden.length === 0) continue;

    const ciudad = aplanar(d.ciudad)
      .split(/[^a-z0-9ñ]+/)
      .filter((w) => w.length >= 4);
    const ciudadCoincide = ciudad.length > 0 && ciudad.some(suelta);

    // Se exige nombre: una ciudad sola coincide con demasiados pedidos.
    const fuerte = coinciden.length >= 2 || (coinciden.length >= 1 && ciudadCoincide);
    if (!fuerte) continue;

    const puntos = coinciden.length + (ciudadCoincide ? 1 : 0);
    if (!mejor || puntos > mejor.puntos) {
      mejor = { pedido: p, puntos, coinciden, ciudadCoincide };
      empate = false;
    } else if (puntos === mejor.puntos && mejor.pedido.id !== p.id) {
      empate = true;
    }
  }

  // Empate = no hay ganador claro. Mejor no sugerir que sugerir el equivocado.
  if (!mejor || empate) return null;

  const d = mejor.pedido.destinatario || {};
  return {
    pedido: mejor.pedido,
    porQue:
      `coincide por nombre (${mejor.coinciden.join(", ")})` +
      (mejor.ciudadCoincide ? ` y por la ciudad (${d.ciudad})` : ""),
  };
}

// ==========================================================================
// ARMAR EL PLAN
// ==========================================================================

/**
 * Cruza las novedades con los pedidos y arma el plan. NO ENVIA NADA.
 *
 * Por cada novedad decide: a quien le corresponde, que se le diria, si su
 * ventana de 24 h esta abierta, y si se puede enviar o exactamente por que
 * no. El panel lo pinta y el operador marca cuales salen.
 *
 * PURA: recibe los pedidos y las conversaciones, no los busca. Asi se prueba
 * entera sin almacen y sin red.
 *
 * @param {object} opciones
 * @param {string}   opciones.texto      lo pegado, o lo convertido del archivo
 * @param {object[]} opciones.pedidos    pedidos despachados contra los que cruzar
 * @param {Map<string,object>|object} [opciones.conversaciones]
 *        contactoId -> conversacion, para calcular la ventana de 24 h
 * @param {object} [opciones.plantillas] clave de tipo -> nombre aprobado en Meta
 * @param {(guia:string) => object|null} [opciones.yaAvisada]
 * @param {object} [opciones.datos]      guia -> { oficina, plazo } puestos a mano
 * @param {number} [opciones.ahora]
 */
function revisar({
  texto,
  pedidos = [],
  conversaciones = null,
  plantillas = {},
  yaAvisada = null,
  datos = {},
  ahora = Date.now(),
} = {}) {
  const ventana = require("../whatsapp/ventana");

  // Indice por guia. Un pedido despachado tiene su guia en `despacho.guia`.
  const porGuia = new Map();
  for (const p of pedidos) {
    const g = String((p && p.despacho && p.despacho.guia) || "").trim();
    if (g) porGuia.set(g, p);
  }

  const conversacionDe = (contactoId) => {
    if (!conversaciones) return null;
    if (conversaciones instanceof Map) return conversaciones.get(contactoId) || null;
    return conversaciones[contactoId] || null;
  };

  const filas = parsear(texto).map((n) => {
    // De todos los numeros largos de la linea, gana el que COINCIDA con una
    // guia que ya conocemos. Esa es la senal mas fuerte que hay: no es
    // adivinar por largo ni por posicion, es cruzar contra nuestros datos.
    const conocida = (n.candidatos || [n.guia]).find((c) => porGuia.has(c));
    const guia = conocida || n.guia;

    const fila = {
      guia,
      motivo: n.motivo,
      tipo: clasificar(n.motivo),
      pedido: porGuia.get(guia) || null,
      comoSeEncontro: porGuia.has(guia) ? "por la guia" : null,
      oficina: n.oficina || "",
      plazo: n.plazo || "",
      enviar: false,
      bloqueada: null,
      porPlantilla: false,
      plantilla: null,
      variables: [],
      mensaje: "",
      ventana: null,
    };

    // La oficina puede venir del archivo o escribirse a mano en el panel. Lo
    // escrito a mano gana: es mas reciente y mas deliberado.
    const aMano = (datos && datos[guia]) || {};
    if (aMano.oficina) fila.oficina = String(aMano.oficina).trim();
    if (aMano.plazo) fila.plazo = String(aMano.plazo).trim();

    // Si no se dio una oficina pero la direccion del archivo PARECE una
    // oficina, se usa. Solo si lo dice: ver `pareceOficina`.
    if (!fila.oficina && n.direccion && pareceOficina(n.direccion)) {
      fila.oficina = String(n.direccion).trim();
    }

    // --- Ya se le aviso de esta guia ---
    const previa = yaAvisada ? yaAvisada(guia) : null;
    if (previa) {
      fila.bloqueada = `ya se le aviso${previa.cuando ? " el " + previa.cuando : ""}`;
      fila.yaAvisada = previa;
      return fila;
    }

    // --- ¿De quien es? ---
    if (!fila.pedido) {
      const porNombre = buscarPorNombre(n.motivo, pedidos);
      if (porNombre) {
        fila.pedido = porNombre.pedido;
        fila.comoSeEncontro = porNombre.porQue;
        // SE SUGIERE, NO SE ENVIA SOLO. Cruzar por nombre es mas debil que
        // cruzar por guia, y avisarle al cliente equivocado de una novedad
        // que no es suya lo manda a resolver un problema inexistente.
        fila.requiereConfirmacion = true;
      } else {
        fila.bloqueada =
          `no se encontro a quien corresponde la guia ${guia}. Puede ser un despacho que no paso ` +
          `por el bot, o la guia no quedo guardada en el pedido.`;
        return fila;
      }
    }

    // --- ¿Se le puede escribir de este motivo? ---
    if (!fila.tipo.avisable) {
      fila.bloqueada =
        fila.tipo.clave === TIPO_DESCONOCIDO.clave
          ? `no se reconocio el motivo ("${n.motivo || "sin texto"}"). No se escribe nada inventado: ` +
            `miralo y gestionalo a mano.`
          : `"${fila.tipo.nombre}": a este caso no se le manda un mensaje automatico, lo gestiona una persona.`;
      return fila;
    }

    // --- Los datos que la plantilla necesita ---
    const pide = fila.tipo.pide || [];
    const faltan = pide.filter((campo) => !String(fila[campo] || "").trim());

    // --- La ventana de 24 h ---
    const conv = conversacionDe(fila.pedido.contactoId);
    fila.ventana = ventana.estado(conv, { ahora });

    const d = fila.pedido.destinatario || {};
    const nombreCorto = String(d.nombre || "").trim().split(/\s+/)[0] || "";

    if (fila.ventana.abierta) {
      // Dentro de la ventana se escribe libre, que es mejor: el texto se
      // adapta al caso y no depende de que Meta tenga una plantilla
      // aprobada. Y aqui la oficina SI puede faltar: el mensaje libre de
      // oficina no la nombra a proposito.
      fila.mensaje = fila.tipo.mensaje({ nombre: nombreCorto, oficina: fila.oficina, plazo: fila.plazo });
      fila.enviar = true;
      return fila;
    }

    // --- Ventana cerrada: solo plantilla ---
    const plantilla = plantillas[fila.tipo.clave];
    if (!plantilla) {
      fila.bloqueada =
        `la ventana de 24 h de este cliente esta cerrada y no hay plantilla aprobada para ` +
        `"${fila.tipo.nombre}". Fuera de esa ventana Meta solo entrega plantillas: hay que crearla ` +
        `en Meta y configurarla.`;
      fila.faltaPlantilla = fila.tipo.clave;
      return fila;
    }

    if (faltan.length) {
      fila.bloqueada =
        `falta ${faltan.join(" y ")} para poder mandar la plantilla de oficina. Viene en el archivo ` +
        `de la transportadora; si no vino, escribilo a mano.`;
      fila.pide = faltan;
      return fila;
    }

    fila.porPlantilla = true;
    fila.plantilla = plantilla;
    // El ORDEN de las variables es el de `pide`, que es el orden en que la
    // plantilla declara sus {{1}}, {{2}}. Cambiarlo manda la fecha donde va
    // la oficina.
    fila.variables = pide.map((campo) => String(fila[campo] || "").trim());
    fila.enviar = true;
    return fila;
  });

  return {
    filas,
    // Resumen para la cabecera de la pantalla: lo primero que se mira es
    // cuantas salen y cuantas no.
    listas: filas.filter((f) => f.enviar).length,
    bloqueadas: filas.filter((f) => f.bloqueada).length,
    porConfirmar: filas.filter((f) => f.requiereConfirmacion && f.enviar).length,
    // Las plantillas que harian falta y no existen. Es una lista de tareas
    // para una persona, y conviene verla junta en vez de fila por fila.
    plantillasQueFaltan: [...new Set(filas.map((f) => f.faltaPlantilla).filter(Boolean))],
  };
}

module.exports = {
  TIPOS,
  TIPO_DESCONOCIDO,
  RE_GUIA,
  clasificar,
  pareceOficina,
  parsear,
  buscarPorNombre,
  revisar,
};
