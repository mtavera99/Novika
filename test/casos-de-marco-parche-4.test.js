"use strict";

// ==========================================================================
// PARCHE 4 · ENTENDER EL SENTIDO, Y LOS DATOS DEL 9 DE OCTUBRE
//
// Marco mandó el parche 4 en cuatro secciones: A (clasificar por
// significado), B (un banco de 60 intenciones), C (28 pruebas obligatorias)
// y D (datos confirmados que reemplazan cualquier valor anterior).
//
// ⚠️ ESTE FICHERO NO SON LAS 28 PRUEBAS DE LA SECCION C.
//
// Las 28 venían numeradas en su mensaje y NO quedaron transcritas en el
// repositorio, así que escribirlas "de memoria" y ponerles su nombre sería
// inventarme lo que pidió. Lo que hay aquí es lo que SI se puede verificar
// palabra por palabra:
//
//   · los dos mensajes literales que abrieron el parche —«Ese quita los
//     cólicos?» y «Pero si quita los cólicos?»—, que recibían la respuesta
//     genérica y un «no te entendí»;
//   · la lista de jerga que él enumeró (kolicos, c0licos, nesecito, q, xq,
//     pa, «ese aparato», «esa vaina»);
//   · la lista de palabras que, según su regla literal, obligan a contestar
//     la intención más cercana: «nunca se usa la respuesta genérica ni "no
//     te entendí"»;
//   · su regla de lenguaje: «ayuda a aliviar», nunca «cura», «elimina» ni
//     «quita el dolor al 100 %»;
//   · los seis datos de la sección D, uno por uno;
//   · y tres defectos de captura que aparecieron AL PROBAR esto y que
//     estaban en producción, no en su lista.
//
// Falta pedirle las 28 para cerrar el hueco exacto. Está dicho en
// docs/PARCHE-4-2026-10-09.md.
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
const extraer = require("../src/dominio/extraer");
const preguntas = require("../src/dominio/preguntas");
const cotizador = require("../src/dominio/cotizador");

const RAIZ = path.join(__dirname, "..");
const ANUNCIO = "Hola, quiero información sobre el cinturón térmico de $49.900.";

/** Lo que Marco prohibió expresamente que recibiera un cliente. */
const NO_ENTENDI = /no te entend|perd[oó]n,? creo que no/i;
const GENERICA = /te cuento lo principal|buena pregunta 🙌 te cuento/i;

/** Su regla de lenguaje: se ayuda a aliviar, no se cura. */
const PROMESA_MEDICA = /\bcura\b|\bcuran\b|elimina el dolor|quita el dolor al 100|desaparece el dolor|garantizado/i;

let SEQ = 0;

function elCinturon() {
  const cat = cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true });
  return [...cat.porId.values()].find((p) => /cinturon/i.test(p.id) || /cinturón/i.test(p.nombre));
}

async function chat({ nombrePerfil = null, telefono = "573116391876" } = {}) {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-p4-")) });
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
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.C${salidas.length}` }] }) };
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
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.C${++SEQ}_${process.pid}_${Date.now()}`,
      idCliente: telefono,
      telefono,
      nombre: nombrePerfil,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });
    const conv = await repos.conversaciones.obtener(telefono);
    return {
      traza,
      texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join(" "),
      conversacion: conv,
      ficha: (conv && conv.ficha) || {},
    };
  };

  const pedidos = async () => {
    const l = await repos.pedidos.listar({ limite: 20 });
    return Array.isArray(l) ? l : l.filas || [];
  };

  return { dice, pedidos, repos };
}

