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
const atencion = require("../almacen/atencion");

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
  // La ultima etapa es ENTREGADO, no despachado. En contraentrega un
  // despacho todavia puede caerse, y el embudo que termina en "despachado"
  // da por ganada una venta que aun no se cobro.
  { id: "entregado", etiqueta: "Entregado" },
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

  if (vivos.some((p) => p.estado === "entregado")) return "entregado";
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
  const entregados = vivos.filter((p) => p.estado === "entregado");

  // ⚠️ "POR DESPACHAR" NO ES "TODO LO QUE NO ESTA DESPACHADO".
  //
  // Esto era `p.estado !== "despachado"`, y al aparecer el estado
  // `entregado` ese filtro se habria tragado los pedidos ya ENTREGADOS: la
  // pila de trabajo del dia habria crecido con paquetes que ya estan en
  // casa del cliente. Es el fan-out tipico de añadir un valor a un enum, y
  // el sitio donde mas duele porque es la lista por la que se trabaja.
  const porDespachar = vivos.filter(
    (p) => p.estado !== "despachado" && p.estado !== "entregado"
  );

  // Las novedades se registran sobre un despachado, pero un pedido con
  // novedad puede acabar entregandose: se miran los dos para no perder una
  // incidencia abierta que nadie cerro.
  const conNovedad = [...despachados, ...entregados].filter((p) =>
    (p.novedades || []).some((n) => !n.resueltaEn)
  );

  const porTipo = {};
  for (const p of conNovedad) {
    for (const n of p.novedades || []) {
      if (n.resueltaEn) continue;
      porTipo[n.tipo] = (porTipo[n.tipo] || 0) + 1;
    }
  }

  return {
    porDespachar,
    despachados,
    entregados,
    // Lo que SALIO y todavia no consta entregado: es la plata que esta en
    // la calle. En contraentrega es el riesgo vivo del negocio.
    enLaCalle: despachados,
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

// --------------------------------------------------------------------------
// LA CAJA: VENDIDO NO ES RECAUDADO
//
// EN CONTRAENTREGA LA PLATA SOLO EXISTE CUANDO SE ENTREGA. Hasta ahora el
// panel sumaba los pedidos vivos del dia y presentaba el resultado como el
// importe; para una venta anticipada seria correcto, pero aqui el cliente
// paga en la puerta. Marco pregunto "cuanto vamos recaudado" y el sistema
// sabia contestar cuanto se habia VENDIDO.
//
// Son tres cifras distintas y las tres hacen falta:
//
//   · facturado — todo lo que se vendio y no esta cancelado
//   · recaudado — SOLO lo entregado. Es la unica plata que entro
//   · enRiesgo  — lo que salio y aun no consta entregado
//
// `tasaDeEntrega` es el numero que en la referencia de BIKERPRO decide si
// el canal es rentable: con el rechazo al 5% lo era y al 32% no.
//
// Devuelve `null` -nunca 0- cuando no hay base para el porcentaje. Un 0%
// inventado se lee como "esto va malisimo", y es la misma regla que ya
// sigue `embudo`.
// --------------------------------------------------------------------------
function caja({ pedidos = [] } = {}) {
  const total = (lista) => lista.reduce((s, p) => s + importeDe(p), 0);

  const cancelados = pedidos.filter((p) => p.estado === "cancelado");
  const vivos = pedidos.filter((p) => p.estado !== "cancelado");
  const entregados = vivos.filter((p) => p.estado === "entregado");
  const despachados = vivos.filter((p) => p.estado === "despachado");
  const sinSalir = vivos.filter(
    (p) => p.estado !== "despachado" && p.estado !== "entregado"
  );

  const facturado = total(vivos);
  // El recaudado sale del importe CONGELADO al entregar, no del total
  // actual del pedido: si alguien modifica la cotizacion manana, la caja de
  // ayer no se mueve.
  const recaudado = entregados.reduce(
    (s, p) => s + ((p.entrega && p.entrega.importeRecaudado) || importeDe(p)),
    0
  );

  const salieron = entregados.length + despachados.length;

  return {
    facturado,
    recaudado,
    enRiesgo: total(despachados) + total(sinSalir),
    // Cuantos pedidos hay en cada sitio, para poder leer el importe.
    pedidos: {
      vivos: vivos.length,
      entregados: entregados.length,
      despachados: despachados.length,
      sinSalir: sinSalir.length,
      cancelados: cancelados.length,
    },
    // ------------------------------------------------------------------
    // DE LO QUE SALIO, CUANTO CONSTA ENTREGADO
    //
    // ⚠️ ESTO **NO** ES LA TASA DE RECHAZO, y la diferencia importa porque
    // la tasa de rechazo es el numero que decide si el canal es rentable.
    //
    // Un pedido que sigue despachado puede estar en camino -no es un
    // fracaso- o puede haberse perdido, y hoy NO HAY FORMA DE DISTINGUIRLO:
    // `cancelar` se niega sobre un pedido despachado ("el pedido ya salio:
    // la cancelacion la gestiona una persona"), asi que una entrega
    // FALLIDA no se puede registrar en el sistema.
    //
    // Mientras no exista un estado `devuelto`, esta cifra solo dice cuanto
    // de lo que salio YA consta entregado, y sube sola a medida que alguien
    // marca las entregas. Llamarla tasa de entrega seria dar por rechazado
    // todo lo que va en camino, y por entregado todo lo que nadie marco.
    // ------------------------------------------------------------------
    entregadoDeLoQueSalio: salieron > 0 ? Math.round((entregados.length / salieron) * 100) : null,
    // Para decirlo en la pantalla en vez de que alguien lea el porcentaje
    // como si fuera el rechazo.
    faltaEstadoDevuelto: true,
    hayDatos: pedidos.length > 0,
    // ⚠️ Si nadie marca las entregas en el panel, `recaudado` sale 0 y NO
    // significa que no se haya cobrado: significa que no se registro. La
    // vista tiene que decirlo en vez de mostrar un cero a secas.
    hayEntregasRegistradas: entregados.length > 0,
  };
}

function importeDe(p) {
  return (p && p.cotizacion && p.cotizacion.total) || 0;
}

// --------------------------------------------------------------------------
// QUIEN CONTESTO: EL BOT O UNA PERSONA
//
// Marco lo pidio como "la cantidad de chats respondidos por el bot", y es
// el numero que dice cuanto trabajo esta ahorrando de verdad.
//
// ⚠️ LIMITE QUE HAY QUE DECIR: `conversacion.mensajes` guarda los ULTIMOS
// 60 mensajes (`atencion.MAX_MENSAJES`), asi que esto cuenta CHATS en los
// que contesto cada uno, no el total historico de mensajes. Para un chat
// muy largo los primeros mensajes ya no estan. Contar chats -y no mensajes-
// es lo que ese dato soporta sin exagerar.
//
// Y solo cuenta lo que SALIO: un mensaje con `estado` distinto de "enviado"
// es uno que el emisor bloqueo, y contarlo como respondido diria que
// atendimos a alguien que nunca recibio nada.
// --------------------------------------------------------------------------
function atendidos({ conversaciones = [] } = {}) {
  let soloBot = 0;
  let conPersona = 0;
  let sinRespuesta = 0;

  for (const c of conversaciones) {
    const mensajes = (c && c.mensajes) || [];
    const salieron = mensajes.filter((m) => m && m.estado === "enviado");
    const bot = salieron.some((m) => m.de === atencion.QUIEN.BOT);
    const persona = salieron.some((m) => m.de === atencion.QUIEN.OPERADOR);

    if (persona) conPersona++;
    else if (bot) soloBot++;
    else sinRespuesta++;
  }

  const contestados = soloBot + conPersona;

  return {
    soloBot,
    conPersona,
    sinRespuesta,
    contestados,
    total: conversaciones.length,
    // Que porcentaje de los chats CONTESTADOS resolvio el bot sin que
    // tuviera que entrar nadie. Sobre los contestados y no sobre el total,
    // porque un chat sin responder no es merito ni demerito del bot.
    porcentajeDelBot: contestados > 0 ? Math.round((soloBot / contestados) * 100) : null,
  };
}

module.exports = {
  ETAPAS,
  etapaDe,
  embudo,
  atribucion,
  origenDe,
  despachos,
  caja,
  atendidos,
  diasDesde,
};
