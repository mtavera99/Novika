"use strict";

// ==========================================================================
// LA VOZ
//
// DE DONDE SALE: Marco probo el bot desde su numero y dijo que responde
// "muy plano, muy robot, muy seco, muy tosco", y que falta el tacto de
// vendedor: "mas atento, mas persuasivo".
//
// El contenido estaba bien. La forma, no:
//
//   antes: "Tiene garantía de 1 mes por defecto de fábrica."
//   ahora: "¡Claro que sí! Tiene 1 mes de garantía por defecto de fábrica,
//           así que compras con tranquilidad 😊"
//
// LO QUE ESTA BATERIA DEFIENDE, Y ES LO DELICADO DEL CAMBIO:
//
// La calidez ENVUELVE el dato, nunca lo toca. Las cifras siguen saliendo del
// cotizador y las caracteristicas del catalogo palabra por palabra. Una
// frase amable que afirme algo del producto es un dato inventado con buen
// tono — y eso es peor que un dato inventado con mal tono, porque convence.
//
// Por eso aqui se prueban las dos cosas a la vez: que suene a persona Y que
// no haya ganado ni una promesa.
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
const { TEMAS } = require("../src/dominio/preguntas");
const { cargarCatalogo } = require("../src/catalogo");

const RAIZ = path.join(__dirname, "..");
const elCinturon = () =>
  cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
    "cinturon-termico-colicos"
  );
const cotizacionDe = (cantidad = 1) =>
  cotizador.cotizar({ producto: elCinturon(), cantidad }).cotizacion;

// --------------------------------------------------------------------------
// 1 · LAS PIEZAS
// --------------------------------------------------------------------------

describe("1 · las piezas de la voz", () => {
  test("«1 unidad(es)» no existe: los plurales son de verdad", () => {
    // Era lo mas robot del cuadro de confirmacion, y estaba justo donde la
    // clienta decide pagar.
    assert.equal(voz.unidades(1), "1 unidad");
    assert.equal(voz.unidades(2), "2 unidades");
    assert.equal(voz.unidades(3), "3 unidades");
    for (const n of [1, 2, 3, 10]) {
      assert.equal(/\(es\)|\(s\)/.test(voz.unidades(n)), false, "quedó un paréntesis de plantilla");
    }
  });

  test("capitaliza después de punto, admiración e interrogación", () => {
    // Salio "¡Claro que sí! tiene 1 mes de garantía": una minuscula despues
    // de un signo de admiracion delata a la maquina.
    assert.equal(voz.unir(["¡Claro que sí!", "tiene garantía."]), "¡Claro que sí! Tiene garantía.");
    assert.equal(voz.unir(["¿Te sirve?", "me pasas la ciudad."]), "¿Te sirve? Me pasas la ciudad.");
  });

  test("un emoji como máximo, y nunca dos", () => {
    assert.equal(voz.cuantosEmojis(voz.conEmoji("Hola", "confirmado")), 1);
    // Si el texto ya trae uno, no se añade otro.
    assert.equal(voz.cuantosEmojis(voz.conEmoji("Hola 🙌", "confirmado")), 1);
  });

  test("el emoji no va detrás de un punto", () => {
    // "tranquilidad. 😊" se lee a formulario. Pero una interrogación SI se
    // conserva: "¿te lo despacho? 📦" está bien escrito.
    assert.equal(voz.conEmoji("Compras tranquila.", "garantia"), "Compras tranquila 😊");
    assert.match(voz.conEmoji("¿Te lo despacho?", "precio"), /¿Te lo despacho\? 📦/);
  });

  test("el nombre de pila: solo el primero, y nunca algo raro", () => {
    assert.equal(voz.nombreDePila("Marco Antonio Tavera Rodríguez"), "Marco");
    assert.equal(voz.nombreDePila("ana maria"), "Ana");
    // Nada de una letra, ni numeros, ni vacio: en la duda no se nombra.
    assert.equal(voz.nombreDePila("A"), "");
    assert.equal(voz.nombreDePila("573001234567"), "");
    assert.equal(voz.nombreDePila(null), "");
  });

  test("cada tema tiene su apertura, y son distintas entre sí", () => {
    // La variedad sale del TEMA, no de un random: la misma pregunta abre
    // igual siempre -se puede probar- y preguntas distintas abren distinto,
    // que es lo que rompe la monotonia.
    const aperturas = [TEMAS.PRECIO, TEMAS.GARANTIA, TEMAS.MEDIDAS, TEMAS.CONFIANZA].map((t) =>
      voz.apertura([t])
    );
    assert.equal(new Set(aperturas).size, 4, "dos temas abren igual: vuelve a sonar monótono");
    for (const a of aperturas) assert.ok(a.length > 0);
  });

  test("un tema sin apertura no rompe nada", () => {
    assert.equal(voz.apertura([]), "");
    assert.equal(voz.apertura(["tema_que_no_existe"]), "");
  });
});

