"use strict";

// ==========================================================================
// LA CONVERSACION COMERCIAL
//
// Esta bateria defiende algo distinto de las demas: no que los numeros sean
// correctos -eso ya esta cubierto- sino que la conversacion SIRVA PARA
// VENDER. Son dos cosas separadas, y el proyecto las tenia desbalanceadas:
// el cotizador estaba probado al detalle y el bot contestaba esto:
//
//   clienta: "Quiero un cinturón. ¿Cuánto vale con envío?"
//   bot:     "Para continuar me falta la ciudad, la dirección de entrega."
//
// Ningun numero estaba mal. La venta estaba perdida igual.
//
// LO QUE SE VIGILA AQUI, Y POR QUE CADA COSA
//
//   1. Se responde PRIMERO lo que preguntan.
//   2. Preguntar no es comprar: a quien averigua no se le piden los datos.
//   3. No se repite el saludo ni la pedida de datos en cada mensaje.
//   4. Lo que no esta aprobado se admite, no se rellena.
//   5. Y NADA de esto puede introducir una cifra o una promesa que el
//      dominio no autorizo. La calidez no puede costar un cobro mal.
//
// El punto 5 es el que hace que esta bateria no sea cosmetica: cada texto
// nuevo pasa por los mismos filtros que el borrador de la IA.
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
const preguntas = require("../src/dominio/preguntas");
const responder = require("../src/cerebro/responder");
const cotizador = require("../src/dominio/cotizador");

const RAIZ = path.join(__dirname, "..");

function catalogoReal() {
  return cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true });
}

const elCinturon = () => catalogoReal().porId.get("cinturon-termico-colicos");

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

/** Una conversacion contra el catalogo real, con emisor espia. */
async function conversacion({ respuestaAutomatica = true } = {}) {
  mutex._reiniciar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-conv-"));
  const repos = await crearReposDeArchivos({ dir });

  const cfg = {
    ...config,
    respuestaAutomatica,
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
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.O${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: catalogoReal(),
    // Sin IA: se prueba EL CAMINO DETERMINISTA a proposito. Es el que atiende
    // cuando el modelo falla, tarda, o dice algo que no pasa los filtros, y
    // es el que no podia depender de Gemini.
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  let n = 0;
  const dice = async (texto) => {
    n += 1;
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: wamidUnico("CONV"),
      idCliente: "573001234567",
      telefono: "573001234567",
      nombre: "Ana Pérez",
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });
    const textos = salidas.filter((s) => s.type === "text").map((s) => s.text.body);
    const fotos = salidas.filter((s) => s.type === "image").map((s) => s.image.link);
    return { traza, texto: textos.join("\n"), textos, fotos };
  };

  return { dice, repos };
}

// --------------------------------------------------------------------------
// 1 · EL CASO EXACTO QUE SE REPORTO
// --------------------------------------------------------------------------

