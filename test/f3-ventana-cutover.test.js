"use strict";

// ==========================================================================
// LA VENTANA DE ESCRITURAS DEL CUTOVER
//
// Esta bateria existe por un agujero medido, no supuesto. La primera version
// del cutover copiaba y comparaba conteos al final; un mensaje que llegaba
// MIENTRAS copiaba quedaba fuera:
//
//   pedidos en el origen al terminar : 3
//   pedidos copiados al destino      : 2
//   problemas que reporta el cutover : []
//
// Cutover "exitoso" con un pedido fuera. La peor forma de fallar, porque
// nadie va a volver a mirar.
//
// La correccion tiene dos mitades y aqui se prueban las dos:
//
//   1. el cutover EXIGE la congelacion y se niega a copiar sin ella;
//   2. toma una HUELLA del origen antes y despues, asi que si algo cambia
//      -aunque la congelacion fallara o alguien escribiera por otro camino-
//      el cutover FALLA en vez de mentir.
//
// Y lo que hace que congelar no cueste ventas: mientras esta congelado el
// webhook sigue contestando 200 y RECLAMANDO el trabajo en el disco, pero no
// lo procesa. Un evento reclamado y sin terminar es exactamente lo que el
// recuperador busca al arrancar.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
const DIR_PRUEBA = ayuda.entornoDePrueba();
const ayudaPg = require("./ayuda-pg");

const congelacion = require("../src/almacen/congelar");
const { copiar, huella, diferencias } = require("../src/cutover");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { cotizar } = require("../src/dominio/cotizador");
const dominioPedido = require("../src/dominio/pedido");

const ESQUEMA = "prueba_f3_ventana";

// --------------------------------------------------------------------------
// La marca de congelacion
// --------------------------------------------------------------------------

test("congelar y descongelar son idempotentes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-freeze-"));

  assert.equal(congelacion.estado(dir).congelado, false);

  const primera = congelacion.congelar(dir, "cutover");
  assert.equal(primera.congelado, true);
  assert.ok(primera.desde);

  // Congelar dos veces conserva la marca original: la antiguedad del
  // congelado es lo que delata un olvido, y reiniciarla lo escondería.
  const segunda = congelacion.congelar(dir, "otra cosa");
  assert.equal(segunda.desde, primera.desde);
  assert.equal(segunda.porQue, "cutover");

  congelacion.descongelar(dir);
  assert.equal(congelacion.estado(dir).congelado, false);
  // Descongelar dos veces no revienta.
  assert.doesNotThrow(() => congelacion.descongelar(dir));
});

test("la marca sobrevive al reinicio del proceso", () => {
  // Vive en DATA_DIR, que es el disco persistente: si se congela y el
  // servicio se reinicia, sigue congelado. Es lo que se quiere.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-freeze2-"));
  congelacion.congelar(dir, "cutover");
  assert.ok(fs.existsSync(path.join(dir, "CONGELADO.json")));

  delete require.cache[require.resolve("../src/almacen/congelar")];
  const otra = require("../src/almacen/congelar");
  assert.equal(otra.estado(dir).congelado, true);
});

test("una marca ILEGIBLE se interpreta como congelado", () => {
  // Ante la duda, no escribir es reversible. Escribir sobre un origen que
  // alguien creia quieto, no.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-freeze3-"));
  fs.writeFileSync(path.join(dir, "CONGELADO.json"), "{roto");
  const e = congelacion.estado(dir);
  assert.equal(e.congelado, true);
  assert.match(e.porQue, /ilegible/);
});

test("el estado dice cuantas horas lleva congelado", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-freeze4-"));
  const hace3h = new Date(Date.now() - 3 * 3600000).toISOString();
  fs.writeFileSync(path.join(dir, "CONGELADO.json"), JSON.stringify({ desde: hace3h, porQue: "olvidado" }));
  // Un congelado olvidado es un bot que acumula mensajes sin atender.
  assert.ok(congelacion.estado(dir).horas >= 2.9);
});

// --------------------------------------------------------------------------
// La huella
// --------------------------------------------------------------------------

