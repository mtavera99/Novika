"use strict";

// ==========================================================================
// ENVIO DE MENSAJES
//
// Un unico punto de salida hacia el cliente. Todo lo que sale de NOVIKA pasa
// por aqui, y por eso el interruptor puede estar aqui y en ningun otro sitio.
//
// --------------------------------------------------------------------------
// EL CANDADO
// --------------------------------------------------------------------------
//
// Con RESPUESTA_AUTOMATICA en 0, enviarTexto() NO llama a la red. Ni una
// vez. No es una comprobacion en la capa de arriba que se pueda olvidar al
// añadir un flujo nuevo: es el unico camino al exterior, y empieza con ese
// `if`.
//
// Esa diferencia es la que importa. "Acordarse de comprobar el interruptor
// en cada sitio que envia" es una instruccion, y las instrucciones se
// incumplen cuando alguien con prisa añade un caso. Un candado en el unico
// camino posible no.
//
// Ademas el envio exige el `permiso` explicito: una llamada que no declara
// por que tiene derecho a escribirle a un cliente se rechaza. Asi una
// prueba no puede enviar por descuido.
// ==========================================================================

const PERMISOS = {
  /** Flujo normal de atencion. Requiere el interruptor encendido. */
  CONVERSACION: "conversacion",
  /** Aviso al dueno. No es un cliente, pero tambien respeta el interruptor. */
  AVISO_AL_DUENO: "aviso_al_dueno",
  /** Prueba controlada, autorizada por una persona para un numero concreto. */
  PRUEBA_AUTORIZADA: "prueba_autorizada",
};

const MOTIVOS_BLOQUEO = {
  INTERRUPTOR: "respuesta_automatica_apagada",
  SIN_CREDENCIALES: "sin_credenciales",
  SIN_PERMISO: "sin_permiso",
  SIN_DESTINO: "sin_destino",
  TEXTO_VACIO: "texto_vacio",
};

/** Codigos de Meta que pueden salir distinto al reintentar. */
const CODIGOS_TEMPORALES = new Set([2, 4, 80007, 130429, 131000, 131056]);
const HTTP_TEMPORALES = new Set([408, 429, 500, 502, 503, 504]);
const ESPERAS_MS = [1500, 4000];

/**
 * @param {object} opciones
 * @param {object} opciones.config
 * @param {object} [opciones.log]
 * @param {object} [opciones.metricas]
 * @param {Function} [opciones.fetchImpl]  inyectable para pruebas
 */
function crearEmisor({ config, log = null, metricas = null, fetchImpl = null } = {}) {
  const hacerFetch = fetchImpl || globalThis.fetch;

  function contar(nombre) {
    if (metricas && typeof metricas.incrementar === "function") metricas.incrementar(nombre);
  }
  function registrar(nivel, evento, datos) {
    if (log && typeof log[nivel] === "function") log[nivel](evento, datos);
  }

  /**
   * ¿Se puede enviar? Se resuelve ANTES de construir nada.
   * @returns {{puede: boolean, motivo?: string}}
   */
  function revisarPermiso({ para, texto, permiso }) {
    if (!Object.values(PERMISOS).includes(permiso)) {
      return { puede: false, motivo: MOTIVOS_BLOQUEO.SIN_PERMISO };
    }
    if (!para) return { puede: false, motivo: MOTIVOS_BLOQUEO.SIN_DESTINO };
    if (!texto || !String(texto).trim()) return { puede: false, motivo: MOTIVOS_BLOQUEO.TEXTO_VACIO };

    // EL CANDADO. Una prueba autorizada es la unica excepcion, y tiene que
    // pedirse por su nombre.
    if (!config.respuestaAutomatica && permiso !== PERMISOS.PRUEBA_AUTORIZADA) {
      return { puede: false, motivo: MOTIVOS_BLOQUEO.INTERRUPTOR };
    }
    if (!config.whatsappToken || !config.idNumero) {
      return { puede: false, motivo: MOTIVOS_BLOQUEO.SIN_CREDENCIALES };
    }
    return { puede: true };
  }

  /**
   * Envia un texto por WhatsApp.
   *
   * NUNCA LANZA. Devuelve siempre un resultado uniforme, porque un fallo de
   * envio no puede tumbar el procesamiento del mensaje de un cliente ni
   * perderse en un catch de otro.
   *
   * @returns {Promise<{enviado: boolean, bloqueado?: boolean, motivo?: string,
   *                    estado?: number, wamid?: string, intentos?: number}>}
   */
  async function enviarTexto({ para, texto, permiso = PERMISOS.CONVERSACION }) {
    const permitido = revisarPermiso({ para, texto, permiso });

    if (!permitido.puede) {
      if (permitido.motivo === MOTIVOS_BLOQUEO.INTERRUPTOR) {
        contar("respuesta_bloqueada_por_interruptor");
        // Sin telefono ni texto: es una decision, no una incidencia.
        registrar("info", "envio_bloqueado_por_interruptor", { longitud: String(texto || "").length });
      } else {
        registrar("warn", "envio_bloqueado", { motivo: permitido.motivo });
      }
      return { enviado: false, bloqueado: true, motivo: permitido.motivo };
    }

    const url = `https://graph.facebook.com/${config.versionGraph}/${config.idNumero}/messages`;
    const cuerpo = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: String(para),
      type: "text",
      text: { preview_url: false, body: String(texto) },
    };

    let ultimo = { estado: 0, codigo: null };

    for (let intento = 1; intento <= ESPERAS_MS.length + 1; intento++) {
      let respuesta;
      try {
        respuesta = await hacerFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.whatsappToken}` },
          body: JSON.stringify(cuerpo),
        });
      } catch (e) {
        // Red caida. Se trata como temporal: en BIKERPRO el try/catch estaba
        // fuera del bucle, asi que un socket cortado se saltaba todos los
        // reintentos y el cliente se quedaba sin respuesta.
        ultimo = { estado: 0, codigo: null, detalle: e && e.message };
        registrar("warn", "envio_error_de_red", { intento });
        if (await esperar(intento)) continue;
        break;
      }

      let datos = null;
      try {
        datos = await respuesta.json();
      } catch {
        datos = null;
      }

      if (respuesta.ok) {
        const wamid = datos?.messages?.[0]?.id || null;
        contar("respuesta_enviada");
        registrar("info", "respuesta_enviada", { wamid, intentos: intento });
        return { enviado: true, estado: respuesta.status, wamid, intentos: intento };
      }

      const codigo = datos?.error?.code ?? null;
      ultimo = { estado: respuesta.status, codigo };
      registrar("warn", "envio_rechazado", { intento, estado: respuesta.status, codigo });

      const temporal = HTTP_TEMPORALES.has(respuesta.status) || CODIGOS_TEMPORALES.has(codigo);
      if (temporal && (await esperar(intento))) continue;
      break;
    }

    contar("error_interno");
    registrar("error", "envio_fallido", { estado: ultimo.estado, codigo: ultimo.codigo });
    return { enviado: false, motivo: "no se pudo enviar", estado: ultimo.estado, codigoMeta: ultimo.codigo };
  }

  async function esperar(intento) {
    const ms = ESPERAS_MS[intento - 1];
    if (ms === undefined) return false;
    await new Promise((r) => setTimeout(r, ms));
    return true;
  }

  return { enviarTexto, revisarPermiso, PERMISOS, MOTIVOS_BLOQUEO };
}

module.exports = { crearEmisor, PERMISOS, MOTIVOS_BLOQUEO, CODIGOS_TEMPORALES, HTTP_TEMPORALES };
