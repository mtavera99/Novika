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
 * Texto determinista segun la situacion.
 *
 * NO contiene ni un dato comercial escrito a mano: todo sale de la
 * cotizacion o del catalogo. Si manana cambia un precio, aqui no se toca
 * nada.
 */
function textoDeterminista({ situacion, cotizacion = null, faltan = [], opciones = [], pedido = null }) {
  switch (situacion) {
    case "producto_desconocido":
      return "Para ayudarte bien, ¿me confirmas cuál producto te interesa?";

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
      if (!pide.length) return "¿Me confirmas los datos de envío?";
      return `Para continuar me falta ${pide.join(", ")}.`;
    }

    case "resumen": {
      if (!cotizacion) return "Dame un momento y te confirmo.";
      return [
        "Confirmemos tu pedido:",
        `${cotizacion.productoNombre} · ${cotizacion.cantidad} unidad(es)`,
        `Total: ${pesos(cotizacion.total)}`,
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
function preparar({ situacion, cotizacion = null, faltan = [], opciones = [], pedido = null, producto = null, borradorIA = null }) {
  const determinista = textoDeterminista({ situacion, cotizacion, faltan, opciones, pedido });
  const bloqueos = [];

  if (!borradorIA || !String(borradorIA).trim()) {
    return { texto: determinista, origen: "determinista", bloqueos: [{ tipo: BLOQUEOS.SIN_BORRADOR }] };
  }

  const autorizados = cotizacion ? cotizacion.importesAutorizados : [];
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
