"use strict";

// ==========================================================================
// EL TONO: QUE NO SUENE A ROBOT
//
// DE DONDE SALE: Marco volvio a probar el bot desde su numero DESPUES del
// primer trabajo de voz y dijo que sigue escribiendo "muy seco, sin emojis
// y muy tipo robot". Pidio el tono de BIKERPRO: "mira como utiliza los
// emojis, como le habla al cliente, siendo un poco mas amable y persuasivo
// para vender".
//
// Las reglas no se inventaron: estan escritas en el guion de BIKERPRO y son
// las cuatro que aqui faltaban.
//
//   1. "Emojis con moderación (1 o 2 por mensaje)" — aqui el tope era UNO,
//      y habia mensajes enteros con NINGUNO.
//   2. "SIEMPRE termina con una pregunta que avanza la venta" — aqui varios
//      mensajes acababan en seco ("Cuando quieras lo preparamos.").
//   3. Mensajes cortos, colombiano, cercano, de "tú".
//   4. Reconocer antes de dar el dato.
//
// ⚠️ LO QUE ESTAS PRUEBAS NO PUEDEN HACER, Y CONVIENE NO OLVIDARLO: medir
// si el tono VENDE mas. Eso solo se ve en la conversion real. Lo que se
// puede fijar es que el bot no vuelva a quedarse seco sin que nadie se
// entere, que es como se llego hasta aqui.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const voz = require("../src/cerebro/voz");
const responder = require("../src/cerebro/responder");
const cotizador = require("../src/dominio/cotizador");
const { cargarCatalogo } = require("../src/catalogo");

const RAIZ = path.join(__dirname, "..");
const elCinturon = () =>
  cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
    "cinturon-termico-colicos"
  );
const cotizacionDe = (cantidad = 1) =>
  cotizador.cotizar({ producto: elCinturon(), cantidad }).cotizacion;

/** Los turnos de venta: los que el cliente lee mientras decide. */
const DE_VENTA = [
  "hola",
  "¿cuánto vale?",
  "¿cuánto vale con envío?",
  "¿cuánto cuestan dos?",
  "¿tiene garantía?",
  "¿me sirve? uso talla XL",
  "¿cuándo llega?",
  "¿de qué color?",
  "¿para qué sirve?",
  "¿es estafa?",
  "está muy caro",
  "hay descuento?",
  "lo quiero",
];

const unTexto = (mensajeCliente, extra = {}) =>
  responder.textoDeterminista({
    situacion: "faltan_datos",
    cotizacion: cotizacionDe(1),
    faltan: ["nombre", "ciudad", "direccion"],
    producto: elCinturon(),
    mensajeCliente,
    memoria: { saludado: true },
    ...extra,
  });

// --------------------------------------------------------------------------
// 1 · NI UN MENSAJE DE VENTA SECO
// --------------------------------------------------------------------------

describe("1 · ningún mensaje de venta sale sin emoji", () => {
  test("todo turno de venta lleva al menos uno", () => {
    // Era el defecto literal que reporto Marco: "sigue escribiendo muy seco,
    // sin emojis". Varias ramas componian con `emoji: null`.
    for (const mensajeCliente of DE_VENTA) {
      const texto = unTexto(mensajeCliente);
      assert.ok(
        voz.cuantosEmojis(texto) >= 1,
        `mensaje seco, sin un solo emoji, ante "${mensajeCliente}": ${texto}`
      );
    }
  });

  test("y entre uno y dos, nunca tres", () => {
    for (const mensajeCliente of DE_VENTA) {
      const n = voz.cuantosEmojis(unTexto(mensajeCliente));
      assert.ok(n >= 1 && n <= 2, `${n} emojis ante "${mensajeCliente}"`);
    }
  });

  test("los mensajes que admiten no saber algo tampoco salen secos", () => {
    // Son los que mas frios se leen, porque la noticia ya no es la que el
    // cliente queria. Antes iban todos con `emoji: null`.
    const texto = unTexto("¿me lo puedo poner dormida toda la noche?");
    assert.ok(voz.cuantosEmojis(texto) >= 1, `admitir un hueco salió seco: ${texto}`);

    const sinTarifa = unTexto("¿cuánto cuestan tres?", { cantidadSinTarifa: 3 });
    assert.ok(voz.cuantosEmojis(sinTarifa) >= 1, `el precio sin aprobar salió seco: ${sinTarifa}`);
  });
});

// --------------------------------------------------------------------------
// 2 · SIEMPRE UNA PREGUNTA QUE AVANZA LA VENTA
// --------------------------------------------------------------------------