// --------------------------------------------------------------------------
// 2 · SUENA A PERSONA
// --------------------------------------------------------------------------

describe("2 · suena a persona que vende", () => {
  test("reconoce la pregunta antes de dar el dato", async () => {
    // El defecto de fondo: TODA respuesta empezaba con el dato.
    const p = elCinturon();
    const t = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizacionDe(1),
      faltan: ["ciudad", "direccion"],
      producto: p,
      mensajeCliente: "¿tiene garantía?",
      memoria: { saludado: true },
    });
    // Empieza reconociendo, no con "Tiene garantía de...".
    assert.match(t, /^(¡Claro que sí!|Claro|Te cuento|Te explico)/, `empieza con el dato: ${t}`);
    assert.match(t, /1 mes/, "y el dato sigue estando");
  });

  test("empatiza antes de hablar del ajuste", () => {
    // "¿me sirve a mí?" es la duda mas personal que llega: alguien contando
    // su cuerpo a un desconocido.
    const t = contestar.deTema(TEMAS.MEDIDAS, { producto: elCinturon() });
    assert.match(t, /graduable/);
    const completo = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizacionDe(1),
      faltan: [],
      producto: elCinturon(),
      mensajeCliente: "¿me sirve a mí? tengo la cintura ancha",
      memoria: { saludado: true },
    });
    assert.match(completo, /te entiendo/i, `no empatizó: ${completo}`);
  });

  test("habla del envío en segunda persona, no de la transportadora", () => {
    // Antes: "La transportadora normalmente entrega en 1 a 3 días hábiles
    // según la ciudad." Correcto y escrito como un aviso legal.
    const t = contestar.deTema(TEMAS.ENTREGA, { producto: elCinturon() });
    assert.match(t, /te llega en 1 a 3 días hábiles/i);
    assert.match(t, /según tu ciudad/, "el matiz sigue, y ahora es suyo");
  });

  test("celebra la decisión de compra antes de pedir datos", () => {
    // "lo quiero" recibia "Para despacharlo me pasas la ciudad y la
    // dirección": ni un "perfecto" en el momento mas importante.
    const t = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizacionDe(1),
      faltan: ["ciudad", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "lo quiero",
      memoria: { saludado: true, precioInformado: true },
    });
    assert.match(t, /perfecto/i, `no celebró la compra: ${t}`);
    assert.match(t, /me pasas/, "y pide lo que falta");
  });

  test("usa el nombre al confirmar, y solo si está confirmado", () => {
    const conNombre = responder.textoDeterminista({
      situacion: "confirmado",
      pedido: { id: "NOV-ABC-123" },
      producto: elCinturon(),
      mensajeCliente: "sí confirmo",
      nombreCliente: "Marco Tavera",
    });
    assert.match(conNombre, /¡Listo, Marco!/);
    assert.match(conNombre, /Gracias por tu compra/);

    const sinNombre = responder.textoDeterminista({
      situacion: "confirmado",
      pedido: { id: "NOV-ABC-123" },
      producto: elCinturon(),
      mensajeCliente: "sí confirmo",
      nombreCliente: null,
    });
    assert.match(sinNombre, /^¡Listo!/, "sin nombre confirmado no se inventa uno");
  });

  test("el cuadro de confirmación no tiene paréntesis de plantilla", () => {
    const t = responder.textoDeterminista({
      situacion: "resumen",
      cotizacion: cotizacionDe(1),
      producto: elCinturon(),
      mensajeCliente: "Marco, Medellín, Calle 45",
    });
    assert.match(t, /· 1 unidad$/m);
    assert.equal(/unidad\(es\)/.test(t), false, "quedó el paréntesis de la plantilla");
  });
});

