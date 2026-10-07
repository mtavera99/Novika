"use strict";

// ==========================================================================
// DESTINO: CIUDAD, DEPARTAMENTO Y DIRECCION
//
// Modulo puro. Sin I/O.
//
// Tres reglas, y las tres vienen de errores que cuestan plata:
//
//   1. UNA FRASE NO ES UNA CIUDAD.
//      El modelo, si se le deja, extrae "a mi casa" como direccion y "por
//      aqui cerca" como ciudad. Un pedido con eso en la guia es una
//      devolucion. Aqui una ciudad solo se confirma si se resuelve contra la
//      lista; una direccion, solo si tiene forma de direccion.
//
//   2. CIUDAD AMBIGUA NO SE ADIVINA.
//      En Colombia hay varias "Santa Rosa", varios "San Pedro". Si el nombre
//      resuelve a mas de un departamento, NO se elige: se devuelve la lista
//      para preguntar. Elegir es despachar a otro departamento.
//
//   3. MARCAR, NO BLOQUEAR.
//      Una ciudad que no esta en la lista no tumba el pedido: lo marca para
//      revision. La lista esta incompleta por definicion y perder una venta
//      real por un municipio que falta es el peor resultado posible.
//
// SOBRE LA LISTA: es una semilla de las ciudades principales, marcada como
// incompleta. Son datos geograficos publicos, no politica comercial: aqui NO
// hay cobertura, ni tarifas, ni tiempos de entrega. Eso lo define el dueno y
// vive en el catalogo.
// ==========================================================================

const { aplanar } = require("./texto");

/**
 * Semilla de ciudades principales -> departamento.
 *
 * INCOMPLETA A PROPOSITO. Lo que no esta aqui no se rechaza: se marca para
 * revision humana. Pendiente: cargar el listado completo de municipios.
 */
const CIUDADES_SEMILLA = {
  bogota: ["Bogotá D.C."],
  "bogota dc": ["Bogotá D.C."],
  medellin: ["Antioquia"],
  cali: ["Valle del Cauca"],
  barranquilla: ["Atlántico"],
  cartagena: ["Bolívar"],
  cucuta: ["Norte de Santander"],
  bucaramanga: ["Santander"],
  pereira: ["Risaralda"],
  "santa marta": ["Magdalena"],
  ibague: ["Tolima"],
  manizales: ["Caldas"],
  villavicencio: ["Meta"],
  pasto: ["Nariño"],
  monteria: ["Córdoba"],
  neiva: ["Huila"],
  armenia: ["Quindío"],
  popayan: ["Cauca"],
  sincelejo: ["Sucre"],
  valledupar: ["Cesar"],
  tunja: ["Boyacá"],
  riohacha: ["La Guajira"],
  florencia: ["Caquetá"],
  quibdo: ["Chocó"],
  yopal: ["Casanare"],
  arauca: ["Arauca"],
  mocoa: ["Putumayo"],
  leticia: ["Amazonas"],
  soacha: ["Cundinamarca"],
  bello: ["Antioquia"],
  itagui: ["Antioquia"],
  envigado: ["Antioquia"],
  palmira: ["Valle del Cauca"],
  buenaventura: ["Valle del Cauca"],
  soledad: ["Atlántico"],
  malambo: ["Atlántico"],
  floridablanca: ["Santander"],
  giron: ["Santander"],
  piedecuesta: ["Santander"],
  dosquebradas: ["Risaralda"],
  tulua: ["Valle del Cauca"],
  zipaquira: ["Cundinamarca"],
  facatativa: ["Cundinamarca"],
  chia: ["Cundinamarca"],
  girardot: ["Cundinamarca"],
  duitama: ["Boyacá"],
  sogamoso: ["Boyacá"],
  apartado: ["Antioquia"],
  turbo: ["Antioquia"],
  maicao: ["La Guajira"],
  ipiales: ["Nariño"],
  tumaco: ["Nariño"],
  "san andres": ["Archipiélago de San Andrés"],

  // Homonimos reales: el mismo nombre en varios departamentos. NO se eligen.
  "santa rosa": ["Bolívar", "Cauca", "Antioquia"],
  "san pedro": ["Valle del Cauca", "Sucre", "Antioquia"],
  "la union": ["Valle del Cauca", "Nariño", "Antioquia", "Sucre"],
  "san jose": ["Caldas", "Norte de Santander"],
  "el carmen": ["Norte de Santander", "Chocó"],
  rionegro: ["Antioquia", "Santander"],
  "puerto rico": ["Caquetá", "Meta"],
  albania: ["La Guajira", "Caquetá", "Santander"],
};

