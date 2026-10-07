"use strict";

// ==========================================================================
// CLIENTE DE IA
//
// Una sola puerta hacia el modelo. El resto del sistema llama a analizar() y
// no sabe si detras hay OpenAI, otro proveedor o un doble de pruebas.
//
// Lo que garantiza esta capa, y por que:
//
//   NUNCA LANZA. Un fallo del modelo no puede tumbar el procesamiento del
//   mensaje de un cliente. Devuelve un analisis de respaldo y el mensaje
//   sigue su camino hacia una persona.
//
//   NUNCA DEVUELVE UN HECHO SIN VALIDAR. Todo pasa por el contrato. Si no
//   cumple, se descarta completo y se registra el motivo.
//
//   TIMEOUT SIEMPRE. Sin timeout, una llamada colgada deja al cliente sin
//   respuesta indefinidamente, que es la peor version de "no perder ventas".
//
//   NO REGISTRA EL TEXTO DEL CLIENTE NI LA CLAVE. Los errores se registran
//   con longitudes y codigos, no con contenido.
//
// Nota sobre reintentos: solo se reintenta lo que puede salir distinto la
// segunda vez (red, 429, 5xx, JSON ilegible). Un 401 o un 400 se reintentan
// igual de mal, asi que no se reintentan.
// ==========================================================================

const { validarAnalisis, analisisDeRespaldo } = require("./contrato");

const MOTIVOS = {
  SIN_PROVEEDOR: "sin_proveedor",
  TIMEOUT: "timeout",
  RED: "red",
  HTTP: "http",
  JSON_INVALIDO: "json_invalido",
  CONTRATO: "contrato_incumplido",
  VACIO: "respuesta_vacia",
};

/** Codigos HTTP que pueden salir distinto en el siguiente intento. */
const HTTP_REINTENTABLES = new Set([408, 425, 429, 500, 502, 503, 504]);

const ESPERAS_MS = [400, 1200];

/**
 * @param {object} opciones
 * @param {object} opciones.proveedor  objeto con completar({sistema, usuario, timeoutMs})
 * @param {number} [opciones.intentos]
 * @param {number} [opciones.timeoutMs]
 * @param {object} [opciones.log]
 * @param {object} [opciones.metricas]
 */
