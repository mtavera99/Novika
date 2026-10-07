"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Tres cosas que, si fallan, cuestan dinero directo:
//
//   SNAPSHOT: si manana sube el precio, el pedido de ayer tiene que seguir
//   valiendo lo que el cliente acepto. Guardar solo un productoId y
//   recalcular al consultar hace que el historico cambie solo, y entonces la
//   contabilidad del negocio no es auditable.
//
//   DOS CLAVES DE IDEMPOTENCIA: hay dos duplicados distintos (retransmision
//   del webhook y "si" repetido) y con una sola clave se escapa uno.
//
//   COHERENCIA TRAS MODIFICAR: dejar la cantidad en 3 con el total de 2 es
//   la clase de inconsistencia que acaba en devolucion y en discusion.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const pedido = require("../src/dominio/pedido");
const { cotizar } = require("../src/dominio/cotizador");

function productoDePrueba(sobre = {}) {
  return {
    id: "producto-prueba",
    nombre: "Producto de prueba",
    activo: true,
    motorDePrecio: "tabla",
    precios: { 1: 50000, 2: 90000, 3: 120000 },
    logistica: { politicaEnvio: { tipo: "incluido" } },
    ...sobre,
  };
}

const DATOS = {
  nombre: "Ana Pérez",
  telefono: "3001234567",
  ciudad: "Medellín",
  departamento: "Antioquia",
  direccion: "Calle 45 # 23-10",
};

function construirBasico(sobre = {}) {
  const cot = cotizar({
    producto: productoDePrueba(),
    cantidad: 1,
    destino: { ciudad: "Medellín", departamento: "Antioquia" },
  }).cotizacion;
  return pedido.construir({
    cotizacion: cot,
    datos: DATOS,
    contactoId: "573001234567",
    conversacionId: "conv-1",
    ofertaId: "of-1",
    wamidConfirmacion: "wamid.CONF",
    ...sobre,
  });
}

// --------------------------------------------------------------------------
// Construccion
// --------------------------------------------------------------------------

test("un pedido completo se construye", () => {
  const r = construirBasico();
  assert.equal(r.ok, true);
  assert.equal(r.pedido.estado, pedido.ESTADOS_PEDIDO.CONFIRMADO);
  assert.match(r.pedido.id, /^NOV-/);
  assert.equal(r.pedido.version, 1);
});

test("el id de pedido NO lleva el telefono del cliente dentro", () => {
  // Un id de pedido se pega en chats, correos y guias.
  const r = construirBasico();
  assert.equal(r.pedido.id.includes("3001234567"), false);
  assert.equal(r.pedido.id.includes("573001234567"), false);
});

test("faltar un dato de despacho impide crear el pedido, y dice cual", () => {
  const r = construirBasico({ datos: { ...DATOS, direccion: null } });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("direccion"));
});

test("sin wamid de confirmacion no hay pedido: sin el no se puede deduplicar", () => {
  const r = construirBasico({ wamidConfirmacion: null });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("wamidConfirmacion"));
});

test("sin oferta no hay pedido", () => {
  const r = construirBasico({ ofertaId: null });
  assert.equal(r.ok, false);
  assert.ok(r.falta.includes("ofertaId"));
});

