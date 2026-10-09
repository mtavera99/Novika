"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Una novedad de entrega sin gestionar se convierte en una devolucion en
// pocos dias, y en contraentrega eso cuesta el flete de ida, el de vuelta y
// la venta. Pero avisar MAL cuesta mas que no avisar:
//
//   EL INCIDENTE DEL 14-SEP (BIKERPRO): el bot le prometio a una clienta "la
//   oficina de Servientrega en Potosi". Servientrega NO presta recogida en
//   oficina. La clienta lo leyo. Desde entonces: la oficina solo puede venir
//   de la novedad, nunca de nosotros.
//
//   EL CASO MAS FRECUENTE QUEDABA FUERA: "no se localiza direccion del
//   destinatario" es el texto literal de la plataforma y no estaba en la
//   lista de senales, asi que esas novedades caian en "motivo no reconocido"
//   y el cliente no recibia nada. Se descubrio comparando la lista con la
//   pantalla real, no por un error.
//
//   EL NUMERO EQUIVOCADO: una fila real traia 10104874 (orden interno, 8
//   digitos) y 240062099941 (la guia, 12). "El primero que no parezca
//   celular" se quedaba con el interno y la novedad no cruzaba con nadie.
//
//   LA VENTANA YA ESTA CERRADA: una novedad llega 1 a 3 dias despues, asi
//   que casi nunca hay ventana de 24 h. Con texto libre Meta acepta el
//   mensaje y NO lo entrega: el operador tacha al cliente de su lista
//   creyendo que ya esta avisado.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const novedades = require("../src/despacho/novedades");
const { TIPOS_DE_NOVEDAD } = require("../src/dominio/pedido");

const AHORA = Date.parse("2026-10-08T15:00:00.000Z");

function pedidoDespachado(sobre = {}) {
  const { destinatario, despacho, ...resto } = sobre;
  return {
    id: "NOV-ANA",
    estado: "despachado",
    contactoId: "573001112233",
    destinatario: {
      nombre: "Ana Maria Perez",
      telefono: "3001112233",
      ciudad: "Medellin",
      direccion: "Calle 45 # 23-10",
      ...destinatario,
    },
    cotizacion: { total: 89000 },
    despacho: { guia: "240061604892", transportadora: "Interrapidisimo", ...despacho },
    novedades: [],
    ...resto,
  };
}

/** Conversacion con el ultimo mensaje del cliente hace `hace` milisegundos. */
function conversacionConMensaje(contactoId, hace) {
  return {
    contactoId,
    mensajes: [{ de: "cliente", texto: "hola", ts: new Date(AHORA - hace).toISOString() }],
  };
}

const PLANTILLAS = {
  [TIPOS_DE_NOVEDAD.DIRECCION]: "novedad_direccion",
  [TIPOS_DE_NOVEDAD.AUSENTE]: "novedad_ausente",
  [TIPOS_DE_NOVEDAD.OFICINA]: "novedad_oficina",
};

// --------------------------------------------------------------------------
// 1 · Clasificar
// --------------------------------------------------------------------------

test("EL CASO MAS FRECUENTE: 'no se localiza direccion del destinatario' se reconoce", () => {
  const t = novedades.clasificar("No se localiza direccion del destinatario");
  assert.equal(t.clave, TIPOS_DE_NOVEDAD.DIRECCION);
  assert.equal(t.avisable, true);
});

test("reconoce las tres familias a las que SI se le escribe", () => {
  assert.equal(novedades.clasificar("Direccion incompleta").clave, TIPOS_DE_NOVEDAD.DIRECCION);
  assert.equal(novedades.clasificar("Destinatario ausente").clave, TIPOS_DE_NOVEDAD.AUSENTE);
  assert.equal(novedades.clasificar("Reclame en oficina").clave, TIPOS_DE_NOVEDAD.OFICINA);
});

