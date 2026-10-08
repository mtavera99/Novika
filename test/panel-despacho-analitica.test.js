"use strict";

// ==========================================================================
// DESPACHO, NOVEDADES, EMBUDO Y ATRIBUCION
//
// Todo con datos FICTICIOS y verificable a mano. Es la parte del alcance
// que no necesita nada de fuera:
//
//   - despachar y registrar novedades son transiciones del dominio;
//   - el embudo y la atribucion son cuentas.
//
// Lo que si necesita algo de fuera -un PDF real de la transportadora y
// plantillas aprobadas por Meta- no se prueba aqui porque no esta
// implementado, y no se presenta como si lo estuviera.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const dominioPedido = require("../src/dominio/pedido");
const analitica = require("../src/panel/analitica");
const { cotizar } = require("../src/dominio/cotizador");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");

const PRODUCTO = {
  id: "producto-x",
  nombre: "Producto X",
  activo: true,
  motorDePrecio: "tabla",
  precios: { 1: 100000, 2: 180000 },
  logistica: { politicaEnvio: { tipo: "incluido" } },
};

function pedidoDe({ ofertaId = "of-1", cantidad = 1, contactoId = "573001112233", origen = null, sinDireccion = false } = {}) {
  const cot = cotizar({
    producto: PRODUCTO,
    cantidad,
    destino: { ciudad: "Medellín", departamento: "Antioquia" },
  });
  const datos = {
    nombre: "Ana Pérez",
    telefono: "3001112233",
    ciudad: "Medellín",
    departamento: "Antioquia",
    direccion: "Calle 45 # 23-10",
  };
  const armado = dominioPedido.construir({
    cotizacion: cot.cotizacion,
    datos,
    contactoId,
    conversacionId: contactoId,
    ofertaId,
    wamidConfirmacion: `wamid.${ofertaId}`,
    origen,
  });
  assert.equal(armado.ok, true, `el pedido de prueba no se armo: ${(armado.falta || []).join(",")}`);
  const p = armado.pedido;
  // Para probar que despachar se NIEGA sin los datos de despacho.
  if (sinDireccion) delete p.destinatario.direccion;
  return p;
}

// ==========================================================================
// 1 · DESPACHAR
// ==========================================================================

describe("1 · despachar un pedido", () => {
  test("ESCENARIO: se despacha con su guia y queda versionado y en el historial", () => {
    const p = pedidoDe();
    const r = dominioPedido.despachar({ pedido: p, guia: "99E-123456", transportadora: "99 Envios" });

    assert.equal(r.ok, true);
    assert.equal(r.pedido.estado, "despachado");
    assert.equal(r.pedido.despacho.guia, "99E-123456");
    assert.equal(r.pedido.despacho.transportadora, "99 Envios");
    assert.ok(r.pedido.despacho.despachadoEn);
    assert.equal(r.pedido.version, p.version + 1, "despachar sube la version");

    const ultima = r.pedido.historial[r.pedido.historial.length - 1];
    assert.equal(ultima.accion, "despachado");
    assert.equal(ultima.guia, "99E-123456");
  });

  test("SIN numero de guia se niega: un despachado sin guia no se puede rastrear", () => {
    const p = pedidoDe();
    for (const guia of [undefined, null, "", "   "]) {
      const r = dominioPedido.despachar({ pedido: p, guia });
      assert.equal(r.ok, false, `acepto la guia ${JSON.stringify(guia)}`);
      assert.match(r.motivo, /guia/);
    }
  });

  test("es idempotente con la MISMA guia y no sube la version", () => {
    // El panel puede reintentar y el PDF puede subirse dos veces.
    const p = pedidoDe();
    const primera = dominioPedido.despachar({ pedido: p, guia: "G-1" });
    const segunda = dominioPedido.despachar({ pedido: primera.pedido, guia: "G-1" });

    assert.equal(segunda.ok, true);
    assert.equal(segunda.yaEstaba, true);
    assert.equal(segunda.pedido.version, primera.pedido.version, "no puede subir la version otra vez");
  });

  test("con una guia DISTINTA falla y lo explica", () => {
    // Dos guias para un pedido significa que una de las dos es de otro
    // cliente. Eso no lo puede resolver el codigo.
    const p = pedidoDe();
    const ya = dominioPedido.despachar({ pedido: p, guia: "G-1" });
    const otra = dominioPedido.despachar({ pedido: ya.pedido, guia: "G-2" });

    assert.equal(otra.ok, false);
    assert.match(otra.motivo, /ya salio con la guia G-1/);
    assert.equal(otra.guiaActual, "G-1");
  });

  test("no se despacha un pedido al que le faltan datos de entrega", () => {
    const p = pedidoDe({ sinDireccion: true });
    const r = dominioPedido.despachar({ pedido: p, guia: "G-9" });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /falta direccion/);
  });

  test("no se despacha un pedido cancelado", () => {
    const p = pedidoDe();
    const cancelado = dominioPedido.cancelar({ pedido: p, motivo: "se arrepintio" });
    const r = dominioPedido.despachar({ pedido: cancelado.pedido, guia: "G-9" });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /cancelado/);
  });

  test("sobrevive al disco: la guia se recupera igual", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-desp-"));
    const repos = await crearReposDeArchivos({ dir });
    try {
      await repos.contactos.guardar({ id: "573001112233" });
      const p = pedidoDe();
      await repos.pedidos.crearSiNoExiste(p);
      const r = dominioPedido.despachar({
        pedido: await repos.pedidos.obtener(p.id),
        guia: "G-DISCO",
        transportadora: "Coordinadora",
      });
      await repos.pedidos.reemplazar(r.pedido);

      const leido = await repos.pedidos.obtener(p.id);
      assert.equal(leido.estado, "despachado");
      assert.equal(leido.despacho.guia, "G-DISCO");
      assert.equal(leido.despacho.transportadora, "Coordinadora");
    } finally {
      await repos.cerrar();
    }
  });
});

