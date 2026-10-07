"use strict";

// ==========================================================================
// LAS PRIMERAS CONDICIONES COMERCIALES REALES
//
// Marco confirmo tres datos el 2026-10-07, y son los primeros datos reales
// que entran al catalogo:
//
//   precio de 1 unidad .... 49.900 COP
//   envio ................. incluido
//   pago .................. contraentrega
//
// Y dijo dos cosas mas, que son las que esta bateria vigila de verdad: NO
// hay descuento por cantidad, y NO hay garantia definida. Lo peligroso de un
// dato que falta no es que falte: es que alguien lo complete de forma
// plausible. "Dos por 95.000" suena a precio real y no lo es.
//
// Por eso las pruebas se hacen contra el ARCHIVO del catalogo, no contra un
// fixture: un fixture comprueba que el codigo funciona, y lo que hay que
// comprobar aqui es que el dato guardado es el que Marco dijo. Si alguien
// edita el JSON y pone un precio por volumen que nadie aprobo, esto falla.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const { cargarCatalogo } = require("../src/catalogo");
const { validarProducto } = require("../src/catalogo/esquema");
const cotizador = require("../src/dominio/cotizador");
const responder = require("../src/cerebro/responder");

const RAIZ = path.join(__dirname, "..");
const ID = "cinturon-termico-colicos";

function catalogoReal() {
  return cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true });
}

function elCinturon() {
  const c = catalogoReal();
  assert.equal(c.problemas.length, 0, `el catalogo no carga limpio: ${JSON.stringify(c.problemas)}`);
  const p = c.porId.get(ID);
  assert.ok(p, "el cinturon tiene que estar en el catalogo");
  return p;
}

/**
 * El cinturon activado SOLO EN MEMORIA.
 *
 * Hace falta para poder cotizar en las pruebas, porque el cotizador se niega
 * a cotizar un producto inactivo. El archivo sigue en borrador, y hay una
 * prueba mas abajo que lo comprueba justamente para que esta funcion no se
 * convierta en la puerta por la que el producto acaba activo sin ficha.
 *
 * El nombre y la descripcion son de prueba y se marcan como tales: no se
 * parecen a un nombre comercial para que nadie los copie al archivo.
 */
function activadoEnMemoria(extra = {}) {
  return {
    ...elCinturon(),
    activo: true,
    nombre: "(nombre de prueba)",
    descripcionAutorizada: "(descripcion de prueba)",
    pendientes: [],
    ...extra,
  };
}

// --------------------------------------------------------------------------
// LO QUE MARCO CONFIRMO, TAL CUAL
// --------------------------------------------------------------------------

test("el precio de 1 unidad es exactamente 49.900, entero y en pesos", () => {
  const p = elCinturon();
  assert.equal(p.precios["1"], 49900);
  assert.equal(Number.isInteger(p.precios["1"]), true, "un precio con decimales acabaria redondeando al cobrar");
  // Ni 49.9 ni "49900" ni 4990000 centavos: el cotizador trabaja en pesos
  // enteros y el formato se aplica al escribir el mensaje.
  assert.equal(typeof p.precios["1"], "number");
});

test("el envio esta declarado como incluido, y no como provisional", () => {
  const pol = elCinturon().logistica.politicaEnvio;
  assert.equal(pol.tipo, "incluido");
  assert.equal(pol.provisional, false);
  assert.ok(pol.porQue, "una condicion comercial sin constancia de quien la decidio no se puede auditar");
});

test("el pago contraentrega esta en el catalogo, no en el prompt", () => {
  const p = elCinturon();
  assert.equal(p.pago.metodo, "contraentrega");
  assert.ok(p.pago.etiquetaCliente, "sin etiqueta, el bot tendria que redactar como se cobra");

  // La etiqueta no puede traer cifras: el filtro de importes las leeria como
  // un cobro que el codigo no calculo y bloquearia el mensaje completo.
  assert.equal(/\d/.test(p.pago.etiquetaCliente), false);
});

// --------------------------------------------------------------------------
// LO QUE MARCO PROHIBIO INVENTAR
// --------------------------------------------------------------------------

test("NO hay descuento por cantidad: la tabla cubre solo 1 unidad", () => {
  const p = elCinturon();
  assert.deepEqual(Object.keys(p.precios), ["1"], "aparecio un precio por volumen que nadie aprobo");
  assert.deepEqual(p.promociones, [], "aparecio una promocion que nadie aprobo");
});

