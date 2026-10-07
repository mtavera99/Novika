"use strict";

// ==========================================================================
// BITACORA DE TRABAJO
//
// Sustituye a la memoria de "ids ya vistos". El cambio no es de nombre: es
// de semantica, y viene de un agujero real que se encontro simulando un
// crash con SIGKILL.
//
// --------------------------------------------------------------------------
// EL AGUJERO QUE CIERRA
// --------------------------------------------------------------------------
//
// La version anterior marcaba el wamid como "visto" AL LLEGAR y despues
// procesaba. Si el proceso moria en medio -un despliegue de Render, un OOM,
// un SIGKILL- pasaba esto:
//
//   1. el evento quedaba en el diario (la evidencia se salvaba);
//   2. Meta ya tenia su 200, asi que NO reintentaba;
//   3. al reiniciar, nada volvia a mirar ese evento;
//   4. y si Meta hubiera reintentado, el wamid ya estaba marcado:
//      se descartaba como duplicado.
//
// Resultado medido: el mensaje de un cliente quedaba registrado y SIN
// PROCESAR para siempre, y el propio candado antiduplicados impedia
// recuperarlo. Desde fuera era indistinguible de "ese cliente no escribio".
//
// --------------------------------------------------------------------------
// LA CORRECCION
// --------------------------------------------------------------------------
//
// "Visto" no es un estado util. Los estados utiles son tres:
//
//   reclamado  -> alguien empezo a procesarlo y no ha terminado
//   terminado  -> se proceso completo. Este es el candado antiduplicados.
//   agotado    -> se intento MAX_INTENTOS veces y sigue fallando
//
// Con eso, un registro que sigue en `reclamado` al arrancar significa
// exactamente una cosa: el proceso murio procesandolo. Y entonces se
// reprocesa, sin depender de que Meta reintente.
//
// La distincion clave: DEDUPLICAR POR "TERMINADO", NO POR "VISTO". Un evento
// visto a medias no es un duplicado: es trabajo pendiente.
//
// --------------------------------------------------------------------------
// POR QUE ES SEGURO REPROCESAR
// --------------------------------------------------------------------------
//
// Porque el pedido es idempotente aguas abajo: claveDeEvento se deriva del
// wamid, asi que un replay del mismo evento produce la misma clave y
// crearSiNoExiste lo rechaza. Reprocesar no puede crear un segundo pedido.
//
// Y los envios no son un riesgo mientras el interruptor este apagado:
// src/whatsapp/enviar.js es el unico camino al exterior y lo comprueba.
//
// --------------------------------------------------------------------------
// DURABILIDAD
// --------------------------------------------------------------------------
//
// Archivo append-only (.jsonl) con una linea por transicion, e indice en
// memoria reconstruido al arrancar. Append-only y no reescritura porque lo
// ya escrito no se puede perder si el proceso muere: es justo el escenario
// para el que existe este modulo.
//
// reclamar() es SINCRONO de principio a fin, sin un solo `await`. Eso lo
// hace atomico en Node: dos entregas del mismo wamid no pueden entrelazarse
// entre la comprobacion y la escritura.
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");
const { config } = require("../config");
const log = require("../log");

const ARCHIVO = path.join(config.dirDatos, "trabajo.jsonl");

const ESTADOS = {
  RECLAMADO: "reclamado",
  TERMINADO: "terminado",
  AGOTADO: "agotado",
};

/**
 * Intentos antes de rendirse.
 *
 * Un tope es obligatorio: un mensaje que hace fallar al cerebro de forma
 * determinista entraria en un bucle infinito de recuperaciones, y cada
 * reinicio lo volveria a intentar. Al agotarse se grita en el log y queda en
 * el diario, para que una persona lo mire.
 */
const MAX_INTENTOS = 3;

/**
 * Cuanto se recuerda un evento terminado.
 *
 * 7 dias, no 36 horas. Meta reintenta durante 36 horas lo que no recibe un
 * 200, asi que 7 dias cubren esa ventana con holgura y dejan margen para un
 * fin de semana con incidencias.
 */
const DIAS_QUE_SE_RECUERDAN = 7;
const MS_QUE_SE_RECUERDAN = DIAS_QUE_SE_RECUERDAN * 24 * 60 * 60 * 1000;

/** @type {Map<string, object>|null} wamid -> registro */
let indice = null;

function asegurarCarpeta() {
  fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
}

function anotarLinea(registro) {
  try {
    asegurarCarpeta();
    fs.appendFileSync(ARCHIVO, `${JSON.stringify(registro)}\n`);
    return true;
  } catch (e) {
    log.error("trabajo_no_escribio", { detalle: e.message });
    return false;
  }
}

