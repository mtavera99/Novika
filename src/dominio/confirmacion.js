"use strict";

// ==========================================================================
// CONFIRMACION: EL CANDADO MAS IMPORTANTE DEL SISTEMA
//
// Modulo puro. Sin I/O, sin IA.
//
// Esto NO se le pregunta al modelo. En BIKERPRO el guion le decia a la IA
// que emitiera el bloque de pedido "al confirmar", y un cliente que escribio
// literalmente "No confirmo" acabo con el pedido guardado. La conclusion
// quedo escrita en cinco archivos de ese repositorio: una instruccion al
// modelo no es un candado.
//
// Cuatro reglas que vienen de incidentes reales, no de teoria:
//
//   1. LA NEGACION SE EVALUA ANTES QUE LA AFIRMACION.
//      "no confirmo" contiene "confirmo". Si se busca la afirmacion primero,
//      gana la palabra equivocada.
//
//   2. LA PREGUNTA DE ESTADO SE EVALUA ANTES QUE EL "SI" SUELTO.
//      "si mandaron el pedido gracias" es una pregunta, y empieza por "si".
//      En BIKERPRO esa frase genero un segundo pedido por el mismo importe.
//
//   3. UN "SI" SOLO CUENTA SI HAY ALGO QUE CONFIRMAR.
//      Fuera del estado PENDIENTE_CONFIRMACION, un "si" no confirma nada:
//      no hay resumen al que responder. El estado manda, no la palabra.
//
//   4. ANTE LA DUDA, NO SE TIRA LA VENTA.
//      Una respuesta que no se entiende puede ser un "hagale" que no
//      reconocemos. Se guarda marcada y la revisa una persona. Perder una
//      venta real es peor que revisar una a mano.
// ==========================================================================

const { vistas } = require("./texto");

/**
 * CANCELAR UN PEDIDO YA CONFIRMADO: lo que SI lo dice sin lugar a dudas.
 *
 * Mas estricta que `NEGACIONES` a proposito. Un "no" suelto, un "no
 * entiendo" o un "no me ha llegado" NO pueden borrar una venta cerrada: hay
 * logistica y plata comprometidas, y quien despacha ya cuenta con ese
 * paquete. El motivo completo esta en `evaluar()`.
 */
const CANCELACION_INEQUIVOCA = [
  /\bcancel(a|ar|alo|ame|emos|en)\b/,
  /\banul(a|ar|alo|ame|emos|en)\b/,
  /\bya\s+no\s+(lo|la|los|las)\s+(quiero|necesito|voy\s+a\s+recibir)\b/,
  /\bno\s+(lo|la|los|las)\s+quiero\s+(ya|mas)\b/,
  /\bno\s+me\s+(lo|la)\s+man(de|den|des)\b/,
  /\bdevuelv(an|anlo|elo)\b/,
  /\bno\s+lo\s+voy\s+a\s+recibir\b/,
  /\bmejor\s+(ya\s+)?no\s+(lo|la)\s+(quiero|mande|manden)\b/,
];

/** Clases de respuesta del cliente. */
const CLASES = {
  SI: "si",
  NO: "no",
  PREGUNTA_ESTADO: "pregunta_estado",
  CORRECCION: "correccion",
  ACUSE: "acuse", // "gracias", "ok" sin valor transaccional
  AMBIGUO: "ambiguo",
};

