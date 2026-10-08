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
    // Para el boton de fotos. `fotosEnviadas` lo anota el envio en la
    // propia conversacion, asi que sobrevive a un reinicio.
    fotosYaEnviadas: Boolean((conv.fotosEnviadas || {})[conv.productoId]),
  };
}

// ==========================================================================
// LA BANDEJA: TODOS LOS CHATS
//
// POR QUE HACE FALTA, Y QUE SE PERDIA SIN ELLA
//
// El tablero muestra los chats que ESPERAN RESPUESTA, que es lo correcto
// para trabajar el dia. Pero no habia ninguna pantalla donde ver la
// conversacion de alguien que ya fue atendido, o la de quien pregunto y no
// compro — y esas son la mayoria.
//
// Para buscarlas habia `/panel/buscar`, que exige saber a quien buscas. Si
// no te acuerdas del nombre, no hay forma de llegar. Es el mismo agujero que
// BIKERPRO documento: el chat que mas falta leer -el del cliente que
// pregunto y se fue- era el unico que no se podia abrir.
//
// Y sin la lista completa no hay auditoria posible: "que le dijo el bot a la
// gente hoy" no se puede responder mirando solo lo pendiente.
//
// DECISIONES
//
// 1. SE PAGINA DE VERDAD. Con volumen, una pantalla que trae todo es una
//    pantalla que no carga. Y Marco trabaja desde el celular.
//
// 2. LOS PEDIDOS SE CONSULTAN UNA VEZ, no uno por conversacion. Preguntar
//    `porContacto` dentro del bucle son N consultas por pantalla.
//
// 3. EL ULTIMO MENSAJE VA EN LA FILA. Sin el, la lista es una guia de
//    telefonos: hay que abrir cada chat para saber de que iba.
// ==========================================================================

/** Filtros de la bandeja. Cada uno responde a una pregunta real. */
const FILTROS = {
  TODOS: "todos",
  ESPERANDO: "esperando", // alguien espera respuesta ahora
  EN_CURSO: "en_curso", // conversacion viva, nadie esperando
  ATENDIDOS: "atendidos", // una persona ya los resolvio
  CON_PEDIDO: "con_pedido",
  SIN_PEDIDO: "sin_pedido", // pregunto y no compro: donde se ven las fugas
};

/** Recorta un texto para la fila, sin cortar a mitad de palabra. */
function recortar(texto, maximo = 90) {
  const t = String(texto || "").replace(/\s+/g, " ").trim();
  if (t.length <= maximo) return t;
  return `${t.slice(0, t.lastIndexOf(" ", maximo) || maximo)}…`;
}

/**
 * ¿Esta fila cumple el filtro?
 *
 * Funcion pura y fuera de `bandeja` a proposito: la primera version la tenia
 * dentro leyendo el `filtro` del closure, y para contar las pestañas habia
 * que reasignar ese parametro y restaurarlo. Eso funciona y es una trampa:
 * cualquier `await` en medio dejaria el contador mintiendo.
 */
function cumple(fila, filtro) {
  switch (filtro) {
    case FILTROS.ESPERANDO:
      return fila.esperando && fila.clase !== CLASES.ATENDIDA;
    case FILTROS.EN_CURSO:
      return !fila.esperando && fila.clase !== CLASES.ATENDIDA;
    case FILTROS.ATENDIDOS:
      return fila.clase === CLASES.ATENDIDA;
    case FILTROS.CON_PEDIDO:
      return fila.pedidosVivos > 0;
    case FILTROS.SIN_PEDIDO:
      return fila.pedidosVivos === 0;
    default:
      return true;
  }
}

/**
 * Bandeja de conversaciones, filtrada, buscada y paginada.
 *
 * @param {object} repos
 * @param {object} opciones
 * @param {string} [opciones.filtro]  uno de FILTROS
 * @param {string} [opciones.q]       busqueda por nombre, telefono o ciudad
 * @param {number} [opciones.pagina]  1 en adelante
 */
// ==========================================================================
// CUANTAS CONVERSACIONES SE LEEN PARA LA BANDEJA
//
// 20.000 por defecto, configurable con PANEL_TECHO_CHATS.
//
// ESTABA EN 2.000 Y ESO NO ERA UN TECHO: ERA UNA PERDIDA. Marco lo dijo
// claro: necesita poder CONSULTAR todos los chats con paginacion, no
// enterarse de que algunos quedaron fuera.
//
// POR QUE NO SE PAGINA EN EL ALMACEN, que seria lo elegante:
//
// Los filtros y la busqueda se aplican sobre el conjunto COMPLETO, y tienen
// que hacerlo. Si se paginara antes de filtrar, la pagina 1 de "sin pedido"
// traeria solo los que haya entre los primeros 25 de todos — paginas
// incompletas y contadores falsos. Eso es peor que el limite, porque un
// numero equivocado no se nota y un aviso si.
//
// Para paginar en el almacen habria que bajar los seis filtros y la
// busqueda a SQL y al backend de archivos, en los dos, manteniendolos
// iguales. Es un cambio grande que hoy no compra nada: en produccion el
// almacen es PostgreSQL, donde listar 20.000 filas es una consulta
// indexada, no 20.000 lecturas de disco. Cuando el volumen lo pida, el
// sitio por donde entrar es este comentario.
//
// El aviso se queda igual: es la red que avisa de que llego ese dia.
// ==========================================================================
const TECHO_DE_CHATS = Math.max(100, Number(process.env.PANEL_TECHO_CHATS) || 20000);

