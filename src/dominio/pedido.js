"use strict";

// ==========================================================================
// PEDIDO
//
// Modulo puro. Sin I/O.
//
// Tres ideas cargan con casi todo el peso de este archivo:
//
// 1. SNAPSHOT, NO REFERENCIA.
//    El pedido guarda una COPIA de la cotizacion y de los datos del
//    destinatario tal como estaban al confirmar. Si manana sube el precio
//    del producto, el pedido de ayer sigue valiendo lo que el cliente
//    acepto. Guardar un productoId y recalcular al consultar significa que
//    el historico cambia solo, y entonces la contabilidad del negocio no
//    es auditable.
//
// 2. DOS CLAVES DE IDEMPOTENCIA, PORQUE HAY DOS DUPLICADOS DISTINTOS.
//
//    a) Retransmision del webhook: Meta reenvia el mismo evento. Mismo
//       wamid -> misma claveDeEvento -> el almacen rechaza el segundo.
//
//    b) Cliente que escribe "si" dos veces: wamid distinto, pero la MISMA
//       oferta. La claveDeOferta lo bloquea.
//
//    Con una sola clave se escapa uno de los dos casos. Las dos son
//    restricciones de unicidad en el almacen, no comprobaciones en memoria:
//    un Set en memoria se borra al reiniciar, y el reintento de Meta puede
//    llegar hasta 36 horas despues.
//
// 3. LAS MODIFICACIONES NO PISAN: VERSIONAN.
//    Cambiar la direccion de un pedido crea una version nueva y conserva la
//    anterior. "Que le dijimos al cliente y cuando" tiene que poder
//    responderse meses despues.
// ==========================================================================

const crypto = require("node:crypto");
const { firmaDeCondiciones } = require("./cotizador");

const ESTADOS_PEDIDO = {
  CONFIRMADO: "confirmado",
  EN_REVISION: "en_revision", // guardado pero una persona tiene que verlo
  MODIFICADO: "modificado",
  CANCELADO: "cancelado",
  DESPACHADO: "despachado",
};

/** Datos del destinatario imprescindibles para despachar. */
const REQUERIDOS_PARA_DESPACHAR = ["nombre", "telefono", "ciudad", "direccion"];

function hash(partes) {
  return crypto.createHash("sha256").update(partes.join("|")).digest("hex");
}

/**
 * Clave de idempotencia por evento. Bloquea la retransmision del webhook.
 * Determinista: el mismo evento produce siempre la misma clave.
 */
function claveDeEvento(contactoId, wamid) {
  if (!contactoId || !wamid) return null;
  return hash(["evento", String(contactoId), String(wamid)]).slice(0, 32);
}

/**
 * Clave de idempotencia por oferta. Bloquea el "si" repetido.
 * Un contacto no puede tener dos pedidos vivos sobre la misma oferta.
 */
function claveDeOferta(contactoId, ofertaId) {
  if (!contactoId || !ofertaId) return null;
  return hash(["oferta", String(contactoId), String(ofertaId)]).slice(0, 32);
}

/**
 * Id de pedido legible. El prefijo del contacto va HASHEADO: un id de pedido
 * se pega en chats, correos y guias, y no tiene por que llevar el telefono
 * del cliente dentro.
 */
function nuevoIdDePedido(contactoId, ahora = new Date()) {
  const tiempo = ahora.getTime().toString(36).toUpperCase();
  const quien = hash(["pedido", String(contactoId || "anonimo")]).slice(0, 4).toUpperCase();
  const azar = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `NOV-${tiempo}-${quien}${azar}`;
}

