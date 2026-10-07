"use strict";

// ==========================================================================
// PROCESAR EVENTOS
//
// Orden de las compuertas. El orden no es estetico: cada paso existe para
// que el siguiente no tenga que desconfiar.
//
//   1. AISLAMIENTO  - ¿es un evento del numero de NOVIKA?
//   2. CLASE        - ¿es un mensaje de un cliente o un acuse de entrega?
//   3. DEDUPLICACION- ¿ya habiamos visto este wamid?
//   4. MANEJO       - aqui entrara la conversacion (fase 2)
//
// La deduplicacion va DESPUES del aislamiento (no gastamos el id de un
// evento ajeno) y ANTES del manejo (ningun efecto se produce dos veces).
//
// Todo lo que se decide queda en el diario. Si manana la pregunta es "¿por
// que este cliente no recibio respuesta?", la respuesta tiene que estar en
// disco, no en la memoria de un proceso que ya se reinicio.
// ==========================================================================

const { config } = require("../config");
const log = require("../log");
const diario = require("../almacen/diario");
const trabajo = require("../almacen/trabajo");
const congelacion = require("../almacen/congelar");
const aislamiento = require("../aislamiento");
const metricas = require("../metricas");
const { obtenerCerebro } = require("../cerebro");
const { normalizar, CLASES } = require("./normalizar");

/**
 * Un acuse de entrega de Meta. No hay nada que contestar; se registra.
 * Un `failed` aqui es la unica forma de saber que Meta acepto un mensaje
 * con 200 y despues no lo entrego.
 */
function manejarEstado(evento) {
  diario.anotar("estado", {
    wamid: evento.wamid,
    estado: evento.estado,
    para: evento.para,
    errores: evento.errores,
    categoriaPrecio: evento.categoriaPrecio,
  });

  if (evento.estado === "failed") {
    metricas.incrementar("mensaje_no_entregado");
    log.error("mensaje_no_entregado", {
      wamid: evento.wamid,
      para: evento.para,
      errores: evento.errores,
    });
  }
}

/**
 * Mensaje de un cliente.
 *
 * FASE 1: se registra y se deja ahi. Todavia no hay catalogo con productos
 * reales, ni precios aprobados, ni guion comercial, asi que cualquier
 * respuesta automatica seria informacion inventada. El interruptor
 * RESPUESTA_AUTOMATICA existe para que el dia que haya guion se encienda sin
 * desplegar codigo nuevo.
 *
 * FASE 2 (aqui, en este orden):
 *   identificar producto (determinista, desde el catalogo y el referral)
 *   -> conversacion con IA acotada a datos autorizados
 *   -> deteccion de intencion de compra
 *   -> captura y validacion de datos del cliente
 *   -> resumen
 *   -> confirmacion inequivoca (en codigo, no en el prompt)
 *   -> guardar pedido
 */
