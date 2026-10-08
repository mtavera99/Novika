"use strict";

// ==========================================================================
// LA VENTA PERDIDA DEL 08-OCT · 08:10
//
// Marco: "un cliente escribió hace media hora y el bot no cerró ventaaa!"
//
// Era verdad, y no fue UN fallo: fueron SEIS en la misma conversación. Todos
// capturados del panel de producción, con los mensajes exactos de la
// clienta. Esto es lo que recibió:
//
//   "Con cables para cargar" -> le explicó para qué sirve el cinturón
//   "Trae cargador"          -> le pidió los datos de entrega
//   "Algo contra entrega"    -> "el precio no te lo quiero decir a medias"
//   "Que costó tiene"        -> "esa no te la quiero contestar a medias"
//   "Solo 1"                 -> "¡Perfecto, gracias!"  y ahí se murió
//   "Ayuda con pedido"       -> le explicó para qué sirve, otra vez
//
// Dos de ellos son los que de verdad costaron la venta:
//
//   · "QUE COSTÓ TIENE": el bot se negó a decir el precio — un precio que
//     él mismo había dicho dos mensajes antes. "costo" no estaba en la
//     lista de formas de preguntar el precio; solo el verbo ("cuesta").
//
//   · "SOLO 1": la clienta contestó LA PREGUNTA DEL PROPIO BOT ("¿cuántos
//     quieres?") y recibió un acuse de recibo sin siguiente paso, teniendo
//     el nombre y la dirección sin pedir. Dos mensajes después tuvo que
//     escribir "Ayuda con pedido": pidió ella que la ayudaran a comprar.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const preguntas = require("../src/dominio/preguntas");
const { TEMAS } = preguntas;
const contestar = require("../src/cerebro/contestar");
const responder = require("../src/cerebro/responder");
const cotizador = require("../src/dominio/cotizador");
const { cargarCatalogo } = require("../src/catalogo");

const RAIZ = path.join(__dirname, "..");
const elCinturon = () =>
  cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
    "cinturon-termico-colicos"
  );

const responde = (mensajeCliente, extra = {}) =>
  responder.textoDeterminista({
    situacion: "faltan_datos",
    cotizacion: cotizador.cotizar({ producto: elCinturon(), cantidad: 1 }).cotizacion,
    faltan: ["nombre", "direccion"],
    producto: elCinturon(),
    mensajeCliente,
    memoria: { saludado: true },
    ...extra,
  });

// --------------------------------------------------------------------------
// 1 · "QUE COSTÓ TIENE" ES PREGUNTAR EL PRECIO
// --------------------------------------------------------------------------

describe("1 · preguntar el precio con la palabra «costo»", () => {
  test("«que costó tiene» se reconoce como pregunta de precio", () => {
    for (const frase of ["Que costó tiene", "que costo tiene", "cual es el costo", "y el costo?"]) {
      const r = preguntas.leer(frase);
      assert.ok(r.temas.includes(TEMAS.PRECIO), `no lo leyó como pregunta de precio: ${frase}`);
    }
  });

  test("y recibe la cifra, no un «no te la quiero contestar»", () => {
    const t = responde("Que costó tiene");
    assert.match(t, /\$49\.900/, `no dio el precio: ${t}`);
    assert.equal(
      /no te la quiero contestar|la dejo anotada/i.test(t),
      false,
      `se negó a decir un precio que ya sabía: ${t}`
    );
  });

  test("pero «costoso» sigue siendo una OBJECIÓN, que se contesta distinto", () => {
    // Las dos palabras se parecen y piden cosas distintas: una quiere el
    // numero, la otra quiere que le rebatan el precio.
    const r = preguntas.leer("esta muy costoso");
    assert.ok(r.temas.includes(TEMAS.OBJECION_PRECIO), "perdió la objeción");
    assert.equal(r.temas.includes(TEMAS.PRECIO), false, "le repetiría el precio a quien se queja de él");
  });
});

