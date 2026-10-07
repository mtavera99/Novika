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
  zonaHoraria: texto("ZONA_HORARIA", "America/Bogota"),
  ownerWhatsapp: texto("OWNER_WHATSAPP"),

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

  return { errores, avisos };
}

module.exports = { config, revisar };
