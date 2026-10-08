"use strict";

// ==========================================================================
// LEER EL ARCHIVO DE NOVEDADES DE LA TRANSPORTADORA
//
// La transportadora exporta las novedades en CSV o en XLSX. Este modulo lo
// convierte en filas de texto para que `novedades.js` las clasifique.
//
// --------------------------------------------------------------------------
// POR QUE SE LEE XLSX A MANO Y NO CON UNA LIBRERIA
// --------------------------------------------------------------------------
//
// Un .xlsx es un ZIP con XML dentro, y Node trae `zlib`. Las librerias de
// Excel son grandes, cambian de API y han tenido CVEs de deserializacion;
// aqui solo hace falta leer celdas de texto de la primera hoja.
//
// La convencion del proyecto es explicita: "Dependencias: express y dotenv.
// Nada mas sin una razon". Leer un ZIP con la libreria estandar no es una
// razon suficiente para traer una.
//
// --------------------------------------------------------------------------
// Y POR QUE SE PUEDE PEGAR TEXTO A MANO
// --------------------------------------------------------------------------
//
// Porque todavia no se sabe que formato exacto exportara la transportadora
// que use NOVIKA -ni si exportara algo-. Pegar lo que se ve en la pantalla
// funciona hoy, sin depender de eso. Si manana hay export, el mismo
// clasificador lo lee.
//
// Es la diferencia entre una pantalla que funciona y una que espera a que
// alguien decida algo.
// ==========================================================================

const zlib = require("node:zlib");

/** Tope de filas. Un export de novedades son decenas, no decenas de miles. */
const MAX_FILAS = 2000;

// ==========================================================================
// ZIP
// ==========================================================================

const FIRMA_FIN = 0x06054b50; // PK\x05\x06  fin del directorio central
const FIRMA_CENTRAL = 0x02014b50; // PK\x01\x02  entrada del directorio

/** Busca el fin del directorio central, que esta al FINAL del archivo. */
function buscarFin(buf) {
  // Se busca hacia atras porque puede haber un comentario al final, de hasta
  // 64 KB. Mas atras de eso no es un ZIP valido.
  const desde = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= desde; i--) {
    if (buf.readUInt32LE(i) === FIRMA_FIN) return i;
  }
  return -1;
}

/**
 * Saca del ZIP las entradas pedidas, ya descomprimidas.
 *
 * @param {Buffer} buf
 * @param {(nombre:string) => boolean} quiero
 * @returns {Map<string, Buffer>}
 */
function abrirZip(buf, quiero) {
  const salida = new Map();

  const fin = buscarFin(buf);
  if (fin === -1) throw new Error("no es un archivo ZIP valido (falta el fin del directorio central)");

  const cuantas = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);

  for (let i = 0; i < cuantas; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== FIRMA_CENTRAL) break;

    const metodo = buf.readUInt16LE(p + 10);
    const tamComprimido = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComentario = buf.readUInt16LE(p + 32);
    const offsetLocal = buf.readUInt32LE(p + 42);
    const nombre = buf.slice(p + 46, p + 46 + largoNombre).toString("utf8");

    p += 46 + largoNombre + largoExtra + largoComentario;

    if (!quiero(nombre)) continue;

    // En la cabecera LOCAL los campos de nombre y extra pueden tener otra
    // longitud que en el directorio central, asi que se vuelven a leer.
    const nombreLocal = buf.readUInt16LE(offsetLocal + 26);
    const extraLocal = buf.readUInt16LE(offsetLocal + 28);
    const datos = buf.slice(
      offsetLocal + 30 + nombreLocal + extraLocal,
      offsetLocal + 30 + nombreLocal + extraLocal + tamComprimido
    );

    if (metodo === 0) salida.set(nombre, datos);
    else if (metodo === 8) salida.set(nombre, zlib.inflateRawSync(datos));
    // Cualquier otro metodo de compresion se ignora en silencio: Excel usa 0
    // y 8, y adivinar con otro daria basura que parece texto.
  }

  return salida;
}

// ==========================================================================
// XML
// ==========================================================================

