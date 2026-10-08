"use strict";

// ==========================================================================
// POR QUE EL BOT NO CONTESTO
//
// DE DONDE SALE: Marco entro al panel y encontro mensajes sin responder.
// Tuvo que contestarlos a mano y no sabia por que habia pasado.
//
// Auditandolo salieron DOS causas, y las dos eran diseño propio:
//
//   1. NUMEROS_DE_PRUEBA estaba puesta con un numero. El bot solo le
//      contesta a esos; a cualquier otro cliente le guarda el mensaje y se
//      calla. Es configuracion, no un fallo — pero ya habia clientes de
//      verdad escribiendo.
//
//   2. LA PAUSA NO SE LEVANTABA NUNCA. Al responder a mano desde el panel,
//      el bot se pausa en ese chat -correcto: dos voces a la vez es peor-
//      pero la pausa no caducaba. Ese chat quedaba sin bot PARA SIEMPRE.
//
// Y el problema de fondo no era ninguna de las dos: era que NINGUNA SE
// VEIA. Las dos estaban registradas en el diario y en los logs de Render, y
// el panel seguia mostrando un dia normal. Habia que entrar, leer los chats
// y darse cuenta.
//
// Un bot que no contesta y no lo dice es peor que uno caido: el caido se
// nota.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const atencion = require("../src/almacen/atencion");
const silencios = require("../src/panel/silencios");
const vistas = require("../src/panel/vistas");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");

const HORA = 3600000;

async function conRepos() {
  return crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-silencios-")) });
}

/** Conversacion con mensajes y, si se pide, pausada desde hace N horas. */
async function sembrar(repos, { id, mensajes = [], pausadaHace = null, atendido = false }) {
  const conv = { contactoId: id, estado: "explorando", ficha: {}, ventana: [] };
  for (const m of mensajes) {
    atencion.anotarMensaje(conv, { de: m.de, texto: m.texto, estado: m.estado || "enviado", por: m.por });
  }
  if (pausadaHace !== null) {
    conv.atencion = {
      ...atencion.leer(conv),
      pausado: true,
      por: "panel",
      desde: new Date(Date.now() - pausadaHace * HORA).toISOString(),
    };
  }
  if (atendido) {
    conv.atencion = { ...atencion.leer(conv), atendidoEn: new Date().toISOString(), atendidoPor: "panel" };
  }
  await repos.conversaciones.guardar(conv);
  return conv;
}

// --------------------------------------------------------------------------
// 1 · LA PAUSA CADUCA
// --------------------------------------------------------------------------

describe("1 · la pausa del bot caduca", () => {
  test("recien tomada, el bot sigue callado", async () => {
    // Lo contrario seria peor que el defecto: si una persona esta
    // respondiendo AHORA, el bot no puede hablar encima.
    const repos = await conRepos();
    await sembrar(repos, { id: "573000000001", mensajes: [{ de: "cliente", texto: "hola" }], pausadaHace: 1 });
    assert.equal(await atencion.estaPausada(repos, "573000000001"), true);
  });

  test("a las 12 horas el bot retoma", async () => {
    const repos = await conRepos();
    await sembrar(repos, { id: "573000000002", mensajes: [{ de: "cliente", texto: "hola" }], pausadaHace: 20 });
    assert.equal(await atencion.estaPausada(repos, "573000000002"), false, "el chat quedó sin bot para siempre");
  });

  test("al caducar se LEVANTA en el almacén, no solo se ignora", async () => {
    // Si solo se ignorara, el panel seguiria mostrando el chat como tomado
    // por una persona y nadie sabria que el bot volvio a atenderlo.
    const repos = await conRepos();
    await sembrar(repos, { id: "573000000003", mensajes: [{ de: "cliente", texto: "hola" }], pausadaHace: 30 });
    await atencion.estaPausada(repos, "573000000003");

    const conv = await repos.conversaciones.obtener("573000000003");
    assert.equal(atencion.leer(conv).pausado, false);
    assert.ok(conv.atencion.caducoEn, "tiene que quedar constancia de cuándo volvió el bot");
  });

  test("sin fecha de inicio NO se levanta", async () => {
    // En la duda, el bot se calla. Callarse de más es recuperable;
    // pisarle la conversación a quien atiende, no.
    const repos = await conRepos();
    const conv = { contactoId: "573000000004", estado: "explorando", ficha: {}, ventana: [] };
    conv.atencion = { pausado: true, por: "panel", desde: null };
    await repos.conversaciones.guardar(conv);

    assert.equal(atencion.pausaCaducada(conv), false);
    assert.equal(await atencion.estaPausada(repos, "573000000004"), true);
  });

  test("un error de lectura deja el bot callado", async () => {
    // Regresion del comportamiento que ya existia: ante un fallo del
    // almacen NO se envia.
    const roto = { conversaciones: { async obtener() { throw new Error("disco"); } } };
    assert.equal(await atencion.estaPausada(roto, "573000000005"), true);
  });
});