test("NO hay garantia ni claims inventados", () => {
  const p = elCinturon();
  assert.equal(p.garantia, "", "se escribio una garantia que Marco no ha definido");
  assert.deepEqual(p.claimsPermitidos, [], "se autorizo una afirmacion sin revisarla una por una");
  assert.deepEqual(p.caracteristicasAutorizadas, []);

  // La lista de prohibidos SI tiene que estar llena: es la que no afirma
  // nada, solo prohibe, y en un producto que se compra por dolor el riesgo
  // no es el precio, es la promesa medica.
  assert.ok(p.claimsProhibidos.length >= 5);
  assert.ok(p.claimsProhibidos.some((c) => /dispositivo medico/.test(c)));
});

test("lo que falta y no bloquea esta en sinDatoConfirmado, que entra al prompt", () => {
  const p = elCinturon();
  // Son las preguntas que mas se repiten en este producto y ninguna tiene
  // respuesta aprobada. Si no estuvieran declaradas, el modelo las
  // contestaria con algo verosimil.
  for (const tema of [/garantia/, /tiempo de entrega/, /dos o mas unidades/, /tallas/]) {
    assert.ok(
      p.sinDatoConfirmado.some((s) => tema.test(s)),
      `falta declarar ${tema} como dato sin confirmar: el modelo lo rellenaria`
    );
  }
});

// --------------------------------------------------------------------------
// EL CANDADO DE ACTIVACION
//
// Marco pregunto que bloquea de verdad. Estas dos pruebas responden con
// codigo en vez de con una opinion: la primera dice que hoy no se puede
// activar y por que, la segunda dice que resolviendo esos puntos si.
// --------------------------------------------------------------------------

test("el archivo del catalogo sigue INACTIVO", () => {
  const p = elCinturon();
  assert.equal(p.activo, false, "el producto se activo sin que la ficha este completa");
  assert.equal(catalogoReal().activos.length, 0);
  assert.ok(p.pendientes.length > 0);
});

test("activarlo HOY tal cual lo rechaza la validacion, y dice por que", () => {
  const errores = validarProducto({ ...elCinturon(), activo: true }, "simulacion").errores;
  assert.ok(errores.length > 0, "se podria activar un producto sin nombre ni descripcion");
  assert.ok(errores.some((e) => /pendiente\(s\) sin resolver/.test(e)));
  assert.ok(
    errores.some((e) => /descripcionAutorizada/.test(e)),
    `el motivo tiene que nombrar el campo que falta: ${JSON.stringify(errores)}`
  );
});

test("resueltos los 3 pendientes, la validacion lo deja activar: la lista es exacta", () => {
  // Esto es lo que convierte la lista de bloqueantes en una afirmacion
  // comprobable. Si manana alguien añade una exigencia nueva al esquema sin
  // ponerla en `pendientes`, esta prueba falla y la lista se corrige.
  const listo = {
    ...elCinturon(),
    activo: true,
    pendientes: [],
    nombre: "(nombre de prueba)",
    descripcionAutorizada: "(descripcion de prueba)",
  };
  const r = validarProducto(listo, "simulacion");
  assert.deepEqual(r.errores, [], "queda algun bloqueante que no esta en la lista de pendientes");
});

test("un producto activo sin metodo de pago declarado se rechaza", () => {
  // El candado nuevo. Sin esto, un producto se vende, se despacha, y nadie
  // sabe si habia que recaudar en la puerta.
  const sinPago = { ...activadoEnMemoria() };
  delete sinPago.pago;
  const r = validarProducto(sinPago, "simulacion");
  assert.ok(r.errores.some((e) => /pago\.metodo/.test(e)), JSON.stringify(r.errores));
});

test("un metodo de pago que el sistema no sabe representar se rechaza", () => {
  const r = validarProducto(activadoEnMemoria({ pago: { metodo: "fiado" } }), "simulacion");
  assert.ok(r.errores.some((e) => /pago\.metodo/.test(e) && /fiado/.test(e)));
});

test("una etiqueta de pago con cifras se rechaza antes de llegar al cliente", () => {
  // Una etiqueta como "Pagas 49900 al recibir" romperia el filtro de
  // importes: la cifra no esta autorizada y el mensaje entero se bloquearia.
  // Mejor que falle al cargar el catalogo.
  const r = validarProducto(
    activadoEnMemoria({ pago: { metodo: "contraentrega", etiquetaCliente: "Pagas 49900 al recibir" } }),
    "simulacion"
  );
  assert.ok(r.errores.some((e) => /etiquetaCliente/.test(e)));
});

// --------------------------------------------------------------------------
// COTIZAR
// --------------------------------------------------------------------------

