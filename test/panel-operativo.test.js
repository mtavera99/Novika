"use strict";

// ==========================================================================
// EL TABLERO OPERATIVO (2026-11-11)
//
// Marco pidio que /panel tenga la misma forma de trabajar el dia que el
// panel de su otro negocio: numeros contra ayer, atencion por dias, cola de
// despacho con alertas y acciones en la fila, anulados con «reactivar»,
// por anuncio y las conversaciones en la misma pantalla.
//
// Esta bateria fija los CALCULOS (operativo.js es puro) y lo que la vista
// no puede romper: etiquetas en cada celda, scripts que compilan, ningun
// manejador sin declarar, y ningun nombre del otro negocio.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const operativo = require("../src/panel/operativo");
const vistas = require("../src/panel/vistas");
const datos = require("../src/panel/datos");
const fecha = require("../src/panel/fecha");
const atencion = require("../src/almacen/atencion");
const dominioPedido = require("../src/dominio/pedido");

const AHORA = Date.parse("2026-11-11T20:00:00Z"); // 15:00 en Bogota
const HOY = fecha.hoyBogota(AHORA);
const AYER = fecha.diaAnterior(HOY);
const enBogota = (dia, hora = "15:00") => new Date(`${dia}T${hora}:00-05:00`).toISOString();

function pedido({ id, contactoId = "573001", estado = "confirmado", dia = HOY, total = 49900, cantidad = 1, ciudad = "Cali", telefono = "3001110001", direccion = "Calle 1 # 2-3", revisiones = [], extra = {} }) {
  return {
    id,
    version: 1,
    estado,
    contactoId,
    creadoEn: enBogota(dia),
    cantidad,
    producto: { id: "p", nombre: "Producto" },
    destinatario: { nombre: "Ana Pérez", telefono, ciudad, direccion },
    cotizacion: { productoId: "p", cantidad, subtotal: total, envio: 0, descuento: 0, total, condiciones: { pagoMetodo: "contraentrega" } },
    revisiones,
    historial: [],
    ...extra,
  };
}

function conversacion(contactoId, mensajes = [], extra = {}) {
  const c = { contactoId, estado: "explorando", ficha: {}, mensajes: [], ...extra };
  for (const m of mensajes) atencion.anotarMensaje(c, m);
  return c;
}

// ==========================================================================
describe("1 · los números de un día", () => {
  const pedidos = [
    pedido({ id: "A", dia: HOY, total: 49900 }),
    pedido({ id: "B", dia: HOY, total: 85000, cantidad: 2, ciudad: "Bogotá, Cundinamarca", contactoId: "573002", telefono: "3002" }),
    pedido({ id: "C", dia: HOY, estado: "cancelado", total: 49900 }),
    pedido({ id: "D", dia: AYER, total: 49900, contactoId: "573004", telefono: "3004" }),
    pedido({
      id: "E",
      dia: AYER,
      estado: "entregado",
      contactoId: "573005",
      telefono: "3005",
      extra: { entrega: { entregadoEn: enBogota(HOY, "10:00"), importeRecaudado: 49900 } },
    }),
  ];
  const conversaciones = [
    conversacion("573001", [{ de: "cliente", texto: "hola", ts: enBogota(HOY, "09:00") }]),
    conversacion("573002", [{ de: "cliente", texto: "hola", ts: enBogota(HOY, "11:00") }]),
    conversacion("573003", [{ de: "bot", texto: "¿seguimos?", ts: enBogota(HOY, "12:00") }]),
    conversacion("573004", [{ de: "cliente", texto: "hola", ts: enBogota(AYER, "09:00") }]),
  ];

  test("pedidos, vendido, unidades, ticket y share de 2, sin contar los cancelados", () => {
    const d = operativo.delDia(HOY, { conversaciones, pedidos });
    assert.equal(d.pedidos, 2);
    assert.equal(d.vendido, 134900);
    assert.equal(d.unidades, 3);
    assert.equal(d.ticketPromedio, 67450);
    assert.equal(d.share2uds, 50);
  });

  test("«recaudo hoy» es lo ENTREGADO hoy, no lo vendido: esto es contraentrega", () => {
    const d = operativo.delDia(HOY, { conversaciones, pedidos });
    assert.equal(d.recaudo, 49900);
    assert.equal(d.entregas, 1);
  });

  test("conversaciones del día son las que el CLIENTE escribió ese día", () => {
    assert.equal(operativo.delDia(HOY, { conversaciones, pedidos }).conversaciones, 2);
    assert.equal(operativo.delDia(AYER, { conversaciones, pedidos }).conversaciones, 1);
  });

  test("el cierre se topa en 100% y lo dice", () => {
    const d = operativo.delDia(HOY, { conversaciones: conversaciones.slice(0, 1), pedidos });
    assert.equal(d.cierre, 100);
    assert.equal(d.cierreTopado, true);
  });

  test("ciudades top, sin el departamento", () => {
    const d = operativo.delDia(HOY, { conversaciones, pedidos });
    assert.deepEqual(d.topCiudades.map(([c]) => c).sort(), ["Bogotá", "Cali"]);
  });

  test("la comparación contra ayer no inventa porcentajes cuando ayer fue cero", () => {
    assert.equal(operativo.variacion(5, 0), null);
    assert.deepEqual(operativo.variacion(10, 10), { igual: true, pct: 0 });
    assert.deepEqual(operativo.variacion(15, 10), { igual: false, sube: true, pct: 50 });
    assert.deepEqual(operativo.variacion(5, 10), { igual: false, sube: false, pct: 50 });
  });
});

