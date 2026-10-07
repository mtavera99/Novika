"use strict";

// ==========================================================================
// REGRESIONES DE FASE 2
//
// Cada prueba de aqui corresponde a un fallo que existio de verdad durante
// la implementacion. Se documentan con el sintoma, no solo con el arreglo,
// porque el sintoma es lo que hay que reconocer si vuelve.
//
// Los tres tenian la misma forma peligrosa: NO DABAN ERROR. El sistema
// seguia funcionando y devolviendo algo plausible.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

require("./ayuda").entornoDePrueba();
const estados = require("../src/dominio/estados");
const texto = require("../src/dominio/texto");
const extraer = require("../src/dominio/extraer");

// --------------------------------------------------------------------------
// 1. La maquina de estados no permitia saltos
// --------------------------------------------------------------------------

test("REGRESION: un cliente que dice todo de golpe llega al resumen", () => {
  // SINTOMA: la conversacion se quedaba en "nuevo" para siempre y el resumen
  // nunca llegaba, aunque la cotizacion SI se calculaba y los datos SI se
  // confirmaban. No habia excepcion: la transicion se rechazaba, se anotaba
  // un aviso que nadie leia, y el estado no avanzaba.
  //
  // CAUSA: la tabla de transiciones obligaba a pasar escalon por escalon,
  // pero un cliente real dice "quiero el cinturon, soy Ana, Medellin, Calle
  // 45" en un solo mensaje. Eso cubre producto, datos y cotizacion de golpe.
  assert.equal(estados.puedeTransicionar(estados.ESTADOS.NUEVO, estados.ESTADOS.CAPTURANDO_DATOS), true);
  assert.equal(estados.puedeTransicionar(estados.ESTADOS.NUEVO, estados.ESTADOS.PENDIENTE_CONFIRMACION), true);
  assert.equal(estados.puedeTransicionar(estados.ESTADOS.EXPLORANDO, estados.ESTADOS.PENDIENTE_CONFIRMACION), true);
});

test("REGRESION: volver atras en el camino de venta es legitimo", () => {
  // "mejor que sean dos" obliga a recotizar desde PENDIENTE_CONFIRMACION.
  assert.equal(estados.puedeTransicionar(estados.ESTADOS.PENDIENTE_CONFIRMACION, estados.ESTADOS.COTIZADO), true);
  assert.equal(estados.puedeTransicionar(estados.ESTADOS.PENDIENTE_CONFIRMACION, estados.ESTADOS.CAPTURANDO_DATOS), true);
});

test("pero el blindaje de CONFIRMADO sigue intacto tras permitir los saltos", () => {
  // Esto es lo que no se podia perder al relajar la tabla.
  for (const hacia of estados.CAMINO_DE_VENTA) {
    assert.equal(
      estados.puedeTransicionar(estados.ESTADOS.CONFIRMADO, hacia),
      false,
      `se permitio CONFIRMADO -> ${hacia}`
    );
  }
});

test("a CONFIRMADO solo se llega desde PENDIENTE_CONFIRMACION, MODIFICANDO o POSVENTA", () => {
  const permitidos = Object.entries(estados.TRANSICIONES)
    .filter(([, hacia]) => hacia.includes(estados.ESTADOS.CONFIRMADO))
    .map(([desde]) => desde)
    .sort();
  assert.deepEqual(permitidos, [
    estados.ESTADOS.CONFIRMADO,
    estados.ESTADOS.MODIFICANDO,
    estados.ESTADOS.PENDIENTE_CONFIRMACION,
    estados.ESTADOS.POSVENTA,
  ].sort());
});

// --------------------------------------------------------------------------
// 2. La direccion se leia como cantidad
// --------------------------------------------------------------------------

test("REGRESION: 'vivo en la calle 45' no son 45 unidades", () => {
  // SINTOMA: se cotizaban 45 unidades y el total salia absurdo, sin error.
  // CAUSA: la heuristica proponia como cantidad cualquier numero entre 1 y
  // 50 que apareciera en el texto. La direccion es justo donde mas numeros
  // escribe un cliente, asi que no era un caso raro: era el caso normal.
  assert.equal(extraer.cantidadEn("vivo en la calle 45").valor, null);
  assert.equal(extraer.cantidadEn("Carrera 70 # 23-10 apto 5").valor, null);
  assert.equal(extraer.cantidadEn("quiero 2 por favor").valor, 2);
});

test("un numero de telefono o cedula no es una cantidad", () => {
  assert.equal(extraer.cantidadEn("mi celular es 3001234567").valor, null);
  assert.equal(extraer.cantidadEn("mi cedula 1020304050").valor, null);
});

// --------------------------------------------------------------------------
// 3. La tilde no se detectaba
// --------------------------------------------------------------------------

