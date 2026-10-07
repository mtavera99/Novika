"use strict";

// ==========================================================================
// «Muéstrame fotos del cinturón y dime cuánto cuesta y cómo es el envío»
//
// El mensaje que reporto Marco. El bot volvia a preguntar que producto
// queria, en cada mensaje, en bucle.
//
// Eran TRES defectos encadenados, y cada uno bastaba para romperlo:
//
//   1. `senalesEnTexto` solo recorria `catalogo.activos`. Con el unico
//      producto en borrador, NINGUN mensaje podia identificar nada.
//
//   2. Los patrones se comparaban contra el texto CRUDO y estan escritos
//      sin tildes. "cinturon termico" coincidia; "cinturón térmico" NO. Es
//      decir: funcionaba justo con la forma que casi nadie escribe, porque
//      el teclado del movil pone la tilde sola.
//
//   3. Aun identificandolo, el flujo hacia `conversacion.productoId = null`
//      porque el producto no estaba activo, y caia en "producto
//      desconocido". Olvidaba lo que el cliente acababa de decir.
//
// Y un cuarto, de omision: el envio de fotos existia pero no estaba
// conectado al cerebro, asi que el bot nunca las mandaba.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ayuda = require("./ayuda");
const dir = ayuda.entornoDePrueba({
  MODO_SOMBRA: "1",
  RESPUESTA_AUTOMATICA: "1", // local, con fetch espia: no sale nada a la red
  URL_PUBLICA: "https://novika-bot.onrender.com",
  WHATSAPP_TOKEN: "token-falso-de-prueba",
});

const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearEmisor } = require("../src/whatsapp/enviar");
const { cargarCatalogo } = require("../src/catalogo");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearProveedorFalso } = require("../src/ia/proveedores/falso");
const senales = require("../src/catalogo/senales");
const atencion = require("../src/almacen/atencion");
const { cotizar } = require("../src/dominio/cotizador");

const fs = require("node:fs");
const os = require("node:os");

const EL_MENSAJE = "Muéstrame fotos del cinturón y dime cuánto cuesta y cómo es el envío";
const CINTURON = "cinturon-termico-colicos";
const CLIENTE = "573058742138";

const nada = { info() {}, warn() {}, error() {} };
const sinContar = { incrementar() {} };

/** Cerebro completo con un `fetch` espia: nada sale a la red. */
async function montar() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "novika-ident-"));
  const repos = await crearReposDeArchivos({ dir: path.join(d, "t") });
  const catalogo = cargarCatalogo({ refrescar: true });

  const salidas = [];
  const fetchImpl = async (_u, o) => {
    salidas.push(JSON.parse(o.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: `wamid.S${salidas.length}` }] }),
      text: async () => "",
    };
  };

  const ia = crearCliente({ proveedor: crearProveedorFalso(), timeoutMs: 5000, log: nada, metricas: sinContar });
  const emisor = crearEmisor({ config, fetchImpl, repos, atencion });
  const cerebro = crearCerebro({
    config, repos, catalogo, ia, emisor, log: nada, metricas: sinContar, diario: { anotar() {} },
  });

  let n = 0;
  const escribe = (texto) =>
    cerebro.procesar({
      clase: "mensaje",
      idCliente: CLIENTE,
      telefono: CLIENTE,
      idNumero: config.idNumero,
      wamid: `wamid.${++n}`,
      texto,
    });

  return { repos, catalogo, salidas, escribe, cerrar: () => repos.cerrar() };
}

// ==========================================================================
// 1 · IDENTIFICACION
// ==========================================================================

