"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Las plantillas y los documentos son el camino NORMAL de los dos mensajes
// mas valiosos del negocio, no una excepcion:
//
//   · la guia sale al dia siguiente de la compra
//   · la novedad de entrega llega 1 a 3 dias despues
//
// Los dos caen fuera de la ventana de 24 h de Meta, donde lo unico que Meta
// entrega son plantillas aprobadas. Con texto libre responde 131047 y el
// cliente no recibe nada.
//
// Lo que estas pruebas vigilan:
//
//   EL CANDADO SIGUE PUESTO. Se acaban de anadir tres caminos de salida
//   nuevos -plantilla, documento, subida de media-. Si alguno se salta el
//   interruptor, el panel se convierte en una puerta abierta a mandar
//   WhatsApps reales sin haberlo decidido. Es justo el riesgo que la
//   convencion del proyecto nombra: "el candado vive en el unico camino al
//   exterior, no en la capa de arriba".
//
//   NO SE SUBE UN PDF QUE NO SE VA A PODER ENVIAR. Subir primero y
//   comprobar despues gasta una llamada y deja un mediaId huerfano en Meta.
//
//   es_CO, NO es. Para Meta son dos traducciones distintas: con "es"
//   rechaza con 132001 aunque la plantilla este aprobada, y el mensaje de
//   error habla del NOMBRE, asi que se busca el fallo donde no esta.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const { crearEmisor, PERMISOS, MOTIVOS_BLOQUEO } = require("../src/whatsapp/enviar");
const ventana = require("../src/whatsapp/ventana");

const CONFIG_BASE = {
  respuestaAutomatica: false,
  panelEnvioManual: false,
  whatsappToken: "token-de-prueba",
  idNumero: "111111111111111",
  versionGraph: "v21.0",
  idiomaPlantillas: "es_CO",
};

/** Para los envios del panel, que tienen su propio interruptor. */
const CONFIG_PANEL = { ...CONFIG_BASE, panelEnvioManual: true };

function fetchEspia({ mediaId = "media-123" } = {}) {
  const llamadas = [];
  const impl = async (url, opciones) => {
    llamadas.push({ url, opciones });
    if (/\/media$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ id: mediaId }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.SALIDA" }] }) };
  };
  impl.llamadas = llamadas;
  impl.cuerpos = () =>
    llamadas
      .filter((l) => typeof l.opciones.body === "string")
      .map((l) => JSON.parse(l.opciones.body));
  return impl;
}

// --------------------------------------------------------------------------
// 1 · El candado, en los caminos nuevos
// --------------------------------------------------------------------------

test("EL CANDADO: una plantilla de conversacion no sale con el interruptor apagado", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_BASE, fetchImpl });

  const r = await emisor.enviarPlantilla({ para: "573001234567", plantilla: "novedad_ausente" });

  assert.equal(r.enviado, false);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.INTERRUPTOR);
  assert.equal(fetchImpl.llamadas.length, 0, "llamo a Meta con el interruptor apagado");
});

test("EL CANDADO: un documento no sale con el envio manual del panel apagado", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_BASE, fetchImpl });

  const r = await emisor.enviarDocumento({
    para: "573001234567",
    datos: Buffer.from("%PDF-falso"),
    nombreArchivo: "guia.pdf",
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  assert.equal(r.enviado, false);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO);
  assert.equal(fetchImpl.llamadas.length, 0, "SUBIO el PDF aunque el envio estaba bloqueado");
});

test("NO SE SUBE UN PDF QUE NO SE VA A PODER ENVIAR: los permisos van primero", async () => {
  // Subir y comprobar despues gasta una llamada y deja un mediaId huerfano.
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: { ...CONFIG_PANEL, whatsappToken: "" }, fetchImpl });

  const r = await emisor.enviarDocumento({
    para: "573001234567",
    datos: Buffer.from("%PDF-falso"),
    nombreArchivo: "guia.pdf",
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  assert.equal(r.enviado, false);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.SIN_CREDENCIALES);
  assert.equal(fetchImpl.llamadas.length, 0);
});

// --------------------------------------------------------------------------
// 2 · Las plantillas
// --------------------------------------------------------------------------

