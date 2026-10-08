"use strict";

// ==========================================================================
// POR QUE EL BOT NO CONTESTO
//
// DE DONDE SALE ESTE MODULO: Marco entro al panel y encontro mensajes sin
// responder. Tuvo que contestarlos a mano y no sabia por que habia pasado.
//
// Y el problema de fondo no era ninguna de las causas concretas -todas
// estaban previstas y registradas- sino que NINGUNA SE VEIA. El bot se
// callaba, lo anotaba en el diario y en los logs de Render, y el panel
// seguia mostrando un dia normal. Habia que entrar, leer los chats y
// darse cuenta.
//
// Un bot que no contesta y no lo dice es peor que uno caido: el caido se
// nota.
//
// LAS CAUSAS, TODAS REALES Y TODAS DISTINTAS
//
//   1. NUMEROS_DE_PRUEBA puesta  -> el bot solo contesta a esos numeros.
//      Es la causa mas probable hoy, y es configuracion, no un fallo.
//   2. Chat pausado              -> alguien tomo el control. El bot calla a
//      proposito... y antes NO VOLVIA NUNCA.
//   3. RESPUESTA_AUTOMATICA=0    -> modo sombra: prepara y no envia.
//   4. Fallo de envio            -> Meta rechazo el mensaje.
//
// Las cuatro se cuentan aqui y se muestran con QUE HACER en cada caso. Un
// diagnostico que dice "hay 7 mensajes sin responder" y no dice por que
// obliga a investigar; esto dice cual es la palanca.
// ==========================================================================

const diario = require("../almacen/diario");
const atencion = require("../almacen/atencion");
const fecha = require("./fecha");

/** Motivos por los que un mensaje del negocio no salio. */
const MOTIVOS = {
  FUERA_DE_LISTA: "fuera_de_la_lista_de_prueba",
  PAUSADO: "conversacion_pausada",
  INTERRUPTOR: "respuesta_automatica_apagada",
  ENVIO_MANUAL: "envio_manual_apagado",
  SIN_CREDENCIALES: "sin_credenciales",
  FALLO: "fallo_de_envio",
  PREPARADO: "preparado_sin_enviar",
  // --------------------------------------------------------------------
  // LOS DOS QUE FALTABAN, Y ERAN LA MAYORIA
  //
  // El 08-oct esta pantalla decia "Motivo no catalogado · mira el diario"
  // en 5 de los 7 mensajes sin salir. Es decir: la pantalla que existe
  // para explicar por que el bot no contesto, no sabia explicar el caso
  // mas frecuente. Y "mira el diario" no es algo que Marco pueda hacer.
  //
  // Los dos motivos los escribe el cerebro desde siempre; nadie los habia
  // traido aqui.
  // --------------------------------------------------------------------
  ESCALADO: "escalado_esperando_persona",
  NOTA_INTERNA: "nota_interna",
  /** Cliente con nombre de usuario de WhatsApp: no hay numero al que escribir. */
  SIN_TELEFONO: "destinatario_sin_telefono",
};

/**
 * Que hacer con cada motivo.
 *
 * El texto dice la PALANCA concreta, no un consejo generico. "Revisa la
 * configuracion" obliga a buscar; "quita NUMEROS_DE_PRUEBA en Render"
 * se ejecuta.
 */
