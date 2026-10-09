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
  /**
   * ENTREGADO: llego y el cliente pago.
   *
   * En un negocio CONTRAENTREGA este es el unico estado en el que la plata
   * existe de verdad. Sin el, "cuanto vamos recaudado" se contestaba con el
   * importe de lo VENDIDO, que es otra pregunta: la diferencia entre las dos
   * cifras es la tasa de rechazo.
   */
  ENTREGADO: "entregado",
};

/**
 * Estados en los que el pedido YA CUMPLIO SU CICLO.
 *
 * Es la lista que decide cual es el pedido "vivo" de un contacto, y vive
 * aqui -en el dominio- porque los DOS backends del almacen la necesitan y
 * tenerla dos veces es como se separan. Ya paso con las dos listas de
 * "pregunta de precio".
 *
 * `entregado` entra por la misma razon que `despachado`: a quien ya recibio
 * su pedido hay que dejarle comprar otra vez. Si un entregado contara como
 * vivo, la clienta que vuelve acabaria modificando el pedido que ya tiene
 * en casa.
 */
const CERRADOS = new Set([
  ESTADOS_PEDIDO.CANCELADO,
  ESTADOS_PEDIDO.DESPACHADO,
  ESTADOS_PEDIDO.ENTREGADO,
]);

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
  // ----------------------------------------------------------------------
  // CORREGIR UN DATO CIERRA SU REVISION
  //
  // ⚠️ SIN ESTO, UN PEDIDO EN REVISION NO TENIA SALIDA, Y BLOQUEO UNA GUIA
  //    DE VERDAD EL 09-oct.
  //
  // `construir` pone el pedido en EN_REVISION cuando un dato queda dudoso
  // -por ejemplo un nombre de una sola palabra-, y `listoParaDespachar`
  // niega el despacho mientras siga en ese estado. Correcto: nadie quiere
  // imprimir una guia a nombre de "Sii".
  //
  // Lo que faltaba era la puerta de salida. Las revisiones se escribian al
  // crear el pedido y NADIE las borraba nunca, asi que el unico final
  // posible era cancelar el pedido y rehacerlo a mano. Una clienta de
  // Ipiales con $49.900 se quedo sin paquete por eso.
  //
  // Ahora, cuando se corrige el campo que estaba en duda, su revision se
  // va con el. Las de los OTROS campos se quedan: arreglar el nombre no
  // dice nada sobre la direccion.
  // ----------------------------------------------------------------------
  const camposCorregidos = new Set(Object.keys(cambios));
  const revisionesQueQuedan = (nuevo.revisiones || []).filter((r) => !camposCorregidos.has(r && r.campo));
  const revisionesCerradas = (nuevo.revisiones || []).length - revisionesQueQuedan.length;
  nuevo.revisiones = revisionesQueQuedan;

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
    // Queda escrito en el historial, que es lo que se ve en Auditoria: si
    // un pedido pasa de "en revision" a despachable, tiene que poder
    // leerse POR QUE y quien lo hizo.
    revisionesCerradas: revisionesCerradas || 0,
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
 * ENTREGAR: el paquete llego y el cliente pago.
 *
 * --------------------------------------------------------------------------
 * POR QUE ESTE ESTADO HACIA FALTA, Y NO ES UN LUJO DE PANEL
 * --------------------------------------------------------------------------
 *
 * ESTE NEGOCIO ES CONTRAENTREGA. El cliente paga cuando el paquete esta en
 * su mano, asi que un pedido confirmado -o incluso despachado- NO es plata
 * cobrada: es plata en riesgo. Si se cae la entrega, el importe no entra y
 * encima el flete ya se gasto.
 *
 * Sin este estado, el panel sumaba los pedidos vivos y lo llamaba el
 * importe del dia. Para una venta anticipada eso seria correcto; para
 * contraentrega contesta OTRA PREGUNTA. Marco pregunto "cuanto vamos
 * recaudado", y lo que el panel sabia decir era cuanto se habia VENDIDO.
 * La diferencia entre las dos cifras es exactamente la tasa de rechazo, que
 * en la referencia de BIKERPRO es el numero que decide si el negocio gana o
 * pierde.
 *
 * IDEMPOTENTE: marcar dos veces entregado no es un error -el panel puede
 * reintentar, o dos personas pueden marcarlo- y no sube la version.
 *
 * SOLO DESDE DESPACHADO. Un pedido que no salio no puede haber llegado, y
 * dejar que se marque entregado sin pasar por despachado permite cuadrar la
 * caja con pedidos que nunca se enviaron. Si la entrega ocurrio de verdad,
 * primero se registra el despacho con su guia.
 */
