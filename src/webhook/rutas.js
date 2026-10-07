"use strict";

// ==========================================================================
// RUTAS DEL WEBHOOK
//
//   GET  /webhook  -> handshake de verificacion de Meta
//   POST /webhook  -> recepcion de eventos
//
// El orden del POST es lo importante de este archivo:
//
//   1. validar la firma
//   2. ESCRIBIR el evento crudo en el diario
//   3. contestar 200
//   4. procesar aparte
//
// BIKERPRO hace 3 -> 4 y no hace 1 ni 2. La consecuencia del 2 que falta:
// si el proceso muere entre el 200 y el final del procesamiento (por ejemplo
// un SIGTERM de despliegue, y hubo dias con ocho despliegues), el mensaje se
// perdio para siempre, porque Meta ya recibio su 200 y no reintenta. Desde
// fuera eso es indistinguible de "hoy no escribio nadie".
//
// Escribir antes de contestar cuesta un appendFileSync de unos cientos de
// bytes. El 200 sigue saliendo muy por debajo del limite de Meta.
// ==========================================================================

const crypto = require("node:crypto");
const { config } = require("../config");
const log = require("../log");
const diario = require("../almacen/diario");
const metricas = require("../metricas");
const { revisarFirma } = require("./firma");
const { admitir, procesarAdmitidos } = require("./procesar");

function montar(app) {
  // ------------------------------------------------------------------------
  // GET /webhook — verificacion
  //
  // Meta llama una sola vez, al pulsar "Verificar y guardar". Espera el
  // valor de hub.challenge tal cual, en texto plano, con 200.
  //
  // Esta ruta funciona aunque META_APP_SECRET no este configurado todavia:
  // la verificacion no debe quedar bloqueada por una variable que hace falta
  // mas adelante.
  // ------------------------------------------------------------------------
  app.get("/webhook", (req, res) => {
    const modo = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const reto = req.query["hub.challenge"];

    const esperado = config.verifyToken;
    const coincide =
      typeof token === "string" &&
      typeof esperado === "string" &&
      token.length === esperado.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(esperado));

    if (modo === "subscribe" && coincide) {
      metricas.incrementar("webhook_verificado");
      diario.anotar("webhook_verificado", { ip: req.ip });
      log.info("webhook_verificado", {});
      return res.status(200).type("text/plain").send(String(reto ?? ""));
    }

    // El motivo se anota pero NO se devuelve: a quien llama se le dice 403 y
    // nada mas. Decirle "el token no coincide" le confirma que acerto la URL.
    diario.anotar("webhook_verificacion_fallida", {
      ip: req.ip,
      modo: modo || null,
      motivo: !esperado ? "sin_verify_token_configurado" : modo !== "subscribe" ? "modo_incorrecto" : "token_no_coincide",
    });
    log.warn("webhook_verificacion_fallida", {
      modo: modo || null,
      hayTokenConfigurado: Boolean(esperado),
    });
    return res.sendStatus(403);
  });

  // ------------------------------------------------------------------------
  // POST /webhook — eventos
  // ------------------------------------------------------------------------
  app.post("/webhook", (req, res) => {
    const idEntrega = crypto.randomUUID();

    // 1. Firma
    const firma = revisarFirma(req.cuerpoCrudo, req.get("x-hub-signature-256"), config.appSecret);

    if (!firma.ok && firma.motivo === "sin_app_secret") {
      // Caso de montaje: Meta ya esta entregando pero falta la clave de la
      // app. No se puede demostrar que el evento venga de Meta, asi que no
      // se procesa. Se contesta 200 para que Meta no desactive la
      // suscripcion, y el evento queda en el diario: no se pierde, solo
      // queda sin procesar hasta que la variable este puesta.
      diario.anotar("rechazado_sin_app_secret", { idEntrega, cuerpo: req.body });
      log.error("rechazado_sin_app_secret", {
        idEntrega,
        detalle:
          "Llego un evento pero META_APP_SECRET no esta configurado. El evento quedo en el diario SIN PROCESAR. Configura la variable para empezar a atender clientes.",
      });
      return res.sendStatus(200);
    }

    if (!firma.ok) {
      // Firma presente y mala, o ausente habiendo clave: no es Meta.
      // Aqui si se contesta 403: no hay por que facilitarle el trabajo a
      // quien esta probando la URL.
      metricas.incrementar("firma_invalida");
      diario.anotar("firma_invalida", { idEntrega, motivo: firma.motivo, ip: req.ip });
      log.error("firma_invalida", { idEntrega, motivo: firma.motivo });
      return res.sendStatus(403);
    }

    // 2. Durabilidad antes del acuse: el evento crudo
    const anotado = diario.anotar("entrada_cruda", { idEntrega, cuerpo: req.body });

    // 3. Durabilidad antes del acuse: EL TRABAJO RECLAMADO
    //
    // Esto va aqui, y no dentro del procesamiento asincrono, por el
    // invariante que sostiene la recuperacion:
    //
    //   NUNCA CONTESTAR 200 SIN QUE EL TRABAJO ESTE RECLAMADO EN DISCO.
    //
    // Meta deja de reintentar en cuanto recibe el 200. Si el proceso muere
    // despues del acuse y no hay un registro de trabajo, nadie sabe que ese
    // mensaje quedo pendiente: no hay a quien preguntar. Se midio con
    // SIGKILL, y el mensaje se perdia en silencio.
    let admision;
    try {
      admision = admitir(req.body, idEntrega);
    } catch (e) {
      // Fallo al normalizar o reclamar. NO se contesta 200: es mejor que
      // Meta reintente que perder el mensaje.
      diario.anotar("fallo_al_admitir", { idEntrega, error: e.message, pila: e.stack });
      log.error("fallo_al_admitir", { idEntrega, detalle: e.message });
      return res.sendStatus(503);
    }

    if (!admision.durable) {
      // Habia mensajes y ninguno se pudo reclamar en disco. Sin registro
      // durable no hay recuperacion posible, asi que se devuelve 503 para
      // que Meta lo reintente -tiene 36 horas de margen- en vez de aceptar
      // un mensaje que podriamos perder.
      diario.anotar("admision_no_durable", { idEntrega, mensajes: admision.mensajes });
      log.error("admision_no_durable", {
        idEntrega,
        mensajes: admision.mensajes,
        detalle:
          "No se pudo reclamar el trabajo en disco. Se devuelve 503 para que Meta reintente en vez de perder el mensaje. Revisa el disco.",
      });
      return res.sendStatus(503);
    }

    // 4. Acuse a Meta. Desde aqui, todo lo admitido es recuperable.
    res.sendStatus(200);

    if (!anotado) {
      log.error("entrada_sin_diario", {
        idEntrega,
        detalle: "No se pudo escribir el evento crudo en el diario, pero el trabajo si quedo reclamado.",
      });
    }

    // 5. Procesamiento fuera del ciclo de respuesta
    procesarAdmitidos(admision.admitidos, idEntrega).catch((e) => {
      diario.anotar("fallo_global_al_procesar", { idEntrega, error: e.message, pila: e.stack });
      log.error("fallo_global_al_procesar", { idEntrega, detalle: e.message });
    });
  });
}

module.exports = { montar };
