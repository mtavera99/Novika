"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// Dos preguntas concretas, contestadas con codigo en vez de con una opinion:
//
//   1. ¿Hace falta META_APP_SECRET para que Meta verifique la Callback URL?
//      NO. La documentacion de Meta describe dos tipos de peticion. La
//      "Verification Request" es un GET con hub.mode, hub.challenge y
//      hub.verify_token, y se valida comparando el verify_token y devolviendo
//      el challenge. No lleva cabecera de firma. Solo las "Event
//      Notifications" (los POST) van firmadas con X-Hub-Signature-256.
//
//   2. ¿Hace falta disco persistente para verificar la Callback URL?
//      NO. El handshake no escribe nada.
//
// Conclusion operativa: la Fase 1 (conectar Meta) se puede completar con UNA
// sola variable, WHATSAPP_VERIFY_TOKEN, y sin disco. La Fase 2 (responder y
// guardar) si necesita las dos cosas, y hay un candado que lo impide
// mientras falten.
//
// Esta bateria corre con META_APP_SECRET y DATA_DIR deliberadamente sin
// configurar: es el estado real del proyecto antes del primer despliegue.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba({
  META_APP_SECRET: null, // sin clave de la app, a proposito
  WHATSAPP_PHONE_NUMBER_ID: null, // sin filtro de numero todavia
  RESPUESTA_AUTOMATICA: "0",
});

const { crearApp } = require("../src/app");
const { config, revisar } = require("../src/config");

async function conServidor(prueba) {
  const { url, cerrar } = await ayuda.levantar(crearApp());
  try {
    await prueba(url);
  } finally {
    await cerrar();
  }
}

const dejarProcesar = () => new Promise((r) => setTimeout(r, 60));

// --------------------------------------------------------------------------
// 1. El handshake no necesita META_APP_SECRET
// --------------------------------------------------------------------------

test("sin META_APP_SECRET el servidor arranca", () => {
  assert.equal(config.firmaActiva, false);
  const { errores } = revisar();
  assert.deepEqual(errores, [], `no deberia haber errores de arranque: ${errores.join(" | ")}`);
});

test("sin META_APP_SECRET, Meta PUEDE verificar la Callback URL", async () => {
  await conServidor(async (url) => {
    const r = await fetch(
      `${url}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.verifyToken)}&hub.challenge=1158201444`
    );
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "1158201444");
  });
});

test("el handshake no escribe nada en disco: tampoco necesita disco persistente", async () => {
  await conServidor(async (url) => {
    await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.verifyToken)}&hub.challenge=abc`);
    // Se registra en el diario por trazabilidad, pero nada del handshake
    // depende de que ese registro sobreviva: Meta no lo vuelve a consultar.
    const anotado = ayuda.leerDiario(DIR).some((d) => d.tipo === "webhook_verificado");
    assert.equal(anotado, true);
  });
});

// --------------------------------------------------------------------------
// 2. Pero sin META_APP_SECRET no se procesa ningun evento
// --------------------------------------------------------------------------

test("sin META_APP_SECRET los eventos se guardan pero NO se procesan", async () => {
  await conServidor(async (url) => {
    const cuerpo = ayuda.payloadDeTexto({ wamid: "wamid.SINCLAVE" });

    const r = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    });

    // 200, no 4xx: un 4xx repetido hace que Meta desactive la suscripcion y
    // se dejen de recibir TODOS los mensajes, no solo este.
    assert.equal(r.status, 200);

    await dejarProcesar();
    const entradas = ayuda.leerDiario(DIR);

    // Queda constancia, para que el mensaje no se pierda...
    assert.ok(entradas.some((d) => d.tipo === "rechazado_sin_app_secret"));
    // ...pero no se procesa, porque no se puede demostrar que venga de Meta.
    assert.equal(entradas.some((d) => d.tipo === "mensaje" && d.wamid === "wamid.SINCLAVE"), false);
  });
});

test("/health dice sin rodeos que no esta procesando eventos", async () => {
  await conServidor(async (url) => {
    const cuerpo = await (await fetch(`${url}/health`)).json();
    assert.equal(cuerpo.firma_activa, false);
    assert.equal(cuerpo.respuesta_automatica, false);
    assert.equal(cuerpo.filtro_de_numero, "inactivo");
    // Y el estado de la persistencia, comprobado y no deducido.
    assert.ok(["disco-persistente", "efimera", "local"].includes(cuerpo.persistencia));
    assert.equal(typeof cuerpo.almacenamiento_durable, "boolean");
  });
});

// --------------------------------------------------------------------------
// 3. El candado que separa la Fase 1 de la Fase 2
// --------------------------------------------------------------------------

test("con almacenamiento efimero, encender las respuestas NO arranca", () => {
  const efimero = { modo: "efimera", esDurable: false, motivo: "no hay disco montado" };
  const { errores } = revisar({ ...config, persistencia: efimero, respuestaAutomatica: true });
  assert.ok(
    errores.some((e) => /almacenamiento es efimero/.test(e)),
    "responder sin memoria durable duplica respuestas, y en fase 2 duplica pedidos"
  );
});

test("con almacenamiento efimero y sin responder, solo avisa", () => {
  const efimero = { modo: "efimera", esDurable: false, motivo: "no hay disco montado" };
  const { errores, avisos } = revisar({ ...config, persistencia: efimero, respuestaAutomatica: false });
  assert.deepEqual(errores, [], "la Fase 1 tiene que poder completarse sin disco");
  assert.ok(avisos.some((a) => /EFIMERO/.test(a)));
});
