"use strict";

// ==========================================================================
// LEER Y PARTIR EL PDF DE LA TRANSPORTADORA
//
// La unica parte del flujo de guias que toca un archivo. Todo lo demas
// -decidir de quien es cada etiqueta- vive en `guias.js` y es puro.
//
// Dos operaciones, y las dos cargan el PDF entero en memoria:
//
//   leerPaginas()  el TEXTO de cada pagina, agrupado por linea   (pdfjs-dist)
//   partirHojas()  un PDF de una hoja por cada pagina            (pdf-lib)
//
// ==========================================================================
// POR QUE EL TEXTO SE LEE EN UN PROCESO APARTE
// ==========================================================================
//
// Porque `pdfjs` NO DEVUELVE LA MEMORIA QUE USA. Medido en BIKERPRO el
// 30-sep, y no se arregla con `page.cleanup()`, ni con `doc.destroy()`, ni
// forzando el recolector:
//
//     solo CARGAR el modulo pdfjs        +41 MB
//     leer 40 paginas                    +30 MB
//     despues de destroy() + recolector    0 MB devueltos
//                                        ─────────
//                                         71 MB que no vuelven nunca
//
// Node si libera por dentro -el heap y `external` bajan a lo normal- pero el
// sistema operativo nunca recupera esos 71 MB. Con el contenedor de 512 MB
// de Render, dos o tres lotes de guias y el proceso muere por memoria. Se
// probo tambien `useSystemFonts: false` (no cambia nada) y
// `MALLOC_ARENA_MAX=2` (lo empeora).
//
// LA SALIDA: cuando un PROCESO termina, el sistema recupera el 100% de lo
// que tenia, incluido lo que una libreria nativa se nego a soltar. Asi que
// el texto se extrae en un proceso hijo que se muere al acabar, y el
// servicio recibe solo el texto. Medido sobre tres lotes seguidos:
//
//     pdfjs dentro del servicio:  +71 MB cada lote
//     en un proceso aparte:        +1 MB en total
//
// El coste son unos 300 ms de arranque del hijo, una vez por PDF. Los PDF se
// suben a mano unas veces al dia: no se nota.
// ==========================================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Lo que tarda como maximo el hijo antes de que se le mate. */
const TOPE_WORKER_MS = 120000;

/**
 * Tope de paginas por lote.
 *
 * No es un limite tecnico: es un freno para que un PDF equivocado -un
 * catalogo, un extracto bancario de 400 hojas- no se convierta en 400
 * intentos de parear y un pico de memoria. Un lote de guias real son
 * decenas.
 */
const MAX_PAGINAS = 150;

/**
 * Comprueba que esto sea de verdad un PDF, y lo recorta si hace falta.
 *
 * --------------------------------------------------------------------------
 * LA CABECERA NO SIEMPRE ESTA EN EL BYTE 0
 * --------------------------------------------------------------------------
 *
 * Un PDF reenviado por WhatsApp, o pasado por un conversor, puede traer
 * bytes de preambulo antes del "%PDF-". En BIKERPRO eso daba un 400 sin
 * explicacion y parecia que el archivo estuviera corrupto.
 *
 * Se busca la cabecera dentro del primer kilobyte y se recorta el preambulo.
 * Si no esta, el error dice el TAMANO y los PRIMEROS BYTES, porque "no es un
 * PDF valido" no permite averiguar nada: con el tamano se ve enseguida si lo
 * que se subio fue un archivo vacio o una imagen.
 *
 * @returns {{ok:true, datos:Buffer} | {ok:false, motivo:string}}
 */
function revisarPdf(datos) {
  const buf = Buffer.isBuffer(datos) ? datos : Buffer.from(datos || []);
  if (!buf.length) {
    return { ok: false, motivo: "el archivo llego vacio: no se subio nada" };
  }

  const marca = Buffer.from("%PDF-");
  const donde = buf.slice(0, 1024).indexOf(marca);

  if (donde === -1) {
    const primeros = buf.slice(0, 16).toString("hex").match(/.{1,2}/g).join(" ");
    return {
      ok: false,
      motivo:
        `esto no parece un PDF: no se encontro la cabecera "%PDF-" en el primer kilobyte. ` +
        `Pesa ${buf.length} bytes y empieza por ${primeros}. ` +
        `Si lo descargaste de la transportadora, subelo tal cual, sin reenviarlo por WhatsApp.`,
    };
  }

  return { ok: true, datos: donde === 0 ? buf : buf.slice(donde) };
}

/**
 * El TEXTO de cada pagina, agrupado por linea.
 *
 * Se agrupa por la coordenada Y de cada pedazo porque la etiqueta se lee por
 * sus rotulos: juntar todo en un chorro pega el nombre del destinatario con
 * el del remitente y el parseo empieza a adivinar.
 *
 * @returns {Promise<{ok:true, paginas:string[][], enProcesoAparte:boolean}
 *                  | {ok:false, motivo:string}>}
 */
