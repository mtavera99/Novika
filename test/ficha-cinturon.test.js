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

test("los precios son EXACTAMENTE los que aprobo Marco, y ninguno mas", () => {
  // ANTES ESTA PRUEBA EXIGIA UNA SOLA CLAVE ("1"), y era correcto mientras
  // no habia precio por volumen. Marco confirmo el combo el 2026-10-08:
  // 85.000 por dos. Mantener la asercion obligaria a borrar un dato real.
  //
  // Y EL 2026-10-09 (parche 4) MARCO AMPLIO LA TABLA HASTA CINCO, con una
  // regla sencilla: desde 2 unidades, 42.500 cada una. De ahi salen 3 =
  // 127.500, 4 = 170.000 y 5 = 212.500. Textual suyo: "mas de 5 se escala a
  // mayorista", asi que la tabla PARA en 5 y no se extrapola.
  //
  // Lo que se vigila sigue siendo lo mismo: que no aparezca un precio que
  // nadie aprobo. Solo que ahora la lista aprobada tiene cinco entradas.
  const p = elCinturon();
  assert.deepEqual(p.precios, { 1: 49900, 2: 85000, 3: 127500, 4: 170000, 5: 212500 });

  // Y que los escalones de 2 a 5 sigan la regla que dio, en vez de ser
  // cifras sueltas que alguien tecleo: 42.500 por unidad, exacto.
  for (const n of [2, 3, 4, 5]) {
    assert.equal(p.precios[n], 42500 * n, `el escalon de ${n} no sale de 42.500 c/u`);
  }
  assert.equal(p.precios[6], undefined, "aparecio un precio para 6, que Marco dijo que se escala");
  assert.deepEqual(p.promociones, [], "aparecio una promocion que nadie aprobo");
});

test("la garantia es la que dijo Marco, y nada mas", () => {
  const p = elCinturon();
  // ANTES SE EXIGIA `garantia: ""`. Marco la confirmo el 2026-10-07: 1 mes.
  // Mantener la asercion obligaria a borrar un dato aprobado.
  //
  // Lo que se vigila ahora es que sea EXACTAMENTE lo que dijo: un plazo, sin
  // alcance ni procedimiento añadidos. "1 mes, te lo cambiamos si sale
  // defectuoso" seria la frase que suena razonable y que nadie aprobo.
  assert.equal(p.garantia, "1 mes");
  assert.equal(/cambio|devoluci|cubre|reembolso/i.test(p.garantia), false, "se le añadió alcance a la garantía");
  assert.deepEqual(p.claimsPermitidos, [], "se autorizo una afirmacion sin revisarla una por una");

  // ANTES EXIGIA `caracteristicasAutorizadas` VACIA, y dejo de valer el
  // 2026-10-07: Marco aprobo el color, la talla, el empaque y el panel de
  // control. Mantener la asercion obligaria a borrar datos aprobados.
  //
  // Lo que se vigila ahora es que ahi SOLO haya cosas aprobadas, y en
  // particular que no se haya colado una medida de ajuste -que es
  // justamente lo que Marco dijo que no se puede prometer.
  for (const c of p.caracteristicasAutorizadas) {
    assert.equal(
      /\bcm\b|centimetro|contorno|cualquier/.test(c),
      false,
      `se autorizo una caracteristica de ajuste que nadie midio: "${c}"`
    );
  }

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
  //
  // Esta lista se vacia a medida que Marco confirma datos. Han salido:
  // "tallas" y "colores", "la garantia" y "el tiempo de entrega", y el
  // 2026-10-08 el tramite y el alcance de la garantia mas el precio de dos.
  // Lo que queda son los que de verdad siguen abiertos, y el mas delicado
  // es el contorno del ajuste.
  // 'el material' salio el 2026-10-08: Marco lo confirmo (plastico y
  // almohadillas). Sigue aqui lo que de verdad no se sabe.
  // `trae exactamente el paquete` SALIO de la lista el 2026-10-09: Marco
  // autorizo el contenido del paquete, asi que ya no es un hueco. Se cambia
  // por `Nequi`, que sigue siendo uno de los que el dejo como [CONFIRMAR].
  //
  // ⚠️ Y `contorno`, `Nequi` y `tres o mas unidades` SALIERON TAMBIEN, con
  //    la seccion D del parche 4 (2026-10-09). Los tres los confirmo Marco:
  //    la correa abarca 130 a 150 cm, se paga con efectivo/Nequi/Daviplata/
  //    transferencia, y la tabla de precios llega a 5 unidades.
  //
  //    Lo que queda son los tres huecos de verdad. El de precios se
  //    estrecho, no se borro: el escalon que falta ahora es por ENCIMA de
  //    cinco, que Marco dijo que se habla como mayorista.
  for (const tema of [/mas de cinco unidades/, /medidas exactas/, /dia exacto/]) {
    assert.ok(
      p.sinDatoConfirmado.some((s) => tema.test(s)),
      `falta declarar ${tema} como dato sin confirmar: el modelo lo rellenaria`
    );
  }
});

