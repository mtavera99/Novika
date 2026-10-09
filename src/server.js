"use strict";

// ==========================================================================
// ARRANQUE
//
// Este archivo hace tres cosas y ninguna mas: validar la configuracion,
// levantar el puerto y apagarse con orden.
//
// La validacion va ANTES de escuchar. Si falta un secreto, el proceso no
// arranca y lo dice en una linea legible. La alternativa -arrancar y fallar
// en el primer mensaje de un cliente real- es la que sale caro.
// ==========================================================================

const { config, revisar } = require("./config");
const log = require("./log");
const diario = require("./almacen/diario");
const { crearApp } = require("./app");
const { recuperarPendientes } = require("./webhook/recuperar");
const metricas = require("./metricas");
const { arrancarBarrido } = require("./cerebro/recordar");
const { obtenerPiezas } = require("./cerebro/index");

function arrancar() {
  const { errores, avisos } = revisar();

  if (errores.length) {
    console.error("");
    console.error("NOVIKA no puede arrancar. Hay que corregir esto primero:");
    console.error("");
    for (const e of errores) console.error(`  [X] ${e}`);
    console.error("");
    console.error("Las variables se configuran en el panel del hosting (Render -> Environment)");
    console.error("o en un archivo .env local. La plantilla esta en .env.example.");
    console.error("");
    process.exit(1);
  }

  for (const a of avisos) log.warn("aviso_de_configuracion", { detalle: a });

  const app = crearApp();

  const servidor = app.listen(config.puerto, () => {
    log.info("arrancado", {
      puerto: config.puerto,
      commit: config.commit ? config.commit.slice(0, 7) : null,
      firma_activa: config.firmaActiva,
      puede_enviar: config.puedeEnviar,
      respuesta_automatica: config.respuestaAutomatica,
      filtro_de_numero: config.idNumero ? "activo" : "inactivo",
      dir_datos: config.dirDatos,
      persistencia: config.persistencia.modo,
    });
    diario.anotar("arranque", {
      commit: config.commit || null,
      firma_activa: config.firmaActiva,
      respuesta_automatica: config.respuestaAutomatica,
      persistencia: config.persistencia.modo,
    });

    // RECUPERACION DE TRABAJO PENDIENTE.
    //
    // Va DESPUES de escuchar, no antes: el servicio tiene que poder
    // responder al health check y aceptar mensajes nuevos mientras recupera
    // los viejos. Hacerlo antes de listen retrasaria el arranque y Render
    // podria darlo por caido.
    //
    // Y no se espera (`.catch` en vez de `await`): un problema recuperando
    // mensajes viejos no puede impedir atender los nuevos.
    recuperarPendientes().catch((e) => {
      log.error("recuperacion_no_arranco", { detalle: e.message });
      diario.anotar("recuperacion_no_arranco", { error: e.message });
    });

    // ------------------------------------------------------------------
    // BARRIDO DE RECORDATORIOS
    //
    // Va aqui -despues de `listen`, igual que la recuperacion- y NO se
    // espera: si el barrido no arranca, el bot tiene que seguir atendiendo.
    //
    // Apagado por defecto (`RECORDATORIOS`), asi que en un despliegue
    // normal esto solo escribe una linea en el log y se va. Lo enciende
    // Marco en Render cuando quiera, porque manda mensajes que nadie pidio
    // a clientes reales.
    //
    // `arrancarBarrido` usa `setInterval` con `unref()`: no retrasa el
    // apagado cuando Render manda SIGTERM en cada despliegue.
    // ------------------------------------------------------------------
    try {
      arrancarBarrido({ config, obtenerPiezas, log, metricas, diario });
    } catch (e) {
      log.error("recordatorios_no_arrancaron", { detalle: e.message });
      diario.anotar("recordatorios_no_arrancaron", { error: e.message });
    }
  });

  // Apagado ordenado. En Render cada despliegue manda SIGTERM; dejar de
  // aceptar conexiones nuevas y terminar las en curso evita cortar una
  // peticion a medias.
  const apagar = (señal) => {
    log.warn("apagando", { señal });
    diario.anotar("apagado", { señal });
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", () => apagar("SIGTERM"));
  process.on("SIGINT", () => apagar("SIGINT"));

  // Un fallo no capturado no puede morir en silencio: queda en el diario
  // antes de que el proceso desaparezca.
  process.on("unhandledRejection", (razon) => {
    diario.anotar("promesa_sin_capturar", { error: String(razon && razon.message ? razon.message : razon) });
    log.error("promesa_sin_capturar", { detalle: String(razon) });
  });
  process.on("uncaughtException", (e) => {
    diario.anotar("excepcion_sin_capturar", { error: e.message, pila: e.stack });
    log.error("excepcion_sin_capturar", { detalle: e.message });
    process.exit(1);
  });

  return servidor;
}

if (require.main === module) arrancar();

module.exports = { arrancar };
