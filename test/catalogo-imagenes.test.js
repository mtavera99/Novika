"use strict";

// ==========================================================================
// IMAGENES DEL CATALOGO
//
// Las cinco fotos del cinturon, convertidas desde HEIC, vinculadas al
// producto y servidas por HTTP para que Meta pueda descargarlas.
//
// Lo que se fija aqui:
//
//   - que los ORIGINALES sigan estando (son el master, no se tiran);
//   - que las convertidas cumplan lo que Meta exige, comprobado por los
//     BYTES del archivo y no por la extension;
//   - que la ruta publica sirva las convertidas y NO los originales;
//   - que no se pueda salir de la carpeta;
//   - que sin URL publica se diga, en vez de mandar un enlace a medias.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const { crearApp } = require("../src/app");
const esquema = require("../src/catalogo/esquema");
const imagenes = require("../src/catalogo/imagenes");
const { cargarCatalogo } = require("../src/catalogo");

const RAIZ = path.join(__dirname, "..");
const PRODUCTO = require("../catalogo/productos/cinturon-termico-colicos.json");
const DIR = "catalogo/imagenes/cinturon-termico";

const ESPERADAS = ["01-frente.jpg", "02-puesto.jpg", "03-detalle.jpg", "04-correa.jpg", "05-empaque.jpg"];
const ORIGINALES = [
  "01frente..heic",
  "02productopuesto.heic",
  "03detalle.heic",
  "04correa.heic",
  "05empaque.heic",
];

// ==========================================================================
// 1 · LOS ORIGINALES SE CONSERVAN
// ==========================================================================

describe("1 · los HEIC originales no se tocan", () => {
  test("las cinco siguen ahi", () => {
    // Son el master. Una conversion se puede repetir; un original borrado
    // obliga a volver a fotografiar el producto.
    for (const n of ORIGINALES) {
      const p = path.join(RAIZ, DIR, "originales", n);
      assert.ok(fs.existsSync(p), `falta el original ${n}`);
      assert.ok(fs.statSync(p).size > 100000, `${n} parece truncado`);
    }
  });
});

// ==========================================================================
// 2 · LAS CONVERTIDAS CUMPLEN LO QUE META EXIGE
// ==========================================================================

describe("2 · las JPEG cumplen los requisitos de Meta", () => {
  test("existen las cinco", () => {
    for (const n of ESPERADAS) {
      assert.ok(fs.existsSync(path.join(RAIZ, DIR, n)), `falta ${n}`);
    }
  });

  test("son JPEG de verdad, por sus BYTES", () => {
    // Un HEIC renombrado a .jpg pasaria cualquier comprobacion de nombre y
    // fallaria en Meta con un 131053, ya con el cliente esperando.
    for (const n of ESPERADAS) {
      const real = esquema.formatoReal(path.join(RAIZ, DIR, n));
      assert.ok(real, `${n} no se reconoce`);
      assert.equal(real.mime, "image/jpeg", `${n} no es jpeg`);
    }
  });

  test("ninguna pasa de 5 MB", () => {
    for (const n of ESPERADAS) {
      const bytes = fs.statSync(path.join(RAIZ, DIR, n)).size;
      assert.ok(bytes <= esquema.MAX_BYTES_IMAGEN, `${n} pesa ${bytes} y el limite es 5 MB`);
    }
  });

  test("y pesan mucho menos que el original: se envian por datos moviles", () => {
    // No es estetica. Una clienta abre WhatsApp en la calle; una foto de
    // 1,8 MB tarda y a veces no carga.
    let original = 0;
    let convertida = 0;
    for (const n of ORIGINALES) original += fs.statSync(path.join(RAIZ, DIR, "originales", n)).size;
    for (const n of ESPERADAS) convertida += fs.statSync(path.join(RAIZ, DIR, n)).size;
    assert.ok(convertida < original / 2, `convertidas ${convertida} vs originales ${original}`);
  });

  test("no llevan metadatos de camara ni GPS", () => {
    // Una foto de producto hecha con el movil puede traer la ubicacion de
    // donde se tomo, que es la casa o la bodega.
    for (const n of ESPERADAS) {
      const bytes = fs.readFileSync(path.join(RAIZ, DIR, n));
      // Marcadores EXIF y GPS en los primeros 64 KB, donde irian.
      const cabeza = bytes.subarray(0, 65536).toString("latin1");
      assert.ok(!cabeza.includes("GPS"), `${n} lleva GPS`);
      assert.ok(!/Apple|iPhone/i.test(cabeza), `${n} lleva marca de camara`);
    }
  });
});