test("sin plantilla configurada NO se intenta nada, y el motivo es una tarea, no un fallo", async () => {
  // Mezclarlo con los errores de envio lo esconde en el ruido, y entonces
  // nadie crea la plantilla.
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });

  const r = await emisor.enviarPlantilla({
    para: "573001234567",
    plantilla: "",
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  assert.equal(r.enviado, false);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.SIN_PLANTILLA);
  assert.equal(fetchImpl.llamadas.length, 0);
});

test("la plantilla sale con el idioma es_CO, no es", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });

  await emisor.enviarPlantilla({
    para: "573001234567",
    plantilla: "novedad_ausente",
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  const cuerpo = fetchImpl.cuerpos()[0];
  assert.equal(cuerpo.type, "template");
  assert.equal(cuerpo.template.name, "novedad_ausente");
  assert.equal(cuerpo.template.language.code, "es_CO");
});

test("las variables van en el cuerpo, en orden", async () => {
  // Cambiar el orden manda la fecha donde va la oficina.
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });

  await emisor.enviarPlantilla({
    para: "573001234567",
    plantilla: "novedad_oficina",
    variables: ["Centro Medellin", "15 de octubre"],
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  const cuerpo = fetchImpl.cuerpos()[0];
  const body = cuerpo.template.components.find((c) => c.type === "body");
  assert.deepEqual(
    body.parameters.map((p) => p.text),
    ["Centro Medellin", "15 de octubre"]
  );
});

test("a un cliente con nombre de usuario la plantilla sale por `recipient`, no por `to`", async () => {
  // Meta lo exige asi, y mandar el BSUID en `to` es justo el error que
  // rechaza con 131026.
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });

  await emisor.enviarPlantilla({
    para: "CO.1098944123092301",
    plantilla: "novedad_ausente",
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  const cuerpo = fetchImpl.cuerpos()[0];
  assert.equal(cuerpo.recipient, "CO.1098944123092301");
  assert.equal(cuerpo.to, undefined, "mando el BSUID en `to`, que es lo que Meta rechaza");
});

// --------------------------------------------------------------------------
// 3 · El documento, y la ventana que decide el canal
// --------------------------------------------------------------------------

test("ventana ABIERTA: el PDF va como documento con pie", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });

  const r = await emisor.enviarDocumento({
    para: "573001234567",
    datos: Buffer.from("%PDF-falso"),
    nombreArchivo: "guia-111-novika.pdf",
    pie: "tu pedido va en camino",
    ventanaAbierta: true,
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  assert.equal(r.enviado, true);
  assert.equal(r.porPlantilla, false);
  // Primero la subida, luego el mensaje.
  assert.match(fetchImpl.llamadas[0].url, /\/media$/);
  const cuerpo = fetchImpl.cuerpos()[0];
  assert.equal(cuerpo.type, "document");
  assert.equal(cuerpo.document.id, "media-123");
  assert.equal(cuerpo.document.caption, "tu pedido va en camino");
});

test("ventana CERRADA: el PDF va en la cabecera de la plantilla", async () => {
  // Es el caso normal de una guia: se despacha al dia siguiente.
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });

  const r = await emisor.enviarDocumento({
    para: "573001234567",
    datos: Buffer.from("%PDF-falso"),
    nombreArchivo: "guia-111-novika.pdf",
    pie: "esto no se manda: el texto de la plantilla ya esta aprobado",
    ventanaAbierta: false,
    plantilla: "guia_de_envio",
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  assert.equal(r.enviado, true);
  assert.equal(r.porPlantilla, true);

  const cuerpo = fetchImpl.cuerpos()[0];
  assert.equal(cuerpo.type, "template");
  const header = cuerpo.template.components.find((c) => c.type === "header");
  assert.equal(header.parameters[0].document.id, "media-123");
  assert.equal(header.parameters[0].document.filename, "guia-111-novika.pdf");
});

test("ventana CERRADA y sin plantilla: no se sube nada y se dice que falta la plantilla", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });

  const r = await emisor.enviarDocumento({
    para: "573001234567",
    datos: Buffer.from("%PDF-falso"),
    nombreArchivo: "guia.pdf",
    ventanaAbierta: false,
    plantilla: null,
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  assert.equal(r.enviado, false);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.SIN_PLANTILLA);
  assert.equal(fetchImpl.llamadas.length, 0, "subio el PDF sabiendo que no podia enviarlo");
});

