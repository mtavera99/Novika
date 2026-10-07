"use strict";

// ==========================================================================
// NORMALIZACION DE TEXTO
//
// Modulo puro. Sin I/O, sin IA, sin process.env.
//
// Aqui vive una leccion caro aprendida en BIKERPRO: su funcion de limpieza
// quitaba las tildes antes de comparar, asi que "si" (condicional) y "si"
// (afirmativo) colapsaban en la misma cadena. El mensaje de un cliente que
// decia "si mandaron el pedido gracias" -una PREGUNTA- hizo match con el
// patron de afirmacion y genero un segundo pedido por el mismo importe.
//
// Por eso aqui la normalizacion devuelve SIEMPRE las dos versiones: la
// aplanada, util para buscar palabras, y la original, que es la unica que
// sabe si el cliente escribio "si" o "si". Quien decide algo transaccional
// tiene que poder consultar las dos.
// ==========================================================================

/** Quita tildes y diacriticos. "cinturon termico" <- "cinturón térmico" */
function sinTildes(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Forma canonica para buscar: minusculas, sin tildes, sin signos, con los
 * espacios colapsados. Se conservan los digitos porque las cantidades
 * importan ("quiero 2").
 */
function aplanar(texto) {
  return sinTildes(texto)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Las dos vistas de un mensaje, juntas y explicitas.
 *
 * @returns {{crudo: string, plano: string, minusculas: string, vacio: boolean,
 *            tieneTildeAfirmativa: boolean, palabras: string[]}}
 */
function vistas(texto) {
  const crudo = String(texto ?? "");
  const minusculas = crudo.toLowerCase();
  return {
    crudo,
    minusculas,
    plano: aplanar(crudo),
    vacio: crudo.trim() === "",
    // Si el cliente se tomo la molestia de poner la tilde, "si" es
    // inequivocamente afirmativo. Sin tilde puede ser condicional.
    //
    // Sin \b a proposito: en JavaScript \b se define sobre \w, que es
    // ASCII, asi que "i" acentuada no cuenta como caracter de palabra y
    // /\bsí\b/ NO coincide con "sí". Es el tipo de detalle que hace que una
    // comprobacion parezca estar y no este.
    tieneTildeAfirmativa: /sí/i.test(crudo),
    palabras: aplanar(crudo).split(" ").filter(Boolean),
  };
}

/** ¿Aparece alguno de estos patrones? Devuelve el primero que coincide. */
function primeraCoincidencia(texto, patrones) {
  for (const p of patrones) {
    const re = p instanceof RegExp ? p : new RegExp(p, "i");
    const m = String(texto).match(re);
    if (m) return { patron: re, coincidencia: m[0], posicion: m.index };
  }
  return null;
}

/**
 * Cantidad escrita en palabras o digitos. Devuelve null si no hay ninguna:
 * no asume 1. Asumir una cantidad es cobrar lo que el cliente no pidio.
 */
const NUMEROS_EN_PALABRAS = {
  un: 1, uno: 1, una: 1,
  dos: 2, par: 2,
  tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, docena: 12,
};

/**
 * Todas las cantidades mencionadas, en orden de aparicion.
 *
 * Devolver TODAS y no una es deliberado: "queria dos, mejor uno" tiene dos
 * señales en conflicto, y quien decide necesita verlas para resolver por
 * posicion (gana la correccion mas tardia) o para no resolver nada.
 */
/** Numerales de varias palabras. Se resuelven ANTES de los de una. */
const NUMEROS_COMPUESTOS = [
  { re: /\bun[ao]?\s+docena\b/g, valor: 12 },
  { re: /\bmedia\s+docena\b/g, valor: 6 },
  { re: /\bun\s+par\b/g, valor: 2 },
];

function cantidadesEn(texto) {
  let { plano } = vistas(texto);
  const encontradas = [];

  // "un par" vale 2, no 1. Si se buscaran primero las palabras sueltas,
  // "un" ganaria por posicion y se cotizaria la mitad del pedido. Los
  // compuestos se registran y se tapan con guiones para que lo que queda no
  // vuelva a leerse.
  for (const { re, valor } of NUMEROS_COMPUESTOS) {
    let c;
    const copia = new RegExp(re.source, "g");
    while ((c = copia.exec(plano)) !== null) {
      encontradas.push({ valor, posicion: c.index, origen: "compuesto" });
    }
    plano = plano.replace(new RegExp(re.source, "g"), (coincidencia) => "-".repeat(coincidencia.length));
  }

  const reDigitos = /\b(\d{1,3})\b/g;
  let m;
  while ((m = reDigitos.exec(plano)) !== null) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 999) encontradas.push({ valor: n, posicion: m.index, origen: "digito" });
  }

  for (const [palabra, valor] of Object.entries(NUMEROS_EN_PALABRAS)) {
    const re = new RegExp(`\\b${palabra}\\b`, "g");
    while ((m = re.exec(plano)) !== null) {
      encontradas.push({ valor, posicion: m.index, origen: "palabra" });
    }
  }

  return encontradas.sort((a, b) => a.posicion - b.posicion);
}

module.exports = { sinTildes, aplanar, vistas, primeraCoincidencia, cantidadesEn, NUMEROS_EN_PALABRAS, NUMEROS_COMPUESTOS };
