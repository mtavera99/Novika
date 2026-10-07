"use strict";

// ==========================================================================
// Utilidades para las pruebas.
//
// Reglas de la bateria de NOVIKA:
//   - ninguna prueba necesita credenciales reales;
//   - ninguna prueba sale a la red;
//   - ninguna prueba escribe fuera de /tmp;
//   - cada archivo de prueba corre en su propio proceso (node --test lo hace
//     asi), por eso puede fijar su propio entorno antes de requerir config.
// ==========================================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Prepara un entorno aislado. HAY QUE LLAMARLO ANTES de requerir cualquier
 * modulo de src/, porque src/config.js lee process.env al cargarse.
 */
function entornoDePrueba(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-prueba-"));

  const base = {
    DATA_DIR: dir,
    WHATSAPP_VERIFY_TOKEN: "token_de_verificacion_de_prueba_0123456789",
    META_APP_SECRET: "clave_secreta_de_prueba",
    WHATSAPP_PHONE_NUMBER_ID: "111111111111111",
    PANEL_TOKEN: "token_del_panel_de_prueba",
    LOG_NIVEL: "error",
    LOG_PII: "0",
    RESPUESTA_AUTOMATICA: "0",
    ZONA_HORARIA: "America/Bogota",
  };

  for (const [k, v] of Object.entries({ ...base, ...extra })) {
    if (v === null) delete process.env[k];
    else process.env[k] = String(v);
  }

  return dir;
}

/** Levanta la app en un puerto libre y devuelve { url, cerrar }. */
async function levantar(app) {
  const servidor = await new Promise((listo) => {
    const s = app.listen(0, () => listo(s));
  });
  const { port } = servidor.address();
  return {
    url: `http://127.0.0.1:${port}`,
    cerrar: () => new Promise((listo) => servidor.close(listo)),
  };
}

/** Cuerpo entrante de WhatsApp con un mensaje de texto. */
function payloadDeTexto({ wamid = "wamid.PRUEBA1", texto = "hola", idNumero = "111111111111111", de = "573001234567" } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_DE_PRUEBA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "573000000000", phone_number_id: idNumero },
              contacts: [{ profile: { name: "Cliente de prueba" }, wa_id: de }],
              messages: [{ from: de, id: wamid, timestamp: "1760000000", type: "text", text: { body: texto } }],
            },
          },
        ],
      },
    ],
  };
}

/** Cuerpo entrante con un acuse de estado. */
function payloadDeEstado({ wamid = "wamid.ESTADO1", estado = "failed", idNumero = "111111111111111" } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_DE_PRUEBA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "573000000000", phone_number_id: idNumero },
              statuses: [
                {
                  id: wamid,
                  status: estado,
                  timestamp: "1760000000",
                  recipient_id: "573001234567",
                  errors: estado === "failed" ? [{ code: 131047, title: "Re-engagement message" }] : undefined,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Lee todas las entradas del diario escritas durante la prueba. */
function leerDiario(dir) {
  const carpeta = path.join(dir, "diario");
  if (!fs.existsSync(carpeta)) return [];
  return fs
    .readdirSync(carpeta)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) =>
      fs
        .readFileSync(path.join(carpeta, n), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    );
}

module.exports = { entornoDePrueba, levantar, payloadDeTexto, payloadDeEstado, leerDiario };
