"use strict";

// ==========================================================================
// npm run migrar          · aplica las migraciones pendientes
// npm run migrar-estado   · dice que falta, sin tocar nada
//
// Comando aparte a proposito: migrar es una decision, no un efecto
// secundario de desplegar. Ver src/almacen/repos/postgres/migrar.js.
//
// NUNCA imprime la cadena de conexion: lleva la contrasena dentro.
// ==========================================================================

const { config } = require("./config");
const log = require("./log");
const { migrar, estado } = require("./almacen/repos/postgres/migrar");

/** Host y base, sin usuario ni contrasena. Para saber DONDE se va a migrar. */
/** Host y base, SIN usuario ni contrasena. Para saber DONDE se va a migrar. */
function describirDestino(dsn) {
  try {
    const u = new URL(dsn);
    const host = u.hostname || u.searchParams.get("host") || "socket local";
    return `${host}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    // Nunca se devuelve el DSN crudo: lleva la contrasena dentro.
    return "(destino no interpretable)";
  }
}

async function principal() {
  const soloMirar = process.argv.includes("--estado");

  if (!config.databaseUrl) {
    console.error("");
    console.error("No hay DATABASE_URL configurada: no hay base de datos que migrar.");
    console.error("Mientras NOVIKA use archivos sobre el disco persistente, no hace falta migrar nada.");
    console.error("");
    process.exit(1);
  }

  const { Client } = require("pg");
  const { opcionesDeSsl } = require("./almacen/repos/postgres");
  const cliente = new Client({ connectionString: config.databaseUrl, ssl: opcionesDeSsl(config.databaseUrl) });

  console.log("");
  console.log(`NOVIKA · migraciones -> ${describirDestino(config.databaseUrl)}`);
  console.log("".padEnd(62, "-"));

  await cliente.connect();
  try {
    if (soloMirar) {
      for (const m of await estado({ cliente })) {
        const marca = m.aplicada ? (m.checksumCoincide ? "aplicada" : "APLICADA PERO EL ARCHIVO CAMBIO") : "pendiente";
        console.log(`  ${m.nombre.padEnd(34)} ${marca}`);
      }
      console.log("");
      return;
    }

    const r = await migrar({ cliente, log });

    for (const n of r.yaEstaban) console.log(`  ${n.padEnd(34)} ya estaba`);
    for (const n of r.aplicadas) console.log(`  ${n.padEnd(34)} APLICADA`);
    console.log("".padEnd(62, "-"));
    console.log(`  ${r.aplicadas.length} aplicada(s), ${r.yaEstaban.length} ya estaban, ${r.total} en total.`);
    console.log("");
  } finally {
    await cliente.end();
  }
}

principal().catch((e) => {
  console.error("");
  console.error("La migracion NO se completo:");
  console.error(`  ${e.message}`);
  console.error("");
  console.error("La base queda como estaba: cada migracion corre dentro de su propia transaccion.");
  console.error("");
  process.exit(1);
});
