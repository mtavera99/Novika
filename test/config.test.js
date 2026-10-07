"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// La configuracion es donde se rompen los proyectos de WhatsApp: una
// variable que falta, un token que se reutiliza, un secreto con un valor por
// defecto escrito en el codigo.
//
// En BIKERPRO el token de verificacion tenia un respaldo escrito en el
// codigo fuente, el repositorio es publico, y ese valor quedo publicado en
// cinco archivos y en el historial de git para siempre. Esta prueba fija que
// NOVIKA prefiera no arrancar antes que arrancar con un secreto inventado.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

require("./ayuda").entornoDePrueba();
const { config, revisar } = require("../src/config");

/** Config base valida, para alterarla campo a campo. */
function base(extra = {}) {
  return {
    verifyToken: "f3a9c0e1b7d84526ac10ff93b2e4517d",
    appSecret: "clave_de_la_app",
    idNumero: "111111111111111",
    idWaba: "222222222222222",
    ownerWhatsapp: "573000000000",
    dirDatos: "/var/data",
    panelToken: "otro_secreto_distinto",
    firmaActiva: true,
    persistencia: { modo: "disco-persistente", esDurable: true, motivo: "disco montado" },
    permitirSinPersistencia: false,
    logPii: false,
    respuestaAutomatica: false,
    ...extra,
  };
}

test("sin token de verificacion no arranca", () => {
  const { errores } = revisar(base({ verifyToken: "" }));
  assert.ok(errores.some((e) => /WHATSAPP_VERIFY_TOKEN/.test(e)));
  // Y el mensaje tiene que decir como arreglarlo, no solo que falta.
  assert.ok(errores.some((e) => /openssl rand/.test(e)));
});

test("un token de verificacion corto no arranca", () => {
  const { errores } = revisar(base({ verifyToken: "corto" }));
  assert.ok(errores.some((e) => /32 o mas/.test(e)));
});

test("reutilizar el mismo valor para el panel y para la verificacion no arranca", () => {
  const mismo = "f3a9c0e1b7d84526ac10ff93b2e4517d";
  const { errores } = revisar(base({ verifyToken: mismo, panelToken: mismo }));
  assert.ok(errores.some((e) => /privilegios distintos/.test(e)));
});

test("un valor de BIKERPRO en la configuracion no arranca", () => {
  const { errores } = revisar(base({ dirDatos: "/var/data/bikerpro" }));
  assert.ok(errores.some((e) => /bikerpro/i.test(e)));
});

test("una configuracion limpia arranca", () => {
  assert.deepEqual(revisar(base()).errores, []);
});

// --------------------------------------------------------------------------
// Avisos: arranca, pero el dueno tiene que saberlo
// --------------------------------------------------------------------------

test("sin clave de la app arranca, pero avisa de que no se procesaran eventos", () => {
  const { errores, avisos } = revisar(base({ appSecret: "", firmaActiva: false }));
  // No es un error: bloquear aqui impediria que Meta verifique el webhook,
  // que es justo el paso que hay que desbloquear primero.
  assert.deepEqual(errores, []);
  assert.ok(avisos.some((a) => /DESCARTAR/.test(a)));
});

test("sin id de numero avisa de que el filtro de aislamiento esta inactivo", () => {
  const { avisos } = revisar(base({ idNumero: "" }));
  assert.ok(avisos.some((a) => /filtro/.test(a)));
});

test("con almacenamiento efimero avisa, pero deja verificar el webhook", () => {
  // Recibir y verificar no escribe nada, asi que la Fase 1 no necesita disco.
  const efimero = { modo: "efimera", esDurable: false, motivo: "no hay disco montado" };
  const { errores, avisos } = revisar(base({ persistencia: efimero }));
  assert.deepEqual(errores, []);
  assert.ok(avisos.some((a) => /EFIMERO/.test(a)));
  assert.ok(avisos.some((a) => /handshake no escribe nada/.test(a)));
});

test("almacenamiento efimero + responder a clientes NO arranca", () => {
  // Responder sin memoria durable duplica respuestas y, en fase 2, pedidos.
  const efimero = { modo: "efimera", esDurable: false, motivo: "no hay disco montado" };
  const { errores } = revisar(base({ persistencia: efimero, respuestaAutomatica: true }));
  assert.ok(errores.some((e) => /almacenamiento es efimero/.test(e)));
  assert.ok(errores.some((e) => /PERMITIR_SIN_PERSISTENCIA/.test(e)), "el error tiene que decir como saltarselo a proposito");
});

test("el escape explicito permite la prueba controlada, pero avisa", () => {
  const efimero = { modo: "efimera", esDurable: false, motivo: "no hay disco montado" };
  const { errores, avisos } = revisar(base({ persistencia: efimero, respuestaAutomatica: true, permitirSinPersistencia: true }));
  assert.deepEqual(errores, []);
  assert.ok(avisos.some((a) => /Solo para pruebas/.test(a)));
});

test("con los logs de datos personales encendidos, avisa", () => {
  const { avisos } = revisar(base({ logPii: true }));
  assert.ok(avisos.some((a) => /telefonos y textos/.test(a)));
});

test("con respuesta automatica encendida, avisa de que va a escribir a clientes reales", () => {
  const { avisos } = revisar(base({ respuestaAutomatica: true }));
  assert.ok(avisos.some((a) => /clientes reales/.test(a)));
});

// --------------------------------------------------------------------------
// Ningun secreto tiene respaldo en el codigo
// --------------------------------------------------------------------------

test("config.js no define valores por defecto para los secretos", () => {
  const fuente = fs.readFileSync(require.resolve("../src/config.js"), "utf8");
  // Lo que se busca es el patron texto("ALGO_SECRETO", "un valor"): un
  // respaldo escrito en el codigo. Los secretos se leen sin segundo argumento.
  for (const nombre of ["WHATSAPP_VERIFY_TOKEN", "META_APP_SECRET", "WHATSAPP_TOKEN", "PANEL_TOKEN"]) {
    const conRespaldo = new RegExp(`texto\\("${nombre}",`);
    assert.equal(conRespaldo.test(fuente), false, `${nombre} tiene un valor por defecto en el codigo`);
  }
});

test("las banderas derivadas reflejan el estado real", () => {
  // Son las que /health expone para contestar "por que no responde".
  assert.equal(config.firmaActiva, Boolean(config.appSecret));
  assert.equal(config.puedeEnviar, Boolean(config.whatsappToken && config.idNumero));
});
