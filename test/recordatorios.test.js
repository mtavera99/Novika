"use strict";

// ==========================================================================
// LOS RECORDATORIOS
//
// El bot escribiéndole primero a quien se quedó callado. Lo autorizó Marco el
// 2026-10-10: «deja por lo menos uno […] como tú dijiste a los 30 minutos, y
// quizás otro a las dos o tres horas».
//
// --------------------------------------------------------------------------
// POR QUÉ ESTE FICHERO ES TAN LARGO
// --------------------------------------------------------------------------
//
// Porque es la única función del bot que manda mensajes que NADIE pidió, a
// números de clientes reales, con una campaña de Facebook encendida. Un
// recordatorio mal decidido no es un texto feo: es spam desde el número de
// la empresa, y un reporte de spam le cuesta a Marco la calidad del número —
// que vale mucho más que cualquier venta suelta.
//
// Así que lo que se prueba aquí, sobre todo, es CUÁNDO **NO** HAY QUE
// ESCRIBIR. Cada `test` de la sección 2 corresponde a una guarda del módulo.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const { config } = require("../src/config");
const recordatorios = require("../src/dominio/recordatorios");
const recordar = require("../src/cerebro/recordar");
const atencion = require("../src/almacen/atencion");
const campos = require("../src/dominio/campos");
const estados = require("../src/dominio/estados");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearEmisor } = require("../src/whatsapp/enviar");
const { cargarCatalogo } = require("../src/catalogo");

const RAIZ = path.join(__dirname, "..");
const MIN = 60 * 1000;
const HORA = 60 * MIN;

/** Un campo de la ficha ya confirmado, construido con el dominio. */
const confirmado = (valor) =>
  campos.confirmar(campos.proponer(campos.campoVacio(), valor, campos.ORIGENES.CLIENTE), () => ({ ok: true, valor }));

/** Las 15:00 en Bogotá (20:00 UTC): dentro del horario permitido. */
const LAS_TRES_DE_LA_TARDE = Date.parse("2026-10-10T20:00:00Z");
/** Las 03:00 en Bogotá (08:00 UTC): fuera del horario. */
const LAS_TRES_DE_LA_MANANA = Date.parse("2026-10-10T08:00:00Z");

/**
 * Una conversación viva y lista para recibir su recordatorio.
 *
 * Se parte de este objeto y cada prueba rompe UNA cosa, para que el fallo
 * señale exactamente a la guarda que dejó de funcionar.
 */
function conversacionCallada({ silencioMin = 45, ahora = LAS_TRES_DE_LA_TARDE } = {}) {
  const cuando = new Date(ahora - silencioMin * MIN).toISOString();
  return {
    contactoId: "573001112233",
    estado: estados.ESTADOS.CAPTURANDO_DATOS,
    saludado: true,
    datosPedidos: true,
    ultimoDelClienteEn: cuando,
    // Los campos se construyen con el dominio, no a mano: inventarse la
    // forma del objeto hace que la prueba mida otra cosa (la primera versión
    // de este fichero lo hizo, y los textos salían pidiendo la ciudad que la
    // clienta ya había dado).
    ficha: {
      nombre: confirmado("Ana María"),
      telefono: confirmado("573001112233"),
      ciudad: confirmado("Bogota"),
    },
    mensajes: [
      { de: "cliente", texto: "Cuánto vale", ts: cuando },
      { de: "bot", texto: "Te queda en $49.900...", ts: new Date(ahora - (silencioMin - 1) * MIN).toISOString() },
    ],
  };
}

const decidir = (conversacion, extra = {}) =>
  recordatorios.decidir({
    conversacion,
    ahora: LAS_TRES_DE_LA_TARDE,
    activos: true,
    minutos: [30, 180],
    desdeHora: 8,
    hastaHora: 21,
    ...extra,
  });