// --- 1. Negaciones. Se revisan primero. ---
//
// ⚠️ AQUI ESTUVO EL DEFECTO MAS CARO QUE HA TENIDO ESTE BOT. NO SE AMPLIA
//    ESTA LISTA CON UN PATRON QUE EMPIECE POR "no" Y SIGA CON CUALQUIER COSA.
//
// Habia un `/^no\b/` suelto. Parecia inofensivo -"no" es una negacion- pero
// `\b` solo marca el final de la palabra: casaba con CUALQUIER mensaje que
// empezara por "no". Y en un WhatsApp colombiano, empezar por "no" es lo
// normal:
//
//   "No habría manera de que llegue hoy?"   -> una clienta con prisa
//   "No entiendo"                           -> alguien perdido
//   "No cargaron"                           -> las fotos no le llegaron
//   "no me alcanza"                          -> la objecion mas comun
//   "no confío en estas páginas"             -> la objecion de confianza
//   "no me ha llegado"                       -> posventa
//
// Los seis se clasificaban como NO -> accion CANCELAR. Y como ninguno tenia
// un pedido que cancelar, `cancelarPedido` devolvia `cancelado:false`, el
// turno acababa en `situacion = "escalado"` y el bot SE PAUSABA 12 HORAS.
//
// Medido en el panel de produccion el 2026-10-08: de 33 chats, 0 pedidos.
// Tres de las conversaciones perdidas murieron exactamente asi, y una la
// tuvo que rescatar una persona a mano hora y media despues.
//
// La regla: "no" a secas es una negacion. "no" seguido de algo es una frase,
// y hay que leer el algo. Lo que de verdad niega esta enumerado abajo.
const NEGACIONES = [
  // "no" PELADO, con o sin signos. Esto es lo unico que `^no\b` deberia
  // haber sido.
  /^no[\s!.,¡¿?]*$/,
  // Cortesia al declinar: "no gracias", "no, muchas gracias".
  /^no\s+(muchas\s+)?gracias\b/,
  /\bno\s+(muchas\s+)?gracias\b/,
  // Negaciones de intencion: dicen QUE no quieren.
  /\bno\s+(confirm|quier|lo\s+quier|la\s+quier|los\s+quier|las\s+quier|me\s+interes|me\s+sirve|deseo)/,
  /\bno\s+(por\s+ahora|todavia|aun)\b/,
  /\bno\s+lo\s+voy/,
  /\bno\s+me\s+(lo|la|los|las)\s+(llevo|voy)/,
  /\bya\s+no\b/,
  /\bmejor\s+no\b/,
  /\bcancel(a|ar|alo|ame|emos|en)\b/,
  // "anulen el pedido" es una cancelacion y no estaba: se quedaba en
  // AMBIGUO, asi que sobre un pedido confirmado no hacia nada. El cliente
  // pedia anular y nadie se enteraba.
  /\banul(a|ar|alo|ame|emos|en)\b/,
  /\bdejalo\b/,
  /\bnegativo\b/,
  /\bdesisto\b/,
];

// --- 2. Preguntas de estado (posventa). Antes del "si" suelto. ---
const PREGUNTAS_ESTADO = [
  // `llegado` y `llegara` faltaban, y "no me ha llegado" es LA pregunta de
  // posventa. Sin ellas caia en AMBIGUO.
  /\b(ya\s+)?(lo\s+|la\s+|me\s+lo\s+|me\s+la\s+)?(mandaron|enviaron|despacharon|salio|sale|llega|llego|llegado|llegara|viene)\b/,
  /\bno\s+me\s+ha\s+lleg(ado|ada)\b/,
  /\bcuando\s+(me\s+)?(llega|lo\s+recibo|la\s+recibo|lo\s+mandan|sale)/,
  /\bdonde\s+(va|esta|viene)\b/,
  /\b(numero\s+de\s+)?(guia|rastreo|seguimiento)\b/,
  /\bmi\s+pedido\b.*\?/,
  /\bque\s+paso\s+con\b/,
  /\bsigue\s+en\s+camino\b/,
];

// --- 3. Afirmaciones inequivocas: dicen QUE se afirma. ---
const AFIRMACIONES_FUERTES = [
  /\b(si|claro|listo|dale|ok)[\s,]*(confirm)/,
  /\bconfirm(o|ado|amos|alo|emos)\b/,
  /\b(lo|la)\s+(quiero|compro|llevo|tomo)\b/,
  /\bquiero\s+(comprar|pedir|el|la|uno|dos)/,
  /\bhagale\b/,
  /\bhag(amos|ale)\s+/,
  /\bde\s+una\b/,
  /\bperfecto[\s,]*(confirm|lo\s+quiero)/,
  /\bestoy\s+de\s+acuerdo\b/,
  /\bacepto\b/,
  /\bproced(a|amos|e)\b/,
];

