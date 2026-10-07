"use strict";

// ==========================================================================
// IMAGENES DE PRODUCTO PARA WHATSAPP
//
// Convierte la ruta que guarda el catalogo -relativa al repositorio- en la
// URL absoluta que Meta necesita, y comprueba que de verdad se pueda
// mandar.
//
// --------------------------------------------------------------------------
// POR QUE EXISTE ESTE MODULO
// --------------------------------------------------------------------------
//
// Mandar una foto por la Cloud API tiene dos caminos:
//
//   - `link`: se le pasa una URL y Meta la descarga con SUS servidores.
//   - subir el archivo y usar el `media id` que devuelve.
//
// Con `link` la URL tiene que ser ABSOLUTA, PUBLICA y HTTPS. Una ruta
// relativa, o una que pida credenciales, da un error 131053 ("Media upload
// error") y el mensaje no llega — y eso pasa DESPUES de que el cliente haya
// preguntado por el producto.
//
// Los requisitos de Meta (jpeg o png, 8 bits RGB, maximo 5 MB) ya los
// comprueba el esquema al cargar el catalogo. Aqui se comprueba lo otro: que
// el archivo exista en ESTE despliegue y que haya una URL publica con la que
// construir el enlace.
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");

const { RAIZ_IMAGENES, MAX_BYTES_IMAGEN, formatoReal } = require("./esquema");

/** Donde viven los archivos, en el disco de este despliegue. */
const RAIZ_EN_DISCO = path.join(__dirname, "..", "..", RAIZ_IMAGENES);

/** La ruta publica es /imagenes/<lo que siga a catalogo/imagenes/>. */
function rutaPublica(archivo) {
  const relativa = String(archivo || "").replace(new RegExp(`^${RAIZ_IMAGENES}/`), "");
  return `/imagenes/${relativa}`;
}

/**
 * URL absoluta de una imagen, o null si no se puede construir.
 *
 * Devuelve null -y no una URL a medias- cuando falta la base: una URL
 * relativa enviada a Meta es un error 131053 con el cliente esperando.
 */
function urlDeImagen(archivo, urlPublica) {
  const base = String(urlPublica || "").replace(/\/+$/, "");
  if (!base) return null;
  return `${base}${rutaPublica(archivo)}`;
}

/**
 * ¿Se puede mandar esta imagen AHORA?
 *
 * Comprueba lo que depende del despliegue, no del catalogo:
 *   - el archivo existe en este disco;
 *   - pesa menos de 5 MB;
 *   - es jpeg o png por sus bytes;
 *   - hay URL publica con la que construir el enlace.
 */
function revisarImagen(archivo, urlPublica) {
  const problemas = [];
  const absoluta = path.join(__dirname, "..", "..", archivo);

  let bytes = null;
  try {
    bytes = fs.statSync(absoluta).size;
  } catch {
    problemas.push("el archivo no existe en este despliegue");
  }

  if (bytes !== null && bytes > MAX_BYTES_IMAGEN) {
    problemas.push(`pesa ${Math.round(bytes / 1024)} KB y Meta no acepta mas de 5 MB`);
  }

  const real = bytes === null ? null : formatoReal(absoluta);
  if (bytes !== null && !real) {
    problemas.push("no es jpeg ni png por sus bytes");
  }

  const url = urlDeImagen(archivo, urlPublica);
  if (!url) {
    problemas.push(
      "no hay URL publica configurada (URL_PUBLICA o RENDER_EXTERNAL_URL): sin ella Meta no puede descargar la foto"
    );
  } else if (!/^https:\/\//i.test(url)) {
    // Meta exige HTTPS. En local la URL sera http y eso esta bien para
    // probar, pero tiene que decirse para que nadie crea que esta listo.
    problemas.push(`la URL no es HTTPS (${url.split("/imagenes/")[0]}); Meta solo descarga por HTTPS`);
  }

  return {
    archivo,
    url,
    bytes,
    mime: real ? real.mime : null,
    sePuedeEnviar: problemas.length === 0,
    problemas,
  };
}

/** Revisa todas las imagenes de un producto. */
function revisarProducto(producto, urlPublica) {
  const imagenes = (producto && producto.imagenes) || [];
  const revisadas = imagenes.map((img) => ({ ...revisarImagen(img.archivo, urlPublica), alt: img.alt || null }));
  return {
    productoId: producto && producto.id,
    cuantas: revisadas.length,
    enviables: revisadas.filter((r) => r.sePuedeEnviar).length,
    todasEnviables: revisadas.length > 0 && revisadas.every((r) => r.sePuedeEnviar),
    imagenes: revisadas,
  };
}

module.exports = { RAIZ_EN_DISCO, rutaPublica, urlDeImagen, revisarImagen, revisarProducto };