const LISTA_INCOMPLETA = true;

/** Frases que NO son una ciudad aunque el modelo las proponga. */
const NO_SON_CIUDAD = [
  /^(mi|la|el)\s+(casa|apartamento|apto|oficina|trabajo|finca)/,
  /^(aca|aqui|alla|ahi)\b/,
  /^(por\s+)?(aqui|aca|alla)\s+cerca/,
  /^(donde|lo\s+que|como)\b/,
  /^(si|no|ok|listo|gracias|hola|buenas)\b/,
  /^(el\s+)?mismo\b/,
  /^(contraentrega|contra\s+entrega|efectivo|nequi|transferencia)\b/,
  /^\d+$/, // un numero suelto no es una ciudad
];

/** Frases que NO son una direccion. */
const NO_SON_DIRECCION = [
  /^(mi|la|el)\s+(casa|apartamento|apto|oficina|trabajo)\s*$/,
  /^(aca|aqui|alla|ahi|donde\s+siempre|la\s+misma)\s*$/,
  /^(el\s+)?mismo\s*$/,
  /^(si|no|ok|listo|gracias)\s*$/,
  /^(contraentrega|contra\s+entrega|efectivo)\s*$/,
];

/**
 * Resuelve una ciudad.
 *
 * @param {string} texto
 * @param {string} [departamentoSugerido] para desambiguar homonimos
 * @returns {{ok: boolean, ciudad?: string, departamento?: string,
 *            ambigua?: boolean, opciones?: string[], revisar?: boolean, motivo?: string}}
 */
function resolverCiudad(texto, departamentoSugerido = null) {
  const plano = aplanar(texto);
  if (!plano) return { ok: false, motivo: "vacio" };

  if (NO_SON_CIUDAD.some((re) => re.test(plano))) {
    return { ok: false, motivo: `"${String(texto).slice(0, 40)}" no es el nombre de una ciudad` };
  }

  const departamentos = CIUDADES_SEMILLA[plano];

  if (!departamentos) {
    // No esta en la semilla. NO se rechaza: la lista esta incompleta y
    // rechazar seria perder una venta por un municipio que falta. Se acepta
    // marcado para que una persona lo revise antes de despachar.
    return {
      ok: true,
      ciudad: titular(plano),
      departamento: departamentoSugerido || null,
      revisar: true,
      motivo: "la ciudad no esta en el listado conocido: revisar antes de despachar",
    };
  }

  if (departamentos.length === 1) {
    return { ok: true, ciudad: titular(plano), departamento: departamentos[0], revisar: false };
  }

  // Homonimo. Si el cliente ya dijo el departamento y encaja, se resuelve.
  if (departamentoSugerido) {
    const planoSug = aplanar(departamentoSugerido);
    const encaje = departamentos.find((d) => aplanar(d) === planoSug);
    if (encaje) return { ok: true, ciudad: titular(plano), departamento: encaje, revisar: false };
  }

  // Varios departamentos y ninguna pista: NO se elige.
  return {
    ok: false,
    ambigua: true,
    opciones: departamentos,
    motivo: `"${titular(plano)}" existe en ${departamentos.length} departamentos: hay que preguntar cual`,
  };
}

