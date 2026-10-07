"use strict";

// ==========================================================================
// npm run comprobar-postgres
//
// Revision de SOLO LECTURA de la base de datos, antes de tocar nada.
//
// --------------------------------------------------------------------------
// POR QUE EXISTE
// --------------------------------------------------------------------------
//
// Hay una trampa en el orden de los pasos: si se configura DATABASE_URL en
// el servicio ANTES de aplicar el esquema, el servicio NO ARRANCA -por
// diseno, porque no crea tablas por su cuenta- y produccion se queda caida
// hasta que alguien quite la variable.
//
// Este comando permite comprobar antes: conectividad, version, permisos,
// estado de las migraciones, tablas presentes y cuantos datos hay a cada
// lado. Todo sin escribir una sola fila.
//
// Y esta pensado para pegarse en un chat: NO imprime la cadena de conexion
// ni la contrasena, solo el host y el nombre de la base.
//
// La prueba de permisos crea una tabla temporal dentro de una transaccion y
// hace ROLLBACK. Es la unica forma de saber si el rol puede ejecutar las
// migraciones sin descubrirlo a mitad de la migracion.
// ==========================================================================

const { config } = require("./config");
const congelacion = require("./almacen/congelar");

const { describirDestino } = require("./almacen/repos/postgres");

const si = (v) => (v ? "si" : "NO");