const QUE_HACER = {
  [MOTIVOS.FUERA_DE_LISTA]: {
    titulo: "La lista de prueba está puesta",
    porQue:
      "NUMEROS_DE_PRUEBA tiene números configurados, así que el bot SOLO le contesta a esos. " +
      "A cualquier otro cliente le guarda el mensaje y se calla.",
    comoSeArregla: "Borra la variable NUMEROS_DE_PRUEBA en Render para abrir al público.",
    gravedad: "alta",
  },
  [MOTIVOS.PAUSADO]: {
    titulo: "Alguien tomó el control del chat",
    porQue:
      "El bot se calla cuando una persona responde, para que el cliente no reciba dos voces. " +
      "Pero la pausa NO se levantaba sola: el chat quedaba sin bot para siempre.",
    comoSeArregla: 'Usa "Devolver al bot" en el chat, o el botón de devolver todos.',
    gravedad: "alta",
  },
  [MOTIVOS.INTERRUPTOR]: {
    titulo: "La respuesta automática está apagada",
    porQue: "El bot procesa todo y prepara la respuesta, pero no la envía. Es el modo sombra.",
    comoSeArregla: "Pon RESPUESTA_AUTOMATICA=1 en Render.",
    gravedad: "alta",
  },
  [MOTIVOS.ENVIO_MANUAL]: {
    titulo: "Los envíos desde el panel están apagados",
    porQue: "Escribiste desde el panel y el mensaje no salió.",
    comoSeArregla: "Pon PANEL_ENVIO_MANUAL=1 en Render.",
    gravedad: "media",
  },
  [MOTIVOS.SIN_CREDENCIALES]: {
    titulo: "Faltan credenciales de WhatsApp",
    porQue: "Sin token o sin id de número, no hay forma de enviar nada.",
    comoSeArregla: "Revisa WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID en Render.",
    gravedad: "alta",
  },
  [MOTIVOS.ESCALADO]: {
    titulo: "El bot escaló y espera a una persona",
    porQue:
      "El bot contestó lo que sabía, avisó UNA vez de que lo revisa alguien del equipo, y se calló a " +
      "propósito. No es un fallo: es la regla de escalado. Pero el cliente SÍ está esperando una respuesta " +
      "humana, y si nadie entra, esa conversación se queda quieta.",
    comoSeArregla: 'Entra al chat, contéstale y marca "atendido". La pausa caduca sola a las 12 horas.',
    gravedad: "alta",
  },
  [MOTIVOS.NOTA_INTERNA]: {
    titulo: "Era una nota interna, no un mensaje",
    porQue:
      "El cerebro registró algo para que quede constancia, sin intención de enviarlo al cliente. " +
      "Cuenta como «mensaje sin salir» porque no salió, pero no falta nada.",
    comoSeArregla: "Nada que arreglar.",
    gravedad: "baja",
  },
  [MOTIVOS.SIN_TELEFONO]: {
    titulo: "No había a dónde enviar el mensaje",
    porQue:
      "El destinatario no era ni un teléfono ni un identificador de WhatsApp con la forma que Meta exige, " +
      "así que no se gastó el intento. " +
      "Ojo: a los clientes que entran con NOMBRE DE USUARIO (su id empieza por «CO.») SÍ se les puede " +
      "escribir desde junio de 2026 — el mensaje sale con su identificador—. Lo que no tenemos de ellos es " +
      "el teléfono.",
    comoSeArregla:
      "Si el cliente entró con nombre de usuario, contéstale normal: el bot ya lo hace. Lo que hay que " +
      "pedirle en el chat es el celular, porque sin él la transportadora no puede entregar.",
    gravedad: "media",
  },
  [MOTIVOS.FALLO]: {
    titulo: "Meta rechazó el mensaje",
    porQue: "El envío se intentó y falló. Puede ser la ventana de 24 h o el token caducado.",
    comoSeArregla: "Mira el detalle en el chat. Si es la ventana de 24 h, hace falta una plantilla.",
    gravedad: "alta",
  },
  [MOTIVOS.PREPARADO]: {
    titulo: "Se preparó y no se envió",
    porQue: "La respuesta existe pero no salió, y el motivo concreto no quedó registrado.",
    comoSeArregla: "Abre el chat para ver el estado del mensaje.",
    gravedad: "media",
  },
};

/**
 * Diagnostico de los silencios del dia.
 *
 * @param {object} repos
 * @param {object} [opciones]
 * @param {string} [opciones.dia] AAAA-MM-DD en Bogota
 */