test("la huella detecta un alta, una baja Y una modificacion", () => {
  const base = {
    contactos: [{ id: "c1", actualizadoEn: "2026-01-01T00:00:00Z" }],
    conversaciones: [{ contactoId: "c1", actualizadoEn: "2026-01-01T00:00:00Z" }],
    pedidos: [{ id: "NOV-1", version: 1, estado: "confirmado", actualizadoEn: "2026-01-01T00:00:00Z" }],
  };

  const h = huella(base);
  assert.equal(huella(base).resumen, h.resumen, "la huella no es estable");

  // Alta
  const conAlta = { ...base, pedidos: [...base.pedidos, { id: "NOV-2", version: 1, estado: "confirmado" }] };
  assert.notEqual(huella(conAlta).resumen, h.resumen);

  // Baja
  assert.notEqual(huella({ ...base, pedidos: [] }).resumen, h.resumen);

  // MODIFICACION con el mismo conteo: es la que un conteo no detecta.
  const conCambio = {
    ...base,
    pedidos: [{ id: "NOV-1", version: 2, estado: "modificado", actualizadoEn: "2026-01-02T00:00:00Z" }],
  };
  const hCambio = huella(conCambio);
  assert.equal(hCambio.pedidos, h.pedidos, "mismo conteo");
  assert.notEqual(hCambio.resumen, h.resumen, "una modificacion silenciosa paso inadvertida");

  assert.match(diferencias(h, hCambio).join(" "), /contenido distinto/);
});

// --------------------------------------------------------------------------
// Con PostgreSQL real
// --------------------------------------------------------------------------

