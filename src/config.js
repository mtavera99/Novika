"use strict";

// ==========================================================================
// CONFIGURACION
//
// Un unico sitio donde se lee process.env. El resto del codigo importa este
// modulo y no vuelve a tocar el entorno. Dos razones:
//
//   - se puede validar todo de golpe al arrancar, en vez de descubrir a las
//     tres de la tarde que falta una variable;
//   - no hay valores por defecto escondidos en mitad de un modulo.
//
// Decision deliberada: NO hay valores de respaldo para los secretos. En
// BIKERPRO el token de verificacion tenia un respaldo escrito en el codigo
// y acabo publicado en cinco archivos de un repositorio publico. Si falta un
// secreto, NOVIKA no arranca.
// ==========================================================================

const path = require("node:path");

try {
  require("dotenv").config();
} catch (e) {
  // En produccion las variables llegan del entorno; dotenv es solo comodidad local.
}

function texto(nombre, porDefecto = "") {
  const v = process.env[nombre];
  return typeof v === "string" ? v.trim() : porDefecto;
}

function bandera(nombre, porDefecto = false) {
  const v = texto(nombre);
  if (v === "") return porDefecto;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "si";
}

function entero(nombre, porDefecto) {
  const n = Number.parseInt(texto(nombre), 10);
  return Number.isFinite(n) ? n : porDefecto;
}

