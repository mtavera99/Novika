"use strict";

// ==========================================================================
// LOS OCHO DEFECTOS DEL 10-OCT
//
// Marco reviso las 15 conversaciones mas recientes del panel de produccion y
// los numero por prioridad. Cada bloque de abajo es uno de ellos, con los
// mensajes LITERALES del cliente copiados del panel.
//
// Lo que confirmo que ya funcionaba y no se toca: el mensaje de bienvenida
// con el combo de $85.000, la respuesta a los audios y la de garantia.
//
// DOS DEFECTOS MAS SE ARREGLARON AQUI SIN QUE NADIE LOS PIDIERA, porque
// aparecieron al arreglar los otros, y los dos costaban pedidos:
//
//   · el nombre de perfil de WhatsApp pisaba el nombre que escribia el
//     cliente (bloque 9);
//   · a quien decia "mándamelo" dos veces se le contestaba "no te entendí"
//     (bloque 10).
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearEmisor } = require("../src/whatsapp/enviar");
const { cargarCatalogo } = require("../src/catalogo");
const atencion = require("../src/almacen/atencion");
const mutex = require("../src/almacen/mutex");
const campos = require("../src/dominio/campos");
const confirmacion = require("../src/dominio/confirmacion");
const extraer = require("../src/dominio/extraer");
const destino = require("../src/dominio/destino");
const preguntas = require("../src/dominio/preguntas");
const contestar = require("../src/cerebro/contestar");
const responder = require("../src/cerebro/responder");

const RAIZ = path.join(__dirname, "..");
const CLIENTE = "573001112233";
const ANUNCIO = "Hola, quiero información sobre el cinturón térmico de $49.900.";

/** Las frases que Marco prohibio expresamente. */
const PROHIBIDAS = /no quiero repetirme|dime concretamente|no te l[ao]s? quiero (decir|contestar) a medias|no te entend/i;

let SEQ = 0;

