"use strict";

// ==========================================================================
// LOS CHATS REALES DEL 17-NOV, CON EL CHAMPU COMO UNICO PRODUCTO ACTIVO
//
// Incidentes verificados en produccion, con main en 85eb444:
//
//   1. «¿Cuánto dura el efecto del champú?» -> el texto pasivo, sin oferta
//      ni ciudad. El arreglo de a842933 existia, pero en modo natural lo
//      redactaba el MODELO y su borrador pisaba al del codigo.
//   2. Un lead de anuncio recibio «¿qué producto te gustaría conocer?»: el
//      contexto guardado (el cinturon, ya inactivo) ganaba al anuncio.
//   3. «¿Puede producir alergia?» -> «fórmula herbal suave sin amoníaco
//      agresivo». Sin tema propio, lo redacto el modelo con el texto de
//      `seguridad` del catalogo.
//   4. «mañana hacemos el pedido» -> el precio otra vez.
//   5. «preguntó algo que no está en el catálogo» para preguntas cubiertas.
//
// Cada prueba corre con el catalogo REAL y, donde el incidente lo pide,
// con un modelo simulado que devuelve el borrador malo: el arreglo tiene
// que aguantar aunque el modelo se equivoque.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearProveedorFalso, analisisValido } = require("../src/ia/proveedores/falso");
const { crearEmisor } = require("../src/whatsapp/enviar");
const { cargarCatalogo } = require("../src/catalogo");
const cotizador = require("../src/dominio/cotizador");
const preguntas = require("../src/dominio/preguntas");
const recordatorios = require("../src/dominio/recordatorios");
const remarketing = require("../src/dominio/remarketing");
const recordar = require("../src/cerebro/recordar");
const responder = require("../src/cerebro/responder");
const campos = require("../src/dominio/campos");
const atencion = require("../src/almacen/atencion");
const mutex = require("../src/almacen/mutex");

const RAIZ = path.join(__dirname, "..");
const catalogoReal = () => cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true });
const champu = () => catalogoReal().porId.get("champu-para-canas");
const ANUNCIO = champu().anuncios[0];

let SEQ = 0;

/** Un chat con el catalogo real. `borradores` son las respuestas del modelo simulado, en orden. */
async function chat({ borradores = null, extraConfig = {}, sembrar = null } = {}) {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-17nov-")) });
  const cfg = { ...config, respuestaAutomatica: true, whatsappToken: "t", idNumero: "0", urlPublica: "https://x.invalido", ...extraConfig };
  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    atencion,
    fetchImpl: async (_u, o) => {
      salidas.push(JSON.parse(o.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.N${salidas.length}` }] }) };
    },
  });
  const proveedor = borradores ? crearProveedorFalso(borradores) : null;
  const cerebro = crearCerebro({ config: cfg, repos, catalogo: catalogoReal(), ia: crearCliente({ proveedor, intentos: 1 }), emisor });
  const tel = "573009990017";
  if (sembrar) await repos.conversaciones.guardar({ contactoId: tel, ...sembrar });
  const dice = async (texto, referral = null) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.N${++SEQ}_${process.pid}_${Date.now()}`,
      idCliente: tel,
      telefono: tel,
      nombre: null,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral,
    });
    const conversacion = await repos.conversaciones.obtener(tel);
    return { traza, texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join(" "), conversacion };
  };
  return { dice, repos };
}

const borrador = (texto, intencion = "pregunta_producto") => analisisValido({ intencion, borrador: texto });
const cuantasPreguntas = (t) => (String(t).match(/\?/g) || []).length;

// ==========================================================================
describe("0 · los precios autorizados del champú", () => {
  test("1 caja $59.900, 2 $89.000, 3 $119.000, del cotizador", () => {
    const p = champu();
    assert.equal(cotizador.cotizar({ producto: p, cantidad: 1 }).cotizacion.total, 59900);
    assert.equal(cotizador.cotizar({ producto: p, cantidad: 2 }).cotizacion.total, 89000);
    assert.equal(cotizador.cotizar({ producto: p, cantidad: 3 }).cotizacion.total, 119000);
  });

  test("es el único producto activo", () => {
    assert.deepEqual(catalogoReal().activos.map((p) => p.id), ["champu-para-canas"]);
  });
});