// --------------------------------------------------------------------------
// Y LO CONTRARIO, QUE ES EL DEFECTO QUE DE VERDAD SE COLO
//
// La ficha se contradecia a si misma: `precios` tenia la clave "2" y a la
// vez `sinDatoConfirmado` declaraba que faltaba "el precio por dos o mas
// unidades". Igual con la garantia: los campos `garantiaCubre`,
// `garantiaNoCubre` y `garantiaComoSeTramita` estaban rellenos mientras la
// lista seguia diciendo que no se sabian.
//
// Un dato confirmado y declarado dudoso a la vez es lo peor de los dos
// mundos: el bot lo tiene y no lo usa, o lo usa y el filtro se lo tumba.
//
// Y NINGUNA PRUEBA LO HABRIA VISTO, porque confirmar un dato toca DOS
// sitios -el campo y la lista- y las pruebas solo miraban la lista. Esta
// comprueba la coherencia ENTRE los dos, que es donde estaba el hueco.
// --------------------------------------------------------------------------
test("un dato que YA esta en la ficha no puede declararse desconocido", () => {
  const p = elCinturon();
  const declarado = (re) => p.sinDatoConfirmado.some((s) => re.test(s));

  if (p.precios && p.precios["2"] !== undefined) {
    assert.equal(
      declarado(/\bdos o mas unidades\b/),
      false,
      "el precio de 2 esta en `precios` y a la vez declarado sin confirmar"
    );
  }
  if (p.garantiaComoSeTramita) {
    assert.equal(declarado(/tramita la garantia/), false, "el tramite esta en la ficha y declarado sin confirmar");
  }
  if (p.garantiaCubre) {
    assert.equal(declarado(/cubre exactamente la garantia/), false, "el alcance esta en la ficha y declarado sin confirmar");
  }

  // ⚠️ EL CONTORNO VOLVIO A PASAR, Y AHORA SE COMPRUEBA EN LOS DOS SENTIDOS.
  //
  // El 2026-10-09 se escribio la medida en la ficha y se olvido sacarla de
  // la lista — exactamente el defecto que esta prueba vigila, cometido otra
  // vez. Y encima la medida se escribio en un campo NUEVO
  // (`contornoMaxCm`) al lado del que ya existia (`contornoMaximoCm`, que
  // se quedo en null), asi que la comprobacion de abajo seguia pasando
  // mientras el bot ya decia "130 a 150 cm". Por eso ahora el maximo vive
  // en un solo campo y se afirman las dos direcciones.
  if (p.ajuste && p.ajuste.contornoMaximoCm) {
    assert.equal(
      declarado(/contorno/),
      false,
      "la correa tiene medida en la ficha y a la vez se declara que no se sabe"
    );
  } else {
    assert.ok(declarado(/contorno/), "no hay medida de contorno y no esta declarada");
  }
  if (p.pago && Array.isArray(p.pago.mediosAlRecibir) && p.pago.mediosAlRecibir.length) {
    assert.equal(declarado(/Nequi|transferencia/), false, "los medios de pago estan en la ficha y declarados dudosos");
  }

  // Y al revés: lo que NO tiene campo sigue declarado. El primer escalon de
  // precio que no existe tiene que seguir en la lista, sea cual sea.
  const tope = Math.max(...Object.keys(p.precios || {}).map(Number));
  assert.ok(
    declarado(/unidades/),
    `la tabla llega a ${tope} y no hay ningun escalon declarado como pendiente`
  );
  assert.equal(p.precios[tope + 1], undefined, "la tabla no puede tener un escalon por encima de su tope");
});

