"use strict";

// ==========================================================================
// ESQUEMA DE PRODUCTO
//
// NOVIKA vende hogar, tecnologia, bienestar, herramientas, accesorios y lo
// que venga. Por eso el producto es DATO, no codigo: un archivo JSON por
// producto en /catalogo/productos. Añadir un producto no es desplegar.
//
// En BIKERPRO los productos viven en un objeto literal dentro de un .js de
// 875 lineas, y encima hay un segundo catalogo (el CSV del feed de Meta) que
// puede divergir del motor de precios: su propio README admite que un
// producto esta en el feed pero su precio no esta automatizado. Un catalogo
// que puede contradecirse a si mismo es una fuente de cobros incorrectos.
// Aqui la fuente de verdad es una sola, y el feed de Meta se GENERARA desde
// ella cuando haga falta.
//
// La regla que mas importa de todo este archivo:
//
//   UN PRODUCTO NO PUEDE ESTAR ACTIVO SI LE FALTA UN DATO CRITICO.
//
// Un producto con `activo: true` y `precios` vacio no es un borrador
// incompleto: es un cobro incorrecto esperando a pasar. Por eso la
// validacion es asimetrica: borrador -> permisivo; activo -> estricto.
// ==========================================================================

/** Los unicos motores de precio que el sistema sabe aplicar. */
const MOTORES_DE_PRECIO = ["tabla", "producto_mas_envio"];

/** Niveles de confianza de una señal (alias) de producto. */
const CONFIANZAS = ["alta", "media", "baja"];

/**
 * Forma de un producto. Esto es documentacion ejecutable: la validacion de
 * abajo la hace cumplir.
 *
 *  id                        string   obligatorio, unico, minusculas-con-guiones
 *  nombre                    string   obligatorio
 *  nombreCorto               string   como lo nombra el bot en una frase
 *  categoria                 string   obligatorio: hogar | tecnologia | bienestar | herramientas | accesorios | ...
 *  activo                    boolean  obligatorio. true = el bot puede venderlo HOY
 *
 *  aliases                   array    [{ patron, confianza, senal }]
 *                                     `patron` es una expresion regular en texto.
 *                                     Un alias ambiguo entre dos productos NO es alias.
 *
 *  descripcionAutorizada     string   lo que el bot puede decir del producto
 *  caracteristicasAutorizadas array   frases afirmables, una por elemento
 *  datosConfirmados          objeto   { clave: { preguntas: [...], respuesta: "..." } }
 *                                     respuesta literal y aprobada
 *  sinDatoConfirmado         array    terminos que obligan a "te lo confirmo",
 *                                     aunque la frase toque tambien un dato confirmado
 *
 *  motorDePrecio             string   uno de MOTORES_DE_PRECIO
 *  precios                   objeto   { "1": 00000, "2": 00000 }  cantidad -> precio total
 *  ofertaPrincipal           string   como se presenta la oferta
 *  promociones               array    [{ id, descripcion, desde, hasta, condiciones }]
 *
 *  variantes                 array    [{ clave, etiqueta, obligatoria, opciones: [] }]
 *                                     generico a proposito: talla, color, voltaje, sabor...
 *
 *  logistica                 objeto   { pesoGr, dimensionesCm: {largo,ancho,alto},
 *                                       politicaEnvio: { tipo, hastaUnidades,
 *                                                        provisional, porQue,
 *                                                        noHeredar: [], revisarCuando } }
 *
 *  faq                       array    [{ pregunta, respuesta }]
 *  garantia                  string
 *  restricciones             array    donde no se vende, que no se promete
 *  pendientes                array    TODOs explicitos. Si tiene alguno, no puede estar activo.
 */

function esTexto(v) {
  return typeof v === "string" && v.trim() !== "";
}

function esListaDeTexto(v) {
  return Array.isArray(v) && v.every(esTexto);
}

/**
 * Valida un producto.
 * @returns {{errores: string[], avisos: string[]}}
 */