const ENTIDADES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function desescapar(s) {
  return String(s || "")
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTIDADES[m])
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/**
 * La tabla de textos compartidos.
 *
 * Excel no repite una cadena: la guarda una vez aqui y en la celda pone su
 * indice. Sin leer esto, una hoja de texto se lee entera como numeros.
 */
function leerTextosCompartidos(xml) {
  const textos = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // Un <si> puede tener varios <t> si la celda lleva texto con formatos
    // distintos ("Oficina **CENTRO**"): se concatenan todos.
    let s = "";
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
    textos.push(desescapar(s));
  }
  return textos;
}

/** "BC12" -> indice 0-based de la columna. */
function indiceDeColumna(ref) {
  const letras = String(ref || "").replace(/[^A-Z]/g, "");
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Las filas de una hoja, como matriz de cadenas. */
function leerHoja(xml, textos) {
  const filas = [];

  for (const f of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const celdas = [];
    for (const c of f[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
      const atributos = c[1] || c[3] || "";
      const dentro = c[2] || "";

      const ref = (atributos.match(/r="([A-Z]+\d+)"/) || [])[1];
      const tipo = (atributos.match(/t="([^"]+)"/) || [])[1];

      let valor = "";
      if (tipo === "inlineStr") {
        const t = dentro.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        valor = t ? desescapar(t[1]) : "";
      } else {
        const v = dentro.match(/<v>([\s\S]*?)<\/v>/);
        const crudo = v ? desescapar(v[1]) : "";
        // t="s" significa "es un indice a la tabla de textos compartidos".
        valor = tipo === "s" ? textos[Number(crudo)] || "" : crudo;
      }

      const i = ref ? indiceDeColumna(ref) : celdas.length;
      celdas[i] = String(valor == null ? "" : valor).trim();
    }

    // Las celdas vacias quedan como `undefined` por el indexado por
    // referencia: se normalizan para que el resto no tenga que comprobarlo.
    for (let i = 0; i < celdas.length; i++) if (celdas[i] === undefined) celdas[i] = "";

    if (celdas.some((c) => c !== "")) filas.push(celdas);
    if (filas.length >= MAX_FILAS) break;
  }

  return filas;
}

/** @returns {{ok:true, filas:string[][]} | {ok:false, motivo:string}} */
function leerXlsx(datos) {
  let entradas;
  try {
    entradas = abrirZip(
      datos,
      (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet1\.xml$/.test(n)
    );
  } catch (e) {
    return { ok: false, motivo: `no se pudo abrir el archivo: ${e.message}` };
  }

  const hoja = entradas.get("xl/worksheets/sheet1.xml");
  if (!hoja) {
    return {
      ok: false,
      motivo:
        "el archivo no tiene una primera hoja legible. Si lo abriste y lo guardaste con otro " +
        "programa, exportalo de nuevo desde la transportadora, o pega el texto a mano.",
    };
  }

  const compartidos = entradas.get("xl/sharedStrings.xml");
  const textos = compartidos ? leerTextosCompartidos(compartidos.toString("utf8")) : [];

  try {
    return { ok: true, filas: leerHoja(hoja.toString("utf8"), textos) };
  } catch (e) {
    return { ok: false, motivo: `no se pudo leer la hoja: ${e.message}` };
  }
}

// ==========================================================================
// CSV
// ==========================================================================

/**
 * CSV con comillas, saltos de linea dentro de celda y separador detectado.
 *
 * El separador se detecta en vez de fijarse: un CSV exportado en un Windows
 * en espanol usa punto y coma, y uno exportado por una API usa coma. Fijar
 * uno hace que el otro se lea como una sola columna gigante, que es un fallo
 * silencioso: parece que el archivo no trae datos.
 */
function leerCsv(texto) {
  const s = String(texto || "").replace(/^\uFEFF/, "");

  const primeraLinea = s.split(/\r?\n/)[0] || "";
  const cuenta = (c) => (primeraLinea.match(new RegExp(`\\${c}`, "g")) || []).length;
  const separador = [";", "\t", ",", "|"].sort((a, b) => cuenta(b) - cuenta(a))[0];

  const filas = [];
  let celda = "";
  let fila = [];
  let enComillas = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (enComillas) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          celda += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        celda += c;
      }
      continue;
    }

    if (c === '"') enComillas = true;
    else if (c === separador) {
      fila.push(celda.trim());
      celda = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      fila.push(celda.trim());
      celda = "";
      if (fila.some((x) => x !== "")) filas.push(fila);
      fila = [];
      if (filas.length >= MAX_FILAS) return { ok: true, filas, separador };
    } else {
      celda += c;
    }
  }

  fila.push(celda.trim());
  if (fila.some((x) => x !== "")) filas.push(fila);

  return { ok: true, filas, separador };
}