// --------------------------------------------------------------------------
// 2 · EL DIAGNOSTICO
// --------------------------------------------------------------------------

describe("2 · el diagnóstico dice por qué", () => {
  test("cuenta quién está esperando respuesta", async () => {
    const repos = await conRepos();
    // Esperando: el ultimo mensaje es del cliente.
    await sembrar(repos, { id: "573000000011", mensajes: [{ de: "cliente", texto: "¿hola?" }] });
    // Contestada: hay respuesta despues.
    await sembrar(repos, {
      id: "573000000012",
      mensajes: [{ de: "cliente", texto: "hola" }, { de: "bot", texto: "¡Hola!" }],
    });

    const d = await silencios.diagnostico(repos, {});
    assert.equal(d.cuantosEsperan, 1);
    assert.equal(d.esperando[0].contactoId, "573000000011");
  });

  test("distingue a quien NUNCA recibió una respuesta", async () => {
    // Es peor que uno a medio atender: ese cliente no sabe ni si existimos.
    const repos = await conRepos();
    await sembrar(repos, { id: "573000000021", mensajes: [{ de: "cliente", texto: "buenas" }] });
    await sembrar(repos, {
      id: "573000000022",
      mensajes: [
        { de: "cliente", texto: "hola" },
        { de: "bot", texto: "¡Hola!" },
        { de: "cliente", texto: "¿y el precio?" },
      ],
    });

    const d = await silencios.diagnostico(repos, {});
    assert.equal(d.cuantosEsperan, 2);
    assert.equal(d.nuncaRespondidos, 1);
    assert.equal(d.esperando.find((e) => e.contactoId === "573000000021").nuncaRespondido, true);
    assert.equal(d.esperando.find((e) => e.contactoId === "573000000022").nuncaRespondido, false);
  });

  test("lo atendido a mano NO cuenta como esperando", async () => {
    const repos = await conRepos();
    await sembrar(repos, { id: "573000000031", mensajes: [{ de: "cliente", texto: "hola" }], atendido: true });
    const d = await silencios.diagnostico(repos, {});
    assert.equal(d.cuantosEsperan, 0);
  });

  test("cuenta los chats donde el bot está callado", async () => {
    const repos = await conRepos();
    await sembrar(repos, { id: "573000000041", mensajes: [{ de: "cliente", texto: "hola" }], pausadaHace: 2 });
    const d = await silencios.diagnostico(repos, {});
    assert.equal(d.pausados.length, 1);
    assert.equal(d.pausados[0].horas, 2);
    assert.ok(d.causas.some((c) => c.motivo === silencios.MOTIVOS.PAUSADO));
  });

  test("cada causa trae la palanca concreta, no un consejo genérico", async () => {
    // "Revisa la configuración" obliga a investigar. "Borra
    // NUMEROS_DE_PRUEBA en Render" se ejecuta.
    const repos = await conRepos();
    await sembrar(repos, {
      id: "573000000051",
      mensajes: [
        { de: "cliente", texto: "hola" },
        { de: "bot", texto: "preparada", estado: "respuesta_automatica_apagada" },
      ],
    });

    const d = await silencios.diagnostico(repos, {});
    const causa = d.causas.find((c) => c.motivo === silencios.MOTIVOS.INTERRUPTOR);
    assert.ok(causa, "no detectó el interruptor apagado");
    assert.match(causa.comoSeArregla, /RESPUESTA_AUTOMATICA=1/);
    assert.match(causa.porQue, /modo sombra/i);
    assert.equal(causa.gravedad, "alta");
  });

  test("la causa de la lista de prueba trae la palanca correcta", () => {
    const c = silencios.QUE_HACER[silencios.MOTIVOS.FUERA_DE_LISTA];
    assert.match(c.comoSeArregla, /NUMEROS_DE_PRUEBA/);
    assert.match(c.porQue, /SOLO le contesta/);
  });

  test("los que esperan más tiempo salen primero", async () => {
    const repos = await conRepos();
    const viejo = { contactoId: "573000000061", estado: "explorando", ficha: {}, ventana: [] };
    atencion.anotarMensaje(viejo, { de: "cliente", texto: "llevo horas" });
    viejo.mensajes[0].ts = Date.now() - 5 * HORA;
    await repos.conversaciones.guardar(viejo);
    await sembrar(repos, { id: "573000000062", mensajes: [{ de: "cliente", texto: "acabo de escribir" }] });

    const d = await silencios.diagnostico(repos, {});
    assert.equal(d.esperando[0].contactoId, "573000000061", "lo más viejo tiene que ir arriba");
  });
});