function validarProducto(p, origen = "(sin origen)") {
  const errores = [];
  const avisos = [];
  const donde = (campo) => `${origen} -> ${campo}`;

  // ---- Siempre obligatorio, borrador incluido ----
  if (!esTexto(p && p.id)) {
    errores.push(`${donde("id")}: falta. Sin id no se puede estampar el producto en un pedido.`);
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id)) {
    errores.push(`${donde("id")}: "${p.id}" debe ser minusculas-con-guiones, sin espacios ni acentos.`);
  }
  if (!esTexto(p && p.nombre)) errores.push(`${donde("nombre")}: falta.`);
  if (!esTexto(p && p.categoria)) errores.push(`${donde("categoria")}: falta.`);
  if (typeof (p && p.activo) !== "boolean") {
    errores.push(`${donde("activo")}: debe ser true o false, explicito. No se asume.`);
  }

  // ---- Coherencia de los campos que esten presentes ----
  for (const alias of Array.isArray(p && p.aliases) ? p.aliases : []) {
    if (!esTexto(alias && alias.patron)) {
      errores.push(`${donde("aliases")}: hay un alias sin "patron".`);
      continue;
    }
    try {
      new RegExp(alias.patron, "i");
    } catch (e) {
      errores.push(`${donde("aliases")}: el patron ${JSON.stringify(alias.patron)} no es una expresion regular valida (${e.message}).`);
    }
    if (alias.confianza && !CONFIANZAS.includes(alias.confianza)) {
      errores.push(`${donde("aliases")}: confianza "${alias.confianza}" no valida. Usa: ${CONFIANZAS.join(", ")}.`);
    }
  }

  if (p && p.motorDePrecio !== undefined && !MOTORES_DE_PRECIO.includes(p.motorDePrecio)) {
    errores.push(`${donde("motorDePrecio")}: "${p.motorDePrecio}" no existe. Usa: ${MOTORES_DE_PRECIO.join(", ")}.`);
  }

  if (p && p.precios !== undefined) {
    if (typeof p.precios !== "object" || p.precios === null || Array.isArray(p.precios)) {
      errores.push(`${donde("precios")}: debe ser un objeto { "1": precio, "2": precio }.`);
    } else {
      for (const [cantidad, precio] of Object.entries(p.precios)) {
        if (!/^\d+$/.test(cantidad) || Number(cantidad) < 1) {
          errores.push(`${donde("precios")}: la clave "${cantidad}" debe ser una cantidad entera positiva.`);
        }
        if (!Number.isInteger(precio) || precio <= 0) {
          errores.push(
            `${donde("precios")}: el precio de "${cantidad}" debe ser un entero positivo en pesos, sin decimales ni separadores.`
          );
        }
      }
    }
  }

  for (const v of Array.isArray(p && p.variantes) ? p.variantes : []) {
    if (!esTexto(v && v.clave)) errores.push(`${donde("variantes")}: hay una variante sin "clave".`);
    if (!Array.isArray(v && v.opciones) || !v.opciones.length) {
      errores.push(`${donde("variantes")}: la variante "${(v && v.clave) || "?"}" no tiene opciones.`);
    }
    if (typeof (v && v.obligatoria) !== "boolean") {
      avisos.push(`${donde("variantes")}: "${(v && v.clave) || "?"}" no dice si es obligatoria; se asumira que no.`);
    }
  }

  if (p && p.sinDatoConfirmado !== undefined && !esListaDeTexto(p.sinDatoConfirmado)) {
    errores.push(`${donde("sinDatoConfirmado")}: debe ser una lista de textos.`);
  }
  if (p && p.caracteristicasAutorizadas !== undefined && !esListaDeTexto(p.caracteristicasAutorizadas)) {
    errores.push(`${donde("caracteristicasAutorizadas")}: debe ser una lista de textos.`);
  }
  if (p && p.pendientes !== undefined && !esListaDeTexto(p.pendientes)) {
    errores.push(`${donde("pendientes")}: debe ser una lista de textos.`);
  }

  // ---- Exigencias SOLO para productos activos ----
  if (p && p.activo === true) {
    const pendientes = Array.isArray(p.pendientes) ? p.pendientes : [];
    if (pendientes.length) {
      errores.push(
        `${donde("activo")}: no puede estar activo con ${pendientes.length} pendiente(s) sin resolver: ${pendientes.join("; ")}`
      );
    }
    if (!esTexto(p.descripcionAutorizada)) {
      errores.push(`${donde("descripcionAutorizada")}: obligatoria para un producto activo. Sin ella el bot improvisa.`);
    }
    if (!esTexto(p.motorDePrecio)) {
      errores.push(`${donde("motorDePrecio")}: obligatorio para un producto activo.`);
    }
    if (!p.precios || !Object.keys(p.precios).length) {
      errores.push(`${donde("precios")}: un producto activo sin precios acabaria cotizandose mal.`);
    } else if (p.precios["1"] === undefined) {
      errores.push(`${donde("precios")}: falta el precio de 1 unidad, que es el caso mas comun.`);
    }
    const politica = p.logistica && p.logistica.politicaEnvio;
    if (!politica || !esTexto(politica.tipo)) {
      errores.push(`${donde("logistica.politicaEnvio.tipo")}: obligatorio para un producto activo.`);
    } else if (politica.provisional === true && !esTexto(politica.revisarCuando)) {
      avisos.push(
        `${donde("logistica.politicaEnvio")}: marcada como provisional sin "revisarCuando". Una decision provisional sin fecha de revision se vuelve permanente.`
      );
    }
    if (!Array.isArray(p.aliases) || !p.aliases.length) {
      avisos.push(
        `${donde("aliases")}: sin alias, el producto solo se identificara por el anuncio de origen. Añade al menos uno.`
      );
    }
  }

  return { errores, avisos };
}

/** Valida el catalogo completo: lo de cada producto mas lo que es global. */
function validarCatalogo(productos) {
  const errores = [];
  const avisos = [];
  const vistos = new Map();

  for (const { producto, origen } of productos) {
    const r = validarProducto(producto, origen);
    errores.push(...r.errores);
    avisos.push(...r.avisos);

    const id = producto && producto.id;
    if (id) {
      if (vistos.has(id)) {
        errores.push(`id duplicado "${id}": esta en ${vistos.get(id)} y en ${origen}. Un id apunta a un producto y solo uno.`);
      } else {
        vistos.set(id, origen);
      }
    }
  }

  // Candado anti-contaminacion: ninguna constante logistica declarada como
  // "no heredable" por un producto puede aparecer en otro. En un catalogo
  // multicategoria, un articulo de hogar voluminoso y un accesorio pequeño
  // no comparten tarifa, y heredarla en silencio es un cobro incorrecto.
  for (const { producto, origen } of productos) {
    const noHeredar =
      (producto && producto.logistica && producto.logistica.politicaEnvio && producto.logistica.politicaEnvio.noHeredar) || [];
    for (const constante of noHeredar) {
      for (const otro of productos) {
        if (otro.producto === producto) continue;
        const politicaAjena = (otro.producto && otro.producto.logistica && otro.producto.logistica.politicaEnvio) || {};
        if (politicaAjena.tipo === constante) {
          errores.push(
            `${origen} declara que "${constante}" no se hereda, pero ${otro.origen} lo usa como politica de envio. Uno de los dos esta mal.`
          );
        }
      }
    }
  }

  return { errores, avisos };
}

module.exports = { validarProducto, validarCatalogo, MOTORES_DE_PRECIO, CONFIANZAS };