describe("1 · «Quiero un cinturón. ¿Cuánto vale con envío?»", () => {
  const EL_MENSAJE = "Quiero un cinturón. ¿Cuánto vale con envío?";

  test("responde el precio, el envío y el pago", async () => {
    const { dice } = await conversacion();
    const r = await dice(EL_MENSAJE);

    assert.match(r.texto, /49\.900/, "no dijo el precio");
    assert.match(r.texto, /incluido/i, "no dijo que el envío va incluido");
    assert.match(r.texto, /al recibir/i, "no dijo que paga al recibir");
  });

  test("NO responde pidiendo la dirección a secas", async () => {
    // El defecto exacto: "Para continuar me falta la ciudad, la dirección de
    // entrega." como respuesta completa a una pregunta de precio.
    const { dice } = await conversacion();
    const r = await dice(EL_MENSAJE);

    const primeraFrase = r.texto.split(/[.\n]/)[0];
    assert.equal(
      /me falta|dirección|ciudad/i.test(primeraFrase),
      false,
      `lo primero que dice sigue siendo una pedida de datos: "${primeraFrase}"`
    );
  });

  test("el precio va ANTES de pedir los datos", async () => {
    const { dice } = await conversacion();
    const r = await dice(EL_MENSAJE);
    assert.ok(r.texto.indexOf("49.900") < r.texto.search(/me pasas|dirección/i), "pide los datos antes del precio");
  });

  test("la cantidad identificada NO impide informar el precio", async () => {
    // LA CAUSA DEL DEFECTO. "un cinturón" identifica cantidad 1, asi que
    // `faltan` no incluia "cantidad", asi que no se calculaba la cotizacion
    // informativa... y el texto solo miraba esa. Con la cantidad conocida hay
    // algo mejor que la informativa: la cotizacion de verdad.
    const { dice } = await conversacion();
    const r = await dice(EL_MENSAJE);

    assert.ok(!(r.traza.faltan || []).includes("cantidad"), "la cantidad tenía que estar identificada");
    assert.ok(r.traza.cotizacion, "con la cantidad conocida tiene que haber cotización real");
    assert.match(r.texto, /49\.900/);
  });

  test("y no se crea ningún pedido con eso", async () => {
    const { dice, repos } = await conversacion();
    await dice(EL_MENSAJE);
    assert.equal((await repos.pedidos.porContacto("573001234567")).length, 0);
  });
});

// --------------------------------------------------------------------------
// 2 · PREGUNTAR NO ES COMPRAR
// --------------------------------------------------------------------------

describe("2 · a quien averigua no se le piden los datos", () => {
  test("una duda informativa se responde y nada más", async () => {
    const { dice } = await conversacion();
    await dice("hola");

    for (const duda of ["¿tiene garantía?", "¿de qué material es?", "¿cómo funciona?"]) {
      const r = await dice(duda);
      assert.equal(
        /me pasas|tu nombre completo|la dirección/i.test(r.texto),
        false,
        `pidió los datos de entrega ante "${duda}": ${r.texto}`
      );
    }
  });

  test('"¿me sirve a mí?" es una duda, no una señal de compra', async () => {
    // Estuvo roto: "me sirve" estaba en la lista de señales de compra, asi que
    // "¿me sirve a mí? uso talla XL" -la duda mas frecuente de algo que se
    // pone en el cuerpo- recibia una pedida de direccion.
    assert.equal(preguntas.leer("¿me sirve a mí? uso talla XL").compra, false);
    // Afirmando SI es señal de compra: ahi el cliente esta aceptando.
    assert.equal(preguntas.leer("me sirve, lo quiero").compra, true);

    const { dice } = await conversacion();
    const r = await dice("¿me sirve a mí? uso talla XL");
    assert.equal(/me pasas|la dirección/i.test(r.texto), false, `pidió datos: ${r.texto}`);
  });

  test("con señal de compra SÍ se piden los datos", async () => {
    const { dice } = await conversacion();
    await dice("hola");
    const r = await dice("lo quiero");
    assert.match(r.texto, /me pasas|dirección/i, `no pidió los datos: ${r.texto}`);
  });

  test("tras dar el precio sin señal de compra, se pregunta si le sirve", async () => {
    // El microcierre: una sola pregunta facil en vez de los cuatro datos.
    const { dice } = await conversacion();
    await dice("hola");
    const r = await dice("¿cuánto cuesta?");
    assert.match(r.texto, /49\.900/);
    // Se comprueba EL HECHO -que invite sin pedir los datos- y no la frase
    // exacta: la redaccion cambio al mejorar el tono ("¿Te animas y te lo
    // despacho?" en vez de "¿Te sirve?") y una asercion pegada a las
    // palabras obliga a reescribirla cada vez que se afina la voz.
    assert.match(r.texto, /\?/, `no hizo ningún microcierre: ${r.texto}`);
    assert.match(r.texto, /te sirve|te animas|te lo despacho/i, `no invitó a cerrar: ${r.texto}`);
    assert.equal(/tu nombre completo/i.test(r.texto), false, "pidió los datos de golpe");
  });
});