describe("2 · el mensaje cierra invitando, no avisando", () => {
  test("un turno informativo acaba en pregunta, no en un aviso", () => {
    // La regla de tono de BIKERPRO: "SIEMPRE termina con una pregunta que
    // avanza la venta". Aqui acababa en "Cuando quieras lo preparamos.",
    // que no pide nada pero tampoco invita a nada.
    for (const mensajeCliente of ["¿tiene garantía?", "¿para qué sirve?", "¿de qué color?"]) {
      const texto = unTexto(mensajeCliente);
      assert.match(texto, /\?\s*[^\s]*\s*$/u, `no cierra con una pregunta: ${texto}`);
    }
  });

  test("ya no existe el cierre que no invitaba a nada", () => {
    for (const mensajeCliente of DE_VENTA) {
      const texto = unTexto(mensajeCliente);
      assert.equal(
        /cuando quieras lo preparamos/i.test(texto),
        false,
        `volvió el cierre que se moría solo: ${texto}`
      );
    }
  });

  test("pero a quien solo averigua NO se le piden los datos", () => {
    // La calidez no puede costar la regla que mas importa: invitar no es
    // pedir nombre, ciudad y direccion a quien esta preguntando.
    const texto = unTexto("¿tiene garantía?");
    assert.equal(
      /nombre completo|la dirección/i.test(texto),
      false,
      `le pidió los datos a quien solo preguntaba: ${texto}`
    );
  });
});

// --------------------------------------------------------------------------
// 3 · LA CALIDEZ NO TOCA EL DATO
//
// La misma guarda que ya protege el resto: si una frase de tono afirmara
// algo del producto o colara una cifra, seria un dato inventado con buen
// tono. Es lo que separa este cambio de un maquillaje.
// --------------------------------------------------------------------------

describe("3 · más calidez, mismas garantías", () => {
  test("ni un claim prohibido ni un importe sin calcular", () => {
    const producto = elCinturon();
    const cot = cotizacionDe(1);
    for (const mensajeCliente of DE_VENTA) {
      const texto = unTexto(mensajeCliente);

      const claims = responder.revisarClaims(texto, producto);
      assert.equal(
        claims.ok,
        true,
        `claim ante "${mensajeCliente}": ${JSON.stringify(claims.encontrados)} -> ${texto}`
      );

      const importes = cotizador.revisarImportes(texto, cot.importesAutorizados);
      assert.equal(
        importes.ok,
        true,
        `importe ante "${mensajeCliente}": ${JSON.stringify(importes.sospechosos)} -> ${texto}`
      );
    }
  });

  test("«¿te lo aparto?» no promete despacho ni plazo", () => {
    // Apartar es lo que SI hacemos. Prometer que sale hoy, no: esas frases
    // estan en claimsProhibidos y ahi se quedan.
    for (const mensajeCliente of DE_VENTA) {
      const texto = unTexto(mensajeCliente);
      assert.equal(
        /despacho hoy|sale hoy|te llega mañana|entrega inmediata/i.test(texto),
        false,
        `prometió despacho al invitar: ${texto}`
      );
    }
  });

  test("la mayúscula no se pierde detrás del emoji de en medio", () => {
    // Un mensaje con dos emojis lleva uno en medio, y detras va una frase
    // nueva: tiene que seguir empezando en mayuscula.
    for (const mensajeCliente of DE_VENTA) {
      const texto = unTexto(mensajeCliente);
      assert.equal(
        /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s+\p{Ll}/u.test(texto),
        false,
        `minúscula detrás del emoji ante "${mensajeCliente}": ${texto}`
      );
    }
  });
});

// --------------------------------------------------------------------------
// 4 · ABRE POR EL TEMA QUE DE VERDAD CONTESTA
// --------------------------------------------------------------------------

describe("4 · la apertura corresponde a la respuesta", () => {
  test("«¿me sirve? uso talla XL» abre con empatía, no con el «Sí,» de la talla", () => {
    // Salia "Sí, La correa es graduable...": marcaba TALLA y MEDIDAS, abria
    // con el "Sí," de TALLA y contestaba con la frase de MEDIDAS. Y la
    // apertura empatica escrita justo para esa pregunta no se usaba nunca.
    const texto = unTexto("¿me sirve? uso talla XL");
    assert.match(texto, /^Te entiendo/, `no abre con empatía: ${texto}`);
    assert.equal(/Sí, La correa/.test(texto), false, `mayúscula tras la coma: ${texto}`);
    assert.match(texto, /correa es graduable/i, "y el dato sigue estando");
  });
});