// ==========================================================================
describe("A · entender el sentido, no la letra", () => {
  // ------------------------------------------------------------------------
  // LOS DOS MENSAJES QUE ABRIERON EL PARCHE
  //
  // Del panel, 9-oct 02:07, con el parche 3 ya puesto:
  //   cliente · "Ese quita los cólicos?"   bot · "Buena pregunta 🙌 Te
  //                                               cuento lo principal..."
  //   cliente · "Pero si quita los cólicos?"  bot · "Perdón, creo que no te
  //                                                  entendí bien 🙈"
  //
  // La lista de patrones tenía "sirve para" y "para que sirve". No tenía
  // "quita". De un producto que se llama "cinturón térmico PARA CÓLICOS".
  // ------------------------------------------------------------------------
  test("1 · «Ese quita los cólicos?» se contesta, no se despacha con lo principal", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Ese quita los cólicos?");

    assert.equal(GENERICA.test(r.texto), false, `respuesta genérica: ${r.texto}`);
    assert.equal(NO_ENTENDI.test(r.texto), false, r.texto);
    assert.match(r.texto, /c[óo]lico/i, `no habló del cólico: ${r.texto}`);
    assert.match(r.texto, /alivia|aliviar|relaj/i, `no dijo qué hace: ${r.texto}`);
  });

  test("2 · y repetirla con un «Pero» delante tampoco recibe «no te entendí»", async () => {
    // El segundo mensaje es el que de verdad dolía: la clienta insistió
    // porque la primera respuesta no le sirvió, y recibió un «no te
    // entendí» a la misma pregunta.
    const c = await chat();
    await c.dice(ANUNCIO);
    await c.dice("Ese quita los cólicos?");
    const r = await c.dice("Pero si quita los cólicos?");

    assert.equal(NO_ENTENDI.test(r.texto), false, `el fallo literal del 9-oct: ${r.texto}`);
    assert.match(r.texto, /c[óo]lico/i, r.texto);
  });

  test("3 · «no te entendí» nunca dos veces seguidas", async () => {
    // Su regla: solo si no hay relación con producto, compra o envío, y
    // nunca dos veces seguidas.
    const c = await chat();
    await c.dice(ANUNCIO);
    const uno = await c.dice("asdfgh qwerty");
    const dos = await c.dice("zxcvbn poiuyt");

    assert.equal(
      NO_ENTENDI.test(uno.texto) && NO_ENTENDI.test(dos.texto),
      false,
      `dos «no te entendí» seguidos:\n  1) ${uno.texto}\n  2) ${dos.texto}`
    );
  });

  // ------------------------------------------------------------------------
  // LA JERGA QUE ENUMERO MARCO, UNA POR UNA
  // ------------------------------------------------------------------------
  test("4 · la jerga y las erratas que enumeró Marco se entienden", async () => {
    const frases = [
      "kolicos",
      "c0licos",
      "nesecito uno pa los kolicos",
      "q tal sirve pa la regla",
      "xq es tan caro",
      "ese aparato como se carga",
      "esa vaina kalienta?",
    ];
    for (const f of frases) {
      const c = await chat();
      await c.dice(ANUNCIO);
      const r = await c.dice(f);
      assert.equal(NO_ENTENDI.test(r.texto), false, `«${f}» recibió un «no te entendí»: ${r.texto}`);
      assert.equal(GENERICA.test(r.texto), false, `«${f}» recibió la genérica: ${r.texto}`);
      assert.ok(r.texto.trim().length > 0, `«${f}» se quedó sin respuesta`);
    }
  });

  // ------------------------------------------------------------------------
  // SU REGLA LITERAL: ESTAS PALABRAS NUNCA CAEN EN LA GENERICA
  // ------------------------------------------------------------------------
  test("5 · las palabras de producto que listó siempre reciben la intención más cercana", () => {
    // La lista es la suya, textual. Se comprueba en el detector y no en la
    // conversación completa porque es donde vive la regla: si aquí no hay
    // tema, el redactor no tiene de qué hablar.
    const suyas = [
      "cólico", "dolor", "regla", "periodo", "menstruación", "calienta", "calor", "vibra",
      "masaje", "batería", "carga", "cargador", "relaja", "músculo", "espalda", "barriga",
      "abdomen", "sirve", "funciona", "quema",
    ];
    const sinTema = [];
    for (const p of suyas) {
      const l = preguntas.leer(`${p}?`);
      if (!l.temas.length) sinTema.push(p);
    }
    assert.deepEqual(sinTema, [], `palabras de Marco que siguen sin intención: ${sinTema.join(", ")}`);
  });

  test("6 · pero el NOMBRE del producto no es una pregunta sobre el producto", async () => {
    // El defecto que introdujo la red de seguridad: «termico» y «colicos»
    // están en el nombre, así que "quiero el cinturón térmico" se contestaba
    // con la temperatura y perdía el precio y la pedida de datos.
    const c = await chat();
    const r = await c.dice("quiero el cinturon termico");

    assert.match(r.texto, /49\.900/, `perdió el precio por leer el nombre como pregunta: ${r.texto}`);
    assert.equal(/60 °C|niveles de calor/.test(r.texto), false, `contestó la temperatura a una compra: ${r.texto}`);
  });

  test("7 · dos preguntas en un mensaje se contestan las dos", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("cuanto vale y tiene garantia?");

    assert.match(r.texto, /49\.900/, `no contestó el precio: ${r.texto}`);
    assert.match(r.texto, /garant[íi]a|1 mes/i, `no contestó la garantía: ${r.texto}`);
  });

  test("8 · nunca se promete curar: se ayuda a aliviar", async () => {
    // La regla de lenguaje de la sección B, que es la que más riesgo tiene:
    // es un producto de bienestar que se compra por dolor.
    for (const f of ["quita los colicos?", "me cura el dolor?", "sirve para el dolor menstrual?", "duele mucho, me sirve?"]) {
      const c = await chat();
      await c.dice(ANUNCIO);
      const r = await c.dice(f);
      assert.equal(PROMESA_MEDICA.test(r.texto), false, `promesa médica ante «${f}»: ${r.texto}`);
    }
  });
});

