"use strict";

// ==========================================================================
// RECUPERACION DE TRABAJO PENDIENTE
//
// Se ejecuta al arrancar. Busca eventos que quedaron a medias y los
// reprocesa, sin depender de que Meta reenvie nada.
//
// --------------------------------------------------------------------------
// POR QUE HACE FALTA
// --------------------------------------------------------------------------
//
// El webhook contesta 200 a Meta ANTES de terminar de procesar, porque Meta
// exige una respuesta rapida. En cuanto Meta tiene ese 200, deja de
// reintentar.
//
// Asi que si el proceso muere entre el 200 y el final del procesamiento, no
// hay nadie que vuelva a traer ese mensaje. Y morir ahi no es exotico: un
// disco persistente en Render DESACTIVA los despliegues sin interrupcion, de
// modo que cada deploy mata el proceso. Hubo dias con ocho despliegues.
//
// Esto se midio con SIGKILL: el evento quedaba en el diario y SIN PROCESAR
// para siempre, y como el wamid ya figuraba como "visto", una retransmision
// hipotetica tambien se descartaba. El mensaje de un cliente desaparecia sin
// un solo error.
//
// --------------------------------------------------------------------------
// POR QUE ES SEGURO
// --------------------------------------------------------------------------
//
//   - Reprocesar pasa por atenderEvento(), el MISMO camino que un evento
//     recien llegado. Un camino aparte divergiria.
//   - Un pedido no se puede duplicar: claveDeEvento se deriva del wamid, asi
//     que el replay produce la misma clave y crearSiNoExiste lo rechaza.
//   - No se puede enviar nada: los envios salen por src/whatsapp/enviar.js,
//     que comprueba RESPUESTA_AUTOMATICA. La recuperacion hereda ese candado
//     sin tener que acordarse de nada.
//   - Hay tope de intentos: un mensaje que rompe el cerebro de forma
//     determinista no puede reintentarse en cada arranque para siempre.
// ==========================================================================

const { config } = require("../config");
const log = require("../log");
const diario = require("../almacen/diario");
const metricas = require("../metricas");
const trabajo = require("../almacen/trabajo");
const congelacion = require("../almacen/congelar");

/**
 * Reprocesa el trabajo interrumpido.
 *
 * NUNCA LANZA. Un fallo de la recuperacion no puede impedir que el servicio
 * atienda los mensajes nuevos: eso convertiria un problema con mensajes
 * viejos en una caida completa.
 *
 * @param {object} opciones
 * @param {Function} [opciones.atender]  inyectable para pruebas
 * @returns {Promise<{revisados: number, recuperados: number, fallidos: number, agotados: number}>}
 */
