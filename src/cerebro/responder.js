"use strict";

// ==========================================================================
// PREPARACION DE LA RESPUESTA
//
// Modulo casi puro: recibe hechos ya calculados y produce texto.
//
// Dos cosas pasan aqui, y el orden es el que importa:
//
//   1. SE CONSTRUYE UN TEXTO DETERMINISTA con los datos autorizados. Este
//      texto no depende del modelo y siempre existe. Es el que se usa si
//      algo falla.
//
//   2. SI LA IA PROPUSO UN BORRADOR, SE REVISA. Tiene que pasar dos filtros:
//
//        - importes: ninguna cifra de dinero que el cotizador no calculo;
//        - claims: ninguna frase de la lista de prohibidos del producto.
//
//      Si falla cualquiera, SE DESCARTA EL BORRADOR COMPLETO y se usa el
//      determinista. No se corrige, no se recorta: un texto que intenta
//      afirmar algo prohibido es un texto en el que no se puede confiar, y
//      arreglar la frase mala deja las demas sin revisar.
//
// Por que el filtro de claims importa tanto en NOVIKA: el primer producto es
// para dolor menstrual. Ahi el riesgo no es exagerar un precio, es hacer una
// promesa medica. "Cura los colicos" no es una venta agresiva: es una
// devolucion y, potencialmente, un problema regulatorio.
// ==========================================================================

const { revisarImportes } = require("../dominio/cotizador");
const { aplanar } = require("../dominio/texto");

const BLOQUEOS = {
  IMPORTE_NO_AUTORIZADO: "importe_no_autorizado",
  CLAIM_PROHIBIDO: "claim_prohibido",
  SIN_BORRADOR: "sin_borrador",
  /** El producto se reconoce pero no tiene ficha: el modelo no redacta. */
  PRODUCTO_SIN_FICHA: "producto_sin_ficha",
};

/**
 * ¿El texto afirma algo de la lista de prohibidos del producto?
 *
 * Se compara sobre el texto aplanado (sin tildes, minusculas) para que
 * "cura los cólicos" y "CURA LOS COLICOS" cuenten igual.
 */
function revisarClaims(texto, producto) {
  const prohibidos = [
    ...((producto && producto.claimsProhibidos) || []),
    ...((producto && producto.sinDatoConfirmado) || []),
  ];
  if (!prohibidos.length) return { ok: true, encontrados: [] };

  const plano = aplanar(texto);
  const encontrados = prohibidos.filter((claim) => {
    const clave = aplanar(claim);
    if (!clave) return false;
    // Para frases largas se busca la frase; para terminos de una palabra, la
    // palabra con limites, para no marcar "embarazo" dentro de otra palabra.
    if (clave.includes(" ")) return plano.includes(clave);
    return new RegExp(`\\b${clave}\\b`).test(plano);
  });

  return { ok: encontrados.length === 0, encontrados };
}

