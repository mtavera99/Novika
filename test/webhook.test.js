"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// Es la bateria del unico camino por el que entra dinero: el webhook.
// Cada asercion corresponde a un fallo concreto que cuesta ventas o
// credibilidad:
//
//   - si el handshake GET se rompe, Meta no verifica y no entra NADA;
//   - si un POST sin firma se procesa, cualquiera puede inventarse clientes;
//   - si un reintento de Meta se procesa dos veces, el cliente recibe dos
//     respuestas (y en fase 2, nace un pedido fantasma);
//   - si un evento de otro numero se procesa, NOVIKA le contesta a los
//     clientes de BIKERPRO;
//   - si el evento no esta en disco antes del 200, un reinicio del hosting
//     lo borra para siempre y nadie se entera.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const { crearApp } = require("../src/app");
const { firmar } = require("../src/webhook/firma");
const { config } = require("../src/config");

const SECRETO = config.appSecret;
const VERIFY = config.verifyToken;

async function conServidor(prueba) {
  const { url, cerrar } = await ayuda.levantar(crearApp());
  try {
    await prueba(url);
  } finally {
    await cerrar();
  }
}

/** POST firmado como lo haria Meta. */
async function postFirmado(url, cuerpo, { secreto = SECRETO, cabecera } = {}) {
  const crudo = JSON.stringify(cuerpo);
  return fetch(`${url}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": cabecera !== undefined ? cabecera : firmar(Buffer.from(crudo), secreto),
    },
    body: crudo,
  });
}

/** El POST contesta 200 y procesa aparte; hay que dar el turno al bucle. */
const dejarProcesar = () => new Promise((r) => setTimeout(r, 60));

// --------------------------------------------------------------------------
// Verificacion (GET)
// --------------------------------------------------------------------------

test("GET /webhook con el token correcto devuelve el challenge en texto plano", async () => {
  await conServidor(async (url) => {
    const r = await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=1158201444`);
    assert.equal(r.status, 200);
    // Meta compara el cuerpo literalmente: ni JSON, ni comillas, ni salto.
    assert.equal(await r.text(), "1158201444");
  });
});