async function manejarMensaje(evento) {
  diario.anotar("mensaje", {
    wamid: evento.wamid,
    idCliente: evento.idCliente,
    telefono: evento.telefono,
    bsuid: evento.bsuid,
    nombre: evento.nombre,
    tipoMensaje: evento.tipo,
    origenTexto: evento.origenTexto,
    // El texto se guarda completo en el diario: es la trazabilidad de la
    // conversacion y la base de cualquier auditoria posterior. El diario
    // vive en el disco privado del servicio, no en los logs del hosting.
    texto: evento.texto,
    idOpcion: evento.idOpcion || null,
    referral: evento.referral,
    contexto: evento.contexto,
    media: evento.media || null,
    ubicacion: evento.ubicacion || null,
  });

  log.info("mensaje_recibido", {
    wamid: evento.wamid,
    idCliente: evento.idCliente,
    tipoMensaje: evento.tipo,
    origenTexto: evento.origenTexto,
    texto: evento.texto,
    conReferral: Boolean(evento.referral),
  });

  // --------------------------------------------------------------------
  // MODO SOMBRA
  //
  // El mensaje real se procesa de principio a fin -producto, intencion,
  // datos, cotizacion, confirmacion, pedido- y la respuesta se PREPARA y se
  // guarda, pero no sale. Permite auditar conversaciones reales antes de
  // soltar el bot.
  //
  // El envio no se decide aqui: lo decide src/whatsapp/enviar.js, que es el
  // unico camino al exterior y empieza comprobando el interruptor. Si esta
  // comprobacion viviera aqui, cada flujo nuevo tendria que acordarse de
  // repetirla.
  // --------------------------------------------------------------------
  if (!config.modoSombra && !config.respuestaAutomatica) {
    diario.anotar("sin_responder", { wamid: evento.wamid, motivo: "modo_sombra_apagado" });
    return { accion: "registrado", respondido: false };
  }

  try {
    const cerebro = await obtenerCerebro();
    const traza = await cerebro.procesar(evento);

    if (!config.respuestaAutomatica) {
      diario.anotar("sin_responder", {
        wamid: evento.wamid,
        motivo: "respuesta_automatica_apagada",
        // Queda constancia de que SI se preparo una respuesta: es la
        // diferencia entre "el bot no supo que decir" y "el bot sabia y
        // callamos a proposito".
        respuestaPreparada: true,
        situacion: traza.respuesta && traza.respuesta.situacion,
      });
    }

    return {
      accion: "procesado",
      respondido: traza.enviada === true,
      estado: traza.estadoNuevo,
      situacion: traza.respuesta && traza.respuesta.situacion,
      pedido: traza.pedido,
    };
  } catch (e) {
    // El mensaje NO se pierde: ya esta en el diario, y el fallo tambien. Un
    // error del cerebro no puede dejar al cliente sin rastro.
    diario.anotar("fallo_del_cerebro", { wamid: evento.wamid, error: e.message, pila: e.stack });
    log.error("fallo_del_cerebro", { wamid: evento.wamid, detalle: e.message });
    metricas.incrementar("error_interno");
    // `fallo` y `error` los lee atenderEvento para dejar el trabajo
    // RECLAMABLE en vez de terminado. Sin esta senal, un turno que falla
    // queda cerrado y nadie lo vuelve a mirar.
    return { accion: "registrado", respondido: false, fallo: true, error: e.message };
  }
}

/**
 * Punto de entrada. Se llama DESPUES de haber contestado 200 a Meta y
 * DESPUES de que el evento crudo ya este en el diario.
 *
 * Nunca lanza: un evento que falla no puede arrastrar a los demas del mismo
 * lote. Y un fallo no se traga en silencio, se anota en el diario, que es lo
 * que BIKERPRO no hace (`.catch(e => console.error(...))` y el trabajo se pierde).
 */
/**
 * ADMITIR: reclama el trabajo de forma durable. SINCRONO Y ANTES DEL 200.
 *
 * --------------------------------------------------------------------------
 * EL INVARIANTE QUE SOSTIENE TODO
 * --------------------------------------------------------------------------
 *
 *   NUNCA SE CONTESTA 200 SIN QUE EL TRABAJO ESTE RECLAMADO EN DISCO.
 *
 * La primera version de la recuperacion reclamaba dentro del procesamiento
 * asincrono, es decir DESPUES del 200. Simulando un SIGKILL se vio que
 * quedaba una ventana: el proceso moria entre el acuse y el reclamo, y
 * entonces no habia registro de trabajo que recuperar. El evento estaba en
 * el diario -la evidencia- pero nada sabia que habia quedado pendiente.
 *
 * Medido: `entrada_cruda` escrito, `trabajo.jsonl` inexistente, 0 turnos
 * procesados tras el reinicio.
 *
 * El reclamo no es parte del procesamiento: es parte de PERSISTIR. Por eso
 * esta funcion es sincrona de principio a fin y se ejecuta antes del acuse.
 * Cuesta un appendFileSync de unos cientos de bytes por evento, muy por
 * debajo del margen que da Meta.
 *
 * @returns {{admitidos: Array, durable: boolean}}
 */
