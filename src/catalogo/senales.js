"use strict";

// ==========================================================================
// IDENTIFICACION DE PRODUCTO
//
// Modulo puro salvo que recibe el catalogo ya cargado.
//
// En un catalogo multicategoria, confundir el producto es despachar el
// equivocado y pagar la devolucion. Y el error no suele venir de no
// reconocer el producto: viene de reconocer uno que no era.
//
// El caso que mas duele, documentado en BIKERPRO: en una conversacion sobre
// intercomunicadores el cliente pregunto "¿son impermeables?". La palabra
// "impermeable" era el nombre del otro producto, el sistema leyo un cambio
// de producto, congelo el nuevo, y el pedido se guardo con el producto
// equivocado al precio equivocado.
//
// En NOVIKA eso va a pasar MAS, no menos: "termico", "inalambrico",
// "portatil", "antideslizante" son a la vez adjetivos y nombres de producto.
// Por eso hay dos mecanismos separados:
//
//   SEÑALES CON PRIORIDAD Y CONFIANZA  -> que producto es
//   DETECTOR DE FALSA SEÑAL            -> cuando NO hacer caso a una señal
//
// Y la regla que lo cierra: si no se puede identificar, el producto es
// DESCONOCIDO. No hay producto por defecto. Preguntar cuesta un mensaje;
// adivinar cuesta un paquete, un flete y la confianza del cliente.
// ==========================================================================

const { aplanar } = require("../dominio/texto");

const DESCONOCIDO = null;

const ORIGENES = {
  TEXTO_ACTUAL: "texto_actual",
  CONTEXTO: "contexto_confirmado",
  REFERRAL: "referral",
  VENTANA: "ventana_reciente",
};

/**
 * Giros que convierten la mencion de un producto en una PREGUNTA sobre el
 * producto actual, no en un cambio de producto.
 *
 * "¿sirve para la espalda?" en una conversacion sobre un cinturon no es
 * pedir un producto de espalda.
 */
const GIROS_COMPARATIVOS = [
  /\b(sirve|funciona|vale|va|se\s+puede\s+usar|se\s+usa)\s+(para|con|en)\b/,
  /\b(es|son)\s+(igual|parecido|similar|lo\s+mismo)\b/,
  /\b(se\s+parece|comparado|frente)\s+a\b/,
  /\b(tambien|ademas)\s+(sirve|funciona|vale)\b/,
  /\bque\s+diferencia\b/,
  /\b(es|son)\s+\w+(es|s)?\?/, // "¿son termicos?" -> adjetivo, no producto
  /\b(viene|trae|incluye)\s+con\b/,
  /\bademas\s+de\b/,
];

/** ¿El mensaje es una pregunta sobre caracteristicas y no un pedido? */
function esGiroComparativo(texto) {
  const plano = aplanar(texto);
  return GIROS_COMPARATIVOS.some((re) => re.test(plano));
}

/**
 * Giros que SI indican que el cliente quiere otro producto.
 * Tienen que ser explicitos: pedir, querer, cambiar.
 */
const GIROS_DE_CAMBIO = [
  /\b(quiero|necesito|busco|me\s+interesa|mandame|enviame|vendeme)\b/,
  /\b(mejor|en\s+vez\s+de|en\s+lugar\s+de|cambi(a|o|ar))\b/,
  /\bel\s+otro\b/,
  /\btambien\s+quiero\b/,
  /\b(cuanto\s+(vale|cuesta)|precio\s+del?)\b/,
];

function pideOtroProducto(texto) {
  const plano = aplanar(texto);
  return GIROS_DE_CAMBIO.some((re) => re.test(plano));
}

/**
 * Señales de producto en un texto, con su confianza y posicion.
 * Delega al catalogo, que es quien tiene los alias.
 */