describe("1 · identificar el producto", () => {
  const catalogo = cargarCatalogo({ refrescar: true });

  test("ESCENARIO: el mensaje reportado identifica el cinturon", () => {
    const r = senales.resolver({ texto: EL_MENSAJE, catalogo });
    assert.equal(r.productoId, CINTURON, "el mensaje de Marco no identifica el producto");
    // `ambiguo` solo se pone a true en la rama ambigua, asi que aqui es
    // undefined. Se comprueba que NO sea verdadero, no que sea false.
    assert.ok(!r.ambiguo, "no deberia ser ambiguo: solo hay un producto");
  });

  test("CON TILDES tambien, que es como escribe la gente", () => {
    // El teclado del movil pone la tilde sola. El alias funcionaba justo
    // con la forma que casi nadie escribe.
    for (const t of [
      "cinturón térmico",
      "cinturon termico",
      "CINTURÓN TÉRMICO",
      "una faja térmica",
      "cinturón térmico para cólicos",
      "cólicos menstruales",
    ]) {
      assert.equal(senales.resolver({ texto: t, catalogo }).productoId, CINTURON, `no identifico "${t}"`);
    }
  });

  test("y «del cinturón» a secas, que es como lo pidio Marco", () => {
    for (const t of ["del cinturón", "fotos del cinturon", "ese cinturón", "los cinturones"]) {
      assert.equal(senales.resolver({ texto: t, catalogo }).productoId, CINTURON, `no identifico "${t}"`);
    }
  });

  test("un producto EN BORRADOR se identifica: reconocer no es vender", () => {
    const p = catalogo.porId.get(CINTURON);
    assert.equal(p.activo, false, "el cinturon deberia seguir en borrador");
    assert.equal(senales.resolver({ texto: EL_MENSAJE, catalogo }).productoId, CINTURON);
  });

  test("pero NO se puede cotizar, y eso no cambio", () => {
    // El candado de verdad esta aqui, no en la identificacion.
    const p = catalogo.porId.get(CINTURON);
    const r = cotizar({ producto: p, cantidad: 1, destino: { ciudad: "Medellín", departamento: "Antioquia" } });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /no esta activo/);
  });

  test("lo que NO menciona el producto sigue sin identificarse", () => {
    // El arreglo no puede volverse un "todo es el cinturon".
    for (const t of ["hola", "quiero una lámpara", "cuanto cuesta el envío", "gracias"]) {
      assert.equal(senales.resolver({ texto: t, catalogo }).productoId, null, `identifico de mas: "${t}"`);
    }
  });
});

// ==========================================================================
// 2 · NO VUELVE A PREGUNTAR
// ==========================================================================

describe("2 · el bot explica en vez de repetir la pregunta", () => {
  test("ESCENARIO: responde al mensaje reportado sin preguntar que producto es", async () => {
    const m = await montar();
    try {
      const t = await m.escribe(EL_MENSAJE);

      assert.equal(t.producto.productoId, CINTURON);
      assert.equal(t.respuesta.situacion, "producto_en_borrador");
      assert.notEqual(t.respuesta.situacion, "producto_desconocido");

      const texto = t.respuesta.texto;
      assert.ok(
        !/cuál producto|que producto|cual producto/i.test(texto),
        `vuelve a preguntar: "${texto}"`
      );
      assert.match(texto, /precio/i, "tiene que explicar lo del precio");
    } finally {
      await m.cerrar();
    }
  });

  test("NO inventa ningun importe ni plazo", async () => {
    const m = await montar();
    try {
      const t = await m.escribe(EL_MENSAJE);
      const texto = t.respuesta.texto;
      assert.ok(!/\$/.test(texto), `menciona un importe: "${texto}"`);
      assert.ok(!/\d{4,}/.test(texto), `menciona una cifra grande: "${texto}"`);
      assert.ok(!/\b\d+\s*(dias?|horas?)\b/i.test(texto), `promete un plazo: "${texto}"`);
      // Y el texto es NUESTRO, no del modelo: con un precio en juego el
      // modelo no redacta.
      assert.equal(t.respuesta.origen, "determinista");
    } finally {
      await m.cerrar();
    }
  });

  test("la identificacion SE CONSERVA entre mensajes", async () => {
    // El bucle venia de aqui: olvidaba el producto en cada turno.
    const m = await montar();
    try {
      await m.escribe(EL_MENSAJE);
      const segundo = await m.escribe("y cuanto vale?");

      assert.equal(segundo.producto.productoId, CINTURON, "olvido el producto");
      assert.equal(segundo.respuesta.situacion, "producto_en_borrador");
      assert.ok(!/cuál producto|cual producto/i.test(segundo.respuesta.texto));

      const conv = await m.repos.conversaciones.obtener(CLIENTE);
      assert.equal(conv.productoId, CINTURON, "la conversacion perdio el producto");
    } finally {
      await m.cerrar();
    }
  });

  test("y no se crea ningun pedido", async () => {
    const m = await montar();
    try {
      await m.escribe(EL_MENSAJE);
      await m.escribe("si, lo quiero");
      const pedidos = await m.repos.pedidos.listar({ limite: 10 });
      assert.equal(pedidos.length, 0, "no puede haber pedido sin precio");
    } finally {
      await m.cerrar();
    }
  });
});

// ==========================================================================
// 3 · LAS FOTOS SE MANDAN
// ==========================================================================