// --------------------------------------------------------------------------
// 2 · CONTESTAR LA PREGUNTA DEL BOT ES AVANZAR LA VENTA
// --------------------------------------------------------------------------

describe("2 · «Solo 1» no puede acabar la conversación", () => {
  test("dar la cantidad lleva a pedir lo que falta", () => {
    // El bot acababa de preguntar "¿cuántos quieres?". La clienta contesta.
    // Si la respuesta es "¡Perfecto, gracias!" y nada mas, la venta se muere
    // con el nombre y la direccion sin pedir.
    const t = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizador.cotizar({ producto: elCinturon(), cantidad: 1 }).cotizacion,
      faltan: ["nombre", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "Solo 1",
      datosAportados: ["cantidad"],
      memoria: { saludado: true, datosPedidos: true },
    });

    assert.match(t, /me pasas/i, `no pidió lo que falta: ${t}`);
    assert.match(t, /nombre completo/i, t);
    assert.match(t, /dirección/i, t);
  });

  test("y «dar la ciudad» sigue SIN disparar la pedida de datos", () => {
    // La regla del PR #9 no se toca: "Palmira" puede ser "¿me llega allá?".
    // La ciudad es el unico dato ambiguo; la cantidad, el nombre y la
    // direccion no lo son.
    const t = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizador.cotizar({ producto: elCinturon(), cantidad: 1 }).cotizacion,
      faltan: ["nombre", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "Palmira",
      datosAportados: ["ciudad", "departamento"],
      ciudadConfirmada: "Palmira",
      memoria: { saludado: true },
    });
    assert.equal(/me pasas/.test(t), false, `pidió datos a quien solo dijo su ciudad: ${t}`);
  });

  test("«ayuda con pedido» es querer comprar, no una duda del producto", () => {
    const r = preguntas.leer("Ayuda con pedido");
    assert.equal(r.compra, true, "no vio que está pidiendo ayuda para comprar");
    assert.equal(
      r.temas.includes(TEMAS.USO),
      false,
      "le explicaría para qué sirve el producto a quien quiere pedirlo"
    );

    const t = responde("Ayuda con pedido");
    assert.match(t, /me pasas/i, `no la ayudó a pedir: ${t}`);
    assert.equal(/es justo para eso|alivia el cólico/i.test(t), false, `le explicó el producto: ${t}`);
  });

  test("pero «ayuda con los cólicos» SIGUE siendo la duda del producto", () => {
    // El lookahead no puede llevarse por delante la pregunta de verdad.
    const r = preguntas.leer("ayuda con los colicos?");
    assert.ok(r.temas.includes(TEMAS.USO), "perdió la pregunta de para qué sirve");
  });
});

// --------------------------------------------------------------------------
// 3 · EL PAGO Y EL ENVÍO SON POLÍTICAS: NO NECESITAN COTIZACIÓN
// --------------------------------------------------------------------------

describe("3 · «Algo contra entrega» se contesta desde la ficha", () => {
  test("sin cotización, la forma de pago SÍ se sabe", () => {
    const t = contestar.deTema(TEMAS.PAGO, { producto: elCinturon(), cotizacion: null });
    assert.match(t, /pagas cuando lo recibes/i, `no contestó el pago sin cotización: ${t}`);
  });

  test("sin cotización, la política de envío TAMBIÉN se sabe", () => {
    const t = contestar.deTema(TEMAS.ENVIO, { producto: elCinturon(), cotizacion: null });
    assert.match(t, /envío va incluido/i, t);
  });

  test("y preguntar por el contraentrega no recibe «el precio no te lo quiero decir»", () => {
    // Era el peor de los seis: ni contestaba lo que preguntó, ni era verdad
    // -el bot le había dicho el precio dos mensajes antes-.
    const t = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: null,
      cotizacionInformativa: null,
      faltan: ["nombre", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "Algo contra entrega",
      memoria: { saludado: true },
    });
    assert.match(t, /pagas cuando lo recibes/i, `no contestó la forma de pago: ${t}`);
    assert.equal(
      /el precio no te lo quiero decir/i.test(t),
      false,
      `contestó por el precio a quien preguntó por el pago: ${t}`
    );
  });

  test("y si lo que pregunta ES el precio y no hay cotización, ahí sí se admite", () => {
    // La honestidad no se pierde: sin cifra, no se inventa una.
    const t = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: null,
      cotizacionInformativa: null,
      faltan: ["nombre", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "cuanto vale?",
      memoria: { saludado: true },
    });
    assert.match(t, /el precio no te lo quiero decir a medias/i, t);
    assert.equal(/\$/.test(t), false, `se inventó una cifra sin cotización: ${t}`);
  });
});

