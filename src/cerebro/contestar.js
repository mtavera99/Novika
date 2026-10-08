"use strict";

// ==========================================================================
// RESPONDER LA DUDA, CON DATOS DEL CATALOGO
//
// Este modulo convierte un tema -lo que pregunto el cliente- en una frase
// para el cliente. Todas las frases salen de aqui o del cotizador, nunca del
// modelo.
//
// POR QUE EXISTE: "LA CALIDEZ NO PUEDE DEPENDER DE QUE GEMINI RESPONDA"
//
// El camino determinista era el de respaldo, y se notaba: "Para continuar me
// falta la ciudad, la dirección de entrega." Correcto y frio. Y ese camino se
// usa MAS de lo que parece, porque se usa siempre que:
//
//   · no hay proveedor de IA configurado,
//   · la IA falla, tarda o devuelve vacio,
//   · el borrador del modelo menciona un importe no autorizado,
//   · el borrador toca un claim prohibido,
//   · el producto esta en borrador (ahi el modelo no redacta a proposito).
//
// O sea: el respaldo atiende clientes reales. Si es seco, la tienda suena
// seca. Mejorarlo no es cosmetica.
//
// DOS LIMITES QUE NO SE CRUZAN
//
// 1. NINGUN IMPORTE SE ESCRIBE AQUI. Las cifras llegan ya calculadas en la
//    cotizacion. No hay una sola constante monetaria en este archivo.
//
// 2. LO QUE NO ESTA APROBADO SE ADMITE, NO SE RELLENA. Si el catalogo no
//    tiene el dato, la respuesta dice que lo confirma una persona. Eso es
//    mejor que una frase amable con un dato inventado dentro.
// ==========================================================================

const { TEMAS } = require("../dominio/preguntas");