// ==========================================================================
// 3 · VINCULADAS AL PRODUCTO, Y VALIDADAS
// ==========================================================================

describe("3 · el catalogo las conoce", () => {
  test("el cinturon tiene las cinco vinculadas, con descripcion", () => {
    assert.ok(Array.isArray(PRODUCTO.imagenes), "el producto no tiene imagenes");
    assert.equal(PRODUCTO.imagenes.length, 5);
    for (const img of PRODUCTO.imagenes) {
      assert.ok(img.archivo.startsWith(DIR + "/"), `ruta rara: ${img.archivo}`);
      assert.ok(img.alt && img.alt.length > 5, `sin descripcion: ${img.archivo}`);
    }
  });

  test("el catalogo entero carga sin problemas", () => {
    const c = cargarCatalogo();
    assert.deepEqual(c.problemas, []);
  });

  test("vincular fotos NO activa un producto: una foto no es una ficha", () => {
    // ESTA PRUEBA MIRABA EL CINTURON Y EXIGIA `activo: false`. Servia
    // mientras el cinturon era el borrador; Marco cerro su ficha el
    // 2026-10-07 y ya esta activo, asi que mirarlo a el ya no demuestra
    // nada sobre las fotos.
    //
    // La garantia que importa no era "el cinturon esta inactivo", era "las
    // fotos no bastan para vender". Eso hay que seguir vigilandolo, porque
    // con el segundo producto se repite: entran antes las fotos que los
    // precios. Asi que se comprueba sobre un producto sintetico con las
    // cinco fotos de verdad y la ficha a medias.
    const conFotosYSinFicha = {
      id: "producto-con-fotos-sin-ficha",
      categoria: "bienestar",
      activo: true,
      imagenes: PRODUCTO.imagenes,
      motorDePrecio: "tabla",
      precios: {},
      pendientes: ["precio", "descripcion"],
    };

    const r = esquema.validarProducto(conFotosYSinFicha, "sintetico");
    assert.ok(r.errores.length > 0, "cinco fotos validas dejaron activar un producto sin ficha");
    assert.ok(r.errores.some((e) => /pendiente/.test(e)));
    assert.ok(r.errores.some((e) => /precios/.test(e)));
  });

  test("la validacion rechaza una ruta que no existe", () => {
    const p = JSON.parse(JSON.stringify(PRODUCTO));
    p.imagenes.push({ archivo: `${DIR}/no-existe.jpg`, alt: "x" });
    const r = esquema.validarProducto(p, "prueba");
    assert.match(r.errores.join(" "), /no existe/);
  });

  test("rechaza una ruta que se sale de la carpeta", () => {
    for (const mala of ["/etc/passwd", "catalogo/imagenes/../../package.json", "../secreto.jpg"]) {
      const p = JSON.parse(JSON.stringify(PRODUCTO));
      p.imagenes = [{ archivo: mala, alt: "x" }];
      const r = esquema.validarProducto(p, "prueba");
      assert.ok(r.errores.length > 0, `acepto ${mala}`);
    }
  });

  test("rechaza un HEIC aunque se llame .jpg", () => {
    const p = JSON.parse(JSON.stringify(PRODUCTO));
    p.imagenes = [{ archivo: `${DIR}/originales/01frente..heic`, alt: "x" }];
    const r = esquema.validarProducto(p, "prueba");
    assert.match(r.errores.join(" "), /no es jpeg ni png/);
  });
});

// ==========================================================================
// 4 · LA URL QUE SE LE PASA A META
// ==========================================================================

describe("4 · construir el enlace para Meta", () => {
  test("absoluta y bajo /imagenes", () => {
    const u = imagenes.urlDeImagen(`${DIR}/01-frente.jpg`, "https://novika-bot.onrender.com");
    assert.equal(u, "https://novika-bot.onrender.com/imagenes/cinturon-termico/01-frente.jpg");
  });

  test("sin URL publica devuelve null y lo DICE, no un enlace a medias", () => {
    // Una URL relativa mandada a Meta es un 131053 con el cliente
    // esperando. Mejor negarse antes.
    assert.equal(imagenes.urlDeImagen(`${DIR}/01-frente.jpg`, ""), null);
    const r = imagenes.revisarImagen(`${DIR}/01-frente.jpg`, "");
    assert.equal(r.sePuedeEnviar, false);
    assert.match(r.problemas.join(" "), /URL publica/);
  });

  test("avisa si la URL no es HTTPS", () => {
    const r = imagenes.revisarImagen(`${DIR}/01-frente.jpg`, "http://localhost:3000");
    assert.equal(r.sePuedeEnviar, false);
    assert.match(r.problemas.join(" "), /HTTPS/);
  });

  test("con URL HTTPS y archivo real, se puede enviar", () => {
    const r = imagenes.revisarProducto(PRODUCTO, "https://novika-bot.onrender.com");
    assert.equal(r.cuantas, 5);
    assert.equal(r.enviables, 5, `problemas: ${JSON.stringify(r.imagenes.filter((i) => !i.sePuedeEnviar))}`);
    assert.equal(r.todasEnviables, true);
    for (const i of r.imagenes) assert.equal(i.mime, "image/jpeg");
  });
});

