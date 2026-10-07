"use strict";

// ==========================================================================
// BITACORA DE TRABAJO: CRASH Y RECUPERACION
//
// Esta bateria existe por un agujero real, encontrado simulando un SIGKILL
// contra el servidor de verdad:
//
//   1. Meta enviaba un mensaje
//   2. NOVIKA lo persistia en el diario
//   3. NOVIKA contestaba 200
//   4. el proceso moria ANTES de que el cerebro terminara
//   5. Render reiniciaba
//   -> el mensaje quedaba registrado y SIN PROCESAR para siempre
//
// Y habia una segunda capa del problema: el wamid ya figuraba como "visto",
// asi que una retransmision hipotetica de Meta tambien se descartaba. El
// propio candado antiduplicados impedia la recuperacion.
//
// Medido antes del arreglo:
//   turno_procesado: 0 · duplicado_descartado: 1
//
// La correccion: deduplicar por TERMINADO, no por VISTO. Un evento visto a
// medias no es un duplicado, es trabajo pendiente.
//
// Incluye las aserciones que antes vivian en test/vistos.test.js, porque ese
// modulo quedo sustituido: tener dos mecanismos de deduplicacion y solo uno
// con autoridad es como se acaba con dos fuentes de verdad.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();
const trabajo = require("../src/almacen/trabajo");

const evento = (wamid) => ({ clase: "mensaje", wamid, idCliente: "573001234567", texto: "hola" });

// --------------------------------------------------------------------------
// Lo que heredamos de la deduplicacion anterior
// --------------------------------------------------------------------------

test("un evento nuevo se reclama; el mismo, mientras se procesa, no", () => {
  trabajo._reiniciar();
  assert.equal(trabajo.reclamar("wamid.A", { evento: evento("wamid.A") }).ok, true);
  const segundo = trabajo.reclamar("wamid.A", { evento: evento("wamid.A") });
  assert.equal(segundo.ok, false);
  assert.equal(segundo.motivo, "en_curso");
});

test("un evento TERMINADO no vuelve a ejecutarse nunca", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.B", { evento: evento("wamid.B") });
  trabajo.terminar("wamid.B");

  const otra = trabajo.reclamar("wamid.B", { evento: evento("wamid.B") });
  assert.equal(otra.ok, false);
  assert.equal(otra.motivo, "terminado");

  // Ni siquiera en recuperacion: terminado es terminado.
  const enRecuperacion = trabajo.reclamar("wamid.B", { evento: evento("wamid.B"), enRecuperacion: true });
  assert.equal(enRecuperacion.ok, false);
  assert.equal(enRecuperacion.motivo, "terminado");
});

test("eventos distintos no se estorban", () => {
  trabajo._reiniciar();
  assert.equal(trabajo.reclamar("wamid.X", { evento: evento("wamid.X") }).ok, true);
  assert.equal(trabajo.reclamar("wamid.Y", { evento: evento("wamid.Y") }).ok, true);
  assert.equal(trabajo.estado().total, 2);
});

test("un evento sin wamid se deja pasar: no se tira el mensaje de un cliente", () => {
  trabajo._reiniciar();
  const r = trabajo.reclamar(null, {});
  assert.equal(r.ok, true);
  assert.equal(r.motivo, "sin_wamid");
  assert.equal(trabajo.estado().total, 0);
});

test("el candado sobrevive al reinicio del proceso", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.PERSISTE", { evento: evento("wamid.PERSISTE") });
  trabajo.terminar("wamid.PERSISTE");

  trabajo._olvidarMemoria(); // el proceso se reinicia; el disco se queda

  const otra = trabajo.reclamar("wamid.PERSISTE", { evento: evento("wamid.PERSISTE") });
  assert.equal(otra.ok, false, "tras reiniciar, un evento terminado se volvio a procesar");
  assert.equal(otra.motivo, "terminado");
});

test("una linea corrupta no impide arrancar", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.BUENO", { evento: evento("wamid.BUENO") });
  trabajo.terminar("wamid.BUENO");
  fs.appendFileSync(trabajo.ARCHIVO, "no es json\n");

  trabajo._olvidarMemoria();
  assert.equal(trabajo.reclamar("wamid.BUENO", {}).motivo, "terminado");
});

// --------------------------------------------------------------------------
// CRASH: LO NUEVO
// --------------------------------------------------------------------------

test("CRASH tras persistir: el evento queda reclamado, no perdido", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.CRASH", { evento: evento("wamid.CRASH") });
  // El proceso muere aqui: nunca se llama a terminar().

  trabajo._olvidarMemoria();

  const pendientes = trabajo.paraRecuperar();
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].wamid, "wamid.CRASH");
  // Y el evento viaja con el registro, para que la recuperacion sea
  // autosuficiente: no depende de que Meta reenvie nada.
  assert.equal(pendientes[0].evento.texto, "hola");
});

