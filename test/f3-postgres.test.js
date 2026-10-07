"use strict";

// ==========================================================================
// POSTGRESQL: EL MISMO CONTRATO, Y LO QUE SOLO LA BASE PUEDE GARANTIZAR
//
// Dos partes:
//
//   1. LAS PRUEBAS DE CONTRATO, las mismas que pasa el adaptador de
//      archivos. Si los dos las pasan, el resto del sistema no nota la
//      diferencia, y eso es exactamente lo que hace posible el cutover.
//
//   2. GARANTIAS QUE EL ADAPTADOR DE ARCHIVOS NO PUEDE DAR: no duplicar con
//      conexiones REALMENTE concurrentes, restricciones del motor, y cerrojo
//      de contacto a nivel de base en vez de en memoria.
//
// Sin DATABASE_URL_PRUEBAS estas pruebas se SALTAN, no fallan: el resto de
// la bateria tiene que seguir corriendo en CI sin una base de datos. Pero
// saltarse no es pasar, y el informe lo dice.
//
// Para levantar una base local de prueba, ver docs/POSTGRES.md.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const { pruebasDeContrato, revisarForma, MOTIVOS_NO_CREADO } = require("../src/almacen/repos/contrato");
const ayudaPg = require("./ayuda-pg");

const { sinBase, motivoSalto } = ayudaPg;
// Esquema propio de ESTE archivo: node --test corre los archivos en
// paralelo y dos que borren las mismas tablas se pisan.
const ESQUEMA = "prueba_f3_repos";
let DSN = "";

async function esquemaLimpio() {
  const r = await ayudaPg.prepararEsquema(ESQUEMA);
  DSN = r.dsn;
  return r.migracion;
}
const clienteCrudo = () => ayudaPg.clienteCrudo(DSN);
const crearRepos = () => ayudaPg.crearRepos(DSN);
const vaciar = () => ayudaPg.vaciar(DSN);

// --------------------------------------------------------------------------
// 1. EL CONTRATO
// --------------------------------------------------------------------------

if (sinBase) {
  test("PostgreSQL: pruebas de contrato", { skip: motivoSalto }, () => {});
} else {
  // Se prepara una sola vez y todas las demas pruebas esperan a que termine.
  const listo = esquemaLimpio();

  test("el esquema se aplica desde cero con las migraciones", async () => {
    const r = await listo;
    assert.ok(r.aplicadas.includes("001-esquema-inicial.sql"), `aplicadas: ${r.aplicadas.join(", ")}`);
  });

  test("el adaptador cumple la forma del contrato", async () => {
    const repos = await crearRepos();
    try {
      const f = revisarForma(repos);
      assert.equal(f.ok, true, `faltan: ${f.faltan.join(", ")}`);
      assert.equal(repos.tipo, "postgres");
    } finally {
      await repos.cerrar();
    }
  });

  // LAS MISMAS pruebas que pasa el adaptador de archivos.
  pruebasDeContrato({
    nombre: "postgres",
    crear: async () => {
      await listo;
      await vaciar();
      return crearRepos();
    },
    test,
    assert,
  });
}

// --------------------------------------------------------------------------
// 2. GARANTIAS QUE SOLO DA LA BASE
// --------------------------------------------------------------------------

