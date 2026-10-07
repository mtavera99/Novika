"use strict";

// ==========================================================================
// SERIALIZACION POR CLAVE
//
// Node es monohilo, y eso engaña: parece que no hacen falta cerrojos. Pero
// cada `await` es un punto donde otra tarea entra. El patron
//
//     const conv = await leer(id);     // <- aqui entra el segundo mensaje
//     conv.estado = "confirmado";
//     await guardar(id, conv);         // <- el segundo pisa al primero
//
// pierde escrituras en cuanto llegan dos eventos del mismo cliente casi a la
// vez. Y eso pasa de verdad: el cliente manda "si" y "listo" seguidos, o
// Meta entrega un lote con dos mensajes del mismo numero.
//
// La consecuencia en Fase 2 no es un estado raro: son dos pedidos.
//
// Este modulo serializa por clave -una cola por conversacion- de modo que
// leer, decidir y guardar sea indivisible para un mismo cliente. Dos
// clientes distintos siguen avanzando en paralelo.
//
// LIMITE QUE HAY QUE TENER PRESENTE: esto protege DENTRO de un proceso. Hoy
// basta porque el servicio corre con numInstances 1 (un disco de Render no
// admite mas). Cuando el estado se mueva a PostgreSQL, el candado definitivo
// seran las restricciones de unicidad y las transacciones de la base, y esta
// cola pasara a ser una optimizacion, no la garantia.
// ==========================================================================

/** @type {Map<string, Promise<any>>} */
const colas = new Map();

/** Metricas simples para ver si hay contencion real. */
const contadores = { entradas: 0, esperas: 0, maxCola: 0 };

/**
 * Ejecuta `tarea` en exclusiva para `clave`. Las llamadas con la misma clave
 * se encolan en orden de llegada; las de claves distintas no se estorban.
 *
 * @param {string} clave
 * @param {() => Promise<T>} tarea
 * @returns {Promise<T>}
 * @template T
 */
function enSerie(clave, tarea) {
  const k = String(clave ?? "sin-clave");
  contadores.entradas++;

  const previa = colas.get(k);
  if (previa) {
    contadores.esperas++;
  }

  // La cadena se construye sobre la promesa anterior pase lo que pase con
  // ella: si una tarea falla, la siguiente tiene que ejecutarse igual. Un
  // error no puede dejar la conversacion bloqueada para siempre.
  const anterior = previa || Promise.resolve();
  const ejecucion = anterior.then(
    () => tarea(),
    () => tarea()
  );

  // En la cola se guarda una version que nunca rechaza, para que el eslabon
  // siguiente no herede un rechazo no capturado.
  const eslabon = ejecucion.then(
    () => undefined,
    () => undefined
  );
  colas.set(k, eslabon);

  // Limpieza: si nadie mas se encolo detras, se borra la entrada para que el
  // Map no crezca con una clave por cliente historico.
  eslabon.then(() => {
    if (colas.get(k) === eslabon) colas.delete(k);
    contadores.maxCola = Math.max(contadores.maxCola, colas.size);
  });

  return ejecucion;
}

/** ¿Cuantas claves tienen trabajo en curso? */
function enCurso() {
  return colas.size;
}

function estadisticas() {
  return { ...contadores, enCurso: colas.size };
}

/** Solo para pruebas. */
function _reiniciar() {
  colas.clear();
  contadores.entradas = 0;
  contadores.esperas = 0;
  contadores.maxCola = 0;
}

module.exports = { enSerie, enCurso, estadisticas, _reiniciar };
