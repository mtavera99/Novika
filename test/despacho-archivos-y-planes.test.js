"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Tres piezas de fontaneria que, cuando fallan, no se ven como un fallo:
//
//   EL LECTOR DEL ARCHIVO. Si el separador del CSV se fija en vez de
//   detectarse, un export con punto y coma se lee como UNA columna gigante y
//   la pantalla dice "0 novedades". Parece que el archivo venia vacio.
//
//   LAS COLUMNAS, POR NOMBRE Y NO POR POSICION. Leer "la tercera columna"
//   funciona hasta el dia en que la transportadora mete una columna nueva:
//   entonces se le manda a cada cliente el mensaje de otro, y nada avisa.
//
//   EL PLAN. Entre revisar y enviar puede haber un despliegue. En BIKERPRO
//   eso devolvia un 400 pelado y parecia un fallo del panel; el operador no
//   tenia forma de saber que solo habia que volver a subir el archivo. Y sin
//   topes de vida, un plan con decenas de MB de PDF dentro se queda en
//   memoria hasta que Render mata el proceso.
//
//   EL PDF REENVIADO. Un PDF que paso por WhatsApp puede traer bytes antes
//   de la cabecera "%PDF-". Daba un 400 sin explicacion y parecia corrupto.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");

require("./ayuda").entornoDePrueba();
const hoja = require("../src/despacho/hoja-de-calculo");
const planes = require("../src/despacho/planes");
const pdf = require("../src/despacho/pdf");

// --------------------------------------------------------------------------
// Un .xlsx de verdad, construido aqui.
//
// Se construye en vez de guardar un binario en el repositorio: asi se ve
// exactamente que estructura se esta probando, y no hay un archivo opaco que
// nadie sabe de donde salio.
// --------------------------------------------------------------------------

