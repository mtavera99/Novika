"use strict";

// ==========================================================================
// PREGUNTAR POR DOS NO ES NI COMPRAR DOS NI TENER UN PEDIDO
//
// DE DONDE SALE: una captura de Marco, en produccion, con un pedido ya
// confirmado. Cuatro mensajes seguidos de la misma clienta:
//
//   clienta: "Qué precio tiene el envío"
//   bot:     contesta el envio + el precio del producto que no pidio +
//            el numero de pedido + una oferta vaga de atencion humana
//   clienta: "Que valen dos?"
//   bot:     "Tu pedido NOV-... ya está confirmado"
//   clienta: "Que valen dos unidades?"
//   bot:     "Perdón, no quiero repetirme. Dime concretamente qué necesitas"
//   clienta: "Quiero saber cuánto valen dos unidades"
//   bot:     "Tu pedido NOV-... ya está confirmado"
//
// TRES INTENTOS DE COMPRAR MAS, LOS TRES PERDIDOS. Y ninguno por falta de
// dato: el precio de dos esta en el catalogo desde que Marco lo confirmo.
//
// LAS CUATRO CAUSAS, que son independientes y estaban encadenadas:
//
//   1. El detector de precio solo conocia el SINGULAR -"cuanto vale"- y no
//      "valen", "cuestan" ni "a como". Quien pregunta por dos escribe en
//      plural, que era justo el hueco. Sin tema reconocido, la posventa no
//      tiene nada que responder y cae al estado del pedido.
//   2. La cantidad PREGUNTADA no existia como dato, asi que el precio se
//      contestaba por la cantidad del PEDIDO.
//   3. La guarda anti-repeticion sustituia una pregunta clarisima por
//      "dime qué necesitas", que es peor que repetirse.
//   4. "precio" en "¿que precio tiene el envio?" marcaba el tema PRECIO y
//      el bot soltaba una cifra que nadie habia pedido.
//
// LO QUE ESTA BATERIA DEFIENDE A LA VEZ: que se conteste, que se conteste
// POR LA CANTIDAD PREGUNTADA, y que preguntar NO toque el pedido ni la
// ficha. Esa ultima es la que impide que arreglar la venta abra un agujero.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba({
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
const campos = require("../src/dominio/campos");
const atencion = require("../src/almacen/atencion");

const RAIZ = path.join(__dirname, "..");
const CLIENTE = "573009998877";

let SECUENCIA = 0;
const wamidUnico = () => `wamid.D2_${++SECUENCIA}_${process.pid}`;

