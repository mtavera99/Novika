"use strict";

// ==========================================================================
// EJECUTOR DE MIGRACIONES
//
// Aplica los .sql de /migraciones en orden, una sola vez cada uno, y deja
// constancia de cual se aplico y con que contenido.
//
// --------------------------------------------------------------------------
// TRES REGLAS, Y LAS TRES SON PARA NO DESTRUIR DATOS
// --------------------------------------------------------------------------
//
// 1. NO SE EJECUTA AL ARRANCAR. Es un comando aparte (`npm run migrar`).
//    Un servicio que toca el esquema al arrancar hace cambios de estructura
//    en un momento que nadie esta mirando, y si el despliegue reinicia tres
//    veces lo intenta tres veces. Migrar es una decision, no un efecto
//    secundario de desplegar.
//
// 2. CHECKSUM POR ARCHIVO. Si un .sql ya aplicado cambia de contenido, el
//    ejecutor FALLA y lo dice. Sin esto, editar una migracion ya aplicada
//    deja la base en un estado que no corresponde a ningun archivo del
//    repositorio, y nadie se entera hasta que algo no cuadra.
//
// 3. CERROJO DE AVISO (advisory lock). Dos procesos migrando a la vez
//    pueden intentar crear la misma tabla. El cerrojo es a nivel de sesion
//    de Postgres, asi que funciona aunque los procesos esten en maquinas
//    distintas: es la clase de garantia que un cerrojo en memoria no da.
//
// Cada migracion corre DENTRO DE UNA TRANSACCION junto con su registro en
// la tabla `migraciones`: o se aplica y queda anotada, o no pasa ninguna de
// las dos cosas. Nunca "aplicada pero sin anotar".
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CARPETA = path.join(__dirname, "..", "..", "..", "..", "migraciones");

/** Numero arbitrario pero fijo: identifica este cerrojo y ningun otro. */
const CERROJO_MIGRACIONES = 918273645;

function checksum(texto) {
  return crypto.createHash("sha256").update(texto).digest("hex").slice(0, 32);
}

/** Los .sql de la carpeta, en orden alfabetico (de ahi el prefijo 001-). */
function leerMigraciones(carpeta = CARPETA) {
  let nombres = [];
  try {
    nombres = fs
      .readdirSync(carpeta)
      .filter((n) => n.endsWith(".sql"))
      .sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return nombres.map((nombre) => {
    const sql = fs.readFileSync(path.join(carpeta, nombre), "utf8");
    return { nombre, sql, checksum: checksum(sql) };
  });
}

/**
 * Aplica las migraciones pendientes.
 *
 * @param {object} opciones
 * @param {object} opciones.cliente  cliente de pg ya conectado
 * @param {string} [opciones.carpeta]
 * @param {object} [opciones.log]
 * @returns {Promise<{aplicadas: string[], yaEstaban: string[], total: number}>}
 */
async function migrar({ cliente, carpeta = CARPETA, log = null } = {}) {
  const decir = (nivel, evento, datos) => {
    if (log && typeof log[nivel] === "function") log[nivel](evento, datos);
  };

  const migraciones = leerMigraciones(carpeta);
  const resultado = { aplicadas: [], yaEstaban: [], total: migraciones.length };

  if (!migraciones.length) {
    decir("warn", "migraciones_sin_archivos", { carpeta });
    return resultado;
  }

  // El cerrojo se toma a nivel de SESION y se suelta explicitamente: las
  // migraciones corren en transacciones propias, asi que un cerrojo de
  // transaccion se soltaria en el primer COMMIT.
  await cliente.query("SELECT pg_advisory_lock($1)", [CERROJO_MIGRACIONES]);

  try {
    // Bootstrap. Es lo unico que se crea sin migracion, porque es donde se
    // anotan las migraciones.
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS migraciones (
        nombre      TEXT        PRIMARY KEY,
        checksum    TEXT        NOT NULL,
        aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await cliente.query("SELECT nombre, checksum FROM migraciones");
    const aplicadas = new Map(rows.map((r) => [r.nombre, r.checksum]));

    for (const m of migraciones) {
      const previo = aplicadas.get(m.nombre);

      if (previo) {
        if (previo !== m.checksum) {
          // No se "arregla" silenciosamente: se para. La base esta en un
          // estado que no corresponde al archivo, y solo una persona puede
          // decidir que hacer con eso.
          throw new Error(
            `La migracion "${m.nombre}" ya se aplico, pero su contenido cambio ` +
              `(checksum ${previo} -> ${m.checksum}). No se toca la base. ` +
              `Si el cambio es intencionado, crea una migracion NUEVA en vez de editar esta.`
          );
        }
        resultado.yaEstaban.push(m.nombre);
        continue;
      }

      decir("info", "migracion_aplicando", { nombre: m.nombre });

      // La migracion y su registro, en la misma transaccion.
      await cliente.query("BEGIN");
      try {
        await cliente.query(m.sql);
        await cliente.query("INSERT INTO migraciones (nombre, checksum) VALUES ($1, $2)", [m.nombre, m.checksum]);
        await cliente.query("COMMIT");
      } catch (e) {
        await cliente.query("ROLLBACK").catch(() => {});
        throw new Error(`La migracion "${m.nombre}" fallo y se deshizo entera: ${e.message}`);
      }

      resultado.aplicadas.push(m.nombre);
      decir("info", "migracion_aplicada", { nombre: m.nombre });
    }
  } finally {
    await cliente.query("SELECT pg_advisory_unlock($1)", [CERROJO_MIGRACIONES]).catch(() => {});
  }

  return resultado;
}

/** Que falta por aplicar, sin aplicar nada. Para poder mirar antes de tocar. */
async function estado({ cliente, carpeta = CARPETA } = {}) {
  const migraciones = leerMigraciones(carpeta);
  let aplicadas = new Map();
  try {
    const { rows } = await cliente.query("SELECT nombre, checksum, aplicada_en FROM migraciones");
    aplicadas = new Map(rows.map((r) => [r.nombre, r]));
  } catch {
    // La tabla aun no existe: ninguna aplicada.
  }
  return migraciones.map((m) => {
    const a = aplicadas.get(m.nombre);
    return {
      nombre: m.nombre,
      aplicada: Boolean(a),
      aplicadaEn: a ? a.aplicada_en : null,
      checksumCoincide: a ? a.checksum === m.checksum : null,
    };
  });
}

module.exports = { migrar, estado, leerMigraciones, checksum, CARPETA, CERROJO_MIGRACIONES };