// ==========================================================================
describe("1 · «¿Cuánto dura el efecto del champú?»", () => {
  test("aunque el modelo mande el texto pasivo, sale la oferta y se pide la ciudad", async () => {
    const c = await chat({
      borradores: [
        borrador("¡Hola! Te cuento."),
        borrador("El color dura entre 3 y 4 semanas según el crecimiento de tu cabello."),
      ],
    });
    await c.dice("Hola, quiero información");
    const r = await c.dice("¿Cuánto dura el efecto del champú?");
    assert.equal(r.traza.respuesta.origen, "determinista", r.texto);
    assert.match(r.texto, /3 y 4 semanas/);
    assert.match(r.texto, /\$89\.000/);
    assert.match(r.texto, /\$119\.000/);
    assert.match(r.texto, /ciudad/i);
  });

  test("una sola pregunta de ciudad, y nada de batería", async () => {
    const c = await chat();
    const r = await c.dice("¿Cuánto dura el efecto del champú?");
    assert.equal(/bater[ií]a|cargador/i.test(r.texto), false, r.texto);
    assert.equal(cuantasPreguntas(r.texto), 1, r.texto);
  });

  test("las formas de preguntar lo mismo caen en el mismo tema", () => {
    for (const t of ["cuánto dura el color", "se cae con el agua?", "cada cuanto se aplica?", "es permanente?", "y cuánto dura?"]) {
      assert.deepEqual(preguntas.leer(t).temas, [preguntas.TEMAS.DURACION_EFECTO], t);
    }
  });

  test("ninguna cifra de la respuesta está escrita a mano: todas salen del cotizador", async () => {
    const p = champu();
    const t = require("../src/cerebro/contestar").deTema(preguntas.TEMAS.DURACION_EFECTO, { producto: p });
    const autorizados = new Set([1, 2, 3].map((n) => cotizador.cotizar({ producto: p, cantidad: n }).cotizacion.total));
    for (const m of t.match(/\$[\d.]+/g) || []) assert.ok(autorizados.has(Number(m.replace(/\D/g, ""))), m);
  });
});

// ==========================================================================
describe("2 · un lead del anuncio nunca recibe «¿qué producto?»", () => {
  test("con el cinturón (inactivo) guardado en el chat, el anuncio del champú manda", async () => {
    const c = await chat({ sembrar: { estado: "producto_identificado", productoId: "cinturon-termico-colicos", ficha: {}, mensajes: [] } });
    const r = await c.dice("Hola, quiero información", { source_id: ANUNCIO, source_type: "ad" });
    assert.equal(r.traza.producto.productoId, "champu-para-canas");
    assert.match(r.texto, /champ[uú]/i);
    assert.equal(/qu[eé] producto|cintur/i.test(r.texto), false, r.texto);
  });

  test("con un anuncio que no está mapeado, también: es el único activo", async () => {
    const c = await chat({ sembrar: { estado: "producto_identificado", productoId: "cinturon-termico-colicos", ficha: {}, mensajes: [] } });
    const r = await c.dice("Me interesa", { source_id: "999999999", source_type: "ad" });
    assert.equal(r.traza.producto.productoId, "champu-para-canas");
  });

  test("si el modelo pregunta qué producto quiere, su borrador se descarta", async () => {
    const c = await chat({ borradores: [borrador("¡Hola! ¿Qué producto te gustaría conocer? 😊", "saludo")] });
    const r = await c.dice("Buenas, me interesa lo del anuncio", { source_id: ANUNCIO, source_type: "ad" });
    assert.equal(/qu[eé] producto/i.test(r.texto), false, r.texto);
  });

  test("el candado, aislado", () => {
    const r = responder.preparar({
      situacion: "faltan_datos",
      producto: champu(),
      mensajeCliente: "me cuentas?",
      borradorIA: "Claro, ¿qué producto te interesa?",
    });
    assert.equal(r.origen, "determinista");
    assert.ok(r.bloqueos.some((b) => b.tipo === responder.BLOQUEOS.PREGUNTA_EL_PRODUCTO), JSON.stringify(r.bloqueos));
  });
});

