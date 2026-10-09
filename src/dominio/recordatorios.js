"use strict";

// ==========================================================================
// RECORDATORIOS: ESCRIBIRLE AL CLIENTE QUE SE QUEDO CALLADO
//
// POR QUE EXISTE
//
// Hasta el 2026-10-10 el bot solo hablaba si el cliente escribia primero. Si
// alguien preguntaba el precio y desaparecia, nadie volvia a decirle nada.
// Nunca.
//
// Y eso era, con diferencia, lo que mas plata dejaba en la mesa: de los 25
// chats del panel, DIEZ no recibieron un segundo mensaje. Preguntaron algo,
// no contestaron, y ahi quedaron.
//
// --------------------------------------------------------------------------
// ESTE MODULO NO ENVIA NADA. SOLO DECIDE.
// --------------------------------------------------------------------------
//
// Es puro: recibe una conversacion y una hora, y devuelve si toca recordar y
// cual de los dos recordatorios. El envio, el barrido y la persistencia
// viven en `src/cerebro/recordar.js`.
//
// La razon de separarlo es que ESTO es lo que hay que poder probar sin red:
// un recordatorio mal decidido es un mensaje no solicitado a un cliente
// real, con una campaña encendida. Las trece guardas de abajo son el
// producto, no un detalle.
//
// --------------------------------------------------------------------------
// LOS TIEMPOS, Y POR QUE ESTOS
// --------------------------------------------------------------------------
//
// Marco los eligio: uno a los 30 minutos y otro a las 2-3 horas. Son mas
// agresivos que la guia habitual de carritos abandonados -primer toque entre
// 60 y 180 minutos- y aciertan en lo que de verdad manda aqui:
//
//   LA VENTANA DE 24 HORAS DE WHATSAPP. Meta solo deja escribir texto libre
//   durante las 24 h siguientes al ultimo mensaje DEL CLIENTE. Fuera de esa
//   ventana hace falta una plantilla aprobada, y hoy NOVIKA no tiene
//   ninguna (`plantillas_de_novedad: 0` en /health).
//
// Asi que los dos toques caben dentro de la ventana y no necesitan tramite.
// Los toques clasicos de 24 h y 72 h son justo los que exigen esa plantilla:
// quedan documentados para cuando Marco la tenga aprobada.
// ==========================================================================

const fecha = require("../panel/fecha");
const estados = require("./estados");
const atencion = require("../almacen/atencion");

/** Por que NO se recuerda. Vocabulario cerrado, para poder contarlo. */
const MOTIVOS = {
  APAGADO: "los recordatorios estan apagados",
  SIN_MARCA: "no se sabe cuando escribio el cliente por ultima vez",
  NO_SALUDADO: "el bot todavia no le ha dicho nada: no hay conversacion que retomar",
  TURNO_DEL_BOT: "el ultimo mensaje es del cliente: el bot le debe una respuesta, no un recordatorio",
  TIENE_PEDIDO: "ya tiene un pedido: recordarle seria pedirle que compre lo que compro",
  BLINDADO: "la conversacion esta en manos de una persona",
  PAUSADO: "el chat esta pausado",
  DECLINO: "dijo que no: insistir es acoso, no venta",
  VENTANA_CERRADA: "pasaron mas de 24 h: Meta solo entrega plantillas aprobadas",
  COMPLETOS: "ya recibio todos los recordatorios",
  PRONTO: "todavia no toca",
  FUERA_DE_HORARIO: "esta fuera del horario permitido",
};

/**
 * Cuando escribio el cliente por ultima vez, en milisegundos.
 *
 * ⚠️ SE PREFIERE EL CAMPO DEDICADO Y NO EL HISTORIAL, y la diferencia
 *    importa: `atencion` recorta el historial a los ultimos 60 mensajes
 *    (MAX_MENSAJES). En un chat largo donde los ultimos sesenta son del bot
 *    y del operador, el mensaje del cliente SE CAE de la lista y buscarlo
 *    ahi devuelve null — es decir, "no se sabe", y entonces no se recuerda
 *    nunca justo en los chats mas trabajados.
 *
 * El historial se mantiene como respaldo para las conversaciones que
 * existian antes de que el campo existiera.
 */
function ultimoDelClienteMs(conversacion) {
  const directo = conversacion && conversacion.ultimoDelClienteEn;
  const t1 = directo ? Date.parse(directo) : NaN;
  if (Number.isFinite(t1)) return t1;

  const ultimo = atencion.ultimoDelCliente(conversacion || {});
  const t2 = ultimo && ultimo.ts ? Date.parse(ultimo.ts) : NaN;
  return Number.isFinite(t2) ? t2 : null;
}

