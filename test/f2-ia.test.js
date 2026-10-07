"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Marco lo pidio explicitamente: si la IA falla, NO perder el mensaje, NO
// crear pedidos inventados, NO cotizar inventando, NO confirmar nada.
//
// La asercion mas valiosa es la del contrato: el modelo NO TIENE DONDE
// escribir un precio, un total ni una confirmacion. No es que se valide
// despues; es que el campo no existe, y si aparece, la respuesta entera se
// descarta. Lo que no se puede expresar no se puede colar.
//
// Nada de esto sale a la red ni necesita una clave.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const { crearCliente, MOTIVOS, extraerJson } = require("../src/ia/cliente");
const { crearProveedorFalso, analisisValido } = require("../src/ia/proveedores/falso");
const { validarAnalisis, INTENCIONES, CAMPOS_PROHIBIDOS } = require("../src/ia/contrato");

const PETICION = { sistema: "eres un asistente", usuario: "hola" };

// --------------------------------------------------------------------------
// Camino feliz
// --------------------------------------------------------------------------

test("una respuesta valida se acepta", async () => {
  const ia = crearCliente({
    proveedor: crearProveedorFalso([analisisValido({ intencion: "pregunta_precio" })]),
    intentos: 1,
  });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, true);
  assert.equal(r.analisis.intencion, "pregunta_precio");
});

test("los candidatos validos se conservan", async () => {
  const ia = crearCliente({
    proveedor: crearProveedorFalso([
      analisisValido({ intencion: "da_datos", candidatos: { ciudad: "Medellín", cantidad: 2 } }),
    ]),
    intentos: 1,
  });
  const r = await ia.analizar(PETICION);
  assert.equal(r.analisis.candidatos.ciudad, "Medellín");
  assert.equal(r.analisis.candidatos.cantidad, 2);
});

// --------------------------------------------------------------------------
// EL CONTRATO: el modelo no puede fijar hechos
// --------------------------------------------------------------------------

test("un precio en la salida DESCARTA la respuesta entera", async () => {
  const ia = crearCliente({
    proveedor: crearProveedorFalso([
      { texto: JSON.stringify({ intencion: "pregunta_precio", candidatos: { precio: 50000 } }) },
    ]),
    intentos: 1,
  });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, MOTIVOS.CONTRATO);
  // Y lo que vuelve es un respaldo seguro, no "la parte buena".
  assert.equal(r.analisis.intencion, INTENCIONES.NO_SE_ENTIENDE);
  assert.equal(r.analisis.respaldo, true);
});

test("ningun campo critico se puede colar, a ninguna profundidad", () => {
  for (const campo of CAMPOS_PROHIBIDOS) {
    const plano = validarAnalisis({ intencion: "saludo", [campo]: 1 });
    assert.equal(plano.ok, false, `"${campo}" paso en el primer nivel`);

    const anidado = validarAnalisis({ intencion: "saludo", candidatos: { ciudad: "Cali" }, extra: { dentro: { [campo]: 1 } } });
    assert.equal(anidado.ok, false, `"${campo}" paso anidado`);
  }
});

test("el modelo no puede proponer un campo que no esta en la lista", () => {
  const r = validarAnalisis({ intencion: "da_datos", candidatos: { descuentoEspecial: "20%" } });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no puede proponer/);
});

test("una intencion fuera del vocabulario se rechaza", () => {
  const r = validarAnalisis({ intencion: "regalar_el_producto" });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /vocabulario/);
});

test("una cantidad absurda se rechaza", () => {
  for (const cantidad of [0, -5, 1.5, 100000, "dos"]) {
    const r = validarAnalisis({ intencion: "da_datos", candidatos: { cantidad } });
    assert.equal(r.ok, false, `cantidad ${cantidad} paso`);
  }
});

test("un borrador demasiado largo se rechaza", () => {
  const r = validarAnalisis({ intencion: "saludo", borradorRespuesta: "x".repeat(2001) });
  assert.equal(r.ok, false);
});

test("el modelo puede SUGERIR un producto, pero es solo una sugerencia", () => {
  const r = validarAnalisis({ intencion: "pregunta_producto", productoSugerido: "cinturon-termico" });
  assert.equal(r.ok, true);
  assert.equal(r.analisis.productoSugerido, "cinturon-termico");
  // Quien resuelve el producto es catalogo/senales.js, no esto.
});

// --------------------------------------------------------------------------
// Fallos del modelo
// --------------------------------------------------------------------------

test("JSON invalido: se reintenta y, si no sale, respaldo seguro", async () => {
  const proveedor = crearProveedorFalso([{ texto: "esto no es json {{{" }, { texto: "tampoco >>>" }]);
  const ia = crearCliente({ proveedor, intentos: 2 });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, MOTIVOS.JSON_INVALIDO);
  assert.equal(proveedor.llamadas.length, 2, "no reintento");
  assert.equal(r.analisis.respaldo, true);
});

test("JSON invalido en el primer intento y valido en el segundo: sale bien", async () => {
  const ia = crearCliente({
    proveedor: crearProveedorFalso([{ texto: "roto {{" }, analisisValido({ intencion: "saludo" })]),
    intentos: 2,
  });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, true);
  assert.equal(r.analisis.intencion, "saludo");
});