// ==========================================================================
describe("3 · «¿Puede producir alergia?»: nunca se promete seguridad", () => {
  const BORRADOR_MALO = "Es una fórmula herbal suave sin amoníaco agresivo, solo usa los guantes.";

  test("aunque el modelo diga «suave, sin amoníaco», sale la recomendación prudente", async () => {
    const c = await chat({ borradores: [borrador(BORRADOR_MALO)] });
    const r = await c.dice("¿Puede producir alergia?");
    assert.equal(r.traza.respuesta.origen, "determinista", r.texto);
    assert.match(r.texto, /prueba de parche/i);
    assert.match(r.texto, /ingredientes/i);
    assert.match(r.texto, /no lo sigas usando/i);
    assert.match(r.texto, /no te puedo asegurar/i);
    assert.equal(/sin amon[ií]aco|suave|hipoalerg|no da alergia/i.test(r.texto), false, r.texto);
  });

  test("las otras formas de preguntarlo caen en el mismo tema", () => {
    for (const t of ["es seguro para piel sensible?", "tiene amoniaco?", "soy alérgica a los tintes", "me pica el cuero cabelludo", "qué ingredientes tiene?"]) {
      assert.ok(preguntas.leer(t).temas.includes(preguntas.TEMAS.ALERGIA), t);
      assert.equal(preguntas.leer(t).temas.includes(preguntas.TEMAS.CONFIANZA), false, t);
    }
  });

  test("el texto de seguridad del catálogo ya no dice «suave sin amoníaco»", () => {
    assert.equal(/suave|sin amon/i.test(champu().seguridad.texto), false);
    assert.match(champu().seguridad.texto, /prueba de parche/);
  });

  test("las promesas de seguridad están prohibidas también para el modelo", () => {
    for (const f of ["Tranquila, no da alergia", "Es apto para piel sensible", "no irrita para nada"]) {
      assert.equal(responder.revisarClaims(f, champu()).ok, false, f);
    }
  });
});

// ==========================================================================
describe("4 · «mañana hacemos el pedido»", () => {
  test("se reconoce el aplazamiento, sin repetir el precio", async () => {
    const c = await chat();
    await c.dice("cuánto vale?");
    const r = await c.dice("mañana hacemos el pedido");
    assert.equal(/\$\d/.test(r.texto), false, r.texto);
    assert.match(r.texto, /sin afán/i);
    assert.ok(r.conversacion.aplazadoEn, "no quedó anotado el aplazamiento");
  });

  test("solo promete escribirle si hay recordatorios encendidos", async () => {
    const sin = await chat({ extraConfig: { recordatorios: false } });
    assert.equal(/te escribo/i.test((await sin.dice("mañana hacemos el pedido")).texto), false);
    const con = await chat({ extraConfig: { recordatorios: true } });
    assert.match((await con.dice("mañana hacemos el pedido")).texto, /te escribo por aqu[ií]/i);
  });

  test("las variantes reales del 17-nov también", () => {
    for (const t of ["mañana hacemos el pedido", "mañana le hago el pedido", "dejeme hablarlo con mi esposa y mañana le confirmo", "más tarde te escribo"]) {
      assert.ok(preguntas.leer(t).temas.includes(preguntas.TEMAS.OTRO_DIA), t);
    }
    // «¿me llega mañana?» sigue siendo una pregunta de plazo.
    assert.deepEqual(preguntas.leer("¿me llega mañana?").temas, [preguntas.TEMAS.LLEGA_HOY]);
  });

  function conversacionAplazada(horaDelMensaje) {
    const ts = new Date(`2026-11-17T${horaDelMensaje}:00-05:00`).toISOString();
    return {
      contactoId: "573001",
      estado: "cotizado",
      saludado: true,
      ultimoDelClienteEn: ts,
      aplazadoEn: ts,
      mensajes: [
        { de: "cliente", texto: "mañana hacemos el pedido", ts },
        { de: "bot", texto: "¡Listo, sin afán!", ts, estado: "enviado" },
      ],
    };
  }
  const a = (iso) => Date.parse(iso);

  test("el seguimiento sale a las 20 h, dentro de horario", () => {
    const c = conversacionAplazada("14:00");
    assert.equal(recordatorios.decidir({ conversacion: c, activos: true, ahora: a("2026-11-17T20:00:00-05:00") }).debe, false);
    assert.equal(recordatorios.decidir({ conversacion: c, activos: true, ahora: a("2026-11-18T10:00:00-05:00") }).debe, true);
  });

  test("si las 20 h caen de madrugada, sale en la última oportunidad dentro de la ventana", () => {
    // 07:00 + 20 h = 03:00 (fuera de horario) y las 08:00 ya son la hora 25.
    const c = conversacionAplazada("07:00");
    const d = recordatorios.decidir({ conversacion: c, activos: true, ahora: a("2026-11-17T19:30:00-05:00") });
    assert.equal(d.debe, true, d.motivo);
  });

  test("y el recordatorio retoma lo que dijo, sin precio", () => {
    const t = recordar.texto({ conversacion: conversacionAplazada("14:00"), producto: champu(), orden: 1 });
    assert.match(t, /como quedamos/i);
    assert.equal(/\$\d/.test(t), false, t);
  });
});