/** "santa marta" -> "Santa Marta" */
function titular(plano) {
  return plano
    .split(" ")
    .map((p) => (p.length > 2 ? p[0].toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * ¿Esto tiene forma de direccion?
 *
 * No se comprueba que exista -eso no se puede saber desde aqui-, se
 * comprueba que tenga los elementos minimos para que una transportadora
 * pueda intentar la entrega: un tipo de via y un numero.
 */
const TIPOS_DE_VIA = /\b(calle|cll|cl|carrera|cra|kra|kr|avenida|av|ave|diagonal|dg|diag|transversal|tv|trans|manzana|mz|circular|circunvalar|autopista|via|vereda|km|kilometro)\b/;

function validarDireccion(texto) {
  const crudo = String(texto ?? "").trim();
  const plano = aplanar(crudo);

  if (!plano) return { ok: false, motivo: "vacio" };

  if (NO_SON_DIRECCION.some((re) => re.test(plano))) {
    return { ok: false, motivo: `"${crudo.slice(0, 40)}" no es una direccion` };
  }

  if (plano.length < 8) {
    return { ok: false, motivo: "demasiado corta para ser una direccion" };
  }

  const tieneVia = TIPOS_DE_VIA.test(plano);
  const tieneNumero = /\d/.test(plano);

  if (!tieneNumero) {
    return { ok: false, motivo: "una direccion sin ningun numero no sirve para despachar" };
  }

  if (!tieneVia) {
    // Hay numeros pero no un tipo de via reconocible. Puede ser una vereda o
    // un conjunto. Se acepta MARCADA: bloquear aqui pierde ventas en zonas
    // donde las direcciones no siguen el formato urbano.
    return {
      ok: true,
      valor: crudo,
      revisar: true,
      motivo: "no se reconoce el tipo de via: revisar antes de generar la guia",
    };
  }

  return { ok: true, valor: crudo, revisar: false };
}

/**
 * Telefono colombiano para despacho.
 *
 * Candado duro, no marca: una transportadora exige telefono, asi que un
 * pedido sin telefono valido no se puede despachar. Es la unica validacion
 * de este modulo que bloquea en vez de marcar.
 */
function validarTelefono(texto) {
  const digitos = String(texto ?? "").replace(/\D/g, "");
  if (!digitos) return { ok: false, motivo: "vacio" };

  // Movil colombiano: 3XXXXXXXXX (10 digitos), con o sin el 57 delante.
  const sinPais = digitos.startsWith("57") && digitos.length === 12 ? digitos.slice(2) : digitos;

  if (sinPais.length !== 10) {
    return { ok: false, motivo: `${sinPais.length} digitos: un movil colombiano tiene 10` };
  }
  if (!sinPais.startsWith("3")) {
    return { ok: false, motivo: "un movil colombiano empieza por 3" };
  }
  if (/^(\d)\1{9}$/.test(sinPais)) {
    return { ok: false, motivo: "todos los digitos iguales: no es un numero real" };
  }

  return { ok: true, valor: sinPais };
}

/** Nombre de persona. Marca en vez de bloquear, salvo casos imposibles. */
function validarNombre(texto) {
  const crudo = String(texto ?? "").trim();
  const plano = aplanar(crudo);

  if (!plano) return { ok: false, motivo: "vacio" };
  if (plano.length < 3) return { ok: false, motivo: "demasiado corto" };
  if (/\d/.test(plano)) return { ok: false, motivo: "un nombre no lleva numeros" };
  if (/^(si|no|ok|listo|gracias|hola|buenas|claro|dale)\b/.test(plano)) {
    return { ok: false, motivo: `"${crudo.slice(0, 30)}" no es un nombre` };
  }

  const palabras = plano.split(" ").filter(Boolean);
  if (palabras.length < 2) {
    // Un solo nombre sirve para contactar, pero la transportadora suele
    // querer nombre y apellido. Se acepta marcado.
    return { ok: true, valor: crudo, revisar: true, motivo: "solo un nombre: puede faltar el apellido" };
  }

  return { ok: true, valor: crudo, revisar: false };
}

module.exports = {
  CIUDADES_SEMILLA,
  LISTA_INCOMPLETA,
  resolverCiudad,
  validarDireccion,
  validarTelefono,
  validarNombre,
  titular,
};