// ==========================================================================
// 5 · SERVIDAS POR HTTP
// ==========================================================================

describe("5 · la ruta publica", () => {
  async function levantar() {
    return ayuda.levantar(crearApp());
  }

  test("ESCENARIO: Meta puede descargar la foto", async () => {
    // Publica y sin token a proposito: Meta descarga con sus servidores y
    // no puede presentar una cookie nuestra.
    const s = await levantar();
    try {
      const r = await fetch(`${s.url}/imagenes/cinturon-termico/01-frente.jpg`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/jpeg");

      const bytes = Buffer.from(await r.arrayBuffer());
      assert.ok(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff, "no llego un JPEG");
      assert.equal(bytes.length, fs.statSync(path.join(RAIZ, DIR, "01-frente.jpg")).size);
    } finally {
      await s.cerrar();
    }
  });

  test("las cinco responden 200", async () => {
    const s = await levantar();
    try {
      for (const n of ESPERADAS) {
        const r = await fetch(`${s.url}/imagenes/cinturon-termico/${n}`);
        assert.equal(r.status, 200, `${n} dio ${r.status}`);
      }
    } finally {
      await s.cerrar();
    }
  });

  test("los ORIGINALES no se publican", async () => {
    // Meta no acepta HEIC y pesan el triple. Publicarlos solo sirve para
    // gastar ancho de banda y para que alguien los use por error.
    const s = await levantar();
    try {
      for (const n of ORIGINALES) {
        const r = await fetch(`${s.url}/imagenes/cinturon-termico/originales/${n}`);
        assert.equal(r.status, 404, `el original ${n} se esta publicando`);
      }
    } finally {
      await s.cerrar();
    }
  });

  test("no se puede salir de la carpeta", async () => {
    const s = await levantar();
    try {
      for (const u of [
        "/imagenes/../package.json",
        "/imagenes/../../package.json",
        "/imagenes/..%2F..%2Fpackage.json",
        "/imagenes/cinturon-termico/../../../package.json",
      ]) {
        const r = await fetch(`${s.url}${u}`);
        assert.ok(r.status === 403 || r.status === 404, `${u} dio ${r.status}`);
        const cuerpo = await r.text();
        assert.ok(!cuerpo.includes('"name"'), `${u} filtro el package.json`);
      }
    } finally {
      await s.cerrar();
    }
  });

  test("no se sirve nada que no sea jpg o png", async () => {
    const s = await levantar();
    try {
      for (const u of [
        "/imagenes/cinturon-termico/originales/README.md",
        "/imagenes/cinturon-termico/01-frente.jpg.txt",
      ]) {
        const r = await fetch(`${s.url}${u}`);
        assert.equal(r.status, 404, `${u} dio ${r.status}`);
      }
    } finally {
      await s.cerrar();
    }
  });

  test("no hay listado de carpeta", async () => {
    const s = await levantar();
    try {
      for (const u of ["/imagenes/", "/imagenes/cinturon-termico/"]) {
        const r = await fetch(`${s.url}${u}`);
        assert.equal(r.status, 404);
      }
    } finally {
      await s.cerrar();
    }
  });

  test("se cachean: Meta no vuelve a bajarlas en cada mensaje", async () => {
    const s = await levantar();
    try {
      const r = await fetch(`${s.url}/imagenes/cinturon-termico/01-frente.jpg`);
      assert.match(r.headers.get("cache-control") || "", /max-age=\d{5,}/);
      assert.ok(r.headers.get("etag"), "sin etag");
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    } finally {
      await s.cerrar();
    }
  });

  test("la ruta de imagenes NO exige sesion del panel", async () => {
    // Si la pidiera, Meta recibiria un 401 y el mensaje fallaria.
    const s = await levantar();
    try {
      const sinNada = await fetch(`${s.url}/imagenes/cinturon-termico/02-puesto.jpg`);
      assert.equal(sinNada.status, 200);
      // Y el panel sigue cerrado, que es lo que si tiene que estarlo.
      assert.equal((await fetch(`${s.url}/panel`)).status, 401);
    } finally {
      await s.cerrar();
    }
  });
});

module.exports = {};