async function recuperarPendientes({ atender = null } = {}) {
  const resumen = { revisados: 0, recuperados: 0, fallidos: 0, agotados: 0, diferidos: 0 };

  // --------------------------------------------------------------------
  // CONGELADO: no se recupera nada.
  //
  // Durante un cutover el origen tiene que estar quieto. Si la recuperacion
  // procesara los pendientes, escribiria en el almacen que se esta copiando
  // -y un disco persistente en Render convierte cada despliegue en un
  // reinicio, asi que esto no es hipotetico.
  //
  // Se sale ANTES de reclamar nada: reclamar consume un intento, y tres
  // reinicios durante un cutover agotarian el mensaje sin haberlo intentado
  // ni una vez. atenderEvento() tiene la misma compuerta, que es la
  // autoritativa; esta de aqui existe para no reclamar, para no registrar
  // "el proceso anterior murio procesando" cuando no es verdad, y para que
  // el log diga lo que de verdad esta pasando.
  // --------------------------------------------------------------------
  const { congelado, desde, horas } = congelacion.estado(config.dirDatos);
  if (congelado) {
    let cuantos = 0;
    try {
      cuantos = trabajo.paraRecuperar().length;
    } catch {
      /* si no se puede leer, se informa 0: no es el trabajo de esta rama */
    }
    resumen.diferidos = cuantos;
    log.warn("recuperacion_congelada", {
      cuantos,
      desde,
      horas,
      detalle:
        cuantos > 0
          ? `${cuantos} evento(s) esperan a que se descongele. Siguen reclamados en disco y NO han gastado intentos. Ejecuta \`npm run descongelar\` y reinicia.`
          : "Escrituras congeladas. No hay pendientes.",
    });
    diario.anotar("recuperacion_congelada", { cuantos, desde, horas });
    return resumen;
  }

  let pendientes;
  try {
    pendientes = trabajo.paraRecuperar();
  } catch (e) {
    log.error("recuperacion_no_pudo_leer", { detalle: e.message });
    return resumen;
  }

  const sinSalida = trabajo.agotados();
  resumen.agotados = sinSalida.length;

  if (sinSalida.length) {
    // Un evento agotado es una venta potencialmente perdida que NADIE va a
    // volver a mirar si esto no grita.
    log.error("trabajo_agotado", {
      cuantos: sinSalida.length,
      detalle: `${sinSalida.length} evento(s) fallaron ${trabajo.MAX_INTENTOS} veces y ya no se reintentan. Hay que revisarlos a mano en /eventos.`,
      wamids: sinSalida.map((r) => r.wamid),
    });
    diario.anotar("trabajo_agotado", { cuantos: sinSalida.length, wamids: sinSalida.map((r) => r.wamid) });
  }

  if (!pendientes.length) {
    log.info("recuperacion_sin_pendientes", {});
    return resumen;
  }

  // Que haya pendientes al arrancar significa que el proceso anterior murio
  // procesando. Se registra a nivel de error a proposito: es un sintoma, y
  // si pasa a menudo hay algo que investigar.
  log.error("recuperacion_con_pendientes", {
    cuantos: pendientes.length,
    detalle: "El proceso anterior murio procesando estos eventos. Se reprocesan ahora.",
    wamids: pendientes.map((r) => r.wamid),
  });
  diario.anotar("recuperacion_iniciada", { cuantos: pendientes.length, wamids: pendientes.map((r) => r.wamid) });

  // Carga diferida: evita un ciclo de requires entre procesar y recuperar.
  const atenderEvento = atender || require("./procesar").atenderEvento;

  for (const registro of pendientes) {
    resumen.revisados++;
    try {
      const r = await atenderEvento(registro.evento, { enRecuperacion: true, idEntrega: "recuperacion" });
      if (r && r.accion === "fallo") {
        resumen.fallidos++;
      } else if (r && r.accion === "diferido") {
        // Alguien congelo a mitad de la recuperacion. Sigue pendiente: no
        // es un exito, y contarlo como tal diria que el trabajo se hizo.
        resumen.diferidos++;
      } else if (r && r.accion === "duplicado") {
        // Se termino entre medias, o se agotaron los intentos.
        if (r.motivo === "agotado") resumen.agotados++;
      } else {
        resumen.recuperados++;
        // El contador lo incrementa atenderEvento, que es donde el evento se
        // procesa de verdad. Hacerlo tambien aqui lo contaba dos veces.
      }
      diario.anotar("evento_recuperado", {
        wamid: registro.wamid,
        intentos: registro.intentos,
        accion: r && r.accion,
        motivo: r && r.motivo,
      });
    } catch (e) {
      // atenderEvento ya captura lo suyo; esto es el cinturon de seguridad.
      resumen.fallidos++;
      log.error("recuperacion_fallo", { wamid: registro.wamid, detalle: e.message });
      diario.anotar("recuperacion_fallo", { wamid: registro.wamid, error: e.message });
    }
  }

  log.info("recuperacion_terminada", resumen);
  diario.anotar("recuperacion_terminada", resumen);
  return resumen;
}

module.exports = { recuperarPendientes };
