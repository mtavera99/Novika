"use strict";

// ==========================================================================
// LA DIRECCION QUE HUBO QUE CONSEGUIR POR TELEFONO (09-oct)
//
// Marco, despues de despachar el pedido de Ipiales a mano:
//
//   «yo pude recuperar esa venta porque llamé al número de celular y pedí la
//    dirección, pero se supone que el Bot siempre debe pedir la dirección...
//    hay una regla básica para despachar un pedido y es que nos den
//    dirección, que puede ser la nomenclatura tradicional de alguna ciudad o
//    puede ser una oficina de Interrapidísimo, pero sin eso no podemos dejar
//    que el Bot lo tome como pedido porque si no no se va a generar [la
//    guía]. Al igual que el número de celular. Al igual que el nombre: no es
//    necesario el nombre completo, pero sí un nombre por lo menos.»
//
// Lo que paso de verdad, medido sobre el pedido real: el bot acepto "barrio
// centenario" como direccion final, cerro el pedido como `confirmado` y con
// `revisiones: []`. O sea un pedido despachable con una direccion a la que
// nadie puede llegar.
//
// ⚠️ Y AQUI CHOCABAN DOS INSTRUCCIONES SUYAS. Su caso 2 de los 20 originales
//    dice que «Barrio buenos aires» SE ACEPTA y no se vuelve a pedir, porque
//    rechazarla costo una venta el 08-oct. La solucion no es elegir una: el
//    candado va en el DESPACHO -«regla básica para despachar»- y no en
//    aceptar el pedido. Se acepta, se pide la referencia dentro del resumen,
//    y si no la da el pedido queda MARCADO y no se puede despachar.
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
const dominioPedido = require("../src/dominio/pedido");
const responder = require("../src/cerebro/responder");
const cotizador = require("../src/dominio/cotizador");

const RAIZ = path.join(__dirname, "..");
const ANUNCIO = "Hola, quiero información sobre el cinturón térmico de $49.900.";

let SEQ = 0;

function elCinturon() {
  const cat = cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true });
  return [...cat.porId.values()].find((p) => /cinturon/i.test(p.id));
}

async function chat() {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-dir-")) });
  const cfg = { ...config, respuestaAutomatica: true, whatsappToken: "t", idNumero: "000" };
  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    atencion,
    fetchImpl: async (_u, o) => {
      salidas.push(JSON.parse(o.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `w${salidas.length}` }] }) };
    },
  });
  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });
  const tel = "573001112233";
  const dice = async (texto) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `w${++SEQ}_${process.pid}_${Date.now()}`,
      idCliente: tel,
      telefono: tel,
      nombre: "Cliente",
      tipo: "text",
      texto,
      origenTexto: "escrito",
    });
    return { traza, texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join(" ") };
  };
  const pedidos = async () => {
    const l = await repos.pedidos.listar({ limite: 10 });
    return Array.isArray(l) ? l : l.filas || [];
  };
  return { dice, pedidos };
}

/** Lleva la conversación hasta tener nombre y ciudad, sin dirección. */
async function hastaLaDireccion(c) {
  await c.dice(ANUNCIO);
  await c.dice("lo quiero");
  await c.dice("Ipiales");
  await c.dice("Duber");
}

// ==========================================================================
describe("1 · sin dirección utilizable NO se despacha", () => {
  test("solo el barrio: el pedido se crea pero queda SIN PODER DESPACHARSE", async () => {
    // Es el pedido de Ipiales, reproducido. Antes: estado `confirmado` y
    // `revisiones: []` — despachable con una dirección imposible.
    const c = await chat();
    await hastaLaDireccion(c);
    await c.dice("barrio centenario");
    await c.dice("si confirmo");

    const [p] = await c.pedidos();
    assert.ok(p, "no se creó el pedido: eso perdería la venta y el teléfono");
    assert.equal(p.destinatario.direccion, "barrio centenario");

    const listo = dominioPedido.listoParaDespachar(p);
    assert.equal(listo.ok, false, "se habría despachado una guía que no se puede entregar");
    assert.match(listo.motivo, /punto de referencia|oficina/i, listo.motivo);
  });

  test("y la duda NO se evapora aunque la dirección llegue turnos antes del «sí»", async () => {
    // ⚠️ ESTE ERA EL DEFECTO DE FONDO, y es el que obligó a Marco a llamar.
    //
    // Las revisiones se recogían SOLO de los campos confirmados en el turno
    // en curso. Y el turno del «sí» no confirma nada: los datos llegaron
    // antes. Así que la duda se levantaba en su turno, nadie la guardaba, y
    // al crear el pedido la lista llegaba vacía.
    const c = await chat();
    await hastaLaDireccion(c);
    await c.dice("barrio centenario");
    // Tres turnos de relleno entre la dirección y el sí.
    await c.dice("y tiene garantia?");
    await c.dice("de que material es?");
    await c.dice("si confirmo");

    const [p] = await c.pedidos();
    assert.ok(p.revisiones.length, "la duda sobre la dirección se perdió por el camino");
    assert.equal(dominioPedido.listoParaDespachar(p).ok, false);
  });

  test("una dirección con nomenclatura se despacha sin tocar nada", async () => {
    // El camino normal no se toca: si esto falla, el parche frenó ventas
    // buenas, que es peor que el defecto.
    const c = await chat();
    await c.dice(ANUNCIO);
    await c.dice("lo quiero");
    await c.dice("Bogotá");
    await c.dice("Ana Perez");
    await c.dice("Calle 62bis 67-12");
    await c.dice("si");

    const [p] = await c.pedidos();
    assert.equal(p.estado, "confirmado");
    assert.deepEqual(p.revisiones, []);
    assert.equal(dominioPedido.listoParaDespachar(p).ok, true);
  });
});