// ==========================================================================
// 2 · NOVEDADES
// ==========================================================================

describe("2 · novedades de entrega", () => {
  function despachado() {
    return dominioPedido.despachar({ pedido: pedidoDe(), guia: "G-N" }).pedido;
  }

  test("ESCENARIO: se registra una novedad y el pedido SIGUE despachado", () => {
    // Una novedad es algo que le paso al paquete, no un estado distinto de
    // la venta. Si cambiara el estado, el pedido desapareceria de la lista
    // de despachados, que es justo donde hay que verlo.
    const p = despachado();
    const r = dominioPedido.registrarNovedad({ pedido: p, tipo: "ausente", detalle: "nadie en casa" });

    assert.equal(r.ok, true);
    assert.equal(r.pedido.estado, "despachado", "la novedad NO cambia el estado");
    assert.equal(r.pedido.version, p.version, "y no sube la version: la venta no cambio");
    assert.equal(r.pedido.novedades.length, 1);
    assert.equal(r.pedido.novedades[0].tipo, "ausente");
    assert.equal(r.pedido.novedades[0].detalle, "nadie en casa");
    assert.equal(r.pedido.novedades[0].resueltaEn, null);
    // Pero SI queda en el historial: es lo que explica por que tardo.
    assert.equal(r.pedido.historial[r.pedido.historial.length - 1].accion, "novedad");
  });

  test("solo acepta los tres tipos conocidos", () => {
    const p = despachado();
    assert.deepEqual(
      Object.values(dominioPedido.TIPOS_DE_NOVEDAD).sort(),
      ["ausente", "direccion", "oficina"]
    );
    for (const tipo of ["perdido", "", null, "AUSENTE", "otra cosa"]) {
      const r = dominioPedido.registrarNovedad({ pedido: p, tipo });
      assert.equal(r.ok, false, `acepto el tipo ${JSON.stringify(tipo)}`);
    }
  });

  test("es idempotente: la transportadora reporta lo mismo varias veces", () => {
    const p = despachado();
    const a = dominioPedido.registrarNovedad({ pedido: p, tipo: "ausente" });
    const b = dominioPedido.registrarNovedad({ pedido: a.pedido, tipo: "ausente" });

    assert.equal(b.ok, true);
    assert.equal(b.yaEstaba, true);
    assert.equal(b.pedido.novedades.length, 1, "no puede duplicar la novedad abierta");
  });

  test("pero dos tipos distintos conviven", () => {
    const p = despachado();
    const a = dominioPedido.registrarNovedad({ pedido: p, tipo: "ausente" });
    const b = dominioPedido.registrarNovedad({ pedido: a.pedido, tipo: "direccion" });
    assert.equal(b.pedido.novedades.length, 2);
    assert.equal(dominioPedido.novedadesAbiertas(b.pedido).length, 2);
  });

  test("una novedad sobre un pedido que NO salio se rechaza", () => {
    // Avisar al cliente equivocado es peor que no avisar.
    const r = dominioPedido.registrarNovedad({ pedido: pedidoDe(), tipo: "ausente" });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /despachado/);
  });

  test("resolver la cierra, es idempotente, y se puede volver a abrir otra", () => {
    const p = despachado();
    const abierta = dominioPedido.registrarNovedad({ pedido: p, tipo: "ausente" });
    const id = abierta.novedad.id;

    const r = dominioPedido.resolverNovedad({ pedido: abierta.pedido, id, comoSeResolvio: "reprogramada" });
    assert.equal(r.ok, true);
    assert.ok(r.pedido.novedades[0].resueltaEn);
    assert.equal(r.pedido.novedades[0].comoSeResolvio, "reprogramada");
    assert.equal(dominioPedido.novedadesAbiertas(r.pedido).length, 0);

    const otra = dominioPedido.resolverNovedad({ pedido: r.pedido, id });
    assert.equal(otra.ok, true);
    assert.equal(otra.yaEstaba, true);

    // Y como la anterior esta resuelta, se puede registrar la misma otra vez.
    const nueva = dominioPedido.registrarNovedad({ pedido: r.pedido, tipo: "ausente" });
    assert.equal(nueva.yaEstaba, false);
    assert.equal(nueva.pedido.novedades.length, 2);
  });

  test("resolver una novedad que no existe falla y lo dice", () => {
    const p = despachado();
    const r = dominioPedido.resolverNovedad({ pedido: p, id: "nov-99" });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /no hay una novedad/);
  });

  test("el aviso al cliente queda SIN enviar, no como enviado", () => {
    // Hoy no hay plantilla aprobada. El campo existe y queda en null: el
    // dia que se pueda avisar, aqui se vera el resultado real.
    const p = despachado();
    const r = dominioPedido.registrarNovedad({ pedido: p, tipo: "oficina" });
    assert.equal(r.pedido.novedades[0].avisoAlCliente, null);
  });
});