function cargar() {
  if (indice) return indice;
  indice = new Map();

  try {
    asegurarCarpeta();
    if (!fs.existsSync(ARCHIVO)) return indice;

    const corte = Date.now() - MS_QUE_SE_RECUERDAN;
    const lineas = fs.readFileSync(ARCHIVO, "utf8").split("\n").filter(Boolean);
    let descartadas = 0;

    for (const linea of lineas) {
      let r;
      try {
        r = JSON.parse(linea);
      } catch {
        descartadas++;
        continue;
      }
      if (!r || !r.wamid) continue;

      // Un terminado viejo ya no hace falta recordarlo. Un RECLAMADO viejo
      // SI se conserva, por antiguo que sea: es trabajo que quedo a medias y
      // perderlo es perder el mensaje de un cliente.
      if (r.estado === ESTADOS.TERMINADO && Number(r.actualizadoEn || 0) < corte) {
        descartadas++;
        continue;
      }
      // La ultima linea de un wamid es su estado actual.
      indice.set(r.wamid, r);
    }

    if (descartadas > 0) {
      compactar();
      log.info("trabajo_compactado", { quedan: indice.size, descartados: descartadas });
    }
  } catch (e) {
    // Si el indice no se puede leer se arranca vacio. La consecuencia es que
    // un evento ya terminado podria reprocesarse; eso es inofensivo, porque
    // el pedido es idempotente. La alternativa -no arrancar- pierde TODOS
    // los mensajes, no uno.
    log.error("trabajo_no_cargo", { detalle: e.message });
    indice = new Map();
  }
  return indice;
}

function compactar() {
  try {
    const texto = [...indice.values()].map((r) => JSON.stringify(r)).join("\n");
    const tmp = `${ARCHIVO}.tmp`;
    fs.writeFileSync(tmp, texto ? `${texto}\n` : "");
    fs.renameSync(tmp, ARCHIVO); // rename es atomico: nunca queda a medias
  } catch (e) {
    log.error("trabajo_no_compacto", { detalle: e.message });
  }
}

/**
 * Reclama un evento para procesarlo.
 *
 * SINCRONO A PROPOSITO, sin un solo await: comprobar y escribir tiene que
 * ser indivisible. Si hubiera un await en medio, dos entregas del mismo
 * wamid podrian reclamarlo las dos.
 *
 * @param {string} wamid
 * @param {object} opciones
 * @param {object} [opciones.evento]          evento normalizado, para poder reprocesarlo
 * @param {boolean} [opciones.enRecuperacion] true solo cuando llama el recuperador
 * @returns {{ok: boolean, motivo: string, intentos: number, evento?: object}}
 */
function reclamar(wamid, { evento = null, enRecuperacion = false } = {}) {
  if (!wamid) {
    // Sin wamid no se puede deduplicar ni recuperar. Se deja pasar -el
    // mensaje de un cliente no se tira por un id que falta- pero no se
    // registra como trabajo.
    return { ok: true, motivo: "sin_wamid", intentos: 0 };
  }

  const mapa = cargar();
  const previo = mapa.get(wamid);
  const ahora = Date.now();

  if (previo) {
    if (previo.estado === ESTADOS.TERMINADO) {
      // EL CANDADO ANTIDUPLICADOS. Un evento terminado no vuelve a
      // ejecutarse nunca, venga de donde venga.
      return { ok: false, motivo: "terminado", intentos: previo.intentos || 1 };
    }
    if (previo.estado === ESTADOS.AGOTADO) {
      return { ok: false, motivo: "agotado", intentos: previo.intentos || MAX_INTENTOS };
    }
    if (previo.estado === ESTADOS.RECLAMADO && !enRecuperacion) {
      // Otra entrega del mismo evento mientras se esta procesando. No es
      // trabajo nuevo: es el mismo, en curso.
      return { ok: false, motivo: "en_curso", intentos: previo.intentos || 1 };
    }

    // Reclamado + en recuperacion = el proceso murio procesandolo.
    const intentos = (previo.intentos || 1) + 1;
    if (intentos > MAX_INTENTOS) {
      const agotado = { ...previo, estado: ESTADOS.AGOTADO, intentos, actualizadoEn: ahora };
      mapa.set(wamid, agotado);
      anotarLinea(agotado);
      return { ok: false, motivo: "agotado", intentos };
    }

    const reclamado = {
      ...previo,
      estado: ESTADOS.RECLAMADO,
      intentos,
      actualizadoEn: ahora,
      // El evento se conserva del registro original: en recuperacion no hay
      // nadie que lo vuelva a traer.
      evento: previo.evento || evento,
    };
    mapa.set(wamid, reclamado);
    const persistido = anotarLinea(reclamado);
    // SI NO LLEGO AL DISCO, NO OCURRIO. Ver la nota de abajo: dejar el
    // indice avanzado sin respaldo en disco rompe la retransmision.
    if (!persistido) mapa.set(wamid, previo);
    return { ok: true, motivo: "recuperado", intentos, evento: reclamado.evento, persistido };
  }

  const nuevo = {
    wamid,
    estado: ESTADOS.RECLAMADO,
    intentos: 1,
    creadoEn: ahora,
    actualizadoEn: ahora,
    // Se guarda el evento NORMALIZADO para que la recuperacion sea
    // autosuficiente: no tiene que volver a parsear el diario ni depender de
    // que Meta reenvie nada.
    evento,
  };
  const mapaNuevo = cargar();
  mapaNuevo.set(wamid, nuevo);
  // `persistido` le dice a quien llama si el reclamo llego al disco. Importa
  // porque el webhook NO debe contestar 200 si no puede garantizar que el
  // mensaje se podria recuperar: es mejor que Meta reintente.
  const persistido = anotarLinea(nuevo);

  // ----------------------------------------------------------------------
  // SI NO LLEGO AL DISCO, SE DESHACE EN MEMORIA.
  //
  // Esto cierra el peor de los agujeros encontrados en 5649e27, y era
  // invisible porque cada pieza se comportaba "bien" por separado:
  //
  //   1. la escritura falla  -> persistido:false
  //   2. el webhook responde 503 (correcto: sin disco no hay recuperacion)
  //   3. Meta retransmite    (correcto: para eso es el 503)
  //   4. pero el registro SEGUIA en el indice en memoria, asi que la
  //      retransmision se veia "en_curso" y se descartaba como duplicado
  //   5. y al descartarla se contestaba 200
  //
  // Resultado: nada en disco, nadie procesandolo, y Meta convencida de que
  // el mensaje se entrego. El mensaje se perdia POR el mecanismo que existe
  // para rescatarlo.
  //
  // La regla correcta es mas simple que el sintoma: un reclamo que no esta
  // en disco no es un reclamo. Si se pide 503 para que lo reintenten, hay
  // que poder aceptar el reintento.
  // ----------------------------------------------------------------------
  if (!persistido) mapaNuevo.delete(wamid);

  return { ok: true, motivo: "nuevo", intentos: 1, evento, persistido };
}