describe("PostgreSQL: garantias del motor", { skip: sinBase ? motivoSalto : false }, () => {
  // Todas esperan a que el esquema este aplicado.
  const listoParaGarantias = async () => {
    if (!DSN) await ayudaPg.prepararEsquema(ESQUEMA).then((r) => (DSN = r.dsn));
  };
  const pedidoDeEjemplo = (sobre = {}) => ({
    id: sobre.id || `NOV-PG-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    version: 1,
    estado: "confirmado",
    claveDeEvento: sobre.claveDeEvento || "ev-base",
    claveDeOferta: sobre.claveDeOferta || "of-base",
    contactoId: sobre.contactoId || "573001112233",
    conversacionId: sobre.conversacionId || "573001112233",
    ofertaId: sobre.ofertaId || "of-1",
    wamidConfirmacion: sobre.wamidConfirmacion || "wamid.PG",
    producto: { id: "producto-x", nombre: "Producto X", variante: null },
    cantidad: 1,
    destinatario: { nombre: "Ana Pérez", telefono: "3001112233", ciudad: "Medellín", direccion: "Calle 1 # 2-3" },
    cotizacion: {
      productoId: "producto-x",
      cantidad: 1,
      moneda: "COP",
      subtotal: 89000,
      envio: 0,
      descuento: 0,
      total: 89000,
      politicaVersion: "2026.10-fase2.1",
      versionCatalogo: "abc123",
    },
    historial: [{ version: 1, accion: "creado", cuando: new Date().toISOString(), total: 89000 }],
    creadoEn: new Date().toISOString(),
    actualizadoEn: new Date().toISOString(),
    canceladoEn: null,
    motivoCancelacion: null,
    revisiones: [],
    ...sobre,
  });

  test("CONEXIONES REALMENTE CONCURRENTES: 12 intentos de la misma oferta dejan UN pedido", async () => {
    await listoParaGarantias();
    // Esta es la prueba que el adaptador de archivos no puede dar. Son
    // conexiones distintas a la base, no promesas en la misma cola: si la
    // garantia dependiera de enSerie() en memoria, aqui se rompia.
    await vaciar();
    const pools = await Promise.all(Array.from({ length: 12 }, () => crearRepos()));
    try {
      const resultados = await Promise.all(
        pools.map((repos, i) =>
          repos.pedidos.crearSiNoExiste(
            pedidoDeEjemplo({ id: `NOV-CARRERA-${i}`, claveDeEvento: `ev-${i}`, claveDeOferta: "of-carrera" })
          )
        )
      );
      const creados = resultados.filter((r) => r.creado);
      assert.equal(creados.length, 1, `se crearon ${creados.length} pedidos para la misma oferta`);

      // Y los 11 perdedores reciben el pedido de verdad, no un error.
      for (const r of resultados.filter((x) => !x.creado)) {
        assert.equal(r.motivo, MOTIVOS_NO_CREADO.OFERTA_YA_TIENE_PEDIDO);
        assert.equal(r.pedido.id, creados[0].pedido.id);
      }

      assert.equal((await pools[0].pedidos.porContacto("573001112233")).length, 1);
    } finally {
      await Promise.all(pools.map((p) => p.cerrar()));
    }
  });

  test("CONEXIONES CONCURRENTES: el mismo evento desde 8 conexiones deja UN pedido", async () => {
    await listoParaGarantias();
    await vaciar();
    const pools = await Promise.all(Array.from({ length: 8 }, () => crearRepos()));
    try {
      const resultados = await Promise.all(
        pools.map((repos, i) =>
          repos.pedidos.crearSiNoExiste(
            pedidoDeEjemplo({ id: `NOV-EV-${i}`, claveDeEvento: "ev-compartido", claveDeOferta: `of-${i}` })
          )
        )
      );
      assert.equal(resultados.filter((r) => r.creado).length, 1);
      for (const r of resultados.filter((x) => !x.creado)) {
        assert.equal(r.motivo, MOTIVOS_NO_CREADO.EVENTO_REPETIDO);
      }
    } finally {
      await Promise.all(pools.map((p) => p.cerrar()));
    }
  });

  test("el indice UNICO existe de verdad y es PARCIAL en los cancelados", async () => {
    await listoParaGarantias();
    // No basta con que el adaptador se porte bien: la garantia tiene que
    // estar en el motor, para que ningun codigo futuro pueda saltarsela.
    const c = await clienteCrudo();
    try {
      const { rows } = await c.query(`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'pedidos' AND indexname LIKE 'pedidos_clave%'
         ORDER BY indexname
      `);
      const porNombre = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));

      assert.ok(porNombre.pedidos_clave_evento_uniq, "falta el indice de clave_de_evento");
      assert.match(porNombre.pedidos_clave_evento_uniq, /UNIQUE/);

      assert.ok(porNombre.pedidos_clave_oferta_vivo_uniq, "falta el indice de clave_de_oferta");
      assert.match(porNombre.pedidos_clave_oferta_vivo_uniq, /UNIQUE/);
      assert.match(porNombre.pedidos_clave_oferta_vivo_uniq, /WHERE \(estado <> 'cancelado'/);
    } finally {
      await c.end();
    }
  });

  test("el motor rechaza un INSERT duplicado aunque alguien evite el adaptador", async () => {
    await listoParaGarantias();
    await vaciar();
    const repos = await crearRepos();
    try {
      await repos.pedidos.crearSiNoExiste(pedidoDeEjemplo({ claveDeEvento: "ev-x", claveDeOferta: "of-x" }));
    } finally {
      await repos.cerrar();
    }

    const c = await clienteCrudo();
    try {
      await assert.rejects(
        () =>
          c.query(
            `INSERT INTO pedidos (codigo, estado, clave_de_evento, clave_de_oferta, contacto_id, oferta_id,
                                  wamid_confirmacion, producto_id, producto_nombre, cantidad,
                                  subtotal_pesos, envio_pesos, total_pesos, destinatario, cotizacion,
                                  politica_version, version_catalogo)
             VALUES ('NOV-A-MANO','confirmado','ev-x','of-y','573001112233','of-1','w','p','P',1,
                     1000,0,1000,'{}'::jsonb,'{}'::jsonb,'v','v')`
          ),
        /duplicate key|unique/i,
        "el motor acepto una clave de evento repetida"
      );
    } finally {
      await c.end();
    }
  });

  test("el motor rechaza un total que no cuadra con sus partes", async () => {
    await listoParaGarantias();
    // El dominio ya lo calcula bien. Esto es el cinturon: si algun camino
    // futuro escribe un total incoherente, no entra.
    const c = await clienteCrudo();
    try {
      await c.query("INSERT INTO contactos (id) VALUES ('573009990000') ON CONFLICT DO NOTHING");
      await assert.rejects(
        () =>
          c.query(
            `INSERT INTO pedidos (codigo, estado, clave_de_evento, clave_de_oferta, contacto_id, oferta_id,
                                  wamid_confirmacion, producto_id, producto_nombre, cantidad,
                                  subtotal_pesos, envio_pesos, descuento_pesos, total_pesos,
                                  destinatario, cotizacion, politica_version, version_catalogo)
             VALUES ('NOV-DESCUADRE','confirmado','ev-d','of-d','573009990000','of-1','w','p','P',1,
                     50000, 10000, 0, 99999, '{}'::jsonb,'{}'::jsonb,'v','v')`
          ),
        /total_cuadra/i
      );
    } finally {
      await c.end();
    }
  });

  test("el motor exige que un cancelado tenga fecha de cancelacion", async () => {
    await listoParaGarantias();
    const c = await clienteCrudo();
    try {
      await c.query("INSERT INTO contactos (id) VALUES ('573009991111') ON CONFLICT DO NOTHING");
      await assert.rejects(
        () =>
          c.query(
            `INSERT INTO pedidos (codigo, estado, clave_de_evento, clave_de_oferta, contacto_id, oferta_id,
                                  wamid_confirmacion, producto_id, producto_nombre, cantidad,
                                  subtotal_pesos, envio_pesos, total_pesos, destinatario, cotizacion,
                                  politica_version, version_catalogo)
             VALUES ('NOV-SINFECHA','cancelado','ev-sf','of-sf','573009991111','of-1','w','p','P',1,
                     1000,0,1000,'{}'::jsonb,'{}'::jsonb,'v','v')`
          ),
        /cancelacion_coherente/i
      );
    } finally {
      await c.end();
    }
  });

  test("el motor rechaza un estado de pedido que no existe", async () => {
    await listoParaGarantias();
    const c = await clienteCrudo();
    try {
      await c.query("INSERT INTO contactos (id) VALUES ('573009992222') ON CONFLICT DO NOTHING");
      await assert.rejects(
        () =>
          c.query(
            `INSERT INTO pedidos (codigo, estado, clave_de_evento, clave_de_oferta, contacto_id, oferta_id,
                                  wamid_confirmacion, producto_id, producto_nombre, cantidad,
                                  subtotal_pesos, envio_pesos, total_pesos, destinatario, cotizacion,
                                  politica_version, version_catalogo)
             VALUES ('NOV-ESTADORARO','en_tramite','ev-er','of-er','573009992222','of-1','w','p','P',1,
                     1000,0,1000,'{}'::jsonb,'{}'::jsonb,'v','v')`
          ),
        /pedidos_estado_check|check constraint/i
      );
    } finally {
      await c.end();
    }
  });

  // ----------------------------------------------------------------------
  // Conversaciones: los tres campos que el esquema viejo perdia
  // ----------------------------------------------------------------------

  test("la conversacion conserva cotizacion, resumenMostrado y ventana", async () => {
    await listoParaGarantias();
    // Son los tres campos que faltaban en el esquema original. Sin
    // `resumenMostrado` un "si" no confirma nunca; sin `cotizacion` no hay
    // oferta que confirmar. Migrar sin ellos rompia el cierre en silencio.
    await vaciar();
    const repos = await crearRepos();
    try {
      await repos.conversaciones.guardar({
        contactoId: "573001112233",
        estado: "pendiente_confirmacion",
        productoId: "producto-x",
        ofertaId: "of-77",
        resumenMostrado: true,
        cotizacion: { total: 89000, cantidad: 1, moneda: "COP" },
        ficha: { nombre: { valor: "Ana", estado: "confirmado", historial: [] } },
        ventana: [{ texto: "hola", wamid: "w1" }],
        ultimoWamid: "w1",
      });

      const otra = await repos.reabrir();
      try {
        const c = await otra.conversaciones.obtener("573001112233");
        assert.equal(c.resumenMostrado, true, "se perdio resumenMostrado: un si no confirmaria nunca");
        assert.equal(c.cotizacion.total, 89000, "se perdio la cotizacion vigente");
        assert.equal(c.ventana.length, 1, "se perdio la ventana de mensajes");
        assert.equal(c.ficha.nombre.estado, "confirmado");
        assert.equal(c.estado, "pendiente_confirmacion");
        assert.equal(c.ofertaId, "of-77");
      } finally {
        await otra.cerrar();
      }
    } finally {
      await repos.cerrar();
    }
  });

  test("guardar la conversacion dos veces en paralelo no la corrompe", async () => {
    await listoParaGarantias();
    await vaciar();
    const a = await crearRepos();
    const b = await crearRepos();
    try {
      await Promise.all([
        a.conversaciones.guardar({ contactoId: "573001112233", estado: "cotizado", resumenMostrado: false }),
        b.conversaciones.guardar({ contactoId: "573001112233", estado: "capturando_datos", resumenMostrado: true }),
      ]);
      const c = await a.conversaciones.obtener("573001112233");
      // Gana una de las dos, entera. Lo que no puede pasar es una mezcla.
      assert.ok(["cotizado", "capturando_datos"].includes(c.estado));
      if (c.estado === "cotizado") assert.equal(c.resumenMostrado, false);
      if (c.estado === "capturando_datos") assert.equal(c.resumenMostrado, true);
    } finally {
      await a.cerrar();
      await b.cerrar();
    }
  });

  // ----------------------------------------------------------------------
  // Snapshot e historial
  // ----------------------------------------------------------------------

  test("los importes van en PESOS enteros, no en centavos", async () => {
    await listoParaGarantias();
    await vaciar();
    const repos = await crearRepos();
    try {
      await repos.pedidos.crearSiNoExiste(pedidoDeEjemplo({ id: "NOV-PESOS" }));
      const c = await clienteCrudo();
      try {
        const { rows } = await c.query("SELECT total_pesos, subtotal_pesos FROM pedidos WHERE codigo = 'NOV-PESOS'");
        // 89000 pesos, no 8900000 centavos. Un x100 en un total es una
        // discusion con un cliente.
        assert.equal(Number(rows[0].total_pesos), 89000);
        assert.equal(Number(rows[0].subtotal_pesos), 89000);
      } finally {
        await c.end();
      }
      const leido = await repos.pedidos.obtener("NOV-PESOS");
      assert.equal(leido.cotizacion.total, 89000);
    } finally {
      await repos.cerrar();
    }
  });

  test("el historial es append-only y reescribir no lo duplica", async () => {
    await listoParaGarantias();
    await vaciar();
    const repos = await crearRepos();
    try {
      const { pedido } = await repos.pedidos.crearSiNoExiste(pedidoDeEjemplo({ id: "NOV-HIST" }));

      const modificado = {
        ...pedido,
        version: 2,
        estado: "modificado",
        historial: [...pedido.historial, { version: 2, accion: "modificado", cuando: new Date().toISOString() }],
      };
      await repos.pedidos.reemplazar(modificado);
      // Reescribir lo mismo otra vez (reintento, recuperacion) no duplica.
      await repos.pedidos.reemplazar(modificado);

      const leido = await repos.pedidos.obtener("NOV-HIST");
      assert.equal(leido.historial.length, 2, `historial duplicado: ${leido.historial.length} entradas`);
      assert.deepEqual(leido.historial.map((h) => h.accion), ["creado", "modificado"]);
    } finally {
      await repos.cerrar();
    }
  });

  test("el snapshot de la cotizacion vuelve igual que se guardo", async () => {
    await listoParaGarantias();
    await vaciar();
    const repos = await crearRepos();
    try {
      const p = pedidoDeEjemplo({ id: "NOV-SNAP" });
      await repos.pedidos.crearSiNoExiste(p);
      const leido = await repos.pedidos.obtener("NOV-SNAP");
      assert.deepEqual(leido.cotizacion, p.cotizacion);
      assert.deepEqual(leido.destinatario, p.destinatario);
      assert.equal(leido.conversacionId, p.conversacionId);
    } finally {
      await repos.cerrar();
    }
  });

  // ----------------------------------------------------------------------
  // Migraciones
  // ----------------------------------------------------------------------

  test("migrar dos veces no vuelve a aplicar nada", async () => {
    await listoParaGarantias();
    const { migrar } = require("../src/almacen/repos/postgres/migrar");
    const c = await clienteCrudo();
    try {
      const r = await migrar({ cliente: c });
      assert.equal(r.aplicadas.length, 0, "volvio a aplicar una migracion ya aplicada");
      assert.ok(r.yaEstaban.length >= 1);
    } finally {
      await c.end();
    }
  });

  test("si una migracion ya aplicada cambia de contenido, el ejecutor PARA", async () => {
    await listoParaGarantias();
    // Sin esto, editar una migracion ya aplicada deja la base en un estado
    // que no corresponde a ningun archivo del repositorio, y nadie se entera
    // hasta que algo no cuadra.
    const { migrar } = require("../src/almacen/repos/postgres/migrar");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");

    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "novika-mig-"));
    fs.writeFileSync(path.join(carpeta, "900-prueba.sql"), "CREATE TABLE IF NOT EXISTS prueba_checksum (x int);");

    const c = await clienteCrudo();
    try {
      await c.query("DROP TABLE IF EXISTS prueba_checksum");
      await c.query("DELETE FROM migraciones WHERE nombre = '900-prueba.sql'");

      const primera = await migrar({ cliente: c, carpeta });
      assert.ok(primera.aplicadas.includes("900-prueba.sql"));

      // Alguien edita la migracion ya aplicada.
      fs.writeFileSync(path.join(carpeta, "900-prueba.sql"), "CREATE TABLE IF NOT EXISTS prueba_checksum (x int, y int);");

      await assert.rejects(() => migrar({ cliente: c, carpeta }), /contenido cambio|checksum/i);
    } finally {
      await c.query("DROP TABLE IF EXISTS prueba_checksum").catch(() => {});
      await c.query("DELETE FROM migraciones WHERE nombre = '900-prueba.sql'").catch(() => {});
      await c.end();
    }
  });

  test("el arranque falla si el esquema no esta aplicado", async () => {
    await listoParaGarantias();
    // "Nada de crear tablas al arrancar": si falta el esquema, se dice y se
    // para, en vez de improvisar DDL en un momento que nadie esta mirando.
    const { crearRepos: fabrica } = require("../src/almacen/repos");
    const c = await clienteCrudo();
    try {
      await c.query("ALTER TABLE pedidos RENAME TO pedidos_escondidos");
      await assert.rejects(() => fabrica({ databaseUrl: DSN }), /no tiene el esquema|npm run migrar/i);
    } finally {
      await c.query("ALTER TABLE pedidos_escondidos RENAME TO pedidos").catch(() => {});
      await c.end();
    }
  });
});

// --------------------------------------------------------------------------
// Sin base: lo que SI se puede comprobar
// --------------------------------------------------------------------------

test("la deteccion de TLS no obliga a configurar una variable mas", () => {
  const { opcionesDeSsl } = require("../src/almacen/repos/postgres");
  // Interna de Render: red privada, sin TLS.
  assert.equal(opcionesDeSsl("postgres://u:p@dpg-abc-a.oregon-postgres.internal/novika"), false);
  // Local: sin TLS.
  assert.equal(opcionesDeSsl("postgres://u:p@127.0.0.1:5432/novika"), false);
  assert.equal(opcionesDeSsl("postgres://u:p@localhost:5432/novika"), false);
  // Externa: TLS.
  assert.deepEqual(opcionesDeSsl("postgres://u:p@dpg-abc-a.oregon-postgres.render.com/novika"), {
    rejectUnauthorized: false,
  });
  // Explicito manda.
  assert.equal(opcionesDeSsl("postgres://u:p@algo.remoto/novika?sslmode=disable"), false);
});

test("la traduccion a fila no pierde ni inventa importes", () => {
  const { pedidoAFila } = require("../src/almacen/repos/postgres");
  const fila = pedidoAFila({
    id: "NOV-X",
    estado: "confirmado",
    cotizacion: { subtotal: 50000, envio: 12000, descuento: 2000, total: 60000, moneda: "COP" },
    producto: { id: "p", nombre: "P" },
  });
  assert.equal(fila.subtotal_pesos, 50000);
  assert.equal(fila.envio_pesos, 12000);
  assert.equal(fila.descuento_pesos, 2000);
  assert.equal(fila.total_pesos, 60000);
  // El invariante que comprueba el motor.
  assert.equal(fila.total_pesos, fila.subtotal_pesos + fila.envio_pesos - fila.descuento_pesos);
});

test("un pedido no cancelado nunca lleva fecha de cancelacion", () => {
  const { pedidoAFila } = require("../src/almacen/repos/postgres");
  const fila = pedidoAFila({
    id: "NOV-Y",
    estado: "confirmado",
    canceladoEn: "2026-01-01T00:00:00Z", // alguien lo dejo puesto por error
    motivoCancelacion: "ups",
    cotizacion: { subtotal: 1000, envio: 0, descuento: 0, total: 1000 },
    producto: { id: "p", nombre: "P" },
  });
  assert.equal(fila.cancelado_en, null);
  assert.equal(fila.motivo_cancelacion, null);
});
