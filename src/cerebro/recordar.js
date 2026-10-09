"use strict";

// ==========================================================================
// EL BARRIDO DE RECORDATORIOS
//
// Recorre las conversaciones, pregunta a `dominio/recordatorios` si toca, y
// manda el mensaje. La decision vive alli y es pura; aqui esta el I/O.
//
// --------------------------------------------------------------------------
// POR QUE UN BARRIDO Y NO UN TEMPORIZADOR POR CLIENTE
// --------------------------------------------------------------------------
//
// Lo obvio seria `setTimeout(30 min)` al terminar cada turno. Y se pierde en
// el primer despliegue: Render manda SIGTERM, el proceso muere y con el
// todos los temporizadores en memoria. Con el disco persistente activado no
// hay despliegues sin interrupcion, asi que esto pasa en CADA deploy.
//
// El barrido no tiene ese problema porque no recuerda nada: cada pasada
// recalcula desde los datos guardados -cuando escribio el cliente, cuantos
// recordatorios lleva- asi que un reinicio no pierde nada, solo retrasa la
// pasada siguiente. Es el mismo razonamiento por el que `trabajo.jsonl`
// existe para los eventos entrantes.
//
// --------------------------------------------------------------------------
// LO QUE ESTE MODULO NO DA POR SENTADO
// --------------------------------------------------------------------------
//
// Que el envio funcione. El emisor devuelve `{enviado, bloqueado, motivo}` y
// NUNCA lanza, asi que un bloqueo -interruptor apagado, chat pausado, numero
// sin telefono- se cuenta y se sigue con el siguiente cliente. Y SOLO si el
// mensaje salio de verdad se apunta el recordatorio como enviado: si no, al
// encender el interruptor nadie recibiria nada porque el bot creeria que ya
// se lo mando. Es la misma leccion del modo sombra.
// ==========================================================================

const recordatorios = require("../dominio/recordatorios");
const atencionDeChat = require("../almacen/atencion");
const campos = require("../dominio/campos");
const estados = require("../dominio/estados");
const { PERMISOS } = require("../whatsapp/enviar");
const contestar = require("./contestar");

/** Cada cuanto pasa el barrido. */
const CADA_MS = 5 * 60 * 1000;

/** Cuantas conversaciones se miran por pasada. */
const POR_PASADA = 500;

// ==========================================================================
// LOS TEXTOS
//
// Tres reglas, y las tres salieron de los chats del panel:
//
//  1. SE RETOMA DONDE SE QUEDO, no se saluda otra vez. "¡Hola! ¿En qué te
//     puedo ayudar?" a quien ya tuvo media conversacion es volver a empezar,
//     y es lo que mas delata a un bot.
//  2. UNA SOLA COSA QUE HACER. Si falta la direccion, se pide la direccion.
//     Un recordatorio con tres preguntas no se contesta.
//  3. EL SEGUNDO TOQUE AÑADE EL ARGUMENTO, NO LA PRESION. No "¿sigues ahi?"
//     otra vez, sino lo que de verdad quita el miedo: que paga al recibir y
//     que lo prueba 7 dias. Los dos datos salen del catalogo.
//
// Y NUNCA SE INVENTA UNA URGENCIA. "Quedan pocas unidades" o "la oferta
// vence hoy" son las frases que mas convierten en el corto plazo y las que
// no se pueden sostener: no hay inventario en el catalogo que lo respalde, y
// una urgencia falsa repetida convierte el numero en spam.
// ==========================================================================

/**
 * Que decirle, segun donde se quedo y cuantos recordatorios lleva.
 *
 * @returns {string|null} null si no hay nada sensato que decir.
 */
