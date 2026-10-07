"use strict";

// ==========================================================================
// CUTOVER ARCHIVOS -> POSTGRESQL
//
// Lo que se verifica aqui es lo unico que importa de una migracion de datos:
// que NO PIERDA y NO DUPLIQUE. Lo demas es comodidad.
//
// Los casos que cubre vienen de lo que de verdad pasa en un cutover real:
//
//   - se corta a mitad y hay que repetirlo  -> idempotencia
//   - un pedido ya estaba cancelado          -> el estado final se conserva
//   - un pedido tenia historial de cambios   -> no se pierde ni se duplica
//   - alguien lo corre dos veces por si acaso -> mismos conteos
//
// Sin DATABASE_URL_PRUEBAS se saltan: el resto de la bateria tiene que
// correr en CI sin base de datos.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR_PRUEBA = require("./ayuda").entornoDePrueba();

// EL CUTOVER EXIGE CONGELAR LAS ESCRITURAS y se niega a copiar sin la marca.
// Esta bateria prueba la MECANICA de la copia -no perder, no duplicar,
// estados finales-, asi que congela una vez y sigue. La exigencia en si, y
// lo que pasa cuando el origen se mueve durante la copia, estan en
// test/f3-ventana-cutover.test.js.
require("../src/almacen/congelar").congelar(DIR_PRUEBA, "bateria de cutover");

const ayudaPg = require("./ayuda-pg");
const { sinBase, motivoSalto } = ayudaPg;
// Esquema propio de ESTE archivo, para no pisar al de f3-postgres.
const ESQUEMA = "prueba_f3_cutover";
let DSN = "";

const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { copiar } = require("../src/cutover");
const { cotizar } = require("../src/dominio/cotizador");
const dominioPedido = require("../src/dominio/pedido");

// --------------------------------------------------------------------------
// Datos de origen realistas: construidos con el dominio, no a mano
// --------------------------------------------------------------------------

function pedidoReal({ contactoId = "573001112233", ofertaId = "of-1", wamid = "wamid.A", cantidad = 1 } = {}) {
  const producto = {
    id: "producto-x",
    nombre: "Producto X",
    activo: true,
    motorDePrecio: "tabla",
    precios: { 1: 89000, 2: 150000 },
    logistica: { politicaEnvio: { tipo: "incluido" } },
  };
  const cot = cotizar({
    producto,
    cantidad,
    destino: { ciudad: "Medellín", departamento: "Antioquia" },
  }).cotizacion;

  return dominioPedido.construir({
    cotizacion: cot,
    datos: {
      nombre: "Ana Pérez",
      telefono: "3001112233",
      ciudad: "Medellín",
      departamento: "Antioquia",
      direccion: "Calle 45 # 23-10",
    },
    contactoId,
    conversacionId: contactoId,
    ofertaId,
    wamidConfirmacion: wamid,
  }).pedido;
}

async function origenConDatos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-cutover-"));
  const repos = await crearReposDeArchivos({ dir });

  await repos.contactos.guardar({ id: "573001112233", telefono: "3001112233", nombrePerfil: "Ana" });
  await repos.contactos.guardar({ id: "573009998877", telefono: "3009998877", nombrePerfil: "Luis" });

  await repos.conversaciones.guardar({
    contactoId: "573001112233",
    estado: "pendiente_confirmacion",
    productoId: "producto-x",
    ofertaId: "of-1",
    resumenMostrado: true,
    cotizacion: { total: 89000, cantidad: 1, moneda: "COP" },
    ficha: { nombre: { valor: "Ana Pérez", estado: "confirmado", historial: [] } },
    ventana: [{ texto: "hola", wamid: "w1" }],
  });
  await repos.conversaciones.guardar({ contactoId: "573009998877", estado: "explorando", ficha: {} });

  // 1. confirmado
  const a = pedidoReal({ ofertaId: "of-1", wamid: "wamid.A" });
  await repos.pedidos.crearSiNoExiste(a);

  // 2. modificado, con historial de dos entradas
  const b = pedidoReal({ ofertaId: "of-2", wamid: "wamid.B", cantidad: 2 });
  await repos.pedidos.crearSiNoExiste(b);
  const modificado = dominioPedido.modificar({
    pedido: b,
    cambios: { direccion: "Carrera 70 # 1-2" },
    porQue: "lo pidio el cliente",
  }).pedido;
  await repos.pedidos.reemplazar(modificado);

  // 3. cancelado
  const c = pedidoReal({ contactoId: "573009998877", ofertaId: "of-3", wamid: "wamid.C" });
  await repos.pedidos.crearSiNoExiste(c);
  const cancelado = dominioPedido.cancelar({ pedido: c, motivo: "se arrepintio" }).pedido;
  await repos.pedidos.reemplazar(cancelado);

  return { dir, repos, ids: { confirmado: a.id, modificado: modificado.id, cancelado: cancelado.id } };
}