// --------------------------------------------------------------------------
// 4 · EL CARGADOR NO ES "PARA QUÉ SIRVE"
// --------------------------------------------------------------------------

describe("4 · preguntar por el cargador recibe la respuesta honesta", () => {
  test("cables, cargador y batería son su propio tema", () => {
    for (const frase of ["Con cables para cargar", "Trae cargador", "es recargable?", "funciona con bateria"]) {
      const r = preguntas.leer(frase);
      assert.ok(r.temas.includes(TEMAS.ENERGIA), `no lo reconoció: ${frase}`);
      assert.equal(r.temas.includes(TEMAS.USO), false, `lo trató como «para qué sirve»: ${frase}`);
    }
  });

  test("y la respuesta admite que ese dato no está confirmado", () => {
    // La ficha declara "si funciona con bateria o enchufado" como dato NO
    // confirmado. Contestar la frase de los cólicos no es contestar.
    for (const frase of ["Con cables para cargar", "Trae cargador"]) {
      const t = responde(frase);
      assert.match(t, /batería o enchufado/i, `no admitió el hueco: ${t}`);
      assert.equal(
        /es justo para eso|alivia el cólico/i.test(t),
        false,
        `contestó para qué sirve a quien preguntó por el cargador: ${t}`
      );
    }
  });

  test("«para qué sirve» sigue contestándose con el dato autorizado", () => {
    const t = responde("¿para qué sirve?");
    assert.match(t, /alivia el cólico/i, `se rompió la respuesta de para qué sirve: ${t}`);
  });

  test("y no promete lo que no sabe", () => {
    const producto = elCinturon();
    for (const frase of ["Con cables para cargar", "Trae cargador", "Que costó tiene", "Ayuda con pedido"]) {
      const t = responde(frase);
      const claims = responder.revisarClaims(t, producto);
      assert.equal(claims.ok, true, `${JSON.stringify(claims.encontrados)} -> ${t}`);
    }
  });
});

// --------------------------------------------------------------------------
// 5 · NO SE PROMETE CUÁNDO SE CONTESTA · el bucle del chat de Marco
//
// Esto le llegó a Marco desde su propio número, DESPUÉS de que se hubieran
// prohibido las frases de tiempo:
//
//   Marco  · "Buenas"
//   NOVIKA · "Déjame confirmarlo bien con el equipo y te escribo en un
//             momentico."
//   Marco  · "Confirmar que?"
//   NOVIKA · "Perdón, no quiero repetirme. Dime concretamente qué necesitas"
//   Marco  · "Empecemos de nuevo"
//   NOVIKA · "Déjame confirmarlo bien con el equipo…"
//
// «momentico» no estaba en `claimsProhibidos`, y «te escribo» tampoco casaba
// con «te escribe». La lista tapaba las cuatro frases vistas, no el ERROR:
// compara TEXTO EXACTO, y en castellano colombiano hay infinitas formas de
// decir lo mismo — momentico, ratico, minuticos, ahorita, ya mismo—.
//
// El propio documento de traspaso lo avisaba: «estas dos últimas se
// escaparon una vez por buscar la palabra exacta». Se arregló el síntoma.
//
// Importa porque NO HAY NADIE DE GUARDIA: a una clienta que escribe un
// domingo a las 11 de la noche, «en un momentico» es mentira.
// --------------------------------------------------------------------------

