"use strict";

// ==========================================================================
// POSVENTA: QUIEN YA COMPRO TAMBIEN PREGUNTA
//
// DE DONDE SALE ESTA BATERIA: una captura de Marco, en produccion.
//
//   Marco: "Ese tiene garantía?"
//   bot:   "Tu pedido NOV-... ya está confirmado. Si necesitas cambiar algo,
//           dime qué y lo revisamos."
//   Marco: "Pregunto si tiene garantía"
//   bot:   (el mismo texto)
//   Marco: "Si"
//   bot:   (el mismo texto otra vez)
//
// Tras confirmar un pedido el estado queda BLINDADO, y eso esta bien: un
// "si" no puede recotizar ni crear un segundo pedido. El error fue tratar
// "no recotizar" como "no conversar": la situacion `ya_confirmado` devolvia
// la misma frase a cualquier cosa que escribiera el cliente.
//
// Reproduciendolo salio algo peor que la captura: "¿cuánto vale otro?"
// -una venta adicional- recibia tambien el eco.
//
// Quien ya compro es quien MAS merece respuesta: garantias, cambios de
// direccion, seguimientos. Y es el cliente mas facil de volver a vender.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba({
  RESPUESTA_AUTOMATICA: "1",
  URL_PUBLICA: "https://pruebas.invalido",
  WHATSAPP_TOKEN: "token-de-prueba",
});

const { cargarCatalogo } = require("../src/catalogo");
const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearEmisor } = require("../src/whatsapp/enviar");
const mutex = require("../src/almacen/mutex");
const responder = require("../src/cerebro/responder");
const atencion = require("../src/almacen/atencion");

const RAIZ = path.join(__dirname, "..");
const CLIENTE = "573001234567";

// --------------------------------------------------------------------------
// UN WAMID QUE NO PUEDE COLISIONAR
//
// Estaba construido con `Date.now()` y un contador por conversacion, y eso
// produjo un fallo INTERMITENTE: dos pruebas distintas que arrancan en el
// mismo milisegundo generan el mismo wamid, y el deduplicador -que hace
// bien su trabajo- descarta el segundo mensaje. La prueba fallaba una vez
// cada tantas corridas sin que nada estuviera mal en el codigo.
//
// Una prueba intermitente es peor que ninguna: enseña a volver a correrla
// en vez de a leer el fallo. El contador es de modulo y es unico.
// --------------------------------------------------------------------------
let SECUENCIA = 0;
const wamidUnico = (prefijo) => `wamid.${prefijo}${++SECUENCIA}_${process.pid}`;

/** Conversacion contra el catalogo real, con emisor espia. */
async function conversacion() {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-posventa-")) });
  const cfg = {
    ...config,
    respuestaAutomatica: true,
    whatsappToken: "token-de-prueba",
    idNumero: "000",
    urlPublica: "https://pruebas.invalido",
  };

  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    fetchImpl: async (url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.P${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  let n = 0;
  const dice = async (texto) => {
    n += 1;
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: wamidUnico("PV"),
      idCliente: CLIENTE,
      telefono: CLIENTE,
      nombre: "Marco",
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });
    return { traza, texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join("\n") };
  };

  /** Deja un pedido confirmado, como el que ya tiene Marco. */
  const conPedidoConfirmado = async () => {
    await dice("quiero un cinturon");
    await dice("Marco Tavera, Medellin, Calle 45 # 23-10");
    const r = await dice("si confirmo");
    assert.equal(r.traza.respuesta.situacion, "confirmado", "la venta tiene que cerrarse primero");
    return r.traza.pedido;
  };

  return { dice, repos, conPedidoConfirmado };
}

// --------------------------------------------------------------------------
// 1 · EL CASO DE LA CAPTURA
// --------------------------------------------------------------------------

describe("1 · el caso exacto de la captura", () => {
  test("«¿tiene garantía?» con pedido confirmado se RESPONDE", async () => {
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const r = await c.dice("Ese tiene garantia?");
    assert.equal(r.traza.respuesta.situacion, "ya_confirmado", "el estado sigue blindado, como debe");
    assert.match(r.texto, /garantía/i, `no respondió la duda: ${r.texto}`);
    // Desde el 2026-10-07 la garantia esta confirmada: 1 mes. Antes esta
    // asercion pedia que el bot admitiera no tenerla, y eso ya no aplica.
    assert.match(r.texto, /1 mes/, `no dijo el plazo confirmado: ${r.texto}`);
  });

  test("y NO contesta solo con el número de pedido", async () => {
    // El eco exacto de la captura.
    const c = await conversacion();
    const pedido = await c.conPedidoConfirmado();

    const r = await c.dice("Ese tiene garantia?");
    assert.equal(
      r.texto.trim(),
      r.texto.trim().replace(new RegExp(`^Tu pedido ${pedido.id} ya está confirmado`), ""),
      `la respuesta empieza con el eco del pedido: ${r.texto}`
    );
  });

  test("tres mensajes distintos NO reciben el mismo texto", async () => {
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const uno = await c.dice("Ese tiene garantia?");
    const dos = await c.dice("¿y cuando llega?");
    const tres = await c.dice("¿de que color es?");

    const textos = [uno.texto, dos.texto, tres.texto];
    assert.equal(new Set(textos).size, 3, `hay respuestas repetidas:\n${textos.join("\n---\n")}`);
  });

  test("la misma pregunta repetida SI recibe la misma respuesta", async () => {
    // La guarda contra el eco no puede castigar al cliente que insiste: si
    // pregunta dos veces lo mismo, la respuesta correcta es la misma.
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const uno = await c.dice("Ese tiene garantia?");
    const dos = await c.dice("Pregunto si tiene garantia");

    assert.match(dos.texto, /garantía/i, `dejó de responder la duda: ${dos.texto}`);
    assert.equal(/no quiero repetirme/i.test(dos.texto), false, "se disculpó en vez de contestar");
    assert.equal(uno.texto, dos.texto, "la misma pregunta merece la misma respuesta");
  });
});

