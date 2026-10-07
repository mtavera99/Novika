"use strict";

// ==========================================================================
// EXTRACCION HEURISTICA
//
// Modulo puro. Sin I/O, sin IA.
//
// POR QUE EXISTE, SIENDO QUE LA IA YA EXTRAE CANDIDATOS: porque si la
// extraccion depende solo del modelo, un fallo del proveedor significa cero
// ventas. La prioridad 1 de este proyecto es no perder mensajes y la 2 es no
// perder ventas; un camino que se cae con la API de un tercero incumple las
// dos.
//
// Asi que hay dos fuentes de candidatos y se combinan: heuristica e IA.
// Ninguna de las dos CONFIRMA nada -eso lo hace dominio/destino.js-, solo
// proponen.
//
// La regla que gobierna este archivo: ANTE LA DUDA, NO PROPONER. Un campo
// vacio hace que el bot pregunte, que cuesta un mensaje. Un campo mal
// propuesto acaba en una guia equivocada, que cuesta el producto, el flete y
// el cliente.
// ==========================================================================

const { aplanar, cantidadesEn } = require("./texto");
const { CIUDADES_SEMILLA } = require("./destino");

/** Tipos de via, para reconocer una direccion. */
const VIA = /\b(calle|cll|cl|carrera|cra|kra|kr|avenida|av|ave|diagonal|dg|diag|transversal|tv|trans|manzana|mz|circular|circunvalar|autopista|via|vereda|km|kilometro|lote|finca|conjunto|urbanizacion)\b/;

/** Señales de que el cliente esta diciendo una cantidad. */
const SENAL_CANTIDAD = /\b(quiero|quisiera|dame|deme|mandame|mandeme|enviame|envieme|necesito|llevo|llevame|pongame|ponme|serian|seran|son|me\s+das|me\s+manda|pido|pedir)\b/;

/** Señales de que pide UNO. "lo quiero", "me lo llevo", "quiero el ...". */
const SENAL_SINGULAR = /\b(lo|la)\s+(quiero|compro|llevo|tomo|necesito)\b|\bquiero\s+(el|la|uno|una)\b|\bme\s+lo\s+llevo\b|\bun[oa]?\s+(solo|sola|nada\s+mas)\b/;

/** Señales de plural sin numero: "quiero varios". No se adivina cuantos. */
const SENAL_PLURAL_VAGA = /\b(varios|varias|unos|unas|cuantos|algunos|muchos)\b/;

/** Palabras que NO pueden ser el inicio de una direccion aunque lleven numero. */
const FALSAS_DIRECCIONES = /\b(whatsapp|telefono|celular|cedula|documento|nit|numero\s+de\s+guia)\b/;

/**
 * Cantidad propuesta a partir del texto.
 *
 * @returns {{valor: number|null, porQue: string}}
 */
function cantidadEn(textoCrudo) {
  const plano = aplanar(textoCrudo);
  if (!plano) return { valor: null, porQue: "texto vacio" };

  // Una direccion esta llena de numeros. Si el mensaje parece una direccion,
  // no se lee ninguna cantidad de ahi.
  //
  // Esto no es precaucion teorica: la primera version proponia cualquier
  // numero entre 1 y 50, y "vivo en la calle 45" se convertia en 45
  // unidades. La direccion es justo donde mas numeros escribe un cliente.
  if (VIA.test(plano)) return { valor: null, porQue: "el mensaje parece una direccion: sus numeros no son cantidades" };
  if (FALSAS_DIRECCIONES.test(plano)) return { valor: null, porQue: "los numeros del mensaje son un identificador" };

  const esSoloUnNumero = /^\s*\d{1,2}\s*$/.test(String(textoCrudo));

  if (SENAL_CANTIDAD.test(plano) || esSoloUnNumero) {
    const numeros = cantidadesEn(textoCrudo).filter((n) => n.valor >= 1 && n.valor <= 20);
    if (numeros.length) {
      // Varias señales en conflicto ("queria dos, mejor uno"): gana la
      // ultima, que es la correccion del cliente.
      return { valor: numeros[numeros.length - 1].valor, porQue: "cantidad dicha explicitamente" };
    }
  }

  if (SENAL_PLURAL_VAGA.test(plano)) {
    // "quiero varios" no dice cuantos. Adivinar es cobrar mal.
    return { valor: null, porQue: "pide varios sin decir cuantos: hay que preguntar" };
  }

  if (SENAL_SINGULAR.test(plano)) {
    // "lo quiero", "quiero el cinturon": el cliente habla de UNO. No es una
    // invencion, es lo que dice la frase. Y si hubiera duda, la cantidad
    // menor nunca cobra de mas.
    return { valor: 1, porQue: "el cliente habla en singular" };
  }

  return { valor: null, porQue: "no hay ninguna señal de cantidad" };
}

/** Nombres de ciudad conocidos, los mas largos primero para que gane el especifico. */
const NOMBRES_DE_CIUDAD = Object.keys(CIUDADES_SEMILLA).sort((a, b) => b.length - a.length);

/**
 * Ciudad mencionada en el texto, si se reconoce alguna del listado.
 *
 * Solo propone nombres del listado: asi una frase como "por aqui cerca"
 * nunca llega a proponerse como ciudad. Lo que no esta en el listado lo
 * puede proponer la IA, y entonces destino.js lo acepta MARCADO para
 * revision.
 *
 * @returns {{valor: string|null, porQue: string}}
 */
