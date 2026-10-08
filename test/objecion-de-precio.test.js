"use strict";

// ==========================================================================
// "ESTA MUY CARO" — LA OBJECION QUE MAS PLATA MUEVE
//
// Hasta este cambio no se reconocia: caia en el camino generico y el bot
// contestaba "dime que necesitas" a quien estaba a un paso de comprar.
//
// La FORMA de la respuesta viene de BIKERPRO, que la tiene medida: no saltar
// al descuento, porque las jugadas que no cuestan nada cierran igual o
// mejor. Las CONDICIONES no se copian: su tope de descuento, su envio
// cobrado aparte y su politica de pago anticipado son de ese negocio.
//
// Lo que estas pruebas protegen, en orden de cuanto cuesta equivocarse:
//
//   1. QUE EL BOT NUNCA OFREZCA UN DESCUENTO. NOVIKA no tiene politica de
//      descuento aprobada. El bot de BIKERPRO se invento "$55.900 con pago
//      anticipado" en la primera objecion, y eso estaba tasado en
//      ~$482.400/mes.
//   2. Que objetar el precio NO se lea como comprar: "esta muy caro, pero
//      bueno" salia con compra=true y el bot le pedia la direccion a quien
//      acababa de quejarse del precio.
//   3. Que "Caro" -como se llama media Carolina en Colombia- no se lea como
//      una objecion, porque el bot EXTRAE EL NOMBRE del texto.
//   4. Que a quien se queja del precio no se le repita el precio.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const voz = require("../src/cerebro/voz");
const responder = require("../src/cerebro/responder");
const contestar = require("../src/cerebro/contestar");
const cotizador = require("../src/dominio/cotizador");
const preguntas = require("../src/dominio/preguntas");
const { TEMAS } = preguntas;
const { cargarCatalogo } = require("../src/catalogo");

const RAIZ = path.join(__dirname, "..");
const elCinturon = () =>
  cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
    "cinturon-termico-colicos"
  );
const cotizacionDe = (cantidad = 1) =>
  cotizador.cotizar({ producto: elCinturon(), cantidad }).cotizacion;

/** Las formas en que de verdad llega la objecion por WhatsApp. */
const OBJECIONES = [
  "esta muy caro",
  "está muy caro",
  "uy que caro",
  "esta caro",
  "estan muy caros",
  "carisimo",
  "carísimo",
  "es costoso",
  "muy costoso",
  "no me alcanza",
  "no tengo tanto",
  "no tengo esa plata",
  "es mucha plata",
  "hay descuento?",
  "me das rebaja?",
  "no lo tienes mas barato?",
  "algo mas economico?",
  "cual es el ultimo precio",
  "me lo dejas en 40000",
  "bajas algo el precio?",
  "se sale de mi presupuesto",
  "esta en promocion?",
];

// --------------------------------------------------------------------------
// 1 · EL DETECTOR
// --------------------------------------------------------------------------