// ==========================================================================
// 1 · CUÁNDO SÍ
// ==========================================================================
describe("1 · a quien se quedó callado se le escribe", () => {
  test("a los 30 minutos sale el primero", () => {
    const r = decidir(conversacionCallada({ silencioMin: 31 }));
    assert.equal(r.debe, true, r.motivo);
    assert.equal(r.orden, 1);
  });

  test("a las 3 horas sale el segundo", () => {
    const c = conversacionCallada({ silencioMin: 185 });
    c.recordatorios = { base: c.ultimoDelClienteEn, enviados: 1 };
    const r = decidir(c);
    assert.equal(r.debe, true, r.motivo);
    assert.equal(r.orden, 2);
  });

  test("y después ya no se insiste más", () => {
    const c = conversacionCallada({ silencioMin: 600 });
    c.recordatorios = { base: c.ultimoDelClienteEn, enviados: 2 };
    const r = decidir(c);
    assert.equal(r.debe, false);
    assert.equal(r.motivo, recordatorios.MOTIVOS.COMPLETOS);
  });

  test("si el cliente vuelve a escribir, la serie se reinicia", () => {
    // Cada silencio nuevo es una oportunidad nueva. Los toques no se
    // acumulan de por vida: dos por silencio, no dos por cliente.
    const c = conversacionCallada({ silencioMin: 40 });
    c.recordatorios = { base: new Date(LAS_TRES_DE_LA_TARDE - 5 * HORA).toISOString(), enviados: 2 };
    const r = decidir(c);
    assert.equal(r.debe, true, `no reinició la serie: ${r.motivo}`);
    assert.equal(r.orden, 1);
  });
});

// ==========================================================================
// 2 · CUÁNDO NO — una prueba por guarda
// ==========================================================================
describe("2 · cuándo NO se le escribe", () => {
  test("apagado por defecto: sin el interruptor no sale nada", () => {
    // La guarda más importante de todas. `RECORDATORIOS` es false por
    // defecto: que esto se encienda solo porque alguien despliega sería
    // mandar mensajes no solicitados a clientes reales sin que nadie lo
    // decidiera.
    assert.equal(config.recordatorios, false, "RECORDATORIOS dejó de estar apagado por defecto");

    const r = recordatorios.decidir({ conversacion: conversacionCallada(), ahora: LAS_TRES_DE_LA_TARDE });
    assert.equal(r.debe, false);
    assert.equal(r.motivo, recordatorios.MOTIVOS.APAGADO);
  });

  test("antes de los 30 minutos no toca", () => {
    const r = decidir(conversacionCallada({ silencioMin: 10 }));
    assert.equal(r.debe, false);
    assert.equal(r.motivo, recordatorios.MOTIVOS.PRONTO);
  });

  test("a quien YA COMPRÓ no se le pide que compre", () => {
    for (const estado of [estados.ESTADOS.CONFIRMADO, estados.ESTADOS.MODIFICANDO, estados.ESTADOS.POSVENTA]) {
      const c = conversacionCallada();
      c.estado = estado;
      const r = decidir(c);
      assert.equal(r.debe, false, `le insistió a alguien en ${estado}`);
      assert.equal(r.motivo, recordatorios.MOTIVOS.TIENE_PEDIDO);
    }
  });

  test("a quien dijo que NO no se le insiste", () => {
    // Insistirle no es vender: es la vía rápida a que reporte el número como
    // spam, y eso cuesta la calidad del número.
    const c = conversacionCallada();
    c.declino = true;
    const r = decidir(c);
    assert.equal(r.debe, false);
    assert.equal(r.motivo, recordatorios.MOTIVOS.DECLINO);
  });

  test("si el chat está en manos de una persona, el bot se calla", () => {
    const c = conversacionCallada();
    c.estado = estados.ESTADOS.ESCALADO;
    assert.equal(decidir(c).motivo, recordatorios.MOTIVOS.BLINDADO);

    const p = conversacionCallada();
    p.atencion = { pausado: true, por: "panel", desde: new Date().toISOString() };
    assert.equal(decidir(p).motivo, recordatorios.MOTIVOS.PAUSADO);
  });

  test("si el último mensaje es del CLIENTE, el bot le debe una respuesta", () => {
    // Mandarle "¿seguimos?" a quien lleva una hora esperando contestación es
    // la peor versión posible de esta función. Pasa de verdad: con el chat
    // pausado, los mensajes del cliente se registran y no se contestan.
    const c = conversacionCallada({ silencioMin: 60 });
    c.mensajes = [
      { de: "bot", texto: "Te queda en $49.900", ts: new Date(LAS_TRES_DE_LA_TARDE - 70 * MIN).toISOString() },
      { de: "cliente", texto: "y el envío?", ts: new Date(LAS_TRES_DE_LA_TARDE - 60 * MIN).toISOString() },
    ];
    const r = decidir(c);
    assert.equal(r.debe, false);
    assert.equal(r.motivo, recordatorios.MOTIVOS.TURNO_DEL_BOT);
  });

  test("pasadas 24 h no se escribe: Meta no lo entregaría", () => {
    // La ventana de 24 h de WhatsApp. Fuera de ella solo entran plantillas
    // aprobadas, y NOVIKA todavía no tiene ninguna. Se comprueba aquí para
    // no gastar una llamada a la red en algo que ya se sabe que falla.
    const r = decidir(conversacionCallada({ silencioMin: 25 * 60 }));
    assert.equal(r.debe, false);
    assert.equal(r.motivo, recordatorios.MOTIVOS.VENTANA_CERRADA);
  });

  test("a las 3 de la mañana no se escribe", () => {
    // Y se mira la hora de BOGOTÁ, no la del servidor, que en Render va en
    // UTC. Sin esa conversión la franja «8 a 21» sería «3 de la mañana a 4
    // de la tarde» en Colombia, y el defecto solo se vería en producción.
    const c = conversacionCallada({ silencioMin: 45, ahora: LAS_TRES_DE_LA_MANANA });
    const r = decidir(c, { ahora: LAS_TRES_DE_LA_MANANA });
    assert.equal(r.debe, false);
    assert.equal(r.motivo, recordatorios.MOTIVOS.FUERA_DE_HORARIO);
  });

  test("si el bot nunca le dijo nada, no hay nada que retomar", () => {
    const c = conversacionCallada();
    c.saludado = false;
    assert.equal(decidir(c).motivo, recordatorios.MOTIVOS.NO_SALUDADO);
  });

  test("sin saber cuándo escribió, no se adivina", () => {
    const c = conversacionCallada();
    delete c.ultimoDelClienteEn;
    c.mensajes = [{ de: "bot", texto: "hola", ts: new Date(LAS_TRES_DE_LA_TARDE).toISOString() }];
    assert.equal(decidir(c).motivo, recordatorios.MOTIVOS.SIN_MARCA);
  });
});

