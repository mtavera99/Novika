"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// El sistema de archivos de un Web Service de Render es EFIMERO: sin un
// disco persistente, todo lo escrito se pierde en cada despliegue y en cada
// reinicio.
//
// El fallo peligroso no es olvidarse del disco. Es declarar
// DATA_DIR=/var/data y creer que eso crea uno. Si el disco no esta montado,
// /var/data es una carpeta corriente del contenedor: se escribe bien, se lee
// bien, el nombre tranquiliza, y desaparece en el siguiente despliegue.
//
// Y lo que desaparece es la memoria de ids ya vistos. Meta reintenta durante
// 36 horas lo que no recibe un 200, asi que el reintento llega DESPUES del
// despliegue que borro la memoria, y se procesa como un mensaje nuevo.
//
// Esta bateria fija que el estado de la persistencia se COMPRUEBE y no se
// deduzca de la variable de entorno.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("./ayuda").entornoDePrueba();
const persistencia = require("../src/almacen/persistencia");

function carpetaNueva(nombre) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "novika-persist-")), nombre);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --------------------------------------------------------------------------
// Comprobacion de dispositivo
// --------------------------------------------------------------------------

test("en Render, una carpeta en el mismo sistema de archivos que el codigo es EFIMERA", () => {
  // Es el caso exacto de DATA_DIR=/var/data sin Disk montado.
  const dir = carpetaNueva("sin-disco");
  const r = persistencia.revisar(dir, { enRender: true, dirCodigo: dir });

  assert.equal(r.modo, persistencia.MODOS.EFIMERA);
  assert.equal(r.esDurable, false);
  assert.equal(r.mismoDispositivoQueElCodigo, true);
  // El motivo tiene que decir qué hacer, no solo que algo va mal.
  assert.match(r.motivo, /se borra en cada despliegue/);
  assert.match(r.motivo, /Monta un Disk/);
});

test("en Render, una carpeta en otro sistema de archivos es un disco persistente", () => {
  const r = persistencia.revisar(carpetaNueva("con-disco"), {
    enRender: true,
    // Simula que el codigo vive en otro dispositivo, como pasa con un Disk montado.
    dirCodigo: "/proc", // procfs: siempre otro dispositivo
  });

  assert.equal(r.modo, persistencia.MODOS.DISCO);
  assert.equal(r.esDurable, true);
  assert.equal(r.mismoDispositivoQueElCodigo, false);
});

test("en local no se grita: el disco de la maquina no se borra", () => {
  const dir = carpetaNueva("local");
  const r = persistencia.revisar(dir, { enRender: false, dirCodigo: dir });

  assert.equal(r.modo, persistencia.MODOS.LOCAL);
  assert.equal(r.esDurable, true);
  // Una alarma que salta siempre deja de ser una alarma.
});

/** Ruta invalida de forma portable: un archivo usado como si fuera carpeta. */
function rutaImposible() {
  const archivo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "novika-bloqueo-")), "soy-un-archivo");
  fs.writeFileSync(archivo, "x");
  return path.join(archivo, "datos"); // ENOTDIR
}

test("una carpeta imposible de comprobar se trata como efimera, no como buena", () => {
  const r = persistencia.revisar(rutaImposible(), { enRender: true });
  assert.equal(r.esDurable, false);
  assert.equal(r.modo, persistencia.MODOS.EFIMERA);
  // Ante la duda sobre la durabilidad, se asume lo peor: lo contrario deja
  // al dueno creyendo que tiene auditoria cuando no la tiene.
});

// --------------------------------------------------------------------------
// Contador de arranques: la prueba empirica
// --------------------------------------------------------------------------

test("el contador de arranques sube cuando la carpeta sobrevive", () => {
  const dir = carpetaNueva("marcador");

  assert.equal(persistencia.registrarArranque(dir).arranques, 1);
  assert.equal(persistencia.registrarArranque(dir).arranques, 2);
  const tercero = persistencia.registrarArranque(dir);
  assert.equal(tercero.arranques, 3);
  // El primer arranque se conserva: sirve para saber desde cuando hay datos.
  assert.ok(Date.parse(tercero.primerArranque) <= Date.parse(tercero.ultimoArranque));
});

test("si la carpeta se borra, el contador vuelve a 1: eso delata el disco efimero", () => {
  const dir = carpetaNueva("se-borra");

  persistencia.registrarArranque(dir);
  assert.equal(persistencia.registrarArranque(dir).arranques, 2);

  // Simula un despliegue de Render sin disco montado.
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(
    persistencia.registrarArranque(dir).arranques,
    1,
    "tras borrarse la carpeta el contador debe reiniciarse: es la señal de que el disco no persiste"
  );
});

test("un marcador corrupto no impide arrancar", () => {
  const dir = carpetaNueva("corrupto");
  fs.writeFileSync(path.join(dir, "marcador-de-disco.json"), "{no es json");

  assert.doesNotThrow(() => persistencia.registrarArranque(dir));
  assert.equal(persistencia.registrarArranque(dir).arranques >= 1, true);
});

test("registrarArranque nunca lanza, aunque la carpeta no se pueda escribir", () => {
  // Un fallo al dejar la marca no puede impedir que el bot atienda.
  assert.doesNotThrow(() => persistencia.registrarArranque(rutaImposible()));
});
