"use strict";

// ==========================================================================
// FIRMA X-Hub-Signature-256
//
// Meta firma cada POST con HMAC-SHA256 del cuerpo crudo usando la clave
// secreta de la app. Sin esta comprobacion, la URL del webhook es una API
// publica: cualquiera que la descubra puede inventarse un mensaje de un
// cliente y hacer que el bot responda, cotice y (en fase 2) guarde pedidos.
//
// BIKERPRO no valida la firma. No es un descuido menor: es la diferencia
// entre un endpoint autenticado y uno abierto. En NOVIKA se hace desde el
// primer dia, porque implica capturar el cuerpo crudo antes de parsearlo y
// eso es incomodo de añadir despues.
//
// Dos detalles que es facil equivocar:
//
//   1. El HMAC se calcula sobre los BYTES EXACTOS recibidos. Si se usa el
//      objeto ya parseado y se vuelve a serializar, el resultado no coincide
//      (orden de claves, espacios, escapes unicode). De ahi capturarCuerpoCrudo.
//
//   2. La comparacion es con timingSafeEqual, no con ===. Comparar cadenas
//      secretas con === filtra informacion por el tiempo de respuesta.
// ==========================================================================

const crypto = require("node:crypto");

/**
 * Callback `verify` de express.json(): guarda los bytes originales en la
 * peticion para poder verificar el HMAC despues.
 */
function capturarCuerpoCrudo(req, _res, buf) {
  req.cuerpoCrudo = buf && buf.length ? Buffer.from(buf) : Buffer.alloc(0);
}

/**
 * @param {Buffer} cuerpoCrudo
 * @param {string} cabecera  valor de X-Hub-Signature-256, formato "sha256=<hex>"
 * @param {string} appSecret
 * @returns {{ok: boolean, motivo: string}}
 */
function revisarFirma(cuerpoCrudo, cabecera, appSecret) {
  if (!appSecret) return { ok: false, motivo: "sin_app_secret" };
  if (!cabecera) return { ok: false, motivo: "sin_cabecera" };
  if (!Buffer.isBuffer(cuerpoCrudo)) return { ok: false, motivo: "sin_cuerpo_crudo" };

  const esperada = `sha256=${crypto.createHmac("sha256", appSecret).update(cuerpoCrudo).digest("hex")}`;

  const recibida = Buffer.from(String(cabecera));
  const calculada = Buffer.from(esperada);

  // timingSafeEqual exige la misma longitud. Una longitud distinta ya es
  // firma invalida, y revelarlo no filtra nada util.
  if (recibida.length !== calculada.length) return { ok: false, motivo: "formato" };

  return crypto.timingSafeEqual(recibida, calculada)
    ? { ok: true, motivo: "valida" }
    : { ok: false, motivo: "no_coincide" };
}

/** Util para las pruebas: firma un cuerpo como lo haria Meta. */
function firmar(cuerpoCrudo, appSecret) {
  return `sha256=${crypto.createHmac("sha256", appSecret).update(cuerpoCrudo).digest("hex")}`;
}

module.exports = { capturarCuerpoCrudo, revisarFirma, firmar };