test("a un rechazo NO se le manda un mensaje automatico", () => {
  // Si rechazo el paquete, un automatico molesta; y si fue un malentendido,
  // hay que hablarlo, no mandar una plantilla.
  const t = novedades.clasificar("Pedido cancelado por el cliente");
  assert.equal(t.clave, "rechazado");
  assert.equal(t.avisable, false);
});

test("'telemercadeo' se nombra bien pero no se le escribe", () => {
  // Significa que la transportadora quiere que alguien LLAME, pero no dice
  // que dato falta. Un mensaje generico seria inventar el motivo.
  const t = novedades.clasificar("Telemercadeo");
  assert.equal(t.clave, "telemercadeo");
  assert.equal(t.avisable, false);
});

test("NUNCA ADIVINA: un motivo desconocido se marca como tal", () => {
  const t = novedades.clasificar("asdfgh qwerty");
  assert.equal(t.clave, "desconocida");
  assert.equal(t.avisable, false);
});

test("una direccion de casa NO se toma por una oficina", () => {
  // Usarla como oficina mandaria al cliente a recoger su paquete a su propia
  // casa.
  assert.equal(novedades.pareceOficina("Calle 45 # 23-10 apto 302"), false);
  assert.equal(novedades.pareceOficina("Oficina Centro Medellin"), true);
  assert.equal(novedades.pareceOficina("INTER RAPIDISIMO sucursal poblado"), true);
});

// --------------------------------------------------------------------------
// 2 · Leer las filas
// --------------------------------------------------------------------------

test("EL NUMERO EQUIVOCADO: gana la guia (12 digitos), no el orden interno (8)", () => {
  const filas = novedades.parsear("10104874 ; 240062099941 ; No se localiza direccion");
  assert.equal(filas.length, 1);
  assert.equal(filas[0].guia, "240062099941");
});

test("si el lector reconocio la columna de la guia, manda esa y no se adivina", () => {
  // Con el archivo real, adivinar por largo elegia el telefono con
  // indicativo (12 digitos) en vez de la guia (11).
  const filas = novedades.parsear("[[guia: 64532759599]] ; 573043255345 ; Destinatario ausente");
  assert.equal(filas[0].guia, "64532759599");
});

test("recoge la oficina y el plazo que vienen marcados en el archivo", () => {
  // Estos datos VENIAN en el archivo y se tiraban a la basura al convertir a
  // texto, asi que cada novedad de oficina quedaba bloqueada pidiendolos a
  // mano.
  const filas = novedades.parsear(
    "[[guia: 111111111]] ; Reclame en oficina ; [[oficina: Centro Medellin]] ; [[plazo: 15 de octubre]]"
  );
  assert.equal(filas[0].oficina, "Centro Medellin");
  assert.equal(filas[0].plazo, "15 de octubre");
});

test("la misma guia dos veces no se procesa dos veces", () => {
  const filas = novedades.parsear("111111111 ausente\n111111111 ausente");
  assert.equal(filas.length, 1);
});

test("el motivo queda limpio de numeros, marcadores y separadores", () => {
  const filas = novedades.parsear("[[guia: 111111111]] ; Destinatario ausente ; 3001112233");
  assert.equal(filas[0].motivo, "Destinatario ausente");
});

// --------------------------------------------------------------------------
// 3 · Cruzar con los pedidos
// --------------------------------------------------------------------------

test("cruza por la guia del pedido despachado", () => {
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "240061604892 ; Destinatario ausente",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 60000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });

  assert.equal(r.filas[0].pedido.id, "NOV-ANA");
  assert.equal(r.filas[0].comoSeEncontro, "por la guia");
  assert.equal(r.filas[0].enviar, true);
});

test("si la guia no cruza, la sugerencia por nombre REQUIERE confirmacion", () => {
  // Cruzar por nombre es mas debil que por guia, y avisarle al cliente
  // equivocado lo manda a resolver un problema que no tiene.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "999999999999 ; Ana Maria Perez Medellin ; Destinatario ausente",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 60000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });

  assert.equal(r.filas[0].pedido.id, "NOV-ANA");
  assert.equal(r.filas[0].requiereConfirmacion, true);
  assert.match(r.filas[0].comoSeEncontro, /coincide por nombre/);
});