// ==========================================================================
// 3 · EMBUDO
// ==========================================================================

// --------------------------------------------------------------------------
// ⚠️ ESTA PRUEBA ERA CÓMPLICE DEL DEFECTO QUE AHORA VIGILA (2026-10-09)
//
// Usaba estados inventados -"producto", "datos"- que NO EXISTEN en
// `dominio/estados.js`, los mismos cuatro literales mal escritos que tenia
// `ESTADOS_POR_ETAPA`. Como el codigo y la prueba compartian el error, la
// prueba pasaba y el embudo de produccion contaba a TODO EL MUNDO en la
// primera etapa:
//
//     Escribió              33   100%   se quedaron aquí 33
//     Identificó producto    0     0%   se cayeron       33
//
// con 25 de esos chats en `producto_identificado`. El indicador que existe
// para decir DONDE se escapan los clientes apuntaba al sitio equivocado.
//
// Ahora los estados salen de `ESTADOS`, importado del dominio. Si alguien
// renombra un estado, esto falla — que es lo que tenia que haber pasado.
// --------------------------------------------------------------------------
describe("3 · embudo", () => {
  const { ESTADOS } = require("../src/dominio/estados");
  const conv = (id, estado) => ({ contactoId: id, estado });

  test("los estados del embudo son los del dominio, no literales", () => {
    // La prueba que habria cazado el defecto original. Cada estado que el
    // embudo acredita tiene que existir de verdad.
    const reales = new Set(Object.values(ESTADOS));
    for (const etapa of ["producto", "cotizado", "datos", "confirmado"]) {
      for (const estado of analitica.ESTADOS_POR_ETAPA[etapa]) {
        assert.ok(reales.has(estado), `la etapa "${etapa}" acredita un estado que no existe: "${estado}"`);
      }
    }
  });

  test("ESCENARIO: las etapas son ACUMULATIVAS y ninguna conversion pasa de 100%", () => {
    // Si no fueran acumulativas, la conversion de un paso daria mas de
    // 100% en cuanto alguien salte una etapa, y el embudo no serviria
    // para decidir nada.
    const conversaciones = [
      conv("c1", ESTADOS.NUEVO),
      conv("c2", ESTADOS.PRODUCTO_IDENTIFICADO),
      conv("c3", ESTADOS.COTIZADO),
      conv("c4", ESTADOS.CAPTURANDO_DATOS),
      conv("c5", ESTADOS.CONFIRMADO),
    ];
    const pedidos = [pedidoDe({ contactoId: "c5", ofertaId: "of-c5" })];

    const e = analitica.embudo({ conversaciones, pedidos });
    assert.equal(e.total, 5);

    const por = Object.fromEntries(e.filas.map((f) => [f.id, f]));
    assert.equal(por.escribio.cuantos, 5, "todos escribieron");
    assert.equal(por.producto.cuantos, 4);
    assert.equal(por.cotizado.cuantos, 3);
    assert.equal(por.datos.cuantos, 2);
    assert.equal(por.confirmado.cuantos, 1);
    assert.equal(por.despachado.cuantos, 0);

    for (const f of e.filas) {
      if (f.conversionDelPaso !== null) {
        assert.ok(f.conversionDelPaso <= 100, `${f.id} dio ${f.conversionDelPaso}%`);
      }
      if (f.conversionDesdeArriba !== null) {
        assert.ok(f.conversionDesdeArriba <= 100, `${f.id} dio ${f.conversionDesdeArriba}%`);
      }
    }
  });

  test("las cuentas salen a mano", () => {
    const conversaciones = [
      conv("a", ESTADOS.COTIZADO),
      conv("b", ESTADOS.COTIZADO),
      conv("c", ESTADOS.NUEVO),
      conv("d", ESTADOS.NUEVO),
    ];
    const e = analitica.embudo({ conversaciones, pedidos: [] });
    const por = Object.fromEntries(e.filas.map((f) => [f.id, f]));

    assert.equal(por.escribio.cuantos, 4);
    assert.equal(por.cotizado.cuantos, 2);
    // 2 de 4 = 50% del total.
    assert.equal(por.cotizado.conversionDesdeArriba, 50);
    // Del paso: 2 cotizados sobre 2 que identificaron producto = 100%.
    assert.equal(por.producto.cuantos, 2);
    assert.equal(por.cotizado.conversionDelPaso, 100);
    // Y se cayeron 2 entre "escribio" y "producto".
    assert.equal(por.producto.perdidosEnElPaso, 2);
    // Los que se quedaron en "escribio" y no pasaron.
    assert.equal(por.escribio.seQuedaronAqui, 2);
  });

  test("un pedido DESPACHADO lleva la conversacion hasta el final", () => {
    const conversaciones = [conv("c1", "confirmado")];
    const despachado = dominioPedido.despachar({
      pedido: pedidoDe({ contactoId: "c1", ofertaId: "of-d" }),
      guia: "G-1",
    }).pedido;

    const e = analitica.embudo({ conversaciones, pedidos: [despachado] });
    const por = Object.fromEntries(e.filas.map((f) => [f.id, f]));
    assert.equal(por.despachado.cuantos, 1);
  });

  test("un pedido CANCELADO no cuenta como confirmado", () => {
    // Si contara, el embudo diria que la venta se cerro cuando no.
    const conversaciones = [conv("c1", "cotizado")];
    const cancelado = dominioPedido.cancelar({
      pedido: pedidoDe({ contactoId: "c1", ofertaId: "of-x" }),
      motivo: "no",
    }).pedido;

    const e = analitica.embudo({ conversaciones, pedidos: [cancelado] });
    const por = Object.fromEntries(e.filas.map((f) => [f.id, f]));
    assert.equal(por.confirmado.cuantos, 0);
    assert.equal(por.cotizado.cuantos, 1);
  });

  test("una venta registrada a mano NO se pierde del embudo", () => {
    // La conversacion se quedo en "cotizado" porque el cierre fue por
    // telefono. Quedarse con el estado de la conversacion perderia la venta.
    const conversaciones = [conv("c1", "cotizado")];
    const pedidos = [pedidoDe({ contactoId: "c1", ofertaId: "of-m", origen: { via: "panel" } })];
    const e = analitica.embudo({ conversaciones, pedidos });
    const por = Object.fromEntries(e.filas.map((f) => [f.id, f]));
    assert.equal(por.confirmado.cuantos, 1, "el pedido manda sobre el estado de la conversacion");
  });

  test("sin conversaciones no inventa porcentajes: devuelve null, no 0", () => {
    // Un 0% inventado se lee como "esto va muy mal" cuando en realidad es
    // "todavia no hay datos".
    const e = analitica.embudo({ conversaciones: [], pedidos: [] });
    assert.equal(e.hayDatos, false);
    assert.equal(e.total, 0);
    for (const f of e.filas) {
      assert.equal(f.conversionDesdeArriba, null);
      assert.equal(f.conversionDelPaso, null);
    }
  });
});

