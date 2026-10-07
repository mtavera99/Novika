"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Son las PRUEBAS DE CONTRATO del almacenamiento, ejecutadas contra la
// implementacion de archivos. Su valor real es futuro: cuando exista el
// adaptador de PostgreSQL, tendra que pasar exactamente estas mismas
// pruebas. Migrar deja de ser "esperemos que funcione" y pasa a ser "la
// bateria esta verde o no lo esta".
//
// Dentro van los casos que de verdad importan:
//
//   - la retransmision del webhook no crea un segundo pedido;
//   - un "si" repetido no crea un segundo pedido;
//   - la idempotencia SOBREVIVE AL REINICIO del proceso (el reintento de
//     Meta puede llegar hasta 36 horas despues, con un despliegue en medio);
//   - ocho creaciones simultaneas de la misma oferta dejan UN pedido.
//
// Aqui tambien se prueba la cola por conversacion, que es lo que hace que la
// ultima sea cierta: Node es monohilo, pero cada `await` es un punto de
// entrada para otra tarea.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("./ayuda").entornoDePrueba();
const { pruebasDeContrato, revisarForma } = require("../src/almacen/repos/contrato");
const { crearReposDeArchivos, claveDeArchivo } = require("../src/almacen/repos/archivos");
const mutex = require("../src/almacen/mutex");

function carpetaNueva() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "novika-repos-"));
}

// --------------------------------------------------------------------------
// EL CONTRATO
// --------------------------------------------------------------------------
pruebasDeContrato({
  nombre: "archivos",
  crear: () => crearReposDeArchivos({ dir: carpetaNueva() }),
  test,
  assert,
});

// --------------------------------------------------------------------------
// Propias de la implementacion de archivos
// --------------------------------------------------------------------------

test("la implementacion de archivos cumple la forma del contrato", async () => {
  const repos = await crearReposDeArchivos({ dir: carpetaNueva() });
  const r = revisarForma(repos);
  assert.equal(r.ok, true, `faltan metodos: ${r.faltan.join(", ")}`);
});

test("los nombres de archivo NO contienen el telefono del cliente", async () => {
  // Un listado de directorio, un backup o una captura del disco no tienen
  // por que exponer la agenda de clientes.
  const dir = carpetaNueva();
  const repos = await crearReposDeArchivos({ dir });
  await repos.contactos.guardar({ id: "573001234567", telefono: "3001234567" });
  await repos.conversaciones.guardar({ contactoId: "573001234567", estado: "nuevo" });

  const todos = [];
  const recorrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) recorrer(p);
      else todos.push(e.name);
    }
  };
  recorrer(dir);

  assert.ok(todos.length > 0, "no se escribio nada");
  for (const nombre of todos) {
    assert.equal(nombre.includes("3001234567"), false, `el telefono aparece en el nombre: ${nombre}`);
    assert.equal(nombre.includes("573001234567"), false, `el telefono aparece en el nombre: ${nombre}`);
  }
});

test("el telefono SI esta dentro del archivo, donde hace falta", async () => {
  const repos = await crearReposDeArchivos({ dir: carpetaNueva() });
  await repos.contactos.guardar({ id: "573001234567", telefono: "3001234567" });
  const leido = await repos.contactos.obtener("573001234567");
  assert.equal(leido.telefono, "3001234567");
});

test("claveDeArchivo es estable y no reversible a simple vista", () => {
  const a = claveDeArchivo("573001234567");
  assert.equal(a, claveDeArchivo("573001234567"));
  assert.notEqual(a, claveDeArchivo("573009998888"));
  assert.equal(a.includes("3001234567"), false);
});

test("un archivo de pedido corrupto se aparta y no tumba la consulta", async () => {
  const dir = carpetaNueva();
  const repos = await crearReposDeArchivos({ dir });
  await repos.pedidos.crearSiNoExiste({
    id: "NOV-BUENO",
    estado: "confirmado",
    contactoId: "c1",
    claveDeEvento: "ev-1",
    claveDeOferta: "of-1",
    creadoEn: new Date().toISOString(),
  });

  fs.writeFileSync(path.join(dir, "pedidos", "NOV-ROTO.json"), "{no es json");

  // El pedido bueno sigue consultable; el roto queda apartado para poder
  // recuperarlo a mano. Un pedido ilegible se arregla; uno sobrescrito, no.
  const todos = await repos.pedidos.porContacto("c1");
  assert.equal(todos.length, 1);
  assert.equal(todos[0].id, "NOV-BUENO");
  const apartados = fs.readdirSync(path.join(dir, "pedidos")).filter((n) => n.includes(".roto-"));
  assert.equal(apartados.length, 1);
});