function senalesEnTexto(texto, catalogo) {
  const orden = { alta: 0, media: 1, baja: 2 };
  const encontradas = [];

  // ------------------------------------------------------------------------
  // SE BUSCA EN TODO EL CATALOGO, NO SOLO EN LOS ACTIVOS
  //
  // Antes solo recorria `activos`, y eso tenia una consecuencia que no era
  // evidente: con el unico producto en borrador, NINGUN mensaje podia
  // identificar nada. El cliente escribia "fotos del cinturon termico" y el
  // bot volvia a preguntar que producto queria, en bucle.
  //
  // IDENTIFICAR no es VENDER, y conflictuarlos era el error. Reconocer de
  // que habla el cliente sirve para contestarle con sentido -mandarle las
  // fotos, explicarle que el precio todavia no esta- aunque no se le pueda
  // cotizar.
  //
  // Lo que impide venderlo sigue donde estaba, y es duro: `cotizar()` se
  // niega con "el producto no esta activo", y sin cotizacion no hay pedido.
  // Asi que identificar un borrador no abre ninguna puerta; solo deja de
  // cerrar la boca al bot.
  // ------------------------------------------------------------------------
  const todos = catalogo.productos || catalogo.todos || catalogo.activos || [];

  // ------------------------------------------------------------------------
  // Y SE BUSCA SIN TILDES
  //
  // Los patrones del catalogo estan escritos sin tildes ("cinturon",
  // "termic", "colicos") y se comparaban contra el texto CRUDO. Resultado:
  //
  //   "cinturon termico"  -> coincide
  //   "cinturón térmico"  -> NO coincide
  //
  // Una clienta escribiendo desde el movil pone la tilde, porque el teclado
  // la pone sola. Es decir: el alias funcionaba justo con la forma que casi
  // nadie escribe, y eso es una venta perdida sin ningun error en los logs.
  //
  // Se compara contra la forma aplanada -minusculas, sin tildes, sin
  // signos- que ya existia en dominio/texto.js y que este modulo no usaba.
  // ------------------------------------------------------------------------
  const plano = aplanar(texto);

  for (const producto of todos) {
    for (const alias of producto._aliases || []) {
      const m = plano.match(alias.re);
      if (m) {
        encontradas.push({
          productoId: producto.id,
          confianza: alias.confianza || "media",
          senal: alias.senal || m[0],
          posicion: m.index,
          // Para que quien recibe la senal pueda distinguir "se que
          // producto es" de "se lo puedo vender".
          activo: producto.activo === true,
        });
      }
    }
  }

  // Una sola señal por producto: la de mayor confianza.
  const porProducto = new Map();
  for (const s of encontradas) {
    const previa = porProducto.get(s.productoId);
    if (!previa || (orden[s.confianza] ?? 9) < (orden[previa.confianza] ?? 9)) {
      porProducto.set(s.productoId, s);
    }
  }

  return [...porProducto.values()].sort(
    (a, b) => (orden[a.confianza] ?? 9) - (orden[b.confianza] ?? 9) || a.posicion - b.posicion
  );
}

/** Producto que viene del anuncio de Meta. Señal ADICIONAL, nunca unica. */
function productoDelReferral(referral, catalogo) {
  if (!referral) return null;

  // 1. El anuncio declara el producto. Es la señal mas fiable que existe.
  if (referral.productoId && catalogo.porId.has(referral.productoId)) {
    return { productoId: referral.productoId, confianza: "alta", senal: "productoId del anuncio" };
  }

  // 2. Mapeo por id de anuncio, configurado en el catalogo.
  for (const producto of catalogo.activos || []) {
    const anuncios = producto.anuncios || [];
    if (referral.source_id && anuncios.includes(String(referral.source_id))) {
      return { productoId: producto.id, confianza: "alta", senal: `anuncio ${referral.source_id}` };
    }
  }

  // 3. Ultimo recurso: los alias contra el titular y el cuerpo del anuncio.
  //    Confianza media: el titular de un anuncio puede mencionar varias cosas.
  const textoAnuncio = [referral.headline, referral.body, referral.source_url].filter(Boolean).join(" ");
  if (textoAnuncio) {
    const senales = senalesEnTexto(textoAnuncio, catalogo);
    if (senales.length === 1) {
      return { productoId: senales[0].productoId, confianza: "media", senal: "texto del anuncio" };
    }
  }

  return null;
}

