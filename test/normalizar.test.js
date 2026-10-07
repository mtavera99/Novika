"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// El payload de Meta esta anidado cuatro niveles y mezcla mensajes con
// acuses de entrega. Si la traduccion al formato interno se rompe, el bot
// deja de contestar sin que falle nada visible: desde fuera es identico a
// "hoy no escribio nadie".
//
// Dos casos concretos que esta prueba fija:
//   - los acuses de estado SI se procesan (BIKERPRO los ignoro, y por eso
//     hubo mensajes que Meta aceptaba con 200 y nunca entregaba: el motivo
//     venia justo ahi);
//   - los clientes con nombre de usuario de WhatsApp no tienen telefono, y
//     la clave de la conversacion no puede confundirse con el telefono al
//     que se despacha.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const { normalizar, CLASES } = require("../src/webhook/normalizar");
const { payloadDeTexto, payloadDeEstado } = require("./ayuda");

test("un mensaje de texto se traduce entero", () => {
  const [ev] = normalizar(payloadDeTexto({ wamid: "wamid.A", texto: "buenas, cuanto vale?" }));
  assert.equal(ev.clase, CLASES.MENSAJE);
  assert.equal(ev.wamid, "wamid.A");
  assert.equal(ev.tipo, "text");
  assert.equal(ev.texto, "buenas, cuanto vale?");
  assert.equal(ev.origenTexto, "escrito");
  assert.equal(ev.idCliente, "573001234567");
  assert.equal(ev.telefono, "573001234567");
  assert.equal(ev.nombre, "Cliente de prueba");
  assert.equal(ev.idNumero, "111111111111111");
  assert.equal(typeof ev.enviadoEn, "number");
});

test("un boton interactivo se aplana a texto y conserva el id de la opcion", () => {
  const cuerpo = payloadDeTexto();
  cuerpo.entry[0].changes[0].value.messages[0] = {
    from: "573001234567",
    id: "wamid.B",
    timestamp: "1760000000",
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "comprar-ya", title: "Quiero comprarlo" } },
  };
  const [ev] = normalizar(cuerpo);
  assert.equal(ev.texto, "Quiero comprarlo");
  assert.equal(ev.idOpcion, "comprar-ya");
  assert.equal(ev.origenTexto, "boton");
});

test("una opcion de lista tambien se aplana", () => {
  const cuerpo = payloadDeTexto();
  cuerpo.entry[0].changes[0].value.messages[0] = {
    from: "573001234567",
    id: "wamid.C",
    type: "interactive",
    interactive: { type: "list_reply", list_reply: { id: "cat-hogar", title: "Hogar" } },
  };
  const [ev] = normalizar(cuerpo);
  assert.equal(ev.texto, "Hogar");
  assert.equal(ev.idOpcion, "cat-hogar");
  assert.equal(ev.origenTexto, "lista");
});

test("un boton de plantilla se aplana", () => {
  const cuerpo = payloadDeTexto();
  cuerpo.entry[0].changes[0].value.messages[0] = {
    from: "573001234567",
    id: "wamid.D",
    type: "button",
    button: { text: "Si, confirmo", payload: "CONFIRMA" },
  };
  const [ev] = normalizar(cuerpo);
  assert.equal(ev.texto, "Si, confirmo");
  assert.equal(ev.origenTexto, "boton_plantilla");
});

test("una imagen con pie de foto conserva el pie y los datos del archivo", () => {
  const cuerpo = payloadDeTexto();
  cuerpo.entry[0].changes[0].value.messages[0] = {
    from: "573001234567",
    id: "wamid.E",
    type: "image",
    image: { id: "MEDIA-1", mime_type: "image/jpeg", caption: "es este?" },
  };
  const [ev] = normalizar(cuerpo);
  assert.equal(ev.texto, "es este?");
  assert.deepEqual(ev.media, { tipo: "image", id: "MEDIA-1", mime: "image/jpeg" });
});

test("un tipo que no conocemos no se descarta: llega marcado", () => {
  const cuerpo = payloadDeTexto();
  cuerpo.entry[0].changes[0].value.messages[0] = { from: "573001234567", id: "wamid.F", type: "contacts" };
  const [ev] = normalizar(cuerpo);
  assert.equal(ev.clase, CLASES.MENSAJE);
  assert.equal(ev.origenTexto, "tipo_no_soportado_contacts");
  // Importa que llegue: un cliente que manda algo raro no puede quedarse en
  // silencio, y para contestarle el evento tiene que existir.
  assert.equal(ev.wamid, "wamid.F");
});

test("un cliente sin telefono (nombre de usuario) se identifica por su BSUID", () => {
  const cuerpo = payloadDeTexto();
  cuerpo.entry[0].changes[0].value.contacts = [{ profile: { name: "Ana" }, user_id: "ab.Ana123" }];
  cuerpo.entry[0].changes[0].value.messages[0] = {
    from_user_id: "ab.Ana123",
    id: "wamid.G",
    type: "text",
    text: { body: "hola" },
  };
  const [ev] = normalizar(cuerpo);
  assert.equal(ev.idCliente, "ab.Ana123");
  assert.equal(ev.bsuid, "ab.Ana123");
  // El telefono queda en null a proposito: no hay ninguno, y rellenarlo con
  // el BSUID haria imposible despachar.
  assert.equal(ev.telefono, null);
});

test("el referral del anuncio se conserva", () => {
  const cuerpo = payloadDeTexto();
  cuerpo.entry[0].changes[0].value.messages[0].referral = {
    source_id: "123456",
    headline: "Titular del anuncio",
    source_type: "ad",
  };
  const [ev] = normalizar(cuerpo);
  assert.equal(ev.referral.source_id, "123456");
});

test("un acuse de entrega fallido se traduce con su motivo", () => {
  const [ev] = normalizar(payloadDeEstado({ wamid: "wamid.H", estado: "failed" }));
  assert.equal(ev.clase, CLASES.ESTADO);
  assert.equal(ev.estado, "failed");
  assert.equal(ev.errores.length, 1);
  assert.equal(ev.errores[0].codigo, 131047);
});

test("mensajes y estados en el mismo lote salen como eventos separados", () => {
  const cuerpo = payloadDeTexto({ wamid: "wamid.I" });
  cuerpo.entry[0].changes[0].value.statuses = [{ id: "wamid.J", status: "delivered", recipient_id: "573001234567" }];
  const eventos = normalizar(cuerpo);
  assert.equal(eventos.length, 2);
  assert.deepEqual(
    eventos.map((e) => e.clase),
    [CLASES.MENSAJE, CLASES.ESTADO]
  );
});

test("un cuerpo vacio o deforme no revienta", () => {
  assert.deepEqual(normalizar(null), []);
  assert.deepEqual(normalizar({}), []);
  assert.deepEqual(normalizar({ entry: null }), []);
  const eventos = normalizar({ entry: [{ changes: [{ field: "messages", value: { metadata: {} } }] }] });
  assert.equal(eventos[0].clase, CLASES.DESCONOCIDO);
});