test("GET /webhook con token equivocado devuelve 403 y no dice por que", async () => {
  await conServidor(async (url) => {
    const r = await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=no-es-el-token&hub.challenge=abc`);
    assert.equal(r.status, 403);
    const cuerpo = await r.text();
    // Confirmar "el token esta mal" le dice a quien prueba que acerto la URL.
    assert.equal(cuerpo.includes(VERIFY), false);
    assert.equal(/token/i.test(cuerpo), false);
  });
});

test("GET /webhook sin hub.mode=subscribe devuelve 403", async () => {
  await conServidor(async (url) => {
    const r = await fetch(`${url}/webhook?hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=abc`);
    assert.equal(r.status, 403);
  });
});

test("GET /webhook sin parametros devuelve 403 y no revienta", async () => {
  await conServidor(async (url) => {
    assert.equal((await fetch(`${url}/webhook`)).status, 403);
  });
});

// --------------------------------------------------------------------------
// Recepcion (POST)
// --------------------------------------------------------------------------

test("un POST bien firmado se acepta, queda en el diario y se procesa", async () => {
  await conServidor(async (url) => {
    const wamid = "wamid.OK1";
    const r = await postFirmado(url, ayuda.payloadDeTexto({ wamid, texto: "hola, info por favor" }));
    assert.equal(r.status, 200);

    await dejarProcesar();
    const diario = ayuda.leerDiario(DIR);
    const tipos = diario.map((d) => d.tipo);

    // El evento crudo se escribe ANTES del 200: es lo que impide que un
    // reinicio del hosting borre un mensaje que Meta ya dio por entregado.
    assert.ok(tipos.includes("entrada_cruda"), "falta la entrada cruda");
    assert.ok(tipos.includes("mensaje"), "el mensaje no se proceso");

    const mensaje = diario.find((d) => d.tipo === "mensaje");
    assert.equal(mensaje.wamid, wamid);
    assert.equal(mensaje.texto, "hola, info por favor");
  });
});

test("un POST con firma invalida se rechaza con 403 y no se procesa", async () => {
  await conServidor(async (url) => {
    const antes = ayuda.leerDiario(DIR).filter((d) => d.tipo === "mensaje").length;

    const r = await postFirmado(url, ayuda.payloadDeTexto({ wamid: "wamid.FALSO" }), { secreto: "secreto_de_un_atacante" });
    assert.equal(r.status, 403);

    await dejarProcesar();
    const diario = ayuda.leerDiario(DIR);
    assert.equal(diario.filter((d) => d.tipo === "mensaje").length, antes);
    assert.ok(diario.some((d) => d.tipo === "firma_invalida"));
  });
});

test("un POST sin cabecera de firma se rechaza", async () => {
  await conServidor(async (url) => {
    const r = await postFirmado(url, ayuda.payloadDeTexto({ wamid: "wamid.SINFIRMA" }), { cabecera: null });
    assert.equal(r.status, 403);
  });
});

test("el mismo wamid dos veces se procesa una sola vez", async () => {
  await conServidor(async (url) => {
    const wamid = "wamid.REINTENTO";
    const cuerpo = ayuda.payloadDeTexto({ wamid, texto: "mismo mensaje" });

    assert.equal((await postFirmado(url, cuerpo)).status, 200);
    await dejarProcesar();
    // Meta reentrega cuando no recibe el 200 a tiempo: el mismo evento, otra vez.
    assert.equal((await postFirmado(url, cuerpo)).status, 200);
    await dejarProcesar();

    const diario = ayuda.leerDiario(DIR);
    const procesados = diario.filter((d) => d.tipo === "mensaje" && d.wamid === wamid);
    assert.equal(procesados.length, 1, "el mensaje se proceso mas de una vez");

    // Y el duplicado queda registrado: es la diferencia entre "lo paramos" y
    // "no llego".
    assert.ok(diario.some((d) => d.tipo === "duplicado_descartado" && d.wamid === wamid));
    // Las dos entregas si quedan registradas: dos entradas crudas.
    assert.equal(diario.filter((d) => d.tipo === "entrada_cruda").length >= 2, true);
  });
});

test("un evento de otro phone_number_id se descarta sin procesar", async () => {
  await conServidor(async (url) => {
    const r = await postFirmado(
      url,
      ayuda.payloadDeTexto({ wamid: "wamid.AJENO", idNumero: "999999999999999", texto: "soy de otro bot" })
    );
    assert.equal(r.status, 200);

    await dejarProcesar();
    const diario = ayuda.leerDiario(DIR);
    assert.ok(diario.some((d) => d.tipo === "evento_ajeno" && d.wamid === "wamid.AJENO"));
    assert.equal(diario.some((d) => d.tipo === "mensaje" && d.wamid === "wamid.AJENO"), false);
  });
});

test("un acuse de entrega fallido se registra con su motivo", async () => {
  await conServidor(async (url) => {
    assert.equal((await postFirmado(url, ayuda.payloadDeEstado({ wamid: "wamid.EST", estado: "failed" }))).status, 200);
    await dejarProcesar();

    const estado = ayuda.leerDiario(DIR).find((d) => d.tipo === "estado" && d.wamid === "wamid.EST");
    assert.ok(estado, "el acuse no se registro");
    assert.equal(estado.estado, "failed");
    assert.equal(estado.errores[0].codigo, 131047);
  });
});

test("con RESPUESTA_AUTOMATICA apagada no se intenta responder a nadie", async () => {
  await conServidor(async (url) => {
    await postFirmado(url, ayuda.payloadDeTexto({ wamid: "wamid.CALLADO" }));
    await dejarProcesar();
    const diario = ayuda.leerDiario(DIR);
    assert.ok(diario.some((d) => d.tipo === "sin_responder" && d.motivo === "respuesta_automatica_apagada"));
  });
});

test("un cuerpo JSON roto no hace que Meta desactive la suscripcion", async () => {
  await conServidor(async (url) => {
    const r = await fetch(`${url}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=lo-que-sea" },
      body: "{esto no es json",
    });
    // Un 4xx repetido hace que Meta deje de entregar TODOS los mensajes.
    // Ante un cuerpo roto se contesta 200 y se registra el problema.
    assert.equal(r.status, 200);
    await dejarProcesar();
    assert.ok(ayuda.leerDiario(DIR).some((d) => d.tipo === "error_http"));
  });
});

// --------------------------------------------------------------------------
// Diagnostico
// --------------------------------------------------------------------------

test("/health es publico y dice si el bot esta en condiciones de atender", async () => {
  await conServidor(async (url) => {
    const r = await fetch(`${url}/health`);
    assert.equal(r.status, 200);
    const cuerpo = await r.json();
    assert.equal(cuerpo.marca, "novika");
    assert.equal(cuerpo.firma_activa, true);
    assert.equal(cuerpo.respuesta_automatica, false);
    assert.equal(cuerpo.filtro_de_numero, "activo");
    // Nada secreto en la respuesta publica.
    const texto = JSON.stringify(cuerpo);
    assert.equal(texto.includes(SECRETO), false);
    assert.equal(texto.includes(VERIFY), false);
    assert.equal(texto.includes(config.panelToken), false);
  });
});

test("/eventos exige el token del panel", async () => {
  await conServidor(async (url) => {
    assert.equal((await fetch(`${url}/eventos`)).status, 403);
    assert.equal((await fetch(`${url}/eventos?token=equivocado`)).status, 403);

    const r = await fetch(`${url}/eventos?token=${encodeURIComponent(config.panelToken)}`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
  });
});

test("el token del panel no sirve para verificar el webhook", async () => {
  // Son secretos de privilegio distinto: el de verificacion lo conoce Meta,
  // el del panel lee datos de clientes. Compartirlos fue el error que llevo
  // a que el valor de BIKERPRO acabase publicado en su repositorio.
  await conServidor(async (url) => {
    const r = await fetch(
      `${url}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.panelToken)}&hub.challenge=x`
    );
    assert.equal(r.status, 403);
  });
});

test("una ruta que no existe devuelve 404 en JSON", async () => {
  await conServidor(async (url) => {
    const r = await fetch(`${url}/no-existe`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).ok, false);
  });
});
