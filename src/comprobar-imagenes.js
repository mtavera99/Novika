"use strict";

// ==========================================================================
// npm run comprobar-imagenes
//
// ¿Se pueden mandar las fotos del catalogo por WhatsApp?
//
// Comprueba lo que depende del archivo y del despliegue -que exista, que
// sea jpeg o png por sus BYTES, que no pase de 5 MB, que haya URL publica-
// y, si se le pasa --descargar, se baja cada foto de su URL publica igual
// que lo haria Meta.
//
// Eso ultimo es lo que de verdad importa: el esquema puede estar perfecto y
// la URL seguir dando 404 porque la carpeta no se desplego o porque una ruta
// cambio. Comprobarlo aqui convierte un fallo en la conversacion de una
// venta -error 131053 con el cliente esperando- en un fallo al ejecutar un
// comando.
//
// NO envia ningun mensaje. Solo descarga.
// ==========================================================================

const { config } = require("./config");
const { cargarCatalogo } = require("./catalogo");
const imagenes = require("./catalogo/imagenes");

const si = (v) => (v ? "si" : "NO");

async function principal() {
  const descargar = process.argv.includes("--descargar");
  const problemas = [];

  console.log("");
  console.log("NOVIKA · comprobacion de imagenes del catalogo");
  console.log("".padEnd(70, "-"));

  const base = config.urlPublica;
  console.log(`  URL publica ................ ${base || "(sin configurar)"}`);
  if (!base) {
    problemas.push(
      "no hay URL publica (URL_PUBLICA o RENDER_EXTERNAL_URL). Sin ella Meta no puede descargar las fotos."
    );
  } else if (!/^https:\/\//i.test(base)) {
    problemas.push(`la URL publica no es HTTPS (${base}). Meta solo descarga por HTTPS.`);
  }

  const catalogo = cargarCatalogo();
  const todos = catalogo.productos || catalogo.todos || [];
  console.log(`  productos en el catalogo ... ${todos.length} (${catalogo.activos.length} activo/s)`);
  if (catalogo.problemas.length) {
    console.log(`  problemas del catalogo ..... ${catalogo.problemas.length}`);
    for (const p of catalogo.problemas) problemas.push(String(p));
  }
  console.log("");

  let totalFotos = 0;
  let totalEnviables = 0;

  for (const producto of todos) {
    const r = imagenes.revisarProducto(producto, base);
    if (!r.cuantas) {
      console.log(`  ${producto.id}: sin fotos`);
      continue;
    }
    console.log(`  ${producto.id}${producto.activo ? "" : "  (borrador: activo=false)"}`);

    for (const img of r.imagenes) {
      totalFotos++;
      const kb = img.bytes === null ? "?" : `${Math.round(img.bytes / 1024)} KB`;
      let estado = img.sePuedeEnviar ? "ok" : `NO: ${img.problemas.join("; ")}`;

      // La prueba de verdad: bajarla como lo haria Meta.
      if (descargar && img.url && /^https:\/\//i.test(img.url)) {
        try {
          const resp = await fetch(img.url, { redirect: "follow" });
          const tipo = resp.headers.get("content-type") || "";
          if (!resp.ok) {
            estado = `NO: la URL devolvio HTTP ${resp.status}`;
            problemas.push(`${img.archivo}: la URL publica devolvio HTTP ${resp.status}`);
          } else if (!/^image\/(jpeg|png)$/i.test(tipo)) {
            estado = `NO: la URL devolvio ${tipo}`;
            problemas.push(`${img.archivo}: la URL devolvio ${tipo} y Meta solo acepta jpeg o png`);
          } else {
            const cuerpo = Buffer.from(await resp.arrayBuffer());
            const esJpeg = cuerpo[0] === 0xff && cuerpo[1] === 0xd8 && cuerpo[2] === 0xff;
            const esPng = cuerpo[0] === 0x89 && cuerpo[1] === 0x50;
            if (!esJpeg && !esPng) {
              estado = "NO: lo que llego no es una imagen";
              problemas.push(`${img.archivo}: la URL no devolvio una imagen`);
            } else {
              estado = `ok · descargada ${Math.round(cuerpo.length / 1024)} KB`;
            }
          }
        } catch (e) {
          estado = `NO: no se pudo descargar (${e.message})`;
          problemas.push(`${img.archivo}: no se pudo descargar de su URL publica (${e.message})`);
        }
      }

      if (!img.sePuedeEnviar) for (const p of img.problemas) problemas.push(`${img.archivo}: ${p}`);
      if (estado.startsWith("ok")) totalEnviables++;

      console.log(`    ${String(kb).padStart(7)}  ${img.mime || "?"}  ${estado}`);
      console.log(`             ${img.url || "(sin URL)"}`);
    }
    console.log("");
  }

  console.log("".padEnd(70, "-"));
  console.log(`  fotos ...................... ${totalFotos}`);
  console.log(`  enviables .................. ${totalEnviables}/${totalFotos}`);
  console.log(`  descarga real comprobada ... ${si(descargar)}`);

  if (problemas.length) {
    console.log("");
    console.log("  PROBLEMAS:");
    for (const p of [...new Set(problemas)]) console.log(`    [X] ${p}`);
  }

  console.log("");
  if (!descargar) {
    console.log("  Para comprobar que Meta podria descargarlas de verdad:");
    console.log("    npm run comprobar-imagenes -- --descargar");
    console.log("");
  }

  if (problemas.length) process.exit(1);
}

principal().catch((e) => {
  console.error("");
  console.error(`  La comprobacion fallo: ${e.message}`);
  console.error("");
  process.exit(1);
});