// ==========================================================================
describe("2 · lo que hay que atender", () => {
  test("se agrupa en Hoy, Ayer y Más viejos, y lo atendido se queda apagado", () => {
    const viejo = enBogota(fecha.diaAnterior(AYER), "09:00");
    const conv = [
      conversacion("hoy", [{ de: "cliente", texto: "¿y llega a Pasto?", ts: enBogota(HOY, "14:00") }]),
      conversacion("ayer", [{ de: "cliente", texto: "¿me ayudas?", ts: enBogota(AYER, "14:00") }]),
      conversacion("viejo", [{ de: "cliente", texto: "hola?", ts: viejo }]),
      conversacion("contestado", [
        { de: "cliente", texto: "hola", ts: enBogota(HOY, "08:00") },
        { de: "bot", texto: "¡Hola!", ts: enBogota(HOY, "08:00") },
      ]),
      conversacion("atendido", [{ de: "cliente", texto: "gracias", ts: enBogota(HOY, "09:00") }], {
        atencion: { atendidoEn: enBogota(HOY, "09:30") },
      }),
    ];
    const r = operativo.listaDeAtencion({ conversaciones: conv, ahora: AHORA });
    assert.deepEqual(
      r.grupos.map((g) => [g.titulo, g.filas.map((f) => f.contactoId)]),
      [
        ["Hoy", ["hoy", "atendido"]],
        ["Ayer", ["ayer"]],
        ["Más viejos", ["viejo"]],
      ]
    );
    assert.equal(r.faltan, 3);
    assert.equal(r.grupos[0].filas[1].hecho, true);
  });

  test("una tarea anotada por el bot manda sobre todo lo demás, con su pregunta", () => {
    const c = conversacion("t", [
      { de: "cliente", texto: "¿trae factura?", ts: enBogota(HOY, "10:00") },
      { de: "bot", texto: "Lo dejo anotado", ts: enBogota(HOY, "10:00") },
    ]);
    atencion.anotarPendiente(c, { motivo: atencion.MOTIVOS_PENDIENTE.SIN_DATO, pregunta: "¿trae factura?", ahora: AHORA });
    const m = operativo.motivoDeAtencion(c, { ahora: AHORA });
    assert.equal(m.nivel, "alta");
    assert.equal(m.pregunta, "¿trae factura?");
  });

  test("quien ya compró sale marcado como posventa", () => {
    const conv = [conversacion("573001", [{ de: "cliente", texto: "¿y mi guía?", ts: enBogota(HOY, "10:00") }])];
    const pedidosPorContacto = new Map([["573001", [pedido({ id: "A" })]]]);
    const r = operativo.listaDeAtencion({ conversaciones: conv, pedidosPorContacto, ahora: AHORA });
    assert.equal(r.posventa, 1);
  });
});

