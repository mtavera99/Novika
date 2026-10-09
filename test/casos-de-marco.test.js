"use strict";

// ==========================================================================
// LOS 20 CASOS DE MARCO · PARTE C DEL PLAN DE CORRECCIÓN
//
// Marco los escribió uno por uno a partir de los chats reales del 7 y 8 de
// octubre, con la condición explícita:
//
//   «El bot debe pasarlos todos antes de volver a producción.»
//
// Cada caso lleva, en el mismo orden que su documento: lo que el cliente
// escribió, lo que pasó, y lo que debe pasar ahora.
//
// --------------------------------------------------------------------------
// DOS CASOS NO ESTÁN AQUÍ, Y HAY QUE DECIRLO
// --------------------------------------------------------------------------
//
// · El 15 (recordatorios a los 45 min y 4 h) necesita un programador de
//   tareas que hoy no existe en este repositorio. No se finge con una
//   prueba: está documentado como lo siguiente que falta.
// · El 5 y el 10 (agrupar mensajes que llegan en 5-8 segundos) necesitan un
//   buffer de entrada en el webhook. Lo que SÍ se verifica aquí es que cada
//   uno de esos mensajes, por separado, reciba la respuesta correcta — que
//   era el fallo de fondo.
//
// El resto se verifica de punta a punta.
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
const preguntas = require("../src/dominio/preguntas");
const { TEMAS } = preguntas;

const RAIZ = path.join(__dirname, "..");
const CLIENTE = "573001112233";
const ANUNCIO = "Hola, quiero información sobre el cinturón térmico de $49.900.";

let SEQ = 0;

/**
 * Una conversación contra el cerebro de verdad, con `atencion` cableado al
 * emisor COMO EN PRODUCCIÓN: así, si el bot se queda mudo, la prueba lo ve.
 */
