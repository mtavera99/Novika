"use strict";

// ==========================================================================
// FABRICA DE REPOSITORIOS
//
// Un solo sitio decide donde vive la informacion transaccional. El resto del
// sistema recibe `repos` y no sabe si detras hay archivos o PostgreSQL.
//
// Hoy: archivos, sobre el disco persistente de Render.
// Manana: PostgreSQL, en cuanto exista DATABASE_URL.
//
// El cambio sera una linea aqui. Lo que NO sera una linea es la confianza:
// el adaptador de PostgreSQL tiene que pasar las pruebas de contrato
// (src/almacen/repos/contrato.js) antes de tocar un pedido real.
//
// IMPORTANTE SOBRE EL ESTADO ACTUAL: si DATABASE_URL esta definida, este
// modulo FALLA A PROPOSITO en vez de ignorarla y seguir con archivos.
// Arrancar con archivos cuando el dueno cree que esta usando la base de
// datos es la clase de malentendido que se descubre cuando faltan pedidos.
// ==========================================================================

const path = require("node:path");
const { crearReposDeArchivos } = require("./archivos");
const { revisarForma } = require("./contrato");

const BACKENDS = { ARCHIVOS: "archivos", POSTGRES: "postgres" };

/**
 * @param {object} opciones
 * @param {string} opciones.dirDatos        DATA_DIR
 * @param {string} [opciones.databaseUrl]   si viene, se exige PostgreSQL
 * @param {string} [opciones.subcarpeta]
 */
async function crearRepos({ dirDatos, databaseUrl = "", subcarpeta = "transaccional" } = {}) {
  if (databaseUrl) {
    // Pendiente: adaptador de PostgreSQL. No se escribe a ciegas: sin una
    // base contra la que ejecutar las pruebas de contrato seria codigo sin
    // verificar manejando pedidos, y eso es peor que no tenerlo.
    //
    // El esquema ya esta listo en migraciones/001-esquema-inicial.sql.
    throw new Error(
      "DATABASE_URL esta definida pero el adaptador de PostgreSQL todavia no existe. " +
        "El esquema esta en migraciones/001-esquema-inicial.sql. " +
        "Quita DATABASE_URL para seguir con archivos, o pide el adaptador: tiene que pasar " +
        "las pruebas de contrato de src/almacen/repos/contrato.js antes de usarse."
    );
  }

  if (!dirDatos) throw new Error("crearRepos necesita dirDatos");

  const repos = await crearReposDeArchivos({ dir: path.join(dirDatos, subcarpeta) });

  // Se comprueba la forma al crear, no al usar. Un metodo que falta se
  // descubre al arrancar y no a mitad de una venta.
  const forma = revisarForma(repos);
  if (!forma.ok) {
    throw new Error(`la implementacion "${repos.tipo}" no cumple el contrato, falta: ${forma.faltan.join(", ")}`);
  }

  return repos;
}

module.exports = { crearRepos, BACKENDS };