test("1 unidad cotiza 49.900 con envio en 0 y sin descuento", () => {
  const r = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad: 1 });
  assert.equal(r.ok, true, r.motivo);
  const k = r.cotizacion;
  assert.equal(k.subtotal, 49900);
  assert.equal(k.envio, 0);
  assert.equal(k.descuento, 0);
  assert.equal(k.total, 49900);
  assert.deepEqual(k.promocionesAplicadas, []);

  // El envio en 0 tiene que venir de una politica declarada, no de un campo
  // que nadie lleno. El motivo lo distingue.
  const linea = k.desglose.find((d) => d.concepto === "envio");
  assert.match(linea.porQue, /incluido/);
});

test("2 o mas unidades NO se cotizan: se escala, no se multiplica", () => {
  for (const cantidad of [2, 3, 5, 10, 100]) {
    const r = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad });
    assert.equal(r.ok, false, `se cotizaron ${cantidad} unidades sin precio aprobado`);
    assert.equal(r.escalar, true, "tiene que pasar a una persona, no quedarse callado");
    assert.equal(r.cotizacion, undefined, "no puede salir ninguna cifra de aqui");

    // Y el motivo no puede contener un total calculado "por si acaso".
    const cifras = String(r.motivo).match(/\d{4,}/g) || [];
    assert.deepEqual(cifras, [], `el motivo insinua un importe: ${r.motivo}`);
  }
});

test("la cotizacion lleva las condiciones, y de ahi pasan al pedido", () => {
  const k = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad: 1 }).cotizacion;
  assert.equal(k.condiciones.pagoMetodo, "contraentrega");
  assert.equal(k.condiciones.envioIncluido, true);
  assert.equal(k.condiciones.politicaEnvio, "incluido");
  assert.ok(k.condiciones.pagoEtiqueta);
});

test("cambiar el metodo de pago caduca la oferta que el cliente acepto", () => {
  // Si pasa de contraentrega a pago anticipado, lo que el cliente dijo "si"
  // deja de aplicar. Sin esto, el pedido se despacharia esperando una
  // transferencia que nadie le pidio.
  const contraentrega = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad: 1 }).cotizacion;
  const anticipado = cotizador.cotizar({
    producto: activadoEnMemoria({ pago: { metodo: "anticipado", etiquetaCliente: "Pagas antes del envio" } }),
    cantidad: 1,
  }).cotizacion;

  assert.equal(contraentrega.total, anticipado.total, "el total es el mismo: lo que cambia es la condicion");
  assert.notEqual(
    cotizador.versionDeCatalogo(activadoEnMemoria()),
    cotizador.versionDeCatalogo(activadoEnMemoria({ pago: { metodo: "anticipado" } })),
    "la huella del catalogo ignora el metodo de pago"
  );
  assert.notEqual(
    cotizador.firmaDeCondiciones(contraentrega),
    cotizador.firmaDeCondiciones(anticipado),
    "dos condiciones de cobro distintas producen la misma firma: la oferta no caducaria"
  );
});

// --------------------------------------------------------------------------
// LO QUE LEE LA CLIENTA
// --------------------------------------------------------------------------

test("el resumen dice el total, que el envio va incluido y que paga al recibir", () => {
  const k = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad: 1 }).cotizacion;
  const texto = responder.preparar({ situacion: "resumen", cotizacion: k, producto: activadoEnMemoria() }).texto;

  assert.match(texto, /49\.900/);
  assert.match(texto, /Envío incluido/);
  assert.match(texto, /al recibir/);
  assert.match(texto, /¿Confirmas\?/);

  // Y no promete nada que no este confirmado.
  assert.equal(/garant/i.test(texto), false, "el resumen menciona una garantia que no existe");
  assert.equal(/d[ií]as|llega|entrega en/i.test(texto), false, "el resumen promete un plazo que nadie confirmo");
});

test("el filtro de importes acepta el resumen: ninguna cifra sin calcular", () => {
  const k = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad: 1 }).cotizacion;
  const texto = responder.preparar({ situacion: "resumen", cotizacion: k, producto: activadoEnMemoria() }).texto;

  const r = cotizador.revisarImportes(texto, k.importesAutorizados);
  assert.equal(r.ok, true, `cifras no autorizadas en el resumen: ${JSON.stringify(r.sospechosos)}`);
});

test("sin condiciones declaradas, el texto NO las inventa", () => {
  // Un producto que no declara envio incluido ni metodo de cobro no puede
  // producir "Envío incluido" por costumbre: seria un flete regalado, o un
  // cliente que entiende que ya pago.
  const otro = {
    ...activadoEnMemoria(),
    id: "otro-producto",
    pago: { metodo: "anticipado" },
    logistica: { politicaEnvio: { tipo: "fijo", valorFijo: 12000, provisional: false } },
  };
  const k = cotizador.cotizar({ producto: otro, cantidad: 1 }).cotizacion;
  const texto = responder.preparar({ situacion: "resumen", cotizacion: k, producto: otro }).texto;

  assert.equal(/incluido/i.test(texto), false, "dijo envio incluido sobre un producto con flete aparte");
  assert.equal(/al recibir/i.test(texto), false, "dijo que paga al recibir sobre un producto de pago anticipado");
});