// --------------------------------------------------------------------------
// 3 · CONTINUIDAD: NO REPETIR, NO PREGUNTAR DOS VECES
// --------------------------------------------------------------------------

describe("3 · continuidad", () => {
  test("el saludo va UNA vez en toda la conversación", async () => {
    const { dice } = await conversacion();
    const primera = await dice("hola");
    assert.match(primera.texto, /hola/i);

    for (const seguido of ["¿tiene garantía?", "hola otra vez", "¿cuánto cuesta?"]) {
      const r = await dice(seguido);
      assert.equal(/¡hola!/i.test(r.texto), false, `volvió a saludar ante "${seguido}": ${r.texto}`);
    }
  });

  test("no vuelve a preguntar el producto cuando solo se vende uno", async () => {
    // El bucle que salio al probar: "hola" no nombra el cinturon, asi que
    // cada mensaje caia en producto_desconocido y el bot preguntaba "¿cuál
    // producto te interesa?" una y otra vez, teniendo UN producto en venta.
    const { dice } = await conversacion();
    for (const m of ["hola", "¿tiene garantía?", "¿de qué color viene?", "lo quiero"]) {
      const r = await dice(m);
      assert.equal(
        /cuál producto|qué producto/i.test(r.texto),
        false,
        `preguntó qué producto ante "${m}", y solo vendemos uno: ${r.texto}`
      );
    }
  });

  test("con DOS productos activos sí vuelve a preguntar", async () => {
    // El limite de la regla anterior, y se apaga solo: en cuanto hay entre
    // que elegir, elegir por el cliente seria despachar lo equivocado.
    const senales = require("../src/catalogo/senales");
    const uno = { id: "a", nombre: "A", activo: true, _aliases: [] };
    const dos = { id: "b", nombre: "B", activo: true, _aliases: [] };
    const catalogo = {
      productos: [uno, dos],
      activos: [uno, dos],
      porId: new Map([
        ["a", uno],
        ["b", dos],
      ]),
      productoPorDefecto: null,
    };
    const r = senales.resolver({ texto: "hola, cuanto vale?", catalogo });
    assert.equal(r.productoId, null, "con dos activos no puede elegir solo");
  });

  test("el precio no se repite en cada mensaje", async () => {
    const { dice } = await conversacion();
    await dice("¿cuánto cuesta?");
    const r = await dice("¿y tiene garantía?");
    assert.equal(/49\.900/.test(r.texto), false, `repitió el precio sin que lo pidieran: ${r.texto}`);
  });

  test("pero si lo vuelven a preguntar, se vuelve a decir", async () => {
    const { dice } = await conversacion();
    await dice("¿cuánto cuesta?");
    await dice("¿y tiene garantía?");
    const r = await dice("perdón, ¿cuánto era el precio?");
    assert.match(r.texto, /49\.900/, "se negó a repetir el precio cuando lo preguntaron");
  });
});

// --------------------------------------------------------------------------
// 4 · LO QUE NO ESTA APROBADO SE ADMITE
// --------------------------------------------------------------------------