function texto({ conversacion, producto, orden }) {
  const ficha = (conversacion && conversacion.ficha) || {};
  const nombre = campos.valorConfirmado(ficha.nombre);
  // Solo el nombre de pila, y solo si parece un nombre: el apellido suena a
  // cobro, y el nombre de perfil de WhatsApp a veces es un emoji.
  const pila = nombre && /^[\p{L}][\p{L}'’-]{1,}$/u.test(String(nombre).split(/\s+/)[0])
    ? String(nombre).split(/\s+/)[0]
    : null;
  const hola = pila ? `Hola, ${pila} 😊 ` : "";

  const esperandoElSi = conversacion && conversacion.resumenMostrado === true;

  // --------------------------------------------------------------------
  // CASO 1: EL RESUMEN ESTA EN PANTALLA Y FALTA EL "SI".
  //
  // Es el cliente mas cerca de comprar que existe: ya dio todos sus datos y
  // vio el total. Lo unico que falta es una palabra.
  // --------------------------------------------------------------------
  if (esperandoElSi) {
    if (orden === 1) {
      return `${hola}Te dejé el resumen de tu pedido aquí arriba 👆 ¿Te lo confirmo?`;
    }
    const pagaAlRecibir = contestar.pagaAlRecibir(producto, conversacion && conversacion.cotizacion);
    const extra = pagaAlRecibir ? " Recuerda que pagas cuando te llegue, no por adelantado." : "";
    return `${hola}¿Seguimos con tu pedido? Con un "sí" lo dejo listo.${extra}`;
  }

  // --------------------------------------------------------------------
  // CASO 2: FALTAN DATOS DE ENTREGA. Se pide EL PRIMERO que falte.
  //
  // Uno, no la lista: el recordatorio tiene que ser mas facil de contestar
  // que la pedida original, no igual de dificil.
  // --------------------------------------------------------------------
  const COMO_SE_LLAMA = {
    nombre: "tu nombre completo",
    ciudad: "tu ciudad",
    direccion: "tu dirección",
    telefono: "tu número de celular",
  };
  const falta = ["ciudad", "direccion", "nombre", "telefono"].find(
    (c) => !campos.valorConfirmado(ficha[c]) && COMO_SE_LLAMA[c]
  );

  if (falta && conversacion.datosPedidos === true) {
    if (orden === 1) {
      return `${hola}¿Seguimos con tu pedido? Me falta ${COMO_SE_LLAMA[falta]} y te lo dejo listo 🙌`;
    }
    const prueba = producto && producto.pruebaDeSieteDias;
    const gancho =
      prueba && prueba.activa
        ? " Y lo pruebas 7 días: si no te sirve, te devolvemos tu dinero."
        : "";
    return `${hola}Te dejo el pedido apartado por si lo quieres. Pagas cuando te llegue, no por adelantado.${gancho} ¿Me pasas ${COMO_SE_LLAMA[falta]}?`;
  }

  // --------------------------------------------------------------------
  // CASO 3: SOLO MIRABA. Preguntó algo y se fue.
  //
  // Aqui no hay un dato que pedir, asi que se ofrece el siguiente paso mas
  // pequeño posible: la ciudad, que es lo que el propio bot pregunta en su
  // primer mensaje y lo mas facil de contestar.
  // --------------------------------------------------------------------
  if (orden === 1) {
    return `${hola}¿Te quedó alguna duda del cinturón? Aquí estoy 🙌`;
  }

  const prueba = producto && producto.pruebaDeSieteDias;
  const partes = [`${hola}Te cuento por si te animas:`];
  if (contestar.pagaAlRecibir(producto, conversacion && conversacion.cotizacion)) {
    partes.push("pagas cuando te llegue, no por adelantado,");
  }
  if (prueba && prueba.activa && prueba.dias) {
    partes.push(`y lo pruebas ${prueba.dias} días: si no te sirve, te devolvemos tu dinero.`);
  }
  // Si el catalogo no respalda ninguno de los dos ganchos, no se rellena con
  // adjetivos: se deja el recordatorio corto del primer toque.
  if (partes.length === 1) return `${hola}¿Te animas con el cinturón? Aquí sigo 🙌`;
  partes.push("¿Para qué ciudad sería?");
  return partes.join(" ");
}

/**
 * Una pasada completa.
 *
 * @returns {Promise<{mirados:number, enviados:number, bloqueados:number, porMotivo:object}>}
 */
async function pasada({ config, repos, catalogo, emisor, log, metricas, diario, ahora = Date.now() }) {
  const informe = { mirados: 0, enviados: 0, bloqueados: 0, porMotivo: {} };
  const contar = (n) => metricas && metricas.incrementar && metricas.incrementar(n);
  const anotarMotivo = (m) => {
    informe.porMotivo[m] = (informe.porMotivo[m] || 0) + 1;
  };

  if (!config.recordatorios) {
    anotarMotivo(recordatorios.MOTIVOS.APAGADO);
    return informe;
  }

  let lista = [];
  try {
    const r = await repos.conversaciones.listar({ limite: POR_PASADA });
    lista = Array.isArray(r) ? r : r.filas || [];
  } catch (e) {
    if (log) log.error("recordatorios_no_se_pudo_listar", { detalle: e.message });
    return informe;
  }

  for (const conversacion of lista) {
    informe.mirados++;

    const decision = recordatorios.decidir({
      conversacion,
      ahora,
      activos: config.recordatorios,
      minutos: config.recordatorioMinutos,
      desdeHora: config.recordatoriosDesdeHora,
      hastaHora: config.recordatoriosHastaHora,
    });

    if (!decision.debe) {
      anotarMotivo(decision.motivo);
      continue;
    }

    // ------------------------------------------------------------------
    // SEGUNDA COMPROBACION DE LA PAUSA, CONTRA EL ALMACEN.
    //
    // `decidir` la mira sobre el objeto que trajo `listar`, que puede ser de
    // hace unos milisegundos. Entre esa lectura y este envio un operador
    // puede haber pulsado "Tomar el control". El emisor la comprueba una
    // tercera vez, y aun asi se mira aqui: evita preparar y registrar un
    // mensaje que no va a salir.
    // ------------------------------------------------------------------
    try {
      if (await atencionDeChat.estaPausada(repos, conversacion.contactoId)) {
        anotarMotivo(recordatorios.MOTIVOS.PAUSADO);
        continue;
      }
    } catch (e) {
      anotarMotivo(recordatorios.MOTIVOS.PAUSADO);
      continue;
    }

    const producto =
      (catalogo && (catalogo.productos || []).find((p) => p.id === conversacion.productoId)) || null;

    const cuerpo = texto({ conversacion, producto, orden: decision.orden });
    if (!cuerpo) {
      anotarMotivo("sin texto que mandar");
      continue;
    }

    const destino = campos.valorConfirmado((conversacion.ficha || {}).telefono) || conversacion.contactoId;

    let envio;
    try {
      envio = await emisor.enviarTexto({
        para: destino,
        texto: cuerpo,
        // PERMISOS.CONVERSACION y no ATENCION_MANUAL, a proposito: este es
        // el BOT hablando, asi que tiene que obedecer RESPUESTA_AUTOMATICA y
        // el candado de la pausa. `ATENCION_MANUAL` se salta los dos, y
        // usarlo aqui seria colarse por la puerta del operador.
        permiso: PERMISOS.CONVERSACION,
        conversacionId: conversacion.contactoId,
      });
    } catch (e) {
      if (log) log.error("recordatorio_fallo", { contactoId: conversacion.contactoId, detalle: e.message });
      informe.bloqueados++;
      contar("recordatorio_no_enviado");
      continue;
    }

    if (!envio || !envio.enviado) {
      informe.bloqueados++;
      anotarMotivo(`bloqueado: ${(envio && envio.motivo) || "desconocido"}`);
      contar("recordatorio_no_enviado");
      continue;
    }

    // ------------------------------------------------------------------
    // SOLO AHORA SE APUNTA. Ver la cabecera: si se apuntara antes del
    // envio, un interruptor apagado dejaria al cliente sin recordatorio
    // para siempre, porque el bot creeria que ya se lo mando.
    // ------------------------------------------------------------------
    try {
      conversacion.recordatorios = {
        base: recordatorios.serieDe(conversacion),
        enviados: decision.orden,
        ultimoEn: new Date(ahora).toISOString(),
      };
      atencionDeChat.anotarMensaje(conversacion, {
        de: atencionDeChat.QUIEN.BOT,
        texto: cuerpo,
        wamid: envio.wamid || null,
        estado: "enviado",
        // Para que en el panel se vea que esto NO fue una respuesta: el bot
        // escribio primero.
        por: `recordatorio_${decision.orden}`,
      });
      await repos.conversaciones.guardar(conversacion);
    } catch (e) {
      // El mensaje YA salio. Que no se pueda apuntar es un problema -puede
      // repetirse en la pasada siguiente- pero perder el registro es peor
      // que repetir, asi que se grita y se sigue.
      if (log) log.error("recordatorio_no_se_pudo_apuntar", { contactoId: conversacion.contactoId, detalle: e.message });
    }

    informe.enviados++;
    contar("recordatorio_enviado");
    if (diario) {
      diario.anotar("recordatorio_enviado", {
        idCliente: conversacion.contactoId,
        orden: decision.orden,
        silencioMin: decision.silencioMin,
        estado: conversacion.estado,
        texto: cuerpo,
      });
    }
  }

  if (log && (informe.enviados || informe.bloqueados)) {
    log.info("recordatorios_pasada", informe);
  }
  return informe;
}

/**
 * Arranca el barrido periodico. Devuelve una funcion para pararlo.
 *
 * `unref()` para que no impida apagar el proceso: en Render cada despliegue
 * manda SIGTERM, y un temporizador vivo retrasaria el apagado hasta el
 * timeout forzado.
 */
function arrancarBarrido({ config, obtenerPiezas, log, metricas, diario, cadaMs = CADA_MS }) {
  if (!config.recordatorios) {
    if (log) log.info("recordatorios_apagados", { nota: "se encienden con RECORDATORIOS=1" });
    return () => {};
  }

  let corriendo = false;
  const tic = async () => {
    // Sin solapamiento: una pasada lenta no puede arrancar la siguiente
    // encima, porque las dos mandarian el mismo recordatorio.
    if (corriendo) return;
    corriendo = true;
    try {
      const piezas = await obtenerPiezas();
      await pasada({ ...piezas, config, log, metricas, diario });
    } catch (e) {
      if (log) log.error("recordatorios_pasada_fallo", { detalle: e.message });
    } finally {
      corriendo = false;
    }
  };

  const reloj = setInterval(tic, cadaMs);
  reloj.unref();
  if (log) {
    log.info("recordatorios_encendidos", {
      cada_min: Math.round(cadaMs / 60000),
      toques_min: config.recordatorioMinutos,
      horario: `${config.recordatoriosDesdeHora}-${config.recordatoriosHastaHora} Bogota`,
    });
  }
  return () => clearInterval(reloj);
}

module.exports = { pasada, texto, arrancarBarrido, CADA_MS, POR_PASADA };
