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

const elCinturon = () =>
  cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
    "cinturon-termico-colicos"
  );

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
    return {
      traza,
      texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join("\n"),
      // Las fotos tambien: hay que poder comprobar que lo prometido sale.
      fotos: salidas.filter((s) => s.type === "image").map((s) => s.image.link),
    };
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

// --------------------------------------------------------------------------
// 4 · EL NUMERO DE PEDIDO NO ES UN IMPORTE
//
// DE DONDE SALE: un fallo INTERMITENTE de la bateria de arriba. Una vez cada
// tantas corridas, "ninguna respuesta de posventa trae una cifra sin
// calcular" fallaba con esto:
//
//   cifra no autorizada ante "¿y el envio?": [{"texto":"5558"}]
//
// 5558 no era un importe: era parte del numero de pedido
// NOV-MUYR5558-508BAE67. El filtro leia los digitos del identificador como
// dinero y DESCARTABA el mensaje.
//
// Y era intermitente porque los ids se generan al azar: el mismo texto
// pasaba o se bloqueaba segun si al id le tocaban cuatro digitos seguidos.
// Un filtro que falla una vez de cada tantas es peor que uno que falla
// siempre: el fallo se atribuye a cualquier otra cosa.
//
// EN PRODUCCION esto bloqueaba el borrador del modelo cada vez que
// mencionaba el numero de pedido -o sea, en toda la posventa- y el cliente
// recibia el texto seco de respaldo sin que nadie se enterara.
//
// Estas pruebas usan ids FIJOS a proposito: el defecto se cubre siempre, no
// cuando toca.
// --------------------------------------------------------------------------

describe("4 · el número de pedido no se confunde con dinero", () => {
  const cotizador = require("../src/dominio/cotizador");
  const AUTORIZADOS = [49900, 1];

  test("un id con cuatro dígitos seguidos NO bloquea el mensaje", () => {
    const r = cotizador.revisarImportes(
      "Tu pedido NOV-MUYR5558-508BAE67 ya está confirmado.",
      AUTORIZADOS
    );
    assert.equal(r.ok, true, `bloqueó por el id: ${JSON.stringify(r.sospechosos)}`);
  });

  test("y uno sin dígitos seguidos tampoco, como antes", () => {
    const r = cotizador.revisarImportes("Tu pedido NOV-MUYP34SM-E9FC86A6 ya está confirmado.", AUTORIZADOS);
    assert.equal(r.ok, true);
  });

  // ------------------------------------------------------------------------
  // LO QUE NO SE PUEDE HABER ROTO AL ARREGLARLO
  //
  // La tentacion era pedir que la cifra no estuviera pegada a letras, y eso
  // habria abierto un agujero: "49900pesos" dejaria de revisarse. Se eximio
  // el identificador COMPLETO, con su prefijo, y nada mas.
  // ------------------------------------------------------------------------
  test("un importe no autorizado SIGUE bloqueando", () => {
    const r = cotizador.revisarImportes("Te lo dejo en $35.000.", AUTORIZADOS);
    assert.equal(r.ok, false);
    assert.deepEqual(r.sospechosos.map((s) => s.valor), [35000]);
  });

  test("un importe pegado a una palabra SIGUE bloqueando", () => {
    const r = cotizador.revisarImportes("te queda en 35000pesos", AUTORIZADOS);
    assert.equal(r.ok, false, "el agujero que habría abierto relajar los límites");
  });

  test("el id se exime, pero un importe a su lado SÍ se revisa", () => {
    const r = cotizador.revisarImportes("Tu pedido NOV-AAAA-BBBB cuesta 77000.", AUTORIZADOS);
    assert.equal(r.ok, false);
    assert.deepEqual(r.sospechosos.map((s) => s.valor), [77000]);
  });

  test("algo que solo PARECE un id no se exime", () => {
    // "NOV-1234" no tiene la forma completa del identificador, asi que se
    // revisa como cualquier cifra.
    const r = cotizador.revisarImportes("NOV-1234", AUTORIZADOS);
    assert.equal(r.ok, false);
  });

  test("con el id REAL que genera el código, sea cual sea", () => {
    // Se prueban 200 ids generados de verdad: el defecto aparecia en una
    // fraccion de ellos, asi que una sola muestra no lo habria cazado.
    const { nuevoIdDePedido } = require("../src/dominio/pedido");
    for (let i = 0; i < 200; i++) {
      const id = nuevoIdDePedido("573001234567", new Date(Date.now() + i * 1000));
      const r = cotizador.revisarImportes(`Tu pedido ${id} ya está confirmado.`, AUTORIZADOS);
      assert.equal(r.ok, true, `el id ${id} se leyó como importe: ${JSON.stringify(r.sospechosos)}`);
    }
  });

  test("y en una conversación de verdad, la posventa no se bloquea nunca", async () => {
    const c = await conversacion();
    const pedido = await c.conPedidoConfirmado();
    const cotizador2 = require("../src/dominio/cotizador");

    for (const m of ["¿y el envio?", "¿cuando llega?", "gracias", "¿tiene garantia?"]) {
      const r = await c.dice(m);
      assert.match(r.texto.length ? "ok" : "", /ok/, "tiene que responder algo");
      const rev = cotizador2.revisarImportes(r.texto, [49900, 1]);
      assert.equal(rev.ok, true, `bloqueado ante "${m}" (pedido ${pedido.id}): ${JSON.stringify(rev.sospechosos)}`);
    }
  });
});