/**
 * Resuelve el producto de un turno.
 *
 * PRIORIDAD (y el motivo de cada escalon):
 *
 *   1. Señal explicita en ESTE mensaje, si no es un giro comparativo.
 *      El cliente lo esta diciendo ahora; manda sobre cualquier contexto.
 *
 *   2. Contexto confirmado de la conversacion.
 *      Imprescindible porque el historial se rota: el turno donde se nombro
 *      el producto se cae de la ventana, y sin esto el bot "olvida" de que
 *      estaban hablando a mitad de la venta.
 *
 *   3. Referral del anuncio.
 *      Fiable, pero solo para el primer mensaje: si el cliente ya dijo otra
 *      cosa, lo que dijo pesa mas que el anuncio por el que entro.
 *
 *   4. Señal en la ventana reciente de mensajes.
 *
 *   5. DESCONOCIDO.
 *
 * @returns {{productoId: string|null, origen: string|null, confianza: string,
 *            motivo: string, ambiguo?: boolean, opciones?: string[],
 *            esCambio?: boolean}}
 */
function resolver({ texto = "", referral = null, conversacion = null, catalogo, ventana = [] }) {
  const confirmado = (conversacion && conversacion.productoId) || null;
  const senales = senalesEnTexto(texto, catalogo);

  // ---- 1. Señales en el mensaje actual ----
  if (senales.length > 1) {
    // Dos productos en la misma frase. NO se elige. Elegir en un empate es
    // exactamente como se despacha mal.
    return {
      productoId: DESCONOCIDO,
      origen: ORIGENES.TEXTO_ACTUAL,
      confianza: "baja",
      ambiguo: true,
      opciones: senales.map((s) => s.productoId),
      motivo: `el mensaje menciona ${senales.length} productos: hay que preguntar cual`,
    };
  }

  if (senales.length === 1) {
    const senal = senales[0];
    const esOtro = confirmado && senal.productoId !== confirmado;

    if (esOtro) {
      // La mencion de otro producto en una conversacion ya tipada es el caso
      // peligroso. Solo cuenta como cambio si NO es una pregunta
      // comparativa, O si pide explicitamente el otro producto.
      const comparativo = esGiroComparativo(texto);
      const pide = pideOtroProducto(texto);

      if (comparativo && !pide) {
        return {
          productoId: confirmado,
          origen: ORIGENES.CONTEXTO,
          confianza: "alta",
          esCambio: false,
          motivo: `menciona "${senal.senal}" pero es una pregunta sobre el producto actual, no un cambio`,
        };
      }

      return {
        productoId: senal.productoId,
        origen: ORIGENES.TEXTO_ACTUAL,
        confianza: senal.confianza,
        esCambio: true,
        motivo: `cambio de producto pedido explicitamente: "${senal.senal}"`,
      };
    }

    return {
      productoId: senal.productoId,
      origen: ORIGENES.TEXTO_ACTUAL,
      confianza: senal.confianza,
      esCambio: false,
      motivo: `señal "${senal.senal}" en el mensaje`,
    };
  }

  // ---- 2. Contexto confirmado ----
  if (confirmado && catalogo.porId.has(confirmado)) {
    return {
      productoId: confirmado,
      origen: ORIGENES.CONTEXTO,
      confianza: "alta",
      esCambio: false,
      motivo: "producto ya confirmado en esta conversacion",
    };
  }

  // ---- 3. Referral del anuncio ----
  const delAnuncio = productoDelReferral(referral, catalogo);
  if (delAnuncio) {
    return {
      productoId: delAnuncio.productoId,
      origen: ORIGENES.REFERRAL,
      confianza: delAnuncio.confianza,
      esCambio: false,
      motivo: `viene del anuncio (${delAnuncio.senal})`,
    };
  }

  // ---- 4. Ventana reciente ----
  for (const mensaje of [...(ventana || [])].reverse()) {
    const s = senalesEnTexto(mensaje && mensaje.texto ? mensaje.texto : mensaje, catalogo);
    if (s.length === 1) {
      return {
        productoId: s[0].productoId,
        origen: ORIGENES.VENTANA,
        confianza: "media",
        esCambio: false,
        motivo: `señal "${s[0].senal}" en un mensaje reciente`,
      };
    }
  }

  // ---- 5. Desconocido. NO hay producto por defecto. ----
  return {
    productoId: DESCONOCIDO,
    origen: null,
    confianza: "baja",
    motivo: "no hay ninguna señal de producto: hay que preguntar",
  };
}

module.exports = {
  DESCONOCIDO,
  ORIGENES,
  resolver,
  senalesEnTexto,
  productoDelReferral,
  esGiroComparativo,
  pideOtroProducto,
  GIROS_COMPARATIVOS,
  GIROS_DE_CAMBIO,
};
