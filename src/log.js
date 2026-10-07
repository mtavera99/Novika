"use strict";

// ==========================================================================
// LOGS
//
// Una linea JSON por evento, a stdout. No hay libreria: con el volumen de
// un bot de WhatsApp, console.log con estructura alcanza, y una dependencia
// menos es una dependencia menos que actualizar.
//
// Dos reglas que vienen de lo aprendido en BIKERPRO:
//
//   1. El log NO es la base de datos. Alli se llego a recuperar pedidos
//      leyendo los logs de Render. Lo que tiene que sobrevivir se escribe
//      en el diario (src/almacen/diario.js), no aqui.
//
//   2. Los datos del cliente se enmascaran por defecto. En BIKERPRO los
//      telefonos, nombres y textos de los clientes se imprimian en claro en
//      los logs del hosting. Aqui hay que pedirlo a proposito con LOG_PII=1.
// ==========================================================================

const { config } = require("./config");

const NIVELES = { error: 0, warn: 1, info: 2, debug: 3 };

function nivelActivo() {
  const n = NIVELES[config.nivelLog];
  return n === undefined ? NIVELES.info : n;
}

/** 573001234567 -> ***4567 */
function enmascararTelefono(valor) {
  const t = String(valor);
  if (t.length <= 4) return "***";
  return `***${t.slice(-4)}`;
}

const CLAVES_SENSIBLES = new Set(["telefono", "de", "para", "idCliente", "owner", "wa_id"]);
const CLAVES_DE_TEXTO = new Set(["texto", "cuerpo", "mensaje", "nombre", "direccion"]);

function limpiar(datos) {
  if (!datos || typeof datos !== "object") return datos;
  if (config.logPii) return datos;

  const salida = Array.isArray(datos) ? [] : {};
  for (const [clave, valor] of Object.entries(datos)) {
    if (valor === null || valor === undefined) {
      salida[clave] = valor;
    } else if (CLAVES_SENSIBLES.has(clave)) {
      salida[clave] = enmascararTelefono(valor);
    } else if (CLAVES_DE_TEXTO.has(clave) && typeof valor === "string") {
      // El contenido no se imprime; su longitud si, porque sirve para
      // distinguir "llego vacio" de "llego y fallamos al procesarlo".
      salida[clave] = `<${valor.length} caracteres>`;
    } else if (typeof valor === "object") {
      salida[clave] = limpiar(valor);
    } else {
      salida[clave] = valor;
    }
  }
  return salida;
}

function escribir(nivel, evento, datos) {
  if (NIVELES[nivel] > nivelActivo()) return;
  const linea = {
    ts: new Date().toISOString(),
    nivel,
    marca: config.marca,
    evento,
    ...limpiar(datos),
  };
  const destino = nivel === "error" ? console.error : nivel === "warn" ? console.warn : console.log;
  destino(JSON.stringify(linea));
}

module.exports = {
  error: (evento, datos) => escribir("error", evento, datos),
  warn: (evento, datos) => escribir("warn", evento, datos),
  info: (evento, datos) => escribir("info", evento, datos),
  debug: (evento, datos) => escribir("debug", evento, datos),
  enmascararTelefono,
  limpiar,
};