// ==========================================================================
// 3 · LA MARCA NO SE SACA DEL HISTORIAL RECORTADO
// ==========================================================================
describe("3 · el historial se recorta, el campo no", () => {
  test("con 60 mensajes del bot encima, todavía se sabe cuándo habló el cliente", () => {
    // `atencion` recorta a MAX_MENSAJES = 60. En un chat largo donde los
    // últimos sesenta son del bot y del operador, el mensaje del cliente SE
    // CAE de la lista. Si la marca se sacara de ahí, los recordatorios
    // dejarían de funcionar justo en los chats más trabajados — los que más
    // cerca están de cerrar.
    const c = conversacionCallada({ silencioMin: 45 });
    c.mensajes = Array.from({ length: 70 }, (_, i) => ({
      de: "bot",
      texto: `mensaje ${i}`,
      ts: new Date(LAS_TRES_DE_LA_TARDE - (70 - i) * MIN).toISOString(),
    }));

    assert.equal(atencion.ultimoDelCliente(c), null, "la prueba no está midiendo lo que cree");
    assert.ok(recordatorios.ultimoDelClienteMs(c), "se perdió la marca del cliente");

    const r = decidir(c);
    assert.equal(r.debe, true, `no recordó por culpa del recorte: ${r.motivo}`);
  });
});

