"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// Meta reentrega un webhook cuando no recibe el 200 a tiempo. Sin este
// candado el mismo mensaje se procesa dos veces: hoy significa responder dos
// veces, y en fase 2 significa un pedido que nadie hizo.
//
// Un pedido inventado es peor que un paquete de mas: el dueno decide con
// esos numeros (coste por venta, cierre) y un pedido fantasma los corrompe
// todos.
//
// El candado tiene que sobrevivir a un reinicio del proceso, porque el
// reintento de Meta puede llegar justo despues de un despliegue.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const vistos = require("../src/almacen/vistos");

test("la primera vez es nuevo, la segunda no", () => {
  vistos._reiniciar();
  assert.equal(vistos.esNuevo("wamid.UNO"), true);
  assert.equal(vistos.esNuevo("wamid.UNO"), false);
  assert.equal(vistos.esNuevo("wamid.UNO"), false);
});

test("ids distintos no se estorban", () => {
  vistos._reiniciar();
  assert.equal(vistos.esNuevo("wamid.A"), true);
  assert.equal(vistos.esNuevo("wamid.B"), true);
  assert.equal(vistos.esNuevo("wamid.A"), false);
  assert.equal(vistos.cuantos(), 2);
});

test("un evento sin id se deja pasar: no se puede deduplicar, pero no se bloquea", () => {
  vistos._reiniciar();
  assert.equal(vistos.esNuevo(null), true);
  assert.equal(vistos.esNuevo(undefined), true);
  assert.equal(vistos.esNuevo(""), true);
  assert.equal(vistos.cuantos(), 0);
});

test("el candado sobrevive a un reinicio del proceso", () => {
  vistos._reiniciar();
  assert.equal(vistos.esNuevo("wamid.PERSISTE"), true);

  // Simula un reinicio: se vacia el indice en memoria, el archivo se queda.
  delete require.cache[require.resolve("../src/almacen/vistos")];
  const otraVez = require("../src/almacen/vistos");

  assert.equal(otraVez.esNuevo("wamid.PERSISTE"), false, "tras reiniciar, el id se olvido");
});

test("los ids mas viejos que la ventana se descartan al arrancar", () => {
  vistos._reiniciar();
  const viejo = Date.now() - (vistos.DIAS_QUE_SE_RECUERDAN + 1) * 24 * 60 * 60 * 1000;
  fs.writeFileSync(
    vistos.ARCHIVO,
    `${JSON.stringify({ id: "wamid.VIEJO", ts: viejo })}\n${JSON.stringify({ id: "wamid.RECIENTE", ts: Date.now() })}\n`
  );

  delete require.cache[require.resolve("../src/almacen/vistos")];
  const recargado = require("../src/almacen/vistos");

  assert.equal(recargado.esNuevo("wamid.RECIENTE"), false, "lo reciente deberia seguir recordado");
  assert.equal(recargado.esNuevo("wamid.VIEJO"), true, "lo viejo deberia haberse olvidado");
});

test("una linea corrupta en el archivo no impide arrancar", () => {
  vistos._reiniciar();
  fs.writeFileSync(vistos.ARCHIVO, `no es json\n${JSON.stringify({ id: "wamid.BUENO", ts: Date.now() })}\n`);

  delete require.cache[require.resolve("../src/almacen/vistos")];
  const recargado = require("../src/almacen/vistos");

  // Preferir arrancar con una laguna a no arrancar: no arrancar pierde todos
  // los mensajes, no uno.
  assert.equal(recargado.esNuevo("wamid.BUENO"), false);
});
