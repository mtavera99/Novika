"use strict";

// ==========================================================================
// IDS YA VISTOS (deduplicacion de eventos entrantes)
//
// Meta reentrega un webhook cuando no recibe un 200 a tiempo. Su
// documentacion es concreta: reintenta de inmediato y luego varias veces con
// frecuencia decreciente "durante las siguientes 36 horas", descarta lo no
// confirmado a las 36 horas, y dice explicitamente que el servidor debe
// encargarse de deduplicar.
//
// Si el mismo mensaje se procesa dos veces, el cliente recibe dos respuestas
// y, cuando haya pedidos, puede nacer un pedido fantasma.
//
// BIKERPRO no tiene este candado: su handleWebhook nunca lee msg.id, y toda
// la defensa contra duplicados esta aguas abajo, comparando pedidos ya
// guardados. Eso atrapa el duplicado tarde, cuando ya hubo efectos.
//
// Aqui el candado esta en la puerta: cada wamid se registra una sola vez, y
// quien pregunta recibe la respuesta en la misma operacion.
//
// Durabilidad: archivo append-only + indice en memoria cargado al arrancar.
// Si el proceso muere, lo escrito sigue ahi. Al arrancar se compacta
// descartando lo mas viejo que DIAS_QUE_SE_RECUERDAN.
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../config");
const log = require("./../log");

const ARCHIVO = path.join(config.dirDatos, "vistos.jsonl");

// 7 dias, no 36 horas. La ventana de reintentos de Meta es de 36 horas, asi
// que 7 dias la cubre con holgura y deja margen para un fin de semana con
// incidencias. El coste de recordar de mas es una linea de texto por
// mensaje; el de recordar de menos es un pedido duplicado.
const DIAS_QUE_SE_RECUERDAN = 7;
const MS_QUE_SE_RECUERDAN = DIAS_QUE_SE_RECUERDAN * 24 * 60 * 60 * 1000;

/** @type {Map<string, number>} id -> timestamp en ms */
let indice = null;

function asegurarCarpeta() {
  fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
}

function cargar() {
  if (indice) return indice;
  indice = new Map();
  try {
    asegurarCarpeta();
    if (!fs.existsSync(ARCHIVO)) return indice;

    const corte = Date.now() - MS_QUE_SE_RECUERDAN;
    const lineas = fs.readFileSync(ARCHIVO, "utf8").split("\n").filter(Boolean);
    let descartadas = 0;

    for (const linea of lineas) {
      try {
        const { id, ts } = JSON.parse(linea);
        if (!id) continue;
        const cuando = Number(ts) || 0;
        if (cuando < corte) {
          descartadas++;
          continue;
        }
        indice.set(id, cuando);
      } catch {
        descartadas++;
      }
    }

    // Compactar solo si vale la pena, para no reescribir en cada arranque.
    if (descartadas > 0) {
      const texto = [...indice.entries()].map(([id, ts]) => JSON.stringify({ id, ts })).join("\n");
      const tmp = `${ARCHIVO}.tmp`;
      fs.writeFileSync(tmp, texto ? `${texto}\n` : "");
      fs.renameSync(tmp, ARCHIVO); // rename es atomico: nunca queda a medias
      log.info("vistos_compactado", { quedan: indice.size, descartados: descartadas });
    }
  } catch (e) {
    // Si no se puede leer el indice, se arranca vacio. La consecuencia es
    // que un reintento de Meta podria pasar dos veces; la alternativa seria
    // no arrancar, y eso pierde todos los mensajes, no uno.
    log.error("vistos_no_cargo", { detalle: e.message });
    indice = new Map();
  }
  return indice;
}

/**
 * Registra el id y dice si era nuevo.
 *
 * Marcar y preguntar en una sola operacion es intencionado: si fueran dos
 * llamadas (`yaVisto()` y luego `marcar()`), cualquier `await` entre ambas
 * abriria la ventana que el candado pretende cerrar.
 *
 * @returns {boolean} true si es la primera vez que se ve este id.
 */
function esNuevo(id) {
  if (!id) return true; // sin id no se puede deduplicar; no se bloquea el evento
  const mapa = cargar();
  if (mapa.has(id)) return false;

  const ts = Date.now();
  mapa.set(id, ts);
  try {
    asegurarCarpeta();
    fs.appendFileSync(ARCHIVO, `${JSON.stringify({ id, ts })}\n`);
  } catch (e) {
    log.error("vistos_no_escribio", { detalle: e.message });
  }
  return true;
}

function cuantos() {
  return cargar().size;
}

/** Solo para pruebas: vacia el indice en memoria y el archivo. */
function _reiniciar() {
  indice = null;
  try {
    if (fs.existsSync(ARCHIVO)) fs.rmSync(ARCHIVO);
  } catch {
    /* ignorado */
  }
}

module.exports = { esNuevo, cuantos, ARCHIVO, DIAS_QUE_SE_RECUERDAN, _reiniciar };