async function diagnostico(repos, { dia = null, ahora = Date.now(), limite = 2000 } = {}) {
  const elDia = dia || fecha.hoyBogota(ahora);

  // ----------------------------------------------------------------------
  // 1. LOS QUE NO LLEGARON AL CEREBRO
  //
  // La lista de prueba corta ANTES de redactar, asi que estos mensajes no
  // tienen ni respuesta preparada. Solo quedan en el diario.
  // ----------------------------------------------------------------------
  const delDiario = diario.resumenDeHoy();
  const fueraDeLista = delDiario[MOTIVOS.FUERA_DE_LISTA] || 0;

  // ----------------------------------------------------------------------
  // 2. LOS QUE SE PREPARARON Y NO SALIERON
  //
  // Se cuentan desde las CONVERSACIONES y no desde el diario, porque cada
  // mensaje guarda el estado REAL de su intento. El diario cuenta eventos;
  // esto cuenta lo que el cliente no leyo.
  // ----------------------------------------------------------------------
  const conversaciones = await repos.conversaciones.listar({ limite });

  const porMotivo = {};
  if (fueraDeLista) porMotivo[MOTIVOS.FUERA_DE_LISTA] = fueraDeLista;

  const pausados = [];
  const esperando = [];

  for (const conv of conversaciones) {
    const mensajes = atencion.mensajes(conv);
    const a = atencion.leer(conv);

    // Mensajes del negocio que NO salieron, solo del dia que se mira.
    for (const m of mensajes) {
      if (!m || m.de === atencion.QUIEN.CLIENTE) continue;
      if (!m.estado || m.estado === "enviado") continue;
      if (fecha.diaBogota(m.ts) !== elDia) continue;
      porMotivo[m.estado] = (porMotivo[m.estado] || 0) + 1;
    }

    // Chats donde el bot esta callado por la pausa. No dependen del dia:
    // un chat pausado hace tres dias sigue sin bot hoy, y es justo el que
    // mas importa.
    if (a.pausado) {
      pausados.push({
        contactoId: conv.contactoId,
        por: a.por || "operador",
        desde: a.desde || null,
        horas: a.desde ? Math.floor((ahora - new Date(a.desde).getTime()) / 3600000) : null,
      });
    }

    // El caso que de verdad duele: el cliente escribio lo ultimo y NADIE
    // -ni bot ni persona- le ha contestado despues.
    const ultimo = mensajes.length ? mensajes[mensajes.length - 1] : null;
    if (ultimo && ultimo.de === atencion.QUIEN.CLIENTE && !atencion.estaAtendido(conv)) {
      esperando.push({
        contactoId: conv.contactoId,
        texto: ultimo.texto,
        ts: ultimo.ts,
        minutos: fecha.minutosDesde(ultimo.ts, ahora),
        // Si el bot nunca dijo nada en este chat, es un cliente que nunca
        // recibio una sola respuesta. Peor que uno a medio atender.
        nuncaRespondido: !mensajes.some((m) => m.de !== atencion.QUIEN.CLIENTE),
        pausado: a.pausado === true,
      });
    }
  }

  // Los pausados cuentan como causa aunque hoy no haya habido intento: el
  // chat esta sin bot y eso es lo que hay que ver.
  if (pausados.length) porMotivo[MOTIVOS.PAUSADO] = pausados.length;

  const causas = Object.entries(porMotivo)
    .map(([motivo, cuantos]) => ({
      motivo,
      cuantos,
      ...(QUE_HACER[motivo] || {
        titulo: motivo,
        porQue: "Motivo no catalogado.",
        comoSeArregla: "Mira el diario para el detalle.",
        gravedad: "media",
      }),
    }))
    .sort((a, b) => b.cuantos - a.cuantos);

  esperando.sort((a, b) => b.minutos - a.minutos);

  return {
    dia: elDia,
    // Lo que el cliente no leyo, sumado. Es el numero que importa.
    total: causas.reduce((s, c) => s + c.cuantos, 0),
    causas,
    pausados,
    esperando: esperando.slice(0, 50),
    cuantosEsperan: esperando.length,
    nuncaRespondidos: esperando.filter((e) => e.nuncaRespondido).length,
  };
}

module.exports = { MOTIVOS, QUE_HACER, diagnostico };