// ==========================================================================
// RECONOCER LAS COLUMNAS
// ==========================================================================

/**
 * Los nombres con los que las transportadoras colombianas rotulan cada dato.
 *
 * NO SE ADIVINA POR POSICION. Las columnas cambian de orden entre exports, y
 * leer "la tercera columna" funciona hasta el dia en que la transportadora
 * mete una columna nueva: entonces se le manda a cada cliente el mensaje de
 * otro, y nada avisa.
 *
 * Si no se reconoce ninguna, se cae a leer la linea entera y buscar en ella
 * un numero de guia, que es lo que hace `novedades.parsear`.
 */
const COLUMNAS = [
  {
    campo: "guia",
    nombres: ["guia", "guia no", "numero de guia", "no guia", "nro guia", "remesa", "numero remesa", "guia transportadora"],
  },
  {
    campo: "motivo",
    nombres: [
      "novedad", "motivo", "motivo novedad", "causal", "observacion", "observaciones",
      "detalle", "estado", "ultimo estado", "descripcion", "solucion",
    ],
  },
  { campo: "nombre", nombres: ["destinatario", "nombre destinatario", "cliente", "nombre cliente", "nombre"] },
  { campo: "ciudad", nombres: ["ciudad", "ciudad destino", "destino", "municipio"] },
  { campo: "direccion", nombres: ["direccion", "direccion destinatario", "direccion destino"] },
  { campo: "oficina", nombres: ["oficina", "oficina retiro", "punto de retiro", "sucursal", "agencia"] },
  { campo: "plazo", nombres: ["plazo", "fecha limite", "vence", "vencimiento", "fecha maxima", "retirar antes de"] },
  { campo: "telefono", nombres: ["telefono", "celular", "telefono destinatario", "contacto"] },
];

const aplanarEncabezado = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Busca la fila de encabezados y mapea campo -> indice de columna.
 *
 * La fila de encabezados no siempre es la primera: los exports suelen traer
 * un titulo y una fecha arriba. Se buscan las primeras diez filas y gana la
 * que reconozca mas columnas.
 *
 * @returns {{fila:number, mapa:object, reconocidas:string[]} | null}
 */
function detectarColumnas(filas) {
  let mejor = null;

  for (let f = 0; f < Math.min(filas.length, 10); f++) {
    const encabezados = (filas[f] || []).map(aplanarEncabezado);
    const mapa = {};

    for (const { campo, nombres } of COLUMNAS) {
      // --------------------------------------------------------------------
      // EL ORDEN DE `nombres` ES UN ORDEN DE PREFERENCIA
      //
      // Se recorren los nombres y se busca cada uno EXACTO, en vez de buscar
      // "el primer encabezado que este en la lista". La diferencia importa
      // cuando el archivo trae las dos columnas:
      //
      //     guia | direccion destinatario | direccion
      //
      // Buscando "el primer encabezado que aparezca en la lista" gana
      // `direccion destinatario` solo por estar antes en el ARCHIVO, aunque
      // exista una columna llamada exactamente `direccion`. Recorriendo los
      // nombres, gana el canonico, que es el que se puso primero por algo.
      //
      // Y solo si ninguno coincide exacto se busca por contenido, que es la
      // red para encabezados con texto de mas ("No. guia del envio").
      // --------------------------------------------------------------------
      let i = -1;
      for (const n of nombres) {
        i = encabezados.indexOf(n);
        if (i !== -1) break;
      }
      if (i === -1) i = encabezados.findIndex((h) => h && nombres.some((n) => h.includes(n)));
      if (i !== -1 && mapa[campo] === undefined) mapa[campo] = i;
    }

    const reconocidas = Object.keys(mapa);
    // La guia es imprescindible: sin ella no se sabe de quien es la novedad,
    // y una fila de encabezados que no la trae no es la fila de encabezados.
    if (mapa.guia === undefined) continue;
    if (!mejor || reconocidas.length > mejor.reconocidas.length) {
      mejor = { fila: f, mapa, reconocidas };
    }
  }

  return mejor;
}

