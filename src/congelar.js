"use strict";

// ==========================================================================
// npm run congelar      · el servicio deja de escribir en el almacen
// npm run descongelar   · vuelve a escribir
// npm run congelado     · dice en que estado esta
//
// Sirve para que el cutover copie un origen que no se mueve. Ver
// docs/POSTGRES.md.
//
// IMPORTANTE: mientras este congelado, los mensajes NO se pierden. El
// webhook sigue contestando 200 y reclamando el trabajo en el disco; lo que
// no hace es procesarlo. Al descongelar y reiniciar, el recuperador los
// procesa solos.
// ==========================================================================

const { config } = require("./config");
const congelacion = require("./almacen/congelar");

const accion = process.argv[2] || "estado";

function imprimir(e) {
  if (!e.congelado) {
    console.log("  estado: NO congelado · el servicio escribe normalmente");
    return;
  }
  console.log("  estado: CONGELADO");
  if (e.desde) console.log(`  desde:  ${e.desde}${e.horas !== null ? `  (${e.horas} h)` : ""}`);
  if (e.porQue) console.log(`  motivo: ${e.porQue}`);
  if (e.horas !== null && e.horas >= 1) {
    console.log("");
    console.log("  AVISO: lleva mas de una hora congelado. Los mensajes se estan acumulando");
    console.log("  sin atender. Un congelado olvidado es un bot que no vende.");
  }
}

console.log("");
console.log(`NOVIKA · congelacion de escrituras  (${config.dirDatos})`);
console.log("".padEnd(62, "-"));

try {
  if (accion === "congelar") {
    const e = congelacion.congelar(config.dirDatos, process.argv[3] || "cutover");
    imprimir(e);
    console.log("");
    console.log("  El servicio seguira recibiendo mensajes y contestando 200 a Meta,");
    console.log("  pero NO los procesara: quedan reclamados en el disco y se procesan");
    console.log("  solos al descongelar y reiniciar.");
    console.log("");
    console.log("  Siguiente paso:  npm run cutover -- --simular");
  } else if (accion === "descongelar") {
    imprimir(congelacion.descongelar(config.dirDatos));
    console.log("");
    console.log("  Los mensajes diferidos siguen reclamados en el disco. Se procesan en");
    console.log("  el proximo arranque del servicio: reinicialo en Render para vaciarlos.");
    console.log("  Puedes ver cuantos quedan en /health -> trabajo.reclamados");
  } else {
    imprimir(congelacion.estado(config.dirDatos));
  }
  console.log("");
} catch (e) {
  console.error(`  ERROR: ${e.message}`);
  console.error("");
  process.exit(1);
}