async function destinoLimpio() {
  // Esquema nuevo en cada prueba: asi ninguna depende del estado que dejo
  // la anterior.
  const r = await ayudaPg.prepararEsquema(ESQUEMA);
  DSN = r.dsn;
  return ayudaPg.crearRepos(DSN);
}

// --------------------------------------------------------------------------
// Sin base: lo que si se puede comprobar
// --------------------------------------------------------------------------

test("el inventario del disco lee todo y NO esta en el contrato", async () => {
  const { repos } = await origenConDatos();
  try {
    const inv = await repos._inventario();
    assert.equal(inv.contactos.length, 2);
    assert.equal(inv.conversaciones.length, 2);
    assert.equal(inv.pedidos.length, 3);

    // Fuera del contrato a proposito: el sistema en marcha nunca necesita
    // leer todos los pedidos de golpe.
    const { METODOS } = require("../src/almacen/repos/contrato");
    assert.equal(METODOS.raiz.includes("_inventario"), false);
    assert.equal(METODOS.pedidos.includes("_inventario"), false);
  } finally {
    await repos.cerrar();
  }
});

test("un pedido corrupto no detiene el inventario, pero tampoco se inventa", async () => {
  const { dir, repos } = await origenConDatos();
  try {
    fs.writeFileSync(path.join(dir, "pedidos", "NOV-ROTO.json"), "{no es json");
    const inv = await repos._inventario();
    // Los 3 buenos siguen; el roto no aparece y quedo apartado para que una
    // persona lo recupere a mano.
    assert.equal(inv.pedidos.length, 3);
    assert.equal(fs.readdirSync(path.join(dir, "pedidos")).filter((n) => n.includes(".roto-")).length, 1);
  } finally {
    await repos.cerrar();
  }
});

// --------------------------------------------------------------------------
// Con base real
// --------------------------------------------------------------------------