/** Id de oferta. Vive en la conversacion y se renueva si cambian las condiciones. */
function nuevoIdDeOferta(ahora = new Date()) {
  return `of-${ahora.getTime().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/**
 * Construye un pedido. NO lo guarda.
 *
 * Valida las condiciones deterministas; si no se cumplen, devuelve por que.
 * Un pedido solo existe cuando las cumple todas.
 *
 * @returns {{ok: true, pedido: object} | {ok: false, falta: string[], motivo: string}}
 */
function construir({
  cotizacion,
  datos,
  contactoId,
  conversacionId,
  ofertaId,
  wamidConfirmacion,
  origen = null,
  revisiones = [],
  ahora = new Date(),
}) {
  const falta = [];

  if (!cotizacion || !cotizacion.total) falta.push("cotizacion");
  if (!contactoId) falta.push("contactoId");
  if (!ofertaId) falta.push("ofertaId");
  if (!wamidConfirmacion) falta.push("wamidConfirmacion");

  const d = datos || {};
  for (const campo of REQUERIDOS_PARA_DESPACHAR) {
    if (!d[campo]) falta.push(campo);
  }

  if (falta.length) {
    return {
      ok: false,
      falta,
      motivo: `no se puede crear el pedido, falta: ${falta.join(", ")}`,
    };
  }

  // Coherencia entre la cotizacion y el destino que se va a despachar. Si no
  // cuadran, algo se movio por el camino y despachar seria cobrar un envio
  // calculado para otra ciudad.
  if (cotizacion.destino && cotizacion.destino.ciudad && cotizacion.destino.ciudad !== d.ciudad) {
    return {
      ok: false,
      falta: [],
      motivo: `la cotizacion es para ${cotizacion.destino.ciudad} y el pedido va a ${d.ciudad}: hay que recotizar`,
    };
  }

  // Si quedan dudas sobre algun dato, el pedido SE GUARDA pero marcado. No
  // se descarta la venta; la revisa una persona antes de despachar.
  const estado = revisiones.length ? ESTADOS_PEDIDO.EN_REVISION : ESTADOS_PEDIDO.CONFIRMADO;

  const pedido = {
    id: nuevoIdDePedido(contactoId, ahora),
    version: 1,
    estado,

    claveDeEvento: claveDeEvento(contactoId, wamidConfirmacion),
    claveDeOferta: claveDeOferta(contactoId, ofertaId),

    contactoId,
    conversacionId: conversacionId || null,
    ofertaId,
    wamidConfirmacion,

    // --- SNAPSHOT: copias, no referencias ---
    producto: {
      id: cotizacion.productoId,
      nombre: cotizacion.productoNombre,
      variante: cotizacion.variante || null,
    },
    cantidad: cotizacion.cantidad,
    destinatario: {
      nombre: d.nombre,
      telefono: d.telefono,
      documento: d.documento || null,
      ciudad: d.ciudad,
      departamento: d.departamento || null,
      direccion: d.direccion,
      referencia: d.referencia || null,
    },
    cotizacion: JSON.parse(JSON.stringify(cotizacion)),
    firmaDeCondiciones: firmaDeCondiciones(cotizacion),

    // --- Trazabilidad ---
    origen: origen || null,
    revisiones: [...revisiones],
    historial: [
      {
        version: 1,
        accion: "creado",
        cuando: ahora.toISOString(),
        estado,
        total: cotizacion.total,
        wamid: wamidConfirmacion,
      },
    ],

    creadoEn: ahora.toISOString(),
    actualizadoEn: ahora.toISOString(),
    canceladoEn: null,
    motivoCancelacion: null,
  };

  return { ok: true, pedido };
}

/** Campos cuyo cambio obliga a recotizar. */
const CAMPOS_QUE_AFECTAN_PRECIO = new Set(["cantidad", "ciudad", "departamento", "productoId", "variante"]);

/** ¿Estos cambios obligan a recotizar? */
function requiereRecotizar(cambios) {
  return Object.keys(cambios || {}).some((c) => CAMPOS_QUE_AFECTAN_PRECIO.has(c));
}

/**
 * Aplica una modificacion. Devuelve un pedido NUEVO; no muta el original.
 *
 * Si los cambios afectan al precio, exige una cotizacion nueva. Dejar la
 * cantidad en 3 con el total de 2 es la clase de inconsistencia que acaba en
 * una devolucion y en una discusion con el cliente.
 *
 * @returns {{ok: true, pedido: object} | {ok: false, motivo: string, requiereCotizacion?: boolean}}
 */
function modificar({ pedido, cambios, cotizacionNueva = null, porQue = "", wamid = null, ahora = new Date() }) {
  if (!pedido) return { ok: false, motivo: "no hay pedido que modificar" };
  if (pedido.estado === ESTADOS_PEDIDO.CANCELADO) {
    return { ok: false, motivo: "el pedido esta cancelado: no se modifica, se crea uno nuevo" };
  }
  if (pedido.estado === ESTADOS_PEDIDO.DESPACHADO) {
    return { ok: false, motivo: "el pedido ya esta despachado: cualquier cambio lo gestiona una persona" };
  }
  if (!cambios || !Object.keys(cambios).length) {
    return { ok: false, motivo: "no hay cambios que aplicar" };
  }

  const afectaPrecio = requiereRecotizar(cambios);
  if (afectaPrecio && !cotizacionNueva) {
    return {
      ok: false,
      motivo: `los cambios (${Object.keys(cambios).join(", ")}) afectan al precio: hace falta recotizar`,
      requiereCotizacion: true,
    };
  }

  const nuevo = JSON.parse(JSON.stringify(pedido));
  nuevo.version = pedido.version + 1;
  nuevo.actualizadoEn = ahora.toISOString();
  nuevo.estado = ESTADOS_PEDIDO.MODIFICADO;

  const antes = {};
  for (const [campo, valor] of Object.entries(cambios)) {
    if (campo === "cantidad") {
      antes.cantidad = nuevo.cantidad;
      nuevo.cantidad = valor;
    } else if (campo === "productoId") {
      antes.productoId = nuevo.producto.id;
      nuevo.producto.id = valor;
    } else if (campo === "variante") {
      antes.variante = nuevo.producto.variante;
      nuevo.producto.variante = valor;
    } else if (campo in nuevo.destinatario) {
      antes[campo] = nuevo.destinatario[campo];
      nuevo.destinatario[campo] = valor;
    } else {
      return { ok: false, motivo: `"${campo}" no es un campo modificable de un pedido` };
    }
  }

  if (cotizacionNueva) {
    nuevo.cotizacion = JSON.parse(JSON.stringify(cotizacionNueva));
    nuevo.firmaDeCondiciones = firmaDeCondiciones(cotizacionNueva);
    // Coherencia tras el cambio: la cotizacion nueva tiene que hablar del
    // mismo pedido que acabamos de modificar.
    if (cotizacionNueva.cantidad !== nuevo.cantidad) {
      return {
        ok: false,
        motivo: `la cotizacion nueva es para ${cotizacionNueva.cantidad} y el pedido quedo en ${nuevo.cantidad}`,
      };
    }
    if (cotizacionNueva.productoId !== nuevo.producto.id) {
      return {
        ok: false,
        motivo: `la cotizacion nueva es de ${cotizacionNueva.productoId} y el pedido es de ${nuevo.producto.id}`,
      };
    }
  }

  nuevo.historial.push({
    version: nuevo.version,
    accion: "modificado",
    cuando: ahora.toISOString(),
    cambios: Object.keys(cambios),
    antes,
    despues: { ...cambios },
    total: nuevo.cotizacion.total,
    recotizado: Boolean(cotizacionNueva),
    porQue: porQue || null,
    wamid,
  });

  return { ok: true, pedido: nuevo };
}

/**
 * Cancela. Borrado suave e IDEMPOTENTE: cancelar dos veces no es un error ni
 * pisa el motivo original.
 */
function cancelar({ pedido, motivo = "", wamid = null, ahora = new Date() }) {
  if (!pedido) return { ok: false, motivo: "no hay pedido que cancelar" };
  if (pedido.estado === ESTADOS_PEDIDO.CANCELADO) {
    return { ok: true, pedido, yaEstaba: true };
  }
  if (pedido.estado === ESTADOS_PEDIDO.DESPACHADO) {
    return { ok: false, motivo: "el pedido ya salio: la cancelacion la gestiona una persona" };
  }

  const nuevo = JSON.parse(JSON.stringify(pedido));
  nuevo.version = pedido.version + 1;
  nuevo.estado = ESTADOS_PEDIDO.CANCELADO;
  nuevo.canceladoEn = ahora.toISOString();
  nuevo.motivoCancelacion = motivo || "sin motivo registrado";
  nuevo.actualizadoEn = ahora.toISOString();
  nuevo.historial.push({
    version: nuevo.version,
    accion: "cancelado",
    cuando: ahora.toISOString(),
    porQue: motivo || null,
    wamid,
  });

  return { ok: true, pedido: nuevo, yaEstaba: false };
}

/** ¿Esta listo para despachar sin que nadie lo mire? */
/**
 * Tipos de novedad de entrega.
 *
 * Son los tres que la transportadora reporta y que tienen una accion
 * distinta del cliente. No es una lista abierta a proposito: una novedad
 * con tipo libre no se puede contar, y lo que no se cuenta no se corrige.
 */
const TIPOS_DE_NOVEDAD = {
  AUSENTE: "ausente", // nadie en la direccion
  DIRECCION: "direccion", // direccion incorrecta o incompleta
  OFICINA: "oficina", // hay que recogerlo en oficina
};

/**
 * DESPACHAR: el pedido sale con su numero de guia.
 *
 * --------------------------------------------------------------------------
 * POR QUE LA GUIA ES OBLIGATORIA
 * --------------------------------------------------------------------------
 *
 * Un pedido "despachado" sin numero de guia no se puede rastrear, y es
 * exactamente el estado en el que un cliente pregunta "¿donde va mi
 * pedido?" y nadie sabe responder. Marcarlo despachado sin guia convierte
 * una venta en un paquete perdido con contabilidad correcta.
 *
 * IDEMPOTENTE con la MISMA guia: reenviar el mismo despacho no es un error
 * -el panel puede reintentar, el PDF puede subirse dos veces- y no sube la
 * version. Con una guia DISTINTA si falla: dos guias para un pedido
 * significa que una de las dos es de otro cliente, y eso no lo puede
 * resolver el codigo.
 */
function despachar({ pedido, guia, transportadora = null, wamid = null, ahora = new Date() }) {
  if (!pedido) return { ok: false, motivo: "no hay pedido que despachar" };

  const numero = String(guia || "").trim();
  if (!numero) {
    return { ok: false, motivo: "hace falta el numero de guia: sin el, el pedido no se puede rastrear" };
  }

  if (pedido.estado === ESTADOS_PEDIDO.DESPACHADO) {
    const yaTiene = String((pedido.despacho && pedido.despacho.guia) || "").trim();
    if (yaTiene === numero) return { ok: true, pedido, yaEstaba: true };
    return {
      ok: false,
      motivo: `el pedido ya salio con la guia ${yaTiene}; no se puede cambiar por ${numero} sin que lo revise una persona`,
      guiaActual: yaTiene,
    };
  }

  const listo = listoParaDespachar(pedido);
  if (!listo.ok) return { ok: false, motivo: `no se puede despachar: ${listo.motivo}` };

  const nuevo = JSON.parse(JSON.stringify(pedido));
  nuevo.version = pedido.version + 1;
  nuevo.estado = ESTADOS_PEDIDO.DESPACHADO;
  nuevo.actualizadoEn = ahora.toISOString();
  nuevo.despacho = {
    guia: numero,
    transportadora: transportadora || null,
    despachadoEn: ahora.toISOString(),
  };
  nuevo.historial.push({
    version: nuevo.version,
    accion: "despachado",
    cuando: ahora.toISOString(),
    guia: numero,
    transportadora: transportadora || null,
    wamid,
  });

  return { ok: true, pedido: nuevo, yaEstaba: false };
}

/**
 * Registra una novedad de entrega.
 *
 * No cambia el estado del pedido: sigue despachado. Una novedad es algo que
 * le paso al paquete, no un estado distinto de la venta, y mezclarlas haria
 * que un pedido con novedad desapareciera de los despachados.
 *
 * No sube la version del pedido: la venta no cambio. Pero SI queda en el
 * historial, porque es lo que explica por que una entrega tardo.
 */
function registrarNovedad({ pedido, tipo, detalle = "", ahora = new Date() }) {
  if (!pedido) return { ok: false, motivo: "no hay pedido" };
  if (!Object.values(TIPOS_DE_NOVEDAD).includes(tipo)) {
    return {
      ok: false,
      motivo: `"${tipo}" no es un tipo de novedad conocido (${Object.values(TIPOS_DE_NOVEDAD).join(", ")})`,
    };
  }
  if (pedido.estado !== ESTADOS_PEDIDO.DESPACHADO) {
    // Una novedad sobre un pedido que no salio significa que alguien se
    // equivoco de pedido, y avisar al cliente equivocado es peor que no
    // avisar.
    return { ok: false, motivo: "solo un pedido despachado puede tener una novedad de entrega" };
  }

  const nuevo = JSON.parse(JSON.stringify(pedido));
  nuevo.novedades = Array.isArray(nuevo.novedades) ? nuevo.novedades : [];

  const abierta = nuevo.novedades.find((n) => n.tipo === tipo && !n.resueltaEn);
  if (abierta) {
    // Idempotente: la transportadora reporta la misma novedad varias veces.
    return { ok: true, pedido, yaEstaba: true, novedad: abierta };
  }

  const novedad = {
    id: `nov-${nuevo.novedades.length + 1}`,
    tipo,
    detalle: String(detalle || "").slice(0, 300),
    creadaEn: ahora.toISOString(),
    resueltaEn: null,
    avisoAlCliente: null, // lo rellena quien intente avisar, con su resultado REAL
  };
  nuevo.novedades.push(novedad);
  nuevo.actualizadoEn = ahora.toISOString();
  nuevo.historial.push({
    version: nuevo.version,
    accion: "novedad",
    cuando: ahora.toISOString(),
    tipo,
    porQue: novedad.detalle || null,
  });

  return { ok: true, pedido: nuevo, yaEstaba: false, novedad };
}

/** Cierra una novedad. Idempotente. */
function resolverNovedad({ pedido, id, comoSeResolvio = "", ahora = new Date() }) {
  if (!pedido) return { ok: false, motivo: "no hay pedido" };
  const nuevo = JSON.parse(JSON.stringify(pedido));
  nuevo.novedades = Array.isArray(nuevo.novedades) ? nuevo.novedades : [];
  const n = nuevo.novedades.find((x) => x.id === id);
  if (!n) return { ok: false, motivo: `no hay una novedad ${id} en este pedido` };
  if (n.resueltaEn) return { ok: true, pedido, yaEstaba: true };

  n.resueltaEn = ahora.toISOString();
  n.comoSeResolvio = String(comoSeResolvio || "").slice(0, 300);
  nuevo.actualizadoEn = ahora.toISOString();
  nuevo.historial.push({
    version: nuevo.version,
    accion: "novedad_resuelta",
    cuando: ahora.toISOString(),
    tipo: n.tipo,
    porQue: n.comoSeResolvio || null,
  });

  return { ok: true, pedido: nuevo, yaEstaba: false };
}

/** Novedades sin resolver de un pedido. */
function novedadesAbiertas(pedido) {
  const lista = (pedido && pedido.novedades) || [];
  return Array.isArray(lista) ? lista.filter((n) => !n.resueltaEn) : [];
}

function listoParaDespachar(pedido) {
  if (!pedido) return { ok: false, motivo: "no hay pedido" };
  if (pedido.estado === ESTADOS_PEDIDO.CANCELADO) return { ok: false, motivo: "cancelado" };
  if (pedido.estado === ESTADOS_PEDIDO.EN_REVISION) {
    return { ok: false, motivo: `en revision: ${pedido.revisiones.map((r) => r.motivo || r).join("; ")}` };
  }
  for (const campo of REQUERIDOS_PARA_DESPACHAR) {
    if (!pedido.destinatario || !pedido.destinatario[campo]) {
      return { ok: false, motivo: `falta ${campo}` };
    }
  }
  return { ok: true };
}

module.exports = {
  ESTADOS_PEDIDO,
  REQUERIDOS_PARA_DESPACHAR,
  CAMPOS_QUE_AFECTAN_PRECIO,
  claveDeEvento,
  claveDeOferta,
  nuevoIdDePedido,
  nuevoIdDeOferta,
  construir,
  modificar,
  cancelar,
  despachar,
  registrarNovedad,
  resolverNovedad,
  novedadesAbiertas,
  TIPOS_DE_NOVEDAD,
  requiereRecotizar,
  listoParaDespachar,
};