async function leerPaginas(datos) {
  try {
    const paginas = await enProcesoAparte(datos);
    return { ok: true, paginas, enProcesoAparte: true };
  } catch (e) {
    // Si el hijo no puede arrancar se cae con gracia al camino de siempre.
    // Es mejor un servicio que gasta memoria que un servicio que no puede
    // mandar las guias; pero se avisa, porque la fuga es real.
    const aviso =
      `no se pudo leer el PDF en un proceso aparte (${e && e.message}); ` +
      "se lee en el proceso del servicio, que deja ~71 MB sin devolver al sistema";
    try {
      const paginas = await enEsteProceso(datos);
      return { ok: true, paginas, enProcesoAparte: false, aviso };
    } catch (e2) {
      return { ok: false, motivo: motivoDeLectura(e2) };
    }
  }
}

/**
 * Traduce el fallo de la libreria a algo sobre lo que se pueda actuar.
 *
 * Que falte la dependencia y que el PDF este corrupto son dos problemas con
 * dos soluciones distintas -instalar algo, o volver a descargar el archivo-
 * y el mensaje crudo de la libreria no distingue cual es.
 */
function motivoDeLectura(e) {
  const m = String((e && e.message) || e || "");
  if (/Cannot find module|ERR_MODULE_NOT_FOUND/i.test(m)) {
    return (
      "falta la dependencia que lee PDF (`pdfjs-dist`). El resto del panel funciona; " +
      "para leer el PDF de la transportadora hay que instalarla y volver a desplegar."
    );
  }
  if (/password|encrypt/i.test(m)) {
    return "el PDF esta protegido con contrasena: descargalo de la transportadora sin proteccion.";
  }
  return `no se pudo leer el PDF: ${m}`;
}

function enProcesoAparte(datos) {
  const { fork } = require("node:child_process");

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "novika-guias-"));
  const entrada = path.join(base, "entrada.pdf");
  const salida = path.join(base, "salida.json");
  fs.writeFileSync(entrada, datos);

  const limpiar = () => {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      // Un temporal que no se borra no justifica tumbar el envio de las guias.
    }
  };

  return new Promise((resolve, reject) => {
    // ----------------------------------------------------------------------
    // SE PASAN ARCHIVOS, NO stdout.
    //
    // Cualquier `console.log` de un modulo que el hijo cargue -hoy o dentro
    // de tres meses- se mezclaria con el JSON y lo volveria ilegible. Con un
    // archivo de salida, lo que el hijo imprima es irrelevante.
    // ----------------------------------------------------------------------
    const hijo = fork(path.join(__dirname, "leer-pdf-worker.js"), [entrada, salida], { silent: true });

    let error = "";
    if (hijo.stderr) hijo.stderr.on("data", (d) => (error += d));

    // Un PDF corrupto podria dejar a pdfjs dando vueltas para siempre, y el
    // operador se quedaria mirando una pantalla que no responde.
    const reloj = setTimeout(() => {
      hijo.kill("SIGKILL");
      limpiar();
      reject(new Error("el lector del PDF tardo mas de dos minutos"));
    }, TOPE_WORKER_MS);

    hijo.on("error", (e) => {
      clearTimeout(reloj);
      limpiar();
      reject(e);
    });

    hijo.on("close", (codigo) => {
      clearTimeout(reloj);
      if (codigo !== 0) {
        limpiar();
        return reject(new Error(`el lector salio con codigo ${codigo}: ${error.slice(0, 300)}`));
      }
      try {
        const paginas = JSON.parse(fs.readFileSync(salida, "utf8"));
        limpiar();
        resolve(paginas);
      } catch (e) {
        limpiar();
        reject(new Error(`no se pudo leer la salida del lector: ${e.message}`));
      }
    });
  });
}

/**
 * El parseo, tal cual. Lo invoca el hijo, y es la red de seguridad si el
 * hijo no puede arrancar.
 *
 * SE EXPORTA SOLO PARA ESO. El resto del codigo usa `leerPaginas`, que es la
 * que manda el trabajo al proceso aparte.
 */