test("si la subida falla, no se finge el envio y se devuelve el motivo", async () => {
  const llamadas = [];
  const fetchImpl = async (url, opciones) => {
    llamadas.push(url);
    if (/\/media$/.test(url)) {
      return { ok: false, status: 400, json: async () => ({ error: { code: 100, message: "mal" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "x" }] }) };
  };

  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });
  const r = await emisor.enviarDocumento({
    para: "573001234567",
    datos: Buffer.from("%PDF-falso"),
    nombreArchivo: "guia.pdf",
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  assert.equal(r.enviado, false);
  assert.equal(r.motivo, MOTIVOS_BLOQUEO.DOCUMENTO_NO_SUBIDO);
  assert.ok(!llamadas.some((u) => /\/messages$/.test(u)), "mando el mensaje sin haber subido el PDF");
});

test("un mediaId ya subido se reutiliza: un reintento no vuelve a gastar la subida", async () => {
  const fetchImpl = fetchEspia();
  const emisor = crearEmisor({ config: CONFIG_PANEL, fetchImpl });

  await emisor.enviarDocumento({
    para: "573001234567",
    datos: Buffer.from("%PDF-falso"),
    nombreArchivo: "guia.pdf",
    mediaId: "ya-subido",
    permiso: PERMISOS.ATENCION_MANUAL,
  });

  assert.ok(!fetchImpl.llamadas.some((l) => /\/media$/.test(l.url)), "volvio a subir el PDF");
  assert.equal(fetchImpl.cuerpos()[0].document.id, "ya-subido");
});

// --------------------------------------------------------------------------
// 4 · La ventana de 24 h
// --------------------------------------------------------------------------

const AHORA = Date.parse("2026-10-08T15:00:00.000Z");
const conv = (hace) => ({
  mensajes: [{ de: "cliente", texto: "hola", ts: new Date(AHORA - hace).toISOString() }],
});

test("la ventana la abre EL CLIENTE, no la respuesta del bot", async () => {
  // Si contara el ultimo mensaje de cualquiera, cada respuesta la renovaria
  // y el sistema creeria tenerla abierta para siempre.
  const soloBot = {
    mensajes: [
      { de: "cliente", texto: "hola", ts: new Date(AHORA - 48 * 3600 * 1000).toISOString() },
      { de: "bot", texto: "ahi va", ts: new Date(AHORA - 60 * 1000).toISOString() },
    ],
  };
  assert.equal(ventana.estado(soloBot, { ahora: AHORA }).abierta, false);
});

test("dentro de las 24 h esta abierta y dice cuanto queda", () => {
  const v = ventana.estado(conv(2 * 3600 * 1000), { ahora: AHORA });
  assert.equal(v.abierta, true);
  assert.match(v.restante, /22 h/);
});

test("pasadas las 24 h esta cerrada y explica por que", () => {
  const v = ventana.estado(conv(25 * 3600 * 1000), { ahora: AHORA });
  assert.equal(v.abierta, false);
  assert.match(v.motivo, /solo entrega plantillas/);
});

test("SIN DATO se asume cerrada", () => {
  // Equivocarse hacia el lado cerrado cuesta una plantilla; hacia el
  // abierto, un cliente sin avisar que nadie sabe que no se avisó.
  assert.equal(ventana.estado(null, { ahora: AHORA }).abierta, false);
  assert.equal(ventana.estado({ mensajes: [] }, { ahora: AHORA }).abierta, false);
});

test("traduce el 131047 a la regla, no a un numero", () => {
  assert.ok(ventana.esFueraDeVentana(131047));
  assert.ok(ventana.esFueraDeVentana(470));
  assert.match(ventana.explicarCodigo(131047), /24 h/);
});

test("traduce el 132001 al idioma de la plantilla, que es donde esta el fallo", () => {
  // El mensaje de Meta habla del NOMBRE de la plantilla, asi que se busca el
  // error en el nombre y no en el idioma.
  assert.match(ventana.explicarCodigo(132001), /es_CO/);
});