test("un evento terminado NO aparece como pendiente", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.T", { evento: evento("wamid.T") });
  trabajo.terminar("wamid.T");
  trabajo._olvidarMemoria();
  assert.deepEqual(trabajo.paraRecuperar(), []);
});

test("en recuperacion SI se puede reclamar lo que quedo a medias", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.R", { evento: evento("wamid.R") });
  trabajo._olvidarMemoria();

  const r = trabajo.reclamar("wamid.R", { enRecuperacion: true });
  assert.equal(r.ok, true);
  assert.equal(r.motivo, "recuperado");
  assert.equal(r.intentos, 2);
  assert.ok(r.evento, "el evento tiene que venir con el reclamo");
});

test("un fallo deja el evento reclamable para el siguiente arranque", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.F", { evento: evento("wamid.F") });
  trabajo.fallar("wamid.F", "el cerebro revento");

  trabajo._olvidarMemoria();
  assert.equal(trabajo.paraRecuperar().length, 1);
});

test("tras MAX_INTENTOS se agota y deja de reintentarse", () => {
  // Sin tope, un mensaje que rompe el cerebro de forma determinista se
  // reintentaria en cada arranque para siempre.
  trabajo._reiniciar();
  trabajo.reclamar("wamid.VENENO", { evento: evento("wamid.VENENO") });

  for (let i = 0; i < trabajo.MAX_INTENTOS + 2; i++) {
    trabajo._olvidarMemoria();
    const r = trabajo.reclamar("wamid.VENENO", { enRecuperacion: true });
    if (!r.ok) {
      assert.equal(r.motivo, "agotado");
      break;
    }
    trabajo.fallar("wamid.VENENO", "sigue fallando");
  }

  trabajo._olvidarMemoria();
  assert.equal(trabajo.reclamar("wamid.VENENO", { enRecuperacion: true }).motivo, "agotado");
  assert.deepEqual(trabajo.paraRecuperar(), []);
  // Pero NO se olvida: queda listado para que una persona lo mire.
  assert.equal(trabajo.agotados().length, 1);
});

test("un reclamado antiguo NO se descarta por viejo", () => {
  // Los terminados viejos se pueden olvidar. Los reclamados no: por antiguo
  // que sea, es el mensaje de un cliente que nunca se atendio.
  trabajo._reiniciar();
  const hace30Dias = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(
    trabajo.ARCHIVO,
    `${JSON.stringify({ wamid: "wamid.VIEJO", estado: "reclamado", intentos: 1, creadoEn: hace30Dias, actualizadoEn: hace30Dias, evento: evento("wamid.VIEJO") })}\n` +
      `${JSON.stringify({ wamid: "wamid.TERMINADO_VIEJO", estado: "terminado", intentos: 1, creadoEn: hace30Dias, actualizadoEn: hace30Dias })}\n`
  );

  trabajo._olvidarMemoria();
  const pendientes = trabajo.paraRecuperar();
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].wamid, "wamid.VIEJO");
  // Y el terminado viejo si se olvido.
  assert.equal(trabajo.reclamar("wamid.TERMINADO_VIEJO", { evento: {} }).ok, true);
});

test("terminar borra el evento del registro: una copia menos del mensaje en disco", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.PII", { evento: { wamid: "wamid.PII", texto: "soy Ana y vivo en la Calle 45" } });
  trabajo.terminar("wamid.PII");

  const contenido = fs.readFileSync(trabajo.ARCHIVO, "utf8");
  const lineas = contenido.split("\n").filter(Boolean).map(JSON.parse);
  const ultima = lineas[lineas.length - 1];
  assert.equal(ultima.estado, "terminado");
  assert.equal(ultima.evento, null, "el evento sigue guardado en un registro ya terminado");
});

test("reclamar es sincrono: comprobar y escribir no se pueden entrelazar", () => {
  // Si reclamar() tuviera un await en medio, dos entregas del mismo wamid
  // podrian reclamarlo las dos. Que sea sincrono lo hace atomico en Node.
  trabajo._reiniciar();
  const resultados = [];
  for (let i = 0; i < 10; i++) {
    resultados.push(trabajo.reclamar("wamid.CARRERA", { evento: evento("wamid.CARRERA") }));
  }
  assert.equal(resultados.filter((r) => r.ok).length, 1);
});

test("estado() cuenta por estado, sin exponer contenido", () => {
  trabajo._reiniciar();
  trabajo.reclamar("wamid.1", { evento: evento("wamid.1") });
  trabajo.reclamar("wamid.2", { evento: evento("wamid.2") });
  trabajo.terminar("wamid.2");

  const e = trabajo.estado();
  assert.equal(e.total, 2);
  assert.equal(e.reclamados, 1);
  assert.equal(e.terminados, 1);
  // Solo numeros: se puede exponer en /health sin filtrar nada.
  assert.equal(JSON.stringify(e).includes("hola"), false);
});
