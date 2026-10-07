"use strict";

// ==========================================================================
// EMBUDO Y ATRIBUCION
//
// Calculos puros sobre conversaciones y pedidos. No tocan disco, no tocan
// red y no saben que existe el HTML: se pueden probar con datos inventados
// y verificar a mano con una calculadora.
//
// --------------------------------------------------------------------------
// POR QUE SE PUEDE IMPLEMENTAR SIN CAMPANAS REALES
// --------------------------------------------------------------------------
//
// Lo que hace falta de fuera es el DATO, no la regla. La regla -como se
// cuenta una conversion, que pasa con un pedido cancelado, como se atribuye
// una venta cuyo `referral` falta- se decide aqui y se puede verificar con
// datos ficticios. Lo que no se puede inventar es el numero final.
//
// Asi que esto esta implementado y probado; lo que queda bloqueado es
// tener anuncios activos que generen `referral` de verdad.
//
// --------------------------------------------------------------------------
// LA REGLA QUE MAS IMPORTA
// --------------------------------------------------------------------------
//
// Un embudo donde las etapas se solapan no sirve para decidir nada. Aqui
// cada conversacion cuenta en UNA etapa -la mas avanzada a la que llego- y
// las etapas son acumulativas hacia atras: quien confirmo tambien paso por
// cotizado. Si no fuera acumulativo, la "conversion de cotizado a
// confirmado" daria mas de 100% en cuanto alguien salte un paso.
// ==========================================================================

const fecha = require("./fecha");

/**
 * Etapas del embudo, de la primera a la ultima.
 *
 * Se derivan del estado de la CONVERSACION y del pedido, no de contar
 * mensajes: el estado es explicito y se guarda, contar mensajes seria
 * inferirlo. Ver src/dominio/estados.js.
 */
const ETAPAS = [
  { id: "escribio", etiqueta: "Escribió" },
  { id: "producto", etiqueta: "Identificó producto" },
  { id: "cotizado", etiqueta: "Recibió cotización" },
  { id: "datos", etiqueta: "Dio sus datos" },
  { id: "confirmado", etiqueta: "Confirmó" },
  { id: "despachado", etiqueta: "Despachado" },
];

/** Estados de conversacion que acreditan haber llegado a cada etapa. */
const ESTADOS_POR_ETAPA = {
  producto: new Set(["producto", "cotizado", "datos", "resumen", "confirmado", "modificado", "posventa"]),
  cotizado: new Set(["cotizado", "datos", "resumen", "confirmado", "modificado", "posventa"]),
  datos: new Set(["datos", "resumen", "confirmado", "modificado", "posventa"]),
  confirmado: new Set(["confirmado", "modificado", "posventa"]),
};

/**
 * Etapa mas avanzada a la que llego una conversacion.
 *
 * El pedido manda sobre el estado de la conversacion cuando va mas lejos:
 * una conversacion puede quedarse en "cotizado" y el pedido existir porque
 * se registro a mano desde el panel. Quedarse con el estado de la
 * conversacion perderia esa venta del embudo.
 */
function etapaDe(conversacion, pedidosDelContacto = []) {
  const vivos = pedidosDelContacto.filter((p) => p.estado !== "cancelado");

  if (vivos.some((p) => p.estado === "despachado")) return "despachado";
  if (vivos.length) return "confirmado";

  const estado = (conversacion && conversacion.estado) || "nuevo";
  if (ESTADOS_POR_ETAPA.confirmado.has(estado)) return "confirmado";
  if (ESTADOS_POR_ETAPA.datos.has(estado)) return "datos";
  if (ESTADOS_POR_ETAPA.cotizado.has(estado)) return "cotizado";
  if (ESTADOS_POR_ETAPA.producto.has(estado)) return "producto";
  return "escribio";
}

/**
 * Embudo: cuantos llegaron a cada etapa y donde se cae la gente.
 *
 * `cuantos` es ACUMULATIVO: quien confirmo cuenta tambien en cotizado.
 * `conversionDesdeArriba` es sobre el total que escribio; `conversionDelPaso`
 * es sobre la etapa inmediatamente anterior, que es la que dice DONDE
 * arreglar algo.
 */
function embudo({ conversaciones = [], pedidos = [] } = {}) {
  const porContacto = new Map();
  for (const p of pedidos) {
    const lista = porContacto.get(p.contactoId) || [];
    lista.push(p);
    porContacto.set(p.contactoId, lista);
  }

  const alcanzadas = Object.fromEntries(ETAPAS.map((e) => [e.id, 0]));
  const masLejos = Object.fromEntries(ETAPAS.map((e) => [e.id, 0]));
  const orden = ETAPAS.map((e) => e.id);

  for (const c of conversaciones) {
    const etapa = etapaDe(c, porContacto.get(c.contactoId) || []);
    masLejos[etapa]++;
    // Acumulativo hacia atras: llegar a una etapa implica las anteriores.
    const hasta = orden.indexOf(etapa);
    for (let i = 0; i <= hasta; i++) alcanzadas[orden[i]]++;
  }

  const total = conversaciones.length;
  const filas = ETAPAS.map((e, i) => {
    const cuantos = alcanzadas[e.id];
    const previo = i === 0 ? total : alcanzadas[orden[i - 1]];
    return {
      id: e.id,
      etiqueta: e.etiqueta,
      cuantos,
      // Se quedaron AQUI y no pasaron a la siguiente.
      seQuedaronAqui: masLejos[e.id],
      conversionDesdeArriba: total ? redondear((cuantos / total) * 100) : null,
      // null y no 0 cuando no hay base: un 0% inventado se lee como "esto
      // va muy mal" cuando en realidad es "todavia no hay datos".
      conversionDelPaso: previo ? redondear((cuantos / previo) * 100) : null,
      perdidosEnElPaso: Math.max(0, previo - cuantos),
    };
  });

  return { total, filas, hayDatos: total > 0 };
}