// ==========================================================================
// 4 · LOS TEXTOS
// ==========================================================================
describe("4 · qué le dice", () => {
  const elCinturon = () => cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).productos[0];

  test("retoma donde se quedó y pide UNA sola cosa", () => {
    const c = conversacionCallada();
    // Tiene nombre y ciudad; le falta la dirección.
    const t = recordar.texto({ conversacion: c, producto: elCinturon(), orden: 1 });

    assert.match(t, /dirección/i, `no pidió lo que falta: ${t}`);
    // Una sola petición: un recordatorio con tres preguntas no se contesta.
    assert.equal((t.match(/\?/g) || []).length, 1, `hizo más de una pregunta: ${t}`);
    // Y no vuelve a saludar como si fuera la primera vez.
    assert.equal(/en qué te puedo ayudar/i.test(t), false, `volvió a empezar: ${t}`);
  });

  test("el segundo toque añade el argumento, no la presión", () => {
    const c = conversacionCallada();
    const t = recordar.texto({ conversacion: c, producto: elCinturon(), orden: 2 });

    assert.match(t, /pagas cuando|al recibir/i, `sin el argumento del riesgo: ${t}`);
    assert.match(t, /7 días/i, `sin la prueba de 7 días: ${t}`);
  });

  test("nunca inventa una urgencia", () => {
    // "Quedan pocas unidades" o "la oferta vence hoy" convierten en el corto
    // plazo y no se pueden sostener: no hay inventario en el catálogo que lo
    // respalde, y una urgencia falsa repetida convierte el número en spam.
    const PROHIBIDO = /últimas unidades|quedan pocas|se agota|vence hoy|solo por hoy|última oportunidad|precio sube/i;
    for (const orden of [1, 2]) {
      for (const base of [conversacionCallada(), { ...conversacionCallada(), resumenMostrado: true }]) {
        const t = recordar.texto({ conversacion: base, producto: elCinturon(), orden });
        assert.equal(PROHIBIDO.test(t), false, `inventó una urgencia: ${t}`);
      }
    }
  });

  test("a quien ya vio el resumen solo le pide el sí", () => {
    const c = { ...conversacionCallada(), resumenMostrado: true };
    const t = recordar.texto({ conversacion: c, producto: elCinturon(), orden: 1 });
    assert.match(t, /resumen|confirm/i, t);
  });

  test("usa el nombre de pila, y no un emoji", () => {
    const conEmoji = conversacionCallada();
    conEmoji.ficha.nombre = { confirmado: "🤪", candidato: null, origen: "cliente" };
    const t = recordar.texto({ conversacion: conEmoji, producto: elCinturon(), orden: 1 });
    assert.equal(/Hola, 🤪/.test(t), false, `saludó a un emoji: ${t}`);

    const conNombre = conversacionCallada();
    const t2 = recordar.texto({ conversacion: conNombre, producto: elCinturon(), orden: 1 });
    assert.match(t2, /Hola, Ana/, t2);
    assert.equal(/Ana María/.test(t2), false, `usó el apellido, suena a cobro: ${t2}`);
  });
});