test("un nombre a secas NO alcanza para sugerir: hacen falta dos palabras o nombre + ciudad", () => {
  // Con "Mauricio" solo hay varios, y avisarle al Mauricio equivocado es
  // peor que no avisar.
  const a = pedidoDespachado({ id: "NOV-A", destinatario: { nombre: "Mauricio Gomez", ciudad: "Cali" } });
  assert.equal(novedades.buscarPorNombre("mauricio", [a]), null);
  // Dos palabras si:
  assert.ok(novedades.buscarPorNombre("mauricio gomez", [a]));
});

test("si dos pedidos empatan al buscar por nombre, no se sugiere ninguno", () => {
  const a = pedidoDespachado({ id: "NOV-A", destinatario: { nombre: "Juan Perez", ciudad: "Cali" } });
  const b = pedidoDespachado({ id: "NOV-B", destinatario: { nombre: "Juan Perez", ciudad: "Cali" } });
  assert.equal(novedades.buscarPorNombre("juan perez", [a, b]), null);
});

test("una guia que no se encuentra queda bloqueada y lo dice", () => {
  const r = novedades.revisar({
    texto: "999999999999 ; zzz qqq ; Destinatario ausente",
    pedidos: [pedidoDespachado()],
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });
  assert.equal(r.filas[0].enviar, false);
  assert.match(r.filas[0].bloqueada, /no se encontro a quien corresponde/);
});

// --------------------------------------------------------------------------
// 4 · La ventana de 24 h decide el canal
// --------------------------------------------------------------------------

test("ventana ABIERTA: se escribe texto libre, y se puede leer antes de enviar", () => {
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "240061604892 ; Destinatario ausente",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 60 * 60 * 1000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });

  const f = r.filas[0];
  assert.equal(f.enviar, true);
  assert.equal(f.porPlantilla, false);
  assert.ok(f.mensaje.length > 0, "no dejo el texto exacto para poder leerlo");
  assert.match(f.mensaje, /NOVIKA/);
  assert.match(f.mensaje, /Ana/, "no saluda al cliente por su nombre");
});

test("ventana CERRADA: se manda por plantilla, nunca texto libre", () => {
  // Es el caso NORMAL: una novedad llega dias despues del pedido.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "240061604892 ; Destinatario ausente",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 48 * 60 * 60 * 1000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });

  const f = r.filas[0];
  assert.equal(f.enviar, true);
  assert.equal(f.porPlantilla, true);
  assert.equal(f.plantilla, "novedad_ausente");
});

test("ventana cerrada SIN plantilla configurada: BLOQUEADA, no se intenta", () => {
  // Intentarlo gastaria el intento y anotaria un fallo que parece de red,
  // cuando lo que falta es crear una plantilla en Meta. Bloquear convierte
  // eso en una tarea visible.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "240061604892 ; Destinatario ausente",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 48 * 60 * 60 * 1000)]]),
    plantillas: {}, // ninguna configurada
    ahora: AHORA,
  });

  assert.equal(r.filas[0].enviar, false);
  assert.match(r.filas[0].bloqueada, /plantilla/);
  assert.deepEqual(r.plantillasQueFaltan, [TIPOS_DE_NOVEDAD.AUSENTE]);
});

test("sin registro de mensajes del cliente se asume CERRADA", () => {
  // La asimetria correcta: darla por abierta sin saberlo hace que Meta lo
  // rechace y el operador crea que aviso. Darla por cerrada manda una
  // plantilla, que llega igual.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "240061604892 ; Destinatario ausente",
    pedidos: [p],
    conversaciones: new Map(),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });
  assert.equal(r.filas[0].porPlantilla, true);
});

// --------------------------------------------------------------------------
// 5 · El incidente de la oficina
// --------------------------------------------------------------------------

