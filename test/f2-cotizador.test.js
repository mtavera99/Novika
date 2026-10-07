"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Cobrar mal es la prioridad 3 de Marco, y las tres formas de cobrar mal son
// inventar un numero, asumir un valor que falta e interpolar una cantidad
// que nadie tarifo. Las tres estan cubiertas aqui.
//
// La asercion que mas vale del archivo es la del envio sin configurar: un
// envio asumido en 0 porque no estaba en el catalogo es regalar el flete en
// cada venta, y no da ningun error. Se descubre al cerrar el mes.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const { cotizar, firmaDeCondiciones, revisarImportes, POLITICA_VERSION } = require("../src/dominio/cotizador");

/** Producto de prueba. Los importes son inventados A PROPOSITO: es un fixture. */
function productoDePrueba(sobre = {}) {
  return {
    id: "producto-prueba",
    nombre: "Producto de prueba",
    activo: true,
    motorDePrecio: "tabla",
    precios: { 1: 50000, 2: 90000 },
    logistica: { politicaEnvio: { tipo: "incluido" } },
    ...sobre,
  };
}

// --------------------------------------------------------------------------
// Camino feliz
// --------------------------------------------------------------------------

test("una cotizacion valida devuelve el desglose completo", () => {
  const r = cotizar({ producto: productoDePrueba(), cantidad: 1 });
  assert.equal(r.ok, true);
  const c = r.cotizacion;
  assert.equal(c.subtotal, 50000);
  assert.equal(c.envio, 0);
  assert.equal(c.total, 50000);
  assert.equal(c.moneda, "COP");
  assert.equal(c.politicaVersion, POLITICA_VERSION);
  assert.ok(c.versionCatalogo, "falta la version del catalogo para poder auditar");
  assert.ok(c.desglose.length >= 2);
});

test("el precio sale de la tabla, no de multiplicar", () => {
  // 2 unidades valen 90000, no 100000. El precio por cantidad es una
  // decision comercial, no una multiplicacion.
  const r = cotizar({ producto: productoDePrueba(), cantidad: 2 });
  assert.equal(r.cotizacion.total, 90000);
});

test("el envio fijo se suma", () => {
  const r = cotizar({
    producto: productoDePrueba({ logistica: { politicaEnvio: { tipo: "fijo", valorFijo: 12000 } } }),
    cantidad: 1,
  });
  assert.equal(r.cotizacion.envio, 12000);
  assert.equal(r.cotizacion.total, 62000);
});

test("el envio por destino usa la tarifa del departamento", () => {
  const producto = productoDePrueba({
    logistica: { politicaEnvio: { tipo: "por_destino", tablaPorDepartamento: { Antioquia: 9000, Atlántico: 15000 } } },
  });
  const a = cotizar({ producto, cantidad: 1, destino: { ciudad: "Medellín", departamento: "Antioquia" } });
  assert.equal(a.cotizacion.envio, 9000);
  const b = cotizar({ producto, cantidad: 1, destino: { ciudad: "Barranquilla", departamento: "Atlántico" } });
  assert.equal(b.cotizacion.envio, 15000);
});

// --------------------------------------------------------------------------
// NO INVENTAR
// --------------------------------------------------------------------------

test("una cantidad fuera de la tabla NO se interpola: se escala", () => {
  // Con precio para 1 y para 2, pedir 5 no es "el de 2 mas tres veces el de
  // 1". Eso seria inventar una politica de mayoreo que nadie aprobo.
  const r = cotizar({ producto: productoDePrueba(), cantidad: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.escalar, true);
  assert.match(r.motivo, /no hay precio para 5/);
  assert.match(r.motivo, /la tabla cubre 1, 2/);
});

test("una politica de envio sin importe NO asume cero: dice que falta", () => {
  // El fallo silencioso mas caro: regalar el flete en cada venta sin que
  // salte ningun error.
  const r = cotizar({
    producto: productoDePrueba({ logistica: { politicaEnvio: { tipo: "fijo" } } }),
    cantidad: 1,
  });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("logistica.politicaEnvio.valorFijo"));
});