// ==========================================================================
// 4 · ATRIBUCION
// ==========================================================================

describe("4 · atribucion", () => {
  test("ESCENARIO: reparte ventas e importe por origen", () => {
    const conversaciones = [
      { contactoId: "c1", estado: "confirmado", origen: { referral: { source: "facebook", campana: "camp-A" } } },
      { contactoId: "c2", estado: "confirmado", origen: { referral: { source: "facebook", campana: "camp-A" } } },
      { contactoId: "c3", estado: "cotizado", origen: { referral: { source: "instagram", campana: "camp-B" } } },
      { contactoId: "c4", estado: "nuevo" },
    ];
    const pedidos = [
      pedidoDe({ contactoId: "c1", ofertaId: "of-1" }),
      pedidoDe({ contactoId: "c2", ofertaId: "of-2", cantidad: 2 }),
    ];

    const a = analitica.atribucion({ conversaciones, pedidos });
    const por = Object.fromEntries(a.filas.map((f) => [f.fuente, f]));

    assert.equal(por.facebook.conversaciones, 2);
    assert.equal(por.facebook.pedidos, 2);
    assert.equal(por.facebook.unidades, 3, "1 + 2 unidades");
    assert.equal(por.facebook.importe, 100000 + 180000);
    assert.equal(por.facebook.conversion, 100);
    assert.equal(por.facebook.ticketMedio, Math.round(280000 / 2));

    assert.equal(por.instagram.conversaciones, 1);
    assert.equal(por.instagram.pedidos, 0);
    assert.equal(por.instagram.conversion, 0);
    assert.equal(por.instagram.ticketMedio, null, "sin pedidos no hay ticket medio");

    assert.equal(por.directo.conversaciones, 1);
    assert.equal(a.hayAtribucionReal, true);
  });

  test("los cancelados NO cuentan como venta pero SI se informan por origen", () => {
    // Una campana que trae ventas que luego se caen no es buena. Si los
    // cancelados no aparecen, parece que si.
    const conversaciones = [
      { contactoId: "c1", estado: "confirmado", origen: { referral: { source: "facebook" } } },
    ];
    const cancelado = dominioPedido.cancelar({
      pedido: pedidoDe({ contactoId: "c1", ofertaId: "of-c" }),
      motivo: "no",
    }).pedido;

    const a = analitica.atribucion({ conversaciones, pedidos: [cancelado] });
    const fb = a.filas.find((f) => f.fuente === "facebook");
    assert.equal(fb.pedidos, 0, "un cancelado no es una venta");
    assert.equal(fb.importe, 0);
    assert.equal(fb.cancelados, 1, "pero se ve");
    assert.ok(fb.importeCancelado > 0);
  });

  test("sin referral se atribuye a «directo» y NO se reparte entre campanas", () => {
    // Con esto se decide gasto de publicidad: inventar un origen es peor
    // que no tenerlo.
    const conversaciones = [{ contactoId: "c1", estado: "confirmado" }];
    const a = analitica.atribucion({
      conversaciones,
      pedidos: [pedidoDe({ contactoId: "c1", ofertaId: "of-d" })],
    });
    assert.deepEqual(a.filas.map((f) => f.fuente), ["directo"]);
    assert.equal(a.hayAtribucionReal, false, "todo directo no es atribucion");
  });

  test("una venta del panel NO se atribuye a un anuncio", () => {
    // No se sabe de donde vino; colarla en una campana infla su resultado.
    const conversaciones = [
      { contactoId: "c1", estado: "cotizado", origen: { referral: { source: "facebook" } } },
    ];
    const pedidos = [pedidoDe({ contactoId: "c1", ofertaId: "of-p", origen: { via: "panel" } })];
    const a = analitica.atribucion({ conversaciones, pedidos });

    const fb = a.filas.find((f) => f.fuente === "facebook");
    const panel = a.filas.find((f) => f.fuente === "panel");
    assert.equal(fb.pedidos, 0, "la venta manual no puede acreditarse a la campana");
    assert.equal(panel.pedidos, 1);
  });

  test("origenDe lee las formas que manda Meta", () => {
    assert.equal(analitica.origenDe({ referral: { source: "facebook" } }).fuente, "facebook");
    assert.equal(analitica.origenDe({ origen: { referral: { fuente: "ig" } } }).fuente, "ig");
    // Un referral sin source sigue siendo un anuncio, no "directo".
    assert.equal(analitica.origenDe({ referral: { ad_id: "123" } }).fuente, "anuncio");
    assert.equal(analitica.origenDe({ referral: { ad_id: "123" } }).anuncio, "123");
    assert.equal(analitica.origenDe(null).fuente, "directo");
    assert.equal(analitica.origenDe({}).fuente, "directo");
  });

  test("sin datos no inventa nada", () => {
    const a = analitica.atribucion({ conversaciones: [], pedidos: [] });
    assert.equal(a.hayDatos, false);
    assert.equal(a.hayAtribucionReal, false);
    assert.deepEqual(a.filas, []);
  });
});