describe("1 · objetar el precio se reconoce, y no se confunde con otras cosas", () => {
  test("las formas reales de objetar el precio se reconocen", () => {
    for (const frase of OBJECIONES) {
      const r = preguntas.leer(frase);
      assert.ok(
        r.temas.includes(TEMAS.OBJECION_PRECIO),
        `no reconocio la objecion de precio: ${frase}`
      );
    }
  });

  test('"demora mucho?" pregunta por la entrega, NO objeta el precio', () => {
    // El defecto esta documentado en BIKERPRO: con un `mucho` suelto en el
    // patron, el bot le rebatia el precio a quien pregunto cuando le llega.
    for (const frase of ["demora mucho?", "demora mucho tiempo?", "se demora mucho"]) {
      const r = preguntas.leer(frase);
      assert.equal(
        r.temas.includes(TEMAS.OBJECION_PRECIO),
        false,
        `le rebatiria el precio a quien pregunto por la entrega: ${frase}`
      );
      assert.ok(r.temas.includes(TEMAS.ENTREGA), `no reconocio la pregunta de entrega: ${frase}`);
    }
  });

  test('"Caro" es un NOMBRE, y el bot extrae el nombre del texto', () => {
    // En Colombia media Carolina se presenta como "Caro". Con un `\bcaro\b`
    // suelto en el patron, dar los datos para comprar se leeria como una
    // objecion de precio: el peor momento posible para ponerse a rebatir.
    for (const frase of ["soy Caro", "me llamo Caro Gomez", "soy Caro, vivo en Bogota"]) {
      const r = preguntas.leer(frase);
      assert.equal(
        r.temas.includes(TEMAS.OBJECION_PRECIO),
        false,
        `confundio un nombre con una objecion de precio: ${frase}`
      );
    }
  });

  test("objetar el precio NO es comprar: una señal debil no lo convierte", () => {
    // Medido antes de este cambio: "esta muy caro, pero bueno" salia con
    // compra=true -por la muletilla "bueno"- y el bot le pedia nombre,
    // ciudad y direccion a quien acababa de decir que el precio le parecia
    // alto.
    for (const frase of ["esta muy caro, pero bueno", "carisimo, pero listo", "no me alcanza, vale"]) {
      const r = preguntas.leer(frase);
      assert.equal(r.compra, false, `trato una objecion como una compra: ${frase}`);
    }
  });

  test("pero una señal FUERTE sigue ganando: objetar y comprar a la vez", () => {
    // Una objecion no puede bloquear un "me lo llevo": el cliente puede
    // quejarse del precio y comprar en el mismo mensaje.
    for (const frase of ["esta caro pero me lo llevo", "carisimo, igual lo quiero"]) {
      const r = preguntas.leer(frase);
      assert.equal(r.compra, true, `no vio la compra detras de la objecion: ${frase}`);
      assert.ok(r.temas.includes(TEMAS.OBJECION_PRECIO), `perdio la objecion: ${frase}`);
    }
  });

  test("a quien se queja del precio NO se le vuelve a cantar el precio", () => {
    const r = preguntas.leer("esta muy caro cuanto vale");
    assert.ok(r.temas.includes(TEMAS.OBJECION_PRECIO));
    assert.equal(
      r.temas.includes(TEMAS.PRECIO),
      false,
      "volveria a cantarle la cifra a quien dijo que le parece alta"
    );
  });

  test("pero si pregunta por una CANTIDAD concreta, ahi si quiere una cifra", () => {
    // "esta caro, cuanto valen dos?" si pide un numero, y la cantidad tiene
    // que sobrevivir a que se quite el tema PRECIO.
    const r = preguntas.leer("esta caro, cuanto valen dos?");
    assert.ok(r.temas.includes(TEMAS.OBJECION_PRECIO));
    assert.ok(r.temas.includes(TEMAS.PRECIO), "no le daria el precio que pidio");
    assert.equal(r.cantidadPreguntada, 2, "perdio por cuantas unidades pregunto");
  });

  test("objetar es una pregunta informativa: no autoriza a pedir los datos", () => {
    for (const frase of ["esta muy caro", "hay descuento?"]) {
      assert.equal(preguntas.esInformativo(frase), true, `pediria los datos de entrega: ${frase}`);
    }
  });
});

// --------------------------------------------------------------------------
// 2 · LA ESCALERA, SIN DESCUENTO
// --------------------------------------------------------------------------

