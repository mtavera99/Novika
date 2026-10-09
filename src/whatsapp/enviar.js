"use strict";

// ==========================================================================
// ENVIO DE MENSAJES
//
// Un unico punto de salida hacia el cliente. Todo lo que sale de NOVIKA pasa
// por aqui, y por eso el interruptor puede estar aqui y en ningun otro sitio.
//
// --------------------------------------------------------------------------
// EL CANDADO
// --------------------------------------------------------------------------
//
// Con RESPUESTA_AUTOMATICA en 0, enviarTexto() NO llama a la red. Ni una
// vez. No es una comprobacion en la capa de arriba que se pueda olvidar al
// añadir un flujo nuevo: es el unico camino al exterior, y empieza con ese
// `if`.
//
// Esa diferencia es la que importa. "Acordarse de comprobar el interruptor
// en cada sitio que envia" es una instruccion, y las instrucciones se
// incumplen cuando alguien con prisa añade un caso. Un candado en el unico
// camino posible no.
//
// Ademas el envio exige el `permiso` explicito: una llamada que no declara
// por que tiene derecho a escribirle a un cliente se rechaza. Asi una
// prueba no puede enviar por descuido.
// ==========================================================================

const PERMISOS = {
  /** Flujo normal de atencion. Requiere el interruptor encendido. */
  CONVERSACION: "conversacion",
  /** Aviso al dueno. No es un cliente, pero tambien respeta el interruptor. */
  AVISO_AL_DUENO: "aviso_al_dueno",
  /** Prueba controlada, autorizada por una persona para un numero concreto. */
  PRUEBA_AUTORIZADA: "prueba_autorizada",
  /**
   * Una PERSONA escribiendo desde el panel.
   *
   * Es un permiso aparte y no "conversacion" por dos razones:
   *
   *   - No lo gobierna RESPUESTA_AUTOMATICA. Ese interruptor existe para
   *     que el BOT no hable; un operador que pulsa enviar no es el bot.
   *     Tiene su propio interruptor, PANEL_ENVIO_MANUAL.
   *   - No lo frena la pausa del chat. Al contrario: tomar el control
   *     pausa el bot justo para que escriba la persona.
   */
  ATENCION_MANUAL: "atencion_manual",
};

/**
 * ¿Este destinatario es un telefono al que Meta acepta escribir?
 *
 * VIVE AQUI Y SE EXPORTA, en vez de repetirse donde haga falta: el panel
 * necesita la MISMA respuesta. Dos copias de esta regla se separan — ya
 * paso con las dos listas de "pregunta de precio" y con el filtro de pedido
 * activo duplicado en cada backend.
 */
function esUnTelefono(destino) {
  const d = String(destino || "");
  const digitos = d.replace(/\D/g, "");
  return digitos.length >= 7 && digitos.length <= 15 && !/[a-z]/i.test(d);
}

/**
 * ¿Es un BSUID? `{codigo de pais ISO}.{hasta 128 alfanumericos}`.
 *
 * Es el identificador de los clientes que entran con NOMBRE DE USUARIO de
 * WhatsApp, una funcion de privacidad que Meta empezo a desplegar en 2026:
 * el cliente oculta su numero y en el webhook llega solo este `CO.…`.
 *
 * Se valida la forma COMPLETA -codigo de pais y punto incluidos- porque la
 * documentacion de Meta avisa de que recortar o modificar cualquier parte
 * hace fallar la peticion.
 */
function esUnBsuid(destino) {
  return /^[A-Za-z]{2}\.[A-Za-z0-9]{1,128}$/.test(String(destino || ""));
}

