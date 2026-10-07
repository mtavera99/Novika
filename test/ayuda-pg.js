"use strict";

// ==========================================================================
// Utilidades para las pruebas contra PostgreSQL.
//
// POR QUE UN ESQUEMA POR ARCHIVO DE PRUEBA: `node --test` lanza un proceso
// por archivo y los ejecuta EN PARALELO. La primera version de estas pruebas
// dejaba que los dos archivos borrasen y recreasen las mismas tablas, y se
// pisaban: salian errores de "relation does not exist" que no tenian nada
// que ver con el codigo.
//
// Era un fallo de la bateria, no del producto, y de los peores: hacia dudar
// de un resultado correcto. Cada archivo trabaja ahora en su propio esquema.
// ==========================================================================

const DSN_BASE = process.env.DATABASE_URL_PRUEBAS || "";

/** ¿Hay base de datos contra la que probar? */
const sinBase = !DSN_BASE;
const motivoSalto = "sin DATABASE_URL_PRUEBAS: no hay PostgreSQL contra el que verificar (ver docs/POSTGRES.md)";

/** DSN apuntando a un esquema propio. */
function dsnDeEsquema(esquema) {
  const separador = DSN_BASE.includes("?") ? "&" : "?";
  return `${DSN_BASE}${separador}options=-c%20search_path%3D${esquema}`;
}

async function clienteCrudo(dsn) {
  const { Client } = require("pg");
  const { opcionesDeSsl } = require("../src/almacen/repos/postgres");
  const c = new Client({ connectionString: dsn, ssl: opcionesDeSsl(dsn) });
  await c.connect();
  return c;
}

/**
 * Deja un esquema vacio y con las migraciones aplicadas.
 *
 * @param {string} esquema  nombre propio del archivo de prueba
 * @returns {Promise<{dsn: string, migracion: object}>}
 */
async function prepararEsquema(esquema) {
  const { migrar } = require("../src/almacen/repos/postgres/migrar");

  // Primero, sin search_path, para poder crear el esquema.
  const admin = await clienteCrudo(DSN_BASE);
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${esquema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${esquema}`);
  } finally {
    await admin.end();
  }

  const dsn = dsnDeEsquema(esquema);
  const cli = await clienteCrudo(dsn);
  try {
    const migracion = await migrar({ cliente: cli });
    return { dsn, migracion };
  } finally {
    await cli.end();
  }
}

/** Vacia las filas sin tocar el esquema: cada prueba arranca de cero. */
async function vaciar(dsn) {
  const c = await clienteCrudo(dsn);
  try {
    await c.query("TRUNCATE pedidos_historial, pedidos, conversaciones, contactos CASCADE");
  } finally {
    await c.end();
  }
}

async function crearRepos(dsn) {
  const { crearReposDePostgres } = require("../src/almacen/repos/postgres");
  return crearReposDePostgres({ dsn });
}

module.exports = { sinBase, motivoSalto, DSN_BASE, dsnDeEsquema, prepararEsquema, vaciar, crearRepos, clienteCrudo };