function crearCliente({ proveedor = null, intentos = 2, timeoutMs = 12000, log = null, metricas = null } = {}) {
  function contar(nombre) {
    if (metricas && typeof metricas.incrementar === "function") metricas.incrementar(nombre);
  }
  function registrar(nivel, evento, datos) {
    if (log && typeof log[nivel] === "function") log[nivel](evento, datos);
  }

  /**
   * @returns {Promise<{ok: boolean, analisis: object, motivo?: string, intentos: number}>}
   */
  async function analizar({ sistema, usuario }) {
    if (!proveedor || typeof proveedor.completar !== "function") {
      contar("ia_sin_proveedor");
      return {
        ok: false,
        motivo: MOTIVOS.SIN_PROVEEDOR,
        analisis: analisisDeRespaldo(MOTIVOS.SIN_PROVEEDOR),
        intentos: 0,
      };
    }

    let ultimoMotivo = null;
    let ultimoDetalle = null;

    for (let intento = 1; intento <= Math.max(1, intentos); intento++) {
      const inicio = Date.now();
      let respuesta;

      try {
        respuesta = await proveedor.completar({ sistema, usuario, timeoutMs });
      } catch (e) {
        // Incluye el AbortError del timeout. Se trata como red: puede salir
        // distinto al reintentar.
        ultimoMotivo = e && e.name === "AbortError" ? MOTIVOS.TIMEOUT : MOTIVOS.RED;
        ultimoDetalle = e && e.message ? String(e.message).slice(0, 200) : "sin detalle";
        contar(`ia_fallo_${ultimoMotivo}`);
        registrar("warn", "ia_intento_fallido", { intento, motivo: ultimoMotivo, ms: Date.now() - inicio });
        if (await esperarSiQueda(intento)) continue;
        break;
      }

      // --- Error HTTP ---
      if (respuesta && respuesta.ok === false) {
        const codigo = Number(respuesta.estado) || 0;
        ultimoMotivo = MOTIVOS.HTTP;
        ultimoDetalle = `estado ${codigo}`;
        contar("ia_fallo_http");
        // El cuerpo del error NO se registra: puede traer de vuelta el
        // prompt completo, y con el el mensaje del cliente.
        registrar("warn", "ia_http_no_ok", { intento, estado: codigo, ms: Date.now() - inicio });

        if (HTTP_REINTENTABLES.has(codigo) && (await esperarSiQueda(intento))) continue;
        break;
      }

      const texto = respuesta && typeof respuesta.texto === "string" ? respuesta.texto.trim() : "";
      if (!texto) {
        ultimoMotivo = MOTIVOS.VACIO;
        contar("ia_fallo_vacio");
        registrar("warn", "ia_respuesta_vacia", { intento, ms: Date.now() - inicio });
        if (await esperarSiQueda(intento)) continue;
        break;
      }

      // --- JSON ---
      let crudo;
      try {
        crudo = JSON.parse(extraerJson(texto));
      } catch (e) {
        ultimoMotivo = MOTIVOS.JSON_INVALIDO;
        ultimoDetalle = `${texto.length} caracteres ilegibles`;
        contar("ia_fallo_json");
        // Solo la longitud. El texto puede contener datos del cliente.
        registrar("warn", "ia_json_invalido", { intento, longitud: texto.length, ms: Date.now() - inicio });
        if (await esperarSiQueda(intento)) continue;
        break;
      }

      // --- Contrato ---
      const validado = validarAnalisis(crudo);
      if (!validado.ok) {
        ultimoMotivo = MOTIVOS.CONTRATO;
        ultimoDetalle = validado.motivo;
        contar("ia_fallo_contrato");
        // El motivo del contrato SI se registra: dice que campo intento
        // fijar el modelo, y eso hay que verlo. No incluye valores.
        registrar("error", "ia_contrato_incumplido", { intento, motivo: validado.motivo });
        // Reintentar un incumplimiento de contrato tiene sentido: suele ser
        // una alucinacion puntual del modelo.
        if (await esperarSiQueda(intento)) continue;
        break;
      }

      contar("ia_correcta");
      registrar("info", "ia_correcta", { intento, ms: Date.now() - inicio, intencion: validado.analisis.intencion });
      return { ok: true, analisis: validado.analisis, intentos: intento };
    }

    contar("ia_agotada");
    registrar("error", "ia_agotada", { motivo: ultimoMotivo, detalle: ultimoDetalle, intentos });

    // Se devuelve respaldo, no una excepcion. El mensaje del cliente sigue
    // vivo: se registra, se escala, y nadie se queda sin atender.
    return {
      ok: false,
      motivo: ultimoMotivo || MOTIVOS.RED,
      detalle: ultimoDetalle,
      analisis: analisisDeRespaldo(ultimoMotivo || MOTIVOS.RED),
      intentos,
    };
  }

  async function esperarSiQueda(intento) {
    if (intento >= intentos) return false;
    const ms = ESPERAS_MS[intento - 1] ?? ESPERAS_MS[ESPERAS_MS.length - 1];
    await new Promise((r) => setTimeout(r, ms));
    return true;
  }

  return { analizar, disponible: Boolean(proveedor && typeof proveedor.completar === "function") };
}

/**
 * Saca el objeto JSON de una respuesta que puede venir envuelta en texto o
 * en un bloque de codigo. Los modelos lo hacen aunque se les pida que no.
 */
function extraerJson(texto) {
  const t = String(texto).trim();
  const enBloque = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (enBloque) return enBloque[1].trim();
  const primera = t.indexOf("{");
  const ultima = t.lastIndexOf("}");
  if (primera !== -1 && ultima > primera) return t.slice(primera, ultima + 1);
  return t;
}

module.exports = { crearCliente, MOTIVOS, HTTP_REINTENTABLES, extraerJson };
