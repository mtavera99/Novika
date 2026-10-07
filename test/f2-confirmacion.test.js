"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Es el candado mas importante del sistema, y cada asercion de aqui
// corresponde a un incidente real documentado en BIKERPRO:
//
//   - un cliente escribio "No confirmo" y el pedido se guardo igual, porque
//     el guion le pedia al modelo que emitiera el bloque "al confirmar" y
//     una instruccion al modelo no es un candado;
//
//   - "si mandaron el pedido gracias" -una PREGUNTA- hizo match con el
//     patron de afirmacion y genero un segundo pedido por los mismos
//     $155.000, porque la normalizacion quitaba las tildes y "si" colapso
//     con "si";
//
//   - un "gracias" sobre un pedido ya confirmado volvia a disparar el flujo.
//
// Si alguien reordena los bloques de clasificar(), estas pruebas se caen.
// Ese es el objetivo: el orden ES la logica.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const { clasificar, evaluar, CLASES, ACCIONES } = require("../src/dominio/confirmacion");
const { ESTADOS } = require("../src/dominio/estados");

// --------------------------------------------------------------------------
// Clasificacion
// --------------------------------------------------------------------------

test('"No confirmo" es una NEGACION, no una confirmacion', () => {
  // El incidente original: "no confirmo" contiene "confirmo". Si se busca la
  // afirmacion antes que la negacion, gana la palabra equivocada y se guarda
  // una venta que el cliente rechazo.
  assert.equal(clasificar("No confirmo").clase, CLASES.NO);
  assert.equal(clasificar("no confirmo nada").clase, CLASES.NO);
  assert.equal(clasificar("NO CONFIRMO").clase, CLASES.NO);
});

test("las negaciones comunes se reconocen", () => {
  for (const frase of [
    "no gracias",
    "no lo quiero",
    "ya no",
    "mejor no",
    "cancela el pedido",
    "no por ahora",
    "dejalo",
    "no me interesa",
  ]) {
    assert.equal(clasificar(frase).clase, CLASES.NO, `"${frase}" deberia ser NO`);
  }
});

test('"si mandaron el pedido gracias" es una PREGUNTA, no un si', () => {
  // El incidente que genero un pedido duplicado por el mismo importe.
  const r = clasificar("si mandaron el pedido gracias");
  assert.equal(r.clase, CLASES.PREGUNTA_ESTADO);
});

test("las preguntas de estado se reconocen antes que cualquier si", () => {
  for (const frase of [
    "ya lo enviaron?",
    "cuando me llega",
    "donde va mi pedido",
    "tienes el numero de guia",
    "ya salio?",
    "que paso con mi compra",
  ]) {
    assert.equal(clasificar(frase).clase, CLASES.PREGUNTA_ESTADO, `"${frase}" deberia ser pregunta de estado`);
  }
});

test("las afirmaciones inequivocas dicen QUE se afirma", () => {
  for (const frase of ["si confirmo", "confirmo", "lo quiero", "hagale", "de una", "acepto", "procedamos"]) {
    assert.equal(clasificar(frase).clase, CLASES.SI, `"${frase}" deberia ser SI`);
  }
});

test("las correcciones no son ni si ni no", () => {
  for (const frase of ["mejor uno", "me equivoque", "cambia la direccion", "en vez de dos", "era otra talla"]) {
    assert.equal(clasificar(frase).clase, CLASES.CORRECCION, `"${frase}" deberia ser CORRECCION`);
  }
});

test('"gracias" y "ok" son cortesia, no transaccion', () => {
  for (const frase of ["gracias", "muchas gracias", "ok", "listo", "perfecto", "vale", "bendiciones"]) {
    assert.equal(clasificar(frase).clase, CLASES.ACUSE, `"${frase}" deberia ser ACUSE`);
  }
});

test("la tilde de un si suelto sube la confianza", () => {
  // Quien se toma la molestia de poner la tilde esta afirmando. Sin tilde
  // puede ser condicional, y esa diferencia ya costo un pedido duplicado.
  assert.equal(clasificar("sí").confianza, "media");
  assert.equal(clasificar("si").confianza, "baja");
});

test("un mensaje vacio es ambiguo, no un si", () => {
  assert.equal(clasificar("").clase, CLASES.AMBIGUO);
  assert.equal(clasificar(null).clase, CLASES.AMBIGUO);
});

// --------------------------------------------------------------------------
// LA REGLA QUE PIDIO MARCO: lo confirmado esta blindado
// --------------------------------------------------------------------------

test('un "si" sobre un pedido CONFIRMADO no hace nada', () => {
  const r = evaluar({ texto: "si", estado: ESTADOS.CONFIRMADO, resumenMostrado: true });
  assert.equal(r.accion, ACCIONES.NINGUNA);
  assert.match(r.motivo, /ya esta confirmado/);
});