test("REGRESION: 'sí' con tilde SI se detecta", () => {
  // SINTOMA: la comprobacion de la tilde nunca era verdadera, asi que un
  // "sí" inequivoco se trataba con la misma desconfianza que un "si"
  // condicional. Parecia estar implementada y no lo estaba.
  //
  // CAUSA: /\bsí\b/ no coincide con "sí". En JavaScript \b se define sobre
  // \w, que es ASCII, asi que la "i" acentuada no cuenta como caracter de
  // palabra y el limite de palabra no existe donde parece.
  assert.equal(texto.vistas("sí").tieneTildeAfirmativa, true);
  assert.equal(texto.vistas("Sí, confirmo").tieneTildeAfirmativa, true);
  assert.equal(texto.vistas("si").tieneTildeAfirmativa, false);
  assert.equal(texto.vistas("si mandaron el pedido").tieneTildeAfirmativa, false);
});

// --------------------------------------------------------------------------
// 4. "un par" valia 1
// --------------------------------------------------------------------------

test("REGRESION: 'un par' son 2, no 1", () => {
  // SINTOMA: se cotizaba la mitad del pedido. Un cliente que pide un par
  // recibe uno.
  // CAUSA: se buscaban las palabras sueltas, y "un" ganaba por posicion
  // sobre "par".
  assert.equal(texto.cantidadesEn("mandame un par")[0].valor, 2);
  assert.equal(texto.cantidadesEn("quiero una docena")[0].valor, 12);
  assert.equal(texto.cantidadesEn("media docena")[0].valor, 6);
});

// --------------------------------------------------------------------------
// 5. Aislamiento respecto a BIKERPRO en el codigo de Fase 2
// --------------------------------------------------------------------------

test("ningun archivo de Fase 2 menciona BIKERPRO ni sus productos", () => {
  // El aislamiento de configuracion ya lo cubre test/aislamiento.test.js.
  // Esto cubre el otro riesgo: que al reutilizar patrones se cuele contenido
  // de BIKERPRO en el codigo de NOVIKA. Se permite nombrarlo en comentarios
  // -las lecciones vienen de ahi y hay que poder citarlas-, pero no sus
  // productos, sus precios ni sus identificadores.
  const prohibidos = [
    "impermeable",
    "intercom",
    "colmena",
    "v10",
    "bikerpro_verify",
    "573138615813",
    "573227545695",
    "bikerpro-bot",
  ];

  // src/aislamiento.js es la unica excepcion, y por una razon obvia: es el
  // modulo que BLOQUEA esas palabras, asi que tiene que nombrarlas. El resto
  // de los identificadores de BIKERPRO viven ahi como hash, no en claro, y
  // eso lo vigila test/aislamiento.test.js.
  const EXCEPCION = path.join("src", "aislamiento.js");

  const archivos = [];
  const recorrer = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p);
      else if (e.name.endsWith(".js") && !p.endsWith(EXCEPCION)) archivos.push(p);
    }
  };
  recorrer(path.join(__dirname, "..", "src"));

  assert.ok(archivos.length > 20, `solo se revisaron ${archivos.length} archivos`);

  /**
   * Se revisa el CODIGO, no los comentarios.
   *
   * Citar a BIKERPRO en un comentario es justo lo que queremos que pase: las
   * lecciones vienen de ahi y el incidente concreto es lo que explica por
   * que una regla existe. "PRODUCTO_POR_DEFECTO era impermeable y por eso
   * aqui no hay producto por defecto" es documentacion valiosa.
   *
   * Lo que no puede existir es una referencia EJECUTABLE: un alias, un id,
   * un precio o una credencial de BIKERPRO dentro de la logica de NOVIKA.
   */
  const soloCodigo = (fuente) =>
    fuente
      .replace(/\/\*[\s\S]*?\*\//g, " ") // comentarios de bloque
      .replace(/(^|[^:])\/\/.*$/gm, "$1") // comentarios de linea
      .toLowerCase();

  for (const archivo of archivos) {
    const codigo = soloCodigo(fs.readFileSync(archivo, "utf8"));
    for (const palabra of prohibidos) {
      assert.equal(
        codigo.includes(palabra),
        false,
        `"${palabra}" aparece en el CODIGO de ${path.relative(path.join(__dirname, ".."), archivo)} (no en un comentario)`
      );
    }
  }
});

test("el catalogo de NOVIKA no contiene productos de BIKERPRO", () => {
  const dir = path.join(__dirname, "..", "catalogo", "productos");
  for (const nombre of fs.readdirSync(dir)) {
    const contenido = fs.readFileSync(path.join(dir, nombre), "utf8").toLowerCase();
    for (const palabra of ["impermeable", "intercom", "colmena", "motociclista"]) {
      assert.equal(contenido.includes(palabra), false, `"${palabra}" aparece en catalogo/productos/${nombre}`);
    }
  }
});