// ==========================================================================
describe("2 · el bot SIEMPRE pide la dirección", () => {
  test("con solo el barrio, el resumen pide el punto de referencia y ofrece la oficina", async () => {
    const c = await chat();
    await hastaLaDireccion(c);
    const r = await c.dice("barrio centenario");

    assert.match(r.texto, /Confirmemos tu pedido/i, "no llegó al resumen");
    assert.match(r.texto, /punto de referencia/i, `no pidió la referencia: ${r.texto}`);
    assert.match(r.texto, /oficina de Interrapid/i, `no ofreció la oficina: ${r.texto}`);
    // UNA sola pregunta en el mensaje: la oficina va afirmada, no preguntada.
    assert.equal((r.texto.match(/\?/g) || []).length, 1, `más de una pregunta: ${r.texto}`);
  });

  test("y con una dirección completa NO se pide nada de eso", async () => {
    const c = await chat();
    await c.dice(ANUNCIO);
    await c.dice("lo quiero");
    await c.dice("Bogotá");
    await c.dice("Ana Perez");
    const r = await c.dice("Calle 62bis 67-12");

    assert.match(r.texto, /Confirmemos tu pedido/i);
    assert.equal(/punto de referencia/i.test(r.texto), false, `pidió una referencia que no hacía falta: ${r.texto}`);
  });

  test("la referencia que contesta el cliente SE GUARDA y sale en el resumen", async () => {
    // Sin esto la pregunta era un adorno: el cliente contestaba "al frente de
    // la droguería Cristal" y esa frase no se guardaba en ningún sitio.
    const c = await chat();
    await hastaLaDireccion(c);
    await c.dice("barrio centenario");
    const r = await c.dice("al frente de la droguería Cristal");

    assert.match(r.texto, /al frente de la droguer/i, `la referencia no salió en el resumen: ${r.texto}`);
    await c.dice("si confirmo");
    const [p] = await c.pedidos();
    assert.match(p.destinatario.referencia, /droguer/i, "la referencia no quedó en el pedido");
  });

  test("pero no se queda tragando mensajes: solo se pide UNA vez", async () => {
    // Repetir la pregunta es lo que costó la venta del 08-oct: la clienta
    // contestó "No entiendo" y se fue.
    const c = await chat();
    await hastaLaDireccion(c);
    const uno = await c.dice("barrio centenario");
    const dos = await c.dice("si");

    assert.match(uno.texto, /punto de referencia/i);
    assert.equal(/punto de referencia/i.test(dos.texto), false, `volvió a pedir lo mismo: ${dos.texto}`);
    assert.equal(dos.traza.respuesta.situacion, "confirmado", "el «sí» dejó de confirmar");
  });
});