function crc32(buf) {
  let c;
  const tabla = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabla[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = tabla[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Un ZIP con las entradas desinfladas (metodo 8), como lo escribe Excel. */
function construirZip(entradas) {
  const locales = [];
  const centrales = [];
  let offset = 0;

  for (const [nombre, texto] of Object.entries(entradas)) {
    const crudo = Buffer.from(texto, "utf8");
    const comprimido = zlib.deflateRawSync(crudo);
    const nombreBuf = Buffer.from(nombre, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc32(crudo), 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(crudo.length, 22);
    local.writeUInt16LE(nombreBuf.length, 26);
    locales.push(local, nombreBuf, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(crudo), 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(crudo.length, 24);
    central.writeUInt16LE(nombreBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrales.push(central, nombreBuf);

    offset += 30 + nombreBuf.length + comprimido.length;
  }

  const cuerpo = Buffer.concat(locales);
  const directorio = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(Object.keys(entradas).length, 8);
  fin.writeUInt16LE(Object.keys(entradas).length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(cuerpo.length, 16);

  return Buffer.concat([cuerpo, directorio, fin]);
}

/** Un .xlsx con una hoja de texto, usando la tabla de textos compartidos. */
function xlsxDePrueba(filas) {
  const textos = [];
  const indiceDe = (v) => {
    const i = textos.indexOf(v);
    if (i !== -1) return i;
    textos.push(v);
    return textos.length - 1;
  };

  const letra = (i) => String.fromCharCode(65 + i);
  const cuerpo = filas
    .map((fila, f) => {
      const celdas = fila
        .map((v, c) => `<c r="${letra(c)}${f + 1}" t="s"><v>${indiceDe(String(v))}</v></c>`)
        .join("");
      return `<row r="${f + 1}">${celdas}</row>`;
    })
    .join("");

  const compartidos =
    `<?xml version="1.0"?><sst count="${textos.length}" uniqueCount="${textos.length}">` +
    textos.map((t) => `<si><t>${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</t></si>`).join("") +
    `</sst>`;

  return construirZip({
    "xl/sharedStrings.xml": compartidos,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>${cuerpo}</sheetData></worksheet>`,
  });
}

// --------------------------------------------------------------------------
// 1 · CSV
// --------------------------------------------------------------------------

test("detecta el separador en vez de fijarlo", () => {
  // Un export de un Windows en espanol usa punto y coma; uno de una API,
  // coma. Fijar uno hace que el otro se lea como una columna gigante.
  for (const sep of [";", ",", "\t", "|"]) {
    const r = hoja.leerCsv(`guia${sep}novedad\n111111111${sep}ausente`);
    assert.equal(r.separador, sep, `no detecto "${sep}"`);
    assert.deepEqual(r.filas[1], ["111111111", "ausente"]);
  }
});

test("respeta las comillas y las comas dentro de una celda", () => {
  const r = hoja.leerCsv('guia,direccion\n111111111,"Calle 45 # 23-10, apto 302"');
  assert.deepEqual(r.filas[1], ["111111111", "Calle 45 # 23-10, apto 302"]);
});

test("se come el BOM que pone Excel", () => {
  // Sin esto el primer encabezado llega como "\uFEFFguia" y no se reconoce.
  const r = hoja.leerCsv("\uFEFFguia;novedad\n111111111;ausente");
  assert.equal(r.filas[0][0], "guia");
});

// --------------------------------------------------------------------------
// 2 · Reconocer las columnas
// --------------------------------------------------------------------------

test("encuentra los encabezados aunque no esten en la primera fila", () => {
  // Los exports suelen traer un titulo y una fecha arriba.
  const filas = [
    ["Reporte de novedades"],
    ["Generado el 08/10/2026"],
    ["Numero de guia", "Motivo novedad", "Destinatario", "Ciudad"],
    ["240061604892", "Destinatario ausente", "Ana Perez", "Medellin"],
  ];
  const c = hoja.detectarColumnas(filas);
  assert.equal(c.fila, 2);
  assert.equal(c.mapa.guia, 0);
  assert.equal(c.mapa.motivo, 1);
});

test("sin columna de guia, esa fila NO es la de encabezados", () => {
  // Sin la guia no se sabe de quien es la novedad.
  const c = hoja.detectarColumnas([["Cliente", "Ciudad"], ["Ana", "Cali"]]);
  assert.equal(c, null);
});

test("la coincidencia EXACTA gana sobre la parcial", () => {
  // Al reves, "direccion" se quedaria con "direccion destinatario" aunque
  // existiera una columna llamada exactamente "direccion".
  const c = hoja.detectarColumnas([["guia", "direccion destinatario", "direccion"]]);
  assert.equal(c.mapa.direccion, 2);
});

// --------------------------------------------------------------------------
// 3 · El archivo completo
// --------------------------------------------------------------------------

test("LA OFICINA Y EL PLAZO NO SE PIERDEN: salen como marcadores", () => {
  // Venian en el archivo y se tiraban al convertir a texto, asi que CADA
  // novedad de oficina quedaba bloqueada pidiendo a mano un dato que ya
  // estaba.
  const csv = [
    "guia;novedad;destinatario;ciudad;oficina;fecha limite",
    "240061604892;Reclame en oficina;Ana Perez;Medellin;Centro Medellin;15/10/2026",
  ].join("\n");

  const r = hoja.aTexto(Buffer.from(csv), "novedades.csv");
  assert.equal(r.ok, true);
  assert.equal(r.formato, "csv");
  assert.equal(r.cuantas, 1);
  assert.match(r.texto, /\[\[guia: 240061604892\]\]/);
  assert.match(r.texto, /\[\[oficina: Centro Medellin\]\]/);
  assert.match(r.texto, /\[\[plazo: 15\/10\/2026\]\]/);
  assert.equal(r.columnas.conOficina, true);
});

test("lee un .xlsx de verdad, con su tabla de textos compartidos", () => {
  const archivo = xlsxDePrueba([
    ["Guia", "Novedad", "Destinatario", "Ciudad"],
    ["240061604892", "No se localiza direccion", "Ana Perez", "Medellin"],
    ["64532761837", "Destinatario ausente", "Luis Gomez", "Cali"],
  ]);

  const r = hoja.aTexto(archivo, "novedades.xlsx");
  assert.equal(r.ok, true);
  assert.equal(r.formato, "xlsx");
  assert.equal(r.cuantas, 2);
  assert.match(r.texto, /240061604892/);
  assert.match(r.texto, /No se localiza direccion/);
  assert.match(r.texto, /Luis Gomez/);
});

test("reconoce un xlsx por sus bytes, aunque el nombre no lo diga", () => {
  const archivo = xlsxDePrueba([["Guia", "Novedad"], ["111111111", "ausente"]]);
  const r = hoja.aTexto(archivo, "sin-extension");
  assert.equal(r.formato, "xlsx");
});

test("si no reconoce los encabezados lo DICE, en vez de parecer que no hay datos", () => {
  // La causa suele ser que la transportadora cambio el formato.
  const csv = "240061604892;Destinatario ausente;Ana Perez";
  const r = hoja.aTexto(Buffer.from(csv), "raro.csv");
  assert.equal(r.ok, true);
  assert.equal(r.columnas, null);
  assert.match(r.texto, /240061604892/);
});

test("avisa cuando el archivo no trae columna de oficina", () => {
  // Sin ella las novedades de oficina quedan bloqueadas, y conviene saber
  // que es el archivo y no el sistema.
  const csv = "guia;novedad\n240061604892;Reclame en oficina";
  const r = hoja.aTexto(Buffer.from(csv), "n.csv");
  assert.equal(r.columnas.conOficina, false);
});

// --------------------------------------------------------------------------
// 4 · Los planes
// --------------------------------------------------------------------------

test("un plan se guarda y se recupera", () => {
  const almacen = planes.crearAlmacenDePlanes();
  const id = almacen.guardar({ filas: [{ pagina: 1 }] });
  const r = almacen.obtener(id);
  assert.equal(r.ok, true);
  assert.equal(r.contenido.filas.length, 1);
  almacen.cerrar();
});

test("caduca sin usarse, y lo explica en vez de devolver un error pelado", () => {
  let t = 1000;
  const almacen = planes.crearAlmacenDePlanes({ ahora: () => t });
  const id = almacen.guardar({ filas: [] });

  t += planes.TTL_MS + 1;
  const r = almacen.obtener(id);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, planes.MOTIVOS.CADUCADO);
  assert.match(r.explicacion, /No se envio nada/);
  assert.match(r.explicacion, /Vuelve a subir el archivo/);
  almacen.cerrar();
});

test("usarlo lo mantiene vivo: un reintento no obliga a volver a subir el PDF", () => {
  let t = 1000;
  const almacen = planes.crearAlmacenDePlanes({ ahora: () => t });
  const id = almacen.guardar({ filas: [] });

  // Se toca justo antes de caducar, tres veces.
  for (let i = 0; i < 3; i++) {
    t += planes.TTL_MS - 1000;
    assert.equal(almacen.obtener(id).ok, true, `caduco en el refresco ${i + 1}`);
  }
  almacen.cerrar();
});

test("PERO LA VIDA MAXIMA NO SE REFRESCA: un plan no vive para siempre", () => {
  // Sin este tope, un plan que se reintenta cada hora y media se queda en
  // memoria con sus hojas de PDF dentro: una fuga lenta que solo se nota
  // cuando Render mata el proceso.
  let t = 1000;
  const almacen = planes.crearAlmacenDePlanes({ ahora: () => t });
  const id = almacen.guardar({ filas: [] });

  let vivo = true;
  for (let i = 0; i < 20 && vivo; i++) {
    t += planes.TTL_MS - 1000;
    vivo = almacen.obtener(id).ok;
  }
  assert.equal(vivo, false, "el plan sobrevivio a la vida maxima");
  almacen.cerrar();
});

test("UN REINICIO SE DISTINGUE DE UNA CADUCIDAD", () => {
  // Es la diferencia entre "esperaste mucho" y "no hiciste nada mal, hubo un
  // despliegue". En BIKERPRO las dos daban el mismo 400 sin explicacion.
  const almacen = planes.crearAlmacenDePlanes();
  const r = almacen.obtener("un-id-que-nunca-existio");
  assert.equal(r.ok, false);
  assert.equal(r.motivo, planes.MOTIVOS.REINICIADO);
  assert.match(r.explicacion, /se reinicio/);
  assert.match(r.explicacion, /No se envio nada/);
  almacen.cerrar();
});

test("con el tope de planes se descarta EL MAS VIEJO, nunca el nuevo", () => {
  // El nuevo es el que el operador tiene delante en la pantalla.
  let t = 1000;
  const almacen = planes.crearAlmacenDePlanes({ ahora: () => t });

  const ids = [];
  for (let i = 0; i < planes.MAX_PLANES + 2; i++) {
    t += 1000;
    ids.push(almacen.guardar({ filas: [], n: i }));
  }

  assert.equal(almacen.obtener(ids[0]).ok, false, "conservo el mas viejo");
  assert.equal(almacen.obtener(ids[ids.length - 1]).ok, true, "descarto el mas nuevo");
  almacen.cerrar();
});

test("dice cuanta memoria retiene, para poder mirarlo ANTES de que Render mate el proceso", () => {
  const almacen = planes.crearAlmacenDePlanes();
  almacen.guardar({ filas: [{ hoja: Buffer.alloc(2 * 1048576) }] });
  const e = almacen.estado();
  assert.equal(e.vivos, 1);
  assert.ok(e.mbRetenidos >= 2, `no conto los MB retenidos: ${e.mbRetenidos}`);
  almacen.cerrar();
});

// --------------------------------------------------------------------------
// 5 · Validar el PDF
// --------------------------------------------------------------------------

test("EL PDF REENVIADO: encuentra la cabecera aunque no este en el byte 0", () => {
  // Un PDF reenviado por WhatsApp o pasado por un conversor puede traer
  // bytes de preambulo. Daba un 400 sin explicacion.
  const conBasura = Buffer.concat([Buffer.from("basura previa"), Buffer.from("%PDF-1.4 resto")]);
  const r = pdf.revisarPdf(conBasura);
  assert.equal(r.ok, true);
  assert.ok(r.datos.slice(0, 5).toString() === "%PDF-", "no recorto el preambulo");
});

test("si no es un PDF, el error dice el tamano y los primeros bytes", () => {
  // "No es un PDF valido" no permite averiguar nada; con el tamano se ve
  // enseguida si lo que se subio fue un archivo vacio o una imagen.
  const r = pdf.revisarPdf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /4 bytes/);
  assert.match(r.motivo, /89 50 4e 47/);
});

test("un archivo vacio se dice que esta vacio", () => {
  const r = pdf.revisarPdf(Buffer.alloc(0));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /vacio/);
});