test("EL INCIDENTE DEL 14-SEP: el texto libre de oficina NO nombra ninguna oficina", () => {
  // Prometer "la oficina de Servientrega en Potosi" cuando Servientrega no
  // presta recogida en oficina. Ese dato solo puede venir de la novedad.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "240061604892 ; Reclame en oficina",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 60000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });

  const f = r.filas[0];
  assert.equal(f.enviar, true);
  assert.ok(
    !/servientrega|coordinadora|interrapidisimo/i.test(f.mensaje),
    `nombro una transportadora que no vino en la novedad: ${f.mensaje}`
  );
  // Y en vez de inventarla, pide al cliente que espere los datos.
  assert.match(f.mensaje, /te paso los datos exactos/i);
});

test("la plantilla de oficina SIN oficina ni plazo queda bloqueada pidiendolos", () => {
  // Meta rechaza una plantilla con menos parametros de los que declara, y
  // "esta en la oficina de  para que lo reclames" no sirve de nada.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "240061604892 ; Reclame en oficina",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 48 * 60 * 60 * 1000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });

  assert.equal(r.filas[0].enviar, false);
  assert.match(r.filas[0].bloqueada, /falta oficina y plazo/);
  assert.deepEqual(r.filas[0].pide, ["oficina", "plazo"]);
});

test("con la oficina y el plazo del archivo, la plantilla sale con sus variables EN ORDEN", () => {
  // El orden importa: cambiarlo manda la fecha donde va la oficina.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto:
      "[[guia: 240061604892]] ; Reclame en oficina ; [[oficina: Centro Medellin]] ; [[plazo: 15 de octubre]]",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 48 * 60 * 60 * 1000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });

  assert.equal(r.filas[0].enviar, true);
  assert.equal(r.filas[0].plantilla, "novedad_oficina");
  assert.deepEqual(r.filas[0].variables, ["Centro Medellin", "15 de octubre"]);
});

test("lo escrito a mano en el panel gana sobre lo que trae el archivo", () => {
  // Es mas reciente y mas deliberado.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "[[guia: 240061604892]] ; Reclame en oficina ; [[oficina: Vieja]] ; [[plazo: ayer]]",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 48 * 60 * 60 * 1000)]]),
    plantillas: PLANTILLAS,
    datos: { "240061604892": { oficina: "Centro Medellin", plazo: "15 de octubre" } },
    ahora: AHORA,
  });

  assert.deepEqual(r.filas[0].variables, ["Centro Medellin", "15 de octubre"]);
});

test("si la direccion del archivo PARECE una oficina, se usa como oficina", () => {
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto:
      "[[guia: 240061604892]] ; Reclame en oficina ; [[direccion: Oficina Centro Medellin]] ; [[plazo: 15 de octubre]]",
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 48 * 60 * 60 * 1000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });
  assert.equal(r.filas[0].oficina, "Oficina Centro Medellin");
});

// --------------------------------------------------------------------------
// 6 · No avisar dos veces
// --------------------------------------------------------------------------

test("una guia ya avisada queda bloqueada", () => {
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: "240061604892 ; Destinatario ausente",
    pedidos: [p],
    plantillas: PLANTILLAS,
    yaAvisada: (g) => (g === "240061604892" ? { cuando: "ayer" } : null),
    ahora: AHORA,
  });
  assert.equal(r.filas[0].enviar, false);
  assert.match(r.filas[0].bloqueada, /ya se le aviso/);
});

test("el resumen cuenta listas, bloqueadas y las que piden confirmacion", () => {
  // Es lo primero que se mira en la pantalla: cuantas salen y cuantas no.
  const p = pedidoDespachado();
  const r = novedades.revisar({
    texto: ["240061604892 ; Destinatario ausente", "999999999999 ; zzz ; Direccion incompleta"].join("\n"),
    pedidos: [p],
    conversaciones: new Map([[p.contactoId, conversacionConMensaje(p.contactoId, 60000)]]),
    plantillas: PLANTILLAS,
    ahora: AHORA,
  });

  assert.equal(r.listas, 1);
  assert.equal(r.bloqueadas, 1);
});