// ==========================================================================
// 5 · EL BARRIDO, DE PUNTA A PUNTA
// ==========================================================================
describe("5 · el barrido", () => {
  async function montar({ recordatoriosActivos = true, respuestaAutomatica = true } = {}) {
    const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-rec-")) });
    const cfg = {
      ...config,
      respuestaAutomatica,
      recordatorios: recordatoriosActivos,
      recordatorioMinutos: [30, 180],
      recordatoriosDesdeHora: 0,
      recordatoriosHastaHora: 24,
      whatsappToken: "token-de-prueba",
      idNumero: "000",
    };
    const salidas = [];
    const emisor = crearEmisor({
      config: cfg,
      repos,
      atencion,
      fetchImpl: async (_u, o) => {
        salidas.push(JSON.parse(o.body));
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.R${salidas.length}` }] }) };
      },
    });
    const catalogo = cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true });
    return { repos, cfg, emisor, catalogo, salidas };
  }

  test("manda el recordatorio y lo deja anotado en el chat", async () => {
    const { repos, cfg, emisor, catalogo, salidas } = await montar();
    await repos.conversaciones.guardar(conversacionCallada({ silencioMin: 45 }));

    const informe = await recordar.pasada({
      config: cfg,
      repos,
      catalogo,
      emisor,
      ahora: LAS_TRES_DE_LA_TARDE,
    });

    assert.equal(informe.enviados, 1, `no lo mandó: ${JSON.stringify(informe.porMotivo)}`);
    assert.equal(salidas.length, 1, "no salió ningún mensaje a la red");

    const conv = await repos.conversaciones.obtener("573001112233");
    assert.equal(conv.recordatorios.enviados, 1, "no apuntó el recordatorio");
    // Y queda en el historial, marcado como que el bot escribió primero: si
    // no, el panel no lo muestra y la ventana de 24 h se descoordina de lo
    // que el cliente vio.
    const ultimo = atencion.mensajes(conv).slice(-1)[0];
    assert.equal(ultimo.de, atencion.QUIEN.BOT);
    assert.match(String(ultimo.por || ""), /recordatorio/);
  });

  test("no manda dos veces el mismo", async () => {
    const { repos, cfg, emisor, catalogo } = await montar();
    await repos.conversaciones.guardar(conversacionCallada({ silencioMin: 45 }));

    const a = await recordar.pasada({ config: cfg, repos, catalogo, emisor, ahora: LAS_TRES_DE_LA_TARDE });
    const b = await recordar.pasada({ config: cfg, repos, catalogo, emisor, ahora: LAS_TRES_DE_LA_TARDE + MIN });

    assert.equal(a.enviados, 1);
    assert.equal(b.enviados, 0, "repitió el recordatorio en la pasada siguiente");
  });

  test("con el interruptor apagado no toca la red", async () => {
    const { repos, cfg, emisor, catalogo, salidas } = await montar({ recordatoriosActivos: false });
    await repos.conversaciones.guardar(conversacionCallada({ silencioMin: 45 }));

    const informe = await recordar.pasada({ config: cfg, repos, catalogo, emisor, ahora: LAS_TRES_DE_LA_TARDE });
    assert.equal(informe.enviados, 0);
    assert.equal(salidas.length, 0, "mandó un mensaje con los recordatorios apagados");
  });

  test("si el mensaje NO sale, no se apunta como enviado", async () => {
    // Es la lección del modo sombra: apuntar antes de enviar dejaría al
    // cliente sin recordatorio para siempre, porque el bot creería que ya se
    // lo mandó. Aquí se apaga RESPUESTA_AUTOMATICA, que es lo que bloquea.
    const { repos, cfg, emisor, catalogo, salidas } = await montar({ respuestaAutomatica: false });
    await repos.conversaciones.guardar(conversacionCallada({ silencioMin: 45 }));

    const informe = await recordar.pasada({ config: cfg, repos, catalogo, emisor, ahora: LAS_TRES_DE_LA_TARDE });

    assert.equal(salidas.length, 0, "salió a la red con el interruptor apagado");
    assert.equal(informe.enviados, 0);
    assert.equal(informe.bloqueados, 1, `no contó el bloqueo: ${JSON.stringify(informe.porMotivo)}`);

    const conv = await repos.conversaciones.obtener("573001112233");
    assert.equal(conv.recordatorios, undefined, "apuntó un recordatorio que nunca salió");
  });

  test("un chat pausado no recibe nada, aunque le toque", async () => {
    const { repos, cfg, emisor, catalogo, salidas } = await montar();
    const c = conversacionCallada({ silencioMin: 45 });
    c.atencion = { pausado: true, por: "panel", desde: new Date(LAS_TRES_DE_LA_TARDE).toISOString() };
    await repos.conversaciones.guardar(c);

    const informe = await recordar.pasada({ config: cfg, repos, catalogo, emisor, ahora: LAS_TRES_DE_LA_TARDE });
    assert.equal(salidas.length, 0, "le escribió por encima de una persona");
    assert.equal(informe.enviados, 0);
  });

  test("la métrica está en la lista blanca, o no se vería", () => {
    // `metricas.incrementar` manda cualquier nombre no listado a
    // "desconocido". Este agujero ya ocultó seis acciones del panel y la
    // pausa automática del 08-oct.
    const fuente = fs.readFileSync(path.join(RAIZ, "src", "metricas.js"), "utf8");
    assert.match(fuente, /"recordatorio_enviado"/, "la métrica no está en la lista blanca");
    assert.match(fuente, /"recordatorio_no_enviado"/, "la métrica no está en la lista blanca");
  });
});