const config = {
  marca: "novika",

  puerto: entero("PORT", 3000),

  // --- Meta / WhatsApp ---
  verifyToken: texto("WHATSAPP_VERIFY_TOKEN"),
  appSecret: texto("META_APP_SECRET"),
  whatsappToken: texto("WHATSAPP_TOKEN"),
  idNumero: texto("WHATSAPP_PHONE_NUMBER_ID"),
  idWaba: texto("WHATSAPP_WABA_ID"),
  versionGraph: texto("GRAPH_VERSION", "v21.0"),

  // --- Operacion ---
  dirDatos: texto("DATA_DIR") || path.join(__dirname, "..", "data"),
  panelToken: texto("PANEL_TOKEN"),
  nivelLog: texto("LOG_NIVEL", "info"),
  logPii: bandera("LOG_PII", false),
  respuestaAutomatica: bandera("RESPUESTA_AUTOMATICA", false),
  // Interruptor PROPIO del panel para los envios manuales de un operador.
  //
  // Aparte de RESPUESTA_AUTOMATICA a proposito: ese interruptor existe para
  // que el BOT no hable, y una persona que pulsa enviar no es el bot. Pero
  // tampoco puede quedar implicito, porque entonces el panel seria una
  // puerta abierta a enviar WhatsApps reales sin haberlo decidido.
  //
  // Apagado por defecto: el panel se opera completo y el resultado que
  // muestra es el real -"bloqueado por el interruptor"-, nunca un envio
  // fingido.
  panelEnvioManual: bandera("PANEL_ENVIO_MANUAL", false),
  zonaHoraria: texto("ZONA_HORARIA", "America/Bogota"),
  ownerWhatsapp: texto("OWNER_WHATSAPP"),

  // --- Despacho: guias y novedades de entrega ---

  // --------------------------------------------------------------------------
  // IDIOMA DE LAS PLANTILLAS: "es_CO", NO "es"
  //
  // Para Meta son dos TRADUCCIONES distintas de la misma plantilla. Si la
  // plantilla se subio en Spanish (COL) y se envia con "es", Meta la rechaza
  // con 132001 -"template name does not exist in the translation"- aunque la
  // plantilla este aprobada y visible en el panel de Meta.
  //
  // Es un fallo que no se parece a lo que es: el mensaje habla del NOMBRE de
  // la plantilla, asi que se busca el error en el nombre y no en el idioma.
  // Queda parametrizable porque el idioma lo elige quien crea la plantilla.
  // --------------------------------------------------------------------------
  idiomaPlantillas: texto("PLANTILLA_IDIOMA", "es_CO"),

  // --------------------------------------------------------------------------
  // UNA PLANTILLA POR TIPO DE NOVEDAD, Y NO UNA GENERICA
  //
  // Una sola plantilla ("tu pedido tuvo una novedad, responde") obliga al
  // cliente a PREGUNTAR que paso, y ahi se pierde gente justo cuando el
  // paquete esta a dias de devolverse. Con una por caso, al cliente le llega
  // lo que necesita saber sin preguntar nada.
  //
  // Sin valor por defecto A PROPOSITO. Una plantilla con nombre inventado
  // falla en el envio, que es tarde: el operador ya creyo que aviso. Vacio
  // significa "bloqueado, falta crearla en Meta", y el panel lo dice antes de
  // intentar nada.
  // --------------------------------------------------------------------------
  plantillaNovedadDireccion: texto("PLANTILLA_NOVEDAD_DIRECCION"),
  plantillaNovedadAusente: texto("PLANTILLA_NOVEDAD_AUSENTE"),
  plantillaNovedadOficina: texto("PLANTILLA_NOVEDAD_OFICINA"),

  // La guia se despacha al dia siguiente de la compra, asi que la ventana de
  // 24 h del cliente casi siempre esta cerrada: esta plantilla es el camino
  // NORMAL, no la excepcion.
  plantillaGuia: texto("PLANTILLA_GUIA"),

  // --------------------------------------------------------------------------
  // LOS TELEFONOS PROPIOS QUE VAN IMPRESOS EN LA ETIQUETA
  //
  // Se usa para NO confundir el telefono del remitente con el del cliente al
  // parear una guia. Un telefono vale 50 puntos -la senal mas fuerte-, asi
  // que colar el numero propio como si fuera del destinatario ensucia el
  // pareo entero.
  //
  // ES UNA VARIABLE APARTE DE OWNER_WHATSAPP, y la separacion viene de un
  // incidente de BIKERPRO: el dueno movio los avisos del bot a su celular
  // personal, y como se usaba la misma variable para las dos cosas, el
  // telefono impreso en la etiqueta dejo de reconocerse.
  //
  // Son dos preguntas distintas: "a quien le aviso" y "que numero va impreso
  // en la etiqueta". Acepta varios separados por coma: excluir un numero
  // propio de mas no cuesta nada, olvidarse de uno si.
  // --------------------------------------------------------------------------
  telefonosRemitente: texto("TELEFONOS_REMITENTE")
    .split(/[,;]/)
    .map((n) => n.replace(/\D/g, ""))
    .filter(Boolean),

  // --- Fase 2 ---

  // Modo sombra: procesar el mensaje completo y PREPARAR la respuesta sin
  // enviarla. Encendido por defecto, porque es como se audita el bot con
  // trafico real antes de dejarlo hablar.
  modoSombra: bandera("MODO_SOMBRA", true),

  // IA. Sin clave no hay IA, y el sistema sigue funcionando por el camino
  // determinista: el mensaje se registra y se escala.
  iaApiKey: texto("IA_API_KEY"),
  iaBaseUrl: texto("IA_BASE_URL", "https://api.openai.com/v1"),
  iaModelo: texto("IA_MODELO", "gpt-4o-mini"),
  iaTimeoutMs: entero("IA_TIMEOUT_MS", 12000),

  // PostgreSQL para la informacion transaccional. Mientras este vacio, se
  // usan archivos sobre el disco persistente. Si se define sin que exista el
  // adaptador, el arranque falla a proposito: ver src/almacen/repos/index.js.
  databaseUrl: texto("DATABASE_URL"),

  // --------------------------------------------------------------------------
  // URL PUBLICA DEL SERVICIO
  //
  // Hace falta para mandar una foto por WhatsApp: en el envio por `link`,
  // Meta descarga la imagen con SUS servidores, asi que la URL tiene que ser
  // absoluta, publica y HTTPS. Una ruta relativa no le sirve de nada.
  //
  // Render la pone sola en RENDER_EXTERNAL_URL, asi que en produccion no hay
  // que configurar nada; URL_PUBLICA existe para poder forzarla (un dominio
  // propio, una prueba). Sin ninguna de las dos no se puede construir el
  // enlace, y el codigo que envia tiene que decirlo en vez de mandar una URL
  // a medias que Meta rechazaria.
  // --------------------------------------------------------------------------
  urlPublica: (texto("URL_PUBLICA") || texto("RENDER_EXTERNAL_URL") || "").replace(/\/+$/, ""),

  // --------------------------------------------------------------------------
  // LISTA BLANCA DE NUMEROS PARA PROBAR EN PRODUCCION
  //
  // Vacia = sin restriccion: el bot atiende a quien escriba. Con numeros =
  // SOLO esos reciben respuesta; al resto se le registra el mensaje y se le
  // deja en el panel para que una persona contteste, pero el bot se calla.
  //
  // --------------------------------------------------------------------------
  // POR QUE HACE FALTA, Y POR QUE NO BASTABA LO QUE YA HABIA
  // --------------------------------------------------------------------------
  //
  // `filtro_de_numero` suena a esto y no lo es: compara el phone_number_id
  // NUESTRO, para que no entren eventos de otra app de Meta apuntando a este
  // webhook. No dice nada sobre QUE CLIENTE escribe.
  //
  // Asi que para probar el bot de punta a punta con un numero propio habia
  // que encender RESPUESTA_AUTOMATICA, y eso lo abre a cualquiera que
  // escriba: un anuncio activo, un cliente viejo, alguien que vio el numero.
  // Probar y abrir al publico eran la misma palanca.
  //
  // Ahora son dos. Y el orden importa: se prueba con la lista puesta, y
  // abrir al publico es BORRARLA, que es una decision aparte y explicita.
  //
  // Los numeros se normalizan a solo digitos porque WhatsApp los entrega sin
  // "+" ni espacios y es facil escribirlos de otra forma en Render.
  // --------------------------------------------------------------------------
  numerosDePrueba: texto("NUMEROS_DE_PRUEBA")
    .split(",")
    .map((n) => n.replace(/\D/g, ""))
    .filter(Boolean),

  // Escape explicito para pruebas controladas. Permite responder a clientes
  // sabiendo que el almacenamiento es efimero. Existe para que esa decision
  // sea un acto deliberado y no un descuido.
  permitirSinPersistencia: bandera("PERMITIR_SIN_PERSISTENCIA", false),

  // --- Metadatos del despliegue (los inyecta Render) ---
  commit: texto("RENDER_GIT_COMMIT"),
  rama: texto("RENDER_GIT_BRANCH"),
};