test('"ok", "gracias", "listo", "perfecto" sobre un pedido confirmado no hacen nada', () => {
  for (const frase of ["ok", "gracias", "listo", "perfecto", "si", "sí", "de una", "vale"]) {
    const r = evaluar({ texto: frase, estado: ESTADOS.CONFIRMADO, resumenMostrado: true });
    assert.equal(
      r.accion,
      ACCIONES.NINGUNA,
      `"${frase}" sobre un pedido confirmado produjo "${r.accion}" en vez de no hacer nada`
    );
  }
});

test("el blindaje no depende del patron: ninguna clase crea pedido desde CONFIRMADO", () => {
  // Esto es lo que diferencia "intentamos no duplicar" de "no se puede
  // duplicar": aunque el texto parezca la confirmacion mas clara del mundo,
  // desde CONFIRMADO no sale un CONFIRMAR.
  for (const frase of ["si confirmo", "confirmo el pedido", "hagale", "lo quiero", "acepto", "procede"]) {
    const r = evaluar({ texto: frase, estado: ESTADOS.CONFIRMADO, resumenMostrado: true });
    assert.notEqual(r.accion, ACCIONES.CONFIRMAR, `"${frase}" intento confirmar un pedido ya confirmado`);
  }
});

test("una cancelacion SI atraviesa el blindaje", () => {
  const r = evaluar({ texto: "cancela el pedido", estado: ESTADOS.CONFIRMADO });
  assert.equal(r.accion, ACCIONES.CANCELAR);
});

test("una correccion sobre un pedido confirmado abre modificacion", () => {
  const r = evaluar({ texto: "cambia la direccion", estado: ESTADOS.CONFIRMADO });
  assert.equal(r.accion, ACCIONES.CORREGIR);
});

test("una pregunta de estado sobre un pedido confirmado responde estado", () => {
  const r = evaluar({ texto: "ya lo enviaron?", estado: ESTADOS.CONFIRMADO });
  assert.equal(r.accion, ACCIONES.RESPONDER_ESTADO);
});

// --------------------------------------------------------------------------
// El unico sitio donde un si crea un pedido
// --------------------------------------------------------------------------

test('un "si" frente a un resumen mostrado SI confirma', () => {
  const r = evaluar({ texto: "si", estado: ESTADOS.PENDIENTE_CONFIRMACION, resumenMostrado: true });
  assert.equal(r.accion, ACCIONES.CONFIRMAR);
});

test('"si confirmo" frente a un resumen confirma', () => {
  const r = evaluar({ texto: "si confirmo", estado: ESTADOS.PENDIENTE_CONFIRMACION, resumenMostrado: true });
  assert.equal(r.accion, ACCIONES.CONFIRMAR);
});

test("sin resumen mostrado, un si NO confirma: no hay nada que confirmar", () => {
  const r = evaluar({ texto: "si confirmo", estado: ESTADOS.PENDIENTE_CONFIRMACION, resumenMostrado: false });
  assert.equal(r.accion, ACCIONES.ESCALAR);
  assert.match(r.motivo, /sin resumen mostrado/);
});

test('un "si" en medio de la conversacion no confirma nada', () => {
  for (const estado of [ESTADOS.EXPLORANDO, ESTADOS.COTIZADO, ESTADOS.CAPTURANDO_DATOS]) {
    const r = evaluar({ texto: "si", estado });
    assert.notEqual(r.accion, ACCIONES.CONFIRMAR, `un si en ${estado} no deberia confirmar`);
  }
});

test('"gracias" frente a un resumen NO confirma, pero tampoco tira la venta', () => {
  // Asimetria deliberada: puede ser un "hagale" que no reconocemos. No se
  // descarta y no se guarda a ciegas; lo mira una persona.
  const r = evaluar({ texto: "gracias", estado: ESTADOS.PENDIENTE_CONFIRMACION, resumenMostrado: true });
  assert.equal(r.accion, ACCIONES.ESCALAR);
  assert.match(r.motivo, /puede ser un si/);
});

test("una respuesta ambigua frente a un resumen escala, no se descarta", () => {
  const r = evaluar({ texto: "mmm y eso que incluye", estado: ESTADOS.PENDIENTE_CONFIRMACION, resumenMostrado: true });
  assert.equal(r.accion, ACCIONES.ESCALAR);
});

test('"no confirmo" frente a un resumen CANCELA', () => {
  const r = evaluar({ texto: "no confirmo", estado: ESTADOS.PENDIENTE_CONFIRMACION, resumenMostrado: true });
  assert.equal(r.accion, ACCIONES.CANCELAR);
});

test("una pregunta de estado antes de que exista el pedido escala", () => {
  // Preguntar por el envio de algo que todavia no se ha comprado significa
  // que el cliente y el bot no estan en la misma conversacion.
  const r = evaluar({ texto: "ya lo enviaron?", estado: ESTADOS.PENDIENTE_CONFIRMACION, resumenMostrado: true });
  assert.equal(r.accion, ACCIONES.ESCALAR);
});
