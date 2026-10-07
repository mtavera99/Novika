"use strict";

// ==========================================================================
// CONTADORES
//
// El objetivo que pidio Marco: saber que paso sin leer miles de logs.
//
// Dos reglas:
//
//   1. SOLO NUMEROS. Ningun contador guarda texto del cliente, telefono,
//      direccion ni documento. Un contador es "cuantas veces", nunca "a
//      quien". Asi se puede exponer la vista completa sin filtrar PII.
//
//   2. VOCABULARIO CERRADO. Los nombres estan declarados abajo. Incrementar
//      un nombre que no existe se registra como "desconocido" en vez de
//      crear una metrica silenciosa que nadie va a mirar.
//
// La distincion mas importante del tablero:
//
//      respuesta_preparada  !=  respuesta_enviada
//
// Mientras RESPUESTA_AUTOMATICA este en 0, la primera sube y la segunda
// tiene que quedarse en cero. Si alguna vez `respuesta_enviada` sube con el
// interruptor apagado, es un incidente, y hay una prueba que lo vigila.
// ==========================================================================

const NOMBRES = [
  // --- webhook (Fase 1) ---
  "webhook_recibido",
  "webhook_verificado",
  "firma_invalida",
  "numero_ajeno",
  "duplicado_descartado",
  "mensaje_valido",
  "evento_recuperado",
  "trabajo_agotado",
  "estado_recibido",
  "mensaje_no_entregado",

  // --- producto ---
  "producto_identificado",
  "producto_desconocido",
  "producto_ambiguo",
  "producto_cambiado",
  "falsa_senal_de_cambio",

  // --- intencion / IA ---
  "intencion_detectada",
  "ia_correcta",
  "ia_agotada",
  "ia_sin_proveedor",
  "ia_fallo_timeout",
  "ia_fallo_red",
  "ia_fallo_http",
  "ia_fallo_json",
  "ia_fallo_contrato",
  "ia_fallo_vacio",

  // --- cotizacion ---
  "cotizacion_correcta",
  "cotizacion_datos_faltantes",
  "cotizacion_escalada",
  "importe_no_autorizado_bloqueado",
  "claim_prohibido_bloqueado",

  // --- datos ---
  "dato_propuesto",
  "dato_confirmado",
  "dato_rechazado",

  // --- pedidos ---
  "pedido_confirmado",
  "pedido_en_revision",
  "pedido_duplicado_evitado",
  "pedido_modificado",
  "pedido_recotizado",
  "pedido_cancelado",

  // --- respuestas ---
  "respuesta_preparada",
  "respuesta_enviada",
  "respuesta_bloqueada_por_interruptor",
  "escalado_a_persona",

  // --- fallos ---
  "error_interno",
  "transicion_invalida",
  "desconocido",
];

const contadores = Object.create(null);
let desde = new Date().toISOString();

function incrementar(nombre, cuanto = 1) {
  const clave = NOMBRES.includes(nombre) ? nombre : "desconocido";
  contadores[clave] = (contadores[clave] || 0) + cuanto;
  if (clave === "desconocido" && nombre !== "desconocido") {
    contadores[`desconocido:${nombre}`] = (contadores[`desconocido:${nombre}`] || 0) + cuanto;
  }
  return contadores[clave];
}

function valor(nombre) {
  return contadores[nombre] || 0;
}

/** Vista completa. Solo numeros: se puede exponer sin filtrar nada. */
function instantanea() {
  return { desde, contadores: { ...contadores } };
}

/**
 * Lecturas derivadas: las preguntas que de verdad se hacen, ya respondidas.
 */
function salud() {
  const recibidos = valor("webhook_recibido");
  const validos = valor("mensaje_valido");
  return {
    mensajes_recibidos: recibidos,
    mensajes_procesados: validos,
    // Si esto no es 0 con el interruptor apagado, hay un incidente.
    respuestas_enviadas: valor("respuesta_enviada"),
    respuestas_preparadas: valor("respuesta_preparada"),
    // "Llego y fallamos" frente a "no llego": dos problemas distintos.
    rechazados_por_firma: valor("firma_invalida"),
    rechazados_por_numero: valor("numero_ajeno"),
    duplicados: valor("duplicado_descartado"),
    // Si esto no es 0, el proceso murio procesando y se recupero trabajo.
    eventos_recuperados: valor("evento_recuperado"),
    eventos_agotados: valor("trabajo_agotado"),
    productos_desconocidos: valor("producto_desconocido"),
    pedidos: valor("pedido_confirmado"),
    pedidos_duplicados_evitados: valor("pedido_duplicado_evitado"),
    ia_fallos:
      valor("ia_agotada") + valor("ia_fallo_contrato") + valor("ia_fallo_json") + valor("ia_fallo_timeout"),
    errores: valor("error_interno"),
  };
}

function _reiniciar() {
  for (const k of Object.keys(contadores)) delete contadores[k];
  desde = new Date().toISOString();
}

module.exports = { NOMBRES, incrementar, valor, instantanea, salud, _reiniciar };
