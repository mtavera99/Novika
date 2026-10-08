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

// --------------------------------------------------------------------------
// 6 · UNA CANTIDAD SIN TARIFA NO SE CONTESTA CON OTRA CANTIDAD
//
// Salio demostrando las cuatro conversaciones, y es el mismo error que el
// de la captura por la otra punta:
//
//   clienta: "y cuánto cuestan tres?"
//   bot:     "Claro que sí, una unidad te queda en $49.900..."
//
// El precio de UNA a una pregunta por TRES. La clienta puede leer que tres
// le salen a 49.900, y eso es cobrar mal o perder la venta al aclararlo.
//
// La tabla cubre 1 y 2 porque es lo que Marco aprobo. No se interpola -el
// tercer escalon seria un descuento inventado- y tampoco se contesta por
// otra cantidad: se dice que lo confirma una persona y queda la tarea.
// --------------------------------------------------------------------------

describe("6 · por una cantidad sin precio aprobado no se improvisa", () => {
  test("no se contesta con el precio de otra cantidad", async () => {
    const c = await conversacion();
    const r = await c.dice("y cuanto cuestan tres?");

    assert.equal(/49\.900/.test(r.texto), false, `dio el precio de UNA por una pregunta de TRES: ${r.texto}`);
    assert.equal(/85\.000/.test(r.texto), false, `dio el precio de DOS por una pregunta de TRES: ${r.texto}`);
    // Ni ninguna cifra inventada por multiplicar.
    assert.equal(/149\.700|127\.500|120\.000/.test(r.texto), false, `inventó el precio: ${r.texto}`);
    // Y lo dice: nombra la cantidad por la que preguntó.
    assert.match(r.texto, /3 unidades/, `no reconoció por cuántas preguntaba: ${r.texto}`);
    assert.match(r.texto, /confirmo|equipo/i, `no ofreció confirmarlo: ${r.texto}`);
  });

  test("queda la tarea, porque es una venta MAYOR que la aprobada", async () => {
    // Quien pide tres se lleva mas que quien pide uno. No se puede cotizar,
    // pero perderla por no anotarla seria tonto.
    const c = await conversacion();
    await c.dice("cuanto cuestan tres?");

    const conv = await c.repos.conversaciones.obtener(CLIENTE);
    const p = atencion.pendienteDe(conv);
    assert.equal(p.hay, true, "no dejó tarea por una venta de 3 unidades");
    assert.match(p.pregunta, /3 unidades/, "la tarea no dice por cuántas preguntaba");
  });

  test("tampoco con un pedido ya confirmado", async () => {
    const c = await conversacion();
    const pedido = await c.conPedidoConfirmado();
    const r = await c.dice("y tres cuanto valen?");

    assert.equal(/49\.900/.test(r.texto), false, `contestó con el precio de su pedido: ${r.texto}`);
    const pedidos = await c.repos.pedidos.porContacto(CLIENTE);
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].id, pedido.id, "cambió el pedido confirmado");
  });

  test("pero por DOS, que sí tiene tarifa, se contesta de una", async () => {
    // La guarda no puede volverse una excusa para no vender lo aprobado.
    const c = await conversacion();
    const r = await c.dice("cuanto cuestan dos?");
    assert.match(r.texto, /85\.000/, `no dio el precio aprobado de dos: ${r.texto}`);
  });
});

// --------------------------------------------------------------------------
// 7 · EL CIERRE NO LO IMPROVISA EL MODELO
//
// Con el modelo activo, "listo, lo quiero" NO estaba cubierto por el
// catalogo -no pregunta nada, asi que no tiene temas- y lo redactaba la IA.
// Es el momento mas importante de la conversacion.
//
// Salio en los tres escenarios de venta a la vez:
//
//   clienta: "listo, lo quiero"
//   bot:     "Perfecto, actualizo tu dirección de entrega."
//
// No habia direccion que actualizar y, peor, no pide nada: la venta se
// queda parada ahi. Que falten datos es un hecho del estado, no una
// opinion, y lo sabe el codigo.
// --------------------------------------------------------------------------