async function bandeja(
  repos,
  {
    filtro = FILTROS.TODOS,
    q = "",
    pagina = 1,
    porPagina = 25,
    ahora = Date.now(),
    techo = TECHO_DE_CHATS,
  } = {}
) {
  const todas = await repos.conversaciones.listar({ limite: techo });

  // Una sola consulta de pedidos para saber quien compro. Con PostgreSQL
  // esto es un indice; con archivos, una lectura de carpeta.
  // El techo de PEDIDOS va atado al de conversaciones, y por un motivo mas
  // serio que el de la lista: si un pedido se queda fuera de esta lectura,
  // su cliente aparece como "sin pedido". No es una fila que falta, es una
  // fila MAL CLASIFICADA — y "sin pedido" es justo la pestaña donde Marco
  // busca las fugas. Un cliente que compro listado como fuga es una
  // conclusion equivocada, no un dato incompleto.
  const techoPedidos = techo * 2;
  const pedidos = await repos.pedidos.listar({ limite: techoPedidos });
  const porContacto = new Map();
  for (const p of pedidos) {
    const lista = porContacto.get(p.contactoId) || [];
    lista.push(p);
    porContacto.set(p.contactoId, lista);
  }

  const texto = String(q || "").trim().toLowerCase();

  const filas = todas.map((conv) => {
    const mensajes = atencion.mensajes(conv);
    const ultimo = mensajes.length ? mensajes[mensajes.length - 1] : null;
    const ultimoDelCliente = atencion.ultimoDelCliente(conv);
    const susPedidos = porContacto.get(conv.contactoId) || [];
    const vivos = susPedidos.filter((p) => !NO_CUENTAN.has(p.estado));

    const leer = (campo) => fichaDe.leer(conv.ficha, campo).valor;

    return {
      contactoId: conv.contactoId,
      nombre: leer("nombre") || null,
      telefono: leer("telefono") || conv.contactoId,
      ciudad: leer("ciudad") || null,
      productoId: conv.productoId || null,
      estado: conv.estado,
      clase: clasificar(conv, { ahora }),
      atencion: atencion.leer(conv),
      // Lo que el bot prometio que contestaria una persona. Se calcula aqui
      // para que la fila lo pueda marcar sin abrir la conversacion.
      pendiente: atencion.pendienteDe(conv),
      esperando: esperandoRespuesta(conv),
      mensajes: mensajes.length,
      // El ultimo mensaje y QUIEN lo dijo: una fila donde no se distingue si
      // habló el cliente o el bot no dice si hay algo que hacer.
      ultimo: ultimo ? { de: ultimo.de, texto: recortar(ultimo.texto), ts: ultimo.ts, estado: ultimo.estado } : null,
      ultimoDelClienteTs: ultimoDelCliente ? ultimoDelCliente.ts : null,
      minutosEsperando:
        ultimoDelCliente && esperandoRespuesta(conv) ? fecha.minutosDesde(ultimoDelCliente.ts, ahora) : null,
      pedidos: susPedidos.length,
      pedidosVivos: vivos.length,
      importe: vivos.reduce((s, p) => s + totalDe(p), 0),
      ultimoPedido: susPedidos.length ? susPedidos[susPedidos.length - 1] : null,
    };
  });

  const pasaBusqueda = (f) =>
    !texto ||
    [f.contactoId, f.nombre, f.telefono, f.ciudad, f.productoId, f.ultimo && f.ultimo.texto]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(texto));

  const filtradas = filas.filter((f) => cumple(f, filtro) && pasaBusqueda(f));

  // Lo que espera respuesta primero, y dentro de eso lo que lleva mas
  // tiempo esperando. Despues, por actividad reciente.
  filtradas.sort((a, b) => {
    if (a.esperando !== b.esperando) return a.esperando ? -1 : 1;
    const ta = (a.ultimo && a.ultimo.ts) || 0;
    const tb = (b.ultimo && b.ultimo.ts) || 0;
    return tb - ta;
  });

  // Los contadores se calculan sobre TODAS las filas, no sobre la pagina:
  // una pestaña que dice "3" porque solo mira la pagina actual miente.
  const cuentas = {};
  for (const clave of Object.values(FILTROS)) {
    cuentas[clave] = filas.filter((f) => cumple(f, clave)).length;
  }

  const total = filtradas.length;
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  const actual = Math.min(Math.max(1, Number(pagina) || 1), paginas);
  const desde = (actual - 1) * porPagina;

  return {
    filas: filtradas.slice(desde, desde + porPagina),
    total,
    pagina: actual,
    paginas,
    porPagina,
    filtro,
    q: String(q || ""),
    cuentas,
    // ------------------------------------------------------------------
    // SI LA LISTA SE CORTO, SE DICE
    //
    // Se leen como mucho `techo` conversaciones. Mientras haya menos, da
    // igual; el dia que haya mas, las que sobren desaparecian SIN AVISO:
    // ni en la pestaña, ni en el total, ni en la paginacion. Una bandeja
    // que dice "1.247 chats" cuando hay 3.000 no es un limite, es un
    // error silencioso — y el chat que falta es el que nadie atendio.
    //
    // No se sube el techo a ciegas: con el almacen de archivos, listar
    // son N lecturas de disco. Lo que se arregla es que se NOTE.
    // ------------------------------------------------------------------
    recortada: todas.length >= techo,
    techo,
    // Si se corto la lista de pedidos, hay filas mal clasificadas. Se
    // distingue del recorte de la lista porque el aviso tiene que ser otro:
    // ahi no falta informacion, hay informacion equivocada.
    pedidosRecortados: pedidos.length >= techoPedidos,
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
  FILTROS,
  MINUTOS_URGENTE,
  bandeja,
  cumple,
  recortar,
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
