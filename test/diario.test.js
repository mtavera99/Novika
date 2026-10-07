"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// El diario es la trazabilidad de NOVIKA: si algo no esta aqui, manana no se
// puede responder "¿que paso con este cliente?".
//
// La primera version de anotar() construia la entrada como
// { ts, tipo, ...datos }. Cualquier dato con una clave llamada `tipo` -el
// tipo de mensaje de WhatsApp ("text"), el tipo de error de Express
// ("entity.parse.failed")- sobrescribia la identidad de la entrada. El
// mensaje quedaba guardado como tipo "text" en vez de "mensaje", y las
// consultas del diario no lo encontraban nunca.
//
// Era invisible: el evento SI estaba en disco, con todos sus datos, pero
// etiquetado con otro nombre. Desde fuera, identico a "no llego".
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();
const diario = require("../src/almacen/diario");

test("los datos no pueden sobrescribir el tipo de la entrada", () => {
  diario.anotar("mensaje", { tipo: "text", wamid: "wamid.CHOQUE" });
  const entrada = ayuda.leerDiario(DIR).find((d) => d.wamid === "wamid.CHOQUE");
  assert.equal(entrada.tipo, "mensaje");
});

test("los datos no pueden sobrescribir la marca de tiempo", () => {
  diario.anotar("prueba", { ts: "no-es-una-fecha", marca: "ts" });
  const entrada = ayuda.leerDiario(DIR).find((d) => d.marca === "ts");
  assert.ok(!Number.isNaN(Date.parse(entrada.ts)), `ts invalido: ${entrada.ts}`);
});

test("anotar nunca lanza, aunque el dato no sea serializable", () => {
  const circular = {};
  circular.yo = circular;
  assert.doesNotThrow(() => diario.anotar("prueba", { circular }));
  // Devuelve false para que quien llama pueda gritar, pero no revienta: un
  // fallo del diario no puede tumbar la recepcion del mensaje de un cliente.
  assert.equal(diario.anotar("prueba", { circular }), false);
});

test("ultimas() devuelve lo mas reciente primero", () => {
  diario.anotar("uno", { n: 1 });
  diario.anotar("dos", { n: 2 });
  diario.anotar("tres", { n: 3 });
  const ultimas = diario.ultimas(3);
  assert.deepEqual(
    ultimas.map((e) => e.tipo),
    ["tres", "dos", "uno"]
  );
});

test("resumenDeHoy cuenta por tipo", () => {
  const antes = diario.resumenDeHoy().contado || 0;
  diario.anotar("contado", {});
  diario.anotar("contado", {});
  assert.equal(diario.resumenDeHoy().contado, antes + 2);
});

test("el dia de negocio se calcula en la zona horaria del negocio, no en UTC", () => {
  // El servidor corre en UTC. A las 19:00 de Bogota ya es el dia siguiente en
  // UTC, asi que un corte de dia calculado en UTC parte las ventas de la
  // tarde en dos dias distintos.
  const laNocheEnBogota = new Date("2026-03-15T23:30:00-05:00"); // 04:30 UTC del 16
  assert.equal(diario.diaDeNegocio(laNocheEnBogota), "2026-03-15");
});
