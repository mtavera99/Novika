"use strict";

// ==========================================================================
// CARGA DEL CATALOGO
//
// Lee /catalogo/productos/*.json, valida y devuelve un catalogo en memoria.
//
// Tres decisiones y su motivo:
//
//   1. NO HAY PRODUCTO POR DEFECTO. BIKERPRO tiene
//      PRODUCTO_POR_DEFECTO = "impermeable", y le funciona porque durante
//      meses vendio una sola cosa. En un catalogo multicategoria, adivinar
//      el producto es despachar el equivocado. Si no se puede identificar,
//      se pregunta.
//
//   2. Los archivos que empiezan por "_" se ignoran. Asi la plantilla
//      (_plantilla.json) puede vivir al lado de los productos reales sin
//      entrar al catalogo.
//
//   3. Un archivo invalido NO tumba el catalogo. Se registra el problema y
//      el producto queda fuera. Que un producto nuevo mal escrito deje al
//      bot sin contestarle a nadie es peor que vender uno menos.
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");
const { validarCatalogo } = require("./esquema");

const CARPETA = path.join(__dirname, "..", "..", "catalogo", "productos");

let cache = null;

function compilarAliases(producto) {
  return (producto.aliases || [])
    .map((a) => {
      try {
        return { ...a, re: new RegExp(a.patron, "i") };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * @param {{carpeta?: string, refrescar?: boolean}} opciones
 * @returns {{productos: object[], activos: object[], porId: Map, problemas: string[], avisos: string[]}}
 */
function cargarCatalogo(opciones = {}) {
  const carpeta = opciones.carpeta || CARPETA;
  if (cache && !opciones.refrescar && !opciones.carpeta) return cache;

  const problemas = [];
  const crudos = [];

  let nombres = [];
  try {
    nombres = fs
      .readdirSync(carpeta)
      .filter((n) => n.endsWith(".json") && !n.startsWith("_"))
      .sort();
  } catch (e) {
    problemas.push(`No se pudo leer ${carpeta}: ${e.message}`);
  }

  for (const nombre of nombres) {
    const ruta = path.join(carpeta, nombre);
    try {
      crudos.push({ producto: JSON.parse(fs.readFileSync(ruta, "utf8")), origen: nombre });
    } catch (e) {
      problemas.push(`${nombre}: no es JSON valido (${e.message}). El producto queda fuera del catalogo.`);
    }
  }

  const { errores, avisos } = validarCatalogo(crudos);
  problemas.push(...errores);

  // Solo entran los productos cuyo propio archivo no tiene errores.
  const conErrores = new Set(
    errores.map((e) => String(e).split(" ->")[0].split(":")[0].trim()).filter((n) => n.endsWith(".json"))
  );

  const productos = crudos
    .filter(({ origen }) => !conErrores.has(origen))
    .map(({ producto, origen }) => ({ ...producto, _origen: origen, _aliases: compilarAliases(producto) }));

  const resultado = {
    productos,
    activos: productos.filter((p) => p.activo === true),
    porId: new Map(productos.map((p) => [p.id, p])),
    problemas,
    avisos,
    // Explicito, para que nadie lo "arregle" mas adelante:
    productoPorDefecto: null,
  };

  if (!opciones.carpeta) cache = resultado;
  return resultado;
}

/** Busca por id. Devuelve null si no existe: no inventa un sustituto. */
function productoPorId(id, catalogo = cargarCatalogo()) {
  if (!id) return null;
  return catalogo.porId.get(String(id)) || null;
}

/**
 * Señales de producto encontradas en un texto, de mas a menos confianza.
 * Devuelve TODAS las coincidencias, no una sola: si hay dos productos
 * posibles, quien llame tiene que saberlo para poder preguntar en vez de
 * elegir. Elegir en caso de empate es exactamente como se despacha mal.
 */
function senalesEn(texto, catalogo = cargarCatalogo()) {
  if (!texto) return [];
  const orden = { alta: 0, media: 1, baja: 2 };
  const encontradas = [];

  for (const producto of catalogo.activos) {
    for (const alias of producto._aliases) {
      const m = String(texto).match(alias.re);
      if (m) {
        encontradas.push({
          productoId: producto.id,
          confianza: alias.confianza || "media",
          senal: alias.senal || m[0],
          posicion: m.index,
        });
      }
    }
  }

  return encontradas.sort((a, b) => (orden[a.confianza] ?? 9) - (orden[b.confianza] ?? 9) || a.posicion - b.posicion);
}

function _limpiarCache() {
  cache = null;
}

module.exports = { cargarCatalogo, productoPorId, senalesEn, CARPETA, _limpiarCache };