async function principal() {
  const problemas = [];
  const avisos = [];

  console.log("");
  console.log("NOVIKA · comprobacion de PostgreSQL (solo lectura)");
  console.log("".padEnd(66, "-"));

  // ---- 1. ¿Hay DSN? ----
  if (!config.databaseUrl) {
    console.log("  DATABASE_URL ............... NO configurada");
    console.log("");
    console.log("  Sin DATABASE_URL no hay nada que comprobar. Pasala en el entorno de");
    console.log("  ESTE comando, sin configurarla todavia en el servicio:");
    console.log("");
    console.log('    DATABASE_URL="<internal url>" npm run comprobar-postgres');
    console.log("");
    process.exit(1);
  }

  console.log(`  destino .................... ${describirDestino(config.databaseUrl)}`);

  const { Client } = require("pg");
  const { opcionesDeSsl } = require("./almacen/repos/postgres");
  const ssl = opcionesDeSsl(config.databaseUrl);
  console.log(`  TLS ........................ ${ssl ? "si (url externa)" : "no (red interna o local)"}`);

  const cliente = new Client({
    connectionString: config.databaseUrl,
    ssl,
    // Sin timeout, una URL equivocada deja el comando colgado sin decir nada.
    connectionTimeoutMillis: 10000,
  });

  // ---- 2. Conectividad ----
  try {
    await cliente.connect();
  } catch (e) {
    console.log(`  conexion ................... NO · ${e.message}`);
    console.log("");
    console.log("  Cosas que suelen ser:");
    console.log("    - estas usando la Internal URL desde fuera de Render (solo funciona dentro)");
    console.log("    - la base todavia esta creandose");
    console.log("    - la URL se copio a medias");
    console.log("");
    process.exit(1);
  }

  try {
    const info = await cliente.query(
      "SELECT version() AS v, current_database() AS base, current_user AS usuario, current_schema() AS esquema"
    );
    const { v, base, usuario, esquema } = info.rows[0];
    console.log(`  conexion ................... si`);
    // version() devuelve un parrafo entero (plataforma, compilador). Solo el numero.
    console.log(`  version .................... ${(v.match(/PostgreSQL ([\d.]+)/) || [, v])[1]}`);
    console.log(`  base / usuario / esquema ... ${base} / ${usuario} / ${esquema}`);

    const mayor = Number((v.match(/PostgreSQL (\d+)/) || [])[1] || 0);
    if (mayor && mayor < 14) {
      problemas.push(`PostgreSQL ${mayor} es anterior a lo verificado (15+). Usa 16 o 17.`);
    }

    // ---- 3. Permisos: ¿puede ejecutar las migraciones? ----
    try {
      await cliente.query("BEGIN");
      await cliente.query("CREATE TABLE comprobacion_de_permisos_novika (x int)");
      await cliente.query("ROLLBACK"); // no deja rastro
      console.log("  permisos para migrar ....... si");
    } catch (e) {
      await cliente.query("ROLLBACK").catch(() => {});
      console.log("  permisos para migrar ....... NO");
      problemas.push(`el usuario no puede crear tablas: ${e.message}`);
    }

    // ---- 4. Migraciones ----
    const { estado: estadoMigraciones } = require("./almacen/repos/postgres/migrar");
    const migraciones = await estadoMigraciones({ cliente });
    console.log("");
    console.log("  migraciones:");
    for (const m of migraciones) {
      let marca;
      if (!m.aplicada) marca = "PENDIENTE";
      else if (m.checksumCoincide === false) marca = "APLICADA PERO EL ARCHIVO CAMBIO";
      else marca = "aplicada";
      console.log(`    ${m.nombre.padEnd(32)} ${marca}`);
      if (m.aplicada && m.checksumCoincide === false) {
        problemas.push(`la migracion ${m.nombre} se aplico con otro contenido; no migres sin revisarlo`);
      }
    }
    const pendientes = migraciones.filter((m) => !m.aplicada);

    // ---- 5. Tablas ----
    const { TABLAS_REQUERIDAS } = require("./almacen/repos");
    const { rows: tablas } = await cliente.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [TABLAS_REQUERIDAS]
    );
    const presentes = new Set(tablas.map((t) => t.table_name));
    const faltan = TABLAS_REQUERIDAS.filter((t) => !presentes.has(t));

    console.log("");
    console.log(`  tablas del esquema ......... ${presentes.size}/${TABLAS_REQUERIDAS.length}`);
    if (faltan.length) console.log(`    faltan: ${faltan.join(", ")}`);

    const esquemaListo = faltan.length === 0;

    // ---- 6. Los candados de idempotencia ----
    if (esquemaListo) {
      const { rows: indices } = await cliente.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE tablename = 'pedidos' AND indexname LIKE 'pedidos_clave%'`
      );
      const porNombre = Object.fromEntries(indices.map((r) => [r.indexname, r.indexdef]));
      const evento = Boolean(porNombre.pedidos_clave_evento_uniq);
      const oferta = Boolean(porNombre.pedidos_clave_oferta_vivo_uniq);
      const ofertaParcial = oferta && /WHERE \(estado <> 'cancelado'/.test(porNombre.pedidos_clave_oferta_vivo_uniq);

      console.log(`  candado por evento ......... ${si(evento)}`);
      console.log(`  candado por oferta ......... ${si(oferta)}${oferta ? ` (parcial: ${si(ofertaParcial)})` : ""}`);

      if (!evento) problemas.push("falta el indice unico de clave_de_evento: se podrian duplicar pedidos");
      if (!oferta) problemas.push("falta el indice unico de clave_de_oferta: un 'si' repetido podria duplicar");
      if (oferta && !ofertaParcial) {
        avisos.push("el indice de oferta no es parcial: un cliente que cancele no podria volver a comprar");
      }

      // ---- 7. Cuantos datos hay ya en la base ----
      const { rows: conteos } = await cliente.query(`
        SELECT (SELECT count(*) FROM pedidos)::int        AS pedidos,
               (SELECT count(*) FROM conversaciones)::int AS conversaciones,
               (SELECT count(*) FROM contactos)::int      AS contactos
      `);
      console.log("");
      console.log(
        `  ya en la base .............. ${conteos[0].pedidos} pedido(s), ${conteos[0].conversaciones} conversacion(es), ${conteos[0].contactos} contacto(s)`
      );
    }

    // ---- 8. Que hay en el disco ----
    let enDisco = null;
    try {
      const path = require("node:path");
      const { crearReposDeArchivos } = require("./almacen/repos/archivos");
      const archivos = await crearReposDeArchivos({ dir: path.join(config.dirDatos, "transaccional") });
      const inv = await archivos._inventario();
      enDisco = { pedidos: inv.pedidos.length, conversaciones: inv.conversaciones.length, contactos: inv.contactos.length };
      await archivos.cerrar();
      console.log(
        `  en el disco ................ ${enDisco.pedidos} pedido(s), ${enDisco.conversaciones} conversacion(es), ${enDisco.contactos} contacto(s)`
      );
    } catch (e) {
      avisos.push(`no se pudo leer el disco (${config.dirDatos}): ${e.message}`);
    }

    // ---- 9. Congelacion ----
    const cong = congelacion.estado(config.dirDatos);
    console.log(`  escrituras congeladas ...... ${si(cong.congelado)}${cong.horas !== null ? ` (${cong.horas} h)` : ""}`);
    if (cong.congelado && cong.horas !== null && cong.horas >= 1) {
      avisos.push("lleva mas de una hora congelado: los mensajes se estan acumulando sin atender");
    }

    // ---- 9.b Drenaje de turnos en vuelo ----
    //
    // Son los dos candados que el cutover va a exigir. Se muestran aqui para
    // que se sepa ANTES de intentarlo, no por un error a mitad.
    const trabajo = require("./almacen/trabajo");
    const persistencia = require("./almacen/persistencia");
    const bitacora = trabajo.inspeccionar(config.dirDatos);
    const marcador = persistencia.leerMarcador(config.dirDatos);

    if (!bitacora.legible) {
      console.log("  turnos en vuelo ............ NO SE PUDO LEER");
      problemas.push(`no se pudo leer la bitacora de trabajo: ${bitacora.error}`);
    } else {
      console.log(`  turnos en vuelo ............ ${bitacora.enCurso.length}`);
      console.log(`  trabajo diferido ........... ${bitacora.diferidos.length}`);
    }
    console.log(`  ultimo arranque ............ ${marcador.ultimoArranque || "(sin marcador)"}`);

    if (cong.congelado) {
      const arranque = marcador.ultimoArranque ? Date.parse(marcador.ultimoArranque) : NaN;
      const desde = cong.desde ? Date.parse(cong.desde) : NaN;
      const reinicioOk = !Number.isNaN(arranque) && !Number.isNaN(desde) && arranque > desde;
      console.log(`  reinicio tras congelar ..... ${si(reinicioOk)}`);
      if (!reinicioOk) {
        avisos.push(
          "el servicio no se ha reiniciado desde que se congelo: el cutover se negara. " +
            "Render -> novika-bot -> Manual Deploy -> Restart service."
        );
      }
      if (bitacora.legible && bitacora.enCurso.length > 0) {
        avisos.push(
          `hay ${bitacora.enCurso.length} turno(s) en vuelo: el cutover se negara hasta que un reinicio congelado los drene.`
        );
      }
    }

    // ---- 10. Veredicto ----
    console.log("");
    console.log("".padEnd(66, "-"));

    if (problemas.length) {
      console.log("  PROBLEMAS:");
      for (const p of problemas) console.log(`    [X] ${p}`);
    }
    if (avisos.length) {
      console.log("  AVISOS:");
      for (const a of avisos) console.log(`    [!] ${a}`);
    }
    if (!problemas.length && !avisos.length) console.log("  Sin problemas.");

    console.log("");
    console.log("  SIGUIENTE PASO:");
    if (problemas.length) {
      console.log("    Resolver los problemas de arriba. NO configures DATABASE_URL en el servicio.");
    } else if (pendientes.length) {
      console.log(`    Aplicar ${pendientes.length} migracion(es):   npm run migrar`);
      console.log("    (con DATABASE_URL en el entorno de ese comando, no en el servicio)");
    } else if (!esquemaListo) {
      console.log("    El esquema esta incompleto. Revisa las migraciones antes de seguir.");
    } else if (!cong.congelado) {
      console.log("    1. Congelar las escrituras:       npm run congelar");
      console.log("    2. REINICIAR novika-bot en Render (Manual Deploy -> Restart service)");
      console.log("       Mata cualquier turno en vuelo esperando a la IA. Sin esto el cutover se niega.");
      console.log("    3. Ensayar:                       npm run cutover -- --simular");
    } else {
      const arranque = marcador.ultimoArranque ? Date.parse(marcador.ultimoArranque) : NaN;
      const desde = cong.desde ? Date.parse(cong.desde) : NaN;
      const reinicioOk = !Number.isNaN(arranque) && !Number.isNaN(desde) && arranque > desde;
      if (!reinicioOk) {
        console.log("    REINICIAR novika-bot en Render (Manual Deploy -> Restart service)");
        console.log("    Ya esta congelado, pero el proceso actual pudo empezar turnos antes.");
      } else if (bitacora.legible && bitacora.enCurso.length > 0) {
        console.log("    Hay turnos en vuelo. Vuelve a reiniciar novika-bot, congelado.");
      } else {
        console.log("    Ensayar el cutover:               npm run cutover -- --simular");
      }
    }
    console.log("");

    if (problemas.length) process.exit(1);
  } finally {
    await cliente.end().catch(() => {});
  }
}

principal().catch((e) => {
  console.error("");
  console.error(`  La comprobacion fallo: ${e.message}`);
  console.error("  No se escribio nada.");
  console.error("");
  process.exit(1);
});
