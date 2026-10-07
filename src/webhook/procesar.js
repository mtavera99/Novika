"use strict";

// ==========================================================================
// PROCESAR EVENTOS
//
// Orden de las compuertas. El orden no es estetico: cada paso existe para
// que el siguiente no tenga que desconfiar.
//
//   1. AISLAMIENTO  - ¿es un evento del numero de NOVIKA?
//   2. CLASE        - ¿es un mensaje de un cliente o un acuse de entrega?
//   3. DEDUPLICACION- ¿ya habiamos visto este wamid?
//   4. MANEJO       - aqui entrara la conversacion (fase 2)
//
// La deduplicacion va DESPUES del aislamiento (no gastamos el id de un
// evento ajeno) y ANTES del manejo (ningun efecto se produce dos veces).
//
// Todo lo que se decide queda en el diario. Si manana la pregunta es "¿por
// que este cliente no recibio respuesta?", la respuesta tiene que estar en
// disco, no en la memoria de un proceso que ya se reinicio.
// ==========================================================================

const { config } = require("../config");
const log = require("../log");
const diario = require("../almacen/diario");
const vistos = require("../almacen/vistos");
const aislamiento = require("../aislamiento");
const metricas = require("../metricas");
const { obtenerCerebro } = require("../cerebro");
const { normalizar, CLASES } = require("./normalizar");

/**
 * Un acuse de entrega de Meta. No hay nada que contestar; se registra.
 * Un `failed` aqui es la unica forma de saber que Meta acepto un mensaje
 * con 200 y despues no lo entrego.
 */
function manejarEstado(evento) {
  diario.anotar("estado", {
    wamid: evento.wamid,
    estado: evento.estado,
    para: evento.para,
    errores: evento.errores,
    categoriaPrecio: evento.categoriaPrecio,
  });

  if (evento.estado === "failed") {
    metricas.incrementar("mensaje_no_entregado");
    log.error("mensaje_no_entregado", {
      wamid: evento.wamid,
      para: evento.para,
      errores: evento.errores,
    });
  }
}

/**
 * Mensaje de un cliente.
 *
 * FASE 1: se registra y se deja ahi. Todavia no hay catalogo con productos
 * reales, ni precios aprobados, ni guion comercial, asi que cualquier
 * respuesta automatica seria informacion inventada. El interruptor
 * RESPUESTA_AUTOMATICA existe para que el dia que haya guion se encienda sin
 * desplegar codigo nuevo.
 *
 * FASE 2 (aqui, en este orden):
 *   identificar producto (determinista, desde el catalogo y el referral)
 *   -> conversacion con IA acotada a datos autorizados
 *   -> deteccion de intencion de compra
 *   -> captura y validacion de datos del cliente
 *   -> resumen
 *   -> confirmacion inequivoca (en codigo, no en el prompt)
 *   -> guardar pedido
 */
async function manejarMensaje(evento) {
  diario.anotar("mensaje", {
    wamid: evento.wamid,
    idCliente: evento.idCliente,
    telefono: evento.telefono,
    bsuid: evento.bsuid,
    nombre: evento.nombre,
    tipoMensaje: evento.tipo,
    origenTexto: evento.origenTexto,
    // El texto se guarda completo en el diario: es la trazabilidad de la
    // conversacion y la base de cualquier auditoria posterior. El diario
    // vive en el disco privado del servicio, no en los logs del hosting.
    texto: evento.texto,
    idOpcion: evento.idOpcion || null,
    referral: evento.referral,
    contexto: evento.contexto,
    media: evento.media || null,
    ubicacion: evento.ubicacion || null,
  });

  log.info("mensaje_recibido", {
    wamid: evento.wamid,
    idCliente: evento.idCliente,
    tipoMensaje: evento.tipo,
    origenTexto: evento.origenTexto,
    texto: evento.texto,
    conReferral: Boolean(evento.referral),
  });

  // --------------------------------------------------------------------
  // MODO SOMBRA
  //
  // El mensaje real se procesa de principio a fin -producto, intencion,
  // datos, cotizacion, confirmacion, pedido- y la respuesta se PREPARA y se
  // guarda, pero no sale. Permite auditar conversaciones reales antes de
  // soltar el bot.
  //
  // El envio no se decide aqui: lo decide src/whatsapp/enviar.js, que es el
  // unico camino al exterior y empieza comprobando el interruptor. Si esta
  // comprobacion viviera aqui, cada flujo nuevo tendria que acordarse de
  // repetirla.
  // --------------------------------------------------------------------
  if (!config.modoSombra && !config.respuestaAutomatica) {
    diario.anotar("sin_responder", { wamid: evento.wamid, motivo: "modo_sombra_apagado" });
    return { accion: "registrado", respondido: false };
  }

  try {
    const cerebro = await obtenerCerebro();
    const traza = await cerebro.procesar(evento);

    if (!config.respuestaAutomatica) {
      diario.anotar("sin_responder", {
        wamid: evento.wamid,
        motivo: "respuesta_automatica_apagada",
        // Queda constancia de que SI se preparo una respuesta: es la
        // diferencia entre "el bot no supo que decir" y "el bot sabia y
        // callamos a proposito".
        respuestaPreparada: true,
        situacion: traza.respuesta && traza.respuesta.situacion,
      });
    }

    return {
      accion: "procesado",
      respondido: traza.enviada === true,
      estado: traza.estadoNuevo,
      situacion: traza.respuesta && traza.respuesta.situacion,
      pedido: traza.pedido,
    };
  } catch (e) {
    // El mensaje NO se pierde: ya esta en el diario, y el fallo tambien. Un
    // error del cerebro no puede dejar al cliente sin rastro.
    diario.anotar("fallo_del_cerebro", { wamid: evento.wamid, error: e.message, pila: e.stack });
    log.error("fallo_del_cerebro", { wamid: evento.wamid, detalle: e.message });
    metricas.incrementar("error_interno");
    return { accion: "registrado", respondido: false, fallo: true };
  }
}

