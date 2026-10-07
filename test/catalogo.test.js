"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA PRUEBA
//
// NOVIKA es multiproducto desde el primer dia, y el riesgo de un catalogo
// multiproducto no es que falte un producto: es que uno quede activo con los
// datos a medias. Un producto activo sin precio, o con la politica de envio
// de otro, es un cobro incorrecto esperando a pasar.
//
// La regla que esta bateria defiende: UN PRODUCTO NO PUEDE ESTAR ACTIVO SI
// LE FALTA UN DATO CRITICO. La validacion es permisiva con los borradores y
// estricta con lo que el bot puede vender hoy.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const { validarProducto, validarCatalogo } = require("../src/catalogo/esquema");
const { cargarCatalogo, productoPorId, senalesEn } = require("../src/catalogo");

/** Producto minimo valido y activo. Valores inventados SOLO para la prueba. */
function productoActivo(extra = {}) {
  return {
    id: "producto-de-prueba",
    nombre: "Producto de prueba",
    nombreCorto: "el producto",
    categoria: "hogar",
    activo: true,
    aliases: [{ patron: "\\bproduct[oa]", confianza: "alta", senal: "producto" }],
    descripcionAutorizada: "Descripcion de prueba.",
    caracteristicasAutorizadas: ["caracteristica de prueba"],
    motorDePrecio: "tabla",
    precios: { 1: 1000, 2: 1800 },
    logistica: { politicaEnvio: { tipo: "incluido", provisional: false } },
    pendientes: [],
    ...extra,
  };
}

// --------------------------------------------------------------------------
// Siempre obligatorio
// --------------------------------------------------------------------------

test("sin id no pasa: sin id no se puede estampar el producto en un pedido", () => {
  const { errores } = validarProducto({ nombre: "x", categoria: "hogar", activo: false });
  assert.ok(errores.some((e) => /id.*falta/i.test(e)));
});

test("el id tiene que ser minusculas-con-guiones", () => {
  for (const id of ["Producto Uno", "producto_uno", "prodücto", "producto--uno"]) {
    const { errores } = validarProducto({ id, nombre: "x", categoria: "hogar", activo: false });
    assert.ok(errores.some((e) => /minusculas-con-guiones/.test(e)), `deberia rechazar ${id}`);
  }
});

test("activo tiene que ser explicito, no asumido", () => {
  const { errores } = validarProducto({ id: "p", nombre: "x", categoria: "hogar" });
  assert.ok(errores.some((e) => /activo/.test(e)));
});

// --------------------------------------------------------------------------
// La regla central
// --------------------------------------------------------------------------

test("un borrador puede estar incompleto", () => {
  const borrador = { id: "borrador", nombre: "Borrador", categoria: "tecnologia", activo: false, pendientes: ["definir precio"] };
  assert.deepEqual(validarProducto(borrador).errores, []);
});

test("un producto activo CON pendientes se rechaza", () => {
  const { errores } = validarProducto(productoActivo({ pendientes: ["definir precio de 3 unidades"] }));
  assert.ok(errores.some((e) => /no puede estar activo con 1 pendiente/.test(e)));
});

test("un producto activo SIN precios se rechaza", () => {
  const { errores } = validarProducto(productoActivo({ precios: {} }));
  assert.ok(errores.some((e) => /sin precios/.test(e)));
});

test("un producto activo sin el precio de 1 unidad se rechaza", () => {
  const { errores } = validarProducto(productoActivo({ precios: { 2: 1800 } }));
  assert.ok(errores.some((e) => /precio de 1 unidad/.test(e)));
});

test("un producto activo sin descripcion autorizada se rechaza", () => {
  const { errores } = validarProducto(productoActivo({ descripcionAutorizada: "" }));
  assert.ok(errores.some((e) => /descripcionAutorizada/.test(e)));
});

test("un producto activo sin politica de envio se rechaza", () => {
  const { errores } = validarProducto(productoActivo({ logistica: {} }));
  assert.ok(errores.some((e) => /politicaEnvio/.test(e)));
});

test("un producto activo completo se acepta", () => {
  assert.deepEqual(validarProducto(productoActivo()).errores, []);
});

// --------------------------------------------------------------------------
// Precios
// --------------------------------------------------------------------------

test("los precios tienen que ser enteros positivos en pesos", () => {
  for (const precios of [{ 1: 1000.5 }, { 1: -1000 }, { 1: 0 }, { 1: "1000" }]) {
    const { errores } = validarProducto(productoActivo({ precios }));
    assert.ok(errores.some((e) => /entero positivo/.test(e)), `deberia rechazar ${JSON.stringify(precios)}`);
  }
});

test("la clave de precios tiene que ser una cantidad", () => {
  const { errores } = validarProducto(productoActivo({ precios: { 1: 1000, docena: 9000 } }));
  assert.ok(errores.some((e) => /cantidad entera positiva/.test(e)));
});

test("un motor de precio inexistente se rechaza", () => {
  const { errores } = validarProducto(productoActivo({ motorDePrecio: "lo-que-salga" }));
  assert.ok(errores.some((e) => /no existe/.test(e)));
});

// --------------------------------------------------------------------------
// Alias
// --------------------------------------------------------------------------

test("un alias con una expresion regular invalida se rechaza al validar, no al usarse", () => {
  const { errores } = validarProducto(productoActivo({ aliases: [{ patron: "[sin-cerrar", confianza: "alta" }] }));
  assert.ok(errores.some((e) => /no es una expresion regular valida/.test(e)));
});

test("un nivel de confianza inventado se rechaza", () => {
  const { errores } = validarProducto(productoActivo({ aliases: [{ patron: "abc", confianza: "altisima" }] }));
  assert.ok(errores.some((e) => /confianza/.test(e)));
});