async function chat({ nombrePerfil = null } = {}) {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-10oct-")) });
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
    atencion,
    fetchImpl: async (_url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.T${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  const dice = async (texto) => {
    salidas.length = 0;
    await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.T${++SEQ}_${process.pid}_${Date.now()}`,
      idCliente: CLIENTE,
      telefono: CLIENTE,
      nombre: nombrePerfil,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });
    const conv = await repos.conversaciones.obtener(CLIENTE);
    return {
      texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join(" "),
      fotos: salidas.filter((s) => s.type === "image").length,
      conversacion: conv,
      ficha: (conv && conv.ficha) || {},
    };
  };

  const pedidos = async () => {
    const l = await repos.pedidos.listar({ limite: 20 });
    return Array.isArray(l) ? l : l.filas || [];
  };

  return { dice, pedidos };
}

const elCinturon = () =>
  cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).productos[0];

// ==========================================================================
// 1 · EL "SI" DESPUES DE LA PREGUNTA DE CIERRE
// ==========================================================================
describe("1 · el «sí» tras la pregunta de cierre no puede entrar en bucle", () => {
  // La lista exacta que escribio Marco.
  const LAS_DE_MARCO = [
    "sí",
    "si",
    "claro",
    "dale",
    "listo",
    "ok",
    "de una",
    "mándamelo",
    "envíamelo",
    "lo quiero",
    "quiero uno",
    "hágale",
    "hágame el favor",
    "por favor",
    "👍",
  ];

  test("todas las de la lista de Marco se leen como un sí", () => {
    for (const t of LAS_DE_MARCO) {
      assert.equal(confirmacion.esAfirmacionDeCierre(t), true, `"${t}" no se leyó como un sí`);
    }
  });

  test("y lo que NO es un sí sigue sin serlo", () => {
    const NO = [
      "no",
      "no gracias",
      "no por ahora",
      "mejor no",
      "cancelar",
      "¿sí?",
      "¿cuánto vale?",
      "mejor dos",
      "si pero cuanto vale el envio a mi ciudad",
      "ya me llegó?",
      "necesito pensarlo",
    ];
    for (const t of NO) {
      assert.equal(confirmacion.esAfirmacionDeCierre(t), false, `"${t}" se leyó como un sí y no lo es`);
    }
  });

  test("el patrón de cierre reconoce los cierres que el bot escribe de verdad", () => {
    // Lo promete el comentario de `PREGUNTA_DE_CIERRE`: si alguien cambia la
    // redaccion de un cierre, esta prueba lo caza antes que un cliente.
    const CIERRES = [
      "¿Te lo aparto, o quieres que te cuente algo más de cómo funciona? 🙌",
      "¿Te lo aparto? 🙌",
      "¿Te lo aparto mientras?",
      "¿Quieres que te ayude a pedirlo? 🙌",
      'Te dejé el resumen aquí arriba 👆 Si está todo bien, respóndeme "sí" y lo dejo listo.',
    ];
    for (const t of CIERRES) {
      assert.equal(responder.prometeCierre(t), true, `no se reconoció como cierre: ${t}`);
    }
    // Y lo que NO es un cierre no lo activa: si no, cualquier mensaje
    // dejaria la puerta abierta a leer un "ok" como una compra.
    for (const t of [
      "¿Para qué ciudad sería? Así te digo cuánto se demora 🙌",
      "¿Cuántos quieres? Y para preparar tu pedido me pasas la dirección 🙌",
      "¡Perfecto! A Bogota te llega en 1 a 2 días hábiles.",
    ]) {
      assert.equal(responder.prometeCierre(t), false, `se tomó por cierre y no lo es: ${t}`);
    }
  });

  test("«Mándamelo» pide los datos que faltan, no repite la pregunta", async () => {
    // Chat de Santiago. Recibia "¿Te lo aparto, o quieres que te cuente
    // algo más...?" — la misma pregunta que acababa de contestar.
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    await c.dice("Bogotá");
    const r = await c.dice("Mándamelo");

    assert.equal(/te lo aparto/i.test(r.texto), false, `repitió la pregunta de cierre: ${r.texto}`);
    assert.match(r.texto, /barrio|dirección|referencia/i, `no pidió lo que falta: ${r.texto}`);
    // Cantidad por defecto 1: no se le vuelve a preguntar cuantos quiere.
    assert.equal(/cuántos quieres/i.test(r.texto), false, `le preguntó la cantidad: ${r.texto}`);
    assert.equal(campos.valorConfirmado(r.ficha.cantidad), 1, "no tomó 1 por defecto");
  });

  test("«Si claro por favor» y «Si Agame el favor» también", async () => {
    for (const frase of ["Si claro por favor", "Si Agame el favor"]) {
      const c = await chat({ nombrePerfil: "Cliente" });
      await c.dice(ANUNCIO);
      const r = await c.dice(frase);
      assert.equal(/te lo aparto/i.test(r.texto), false, `"${frase}" recibió la pregunta otra vez: ${r.texto}`);
      assert.match(r.texto, /me pasas/i, `"${frase}" no recibió la pedida de datos: ${r.texto}`);
    }
  });

  test("un «Si» pelado tras el cierre tampoco se pierde", async () => {
    // Chat de Popayan: "Si" -> "¿Te lo aparto...?" y luego "Claro" ->
    // "Perdón, creo que no te entendí bien".
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    // ⚠️ LA CIUDAD VA PRIMERO, Y NO ES UN DETALLE DE LA PRUEBA.
    //
    // Desde el 10-oct (punto 9 de Marco) el bot NO ofrece apartar nada a
    // quien todavía no ha dicho su ciudad: pregunta la ciudad, porque
    // apartar algo sin saber a dónde va es un paso en falso. Así que para
    // que haya pregunta de cierre, primero hay que tener la ciudad.
    await c.dice("Bogotá");
    const conCierre = await c.dice("Cómo funciona");
    assert.equal(responder.prometeCierre(conCierre.texto), true, `el bot no cerró: ${conCierre.texto}`);

    const r = await c.dice("Si");
    assert.equal(PROHIBIDAS.test(r.texto), false, `frase prohibida: ${r.texto}`);
    // Avanzar es pedir lo que falta, con las palabras que toquen: "me pasas
    // la dirección" la primera vez y "dime el barrio… o un punto de
    // referencia" la segunda, que es la reformulación que existe para no
    // repetir la misma petición.
    assert.match(r.texto, /me pasas|barrio|dirección|referencia/i, `no avanzó tras el sí: ${r.texto}`);
  });
});

// ==========================================================================
// 2 · DESPUES DE LA CIUDAD, LOS DATOS
// ==========================================================================
describe("2 · el mensaje de la ciudad lleva la lista de datos", () => {
  test("«Duitama boyaca» no acaba la conversación", async () => {
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Duitama boyaca");

    assert.match(r.texto, /Duitama te llega en/i, `no le dio el plazo: ${r.texto}`);
    assert.match(r.texto, /me pasas/i, `se acabó la conversación tras la ciudad: ${r.texto}`);
    // "si quieres uno o dos": el upsell del combo que Marco pidio conservar.
    assert.match(r.texto, /uno o dos/i, `perdió el ofrecimiento de las dos: ${r.texto}`);
    // Un solo mensaje, una sola pedida.
    assert.equal((r.texto.match(/me pasas/g) || []).length, 1, `pidió dos veces: ${r.texto}`);
  });

  test("y «Bogotá» tampoco", async () => {
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Bogotá");
    assert.match(r.texto, /me pasas/i, `se acabó la conversación tras la ciudad: ${r.texto}`);
  });

  test("pero PREGUNTAR por la ciudad no recibe el formulario", async () => {
    // El nucleo de la regla del PR #9 que sigue vivo.
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    const r = await c.dice("¿Llega a Palmira?");
    assert.equal(/me pasas/.test(r.texto), false, `pidió datos a quien preguntaba: ${r.texto}`);
  });
});

// ==========================================================================
// 3 · CON TODOS LOS DATOS, EL RESUMEN
// ==========================================================================
describe("3 · nombre, ciudad y dirección en UN mensaje llegan al resumen", () => {
  test("el nombre se saca de un mensaje de varias líneas", () => {
    const m = "Alejandro león Garzón\nPopayán Cauca\nBarrio pueblillo en la cantera la pintada";
    assert.equal(extraer.nombreEn(m, { seLoPidieron: true }).valor, "Alejandro león Garzón");
  });

  test("y los candados del nombre no se relajan", () => {
    // Cada linea pasa las mismas comprobaciones que antes: una ciudad, una
    // direccion o una muletilla NO son un nombre, ni sueltas ni en una
    // linea suya.
    for (const m of ["Popayán Cauca\nBarrio pueblillo", "Calle 5 # 3-20\nBogotá", "Si quiero\nBogotá", "gracias\nlisto"]) {
      assert.equal(extraer.nombreEn(m, { seLoPidieron: true }).valor, null, `tomó un nombre donde no hay: ${JSON.stringify(m)}`);
    }
  });

  test("el chat de Popayán acaba en pedido", async () => {
    // El perfil de WhatsApp de este cliente es un emoji: por eso no servia
    // como nombre y el del mensaje era el unico bueno.
    const c = await chat({ nombrePerfil: "🤪" });
    await c.dice(ANUNCIO);
    await c.dice("Sólo necesito una unidad");
    const resumen = await c.dice("Alejandro león Garzón\nPopayán Cauca\nBarrio pueblillo en la cantera la pintada");

    assert.match(resumen.texto, /Confirmemos tu pedido/i, `no mostró el resumen: ${resumen.texto}`);
    assert.match(resumen.texto, /Alejandro león Garzón/, `el resumen no lleva su nombre: ${resumen.texto}`);
    assert.match(resumen.texto, /Barrio pueblillo/i, `el resumen no lleva su dirección: ${resumen.texto}`);

    const r = await c.dice("Si");
    const pedidos = await c.pedidos();
    assert.equal(pedidos.length, 1, `no se creó el pedido: ${r.texto}`);
    assert.match(r.texto, /NOV-/, `no le dio el número de pedido: ${r.texto}`);
  });
});

// ==========================================================================
// 4 · FUERA "NO TE LA QUIERO CONTESTAR A MEDIAS"
// ==========================================================================
describe("4 · las preguntas por las funciones se contestan con la ficha", () => {
  const PREGUNTAS = ["Ese que funciones trae", "Cómo funciona", "Qué hace", "qué funciones tiene", "como se pone"];

  test("ninguna recibe la frase prohibida", async () => {
    for (const q of PREGUNTAS) {
      const c = await chat({ nombrePerfil: "Cliente" });
      await c.dice(ANUNCIO);
      const r = await c.dice(q);
      assert.equal(PROHIBIDAS.test(r.texto), false, `"${q}" recibió una frase prohibida: ${r.texto}`);
      assert.ok(r.texto, `"${q}" se quedó sin respuesta`);
    }
  });

  test("y todas se contestan con datos de la ficha técnica", async () => {
    for (const q of PREGUNTAS) {
      const c = await chat({ nombrePerfil: "Cliente" });
      await c.dice(ANUNCIO);
      const r = await c.dice(q);
      assert.match(r.texto, /niveles de calor|modos de masaje|recargable/i, `"${q}" no usó la ficha: ${r.texto}`);
    }
  });

  test("«qué trae» a secas sigue siendo el empaque, no las funciones", () => {
    assert.deepEqual(preguntas.leer("qué trae").temas, [preguntas.TEMAS.EMPAQUE]);
  });
});

// ==========================================================================
// 5 · "¿COMO FUNCIONA?" CON LA FICHA, Y SIN REPETIRSE
// ==========================================================================
describe("5 · «¿Cómo funciona?» usa la ficha y no repite el texto", () => {
  test("no empieza con un «Sí» que nadie pidió", async () => {
    const c = await chat({ nombrePerfil: "David" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Cómo funciona");
    assert.equal(/^(Con gusto: )?Sí,/.test(r.texto), false, `empieza afirmando algo que nadie preguntó: ${r.texto}`);
  });

  test("dice dónde se pone, en cuánto calienta, los niveles y los modos", async () => {
    const c = await chat({ nombrePerfil: "David" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Cómo funciona");
    assert.match(r.texto, /abdomen/i, r.texto);
    assert.match(r.texto, /10 segundos/i, r.texto);
    assert.match(r.texto, /50, 55 y 60/, r.texto);
    assert.match(r.texto, /4 modos de masaje/i, r.texto);
    assert.match(r.texto, /recargable/i, r.texto);
  });

  test("preguntarlo dos veces NO devuelve el mismo texto", async () => {
    const c = await chat({ nombrePerfil: "David" });
    await c.dice(ANUNCIO);
    const a = await c.dice("Cómo funciona");
    const b = await c.dice("Cómo funciona");
    assert.notEqual(a.texto, b.texto, "devolvió el mismo párrafo las dos veces");
    // Y la segunda sigue siendo una respuesta de verdad, no una disculpa.
    assert.equal(PROHIBIDAS.test(b.texto), false, `la segunda vez se disculpó: ${b.texto}`);
    assert.match(b.texto, /abdomen|calor|masaje/i, `la segunda vez no contestó: ${b.texto}`);
  });

  test("y «para qué sirve» sigue contestando el propósito, no la mecánica", () => {
    // Las dos preguntas volvieron a ser dos temas distintos.
    assert.deepEqual(preguntas.leer("para que sirve").temas, [preguntas.TEMAS.USO]);
    assert.deepEqual(preguntas.leer("Cómo funciona").temas, [preguntas.TEMAS.COMO_SE_USA]);
  });
});

// ==========================================================================
// 6 · EL PLAZO DE BOGOTA
// ==========================================================================
describe("6 · Bogotá son 1 a 2 días hábiles; el resto del país, 1 a 3", () => {
  test("el plazo sale de la ciudad", () => {
    const p = elCinturon();
    for (const ciudad of ["Bogota", "Bogotá", "Bogota DC"]) {
      assert.equal(contestar.plazoDeEntrega(p, ciudad).texto, "1 a 2 días hábiles", `falló con ${ciudad}`);
    }
    for (const ciudad of ["Duitama", "Popayan", "Medellin", "Cali"]) {
      assert.equal(contestar.plazoDeEntrega(p, ciudad).texto, "1 a 3 días hábiles", `falló con ${ciudad}`);
    }
  });

  test("sin ciudad se da el rango general CON su matiz", () => {
    const r = contestar.plazoDeEntrega(elCinturon(), null);
    assert.equal(r.texto, "1 a 3 días hábiles");
    assert.match(r.matiz, /según la ciudad/i, "sin ciudad el matiz hace falta: el rango depende de ella");
  });

  test("con ciudad conocida el «según la ciudad» desaparece", async () => {
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Bogotá");
    assert.match(r.texto, /1 a 2 días hábiles/, `no usó el plazo de Bogotá: ${r.texto}`);
    assert.equal(/según la ciudad/i.test(r.texto), false, `el matiz sobra con la ciudad conocida: ${r.texto}`);
  });
});

// ==========================================================================
// 7 · LA CIUDAD QUE NO ESTA EN EL LISTADO
// ==========================================================================
describe("7 · una ciudad fuera del listado se acepta, no se ignora", () => {
  test("Ciénaga ya se resuelve sola, y Guacamayal queda marcado", () => {
    // ⚠️ ESTA PRUEBA CAMBIO EL 2026-10-10 PORQUE MEJORO EL COMPORTAMIENTO.
    //
    // Afirmaba que "Ciénaga guacamayal" se aceptaba MARCADA para revision,
    // que era lo mejor que se podia hacer con una lista de 60 ciudades.
    // Ahora Ciénaga (Magdalena) esta en el listado del DANE y se resuelve
    // sola, sin pasar por una persona.
    const r = extraer.ciudadEn("Ciénaga guacamayal", { seLaPidieron: true });
    assert.equal(r.valor, "cienaga", "no reconoció el municipio");
    const v = destino.resolverCiudad(r.valor);
    assert.equal(v.ok, true);
    assert.equal(v.revisar, false, "Ciénaga está en el listado: no debería hacer falta revisarla");

    // Y lo que SIGUE necesitando revision humana es lo que no es municipio:
    // Guacamayal es un corregimiento de Zona Bananera.
    const suelto = destino.resolverCiudad("guacamayal");
    assert.equal(suelto.ok, true, "un corregimiento no se rechaza");
    assert.equal(suelto.revisar, true, "un corregimiento tiene que revisarse antes de despachar");
  });

  test("y lo que no es una ciudad sigue rechazándose", () => {
    for (const t of ["mi casa", "aquí cerca", "no sé", "listo", "ok", "contraentrega", "Calle 45 # 3-20", "12345"]) {
      assert.equal(extraer.ciudadEn(t, { seLaPidieron: true }).valor, null, `tomó "${t}" por una ciudad`);
    }
  });

  test("un «sí» mal escrito tampoco es una ciudad", () => {
    // Lo cazó el sondeo de las 65 preguntas reales: "sihh" entraba como
    // topónimo y el bot contestaba "A Sihh te llega en 1 a 3 días hábiles".
    // Son las formas estiradas que se escriben desde el móvil.
    for (const t of ["sihh", "siii", "sii", "noo", "okk", "ahh", "mmm", "jajaja", "ya", "uy"]) {
      assert.equal(extraer.ciudadEn(t, { seLaPidieron: true }).valor, null, `tomó "${t}" por una ciudad`);
    }
  });

  test("pero un municipio corto de verdad sí entra", () => {
    for (const t of ["Tadó", "Sopó", "Chía", "Cota"]) {
      assert.ok(extraer.ciudadEn(t, { seLaPidieron: true }).valor, `rechazó el municipio "${t}"`);
    }
  });

  test("sin que se la hayan pedido, un lugar desconocido no se propone", () => {
    // El contexto es lo que da el permiso para aceptar lo que NO está en el
    // listado. Lo que sí está se reconoce siempre.
    assert.equal(extraer.ciudadEn("Guacamayal").valor, null, "un corregimiento sin contexto no se propone");
    assert.equal(extraer.ciudadEn("Bogotá").valor, "bogota");
    assert.equal(extraer.ciudadEn("Ciénaga").valor, "cienaga", "un municipio del DANE sí, siempre");
  });

  test("el chat de Guacamayal sigue a la pedida de datos", async () => {
    const c = await chat({ nombrePerfil: "Cliente Magdalena" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Ciénaga guacamayal");
    assert.equal(/te lo aparto/i.test(r.texto), false, `saltó al cierre sin usar la ciudad: ${r.texto}`);
    assert.match(r.texto, /me pasas/i, `no siguió con los datos: ${r.texto}`);
  });
});

// ==========================================================================
// 8 · NO PROMETER FOTOS QUE NO SALEN
// ==========================================================================
describe("8 · «te paso las fotos» solo si de verdad salen", () => {
  test("el primer mensaje promete fotos y las manda", async () => {
    const c = await chat({ nombrePerfil: "Cliente" });
    const r = await c.dice(ANUNCIO);
    assert.ok(r.fotos > 0, "prometió fotos y no mandó ninguna");
  });

  test("y cuando ya se mandaron, no se vuelven a prometer", async () => {
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO); // aqui salen las fotos
    const r = await c.dice("Para que sirve");
    if (/te paso las fotos/i.test(r.texto)) {
      assert.ok(r.fotos > 0, `prometió fotos y no salió ninguna: ${r.texto}`);
    }
    assert.equal(/te paso las fotos/i.test(r.texto), false, `volvió a prometer fotos ya enviadas: ${r.texto}`);
  });

  test("ningún mensaje promete fotos sin mandarlas", async () => {
    // La regla, de raiz: si el texto las promete, salen.
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    for (const q of ["Cómo funciona", "Para que sirve", "Qué hace", "de qué material es"]) {
      const r = await c.dice(q);
      if (/te paso las fotos|te mando (unas )?fotos/i.test(r.texto)) {
        assert.ok(r.fotos > 0, `"${q}" prometió fotos y no salió ninguna: ${r.texto}`);
      }
    }
  });
});

// ==========================================================================
// 9 · EL NOMBRE DE PERFIL NO PISA EL NOMBRE DEL CLIENTE
//
// No lo pidio Marco: aparecio al arreglar el 3, y se llevaba un pedido por
// delante. El nombre de perfil de WhatsApp viaja en cada mensaje, se
// proponia en cada turno, y `aplicarCandidatos` lo tomaba por "el cliente
// corrigio su nombre": reabria el campo y metia el emoji, que no pasa
// `validarNombre`, asi que el nombre quedaba VACIO y el pedido no se podia
// crear.
// ==========================================================================
describe("9 · el nombre de perfil de WhatsApp es un respaldo, no una corrección", () => {
  test("un perfil con emoji no borra el nombre que escribió el cliente", async () => {
    const c = await chat({ nombrePerfil: "🤪" });
    await c.dice(ANUNCIO);
    await c.dice("Sólo necesito una unidad");
    await c.dice("Alejandro león Garzón\nPopayán Cauca\nBarrio pueblillo en la cantera la pintada");

    // El turno siguiente trae el perfil otra vez. Antes, aqui se perdia.
    const r = await c.dice("Si");
    assert.equal(
      campos.valorConfirmado(r.ficha.nombre),
      "Alejandro león Garzón",
      "el nombre de perfil pisó el nombre del cliente"
    );
    assert.equal((await c.pedidos()).length, 1, `el pedido no se creó: ${r.texto}`);
  });

  test("pero si no hay nombre, el perfil sí lo rellena", async () => {
    const c = await chat({ nombrePerfil: "Santiago" });
    const r = await c.dice(ANUNCIO);
    assert.equal(campos.valorConfirmado(r.ficha.nombre), "Santiago", "no usó el nombre de perfil para arrancar");
  });
});

// ==========================================================================
// 10 · A QUIEN DICE QUE COMPRA NUNCA SE LE DICE "NO TE ENTENDI"
// ==========================================================================
describe("10 · decir que lo quiere dos veces no es un bot atascado", () => {
  test("«Mándamelo» y luego «Envíamelo» no reciben una disculpa", async () => {
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    await c.dice("Bogotá");
    await c.dice("Mándamelo");
    const r = await c.dice("Envíamelo");

    assert.equal(PROHIBIDAS.test(r.texto), false, `le dijo que no lo entendía: ${r.texto}`);
    assert.match(r.texto, /barrio|dirección|referencia/i, `no insistió con lo que falta: ${r.texto}`);
  });
});

// ==========================================================================
// 11 · EL PANEL NO PUEDE CONTRADECIRSE A SI MISMO
//
// ⚠️ ESTE BLOQUE EXISTE POR UN ERROR MIO, Y LO DIGO ASI PORQUE LO FUE.
//
// El 09-oct cambie el aviso del formulario de respuesta a "Al enviar, el bot
// SIGUE ATENDIENDO este chat", y le dije a Marco por escrito que responder a
// mano no callaba al bot. Las dos cosas eran falsas: `panel/rutas.js`, al
// enviar un mensaje manual, pone `pausado: true`. La propia respuesta de la
// API lo decia bien ("El bot queda pausado en este chat"), asi que el panel
// afirmaba una cosa antes de enviar y la contraria despues.
//
// Y no es un detalle de redaccion. Chat de Popayan, 08-oct: un operador
// escribio "Me confirmas" a las 21:33, eso callo al bot 12 horas, el cliente
// contesto "Si" a las 21:36 y su respuesta murio con "no enviado:
// conversacion_pausada". El cliente dijo que si y nadie le contesto.
//
// La prueba ata el aviso al comportamiento: si alguien cambia uno sin el
// otro, falla aqui y no en la cara de un cliente.
// ==========================================================================
describe("11 · el aviso del panel dice lo que el código hace", () => {
  const codigo = (...partes) => fs.readFileSync(path.join(RAIZ, "src", ...partes), "utf8");

  /** El fichero sin sus comentarios: solo lo que de verdad se ejecuta o se ve. */
  const sinComentarios = (s) =>
    s
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");

  test("ninguna acción manual del panel pausa el bot", () => {
    // Marco, 10-oct: «si yo me meto en una conversación y respondo, el bot
    // debería seguir ahí, a menos de que yo lo silencie».
    //
    // Se comprueba sobre las TRES rutas que mandan algo al cliente a mano:
    // responder, mandar fotos y "Confirmar por WhatsApp". Las tres pausaban.
    const rutas = sinComentarios(codigo("panel", "rutas.js"));
    for (const [nombre, ancla] of [
      ["responder a mano", 'router.post("/responder"'],
      ["mandar fotos a mano", 'router.post("/fotos"'],
    ]) {
      const i = rutas.indexOf(ancla);
      assert.ok(i > 0, `no se encontró la ruta: ${nombre}`);
      const bloque = rutas.slice(i, i + 4500);
      assert.equal(
        /pausado:\s*true/.test(bloque),
        false,
        `${nombre} volvió a pausar el bot: o se deshace, o hay que corregir el aviso del formulario`
      );
    }

    // Y el camino compartido de "Confirmar por WhatsApp", que es el peor
    // sitio posible para pausar: manda el resumen pidiendo un "sí" y
    // desconectaba a quien iba a recibirlo.
    const i = rutas.indexOf("async function enviarDesdeElPanel");
    assert.ok(i > 0, "no se encontró el camino compartido de envío manual");
    assert.equal(
      /pausado:\s*true/.test(rutas.slice(i, i + 2500)),
      false,
      "«Confirmar por WhatsApp» volvió a pausar el bot: el «sí» del cliente se quedaría sin respuesta"
    );
  });

  test("y el formulario promete exactamente eso", () => {
    const vistas = codigo("panel", "vistas.js");
    assert.match(
      sinComentarios(vistas),
      /sigue atendiendo/i,
      "el aviso ya no dice que el bot sigue atendiendo, y el código dice que sí"
    );
    assert.match(sinComentarios(vistas), /Tomar el control/, "el aviso no dice cómo silenciarlo");
  });

  test("callar al bot sigue siendo posible, y solo de dos formas", () => {
    // 1. El botón del panel, que es una decisión humana explícita.
    const rutas = sinComentarios(codigo("panel", "rutas.js"));
    const i = rutas.indexOf('router.post("/control"');
    assert.ok(i > 0, "desapareció la ruta de «Tomar el control»");
    assert.match(rutas.slice(i, i + 1200), /pausado:\s*tomar/, "«Tomar el control» ya no pausa");

    // 2. El propio bot, cuando pasa el caso a una persona: seguir vendiendo
    //    detrás de «te paso con una persona» convierte esa frase en mentira.
    const orquestar = sinComentarios(codigo("cerebro", "orquestar.js"));
    const j = orquestar.indexOf('situacion === "escalado"');
    assert.ok(j > 0, "no se encontró la rama de escalado");
    assert.match(
      orquestar.slice(j, j + 900),
      /pausado:\s*true/,
      "el bot ya no se calla al pasar el caso a una persona"
    );
  });

  test("el bot se calla al escalar, pero no antes de avisar al cliente", async () => {
    // De punta a punta: el mensaje de escalado SÍ sale. Si se pausara antes
    // de enviarlo, el cliente se quedaría sin saber que lo están pasando a
    // una persona, que es lo peor de los dos mundos.
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    const r = await c.dice("quiero hablar con una persona");

    assert.ok(r.texto, "no le dijo nada a quien pidió una persona");
    assert.match(r.texto, /persona|equipo/i, `no le avisó del traspaso: ${r.texto}`);
    assert.equal(atencion.leer(r.conversacion).pausado, true, "el bot no se calló tras pasar el caso");
  });
});

// ==========================================================================
// 12 · LA BANDERA NUEVA TIENE QUE SOBREVIVIR A POSTGRES
//
// Producción corre sobre Postgres (`almacen_transaccional: postgres`), y la
// tabla de conversaciones tiene columnas para unos campos concretos. Los que
// no tienen columna van a `extra`, que es JSON — así persisten `saludado`,
// `datosPedidos`, `pasoPropuesto` y `huboSenalDeCompra`.
//
// `cierrePropuesto` es la memoria que hace funcionar el arreglo del defecto
// 1. Si alguien añadiera una columna para ella sin mapearla, o la metiera en
// la lista de conocidos sin darle columna, el campo se perdería EN SILENCIO:
// en local todo pasaría y en producción el bot volvería a no entender el
// "sí". Esta prueba lo ata.
// ==========================================================================
describe("12 · `cierrePropuesto` persiste en el almacén de producción", () => {
  test("no se queda fuera del guardado de Postgres", () => {
    const pg = fs.readFileSync(path.join(RAIZ, "src", "almacen", "repos", "postgres", "index.js"), "utf8");

    const i = pg.indexOf("CAMPOS_CONVERSACION_CONOCIDOS = new Set([");
    assert.ok(i > 0, "no se encontró la lista de campos con columna propia");
    const lista = pg.slice(i, pg.indexOf("]", i));

    // O tiene columna propia Y se mapea de vuelta, o no la tiene y viaja en
    // `extra`. Lo que no puede es estar en la lista sin mapearse: ahí se
    // pierde.
    if (/cierrePropuesto/.test(lista)) {
      assert.match(
        pg,
        /cierrePropuesto:\s*f\./,
        "`cierrePropuesto` declara columna propia pero no se lee de vuelta: se perdería en producción"
      );
    } else {
      // Camino actual: va en `extra`, que es como persisten las demás
      // banderas de memoria.
      assert.match(pg, /\.\.\.\(f\.extra \|\| \{\}\)/, "las conversaciones ya no recuperan `extra`");
      assert.match(pg, /sobrantes\(c, CAMPOS_CONVERSACION_CONOCIDOS\)/, "las conversaciones ya no guardan `extra`");
    }
  });

  test("y sobrevive de un turno al siguiente", async () => {
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    // La ciudad primero: sin ella el bot pregunta la ciudad en vez de cerrar
    // (punto 9 de Marco, 10-oct).
    const sinCierre = await c.dice("Bogotá");
    assert.equal(responder.prometeCierre(sinCierre.texto), false, `cerró donde no debía: ${sinCierre.texto}`);
    assert.equal(sinCierre.conversacion.cierrePropuesto, false, "la bandera se puso sin pregunta de cierre");

    const conCierre = await c.dice("Cómo funciona");
    assert.equal(responder.prometeCierre(conCierre.texto), true, `el bot no cerró: ${conCierre.texto}`);
    assert.equal(
      conCierre.conversacion.cierrePropuesto,
      true,
      "el bot hizo una pregunta de cierre y no lo recordó"
    );
  });
});