describe("4 · sin inventar", () => {
  test("la garantía se responde con el plazo confirmado", async () => {
    // ANTES ESTA PRUEBA EXIGIA QUE EL BOT ADMITIERA no tener la garantia, y
    // comprobaba la concordancia de "te la confirmo". Marco confirmo 1 mes
    // el 2026-10-07, asi que ahora se responde el dato.
    //
    // La concordancia se sigue vigilando donde todavia aplica: hay temas sin
    // confirmar y esos siguen usando "te lo/la confirmo".
    const { dice } = await conversacion();
    const r = await dice("¿tiene garantía?");
    // El plazo, sin atarse al orden de las palabras: paso de "garantía de 1
    // mes" a "1 mes de garantía" al darle tono.
    assert.match(r.texto, /1 mes/i, `no dijo el plazo: ${r.texto}`);
    assert.match(r.texto, /garantía/i);

    // Y el alcance NO se completa: que cubre y como se tramita no estan
    // definidos.
    assert.equal(/te lo cambiamos|reembols|devolvemos el dinero/i.test(r.texto), false, "prometió un alcance");

    // ANTES ESTA ASERCION PEDIA QUE DERIVARA A UNA PERSONA, y era lo
    // correcto mientras el tramite no estaba definido. Marco lo confirmo el
    // 2026-10-08, asi que ahora se responde.
    const tramite = await dice("¿y cómo la hago efectiva?");
    assert.match(tramite.texto, /escribes por este mismo WhatsApp/i, `no dijo el trámite: ${tramite.texto}`);
    assert.match(tramite.texto, /cambio del producto/i);

    // Y LAS EXCLUSIONES SE DICEN. Quien pregunta "¿cómo la hago efectiva?"
    // esta pidiendo el limite; ocultarlo hasta el dia del reclamo convierte
    // la garantia en una discusion.
    assert.match(tramite.texto, /no cubre/i, "no dijo lo que NO cubre");
    assert.match(tramite.texto, /mojarlo/i, "la exclusión más probable de un producto con panel de control");
  });

  test("las exclusiones NO salen en la primera respuesta", async () => {
    // Abrir con "no cubre si lo mojas" suena a que esperamos que el cliente
    // haga algo mal, y enfria una venta que iba bien. Se dicen cuando
    // preguntan por el alcance.
    const { dice } = await conversacion();
    const r = await dice("¿tiene garantía?");
    assert.match(r.texto, /1 mes/);
    assert.equal(/no cubre|mojarlo|mal uso/i.test(r.texto), false, `abrió con las exclusiones: ${r.texto}`);
  });

  test("«¿me sirve?» dice que es graduable, sin prometer que le queda a cualquiera", async () => {
    // Marco confirmo que la correa es graduable. Lo que NO hay es la medida
    // maxima, asi que "le queda a cualquiera" sigue sin respaldo.
    //
    // Importa por como quedo la garantia: cubre defecto de fabrica, NO "no
    // me quedó". Prometer el ajuste y no cumplirlo deja a la clienta sin
    // garantia y con razon para quejarse.
    const { dice } = await conversacion();
    const r = await dice("¿me sirve? tengo la cintura ancha");

    assert.match(r.texto, /graduable|se ajusta/i, `no dijo lo que sí sabemos: ${r.texto}`);
    assert.equal(
      /le queda a cualquiera|sin problema|no importa|a todas/i.test(r.texto),
      false,
      `prometió ajuste universal sin medida: ${r.texto}`
    );
    const claims = responder.revisarClaims(r.texto, elCinturon());
    assert.equal(claims.ok, true, JSON.stringify(claims.encontrados));
  });

  test("ante «¿me sirve?» NO promete que sirva para cualquier contorno", async () => {
    const { dice } = await conversacion();
    const r = await dice("¿me sirve? tengo bastante abdomen");

    const claims = responder.revisarClaims(r.texto, elCinturon());
    assert.equal(claims.ok, true, `prometió ajuste: ${JSON.stringify(claims.encontrados)}`);
    assert.match(r.texto, /no tengo las medidas|confirmo/i, "no admitió que no tiene la medida");
  });

  test("el tiempo de entrega se dice como RANGO, nunca como un día concreto", async () => {
    // ANTES ESTA PRUEBA EXIGIA QUE NO HUBIERA NINGUN PLAZO, y era lo
    // correcto mientras el dato no existia. Marco lo confirmo el 2026-10-07
    // tomandolo de BIKERPRO -mismas transportadoras, mismos tiempos-, asi
    // que mantener la asercion obligaria a callar un dato aprobado.
    //
    // Lo que hay que vigilar ahora es OTRA cosa, y es mas sutil: que el
    // rango no se convierta en una fecha. "1 a 3 días hábiles" es un plazo
    // de la transportadora; "te llega mañana" es una promesa que depende de
    // la hora de corte y que nadie de NOVIKA controla.
    const { dice } = await conversacion();
    const r = await dice("¿cuándo llega?");

    assert.match(r.texto, /1 a 3 días hábiles/, `no dijo el plazo confirmado: ${r.texto}`);
    // El matiz, en cualquiera de sus formas: "según la ciudad" paso a
    // "según tu ciudad" al hablarle de usted a ella y no de la
    // transportadora.
    assert.match(r.texto, /según (la|tu) ciudad/, "sin el matiz, el rango se lee como un compromiso");
    assert.equal(
      /mañana|pasado mañana|hoy mismo|el lunes|el martes|al día siguiente/i.test(r.texto),
      false,
      `prometió una fecha concreta: ${r.texto}`
    );

    // Y el candado de verdad: esas promesas estan prohibidas por codigo.
    const claims = responder.revisarClaims("Te llega mañana sin falta.", elCinturon());
    assert.equal(claims.ok, false, "prometer un día concreto tiene que estar bloqueado");
  });

  test("responde la desconfianza con un hecho, no con adjetivos", async () => {
    const { dice } = await conversacion();
    const r = await dice("¿esto es confiable o es estafa?");
    // El argumento que de verdad quita el riesgo es el pago contraentrega, y
    // sale del catalogo: no hay que adelantar plata.
    assert.match(r.texto, /pagas cuando|al recibir|no tienes que adelantar/i, `no usó el pago como respuesta: ${r.texto}`);
    // Y nada de adjetivos vacios.
    assert.equal(/somos serios|confía en nosotros/i.test(r.texto), false);
  });
});