// Capacidades derivadas. Se exponen en /health para poder responder
// "¿por que no esta procesando mensajes?" sin entrar al servidor.
config.firmaActiva = Boolean(config.appSecret);
config.puedeEnviar = Boolean(config.whatsappToken && config.idNumero);

// Se COMPRUEBA si el almacenamiento sobrevive a un despliegue; no se deduce
// de que DATA_DIR este definida. Declarar DATA_DIR=/var/data no crea un
// disco: si no esta montado, es una carpeta corriente que se borra en cada
// despliegue, con un nombre que tranquiliza.
config.persistencia = require("./almacen/persistencia").revisar(config.dirDatos);

/**
 * Valida la configuracion. Devuelve { errores, avisos }.
 *   errores -> el proceso no debe arrancar.
 *   avisos  -> arranca, pero hay algo que el dueno tiene que saber.
 */
function revisar(c = config) {
  const errores = [];
  const avisos = [];

  if (!c.verifyToken) {
    errores.push(
      "Falta WHATSAPP_VERIFY_TOKEN. Sin el, Meta no puede verificar el webhook. Generalo con: openssl rand -hex 32"
    );
  } else if (c.verifyToken.length < 16) {
    errores.push(
      `WHATSAPP_VERIFY_TOKEN tiene ${c.verifyToken.length} caracteres. Usa 32 o mas: es lo unico que separa tu webhook del resto de internet durante el handshake.`
    );
  }

  if (c.panelToken && c.panelToken === c.verifyToken) {
    errores.push(
      "PANEL_TOKEN y WHATSAPP_VERIFY_TOKEN son iguales. Tienen privilegios distintos: el de verificacion lo conoce Meta, el del panel lee datos de clientes. Separalos."
    );
  }

  const aislamiento = require("./aislamiento");
  const contaminacion = aislamiento.revisarConfiguracion({
    WHATSAPP_VERIFY_TOKEN: c.verifyToken,
    META_APP_SECRET: c.appSecret,
    WHATSAPP_PHONE_NUMBER_ID: c.idNumero,
    WHATSAPP_WABA_ID: c.idWaba,
    OWNER_WHATSAPP: c.ownerWhatsapp,
    DATA_DIR: c.dirDatos,
    PANEL_TOKEN: c.panelToken,
  });
  errores.push(...contaminacion);

  if (!c.firmaActiva) {
    avisos.push(
      "META_APP_SECRET no esta configurado. Meta PODRA verificar el webhook, pero los eventos entrantes se registraran en el diario y se DESCARTARAN sin procesar, porque no se puede demostrar que vengan de Meta."
    );
  }
  if (!c.idNumero) {
    avisos.push(
      "WHATSAPP_PHONE_NUMBER_ID no esta configurado: el filtro que descarta eventos de otros numeros (BIKERPRO incluido) esta inactivo."
    );
  }
  // --- Persistencia ---
  //
  // La asimetria importa. Con almacenamiento efimero:
  //
  //   RECIBIR y VERIFICAR el webhook funciona perfectamente. El handshake de
  //   Meta no escribe nada, asi que la Fase 1 no necesita disco.
  //
  //   RESPONDER no es seguro. La deduplicacion vive en disco; si se borra en
  //   cada despliegue, el reintento de Meta -que puede llegar hasta 36 horas
  //   despues- se procesa como un mensaje nuevo. Hoy eso es responder dos
  //   veces; con pedidos, es un pedido que nadie hizo. Y un pedido inventado
  //   es peor que un paquete de mas: el dueno decide con esos numeros.
  //
  // Por eso efimero + responder es un ERROR de arranque, y efimero sin
  // responder es solo un aviso.
  const p = c.persistencia || { esDurable: true, modo: "desconocida", motivo: "" };

  if (!p.esDurable && c.respuestaAutomatica && !c.permitirSinPersistencia) {
    errores.push(
      `RESPUESTA_AUTOMATICA esta encendida pero el almacenamiento es efimero. ${p.motivo} ` +
        "Sin memoria que sobreviva al despliegue, un reintento de Meta se procesa dos veces. " +
        "Monta el disco, o pon PERMITIR_SIN_PERSISTENCIA=1 si es una prueba controlada y asumes el riesgo."
    );
  } else if (!p.esDurable) {
    avisos.push(
      `Almacenamiento EFIMERO. ${p.motivo} Verificar el webhook en Meta funciona igual (el handshake no escribe nada), ` +
        "pero el diario y la memoria de ids ya vistos se borran en cada despliegue."
    );
  }

  if (!p.esDurable && c.permitirSinPersistencia && c.respuestaAutomatica) {
    avisos.push(
      "PERMITIR_SIN_PERSISTENCIA=1 con almacenamiento efimero: se pueden duplicar respuestas y, mas adelante, pedidos. Solo para pruebas."
    );
  }
  if (!c.panelToken) {
    avisos.push("PANEL_TOKEN no esta configurado: las rutas de diagnostico quedan cerradas.");
  }
  if (c.logPii) {
    avisos.push("LOG_PII=1: los logs van a incluir telefonos y textos de clientes. Vuelvelo a 0 al terminar de depurar.");
  }
  if (c.respuestaAutomatica) {
    avisos.push("RESPUESTA_AUTOMATICA=1: NOVIKA va a escribirles a clientes reales.");
  }

  // --- Despacho ---
  //
  // Son AVISOS, nunca errores: el servicio tiene que arrancar sin esto. Pero
  // tienen que estar a la vista, porque la consecuencia de que falten no se
  // nota hasta el momento mas caro -el paquete ya salio, o ya tuvo una
  // novedad- y entonces el aviso al cliente queda bloqueado.
  const plantillasDeNovedad = {
    PLANTILLA_NOVEDAD_DIRECCION: c.plantillaNovedadDireccion,
    PLANTILLA_NOVEDAD_AUSENTE: c.plantillaNovedadAusente,
    PLANTILLA_NOVEDAD_OFICINA: c.plantillaNovedadOficina,
  };
  const faltan = Object.entries(plantillasDeNovedad)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (faltan.length) {
    avisos.push(
      `Faltan plantillas de novedad de entrega (${faltan.join(", ")}). Una novedad llega 1 a 3 dias ` +
        "despues del pedido, cuando la ventana de 24 h de Meta ya se cerro, y fuera de ella Meta SOLO " +
        "entrega plantillas aprobadas. Sin ellas, el panel marca esos avisos como bloqueados en vez de " +
        "intentarlos: hay que crearlas en Meta y esperar su aprobacion."
    );
  }
  if (!c.plantillaGuia) {
    avisos.push(
      "PLANTILLA_GUIA no esta configurada. La guia se despacha al dia siguiente de la compra, asi que " +
        "la ventana de 24 h del cliente casi siempre esta cerrada: sin esta plantilla solo se le podra " +
        "mandar la guia a quien haya escrito en las ultimas 24 horas."
    );
  }
  // `revisar` se llama tambien con configuraciones PARCIALES -las pruebas
  // pasan solo los campos que les interesan-, asi que ningun campo nuevo se
  // puede dar por presente. Leerlo a pelo tumbaba la validacion entera, que
  // es justo la que tiene que decir que falta.
  if (!(c.telefonosRemitente || []).length) {
    avisos.push(
      "TELEFONOS_REMITENTE esta vacia. Es el telefono propio IMPRESO en la etiqueta, y sirve para no " +
        "confundirlo con el del cliente al parear una guia: un telefono vale 50 puntos, la senal mas " +
        "fuerte del puntaje. Sin esto, el numero propio entra al pareo como si fuera de un destinatario."
    );
  }

  return { errores, avisos };
}

module.exports = { config, revisar };