// --------------------------------------------------------------------------
// 2 · LA VENTA ADICIONAL
// --------------------------------------------------------------------------

describe("2 · «¿cuánto vale otro?»", () => {
  test("responde el precio y ofrece que una persona lo arme", async () => {
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const r = await c.dice("cuanto vale otro?");
    assert.match(r.texto, /49\.900/, `no dijo el precio: ${r.texto}`);
    assert.match(r.texto, /persona|equipo/i, "no ofreció pasarlo a una persona");
  });

  test("pero NO crea un segundo pedido por su cuenta", async () => {
    // BIKERPRO documento un pedido falso creado asi: un cliente con guia
    // enviada contesto el mensaje y el bot lo tomo como venta nueva. Casi se
    // despacho un paquete que nadie pidio.
    const c = await conversacion();
    await c.conPedidoConfirmado();

    await c.dice("cuanto vale otro?");
    await c.dice("si, quiero otro");
    await c.dice("si confirmo");

    const pedidos = await c.repos.pedidos.porContacto(CLIENTE);
    assert.equal(pedidos.length, 1, "se creó un segundo pedido sin que una persona lo revisara");
  });

  test("ninguna respuesta de posventa trae una cifra sin calcular", async () => {
    const c = await conversacion();
    await c.conPedidoConfirmado();
    const cotizador = require("../src/dominio/cotizador");
    const producto = cargarCatalogo({
      carpeta: path.join(RAIZ, "catalogo", "productos"),
      refrescar: true,
    }).porId.get("cinturon-termico-colicos");
    const autorizados = cotizador.cotizar({ producto, cantidad: 1 }).cotizacion.importesAutorizados;

    for (const m of ["cuanto vale otro?", "¿y el envio?", "¿cuando llega?", "gracias"]) {
      const r = await c.dice(m);
      const rev = cotizador.revisarImportes(r.texto, autorizados);
      assert.equal(rev.ok, true, `cifra no autorizada ante "${m}": ${JSON.stringify(rev.sospechosos)}`);
    }
  });
});

// --------------------------------------------------------------------------
// 3 · LA GUARDA CONTRA EL ECO
// --------------------------------------------------------------------------

describe("3 · no repetir palabra por palabra", () => {
  test("un texto idéntico ante una pregunta distinta se cambia", () => {
    const r = responder.sinRepetir("Lo mismo de antes.", "Lo mismo de antes.");
    assert.equal(r.repetido, true);
    assert.equal(r.texto, responder.PEDIR_CONCRETAR);
    assert.equal(r.escalar, false);
  });

  test("si ya se pidió concretar y volvería a repetirse, pasa a una persona", () => {
    // Dos veces en el mismo sitio significa que el bot no va a resolverlo.
    const r = responder.sinRepetir(responder.PEDIR_CONCRETAR, responder.PEDIR_CONCRETAR);
    assert.equal(r.escalar, true);
    assert.equal(r.texto, responder.PASAR_A_PERSONA);
  });

  test("un texto distinto no se toca", () => {
    const r = responder.sinRepetir("Respuesta nueva.", "Respuesta vieja.");
    assert.equal(r.repetido, false);
    assert.equal(r.texto, "Respuesta nueva.");
  });

  test("con la misma pregunta no se aplica la guarda", () => {
    const r = responder.sinRepetir("La garantía te la confirmo.", "La garantía te la confirmo.", {
      mismaPregunta: true,
    });
    assert.equal(r.repetido, false);
    assert.equal(r.texto, "La garantía te la confirmo.");
  });

  test("el bucle acaba con el chat tomado por una persona", async () => {
    // Si el bot se repite dos veces, el chat se pausa y aparece en el panel
    // para que alguien lo mire. Mejor callarse que dar vueltas.
    const c = await conversacion();
    await c.conPedidoConfirmado();

    // Dos mensajes sin tema reconocible: caen en la misma respuesta.
    await c.dice("ajá");
    const dos = await c.dice("bueno");
    const tres = await c.dice("ok");

    const conv = await c.repos.conversaciones.obtener(CLIENTE);
    const a = atencion.leer(conv);
    // O ya se pauso, o al menos no se repitio el mismo parrafo tres veces.
    assert.ok(
      a.pausado || new Set([dos.texto, tres.texto]).size === 2,
      `el bot se repitió sin escalar:\n${dos.texto}\n---\n${tres.texto}`
    );
  });
});

void DIR;