/**
 * Como se le escribe a este destinatario, en la forma que exige Meta.
 *
 * --------------------------------------------------------------------------
 * A LOS CLIENTES CON NOMBRE DE USUARIO **SI** SE LES PUEDE ESCRIBIR
 * --------------------------------------------------------------------------
 *
 * Esto antes bloqueaba cualquier destino que no fuera un telefono, con el
 * motivo "no se puede escribir a este cliente". Era lo correcto cuando se
 * escribio -8 fallos reales con error 131026- pero ERA UNA CONCLUSION SIN
 * COMPROBAR, y el propio comentario dejaba el pendiente anotado: "hay que
 * comprobar en la documentacion de Meta si la API admite responder a un
 * usuario sin numero".
 *
 * Marco insistio en que si se podia. Comprobado en la documentacion de Meta
 * (Business-scoped user IDs, actualizada el 15-sep-2026), y tiene razon:
 *
 *   · para enviar con el telefono -> se pone `to` y se OMITE `recipient`
 *   · para enviar con el BSUID    -> se pone `recipient` y se OMITE `to`
 *
 * Y el envio a BSUIDs esta disponible desde junio de 2026.
 *
 * ⚠️ OJO CON LA FUENTE: la documentacion de Azure dice que el campo `to`
 * acepta "un telefono o un BSUID, el servicio detecta el formato". Eso es
 * cierto para EL WRAPPER DE AZURE, no para la API de Meta, que es la que
 * usamos aqui. Seguir esa frase habria significado mandar el BSUID en `to`,
 * y la peticion falla. Por eso se confirmo contra la documentacion de Meta.
 *
 * Los 8 fallos originales no fueron porque no se pueda: fue porque se
 * mandaba el BSUID en `to`, que es justo el error que Meta rechaza.
 *
 * @returns {{to:string}|{recipient:string}|null} null si no es ninguna de
 *   las dos cosas: ahi si no hay nada que intentar.
 */
function destinatarioDe(destino) {
  const d = String(destino || "").trim();
  if (esUnTelefono(d)) return { to: d };
  if (esUnBsuid(d)) return { recipient: d };
  return null;
}

const MOTIVOS_BLOQUEO = {
  INTERRUPTOR: "respuesta_automatica_apagada",
  SIN_CREDENCIALES: "sin_credenciales",
  SIN_PERMISO: "sin_permiso",
  SIN_DESTINO: "sin_destino",
  /**
   * Hay destinatario, pero no es un telefono: es un BSUID de un cliente que
   * escribe con nombre de usuario de WhatsApp. Meta lo rechaza con 131026.
   */
  SIN_TELEFONO: "destinatario_sin_telefono",
  TEXTO_VACIO: "texto_vacio",
  /** El panel puede enviar, pero su interruptor esta apagado. */
  ENVIO_MANUAL_APAGADO: "envio_manual_apagado",
  /** Una persona tiene el control de este chat: el bot no habla. */
  CONVERSACION_PAUSADA: "conversacion_pausada",
  /** La imagen no cumple lo que Meta exige, o no se puede alcanzar. */
  IMAGEN_NO_ENVIABLE: "imagen_no_enviable",
  /**
   * Hace falta una plantilla aprobada y no hay ninguna configurada.
   *
   * Es un motivo APARTE de "no se pudo enviar" a proposito: no es un fallo
   * de red ni un rechazo de Meta, es una tarea pendiente de una persona
   * -crear la plantilla y que Meta la apruebe-. Mezclarlo con los errores
   * de envio lo esconde en el ruido, y entonces nadie la crea.
   */
  SIN_PLANTILLA: "sin_plantilla_aprobada",
  /** El documento no se pudo subir a Meta, asi que no hay nada que mandar. */
  DOCUMENTO_NO_SUBIDO: "documento_no_subido",
};

/**
 * Tope del nombre de archivo que ve el cliente.
 *
 * Meta rechaza nombres muy largos, y el nombre de una guia lo construimos
 * nosotros: recortarlo aqui evita que un numero de guia raro tumbe un envio
 * que ya tenia el PDF subido.
 */
const MAX_NOMBRE_ARCHIVO = 240;

/**
 * Tope del pie de foto de WhatsApp.
 *
 * Meta lo corta sin avisar, asi que se recorta aqui: un texto cortado a
 * mitad de una frase por el servidor de otro es peor que uno que nosotros
 * decidimos acortar.
 */
const MAX_PIE_DE_FOTO = 1024;

/** Codigos de Meta que pueden salir distinto al reintentar. */
const CODIGOS_TEMPORALES = new Set([2, 4, 80007, 130429, 131000, 131056]);
const HTTP_TEMPORALES = new Set([408, 429, 500, 502, 503, 504]);
const ESPERAS_MS = [1500, 4000];