// ==========================================================================
describe("3 · la cola de despacho y sus alertas", () => {
  test("pendientes del más viejo al más nuevo; despachados y anulados aparte", () => {
    const cola = operativo.colaDeDespacho([
      pedido({ id: "nuevo", dia: HOY, contactoId: "1", telefono: "1" }),
      pedido({ id: "viejo", dia: AYER, contactoId: "2", telefono: "2" }),
      pedido({ id: "salio", estado: "despachado", contactoId: "3", telefono: "3", extra: { despacho: { guia: "123" } } }),
      pedido({ id: "anulado", estado: "cancelado", contactoId: "4", telefono: "4" }),
    ]);
    assert.deepEqual(cola.pendientes.map((x) => x.pedido.id), ["viejo", "nuevo"]);
    assert.deepEqual(cola.despachados.map((p) => p.id), ["salio"]);
    assert.deepEqual(cola.anulados.map((p) => p.id), ["anulado"]);
    assert.equal(cola.porRecaudar, 99800);
  });

  test("¿REPETIDO?: el mismo celular con otro pedido vivo", () => {
    const cola = operativo.colaDeDespacho([
      pedido({ id: "A", contactoId: "x", telefono: "3001112233" }),
      pedido({ id: "B", contactoId: "y", telefono: "573001112233" }),
    ]);
    assert.ok(cola.pendientes.every((x) => x.alertas.repetido));
  });

  test("SIN CONFIRMAR sale de `listoParaDespachar`, no de una regla nueva", () => {
    const p = pedido({ id: "A", estado: "en_revision", revisiones: [{ campo: "direccion", motivo: "solo el barrio" }] });
    const a = operativo.alertasDe(p);
    assert.equal(a.sinConfirmar, dominioPedido.listoParaDespachar(p).motivo);
  });

  test("PRECIO NO CUADRA compara el pedido con su propio desglose, no con el catálogo de hoy", () => {
    const bien = pedido({ id: "A" });
    assert.equal(operativo.motivoDePrecio(bien), null);
    const mal = pedido({ id: "B" });
    mal.cotizacion.total = 30000;
    assert.match(operativo.motivoDePrecio(mal), /desglose/);
    const cantidad = pedido({ id: "C", cantidad: 2 });
    cantidad.cotizacion.cantidad = 1;
    cantidad.cotizacion.total = cantidad.cotizacion.subtotal;
    assert.match(operativo.motivoDePrecio(cantidad), /unidades/);
  });

  test("OFICINA: la dirección normalizada a «Oficina <transportadora>»", () => {
    assert.equal(operativo.esOficina(pedido({ id: "A", direccion: "Oficina Interrapidísimo" })), true);
    assert.equal(operativo.esOficina(pedido({ id: "B", direccion: "Calle 10 # 5-20" })), false);
  });

  test("los duplicados son el mismo cliente con el mismo total, y los cancelados no cuentan", () => {
    const g = operativo.duplicados([
      pedido({ id: "A", telefono: "3001" }),
      pedido({ id: "B", telefono: "3001" }),
      pedido({ id: "C", telefono: "3001", total: 85000 }),
      pedido({ id: "D", telefono: "3001", estado: "cancelado" }),
    ]);
    assert.equal(g.length, 1);
    assert.deepEqual(g[0].map((p) => p.id), ["A", "B"]);
  });
});

// ==========================================================================
describe("4 · por anuncio", () => {
  test("agrupa por el anuncio del que vino, con los que se fueron sin escribir", () => {
    const ad = { source_id: "120210000000123456", headline: "Para los cólicos" };
    const conv = [
      conversacion("1", [{ de: "cliente", texto: "info", ts: enBogota(HOY) }], { referral: ad }),
      conversacion("2", [{ de: "cliente", texto: "info", ts: enBogota(HOY) }, { de: "cliente", texto: "precio?", ts: enBogota(HOY) }], { referral: ad }),
      conversacion("3", [{ de: "cliente", texto: "hola", ts: enBogota(HOY) }]),
    ];
    const filas = operativo.porAnuncio({ conversaciones: conv, pedidos: [pedido({ id: "A", contactoId: "2" })] });
    const delAnuncio = filas.find((f) => f.id === ad.source_id);
    assert.equal(delAnuncio.charlas, 2);
    assert.equal(delAnuncio.sinEscribir, 1);
    assert.equal(delAnuncio.pedidos, 1);
    assert.equal(delAnuncio.cierre, 50);
    assert.ok(filas.find((f) => f.id === "directo"));
  });
});