describe("7 · la intención de compra la contesta el código", () => {
  test("«lo quiero» pide los datos que faltan, no lo que diga el modelo", async () => {
    const responder = require("../src/cerebro/responder");
    const { cargarCatalogo: cargar } = require("../src/catalogo");
    const prod = cargar({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
      "cinturon-termico-colicos"
    );
    const cotizador = require("../src/dominio/cotizador");
    const cot = cotizador.cotizar({ producto: prod, cantidad: 1 }).cotizacion;

    // El modelo manda un borrador inofensivo pero inservible.
    const r = responder.preparar({
      situacion: "faltan_datos",
      cotizacion: cot,
      faltan: ["nombre", "ciudad", "direccion"],
      producto: prod,
      borradorIA: "Perfecto, actualizo tu dirección de entrega.",
      mensajeCliente: "listo, lo quiero",
    });

    assert.equal(r.origen, "determinista", `el modelo redactó el cierre: ${r.texto}`);
    assert.match(r.texto, /me pasas/i, `no pidió los datos que faltan: ${r.texto}`);
  });

  test("y una duda NO catalogada sí la redacta el modelo", async () => {
    // El reparto tiene que seguir funcionando en el otro sentido: donde el
    // determinista no tiene nada bueno que decir, el modelo sí.
    const responder = require("../src/cerebro/responder");
    const { cargarCatalogo: cargar } = require("../src/catalogo");
    const prod = cargar({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
      "cinturon-termico-colicos"
    );

    const r = responder.preparar({
      situacion: "faltan_datos",
      cotizacion: null,
      faltan: [],
      producto: prod,
      borradorIA: "Sobre usarlo toda la noche no tengo el dato confirmado, te lo verifico con el equipo.",
      mensajeCliente: "oye y esto me lo puedo poner dormida toda la noche?",
    });

    assert.equal(r.origen, "ia", `se descartó un borrador útil: ${r.texto}`);
  });
});

// --------------------------------------------------------------------------
// 8 · LO QUE EL BOT NO PUEDE PROMETER
//
// Marco lo paro en seco: "no prometas despacho hoy. Necesita horario,
// disponibilidad y capacidad de despacho confirmados". Ninguno de los tres
// esta en el catalogo, asi que el bot estaba comprometiendo una operacion
// que no controla.
//
// Y era la misma clase de promesa que YA estaba en `claimsProhibidos` para
// el modelo -"te lo despacho hoy mismo"- que el codigo se saltaba porque
// los claims solo se revisan sobre el borrador de la IA. El candado
// vigilaba al modelo mientras el determinista decia lo mismo.
// --------------------------------------------------------------------------

describe("8 · ni despacho hoy, ni respuesta inmediata", () => {
  test("ningún texto promete despachar", async () => {
    const c = await conversacion();
    const dichos = [];
    dichos.push((await c.dice("hola")).texto);
    dichos.push((await c.dice("cuanto vale")).texto);
    dichos.push((await c.dice("lo quiero")).texto);
    dichos.push((await c.dice("soy Ana, Cali, Carrera 7 # 12-34")).texto);
    dichos.push((await c.dice("si confirmo")).texto);
    dichos.push((await c.dice("que valen dos")).texto);

    for (const t of dichos) {
      assert.equal(
        /despach/i.test(t),
        false,
        `prometió despacho, que no controlamos: ${t}`
      );
    }
  });

  test("ni respuesta «enseguida» o «en un momento»", async () => {
    // No hay nadie de guardia. Si la clienta escribe un domingo por la
    // noche, "en un momento" es falso — y una promesa de tiempo que no se
    // cumple vale menos que decir "no lo sé".
    const c = await conversacion();
    const dichos = [
      // El material ya esta confirmado, asi que se contesta. Para esta
      // prueba sirve un dato que SIGUE sin confirmar.
      (await c.dice("qué trae exactamente el paquete?")).texto,
      (await c.dice("oye y lo puedo usar dormida?")).texto,
      (await c.dice("cuanto cuestan tres?")).texto,
    ];
    for (const t of dichos) {
      assert.equal(/enseguida|en un momento|ya mismo/i.test(t), false, `prometió inmediatez: ${t}`);
      assert.match(t, /anot|equipo/i, `no dijo que queda para el equipo: ${t}`);
    }
  });

  test("y el catálogo también se lo prohíbe al modelo", () => {
    const { cargarCatalogo: cargar } = require("../src/catalogo");
    const prod = cargar({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
      "cinturon-termico-colicos"
    );
    const responder = require("../src/cerebro/responder");
    // PROMESAS de futuro: prohibidas siempre, sin contexto que las salve.
    for (const frase of ["Para despachártelo hoy me pasas la dirección", "Te confirmo enseguida con el equipo"]) {
      const v = responder.revisarClaims(frase, prod);
      assert.equal(v.ok, false, `el filtro deja pasar la promesa: "${frase}"`);
    }
  });

  // ------------------------------------------------------------------------
  // PERO NO SE PROHIBE LA PALABRA, SE COMPRUEBA EL HECHO
  //
  // Correccion de Marco: "el control de despacho debe impedir promesas sin
  // respaldo, no prohibir la palabra despacho. Si un pedido realmente salio,
  // el bot debe poder decirlo".
  //
  // La primera version metio "tu pedido ya salio" en claimsProhibidos, y eso
  // prohibe la frase TAMBIEN cuando es verdad. Y es la pregunta en la que
  // mas se desconfia de una tienda por WhatsApp: callarla deja al cliente a
  // ciegas justo cuando mas quiere saber.
  //
  // El mismo texto, dos veredictos, segun el ESTADO del pedido.
  // ------------------------------------------------------------------------
  test("si el pedido SALIÓ de verdad, el bot puede decirlo", () => {
    const responder = require("../src/cerebro/responder");
    const despachado = { id: "NOV-A", estado: "despachado", guia: "998877" };

    for (const frase of [
      "Tu pedido NOV-A ya salió por Interrapidísimo, con la guía 998877.",
      "Tu pedido ya salió.",
      "ya te lo despachamos",
    ]) {
      assert.equal(responder.revisarDespacho(frase, despachado).ok, true, `bloqueó un hecho verdadero: "${frase}"`);
    }
  });

  test("y si NO salió, la misma frase se bloquea", () => {
    const responder = require("../src/cerebro/responder");
    const confirmado = { id: "NOV-A", estado: "confirmado" };

    for (const frase of ["Tu pedido ya salió.", "ya te lo despachamos", "ya va en camino"]) {
      const v = responder.revisarDespacho(frase, confirmado);
      assert.equal(v.ok, false, `dejó pasar un despacho sin respaldo: "${frase}"`);
      assert.match(v.motivo, /confirmado/, "el motivo no dice el estado real");
    }
  });

  test("hablar de despacho sin afirmar que salió no se bloquea", () => {
    // El control es sobre el HECHO, no sobre el vocabulario.
    const responder = require("../src/cerebro/responder");
    const confirmado = { id: "NOV-A", estado: "confirmado" };
    for (const frase of [
      "El despacho lo hacemos nosotros.",
      "Te avisamos en cuanto salga.",
      "Para preparar tu pedido me pasas la dirección.",
    ]) {
      assert.equal(responder.revisarDespacho(frase, confirmado).ok, true, `prohibió la palabra: "${frase}"`);
    }
  });

  test("y en posventa se dice la guía cuando existe", async () => {
    // El dato existe y esta respaldado -el dominio no deja marcar
    // despachado sin guia- y el bot lo callaba: decia "te avisamos en
    // cuanto salga" dos dias despues de que saliera.
    const responder = require("../src/cerebro/responder");
    const t = responder.textoDeterminista({
      situacion: "ya_confirmado",
      cotizacion: null,
      faltan: [],
      pedido: { id: "NOV-A", estado: "despachado", guia: "998877", transportadora: "Interrapidísimo" },
      mensajeCliente: "ya salio mi pedido?",
    });
    assert.match(t, /ya salió/i, `no dijo que salió: ${t}`);
    assert.match(t, /998877/, `no dio la guía para rastrear: ${t}`);
  });
});

// --------------------------------------------------------------------------
// 9 · UNA CONSULTA NUEVA NO ARRASTRA EL PEDIDO ANTERIOR
//
//   clienta: "y cuánto cuestan 2 con envío"
//   bot:     "...$85.000. El envío va incluido... Tu pedido NOV-... ya está
//             confirmado y te avisamos en cuanto salga."
//
// La ultima frase no la pidio nadie. Mezcla una consulta NUEVA -que es una
// venta- con el estado de una compra vieja, y entierra lo que si importa.
// --------------------------------------------------------------------------

describe("9 · el número de pedido solo si pregunta por su pedido", () => {
  test("preguntar un precio no trae el pedido anterior", async () => {
    const c = await conversacion();
    const pedido = await c.conPedidoConfirmado();

    for (const frase of ["que valen dos", "y cuanto cuestan 2 con envio"]) {
      const r = await c.dice(frase);
      assert.match(r.texto, /85\.000/, `no contestó el precio: ${r.texto}`);
      assert.equal(
        r.texto.includes(pedido.id),
        false,
        `arrastró el número del pedido anterior sin que lo pidieran: ${r.texto}`
      );
      assert.equal(/ya está confirmado|está confirmado/i.test(r.texto), false, `habló de su pedido viejo: ${r.texto}`);
    }
  });

  test("pero preguntando por SU pedido, sí", async () => {
    // El otro lado del candado: quien pregunta por su compra tiene que
    // recibir su numero y su estado.
    const c = await conversacion();
    const pedido = await c.conPedidoConfirmado();

    const r = await c.dice("ya salio mi pedido?");
    assert.ok(r.texto.includes(pedido.id), `no le dio el número de su pedido: ${r.texto}`);
  });
});

// --------------------------------------------------------------------------
// 10 · UNA RESPUESTA HUMANA CUALQUIERA NO RESUELVE LA TAREA
//
// La primera version cerraba la tarea si un operador escribia CUALQUIER
// mensaje despues. "ya te confirmo", "dame un momento" o "hola" la cerraban
// sin resolverla: la pregunta seguia sin contestar y desaparecia de la
// lista, que es peor que no tener lista.
// --------------------------------------------------------------------------

describe("10 · la tarea se cierra con un acto explícito", () => {
  test("un mensaje cualquiera del operador NO la cierra", () => {
    const conv = { mensajes: [] };
    atencion.anotarPendiente(conv, {
      motivo: atencion.MOTIVOS_PENDIENTE.SIN_DATO,
      pregunta: "de que material es",
      ahora: Date.now() - 60000,
    });
    // El operador escribe, pero no resuelve.
    atencion.anotarMensaje(conv, { de: atencion.QUIEN.OPERADOR, texto: "dame un momento y te confirmo" });

    assert.equal(
      atencion.pendienteDe(conv).hay,
      true,
      "un «dame un momento» cerró una tarea que sigue sin resolver"
    );
  });

  test("y «marcar atendido» sí la cierra", async () => {
    const c = await conversacion();
    await c.dice("oye y lo puedo usar dormida?");
    assert.equal(atencion.pendienteDe(await c.repos.conversaciones.obtener(CLIENTE)).hay, true);

    await atencion.marcarAtendido(c.repos, CLIENTE, { por: "marco" });
    assert.equal(
      atencion.pendienteDe(await c.repos.conversaciones.obtener(CLIENTE)).hay,
      false,
      "marcarla atendida no la cerró"
    );
  });
});