// --------------------------------------------------------------------------
// 3 · Y NO GANO NI UNA PROMESA
//
// Es la parte que hace que esto no sea un cambio cosmetico. Se recorren
// TODAS las situaciones con TODOS los mensajes y se comprueba que la voz no
// introdujo un claim prohibido, un importe sin calcular, ni mas de un emoji.
// --------------------------------------------------------------------------

describe("3 · la calidez no introdujo ninguna promesa", () => {
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
    "¿cómo la hago efectiva?",
    "¿me sirve? tengo la cintura ancha",
    "¿cuándo llega?",
    "¿de qué color?",
    "¿es estafa?",
    "lo quiero",
    "sí confirmo",
    "",
  ];

  function todosLosTextos() {
    const producto = elCinturon();
    const cot = cotizacionDe(1);
    const salida = [];
    for (const situacion of SITUACIONES) {
      for (const mensajeCliente of MENSAJES) {
        for (const memoria of [{}, { saludado: true, datosPedidos: true, precioInformado: true }]) {
          for (const nombreCliente of [null, "Marco Tavera"]) {
            salida.push({
              situacion,
              mensajeCliente,
              texto: responder.textoDeterminista({
                situacion,
                cotizacion: cot,
                faltan: ["nombre", "ciudad", "direccion"],
                opciones: ["uno", "otro"],
                pedido: { id: "NOV-MUYR5558-508BAE67" },
                producto,
                mensajeCliente,
                memoria,
                nombreCliente,
              }),
            });
          }
        }
      }
    }
    return salida;
  }

  test("ningún texto contiene un claim prohibido", () => {
    const producto = elCinturon();
    for (const { situacion, mensajeCliente, texto } of todosLosTextos()) {
      const r = responder.revisarClaims(texto, producto);
      assert.equal(
        r.ok,
        true,
        `claim en ${situacion} con "${mensajeCliente}": ${JSON.stringify(r.encontrados)} -> ${texto}`
      );
    }
  });

  test("ningún texto contiene un importe sin calcular", () => {
    const cot = cotizacionDe(1);
    for (const { situacion, mensajeCliente, texto } of todosLosTextos()) {
      const r = cotizador.revisarImportes(texto, cot.importesAutorizados);
      assert.equal(
        r.ok,
        true,
        `importe en ${situacion} con "${mensajeCliente}": ${JSON.stringify(r.sospechosos)} -> ${texto}`
      );
    }
  });

  test("ningún texto lleva más de un emoji", () => {
    // Tres emojis en un mensaje se lee peor que ninguno, y pasa solo si
    // cada pieza trae el suyo.
    for (const { situacion, mensajeCliente, texto } of todosLosTextos()) {
      assert.ok(
        voz.cuantosEmojis(texto) <= 1,
        `${voz.cuantosEmojis(texto)} emojis en ${situacion} con "${mensajeCliente}": ${texto}`
      );
    }
  });

  test("ningún texto empieza en minúscula ni queda a medias", () => {
    for (const { situacion, mensajeCliente, texto } of todosLosTextos()) {
      assert.ok(texto.trim().length > 10, `texto mínimo en ${situacion}: "${texto}"`);
      const primera = texto.trim()[0];
      assert.ok(
        primera === primera.toUpperCase(),
        `empieza en minúscula en ${situacion} con "${mensajeCliente}": ${texto}`
      );
      // Ni espacios dobles ni puntuacion pegada: son las marcas de un texto
      // compuesto a trozos.
      //
      // SE COMPRUEBA LINEA POR LINEA. Aplanar los saltos daba un falso
      // positivo: el cuadro de confirmacion lleva una linea VACIA a
      // proposito entre el resumen y la pregunta, y al convertir los saltos
      // en espacios eso parecia un espacio doble. Un espacio doble DENTRO
      // de una linea si es un defecto; una linea en blanco entre bloques es
      // formato.
      for (const linea of texto.split("\n")) {
        assert.equal(/\s{2,}/.test(linea), false, `espacios dobles en "${linea}" · ${situacion}`);
      }
      assert.equal(/\s[.,;]/.test(texto), false, `espacio antes de puntuación: ${texto}`);
      assert.equal(/\.\./.test(texto.replace(/\.\.\./g, "")), false, `puntos repetidos: ${texto}`);
    }
  });

  test("ningún texto promete una fecha concreta", () => {
    // El riesgo que abrio habilitar el tiempo de entrega, y la voz nueva
    // habla mas de entregas: hay que volver a comprobarlo.
    for (const { situacion, mensajeCliente, texto } of todosLosTextos()) {
      assert.equal(
        /mañana|pasado mañana|hoy mismo|el lunes|el martes|al día siguiente/i.test(texto),
        false,
        `promete una fecha en ${situacion} con "${mensajeCliente}": ${texto}`
      );
    }
  });
});

