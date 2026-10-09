"use strict";

// ==========================================================================
// LA VENTANA DE 24 HORAS DE META
//
// Meta solo entrega TEXTO LIBRE durante las 24 horas siguientes al ultimo
// mensaje DEL CLIENTE. Pasado ese plazo, lo unico que entrega son plantillas
// aprobadas.
//
// --------------------------------------------------------------------------
// POR QUE ESTA REGLA VIVE EN UN MODULO Y NO EN CADA SITIO QUE ENVIA
// --------------------------------------------------------------------------
//
// Porque hacen la misma pregunta tres sitios distintos, y cada uno la
// responderia un poco diferente:
//
//   · el panel, para decirle al operador si puede escribir libre
//   · las guias, que se mandan al dia siguiente de la compra
//   · las novedades de entrega, que llegan uno a tres dias despues
//
// Los dos ultimos caen SIEMPRE fuera de la ventana. No es el caso raro: es
// el caso normal, y es la razon de que las plantillas no sean opcionales.
//
// Tres copias de esta regla se separan. Ya paso en este proyecto con las dos
// listas de "pregunta de precio" y con el filtro de pedido activo duplicado
// en cada backend; la convencion que salio de ahi es que una regla que
// necesitan dos sitios vive en uno solo.
//
// --------------------------------------------------------------------------
// EL ERROR QUE DEVUELVE META, TRADUCIDO
// --------------------------------------------------------------------------
//
// Si se intenta texto libre fuera de la ventana, Meta responde 131047
// ("re-engagement message") o 470. No es un fallo del sistema ni del token:
// es esta regla. Se traduce aqui para que el panel no muestre un numero.
// ==========================================================================

const VENTANA_MS = 24 * 60 * 60 * 1000;

/**
 * Codigos con los que Meta dice "estas fuera de la ventana".
 *
 * Importa distinguirlos de un fallo de verdad: ante estos no hay que
 * reintentar ni revisar el token, hay que mandar una plantilla.
 */
const CODIGOS_FUERA_DE_VENTANA = new Set([131047, 470]);

/** ¿Este codigo de Meta significa "fuera de la ventana de 24 h"? */
function esFueraDeVentana(codigo) {
  return CODIGOS_FUERA_DE_VENTANA.has(Number(codigo));
}

/** Lo que significa un codigo de Meta, en palabras que permiten actuar. */
function explicarCodigo(codigo) {
  const n = Number(codigo);
  if (esFueraDeVentana(n)) {
    return (
      "pasaron mas de 24 h desde el ultimo mensaje del cliente. Fuera de esa ventana Meta solo " +
      "entrega plantillas aprobadas: no es un fallo del envio."
    );
  }
  if (n === 132001) {
    return (
      "Meta no encuentra esa plantilla EN ESE IDIOMA. Suele ser el codigo de idioma: una " +
      "plantilla subida en Spanish (COL) se envia con es_CO, no con es."
    );
  }
  if (n === 131026) {
    return "Meta no puede entregar el mensaje a ese destinatario.";
  }
  if (n === 131053) {
    return "Meta no pudo descargar el archivo adjunto.";
  }
  return null;
}

/**
 * Formatea una duracion en algo que se lee de un vistazo.
 *
 * "quedan 64.800.000 ms" no sirve en una pantalla que se mira con el celular
 * en la mano y un cliente esperando.
 */
function enPalabras(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const resto = m % 60;
  return resto ? `${h} h ${resto} min` : `${h} h`;
}

/**
 * ¿Se le puede escribir texto libre a este cliente ahora?
 *
 * --------------------------------------------------------------------------
 * CUENTA EL ULTIMO MENSAJE DEL CLIENTE, NO EL ULTIMO MENSAJE
 * --------------------------------------------------------------------------
 *
 * La ventana la abre el CLIENTE al escribir. Que el bot haya contestado hace
 * cinco minutos no la reabre: si se contara el ultimo mensaje de cualquiera,
 * el sistema creeria tener la ventana abierta para siempre -porque cada
 * respuesta la renovaria- y los envios fallarian con 131047 sin explicacion.
 *
 * SIN DATO SE ASUME CERRADA. Es la asimetria correcta: dar la ventana por
 * abierta sin saberlo hace que el mensaje se intente, Meta lo rechace y el
 * operador crea que aviso al cliente. Darla por cerrada manda una plantilla,
 * que llega igual. Equivocarse hacia el lado cerrado cuesta una plantilla;
 * hacia el abierto cuesta un cliente sin avisar.
 *
 * @param {object|null} conversacion
 * @param {{ahora?: number, ultimoDelCliente?: string}} [opciones]
 * @returns {{abierta:boolean, restanteMs:number, restante:string,
 *            desde:string|null, motivo:string}}
 */
function estado(conversacion, { ahora = Date.now(), ultimoDelCliente = null } = {}) {
  let marca = ultimoDelCliente;

  if (!marca && conversacion) {
    const lista = Array.isArray(conversacion.mensajes) ? conversacion.mensajes : [];
    for (let i = lista.length - 1; i >= 0; i--) {
      const m = lista[i];
      if (m && m.de === "cliente" && m.ts) {
        marca = m.ts;
        break;
      }
    }
  }

  const t = marca ? Date.parse(marca) : NaN;
  if (!Number.isFinite(t)) {
    return {
      abierta: false,
      restanteMs: 0,
      restante: "",
      desde: null,
      motivo:
        "no hay registro de un mensaje del cliente, asi que no se puede dar la ventana por " +
        "abierta. Hace falta una plantilla aprobada.",
    };
  }

  const restanteMs = t + VENTANA_MS - ahora;
  if (restanteMs <= 0) {
    return {
      abierta: false,
      restanteMs: 0,
      restante: "",
      desde: new Date(t).toISOString(),
      motivo:
        `el cliente escribio hace ${enPalabras(ahora - t)}, mas de 24 h. Meta solo entrega ` +
        "plantillas aprobadas fuera de esa ventana.",
    };
  }

  return {
    abierta: true,
    restanteMs,
    restante: enPalabras(restanteMs),
    desde: new Date(t).toISOString(),
    motivo: `se le puede escribir libre: quedan ${enPalabras(restanteMs)} de la ventana de 24 h.`,
  };
}

module.exports = {
  VENTANA_MS,
  CODIGOS_FUERA_DE_VENTANA,
  esFueraDeVentana,
  explicarCodigo,
  enPalabras,
  estado,
};