// ==========================================================================
// 5 · DESPACHOS PARA LA PANTALLA
// ==========================================================================

describe("5 · lista de despachos y novedades", () => {
  test("separa por despachar, despachados y con novedad", () => {
    const porSalir = pedidoDe({ ofertaId: "of-1" });
    const salido = dominioPedido.despachar({ pedido: pedidoDe({ ofertaId: "of-2" }), guia: "G-2" }).pedido;
    const conNovedad = dominioPedido.registrarNovedad({
      pedido: dominioPedido.despachar({ pedido: pedidoDe({ ofertaId: "of-3" }), guia: "G-3" }).pedido,
      tipo: "ausente",
    }).pedido;
    const cancelado = dominioPedido.cancelar({ pedido: pedidoDe({ ofertaId: "of-4" }), motivo: "no" }).pedido;

    const d = analitica.despachos({ pedidos: [porSalir, salido, conNovedad, cancelado] });

    assert.equal(d.porDespachar.length, 1, "el cancelado no esta por despachar");
    assert.equal(d.porDespachar[0].id, porSalir.id);
    assert.equal(d.despachados.length, 2);
    assert.equal(d.conNovedad.length, 1);
    assert.equal(d.porTipo.ausente, 1);
  });

  test("una novedad resuelta deja de contar como abierta", () => {
    const salido = dominioPedido.despachar({ pedido: pedidoDe({ ofertaId: "of-5" }), guia: "G-5" }).pedido;
    const conN = dominioPedido.registrarNovedad({ pedido: salido, tipo: "oficina" });
    const resuelta = dominioPedido.resolverNovedad({ pedido: conN.pedido, id: conN.novedad.id }).pedido;

    const d = analitica.despachos({ pedidos: [resuelta] });
    assert.equal(d.conNovedad.length, 0);
    assert.deepEqual(d.porTipo, {});
  });

  test("diasDesde no revienta con una fecha ausente", () => {
    assert.equal(analitica.diasDesde(undefined), null);
    assert.equal(analitica.diasDesde("no es fecha"), null);
    assert.equal(analitica.diasDesde(new Date().toISOString()), 0);
  });
});

module.exports = {};