test("si la cotizacion es de otra ciudad, NO se crea: hay que recotizar", () => {
  // El envio se calculo para otro destino. Despachar asi es cobrar un flete
  // que no corresponde.
  const r = construirBasico({ datos: { ...DATOS, ciudad: "Cali" } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /hay que recotizar/);
});

test("un dato dudoso NO tira la venta: se guarda EN REVISION", () => {
  const r = construirBasico({ revisiones: [{ campo: "direccion", motivo: "no se reconoce el tipo de via" }] });
  assert.equal(r.ok, true);
  assert.equal(r.pedido.estado, pedido.ESTADOS_PEDIDO.EN_REVISION);
  assert.equal(pedido.listoParaDespachar(r.pedido).ok, false);
});

// --------------------------------------------------------------------------
// SNAPSHOT
// --------------------------------------------------------------------------

test("el pedido guarda una COPIA de la cotizacion, no una referencia", () => {
  const cot = cotizar({ producto: productoDePrueba(), cantidad: 1 }).cotizacion;
  const r = pedido.construir({
    cotizacion: cot,
    datos: DATOS,
    contactoId: "573001234567",
    ofertaId: "of-1",
    wamidConfirmacion: "wamid.X",
  });

  // Alguien cambia el objeto original despues de confirmar.
  cot.total = 999999;

  assert.equal(r.pedido.cotizacion.total, 50000, "el pedido se dejo modificar desde fuera");
});

test("si el precio del catalogo sube, el pedido viejo conserva el suyo", () => {
  const antes = cotizar({ producto: productoDePrueba(), cantidad: 1 }).cotizacion;
  const r = pedido.construir({
    cotizacion: antes,
    datos: DATOS,
    contactoId: "573001234567",
    ofertaId: "of-1",
    wamidConfirmacion: "wamid.X",
  });

  // Sube el precio en el catalogo.
  const despues = cotizar({ producto: productoDePrueba({ precios: { 1: 70000 } }), cantidad: 1 }).cotizacion;

  assert.equal(r.pedido.cotizacion.total, 50000, "el pedido historico cambio solo");
  assert.equal(despues.total, 70000);
  // Y se puede demostrar con que reglas se cotizo.
  assert.ok(r.pedido.cotizacion.politicaVersion);
  assert.ok(r.pedido.cotizacion.versionCatalogo);
  assert.notEqual(r.pedido.cotizacion.versionCatalogo, despues.versionCatalogo);
});

test("el destinatario tambien es una instantanea", () => {
  const datos = { ...DATOS };
  const r = construirBasico({ datos });
  datos.direccion = "otra direccion";
  assert.equal(r.pedido.destinatario.direccion, "Calle 45 # 23-10");
});

// --------------------------------------------------------------------------
// Claves de idempotencia
// --------------------------------------------------------------------------

test("la clave de evento es determinista: el mismo evento, la misma clave", () => {
  const a = pedido.claveDeEvento("573001234567", "wamid.ABC");
  const b = pedido.claveDeEvento("573001234567", "wamid.ABC");
  assert.equal(a, b);
});

test("distinto wamid produce distinta clave de evento", () => {
  assert.notEqual(pedido.claveDeEvento("573001234567", "wamid.A"), pedido.claveDeEvento("573001234567", "wamid.B"));
});

test("distinto contacto produce distinta clave, aunque el wamid se repitiera", () => {
  assert.notEqual(pedido.claveDeEvento("573001112222", "wamid.A"), pedido.claveDeEvento("573003334444", "wamid.A"));
});

test("la clave de oferta no depende del wamid: eso bloquea el si repetido", () => {
  // Dos mensajes distintos del cliente sobre la MISMA oferta tienen que
  // producir la misma clave de oferta.
  const a = pedido.claveDeOferta("573001234567", "of-1");
  const b = pedido.claveDeOferta("573001234567", "of-1");
  assert.equal(a, b);
  assert.notEqual(a, pedido.claveDeOferta("573001234567", "of-2"));
});

test("las dos claves son distintas entre si", () => {
  const p = construirBasico().pedido;
  assert.notEqual(p.claveDeEvento, p.claveDeOferta);
  assert.ok(p.claveDeEvento);
  assert.ok(p.claveDeOferta);
});

// --------------------------------------------------------------------------
// Modificaciones
// --------------------------------------------------------------------------

test("cambiar la direccion no obliga a recotizar", () => {
  const p = construirBasico().pedido;
  const r = pedido.modificar({ pedido: p, cambios: { direccion: "Carrera 70 # 1-2" } });
  assert.equal(r.ok, true);
  assert.equal(r.pedido.destinatario.direccion, "Carrera 70 # 1-2");
  assert.equal(r.pedido.version, 2);
});

test("cambiar la cantidad SI obliga a recotizar, y lo dice", () => {
  const p = construirBasico().pedido;
  const r = pedido.modificar({ pedido: p, cambios: { cantidad: 2 } });
  assert.equal(r.ok, false);
  assert.equal(r.requiereCotizacion, true);
  assert.match(r.motivo, /afectan al precio/);
});

test("cambiar la cantidad con cotizacion nueva actualiza cantidad Y total", () => {
  const p = construirBasico().pedido;
  const nueva = cotizar({
    producto: productoDePrueba(),
    cantidad: 2,
    destino: { ciudad: "Medellín", departamento: "Antioquia" },
  }).cotizacion;
  const r = pedido.modificar({ pedido: p, cambios: { cantidad: 2 }, cotizacionNueva: nueva });
  assert.equal(r.ok, true);
  assert.equal(r.pedido.cantidad, 2);
  assert.equal(r.pedido.cotizacion.total, 90000);
});

test("una cotizacion que no cuadra con el cambio se rechaza", () => {
  // La inconsistencia que acaba en devolucion: cantidad 3 con el total de 2.
  const p = construirBasico().pedido;
  const deDos = cotizar({
    producto: productoDePrueba(),
    cantidad: 2,
    destino: { ciudad: "Medellín", departamento: "Antioquia" },
  }).cotizacion;
  const r = pedido.modificar({ pedido: p, cambios: { cantidad: 3 }, cotizacionNueva: deDos });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /es para 2 y el pedido quedo en 3/);
});

