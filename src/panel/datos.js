"use strict";

// ==========================================================================
// CONSULTAS DEL PANEL
//
// Todo lo que el panel muestra sale de AQUI, y todo sale de los
// repositorios de NOVIKA. No hay un segundo almacen de pedidos.
//
// Es a proposito que este modulo no sepa nada de HTML: asi las cuentas se
// pueden probar sin montar una pagina, y la pantalla no puede "arreglar" un
// numero mal calculado.
// ==========================================================================

const fecha = require("./fecha");
const atencion = require("../almacen/atencion");
const fichaDe = require("./ficha");

/** Estados de pedido que NO cuentan como venta. */
const NO_CUENTAN = new Set(["cancelado"]);

/**
 * Clasificacion de una conversacion. Es lo que ordena el trabajo del dia.
 *
 * El orden de las comprobaciones es el orden de urgencia, y no es estetico:
 * un chat que cumple dos cosas tiene que aparecer en la mas urgente, porque
 * si aparece en la mas tranquila nadie lo mira.
 */
const CLASES = {
  URGENTE: "urgente",
  PENDIENTE: "pendiente",
  POSVENTA: "posventa",
  ATENDIDA: "atendida",
  EN_CURSO: "en_curso",
};

/** Minutos sin responder a partir de los cuales un chat es urgente. */
const MINUTOS_URGENTE = 15;

/**
 * ¿Hay un mensaje del cliente sin contestar?
 *
 * "Sin contestar" es que el ULTIMO mensaje del historial sea del cliente.
 * Un mensaje del negocio despues significa que alguien -bot o persona- ya
 * dijo algo.
 */
function esperandoRespuesta(conv) {
  const lista = atencion.mensajes(conv);
  if (!lista.length) return false;
  return lista[lista.length - 1].de === atencion.QUIEN.CLIENTE;
}

function clasificar(conv, { ahora = Date.now() } = {}) {
  const a = atencion.leer(conv);
  const ultimo = atencion.ultimoDelCliente(conv);
  const minutos = ultimo ? fecha.minutosDesde(ultimo.ts, ahora) : null;
  const espera = esperandoRespuesta(conv);

  // Atendida primero: si una persona lo resolvio despues del ultimo mensaje
  // del cliente, no hay nada que hacer. Y si el cliente vuelve a escribir,
  // estaAtendido() deja de ser cierto solo.
  if (atencion.estaAtendido(conv)) return CLASES.ATENDIDA;

  // Un chat tomado por una persona y esperando respuesta es lo mas urgente
  // que hay: alguien se comprometio a contestar y el bot esta callado.
  if (espera && minutos !== null && minutos >= MINUTOS_URGENTE) return CLASES.URGENTE;
  if (espera) return CLASES.PENDIENTE;

  // Posventa: ya hay un pedido y la conversacion sigue. Son reclamos,
  // cambios de direccion y seguimientos, y se mezclan con las ventas nuevas
  // si no se separan.
  if (conv.estado === "confirmado" || conv.estado === "modificado") return CLASES.POSVENTA;

  if (a.pausado) return CLASES.EN_CURSO;
  return CLASES.EN_CURSO;
}

/** Unidades de un pedido. */
function unidadesDe(p) {
  const c = p.cotizacion || {};
  return Number(c.cantidad) || Number(p.cantidad) || 1;
}

/** Importe total de un pedido, en pesos enteros. */
function totalDe(p) {
  const c = p.cotizacion || {};
  return Number(c.total) || Number(p.total) || 0;
}

/**
 * Resumen de un dia (AAAA-MM-DD en Bogota).
 *
 * Los cancelados NO cuentan como venta pero SI se informan: un cancelado
 * que desaparece de la pantalla es un pedido del que nadie se acuerda, y
 * ese fue uno de los problemas que BIKERPRO documento.
 */
function resumirPedidos(pedidos) {
  const vivos = pedidos.filter((p) => !NO_CUENTAN.has(p.estado));
  const cancelados = pedidos.filter((p) => NO_CUENTAN.has(p.estado));

  const porProducto = new Map();
  for (const p of vivos) {
    const id = (p.cotizacion && p.cotizacion.productoId) || p.productoId || "(sin producto)";
    const previo = porProducto.get(id) || { productoId: id, pedidos: 0, unidades: 0, importe: 0 };
    previo.pedidos++;
    previo.unidades += unidadesDe(p);
    previo.importe += totalDe(p);
    porProducto.set(id, previo);
  }

  return {
    pedidos: vivos.length,
    unidades: vivos.reduce((s, p) => s + unidadesDe(p), 0),
    importe: vivos.reduce((s, p) => s + totalDe(p), 0),
    cancelados: cancelados.length,
    importeCancelado: cancelados.reduce((s, p) => s + totalDe(p), 0),
    // Multiproducto: NOVIKA no tiene un producto por defecto, asi que el
    // desglose no es un extra, es la unica forma de leer el dia.
    porProducto: [...porProducto.values()].sort((a, b) => b.importe - a.importe),
  };
}