async function enEsteProceso(datos) {
  // Import dinamico: pdfjs es ESM y este proyecto es CommonJS. Ademas asi el
  // servicio arranca aunque nadie vaya a usar las guias en esa ejecucion, y
  // la dependencia no cuesta memoria mientras no se use.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(datos),
    useSystemFonts: true,
    // No ejecutar nada que venga dentro del PDF. El archivo lo genera un
    // tercero y llega por una subida: es entrada no confiable.
    isEvalSupported: false,
  }).promise;

  const paginas = [];
  try {
    const cuantas = Math.min(doc.numPages, MAX_PAGINAS);
    for (let n = 1; n <= cuantas; n++) {
      const pagina = await doc.getPage(n);
      const contenido = await pagina.getTextContent();

      const filas = new Map(); // Y redondeada -> pedazos de texto
      for (const item of contenido.items) {
        if (!item.str || !item.str.trim()) continue;
        // La Y se redondea a multiplos de 3 porque dos pedazos de la misma
        // linea visual no vienen exactamente a la misma altura.
        const y = Math.round(((item.transform && item.transform[5]) || 0) / 3) * 3;
        if (!filas.has(y)) filas.set(y, []);
        filas.get(y).push({ x: (item.transform && item.transform[4]) || 0, str: item.str });
      }

      const lineas = [...filas.entries()]
        .sort((a, b) => b[0] - a[0]) // de arriba hacia abajo
        .map(([, pedazos]) =>
          pedazos
            .sort((a, b) => a.x - b.x)
            .map((p) => p.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        )
        .filter(Boolean);

      paginas.push(lineas);
      pagina.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return paginas;
}

/**
 * Parte el PDF en un PDF de una sola hoja por pagina.
 *
 * @returns {Promise<{ok:true, hojas:Buffer[]} | {ok:false, motivo:string}>}
 */
async function partirHojas(datos) {
  let PDFDocument;
  try {
    ({ PDFDocument } = require("pdf-lib"));
  } catch (e) {
    return {
      ok: false,
      motivo:
        "falta la dependencia que parte el PDF (`pdf-lib`). El resto del panel funciona; " +
        "para partir el PDF de la transportadora hay que instalarla y volver a desplegar.",
    };
  }

  try {
    const origen = await PDFDocument.load(datos, { ignoreEncryption: true });
    const total = origen.getPageCount();
    const cuantas = Math.min(total, MAX_PAGINAS);

    const hojas = [];
    for (let i = 0; i < cuantas; i++) {
      const nuevo = await PDFDocument.create();
      const [pagina] = await nuevo.copyPages(origen, [i]);
      nuevo.addPage(pagina);
      hojas.push(Buffer.from(await nuevo.save()));
    }
    return {
      ok: true,
      hojas,
      recortado: total > cuantas ? { total, leidas: cuantas } : null,
    };
  } catch (e) {
    return { ok: false, motivo: `no se pudo partir el PDF: ${e && e.message}` };
  }
}

/**
 * Las dos operaciones, en el orden que no revienta la memoria.
 *
 * --------------------------------------------------------------------------
 * UNA COSA A LA VEZ, NO LAS DOS EN PARALELO
 * --------------------------------------------------------------------------
 *
 * En BIKERPRO esto era un `Promise.all`, y llego un correo de Render:
 * "exceeded its memory limit". Las dos funciones cargan el PDF ENTERO, asi
 * que en paralelo los dos arboles de objetos viven AL MISMO TIEMPO.
 *
 * Y NO SE GANABA NADA. Node es de un solo hilo y esto es trabajo de CPU, no
 * de red: `Promise.all` no lo hace mas rapido, solo duplica el pico de
 * memoria. Secuencial, el primero se libera antes de que arranque el
 * segundo.
 *
 * @returns {Promise<{ok:true, paginas:string[][], hojas:Buffer[], aviso?:string}
 *                  | {ok:false, motivo:string}>}
 */
async function abrirLote(datosCrudos) {
  const revision = revisarPdf(datosCrudos);
  if (!revision.ok) return revision;

  const texto = await leerPaginas(revision.datos);
  if (!texto.ok) return texto;

  const corte = await partirHojas(revision.datos);
  if (!corte.ok) return corte;

  // Si las dos lecturas no ven el mismo numero de paginas, algo va mal y
  // seguir significaria parear el texto de una hoja con el PDF de otra: la
  // forma exacta de mandarle a un cliente la etiqueta de otro.
  if (texto.paginas.length !== corte.hojas.length) {
    return {
      ok: false,
      motivo:
        `el PDF se leyo con ${texto.paginas.length} paginas de texto y ${corte.hojas.length} hojas. ` +
        "No se continua: emparejar el texto de una hoja con el PDF de otra manda la etiqueta " +
        "equivocada al cliente.",
    };
  }

  return {
    ok: true,
    paginas: texto.paginas,
    hojas: corte.hojas,
    // SE PROPAGA, no se da por supuesto. Es el dato que dice si la lectura
    // uso el proceso hijo o cayo al camino que no devuelve la memoria; si no
    // viajara hasta el diario, una fuga de 71 MB por lote quedaria registrada
    // como una lectura normal y nadie sabria por que el servicio se reinicia.
    enProcesoAparte: texto.enProcesoAparte,
    aviso: texto.aviso || null,
    recortado: corte.recortado || null,
  };
}

module.exports = {
  MAX_PAGINAS,
  TOPE_WORKER_MS,
  revisarPdf,
  leerPaginas,
  partirHojas,
  abrirLote,
  // Exportada SOLO para que `leer-pdf-worker.js` la invoque.
  enEsteProceso,
};