/** Formato de moneda colombiana. Solo para cifras ya calculadas. */
function pesos(n) {
  return `$${Number(n).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

/** Como nombrar el producto en una frase. */
function comoSeLlama(producto) {
  if (!producto) return "el producto";
  return producto.nombreCorto || producto.nombre || "el producto";
}

/**
 * Busca un dato entre las caracteristicas APROBADAS del producto.
 *
 * Devuelve la caracteristica tal y como la aprobo el dueño, sin reescribirla:
 * si el catalogo dice "viene unicamente en color rosado", eso es lo que se
 * dice. Reformularla seria editar un dato aprobado.
 */
function caracteristica(producto, re) {
  const lista = (producto && producto.caracteristicasAutorizadas) || [];
  return lista.find((c) => re.test(String(c).toLowerCase())) || null;
}

/** ¿El producto declara explicitamente que este tema NO esta confirmado? */
function declaradoSinConfirmar(producto, re) {
  const lista = (producto && producto.sinDatoConfirmado) || [];
  return lista.some((s) => re.test(String(s).toLowerCase()));
}

/**
 * Frase para "este dato todavia no lo tengo".
 *
 * Se escribe en primera persona y sin excusas raras. Y dice POR QUE no lo
 * dice -para no darte un dato equivocado-, que es la diferencia entre sonar
 * desinformado y sonar cuidadoso.
 */
function loConfirmo(que, pronombre = "lo") {
  // El pronombre va explicito porque el castellano concuerda: "la garantía te
  // LA confirmo", no "te lo confirmo". Sin esto salia "La garantía te lo
  // confirmo", que es exactamente el tipo de error que hace sonar a maquina.
  return `${que} te ${pronombre} confirmo con el equipo en un momento, no quiero darte un dato equivocado.`;
}

/**
 * Respuesta a un tema.
 *
 * @param {string} tema
 * @param {{producto: object|null, cotizacion: object|null}} contexto
 * @returns {string|null} la frase, o null si este tema no se responde aqui
 */
function deTema(tema, { producto = null, cotizacion = null } = {}) {
  const nombre = comoSeLlama(producto);

  switch (tema) {
    // ----------------------------------------------------------------------
    // PRECIO. La cifra SIEMPRE viene de la cotizacion.
    // ----------------------------------------------------------------------
    case TEMAS.PRECIO: {
      if (!cotizacion) return null;
      const varias = cotizacion.cantidad > 1;
      const sujeto = varias ? `${cotizacion.cantidad} unidades` : nombre;
      // Mayuscula: esta frase empieza el mensaje. Salia "el cinturón térmico
      // te queda en $49.900", en minuscula, que se lee como un fragmento.
      const frase = `${sujeto} te ${varias ? "quedan" : "queda"} en ${pesos(cotizacion.total)}.`;
      return frase.charAt(0).toUpperCase() + frase.slice(1);
    }

    // ----------------------------------------------------------------------
    // ENVIO. Sale de la politica del catalogo, nunca por costumbre.
    // ----------------------------------------------------------------------
    case TEMAS.ENVIO: {
      const c = cotizacion && cotizacion.condiciones;
      if (c && c.envioIncluido) return "El envío va incluido, no pagas nada aparte.";
      if (cotizacion && cotizacion.envio > 0) return `El envío a tu ciudad son ${pesos(cotizacion.envio)}.`;
      return loConfirmo("El envío", "lo");
    }

    // ----------------------------------------------------------------------
    // PAGO. La etiqueta la escribe el catalogo.
    // ----------------------------------------------------------------------
    case TEMAS.PAGO: {
      const c = cotizacion && cotizacion.condiciones;
      if (c && c.pagoMetodo === "contraentrega") {
        return "Pagas cuando lo recibes, en la puerta de tu casa.";
      }
      if (c && c.pagoEtiqueta) return c.pagoEtiqueta;
      // Preguntar por Nequi o transferencia cuando el metodo es contraentrega
      // es frecuente, y la respuesta honesta es que eso lo confirma alguien.
      return loConfirmo("La forma de pago", "la");
    }

    case TEMAS.COLOR: {
      const dato = caracteristica(producto, /color|rosad|negr|blanc|azul/);
      if (dato) return `${dato.charAt(0).toUpperCase()}${dato.slice(1)}.`;
      return loConfirmo("Los colores disponibles", "los");
    }

    case TEMAS.TALLA: {
      const dato = caracteristica(producto, /talla/);
      if (dato) return `${dato.charAt(0).toUpperCase()}${dato.slice(1)}.`;
      return loConfirmo("Las tallas", "las");
    }

    // ----------------------------------------------------------------------
    // MEDIDAS Y AJUSTE: EL TEMA SENSIBLE DE ESTE PRODUCTO
    //
    // Marco fue explicito: no hay medidas del ajuste y no se promete que
    // sirva para cualquier contorno. Y la pregunta llega siempre, porque "me
    // sirve a mi?" es lo primero que pregunta quien compra algo que se pone.
    //
    // La tentacion es contestar con el dato aprobado -"es talla unica con
    // correa ajustable"- y dejar que la clienta concluya que le sirve. Eso es
    // la promesa prohibida dicha a medias. Se dice el dato Y se dice que el
    // contorno exacto no lo tenemos.
    // ----------------------------------------------------------------------
    case TEMAS.MEDIDAS: {
      const talla = caracteristica(producto, /talla/);
      const partes = [];
      if (talla) partes.push(`${talla.charAt(0).toUpperCase()}${talla.slice(1)}.`);
      partes.push(
        "No tengo las medidas exactas del ajuste, así que no te quiero decir que sí sin estar segura: te lo confirmo con el equipo y te escribo."
      );
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // GARANTIA. El plazo esta confirmado; lo que CUBRE, no.
    //
    // Se dice el plazo y se para ahi. La tentacion es completar con "te lo
    // cambiamos si sale defectuoso", que suena razonable y nadie aprobo: el
    // alcance de la garantia y como se tramita siguen sin definir, y una
    // promesa de cambio es la que acaba en una discusion.
    // ----------------------------------------------------------------------
    case TEMAS.GARANTIA: {
      const plazo = producto && producto.garantia;
      if (!plazo) return loConfirmo("La garantía", "la");
      return `Tiene garantía de ${plazo}.`;
    }

    // ----------------------------------------------------------------------
    // EL TRAMITE DE LA GARANTIA: SE DICE EL PLAZO Y SE ADMITE EL RESTO
    //
    // Marco confirmo el plazo, no el procedimiento. Contestar "1 mes" a
    // "¿cómo la hago efectiva?" responde otra pregunta, y completarlo con
    // "te lo cambiamos" es la promesa que nadie aprobo y la que acaba en
    // una discusion cuando el cliente la invoca.
    // ----------------------------------------------------------------------
    case TEMAS.GARANTIA_TRAMITE: {
      const plazo = producto && producto.garantia;
      const partes = [];
      if (plazo) partes.push(`Tiene garantía de ${plazo}.`);
      partes.push("Cómo se tramita te lo explica una persona del equipo, para no darte un dato equivocado.");
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // CUANDO LLEGA. UN RANGO, NUNCA UN DIA.
    //
    // El dato es de la transportadora y es aproximado. El matiz "según la
    // ciudad" NO es un adorno: sin el, el rango se lee como un compromiso,
    // y en un pueblo apartado no se cumple.
    //
    // Y se escribe aqui, en codigo, y no se deja al modelo: la frase
    // siguiente natural -"te llega mañana"- es la que el modelo completa
    // solo, depende de la hora de corte de la transportadora y no la
    // controla nadie de NOVIKA. Esas promesas estan en claimsProhibidos.
    // ----------------------------------------------------------------------
    case TEMAS.ENTREGA: {
      const t = (producto && producto.logistica && producto.logistica.tiempoDeEntrega) || null;
      if (!t || !t.texto) return loConfirmo("El tiempo de entrega", "lo");
      const matiz = t.matiz ? ` ${t.matiz}` : "";
      return `La transportadora normalmente entrega en ${t.texto}${matiz}.`;
    }

    case TEMAS.MATERIAL: {
      const dato = caracteristica(producto, /material|tela|cuero/);
      if (dato) return `${dato.charAt(0).toUpperCase()}${dato.slice(1)}.`;
      return loConfirmo("El material", "lo");
    }

    case TEMAS.USO: {
      // Lo que se puede decir es la descripcion aprobada, tal cual.
      if (producto && producto.descripcionAutorizada) return String(producto.descripcionAutorizada);
      return loConfirmo("Eso", "lo");
    }

    // ----------------------------------------------------------------------
    // DESCONFIANZA. Se responde con un hecho verificable, no con adjetivos.
    //
    // "Somos serios, confía en nosotros" no convence a nadie. Que pagues
    // cuando lo recibas si: es el argumento que quita el riesgo, y sale del
    // catalogo, no de una promesa.
    // ----------------------------------------------------------------------
    case TEMAS.CONFIANZA: {
      const c = cotizacion && cotizacion.condiciones;
      if (c && c.pagoMetodo === "contraentrega") {
        return "Te entiendo. Pagas cuando el pedido llega a tus manos, así que no tienes que adelantar nada.";
      }
      return "Te entiendo. Somos NOVIKA, una tienda colombiana, y cualquier duda te la resuelve una persona del equipo.";
    }

    case TEMAS.FOTOS:
      // Solo se prometen si existen: el cerebro decide si las manda y pasa
      // `producto`. Un bot que anuncia fotos y no manda ninguna deja al
      // cliente esperando algo que no llega.
      if (producto && (producto.imagenes || []).length) return "Te muestro las fotos.";
      return null;

    default:
      return null;
  }
}

/**
 * Responde a TODOS los temas del mensaje, en el orden en que se preguntaron.
 *
 * Se limita a dos temas. Una clienta que pregunta tres cosas y recibe tres
 * parrafos deja de leer: es el muro de texto que BIKERPRO aprendio a evitar.
 * Los temas que no entran se responden en el turno siguiente, cuando los
 * vuelva a preguntar, o los cubre la respuesta de la IA.
 *
 * @returns {{texto: string, temas: string[]}}
 */
function aTemas(temas, contexto, { maximo = 2 } = {}) {
  const frases = [];
  const respondidos = [];

  // MEDIDAS ya dice la talla y ademas aclara que el contorno no se sabe. Si
  // los dos temas vienen juntos -"¿me sirve? uso talla XL" marca los dos- la
  // respuesta salia con la frase de la talla repetida dos veces.
  let lista = [...(temas || [])];
  if (lista.includes(TEMAS.MEDIDAS)) lista = lista.filter((t) => t !== TEMAS.TALLA);
  // El tramite ya dice el plazo: si vienen los dos, el plazo solo sobra.
  if (lista.includes(TEMAS.GARANTIA_TRAMITE)) lista = lista.filter((t) => t !== TEMAS.GARANTIA);

  for (const tema of lista) {
    if (respondidos.length >= maximo) break;
    const frase = deTema(tema, contexto);
    if (!frase) continue;
    // Sin repetir la misma frase dos veces: "¿cuánto vale con envío?" marca
    // PRECIO y ENVIO, y las dos respuestas pueden coincidir en el texto.
    if (frases.includes(frase)) continue;
    frases.push(frase);
    respondidos.push(tema);
  }

  return { texto: frases.join(" "), temas: respondidos };
}

module.exports = { deTema, aTemas, pesos, comoSeLlama, loConfirmo };