function redondear(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Origen de una conversacion o pedido, para atribuir.
 *
 * Meta manda `referral` cuando el cliente entra por un anuncio de
 * Click-to-WhatsApp. Si no hay nada, se atribuye a "directo" y NO se
 * reparte entre las campanas: inventar un origen es peor que no tenerlo,
 * porque se decide gasto de publicidad con esto.
 */
function origenDe(conversacion, pedido = null) {
  const r =
    (pedido && pedido.origen && pedido.origen.referral) ||
    (conversacion && conversacion.origen && conversacion.origen.referral) ||
    (conversacion && conversacion.referral) ||
    null;

  if (pedido && pedido.origen && pedido.origen.via === "panel") {
    // Una venta registrada a mano no se atribuye a un anuncio: no se sabe
    // de donde vino, y colarla en una campana infla su resultado.
    return { fuente: "panel", campana: null, anuncio: null };
  }

  if (!r) return { fuente: "directo", campana: null, anuncio: null };

  return {
    fuente: r.source || r.fuente || "anuncio",
    campana: r.campana || r.campaign_id || r.source_id || null,
    anuncio: r.anuncio || r.ad_id || r.ctwa_clid || null,
  };
}

/**
 * Atribucion: ventas e importe por origen.
 *
 * Un pedido cancelado NO cuenta como venta, pero SI se informa por origen:
 * una campana que trae muchas ventas que luego se caen no es una buena
 * campana, y si los cancelados no aparecen parece que si.
 */
function atribucion({ conversaciones = [], pedidos = [] } = {}) {
  const porContacto = new Map(conversaciones.map((c) => [c.contactoId, c]));
  const porOrigen = new Map();

  const sumar = (clave, cambios) => {
    const previo =
      porOrigen.get(clave) ||
      { fuente: clave, conversaciones: 0, pedidos: 0, unidades: 0, importe: 0, cancelados: 0, importeCancelado: 0 };
    for (const [k, v] of Object.entries(cambios)) previo[k] += v;
    porOrigen.set(clave, previo);
  };

  // Primero las conversaciones, para poder calcular conversion por origen.
  for (const c of conversaciones) {
    sumar(origenDe(c).fuente, { conversaciones: 1 });
  }

  for (const p of pedidos) {
    const conv = porContacto.get(p.contactoId) || null;
    const { fuente } = origenDe(conv, p);
    const cot = p.cotizacion || {};
    const unidades = Number(cot.cantidad) || 1;
    const total = Number(cot.total) || 0;

    if (p.estado === "cancelado") {
      sumar(fuente, { cancelados: 1, importeCancelado: total });
    } else {
      sumar(fuente, { pedidos: 1, unidades, importe: total });
    }
  }

  const filas = [...porOrigen.values()]
    .map((f) => ({
      ...f,
      conversion: f.conversaciones ? redondear((f.pedidos / f.conversaciones) * 100) : null,
      // Ticket medio: solo si hay pedidos. Dividir por cero daria Infinity
      // y la pantalla mostraria "$Infinity".
      ticketMedio: f.pedidos ? Math.round(f.importe / f.pedidos) : null,
    }))
    .sort((a, b) => b.importe - a.importe || b.conversaciones - a.conversaciones);

  return {
    filas,
    hayDatos: filas.length > 0,
    // Honestidad sobre la calidad del dato: si todo es "directo", no hay
    // atribucion que leer, solo ventas sin origen conocido.
    hayAtribucionReal: filas.some((f) => f.fuente !== "directo" && f.fuente !== "panel"),
  };
}

/**
 * Despachos y novedades, para la pantalla de guias.
 */
function despachos({ pedidos = [] } = {}) {
  const vivos = pedidos.filter((p) => p.estado !== "cancelado");
  const despachados = vivos.filter((p) => p.estado === "despachado");
  const porDespachar = vivos.filter((p) => p.estado !== "despachado");

  const conNovedad = despachados.filter((p) => (p.novedades || []).some((n) => !n.resueltaEn));

  const porTipo = {};
  for (const p of despachados) {
    for (const n of p.novedades || []) {
      if (n.resueltaEn) continue;
      porTipo[n.tipo] = (porTipo[n.tipo] || 0) + 1;
    }
  }

  return {
    porDespachar,
    despachados,
    conNovedad,
    porTipo,
    // Cuantos dias lleva despachado cada uno: una entrega que lleva mucho
    // sin novedad y sin llegar es la que hay que mirar.
    masAntiguoSinResolver: conNovedad
      .map((p) => ({ pedido: p, dias: diasDesde(p.despacho && p.despacho.despachadoEn) }))
      .sort((a, b) => (b.dias || 0) - (a.dias || 0))[0] || null,
  };
}

function diasDesde(valor) {
  const min = fecha.minutosDesde(valor);
  return min === null ? null : Math.floor(min / 1440);
}

module.exports = { ETAPAS, etapaDe, embudo, atribucion, origenDe, despachos, diasDesde };