function ciudadEn(textoCrudo) {
  const plano = aplanar(textoCrudo);
  if (!plano) return { valor: null, porQue: "texto vacio" };

  const encontradas = [];
  for (const nombre of NOMBRES_DE_CIUDAD) {
    const re = new RegExp(`\\b${nombre.replace(/\s+/g, "\\s+")}\\b`);
    const m = plano.match(re);
    if (m) encontradas.push({ nombre, posicion: m.index });
  }

  if (!encontradas.length) return { valor: null, porQue: "no se reconoce ninguna ciudad del listado" };

  // Si se mencionan dos ciudades distintas, NO se elige. "soy de Cali pero
  // mandalo a Medellin" tiene dos, y escoger mal es despachar a otra ciudad.
  const distintas = new Set(
    encontradas.filter((e) => !encontradas.some((o) => o.nombre !== e.nombre && o.nombre.includes(e.nombre))).map((e) => e.nombre)
  );
  if (distintas.size > 1) {
    return { valor: null, porQue: `el mensaje menciona ${distintas.size} ciudades: hay que preguntar` };
  }

  return { valor: [...distintas][0], porQue: "ciudad del listado conocido" };
}

/**
 * Direccion mencionada en el texto.
 *
 * Se exige un tipo de via Y un numero. Lo que no cumpla eso no se propone:
 * "mi casa" tiene que llegar vacio para que el bot pregunte, no llegar como
 * candidato para que luego lo rechace la validacion.
 *
 * @returns {{valor: string|null, porQue: string}}
 */
function direccionEn(textoCrudo) {
  const crudo = String(textoCrudo ?? "").trim();
  const plano = aplanar(crudo);
  if (!plano) return { valor: null, porQue: "texto vacio" };
  if (FALSAS_DIRECCIONES.test(plano)) return { valor: null, porQue: "los numeros son un identificador, no una direccion" };

  const m = plano.match(VIA);
  if (!m) return { valor: null, porQue: "no se reconoce ningun tipo de via" };
  if (!/\d/.test(plano.slice(m.index))) {
    return { valor: null, porQue: "hay un tipo de via pero sin numero: no sirve para despachar" };
  }

  // Se recorta sobre el texto CRUDO para conservar tildes y signos: la guia
  // la lee una persona, y "Calle 45 # 23-10" es mas util que "calle 45 23 10".
  const palabraVia = m[0];
  const inicio = crudo.toLowerCase().indexOf(palabraVia);
  if (inicio === -1) return { valor: crudo, porQue: "direccion reconocida" };

  let fragmento = crudo.slice(inicio).trim();

  // Se corta donde empieza otra cosa. "Calle 45 # 23-10, quiero 2" lleva la
  // direccion Y la cantidad; sin este corte, "quiero 2" acabaria impreso en
  // la guia de la transportadora.
  const corte = fragmento.search(
    /[,;.]?\s*\b(quiero|quisiera|necesito|mandame|mandeme|enviame|envieme|dame|deme|llevo|pongame|gracias|mi\s+(telefono|celular|cedula|documento|nombre)|soy)\b/i
  );
  if (corte > 0) fragmento = fragmento.slice(0, corte).trim();

  // Si al final viene una ciudad del listado, se quita: la ciudad va en su
  // propio campo y repetirla en la direccion ensucia la guia.
  const ciudad = ciudadEn(fragmento);
  if (ciudad.valor) {
    const re = new RegExp(`[,;]?\\s*${ciudad.valor.replace(/\s+/g, "\\s+")}\\s*$`, "i");
    fragmento = fragmento.replace(re, "").trim();
  }

  fragmento = fragmento.replace(/[,;.\s]+$/, "").trim();

  if (fragmento.length < 8) return { valor: null, porQue: "lo reconocido es demasiado corto" };
  return { valor: fragmento, porQue: "direccion reconocida" };
}

/**
 * Todos los candidatos que se pueden sacar del texto sin modelo.
 *
 * @returns {{candidatos: object, porQue: object}}
 */
function deTexto(textoCrudo) {
  const candidatos = {};
  const porQue = {};

  const cantidad = cantidadEn(textoCrudo);
  if (cantidad.valor !== null) {
    candidatos.cantidad = cantidad.valor;
  }
  porQue.cantidad = cantidad.porQue;

  const ciudad = ciudadEn(textoCrudo);
  if (ciudad.valor !== null) candidatos.ciudad = ciudad.valor;
  porQue.ciudad = ciudad.porQue;

  const direccion = direccionEn(textoCrudo);
  if (direccion.valor !== null) candidatos.direccion = direccion.valor;
  porQue.direccion = direccion.porQue;

  return { candidatos, porQue };
}

/**
 * Combina los candidatos de la heuristica y los de la IA.
 *
 * LA HEURISTICA GANA cuando las dos proponen algo distinto para el mismo
 * campo. No por desconfianza general en el modelo, sino porque la
 * heuristica solo propone lo que ha reconocido contra una lista o un patron,
 * mientras el modelo propone lo que le parece. Donde la heuristica no llega
 * -nombre, documento, variante, ciudades fuera del listado- el modelo es la
 * unica fuente, y ahi se usa.
 */
function combinar(deHeuristica, deIA) {
  const salida = { ...(deIA || {}) };
  for (const [campo, valor] of Object.entries(deHeuristica || {})) {
    if (valor !== null && valor !== undefined && valor !== "") salida[campo] = valor;
  }
  return salida;
}

module.exports = { deTexto, cantidadEn, ciudadEn, direccionEn, combinar, VIA };
