"use strict";

// ==========================================================================
// EL LOTE DE GUIAS, DE PUNTA A PUNTA, CON UN PDF DE VERDAD
//
// --------------------------------------------------------------------------
// POR QUE ESTA PRUEBA EXISTE
// --------------------------------------------------------------------------
//
// La auditoria de este repositorio -`docs/PANEL-DE-BIKERPRO-A-NOVIKA.md`-
// daba el lector de guias por BLOQUEADO, y el motivo era bueno:
//
//     "el lector esta ajustado al formato exacto de ese PDF. Para NOVIKA
//      falta un PDF real de ejemplo contra el que ajustar y probar el
//      lector. Sin eso, portar el parser es escribir codigo que no se puede
//      verificar."
//
// Esa conclusion asumia que hacia falta un PDF DE LA TRANSPORTADORA. No
// hace falta: el PDF se GENERA aqui con la misma libreria que lo parte, con
// los rotulos que imprimen las transportadoras colombianas. Eso verifica
// toda la cadena -leer el texto, partir las hojas, parear, enviar- sin
// depender de que alguien consiga un archivo.
//
// Lo que esta prueba NO puede verificar, y hay que decirlo: si la
// transportadora que elija NOVIKA usa rotulos distintos a los de aqui, el
// lector tendra que ajustarse. Pero entonces el ajuste es una linea en
// `extraerCampos` con esta bateria de red, no un modulo entero sin probar.
//
// --------------------------------------------------------------------------
// Y VERIFICA EL CANDADO EN EL CAMINO COMPLETO
// --------------------------------------------------------------------------
//
// Con PANEL_ENVIO_MANUAL apagado, el lote se puede subir y revisar entero
// -que es lo que permite construir y operar el panel sin riesgo- y al
// enviar, cada guia dice que la freno el interruptor. Nunca un envio
// fingido.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");

const path = require("node:path");

const ayuda = require("./ayuda");
const dir = ayuda.entornoDePrueba({ PANEL_TOKEN: "token_del_panel_de_prueba" });

/**
 * Los repositorios del servicio viven en la MISMA subcarpeta que usa
 * `crearRepos`. Sembrando en otra, la app no veria los pedidos y el pareo
 * contestaria "no hay pedidos guardados" aunque la prueba acabe de crear uno.
 */
const DIR_REPOS = path.join(dir, "transaccional");

const { crearApp } = require("../src/app");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const pdfLector = require("../src/despacho/pdf");
const guias = require("../src/despacho/guias");

/**
 * Un PDF con una etiqueta por pagina, con los rotulos que de verdad se
 * imprimen.
 */
async function pdfDeEtiquetas(etiquetas) {
  const { PDFDocument, StandardFonts } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const fuente = await doc.embedFont(StandardFonts.Helvetica);

  for (const e of etiquetas) {
    const pagina = doc.addPage([400, 600]);
    const lineas = [
      e.transportadora || "INTER RAPIDISIMO S.A.S.",
      `GUIA No. ${e.guia}`,
      `REMITENTE: NOVIKA  TEL 3109998877`,
      `DESTINATARIO: ${e.nombre}`,
      `DIRECCION: ${e.direccion}`,
      `CIUDAD: ${e.ciudad}`,
      `TELEFONO: ${e.telefono}`,
      `VALOR A RECAUDAR: ${e.total || "89000"}`,
    ];
    let y = 560;
    for (const linea of lineas) {
      pagina.drawText(linea, { x: 20, y, size: 11, font: fuente });
      y -= 26;
    }
  }

  return Buffer.from(await doc.save());
}

function pedidoDespachable({ id, contactoId, nombre, telefono, ciudad, direccion }) {
  return {
    id,
    version: 1,
    estado: "confirmado",
    claveDeEvento: `ev-${id}`,
    claveDeOferta: `of-${id}`,
    contactoId,
    conversacionId: contactoId,
    ofertaId: `of-${id}`,
    wamidConfirmacion: `wamid.${id}`,
    producto: { id: "p", nombre: "Producto", variante: null },
    cantidad: 1,
    destinatario: { nombre, telefono, ciudad, direccion, documento: null, departamento: null, referencia: null },
    cotizacion: { total: 89000, subtotal: 89000, envio: 0, descuento: 0, cantidad: 1, productoId: "p", productoNombre: "Producto" },
    firmaDeCondiciones: "x",
    origen: null,
    revisiones: [],
    historial: [],
    creadoEn: new Date().toISOString(),
    actualizadoEn: new Date().toISOString(),
    canceladoEn: null,
    motivoCancelacion: null,
  };
}