function admitir(cuerpo, idEntrega = null) {
  metricas.incrementar("webhook_recibido");
  const eventos = normalizar(cuerpo);
  const admitidos = [];
  let mensajes = 0;
  let sinRespaldoEnDisco = 0;

  // Se lee del disco en cada lote, sin cache: congelar es un comando de otro
  // proceso, y un valor cacheado dejaria al servicio operando con una idea
  // vieja de la realidad.
  const { congelado } = congelacion.estado(config.dirDatos);

  for (const evento of eventos) {
    // Aislamiento. Se evalua aqui porque es sincrono y porque no tiene
    // sentido reclamar trabajo de un numero que no es el nuestro.
    const propio = aislamiento.eventoEsDeNovika(evento, config.idNumero);
    if (!propio.ok) {
      metricas.incrementar("numero_ajeno");
      diario.anotar("evento_ajeno", {
        idEntrega,
        idNumeroDelEvento: evento.idNumero,
        idNumeroDeNovika: config.idNumero,
        wamid: evento.wamid,
      });
      log.error("evento_de_otro_numero", {
        detalle:
          "Llego un evento de un phone_number_id que no es el de NOVIKA. Revisa que no haya dos apps de Meta apuntando a este webhook.",
        idNumeroDelEvento: evento.idNumero,
      });
      continue;
    }

    // Solo los mensajes se reclaman. Un acuse de entrega no se reprocesa:
    // no tiene efectos que puedan quedar a medias.
    if (evento.clase !== CLASES.MENSAJE) {
      admitidos.push({ evento, reclamo: null });
      continue;
    }

    mensajes++;
    // `diferido` se decide AQUI, en la misma escritura que el reclamo. Si se
    // marcara despues, habria un instante en el que el registro parece un
    // turno en vuelo, y el cutover se negaria sin motivo.
    const reclamo = trabajo.reclamar(evento.wamid, { evento, diferido: congelado });

    // El unico caso malo es "aceptamos trabajo nuevo y no pudimos
    // anotarlo". Un reclamo RECHAZADO (terminado, en curso, agotado) si es
    // durable: significa que ya sabemos de ese evento, y saberlo es
    // exactamente lo que hace falta para no perderlo.
    //
    // La primera version contaba cualquier rechazo como "no durable", y un
    // replay normal de Meta -que siempre se rechaza por "terminado"- se
    // respondia con 503. Eso le dice a Meta que reintente algo que ya esta
    // hecho, y un 5xx repetido acaba desactivando la suscripcion.
    //
    // ESTA COMPROBACION VA ANTES DE LA RAMA DE CONGELACION, no despues.
    // Estaba despues, y el `continue` de la rama congelada se la saltaba:
    // congelado + disco que no acepta la escritura devolvia durable:true y
    // se contestaba 200 sin respaldo. El mensaje quedaba sin rastro y sin
    // nadie que lo reclamara. La congelacion no exime de tener respaldo:
    // precisamente lo que hace que congelar no cueste ventas es que el
    // trabajo SI esta en el disco.
    if (reclamo.ok && reclamo.persistido === false) sinRespaldoEnDisco++;

    // CONGELADO: se reclama igual -el trabajo queda en el disco y no se
    // pierde- pero NO se procesa. Un evento reclamado y sin terminar es
    // exactamente lo que el recuperador busca al arrancar, asi que al
    // descongelar y reiniciar estos mensajes se procesan solos.
    //
    // Se contesta 200 a Meta de todas formas: devolver 503 habria
    // funcionado -Meta reintenta 36 horas- pero convertiria una operacion
    // controlada en una carrera contra un reloj ajeno.
    if (reclamo.ok && congelado) {
      diario.anotar("diferido_por_congelacion", { idEntrega, wamid: evento.wamid });
      metricas.incrementar("evento_diferido");
      admitidos.push({ evento, reclamo, diferido: true });
      continue;
    }

    admitidos.push({ evento, reclamo });
  }

  const durable = sinRespaldoEnDisco === 0;
  return { admitidos, durable, mensajes, sinRespaldoEnDisco, congelado };
}