/**
 * Punto de entrada. Se llama DESPUES de haber contestado 200 a Meta y
 * DESPUES de que el evento crudo ya este en el diario.
 *
 * Nunca lanza: un evento que falla no puede arrastrar a los demas del mismo
 * lote. Y un fallo no se traga en silencio, se anota en el diario, que es lo
 * que BIKERPRO no hace (`.catch(e => console.error(...))` y el trabajo se pierde).
 */
async function procesar(cuerpo, idEntrega = null) {
  metricas.incrementar("webhook_recibido");
  const eventos = normalizar(cuerpo);
  const resultados = [];

  for (const evento of eventos) {
    try {
      // 1. Aislamiento
      const propio = aislamiento.eventoEsDeNovika(evento, config.idNumero);
      if (!propio.ok) {
        diario.anotar("evento_ajeno", {
          idEntrega,
          idNumeroDelEvento: evento.idNumero,
          idNumeroDeNovika: config.idNumero,
          wamid: evento.wamid,
        });
        metricas.incrementar("numero_ajeno");
        log.error("evento_de_otro_numero", {
          detalle:
            "Llego un evento de un phone_number_id que no es el de NOVIKA. Revisa que no haya dos apps de Meta apuntando a este webhook.",
          idNumeroDelEvento: evento.idNumero,
        });
        resultados.push({ wamid: evento.wamid, accion: "descartado_ajeno" });
        continue;
      }

      // 2. Clase
      if (evento.clase === CLASES.ESTADO) {
        metricas.incrementar("estado_recibido");
        manejarEstado(evento);
        resultados.push({ wamid: evento.wamid, accion: "estado" });
        continue;
      }

      if (evento.clase === CLASES.DESCONOCIDO) {
        diario.anotar("evento_desconocido", { idEntrega, claves: evento.claves, campo: evento.campo });
        resultados.push({ accion: "desconocido" });
        continue;
      }

      // 3. Deduplicacion
      if (!vistos.esNuevo(evento.wamid)) {
        metricas.incrementar("duplicado_descartado");
        diario.anotar("duplicado_descartado", { idEntrega, wamid: evento.wamid });
        log.warn("duplicado_descartado", { wamid: evento.wamid });
        resultados.push({ wamid: evento.wamid, accion: "duplicado" });
        continue;
      }

      // 4. Manejo
      metricas.incrementar("mensaje_valido");
      const r = await manejarMensaje(evento);
      resultados.push({ wamid: evento.wamid, ...r });
    } catch (e) {
      metricas.incrementar("error_interno");
      diario.anotar("fallo_al_procesar", {
        idEntrega,
        wamid: evento.wamid,
        error: e.message,
        pila: e.stack,
      });
      log.error("fallo_al_procesar", { wamid: evento.wamid, detalle: e.message });
      resultados.push({ wamid: evento.wamid, accion: "fallo" });
    }
  }

  return resultados;
}

module.exports = { procesar, manejarMensaje, manejarEstado };
