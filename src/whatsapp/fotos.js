"use strict";

// ==========================================================================
// MANDAR LAS FOTOS DE UN PRODUCTO
//
// Un producto tiene varias fotos y WhatsApp solo manda una por mensaje. Asi
// que esto es un lote, y un lote tiene dos problemas que un envio suelto no
// tiene: el ORDEN y la REPETICION.
//
// --------------------------------------------------------------------------
// EN ORDEN, Y POR ESO EN SERIE
// --------------------------------------------------------------------------
//
// Las cinco fotos del cinturon cuentan algo en secuencia: el producto de
// frente, puesto, el detalle de la pantalla, la correa, el empaque.
// Mandarlas con Promise.all seria mas rapido y llegarian desordenadas,
// porque el orden de entrega no lo decidimos nosotros. Una galeria de
// producto que llega revuelta se ve descuidada, y lo que vende una foto es
// precisamente que parezca cuidada.
//
// Van una detras de otra, esperando cada una.
//
// --------------------------------------------------------------------------
// SIN REPETIR
// --------------------------------------------------------------------------
//
// Si el cliente vuelve a preguntar por el mismo producto -o si un turno se
// reprocesa tras un crash, que es algo que esta disenado para ocurrir- el
// bot mandaria las cinco otra vez. Diez fotos seguidas de lo mismo no es un
// detalle estetico: es la clase de cosa por la que alguien bloquea un
// numero.
//
// Se anota en la conversacion que ya se mandaron, por producto. Es el mismo
// razonamiento que la idempotencia del pedido: la marca va en el almacen,
// no en la memoria del proceso, porque en Render cada despliegue reinicia.
//
// --------------------------------------------------------------------------
// EL PIE DE FOTO
// --------------------------------------------------------------------------
//
// Solo la PRIMERA lleva pie. Repetirlo cinco veces llena la pantalla del
// telefono de texto igual. Y el pie se recibe de fuera: este modulo no
// redacta nada, porque un texto sobre un producto es un dato comercial y
// eso no se inventa aqui.
// ==========================================================================

const atencion = require("../almacen/atencion");

/** Dónde se anota en la conversación que ya se mandaron. */
function yaSeMandaron(conversacion, productoId) {
  const m = (conversacion && conversacion.fotosEnviadas) || {};
  const registro = m[productoId];
  return registro ? { si: true, ...registro } : { si: false };
}

function anotarEnviadas(conversacion, productoId, { cuantas, wamids }) {
  conversacion.fotosEnviadas = {
    ...((conversacion && conversacion.fotosEnviadas) || {}),
    [productoId]: { cuando: new Date().toISOString(), cuantas, wamids },
  };
  return conversacion;
}

/**
 * Manda las fotos de un producto.
 *
 * NUNCA LANZA: devuelve siempre un informe. Un fallo mandando fotos no
 * puede tumbar el turno de un cliente.
 *
 * @param {object} o
 * @param {object} o.emisor
 * @param {object} o.repos
 * @param {object} o.producto        del catalogo, con `imagenes`
 * @param {object} o.conversacion    se modifica y se guarda
 * @param {string} o.para            telefono o id de WhatsApp
 * @param {string} o.permiso         CONVERSACION o ATENCION_MANUAL
 * @param {string} [o.pie]           pie de la PRIMERA foto
 * @param {boolean} [o.forzar]       repetir aunque ya se mandaran (panel)
 * @param {number} [o.max]           tope de fotos a mandar
 */