/** Procesa lo ya admitido. Asincrono, DESPUES del 200. */
async function procesarAdmitidos(admitidos, idEntrega = null) {
  const resultados = [];
  for (const { evento, reclamo, diferido } of admitidos) {
    if (diferido) {
      // Reclamado pero no procesado: queda pendiente a proposito. NO se
      // llama a trabajo.terminar(), que es lo que lo deja recuperable.
      resultados.push({ wamid: evento.wamid, accion: "diferido" });
      continue;
    }
    resultados.push(await atenderEvento(evento, { idEntrega, reclamoPrevio: reclamo }));
  }
  return resultados;
}

/**
 * Camino completo: admitir y procesar. Lo usan la recuperacion y las
 * pruebas; el webhook los separa para poder contestar 200 en medio.
 */
async function procesar(cuerpo, idEntrega = null) {
  const { admitidos } = admitir(cuerpo, idEntrega);
  return procesarAdmitidos(admitidos, idEntrega);
}

/**
 * Atiende UN evento. Es el unico camino de procesamiento, y lo usan tanto el
 * webhook como el recuperador de arranque.
 *
 * Que compartan funcion no es ahorro de lineas: es la garantia de que un
 * evento recuperado se procesa EXACTAMENTE igual que uno recien llegado. Dos
 * caminos distintos divergen, y el que casi nunca se ejecuta es el que acaba
 * roto sin que nadie lo note.
 *
 * ORDEN CRITICO:
 *
 *   1. reclamar  -> escritura durable: "estoy procesando este wamid"
 *   2. manejar
 *   3. terminar  -> escritura durable: "ya esta"
 *
 * Si el proceso muere entre 1 y 3, el registro se queda en `reclamado`, y eso
 * es precisamente lo que el recuperador busca al arrancar. La version
 * anterior marcaba el wamid como visto en el paso 1 y no tenia paso 3: un
 * crash dejaba el mensaje registrado y sin procesar para siempre, y el
 * propio candado antiduplicados impedia recuperarlo.
 *
 * @param {object} evento  evento normalizado
 * @param {object} opciones
 * @param {boolean} [opciones.enRecuperacion]
 */