// ==========================================================================
describe("5 · reactivar un pedido anulado", () => {
  const anulado = () => dominioPedido.cancelar({ pedido: pedido({ id: "A" }), motivo: "por error" }).pedido;

  test("vuelve a confirmado, con su versión y el motivo de la anulación en el historial", () => {
    const r = dominioPedido.reactivar({ pedido: anulado(), porQue: "panel" });
    assert.equal(r.ok, true);
    assert.equal(r.pedido.estado, "confirmado");
    assert.equal(r.pedido.version, 3);
    const h = r.pedido.historial[r.pedido.historial.length - 1];
    assert.equal(h.accion, "reactivado");
    assert.match(h.motivoDeLaAnulacion, /por error/);
  });

  test("con dudas sin cerrar vuelve EN REVISIÓN: anular y reactivar no limpia nada", () => {
    const p = dominioPedido.cancelar({
      pedido: pedido({ id: "A", estado: "en_revision", revisiones: [{ campo: "nombre", motivo: "x" }] }),
    }).pedido;
    assert.equal(dominioPedido.reactivar({ pedido: p }).pedido.estado, "en_revision");
  });

  test("solo desde anulado, y nunca si llegó a despacharse", () => {
    assert.equal(dominioPedido.reactivar({ pedido: pedido({ id: "A" }) }).ok, false);
    const salio = anulado();
    salio.despacho = { guia: "999" };
    assert.equal(dominioPedido.reactivar({ pedido: salio }).ok, false);
  });
});

