"use strict";

// ==========================================================================
// PRESENTAR LA TIENDA Y LO QUE SE SABE DE CADA PRODUCTO
//
// Modulo puro: recibe el catalogo ya cargado y devuelve texto. Sin I/O.
//
// POR QUE EXISTE (2026-11-11). Con el numero nuevo en produccion, Marco
// escribio «hola» y «qué vendes» y el bot le contesto el precio de una
// unidad y «¿Para qué ciudad sería?», sin decir NUNCA que producto era. Dos
// causas, las dos de una tienda que se penso con un solo producto:
//
//   · `UNICO_ACTIVO` asumia el cinturon ante una pregunta por la TIENDA.
//   · Ningun texto sabia nombrar «lo que vendemos»: el arranque daba la
//     cifra y el color, y el nombre del producto no aparecia.
//
// Todo lo de aqui sale del catalogo. No hay un solo nombre de producto
// escrito en este archivo, a proposito: el dia que entre el champu, o el
// decimo producto, esto tiene que funcionar sin tocarlo.
// ==========================================================================

const cotizador = require("../dominio/cotizador");

/** Formato de pesos colombiano, igual que el resto del bot. */
function pesos(n) {
  return `$${Number(n).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

/**
 * Lo que es el producto, en una frase corta.
 *
 * `enUnaFrase` es un campo del catalogo, aprobado como cualquier otro texto
 * que va al cliente. Si falta, se usa la primera frase de
 * `descripcionAutorizada`, que tambien esta aprobada. Nunca se inventa.
 */
function enUnaFrase(producto) {
  if (!producto) return "";
  const propia = typeof producto.enUnaFrase === "string" ? producto.enUnaFrase.trim() : "";
  if (propia) return propia.replace(/[.\s]+$/, "");
  const desc = String(producto.descripcionAutorizada || "").trim();
  if (!desc) return "";
  const primera = desc.split(/(?<=\.)\s+/)[0] || desc;
  // En minuscula inicial: va detras del nombre ("Cinturón térmico NOVIKA: ...").
  return primera.replace(/[.\s]+$/, "").replace(/^\p{Lu}/u, (c) => c.toLowerCase());
}

/**
 * Precio de una unidad, SOLO si el cotizador lo da.
 *
 * Se cotiza sin destino a proposito: el precio que se presenta es el de la
 * ficha. Si el producto cobra el envio aparte, el cotizador lo dice en
 * `condiciones` y aqui no se afirma que va incluido.
 */
function precioDeUna(producto) {
  try {
    const r = cotizador.cotizar({ producto, cantidad: 1 });
    if (r && r.ok && r.cotizacion) return r.cotizacion;
  } catch {
    /* sin precio: no se nombra ninguna cifra */
  }
  return null;
}

/**
 * Una linea por producto: nombre, que es, y precio si lo hay.
 *
 * @returns {{texto: string, importes: number[]}} los importes que nombra,
 *   para que el filtro de importes los acepte.
 */
function lineaDeProducto(producto) {
  const nombre = producto.nombre || producto.nombreCorto || producto.id;
  const que = enUnaFrase(producto);
  const cot = precioDeUna(producto);
  const partes = [`${nombre}${que ? `: ${que}` : ""}`];
  const importes = [];
  if (cot) {
    const c = cot.condiciones || {};
    const incluido = c.envioIncluido && !cot.envio;
    partes.push(`${pesos(cot.total)}${incluido ? " con envío incluido" : ""}`);
    importes.push(...(cot.importesAutorizados || []));
  }
  return { texto: partes.join(", "), importes };
}

/**
 * ¿Algun producto activo se paga al recibir? Se dice una vez para toda la
 * lista, no en cada linea.
 */
function todosContraentrega(activos) {
  return activos.length > 0 && activos.every((p) => p && p.pago && p.pago.metodo === "contraentrega");
}

/**
 * El mensaje que presenta la tienda: lo que se vende y cual le interesa.
 *
 * No pide ningun dato. Quien pregunta que vendemos todavia no eligio nada, y
 * pedirle la ciudad ahi es lo que Marco vio el 2026-11-11.
 *
 * @param {object} catalogo  el catalogo cargado (usa `activos`)
 * @param {object} [opc]
 * @param {boolean} [opc.saludar]  abrir con "¡Hola!" (primer mensaje)
 * @param {string|null} [opc.nombre]  nombre de pila YA validado
 * @param {boolean} [opc.conFotos]  las fotos salen en este turno: se anuncian
 * @returns {{texto: string, importes: number[], productos: string[]}}
 */
function presentarTienda(catalogo, { saludar = false, nombre = null, conFotos = false } = {}) {
  const activos = ((catalogo && catalogo.activos) || []).filter(Boolean);
  const hola = saludar ? (nombre ? `¡Hola, ${nombre}! 😊` : "¡Hola! 😊") : "";

  if (!activos.length) {
    return {
      texto: `${hola ? hola + " " : ""}En este momento estamos actualizando el catálogo. Cuéntame qué estás buscando y una persona del equipo te responde por aquí.`.trim(),
      importes: [],
      productos: [],
    };
  }

  const importes = [];
  const lineas = activos.map((p) => {
    const l = lineaDeProducto(p);
    importes.push(...l.importes);
    return l.texto;
  });
  const pagas = todosContraentrega(activos) ? "Y pagas cuando lo recibes." : "";
  // Solo si salen de verdad en este turno: prometer fotos que la
  // deduplicacion no reenvia fue un defecto del 10-oct.
  const fotos = conFotos ? "Te mando unas fotos." : "";
  const antesDeLaPregunta = [pagas, fotos].filter(Boolean).join(" ");

  let cuerpo;
  if (activos.length === 1) {
    // La pregunta es ABIERTA a proposito: con un solo producto no hay
    // "cual", y un "¿te cuento más?" se contesta con un «sí» que no dice
    // nada. «¿Qué te gustaría saber?» deja que pregunte lo que le importa.
    const art = (String(activos[0].nombreCorto || "").match(/^(el|la|los|las)\s/i) || [])[1];
    cuerpo = `En NOVIKA tenemos ${art ? art.toLowerCase() + " " : ""}${lineas[0]}.${antesDeLaPregunta ? " " + antesDeLaPregunta : ""} ¿Qué te gustaría saber? 🙌`;
  } else {
    // Sin viñetas: en WhatsApp una lista corta numerada se lee bien y deja
    // contestar con el numero.
    const lista = lineas.map((l, i) => `${i + 1}. ${l}`).join("\n");
    cuerpo = `En NOVIKA tenemos:\n${lista}\n${antesDeLaPregunta ? antesDeLaPregunta + " " : ""}¿Cuál te interesa? 🙌`;
  }

  return {
    texto: hola ? `${hola} ${cuerpo}` : cuerpo,
    importes: [...new Set(importes)],
    productos: activos.map((p) => p.id),
  };
}

// --------------------------------------------------------------------------
// LO QUE EL MODELO PUEDE AFIRMAR DE UN PRODUCTO
//
// El guion solo llevaba `descripcionAutorizada` y `caracteristicasAutorizadas`.
// Todo lo demas que Marco aprobo -para que sirve, como se usa, material,
// energia, garantia, cuidado- estaba en el catalogo y el modelo no lo veia,
// asi que ante «¿cómo funciona?» solo podia improvisar o callarse.
//
// Se recoge de forma GENERICA: cualquier bloque de la ficha que tenga un
// campo `texto` es un texto aprobado para el cliente (es la convencion de
// todo el catalogo). Lo que empieza por "_" son notas internas y no entra.
// Un bloque con `activa: false` o `activo: false` esta apagado y tampoco.
// --------------------------------------------------------------------------

/** Bloques que nunca son texto para el cliente aunque traigan `texto`. */
const NO_SON_PARA_EL_CLIENTE = new Set([
  "datosConfirmados",
  "claimsProhibidos",
  "claimsPermitidos",
  "aliases",
  "precios",
  "imagenes",
  "pendientes",
  "sinDatoConfirmado",
  "promociones",
]);

/** Campos de un bloque que tambien son frases para el cliente. */
const ES_FRASE = /^(texto\w*|recomendacion|ruido|discrecion|matiz\w*)$/;

function textosAutorizados(producto) {
  if (!producto || typeof producto !== "object") return [];
  const salida = [];
  const add = (etiqueta, v) => {
    const t = typeof v === "string" ? v.trim() : "";
    if (t) salida.push(`${etiqueta}: ${t}`);
  };

  for (const [clave, valor] of Object.entries(producto)) {
    if (clave.startsWith("_") || NO_SON_PARA_EL_CLIENTE.has(clave)) continue;
    if (!valor || typeof valor !== "object" || Array.isArray(valor)) continue;
    if (valor.activa === false || valor.activo === false) continue;
    for (const [sub, v] of Object.entries(valor)) {
      if (sub.startsWith("_") || !ES_FRASE.test(sub)) continue;
      add(sub === "texto" ? clave : `${clave}.${sub}`, v);
    }
    // Un nivel mas, para logistica.tiempoDeEntrega y logistica.recogeEnOficina.
    for (const [sub, v] of Object.entries(valor)) {
      if (sub.startsWith("_") || !v || typeof v !== "object" || Array.isArray(v)) continue;
      if (v.activa === false || v.activo === false) continue;
      if (typeof v.texto === "string") add(`${clave}.${sub}`, v.texto);
    }
  }

  if (typeof producto.garantia === "string" && producto.garantia.trim()) {
    const cubre = producto.garantiaCubre ? ` por ${producto.garantiaCubre}` : "";
    add("garantia", `${producto.garantia}${cubre}`);
  }
  add("garantia.tramite", producto.garantiaComoSeTramita);
  if (Array.isArray(producto.garantiaNoCubre) && producto.garantiaNoCubre.length) {
    add("garantia.noCubre", producto.garantiaNoCubre.join(", "));
  }
  if (Array.isArray(producto.contenidoDelPaquete) && producto.contenidoDelPaquete.length) {
    add("contenidoDelPaquete", producto.contenidoDelPaquete.join(", "));
  }
  if (producto.seguridad && Array.isArray(producto.seguridad.avisos) && producto.seguridad.avisos.length) {
    add("seguridad.avisos", producto.seguridad.avisos.join(" "));
  }
  return salida;
}

module.exports = { presentarTienda, enUnaFrase, lineaDeProducto, precioDeUna, textosAutorizados, pesos };