describe("5 · las promesas de tiempo se cazan por patrón, no por frase exacta", () => {
  const PROMESAS = [
    "Déjame confirmarlo bien con el equipo y te escribo en un momentico.",
    "te escribo en un momentico",
    "te confirmo en un momento",
    "te aviso en un ratico",
    "en unos minuticos te cuento",
    "ya mismo te confirmo",
    "ahorita te escribo",
    "te respondo enseguida",
    "te contestamos de inmediato",
    "Dame un momento y te confirmo.",
  ];

  test("ninguna variante se escapa", () => {
    const producto = elCinturon();
    for (const frase of PROMESAS) {
      const r = responder.revisarClaims(frase, producto);
      assert.equal(r.ok, false, `se escapó una promesa de tiempo: ${frase}`);
    }
  });

  test("pero el PLAZO DE ENTREGA sí se puede decir: es un dato del catálogo", () => {
    // La diferencia no es cosmetica: "1 a 3 dias habiles" lo aprobo Marco y
    // sale de la ficha. Lo prohibido es prometer cuando CONTESTAMOS.
    const producto = elCinturon();
    for (const frase of [
      "Te llega en 1 a 3 días hábiles según tu ciudad.",
      "A Bogotá te llega en 1 a 3 días hábiles.",
      "Lo dejo anotado para el equipo y te responden por aquí.",
      "Esto lo reviso con una persona del equipo y te responde por aquí.",
      "Pagas cuando lo recibes, en la puerta de tu casa. Nada por adelantado.",
    ]) {
      const r = responder.revisarClaims(frase, producto);
      assert.equal(r.ok, true, `bloqueó algo legítimo: ${frase} -> ${JSON.stringify(r.encontrados)}`);
    }
  });

  test("y el texto determinista tampoco promete un plazo", () => {
    // El candado vigilaba al modelo mientras el codigo decia lo mismo:
    // "Dame un momento y te confirmo" era texto nuestro, no de la IA.
    const producto = elCinturon();
    const SITUACIONES = ["resumen", "faltan_datos", "confirmado", "ya_confirmado", "escalado", "cancelado"];
    for (const situacion of SITUACIONES) {
      for (const cotizacion of [null, cotizador.cotizar({ producto, cantidad: 1 }).cotizacion]) {
        const texto = responder.textoDeterminista({
          situacion,
          cotizacion,
          faltan: ["nombre", "direccion"],
          pedido: { id: "NOV-X" },
          producto,
          mensajeCliente: "Buenas",
          memoria: { saludado: true },
        });
        const r = responder.revisarClaims(texto, producto);
        assert.equal(
          r.ok,
          true,
          `el texto determinista promete un plazo en ${situacion}: ${JSON.stringify(r.encontrados)} -> ${texto}`
        );
      }
    }
  });
});

// --------------------------------------------------------------------------
// 6 · LO QUE MARCO CAZÓ PROBANDO DESDE SU NÚMERO · 08-oct 16:14
//
// Cuatro fallos más, los cuatro leídos del panel de producción:
//
//   "Cuando me llegaría"  -> "Esa no te la quiero contestar a medias"
//   "Tienes cinturones"   -> "Perdón, no quiero repetirme"
//   "Gracias"             -> "¿Cuántos quieres? ...me pasas la dirección"
//   "en cuánto me llegaría" -> le contestaba el PRECIO
//
// Los tres primeros son el mismo error de fondo que «costó» frente a
// «cuesta»: el detector conocía UNA forma de la palabra y la clienta usó
// otra. Y la cuarta es una colisión: «en cuánto» era un patrón de precio.
// --------------------------------------------------------------------------