test("con dos pedidos vivos, activoDeContacto NO elige", async () => {
  // Devolver "alguno" seria modificar el pedido equivocado, que es justo el
  // error que se quiere evitar. Dos pedidos vivos es una anomalia y tiene
  // que verla una persona.
  const repos = await crearReposDeArchivos({ dir: carpetaNueva() });
  const base = {
    estado: "confirmado",
    contactoId: "c1",
    creadoEn: new Date().toISOString(),
  };
  await repos.pedidos.crearSiNoExiste({ ...base, id: "NOV-A", claveDeEvento: "ev-a", claveDeOferta: "of-a" });
  await repos.pedidos.crearSiNoExiste({ ...base, id: "NOV-B", claveDeEvento: "ev-b", claveDeOferta: "of-b" });

  assert.equal(await repos.pedidos.activoDeContacto("c1"), null);
  assert.equal((await repos.pedidos.porContacto("c1")).length, 2);
});

// --------------------------------------------------------------------------
// Cola por conversacion
// --------------------------------------------------------------------------

test("la cola serializa las tareas de una misma clave", async () => {
  mutex._reiniciar();
  const orden = [];
  const tarea = (n) => async () => {
    orden.push(`inicio-${n}`);
    await new Promise((r) => setTimeout(r, 10 - n)); // la primera tarda mas
    orden.push(`fin-${n}`);
    return n;
  };

  await Promise.all([mutex.enSerie("c1", tarea(1)), mutex.enSerie("c1", tarea(2)), mutex.enSerie("c1", tarea(3))]);

  // Sin la cola, los tres "inicio" irian seguidos y los "fin" en otro orden.
  assert.deepEqual(orden, ["inicio-1", "fin-1", "inicio-2", "fin-2", "inicio-3", "fin-3"]);
});

test("claves distintas avanzan en paralelo", async () => {
  mutex._reiniciar();
  const orden = [];
  const tarea = (etiqueta, ms) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    orden.push(etiqueta);
  };

  await Promise.all([mutex.enSerie("c1", tarea("lento", 25)), mutex.enSerie("c2", tarea("rapido", 1))]);

  // Dos clientes distintos no se estorban.
  assert.deepEqual(orden, ["rapido", "lento"]);
});

test("una tarea que falla no bloquea la cola para siempre", async () => {
  mutex._reiniciar();
  const fallida = mutex.enSerie("c1", async () => {
    throw new Error("fallo a proposito");
  });
  await assert.rejects(() => fallida);

  // La siguiente tiene que ejecutarse igual. Si un error dejara la cola
  // bloqueada, un fallo puntual dejaria al cliente sin atencion para siempre.
  const valor = await mutex.enSerie("c1", async () => "sigo vivo");
  assert.equal(valor, "sigo vivo");
});

test("la cola no acumula una clave por cliente historico", async () => {
  mutex._reiniciar();
  for (let i = 0; i < 20; i++) {
    await mutex.enSerie(`cliente-${i}`, async () => i);
  }
  // La limpieza del Map ocurre en un .then() del eslabon, asi que hay que
  // dejar correr la cola de microtareas antes de comprobarlo.
  await new Promise((r) => setImmediate(r));
  assert.equal(mutex.enCurso(), 0);
});

test("un lote de eventos del mismo cliente se procesa de uno en uno", async () => {
  mutex._reiniciar();
  let dentro = 0;
  let maximoSimultaneo = 0;

  await Promise.all(
    Array.from({ length: 10 }, () =>
      mutex.enSerie("c1", async () => {
        dentro++;
        maximoSimultaneo = Math.max(maximoSimultaneo, dentro);
        await new Promise((r) => setTimeout(r, 2));
        dentro--;
      })
    )
  );

  assert.equal(maximoSimultaneo, 1, `hubo ${maximoSimultaneo} tareas a la vez para el mismo cliente`);
});
