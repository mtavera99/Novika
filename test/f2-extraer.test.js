"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// La extraccion heuristica es lo que sostiene el camino determinista. Si
// dependiera solo del modelo, un fallo del proveedor significaria cero
// ventas, y eso incumple las dos primeras prioridades del proyecto: no
// perder mensajes y no perder ventas.
//
// La regla que gobierna el modulo y esta bateria: ANTE LA DUDA, NO PROPONER.
// Un campo vacio hace que el bot pregunte, que cuesta un mensaje. Un campo
// mal propuesto acaba en una guia equivocada, que cuesta el producto, el
// flete y el cliente.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const extraer = require("../src/dominio/extraer");

// --------------------------------------------------------------------------
// Cantidad
// --------------------------------------------------------------------------

test("una cantidad dicha explicitamente se propone", () => {
  assert.equal(extraer.cantidadEn("quiero 2").valor, 2);
  assert.equal(extraer.cantidadEn("mandame tres").valor, 3);
  assert.equal(extraer.cantidadEn("necesito 4 por favor").valor, 4);
});

test("un numero suelto cuenta: el bot acaba de preguntar cuantos", () => {
  assert.equal(extraer.cantidadEn("2").valor, 2);
  assert.equal(extraer.cantidadEn(" 3 ").valor, 3);
});

test("el singular propone 1, que nunca cobra de mas", () => {
  // No es inventar: es lo que dice la frase. Y si hubiera duda, la cantidad
  // menor es la unica eleccion que no puede cobrar de mas.
  assert.equal(extraer.cantidadEn("lo quiero").valor, 1);
  assert.equal(extraer.cantidadEn("quiero el cinturon").valor, 1);
  assert.equal(extraer.cantidadEn("me lo llevo").valor, 1);
});

test('"quiero varios" NO se adivina', () => {
  const r = extraer.cantidadEn("quiero varios");
  assert.equal(r.valor, null);
  assert.match(r.porQue, /sin decir cuantos/);
});

test("una correccion tardia gana", () => {
  // "queria dos, mejor uno": la ultima señal es la correccion del cliente.
  assert.equal(extraer.cantidadEn("quiero dos, mejor uno").valor, 1);
});

test("una cantidad absurda no se propone", () => {
  assert.equal(extraer.cantidadEn("quiero 500").valor, null);
});

test("sin ninguna señal no se propone cantidad", () => {
  assert.equal(extraer.cantidadEn("hola buenas").valor, null);
  assert.equal(extraer.cantidadEn("").valor, null);
});

// --------------------------------------------------------------------------
// Ciudad
// --------------------------------------------------------------------------

test("una ciudad del listado se reconoce dentro de una frase", () => {
  assert.equal(extraer.ciudadEn("vivo en Medellin").valor, "medellin");
  assert.equal(extraer.ciudadEn("soy de Santa Marta, barrio el centro").valor, "santa marta");
});

test("las frases semanticas no llegan a proponerse como ciudad", () => {
  // Tienen que llegar VACIAS para que el bot pregunte, no como candidato
  // para que luego lo rechace la validacion.
  for (const frase of ["mandalo a mi casa", "por aqui cerca", "donde siempre", "aqui"]) {
    assert.equal(extraer.ciudadEn(frase).valor, null, `"${frase}" se propuso como ciudad`);
  }
});

test("dos ciudades distintas en el mismo mensaje NO se eligen", () => {
  // "soy de Cali pero mandalo a Medellin": escoger mal es despachar a otra
  // ciudad.
  const r = extraer.ciudadEn("soy de Cali pero mandalo a Medellin");
  assert.equal(r.valor, null);
  assert.match(r.porQue, /2 ciudades/);
});

test("una ciudad que no esta en el listado no la propone la heuristica", () => {
  // La puede proponer la IA, y entonces destino.js la acepta MARCADA.
  assert.equal(extraer.ciudadEn("vivo en Pueblo Nuevo de Abajo").valor, null);
});

// --------------------------------------------------------------------------
// Direccion
// --------------------------------------------------------------------------

test("una direccion con via y numero se propone", () => {
  assert.equal(extraer.direccionEn("Calle 45 # 23-10 apto 302").valor, "Calle 45 # 23-10 apto 302");
  assert.equal(extraer.direccionEn("vivo en la Carrera 70 # 1-2").valor, "Carrera 70 # 1-2");
});

test("la ciudad se recorta de la direccion para no ensuciar la guia", () => {
  const r = extraer.direccionEn("Calle 45 # 23-10, Medellin");
  assert.equal(r.valor, "Calle 45 # 23-10");
});

test("se conservan tildes y signos: la guia la lee una persona", () => {
  const r = extraer.direccionEn("Diagonal 12 # 3-45, Conjunto Los Álamos");
  assert.ok(r.valor.includes("Álamos"), `se perdieron los acentos: ${r.valor}`);
});

test("una via sin numero no se propone", () => {
  const r = extraer.direccionEn("vivo en la calle principal");
  assert.equal(r.valor, null);
  assert.match(r.porQue, /sin numero/);
});

test("las frases semanticas no se proponen como direccion", () => {
  for (const frase of ["mi casa", "donde siempre", "la misma de antes", "aqui"]) {
    assert.equal(extraer.direccionEn(frase).valor, null, `"${frase}" se propuso como direccion`);
  }
});

test("un telefono no se propone como direccion", () => {
  assert.equal(extraer.direccionEn("mi telefono es 3001234567").valor, null);
});

// --------------------------------------------------------------------------
// Conjunto y combinacion
// --------------------------------------------------------------------------

test("deTexto saca varios campos de un mensaje real", () => {
  const { candidatos } = extraer.deTexto("Soy de Medellin, Calle 45 # 23-10, quiero 2");
  assert.equal(candidatos.ciudad, "medellin");
  assert.equal(candidatos.direccion, "Calle 45 # 23-10");
  // La cantidad NO se lee de un mensaje con direccion: sus numeros no son
  // cantidades. Preferible preguntar que cotizar 45 unidades.
  assert.equal(candidatos.cantidad, undefined);
});

test("deTexto explica por que no propuso cada campo", () => {
  const { porQue } = extraer.deTexto("hola");
  assert.ok(porQue.cantidad);
  assert.ok(porQue.ciudad);
  assert.ok(porQue.direccion);
});

test("combinar: la heuristica gana sobre la IA en el mismo campo", () => {
  // La heuristica solo propone lo que reconocio contra una lista o un
  // patron; el modelo propone lo que le parece.
  const r = extraer.combinar({ ciudad: "medellin" }, { ciudad: "por aqui cerca", nombre: "Ana" });
  assert.equal(r.ciudad, "medellin");
  // Y donde la heuristica no llega, el modelo es la unica fuente.
  assert.equal(r.nombre, "Ana");
});

test("combinar no deja que un vacio de la heuristica borre un dato de la IA", () => {
  const r = extraer.combinar({ ciudad: null }, { ciudad: "Pueblo Nuevo" });
  assert.equal(r.ciudad, "Pueblo Nuevo");
});