describe("6 · las formas naturales de preguntar, reconocidas", () => {
  test("el CONDICIONAL también pregunta por la entrega", () => {
    // Es la forma más natural en castellano: "¿cuándo me llegaría?".
    for (const frase of [
      "Cuando me llegaria",
      "cuando me llegaría",
      "cuando llegaria",
      "cuanto se demoraria",
      "cuanto tardaria",
      "cuando lo recibiria",
      "para cuando llega",
    ]) {
      const r = preguntas.leer(frase);
      assert.ok(
        r.temas.includes(TEMAS.ENTREGA),
        `no reconoció la pregunta por el plazo: ${frase}`
      );
    }
  });

  test("y recibe el plazo, que está en la ficha", () => {
    const t = responde("Cuando me llegaria");
    assert.match(t, /1 a 3 días hábiles/i, `no dio el plazo: ${t}`);
    assert.equal(/no te la quiero contestar/i.test(t), false, t);
  });

  test("«en cuánto me llegaría» es el plazo; «en cuánto me lo deja» es el precio", () => {
    // La colisión costaba una respuesta equivocada: le soltaba el PRECIO a
    // quien preguntaba cuándo le llega.
    const plazo = preguntas.leer("en cuanto me llegaria");
    assert.ok(plazo.temas.includes(TEMAS.ENTREGA), "no vio que pregunta por el plazo");
    assert.equal(plazo.temas.includes(TEMAS.PRECIO), false, "le contestaría el precio");

    const precio = preguntas.leer("en cuanto me lo deja");
    assert.ok(precio.temas.includes(TEMAS.PRECIO), "se perdió la pregunta de precio");
  });

  test("«tienes cinturones» es preguntar si hay, y se presenta el producto", () => {
    const r = preguntas.leer("Tienes cinturones");
    assert.equal(r.pideInformacion, true, "no lo leyó como pedir información");

    const t = responde("Tienes cinturones");
    assert.match(t, /49\.900/, `no presentó el producto: ${t}`);
    assert.equal(/no quiero repetirme/i.test(t), false, t);
    assert.equal(/me pasas/i.test(t), false, `le pidió datos a quien preguntó si hay: ${t}`);
  });

  test("a un «gracias» NO se le piden los datos de entrega", () => {
    // Estaba en la lista de defectos conocidos sin arreglar.
    const r = preguntas.leer("Gracias");
    assert.equal(r.soloAgradece, true);
    assert.equal(r.compra, false);

    const t = responde("Gracias");
    assert.equal(/me pasas|dirección/i.test(t), false, `le pidió la dirección a quien agradeció: ${t}`);
    assert.match(t, /con gusto/i, t);
  });

  test("pero «gracias, cuánto vale?» SÍ es una pregunta de precio", () => {
    // El atajo del "gracias" no puede comerse una pregunta de verdad.
    const r = preguntas.leer("gracias, cuanto vale?");
    assert.equal(r.soloAgradece, false);
    assert.ok(r.temas.includes(TEMAS.PRECIO));
  });

  test("y «gracias, me lo llevo» sigue siendo una compra", () => {
    const r = preguntas.leer("gracias, me lo llevo");
    assert.equal(r.soloAgradece, false);
    assert.equal(r.compra, true);
  });
});

// --------------------------------------------------------------------------
// 7 · COMO ESCRIBE LA GENTE DE VERDAD
//
// Marco preguntó «¿qué le preguntamos?». En vez de darle una lista a ciegas
// se pasó una batería de 88 frases reales —los temas que BIKERPRO midió
// sobre 6.317 conversaciones, más las variantes colombianas, las erratas de
// dedo y el dictado de voz—. Fallaban 29.
//
// Y el patrón es SIEMPRE el mismo: el detector conocía UNA forma de la
// palabra y el cliente usa otra. «costó» frente a «cuesta». «llegaría»
// frente a «llega». «bale» frente a «vale». «carito» frente a «caro».
//
// Por eso esta batería existe: no para probar una frase, sino para que la
// FORMA de la frase deje de ser el motivo de perder una venta.
// --------------------------------------------------------------------------