// --------------------------------------------------------------------------
// 5 · LA POSVENTA TAMBIEN TIENE VOZ
//
// DE DONDE SALE: una segunda captura de Marco. La rama `ya_confirmado` se
// habia quedado FUERA del cambio de tono, y es justo la que mas usa quien
// ya compro:
//
//   Marco: "Hola"
//   bot:   "Tu pedido NOV-... ya está confirmado y te avisamos cuando salga."
//   Marco: "Buenas noches"
//   bot:   "Perdón, no quiero repetirme..."   <- la guarda anti-eco
//   Marco: "Qué colores tienes?"
//   bot:   "Viene únicamente en color rosado. Cualquier otra cosa de tu
//           pedido, dime 💗"
//   Marco: "Para que sirve?"
//   bot:   "Cinturón térmico con correa ajustable y panel de control. Se
//           entrega con su empaque. Cualquier otra cosa de tu pedido, dime."
//
// CUATRO DEFECTOS EN CINCO MENSAJES:
//   · un saludo recibia el estado del pedido, como un cajero automatico;
//   · dos saludos seguidos acababan en la guarda anti-eco;
//   · "Cualquier otra cosa de tu pedido, dime" detras de CADA respuesta;
//   · "¿para qué sirve?" describia el objeto sin responder para que sirve.
// --------------------------------------------------------------------------

