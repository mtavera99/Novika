"use strict";

// ==========================================================================
// ¿EL ALMACENAMIENTO SOBREVIVE A UN DESPLIEGUE?
//
// El sistema de archivos de un Web Service de Render es EFIMERO. La
// documentacion de Render lo dice sin rodeos: sin un disco persistente,
// cualquier cambio en los archivos locales se pierde en cada despliegue o
// reinicio.
//
// Declarar DATA_DIR=/var/data NO crea un disco. Si el disco no esta montado,
// /var/data es una carpeta corriente del contenedor: funciona, se puede
// escribir, se lee bien... y desaparece en el siguiente despliegue. El
// nombre tranquiliza y el comportamiento engana.
//
// Ese es el fallo que este modulo detecta, con dos comprobaciones
// independientes:
//
//   1. COMPROBACION DE DISPOSITIVO (inmediata)
//      Un disco montado es otro sistema de archivos. Se comparan los ids de
//      dispositivo de DATA_DIR y del codigo: si coinciden, no hay disco.
//      Verificar en vez de confiar en la variable.
//
//   2. CONTADOR DE ARRANQUES (empirica, a lo largo del tiempo)
//      Cada arranque incrementa un contador en disco. Si tras varios
//      despliegues sigue en 1, la carpeta se esta borrando. Es la prueba
//      que no admite discusion, y se ve en /health.
//
// Por que importa tanto: la deduplicacion es lo que impide procesar dos
// veces el mismo mensaje. Meta reintenta durante 36 HORAS lo que no recibe
// un 200 (su documentacion lo dice, y añade que el servidor debe encargarse
// de deduplicar). Si la memoria de ids ya vistos se borra en cada
// despliegue, el reintento que llega despues se procesa como nuevo. Hoy eso
// es responder dos veces; con pedidos, es un pedido que nadie hizo.
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");

const MODOS = {
  DISCO: "disco-persistente",
  EFIMERA: "efimera",
  LOCAL: "local",
};

/**
 * ¿Lo que escribamos en `dirDatos` sobrevive a un despliegue?
 *
 * @returns {{modo: string, esDurable: boolean, motivo: string, dirDatos: string,
 *            mismoDispositivoQueElCodigo: boolean|null, enRender: boolean}}
 */
function revisar(dirDatos, opciones = {}) {
  const enRender = opciones.enRender !== undefined ? opciones.enRender : Boolean(process.env.RENDER);
  const dirCodigo = opciones.dirCodigo || __dirname;

  let mismoDispositivo = null;
  try {
    fs.mkdirSync(dirDatos, { recursive: true });
    mismoDispositivo = fs.statSync(dirDatos).dev === fs.statSync(dirCodigo).dev;
  } catch (e) {
    return {
      modo: MODOS.EFIMERA,
      esDurable: false,
      motivo: `No se pudo comprobar ${dirDatos}: ${e.message}`,
      dirDatos,
      mismoDispositivoQueElCodigo: null,
      enRender,
    };
  }

  // En local, el disco de la maquina es durable aunque sea el mismo
  // dispositivo que el codigo. Distinguirlo evita una alarma falsa en
  // desarrollo y, mas importante, evita que la alarma real se vuelva ruido.
  if (!enRender) {
    return {
      modo: MODOS.LOCAL,
      esDurable: true,
      motivo: "Entorno local: el disco de la maquina no se borra entre reinicios.",
      dirDatos,
      mismoDispositivoQueElCodigo: mismoDispositivo,
      enRender,
    };
  }

  if (mismoDispositivo) {
    return {
      modo: MODOS.EFIMERA,
      esDurable: false,
      motivo:
        `${dirDatos} esta en el mismo sistema de archivos que el codigo: NO hay un disco montado ahi. ` +
        "En Render ese sistema de archivos se borra en cada despliegue y en cada reinicio. " +
        "Monta un Disk en ese Mount Path (render.yaml ya lo declara) y vuelve a desplegar.",
      dirDatos,
      mismoDispositivoQueElCodigo: true,
      enRender,
    };
  }

  return {
    modo: MODOS.DISCO,
    esDurable: true,
    motivo: `${dirDatos} esta en un sistema de archivos propio: hay un disco persistente montado.`,
    dirDatos,
    mismoDispositivoQueElCodigo: false,
    enRender,
  };
}

/**
 * Incrementa el contador de arranques y lo devuelve.
 *
 * La prueba empirica: si `arranques` sigue en 1 despues de varios
 * despliegues, la carpeta se esta borrando, diga lo que diga la
 * configuracion. Es el mismo razonamiento que la comprobacion de
 * dispositivo, pero medido en vez de deducido.
 *
 * Nunca lanza: un fallo aqui no puede impedir que el bot atienda.
 */
function registrarArranque(dirDatos) {
  const archivo = path.join(dirDatos, "marcador-de-disco.json");
  const ahora = new Date().toISOString();

  let previo = { arranques: 0, primerArranque: ahora };
  try {
    if (fs.existsSync(archivo)) {
      const leido = JSON.parse(fs.readFileSync(archivo, "utf8"));
      if (Number.isFinite(leido.arranques)) previo = leido;
    }
  } catch {
    // Marcador ilegible: se empieza de cero. No es critico.
  }

  const marcador = {
    arranques: previo.arranques + 1,
    primerArranque: previo.primerArranque || ahora,
    ultimoArranque: ahora,
  };

  try {
    fs.mkdirSync(dirDatos, { recursive: true });
    // tmp + rename: rename es atomico, asi que el marcador nunca queda a
    // medias si el proceso muere escribiendo.
    const tmp = `${archivo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(marcador, null, 2));
    fs.renameSync(tmp, archivo);
  } catch {
    // Sin marcador se pierde la prueba empirica, no el servicio.
  }

  return marcador;
}

module.exports = { revisar, registrarArranque, MODOS };