/**
 * @param {object} opciones
 * @param {object} opciones.config
 * @param {object} [opciones.log]
 * @param {object} [opciones.metricas]
 * @param {Function} [opciones.fetchImpl]  inyectable para pruebas
 */
function crearEmisor({
  config,
  log = null,
  metricas = null,
  fetchImpl = null,
  // Para el candado contra las dos voces. Se inyectan para que el emisor no
  // dependa del almacen: sin ellos sigue funcionando -y las pruebas que solo
  // miran el interruptor no tienen que montar repositorios-, pero entonces
  // no hay pausa que comprobar y hay que pasarla por otro lado.
  repos = null,
  atencion = null,
} = {}) {
  const hacerFetch = fetchImpl || globalThis.fetch;

  function contar(nombre) {
    if (metricas && typeof metricas.incrementar === "function") metricas.incrementar(nombre);
  }
  function registrar(nivel, evento, datos) {
    if (log && typeof log[nivel] === "function") log[nivel](evento, datos);
  }

  /**
   * ¿Se puede enviar? Se resuelve ANTES de construir nada.
   * @returns {{puede: boolean, motivo?: string}}
   */
  function revisarPermiso({ para, texto, permiso }) {
    if (!Object.values(PERMISOS).includes(permiso)) {
      return { puede: false, motivo: MOTIVOS_BLOQUEO.SIN_PERMISO };
    }
    if (!para) return { puede: false, motivo: MOTIVOS_BLOQUEO.SIN_DESTINO };
    if (!texto || !String(texto).trim()) return { puede: false, motivo: MOTIVOS_BLOQUEO.TEXTO_VACIO };

    // La atencion manual tiene su propio interruptor. No depende de
    // RESPUESTA_AUTOMATICA porque no es el bot hablando.
    if (permiso === PERMISOS.ATENCION_MANUAL) {
      if (!config.panelEnvioManual) {
        return { puede: false, motivo: MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO };
      }
      if (!config.whatsappToken || !config.idNumero) {
        return { puede: false, motivo: MOTIVOS_BLOQUEO.SIN_CREDENCIALES };
      }
      return { puede: true };
    }

    // EL CANDADO. Una prueba autorizada es la unica excepcion, y tiene que
    // pedirse por su nombre.
    if (!config.respuestaAutomatica && permiso !== PERMISOS.PRUEBA_AUTORIZADA) {
      return { puede: false, motivo: MOTIVOS_BLOQUEO.INTERRUPTOR };
    }
    if (!config.whatsappToken || !config.idNumero) {
      return { puede: false, motivo: MOTIVOS_BLOQUEO.SIN_CREDENCIALES };
    }
    return { puede: true };
  }

  /**
   * Envia un texto por WhatsApp.
   *
   * NUNCA LANZA. Devuelve siempre un resultado uniforme, porque un fallo de
   * envio no puede tumbar el procesamiento del mensaje de un cliente ni
   * perderse en un catch de otro.
   *
   * @returns {Promise<{enviado: boolean, bloqueado?: boolean, motivo?: string,
   *                    estado?: number, wamid?: string, intentos?: number}>}
   */
  /**
   * ENTREGAR: permisos, candado de pausa, construccion y reintentos.
   *
   * Texto e imagen pasan por aqui. Tener dos caminos de salida habria
   * significado dos sitios donde acordarse del interruptor y de la pausa, y
   * el que menos se usa es el que se queda sin el candado.
   */
  async function entregar({ para, permiso, conversacionId, texto, contenido, tipo, aLog = {} }) {
    const permitido = revisarPermiso({ para, texto, permiso });

    // ----------------------------------------------------------------------
    // EL CANDADO CONTRA LAS DOS VOCES
    //
    // Se comprueba AQUI, en el punto unico de salida, y no al empezar el
    // turno. Esa diferencia es todo el arreglo.
    //
    // BIKERPRO lo comprueba al principio:
    //
    //   if (store.isPaused(from)) continue;   <- aqui
    //   await ...                             <- la IA piensa, segundos
    //   await sendText(from, reply);          <- envia sin volver a mirar
    //
    // Si el operador toma el control mientras el modelo piensa, el bot
    // contesta igual y el cliente recibe dos voces. Con Gemini en medio esa
    // ventana son segundos de verdad, no microsegundos.
    //
    // Aqui la pregunta se hace cuando la IA YA respondio y justo antes de
    // escribir a la red. Y se hace en el emisor, que es el unico camino al
    // exterior, para que ningun flujo nuevo tenga que acordarse.
    // ----------------------------------------------------------------------
    if (permitido.puede && permiso === PERMISOS.CONVERSACION && conversacionId && atencion && repos) {
      const pausada = await atencion.estaPausada(repos, conversacionId);
      if (pausada) {
        contar("respuesta_bloqueada_por_pausa");
        registrar("info", "envio_bloqueado_por_pausa", {
          detalle: "Una persona tomo el control de este chat mientras se preparaba la respuesta. El bot no escribe.",
        });
        return { enviado: false, bloqueado: true, motivo: MOTIVOS_BLOQUEO.CONVERSACION_PAUSADA };
      }
    }

    if (!permitido.puede) {
      if (permitido.motivo === MOTIVOS_BLOQUEO.INTERRUPTOR) {
        contar("respuesta_bloqueada_por_interruptor");
        // Sin telefono ni texto: es una decision, no una incidencia.
        registrar("info", "envio_bloqueado_por_interruptor", { longitud: String(texto || "").length });
      } else {
        registrar("warn", "envio_bloqueado", { motivo: permitido.motivo });
      }
      return { enviado: false, bloqueado: true, motivo: permitido.motivo };
    }

    // ----------------------------------------------------------------------
    // UN BSUID NO ES UN DESTINATARIO: NO SE QUEMA EL INTENTO
    //
    // SALIO DE LA AUDITORIA REAL, y son 8 fallos de envio con el mismo
    // error del proveedor:
    //
    //   contacto CO.1667873168388823
    //   error 131026 · Message undeliverable
    //
    // Ese `CO.…` no es un telefono: es un BSUID, el identificador de los
    // clientes que escriben con NOMBRE DE USUARIO de WhatsApp y no tienen
    // numero. `normalizar.js` ya lo distingue -`idCliente` cae al bsuid
    // cuando no hay telefono- y su comentario avisaba de esto literalmente:
    // "la clave de la conversacion y el telefono al que se despacha son
    // cosas distintas, y confundirlas rompe el despacho".
    //
    // Y se confundian: el cerebro envia a `evento.telefono || evento
    // .idCliente`, asi que sin telefono mandaba al BSUID y Meta lo
    // rechazaba. El cliente nunca recibia nada, y como el fallo pasaba en
    // la red, no quedaba a la vista de nadie.
    //
    // Aqui NO se intenta. Reintentar contra un destinatario invalido gasta
    // tres llamadas, llena el diario de ruido y tapa el motivo real. Se
    // devuelve bloqueado con un motivo que se entiende, y quien llama
    // decide -el cerebro deja tarea para una persona-.
    //
    // LO QUE NO SE RESUELVE AQUI, y es decision de Marco: si a estos
    // clientes se les puede responder de otra forma. Hay que comprobar en
    // la documentacion de Meta si la API admite responder a un usuario sin
    // numero; mientras no se sepa, lo unico honesto es no fingir que se
    // envio y que una persona lo vea.
    // ----------------------------------------------------------------------
    const destino = String(para || "");
    const comoEnviar = destinatarioDe(destino);
    if (!comoEnviar) {
      contar("envio_sin_destino_valido");
      registrar("warn", "destinatario_no_valido", {
        // El identificador NO se recorta: con la mascara puesta parecia un
        // telefono extranjero y me llevo a una conclusion inventada.
        destino,
        porQue: "no es un telefono ni un BSUID con la forma que exige Meta",
      });
      return {
        enviado: false,
        bloqueado: true,
        motivo: MOTIVOS_BLOQUEO.SIN_TELEFONO,
      };
    }

    const url = `https://graph.facebook.com/${config.versionGraph}/${config.idNumero}/messages`;
    const cuerpo = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      // `to` con un telefono, o `recipient` con un BSUID. NUNCA los dos:
      // Meta lo exige asi, y `destinatarioDe` devuelve solo uno.
      ...comoEnviar,
      type: tipo,
      [tipo]: contenido,
    };

    let ultimo = { estado: 0, codigo: null };

    for (let intento = 1; intento <= ESPERAS_MS.length + 1; intento++) {
      let respuesta;
      try {
        respuesta = await hacerFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.whatsappToken}` },
          body: JSON.stringify(cuerpo),
        });
      } catch (e) {
        // Red caida. Se trata como temporal: en BIKERPRO el try/catch estaba
        // fuera del bucle, asi que un socket cortado se saltaba todos los
        // reintentos y el cliente se quedaba sin respuesta.
        ultimo = { estado: 0, codigo: null, detalle: e && e.message };
        registrar("warn", "envio_error_de_red", { intento });
        if (await esperar(intento)) continue;
        break;
      }

      let datos = null;
      try {
        datos = await respuesta.json();
      } catch {
        datos = null;
      }

      if (respuesta.ok) {
        const wamid = datos?.messages?.[0]?.id || null;
        contar("respuesta_enviada");
        registrar("info", "respuesta_enviada", { wamid, intentos: intento, tipo, ...aLog });
        return { enviado: true, estado: respuesta.status, wamid, intentos: intento };
      }

      const codigo = datos?.error?.code ?? null;
      ultimo = { estado: respuesta.status, codigo };
      registrar("warn", "envio_rechazado", { intento, estado: respuesta.status, codigo, tipo, ...aLog });

      const temporal = HTTP_TEMPORALES.has(respuesta.status) || CODIGOS_TEMPORALES.has(codigo);
      if (temporal && (await esperar(intento))) continue;
      break;
    }

    contar("error_interno");
    registrar("error", "envio_fallido", { estado: ultimo.estado, codigo: ultimo.codigo, tipo, ...aLog });
    return { enviado: false, motivo: "no se pudo enviar", estado: ultimo.estado, codigoMeta: ultimo.codigo };
  }

  /** Texto. */
  async function enviarTexto({ para, texto, permiso = PERMISOS.CONVERSACION, conversacionId = null }) {
    return entregar({
      para,
      permiso,
      conversacionId,
      texto,
      tipo: "text",
      contenido: { preview_url: false, body: String(texto || "") },
      aLog: { longitud: String(texto || "").length },
    });
  }

  /**
   * UNA IMAGEN, por `link`.
   *
   * ------------------------------------------------------------------------
   * POR QUE SE COMPRUEBA LA IMAGEN ANTES DE LLAMAR A META
   * ------------------------------------------------------------------------
   *
   * Con `link`, Meta descarga la URL con SUS servidores. Si la foto no
   * existe, no es jpeg/png, pasa de 5 MB o la URL no es publica, Meta
   * responde un error 131053 ("Media upload error") — y eso ocurre DESPUES
   * de que el cliente haya preguntado por el producto, con el esperando.
   *
   * Comprobarlo antes convierte ese fallo en un motivo claro y sin gastar
   * una llamada a la API. `revisarImagen` mira el archivo en ESTE
   * despliegue, no solo lo que dice el catalogo.
   *
   * El `texto` del permiso se rellena con el pie o con la propia URL: un
   * envio sin texto no debe caer en TEXTO_VACIO, que es una comprobacion
   * pensada para mensajes de texto.
   */
  async function enviarImagen({
    para,
    archivo = null,
    url: urlDirecta = null,
    pie = "",
    permiso = PERMISOS.CONVERSACION,
    conversacionId = null,
  }) {
    let enlace = urlDirecta;
    let revision = null;

    if (!enlace) {
      if (!archivo) {
        return { enviado: false, bloqueado: true, motivo: MOTIVOS_BLOQUEO.IMAGEN_NO_ENVIABLE, detalle: "sin archivo ni url" };
      }
      revision = require("../catalogo/imagenes").revisarImagen(archivo, config.urlPublica);
      if (!revision.sePuedeEnviar) {
        contar("imagen_no_enviable");
        registrar("warn", "imagen_no_enviable", { archivo, problemas: revision.problemas });
        return {
          enviado: false,
          bloqueado: true,
          motivo: MOTIVOS_BLOQUEO.IMAGEN_NO_ENVIABLE,
          detalle: revision.problemas.join("; "),
        };
      }
      enlace = revision.url;
    }

    const pieRecortado = String(pie || "").slice(0, MAX_PIE_DE_FOTO);

    const r = await entregar({
      para,
      permiso,
      conversacionId,
      // Para la comprobacion de permisos basta con que haya "algo que
      // mandar": aqui el contenido es la imagen, no el texto.
      texto: pieRecortado || enlace,
      tipo: "image",
      contenido: pieRecortado ? { link: enlace, caption: pieRecortado } : { link: enlace },
      aLog: { archivo: archivo || null },
    });

    return { ...r, url: enlace, archivo: archivo || null };
  }

  /**
   * UNA PLANTILLA APROBADA.
   *
   * ------------------------------------------------------------------------
   * POR QUE HACE FALTA, Y POR QUE NO ES "ENVIAR TEXTO CON OTRO NOMBRE"
   * ------------------------------------------------------------------------
   *
   * Fuera de la ventana de 24 horas Meta SOLO entrega plantillas. Y los dos
   * mensajes mas valiosos del negocio caen siempre fuera de esa ventana:
   *
   *   · la guia  -> se despacha al dia siguiente de la compra
   *   · la novedad de entrega -> aparece 1 a 3 dias despues
   *
   * Con texto libre Meta responde 131047 ("re-engagement message") y el
   * cliente no recibe nada. En BIKERPRO esto se midio con el cierre diario:
   * Meta acepto el mensaje con ok:true y NUNCA lo entrego. De ahi la regla
   * que gobierna todo este modulo: aceptado por Meta no es entregado.
   *
   * Si no hay plantilla configurada NO se intenta con texto libre. Se
   * devuelve SIN_PLANTILLA, que es una tarea para una persona, en vez de
   * quemar un intento y anotar un fallo que parece de red.
   *
   * @param {object}   opciones
   * @param {string}   opciones.plantilla  nombre aprobado en Meta
   * @param {string[]} [opciones.variables] los {{1}}, {{2}}... en orden
   * @param {{mediaId:string, nombreArchivo:string}} [opciones.documento]
   *        PDF para la cabecera de la plantilla, ya subido a Meta
   */
  async function enviarPlantilla({
    para,
    plantilla,
    idioma = config.idiomaPlantillas,
    variables = [],
    documento = null,
    permiso = PERMISOS.CONVERSACION,
    conversacionId = null,
  }) {
    const nombre = String(plantilla || "").trim();
    if (!nombre) {
      registrar("warn", "plantilla_sin_nombre", {
        detalle:
          "Se pidio enviar una plantilla sin nombre. Fuera de la ventana de 24 h es el unico " +
          "mensaje que Meta entrega: hay que crearla y que Meta la apruebe.",
      });
      return { enviado: false, bloqueado: true, motivo: MOTIVOS_BLOQUEO.SIN_PLANTILLA };
    }

    const componentes = [];
    if (documento && documento.mediaId) {
      componentes.push({
        type: "header",
        parameters: [
          {
            type: "document",
            document: {
              id: documento.mediaId,
              filename: String(documento.nombreArchivo || "documento.pdf").slice(0, MAX_NOMBRE_ARCHIVO),
            },
          },
        ],
      });
    }
    const cuerpoVars = (Array.isArray(variables) ? variables : [])
      .map((v) => String(v == null ? "" : v))
      .filter((v) => v !== "");
    if (cuerpoVars.length) {
      componentes.push({
        type: "body",
        parameters: cuerpoVars.map((v) => ({ type: "text", text: v })),
      });
    }

    const contenido = {
      name: nombre,
      // El CODIGO DE IDIOMA es exacto y no se adivina. Con "es" Meta rechaza
      // con 132001 ("template name does not exist in the translation") aunque
      // la plantilla este aprobada, porque la subio en Spanish (COL) y para
      // Meta "es" y "es_CO" son dos traducciones distintas.
      language: { code: String(idioma || "es_CO") },
    };
    if (componentes.length) contenido.components = componentes;

    const r = await entregar({
      para,
      permiso,
      conversacionId,
      // Para la revision de permisos lo que hay que mandar es la plantilla.
      // Un envio sin texto no debe caer en TEXTO_VACIO, que es una
      // comprobacion pensada para mensajes de texto.
      texto: nombre,
      tipo: "template",
      contenido,
      aLog: { plantilla: nombre, idioma, variables: cuerpoVars.length, conDocumento: Boolean(documento) },
    });

    return { ...r, plantilla: nombre, porPlantilla: true };
  }

  /**
   * Sube un archivo a Meta y devuelve su `mediaId`.
   *
   * ------------------------------------------------------------------------
   * POR QUE SE SUBE EN VEZ DE MANDAR UN ENLACE
   * ------------------------------------------------------------------------
   *
   * Una guia lleva impresos el NOMBRE, LA DIRECCION Y EL TELEFONO del
   * cliente. Publicarla en una URL alcanzable -aunque sea con un nombre
   * difícil de adivinar- es dejar datos personales expuestos en internet
   * mientras esa URL viva.
   *
   * Subiendola, el PDF viaja a Meta por el canal autenticado, se identifica
   * con un `mediaId` que caduca a los 30 dias, y nunca se publica. Por eso
   * las fotos del catalogo si van por `link` -son publicas a proposito- y
   * las guias no.
   *
   * NUNCA LANZA: devuelve el motivo, porque quien llama tiene que poder
   * mostrarselo al operador en vez de perderlo en un catch.
   */
  async function subirMedia({ datos, nombreArchivo, mime = "application/pdf" }) {
    if (!config.whatsappToken || !config.idNumero) {
      return { ok: false, motivo: MOTIVOS_BLOQUEO.SIN_CREDENCIALES };
    }
    if (!datos || !datos.length) {
      return { ok: false, motivo: MOTIVOS_BLOQUEO.DOCUMENTO_NO_SUBIDO, detalle: "el archivo esta vacio" };
    }

    const url = `https://graph.facebook.com/${config.versionGraph}/${config.idNumero}/media`;
    const nombre = String(nombreArchivo || "documento.pdf").slice(0, MAX_NOMBRE_ARCHIVO);

    let ultimo = { estado: 0, codigo: null, detalle: null };

    // Se reintenta igual que un envio: subir es una llamada de red mas, y un
    // 500 de Meta aqui dejaria la guia sin salir aunque el pareo fuera
    // correcto. Reintentar una subida es seguro -son mediaId distintos y solo
    // se usa el ultimo-, al contrario que reintentar un envio de mensaje.
    for (let intento = 1; intento <= ESPERAS_MS.length + 1; intento++) {
      let respuesta;
      try {
        const form = new FormData();
        form.append("messaging_product", "whatsapp");
        form.append("type", mime);
        // El Blob se construye en cada intento: un cuerpo de FormData ya
        // consumido no se puede volver a enviar.
        form.append("file", new Blob([datos], { type: mime }), nombre);
        respuesta = await hacerFetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${config.whatsappToken}` },
          body: form,
        });
      } catch (e) {
        ultimo = { estado: 0, codigo: null, detalle: e && e.message };
        registrar("warn", "subida_error_de_red", { intento });
        if (await esperar(intento)) continue;
        break;
      }

      let cuerpo = null;
      try {
        cuerpo = await respuesta.json();
      } catch {
        cuerpo = null;
      }

      if (respuesta.ok && cuerpo && cuerpo.id) {
        contar("documento_subido");
        registrar("info", "documento_subido", { intentos: intento, nombreArchivo: nombre });
        return { ok: true, mediaId: cuerpo.id, nombreArchivo: nombre };
      }

      const codigo = cuerpo?.error?.code ?? null;
      ultimo = { estado: respuesta.status, codigo, detalle: cuerpo?.error?.message || null };
      registrar("warn", "subida_rechazada", { intento, estado: respuesta.status, codigo });

      const temporal = HTTP_TEMPORALES.has(respuesta.status) || CODIGOS_TEMPORALES.has(codigo);
      if (temporal && (await esperar(intento))) continue;
      break;
    }

    contar("documento_no_subido");
    registrar("error", "subida_fallida", { estado: ultimo.estado, codigo: ultimo.codigo });
    return {
      ok: false,
      motivo: MOTIVOS_BLOQUEO.DOCUMENTO_NO_SUBIDO,
      estado: ultimo.estado,
      codigoMeta: ultimo.codigo,
      detalle: ultimo.detalle,
    };
  }

  /**
   * UN PDF, subiendolo primero.
   *
   * Decide solo entre documento libre y plantilla segun la ventana de 24 h,
   * porque quien llama no tiene por que saber esa regla de Meta:
   *
   *   · `ventanaAbierta: true`  -> documento con pie de foto
   *   · `ventanaAbierta: false` -> plantilla con el PDF en la cabecera
   *
   * El pie NO viaja en la plantilla: su texto ya esta aprobado en Meta y no
   * se puede cambiar desde aqui. Quien llama recibe `porPlantilla` para
   * poder decirle al operador que el cliente vio el texto aprobado, no el
   * que se escribio.
   *
   * SE SUBE UNA SOLA VEZ aunque haya que reintentar el mensaje: el `mediaId`
   * se devuelve siempre, incluso si el envio falla, para que un reintento no
   * vuelva a gastar la subida.
   */
  async function enviarDocumento({
    para,
    datos,
    nombreArchivo,
    pie = "",
    ventanaAbierta = true,
    plantilla = null,
    idioma = config.idiomaPlantillas,
    mediaId = null,
    permiso = PERMISOS.CONVERSACION,
    conversacionId = null,
  }) {
    // Los permisos se revisan ANTES de subir. Subir un PDF que despues no se
    // va a poder enviar gasta una llamada y deja un mediaId huerfano en Meta.
    const previo = revisarPermiso({ para, texto: nombreArchivo || "documento", permiso });
    if (!previo.puede) {
      registrar(previo.motivo === MOTIVOS_BLOQUEO.INTERRUPTOR ? "info" : "warn", "documento_bloqueado", {
        motivo: previo.motivo,
      });
      return { enviado: false, bloqueado: true, motivo: previo.motivo };
    }

    // Sin plantilla y con la ventana cerrada no hay nada que intentar: Meta
    // no entrega texto libre fuera de las 24 h. Se dice antes de subir.
    if (!ventanaAbierta && !plantilla) {
      return {
        enviado: false,
        bloqueado: true,
        motivo: MOTIVOS_BLOQUEO.SIN_PLANTILLA,
        detalle:
          "la ventana de 24 h de este cliente esta cerrada y no hay plantilla configurada para mandarle el documento",
      };
    }

    let id = mediaId;
    if (!id) {
      const subida = await subirMedia({ datos, nombreArchivo });
      if (!subida.ok) {
        return {
          enviado: false,
          motivo: subida.motivo,
          estado: subida.estado,
          codigoMeta: subida.codigoMeta,
          detalle: subida.detalle,
        };
      }
      id = subida.mediaId;
    }

    const nombre = String(nombreArchivo || "documento.pdf").slice(0, MAX_NOMBRE_ARCHIVO);

    if (!ventanaAbierta) {
      const r = await enviarPlantilla({
        para,
        plantilla,
        idioma,
        documento: { mediaId: id, nombreArchivo: nombre },
        permiso,
        conversacionId,
      });
      return { ...r, mediaId: id, nombreArchivo: nombre };
    }

    const pieRecortado = String(pie || "").slice(0, MAX_PIE_DE_FOTO);
    const r = await entregar({
      para,
      permiso,
      conversacionId,
      texto: pieRecortado || nombre,
      tipo: "document",
      contenido: {
        id,
        filename: nombre,
        ...(pieRecortado ? { caption: pieRecortado } : {}),
      },
      aLog: { nombreArchivo: nombre, longitud: pieRecortado.length },
    });

    return { ...r, mediaId: id, nombreArchivo: nombre, porPlantilla: false };
  }

  async function esperar(intento) {
    const ms = ESPERAS_MS[intento - 1];
    if (ms === undefined) return false;
    await new Promise((r) => setTimeout(r, ms));
    return true;
  }

  return {
    enviarTexto,
    enviarImagen,
    enviarPlantilla,
    enviarDocumento,
    subirMedia,
    revisarPermiso,
    PERMISOS,
    MOTIVOS_BLOQUEO,
  };
}

module.exports = {
  crearEmisor,
  PERMISOS,
  MOTIVOS_BLOQUEO,
  esUnTelefono,
  esUnBsuid,
  destinatarioDe,
  MAX_PIE_DE_FOTO,
  MAX_NOMBRE_ARCHIVO,
  CODIGOS_TEMPORALES,
  HTTP_TEMPORALES,
};