describe("ventana de escrituras contra PostgreSQL real", { skip: ayudaPg.sinBase ? ayudaPg.motivoSalto : false }, () => {
  const producto = {
    id: "producto-x",
    nombre: "Producto X",
    activo: true,
    motorDePrecio: "tabla",
    precios: { 1: 89000 },
    logistica: { politicaEnvio: { tipo: "incluido" } },
  };

  function pedidoNuevo(ofertaId, wamid) {
    const cot = cotizar({
      producto,
      cantidad: 1,
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
      contactoId: "573001112233",
      conversacionId: "573001112233",
      ofertaId,
      wamidConfirmacion: wamid,
    }).pedido;
  }

  async function origenConDosPedidos() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-vent-"));
    const repos = await crearReposDeArchivos({ dir });
    await repos.contactos.guardar({ id: "573001112233", telefono: "3001112233" });
    await repos.pedidos.crearSiNoExiste(pedidoNuevo("of-1", "wamid.1"));
    await repos.pedidos.crearSiNoExiste(pedidoNuevo("of-2", "wamid.2"));
    return { dir, repos };
  }

  async function destinoLimpio() {
    const r = await ayudaPg.prepararEsquema(ESQUEMA);
    return ayudaPg.crearRepos(r.dsn);
  }

  test("SIN congelar, el cutover se NIEGA a copiar", async () => {
    const { dir, repos: origen } = await origenConDosPedidos();
    const destino = await destinoLimpio();
    try {
      congelacion.descongelar(dir);
      const informe = await copiar({ origen, destino, dirDatos: dir });

      assert.ok(informe.problemas.length > 0, "copio sin congelar");
      assert.match(informe.problemas.join(" "), /NO estan congeladas/);
      assert.match(informe.problemas.join(" "), /npm run congelar/);
      // Y no escribio nada.
      assert.equal((await destino.estado()).pedidos, 0);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("CON congelar, el cutover copia y verifica la huella", async () => {
    const { dir, repos: origen } = await origenConDosPedidos();
    const destino = await destinoLimpio();
    try {
      congelacion.congelar(dir, "prueba");
      const informe = await copiar({ origen, destino, dirDatos: dir });

      assert.deepEqual(informe.problemas, [], informe.problemas.join(" | "));
      assert.equal(informe.pedidos.copiados, 2);
      assert.equal((await destino.estado()).pedidos, 2);
      // La huella de antes y la de despues tienen que coincidir.
      assert.equal(informe.huellaAntes.resumen, informe.huellaDespues.resumen);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("REGRESION: una escritura concurrente NO produce un cutover falsamente exitoso", async () => {
    // EL AGUJERO ORIGINAL. Se fuerza exactamente el escenario medido: un
    // pedido nace mientras el cutover esta copiando.
    //
    // Antes: 3 en origen, 2 copiados, problemas []. Ahora tiene que FALLAR.
    const { dir, repos: origen } = await origenConDosPedidos();
    const destino = await destinoLimpio();
    try {
      congelacion.congelar(dir, "prueba");

      const copia = copiar({ origen, destino, dirDatos: dir });
      // Escritura concurrente, saltandose la congelacion a proposito: es lo
      // que pasaria si el candado fallara o alguien escribiera por otro
      // camino.
      await new Promise((r) => setTimeout(r, 2));
      await origen.pedidos.crearSiNoExiste(pedidoNuevo("of-3", "wamid.3"));
      const informe = await copia;

      const enOrigen = (await origen._inventario()).pedidos.length;
      assert.equal(enOrigen, 3, "el escenario no se reprodujo");

      assert.ok(informe.problemas.length > 0, "el cutover se declaro exitoso con un pedido fuera");
      assert.match(informe.problemas.join(" "), /EL ORIGEN CAMBIO DURANTE LA COPIA/);
      // Y dice que se puede repetir sin miedo, porque es idempotente.
      assert.match(informe.problemas.join(" "), /repite el cutover/);
      assert.notEqual(informe.huellaAntes.resumen, informe.huellaDespues.resumen);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("tras detectar el cambio, repetir el cutover SI lo completa", async () => {
    // El problema es recuperable: por eso el mensaje de error lo dice.
    const { dir, repos: origen } = await origenConDosPedidos();
    const destino = await destinoLimpio();
    try {
      congelacion.congelar(dir, "prueba");

      const copia = copiar({ origen, destino, dirDatos: dir });
      await new Promise((r) => setTimeout(r, 2));
      await origen.pedidos.crearSiNoExiste(pedidoNuevo("of-3", "wamid.3"));
      const primera = await copia;
      assert.ok(primera.problemas.length > 0);

      // Segundo pase, ahora sin nadie escribiendo.
      const segunda = await copiar({ origen, destino, dirDatos: dir });
      assert.deepEqual(segunda.problemas, [], segunda.problemas.join(" | "));
      assert.equal((await destino.estado()).pedidos, 3);
      assert.equal(segunda.huellaAntes.resumen, segunda.huellaDespues.resumen);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  test("una MODIFICACION concurrente tambien se detecta, no solo un alta", async () => {
    // Un conteo no la ve: antes y despues hay los mismos pedidos. La huella
    // si, porque incluye version, estado y fecha de actualizacion.
    const { dir, repos: origen } = await origenConDosPedidos();
    const destino = await destinoLimpio();
    try {
      congelacion.congelar(dir, "prueba");
      const inventario = await origen._inventario();
      const victima = inventario.pedidos[0];

      const copia = copiar({ origen, destino, dirDatos: dir });
      await new Promise((r) => setTimeout(r, 2));
      const modificado = dominioPedido.modificar({
        pedido: victima,
        cambios: { direccion: "Carrera 70 # 1-2" },
      }).pedido;
      await origen.pedidos.reemplazar(modificado);
      const informe = await copia;

      assert.equal(informe.huellaAntes.pedidos, informe.huellaDespues.pedidos, "mismo conteo");
      assert.ok(informe.problemas.length > 0, "una modificacion concurrente paso inadvertida");
      assert.match(informe.problemas.join(" "), /EL ORIGEN CAMBIO/);
    } finally {
      await destino.cerrar();
      await origen.cerrar();
    }
  });

  // ----------------------------------------------------------------------
  // Rollback: PostgreSQL -> archivos
  // ----------------------------------------------------------------------

  test("el ROLLBACK copia de PostgreSQL a archivos", async () => {
    // Es el procedimiento correcto una vez que la base ha recibido
    // escrituras que el disco no tiene. Sin esto, "volver atras" seria
    // perderlas.
    const { dir, repos: archivos } = await origenConDosPedidos();
    const postgres = await destinoLimpio();
    try {
      congelacion.congelar(dir, "prueba");
      await copiar({ origen: archivos, destino: postgres, dirDatos: dir });

      // Ahora nace un pedido SOLO en PostgreSQL: operacion real sobre la base.
      await postgres.pedidos.crearSiNoExiste(pedidoNuevo("of-nuevo-en-pg", "wamid.PG"));
      assert.equal((await postgres.estado()).pedidos, 3);
      assert.equal((await archivos._inventario()).pedidos.length, 2);

      // Rollback.
      const vuelta = await copiar({ origen: postgres, destino: archivos, dirDatos: dir });
      assert.deepEqual(vuelta.problemas, [], vuelta.problemas.join(" | "));

      // El pedido exclusivo de PostgreSQL ya esta en el disco.
      assert.equal((await archivos._inventario()).pedidos.length, 3);
    } finally {
      await postgres.cerrar();
      await archivos.cerrar();
    }
  });

  test("el rollback tambien exige congelacion", async () => {
    const { dir, repos: archivos } = await origenConDosPedidos();
    const postgres = await destinoLimpio();
    try {
      congelacion.descongelar(dir);
      const informe = await copiar({ origen: postgres, destino: archivos, dirDatos: dir });
      assert.match(informe.problemas.join(" "), /NO estan congeladas/);
    } finally {
      await postgres.cerrar();
      await archivos.cerrar();
    }
  });

  test("el inventario de PostgreSQL devuelve los pedidos con su historial", async () => {
    const { dir, repos: archivos } = await origenConDosPedidos();
    const postgres = await destinoLimpio();
    try {
      congelacion.congelar(dir, "prueba");
      await copiar({ origen: archivos, destino: postgres, dirDatos: dir });

      const inv = await postgres._inventario();
      assert.equal(inv.pedidos.length, 2);
      assert.equal(inv.contactos.length, 1);
      assert.ok(inv.pedidos[0].historial.length >= 1, "el historial no vino en el inventario");
      assert.ok(inv.pedidos[0].cotizacion.total > 0);
    } finally {
      await postgres.cerrar();
      await archivos.cerrar();
    }
  });
});

// --------------------------------------------------------------------------
// El webhook congelado: reclama, no procesa, no pierde
// --------------------------------------------------------------------------

test("congelado, el webhook RECLAMA el trabajo pero NO lo procesa", async () => {
  // Es lo que hace que congelar no cueste ventas: el mensaje queda
  // reclamado en el disco y el recuperador lo procesa al arrancar.
  const trabajo = require("../src/almacen/trabajo");
  const { admitir, procesarAdmitidos } = require("../src/webhook/procesar");

  trabajo._reiniciar();
  congelacion.congelar(DIR_PRUEBA, "prueba");

  try {
    const cuerpo = ayuda.payloadDeTexto({ wamid: "wamid.CONGELADO", idNumero: "111111111111111" });
    const admision = admitir(cuerpo, "e1");

    assert.equal(admision.congelado, true);
    assert.equal(admision.admitidos.length, 1);
    assert.equal(admision.admitidos[0].diferido, true);
    // Durable: si no lo fuera, congelar perderia mensajes.
    assert.equal(admision.durable, true);

    const resultados = await procesarAdmitidos(admision.admitidos, "e1");
    assert.equal(resultados[0].accion, "diferido");

    // Y queda RECLAMADO, que es lo que el recuperador busca al arrancar.
    trabajo._olvidarMemoria();
    const pendientes = trabajo.paraRecuperar();
    assert.equal(pendientes.length, 1);
    assert.equal(pendientes[0].wamid, "wamid.CONGELADO");
  } finally {
    congelacion.descongelar(DIR_PRUEBA);
    trabajo._reiniciar();
  }
});

test("descongelado, el mismo mensaje SI se procesa", async () => {
  const trabajo = require("../src/almacen/trabajo");
  const { admitir } = require("../src/webhook/procesar");

  trabajo._reiniciar();
  congelacion.descongelar(DIR_PRUEBA);

  const cuerpo = ayuda.payloadDeTexto({ wamid: "wamid.NORMAL", idNumero: "111111111111111" });
  const admision = admitir(cuerpo, "e1");

  assert.equal(admision.congelado, false);
  assert.equal(admision.admitidos[0].diferido, undefined);
  trabajo._reiniciar();
});
