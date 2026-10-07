"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// La firma X-Hub-Signature-256 es lo unico que distingue "me escribio un
// cliente por WhatsApp" de "alguien descubrio mi URL y se invento un
// cliente". BIKERPRO no la comprueba: su webhook acepta cualquier POST.
//
// Si manana alguien "simplifica" revisarFirma comparando con === o
// serializando de nuevo el JSON, estas aserciones fallan.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const { revisarFirma, firmar, capturarCuerpoCrudo } = require("../src/webhook/firma");

const SECRETO = "clave_secreta_de_prueba";
const CUERPO = Buffer.from(JSON.stringify({ hola: "mundo", acento: "ñ" }));

test("una firma correcta se acepta", () => {
  const r = revisarFirma(CUERPO, firmar(CUERPO, SECRETO), SECRETO);
  assert.equal(r.ok, true);
  assert.equal(r.motivo, "valida");
});

test("una firma de otro secreto se rechaza", () => {
  const r = revisarFirma(CUERPO, firmar(CUERPO, "otro_secreto"), SECRETO);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, "no_coincide");
});

test("un cuerpo alterado invalida la firma", () => {
  const firma = firmar(CUERPO, SECRETO);
  const alterado = Buffer.from(JSON.stringify({ hola: "mundo", acento: "ñ", extra: 1 }));
  assert.equal(revisarFirma(alterado, firma, SECRETO).ok, false);
});

test("sin cabecera no se acepta", () => {
  assert.deepEqual(revisarFirma(CUERPO, undefined, SECRETO), { ok: false, motivo: "sin_cabecera" });
  assert.deepEqual(revisarFirma(CUERPO, "", SECRETO), { ok: false, motivo: "sin_cabecera" });
});

test("sin app secret se distingue del resto de fallos", () => {
  // El motivo importa: es el unico caso en el que el webhook contesta 200
  // (para que Meta no desactive la suscripcion) en vez de 403.
  assert.deepEqual(revisarFirma(CUERPO, firmar(CUERPO, SECRETO), ""), { ok: false, motivo: "sin_app_secret" });
});

test("una cabecera con formato raro no revienta", () => {
  for (const cabecera of ["sha256=", "sha1=abc", "no-es-una-firma", "sha256=zzzz"]) {
    const r = revisarFirma(CUERPO, cabecera, SECRETO);
    assert.equal(r.ok, false, `deberia rechazar ${cabecera}`);
  }
});

test("la firma se calcula sobre los bytes crudos, no sobre el objeto reserializado", () => {
  // Un JSON con las mismas claves en otro orden produce otros bytes y, por
  // tanto, otra firma. Si alguien calculase el HMAC con
  // JSON.stringify(req.body), fallaria con payloads reales de Meta.
  const a = Buffer.from('{"a":1,"b":2}');
  const b = Buffer.from('{"b":2,"a":1}');
  assert.notEqual(firmar(a, SECRETO), firmar(b, SECRETO));
  assert.equal(revisarFirma(b, firmar(a, SECRETO), SECRETO).ok, false);
});

test("capturarCuerpoCrudo deja los bytes en la peticion", () => {
  const req = {};
  capturarCuerpoCrudo(req, null, CUERPO);
  assert.ok(Buffer.isBuffer(req.cuerpoCrudo));
  assert.equal(req.cuerpoCrudo.toString(), CUERPO.toString());

  const vacio = {};
  capturarCuerpoCrudo(vacio, null, Buffer.alloc(0));
  assert.equal(vacio.cuerpoCrudo.length, 0);
});
