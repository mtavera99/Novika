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
      disco_propio: config.discoPropio,
    });
    diario.anotar("arranque", {
      commit: config.commit || null,
      firma_activa: config.firmaActiva,
      respuesta_automatica: config.respuestaAutomatica,
    });
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