/** ¿El ultimo mensaje del chat lo escribio el negocio (bot u operador)? */
function habloElNegocioDeUltimo(conversacion) {
  const lista = atencion.mensajes(conversacion || {});
  for (let i = lista.length - 1; i >= 0; i--) {
    const m = lista[i];
    if (!m || !m.de) continue;
    return m.de !== atencion.QUIEN.CLIENTE;
  }
  return false;
}

/**
 * ¿Toca recordarle algo a este cliente?
 *
 * @param {object} opciones
 * @param {object} opciones.conversacion
 * @param {number} [opciones.ahora]
 * @param {boolean} [opciones.activos] El interruptor RECORDATORIOS.
 * @param {number[]} [opciones.minutos] Minutos de silencio de cada toque.
 * @param {number} [opciones.desdeHora] Hora de Bogota a partir de la cual se puede escribir.
 * @param {number} [opciones.hastaHora] Hora de Bogota a partir de la cual ya no.
 * @returns {{debe: boolean, orden: number|null, motivo: string, silencioMin: number|null}}
 */
function decidir({
  conversacion,
  ahora = Date.now(),
  activos = false,
  minutos = [30, 180],
  desdeHora = 8,
  hastaHora = 21,
} = {}) {
  const no = (motivo, silencioMin = null) => ({ debe: false, orden: null, motivo, silencioMin });

  // ----------------------------------------------------------------------
  // 1. EL INTERRUPTOR, Y VA PRIMERO A PROPOSITO.
  //
  // Apagado por defecto. Esto manda mensajes que NADIE pidio a numeros de
  // clientes reales, con una campaña de Facebook encendida. Que se encienda
  // solo porque alguien despliega es inaceptable: lo enciende Marco en
  // Render cuando quiera, igual que RESPUESTA_AUTOMATICA.
  // ----------------------------------------------------------------------
  if (!activos) return no(MOTIVOS.APAGADO);
  if (!conversacion) return no(MOTIVOS.SIN_MARCA);

  // ----------------------------------------------------------------------
  // 2. QUE EL BOT YA LE HAYA DICHO ALGO.
  //
  // Sin esto se le escribiria a un contacto que solo existe porque llego un
  // acuse de entrega o un evento raro, y que nunca tuvo una conversacion.
  // ----------------------------------------------------------------------
  if (conversacion.saludado !== true) return no(MOTIVOS.NO_SALUDADO);

  // ----------------------------------------------------------------------
  // 3. QUE EL ULTIMO MENSAJE SEA DEL NEGOCIO.
  //
  // Si el ultimo es del CLIENTE, lo que falta no es un recordatorio: es la
  // respuesta que el bot le debe. Mandarle "¿seguimos?" a quien lleva una
  // hora esperando contestacion es la peor version posible de esta funcion.
  //
  // Pasa de verdad: con el chat pausado, los mensajes del cliente se
  // registran y no se contestan. Ahi el recordatorio seria un insulto.
  // ----------------------------------------------------------------------
  if (!habloElNegocioDeUltimo(conversacion)) return no(MOTIVOS.TURNO_DEL_BOT);

  // ----------------------------------------------------------------------
  // 4. QUE NO TENGA YA UN PEDIDO.
  //
  // `ESTADOS_CON_PEDIDO` es confirmado, modificando y posventa. Pedirle que
  // compre a quien acaba de comprar es el error que mas rapido destruye la
  // confianza — y el que mas se ve en los bots mal hechos.
  // ----------------------------------------------------------------------
  if (estados.tienePedido(conversacion.estado)) return no(MOTIVOS.TIENE_PEDIDO);

  // ----------------------------------------------------------------------
  // 5. QUE NO ESTE EN MANOS DE UNA PERSONA.
  //
  // `estaBlindado` incluye ESCALADO. Si el bot ya dijo "te paso con una
  // persona", volver a hablar por encima convierte esa frase en mentira.
  // ----------------------------------------------------------------------
  if (estados.estaBlindado(conversacion.estado)) return no(MOTIVOS.BLINDADO);

  // ----------------------------------------------------------------------
  // 6. QUE NO ESTE PAUSADO.
  //
  // Se lee del objeto, no del almacen: esto es puro. El barrido vuelve a
  // comprobarlo contra el almacen antes de enviar, y el emisor lo comprueba
  // una tercera vez. Tres candados en serie para el mismo riesgo, porque el
  // riesgo es hablar por encima de una persona.
  // ----------------------------------------------------------------------
  if (atencion.leer(conversacion).pausado === true) return no(MOTIVOS.PAUSADO);

  // ----------------------------------------------------------------------
  // 7. QUE NO HAYA DICHO QUE NO.
  //
  // `declino` lo pone el cerebro cuando el cliente declina sin pedido. A
  // quien dijo "no gracias" no se le insiste: eso no es vender, es acosar, y
  // es la via rapida a que reporte el numero como spam. Un reporte de spam
  // le cuesta a Marco la calidad del numero, que vale mas que esta venta.
  // ----------------------------------------------------------------------
  if (conversacion.declino === true) return no(MOTIVOS.DECLINO);

  // ----------------------------------------------------------------------
  // 8. LA VENTANA DE 24 HORAS DE WHATSAPP.
  //
  // Meta solo entrega texto libre dentro de las 24 h siguientes al ultimo
  // mensaje del cliente. Fuera, responde 131047 y el mensaje no llega. Se
  // comprueba aqui -con el mismo calculo que `whatsapp/ventana.js`- para no
  // gastar una llamada a la red en algo que ya se sabe que va a fallar.
  // ----------------------------------------------------------------------
  const marca = ultimoDelClienteMs(conversacion);
  if (marca === null) return no(MOTIVOS.SIN_MARCA);

  const silencioMs = ahora - marca;
  const silencioMin = Math.floor(silencioMs / 60000);
  if (silencioMs >= 24 * 60 * 60 * 1000) return no(MOTIVOS.VENTANA_CERRADA, silencioMin);

  // ----------------------------------------------------------------------
  // 9. CUANTOS LLEVA YA, Y CONTRA QUE SILENCIO.
  //
  // `base` es la marca del mensaje del cliente sobre la que se conto la
  // serie. Si el cliente vuelve a escribir, la marca cambia, la serie se
  // reinicia y vuelve a tener sus dos toques. Es lo correcto: cada silencio
  // nuevo es una oportunidad nueva, y los toques no se acumulan de por vida.
  // ----------------------------------------------------------------------
  const estado = conversacion.recordatorios || {};
  const mismaSerie = estado.base === new Date(marca).toISOString();
  const enviados = mismaSerie ? Number(estado.enviados) || 0 : 0;

  // --------------------------------------------------------------------
  // QUIEN DIJO "SERA OTRO DIA" TIENE SU PROPIO PLAZO: 20 HORAS, UNA VEZ.
  //
  // Lo pidio Marco en su punto 7. Y el plazo distinto no es un capricho:
  // a quien aplaza, un recordatorio a los 30 minutos le dice que no se le
  // escucho. Veinte horas despues es otra conversacion.
  //
  // UNA sola vez, y cabe dentro de la ventana de 24 h de WhatsApp — por los
  // pelos, y por eso son 20 y no 24: si se pasara de la ventana haria falta
  // una plantilla aprobada, que todavia no existe.
  // --------------------------------------------------------------------
  const aplazo = conversacion.aplazadoEn && Date.parse(conversacion.aplazadoEn);
  const esAplazado = Number.isFinite(aplazo) && aplazo >= marca - 60000;

  const umbrales = esAplazado
    ? [20 * 60]
    : (Array.isArray(minutos) ? minutos : []).filter((m) => Number.isFinite(m) && m > 0);
  if (!umbrales.length) return no(MOTIVOS.APAGADO, silencioMin);
  if (enviados >= umbrales.length) return no(MOTIVOS.COMPLETOS, silencioMin);

  if (silencioMin < umbrales[enviados]) return no(MOTIVOS.PRONTO, silencioMin);

  // ----------------------------------------------------------------------
  // 10. EL HORARIO. Y ES EL ULTIMO PORQUE ES EL QUE MAS CAMBIA.
  //
  // Un recordatorio a las 3 de la mañana no vende: molesta, y en WhatsApp
  // molestar tiene un precio concreto (que te bloqueen o te reporten).
  //
  // Se mira la hora de BOGOTA, no la del servidor, que en Render esta en
  // UTC. Sin esto, la franja "8 a 21" seria "3 de la mañana a 4 de la
  // tarde" en Colombia — y el defecto solo se veria en produccion.
  // ----------------------------------------------------------------------
  const horaTexto = fecha.horaBogota(ahora);
  const hora = Number.parseInt(String(horaTexto).slice(0, 2), 10);
  if (Number.isFinite(hora) && (hora < desdeHora || hora >= hastaHora)) {
    return no(MOTIVOS.FUERA_DE_HORARIO, silencioMin);
  }

  return { debe: true, orden: enviados + 1, motivo: `silencio de ${silencioMin} min`, silencioMin };
}

/** La marca de serie que hay que guardar tras enviar un recordatorio. */
function serieDe(conversacion) {
  const marca = ultimoDelClienteMs(conversacion);
  return marca === null ? null : new Date(marca).toISOString();
}

module.exports = { decidir, serieDe, ultimoDelClienteMs, habloElNegocioDeUltimo, MOTIVOS };