void DIR;

// --------------------------------------------------------------------------
// 4 · EL PLURAL CIERRA LA VENTA DEL COMBO
//
// Salio probando el tono, y no era de tono: era una venta perdida.
//
//   clienta: "¿cuánto me salen dos?"
//   bot:     "2 unidades te quedan en $85.000..."
//   clienta: "las quiero"
//   bot:     "¿Cuántos quieres?"        <- acababa de decirlo
//   clienta: "Marco Tavera, Medellín, Calle 45 # 23-10"
//   bot:     "¿Cuántos quieres?"        <- otra vez
//
// DOS CAUSAS ENCADENADAS:
//
//   1. Las señales de compra solo cubrian SINGULAR ("lo quiero", "la
//      quiero"). "las quiero", "me las llevo" y "las dos" -justo lo que
//      dice quien compra dos- no contaban como compra. El precio del combo
//      no servia para nada.
//
//   2. "las quiero" no trae ningun numero, asi que el extractor no saca
//      cantidad — y hace bien, no la hay. La cantidad estaba en el TURNO
//      ANTERIOR, en lo que el bot informo, y no se recordaba.
// --------------------------------------------------------------------------

const preguntas = require("../src/dominio/preguntas");

describe("4 · el plural cierra la venta del combo", () => {
  test("el plural cuenta como señal de compra", () => {
    for (const frase of ["las quiero", "los quiero", "me las llevo", "quiero las dos", "dame las dos"]) {
      assert.equal(preguntas.leer(frase).compra, true, `"${frase}" no se leyó como compra`);
    }
    // Y el singular sigue contando, como siempre.
    assert.equal(preguntas.leer("lo quiero").compra, true);
  });

  test('"¿cuánto cuestan las dos?" es una pregunta, no una compra', () => {
    // "las dos" afirmando es aceptar el combo; preguntando es pedir su
    // precio. Por eso va en las señales DEBILES, que no valen con
    // interrogacion.
    assert.equal(preguntas.leer("¿cuánto cuestan las dos?").compra, false);
    assert.equal(preguntas.leer("¿cuánto me salen dos?").compra, false);
  });

  test('"a las dos de la tarde" no es una compra', () => {
    // La unica confusion real de la frase: una hora.
    assert.equal(preguntas.leer("a las dos de la tarde me queda bien").compra, false);
  });
});