// ==========================================================================
describe("5 · sin falsos «preguntó algo que no está en el catálogo»", () => {
  for (const q of ["se puede usar con el cabello mojado?", "¿Puede producir alergia?", "se cae con el agua?", "cada cuanto se aplica?", "es seguro para piel sensible?", "en cuánto tiempo se ve el resultado?"]) {
    test(`«${q}» se contesta y no deja tarea`, async () => {
      const c = await chat();
      await c.dice("Hola, quiero información");
      const r = await c.dice(q);
      assert.equal(atencion.pendienteDe(r.conversacion).hay, false, `${q} -> ${r.texto}`);
      assert.equal(/\$59\.900/.test(r.texto) && /tiempo/.test(q), false, `contestó el precio: ${r.texto}`);
    });
  }

  test("una pregunta sin tema que el modelo contestó bien tampoco deja tarea", async () => {
    const c = await chat({ borradores: [borrador("¡Hola!", "saludo"), borrador("Úsalo en el cabello limpio, y si te hiciste un alisado lo ideal es preguntarle a tu estilista cuándo puedes aplicarlo 😊")] });
    await c.dice("Hola, quiero información");
    const r = await c.dice("lo puedo usar después de alisarme?");
    assert.equal(r.traza.respuesta.origen, "ia");
    assert.equal(atencion.pendienteDe(r.conversacion).hay, false);
  });

  test("pero si el modelo promete confirmar, sí queda la tarea", async () => {
    const c = await chat({ borradores: [borrador("¡Hola!", "saludo"), borrador("Eso lo confirmo con el equipo y te cuento.")] });
    await c.dice("Hola, quiero información");
    const r = await c.dice("lo puedo usar después de alisarme?");
    assert.equal(atencion.pendienteDe(r.conversacion).hay, true);
  });
});

// ==========================================================================
describe("6 · lo que el catálogo dice del champú, y no lo del cinturón", () => {
  test("«¿es original?» nombra la marca Dexe, sin «Sí» y sin «nuestra marca»", async () => {
    const r = await (await chat()).dice("es original?");
    assert.match(r.texto, /Dexe/);
    assert.equal(/nuestra marca|^s[ií],/i.test(r.texto), false, r.texto);
  });

  test("«¿viene en castaño?» no recibe un sí", async () => {
    const r = await (await chat()).dice("viene en castaño?");
    assert.equal(/^s[ií]\b/i.test(r.texto), false, r.texto);
    assert.match(r.texto, /negro natural/);
  });
});

