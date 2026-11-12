"use strict";

// ==========================================================================
// EL TABLERO OPERATIVO
//
// Modulo puro: recibe conversaciones y pedidos ya leidos y devuelve todo lo
// que pinta la pantalla principal del panel. Sin I/O.
//
// DE DONDE SALE (2026-11-11). Marco pidio que /panel tenga «el mismo
// diseño, las mismas secciones, los mismos contadores y las mismas
// funciones» que el panel con el que ya trabaja todos los dias en su otro
// negocio. Lo que se copia es la FORMA de trabajar el dia: arriba los
// numeros comparados con ayer, despues lo que hay que atender, despues lo
// que hay que despachar, y la conversacion a mano sin cambiar de pantalla.
//
// Lo que NO se copia, y es a proposito:
//
//   · «recaudo hoy» aqui es lo ENTREGADO hoy, no lo vendido. Esto es
//     contraentrega: vendido no es cobrado (ver `analitica.caja`). Lo
//     vendido sale en la misma tarjeta de pedidos.
//   · «pagos por verificar» no existe: NOVIKA no cobra por adelantado. La
//     tarjeta solo aparece si hay algo que verificar, asi que no sale.
//   · ningun nombre ni dato del otro negocio. `test/panel.test.js` falla si
//     aparece en `src/panel/`.
//
// Cada calculo que ya existia se REUSA (`datos.totalDe`, `analitica.embudo`,
// `dominioPedido.listoParaDespachar`...). Dos copias de la misma regla se
// separan: este repo lo tiene escrito tres veces.
// ==========================================================================

const fecha = require("./fecha");
const fichaDe = require("./ficha");
const analitica = require("./analitica");
const atencion = require("../almacen/atencion");
const dominioPedido = require("../dominio/pedido");

/** Unidades de un pedido. Misma regla que `datos.unidadesDe`. */
function unidadesDe(p) {
  const c = (p && p.cotizacion) || {};
  return Number(c.cantidad) || Number(p && p.cantidad) || 1;
}

/** Total de un pedido. Misma regla que `datos.totalDe`. */
function totalDe(p) {
  const c = (p && p.cotizacion) || {};
  return Number(c.total) || Number(p && p.total) || 0;
}

const vivo = (p) => p && p.estado !== dominioPedido.ESTADOS_PEDIDO.CANCELADO;
const E = dominioPedido.ESTADOS_PEDIDO;

/** La ciudad, sin el departamento, para agrupar. */
function ciudadCorta(p) {
  const c = String((p && p.destinatario && p.destinatario.ciudad) || "").split(",")[0].trim();
  return c || "sin ciudad";
}

// --------------------------------------------------------------------------
// LOS NUMEROS DE UN DIA
// --------------------------------------------------------------------------

/**
 * Lo que paso en un dia (AAAA-MM-DD en Bogota).
 *
 * `conversaciones` cuenta los chats en los que el CLIENTE escribio ese dia:
 * es la base del cierre. Un chat donde solo hablo el bot -un recordatorio-
 * no es un cliente nuevo.
 */