// --------------------------------------------------------------------------
// Catalogo completo
// --------------------------------------------------------------------------

test("dos productos con el mismo id se rechazan", () => {
  const { errores } = validarCatalogo([
    { producto: productoActivo(), origen: "uno.json" },
    { producto: productoActivo({ nombre: "Otro" }), origen: "dos.json" },
  ]);
  assert.ok(errores.some((e) => /id duplicado/.test(e)));
});

test("noHeredar impide que un producto use la politica de envio que otro prohibe", () => {
  // El caso real: un articulo voluminoso de hogar y un accesorio pequeno no
  // comparten tarifa. Heredarla en silencio es cobrar mal.
  const voluminoso = productoActivo({
    id: "articulo-voluminoso",
    logistica: { politicaEnvio: { tipo: "por-peso", noHeredar: ["incluido"], provisional: false } },
  });
  const pequeno = productoActivo({ id: "accesorio-pequeno", logistica: { politicaEnvio: { tipo: "incluido" } } });

  const { errores } = validarCatalogo([
    { producto: voluminoso, origen: "voluminoso.json" },
    { producto: pequeno, origen: "pequeno.json" },
  ]);
  assert.ok(errores.some((e) => /no se hereda/.test(e)));
});

test("una politica provisional sin fecha de revision avisa", () => {
  const { avisos } = validarProducto(
    productoActivo({ logistica: { politicaEnvio: { tipo: "por-peso", provisional: true } } })
  );
  assert.ok(avisos.some((a) => /revisarCuando/.test(a)));
});

// --------------------------------------------------------------------------
// Carga desde disco
// --------------------------------------------------------------------------

test("los archivos que empiezan por _ no entran al catalogo", () => {
  const carpeta = path.join(DIR, "catalogo-a");
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(path.join(carpeta, "_plantilla.json"), JSON.stringify({ id: "plantilla" }));
  fs.writeFileSync(path.join(carpeta, "bueno.json"), JSON.stringify(productoActivo({ id: "bueno" })));

  const catalogo = cargarCatalogo({ carpeta });
  assert.equal(catalogo.productos.length, 1);
  assert.equal(catalogo.productos[0].id, "bueno");
});

test("un archivo con JSON roto no tumba el resto del catalogo", () => {
  const carpeta = path.join(DIR, "catalogo-b");
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(path.join(carpeta, "roto.json"), "{no es json");
  fs.writeFileSync(path.join(carpeta, "bueno.json"), JSON.stringify(productoActivo({ id: "bueno" })));

  const catalogo = cargarCatalogo({ carpeta });
  assert.equal(catalogo.activos.length, 1);
  assert.ok(catalogo.problemas.some((p) => /roto\.json/.test(p)));
});

test("NO hay producto por defecto: adivinar el producto es despachar el equivocado", () => {
  const carpeta = path.join(DIR, "catalogo-c");
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(path.join(carpeta, "uno.json"), JSON.stringify(productoActivo({ id: "uno" })));

  const catalogo = cargarCatalogo({ carpeta });
  assert.equal(catalogo.productoPorDefecto, null);
  assert.equal(productoPorId("no-existe", catalogo), null);
  assert.equal(productoPorId(null, catalogo), null);
});

test("senalesEn devuelve TODAS las coincidencias, para poder preguntar en vez de elegir", () => {
  const carpeta = path.join(DIR, "catalogo-d");
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(
    path.join(carpeta, "uno.json"),
    JSON.stringify(productoActivo({ id: "lampara", aliases: [{ patron: "\\blampar", confianza: "alta" }] }))
  );
  fs.writeFileSync(
    path.join(carpeta, "dos.json"),
    JSON.stringify(productoActivo({ id: "bombillo", aliases: [{ patron: "\\bbombill", confianza: "alta" }] }))
  );

  const catalogo = cargarCatalogo({ carpeta });

  const unaSola = senalesEn("tienen lamparas?", catalogo);
  assert.equal(unaSola.length, 1);
  assert.equal(unaSola[0].productoId, "lampara");

  // Dos productos nombrados en la misma frase: el sistema no elige por su
  // cuenta. Elegir en un empate es exactamente como se despacha mal.
  const ambiguo = senalesEn("necesito la lampara y el bombillo", catalogo);
  assert.equal(ambiguo.length, 2);

  assert.deepEqual(senalesEn("", catalogo), []);
  assert.deepEqual(senalesEn("hola buenas", catalogo), []);
});

test("los alias usan raices, asi que absorben erratas y plurales", () => {
  const carpeta = path.join(DIR, "catalogo-e");
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(
    path.join(carpeta, "uno.json"),
    JSON.stringify(productoActivo({ id: "organizador", aliases: [{ patron: "\\borganiza[dc]", confianza: "alta" }] }))
  );
  const catalogo = cargarCatalogo({ carpeta });

  for (const frase of ["el organizador", "los organizadores", "un organizacor"]) {
    assert.equal(senalesEn(frase, catalogo).length, 1, `deberia reconocer: ${frase}`);
  }
});

// --------------------------------------------------------------------------
// El catalogo que esta en el repositorio
// --------------------------------------------------------------------------

test("el catalogo del repositorio es valido y todavia no tiene productos activos", () => {
  const catalogo = cargarCatalogo({ carpeta: path.join(__dirname, "..", "catalogo", "productos") });
  assert.deepEqual(catalogo.problemas, [], `el catalogo tiene problemas: ${catalogo.problemas.join(" | ")}`);
  // Los productos reales de NOVIKA todavia no estan definidos. Si esta
  // asercion falla es porque alguien activo un producto: revisa que sus
  // precios y politicas esten aprobados por el dueno, y entonces actualizala.
  assert.equal(catalogo.activos.length, 0);
});