// --------------------------------------------------------------------------
// EL CANDADO DE ACTIVACION
//
// Marco pregunto que bloquea de verdad. Estas dos pruebas responden con
// codigo en vez de con una opinion: la primera dice que hoy no se puede
// activar y por que, la segunda dice que resolviendo esos puntos si.
// --------------------------------------------------------------------------

test("el candado de activacion sigue puesto: sin ficha no se activa", () => {
  // ESTAS DOS PRUEBAS MIRABAN EL CINTURON y exigian que estuviera inactivo y
  // que activarlo fallara. Eran correctas mientras le faltaban el nombre y
  // la descripcion; Marco los entrego el 2026-10-07 y el producto se activo,
  // asi que ya no se puede demostrar el candado con el.
  //
  // El candado hay que seguir vigilandolo, y con el segundo producto importa
  // igual. Se comprueba sobre un sintetico al que le falta cada cosa por
  // separado, que ademas dice MEJOR que antes cual es el hueco.
  const base = {
    id: "sintetico-para-el-candado",
    categoria: "bienestar",
    activo: true,
    nombre: "Sintetico",
    descripcionAutorizada: "Descripcion de prueba.",
    motorDePrecio: "tabla",
    precios: { 1: 1000 },
    pago: { metodo: "contraentrega" },
    logistica: { politicaEnvio: { tipo: "incluido", provisional: false } },
    pendientes: [],
  };

  // Con todo puesto, valida. Es la referencia: si esto falla, lo de abajo no
  // demuestra nada.
  assert.deepEqual(validarProducto(base, "sintetico").errores, []);

  const huecos = {
    "un pendiente sin resolver": { pendientes: ["falta algo"] },
    "sin descripcion autorizada": { descripcionAutorizada: "" },
    "sin precio de 1 unidad": { precios: {} },
    "sin politica de envio": { logistica: { politicaEnvio: {} } },
    "sin metodo de cobro": { pago: null },
  };

  for (const [hueco, parche] of Object.entries(huecos)) {
    const r = validarProducto({ ...base, ...parche }, "sintetico");
    assert.ok(r.errores.length > 0, `se pudo activar un producto ${hueco}`);
  }
});