describe("el lote de guias, con un PDF real", () => {
  async function levantar() {
    const servidor = await ayuda.levantar(crearApp());
    const entrar = async () => {
      const r = await fetch(`${servidor.url}/panel/entrar`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=token_del_panel_de_prueba",
        redirect: "manual",
      });
      return (r.headers.get("set-cookie") || "").split(";")[0];
    };
    return { ...servidor, entrar };
  }

  // ------------------------------------------------------------------------
  // 1 · Leer el PDF
  // ------------------------------------------------------------------------

  test("lee el texto de cada pagina y la parte en una hoja por guia", async () => {
    const archivo = await pdfDeEtiquetas([
      { guia: "240061604892", nombre: "ANA MARIA PEREZ", direccion: "CALLE 45 # 23-10", ciudad: "MEDELLIN", telefono: "3001112233" },
      { guia: "240061604893", nombre: "LUIS GOMEZ", direccion: "CARRERA 7 # 80-12", ciudad: "LA PLAYA", telefono: "3154445566" },
    ]);

    const lote = await pdfLector.abrirLote(archivo);
    assert.equal(lote.ok, true, lote.motivo);
    assert.equal(lote.paginas.length, 2);
    assert.equal(lote.hojas.length, 2);

    // ----------------------------------------------------------------------
    // Y SE LEYO EN EL PROCESO HIJO, que es el arreglo de memoria entero.
    //
    // `pdfjs` no devuelve lo que usa: 41 MB solo por cargarse y ~71 MB por
    // lote, medido. Con el contenedor de 512 MB de Render, dos o tres lotes
    // y el proceso muere. El camino de respaldo funciona -es mejor gastar
    // memoria que no poder mandar las guias- pero si se activa en silencio,
    // la fuga vuelve sin que nada lo diga.
    // ----------------------------------------------------------------------
    assert.equal(
      lote.enProcesoAparte,
      true,
      `la lectura cayo al camino que no devuelve la memoria: ${lote.aviso || "sin aviso"}`
    );

    // Cada hoja es un PDF independiente y valido.
    for (const hoja of lote.hojas) {
      assert.equal(hoja.slice(0, 5).toString(), "%PDF-");
    }

    // Y el texto se leyo de verdad.
    const texto = lote.paginas[0].join(" ");
    assert.match(texto, /240061604892/);
    assert.match(texto, /ANA MARIA PEREZ/);
  });

  test("del PDF generado saca la guia, el nombre, la ciudad y el telefono", async () => {
    const archivo = await pdfDeEtiquetas([
      { guia: "240061604892", nombre: "ANA MARIA PEREZ", direccion: "CALLE 45 # 23-10", ciudad: "MEDELLIN", telefono: "3001112233" },
    ]);
    const lote = await pdfLector.abrirLote(archivo);

    const campos = guias.extraerCampos(lote.paginas[0], { telefonosRemitente: ["3109998877"] });
    assert.equal(campos.guia, "240061604892");
    assert.match(campos.nombre, /ANA MARIA PEREZ/);
    assert.match(campos.ciudad, /MEDELLIN/);
    assert.deepEqual(campos.telefonos, ["3001112233"]);
  });

  test("EL TELEFONO DEL REMITENTE NO ENSUCIA EL PAREO", async () => {
    // Va impreso en toda etiqueta y tiene la misma forma que el del cliente.
    // Si entra, suma 50 puntos contra cualquier pedido.
    const archivo = await pdfDeEtiquetas([
      { guia: "240061604892", nombre: "ANA MARIA PEREZ", direccion: "CALLE 45 # 23-10", ciudad: "MEDELLIN", telefono: "3001112233" },
    ]);
    const lote = await pdfLector.abrirLote(archivo);

    const sinFiltro = guias.extraerCampos(lote.paginas[0]);
    assert.ok(sinFiltro.telefonos.includes("3109998877"), "el PDF de prueba tiene que traer el remitente");

    const conFiltro = guias.extraerCampos(lote.paginas[0], { telefonosRemitente: ["3109998877"] });
    assert.ok(!conFiltro.telefonos.includes("3109998877"), "no filtro el telefono del remitente");
  });

  // ------------------------------------------------------------------------
  // 2 · El recorrido completo por HTTP
  // ------------------------------------------------------------------------

  test("sube el PDF por HTTP, parea contra los pedidos y NO envia nada", async () => {
    const repos = await crearReposDeArchivos({ dir: DIR_REPOS });
    await repos.pedidos.crearSiNoExiste(
      pedidoDespachable({
        id: "NOV-ANA",
        contactoId: "573001112233",
        nombre: "Ana Maria Perez",
        telefono: "3001112233",
        ciudad: "Medellin",
        direccion: "Calle 45 # 23-10",
      })
    );
    await repos.cerrar();

    const archivo = await pdfDeEtiquetas([
      { guia: "240061604892", nombre: "ANA MARIA PEREZ", direccion: "CALLE 45 # 23-10", ciudad: "MEDELLIN", telefono: "3001112233" },
      // Una que no corresponde a nadie.
      { guia: "240061604999", nombre: "ZZZZ QQQQ", direccion: "AVENIDA 1", ciudad: "LETICIA", telefono: "3209990000" },
    ]);

    const s = await levantar();
    try {
      const cookie = await s.entrar();

      const r = await fetch(`${s.url}/panel/guias/revisar`, {
        method: "POST",
        headers: { cookie, "content-type": "application/pdf" },
        body: archivo,
      });

      assert.equal(r.status, 200);
      const plan = await r.json();
      assert.equal(plan.ok, true);
      assert.equal(plan.filas.length, 2);

      const deAna = plan.filas.find((f) => f.guia === "240061604892");
      assert.ok(deAna, "no leyo la guia de Ana");
      assert.equal(deAna.enviar, true, "no pareo la guia que si corresponde");
      assert.equal(deAna.pedido.codigo, "NOV-ANA");
      assert.ok(deAna.certeza >= guias.MINIMO);

      const huerfana = plan.filas.find((f) => f.guia === "240061604999");
      assert.equal(huerfana.enviar, false, "pareo una guia que no corresponde a nadie");
      assert.equal(huerfana.asignable, true, "no ofrece asignarla a mano");

      // ------------------------------------------------------------------
      // LAS ETIQUETAS NO SALEN DEL SERVIDOR
      //
      // Cada hoja lleva nombre, direccion y telefono impresos. El navegador
      // no necesita el PDF para revisar el pareo.
      // ------------------------------------------------------------------
      const crudo = JSON.stringify(plan);
      assert.ok(!/%PDF-/.test(crudo), "mando el PDF de las etiquetas al navegador");
      assert.ok(!plan.filas.some((f) => f.hoja), "mando las hojas al navegador");

      // Y se ofrecen TODOS los pedidos para asignar a mano, con el telefono
      // recortado: para reconocerlo alcanzan los ultimos cuatro digitos.
      assert.ok(plan.candidatos.length >= 1);
      assert.equal(plan.candidatos[0].cel4, "2233");
      assert.ok(!JSON.stringify(plan.candidatos).includes("3001112233"), "mando telefonos completos");
    } finally {
      await s.cerrar();
    }
  });

  test("EL CANDADO: con el envio manual apagado, el lote se revisa pero no sale ni una guia", async () => {
    // Es lo que permite operar el panel completo sin que se escape un
    // WhatsApp real. Y el panel muestra el motivo, nunca un envio fingido.
    const repos = await crearReposDeArchivos({ dir: DIR_REPOS });
    await repos.pedidos.crearSiNoExiste(
      pedidoDespachable({
        id: "NOV-LUIS",
        contactoId: "573154445566",
        nombre: "Luis Gomez",
        telefono: "3154445566",
        ciudad: "La Playa",
        direccion: "Carrera 7 # 80-12",
      })
    );
    await repos.cerrar();

    const archivo = await pdfDeEtiquetas([
      { guia: "240061605001", nombre: "LUIS GOMEZ", direccion: "CARRERA 7 # 80-12", ciudad: "LA PLAYA", telefono: "3154445566" },
    ]);

    const s = await levantar();
    try {
      const cookie = await s.entrar();

      const rev = await fetch(`${s.url}/panel/guias/revisar`, {
        method: "POST",
        headers: { cookie, "content-type": "application/pdf" },
        body: archivo,
      });
      const plan = await rev.json();
      const fila = plan.filas.find((f) => f.guia === "240061605001");
      assert.ok(fila && fila.enviar, "no pareo la guia de Luis (¿se perdio 'La Playa'?)");

      const env = await fetch(`${s.url}/panel/guias/enviar`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ id: plan.id, paginas: [fila.pagina] }),
      });

      assert.equal(env.status, 200);
      const salida = await env.json();
      assert.equal(salida.ok, true);
      assert.equal(salida.enviadas, 0, "salio una guia con el interruptor apagado");
      assert.equal(salida.fallaron, 1);
      // Y dice POR QUE, en lenguaje de operador y no con el codigo interno.
      assert.match(salida.resultados[0].porQue, /PANEL_ENVIO_MANUAL|apagad/i);

      // ------------------------------------------------------------------
      // PERO EL PEDIDO SI QUEDO DESPACHADO, CON SU GUIA
      //
      // Mandar la guia ES despachar. Si no se registrara, el pedido seguiria
      // en "por despachar" con su guia ya emitida: la lista de pendientes
      // mentiria y en el siguiente lote esa guia volveria a ofrecerse.
      //
      // Y el aviso queda con el resultado REAL del intento, no con un
      // "avisado: si" de un mensaje que nadie recibio.
      // ------------------------------------------------------------------
      const despues = await crearReposDeArchivos({ dir: DIR_REPOS });
      try {
        const p = await despues.pedidos.obtener("NOV-LUIS");
        assert.equal(p.estado, "despachado", "no registro el despacho");
        assert.equal(p.despacho.guia, "240061605001");
        assert.equal(p.despacho.avisoAlCliente.enviado, false);
        assert.equal(p.despacho.avisoAlCliente.bloqueado, true);
        assert.equal(
          p.despacho.avisoAlCliente.entregadoEn,
          null,
          "dio por entregado un mensaje que ni salio"
        );
      } finally {
        await despues.cerrar();
      }
    } finally {
      await s.cerrar();
    }
  });

  test("un PDF con la cabecera desplazada se acepta; un archivo que no es PDF se rechaza con el motivo", async () => {
    const s = await levantar();
    try {
      const cookie = await s.entrar();

      const noEsPdf = await fetch(`${s.url}/panel/guias/revisar`, {
        method: "POST",
        headers: { cookie, "content-type": "application/pdf" },
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]),
      });
      assert.equal(noEsPdf.status, 400);
      const error = await noEsPdf.json();
      assert.match(error.error, /no parece un PDF/i);
      // El motivo tiene que permitir actuar: tamano y primeros bytes.
      assert.match(error.error, /bytes/);

      // Y uno reenviado, con preambulo antes de la cabecera, SI entra.
      const real = await pdfDeEtiquetas([
        { guia: "240061605100", nombre: "ANA MARIA PEREZ", direccion: "CALLE 45 # 23-10", ciudad: "MEDELLIN", telefono: "3001112233" },
      ]);
      const reenviado = Buffer.concat([Buffer.from("basura de reenvio"), real]);

      const r = await fetch(`${s.url}/panel/guias/revisar`, {
        method: "POST",
        headers: { cookie, "content-type": "application/pdf" },
        body: reenviado,
      });
      assert.equal(r.status, 200, "rechazo un PDF valido con preambulo");
    } finally {
      await s.cerrar();
    }
  });

  test("la sesion es obligatoria para subir un PDF", async () => {
    const s = await levantar();
    try {
      const r = await fetch(`${s.url}/panel/guias/revisar`, {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: Buffer.from("%PDF-1.4"),
      });
      assert.equal(r.status, 401);
      // En JSON, no texto suelto: hacer r.json() sobre "Forbidden" muestra
      // "Unexpected token 'F'" y manda a buscar el problema donde no esta.
      assert.match(r.headers.get("content-type") || "", /application\/json/);
    } finally {
      await s.cerrar();
    }
  });
});