describe("2 · la respuesta recorre la escalera y nunca ofrece un descuento", () => {
  test("responde con las condiciones que SI estan aprobadas", () => {
    const t = contestar.deTema(TEMAS.OBJECION_PRECIO, {
      producto: elCinturon(),
      cotizacion: cotizacionDe(1),
    });
    // 1. el envio va incluido: el precio que vio es el final.
    assert.match(t, /envío ya va incluido/i, `no dijo que el envio va incluido: ${t}`);
    // 2. paga al recibir: no arriesga plata.
    assert.match(t, /no arriesgas nada/i, `no uso el contraentrega como argumento: ${t}`);
    // 3. la segunda unidad, el paso mas fuerte de la escalera.
    assert.match(t, /si llevas dos/i, `no ofrecio la pareja: ${t}`);
  });

  test("la respuesta a la objecion no nombra ninguna cifra", () => {
    // El importe autorizado del turno es el de la cantidad cotizada. Colar
    // aqui el de otra cantidad es justo lo que `revisarImportes` caza, asi
    // que se ofrece pasar el precio de dos SIN escribirlo.
    const t = contestar.deTema(TEMAS.OBJECION_PRECIO, {
      producto: elCinturon(),
      cotizacion: cotizacionDe(1),
    });
    assert.equal(/\$|\d{3,}/.test(t), false, `metio una cifra en la respuesta a la objecion: ${t}`);
  });

  test("NUNCA ofrece un descuento, ni rebaja, ni pago anticipado", () => {
    // LA PRUEBA QUE MAS PLATA PROTEGE. NOVIKA no tiene politica de descuento
    // aprobada, y el catalogo declara "si hay descuento por cantidad" como
    // dato NO confirmado. En BIKERPRO el bot se invento un precio con pago
    // anticipado en la primera objecion.
    const producto = elCinturon();
    const cot = cotizacionDe(1);
    const PROHIBIDO =
      /te (hago|doy) (un )?descuento|te (rebajo|bajo)|te lo dejo en|precio especial|pago anticipado|si pagas por adelantado|te regalo|descuento de/i;

    for (const mensajeCliente of OBJECIONES) {
      for (const memoria of [{}, { saludado: true, precioInformado: true }]) {
        const texto = responder.textoDeterminista({
          situacion: "faltan_datos",
          cotizacion: cot,
          faltan: ["nombre", "ciudad", "direccion"],
          producto,
          mensajeCliente,
          memoria,
        });
        assert.equal(
          PROHIBIDO.test(texto),
          false,
          `ofrecio un descuento ante "${mensajeCliente}": ${texto}`
        );
      }
    }
  });

  test("y pasa los mismos dos filtros que el borrador de la IA", () => {
    const producto = elCinturon();
    const cot = cotizacionDe(1);

    for (const mensajeCliente of OBJECIONES) {
      const texto = responder.textoDeterminista({
        situacion: "faltan_datos",
        cotizacion: cot,
        faltan: ["nombre", "ciudad", "direccion"],
        producto,
        mensajeCliente,
        memoria: { saludado: true },
      });

      const claims = responder.revisarClaims(texto, producto);
      assert.equal(
        claims.ok,
        true,
        `claim prohibido ante "${mensajeCliente}": ${JSON.stringify(claims.encontrados)} -> ${texto}`
      );

      const importes = cotizador.revisarImportes(texto, cot.importesAutorizados);
      assert.equal(
        importes.ok,
        true,
        `importe no autorizado ante "${mensajeCliente}": ${JSON.stringify(importes.sospechosos)} -> ${texto}`
      );

      assert.ok(texto.trim().length > 0, `se quedo sin responder a "${mensajeCliente}"`);
    }
  });

  test("no abre con «Claro que sí»: a quien se queja se le reconoce la queja", () => {
    const abre = voz.apertura([TEMAS.OBJECION_PRECIO]);
    assert.ok(abre, "la objecion de precio no tiene apertura y el mensaje arrancaria en seco");
    assert.notEqual(abre, voz.APERTURAS[TEMAS.PRECIO]);
    assert.match(abre, /entiendo/i, `no le reconoce la queja: ${abre}`);
  });

  test("si el mensaje ya canto las condiciones, no las repite", () => {
    // "esta caro, el envio cuanto vale?" encabeza con la linea comercial
    // -que dice "con envio incluido y pagas al recibir"- y la respuesta a la
    // objecion las repetia enteras unas palabras despues.
    const texto = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizacionDe(1),
      faltan: ["nombre", "ciudad", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "esta caro, el envio cuanto vale?",
      memoria: { saludado: true },
    });

    const veces = (texto.match(/envío/gi) || []).length;
    assert.equal(veces, 1, `dijo "envío" ${veces} veces en el mismo mensaje: ${texto}`);
    assert.match(texto, /si llevas dos/i, `perdio la oferta de la pareja: ${texto}`);
  });
});