test("cambiar de producto con la cotizacion de otro se rechaza", () => {
  const p = construirBasico().pedido;
  const otra = cotizar({ producto: productoDePrueba({ id: "otro-producto" }), cantidad: 1 }).cotizacion;
  const r = pedido.modificar({ pedido: p, cambios: { productoId: "tercer-producto" }, cotizacionNueva: otra });
  assert.equal(r.ok, false);
});

test("modificar NO muta el pedido original: versiona", () => {
  const p = construirBasico().pedido;
  const r = pedido.modificar({ pedido: p, cambios: { direccion: "nueva" } });
  assert.equal(p.destinatario.direccion, "Calle 45 # 23-10", "se muto el original");
  assert.equal(p.version, 1);
  assert.equal(r.pedido.version, 2);
});

test("el historial conserva el antes y el despues", () => {
  const p = construirBasico().pedido;
  const r = pedido.modificar({ pedido: p, cambios: { nombre: "Ana María Pérez" }, porQue: "lo pidio el cliente" });
  const ultima = r.pedido.historial[r.pedido.historial.length - 1];
  assert.equal(ultima.accion, "modificado");
  assert.equal(ultima.antes.nombre, "Ana Pérez");
  assert.equal(ultima.despues.nombre, "Ana María Pérez");
  assert.equal(ultima.porQue, "lo pidio el cliente");
});

test("un campo que no es modificable se rechaza", () => {
  const p = construirBasico().pedido;
  const r = pedido.modificar({ pedido: p, cambios: { total: 1 } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no es un campo modificable/);
});

test("un pedido despachado no se modifica desde el bot", () => {
  const p = { ...construirBasico().pedido, estado: pedido.ESTADOS_PEDIDO.DESPACHADO };
  const r = pedido.modificar({ pedido: p, cambios: { direccion: "otra" } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /ya esta despachado/);
});

test("requiereRecotizar reconoce los campos que mueven el precio", () => {
  assert.equal(pedido.requiereRecotizar({ cantidad: 2 }), true);
  assert.equal(pedido.requiereRecotizar({ ciudad: "Cali" }), true);
  assert.equal(pedido.requiereRecotizar({ productoId: "x" }), true);
  assert.equal(pedido.requiereRecotizar({ variante: { talla: "M" } }), true);
  assert.equal(pedido.requiereRecotizar({ nombre: "Ana" }), false);
  assert.equal(pedido.requiereRecotizar({ direccion: "x" }), false);
});

// --------------------------------------------------------------------------
// Cancelacion
// --------------------------------------------------------------------------

test("cancelar es un borrado suave con motivo y fecha", () => {
  const p = construirBasico().pedido;
  const r = pedido.cancelar({ pedido: p, motivo: "el cliente se arrepintio" });
  assert.equal(r.ok, true);
  assert.equal(r.pedido.estado, pedido.ESTADOS_PEDIDO.CANCELADO);
  assert.equal(r.pedido.motivoCancelacion, "el cliente se arrepintio");
  assert.ok(r.pedido.canceladoEn);
  // No se borra: sigue consultable.
  assert.equal(r.pedido.id, p.id);
});

test("cancelar dos veces es IDEMPOTENTE y no pisa el motivo original", () => {
  const p = construirBasico().pedido;
  const a = pedido.cancelar({ pedido: p, motivo: "primer motivo" });
  const b = pedido.cancelar({ pedido: a.pedido, motivo: "segundo motivo" });
  assert.equal(b.ok, true);
  assert.equal(b.yaEstaba, true);
  assert.equal(b.pedido.motivoCancelacion, "primer motivo");
  assert.equal(b.pedido.version, a.pedido.version, "una cancelacion repetida subio la version");
});

test("un pedido cancelado no se modifica", () => {
  const p = pedido.cancelar({ pedido: construirBasico().pedido }).pedido;
  const r = pedido.modificar({ pedido: p, cambios: { direccion: "otra" } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /cancelado/);
});

test("listoParaDespachar exige todos los datos", () => {
  assert.equal(pedido.listoParaDespachar(construirBasico().pedido).ok, true);
  const sinTelefono = construirBasico().pedido;
  sinTelefono.destinatario.telefono = null;
  assert.equal(pedido.listoParaDespachar(sinTelefono).ok, false);
});