// ==========================================================================
describe("D · los datos confirmados el 9 de octubre", () => {
  // Su frase: «Estos datos reemplazan cualquier valor anterior».

  test("9 · NO se apaga solo, y se dice sin rodeos", () => {
    const p = elCinturon();
    assert.equal(p.seguridad.apagadoAutomatico, false);
    const t = require("../src/cerebro/contestar").deTema(preguntas.TEMAS.APAGADO_AUTO, { producto: p });
    assert.match(t, /no se apaga sol|no tiene apagado/i, t);
  });

  test("10 · SÍ funciona mientras se carga", () => {
    const p = elCinturon();
    assert.equal(p.energia.usarMientrasCarga, true);
    const t = require("../src/cerebro/contestar").deTema(preguntas.TEMAS.ENERGIA, { producto: p });
    assert.ok(t.length > 0, "el tema de energía se quedó sin texto");
  });

  test("11 · la correa abarca 130 a 150 cm, hasta talla 4XL", () => {
    const p = elCinturon();
    assert.equal(p.ajuste.contornoMinCm, 130);
    assert.equal(p.ajuste.contornoMaximoCm, 150);
    assert.equal(p.ajuste.hastaTalla, "4XL");

    const t = require("../src/cerebro/contestar").deTema(preguntas.TEMAS.MEDIDAS, { producto: p });
    assert.match(t, /130 a 150 cm/, t);
    assert.match(t, /4XL/, t);
    // Y la fórmula que autorizó, no la fácil.
    assert.match(t, /casi cualquier persona/, t);
    assert.equal(/le sirve a cualquiera|talla única universal/i.test(t), false, t);
  });

  test("12 · desde 2 unidades, 42.500 cada una: 2, 3, 4 y 5 cotizan", () => {
    const p = elCinturon();
    const esperado = { 2: 85000, 3: 127500, 4: 170000, 5: 212500 };
    for (const [n, total] of Object.entries(esperado)) {
      const r = cotizador.cotizar({ producto: p, cantidad: Number(n) });
      assert.equal(r.ok, true, `no cotizó ${n} unidades: ${r.motivo}`);
      assert.equal(r.cotizacion.total, total, `el total de ${n} no es el que aprobó Marco`);
      assert.equal(total, 42500 * Number(n), `${n} no sale de 42.500 por unidad`);
    }
  });

  test("13 · más de 5 se escala a mayorista, no se extrapola", () => {
    const p = elCinturon();
    for (const n of [6, 7, 10, 24]) {
      const r = cotizador.cotizar({ producto: p, cantidad: n });
      assert.equal(r.ok, false, `cotizó ${n} unidades, que Marco dijo que se hablan como mayorista`);
      assert.equal(r.escalar, true, `${n} unidades no pasó a una persona`);
    }
  });

  test("14 · y una pregunta por 8 unidades deja la venta anotada", async () => {
    // Es el pedido más grande que puede llegar, así que perderlo por no
    // anotarlo sería lo más caro de todo.
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("y cuanto cuestan ocho?");

    assert.match(r.texto, /8 unidades/, `no reconoció por cuántas preguntaba: ${r.texto}`);
    const p = atencion.pendienteDe(r.conversacion);
    assert.equal(p.hay, true, "no dejó tarea por una venta de 8 unidades");
  });

  test("15 · se paga al recibir con efectivo, Nequi, Daviplata o transferencia", () => {
    const p = elCinturon();
    assert.deepEqual(p.pago.mediosAlRecibir, ["efectivo", "Nequi", "Daviplata", "transferencia"]);

    const t = require("../src/cerebro/contestar").deTema(preguntas.TEMAS.PAGO, { producto: p, cotizacion: null });
    for (const medio of ["efectivo", "Nequi", "Daviplata", "transferencia"]) {
      assert.match(t, new RegExp(medio, "i"), `no nombró ${medio}: ${t}`);
    }
    // La frase canónica que contesta «¿es contra entrega?» va entera.
    assert.match(t, /pagas cuando lo recibes/i, t);
  });

  test("16 · el pago por Nequi ya no se declara como dato pendiente", () => {
    // La trampa que el propio catálogo documenta: un dato confirmado en el
    // campo y declarado dudoso en la lista deja un bot que lo tiene y dice
    // que no lo tiene.
    const p = elCinturon();
    assert.equal(
      p.sinDatoConfirmado.some((s) => /Nequi|transferencia/i.test(s)),
      false,
      "los medios de pago están en la ficha y a la vez declarados sin confirmar"
    );
    assert.equal(
      p.sinDatoConfirmado.some((s) => /contorno/i.test(s)),
      false,
      "la medida de la correa está en la ficha y a la vez declarada sin confirmar"
    );
  });

  test("17b · «¿se puede usar mientras se carga?» se contesta SÍ, no lo contrario", async () => {
    // Defecto de mi propio parche: el dato quedó escrito en la ficha
    // (`energia.usarMientrasCarga`) y sin conectar a ninguna respuesta, así
    // que el bot lo tenía y seguía contestando el texto de energía, que
    // acaba en «mientras lo usas no va conectado a nada» — un NO.
    for (const f of ["se puede usar mientras se carga?", "lo puedo usar conectado?"]) {
      const c = await chat();
      await c.dice(ANUNCIO);
      const r = await c.dice(f);
      assert.match(r.texto, /funciona mientras se está cargando/i, `contestó lo contrario del dato de Marco ante «${f}»: ${r.texto}`);
      assert.equal(
        /no va conectado mientras lo usas|mientras lo usas no va conectado/i.test(r.texto),
        false,
        `salieron las dos respuestas contradictorias juntas: ${r.texto}`
      );
    }
  });

  test("17c · «¿eso quema?» recibe un sí o un no, no una ficha técnica", async () => {
    // Marco autorizó la fórmula, y es condicional a propósito: «nunca
    // quema» y «no se calienta de más» siguen prohibidos.
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("eso quema?");

    assert.match(r.texto, /si lo usas bien, no/i, `no contestó el miedo: ${r.texto}`);
    assert.match(r.texto, /nivel más bajo/i, `no dijo por dónde empezar: ${r.texto}`);
    assert.equal(/nunca quema|no se calienta de m[áa]s/i.test(r.texto), false, `afirmación absoluta prohibida: ${r.texto}`);
    const claims = require("../src/cerebro/responder").revisarClaims(r.texto, elCinturon());
    assert.equal(claims.ok, true, JSON.stringify(claims.encontrados));
  });

  test("17d · «¿me llega hoy?» se contesta que no, sin prometer una fecha", async () => {
    // Caía en el plazo general y salía «Claro, te llega en 1 a 3 días
    // hábiles»: el «Claro,» delante de una pregunta de sí o no se lee como
    // un sí, y «te llega hoy» es un claim prohibido.
    for (const f of ["me llega hoy?", "llega manana?", "llega el mismo dia?"]) {
      const c = await chat();
      await c.dice(ANUNCIO);
      const r = await c.dice(f);
      assert.match(r.texto, /hoy mismo no/i, `no dijo que hoy no ante «${f}»: ${r.texto}`);
      assert.equal(/^Claro,/.test(r.texto), false, `abrió con un «Claro,» que se lee como un sí: ${r.texto}`);
      const claims = require("../src/cerebro/responder").revisarClaims(r.texto, elCinturon());
      assert.equal(claims.ok, true, `${JSON.stringify(claims.encontrados)} -> ${r.texto}`);
    }
  });

  test("17e · una condición médica se deriva al médico, no se contesta con la talla", async () => {
    // «tengo ovario poliquístico, me sirve?» contestaba el contorno de la
    // correa, y «estoy en posparto» recibía la respuesta genérica.
    for (const f of ["tengo ovario poliquistico, me sirve?", "estoy en posparto, puedo usarlo?", "sirve para la endometriosis?"]) {
      const c = await chat();
      await c.dice(ANUNCIO);
      const r = await c.dice(f);
      assert.match(r.texto, /m[ée]dico/i, `no lo derivó al médico ante «${f}»: ${r.texto}`);
      assert.equal(GENERICA.test(r.texto), false, `respuesta genérica ante «${f}»: ${r.texto}`);
      assert.equal(/130 a 150 cm|4XL/.test(r.texto), false, `contestó la talla a una condición médica: ${r.texto}`);
      const claims = require("../src/cerebro/responder").revisarClaims(r.texto, elCinturon());
      assert.equal(claims.ok, true, JSON.stringify(claims.encontrados));
    }
  });

  test("17 · la garantía son las DOS cosas: 7 días de devolución y 1 mes por defectos", () => {
    const p = elCinturon();
    assert.equal(p.garantia, "1 mes");
    assert.ok(p.pruebaDeSieteDias, "falta la prueba de 7 días, que Marco confirmó el 10-oct");
  });
});

