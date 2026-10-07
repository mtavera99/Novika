"use strict";

// ==========================================================================
// NORMALIZAR EL PAYLOAD DE META
//
// El cuerpo que manda Meta esta anidado cuatro niveles
// (entry[].changes[].value.messages[]) y mezcla cosas distintas en la misma
// forma. El resto de NOVIKA no deberia saber nada de eso: recibe una lista
// plana de eventos con un contrato propio.
//
// Esta frontera existe por tres razones concretas:
//
//   1. Meta cambia de version. Cuando cambie, se toca este archivo y nada mas.
//   2. Se pueden escribir pruebas con payloads reales sin levantar el servidor.
//   3. BIKERPRO parsea el payload dentro del mismo archivo de 3.000 lineas
//      que tiene las rutas, el panel HTML y los avisos al dueno. Eso hace
//      que un cambio de Meta obligue a tocar codigo de negocio.
//
// Decision importante: se procesan los eventos `statuses`, no solo
// `messages`. En BIKERPRO se ignoraban, y por eso hubo mensajes que Meta
// aceptaba con un 200 y luego nunca entregaba: el motivo venia justo ahi.
// ==========================================================================

/** Clases de evento que NOVIKA entiende. */
const CLASES = { MENSAJE: "mensaje", ESTADO: "estado", DESCONOCIDO: "desconocido" };

function comoLista(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Quien escribe. Puede ser un telefono o un BSUID (los clientes que usan
 * nombre de usuario de WhatsApp no tienen numero). Se guardan por separado
 * a proposito: la clave de la conversacion y el telefono al que se despacha
 * son cosas distintas, y confundirlas rompe el despacho.
 */
function quienEscribe(mensaje, value) {
  const contacto = comoLista(value && value.contacts)[0] || {};
  const telefono = (mensaje && mensaje.from) || contacto.wa_id || null;
  const bsuid = (mensaje && mensaje.from_user_id) || contacto.user_id || null;
  return {
    idCliente: telefono || bsuid || null,
    telefono: telefono || null,
    bsuid: bsuid || null,
    nombre: (contacto.profile && contacto.profile.name) || null,
  };
}

/**
 * Texto util del mensaje, segun su tipo. Los tipos interactivos se aplanan a
 * texto para que el resto del sistema trate igual "escribio Hola" y "toco el
 * boton Hola": si no, cada flujo nuevo tiene que acordarse de los botones.
 */
function contenidoDe(mensaje) {
  switch (mensaje.type) {
    case "text":
      return { texto: (mensaje.text && mensaje.text.body) || "", origenTexto: "escrito" };

    case "button":
      // Respuesta a un boton de plantilla.
      return { texto: (mensaje.button && mensaje.button.text) || "", origenTexto: "boton_plantilla" };

    case "interactive": {
      const i = mensaje.interactive || {};
      if (i.type === "button_reply") {
        return {
          texto: (i.button_reply && i.button_reply.title) || "",
          idOpcion: (i.button_reply && i.button_reply.id) || null,
          origenTexto: "boton",
        };
      }
      if (i.type === "list_reply") {
        return {
          texto: (i.list_reply && i.list_reply.title) || "",
          idOpcion: (i.list_reply && i.list_reply.id) || null,
          origenTexto: "lista",
        };
      }
      return { texto: "", origenTexto: `interactivo_${i.type || "desconocido"}` };
    }

    case "image":
    case "audio":
    case "video":
    case "document":
    case "sticker": {
      const media = mensaje[mensaje.type] || {};
      return {
        texto: media.caption || "",
        origenTexto: "pie_de_media",
        media: { tipo: mensaje.type, id: media.id || null, mime: media.mime_type || null },
      };
    }

    case "location": {
      const l = mensaje.location || {};
      return { texto: "", origenTexto: "ubicacion", ubicacion: { lat: l.latitude, lon: l.longitude, nombre: l.name || null } };
    }

    default:
      return { texto: "", origenTexto: `tipo_no_soportado_${mensaje.type}` };
  }
}

/**
 * Convierte el cuerpo de Meta en una lista plana de eventos de NOVIKA.
 * No valida la firma ni decide nada: solo traduce.
 *
 * @returns {Array<object>}
 */
function normalizar(cuerpo) {
  const eventos = [];

  for (const entry of comoLista(cuerpo && cuerpo.entry)) {
    for (const change of comoLista(entry.changes)) {
      const value = change.value || {};
      const meta = value.metadata || {};
      const comun = {
        idNumero: meta.phone_number_id || null, // candado de aislamiento
        numeroVisible: meta.display_phone_number || null,
        idWaba: entry.id || null,
        campo: change.field || null,
      };

      // --- Mensajes entrantes ---
      for (const mensaje of comoLista(value.messages)) {
        eventos.push({
          clase: CLASES.MENSAJE,
          ...comun,
          wamid: mensaje.id || null,
          tipo: mensaje.type || "desconocido",
          enviadoEn: mensaje.timestamp ? Number(mensaje.timestamp) * 1000 : null,
          ...quienEscribe(mensaje, value),
          ...contenidoDe(mensaje),
          // Referral: de que anuncio viene. Es una señal ADICIONAL para
          // identificar producto, nunca la unica.
          referral: mensaje.referral || null,
          // Respuesta a un mensaje anterior (cita).
          contexto: mensaje.context || null,
        });
      }

      // --- Estados de mensajes que NOVIKA envio ---
      for (const estado of comoLista(value.statuses)) {
        const errores = comoLista(estado.errors).map((e) => ({
          codigo: e.code || null,
          titulo: e.title || null,
          detalle: (e.error_data && e.error_data.details) || e.details || null,
        }));
        eventos.push({
          clase: CLASES.ESTADO,
          ...comun,
          wamid: estado.id || null,
          estado: estado.status || null, // sent | delivered | read | failed
          para: estado.recipient_id || null,
          enviadoEn: estado.timestamp ? Number(estado.timestamp) * 1000 : null,
          categoriaPrecio: (estado.pricing && estado.pricing.category) || null,
          errores,
        });
      }

      // --- Nada reconocible ---
      if (!comoLista(value.messages).length && !comoLista(value.statuses).length) {
        eventos.push({
          clase: CLASES.DESCONOCIDO,
          ...comun,
          claves: Object.keys(value),
        });
      }
    }
  }

  return eventos;
}

module.exports = { normalizar, CLASES, quienEscribe, contenidoDe };