/**
 * Todo lo que necesita el tablero.
 *
 * @param {object} repos
 * @param {object} opciones
 * @param {string} [opciones.dia]  AAAA-MM-DD en Bogota. Por defecto hoy.
 */
async function tablero(repos, { dia = null, ahora = Date.now(), limiteChats = 200 } = {}) {
  const elDia = dia || fecha.hoyBogota(ahora);

  const [pedidosDelDia, conversaciones] = await Promise.all([
    repos.pedidos.listar({ desde: elDia, hasta: elDia, limite: 1000 }),
    repos.conversaciones.listar({ limite: limiteChats }),
  ]);

  const chats = conversaciones.map((c) => ({
    contactoId: c.contactoId,
    estado: c.estado,
    productoId: c.productoId || null,
    atencion: atencion.leer(c),
    clase: clasificar(c, { ahora }),
    esperando: esperandoRespuesta(c),
    ultimoMensaje: atencion.ultimoDelCliente(c),
    cuantosMensajes: atencion.mensajes(c).length,
    actualizadoEn: c.actualizadoEn || null,
    // La ficha guarda cada campo como { valor, estado, origen }, no como
    // texto: ver src/panel/ficha.js. Interpolarlo directo producia
    // "[object Object]" en la pantalla.
    nombre: fichaDe.nombreParaMostrar(c.ficha),
    telefono: fichaDe.leer(c.ficha, "telefono").valor || c.contactoId,
    ciudad: fichaDe.leer(c.ficha, "ciudad"),
  }));

  const porClase = {};
  for (const clase of Object.values(CLASES)) porClase[clase] = chats.filter((c) => c.clase === clase);

  return {
    dia: elDia,
    hoy: fecha.hoyBogota(ahora),
    resumen: resumirPedidos(pedidosDelDia),
    pedidos: pedidosDelDia,
    chats,
    porClase,
    // Para la fila de pestanas, sin que la vista tenga que recontar.
    cuentas: Object.fromEntries(Object.entries(porClase).map(([k, v]) => [k, v.length])),
  };
}

/**
 * Busca clientes por telefono, nombre o ciudad.
 *
 * Sin indice de busqueda: se recorre la lista acotada. Con el volumen de
 * NOVIKA hoy -una tienda que arranca- es correcto, y montar un indice
 * ahora seria mantener algo que no hace falta. Cuando haga falta, el sitio
 * donde ponerlo es el repositorio, no aqui.
 */
async function buscar(repos, texto, { limite = 50 } = {}) {
  const q = String(texto || "").trim().toLowerCase();
  if (!q) return [];
  const conversaciones = await repos.conversaciones.listar({ limite: 500 });
  const coincide = (c) => {
    // Se busca por el VALOR del campo, no por el objeto que lo envuelve.
    // Antes se comparaba contra "[object Object]", asi que buscar el nombre
    // de un cliente no encontraba nada.
    const valores = ["nombre", "telefono", "ciudad", "direccion"].map((n) => fichaDe.leer(c.ficha, n).valor);
    return [c.contactoId, c.productoId, ...valores]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  };
  return conversaciones.filter(coincide).slice(0, limite);
}

/** Una conversacion con todo lo que el chat necesita. */
async function conversacionCompleta(repos, contactoId) {
  const conv = await repos.conversaciones.obtener(contactoId);
  if (!conv) return null;
  const contacto = await repos.contactos.obtener(contactoId).catch(() => null);
  // `porContacto` ya estaba en el contrato desde la Fase 2: en PostgreSQL es
  // una consulta con indice. Traerse 500 pedidos para filtrar en memoria
  // habria funcionado igual hoy -y habria sido una pantalla que no carga el
  // dia que haya volumen-.
  const pedidos = await repos.pedidos.porContacto(contactoId);
  return {
    conversacion: conv,
    contacto,
    pedidos,
    atencion: atencion.leer(conv),
    mensajes: atencion.mensajes(conv),
    clase: clasificar(conv),
  };
}

/** Serie de dias para la vista por fecha. */
async function serie(repos, { dias = 14, ahora = Date.now() } = {}) {
  const lista = fecha.ultimosDias(dias, fecha.hoyBogota(ahora));
  if (!lista.length) return [];
  const desde = lista[lista.length - 1];
  const hasta = lista[0];
  const pedidos = await repos.pedidos.listar({ desde, hasta, limite: 5000 });

  const porDia = new Map(lista.map((d) => [d, []]));
  for (const p of pedidos) {
    const d = fecha.diaBogota(p.creadoEn);
    if (porDia.has(d)) porDia.get(d).push(p);
  }
  return lista.map((d) => ({ dia: d, ...resumirPedidos(porDia.get(d) || []) }));
}

module.exports = {
  CLASES,
  MINUTOS_URGENTE,
  clasificar,
  esperandoRespuesta,
  unidadesDe,
  totalDe,
  resumirPedidos,
  tablero,
  buscar,
  conversacionCompleta,
  serie,
};