test("la ficha real del cinturon no tiene ningun hueco", () => {
  // La version anterior simulaba la activacion para demostrar que la lista
  // de bloqueantes era exacta. Ya no hace falta simular: el producto esta
  // activo de verdad, y lo que hay que vigilar es que siga sin huecos.
  const r = validarProducto(elCinturon(), "archivo");
  assert.deepEqual(r.errores, []);
  assert.deepEqual(r.avisos, [], `avisos: ${JSON.stringify(r.avisos)}`);
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

test("EL PRECIO NO SE MULTIPLICA: 2 unidades valen 85.000, no 99.800", () => {
  // LA GARANTIA DE FONDO NO CAMBIO, solo el dato. Antes se comprobaba
  // negandose a cotizar 2; ahora que hay precio aprobado se comprueba de
  // forma mas directa y mas fuerte: que el total sea EL DE LA TABLA y no el
  // unitario por la cantidad.
  //
  // Es la misma proteccion: el cotizador no inventa la escala de volumen.
  const r = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad: 2 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.cotizacion.total, 85000);
  assert.notEqual(r.cotizacion.total, 49900 * 2, "multiplicó el precio unitario en vez de leer la tabla");
});

test("mas de CINCO unidades NO se cotizan: se escala, no se extrapola", () => {
  // ⚠️ EL LIMITE SE MOVIO DE 3 A 6 EL 2026-10-09, y es lo unico que cambio.
  //
  // Marco confirmo la tabla hasta 5 unidades y dijo que de ahi para arriba
  // se escala a mayorista. Antes esta prueba empezaba en 3 porque la tabla
  // llegaba a 2.
  //
  // LO QUE PROTEGE ES IDENTICO: que el cotizador no INTERPOLE. Que 3 tenga
  // precio hoy no es porque el codigo lo haya deducido de 42.500 x 3, es
  // porque Marco escribio el escalon. En cuanto se sale de la tabla, el bot
  // calla y pasa la venta a una persona — que ademas es lo que conviene,
  // porque un pedido de 10 unidades es una negociacion, no una cotizacion.
  for (const cantidad of [6, 10, 100]) {
    const r = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad });
    assert.equal(r.ok, false, `se cotizaron ${cantidad} unidades sin precio aprobado`);
    assert.equal(r.escalar, true, "tiene que pasar a una persona, no quedarse callado");
    assert.equal(r.cotizacion, undefined, "no puede salir ninguna cifra de aqui");

    // Y el motivo no puede contener un total calculado "por si acaso". Las
    // cifras de 4+ digitos serian importes; "1, 2, 3, 4, 5" son las claves
    // de la tabla y son informacion util para quien lea el panel.
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
  assert.match(texto, /¿Está todo bien\?/, "el resumen tiene que decir qué contestar");

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

test("pedir 8 unidades no crea pedido ni dice ninguna cifra", async () => {
  // ESTA PRUEBA ERA DE 2 UNIDADES, y luego de 3. Cada vez que Marco aprueba
  // un escalon hay que moverla al primero que NO existe, porque lo que
  // prueba es el borde de la tabla, no un numero concreto.
  //
  // El 2026-10-09 la tabla llego a 5, asi que el caso sin precio aprobado
  // es ahora 8. La garantia es la misma de siempre: donde no hay precio, no
  // sale ninguna cifra.
  const { cerebro, repos } = await montarConElCinturon();

  await cerebro.procesar(msg("quiero 8 cinturones termicos"));
  const traza = await cerebro.procesar(msg("vivo en Medellin, Calle 45 # 23-10"));

  assert.notEqual(traza.respuesta.situacion, "resumen", "se armo un resumen con un precio que no existe");
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 0);

  // Ni un importe en el texto: es el momento exacto en el que un precio
  // plausible por tres unidades se cuela.
  assert.equal(/\$|\d{4,}/.test(traza.respuesta.texto), false, `el texto insinua un importe: ${traza.respuesta.texto}`);
});

void DIR;

// --------------------------------------------------------------------------
// EL PRECIO DE DOS UNIDADES (Marco, 2026-10-08)
//
// Hasta ahora la tabla cubria solo 1 unidad y pedir dos se escalaba a una
// persona. Con el combo confirmado -85.000 por las dos, envio incluido- el
// bot cierra la venta de dos solo.
//
// Y al añadirlo aparecio un defecto de conversacion que no se veia antes:
// con un unico precio no habia forma de preguntar "¿cuánto me salen dos?".
// --------------------------------------------------------------------------

const textoDominio = require("../src/dominio/texto");

test("la tabla cubre 1 a 5 unidades, con los precios confirmados", () => {
  const p = elCinturon();
  assert.equal(p.precios["1"], 49900);
  assert.equal(p.precios["2"], 85000);
  // Los tres de abajo los confirmo Marco el 2026-10-09, con la regla "desde
  // 2 unidades, 42.500 cada una".
  assert.equal(p.precios["3"], 127500);
  assert.equal(p.precios["4"], 170000);
  assert.equal(p.precios["5"], 212500);
  assert.deepEqual(Object.keys(p.precios), ["1", "2", "3", "4", "5"], "apareció un precio que nadie aprobó");
});

test("el combo es mas barato que dos sueltos, y por eso es una promocion", () => {
  // Si el combo costara lo mismo o mas que dos unidades sueltas, no seria
  // una promocion: seria un error de tecleo. 49.900 x 2 = 99.800 contra
  // 85.000 son 14.800 de diferencia.
  const p = elCinturon();
  const dosSueltos = p.precios["1"] * 2;
  assert.ok(p.precios["2"] < dosSueltos, "el combo no puede costar mas que dos unidades sueltas");
  assert.equal(dosSueltos - p.precios["2"], 14800);
});

test("2 unidades cotizan 85.000 con el envio incluido", () => {
  const r = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad: 2 });
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.cotizacion.total, 85000);
  assert.equal(r.cotizacion.envio, 0);
  assert.equal(r.cotizacion.condiciones.pagoMetodo, "contraentrega");
});