async function atenderEvento(evento, { idEntrega = null, enRecuperacion = false, reclamoPrevio = null } = {}) {
  try {
    // 1. Aislamiento. En el camino del webhook ya lo comprobo admitir(); se
    //    repite porque la recuperacion entra por aqui directamente y un
    //    candado que depende de quien llame no es un candado.
    const propio = aislamiento.eventoEsDeNovika(evento, config.idNumero);
    if (!propio.ok) {
      diario.anotar("evento_ajeno", {
        idEntrega,
        idNumeroDelEvento: evento.idNumero,
        idNumeroDeNovika: config.idNumero,
        wamid: evento.wamid,
      });
      metricas.incrementar("numero_ajeno");
      log.error("evento_de_otro_numero", {
        detalle:
          "Llego un evento de un phone_number_id que no es el de NOVIKA. Revisa que no haya dos apps de Meta apuntando a este webhook.",
        idNumeroDelEvento: evento.idNumero,
      });
      return { wamid: evento.wamid, accion: "descartado_ajeno" };
    }

    // 2. Clase
    if (evento.clase === CLASES.ESTADO) {
      metricas.incrementar("estado_recibido");
      manejarEstado(evento);
      return { wamid: evento.wamid, accion: "estado" };
    }

    if (evento.clase === CLASES.DESCONOCIDO) {
      diario.anotar("evento_desconocido", { idEntrega, claves: evento.claves, campo: evento.campo });
      return { accion: "desconocido" };
    }

    // 2.b CONGELACION. Va AQUI, y no solo en admitir(), por dos razones.
    //
    // La primera es que la recuperacion de arranque entra por esta funcion
    // directamente, sin pasar por admitir(). Con la compuerta solo en
    // admitir(), un reinicio durante el cutover -y un disco persistente en
    // Render hace que cada despliegue sea un reinicio- procesaba los
    // mensajes diferidos CONTRA EL ORIGEN QUE SE ESTA COPIANDO y los
    // marcaba como terminados. La congelacion dejaba de ser una compuerta y
    // pasaba a ser un retraso de un reinicio, que es justo lo que no es.
    //
    // La segunda es la regla que ya aplica el aislamiento unas lineas mas
    // arriba: un candado que depende de quien llame no es un candado.
    //
    // Va DESPUES de la clase -un acuse de entrega no escribe en el almacen
    // transaccional, y un `failed` perdido no se recupera de ningun sitio- y
    // ANTES del reclamo, para no consumir un intento. Consumirlo seria
    // fatal: tres reinicios durante un cutover agotarian el mensaje y lo
    // dejarian fuera para siempre, sin haberlo intentado ni una vez.
    if (congelacion.estado(config.dirDatos).congelado) {
      // Si ya habia un registro reclamado, se marca diferido: deja de
      // contar como turno en vuelo para el cutover, sin dejar de ser
      // recuperable. No consume intentos.
      trabajo.diferir(evento.wamid);
      diario.anotar("diferido_por_congelacion", { idEntrega, wamid: evento.wamid, enRecuperacion });
      metricas.incrementar("evento_diferido");
      return { wamid: evento.wamid, accion: "diferido" };
    }

    // 3. Reclamo. Si viene del webhook ya se hizo ANTES del 200; si no, se
    //    hace aqui (recuperacion y pruebas).
    const reclamo = reclamoPrevio || trabajo.reclamar(evento.wamid, { evento, enRecuperacion });
    if (!reclamo.ok) {
      metricas.incrementar("duplicado_descartado");
      diario.anotar("duplicado_descartado", {
        idEntrega,
        wamid: evento.wamid,
        // El motivo distingue tres cosas muy distintas: ya se termino, se
        // esta procesando ahora mismo, o se agotaron los reintentos.
        motivo: reclamo.motivo,
        intentos: reclamo.intentos,
      });
      log.warn("duplicado_descartado", { wamid: evento.wamid, motivo: reclamo.motivo });
      return { wamid: evento.wamid, accion: "duplicado", motivo: reclamo.motivo };
    }

    // 4. Manejo
    metricas.incrementar("mensaje_valido");
    if (enRecuperacion) metricas.incrementar("evento_recuperado");

    const r = await manejarMensaje(evento);

    // 5. Cierre durable.
    //
    // UN TURNO QUE FALLO NO ESTA TERMINADO. manejarMensaje() captura la
    // excepcion del cerebro para poder anotarla en el diario con su pila, y
    // devuelve `fallo:true`. La version anterior llamaba a terminar() de
    // todas formas, asi que el evento quedaba cerrado sin haberse
    // procesado: no se recuperaba (terminado no se reintenta), no se agotaba
    // (nunca llegaba a agotarse) y no aparecia en ninguna lista que alguien
    // mirara. Desaparecia en silencio, que es exactamente el modo de fallo
    // que esta bitacora existe para impedir.
    //
    // fallar() lo deja RECLAMADO -recuperable en el proximo arranque- y lo
    // pasa a AGOTADO al llegar a MAX_INTENTOS, que es lo que evita que un
    // mensaje que rompe el cerebro de forma determinista gire para siempre.
    if (r.fallo) {
      trabajo.fallar(evento.wamid, r.error || "fallo al manejar el mensaje");
    } else {
      // Desde aqui, este wamid no vuelve a ejecutarse.
      trabajo.terminar(evento.wamid, { accion: r.accion, situacion: r.situacion || null });
    }

    return { wamid: evento.wamid, ...r, intentos: reclamo.intentos };
  } catch (e) {
    metricas.incrementar("error_interno");
    // El registro se queda reclamable: el proximo arranque lo reintenta.
    trabajo.fallar(evento.wamid, e.message);
    diario.anotar("fallo_al_procesar", {
      idEntrega,
      wamid: evento.wamid,
      enRecuperacion,
      error: e.message,
      pila: e.stack,
    });
    log.error("fallo_al_procesar", { wamid: evento.wamid, detalle: e.message });
    return { wamid: evento.wamid, accion: "fallo" };
  }
}

module.exports = { procesar, admitir, procesarAdmitidos, atenderEvento, manejarMensaje, manejarEstado };
