"use strict";

// ==========================================================================
// FABRICA DE REPOSITORIOS
//
// Un solo sitio decide donde vive la informacion transaccional. El resto del
// sistema recibe `repos` y no sabe si detras hay archivos o PostgreSQL.
//
// Con DATABASE_URL -> PostgreSQL. Sin ella -> archivos sobre el disco
// persistente de Render.
//
// Lo que NO hace esta fabrica: crear ni modificar tablas. Las migraciones se
// aplican con `npm run migrar`, que es una decision y no un efecto
// secundario de desplegar. Si el esquema no esta al dia, el arranque falla y
// lo dice; no se "arregla" la base por su cuenta en un momento que nadie
// esta mirando.
// ==========================================================================

const path = require("node:path");
const { crearReposDeArchivos } = require("./archivos");
const { revisarForma } = require("./contrato");

const BACKENDS = { ARCHIVOS: "archivos", POSTGRES: "postgres" };

/** Tablas que el adaptador de Postgres necesita para funcionar. */
const TABLAS_REQUERIDAS = ["contactos", "conversaciones", "pedidos", "pedidos_historial"];

/**
 * Columnas que el adaptador escribe y que NO estaban en la 001.
 *
 * --------------------------------------------------------------------------
 * POR QUE NO BASTA COMPROBAR LAS TABLAS
 * --------------------------------------------------------------------------
 *
 * Comprobar solo los nombres de las tablas deja pasar el caso realmente
 * probable: la 001 aplicada y la 002 o la 003 no. Las tablas existen, el
 * arranque pasa, y el primer "column does not exist" aparece A MITAD DE UNA
 * VENTA, que es exactamente lo que esta comprobacion existe para evitar.
 *
 * Y ese caso no es hipotetico: las migraciones se aplican a mano con
 * `npm run migrar`, asi que desplegar codigo nuevo contra una base migrada
 * a medias es un orden de pasos equivocado, no un fallo raro.
 *
 * Solo se listan las que llegaron DESPUES de la 001. Las de la 001 no hace
 * falta: si falta una de ellas, es que la tabla no se creo, y eso ya se
 * detecta arriba.
 */
const COLUMNAS_REQUERIDAS = {
  conversaciones: ["atencion", "mensajes"], // 002
  pedidos: ["despacho", "novedades", "entrega"], // 003 · 004
};

/**
 * Comprueba que el esquema este aplicado ANTES de atender a nadie.
 *
 * Sin esto, el primer error de "relation does not exist" aparece a mitad de
 * una venta. Un arranque que falla es ruidoso y barato.
 */
async function revisarEsquema(repos) {
  const { rows } = await repos._pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [TABLAS_REQUERIDAS]
  );
  const presentes = new Set(rows.map((r) => r.table_name));
  const faltan = TABLAS_REQUERIDAS.filter((t) => !presentes.has(t));
  if (faltan.length) {
    throw new Error(
      `La base de datos no tiene el esquema de NOVIKA. Faltan las tablas: ${faltan.join(", ")}. ` +
        "Aplica las migraciones con `npm run migrar` y vuelve a desplegar. " +
        "El servicio NO crea tablas por su cuenta a proposito."
    );
  }

  const { rows: cols } = await repos._pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [Object.keys(COLUMNAS_REQUERIDAS)]
  );
  const porTabla = new Map();
  for (const c of cols) {
    if (!porTabla.has(c.table_name)) porTabla.set(c.table_name, new Set());
    porTabla.get(c.table_name).add(c.column_name);
  }

  const columnasQueFaltan = [];
  for (const [tabla, requeridas] of Object.entries(COLUMNAS_REQUERIDAS)) {
    const hay = porTabla.get(tabla) || new Set();
    for (const col of requeridas) if (!hay.has(col)) columnasQueFaltan.push(`${tabla}.${col}`);
  }

  if (columnasQueFaltan.length) {
    throw new Error(
      `La base de datos tiene las tablas de NOVIKA pero le faltan columnas: ${columnasQueFaltan.join(", ")}. ` +
        "Hay migraciones sin aplicar. Ejecuta `npm run migrar` (las aplica todas, en orden) y vuelve a desplegar. " +
        "Arrancar asi haria fallar la primera venta en vez del arranque."
    );
  }
}

/**
 * @param {object} opciones
 * @param {string} opciones.dirDatos        DATA_DIR
 * @param {string} [opciones.databaseUrl]   si viene, se usa PostgreSQL
 * @param {string} [opciones.subcarpeta]
 * @param {object} [opciones.log]
 */
async function crearRepos({ dirDatos, databaseUrl = "", subcarpeta = "transaccional", log = null } = {}) {
  let repos;

  if (databaseUrl) {
    const { crearReposDePostgres } = require("./postgres");
    repos = await crearReposDePostgres({ dsn: databaseUrl, log });
    await revisarEsquema(repos);
  } else {
    if (!dirDatos) throw new Error("crearRepos necesita dirDatos cuando no hay DATABASE_URL");
    repos = await crearReposDeArchivos({ dir: path.join(dirDatos, subcarpeta) });
  }

  // Se comprueba la forma al crear, no al usar. Un metodo que falta se
  // descubre al arrancar y no a mitad de una venta.
  const forma = revisarForma(repos);
  if (!forma.ok) {
    throw new Error(`la implementacion "${repos.tipo}" no cumple el contrato, falta: ${forma.faltan.join(", ")}`);
  }

  return repos;
}

module.exports = { crearRepos, revisarEsquema, BACKENDS, TABLAS_REQUERIDAS, COLUMNAS_REQUERIDAS };