// ==========================================================================
describe("Defectos que aparecieron AL PROBAR el parche 4", () => {
  // ------------------------------------------------------------------------
  // No estaban en la lista de Marco: estaban en producción, y se
  // encontraron corriendo `herramientas/revivir.js` con sus chats reales.
  // Los tres son la misma clase de fallo —un mensaje que es una PREGUNTA se
  // guardaba como un DATO del cliente— y los tres pisaban el nombre de
  // perfil de WhatsApp, que era el correcto.
  // ------------------------------------------------------------------------
  test("18 · «Tienes cinturones» no es el nombre del cliente", async () => {
    // Del chat de pruebas de Marco. El pedido salía «Para: Tienes
    // cinturones» y el cierre «¡Listo, Tienes!». Ese nombre es el que iba a
    // la guía de la transportadora.
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    await c.dice("1 a Bogotá");
    const r = await c.dice("Tienes cinturones");

    assert.equal(
      /Tienes cinturones/i.test(String(campos.valorConfirmado(r.ficha.nombre) || "")),
      false,
      "guardó una pregunta como nombre del cliente"
    );
    assert.equal(/¡Listo, Tienes!/.test(r.texto), false, r.texto);
  });

  test("19 · «esa vaina kalienta?» no es una ciudad", async () => {
    // Contestaba «A Esa Vaina Kalienta te llega en 1 a 3 días hábiles»:
    // dejaba la pregunta sin responder Y un destino falso en la ficha.
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("esa vaina kalienta?");

    const ciudad = String(campos.valorConfirmado(r.ficha.ciudad) || "");
    assert.equal(/vaina|kalienta/i.test(ciudad), false, `guardó una pregunta como ciudad: "${ciudad}"`);
    assert.match(r.texto, /calor|calienta|°C/i, `no contestó lo que preguntaba: ${r.texto}`);
  });

  test("20 · «uno» es una cantidad, no un nombre de persona", async () => {
    // El bot pregunta «¿cuántos quieres?», la clienta contesta «uno», y
    // «uno» quedaba como su nombre, pisando «Mauricio Benítez» del perfil.
    const c = await chat({ nombrePerfil: "Mauricio Benítez" });
    await c.dice(ANUNCIO);
    await c.dice("quiero comprarlo");
    const r = await c.dice("uno");

    const nombre = String(campos.valorConfirmado(r.ficha.nombre) || "");
    assert.equal(/^uno$/i.test(nombre), false, `guardó la cantidad como nombre: "${nombre}"`);
  });

  test("21 · y los candados nuevos no se comen un nombre o una ciudad de verdad", () => {
    // El otro lado de los tres arreglos de arriba. Si esto falla, el bot
    // dejó de capturar datos legítimos, que es peor que el defecto.
    const n = (f) => String((extraer.nombreEn(f, { seLoPidieron: true }) || {}).valor);
    for (const [frase, esperado] of [
      ["Mauricio Benítez", "Mauricio Benítez"],
      ["Ana Pérez", "Ana Pérez"],
      ["Marcela", "Marcela"],
      ["Luz Marina Quintero", "Luz Marina Quintero"],
    ]) {
      assert.equal(n(frase), esperado, `dejó de capturar un nombre legítimo: "${frase}"`);
    }

    const ciu = (f) => String((extraer.ciudadEn(f, { seLaPidieron: true }) || {}).valor);
    // Guacamayal no está en el listado del DANE y rechazarlo costó una venta
    // el 08-oct: el candado nuevo no puede volver a cerrar esa puerta.
    for (const [frase, esperado] of [
      ["Guacamayal", "guacamayal"],
      ["Zona Bananera", "zona bananera"],
      ["vivo en Guacamayal", "guacamayal"],
    ]) {
      assert.equal(ciu(frase), esperado, `dejó de capturar una ciudad legítima: "${frase}"`);
    }
  });

  test("22 · los números en palabra se entienden hasta diez", () => {
    // Hacía falta para que «más de 5 se escala a mayorista» funcione cuando
    // la cantidad se escribe con letras: «ocho» no se reconocía y el bot
    // contestaba el precio de UNA.
    for (const [frase, esperado] of [
      ["cuanto cuestan tres", 3],
      ["y si llevo seis?", 6],
      ["cuanto cuestan ocho", 8],
      ["llevando nueve", 9],
      ["cuanto cuestan diez", 10],
    ]) {
      assert.equal(preguntas.leer(frase).cantidadPreguntada, esperado, `no entendió la cantidad de «${frase}»`);
    }
  });
});