// ==========================================================================
describe("7 · remarketing por plantilla fuera de las 24 h", () => {
  const BASE = {
    remarketingPlantilla: "seguimiento_canas_v2",
    remarketingPrecios: "59900,89000,119000",
    remarketingRetiradas: ["promo_canas"],
    remarketingVariables: [],
  };
  const AHORA = Date.parse("2026-11-19T10:00:00-05:00");
  const conversacion = (extra = {}) => ({
    contactoId: "573001",
    estado: "cotizado",
    productoId: "champu-para-canas",
    saludado: true,
    ultimoDelClienteEn: "2026-11-17T09:00:00-05:00",
    mensajes: [
      { de: "cliente", texto: "cuánto vale?", ts: "2026-11-17T09:00:00-05:00" },
      { de: "bot", texto: "Una caja te queda en $59.900", ts: "2026-11-17T09:00:00-05:00", estado: "enviado" },
    ],
    ...extra,
  });
  const decidir = (cfg, conv = conversacion(), ahora = AHORA) =>
    remarketing.decidir({ conversacion: conv, producto: champu(), config: { ...BASE, ...cfg }, ahora, horaBogota: "10:00" });

  test("apagado mientras no haya plantilla", () => {
    assert.equal(decidir({ remarketingPlantilla: "" }).motivo, remarketing.MOTIVOS.APAGADO);
  });

  test("promo_canas NO se manda aunque se configure: tiene el precio viejo de $120.000", () => {
    assert.equal(decidir({ remarketingPlantilla: "promo_canas" }).motivo, remarketing.MOTIVOS.RETIRADA);
    assert.deepEqual(config.remarketingRetiradas, ["promo_canas"]);
  });

  test("una plantilla que declara un precio que el cotizador no da, no sale", () => {
    const d = decidir({ remarketingPrecios: "120000" });
    assert.equal(d.motivo, remarketing.MOTIVOS.PRECIO_NO_AUTORIZADO);
    assert.deepEqual(d.sobran, [120000]);
  });

  test("sin declarar los precios, no sale", () => {
    assert.equal(decidir({ remarketingPrecios: "" }).motivo, remarketing.MOTIVOS.SIN_PRECIOS_DECLARADOS);
  });

  test("con precios correctos, fuera de la ventana y en horario, sí", () => {
    const d = decidir({});
    assert.equal(d.debe, true, d.motivo);
    assert.equal(d.plantilla, "seguimiento_canas_v2");
  });

  test("dentro de las 24 h le toca al recordatorio, no a la plantilla", () => {
    assert.equal(decidir({}, conversacion(), Date.parse("2026-11-17T20:00:00-05:00")).motivo, remarketing.MOTIVOS.DENTRO_DE_VENTANA);
  });

  test("una vez por silencio, y nunca con pedido, pausa o un «no»", () => {
    const base = new Date(Date.parse("2026-11-17T09:00:00-05:00")).toISOString();
    assert.equal(decidir({}, conversacion({ remarketing: { base } })).motivo, remarketing.MOTIVOS.YA_ENVIADO);
    assert.equal(decidir({}, conversacion({ estado: "confirmado" })).debe, false);
    assert.equal(decidir({}, conversacion({ declino: true })).debe, false);
    assert.equal(decidir({}, conversacion({ atencion: { pausado: true } })).debe, false);
  });

  test("el nombre solo si lo escribió el cliente, nunca el del perfil", () => {
    const perfil = conversacion({ ficha: { nombre: { valor: "🤪 Ana", estado: "confirmado", origen: campos.ORIGENES.PERFIL } } });
    assert.equal(decidir({ remarketingVariables: ["nombre"] }, perfil).motivo, remarketing.MOTIVOS.SIN_NOMBRE);
    const escrito = conversacion({ ficha: { nombre: { valor: "ana pérez", estado: "confirmado", origen: campos.ORIGENES.CLIENTE } } });
    assert.deepEqual(decidir({ remarketingVariables: ["nombre"] }, escrito).variables, ["Ana"]);
  });

  test("el barrido manda la plantilla con el permiso del bot y lo apunta", async () => {
    const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-remk-")) });
    await repos.conversaciones.guardar(conversacion());
    const enviadas = [];
    const emisor = {
      enviarTexto: async () => ({ enviado: false, motivo: "no_deberia" }),
      enviarPlantilla: async (o) => {
        enviadas.push(o);
        return { enviado: true, wamid: "wamid.R1" };
      },
    };
    const cfg = { ...config, ...BASE, recordatorios: true, recordatoriosDesdeHora: 8, recordatoriosHastaHora: 21 };
    const informe = await recordar.pasada({ config: cfg, repos, catalogo: catalogoReal(), emisor, ahora: AHORA });
    assert.equal(enviadas.length, 1, JSON.stringify(informe.porMotivo));
    assert.equal(enviadas[0].plantilla, "seguimiento_canas_v2");
    assert.equal(enviadas[0].permiso, require("../src/whatsapp/enviar").PERMISOS.CONVERSACION);
    const guardada = await repos.conversaciones.obtener("573001");
    assert.ok(guardada.remarketing && guardada.remarketing.base);
    // Y la segunda pasada no lo repite.
    await recordar.pasada({ config: cfg, repos, catalogo: catalogoReal(), emisor, ahora: AHORA + 600000 });
    assert.equal(enviadas.length, 1);
  });
});