async function chat({ nombrePerfil = null, telefono = CLIENTE, idCliente = null } = {}) {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-marco-")) });
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
    fetchImpl: async (url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.M${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  const id = idCliente || telefono;

  const dice = async (texto, { tipo = "text", media = null } = {}) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.M${++SEQ}_${process.pid}_${Date.now()}`,
      idCliente: id,
      telefono,
      nombre: nombrePerfil,
      tipo,
      texto,
      origenTexto: media ? "pie_de_media" : "escrito",
      media,
      referral: null,
    });
    const conv = await repos.conversaciones.obtener(id);
    return {
      traza,
      texto: salidas
        .filter((s) => s.type === "text")
        .map((s) => s.text.body)
        .join(" "),
      fotos: salidas.filter((s) => s.type === "image").length,
      pausado: atencion.leer(conv || {}).pausado === true,
      conversacion: conv,
    };
  };

  const pedidos = async () => {
    const l = await repos.pedidos.listar({ limite: 20 });
    return Array.isArray(l) ? l : l.filas || [];
  };

  return { dice, pedidos, repos, id };
}

/** Las frases que Marco prohibió expresamente. */
const PROHIBIDAS = /no quiero repetirme|dime concretamente|no te l[ao]s? quiero (decir|contestar) a medias/i;

/** Ningún mensaje puede quedarse "suelto": todos terminan invitando a algo. */
const CIERRA_CON_ALGO = /\?|¿|te lo aparto|te lo dejo|aqu[íi] estoy|me escribes/i;

describe("Los 20 casos de Marco", () => {
  // ------------------------------------------------------------------------
  test("1 · nombre, ciudad y barrio en tres mensajes → resumen", async () => {
    // Lo que pasó: la dirección quedó como "— falta" y nunca se mostró el
    // resumen. Dos candados en serie exigían un número.
    const c = await chat();
    await c.dice(ANUNCIO);
    await c.dice("Alejandro león Garzón");
    await c.dice("Popayán Cauca");
    const r = await c.dice("Barrio pueblillo en la cantera la pintada");

    assert.match(r.texto, /Confirmemos tu pedido/i, `no llegó al resumen: ${r.texto}`);
    assert.match(r.texto, /pueblillo/i, "no tomó el barrio como dirección");
    assert.match(r.texto, /Popayan/i, "no tomó la ciudad");
  });

  test("2 · «Barrio buenos aires» se acepta y no se vuelve a pedir", async () => {
    // Lo que pasó: pidió la dirección 3 veces hasta que el cliente escribió
    // "No entiendo".
    const c = await chat({ nombrePerfil: "Mauricio Benítez" });
    await c.dice(ANUNCIO);
    await c.dice("San andres de sotavento Córdoba");
    await c.dice("Uno");
    const r = await c.dice("Barrio buenos aires");

    assert.match(r.texto, /Confirmemos tu pedido/i, `no llegó al resumen: ${r.texto}`);
    // Y la ciudad correcta: NO el archipiélago.
    assert.match(r.texto, /Sotavento/i, `ciudad equivocada: ${r.texto}`);
    assert.equal((await c.dice("si")).traza.respuesta.situacion, "confirmado");
  });

  test("3 · «Que costó tiene» → el precio, no un escalado", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Que costó tiene");
    assert.match(r.texto, /49\.900/, r.texto);
    assert.equal(PROHIBIDAS.test(r.texto), false, r.texto);
    assert.equal(r.pausado, false);
  });

  test("4 · «Algo contra entrega» → sí, y sigue la venta", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Algo contra entrega");
    assert.match(r.texto, /al recibir|pagas cuando/i, r.texto);
    assert.equal(PROHIBIDAS.test(r.texto), false, r.texto);
  });

  test("5 · «En qué ciudad» y «Te encuentras» → se contesta, no se escala", async () => {
    // Lo que pasó: los dos mensajes acabaron en el equipo.
    //
    // ⚠️ Lo de AGRUPAR los dos mensajes (A10) necesita un buffer en el
    //    webhook y no está hecho. Lo que se verifica es el fallo de fondo:
    //    que cada uno reciba la respuesta correcta en vez de un escalado.
    const c = await chat();
    await c.dice(ANUNCIO);
    const a = await c.dice("En qué ciudad");
    assert.match(a.texto, /todo el pa[íi]s|colombiana|en línea/i, a.texto);
    assert.equal(PROHIBIDAS.test(a.texto), false, a.texto);

    const b = await c.dice("Te encuentras");
    assert.equal(PROHIBIDAS.test(b.texto), false, b.texto);
    assert.ok(b.texto, "se quedó sin responder");
  });

  test("6 · «Cuando me llegaría» → los tiempos de envío", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Cuando me llegaría");
    assert.match(r.texto, /1 a 3 d[íi]as|1 a 2 d[íi]as/i, r.texto);
    assert.equal(r.pausado, false);
  });

  test("7 · «¿No habría manera de que llegue hoy?» → franqueza, sin escalar", async () => {
    // Lo que pasó: escalado, y la respuesta humana llegó 4 horas después.
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("No habría manera de que llegue hoy?");

    assert.match(r.texto, /1 a 3 d[íi]as|1 a 2 d[íi]as/i, r.texto);
    assert.equal(r.pausado, false, "se calló justo con el cliente más caliente del día");
    // Y NUNCA promete el día: está en claimsProhibidos frase por frase.
    assert.equal(/te llega hoy|llega hoy mismo/i.test(r.texto), false, r.texto);
  });

  test("8 · «Trae cargador» → la respuesta de batería, no la de cólicos", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Trae cargador");
    assert.match(r.texto, /USB|recargable/i, r.texto);
    assert.equal(/alivia el cólico|relajar/i.test(r.texto), false, `contestó otra cosa: ${r.texto}`);

    // Y la segunda forma de preguntarlo NO recibe el mismo párrafo.
    const dos = await c.dice("Con cables para cargar");
    assert.equal(PROHIBIDAS.test(dos.texto), false, dos.texto);
  });

  test("9 · la despedida larga no recibe un formulario", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice(
      "Vale mil gracias, apenas vaya a pedirlo de fijo te aviso, okey, esta hermoso, muy amable, listo, gracias por la info, bendiciones🥰"
    );
    assert.equal(/me pasas|Cuántos quieres/i.test(r.texto), false, `le pidió los datos: ${r.texto}`);
    assert.ok(r.texto, "se quedó sin responder");
  });

  test("10 · un sticker dos veces no recibe la frase prohibida", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const a = await c.dice("", { tipo: "sticker", media: { tipo: "sticker", id: "s1" } });
    const b = await c.dice("", { tipo: "sticker", media: { tipo: "sticker", id: "s2" } });

    for (const r of [a, b]) {
      assert.equal(PROHIBIDAS.test(r.texto), false, r.texto);
      assert.ok(r.texto, "se quedó sin responder a un sticker");
    }
    assert.equal(b.pausado, false, "un sticker repetido pausó el bot");
  });

  test("10-bis · un audio pide que lo escriba, sin prometer inmediatez", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("", { tipo: "audio", media: { tipo: "audio", id: "a1" } });
    assert.match(r.texto, /audios?/i, r.texto);
    // "enseguida" es una promesa de tiempo y está prohibida desde que el bot
    // la usó a las dos de la mañana.
    assert.equal(/enseguida|en un momento/i.test(r.texto), false, r.texto);
  });

  test("11 · «1 a Bogotá» toma cantidad Y ciudad, y no repregunta", async () => {
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    const r = await c.dice("1 a Bogotá");

    assert.match(r.texto, /Bogota/i, r.texto);
    assert.equal(/Cuántos quieres/i.test(r.texto), false, `volvió a preguntar la cantidad: ${r.texto}`);

    const dos = await c.dice("Si");
    assert.equal(/Cuántos quieres/i.test(dos.texto), false, `la repreguntó al turno siguiente: ${dos.texto}`);
    const tres = await c.dice("1 nada amas");
    assert.equal(PROHIBIDAS.test(tres.texto), false, tres.texto);
  });

  test("12 · «Hola» y «Hola?» no reciben dos veces el mismo mensaje", async () => {
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    const a = await c.dice("Hola");
    const b = await c.dice("Hola?");
    assert.notEqual(a.texto.trim(), b.texto.trim(), "mandó dos veces el mismo mensaje");
    assert.equal(PROHIBIDAS.test(b.texto), false, b.texto);
  });

  test("13 · un cliente con nombre de usuario SÍ recibe respuesta", async () => {
    // Lo que pasó: `destinatario_sin_telefono` y nunca le llegó nada.
    //
    // El envío a BSUID se arregló en #48: va en `recipient`, no en `to`.
    const c = await chat({ telefono: null, idCliente: "CO.1234567890123456" });
    const r = await c.dice(ANUNCIO);
    assert.ok(r.texto, "el cliente con nombre de usuario se quedó sin respuesta");
    assert.match(r.texto, /49\.900/, r.texto);
  });

  test("13-bis · y se le pide el celular, porque la transportadora llama", async () => {
    const c = await chat({ telefono: null, idCliente: "CO.1234567890123456" });
    await c.dice(ANUNCIO);
    await c.dice("lo quiero, soy Ana, Cali, Calle 5 # 10-20");
    const r = await c.dice("si");
    const pedido = (await c.pedidos())[0];
    if (!pedido) {
      // Sin celular el pedido NO se puede construir: es la regla que pidió
      // Marco y la protege `REQUERIDOS_PARA_DESPACHAR`. Entonces el bot
      // tiene que estar pidiéndolo.
      assert.match(r.texto, /celular/i, `ni pedido ni petición de celular: ${r.texto}`);
    }
  });

  test("14 · «Hacen envios a todo nacional» → sí, y pregunta la ciudad", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Hacen envios a todo nacional");
    assert.match(r.texto, /todo el pa[íi]s|toda colombia|incluido/i, r.texto);
    assert.match(r.texto, CIERRA_CON_ALGO, `se quedó suelto: ${r.texto}`);
  });

  test("16 · reiniciar la conversación NO anula el pedido", async () => {
    // Lo que pasó: el pedido apareció anulado después de "conversación
    // reiniciada por panel".
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    await c.dice("lo quiero, soy Santiago, Bogotá, Calle 62bis 67-12");
    const conf = await c.dice("Si");
    assert.equal(conf.traza.respuesta.situacion, "confirmado", "la venta no se cerró");

    await atencion.empezarDeCero(c.repos, c.id, { por: "panel" });

    const pedidos = await c.pedidos();
    assert.equal(pedidos.length, 1, "el pedido desapareció");
    assert.notEqual(pedidos[0].estado, "cancelado", "reiniciar la conversación anuló el pedido");
  });

  test("16-bis · y un «No entiendo» tampoco lo anula", async () => {
    // ⚠️ ESTE ERA EL MECANISMO REAL, y es peor que el que Marco sospechaba.
    //
    // Con el `/^no\b/` que había en las negaciones, CUALQUIER mensaje que
    // empezara por "no" se leía como cancelación — y sobre un pedido ya
    // confirmado eso no se quedaba en un escalado: cancelaba el pedido.
    const c = await chat({ nombrePerfil: "Santiago" });
    await c.dice(ANUNCIO);
    await c.dice("lo quiero, soy Santiago, Bogotá, Calle 62bis 67-12");
    await c.dice("Si");

    for (const m of ["No entiendo", "no me ha llegado", "No cargaron", "no"]) {
      await c.dice(m);
      const p = (await c.pedidos())[0];
      assert.notEqual(p.estado, "cancelado", `"${m}" canceló un pedido confirmado`);
    }

    // Pero pedirlo claro SÍ cancela: el cliente tiene derecho.
    await c.dice("cancelar mi pedido");
    assert.equal((await c.pedidos())[0].estado, "cancelado", "no dejó cancelar a quien lo pidió claro");
  });

  test("17 · «En q colores tiene» termina con una pregunta", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("En q colores tiene");
    assert.match(r.texto, /rosado/i, r.texto);
    assert.match(r.texto, CIERRA_CON_ALGO, `se quedó suelto, sin invitar a nada: ${r.texto}`);
  });

  test("18 · «Quiero hablar con alguien» escala, y el bot sigue atendiendo", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Quiero hablar con alguien");

    assert.equal(r.traza.motivoEscalado, "pidio_una_persona");
    assert.match(r.texto, /persona del equipo/i, r.texto);
    assert.equal(atencion.pendienteDe(r.conversacion).hay, true, "escaló y no dejó tarea");
    // Y NO se calla: es la regla que pidió Marco.
    assert.equal(r.pausado, false, "escalar volvió a pausar el bot");

    const sigue = await c.dice("bueno, igual lo quiero, soy Ana, Cali, Calle 5 # 10-20");
    assert.ok(sigue.texto, "tras escalar dejó de atender la venta");
  });

  test("19 · «Estoy embarazada» deriva al médico, sin consejo médico", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Estoy embarazada, ¿lo puedo usar?");

    assert.match(r.texto, /m[ée]dico/i, r.texto);
    // Ni sí, ni consejo, ni promesa.
    assert.equal(/claro que s[íi]|s[íi], (puedes|es apto)|no hay problema/i.test(r.texto), false, r.texto);
    // Y no escala: la regla de Marco es que solo escale si insiste con
    // preguntas médicas.
    assert.equal(r.pausado, false);
  });

  test("20 · «Quiero 10 para mi tienda» escala como mayorista", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    const r = await c.dice("Quiero 10 para mi tienda");

    assert.equal(r.traza.motivoEscalado, "pedido_mayorista");
    assert.match(r.texto, /por mayor|persona del equipo/i, r.texto);
    assert.equal(atencion.pendienteDe(r.conversacion).hay, true, "el lead mayorista no dejó tarea");
    // Y NO se inventa un precio: la tabla cubre 1 y 2 unidades.
    assert.equal(/\$/.test(r.texto), false, `soltó una cifra que no existe: ${r.texto}`);
  });

  // ------------------------------------------------------------------------
  // REGLAS TRANSVERSALES DEL PROMPT NUEVO (Parte B)
  // ------------------------------------------------------------------------

  // ------------------------------------------------------------------------
  // LA CONTRADICCIÓN ENTRE EL ANUNCIO Y LA GARANTÍA (2026-10-09)
  //
  // El anuncio de Facebook promete «Pruébalo 7 días: si no sientes alivio,
  // te devolvemos tu dinero». Marco confirmó que lo que vale es «1 mes por
  // defecto de fábrica». No son lo mismo: una devuelve plata por no gustar,
  // la otra cambia el producto si llega roto.
  //
  // Así que van a llegar clientas citando el anuncio, y el bot tiene que
  // sostener una contradicción que no creó él. Tres cosas que NO puede hacer:
  // prometer la devolución (nadie la aprobó), negar que el anuncio lo diga
  // (lo dice), o contestar el plazo de la garantía como si fuera lo mismo
  // (es cambiarle las condiciones sin avisar).
  // ------------------------------------------------------------------------
  describe("el anuncio promete 7 días y la garantía es de 1 mes", () => {
    const CITAN_EL_ANUNCIO = [
      "pero el anuncio dice que me devuelven el dinero",
      "si no siento alivio me devuelven la plata?",
      "no era de 7 dias de prueba?",
      "ahí dice que me devuelven el dinero",
    ];

    test("no promete la devolución, pero tampoco desmiente el anuncio", async () => {
      for (const m of CITAN_EL_ANUNCIO) {
        const c = await chat();
        await c.dice(ANUNCIO);
        const r = await c.dice(m);

        // NO promete devolver plata.
        assert.equal(
          /te devolvemos|te devuelvo|se te devuelve|devolución del dinero sí|7 días de prueba/i.test(r.texto),
          false,
          `prometió la devolución con "${m}": ${r.texto}`
        );
        // NO desmiente a la clienta.
        assert.equal(
          /no es (cierto|verdad)|eso no|está equivocad|no decimos/i.test(r.texto),
          false,
          `desmintió a la clienta con "${m}": ${r.texto}`
        );
        // Dice lo que SÍ cubre, y pone delante el contraentrega.
        assert.match(r.texto, /pagas cuando|al recibir|antes de/i, `sin el argumento del riesgo: ${r.texto}`);
        assert.match(r.texto, /1 mes|defecto de fábrica/i, `sin la garantía real: ${r.texto}`);
        // Y queda la tarea: cada una es evidencia de que el anuncio genera
        // una expectativa que la política no cubre.
        assert.equal(atencion.pendienteDe(r.conversacion).hay, true, `no dejó tarea con "${m}"`);
      }
    });

    test("y el filtro de claims bloquea la promesa aunque el modelo la intente", () => {
      // La defensa de verdad: si el modelo redacta la promesa del anuncio,
      // `revisarClaims` tiene que tumbarla. Es plata de vuelta, y es la
      // única promesa del catálogo que el propio anuncio ya está haciendo.
      const responder = require("../src/cerebro/responder");
      const producto = cargarCatalogo({
        carpeta: path.join(RAIZ, "catalogo", "productos"),
        refrescar: true,
      }).porId.get("cinturon-termico-colicos");

      for (const frase of [
        "Pruébalo 7 días y si no sientes alivio te devolvemos tu dinero",
        "Tienes garantía de 7 días",
        "Si no te gusta te devolvemos tu dinero",
      ]) {
        const v = responder.revisarClaims(frase, producto);
        assert.equal(v.ok, false, `el filtro deja pasar la promesa de devolución: "${frase}"`);
      }
    });

    test("la garantía del catálogo sigue siendo la que confirmó Marco", () => {
      const producto = cargarCatalogo({
        carpeta: path.join(RAIZ, "catalogo", "productos"),
        refrescar: true,
      }).porId.get("cinturon-termico-colicos");

      assert.equal(producto.garantia, "1 mes");
      assert.equal(producto.garantiaCubre, "defecto de fábrica");
    });
  });

  test("ningún mensaje contiene una de las frases que Marco prohibió", async () => {
    const c = await chat({ nombrePerfil: "Daniela" });
    const dichos = [];
    for (const m of [
      ANUNCIO,
      "En qué ciudad",
      "Cuando me llegaría",
      "Trae cargador",
      "se puede lavar?",
      "hace ruido?",
      "sirve para la espalda?",
      "está muy caro",
      "no me alcanza",
      "Gracias",
      "lo quiero",
      "Daniela Sarmiento",
      "Medellín, Carrera 70 # 45-12",
      "si",
    ]) {
      dichos.push({ m, texto: (await c.dice(m)).texto });
    }

    for (const d of dichos) {
      assert.equal(PROHIBIDAS.test(d.texto), false, `tras "${d.m}": ${d.texto}`);
      assert.ok(d.texto, `se quedó mudo tras "${d.m}"`);
    }
    assert.equal((await c.pedidos()).length, 1, "la conversación completa no cerró");
  });

  test("el primer mensaje termina preguntando, y manda 3 fotos", async () => {
    // De 25 chats, 10 clientes recibieron el primer mensaje y no volvieron a
    // escribir. Terminaba en "Te paso las fotos", que no invita a nada.
    const c = await chat();
    const r = await c.dice(ANUNCIO);

    assert.match(r.texto, /49\.900/, r.texto);
    assert.match(r.texto, /85\.000/, "no ofreció la pareja desde el primer mensaje");
    assert.match(r.texto, /¿Para qué ciudad/i, `no cerró con la pregunta fácil: ${r.texto}`);
    assert.equal(r.fotos, 3, `mandó ${r.fotos} fotos`);
  });

  test("y el bot nunca manda dos veces seguidas el mismo texto", async () => {
    const c = await chat({ nombrePerfil: "Clara" });
    const vistos = [];
    for (const m of [ANUNCIO, "Hola", "Hola?", "ok", "listo", "ahí le aviso", "gracias", "y cuánto vale?"]) {
      const r = await c.dice(m);
      if (r.texto) vistos.push({ m, texto: r.texto.trim() });
    }
    for (let i = 1; i < vistos.length; i += 1) {
      assert.notEqual(
        vistos[i].texto,
        vistos[i - 1].texto,
        `repitió el mismo mensaje tras "${vistos[i - 1].m}" y "${vistos[i].m}": ${vistos[i].texto}`
      );
    }
  });
});
