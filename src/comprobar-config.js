"use strict";

// ==========================================================================
// npm run comprobar-config
//
// Dice si la configuracion actual permitiria arrancar, y que falta, sin
// levantar el puerto ni tocar nada. Util antes de un despliegue y util para
// contestar "¿por que no responde?" desde la terminal.
//
// No imprime ningun valor secreto: solo si esta o no esta.
// ==========================================================================

const { config, revisar } = require("./config");
const { cargarCatalogo } = require("./catalogo");

function marca(valor) {
  return valor ? "si" : "NO";
}

const { errores, avisos } = revisar();

console.log("");
console.log("NOVIKA · comprobacion de configuracion");
console.log("".padEnd(60, "-"));
console.log(`  token de verificacion ...... ${marca(config.verifyToken)}`);
console.log(`  clave secreta de la app .... ${marca(config.appSecret)}  (sin ella los eventos no se procesan)`);
console.log(`  token de WhatsApp .......... ${marca(config.whatsappToken)}`);
console.log(`  id del numero .............. ${marca(config.idNumero)}  (filtro de aislamiento)`);
console.log(`  id de la WABA .............. ${marca(config.idWaba)}`);
console.log(`  token del panel ............ ${marca(config.panelToken)}`);
console.log(`  almacenamiento ............. ${config.persistencia.modo}${config.persistencia.esDurable ? "" : "  <-- SE BORRA EN CADA DESPLIEGUE"}`);
console.log(`  respuesta automatica ....... ${config.respuestaAutomatica ? "ENCENDIDA" : "apagada"}`);
console.log(`  carpeta de datos ........... ${config.dirDatos}`);
console.log(`    ${config.persistencia.motivo}`);
console.log("".padEnd(60, "-"));

const catalogo = cargarCatalogo();
console.log(`  productos en el catalogo ... ${catalogo.productos.length} (${catalogo.activos.length} activos)`);
if (catalogo.problemas.length) {
  console.log("");
  console.log("  Problemas en el catalogo:");
  for (const p of catalogo.problemas) console.log(`    [!] ${p}`);
}
console.log("".padEnd(60, "-"));

if (avisos.length) {
  console.log("");
  console.log("Avisos (arranca, pero conviene saberlo):");
  for (const a of avisos) console.log(`  [!] ${a}`);
}

if (errores.length) {
  console.log("");
  console.log("Errores (el servidor NO arrancaria):");
  for (const e of errores) console.log(`  [X] ${e}`);
  console.log("");
  process.exit(1);
}

console.log("");
console.log("Configuracion valida: el servidor arrancaria.");
console.log("");
