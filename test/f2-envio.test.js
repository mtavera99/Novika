"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// El interruptor RESPUESTA_AUTOMATICA es la unica cosa que separa "estamos
// construyendo el bot" de "el bot le esta escribiendo a clientes reales".
//
// Por eso el candado vive en el emisor, que es el UNICO camino al exterior,
// y no en la capa de arriba: "acordarse de comprobar el interruptor en cada
// sitio que envia" es una instruccion, y las instrucciones se incumplen
// cuando alguien con prisa añade un flujo nuevo.
//
// Estas pruebas vigilan ese candado. Si alguien lo mueve o lo rodea, se
// caen.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const { crearEmisor, PERMISOS, MOTIVOS_BLOQUEO } = require("../src/whatsapp/enviar");
const metricas = require("../src/metricas");

const CONFIG_BASE = {
  respuestaAutomatica: false,
  whatsappToken: "token-de-prueba",
  idNumero: "111111111111111",
  versionGraph: "v21.0",
};

/** fetch que registra las llamadas y responde ok. */
function fetchEspia() {
  const llamadas = [];
  const impl = async (url, opciones) => {
    llamadas.push({ url, opciones });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.SALIDA" }] }) };
  };
  impl.llamadas = llamadas;
  return impl;
}

// --------------------------------------------------------------------------
// EL CANDADO
// --------------------------------------------------------------------------

test("con el interruptor apagado NO se llama a la red", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_BASE, fetchImpl });

  const r = await emisor.enviarTexto({ para: "573001234567", texto: "hola" });

  assert.equal(r.enviado, false);
  assert.equal(r.bloqueado, true);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.INTERRUPTOR);
  assert.equal(fetchImpl.llamadas.length, 0, "se llamo a la API de Meta con el interruptor apagado");
});

test("el bloqueo se cuenta, para poder verlo en las metricas", async () => {
  metricas._reiniciar();
  const emisor = crearEmisor({ config: CONFIG_BASE, fetchImpl: fetchEspia(), metricas });
  await emisor.enviarTexto({ para: "573001234567", texto: "hola" });
  assert.equal(metricas.valor("respuesta_bloqueada_por_interruptor"), 1);
  assert.equal(metricas.valor("respuesta_enviada"), 0);
});

test("con el interruptor encendido SI se envia", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: { ...CONFIG_BASE, respuestaAutomatica: true }, fetchImpl });

  const r = await emisor.enviarTexto({ para: "573001234567", texto: "hola" });

  assert.equal(r.enviado, true);
  assert.equal(r.wamid, "wamid.SALIDA");
  assert.equal(fetchImpl.llamadas.length, 1);
  assert.match(fetchImpl.llamadas[0].url, /111111111111111\/messages$/);
});

test("un aviso al dueno tambien respeta el interruptor", async () => {
  // Tentador dejarlo pasar "porque no es un cliente". Pero el interruptor
  // apagado significa que el sistema no esta listo para mandar mensajes, y
  // un aviso con datos mal calculados es igual de confuso.
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_BASE, fetchImpl });
  const r = await emisor.enviarTexto({ para: "573009998888", texto: "aviso", permiso: PERMISOS.AVISO_AL_DUENO });
  assert.equal(r.enviado, false);
  assert.equal(fetchImpl.llamadas.length, 0);
});

test("una prueba autorizada es la UNICA excepcion, y hay que pedirla por su nombre", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_BASE, fetchImpl });
  const r = await emisor.enviarTexto({
    para: "573001234567",
    texto: "prueba controlada",
    permiso: PERMISOS.PRUEBA_AUTORIZADA,
  });
  assert.equal(r.enviado, true);
  assert.equal(fetchImpl.llamadas.length, 1);
});

test("un permiso inventado se rechaza", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: { ...CONFIG_BASE, respuestaAutomatica: true }, fetchImpl });
  const r = await emisor.enviarTexto({ para: "573001234567", texto: "hola", permiso: "me-apetece" });
  assert.equal(r.enviado, false);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.SIN_PERMISO);
  assert.equal(fetchImpl.llamadas.length, 0);
});

// --------------------------------------------------------------------------
// Validaciones previas
// --------------------------------------------------------------------------

test("sin credenciales no se intenta enviar", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({
    config: { ...CONFIG_BASE, respuestaAutomatica: true, whatsappToken: "" },
    fetchImpl,
  });
  const r = await emisor.enviarTexto({ para: "573001234567", texto: "hola" });
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.SIN_CREDENCIALES);
  assert.equal(fetchImpl.llamadas.length, 0);
});