/** Formato de moneda colombiana. Solo para cifras ya calculadas. */
function pesos(n) {
  return `$${Number(n).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

/**
 * Lineas de condiciones -envio y cobro- que acompañan a un total.
 *
 * Salen de `cotizacion.condiciones`, que el cotizador copia del catalogo. Si
 * el producto no declara una condicion, NO se escribe nada: no hay texto por
 * defecto. Dos motivos concretos:
 *
 *   - "Envío incluido" dicho por costumbre, sobre un producto cuya politica
 *     es "fijo", es un flete que el cliente no espera pagar y una discusion
 *     en la puerta.
 *   - En contraentrega, si el mensaje NO dice que paga al recibir, el
 *     cliente puede entender que ya debe transferir. Decirlo es parte del
 *     cierre, no un adorno.
 *
 * Ninguna etiqueta puede traer cifras -el esquema lo impide-, asi que estas
 * lineas nunca activan el filtro de importes no autorizados.
 */
function lineasDeCondiciones(cotizacion) {
  const c = (cotizacion && cotizacion.condiciones) || null;
  if (!c) return [];

  const partes = [];
  // Solo cuando el envio va realmente incluido. Con envio > 0 ya se desglosa
  // arriba como una linea de importe, y repetirlo seria confuso.
  if (c.envioIncluido && !cotizacion.envio) partes.push("Envío incluido");
  if (c.pagoEtiqueta) partes.push(c.pagoEtiqueta);

  return partes.length ? [partes.join(" · ")] : [];
}

/**
 * Texto determinista segun la situacion.
 *
 * NO contiene ni un dato comercial escrito a mano: todo sale de la
 * cotizacion o del catalogo. Si manana cambia un precio, aqui no se toca
 * nada.
 */
function textoDeterminista({ situacion, cotizacion = null, cotizacionInformativa = null, faltan = [], opciones = [], pedido = null, producto = null }) {
  switch (situacion) {
    case "producto_desconocido":
      return "Para ayudarte bien, ¿me confirmas cuál producto te interesa?";

    // ----------------------------------------------------------------------
    // PRODUCTO EN BORRADOR: se sabe cual es, pero no tiene ficha.
    //
    // Este texto es DETERMINISTA y no pasa por el modelo a proposito. El
    // cliente acaba de preguntar un precio; es justo el momento en el que un
    // modelo rellena el hueco con una cifra plausible. Aqui no hay hueco que
    // rellenar: no se nombra ningun importe, ningun plazo y ninguna
    // caracteristica, porque ninguno esta aprobado.
    //
    // Y NO vuelve a preguntar que producto es. Preguntar lo que el cliente ya
    // respondio es la forma mas rapida de que deje de escribir.
    //
    // Dice que una persona confirma, porque es verdad: mientras el producto
    // este en borrador, cerrar la venta lo hace alguien a mano desde el
    // panel.
    // ----------------------------------------------------------------------
    case "producto_en_borrador": {
      const comoSeLlama = (producto && (producto.nombre || producto.nombreCorto)) || null;
      const lo = comoSeLlama ? `el ${comoSeLlama}` : "ese producto";
      // Solo se prometen las fotos si existen. Un bot que dice "te muestro
      // las fotos" y no manda ninguna queda peor que uno que no las
      // menciona: el cliente se queda esperando algo que no va a llegar.
      const hayFotos = Boolean(producto && (producto.imagenes || []).length);
      return [
        `Sí, ${lo} lo tenemos.`,
        hayFotos ? "Te muestro las fotos." : "",
        "El precio y el envío te los confirma una persona del equipo en un momento:",
        "todavía no los tengo publicados y no quiero darte un dato equivocado.",
      ]
        .filter(Boolean)
        .join(" ");
    }

    case "producto_ambiguo":
      return opciones.length
        ? `¿Cuál de estos te interesa: ${opciones.join(" o ")}?`
        : "¿Me confirmas cuál producto te interesa?";

    case "cotizacion": {
      if (!cotizacion) return "Dame un momento y te confirmo.";
      const lineas = [`${cotizacion.productoNombre} · ${cotizacion.cantidad} unidad(es)`];
      if (cotizacion.envio > 0) {
        lineas.push(`Producto: ${pesos(cotizacion.subtotal)}`);
        lineas.push(`Envío: ${pesos(cotizacion.envio)}`);
      }
      if (cotizacion.descuento > 0) lineas.push(`Descuento: -${pesos(cotizacion.descuento)}`);
      lineas.push(`Total: ${pesos(cotizacion.total)}`);
      lineas.push(...lineasDeCondiciones(cotizacion));
      return lineas.join("\n");
    }

    case "faltan_datos": {
      const nombres = {
        nombre: "tu nombre completo",
        telefono: "un número de contacto",
        ciudad: "la ciudad",
        departamento: "el departamento",
        direccion: "la dirección de entrega",
        referencia: "un punto de referencia",
        cantidad: "cuántas unidades quieres",
      };
      const pide = faltan.map((f) => nombres[f] || f);
      const peticion = pide.length ? `Para continuar me falta ${pide.join(", ")}.` : "¿Me confirmas los datos de envío?";

      // ----------------------------------------------------------------------
      // EL PRECIO VA ANTES DE PEDIR LA DIRECCION
      //
      // Sin esto, a "¿cuánto cuesta?" el bot contestaba "me falta la ciudad y
      // la dirección": pedirle los datos a alguien que todavia no sabe el
      // precio. Es la forma mas rapida de perder la venta, y pasaba aunque el
      // precio estuviera en el catalogo, solo porque faltaba la cantidad.
      //
      // La cifra la calcula el cotizador para UNA unidad; aqui no se
      // multiplica nada. Y es informativa a proposito: no crea oferta ni
      // marca resumen mostrado, asi que un "si" a este mensaje no confirma
      // ningun pedido.
      // ----------------------------------------------------------------------
      if (cotizacionInformativa) {
        const condiciones = lineasDeCondiciones(cotizacionInformativa);
        const precio = `Una unidad cuesta ${pesos(cotizacionInformativa.total)}${
          condiciones.length ? `, con ${condiciones[0].toLowerCase().replace(" · ", " y ")}` : ""
        }.`;
        return `${precio}\n${peticion}`;
      }

      return peticion;
    }

    case "resumen": {
      if (!cotizacion) return "Dame un momento y te confirmo.";
      return [
        "Confirmemos tu pedido:",
        `${cotizacion.productoNombre} · ${cotizacion.cantidad} unidad(es)`,
        `Total: ${pesos(cotizacion.total)}`,
        ...lineasDeCondiciones(cotizacion),
        "",
        "¿Confirmas?",
      ].join("\n");
    }

    case "confirmado":
      return pedido
        ? `Listo, tu pedido quedó registrado con el número ${pedido.id}.`
        : "Listo, tu pedido quedó registrado.";

    case "ya_confirmado":
      // La respuesta al "si"/"gracias" sobre un pedido ya confirmado. No
      // cotiza, no confirma, no cambia nada.
      return pedido
        ? `Tu pedido ${pedido.id} ya está confirmado. Si necesitas cambiar algo, dime qué.`
        : "Tu pedido ya está confirmado.";

    case "cancelado":
      return "Listo, lo cancelamos. Si cambias de opinión, escríbeme.";

    case "escalado":
      return "Dame un momento, te confirmo en seguida.";

    case "sin_respuesta_automatica":
    default:
      return "Dame un momento, te confirmo en seguida.";
  }
}

/**
 * Prepara la respuesta final.
 *
 * @returns {{texto: string, origen: "determinista"|"ia", bloqueos: object[]}}
 */
function preparar({
  situacion,
  cotizacion = null,
  cotizacionInformativa = null,
  faltan = [],
  opciones = [],
  pedido = null,
  producto = null,
  borradorIA = null,
}) {
  const determinista = textoDeterminista({ situacion, cotizacion, cotizacionInformativa, faltan, opciones, pedido, producto });
  const bloqueos = [];

  // --------------------------------------------------------------------------
  // CON EL PRODUCTO EN BORRADOR, EL MODELO NO REDACTA.
  //
  // El cliente acaba de preguntar un precio que no existe. Es el momento
  // exacto en el que un modelo rellena el hueco con una cifra plausible, y
  // una cifra plausible es un cobro equivocado.
  //
  // El filtro de importes ya lo frenaria -sin cotizacion no hay importes
  // autorizados, asi que cualquier cifra se bloquea-, pero depender de eso
  // seria confiar en que el modelo se equivoque de una forma concreta.
  // Aqui no se le pide nada: el texto es el nuestro.
  // --------------------------------------------------------------------------
  if (situacion === "producto_en_borrador") {
    return { texto: determinista, origen: "determinista", bloqueos: [{ tipo: BLOQUEOS.PRODUCTO_SIN_FICHA }] };
  }

  if (!borradorIA || !String(borradorIA).trim()) {
    return { texto: determinista, origen: "determinista", bloqueos: [{ tipo: BLOQUEOS.SIN_BORRADOR }] };
  }

  // Los importes de la informativa tambien cuentan: si no, un borrador que
  // repite el precio correcto se bloquearia por decir la verdad.
  const autorizados = [
    ...((cotizacion && cotizacion.importesAutorizados) || []),
    ...((cotizacionInformativa && cotizacionInformativa.importesAutorizados) || []),
  ];
  const importes = revisarImportes(borradorIA, autorizados);
  if (!importes.ok) {
    bloqueos.push({
      tipo: BLOQUEOS.IMPORTE_NO_AUTORIZADO,
      detalle: importes.sospechosos.map((s) => s.valor),
    });
  }

  const claims = revisarClaims(borradorIA, producto);
  if (!claims.ok) {
    bloqueos.push({ tipo: BLOQUEOS.CLAIM_PROHIBIDO, detalle: claims.encontrados });
  }

  if (bloqueos.length) {
    // Borrador descartado completo. El cliente recibe el texto determinista,
    // que es correcto aunque sea mas seco.
    return { texto: determinista, origen: "determinista", bloqueos };
  }

  return { texto: borradorIA, origen: "ia", bloqueos: [] };
}

module.exports = { preparar, textoDeterminista, revisarClaims, BLOQUEOS, pesos };