// --------------------------------------------------------------------------
// LA VENTA COMPLETA, Y EL PEDIDO UNA SOLA VEZ
//
// Es la prueba que Marco quiere hacer desde su numero. Aqui va automatizada
// para que el ensayo manual confirme algo que ya esta verificado, en vez de
// servir para descubrirlo.
// --------------------------------------------------------------------------

const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearEmisor } = require("../src/whatsapp/enviar");
const mutex = require("../src/almacen/mutex");

async function montarConElCinturon() {
  mutex._reiniciar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-ficha-"));
  const repos = await crearReposDeArchivos({ dir });

  const producto = activadoEnMemoria();
  const catalogo = {
    productos: [producto],
    activos: [producto],
    porId: new Map([[producto.id, producto]]),
    productoPorDefecto: null,
  };

  const cfg = { ...config, respuestaAutomatica: false };
  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo,
    ia: crearCliente({ proveedor: null }),
    // Si algo intenta enviar, la prueba falla: no se le escribe a nadie.
    emisor: crearEmisor({ config: cfg, fetchImpl: async () => assert.fail("se intento enviar un WhatsApp") }),
  });

  return { cerebro, repos };
}

let t = 0;
function msg(texto) {
  t += 1;
  return {
    clase: "mensaje",
    wamid: `wamid.FICHA${t}`,
    idCliente: "573001234567",
    telefono: "573001234567",
    nombre: "Ana Pérez",
    tipo: "text",
    texto,
    origenTexto: "escrito",
    referral: null,
  };
}

test("venta completa: un pedido, con 49.900 y contraentrega estampados", async () => {
  const { cerebro, repos } = await montarConElCinturon();

  await cerebro.procesar(msg("hola, quiero el cinturon termico"));
  const resumen = await cerebro.procesar(msg("vivo en Medellin, Calle 45 # 23-10"));
  assert.equal(resumen.respuesta.situacion, "resumen", `situacion: ${resumen.respuesta.situacion}`);
  assert.match(resumen.respuesta.texto, /49\.900/);
  assert.match(resumen.respuesta.texto, /al recibir/);

  const confirmada = await cerebro.procesar(msg("si confirmo"));
  assert.equal(confirmada.estadoNuevo, "confirmado");
  assert.equal(confirmada.pedido.creado, true);

  const guardados = await repos.pedidos.porContacto("573001234567");
  assert.equal(guardados.length, 1, "el pedido tiene que aparecer UNA sola vez");

  const pedido = guardados[0];
  assert.equal(pedido.cotizacion.total, 49900);
  assert.equal(pedido.cotizacion.envio, 0);

  // Lo que ve quien despacha: hay que recaudar en la puerta. Si esto no
  // queda en el pedido, el paquete se entrega sin cobrar.
  assert.equal(pedido.cotizacion.condiciones.pagoMetodo, "contraentrega");
});

test("confirmar dos veces deja UN pedido y no recotiza", async () => {
  const { cerebro, repos } = await montarConElCinturon();

  await cerebro.procesar(msg("quiero el cinturon termico"));
  await cerebro.procesar(msg("vivo en Medellin, Calle 45 # 23-10"));
  await cerebro.procesar(msg("si confirmo"));
  const segunda = await cerebro.procesar(msg("si, confirmo"));

  assert.equal(segunda.respuesta.situacion, "ya_confirmado");
  const guardados = await repos.pedidos.porContacto("573001234567");
  assert.equal(guardados.length, 1, "se duplico el pedido");
});

test("pedir 2 unidades no crea pedido ni dice ninguna cifra", async () => {
  const { cerebro, repos } = await montarConElCinturon();

  await cerebro.procesar(msg("quiero 2 cinturones termicos"));
  const traza = await cerebro.procesar(msg("vivo en Medellin, Calle 45 # 23-10"));

  assert.notEqual(traza.respuesta.situacion, "resumen", "se armo un resumen con un precio que no existe");
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 0);

  // Ni un importe en el texto: es el momento exacto en el que un precio
  // plausible por dos unidades se cuela.
  assert.equal(/\$|\d{4,}/.test(traza.respuesta.texto), false, `el texto insinua un importe: ${traza.respuesta.texto}`);
});

void DIR;