async function conversacion() {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-dos-")) });
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
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.X${salidas.length}` }] }) };
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
      wamid: wamidUnico(),
      idCliente: CLIENTE,
      telefono: CLIENTE,
      nombre: null,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });
    return {
      traza,
      texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join("\n"),
    };
  };

  const conPedidoConfirmado = async () => {
    await dice("quiero un cinturon");
    await dice("soy Luz Marina, Palmira, Calle 20 # 15-30");
    const r = await dice("si confirmo");
    assert.equal(r.traza.respuesta.situacion, "confirmado", "la venta tiene que cerrarse primero");
    return r.traza.pedido;
  };

  return { dice, repos, conPedidoConfirmado };
}

// --------------------------------------------------------------------------
// 1 · EL DETECTOR
// --------------------------------------------------------------------------

describe("1 · reconocer la pregunta tal como la escribe la gente", () => {
  test("el plural también es una pregunta de precio", () => {
    // Ninguna de estas se reconocia, y son las que escribe quien pregunta
    // por mas de una unidad.
    for (const frase of [
      "Que valen dos?",
      "Que valen dos unidades?",
      "Quiero saber cuánto valen dos unidades",
      "cuánto cuestan dos",
      "cuanto cuestan 2",
      "que valen 2",
      "cuanto me salen dos",
      "a como el cinturon",
    ]) {
      const r = preguntas.leer(frase);
      assert.ok(
        r.temas.includes(preguntas.TEMAS.PRECIO),
        `no reconoció como pregunta de precio: ${frase}`
      );
    }
  });

  test("con tildes o sin ellas, con signos o sin ellos, da igual", () => {
    // El teclado del movil pone las tildes solo a veces, y mucha gente no
    // escribe el signo de interrogacion.
    for (const par of [
      ["cuánto cuestan dos", "cuanto cuestan dos"],
      ["¿Qué valen dos?", "que valen dos"],
      ["Cuánto Valen 2", "cuanto valen 2"],
    ]) {
      const a = preguntas.leer(par[0]);
      const b = preguntas.leer(par[1]);
      assert.deepEqual(a.temas, b.temas, `cambia con la tilde o el signo: ${par[0]}`);
      assert.equal(a.cantidadPreguntada, b.cantidadPreguntada);
    }
  });

  test("dice POR CUÁNTAS pregunta, en cifra o en palabra", () => {
    assert.equal(preguntas.leer("que valen dos").cantidadPreguntada, 2);
    assert.equal(preguntas.leer("cuanto cuestan 2").cantidadPreguntada, 2);
    assert.equal(preguntas.leer("cuánto sale el par").cantidadPreguntada, 2);
    assert.equal(preguntas.leer("precio de tres").cantidadPreguntada, 3);
    // Sin decir cuántas, no se adivina.
    assert.equal(preguntas.leer("cuanto vale").cantidadPreguntada, null);
  });

  test("una dirección no es una cantidad, ni dentro de una pregunta de precio", () => {
    // El error que ya se cometio una vez leyendo "calle 45" como 45
    // unidades. Aqui volveria a entrar por la puerta de al lado.
    assert.equal(preguntas.leer("cuanto vale a Calle 20 # 15-30").cantidadPreguntada, null);
    assert.equal(preguntas.leer("cuanto vale el envio a la carrera 12").cantidadPreguntada, null);
  });

  test("preguntar el precio NO es intención de compra", () => {
    // "vale" en Colombia es "de acuerdo", y por eso era una señal debil de
    // compra... incluido en "¿cuánto VALE?". El bot le pedia los datos de
    // entrega a quien solo estaba averiguando.
    assert.equal(preguntas.leer("cuanto vale").compra, false);
    assert.equal(preguntas.leer("cuanto vale el envio").compra, false);
    assert.equal(preguntas.leer("a como vale").compra, false);
    // Pero "vale" sola sigue siendo aceptar.
    assert.equal(preguntas.leer("vale").compra, true);
    assert.equal(preguntas.leer("listo, vale").compra, true);
  });

  test('"quiero 2 unidades" en cifra también es compra', () => {
    // Solo se cubrian los numeros escritos con letras.
    assert.equal(preguntas.leer("quiero 2 unidades").compra, true);
    assert.equal(preguntas.leer("quiero 2").compra, true);
    assert.equal(preguntas.leer("quiero dos").compra, true);
  });

  test('"¿qué precio tiene el envío?" pregunta por el ENVÍO', () => {
    // La palabra "precio" marcaba el tema PRECIO y el bot contestaba
    // ademas el precio del producto, que nadie habia pedido.
    const r = preguntas.leer("Qué precio tiene el envío");
    assert.ok(r.temas.includes(preguntas.TEMAS.ENVIO), "no reconoció que pregunta por el envío");
    assert.equal(r.temas.includes(preguntas.TEMAS.PRECIO), false, "contestaría además el precio del producto");

    // Pero "con envío" es lo contrario: pregunta el total.
    const t = preguntas.leer("cuánto vale con envío");
    assert.ok(t.temas.includes(preguntas.TEMAS.PRECIO), "«con envío» pregunta el total y debe dar precio");
  });

  test('"otro" es una intención distinta de "cuánto vale"', () => {
    assert.equal(preguntas.leer("cuanto vale otro?").quiereOtro, true);
    assert.equal(preguntas.leer("quiero uno mas").quiereOtro, true);
    // Preguntar por dos NO es pedir otro: es una consulta de precio.
    assert.equal(preguntas.leer("que valen dos?").quiereOtro, false);
  });
});

// --------------------------------------------------------------------------
// 2 · LA CONVERSACION DE LA CAPTURA, ENTERA
// --------------------------------------------------------------------------

describe("2 · la captura completa, con un pedido ya confirmado", () => {
  test("las cuatro preguntas se responden, y por la cantidad correcta", async () => {
    const c = await conversacion();
    const pedido = await c.conPedidoConfirmado();

    // 1. El envio: se contesta el envio y NADA mas.
    const envio = await c.dice("Qué precio tiene el envío");
    assert.match(envio.texto, /incluido/i, `no contestó el envío: ${envio.texto}`);
    assert.equal(
      /49\.900/.test(envio.texto),
      false,
      `soltó el precio del producto, que no preguntó: ${envio.texto}`
    );

    // 2, 3 y 4: las tres variantes de "¿que valen dos?" dan el precio de DOS.
    for (const frase of ["Que valen dos?", "Que valen dos unidades?", "Quiero saber cuánto valen dos unidades"]) {
      const r = await c.dice(frase);
      assert.match(r.texto, /85\.000/, `no dio el precio de dos para "${frase}": ${r.texto}`);
      assert.equal(
        /49\.900/.test(r.texto),
        false,
        `contestó el precio de UNA a una pregunta por DOS: ${r.texto}`
      );
      // Y nunca el eco del pedido ni el "dime qué necesitas".
      assert.equal(/ya está confirmado/.test(r.texto), false, `eco del pedido: ${r.texto}`);
      assert.equal(/no quiero repetirme/.test(r.texto), false, `se rindió ante una pregunta clara: ${r.texto}`);
    }

    // Y lo que NO puede haber pasado por responder bien: ni un pedido mas.
    const pedidos = await c.repos.pedidos.porContacto(CLIENTE);
    assert.equal(pedidos.length, 1, "preguntar por dos creó o cambió un pedido");
    assert.equal(pedidos[0].id, pedido.id, "cambió el pedido que ya estaba confirmado");
  });

  test("preguntar por dos NO fija la cantidad en la ficha", async () => {
    // Si preguntar confirmara la cantidad, quien pregunta por dos y luego
    // quiere una se quedaria con dos fijadas — y se le cobraria de mas.
    const c = await conversacion();
    await c.dice("cuanto vale");
    await c.dice("que valen dos?");

    const conv = await c.repos.conversaciones.obtener(CLIENTE);
    const cantidad = campos.valorConfirmado(conv.ficha && conv.ficha.cantidad);
    assert.notEqual(cantidad, 2, "preguntar por dos fijó la cantidad en 2");
  });

  test("la cifra de dos sale del cotizador, no de multiplicar", async () => {
    // 2 x 49.900 = 99.800, y el combo vale 85.000. Si alguna vez saliera
    // 99.800, el precio lo estaria calculando el bot en vez del catalogo.
    const c = await conversacion();
    const r = await c.dice("cuanto cuestan dos");
    assert.match(r.texto, /85\.000/, `no usó el precio del catálogo: ${r.texto}`);
    assert.equal(/99\.800/.test(r.texto), false, "multiplicó el precio de una en vez de usar la tabla");
  });

  test("por TRES, que no tiene precio aprobado, no se inventa nada", async () => {
    // La tabla cubre 1 y 2. Extrapolar el tercer escalon es inventar un
    // descuento que nadie autorizo.
    const c = await conversacion();
    const r = await c.dice("cuanto cuestan tres");
    assert.equal(/127\.500|149\.700|120\.000/.test(r.texto), false, `inventó el precio de tres: ${r.texto}`);
  });
});

// --------------------------------------------------------------------------
// 3 · LO QUE SE PROMETE, QUEDA ANOTADO
// --------------------------------------------------------------------------

describe("3 · la atención humana prometida existe de verdad", () => {
  test("si dice que una persona lo arma, queda la tarea con la pregunta", async () => {
    // "Le digo a una persona del equipo" no generaba nada: ni lista, ni
    // aviso, ni rastro. Era una promesa vacia.
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const r = await c.dice("cuanto vale otro?");
    assert.match(r.texto, /persona|equipo/i, `no ofreció ayuda humana: ${r.texto}`);

    const conv = await c.repos.conversaciones.obtener(CLIENTE);
    const p = atencion.pendienteDe(conv);
    assert.equal(p.hay, true, "prometió una persona y no dejó ninguna tarea");
    assert.equal(p.motivo, atencion.MOTIVOS_PENDIENTE.OTRA_COMPRA);
    assert.match(p.pregunta, /otro/i, "la tarea no guarda lo que preguntó");
  });

  test("preguntar un precio NO deja tarea ni ofrece una persona", async () => {
    // Era un estribillo: la frase salia en los tres mensajes seguidos.
    const c = await conversacion();
    await c.conPedidoConfirmado();

    const r = await c.dice("que valen dos?");
    assert.equal(/persona|equipo/i.test(r.texto), false, `ofreció una persona sin hacer falta: ${r.texto}`);

    const conv = await c.repos.conversaciones.obtener(CLIENTE);
    assert.equal(atencion.pendienteDe(conv).hay, false, "dejó una tarea por una simple consulta de precio");
  });

  test("la tarea se resuelve sola cuando una persona atiende", async () => {
    // Misma idea que "atendido": no se guarda un si/no que alguien tenga
    // que acordarse de borrar.
    const c = await conversacion();
    await c.conPedidoConfirmado();
    await c.dice("cuanto vale otro?");

    await atencion.marcarAtendido(c.repos, CLIENTE, { por: "marco" });
    const conv = await c.repos.conversaciones.obtener(CLIENTE);
    assert.equal(atencion.pendienteDe(conv).hay, false, "la tarea sigue abierta después de atenderla");
  });

  test("no se pisa la primera pregunta pendiente con la última", () => {
    // La que lleva mas tiempo esperando es la que importa.
    const conv = { mensajes: [] };
    atencion.anotarPendiente(conv, { motivo: atencion.MOTIVOS_PENDIENTE.SIN_DATO, pregunta: "de que material es" });
    atencion.anotarPendiente(conv, { motivo: atencion.MOTIVOS_PENDIENTE.OTRA_COMPRA, pregunta: "quiero otro" });
    assert.match(atencion.pendienteDe(conv).pregunta, /material/, "la segunda pisó a la primera");
  });
});

// --------------------------------------------------------------------------
// 4 · CORREGIR UN DATO YA CONFIRMADO
//
// EL DEFECTO MAS CARO DE TODOS LOS ENCONTRADOS, porque no se veia:
//
//   clienta: "soy Ana, Cali, Carrera 7 # 12-34"
//   bot:     (cuadro de confirmacion)
//   clienta: "espera, la dirección es Carrera 9 # 45-67"
//   bot:     "Perdón, no quiero repetirme. Dime concretamente qué necesitas"
//   clienta: "sí"
//   bot:     pedido creado... A LA CARRERA 7
//
// El paquete salia a la direccion vieja: el producto, el flete y la clienta,
// los tres perdidos, y nadie se enteraba hasta la devolucion.
//
// La causa era un candado bien pensado al que le faltaba la puerta:
// `campos.proponer` no pisa un dato confirmado -correcto, para que el
// MODELO no invente- y `reabrir()`, que es la via legitima, solo se llamaba
// desde el panel. Desde la conversacion no habia forma de corregir nada.
// --------------------------------------------------------------------------

describe("4 · el cliente puede corregir sus propios datos", () => {
  test("la dirección corregida es la que llega al pedido", async () => {
    const c = await conversacion();
    await c.dice("quiero uno");
    await c.dice("soy Ana, Cali, Carrera 7 # 12-34");
    await c.dice("espera, la direccion es Carrera 9 # 45-67");
    await c.dice("si confirmo");

    const pedidos = await c.repos.pedidos.porContacto(CLIENTE);
    assert.equal(pedidos.length, 1, "la corrección creó un pedido de más");
    assert.equal(
      pedidos[0].destinatario.direccion,
      "Carrera 9 # 45-67",
      `el paquete sale a la dirección vieja: ${pedidos[0].destinatario.direccion}`
    );
  });

  test("y el cuadro de confirmación muestra el cambio", async () => {
    // Sin esto la clienta no puede comprobar que se le hizo caso, y encima
    // el texto salia identico: la guarda anti-eco lo leia como un bucle.
    const c = await conversacion();
    await c.dice("quiero uno");
    await c.dice("soy Ana, Cali, Carrera 7 # 12-34");
    const r = await c.dice("espera, la direccion es Carrera 9 # 45-67");

    assert.match(r.texto, /Carrera 9 # 45-67/, `no muestra la dirección nueva: ${r.texto}`);
    assert.equal(/Carrera 7 # 12-34/.test(r.texto), false, "sigue mostrando la vieja");
    assert.equal(/no quiero repetirme/.test(r.texto), false, "se rindió ante una corrección clara");
  });

  test("el cuadro de confirmación dice A DÓNDE va el paquete", async () => {
    // Confirmaba un envio sin mostrar el destino. Una direccion mal
    // entendida se despachaba sin que la clienta tuviera como verlo.
    const c = await conversacion();
    await c.dice("quiero uno");
    const r = await c.dice("soy Ana, Cali, Carrera 7 # 12-34");
    assert.match(r.texto, /Ana/, "no muestra a nombre de quién va");
    assert.match(r.texto, /Cali/, "no muestra la ciudad");
    assert.match(r.texto, /Carrera 7 # 12-34/, "no muestra la dirección");
  });

  test("pero la IA sigue sin poder pisar un dato confirmado", async () => {
    // El candado que se abrio es SOLO para el cliente. Si se abriera para
    // el modelo, una alucinacion cambiaria una direccion ya validada.
    const campos2 = require("../src/dominio/campos");
    let campo = campos2.proponer(campos2.campoVacio ? campos2.campoVacio() : undefined, "Calle 1 # 2-3", campos2.ORIGENES.CLIENTE);
    campo = campos2.confirmar(campo, (v) => ({ ok: true, valor: v }));
    assert.equal(campo.estado, "confirmado");

    const tocado = campos2.proponer(campo, "Calle 99 # 99-99", campos2.ORIGENES.IA);
    assert.equal(tocado.valor, "Calle 1 # 2-3", "la IA pisó un dato confirmado");
  });
});

// --------------------------------------------------------------------------
// 5 · CUANDO NO SE SABE, SE DICE — Y NO SE PIDE LA DIRECCION
// --------------------------------------------------------------------------

describe("5 · la respuesta de respaldo es útil, no un formulario", () => {
  test("una duda no catalogada no se contesta pidiendo datos", async () => {
    // La peor respuesta que daba el bot:
    //   "oye y esto me lo puedo poner dormida toda la noche?"
    //   -> "¿Cuántos quieres? Y para despachártelo me pasas la dirección"
    // Le pide la direccion a quien pregunta por la seguridad del producto.
    const c = await conversacion();
    await c.dice("cuanto vale");
    const r = await c.dice("oye y esto me lo puedo poner dormida toda la noche?");

    assert.equal(/me pasas/.test(r.texto), false, `contestó con un formulario: ${r.texto}`);
    assert.equal(/Cuántos quieres/.test(r.texto), false, `contestó con un formulario: ${r.texto}`);
    assert.match(r.texto, /persona|equipo/i, `no ofreció resolverla de verdad: ${r.texto}`);
  });

  test("y queda registrada para que alguien la conteste", async () => {
    const c = await conversacion();
    await c.dice("cuanto vale");
    await c.dice("oye y esto me lo puedo poner dormida toda la noche?");

    const conv = await c.repos.conversaciones.obtener(CLIENTE);
    const p = atencion.pendienteDe(conv);
    assert.equal(p.hay, true, "prometió una persona y no dejó tarea");
    assert.match(p.pregunta, /dormida/, "la tarea no guarda la pregunta");
  });

  test("si el modelo revienta, el turno no se pierde", async () => {
    // Un proveedor que lanza mataba el turno entero: la excepcion subia al
    // webhook y el cliente no recibia NADA. El camino determinista funciona
    // sin modelo, asi que lo correcto es degradar, no morir.
    mutex._reiniciar();
    const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-roto-")) });
    const cfg = { ...config, respuestaAutomatica: true, whatsappToken: "t", idNumero: "000", urlPublica: "https://x.invalido" };
    const salidas = [];
    const emisor = crearEmisor({
      config: cfg,
      repos,
      fetchImpl: async (u, o) => {
        salidas.push(JSON.parse(o.body));
        return { ok: true, status: 200, json: async () => ({ messages: [{ id: "w1" }] }) };
      },
    });
    const cerebro = crearCerebro({
      config: cfg,
      repos,
      catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
      ia: {
        disponible: true,
        async analizar() {
          throw new Error("502 del proveedor");
        },
      },
      emisor,
    });

    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: wamidUnico(),
      idCliente: CLIENTE,
      telefono: CLIENTE,
      nombre: null,
      tipo: "text",
      texto: "cuanto vale",
      origenTexto: "escrito",
      referral: null,
    });

    const texto = salidas.filter((s) => s.type === "text").map((s) => s.text.body).join("\n");
    assert.match(texto, /49\.900/, `no respondió con el camino determinista: ${texto}`);
    assert.ok(
      traza.avisos.some((a) => /excepcion/.test(a)),
      "no dejó constancia de que el modelo falló"
    );
  });
});