describe("cutover contra PostgreSQL real", { skip: sinBase ? motivoSalto : false }, () => {
  test("la simulacion no escribe nada", async () => {
    const { repos: origen } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      const informe = await copiar({ origen, destino, simular: true, exigirDrenaje: false });
      assert.equal(informe.simulado, true);
      assert.equal(informe.pedidos.origen, 3);
      // Nada escrito.
      assert.equal((await destino.estado()).pedidos, 0);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("el cutover copia todo y los conteos cuadran", async () => {
    const { repos: origen, ids } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      const informe = await copiar({ origen, destino, exigirDrenaje: false });

      assert.deepEqual(informe.problemas, [], `problemas: ${informe.problemas.join(" | ")}`);
      assert.equal(informe.contactos.copiados, 2);
      assert.equal(informe.conversaciones.copiados, 2);
      assert.equal(informe.pedidos.copiados, 3);

      const estado = await destino.estado();
      assert.equal(estado.pedidos, 3);
      assert.equal(estado.conversaciones, 2);
      assert.equal(estado.contactos, 2);

      // Y los tres pedidos estan, cada uno con su estado final.
      assert.equal((await destino.pedidos.obtener(ids.confirmado)).estado, "confirmado");
      assert.equal((await destino.pedidos.obtener(ids.modificado)).estado, "modificado");
      assert.equal((await destino.pedidos.obtener(ids.cancelado)).estado, "cancelado");
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("IDEMPOTENTE: correrlo dos veces no duplica nada", async () => {
    // El caso real: la primera vez se corta a mitad y hay que repetirlo.
    const { repos: origen } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      await copiar({ origen, destino, exigirDrenaje: false });
      const primera = await destino.estado();

      const segunda = await copiar({ origen, destino, exigirDrenaje: false });
      const despues = await destino.estado();

      assert.deepEqual(despues, primera, "el segundo pase cambio los conteos");
      assert.equal(segunda.pedidos.copiados, 0);
      assert.equal(segunda.pedidos.yaEstaban, 3);
      assert.deepEqual(segunda.problemas, []);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("el pedido CANCELADO conserva su estado, su motivo y su fecha", async () => {
    // Si el cutover lo trajera como "confirmado", un pedido que el cliente
    // cancelo volveria a la cola de despacho. Es la peor forma de duplicar.
    const { repos: origen, ids } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      await copiar({ origen, destino, exigirDrenaje: false });
      const p = await destino.pedidos.obtener(ids.cancelado);
      assert.equal(p.estado, "cancelado");
      assert.equal(p.motivoCancelacion, "se arrepintio");
      assert.ok(p.canceladoEn);

      // Y no sale en los activos.
      assert.equal(await destino.pedidos.activoDeContacto("573009998877"), null);
      assert.equal((await destino.pedidos.porContacto("573009998877")).length, 0);
      assert.equal((await destino.pedidos.porContacto("573009998877", { incluirCancelados: true })).length, 1);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("el historial del pedido modificado llega completo y sin duplicar", async () => {
    const { repos: origen, ids } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      await copiar({ origen, destino, exigirDrenaje: false });
      await copiar({ origen, destino, exigirDrenaje: false }); // segundo pase

      const enDisco = await origen.pedidos.obtener(ids.modificado);
      const enBase = await destino.pedidos.obtener(ids.modificado);

      assert.equal(enBase.historial.length, enDisco.historial.length);
      assert.deepEqual(
        enBase.historial.map((h) => h.accion),
        enDisco.historial.map((h) => h.accion)
      );
      assert.equal(enBase.version, enDisco.version);
      assert.equal(enBase.destinatario.direccion, "Carrera 70 # 1-2");
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("el snapshot comercial sobrevive al cutover intacto", async () => {
    // Si manana sube el precio, estos pedidos tienen que seguir valiendo lo
    // que el cliente acepto. El snapshot es lo que lo garantiza.
    const { repos: origen, ids } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      await copiar({ origen, destino, exigirDrenaje: false });
      const enDisco = await origen.pedidos.obtener(ids.confirmado);
      const enBase = await destino.pedidos.obtener(ids.confirmado);

      assert.deepEqual(enBase.cotizacion, enDisco.cotizacion);
      assert.deepEqual(enBase.destinatario, enDisco.destinatario);
      assert.equal(enBase.firmaDeCondiciones, enDisco.firmaDeCondiciones);
      assert.equal(enBase.cotizacion.politicaVersion, enDisco.cotizacion.politicaVersion);
      assert.equal(enBase.cotizacion.versionCatalogo, enDisco.cotizacion.versionCatalogo);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("la conversacion llega con los tres campos que deciden una venta", async () => {
    const { repos: origen } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      await copiar({ origen, destino, exigirDrenaje: false });
      const c = await destino.conversaciones.obtener("573001112233");
      assert.equal(c.resumenMostrado, true, "sin esto, un si no confirmaria tras el cutover");
      assert.equal(c.cotizacion.total, 89000);
      assert.equal(c.ventana.length, 1);
      assert.equal(c.estado, "pendiente_confirmacion");
      assert.equal(c.ficha.nombre.estado, "confirmado");
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("tras el cutover, la idempotencia de pedidos sigue vigente en la base", async () => {
    // Lo que importa del cutover no es solo que los datos lleguen: es que
    // las garantias viajen con ellos. Un replay de Meta despues de migrar no
    // puede crear un pedido.
    const { repos: origen, ids } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      await copiar({ origen, destino, exigirDrenaje: false });

      const original = await destino.pedidos.obtener(ids.confirmado);
      const replay = { ...original, id: "NOV-REPLAY-TRAS-CUTOVER" };
      const r = await destino.pedidos.crearSiNoExiste(replay);

      assert.equal(r.creado, false);
      assert.equal(r.pedido.id, ids.confirmado);
      assert.equal((await destino.estado()).pedidos, 3);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("si dos pedidos distintos comparten clave, el cutover lo DICE y falla", async () => {
    // El unico caso que no se puede resolver sin una persona. Un cutover que
    // lo tapara dejaria un pedido fuera sin que nadie lo supiera.
    const { repos: origen } = await origenConDatos();
    const destino = await destinoLimpio();
    try {
      await copiar({ origen, destino, exigirDrenaje: false });

      // Se fabrica el choque: otro pedido con la clave de evento de uno que
      // ya esta, pero con otro id.
      const inv = await origen._inventario();
      const impostor = { ...inv.pedidos[0], id: "NOV-IMPOSTOR" };
      await origen.pedidos.reemplazar(impostor);

      const informe = await copiar({ origen, destino, exigirDrenaje: false });
      assert.ok(informe.problemas.length > 0, "el choque de claves paso inadvertido");
      assert.ok(informe.pedidos.noCreados.length > 0);
      assert.match(informe.problemas.join(" "), /NOV-IMPOSTOR/);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });
});