describe("3 · el envio de fotos esta conectado", () => {
  test("ESCENARIO: manda el texto y DESPUES las cinco fotos, en orden", async () => {
    const m = await montar();
    try {
      const t = await m.escribe(EL_MENSAJE);

      assert.equal(t.fotos.enviadas, 5, `fotos: ${JSON.stringify(t.fotos)}`);
      assert.equal(m.salidas.length, 6, "un texto + cinco fotos");

      assert.equal(m.salidas[0].type, "text", "el texto va primero: las fotos sin contexto no dicen nada");
      const fotos = m.salidas.slice(1);
      assert.deepEqual(
        fotos.map((c) => c.image.link.split("/").pop()),
        ["01-frente.jpg", "02-puesto.jpg", "03-detalle.jpg", "04-correa.jpg", "05-empaque.jpg"]
      );
      for (const f of fotos) assert.match(f.image.link, /^https:\/\//);
    } finally {
      await m.cerrar();
    }
  });

  test("el texto ANUNCIA las fotos que de verdad manda", async () => {
    // Un bot que dice "te muestro las fotos" y no manda ninguna deja al
    // cliente esperando algo que no llega.
    const m = await montar();
    try {
      const t = await m.escribe(EL_MENSAJE);
      assert.match(t.respuesta.texto, /fotos/i);
      assert.ok(t.fotos.enviadas > 0, "las anuncia y no las manda");
    } finally {
      await m.cerrar();
    }
  });

  test("y NO las repite en el mensaje siguiente", async () => {
    const m = await montar();
    try {
      await m.escribe(EL_MENSAJE);
      m.salidas.length = 0;
      const segundo = await m.escribe("y cuanto vale?");

      assert.equal(segundo.fotos.repetido, true);
      assert.equal(segundo.fotos.enviadas, 0);
      assert.equal(
        m.salidas.filter((c) => c.type === "image").length,
        0,
        "diez fotos iguales es por lo que alguien bloquea un numero"
      );
    } finally {
      await m.cerrar();
    }
  });

  test("quedan en el historial del chat, con su resultado", async () => {
    const m = await montar();
    try {
      await m.escribe(EL_MENSAJE);
      const conv = await m.repos.conversaciones.obtener(CLIENTE);
      const deFoto = atencion.mensajes(conv).filter((x) => x.texto.startsWith("[foto]"));
      assert.equal(deFoto.length, 5);
      for (const x of deFoto) assert.equal(x.estado, "enviado");
    } finally {
      await m.cerrar();
    }
  });
});

// ==========================================================================
// 4 · LOS CANDADOS SIGUEN PUESTOS
// ==========================================================================

describe("4 · nada de esto abrio una puerta", () => {
  test("el producto sigue en borrador y con sus pendientes", () => {
    const p = require("../catalogo/productos/cinturon-termico-colicos.json");
    assert.equal(p.activo, false);
    assert.equal(p.nombre, "");
    assert.ok(p.pendientes.length > 0);

    // ANTES ESTA PRUEBA EXIGIA `precios` VACIO, y ya no corresponde.
    //
    // Lo exigia porque cuando se escribio no habia ni un dato comercial, asi
    // que "sin precios" equivalia a "sin ficha". Marco confirmo el precio de
    // 1 unidad el 2026-10-07, y mantener la asercion obligaria a borrar un
    // dato real para que la prueba pasara.
    //
    // Lo que de verdad protege este bloque no es que falten precios: es que
    // tener precio NO active el producto por si solo. Un producto con precio
    // y sin ficha sigue siendo un producto que no se puede vender, y eso es
    // lo que se comprueba ahora.
    assert.equal(p.precios["1"], 49900, "el precio confirmado por Marco desaparecio del catalogo");
    assert.equal(
      require("../src/catalogo").cargarCatalogo({
        carpeta: require("node:path").join(__dirname, "..", "catalogo", "productos"),
        refrescar: true,
      }).activos.length,
      0,
      "tener precio no puede meter el producto en la lista de los vendibles"
    );
  });

  test("con RESPUESTA_AUTOMATICA apagada no sale nada, ni texto ni fotos", async () => {
    const guardado = config.respuestaAutomatica;
    try {
      config.respuestaAutomatica = false;
      const m = await montar();
      try {
        const t = await m.escribe(EL_MENSAJE);
        assert.equal(m.salidas.length, 0, "no puede salir nada con el interruptor apagado");
        assert.equal(t.enviada, false);
        // Y la respuesta SI se prepara: es lo que se audita en modo sombra.
        assert.ok(t.respuesta.texto.length > 0);
      } finally {
        await m.cerrar();
      }
    } finally {
      config.respuestaAutomatica = guardado;
    }
  });

  test("si el operador tiene el control, el bot no manda ni texto ni fotos", async () => {
    const m = await montar();
    try {
      // Primer turno para que exista la conversacion.
      await m.escribe("hola");
      await atencion.tomarControl(m.repos, CLIENTE, { por: "panel" });
      m.salidas.length = 0;

      await m.escribe(EL_MENSAJE);
      assert.equal(m.salidas.length, 0, "el bot hablo con el chat tomado");
    } finally {
      await m.cerrar();
    }
  });
});

module.exports = {};