// --------------------------------------------------------------------------
// 5 · LA CALIDEZ NO PUEDE COSTAR UN COBRO MAL
//
// Todo texto nuevo pasa por los mismos dos filtros que el borrador de la IA.
// Es lo que separa esta bateria de un cambio cosmetico.
// --------------------------------------------------------------------------

describe("5 · ningún texto nuevo introduce una cifra o una promesa", () => {
  const SITUACIONES = [
    "producto_desconocido",
    "producto_en_borrador",
    "producto_ambiguo",
    "cotizacion",
    "faltan_datos",
    "resumen",
    "confirmado",
    "ya_confirmado",
    "cancelado",
    "escalado",
    "sin_respuesta_automatica",
  ];

  const MENSAJES = [
    "hola",
    "¿cuánto vale con envío?",
    "¿tiene garantía?",
    "¿me sirve? uso talla XL",
    "¿cuándo llega?",
    "¿de qué color?",
    "lo quiero",
    "sí confirmo",
    "¿es estafa?",
    "",
  ];

  test("ningún texto determinista contiene un claim prohibido", () => {
    const producto = elCinturon();
    const cot = cotizador.cotizar({ producto, cantidad: 1 }).cotizacion;

    for (const situacion of SITUACIONES) {
      for (const mensajeCliente of MENSAJES) {
        for (const memoria of [{}, { saludado: true, datosPedidos: true, precioInformado: true }]) {
          const texto = responder.textoDeterminista({
            situacion,
            cotizacion: cot,
            faltan: ["nombre", "ciudad", "direccion"],
            opciones: ["uno", "otro"],
            pedido: { id: "NOV-X" },
            producto,
            mensajeCliente,
            memoria,
          });
          const claims = responder.revisarClaims(texto, producto);
          assert.equal(
            claims.ok,
            true,
            `claim prohibido en ${situacion} con "${mensajeCliente}": ${JSON.stringify(claims.encontrados)} -> ${texto}`
          );
        }
      }
    }
  });

  test("ningún texto determinista contiene un importe sin calcular", () => {
    const producto = elCinturon();
    const cot = cotizador.cotizar({ producto, cantidad: 1 }).cotizacion;

    for (const situacion of SITUACIONES) {
      for (const mensajeCliente of MENSAJES) {
        const texto = responder.textoDeterminista({
          situacion,
          cotizacion: cot,
          faltan: ["nombre", "ciudad"],
          pedido: { id: "NOV-X" },
          producto,
          mensajeCliente,
        });
        const r = cotizador.revisarImportes(texto, cot.importesAutorizados);
        assert.equal(
          r.ok,
          true,
          `importe no autorizado en ${situacion} con "${mensajeCliente}": ${JSON.stringify(r.sospechosos)} -> ${texto}`
        );
      }
    }
  });

  test("SIN cotización, ningún texto nombra una cifra", () => {
    // El caso peligroso: el producto en borrador, o antes de poder cotizar.
    // Aqui no hay ningun importe autorizado, asi que cualquier cifra sobra.
    const producto = elCinturon();
    for (const situacion of SITUACIONES) {
      for (const mensajeCliente of MENSAJES) {
        const texto = responder.textoDeterminista({
          situacion,
          cotizacion: null,
          cotizacionInformativa: null,
          faltan: ["nombre", "ciudad"],
          producto,
          mensajeCliente,
        });
        assert.equal(
          /\$|\d{3,}/.test(texto),
          false,
          `cifra sin cotización en ${situacion} con "${mensajeCliente}": ${texto}`
        );
      }
    }
  });

  test("ningún texto se queda vacío", () => {
    // Un mensaje vacio no se envia -el emisor lo bloquea- y el cliente se
    // queda sin respuesta sin que nadie se entere.
    const producto = elCinturon();
    const cot = cotizador.cotizar({ producto, cantidad: 1 }).cotizacion;
    for (const situacion of SITUACIONES) {
      for (const mensajeCliente of MENSAJES) {
        const texto = responder.textoDeterminista({
          situacion,
          cotizacion: cot,
          faltan: [],
          producto,
          mensajeCliente,
        });
        assert.ok(String(texto).trim().length > 10, `texto vacío o mínimo en ${situacion}: "${texto}"`);
      }
    }
  });
});