// --- 4. Correcciones: cambian un dato, no confirman. ---
const CORRECCIONES = [
  /\bmejor\s+(uno|dos|tres|el|la|otro|otra|cambi)/,
  /\bme\s+equivoqu/,
  /\bcorrig(e|eme|elo)\b/,
  /\bcambi(a|ar|alo|ame|emos|o)\b/,
  /\ben\s+vez\s+de\b/,
  /\bno\s+es\s+(ese|esa|asi)\b/,
  /\bera\s+(otro|otra|a)\b/,
  /\bactualiz(a|ame|ar)\b/,
];

// --- 5. Acuses sin valor transaccional. ---
const ACUSES = [
  /^(muchas\s+)?gracias\b/,
  /^(ok|oki|okey|vale|bueno|bien|listo|perfecto|excelente|genial|chevere|de\s+una)[\s!.]*$/,
  /^(si|sii+|sip)[\s!.]*$/, // "si" a secas: solo cuenta si hay algo que confirmar
  /^(dios\s+le\s+bendiga|bendiciones|feliz\s+dia)\b/,
  /^(👍|🙏|✅|😊|❤️)+$/u,
];

/** ¿Coincide alguno de los patrones? */
function coincide(plano, patrones) {
  return patrones.some((re) => re.test(plano));
}

/**
 * Clasifica un mensaje del cliente, sin mirar el estado.
 *
 * EL ORDEN DE LOS BLOQUES ES LA LOGICA. No se reordenan sin romper los
 * incidentes que cada uno cubre.
 *
 * @returns {{clase: string, confianza: "alta"|"media"|"baja", motivo: string}}
 */
function clasificar(texto) {
  const v = vistas(texto);
  if (v.vacio) return { clase: CLASES.AMBIGUO, confianza: "alta", motivo: "mensaje vacio" };

  const t = v.plano;

  // 1. Negacion primero: "no confirmo" contiene "confirmo".
  if (coincide(t, NEGACIONES)) {
    return { clase: CLASES.NO, confianza: "alta", motivo: "negacion explicita" };
  }

  // 2. Pregunta de estado antes del "si" suelto: "si mandaron el pedido?"
  //    empieza por "si" y es una pregunta.
  if (coincide(t, PREGUNTAS_ESTADO)) {
    return { clase: CLASES.PREGUNTA_ESTADO, confianza: "alta", motivo: "pregunta por el estado del pedido" };
  }

  // 3. Afirmacion inequivoca: dice QUE confirma.
  if (coincide(t, AFIRMACIONES_FUERTES)) {
    return { clase: CLASES.SI, confianza: "alta", motivo: "afirmacion inequivoca" };
  }

  // 4. Correccion: cambia un dato; no es un si ni un no.
  if (coincide(t, CORRECCIONES)) {
    return { clase: CLASES.CORRECCION, confianza: "media", motivo: "pide cambiar un dato" };
  }

  // 5. Acuse o "si" a secas. Que signifique algo depende del estado, y eso
  //    lo resuelve evaluar(), no esta funcion.
  if (coincide(t, ACUSES)) {
    const esSiSuelto = /^(si|sii+|sip)[\s!.]*$/.test(t);
    return {
      clase: CLASES.ACUSE,
      // La tilde es intencion: quien escribe "si" esta afirmando.
      confianza: esSiSuelto && v.tieneTildeAfirmativa ? "media" : "baja",
      motivo: esSiSuelto ? "afirmacion escueta, depende del contexto" : "cortesia sin valor transaccional",
    };
  }

  return { clase: CLASES.AMBIGUO, confianza: "baja", motivo: "no encaja en ningun patron conocido" };
}