function delDia(dia, { conversaciones = [], pedidos = [] } = {}) {
  const deHoy = pedidos.filter((p) => vivo(p) && fecha.diaBogota(p.creadoEn) === dia);
  const vendido = deHoy.reduce((s, p) => s + totalDe(p), 0);
  const unidades = deHoy.reduce((s, p) => s + unidadesDe(p), 0);

  const entregadosHoy = pedidos.filter(
    (p) => p && p.estado === E.ENTREGADO && p.entrega && fecha.diaBogota(p.entrega.entregadoEn) === dia
  );
  const recaudo = entregadosHoy.reduce((s, p) => s + ((p.entrega && p.entrega.importeRecaudado) || totalDe(p)), 0);

  let chats = 0;
  for (const c of conversaciones) {
    const escribio = atencion
      .mensajes(c)
      .some((m) => m && m.de === atencion.QUIEN.CLIENTE && fecha.diaBogota(m.ts) === dia);
    if (escribio) chats++;
  }

  const ciudades = new Map();
  for (const p of deHoy) ciudades.set(ciudadCorta(p), (ciudades.get(ciudadCorta(p)) || 0) + 1);

  return {
    dia,
    pedidos: deHoy.length,
    vendido,
    recaudo,
    entregas: entregadosHoy.length,
    unidades,
    ticketPromedio: deHoy.length ? Math.round(vendido / deHoy.length) : 0,
    conversaciones: chats,
    // Topado en 100, y se dice cuando pasa: quien escribio ayer y confirmo
    // hoy cuenta el pedido hoy y su conversacion no. Un 150% tira abajo la
    // confianza en todos los demas numeros de la pantalla.
    cierre: chats ? Math.min(100, (deHoy.length / chats) * 100) : 0,
    cierreTopado: chats > 0 && deHoy.length > chats,
    share2uds: deHoy.length ? (deHoy.filter((p) => unidadesDe(p) >= 2).length / deHoy.length) * 100 : 0,
    topCiudades: [...ciudades.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
  };
}

/**
 * Comparacion contra ayer. `null` cuando ayer fue cero: un «▲ ∞%» no se
 * puede leer, y un «▲ 100%» seria inventado.
 */
function variacion(hoy, ayer) {
  if (!ayer) return null;
  const d = ((hoy - ayer) / ayer) * 100;
  if (!Number.isFinite(d) || Math.abs(d) < 1) return { igual: true, pct: 0 };
  return { igual: false, sube: d > 0, pct: Math.round(Math.abs(d)) };
}

// --------------------------------------------------------------------------
// LO QUE HAY QUE ATENDER
// --------------------------------------------------------------------------

const MINUTOS_URGENTE = 15;

/**
 * Por que un chat necesita a una persona, en una linea. `null` si no.
 *
 * Tres causas, en orden de urgencia:
 *   1. hay una tarea anotada por el bot (no supo, pregunta sin dato…);
 *   2. el cliente escribio y nadie le contesto (bot pausado, fallo de envio);
 *   3. el chat esta tomado por una persona.
 */
function motivoDeAtencion(conv, { ahora = Date.now(), motivosEnClaro = {} } = {}) {
  if (atencion.estaAtendido(conv)) return null;
  const tarea = atencion.pendienteDe(conv);
  const lista = atencion.mensajes(conv);
  const ultimo = lista.length ? lista[lista.length - 1] : null;
  const delCliente = atencion.ultimoDelCliente(conv);
  const minutos = delCliente ? fecha.minutosDesde(delCliente.ts, ahora) : null;
  const a = atencion.leer(conv);
  // La pausa caduca sola a las 12 h: una pausa caducada ya no tiene a nadie
  // dentro, y contarla como «la tiene una persona» engordaria la lista.
  const pausado = a.pausado && !(typeof atencion.pausaCaducada === "function" && atencion.pausaCaducada(conv, { ahora }));

  if (tarea.hay) {
    return {
      nivel: "alta",
      motivo: motivosEnClaro[tarea.motivo] || tarea.motivo,
      desde: tarea.desde,
      pregunta: tarea.pregunta || "",
    };
  }
  if (ultimo && ultimo.de === atencion.QUIEN.CLIENTE) {
    return {
      nivel: minutos !== null && minutos >= MINUTOS_URGENTE ? "alta" : "media",
      motivo: pausado ? "escribió y el bot está pausado" : "escribió y no se le ha contestado",
      desde: ultimo.ts,
      pregunta: ultimo.texto || "",
    };
  }
  if (pausado) {
    return { nivel: "media", motivo: "el chat lo tiene una persona", desde: a.desde || (delCliente && delCliente.ts), pregunta: "" };
  }
  return null;
}

/** ¿Es posventa? Ya compro y sigue escribiendo. */
function esPosventa(conv, pedidosDelContacto) {
  return (
    (pedidosDelContacto || []).some(vivo) ||
    ["confirmado", "modificando", "posventa"].includes(conv && conv.estado)
  );
}

/**
 * La lista de atencion, agrupada por el dia en que el cliente empezo a
 * esperar: HOY, AYER, MÁS VIEJOS. Los atendidos de hoy y ayer se quedan en
 * la lista, apagados: se lee como una lista de tareas tachadas.
 */
function listaDeAtencion({ conversaciones = [], pedidosPorContacto = new Map(), ahora = Date.now(), motivosEnClaro = {} }) {
  const hoy = fecha.hoyBogota(ahora);
  const ayer = fecha.diaAnterior(hoy);
  const filas = [];

  for (const c of conversaciones) {
    const m = motivoDeAtencion(c, { ahora, motivosEnClaro });
    const a = atencion.leer(c);
    const atendidoHace = a.atendidoEn && atencion.estaAtendido(c) ? a.atendidoEn : null;
    if (!m && !atendidoHace) continue;
    const diaAtendido = atendidoHace ? fecha.diaBogota(atendidoHace) : null;
    if (!m && diaAtendido !== hoy && diaAtendido !== ayer) continue;

    const n = fichaDe.nombreParaMostrar(c.ficha);
    filas.push({
      contactoId: c.contactoId,
      nombre: n.texto,
      telefono: fichaDe.leer(c.ficha, "telefono").valor || c.contactoId,
      nivel: m ? m.nivel : "hecho",
      hecho: !m,
      motivo: m ? m.motivo : "ya se atendió",
      pregunta: m ? m.pregunta : "",
      desde: m ? m.desde : atendidoHace,
      posventa: esPosventa(c, pedidosPorContacto.get(c.contactoId)),
      dia: fecha.diaBogota(m ? m.desde : atendidoHace),
    });
  }

  const orden = { alta: 0, media: 1, hecho: 2 };
  filas.sort(
    (x, y) => orden[x.nivel] - orden[y.nivel] || (fecha.aMilisegundos(x.desde) || 0) - (fecha.aMilisegundos(y.desde) || 0)
  );

  const grupos = [
    { titulo: "Hoy", filas: filas.filter((f) => f.dia === hoy) },
    { titulo: "Ayer", filas: filas.filter((f) => f.dia === ayer) },
    { titulo: "Más viejos", filas: filas.filter((f) => f.dia !== hoy && f.dia !== ayer) },
  ]
    .map((g) => ({ ...g, faltan: g.filas.filter((f) => !f.hecho).length }))
    .filter((g) => g.filas.length);

  const pendientes = filas.filter((f) => !f.hecho);
  return {
    grupos,
    faltan: pendientes.length,
    posventa: pendientes.filter((f) => f.posventa).length,
  };
}

// --------------------------------------------------------------------------
// LO QUE HAY QUE DESPACHAR, CON SUS ALERTAS
// --------------------------------------------------------------------------

const UN_DIA_MS = 24 * 60 * 60 * 1000;

/** ¿La direccion es una oficina de transportadora? Ver `destino.js`. */
function esOficina(p) {
  return /^oficina\b/i.test(String((p && p.destinatario && p.destinatario.direccion) || "").trim());
}

/**
 * ¿El total cuadra con su propio desglose?
 *
 * NO se recotiza contra el catalogo de hoy, y es deliberado: el pedido
 * guarda una COPIA de la cotizacion para que un cambio de precio manana no
 * mueva la venta de ayer. Lo que si se puede comprobar es que el pedido
 * sea coherente consigo mismo: subtotal + envio - descuento = total, y que
 * la cantidad de la cotizacion sea la del pedido.
 */
function motivoDePrecio(p) {
  const c = (p && p.cotizacion) || null;
  if (!c) return "el pedido no tiene cotización";
  const esperado = Number(c.subtotal || 0) + Number(c.envio || 0) - Number(c.descuento || 0);
  if (Number(c.total) !== esperado) return `el total dice ${c.total} y el desglose suma ${esperado}`;
  if (p.cantidad && c.cantidad && Number(p.cantidad) !== Number(c.cantidad)) {
    return `el pedido dice ${p.cantidad} unidades y la cotización ${c.cantidad}`;
  }
  return null;
}

/**
 * Alertas de un pedido pendiente.
 *
 *   repetido     el mismo cliente (chat o celular) tiene otro pedido vivo
 *   sinConfirmar `listoParaDespachar` dice que no: revisiones o datos que faltan
 *   precio       el total no cuadra con su desglose
 *   guiaEnviada  tiene guia registrada pero sigue en la cola
 *   oficina      se entrega en oficina, no en una casa
 */
function alertasDe(p, { otrosVivosDelCliente = 0 } = {}) {
  const listo = dominioPedido.listoParaDespachar(p);
  const precio = motivoDePrecio(p);
  const d = (p && p.destinatario) || {};
  return {
    repetido: otrosVivosDelCliente > 0,
    sinConfirmar: listo.ok ? null : listo.motivo,
    precio,
    guiaEnviada: Boolean(p && p.despacho && p.despacho.guia),
    oficina: esOficina(p),
    viejo: Date.now() - (fecha.aMilisegundos(p && p.creadoEn) || Date.now()) > UN_DIA_MS,
    faltaCelular: !String(d.telefono || "").trim(),
    faltaDireccion: !String(d.direccion || "").trim(),
  };
}

/** Clave de cliente para detectar repetidos: el celular si lo hay, si no el chat. */
function claveDeCliente(p) {
  const tel = String((p && p.destinatario && p.destinatario.telefono) || "").replace(/\D/g, "").slice(-10);
  return tel || `chat:${p && p.contactoId}`;
}

function colaDeDespacho(pedidos = []) {
  const vivos = pedidos.filter(vivo);
  const porCliente = new Map();
  for (const p of vivos) {
    if (p.estado === E.ENTREGADO) continue;
    const k = claveDeCliente(p);
    porCliente.set(k, (porCliente.get(k) || 0) + 1);
  }

  const ordenar = (a, b) => (fecha.aMilisegundos(a.creadoEn) || 0) - (fecha.aMilisegundos(b.creadoEn) || 0);
  // Del MAS VIEJO al mas nuevo: en una lista de trabajo lo urgente es lo que
  // lleva mas tiempo esperando, no lo que acaba de entrar.
  const pendientes = vivos
    .filter((p) => p.estado !== E.DESPACHADO && p.estado !== E.ENTREGADO)
    .sort(ordenar)
    .map((p) => ({ pedido: p, alertas: alertasDe(p, { otrosVivosDelCliente: (porCliente.get(claveDeCliente(p)) || 1) - 1 }) }));

  const paraRevisar = pendientes.filter((x) => x.alertas.sinConfirmar || x.alertas.precio || x.alertas.repetido);
  const despachados = vivos
    .filter((p) => p.estado === E.DESPACHADO || p.estado === E.ENTREGADO)
    .sort((a, b) => ordenar(b, a));
  const anulados = pedidos
    .filter((p) => p && p.estado === E.CANCELADO)
    .sort((a, b) => (fecha.aMilisegundos(b.canceladoEn || b.actualizadoEn) || 0) - (fecha.aMilisegundos(a.canceladoEn || a.actualizadoEn) || 0));

  return {
    pendientes,
    porRecaudar: pendientes.reduce((s, x) => s + totalDe(x.pedido), 0),
    paraRevisar,
    sinConfirmar: paraRevisar.reduce((s, x) => s + totalDe(x.pedido), 0),
    sinCelular: pendientes.filter((x) => x.alertas.faltaCelular).length,
    despachados,
    enLaCalle: despachados.filter((p) => p.estado === E.DESPACHADO).length,
    anulados,
  };
}

// --------------------------------------------------------------------------
// POR ANUNCIO
//
// Agrupa por el anuncio del que vino el chat (`referral.source_id` de Meta),
// y si no lo hay, por la fuente que da `analitica.origenDe`. «Se fueron sin
// escribir» son los que llegaron con el mensaje del anuncio y no volvieron a
// escribir: un clic que costo y no hablo.
// --------------------------------------------------------------------------
function claveDeAnuncio(conv, pedido = null) {
  const r =
    (pedido && pedido.origen && pedido.origen.referral) ||
    (conv && conv.referral) ||
    (conv && conv.origen && conv.origen.referral) ||
    null;
  if (pedido && pedido.origen && pedido.origen.via === "panel") return { id: "panel", titulo: "venta manual" };
  if (r && (r.source_id || r.ad_id)) {
    return { id: String(r.source_id || r.ad_id), titulo: r.headline || r.source_url || "anuncio" };
  }
  const o = analitica.origenDe(conv, pedido);
  return { id: o.fuente, titulo: o.fuente === "directo" ? "sin anuncio (escribió directo)" : o.fuente };
}

function porAnuncio({ conversaciones = [], pedidos = [] } = {}) {
  const porContacto = new Map(conversaciones.map((c) => [c.contactoId, c]));
  const filas = new Map();
  const fila = (k) => {
    if (!filas.has(k.id)) filas.set(k.id, { id: k.id, titulo: k.titulo, charlas: 0, sinEscribir: 0, pedidos: 0, vendido: 0 });
    return filas.get(k.id);
  };

  for (const c of conversaciones) {
    const f = fila(claveDeAnuncio(c));
    f.charlas++;
    const escritos = atencion.mensajes(c).filter((m) => m && m.de === atencion.QUIEN.CLIENTE).length;
    if (escritos <= 1) f.sinEscribir++;
  }
  for (const p of pedidos.filter(vivo)) {
    const f = fila(claveDeAnuncio(porContacto.get(p.contactoId) || null, p));
    f.pedidos++;
    f.vendido += totalDe(p);
  }

  return [...filas.values()]
    .map((f) => ({
      ...f,
      pctSinEscribir: f.charlas ? Math.round((f.sinEscribir / f.charlas) * 100) : null,
      cierre: f.charlas ? Math.round((f.pedidos / f.charlas) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.charlas - a.charlas || b.pedidos - a.pedidos);
}

// --------------------------------------------------------------------------
// LOS DUPLICADOS
//
// Dos pedidos vivos del mismo cliente con el mismo total. Puede ser real
// -compro dos veces- o puede ser el «sí» repetido que la doble clave de
// idempotencia no reconocio porque cambio algo en medio. No se borra nada
// solo: se enseñan y una persona decide cual anular.
// --------------------------------------------------------------------------
function duplicados(pedidos = []) {
  const grupos = new Map();
  for (const p of pedidos.filter(vivo)) {
    const k = `${claveDeCliente(p)}|${totalDe(p)}`;
    const lista = grupos.get(k) || [];
    lista.push(p);
    grupos.set(k, lista);
  }
  return [...grupos.values()]
    .filter((l) => l.length > 1)
    .map((l) => l.sort((a, b) => (fecha.aMilisegundos(a.creadoEn) || 0) - (fecha.aMilisegundos(b.creadoEn) || 0)));
}

// --------------------------------------------------------------------------
// EL CIERRE DEL DIA, EN TEXTO PARA WHATSAPP
// --------------------------------------------------------------------------
function textoDeCierre({ hoy, ayer, cola, pesos }) {
  const flecha = (a, b) => {
    const v = variacion(a, b);
    if (!v) return "";
    if (v.igual) return " (igual que ayer)";
    return v.sube ? ` (▲${v.pct}% vs ayer)` : ` (▼${v.pct}% vs ayer)`;
  };
  const lineas = [
    `📊 NOVIKA · cierre del ${hoy.dia}`,
    `🛒 Pedidos: ${hoy.pedidos}${flecha(hoy.pedidos, ayer.pedidos)} · ${pesos(hoy.vendido)} vendidos`,
    `💵 Recaudado hoy (entregas): ${pesos(hoy.recaudo)}`,
    `📦 Unidades: ${hoy.unidades} · ticket ${pesos(hoy.ticketPromedio)}`,
    `💬 Conversaciones: ${hoy.conversaciones}${flecha(hoy.conversaciones, ayer.conversaciones)} · cierre ${hoy.cierre.toFixed(1)}%`,
    `📋 Por despachar: ${cola.pendientes.length} (${pesos(cola.porRecaudar)})`,
  ];
  if (cola.paraRevisar.length) lineas.push(`🔴 Revisar antes de despachar: ${cola.paraRevisar.length}`);
  if (hoy.topCiudades.length) lineas.push(`📍 ${hoy.topCiudades.map(([c, n]) => `${c} ${n}`).join(" · ")}`);
  return lineas.join("\n");
}

// --------------------------------------------------------------------------
// TODO JUNTO
// --------------------------------------------------------------------------
function tableroOperativo({ conversaciones = [], pedidos = [], ahora = Date.now(), motivosEnClaro = {} } = {}) {
  const hoyDia = fecha.hoyBogota(ahora);
  const ayerDia = fecha.diaAnterior(hoyDia);
  const hoy = delDia(hoyDia, { conversaciones, pedidos });
  const ayer = delDia(ayerDia, { conversaciones, pedidos });

  const pedidosPorContacto = new Map();
  for (const p of pedidos) {
    const l = pedidosPorContacto.get(p.contactoId) || [];
    l.push(p);
    pedidosPorContacto.set(p.contactoId, l);
  }

  const lista = listaDeAtencion({ conversaciones, pedidosPorContacto, ahora, motivosEnClaro });
  const cola = colaDeDespacho(pedidos);

  return {
    hoy,
    ayer,
    variaciones: {
      pedidos: variacion(hoy.pedidos, ayer.pedidos),
      recaudo: variacion(hoy.recaudo, ayer.recaudo),
      conversaciones: variacion(hoy.conversaciones, ayer.conversaciones),
    },
    atencion: lista,
    // «esperando humano»: los que de verdad esperan una respuesta, no los
    // pausados que ya se contestaron.
    esperandoHumano: lista.faltan,
    cola,
    embudo: analitica.embudo({ conversaciones, pedidos }),
    porAnuncio: porAnuncio({ conversaciones, pedidos }),
    duplicados: duplicados(pedidos),
  };
}

module.exports = {
  tableroOperativo,
  delDia,
  variacion,
  motivoDeAtencion,
  listaDeAtencion,
  colaDeDespacho,
  alertasDe,
  motivoDePrecio,
  porAnuncio,
  duplicados,
  textoDeCierre,
  esOficina,
  MINUTOS_URGENTE,
};
