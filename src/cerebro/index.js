"use strict";

// ==========================================================================
// CABLEADO DEL CEREBRO
//
// Construye las dependencias una sola vez y las comparte. Separado de
// orquestar.js a proposito: ese modulo recibe todo por parametro y por eso
// se puede probar con dobles; este es el unico que sabe de config, de disco
// y de claves.
//
// Si algo del cableado falla -por ejemplo, el disco no esta disponible-, NO
// se lanza hacia arriba. El webhook ya guardo el evento crudo antes de
// contestar 200; hundir el procesamiento solo añadiria un mensaje perdido a
// un problema que ya existe. Se registra y el turno se marca como no
// procesado.
// ==========================================================================

const { config } = require("../config");
const log = require("../log");
const diario = require("../almacen/diario");
const metricas = require("../metricas");
const { crearRepos } = require("../almacen/repos");
const { cargarCatalogo } = require("../catalogo");
const { crearCliente } = require("../ia/cliente");
const { crearEmisor } = require("../whatsapp/enviar");
const { crearCerebro } = require("./orquestar");

let promesa = null;

/** Proveedor de IA segun la configuracion. Sin clave, no hay IA. */
function construirProveedor() {
  if (!config.iaApiKey) return null;
  try {
    const { crearProveedorOpenAI } = require("../ia/proveedores/openai");
    return crearProveedorOpenAI({
      apiKey: config.iaApiKey,
      baseUrl: config.iaBaseUrl,
      modelo: config.iaModelo,
    });
  } catch (e) {
    log.error("ia_proveedor_no_construido", { detalle: e.message });
    return null;
  }
}

async function obtenerCerebro() {
  if (promesa) return promesa;

  promesa = (async () => {
    const repos = await crearRepos({
      dirDatos: config.dirDatos,
      databaseUrl: config.databaseUrl,
    });

    const catalogo = cargarCatalogo();
    if (catalogo.problemas.length) {
      // Un catalogo con problemas no impide atender: los productos validos
      // entran y los rotos quedan fuera. Pero tiene que gritarlo.
      log.error("catalogo_con_problemas", { cuantos: catalogo.problemas.length, problemas: catalogo.problemas });
    }

    const ia = crearCliente({
      proveedor: construirProveedor(),
      timeoutMs: config.iaTimeoutMs,
      log,
      metricas,
    });

    const emisor = crearEmisor({ config, log, metricas });

    log.info("cerebro_listo", {
      almacen: repos.tipo,
      productosActivos: catalogo.activos.length,
      ia: ia.disponible,
      modoSombra: config.modoSombra,
      respuestaAutomatica: config.respuestaAutomatica,
    });

    return crearCerebro({ config, repos, catalogo, ia, emisor, log, metricas, diario });
  })().catch((e) => {
    log.error("cerebro_no_se_pudo_construir", { detalle: e.message });
    diario.anotar("cerebro_no_se_pudo_construir", { error: e.message });
    // Se limpia para que el intento siguiente pueda volver a probar: un
    // fallo transitorio del disco no puede dejar el bot inutil hasta el
    // proximo despliegue.
    promesa = null;
    throw e;
  });

  return promesa;
}

/** Solo para pruebas. */
function _reiniciar() {
  promesa = null;
}

module.exports = { obtenerCerebro, _reiniciar };