describe("7 · las erratas, el imperativo y los diminutivos", () => {
  test("«cuanto bale» es preguntar el precio (la b por la v)", () => {
    // De las erratas más comunes en Colombia, y cae sobre LA pregunta que
    // más se hace. Perderla por una letra es perder la venta entera.
    for (const frase of ["cuanto bale", "cuanto balen 2", "kuanto cuesta", "kuanto kuestan 2"]) {
      const r = preguntas.leer(frase);
      assert.ok(r.temas.includes(TEMAS.PRECIO), `no reconoció el precio: ${frase}`);
    }
  });

  test("y si pregunta por DOS con errata, se cotiza por dos", () => {
    // Si el precio se reconoce pero la cantidad no, se contesta el precio
    // de UNA a una pregunta por DOS: el defecto del PR #2, por la puerta de
    // atrás.
    for (const frase of ["cuanto balen 2", "kuanto kuestan 2", "y el par?"]) {
      assert.equal(preguntas.leer(frase).cantidadPreguntada, 2, `perdió la cantidad: ${frase}`);
    }
  });

  test("el IMPERATIVO es comprar: «deme 2», «mándeme uno»", () => {
    // Es como se compra hablando. La lista solo tenía "quiero/llevo/compro".
    for (const frase of ["deme 2", "mandeme uno", "regaleme uno", "necesito uno", "si quiero"]) {
      assert.equal(preguntas.leer(frase).compra, true, `no vio la compra: ${frase}`);
    }
  });

  test("«está carito» es una objeción: el diminutivo suaviza, no cambia el tema", () => {
    // Quien dice "carito" no quiere pelear el precio: quiere una razón.
    for (const frase of ["esta carito", "muy carito", "no tengo plata ahora"]) {
      const r = preguntas.leer(frase);
      assert.ok(
        r.temas.includes(TEMAS.OBJECION_PRECIO),
        `no reconoció la objeción: ${frase}`
      );
    }
  });

  test("«tas ahi?» y «q tal» son saludos: no se dejan sin respuesta", () => {
    for (const frase of ["tas ahi?", "q tal", "hay alguien?"]) {
      const r = preguntas.leer(frase);
      assert.equal(r.saludo, true, `no lo leyó como saludo: ${frase}`);
    }
  });

  test("«mas info» es pedir información, y no se le piden datos", () => {
    const r = preguntas.leer("mas info");
    assert.equal(r.pideInformacion, true);

    const t = responde("mas info");
    assert.match(t, /49\.900/, `no presentó el producto: ${t}`);
    assert.equal(/me pasas/i.test(t), false, `le pidió datos a quien pidió información: ${t}`);
  });

  test("«dsps le escribo» se lo está pensando: no se insiste", () => {
    const r = preguntas.leer("dsps le escribo");
    assert.equal(r.seLoPiensa, true);

    const t = responde("dsps le escribo");
    assert.equal(/me pasas|nombre completo/i.test(t), false, `insistió con los datos: ${t}`);
    assert.match(t, /aquí estoy|sin afán/i, t);
  });

  test("y ninguna de las formas nuevas promete nada que no sea verdad", () => {
    const producto = elCinturon();
    for (const frase of [
      "cuanto bale",
      "deme 2",
      "esta carito",
      "mas info",
      "dsps le escribo",
      "tas ahi?",
      "no sera estafa?",
      "se paga al recibir?",
      "llega el lunes?",
      "como hago el pedido",
    ]) {
      const t = responde(frase);
      const claims = responder.revisarClaims(t, producto);
      assert.equal(claims.ok, true, `${frase}: ${JSON.stringify(claims.encontrados)} -> ${t}`);
      assert.ok(t.trim().length > 10, `respuesta vacía a "${frase}"`);
    }
  });
});