test("MAS DE 5 unidades SIGUEN escalando: la tabla no se extrapola", () => {
  // Ahora hay cinco escalones, y la escala tiene una regla visible (42.500
  // por unidad desde la segunda). Eso hace mas tentador que nunca
  // extrapolar: 6 x 42.500 = 255.000 "sale solo". Y es exactamente lo que
  // no se puede hacer — Marco dijo que de 5 para arriba se habla de
  // mayorista, que es un precio distinto y una conversacion con una persona.
  for (const cantidad of [6, 7, 12, 50]) {
    const r = cotizador.cotizar({ producto: activadoEnMemoria(), cantidad });
    assert.equal(r.ok, false, `se cotizaron ${cantidad} unidades sin precio aprobado`);
    assert.equal(r.escalar, true);
    // Y el motivo dice que cubre 1 a 5, para que quien lea el panel sepa
    // exactamente que falta.
    assert.match(r.motivo, /la tabla cubre 1, 2, 3, 4, 5/);
  }
});

test("añadir el precio de 2 cambia la huella del catalogo", () => {
  // Efecto conocido y aceptado: `versionDeCatalogo` incluye `precios`
  // completo, asi que una oferta abierta en el momento del despliegue no se
  // confirmara — se escalara a una persona. Es el lado seguro: nunca se
  // cobra un precio viejo. Afinar la huella por cantidad debilitaria el
  // candado que impide cobrar mal.
  const conDos = activadoEnMemoria();
  const soloUna = { ...conDos, precios: { 1: 49900 } };
  assert.notEqual(
    cotizador.versionDeCatalogo(conDos),
    cotizador.versionDeCatalogo(soloUna),
    "un cambio de precios tiene que cambiar la huella"
  );
});

test('"¿cuánto me salen dos?" informa el precio de DOS, no de una', () => {
  // EL DEFECTO: la clienta preguntaba por dos y recibia el precio de una,
  // mas un "¿cuántos quieres?" sobre algo que acababa de decir.
  //
  // `extraer` no toma la cantidad de una pregunta de precio -y hace bien,
  // preguntar no es comprar- asi que la cantidad para INFORMAR se lee
  // aparte, acotada a la tabla de precios.
  const p = elCinturon();
  const mencionadas = textoDominio.cantidadesEn("¿cuánto me salen dos?").map((c) => c.valor);
  assert.deepEqual(mencionadas, [2]);
  assert.ok(p.precios["2"] !== undefined, "2 tiene que estar en la tabla para poder informarlo");
});

test("una direccion NO se lee como cantidad para informar el precio", () => {
  // La tabla de precios acota el riesgo sola: "Calle 45 # 23-10" menciona
  // 45, 23 y 10, y ninguno existe en `precios`, asi que se descartan sin
  // volver a escribir la heuristica que ya confundio una direccion con una
  // cantidad.
  const p = elCinturon();
  const mencionadas = textoDominio.cantidadesEn("Ana Perez, Medellin, Calle 45 # 23-10").map((c) => c.valor);
  const enTabla = mencionadas.filter((n) => p.precios[String(n)] !== undefined);
  assert.deepEqual(enTabla, [], `se tomó un número de la dirección como cantidad: ${JSON.stringify(mencionadas)}`);
});