test("sin destino o sin texto no se envia", async () => {
  const emisor = crearEmisor({ config: { ...CONFIG_BASE, respuestaAutomatica: true }, fetchImpl: fetchEspia() });
  assert.equal((await emisor.enviarTexto({ para: null, texto: "hola" })).motivo, MOTIVOS_BLOQUEO.SIN_DESTINO);
  assert.equal((await emisor.enviarTexto({ para: "573001234567", texto: "  " })).motivo, MOTIVOS_BLOQUEO.TEXTO_VACIO);
});

test("revisarPermiso permite consultar antes de construir nada", () => {
  const emisor = crearEmisor({ config: CONFIG_BASE, fetchImpl: fetchEspia() });
  const r = emisor.revisarPermiso({ para: "573001234567", texto: "hola", permiso: PERMISOS.CONVERSACION });
  assert.equal(r.puede, false);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.INTERRUPTOR);
});

// --------------------------------------------------------------------------
// Reintentos
// --------------------------------------------------------------------------

test("un 429 se reintenta y puede acabar bien", async () => {
  const llamadas = [];
  const fetchImpl = async (url, opciones) => {
    llamadas.push({ url, opciones });
    if (llamadas.length === 1) return { ok: false, status: 429, json: async () => ({ error: { code: 130429 } }) };
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.OK" }] }) };
  };

  const emisor = crearEmisor({ config: { ...CONFIG_BASE, respuestaAutomatica: true }, fetchImpl });
  const r = await emisor.enviarTexto({ para: "573001234567", texto: "hola" });

  assert.equal(r.enviado, true);
  assert.equal(llamadas.length, 2);
});

test("un error permanente NO se reintenta", async () => {
  const llamadas = [];
  const fetchImpl = async () => {
    llamadas.push(1);
    // 131047: ventana de 24 horas cerrada. Reintentar sale igual de mal.
    return { ok: false, status: 400, json: async () => ({ error: { code: 131047 } }) };
  };

  const emisor = crearEmisor({ config: { ...CONFIG_BASE, respuestaAutomatica: true }, fetchImpl });
  const r = await emisor.enviarTexto({ para: "573001234567", texto: "hola" });

  assert.equal(r.enviado, false);
  assert.equal(llamadas.length, 1);
  assert.equal(r.codigoMeta, 131047);
});

test("un error de red se reintenta en vez de propagarse", async () => {
  // En BIKERPRO el try/catch estaba FUERA del bucle, asi que un socket
  // cortado se saltaba todos los reintentos.
  let intentos = 0;
  const fetchImpl = async () => {
    intentos++;
    if (intentos < 2) throw new Error("fetch failed");
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.OK" }] }) };
  };

  const emisor = crearEmisor({ config: { ...CONFIG_BASE, respuestaAutomatica: true }, fetchImpl });
  const r = await emisor.enviarTexto({ para: "573001234567", texto: "hola" });
  assert.equal(r.enviado, true);
  assert.equal(intentos, 2);
});

test("enviarTexto NUNCA lanza", async () => {
  const emisor = crearEmisor({
    config: { ...CONFIG_BASE, respuestaAutomatica: true },
    fetchImpl: async () => {
      throw new Error("todo mal");
    },
  });
  await assert.doesNotReject(() => emisor.enviarTexto({ para: "573001234567", texto: "hola" }));
  const r = await emisor.enviarTexto({ para: "573001234567", texto: "hola" });
  assert.equal(r.enviado, false);
});

// --------------------------------------------------------------------------
// Privacidad
// --------------------------------------------------------------------------

test("el bloqueo por interruptor no registra el telefono ni el texto", async () => {
  const registros = [];
  const log = { info: (e, d) => registros.push({ e, d }), warn: (e, d) => registros.push({ e, d }), error: (e, d) => registros.push({ e, d }) };
  const emisor = crearEmisor({ config: CONFIG_BASE, fetchImpl: fetchEspia(), log });

  await emisor.enviarTexto({ para: "573001234567", texto: "Hola Ana, tu pedido va a la Calle 45" });

  const todo = JSON.stringify(registros);
  assert.equal(todo.includes("573001234567"), false);
  assert.equal(todo.includes("Calle 45"), false);
  assert.ok(todo.includes("longitud"), "conviene saber que SI habia texto preparado");
});