// ==========================================================================
describe("6 · la vista", () => {
  function datosDePrueba() {
    const conversaciones = [
      conversacion("573001", [{ de: "cliente", texto: "hola <b>", ts: enBogota(HOY, "14:00") }]),
      conversacion("573002", [{ de: "cliente", texto: "¿y mi guía?", ts: enBogota(HOY, "13:00") }]),
    ];
    const pedidos = [
      pedido({ id: "NOV-1", contactoId: "573002" }),
      pedido({ id: "NOV-2", contactoId: "573003", telefono: "3003", estado: "despachado", extra: { despacho: { guia: "777", transportadora: "Coordinadora" } } }),
      pedido({ id: "NOV-3", contactoId: "573004", telefono: "3004", estado: "cancelado" }),
    ];
    return {
      dia: HOY,
      hoy: HOY,
      resumen: datos.resumirPedidos(pedidos),
      pedidos,
      chats: [],
      porClase: {},
      cuentas: {},
      operativo: operativo.tableroOperativo({ conversaciones, pedidos, ahora: AHORA }),
      recientes: datos.conversacionesRecientes(conversaciones, pedidos, { ahora: AHORA }),
    };
  }
  const html = () => vistas.tablero({ datos: datosDePrueba(), envioManualActivo: true, numeroDelBot: "+57 300 000 0000" });

  test("trae los atajos, los KPI, las acciones y las secciones, en ese orden", () => {
    const h = html();
    const orden = [
      "🔴 Atender (",
      "🛟 Posventa (",
      "📋 Despachar (",
      "💬 Chats",
      "pedidos hoy",
      "recaudo hoy",
      "unidades",
      "ticket promedio",
      "conversaciones hoy",
      "cierre",
      "share 2 uds",
      "esperando humano",
      "pendientes de despachar",
      "📦 Enviar guías",
      "🔍 Auditar el día",
      "📮 Avisar novedades de entrega",
      "⬇️ Descargar pedidos (CSV)",
      "📲 Mandarme el cierre por WhatsApp",
      "🧹 Revisar pedidos duplicados",
      "chat(s) esperando respuesta",
      "📉 Dónde se caen los clientes",
      "📋 Pendientes de despachar",
      "✅ Ya despachados",
      "🚫 Anulados",
      "📣 Por anuncio",
      "💬 Conversaciones",
    ];
    let desde = 0;
    for (const t of orden) {
      const i = h.indexOf(t, desde);
      assert.ok(i >= 0, `falta «${t}» (o está fuera de orden)`);
      desde = i;
    }
    assert.match(h, /se actualiza cada 45 s, nunca mientras escribes/);
    assert.match(h, /WhatsApp \+57 300 000 0000/);
  });

  test("cada fila trae su acción: ya la envié, anular, entregado, reactivar", () => {
    const h = html();
    assert.match(h, /onclick="yaLaEnvie\(this\)"/);
    assert.match(h, /onclick="anular\(this\)"/);
    assert.match(h, /onclick="entregado\(this\)"/);
    assert.match(h, /onclick="reactivar\(this\)"/);
    assert.match(h, /onclick="marcarChat\(this\)"/);
    assert.match(h, /onclick="responderEnLinea\(this\)"/);
  });

  test("cada celda lleva su etiqueta, para leerse apilada en el celular", () => {
    for (const celda of html().match(/<td[^>]*>/g) || []) assert.match(celda, /data-label="/, celda);
  });

  test("los scripts compilan y ningún manejador queda sin declarar", () => {
    const h = html();
    const scripts = [...h.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const s of scripts) new vm.Script(s);
    const todo = scripts.join("\n");
    const usados = [...new Set([...h.matchAll(/on(?:click|change|submit|input)="([\w.]+)\(/g)].map((m) => m[1]))];
    for (const f of usados.filter((u) => !u.includes("."))) {
      assert.ok(new RegExp(`function ${f}\\b`).test(todo), `«${f}» no está declarado`);
    }
  });

  test("lo que escribe un cliente sale escapado, y los ids no van dentro de JavaScript", () => {
    const h = html();
    assert.equal(h.includes("hola <b>"), false);
    assert.equal(/onclick="[^"]*'/.test(h), false, "un id metido en una cadena de JS");
  });

  test("la página nunca se recarga con un borrador o una acción a medias", () => {
    assert.match(vistas.GUION_TABLERO, /function ocupado\(\)/);
    assert.match(vistas.GUION_TABLERO, /if \(document\.hidden \|\| ocupado\(\)\) return;/);
    assert.match(vistas.GUION_TABLERO, /CADA_MS = 45000/);
  });

  test("sin el bloque operativo (una llamada antigua) se pinta lo mínimo y no se rompe", () => {
    const h = vistas.tablero({ datos: { dia: HOY, resumen: datos.resumirPedidos([]), pedidos: [], chats: [], porClase: {}, cuentas: {} } });
    assert.match(h, /unidades/);
  });

  test("las pantallas de cierre y duplicados compilan", () => {
    for (const h of [vistas.cierre({ texto: "📊 NOVIKA" }), vistas.duplicados({ grupos: [] })]) {
      for (const m of h.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
    }
  });

  test("el texto del cierre lleva los números y la comparación", () => {
    const d = datosDePrueba().operativo;
    const t = operativo.textoDeCierre({ hoy: d.hoy, ayer: d.ayer, cola: d.cola, pesos: (n) => `$${n}` });
    // NOV-1 y NOV-2 (despachado) se crearon hoy; el anulado no cuenta.
    assert.match(t, /Pedidos: 2/);
    assert.match(t, /Por despachar: 1/);
  });
});

// ==========================================================================
describe("7 · el anuncio queda guardado en la conversación y llega al pedido", () => {
  test("Meta manda el referral solo en el primer mensaje, y el «sí» ya no lo trae", async () => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { config } = require("../src/config");
    const { crearCerebro } = require("../src/cerebro/orquestar");
    const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
    const { crearCliente } = require("../src/ia/cliente");
    const { crearEmisor } = require("../src/whatsapp/enviar");
    const { cargarCatalogo } = require("../src/catalogo");
    require("../src/almacen/mutex")._reiniciar();

    const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-referral-")) });
    const cfg = { ...config, respuestaAutomatica: true, whatsappToken: "t", idNumero: "0", urlPublica: "https://x.invalido" };
    const emisor = crearEmisor({ config: cfg, repos, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: "w" }] }) }) });
    const cerebro = crearCerebro({
      config: cfg,
      repos,
      catalogo: cargarCatalogo({ carpeta: path.join(__dirname, "..", "catalogo", "productos"), refrescar: true }),
      ia: crearCliente({ proveedor: null }),
      emisor,
    });
    const tel = "573007770001";
    let n = 0;
    const dice = (texto, referral = null) =>
      cerebro.procesar({ clase: "mensaje", wamid: `wamid.REF${++n}`, idCliente: tel, telefono: tel, tipo: "text", texto, origenTexto: "escrito", referral });

    const ad = { source_id: "120210000000999", source_type: "ad", headline: "Cinturón", source_url: "https://fb.me/a" };
    await dice("Hola, quiero información", ad);
    await dice("lo quiero, soy Ana Ramírez, Medellín, Calle 50 # 20-15, 3007770001");
    await dice("sí");

    const conv = await repos.conversaciones.obtener(tel);
    assert.equal(conv.referral.source_id, ad.source_id);
    const [p] = await repos.pedidos.porContacto(tel);
    assert.ok(p, "no se creó el pedido");
    assert.equal(p.origen.referral.source_id, ad.source_id);
    await repos.cerrar();
  });
});
