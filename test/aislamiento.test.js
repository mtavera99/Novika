"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// NOVIKA y BIKERPRO son del mismo dueno, viven en la misma cuenta de Meta y
// se despliegan en el mismo hosting. El error facil no es conceptual: es
// pegar una variable en el servicio equivocado a las once de la noche.
//
// Si eso pasa, NOVIKA empieza a contestarle a los clientes de BIKERPRO. Esta
// prueba fija que el proyecto se niegue a arrancar antes de llegar ahi.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const aislamiento = require("../src/aislamiento");

test("el token de verificacion de BIKERPRO se detecta", () => {
  const problemas = aislamiento.revisarConfiguracion({ WHATSAPP_VERIFY_TOKEN: "bikerpro_verify_123" });
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /WHATSAPP_VERIFY_TOKEN/);
});

test("los numeros de WhatsApp de BIKERPRO se detectan", () => {
  assert.equal(aislamiento.revisarConfiguracion({ OWNER_WHATSAPP: "573138615813" }).length, 1);
  assert.equal(aislamiento.revisarConfiguracion({ BOT_WHATSAPP: "573227545695" }).length, 1);
});

test("cualquier valor que mencione BIKERPRO se detecta", () => {
  const problemas = aislamiento.revisarConfiguracion({
    DATA_DIR: "/var/data/bikerpro",
    OTRA: "https://BikerPro-bot.example/webhook",
  });
  assert.equal(problemas.length, 2);
});

test("una configuracion limpia no produce problemas", () => {
  const problemas = aislamiento.revisarConfiguracion({
    WHATSAPP_VERIFY_TOKEN: "f3a9c0e1b7d84526ac10ff93b2e4517d",
    OWNER_WHATSAPP: "573000000000",
    DATA_DIR: "/var/data",
    PANEL_TOKEN: "otro_secreto_distinto",
  });
  assert.deepEqual(problemas, []);
});

test("los valores vacios o ausentes se ignoran", () => {
  assert.deepEqual(aislamiento.revisarConfiguracion({ A: "", B: null, C: undefined }), []);
  assert.deepEqual(aislamiento.revisarConfiguracion(null), []);
});

test("los valores prohibidos se guardan como hash, no en claro", () => {
  // Copiar los identificadores de BIKERPRO a este repositorio publico seria
  // republicarlos. El modulo entero no debe contener la cadena literal.
  const fuente = require("node:fs").readFileSync(require.resolve("../src/aislamiento.js"), "utf8");
  assert.equal(fuente.includes("bikerpro_verify_123"), false);
  assert.equal(fuente.includes("573138615813"), false);
  assert.equal(fuente.includes("573227545695"), false);
});

// --------------------------------------------------------------------------
// Candado por evento
// --------------------------------------------------------------------------

test("un evento del numero de NOVIKA pasa", () => {
  const r = aislamiento.eventoEsDeNovika({ idNumero: "111" }, "111");
  assert.equal(r.ok, true);
});

test("un evento de otro numero se bloquea", () => {
  const r = aislamiento.eventoEsDeNovika({ idNumero: "999" }, "111");
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "numero_ajeno");
});

test("sin id configurado se deja pasar y se dice por que", () => {
  // Durante el montaje la variable todavia no esta puesta. Bloquear aqui
  // impediria recibir el primer mensaje de prueba, que es justo lo que se
  // necesita para comprobar que la conexion funciona.
  const r = aislamiento.eventoEsDeNovika({ idNumero: "999" }, "");
  assert.equal(r.ok, true);
  assert.equal(r.motivo, "sin_id_configurado");
});

test("la comparacion no se deja enganar por el tipo", () => {
  assert.equal(aislamiento.eventoEsDeNovika({ idNumero: 111 }, "111").ok, true);
});
