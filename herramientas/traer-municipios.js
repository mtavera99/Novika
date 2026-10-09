"use strict";

// ==========================================================================
// TRAER LA LISTA DE MUNICIPIOS DEL DANE
//
// POR QUE EXISTE
//
// `destino.CIUDADES_SEMILLA` tenia ~60 entradas escritas a mano, y estaba
// incompleta a proposito: la regla era "marcar, no bloquear". Pero el panel
// del 09-oct mostro el precio de esa decision:
//
//   "A orocue"            -> no reconocio la ciudad
//   "Málaga Santander"    -> no reconocio la ciudad
//   "Ciénaga guacamayal"  -> no reconocio la ciudad
//
// En los tres el bot salto a "¿Te lo aparto...?" sin dar el plazo ni pedir
// datos, y a la clienta de Orocue le volvio a preguntar la ciudad despues de
// que ya la habia dado. Colombia tiene 1.100 municipios y adivinar cuales
// escribir a mano era la decision equivocada.
//
// LA FUENTE ES OFICIAL: DIVIPOLA del DANE, publicado en datos.gov.co.
//   https://www.datos.gov.co/resource/gdxc-w37w.json
//
// --------------------------------------------------------------------------
// POR QUE UN FICHERO GENERADO Y NO UNA LLAMADA EN CALIENTE
// --------------------------------------------------------------------------
//
// Porque el bot no puede depender de que datos.gov.co este arriba para saber
// si Orocue existe. Se genera una vez, se revisa en el repositorio, y se
// vuelve a correr cuando el DANE cambie algo (crear un municipio nuevo en
// Colombia es un acto legislativo: pasa cada varios años).
//
//   node herramientas/traer-municipios.js
// ==========================================================================

const fs = require("node:fs");
const path = require("node:path");

const { aplanar } = require("../src/dominio/texto");

const FUENTE = "https://www.datos.gov.co/resource/gdxc-w37w.json?$limit=2000";
const DESTINO = path.join(__dirname, "..", "src", "dominio", "municipios-co.json");

(async () => {
  process.stdout.write(`Trayendo DIVIPOLA del DANE...\n  ${FUENTE}\n`);
  const r = await fetch(FUENTE);
  if (!r.ok) {
    console.error(`La fuente respondio ${r.status}. No se toca el fichero existente.`);
    process.exit(1);
  }
  const filas = await r.json();
  if (!Array.isArray(filas) || filas.length < 1000) {
    console.error(`Llegaron ${Array.isArray(filas) ? filas.length : 0} filas y se esperaban ~1.100. Se aborta.`);
    process.exit(1);
  }

  // ⚠️ SE APLANA CON `texto.aplanar`, LA MISMA FUNCION QUE USA EL BOT.
  //
  // Generar el fichero con una normalizacion propia -por ejemplo la de
  // Python- es como tener dos listas: coincidirian en el 99% y fallarian en
  // la ñ o en una tilde suelta, que es justo donde estan los municipios
  // raros. La clave la escribe quien luego la va a buscar.
  const porNombre = {};
  for (const f of filas) {
    const nombre = String(f.nom_mpio || "").trim();
    const dpto = String(f.dpto || "").trim();
    if (!nombre || !dpto) continue;
    const clave = aplanar(nombre);
    if (!clave) continue;
    // El departamento se guarda en Capitalizado legible, no en MAYUSCULAS:
    // es lo que se le acaba imprimiendo a una guia.
    // Capitalizado legible: es lo que se le acaba imprimiendo a una guia.
    // Las preposiciones van en minuscula ("Valle del Cauca", no "Valle Del
    // Cauca") y las siglas se dejan en mayuscula ("Bogotá, D.C.").
    const MINUSCULAS = new Set(["de", "del", "la", "las", "los", "y"]);
    const bonito = dpto
      .toLocaleLowerCase("es")
      .split(/\s+/)
      .map((palabra, i) => {
        if (/^d\.?c\.?$/i.test(palabra)) return "D.C.";
        if (i > 0 && MINUSCULAS.has(palabra)) return palabra;
        return palabra.replace(/^([a-záéíóúñ])/, (c) => c.toLocaleUpperCase("es"));
      })
      .join(" ")
      .replace(/\.\.+/g, ".");
    const añadir = (k) => {
      if (!k) return;
      if (!porNombre[k]) porNombre[k] = [];
      if (!porNombre[k].includes(bonito)) porNombre[k].push(bonito);
    };
    añadir(clave);

    // ------------------------------------------------------------------
    // ALIAS: COMO LO ESCRIBE EL DANE NO ES COMO LO ESCRIBE UN CLIENTE.
    //
    // ⚠️ SIN ESTO, "Bogotá" NO ESTABA EN LA LISTA. El DANE la registra como
    //    "BOGOTÁ, D.C.", que aplanado queda "bogota d c" — y nadie escribe
    //    eso en un chat. La ciudad con mas pedidos del pais se habria
    //    quedado fuera de su propia lista de ciudades.
    //
    // La regla general: si el nombre oficial trae una coletilla entre
    // parentesis o detras de una coma, tambien vale el nombre a secas.
    // ------------------------------------------------------------------
    const sinColetilla = aplanar(nombre.replace(/[(,].*$/, ""));
    if (sinColetilla && sinColetilla !== clave) añadir(sinColetilla);
  }

  const claves = Object.keys(porNombre).sort();
  const homonimos = claves.filter((k) => porNombre[k].length > 1);

  const salida = {
    _LEEME:
      "GENERADO. No se edita a mano: se regenera con `node herramientas/traer-municipios.js`. " +
      "Fuente: DIVIPOLA del DANE (datos.gov.co/resource/gdxc-w37w). " +
      "Clave = nombre del municipio aplanado con src/dominio/texto.aplanar; valor = departamentos donde existe ese nombre. " +
      "Un nombre con DOS O MAS departamentos es un homonimo y NO se puede resolver solo: " +
      "src/dominio/destino.js devuelve `ambigua` y pregunta, porque despachar al departamento equivocado " +
      "es mandar el paquete a 700 km.",
    _generado: new Date().toISOString().slice(0, 10),
    _municipios: claves.length,
    _homonimos: homonimos.length,
    municipios: porNombre,
  };

  fs.writeFileSync(DESTINO, `${JSON.stringify(salida, null, 0)}\n`, "utf8");

  process.stdout.write(
    `\n  municipios: ${claves.length}\n` +
      `  homonimos:  ${homonimos.length}  (${homonimos.slice(0, 8).join(", ")}...)\n` +
      `  escrito en: ${path.relative(path.join(__dirname, ".."), DESTINO)}\n` +
      `  tamaño:     ${(fs.statSync(DESTINO).size / 1024).toFixed(0)} KB\n`
  );
})();