// --------------------------------------------------------------------------
// 3 · LA PANTALLA
// --------------------------------------------------------------------------

describe("3 · la pantalla lo dice sin tener que investigar", () => {
  async function pantalla({ numerosDePrueba = [], respuestaAutomatica = true } = {}) {
    const repos = await conRepos();
    await sembrar(repos, { id: "573000000071", mensajes: [{ de: "cliente", texto: "me interesa" }] });
    await sembrar(repos, { id: "573000000072", mensajes: [{ de: "cliente", texto: "hola" }], pausadaHace: 3 });
    const d = await silencios.diagnostico(repos, {});
    return vistas.sinResponder({ datos: d, config: { numerosDePrueba, respuestaAutomatica } });
  }

  test("el titular dice cuántos esperan", async () => {
    const html = await pantalla();
    assert.match(html, /están esperando respuesta/);
    assert.match(html, /NINGUNA respuesta/, "tiene que destacar a quien nunca recibió nada");
  });

  test("avisa en grande si la lista de prueba está puesta", async () => {
    // Es la causa más probable y la que menos se sospecha: no es un fallo,
    // es una variable que quedó puesta de cuando se probaba.
    const html = await pantalla({ numerosDePrueba: ["573001234567"] });
    assert.match(html, /SOLO esos números reciben respuesta/);
    assert.match(html, /kpi no/, "tiene que salir marcado como problema");
  });

  test("sin lista, lo dice también", async () => {
    const html = await pantalla({ numerosDePrueba: [] });
    assert.match(html, /abierto al público/);
  });

  test("avisa si la respuesta automática está apagada", async () => {
    const html = await pantalla({ respuestaAutomatica: false });
    assert.match(html, /APAGADA/);
    assert.match(html, /prepara y no envía/);
  });

  test("lista los chats sin bot y ofrece devolverlos", async () => {
    const html = await pantalla();
    assert.match(html, /Chats donde el bot está callado/);
    assert.match(html, /\/panel\/devolver-todos/);
    assert.match(html, /caduca sola/, "tiene que explicar que la pausa ya no es eterna");
    // Accion con consecuencias: se confirma antes.
    assert.match(html, /onsubmit="return confirm/);
  });

  test("se puede entrar a cada chat desde la pantalla", async () => {
    const html = await pantalla();
    assert.match(html, /\/panel\/chat\?id=573000000071/);
  });

  test("cuando no hay nadie esperando, lo dice en verde", async () => {
    const repos = await conRepos();
    await sembrar(repos, {
      id: "573000000081",
      mensajes: [{ de: "cliente", texto: "hola" }, { de: "bot", texto: "¡Hola!" }],
    });
    const d = await silencios.diagnostico(repos, {});
    const html = vistas.sinResponder({ datos: d, config: {} });
    assert.match(html, /Nadie está esperando respuesta/);
    assert.match(html, /aviso ok/);
  });

  test("el enlace está en el menú de todas las pantallas", async () => {
    const html = await pantalla();
    assert.match(html, /href="\/panel\/sin-responder"/);
    assert.match(html, /aria-current="page"/, "y se marca cuando estás en ella");
  });
});

void DIR;