// ==========================================================================
describe("3 · la oficina de la transportadora", () => {
  test("pedirla cierra la venta, y el pedido queda despachable", async () => {
    // Autorizado por Marco: «nosotros también podemos llevar a la oficina
    // inter rapidísimo o a la oficina de coordinadora».
    const c = await chat();
    await hastaLaDireccion(c);
    await c.dice("barrio centenario");
    await c.dice("mejor la recojo en la oficina de interrapidisimo");
    await c.dice("si confirmo");

    const [p] = await c.pedidos();
    assert.equal(p.destinatario.direccion, "Oficina Interrapidísimo", "no guardó el envío a oficina");
    assert.deepEqual(p.revisiones, [], "marcó para revisión un envío a oficina, que es una dirección completa");
    assert.equal(dominioPedido.listoParaDespachar(p).ok, true, "no se puede despachar un envío a oficina");
  });

  test("el nombre de la transportadora se normaliza, porque va impreso en la guía", async () => {
    const c = await chat();
    await hastaLaDireccion(c);
    await c.dice("barrio centenario");
    await c.dice("la dejo en coordinadora y la recojo ahi");
    await c.dice("si confirmo");

    const [p] = await c.pedidos();
    assert.equal(p.destinatario.direccion, "Oficina Coordinadora");
  });

  test("el texto de la oficina sale del CATÁLOGO, no escrito a mano", () => {
    // Es un dato comercial que autorizó Marco: vive donde viven los datos.
    // Si algún día desactiva el envío a oficina, la frase se cae sola.
    const p = elCinturon();
    const o = p.logistica.recogeEnOficina;
    assert.equal(o.activo, true);
    assert.deepEqual(o.transportadoras, ["Interrapidísimo", "Coordinadora"]);

    const cot = cotizador.cotizar({ producto: p, cantidad: 1 }).cotizacion;
    const conOficina = responder.textoDeterminista({
      situacion: "resumen",
      cotizacion: cot,
      faltan: [],
      producto: p,
      faltaReferencia: true,
      datosDeEntrega: { nombre: "Duber", ciudad: "Ipiales", direccion: "barrio centenario" },
      memoria: { saludado: true },
    });
    assert.match(conOficina, /oficina de Interrapid/i);

    // Y con el envío a oficina apagado, la frase desaparece sin tocar código.
    const apagado = JSON.parse(JSON.stringify(p));
    apagado.logistica.recogeEnOficina.activo = false;
    const sinOficina = responder.textoDeterminista({
      situacion: "resumen",
      cotizacion: cot,
      faltan: [],
      producto: apagado,
      faltaReferencia: true,
      datosDeEntrega: { nombre: "Duber", ciudad: "Ipiales", direccion: "barrio centenario" },
      memoria: { saludado: true },
    });
    assert.equal(/oficina de Interrapid/i.test(sinOficina), false, "la frase no sale del catálogo");
    assert.match(sinOficina, /punto de referencia/i, "se perdió la petición de referencia");
  });
});

// ==========================================================================
describe("4 · un parámetro que no se reenvía queda INERTE", () => {
  // ⚠️ ESTO ME PASO, Y NO LO CAZO NINGUNA PRUEBA.
  //
  // `responder.preparar` enumera a mano lo que le pasa a `textoDeterminista`.
  // En el parche del "retomar" (09-oct) cablee `resumenMostrado` en el
  // cerebro y olvide declararlo en `preparar`: el cerebro lo mandaba, el
  // redactor usaba su valor por defecto, y la rama del cierre que empuja al
  // "sí" con el resumen en pantalla NUNCA se ejecuto en produccion. Sin
  // error y sin prueba roja. Lo encontre al cablear `faltaReferencia` y ver
  // que tampoco llegaba.
  //
  // Estas dos pruebas van por `preparar`, no por `textoDeterminista`, que es
  // donde estaba el agujero.
  const elProducto = () => elCinturon();
  const cot = () => cotizador.cotizar({ producto: elProducto(), cantidad: 1 }).cotizacion;

  test("`preparar` reenvía faltaReferencia", () => {
    const r = responder.preparar({
      situacion: "resumen",
      cotizacion: cot(),
      faltan: [],
      producto: elProducto(),
      faltaReferencia: true,
      datosDeEntrega: { nombre: "Duber", ciudad: "Ipiales", direccion: "barrio centenario" },
      memoria: { saludado: true },
    });
    assert.match(r.texto, /punto de referencia/i, "`preparar` se comió faltaReferencia");
  });

  test("`preparar` reenvía resumenMostrado", () => {
    const r = responder.preparar({
      situacion: "faltan_datos",
      cotizacion: cot(),
      faltan: ["direccion"],
      producto: elProducto(),
      ciudadConfirmada: "Bogota",
      resumenMostrado: true,
      huboSenalDeCompra: true,
      mensajeCliente: "de que material es?",
      memoria: { saludado: true, datosPedidos: true, pasoPropuesto: true },
    });
    assert.match(r.texto, /respóndeme "sí"/i, "`preparar` se comió resumenMostrado");
  });
});