// --------------------------------------------------------------------------
// 3 · LA SEGUNDA UNIDAD SE COMPRUEBA CONTRA EL COTIZADOR, NO SE AFIRMA
//
// Es el paso mas fuerte de la escalera y el unico donde bajarle el costo a
// la clienta nos deja MAS plata. Precisamente por eso no puede ser una
// frase fija: si la tabla cambia y dos dejan de convenir, la frase tiene
// que desaparecer sola, sin que nadie se acuerde de venir a borrarla.
// --------------------------------------------------------------------------

describe("3 · la oferta de la pareja depende de la tabla, no del texto", () => {
  const conPrecios = (precios) => {
    const p = structuredClone(elCinturon());
    p.precios = precios;
    return p;
  };

  test("si la tabla NO tiene precio para dos, no se ofrece la pareja", () => {
    const t = contestar.deTema(TEMAS.OBJECION_PRECIO, {
      producto: conPrecios({ 1: 49900 }),
      cotizacion: cotizacionDe(1),
    });
    assert.equal(/llevas dos/i.test(t), false, `ofrecio una pareja que no tiene precio: ${t}`);
    // Y sigue respondiendo algo util: la objecion no se queda sin respuesta.
    assert.match(t, /envío ya va incluido/i, `se quedo sin argumento: ${t}`);
  });

  test("si dos cuestan exactamente el doble, tampoco: no habria nada que ofrecer", () => {
    const t = contestar.deTema(TEMAS.OBJECION_PRECIO, {
      producto: conPrecios({ 1: 49900, 2: 99800 }),
      cotizacion: cotizacionDe(1),
    });
    assert.equal(
      /sale mejor que dos por separado/i.test(t),
      false,
      `afirmo un ahorro que la tabla no respalda: ${t}`
    );
  });

  test("con la tabla de verdad, la pareja SI conviene y se ofrece", () => {
    // Que la prueba de arriba no pase por una ruta muerta: con los precios
    // reales del catalogo la frase tiene que aparecer.
    const una = cotizador.cotizar({ producto: elCinturon(), cantidad: 1 }).cotizacion;
    const dos = cotizador.cotizar({ producto: elCinturon(), cantidad: 2 }).cotizacion;
    assert.ok(dos.total < una.total * 2, "la tabla real ya no premia llevar dos: revisar el guion");

    const t = contestar.deTema(TEMAS.OBJECION_PRECIO, {
      producto: elCinturon(),
      cotizacion: una,
    });
    assert.match(t, /sale mejor que dos por separado/i);
  });
});

// --------------------------------------------------------------------------
// 4 · "Y SI LLEVO DOS?" — LA PROMESA SE CUMPLE
//
// La respuesta a la objecion ofrece pasar el precio de dos. Esa frase es
// una promesa, y antes de este cambio el bot NO la cumplia: "y si llevo
// dos?" no se reconocia como pregunta de precio, el extractor se quedaba
// con el "dos" como cantidad de la ficha y la clienta recibia un
// "¡Perfecto, gracias!" sin una sola cifra.
//
// Es el mismo defecto que ya tuvo el bot con las fotos: anunciar algo y no
// mandarlo.
// --------------------------------------------------------------------------

