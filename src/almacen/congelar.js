"use strict";

// ==========================================================================
// CONGELACION DE ESCRITURAS
//
// Marca en disco que el servicio NO debe escribir en el almacen
// transaccional. Existe para una sola cosa: que el cutover
// archivos -> PostgreSQL copie un origen que no se mueve.
//
// --------------------------------------------------------------------------
// EL AGUJERO QUE CIERRA
// --------------------------------------------------------------------------
//
// Sin esto, un mensaje que llega MIENTRAS el cutover copia produce un pedido
// que el cutover ya no ve. Medido antes del arreglo:
//
//   pedidos en el origen al terminar : 3
//   pedidos copiados al destino      : 2
//   problemas que reporta el cutover : []
//
// Es decir: cutover "exitoso" con un pedido fuera. La peor forma de fallar,
// porque nadie va a volver a mirar.
//
// --------------------------------------------------------------------------
// POR QUE NO SE PIERDE NADA MIENTRAS ESTA CONGELADO
// --------------------------------------------------------------------------
//
// Congelado NO significa rechazar mensajes. El webhook sigue contestando
// 200 a Meta y sigue RECLAMANDO el trabajo en la bitacora del disco -que no
// forma parte del cutover-, pero NO lo procesa y NO lo marca como
// terminado.
//
// Un evento reclamado y sin terminar es, por definicion, lo que el
// recuperador busca al arrancar. Asi que al descongelar y reiniciar, esos
// mensajes se procesan solos, ya contra PostgreSQL. No hace falta inventar
// nada: se reutiliza la recuperacion durable que ya existe y ya esta
// probada.
//
// Eso tambien evita depender de los reintentos de Meta: devolver 503 habria
// funcionado -Meta reintenta 36 horas- pero habria convertido una operacion
// controlada en una carrera contra un reloj ajeno.
//
// --------------------------------------------------------------------------
// EL RIESGO DE DEJARLO PUESTO
// --------------------------------------------------------------------------
//
// Un congelado olvidado es un bot que acumula mensajes sin atender a nadie.
// Por eso:
//   - /health lo publica, con desde cuando;
//   - cada evento diferido se registra en el diario;
//   - el estado dice cuantas horas lleva, para que un olvido se vea.
//
// La marca vive en DATA_DIR, asi que sobrevive a un reinicio: si se congela
// y el servicio se reinicia, sigue congelado. Es lo que se quiere.
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");

const NOMBRE = "CONGELADO.json";

function ruta(dirDatos) {
  return path.join(dirDatos, NOMBRE);
}

/**
 * ¿Estan congeladas las escrituras?
 *
 * Se lee del DISCO en cada llamada, sin cache. A proposito: congelar y
 * descongelar son comandos de otro proceso, asi que un valor cacheado dejaria
 * al servicio operando con una idea vieja de la realidad.
 *
 * @returns {{congelado: boolean, desde: string|null, porQue: string|null, horas: number|null}}
 */
function estado(dirDatos) {
  try {
    const bruto = fs.readFileSync(ruta(dirDatos), "utf8");
    const marca = JSON.parse(bruto);
    const desde = marca.desde || null;
    const horas = desde ? (Date.now() - Date.parse(desde)) / 3600000 : null;
    return {
      congelado: true,
      desde,
      porQue: marca.porQue || null,
      horas: horas === null ? null : Math.round(horas * 10) / 10,
    };
  } catch (e) {
    if (e.code === "ENOENT") return { congelado: false, desde: null, porQue: null, horas: null };
    // Marca ilegible: se asume CONGELADO. Ante la duda, no escribir es
    // reversible; escribir sobre un origen que alguien creia quieto, no.
    return { congelado: true, desde: null, porQue: "marca ilegible: se asume congelado", horas: null };
  }
}

/** Congela. Idempotente: si ya estaba, conserva la marca original. */
function congelar(dirDatos, porQue = "cutover") {
  const previo = estado(dirDatos);
  if (previo.congelado && previo.desde) return previo;

  const marca = { desde: new Date().toISOString(), porQue };
  fs.mkdirSync(dirDatos, { recursive: true });
  const tmp = `${ruta(dirDatos)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marca, null, 2));
  fs.renameSync(tmp, ruta(dirDatos)); // rename es atomico
  return { congelado: true, ...marca, horas: 0 };
}

/** Descongela. Idempotente. */
function descongelar(dirDatos) {
  try {
    fs.rmSync(ruta(dirDatos));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return estado(dirDatos);
}

module.exports = { estado, congelar, descongelar, ruta, NOMBRE };