function entregar({ pedido, ahora = new Date() }) {
  if (!pedido) return { ok: false, motivo: "no hay pedido que entregar" };

  if (pedido.estado === ESTADOS_PEDIDO.ENTREGADO) {
    return { ok: true, pedido, yaEstaba: true };
  }

  if (pedido.estado !== ESTADOS_PEDIDO.DESPACHADO) {
    return {
      ok: false,
      motivo:
        `el pedido esta "${pedido.estado}": solo se puede entregar lo que ya salio despachado. ` +
        `Si llego de verdad, primero se registra el despacho con su guia`,
    };
  }

  const nuevo = JSON.parse(JSON.stringify(pedido));
  nuevo.version = pedido.version + 1;
  nuevo.estado = ESTADOS_PEDIDO.ENTREGADO;
  nuevo.actualizadoEn = ahora.toISOString();
  nuevo.entrega = {
    entregadoEn: ahora.toISOString(),
    // El importe que se recaudo es el del pedido, y se congela aqui: si
    // manana alguien modifica la cotizacion, la caja de ayer no se mueve.
    importeRecaudado: (pedido.cotizacion && pedido.cotizacion.total) || 0,
  };
  nuevo.historial.push({
    version: nuevo.version,
    accion: "entregado",
    cuando: ahora.toISOString(),
    importeRecaudado: nuevo.entrega.importeRecaudado,
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

/**
 * Anota QUE PASO DE VERDAD al intentar avisarle al cliente.
 *
 * --------------------------------------------------------------------------
 * POR QUE SE GUARDA EL RESULTADO Y NO UN "AVISADO: SI"
 * --------------------------------------------------------------------------
 *
 * Porque que Meta acepte un mensaje NO significa que lo entregue. Se midio
 * en BIKERPRO con el cierre diario: Meta respondio ok con su `wamid` y nunca
 * lo entrego. Un campo booleano habria dicho "avisado" de un mensaje que el
 * cliente no vio nunca.
 *
 * Asi que se guarda la terna completa: si se acepto, si lo freno un
 * interruptor -y cual-, o si fallo y con que codigo. El panel lo muestra tal
 * cual, y la entrega real solo se da por buena cuando llega el acuse
 * `delivered` por el webhook.
 *
 * NO SUBE LA VERSION NI CAMBIA EL ESTADO: avisar no modifica la venta. Pero
 * SI queda en el historial, porque es lo que explica por que un cliente no
 * se enteró de que su paquete estaba en una oficina.
 *
 * ES IDEMPOTENTE HACIA EL LADO SEGURO: un aviso que ya salio no se sobrescribe
 * con uno que fallo. Si el primer intento se entrego y un reintento por
 * descuido falla, el pedido tiene que seguir diciendo que el cliente fue
 * avisado; al reves, el operador volveria a escribirle.
 *
 * @param {object} opciones
 * @param {object} opciones.pedido
 * @param {{enviado:boolean, bloqueado?:boolean, motivo?:string, wamid?:string,
 *          porPlantilla?:boolean, plantilla?:string, codigoMeta?:number,
 *          certeza?:number, aMano?:boolean}} opciones.resultado
 */
function registrarAvisoDeGuia({ pedido, resultado, ahora = new Date() }) {
  if (!pedido) return { ok: false, motivo: "no hay pedido" };
  if (!pedido.despacho || !pedido.despacho.guia) {
    return { ok: false, motivo: "este pedido no tiene guia: no hay nada de lo que avisar" };
  }

  const yaSalio = pedido.despacho.avisoAlCliente && pedido.despacho.avisoAlCliente.enviado;
  if (yaSalio && !(resultado && resultado.enviado)) {
    return { ok: true, pedido, yaEstaba: true };
  }

  const nuevo = JSON.parse(JSON.stringify(pedido));
  nuevo.despacho.avisoAlCliente = resumirAviso(resultado, ahora);
  nuevo.actualizadoEn = ahora.toISOString();
  nuevo.historial.push({
    version: nuevo.version,
    accion: "aviso_de_guia",
    cuando: ahora.toISOString(),
    guia: nuevo.despacho.guia,
    enviado: nuevo.despacho.avisoAlCliente.enviado,
    porQue: nuevo.despacho.avisoAlCliente.motivo || null,
  });

  return { ok: true, pedido: nuevo, yaEstaba: false };
}

/** Lo mismo, para el aviso de una novedad concreta. */
function registrarAvisoDeNovedad({ pedido, id, resultado, ahora = new Date() }) {
  if (!pedido) return { ok: false, motivo: "no hay pedido" };

  const nuevo = JSON.parse(JSON.stringify(pedido));
  nuevo.novedades = Array.isArray(nuevo.novedades) ? nuevo.novedades : [];
  const n = nuevo.novedades.find((x) => x.id === id);
  if (!n) return { ok: false, motivo: `no hay una novedad ${id} en este pedido` };

  if (n.avisoAlCliente && n.avisoAlCliente.enviado && !(resultado && resultado.enviado)) {
    return { ok: true, pedido, yaEstaba: true };
  }

  n.avisoAlCliente = resumirAviso(resultado, ahora);
  nuevo.actualizadoEn = ahora.toISOString();
  nuevo.historial.push({
    version: nuevo.version,
    accion: "aviso_de_novedad",
    cuando: ahora.toISOString(),
    tipo: n.tipo,
    enviado: n.avisoAlCliente.enviado,
    porQue: n.avisoAlCliente.motivo || null,
  });

  return { ok: true, pedido: nuevo, yaEstaba: false };
}

/**
 * Normaliza el resultado de un envio a lo que se guarda en el pedido.
 *
 * Se queda con lo que permite responder "¿el cliente lo vio?" y descarta el
 * resto: el objeto que devuelve el emisor lleva detalles de red que no
 * tienen por que vivir dentro de un pedido para siempre.
 */
function resumirAviso(resultado, ahora) {
  const r = resultado || {};
  return {
    enviado: Boolean(r.enviado),
    // `bloqueado` distingue "lo paro un interruptor nuestro" de "fallo".
    // Son dos cosas con dos soluciones distintas, y mezclarlas hace que se
    // busque un fallo de red donde hay un interruptor apagado.
    bloqueado: Boolean(r.bloqueado),
    motivo: r.motivo || null,
    wamid: r.wamid || null,
    porPlantilla: Boolean(r.porPlantilla),
    plantilla: r.plantilla || null,
    codigoMeta: r.codigoMeta == null ? null : Number(r.codigoMeta),
    // Para el flujo de guias: con que certeza se pareo, y si lo asigno una
    // persona. Manana, ante un error, dice si fallo el puntaje o el humano.
    certeza: r.certeza == null ? null : Number(r.certeza),
    aMano: Boolean(r.aMano),
    cuando: ahora.toISOString(),
    /**
     * La entrega REAL, que solo la confirma el acuse del webhook. Nace en
     * null a proposito: "aceptado por Meta" y "entregado" son dos cosas, y
     * dar la segunda por la primera es como se cuentan clientes avisados que
     * no se enteraron de nada.
     */
    entregadoEn: null,
  };
}

/** Novedades sin resolver de un pedido. */
function novedadesAbiertas(pedido) {
  const lista = (pedido && pedido.novedades) || [];
  return Array.isArray(lista) ? lista.filter((n) => !n.resueltaEn) : [];
}

function listoParaDespachar(pedido) {
  if (!pedido) return { ok: false, motivo: "no hay pedido" };
  if (pedido.estado === ESTADOS_PEDIDO.CANCELADO) return { ok: false, motivo: "cancelado" };
  // ⚠️ SE MIRAN LAS REVISIONES, NO SOLO EL ESTADO.
  //
  // Antes solo se comprobaba `estado === EN_REVISION`, y eso dejaba un hueco
  // que se abrio al permitir corregir datos: `modificar` pone el pedido en
  // MODIFICADO, asi que un pedido con una duda SIN resolver se volvia
  // despachable por haber tocado cualquier otro campo. Con el cambio de
  // cantidad ya pasaba: cambiar de 1 a 2 unidades "limpiaba" una duda sobre
  // el nombre que nadie habia mirado.
  //
  // Mirar la lista es equivalente a mirar el estado en el momento de crear
  // el pedido -`construir` pone EN_REVISION si y solo si hay revisiones-, asi
  // que esto no bloquea nada que antes pasara: solo tapa el hueco.
  const pendientes = (pedido.revisiones || []).filter(Boolean);
  if (pedido.estado === ESTADOS_PEDIDO.EN_REVISION || pendientes.length) {
    return { ok: false, motivo: `en revision: ${pendientes.map((r) => r.motivo || r).join("; ")}` };
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
  CERRADOS,
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
  entregar,
  registrarNovedad,
  resolverNovedad,
  registrarAvisoDeGuia,
  registrarAvisoDeNovedad,
  novedadesAbiertas,
  TIPOS_DE_NOVEDAD,
  requiereRecotizar,
  listoParaDespachar,
};