/** Marca un evento como procesado por completo. Es lo que cierra el candado. */
function terminar(wamid, resumen = null) {
  if (!wamid) return false;
  const mapa = cargar();
  const previo = mapa.get(wamid) || { wamid, intentos: 1, creadoEn: Date.now() };

  const terminado = {
    wamid,
    estado: ESTADOS.TERMINADO,
    intentos: previo.intentos || 1,
    creadoEn: previo.creadoEn,
    actualizadoEn: Date.now(),
    resumen,
    // El evento ya no hace falta: no se va a reprocesar. Dejar de guardarlo
    // tambien quita del disco una copia del mensaje del cliente.
    evento: null,
  };
  mapa.set(wamid, terminado);
  return anotarLinea(terminado);
}

/**
 * Marca un intento fallido. El registro sigue reclamable, asi que el
 * siguiente arranque lo reintenta.
 */
function fallar(wamid, error = null) {
  if (!wamid) return false;
  const mapa = cargar();
  const previo = mapa.get(wamid);
  if (!previo) return false;

  const intentos = previo.intentos || 1;
  const estado = intentos >= MAX_INTENTOS ? ESTADOS.AGOTADO : ESTADOS.RECLAMADO;

  const actualizado = {
    ...previo,
    estado,
    intentos,
    actualizadoEn: Date.now(),
    ultimoError: error ? String(error).slice(0, 300) : null,
  };
  mapa.set(wamid, actualizado);
  return anotarLinea(actualizado);
}

/**
 * Eventos que quedaron a medias y hay que reprocesar.
 *
 * Son los que estan en RECLAMADO: si el proceso hubiera terminado con ellos,
 * estarian en TERMINADO. Que siga habiendo alguno al arrancar es, por
 * definicion, trabajo interrumpido.
 */
function paraRecuperar() {
  return [...cargar().values()]
    .filter((r) => r.estado === ESTADOS.RECLAMADO && (r.intentos || 1) <= MAX_INTENTOS && r.evento)
    .sort((a, b) => (a.creadoEn || 0) - (b.creadoEn || 0));
}

/** Los que se rindieron. Hay que mirarlos a mano. */
function agotados() {
  return [...cargar().values()].filter((r) => r.estado === ESTADOS.AGOTADO);
}

function estado() {
  const todos = [...cargar().values()];
  const porEstado = {};
  for (const r of todos) porEstado[r.estado] = (porEstado[r.estado] || 0) + 1;
  return {
    total: todos.length,
    reclamados: porEstado[ESTADOS.RECLAMADO] || 0,
    terminados: porEstado[ESTADOS.TERMINADO] || 0,
    agotados: porEstado[ESTADOS.AGOTADO] || 0,
  };
}

/** Solo para pruebas: vacia el indice en memoria y el archivo. */
function _reiniciar() {
  indice = null;
  try {
    if (fs.existsSync(ARCHIVO)) fs.rmSync(ARCHIVO);
  } catch {
    /* ignorado */
  }
}

/** Solo para pruebas: simula el reinicio del proceso sin borrar el disco. */
function _olvidarMemoria() {
  indice = null;
}

module.exports = {
  ESTADOS,
  MAX_INTENTOS,
  DIAS_QUE_SE_RECUERDAN,
  ARCHIVO,
  reclamar,
  terminar,
  fallar,
  paraRecuperar,
  agotados,
  estado,
  _reiniciar,
  _olvidarMemoria,
};