// --------------------------------------------------------------------------
// 6 · LA VENTA SIGUE CERRANDO
//
// Todo lo anterior cambia como se habla. Esto comprueba que no rompio la
// venta: el pedido sigue entrando una vez, con el total y el pago correctos.
// --------------------------------------------------------------------------

describe("6 · la venta cierra igual", () => {
  test("conversación completa con dudas por el medio: UN pedido correcto", async () => {
    const { dice, repos } = await conversacion();

    await dice("Hola, buenas tardes");
    await dice("¿tiene garantía?");
    await dice("¿me sirve? uso talla XL");
    await dice("Quiero un cinturón. ¿Cuánto vale con envío?");
    await dice("lo quiero");
    const resumen = await dice("Ana Pérez, Medellín, Calle 45 # 23-10");
    assert.equal(resumen.traza.respuesta.situacion, "resumen", `situación: ${resumen.traza.respuesta.situacion}`);
    assert.match(resumen.texto, /49\.900/);

    const conf = await dice("sí confirmo");
    assert.equal(conf.traza.respuesta.situacion, "confirmado");

    const pedidos = await repos.pedidos.porContacto("573001234567");
    assert.equal(pedidos.length, 1, "el pedido tiene que entrar UNA vez");
    assert.equal(pedidos[0].cotizacion.total, 49900);
    assert.equal(pedidos[0].cotizacion.condiciones.pagoMetodo, "contraentrega");
  });

  test("con el interruptor apagado no sale nada", async () => {
    const { dice } = await conversacion({ respuestaAutomatica: false });
    const r = await dice("Quiero un cinturón. ¿Cuánto vale con envío?");
    assert.equal(r.textos.length, 0);
    assert.equal(r.fotos.length, 0);
    assert.equal(r.traza.enviada, false);
    assert.ok(r.traza.respuesta.texto.length > 0, "en modo sombra se prepara igual");
  });
});

void DIR;