describe("4 · la pregunta condicional por otra cantidad", () => {
  test("«y si llevo dos?» es una pregunta de precio por DOS, no una compra", () => {
    for (const frase of ["y si llevo dos?", "y si me llevo dos?", "y llevando dos?", "si llevara dos?"]) {
      const r = preguntas.leer(frase);
      assert.ok(r.temas.includes(TEMAS.PRECIO), `no la leyo como pregunta de precio: ${frase}`);
      assert.equal(r.cantidadPreguntada, 2, `no saco la cantidad preguntada: ${frase}`);
      assert.equal(r.compra, false, `la trato como una compra cerrada: ${frase}`);
    }
  });

  test("y le contesta con el precio de DOS, que es lo que le prometio", () => {
    const texto = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizacionDe(2),
      faltan: ["nombre", "ciudad", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "y si llevo dos?",
      memoria: { saludado: true },
    });
    assert.match(texto, /2 unidades/i, `no cotizo por dos: ${texto}`);
    assert.match(texto, /\$85\.000/, `no dio el precio de dos: ${texto}`);
  });

  test("un «sí» rotundo NO se confunde con la pregunta condicional", () => {
    // `aplanar` se come la coma, asi que "si, me llevo dos" y "si me llevo
    // dos" llegan al detector IDENTICAS. Por eso el patron exige el "y"
    // delante, el subjuntivo o el gerundio: un "si llevo dos" pelado se
    // queda fuera a proposito, porque cotizarle a quien estaba diciendo que
    // si es peor que no entenderle la pregunta.
    for (const frase of ["si, me llevo dos", "si llevo dos", "me llevo dos"]) {
      const r = preguntas.leer(frase);
      assert.equal(
        r.temas.includes(TEMAS.PRECIO),
        false,
        `le cotizo a quien estaba cerrando la compra: ${frase}`
      );
    }
  });

  test("por una cantidad SIN tarifa sigue sin improvisar", () => {
    // "y si llevo tres?" entra por el mismo patron nuevo, y la tabla solo
    // cubre 1 y 2. No se interpola: se admite y queda la tarea.
    const r = preguntas.leer("y si llevo tres?");
    assert.equal(r.cantidadPreguntada, 3);

    const texto = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizacionDe(1),
      cantidadSinTarifa: 3,
      faltan: ["nombre", "ciudad", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "y si llevo tres?",
      memoria: { saludado: true },
    });
    assert.equal(/\$/.test(texto), false, `solto una cifra por tres unidades: ${texto}`);
  });
});

// --------------------------------------------------------------------------
// 5 · SI EL MODELO SE INVENTA UN DESCUENTO, NO SALE
//
// LA PRUEBA QUE MAS PLATA PROTEGE DE TODO EL ARCHIVO.
//
// No es un caso hipotetico: el bot de BIKERPRO ofrecio "$55.900 con pago
// anticipado" en la PRIMERA objecion de precio, inventandose una politica
// que nadie habia aprobado. El riesgo quedo tasado en ~$482.400/mes.
//
// Reconocer la objecion como tema tiene un efecto que conviene dejar por
// escrito: a partir de ahora el turno lo cubre el catalogo, asi que el
// borrador del modelo se descarta y sale el texto determinista. Es
// deliberado. En la objecion de precio el modelo no redacta.
// --------------------------------------------------------------------------

describe("5 · ante una objecion, el modelo no redacta", () => {
  const INVENTOS = [
    "Te lo dejo en $55.900 si pagas por adelantado 🙌",
    "Te hago un descuento de $3.000 si lo cerramos hoy",
    "Claro, te puedo dar un precio especial de $45.000",
    "Si llevas dos te regalo el envío y te bajo $5.000",
  ];

  test("el descuento inventado se descarta y sale la escalera", () => {
    const producto = elCinturon();
    const cot = cotizacionDe(1);

    for (const borradorIA of INVENTOS) {
      const r = responder.preparar({
        situacion: "faltan_datos",
        cotizacion: cot,
        faltan: ["nombre", "ciudad", "direccion"],
        producto,
        mensajeCliente: "esta muy caro",
        memoria: { saludado: true },
        borradorIA,
      });

      assert.equal(r.origen, "determinista", `dejo redactar al modelo: ${borradorIA}`);
      assert.notEqual(r.texto, borradorIA);
      // Y lo que de verdad importa: la cifra inventada no sale.
      assert.equal(
        /55\.900|45\.000|3\.000|5\.000/.test(r.texto),
        false,
        `se colo una cifra inventada: ${r.texto}`
      );
      const importes = cotizador.revisarImportes(r.texto, cot.importesAutorizados);
      assert.equal(importes.ok, true, `importe no autorizado: ${JSON.stringify(importes.sospechosos)}`);
    }
  });
});