test("timeout: se trata como fallo recuperable y acaba en respaldo", async () => {
  const proveedor = crearProveedorFalso([
    { lanzar: "The operation was aborted", nombre: "AbortError" },
    { lanzar: "The operation was aborted", nombre: "AbortError" },
  ]);
  const ia = crearCliente({ proveedor, intentos: 2 });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, MOTIVOS.TIMEOUT);
  assert.equal(r.analisis.respaldo, true);
});

test("error de red: no lanza, devuelve respaldo", async () => {
  const ia = crearCliente({ proveedor: crearProveedorFalso([{ lanzar: "fetch failed" }]), intentos: 1 });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, MOTIVOS.RED);
});

test("un 429 se reintenta", async () => {
  const proveedor = crearProveedorFalso([{ ok: false, estado: 429 }, analisisValido({ intencion: "saludo" })]);
  const ia = crearCliente({ proveedor, intentos: 2 });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, true);
  assert.equal(proveedor.llamadas.length, 2);
});

test("un 401 NO se reintenta: la segunda vez saldria igual de mal", async () => {
  const proveedor = crearProveedorFalso([{ ok: false, estado: 401 }, analisisValido()]);
  const ia = crearCliente({ proveedor, intentos: 2 });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, false);
  assert.equal(proveedor.llamadas.length, 1, "reintento una credencial invalida");
});

test("una respuesta vacia no se acepta como valida", async () => {
  const ia = crearCliente({ proveedor: crearProveedorFalso([{ texto: "   " }]), intentos: 1 });
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, MOTIVOS.VACIO);
});

test("sin proveedor el sistema sigue funcionando", async () => {
  // Es el estado real de NOVIKA hoy: sin clave de IA. El mensaje se registra
  // y se escala; no se pierde y no se inventa nada.
  const ia = crearCliente({ proveedor: null });
  assert.equal(ia.disponible, false);
  const r = await ia.analizar(PETICION);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, MOTIVOS.SIN_PROVEEDOR);
  assert.equal(r.analisis.intencion, INTENCIONES.NO_SE_ENTIENDE);
});

test("analizar NUNCA lanza, pase lo que pase", async () => {
  const casos = [
    [{ lanzar: "boom" }],
    [{ ok: false, estado: 500 }],
    [{ texto: "{}" }],
    [{ texto: JSON.stringify({ intencion: "saludo", total: 1 }) }],
    [],
  ];
  for (const respuestas of casos) {
    const ia = crearCliente({ proveedor: crearProveedorFalso(respuestas), intentos: 1 });
    await assert.doesNotReject(() => ia.analizar(PETICION));
  }
});

// --------------------------------------------------------------------------
// Privacidad en los registros
// --------------------------------------------------------------------------

test("un fallo de la IA no registra el texto del cliente", async () => {
  const registros = [];
  const log = {
    info: (e, d) => registros.push({ e, d }),
    warn: (e, d) => registros.push({ e, d }),
    error: (e, d) => registros.push({ e, d }),
  };
  const ia = crearCliente({
    proveedor: crearProveedorFalso([{ texto: "roto {{" }]),
    intentos: 1,
    log,
  });
  await ia.analizar({ sistema: "s", usuario: "me llamo Ana Perez, vivo en la Calle 45 # 23-10" });

  const todo = JSON.stringify(registros);
  assert.equal(todo.includes("Ana Perez"), false, "el nombre del cliente acabo en los logs");
  assert.equal(todo.includes("Calle 45"), false, "la direccion del cliente acabo en los logs");
  // Si se registra la longitud, que es lo que permite distinguir "llego
  // vacio" de "llego y no lo entendimos".
  assert.ok(todo.includes("longitud"));
});

test("un incumplimiento de contrato SI registra que campo fue, sin el valor", async () => {
  const registros = [];
  const log = { info() {}, warn() {}, error: (e, d) => registros.push({ e, d }) };
  const ia = crearCliente({
    proveedor: crearProveedorFalso([{ texto: JSON.stringify({ intencion: "saludo", total: 123456 }) }]),
    intentos: 1,
    log,
  });
  await ia.analizar(PETICION);
  const todo = JSON.stringify(registros);
  assert.ok(todo.includes("total"), "no se registro que campo intento fijar el modelo");
  assert.equal(todo.includes("123456"), false, "se registro el valor inventado");
});

// --------------------------------------------------------------------------
// Extraccion de JSON
// --------------------------------------------------------------------------

test("extraerJson desenvuelve los bloques de codigo que el modelo añade", () => {
  assert.equal(extraerJson('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extraerJson('```\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extraerJson('Claro: {"a":1} espero que sirva'), '{"a":1}');
  assert.equal(extraerJson('{"a":1}'), '{"a":1}');
});

// --------------------------------------------------------------------------
// Metricas
// --------------------------------------------------------------------------

test("los fallos de la IA quedan contados por tipo", async () => {
  const metricas = require("../src/metricas");
  metricas._reiniciar();

  const ia = crearCliente({
    proveedor: crearProveedorFalso([{ texto: "roto {{" }]),
    intentos: 1,
    metricas,
  });
  await ia.analizar(PETICION);

  assert.equal(metricas.valor("ia_fallo_json"), 1);
  assert.equal(metricas.valor("ia_agotada"), 1);
});