/**
 * Convierte el archivo en el texto que lee `novedades.parsear`.
 *
 * Cuando se reconocen las columnas, los datos que no se pueden adivinar
 * -la guia exacta, la oficina, el plazo- van en MARCADORES `[[campo: valor]]`
 * en vez de perderse en la linea.
 *
 * Esto sale de un fallo real de BIKERPRO: la oficina y la fecha limite
 * venian en el archivo, se tiraban a la basura al convertir a texto, y
 * entonces CADA novedad de oficina quedaba bloqueada pidiendolas a mano. El
 * dato estaba y se descartaba.
 *
 * @param {Buffer|string} datos
 * @param {string} nombre nombre del archivo, para decidir el formato
 */
function aTexto(datos, nombre = "") {
  const esXlsx =
    /\.xlsx$/i.test(nombre) ||
    (Buffer.isBuffer(datos) && datos.length > 2 && datos[0] === 0x50 && datos[1] === 0x4b);

  let filas;
  let formato;

  if (esXlsx) {
    const r = leerXlsx(Buffer.isBuffer(datos) ? datos : Buffer.from(datos));
    if (!r.ok) return r;
    filas = r.filas;
    formato = "xlsx";
  } else {
    const r = leerCsv(Buffer.isBuffer(datos) ? datos.toString("utf8") : datos);
    filas = r.filas;
    formato = "csv";
  }

  if (!filas.length) {
    return { ok: false, motivo: "el archivo no trae ninguna fila con datos" };
  }

  const columnas = detectarColumnas(filas);

  if (!columnas) {
    // Sin encabezados reconocidos NO se inventa un mapeo: se pasan las filas
    // tal cual y el clasificador busca la guia dentro de cada linea. Peor,
    // pero honesto, y el panel dice que no se reconocieron las columnas para
    // que se pueda mirar si cambio el encabezado.
    return {
      ok: true,
      formato,
      columnas: null,
      cuantas: filas.length,
      texto: filas.map((f) => f.filter(Boolean).join(" ; ")).join("\n"),
    };
  }

  const { mapa, fila: filaEncabezado } = columnas;
  const dato = (f, campo) => (mapa[campo] === undefined ? "" : String(f[mapa[campo]] || "").trim());

  const lineas = [];
  for (let i = filaEncabezado + 1; i < filas.length; i++) {
    const f = filas[i];
    const guia = dato(f, "guia");
    if (!guia) continue;

    const partes = [];
    const marca = (campo) => {
      const v = dato(f, campo);
      if (v) partes.push(`[[${campo}: ${v}]]`);
    };

    marca("guia");
    // El motivo va en claro porque es lo que el clasificador lee para
    // decidir el tipo de novedad.
    const motivo = dato(f, "motivo");
    if (motivo) partes.push(motivo);
    for (const campo of ["nombre", "ciudad"]) {
      const v = dato(f, campo);
      if (v) partes.push(v);
    }
    marca("oficina");
    marca("plazo");
    marca("direccion");

    lineas.push(partes.join(" ; "));
  }

  return {
    ok: true,
    formato,
    columnas: {
      fila: filaEncabezado + 1,
      reconocidas: columnas.reconocidas,
      // Para que el panel pueda avisar si la transportadora dejo de mandar
      // la oficina: sin ella, las novedades de oficina quedan bloqueadas y
      // conviene saber que es el archivo y no el sistema.
      conOficina: mapa.oficina !== undefined,
      conPlazo: mapa.plazo !== undefined,
    },
    cuantas: lineas.length,
    texto: lineas.join("\n"),
  };
}

module.exports = {
  MAX_FILAS,
  COLUMNAS,
  leerCsv,
  leerXlsx,
  detectarColumnas,
  aplanarEncabezado,
  aTexto,
};