async function enviarFotosDeProducto({
  emisor,
  repos,
  producto,
  conversacion,
  para,
  permiso,
  pie = "",
  forzar = false,
  max = 10,
}) {
  const informe = {
    productoId: producto && producto.id,
    cuantas: 0,
    enviadas: 0,
    bloqueadas: 0,
    fallidas: 0,
    repetido: false,
    resultados: [],
    problemas: [],
  };

  const imagenes = (producto && producto.imagenes) || [];
  informe.cuantas = Math.min(imagenes.length, max);

  if (!imagenes.length) {
    informe.problemas.push(`el producto ${producto && producto.id} no tiene fotos vinculadas`);
    return informe;
  }
  if (!emisor || typeof emisor.enviarImagen !== "function") {
    informe.problemas.push("no hay emisor con el que mandar");
    return informe;
  }

  // --- Sin repetir ---
  const previo = yaSeMandaron(conversacion, producto.id);
  if (previo.si && !forzar) {
    informe.repetido = true;
    informe.problemas.push(
      `las fotos de ${producto.id} ya se le mandaron a este cliente el ${previo.cuando} (${previo.cuantas}). No se repiten.`
    );
    return informe;
  }

  const wamids = [];

  for (const [i, img] of imagenes.slice(0, max).entries()) {
    // En serie, esperando cada una: es lo que preserva el orden.
    const r = await emisor.enviarImagen({
      para,
      archivo: img.archivo,
      // Solo la primera lleva pie.
      pie: i === 0 ? pie : "",
      permiso,
      conversacionId: conversacion && conversacion.contactoId,
    });

    const estado = r.enviado ? "enviado" : r.bloqueado ? r.motivo : "fallo_de_envio";
    informe.resultados.push({
      archivo: img.archivo,
      alt: img.alt || null,
      enviado: r.enviado === true,
      estado,
      detalle: r.detalle || null,
      wamid: r.wamid || null,
      url: r.url || null,
    });

    if (r.enviado) {
      informe.enviadas++;
      if (r.wamid) wamids.push(r.wamid);
    } else if (r.bloqueado) {
      informe.bloqueadas++;
    } else {
      informe.fallidas++;
    }

    // El historial guarda el resultado REAL de cada foto, igual que un
    // mensaje de texto. Si no salio, se ve que no salio.
    if (conversacion) {
      atencion.anotarMensaje(conversacion, {
        de: permiso === "atencion_manual" ? atencion.QUIEN.OPERADOR : atencion.QUIEN.BOT,
        texto: `[foto] ${img.alt || img.archivo}`,
        por: permiso === "atencion_manual" ? "panel" : null,
        estado,
        wamid: r.wamid || null,
      });
    }

    // --------------------------------------------------------------
    // Si la PRIMERA se bloquea, se para.
    //
    // Un bloqueo no es un problema de esa foto: es el interruptor
    // apagado, o una persona que tomo el control del chat. Seguir
    // intentando las otras cuatro solo llena el historial de cuatro
    // "no enviado" identicos y gasta cuatro llamadas para nada.
    //
    // Un FALLO si deja seguir: puede ser de esa imagen concreta.
    // --------------------------------------------------------------
    if (r.bloqueado && i === 0) {
      informe.problemas.push(
        `no se mando ninguna: ${r.motivo}${r.detalle ? ` (${r.detalle})` : ""}`
      );
      break;
    }
  }

  // Solo se marca como mandado si de verdad salio alguna. Marcarlo tras un
  // bloqueo impediria volver a intentarlo cuando se encienda el
  // interruptor, y el cliente se quedaria sin fotos para siempre.
  if (informe.enviadas > 0 && conversacion) {
    anotarEnviadas(conversacion, producto.id, { cuantas: informe.enviadas, wamids });
  }

  if (conversacion && repos) {
    try {
      await repos.conversaciones.guardar(conversacion);
    } catch (e) {
      informe.problemas.push(`no se pudo guardar la conversacion: ${e.message}`);
    }
  }

  if (informe.enviadas > 0 && informe.enviadas < informe.cuantas) {
    informe.problemas.push(
      `se mandaron ${informe.enviadas} de ${informe.cuantas}: el cliente vio una galeria incompleta`
    );
  }

  return informe;
}

module.exports = { enviarFotosDeProducto, yaSeMandaron, anotarEnviadas };