describe("5 · la posventa suena a persona", () => {
  test("un saludo se contesta saludando, no con el número de pedido", async () => {
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const r = await c.dice("Hola");
    assert.match(r.texto, /¡Hola/, `no saludó: ${r.texto}`);
    assert.equal(/NOV-/.test(r.texto), false, `soltó el número de pedido a un saludo: ${r.texto}`);
    assert.match(r.texto, /ayudar/i, "tiene que ofrecer ayuda, no cerrar");
  });

  test("usa el nombre al saludar, si está confirmado", async () => {
    const c = await conversacion();
    await c.conPedidoConfirmado();
    const r = await c.dice("Hola");
    assert.match(r.texto, /Marco/, `no usó el nombre que ya tenía: ${r.texto}`);
  });

  test("dos saludos seguidos NO caen en la guarda anti-eco", async () => {
    // Saludar dos veces merece que te saluden dos veces. Un saludo no tiene
    // temas, asi que la regla de "misma pregunta" no lo cubria.
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const uno = await c.dice("Hola");
    const dos = await c.dice("Buenas noches");

    assert.equal(/no quiero repetirme/i.test(dos.texto), false, `se disculpó por saludar: ${dos.texto}`);
    assert.match(dos.texto, /¡Hola/);
    assert.equal(uno.texto, dos.texto, "dos saludos, el mismo saludo");
  });

  test("reconoce la pregunta antes del dato, igual que en el resto", async () => {
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const r = await c.dice("Tiene garantía?");
    assert.match(r.texto, /^¡Claro que sí!/, `sin apertura: ${r.texto}`);
    assert.match(r.texto, /1 mes/);
    assert.match(r.texto, /tranquilidad/, "y el beneficio de tener garantía");
  });

  test('se quitó el estribillo "Cualquier otra cosa de tu pedido, dime"', async () => {
    // Salia detras de CADA respuesta: amable la primera vez, robotico a la
    // tercera. Es la regla de "no fuerces una pregunta comercial en cada
    // respuesta", aplicada a la posventa.
    const c = await conversacion();
    await c.conPedidoConfirmado();

    for (const m of ["Tiene garantía?", "Qué colores tienes?", "¿de qué material es?"]) {
      const r = await c.dice(m);
      assert.equal(
        /cualquier otra cosa de tu pedido/i.test(r.texto),
        false,
        `repitió el estribillo ante "${m}": ${r.texto}`
      );
    }
  });

  test("tres dudas seguidas dan tres respuestas distintas", async () => {
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const uno = await c.dice("Tiene garantía?");
    const dos = await c.dice("Qué colores tienes?");
    const tres = await c.dice("¿en cuántos días llega?");

    const textos = [uno.texto, dos.texto, tres.texto];
    assert.equal(new Set(textos).size, 3, `hay repetidas:\n${textos.join("\n---\n")}`);
    assert.match(uno.texto, /garantía/i);
    assert.match(dos.texto, /rosado/i);
    assert.match(tres.texto, /1 a 3 días/i);
  });
});

// --------------------------------------------------------------------------
// 6 · SI EL MENSAJE PROMETE FOTOS, LAS FOTOS SALEN
//
// Este defecto ya se habia corregido una vez y volvio por otro camino: al
// mejorar la respuesta de "¿para qué sirve?", el texto decia "te paso las
// fotos para que lo veas bien" y no salia ninguna, porque esa pregunta no
// activaba el detector de peticion de fotos.
//
// Que reaparezca por otra via significa que la condicion estaba en el sitio
// equivocado: ahora se mira EL TEXTO YA PREPARADO, asi que el mensaje y las
// fotos no se pueden desalinear. Cualquier frase futura que las prometa las
// manda, sin que nadie tenga que acordarse de añadir su caso.
// --------------------------------------------------------------------------

describe("6 · lo prometido se cumple", () => {
  test('"¿para qué sirve?" promete fotos Y las manda', async () => {
    const c = await conversacion();
    const r = await c.dice("Para que sirve?");
    assert.match(r.texto, /fotos/i, "el texto tiene que ofrecer las fotos");
    assert.equal(r.fotos.length, 5, `prometió fotos y salieron ${r.fotos.length}`);
  });

  test("y cuando NO las promete, no las manda", async () => {
    // La otra mitad: mandar cinco fotos a quien pregunto el color es spam.
    const c = await conversacion();
    await c.dice("Para que sirve?"); // consume las fotos
    const r = await c.dice("¿y de qué color es?");
    assert.equal(/\bfotos?\b/i.test(r.texto), false);
    assert.equal(r.fotos.length, 0);
  });

  test("ningún texto promete fotos de un producto que no las tiene", () => {
    // Si el producto no tiene imagenes vinculadas, ninguna frase puede
    // ofrecerlas: el cliente se quedaria esperando algo que no existe.
    const responder2 = require("../src/cerebro/responder");
    const sinFotos = { ...elCinturon(), imagenes: [] };
    for (const mensaje of ["hola", "para qué sirve", "mándame fotos", "¿cómo es?"]) {
      for (const situacion of ["faltan_datos", "ya_confirmado", "producto_en_borrador", "escalado"]) {
        const t = responder2.textoDeterminista({
          situacion,
          cotizacion: null,
          faltan: [],
          producto: sinFotos,
          mensajeCliente: mensaje,
        });
        assert.equal(
          /\bfotos?\b/i.test(t),
          false,
          `prometió fotos sin tenerlas en ${situacion} con "${mensaje}": ${t}`
        );
      }
    }
  });
});