/** Acciones que puede pedir la evaluacion. Un vocabulario cerrado. */
const ACCIONES = {
  CONFIRMAR: "confirmar",       // crear el pedido
  CANCELAR: "cancelar",
  CORREGIR: "corregir",         // volver a capturar datos / recotizar
  RESPONDER_ESTADO: "responder_estado",
  ESCALAR: "escalar",           // que lo vea una persona
  NINGUNA: "ninguna",           // acusar recibo y no tocar nada
};

const { ESTADOS } = require("./estados");

/**
 * Decide que hacer con un mensaje, segun su clase Y el estado de la
 * conversacion. Aqui esta la regla que pidio Marco explicitamente.
 *
 * @param {{texto: string, estado: string, resumenMostrado?: boolean}} entrada
 * @returns {{accion: string, clase: string, motivo: string, confianza: string}}
 */
function evaluar({ texto, estado, resumenMostrado = false }) {
  const c = clasificar(texto);
  const base = { clase: c.clase, confianza: c.confianza };

  // ----------------------------------------------------------------------
  // BLINDAJE DE LO YA CONFIRMADO
  //
  // Esta rama va PRIMERO, antes de mirar la clase del mensaje. Es la
  // diferencia entre "intentamos no duplicar" y "no se puede duplicar":
  // ningun texto, por mucho que parezca una confirmacion, puede crear un
  // segundo pedido desde aqui. El estado lo impide, no el patron.
  // ----------------------------------------------------------------------
  if (estado === ESTADOS.CONFIRMADO || estado === ESTADOS.POSVENTA) {
    if (c.clase === CLASES.NO) {
      // ----------------------------------------------------------------
      // UN PEDIDO CONFIRMADO NO SE CANCELA CON UN "NO" CUALQUIERA
      //
      // ⚠️ ESTO PERDIO UN PEDIDO DE VERDAD. Marco lo reporto asi: "el
      //    pedido confirmado aparece anulado".
      //
      // El mecanismo: con el `/^no\b/` que habia en NEGACIONES, CUALQUIER
      // mensaje que empezara por "no" se leia como negacion. Y sobre un
      // pedido ya confirmado eso no se queda en un escalado: llega aqui,
      // devuelve CANCELAR, y el pedido SE CANCELA de verdad. Un "No
      // entiendo" o un "no me ha llegado" -que es posventa pura- borraba
      // una venta cerrada.
      //
      // La raiz ya esta arreglada, pero esta rama merece su propio candado:
      // es la unica del sistema donde el TEXTO del cliente destruye un
      // compromiso con quien despacha. Aqui no vale "ante la duda, no se
      // tira la venta": vale "ante la duda, NO SE TOCA EL PEDIDO".
      //
      // Asi que se exige intencion inequivoca de cancelar. Lo ambiguo lo
      // mira una persona, que es lo que pidio Marco: "anular solo con una
      // accion explicita".
      // ----------------------------------------------------------------
      if (coincide(vistas(texto).plano, CANCELACION_INEQUIVOCA)) {
        return { ...base, accion: ACCIONES.CANCELAR, motivo: "pide cancelar un pedido confirmado, sin ambigüedad" };
      }
      return {
        ...base,
        accion: ACCIONES.ESCALAR,
        motivo: "dijo que no sobre un pedido confirmado, pero sin pedir cancelarlo: lo revisa una persona",
      };
    }
    if (c.clase === CLASES.CORRECCION) {
      return { ...base, accion: ACCIONES.CORREGIR, motivo: "pide modificar un pedido ya confirmado" };
    }
    if (c.clase === CLASES.PREGUNTA_ESTADO) {
      return { ...base, accion: ACCIONES.RESPONDER_ESTADO, motivo: "pregunta por un pedido ya confirmado" };
    }
    // "si", "ok", "gracias", "listo", "perfecto" sobre un pedido confirmado:
    // se acusa recibo y NO se toca nada. Ni se cotiza, ni se crea pedido.
    return {
      ...base,
      accion: ACCIONES.NINGUNA,
      motivo: "el pedido ya esta confirmado: este mensaje no lo modifica",
    };
  }

  if (estado === ESTADOS.MODIFICANDO) {
    if (c.clase === CLASES.NO) return { ...base, accion: ACCIONES.CANCELAR, motivo: "cancela durante una modificacion" };
    if (c.clase === CLASES.SI) return { ...base, accion: ACCIONES.CONFIRMAR, motivo: "confirma la modificacion" };
    return { ...base, accion: ACCIONES.CORREGIR, motivo: "sigue modificando" };
  }

  // ----------------------------------------------------------------------
  // PENDIENTE DE CONFIRMACION: el unico sitio donde un "si" crea un pedido
  // ----------------------------------------------------------------------
  if (estado === ESTADOS.PENDIENTE_CONFIRMACION) {
    if (!resumenMostrado) {
      // Sin resumen mostrado no hay nada que confirmar. Confirmar "a ciegas"
      // es guardar un pedido que el cliente nunca vio.
      return { ...base, accion: ACCIONES.ESCALAR, motivo: "estado pendiente sin resumen mostrado al cliente" };
    }
    if (c.clase === CLASES.NO) return { ...base, accion: ACCIONES.CANCELAR, motivo: "rechaza el resumen" };
    if (c.clase === CLASES.CORRECCION) return { ...base, accion: ACCIONES.CORREGIR, motivo: "corrige antes de confirmar" };
    if (c.clase === CLASES.PREGUNTA_ESTADO) {
      return { ...base, accion: ACCIONES.ESCALAR, motivo: "pregunta por un pedido que todavia no existe" };
    }
    if (c.clase === CLASES.SI) return { ...base, accion: ACCIONES.CONFIRMAR, motivo: "confirma el resumen" };

    if (c.clase === CLASES.ACUSE) {
      // "si" a secas frente a un resumen: es la respuesta mas comun de un
      // cliente real. Cuenta como confirmacion.
      if (/^(si|sii+|sip)[\s!.]*$/.test(vistas(texto).plano)) {
        return { ...base, accion: ACCIONES.CONFIRMAR, motivo: "afirmacion escueta frente a un resumen mostrado" };
      }
      // "gracias" / "ok" frente a un resumen NO es una confirmacion, pero
      // tampoco un rechazo. No se tira la venta: la revisa una persona.
      return { ...base, accion: ACCIONES.ESCALAR, motivo: "cortesia ambigua frente a un resumen: puede ser un si" };
    }

    // Ambiguo con un resumen delante. Aqui se aplica la asimetria: no se
    // descarta la venta y no se guarda a ciegas. Escala.
    return { ...base, accion: ACCIONES.ESCALAR, motivo: "respuesta ambigua frente a un resumen mostrado" };
  }

  // ----------------------------------------------------------------------
  // Resto de estados: un "si" no confirma nada porque no hay resumen
  // ----------------------------------------------------------------------
  if (c.clase === CLASES.NO) return { ...base, accion: ACCIONES.CANCELAR, motivo: "no quiere seguir" };
  if (c.clase === CLASES.PREGUNTA_ESTADO) {
    return { ...base, accion: ACCIONES.RESPONDER_ESTADO, motivo: "pregunta por un pedido" };
  }
  if (c.clase === CLASES.CORRECCION) return { ...base, accion: ACCIONES.CORREGIR, motivo: "corrige un dato" };

  return {
    ...base,
    accion: ACCIONES.NINGUNA,
    motivo: "sin resumen mostrado no hay nada que confirmar",
  };
}

module.exports = {
  CLASES,
  ACCIONES,
  clasificar,
  evaluar,
  // expuestos para las pruebas de regresion
  NEGACIONES,
  PREGUNTAS_ESTADO,
  AFIRMACIONES_FUERTES,
  CANCELACION_INEQUIVOCA,
};