test("un departamento sin tarifa NO usa el de al lado", () => {
  const r = cotizar({
    producto: productoDePrueba({
      logistica: { politicaEnvio: { tipo: "por_destino", tablaPorDepartamento: { Antioquia: 9000 } } },
    }),
    cantidad: 1,
    destino: { ciudad: "Leticia", departamento: "Amazonas" },
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no hay tarifa configurada para Amazonas/);
});

test("un envio por destino sin destino conocido no cotiza", () => {
  const r = cotizar({
    producto: productoDePrueba({
      logistica: { politicaEnvio: { tipo: "por_destino", tablaPorDepartamento: { Antioquia: 9000 } } },
    }),
    cantidad: 1,
    destino: null,
  });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("departamento"));
});

test("un producto sin politica de envio no cotiza", () => {
  const r = cotizar({ producto: productoDePrueba({ logistica: {} }), cantidad: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("logistica.politicaEnvio.tipo"));
});

test("un producto INACTIVO no se cotiza", () => {
  const r = cotizar({ producto: productoDePrueba({ activo: false }), cantidad: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.escalar, true);
  assert.match(r.motivo, /no esta activo/);
});

test("sin producto no se cotiza", () => {
  assert.equal(cotizar({ producto: null, cantidad: 1 }).ok, false);
});

test("sin cantidad no se cotiza, y lo dice", () => {
  const r = cotizar({ producto: productoDePrueba(), cantidad: null });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("cantidad"));
});

test("una cantidad no entera o negativa no cotiza", () => {
  for (const cantidad of [0, -1, 1.5, "2"]) {
    assert.equal(cotizar({ producto: productoDePrueba(), cantidad }).ok, false, `cantidad ${cantidad}`);
  }
});

// --------------------------------------------------------------------------
// Variantes
// --------------------------------------------------------------------------

test("una variante obligatoria sin elegir impide cotizar", () => {
  const producto = productoDePrueba({
    variantes: [{ clave: "talla", obligatoria: true, opciones: ["S", "M", "L"] }],
  });
  const r = cotizar({ producto, cantidad: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("variante.talla"));
});

test("una opcion de variante que no existe se rechaza", () => {
  const producto = productoDePrueba({
    variantes: [{ clave: "talla", obligatoria: true, opciones: ["S", "M"] }],
  });
  const r = cotizar({ producto, cantidad: 1, variante: { talla: "XXL" } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no es una opcion de talla/);
});

test("una variante obligatoria bien elegida cotiza", () => {
  const producto = productoDePrueba({
    variantes: [{ clave: "talla", obligatoria: true, opciones: ["S", "M"] }],
  });
  const r = cotizar({ producto, cantidad: 1, variante: { talla: "M" } });
  assert.equal(r.ok, true);
});

// --------------------------------------------------------------------------
// Promociones
// --------------------------------------------------------------------------

test("sin promociones el descuento es cero", () => {
  assert.equal(cotizar({ producto: productoDePrueba(), cantidad: 1 }).cotizacion.descuento, 0);
});

test("varias promociones vigentes NO se suman: se aplica la mayor", () => {
  // Sumar descuentos que nadie definio como acumulables es regalar margen.
  const producto = productoDePrueba({
    promociones: [
      { id: "p1", descuento: 5000 },
      { id: "p2", descuento: 8000 },
    ],
  });
  const r = cotizar({ producto, cantidad: 1 });
  assert.equal(r.cotizacion.descuento, 8000);
  assert.deepEqual(r.cotizacion.promocionesAplicadas, ["p2"]);
  assert.equal(r.cotizacion.total, 42000);
});

test("una promocion caducada no se aplica", () => {
  const producto = productoDePrueba({
    promociones: [{ id: "vieja", descuento: 5000, hasta: "2020-01-01T00:00:00Z" }],
  });
  assert.equal(cotizar({ producto, cantidad: 1 }).cotizacion.descuento, 0);
});

test("una promocion con minimo de unidades respeta el minimo", () => {
  const producto = productoDePrueba({ promociones: [{ id: "x2", descuento: 10000, minimoUnidades: 2 }] });
  assert.equal(cotizar({ producto, cantidad: 1 }).cotizacion.descuento, 0);
  assert.equal(cotizar({ producto, cantidad: 2 }).cotizacion.descuento, 10000);
});

test("el descuento nunca deja el total en negativo", () => {
  const producto = productoDePrueba({ promociones: [{ id: "absurda", descuento: 999999 }] });
  const r = cotizar({ producto, cantidad: 1 });
  assert.ok(r.ok === false || r.cotizacion.total > 0);
});

// --------------------------------------------------------------------------
// Lista blanca de importes: el filtro contra el precio inventado
// --------------------------------------------------------------------------

test("la cotizacion declara que cifras puede contener la respuesta", () => {
  const r = cotizar({
    producto: productoDePrueba({ logistica: { politicaEnvio: { tipo: "fijo", valorFijo: 12000 } } }),
    cantidad: 2,
  });
  const autorizados = r.cotizacion.importesAutorizados;
  assert.ok(autorizados.includes(90000), "falta el subtotal");
  assert.ok(autorizados.includes(12000), "falta el envio");
  assert.ok(autorizados.includes(102000), "falta el total");
});

test("un precio inventado en el texto se detecta", () => {
  const r = revisarImportes("Te queda en $89.000 con envio", [50000, 102000]);
  assert.equal(r.ok, false);
  assert.equal(r.sospechosos[0].valor, 89000);
});

test("los importes autorizados pasan en cualquier formato", () => {
  for (const texto of ["Total: $50.000", "son 50000 pesos", "$ 50,000", "50.000"]) {
    assert.equal(revisarImportes(texto, [50000]).ok, true, `deberia aceptar: ${texto}`);
  }
});

test("un texto sin cifras de dinero pasa", () => {
  assert.equal(revisarImportes("Claro, te cuento todo sobre el producto", []).ok, true);
});

// --------------------------------------------------------------------------
// Firma de condiciones
// --------------------------------------------------------------------------

test("la firma cambia si cambia la cantidad", () => {
  const a = cotizar({ producto: productoDePrueba(), cantidad: 1 }).cotizacion;
  const b = cotizar({ producto: productoDePrueba(), cantidad: 2 }).cotizacion;
  assert.notEqual(firmaDeCondiciones(a), firmaDeCondiciones(b));
});

test("la firma cambia si cambia el destino", () => {
  const producto = productoDePrueba({
    logistica: { politicaEnvio: { tipo: "por_destino", tablaPorDepartamento: { Antioquia: 9000, Santander: 9000 } } },
  });
  const a = cotizar({ producto, cantidad: 1, destino: { ciudad: "Medellín", departamento: "Antioquia" } }).cotizacion;
  const b = cotizar({ producto, cantidad: 1, destino: { ciudad: "Bucaramanga", departamento: "Santander" } }).cotizacion;
  // Mismo total, destino distinto: la firma TIENE que cambiar. Si fuera solo
  // la tarifa, dos compras distintas producirian la misma huella y un pedido
  // podria escribirse encima del de otro destinatario.
  assert.equal(a.total, b.total);
  assert.notEqual(firmaDeCondiciones(a), firmaDeCondiciones(b));
});

test("la firma cambia si cambia el precio en el catalogo", () => {
  const a = cotizar({ producto: productoDePrueba(), cantidad: 1 }).cotizacion;
  const b = cotizar({ producto: productoDePrueba({ precios: { 1: 55000 } }), cantidad: 1 }).cotizacion;
  assert.notEqual(firmaDeCondiciones(a), firmaDeCondiciones(b));
});

test("la firma es estable si nada cambia", () => {
  const a = cotizar({ producto: productoDePrueba(), cantidad: 1 }).cotizacion;
  const b = cotizar({ producto: productoDePrueba(), cantidad: 1 }).cotizacion;
  assert.equal(firmaDeCondiciones(a), firmaDeCondiciones(b));
});

// --------------------------------------------------------------------------
// Motor producto_mas_envio
// --------------------------------------------------------------------------

test("el motor producto_mas_envio multiplica por el unitario", () => {
  const r = cotizar({
    producto: productoDePrueba({
      motorDePrecio: "producto_mas_envio",
      precios: undefined,
      precioUnitario: 30000,
      logistica: { politicaEnvio: { tipo: "fijo", valorFijo: 10000 } },
    }),
    cantidad: 3,
  });
  assert.equal(r.cotizacion.subtotal, 90000);
  assert.equal(r.cotizacion.total, 100000);
});

test("el motor producto_mas_envio sin precio unitario no cotiza", () => {
  const r = cotizar({
    producto: productoDePrueba({ motorDePrecio: "producto_mas_envio", precios: undefined }),
    cantidad: 1,
  });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("precioUnitario"));
});

test("un motor de precio desconocido no cotiza", () => {
  const r = cotizar({ producto: productoDePrueba({ motorDePrecio: "a-ojo" }), cantidad: 1 });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("motorDePrecio"));
});
