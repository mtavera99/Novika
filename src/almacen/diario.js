"use strict";

// ==========================================================================
// DIARIO DE EVENTOS (append-only, un archivo JSONL por dia)
//
// Esto es la trazabilidad de NOVIKA. Todo lo que entra por el webhook se
// escribe aqui ANTES de procesarse, y todo lo que se decide sobre un evento
// se escribe aqui despues.
//
// Por que append-only y no un JSON que se reescribe entero:
//
//   - BIKERPRO guarda su estado leyendo y reescribiendo el archivo completo
//     en cada operacion. Eso le costo archivos truncados cuando el hosting
//     mandaba SIGTERM a mitad de escritura.
//   - Un append con O_APPEND de pocos cientos de bytes no se parte por la
//     mitad, y lo ya escrito no se puede perder porque nadie lo reescribe.
//
// Por que en disco y no en memoria:
//
//   - BIKERPRO tenia su bitacora en un array de 60 posiciones en memoria.
//     Se borraba en cada despliegue, y hubo dias con ocho despliegues.
//     Justo cuando hacia falta auditar, no habia nada que auditar.
//
// Este modulo es el sustituto honesto de una base de datos para la fase 1.
// Cuando entren pedidos, la fase correspondiente migra a SQLite o Postgres;
// el diario se queda igual, porque un registro inmutable de "que llego"
// sigue siendo util al lado de cualquier base de datos.
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../config");
const log = require("../log");

const CARPETA = path.join(config.dirDatos, "diario");

let carpetaLista = false;
function asegurarCarpeta() {
  if (carpetaLista) return;
  fs.mkdirSync(CARPETA, { recursive: true });
  carpetaLista = true;
}

// Intl.DateTimeFormat reutilizado a nivel de modulo, no construido por
// llamada. En BIKERPRO construirlo en cada llamada provocaba 74 reinicios
// por memoria en el hosting.
const FECHA = new Intl.DateTimeFormat("sv-SE", {
  timeZone: config.zonaHoraria,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function diaDeNegocio(fecha = new Date()) {
  return FECHA.format(fecha); // sv-SE da YYYY-MM-DD
}

function archivoDelDia(fecha = new Date()) {
  return path.join(CARPETA, `${diaDeNegocio(fecha)}.jsonl`);
}

/**
 * Escribe una entrada en el diario. Sincrono a proposito: el webhook llama a
 * esto antes de contestar 200 a Meta, y la garantia que se quiere es
 * justamente "si contestamos 200, ya estaba en disco".
 *
 * Nunca lanza. Un fallo del diario no puede tumbar la recepcion de un
 * mensaje de un cliente; se grita en el log y se sigue.
 */
function anotar(tipo, datos = {}) {
  // `ts` y `tipo` son la identidad de la entrada y se escriben DESPUES del
  // spread a proposito. Antes iban antes, y cualquier dato que trajera una
  // clave llamada `tipo` (el tipo de mensaje de WhatsApp, el tipo de error de
  // Express) la sobrescribia: la entrada quedaba guardada como "text" o como
  // "entity.parse.failed" en vez de "mensaje" o "error_http", y las consultas
  // del diario no la encontraban nunca. Lo detecto test/webhook.test.js.
  const entrada = { ts: null, tipo: null, ...datos };
  entrada.ts = new Date().toISOString();
  entrada.tipo = tipo;
  try {
    asegurarCarpeta();
    fs.appendFileSync(archivoDelDia(), `${JSON.stringify(entrada)}\n`);
    return true;
  } catch (e) {
    log.error("diario_no_escribio", { tipo, detalle: e.message });
    return false;
  }
}

/** Ultimas `cuantas` entradas, de mas reciente a mas antigua. */
function ultimas(cuantas = 50) {
  try {
    asegurarCarpeta();
    const archivos = fs
      .readdirSync(CARPETA)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .reverse();

    const salida = [];
    for (const nombre of archivos) {
      const lineas = fs
        .readFileSync(path.join(CARPETA, nombre), "utf8")
        .split("\n")
        .filter(Boolean)
        .reverse();
      for (const linea of lineas) {
        try {
          salida.push(JSON.parse(linea));
        } catch {
          salida.push({ tipo: "linea_ilegible", crudo: linea.slice(0, 200) });
        }
        if (salida.length >= cuantas) return salida;
      }
    }
    return salida;
  } catch (e) {
    log.error("diario_no_leyo", { detalle: e.message });
    return [];
  }
}

/** Cuenta por tipo dentro del dia de negocio actual. Para /health. */
function resumenDeHoy() {
  const conteo = {};
  try {
    const archivo = archivoDelDia();
    if (!fs.existsSync(archivo)) return conteo;
    const lineas = fs.readFileSync(archivo, "utf8").split("\n").filter(Boolean);
    for (const linea of lineas) {
      try {
        const tipo = JSON.parse(linea).tipo || "sin_tipo";
        conteo[tipo] = (conteo[tipo] || 0) + 1;
      } catch {
        conteo.linea_ilegible = (conteo.linea_ilegible || 0) + 1;
      }
    }
  } catch (e) {
    log.error("diario_no_resumio", { detalle: e.message });
  }
  return conteo;
}

module.exports = { anotar, ultimas, resumenDeHoy, diaDeNegocio, CARPETA };
