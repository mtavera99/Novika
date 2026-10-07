"use strict";

// ==========================================================================
// PROVEEDOR FALSO
//
// Doble de pruebas. Devuelve lo que se le diga, en el orden que se le diga.
//
// Existe para que toda la bateria de Fase 2 pueda probar el camino completo
// -incluidos los fallos del modelo- sin red, sin claves y sin gastar un
// centimo. Que probar "la IA devolvio JSON roto" sea facil es lo que hace
// que ese caso este probado.
// ==========================================================================

/**
 * @param {Array<object|Function>} respuestas  cola de respuestas.
 *   Cada elemento puede ser:
 *     {texto: "..."}                     respuesta cruda del modelo
 *     {ok: false, estado: 500}           error HTTP
 *     {lanzar: "mensaje"}                excepcion
 *     {lanzar: "...", nombre:"AbortError"} timeout
 *     {demoraMs: 50, texto: "..."}       respuesta lenta
 *     function(entrada)                  calculada
 */
function crearProveedorFalso(respuestas = []) {
  const cola = [...respuestas];
  const llamadas = [];

  async function completar(entrada) {
    llamadas.push({
      sistema: entrada.sistema,
      usuario: entrada.usuario,
      timeoutMs: entrada.timeoutMs,
      cuando: Date.now(),
    });

    if (!cola.length) {
      return { ok: false, estado: 0, texto: "" };
    }

    let siguiente = cola.shift();
    if (typeof siguiente === "function") siguiente = siguiente(entrada);

    if (siguiente && siguiente.demoraMs) {
      await new Promise((r) => setTimeout(r, siguiente.demoraMs));
    }

    if (siguiente && siguiente.lanzar) {
      const e = new Error(siguiente.lanzar);
      if (siguiente.nombre) e.name = siguiente.nombre;
      throw e;
    }

    if (siguiente && siguiente.ok === false) {
      return { ok: false, estado: siguiente.estado || 500, texto: siguiente.texto || "" };
    }

    return { ok: true, estado: 200, texto: (siguiente && siguiente.texto) || "" };
  }

  return {
    completar,
    llamadas,
    pendientes: () => cola.length,
    /** Util para afirmar que el prompt NO llevaba algo que no debia. */
    ultimoPrompt: () => llamadas[llamadas.length - 1] || null,
  };
}

/** Respuesta valida minima, para los caminos felices. */
function analisisValido({ intencion = "pregunta_producto", candidatos = {}, borrador = null, productoSugerido = null } = {}) {
  return {
    texto: JSON.stringify({
      intencion,
      candidatos,
      productoSugerido,
      borradorRespuesta: borrador,
      preguntasDelCliente: [],
    }),
  };
}

module.exports = { crearProveedorFalso, analisisValido };
