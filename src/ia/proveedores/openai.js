"use strict";

// ==========================================================================
// PROVEEDOR COMPATIBLE CON OPENAI
//
// Lo unico que sabe de HTTP en toda la capa de IA. No interpreta nada: pide
// una respuesta y devuelve texto crudo. Quien decide si ese texto sirve es
// src/ia/cliente.js, contra el contrato.
//
// Hablar el dialecto /v1/chat/completions y no una API propietaria es
// deliberado: los precios de los modelos se mueven mucho, y cambiar de
// proveedor tiene que ser cambiar una variable de entorno, no reescribir
// codigo. En BIKERPRO esta decision ya se tomo, por la misma razon.
//
// La clave NO se registra, NO se devuelve y NO aparece en los errores.
// ==========================================================================

const TIEMPO_POR_DEFECTO_MS = 12000;

/**
 * @param {object} opciones
 * @param {string} opciones.apiKey
 * @param {string} [opciones.baseUrl]
 * @param {string} [opciones.modelo]
 * @param {number} [opciones.temperatura]
 * @param {number} [opciones.maxTokens]
 */
function crearProveedorOpenAI({
  apiKey,
  baseUrl = "https://api.openai.com/v1",
  modelo = "gpt-4o-mini",
  temperatura = 0.3,
  maxTokens = 900,
} = {}) {
  if (!apiKey) throw new Error("crearProveedorOpenAI necesita una apiKey");

  async function completar({ sistema, usuario, timeoutMs = TIEMPO_POR_DEFECTO_MS }) {
    // AbortController da el timeout real. Sin el, una llamada colgada deja
    // al cliente esperando indefinidamente.
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), timeoutMs);

    try {
      const respuesta = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelo,
          temperature: temperatura,
          max_tokens: maxTokens,
          // Se pide JSON a nivel de API, no solo en el prompt. Una
          // instruccion en el prompt es una sugerencia; esto es el formato.
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sistema },
            { role: "user", content: usuario },
          ],
        }),
        signal: control.signal,
      });

      if (!respuesta.ok) {
        // El cuerpo del error se lee pero NO se propaga: los proveedores
        // devuelven el prompt dentro del error, y el prompt lleva el mensaje
        // del cliente.
        let pista = "";
        try {
          const cuerpo = await respuesta.json();
          pista = (cuerpo && cuerpo.error && cuerpo.error.code) || "";
        } catch {
          /* sin pista */
        }
        return { ok: false, estado: respuesta.status, texto: "", codigo: pista };
      }

      const cuerpo = await respuesta.json();
      const texto = cuerpo?.choices?.[0]?.message?.content ?? "";
      return {
        ok: true,
        estado: 200,
        texto,
        uso: cuerpo?.usage
          ? { entrada: cuerpo.usage.prompt_tokens, salida: cuerpo.usage.completion_tokens }
          : null,
      };
    } finally {
      clearTimeout(reloj);
    }
  }

  return { completar, modelo };
}

module.exports = { crearProveedorOpenAI, TIEMPO_POR_DEFECTO_MS };
