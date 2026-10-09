"use strict";

// ==========================================================================
// ENVIO DE FOTOS DE PRODUCTO
//
// Ninguna prueba sale a la red: el `fetch` esta sustituido por un espia que
// apunta lo que SALDRIA y devuelve lo que devolveria Meta. Asi se puede
// comprobar el orden, el pie y los candados sin escribirle a nadie.
//
// Lo que se fija:
//
//   - los mismos candados que el texto: interruptor, pausa, permisos;
//   - EN ORDEN, porque las cinco fotos cuentan algo en secuencia;
//   - sin repetir, porque diez fotos iguales es por lo que alguien bloquea
//     un numero;
//   - la imagen se comprueba ANTES de llamar a Meta;
//   - el historial guarda el resultado REAL de cada foto.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const { crearEmisor, PERMISOS, MOTIVOS_BLOQUEO, MAX_PIE_DE_FOTO } = require("../src/whatsapp/enviar");
const fotos = require("../src/whatsapp/fotos");
const atencion = require("../src/almacen/atencion");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");

const PRODUCTO = require("../catalogo/productos/cinturon-termico-colicos.json");
const URL_PUBLICA = "https://novika-bot.onrender.com";

const CONFIG = {
  respuestaAutomatica: true,
  panelEnvioManual: true,
  whatsappToken: "token_de_prueba",
  idNumero: "111111111111111",
  versionGraph: "v21.0",
  urlPublica: URL_PUBLICA,
};

/** fetch espia: apunta lo que saldria, no sale. */
function espia({ fallaEn = null } = {}) {
  const llamadas = [];
  const f = async (url, opciones) => {
    const cuerpo = JSON.parse(opciones.body);
    llamadas.push(cuerpo);
    if (fallaEn && llamadas.length === fallaEn) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { code: 131053, message: "Media upload error" } }),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: `wamid.FOTO${llamadas.length}` }] }),
      text: async () => "",
    };
  };
  f.llamadas = llamadas;
  return f;
}

async function conversacionNueva() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-fotos-"));
  const repos = await crearReposDeArchivos({ dir });
  const id = "573058742138";
  await repos.contactos.guardar({ id, telefono: id });
  const conv = { contactoId: id, estado: "producto", productoId: PRODUCTO.id, ficha: {} };
  await repos.conversaciones.guardar(conv);
  return { repos, conv, id };
}

// ==========================================================================
// 1 · UNA IMAGEN
// ==========================================================================

describe("1 · enviarImagen", () => {
  test("ESCENARIO: manda la foto por `link` con la URL publica", async () => {
    const fetchImpl = espia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl });

    const r = await emisor.enviarImagen({
      para: "573058742138",
      archivo: PRODUCTO.imagenes[0].archivo,
      pie: "El cinturon termico",
      permiso: PERMISOS.CONVERSACION,
    });

    assert.equal(r.enviado, true);
    assert.equal(r.wamid, "wamid.FOTO1");
    assert.equal(fetchImpl.llamadas.length, 1);

    const c = fetchImpl.llamadas[0];
    assert.equal(c.type, "image");
    assert.equal(c.image.link, `${URL_PUBLICA}/imagenes/cinturon-termico/01-frente.jpg`);
    assert.equal(c.image.caption, "El cinturon termico");
    assert.ok(/^https:\/\//.test(c.image.link), "Meta solo descarga por HTTPS");
  });

  test("sin pie, no manda `caption` vacio", async () => {
    const fetchImpl = espia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl });
    await emisor.enviarImagen({ para: "573001112233", archivo: PRODUCTO.imagenes[1].archivo, permiso: PERMISOS.CONVERSACION });
    assert.equal(fetchImpl.llamadas[0].image.caption, undefined);
  });

  test("el pie se recorta al limite de WhatsApp", async () => {
    // Meta lo corta sin avisar. Un texto cortado por el servidor de otro a
    // mitad de una frase es peor que uno que nosotros acortamos.
    const fetchImpl = espia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl });
    await emisor.enviarImagen({
      para: "573001112233",
      archivo: PRODUCTO.imagenes[0].archivo,
      pie: "a".repeat(MAX_PIE_DE_FOTO + 500),
      permiso: PERMISOS.CONVERSACION,
    });
    assert.equal(fetchImpl.llamadas[0].image.caption.length, MAX_PIE_DE_FOTO);
  });

  test("una imagen que NO cumple se rechaza SIN llamar a Meta", async () => {
    // Con `link`, Meta descarga la URL y devuelve 131053 si no puede. Eso
    // pasa con el cliente esperando. Comprobarlo antes lo convierte en un
    // motivo claro y ahorra la llamada.
    const fetchImpl = espia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl });

    const casos = [
      ["catalogo/imagenes/cinturon-termico/no-existe.jpg", /no existe/],
      ["catalogo/imagenes/cinturon-termico/originales/01frente..heic", /no es jpeg ni png/],
    ];
    for (const [archivo, esperado] of casos) {
      const r = await emisor.enviarImagen({ para: "573001112233", archivo, permiso: PERMISOS.CONVERSACION });
      assert.equal(r.enviado, false, `acepto ${archivo}`);
      assert.equal(r.motivo, MOTIVOS_BLOQUEO.IMAGEN_NO_ENVIABLE);
      assert.match(r.detalle, esperado);
    }
    assert.equal(fetchImpl.llamadas.length, 0, "no se puede llamar a Meta con una imagen invalida");
  });

  test("sin URL publica no se manda nada", async () => {
    const fetchImpl = espia();
    const emisor = crearEmisor({ config: { ...CONFIG, urlPublica: "" }, fetchImpl });
    const r = await emisor.enviarImagen({ para: "573001112233", archivo: PRODUCTO.imagenes[0].archivo, permiso: PERMISOS.CONVERSACION });
    assert.equal(r.enviado, false);
    assert.match(r.detalle, /URL publica/);
    assert.equal(fetchImpl.llamadas.length, 0);
  });
});

// ==========================================================================
// 2 · LOS MISMOS CANDADOS QUE EL TEXTO
// ==========================================================================

describe("2 · interruptores y pausa valen igual para las fotos", () => {
  test("RESPUESTA_AUTOMATICA apagada: el bot no manda fotos", async () => {
    const fetchImpl = espia();
    const emisor = crearEmisor({ config: { ...CONFIG, respuestaAutomatica: false }, fetchImpl });
    const r = await emisor.enviarImagen({
      para: "573001112233", archivo: PRODUCTO.imagenes[0].archivo, permiso: PERMISOS.CONVERSACION,
    });
    assert.equal(r.enviado, false);
    assert.equal(r.motivo, MOTIVOS_BLOQUEO.INTERRUPTOR);
    assert.equal(fetchImpl.llamadas.length, 0);
  });

  test("PANEL_ENVIO_MANUAL apagado: el panel no manda fotos", async () => {
    const fetchImpl = espia();
    const emisor = crearEmisor({ config: { ...CONFIG, panelEnvioManual: false }, fetchImpl });
    const r = await emisor.enviarImagen({
      para: "573001112233", archivo: PRODUCTO.imagenes[0].archivo, permiso: PERMISOS.ATENCION_MANUAL,
    });
    assert.equal(r.enviado, false);
    assert.equal(r.motivo, MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO);
    assert.equal(fetchImpl.llamadas.length, 0);
  });

  test("ESCENARIO: el operador toma el control y el bot YA NO manda fotos", async () => {
    // El mismo candado que con el texto, y en el mismo sitio: el punto
    // unico de salida, despues de que la IA haya respondido.
    const { repos, conv, id } = await conversacionNueva();
    try {
      const fetchImpl = espia();
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });

      await atencion.tomarControl(repos, id, { por: "panel" });

      const r = await emisor.enviarImagen({
        para: id, archivo: PRODUCTO.imagenes[0].archivo,
        permiso: PERMISOS.CONVERSACION, conversacionId: id,
      });
      assert.equal(r.enviado, false);
      assert.equal(r.motivo, MOTIVOS_BLOQUEO.CONVERSACION_PAUSADA);
      assert.equal(fetchImpl.llamadas.length, 0, "no se llamo a Meta");
    } finally {
      await repos.cerrar();
    }
  });

  test("pero el OPERADOR si puede mandarlas con el chat pausado", async () => {
    const { repos, id } = await conversacionNueva();
    try {
      const fetchImpl = espia();
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });
      await atencion.tomarControl(repos, id, { por: "panel" });

      const r = await emisor.enviarImagen({
        para: id, archivo: PRODUCTO.imagenes[0].archivo,
        permiso: PERMISOS.ATENCION_MANUAL, conversacionId: id,
      });
      assert.equal(r.enviado, true);
    } finally {
      await repos.cerrar();
    }
  });
});

// ==========================================================================
// 3 · LAS CINCO, EN ORDEN
// ==========================================================================

describe("3 · el lote de fotos", () => {
  test("ESCENARIO: manda las cinco EN ORDEN", async () => {
    // El orden cuenta algo, y LO DECIDE EL CATALOGO, no esta prueba.
    //
    // ⚠️ CAMBIO EL 2026-10-09: ahora es frente, puesto, EMPAQUE, detalle,
    //    correa. El envio automatico se limito a TRES fotos (lo pidio Marco:
    //    cinco llenan la pantalla del movil y empujan el texto con el precio
    //    fuera de la vista), asi que las tres primeras de la lista son las
    //    que ve el cliente — y las tres que el eligio son frente, puesto y
    //    con su caja.
    //
    // Aqui se llama a `enviarFotosDeProducto` SIN `max`, asi que salen las
    // cinco: lo que se comprueba es que salgan EN ORDEN y de una en una. Con
    // Promise.all seria mas rapido y llegarian revueltas.
    const { repos, conv, id } = await conversacionNueva();
    try {
      const fetchImpl = espia();
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });

      const informe = await fotos.enviarFotosDeProducto({
        emisor, repos, producto: PRODUCTO, conversacion: conv,
        para: id, permiso: PERMISOS.CONVERSACION, pie: "Mira el producto",
      });

      assert.equal(informe.enviadas, 5);
      assert.equal(informe.cuantas, 5);
      assert.deepEqual(informe.problemas, []);
      assert.equal(fetchImpl.llamadas.length, 5);

      const enviadas = fetchImpl.llamadas.map((c) => c.image.link.split("/").pop());
      assert.deepEqual(enviadas, [
        "01-frente.jpg",
      "02-puesto.jpg",
      "05-empaque.jpg",
      "03-detalle.jpg",
      "04-correa.jpg",
      ]);
    } finally {
      await repos.cerrar();
    }
  });

  test("solo la PRIMERA lleva pie", async () => {
    // Repetirlo cinco veces llena la pantalla del telefono de texto igual.
    const { repos, conv, id } = await conversacionNueva();
    try {
      const fetchImpl = espia();
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });
      await fotos.enviarFotosDeProducto({
        emisor, repos, producto: PRODUCTO, conversacion: conv,
        para: id, permiso: PERMISOS.CONVERSACION, pie: "Mira el producto",
      });
      assert.equal(fetchImpl.llamadas[0].image.caption, "Mira el producto");
      for (const c of fetchImpl.llamadas.slice(1)) {
        assert.equal(c.image.caption, undefined, "solo la primera lleva pie");
      }
    } finally {
      await repos.cerrar();
    }
  });

  test("ESCENARIO: no se repiten si ya se mandaron", async () => {
    // Diez fotos seguidas de lo mismo es por lo que alguien bloquea un
    // numero. Y un turno reprocesado tras un crash es algo que esta
    // disenado para ocurrir.
    const { repos, conv, id } = await conversacionNueva();
    try {
      const fetchImpl = espia();
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });
      const comun = { emisor, repos, producto: PRODUCTO, para: id, permiso: PERMISOS.CONVERSACION };

      const primera = await fotos.enviarFotosDeProducto({ ...comun, conversacion: conv });
      assert.equal(primera.enviadas, 5);

      // Se relee del disco: la marca tiene que haber sobrevivido.
      const guardada = await repos.conversaciones.obtener(id);
      const segunda = await fotos.enviarFotosDeProducto({ ...comun, conversacion: guardada });

      assert.equal(segunda.repetido, true);
      assert.equal(segunda.enviadas, 0);
      assert.equal(fetchImpl.llamadas.length, 5, "no puede haber mandado mas");
      assert.match(segunda.problemas.join(" "), /ya se le mandaron/);
    } finally {
      await repos.cerrar();
    }
  });

  test("la marca sobrevive a un reinicio del proceso", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-fotos-r-"));
    const uno = await crearReposDeArchivos({ dir });
    const id = "573058742138";
    try {
      await uno.contactos.guardar({ id });
      const conv = { contactoId: id, estado: "producto", productoId: PRODUCTO.id, ficha: {} };
      await uno.conversaciones.guardar(conv);
      const fetchImpl = espia();
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos: uno, atencion });
      await fotos.enviarFotosDeProducto({
        emisor, repos: uno, producto: PRODUCTO, conversacion: conv, para: id, permiso: PERMISOS.CONVERSACION,
      });
    } finally {
      await uno.cerrar();
    }

    // Proceso nuevo, mismo disco.
    const dos = await crearReposDeArchivos({ dir });
    try {
      const conv = await dos.conversaciones.obtener(id);
      assert.equal(fotos.yaSeMandaron(conv, PRODUCTO.id).si, true, "la marca no sobrevivio");
    } finally {
      await dos.cerrar();
    }
  });

  test("con `forzar` si se reenvian (es lo que hace el panel)", async () => {
    const { repos, conv, id } = await conversacionNueva();
    try {
      const fetchImpl = espia();
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });
      const comun = { emisor, repos, producto: PRODUCTO, para: id, permiso: PERMISOS.ATENCION_MANUAL };
      await fotos.enviarFotosDeProducto({ ...comun, conversacion: conv });
      const otra = await fotos.enviarFotosDeProducto({
        ...comun, conversacion: await repos.conversaciones.obtener(id), forzar: true,
      });
      assert.equal(otra.enviadas, 5);
      assert.equal(fetchImpl.llamadas.length, 10);
    } finally {
      await repos.cerrar();
    }
  });

  test("si la PRIMERA se bloquea, no intenta las otras cuatro", async () => {
    // Un bloqueo no es de esa foto: es el interruptor o la pausa. Seguir
    // solo llena el historial de cuatro "no enviado" identicos.
    const { repos, conv, id } = await conversacionNueva();
    try {
      const fetchImpl = espia();
      const emisor = crearEmisor({
        config: { ...CONFIG, respuestaAutomatica: false }, fetchImpl, repos, atencion,
      });
      const informe = await fotos.enviarFotosDeProducto({
        emisor, repos, producto: PRODUCTO, conversacion: conv, para: id, permiso: PERMISOS.CONVERSACION,
      });
      assert.equal(informe.enviadas, 0);
      assert.equal(informe.bloqueadas, 1, "solo tenia que intentar una");
      assert.equal(fetchImpl.llamadas.length, 0);
      assert.match(informe.problemas.join(" "), /no se mando ninguna/);
    } finally {
      await repos.cerrar();
    }
  });

  test("tras un bloqueo NO se marca como enviado: se puede reintentar", async () => {
    // Si se marcara, al encender el interruptor el cliente se quedaria sin
    // fotos para siempre.
    const { repos, conv, id } = await conversacionNueva();
    try {
      const apagado = crearEmisor({ config: { ...CONFIG, respuestaAutomatica: false }, fetchImpl: espia(), repos, atencion });
      await fotos.enviarFotosDeProducto({
        emisor: apagado, repos, producto: PRODUCTO, conversacion: conv, para: id, permiso: PERMISOS.CONVERSACION,
      });
      assert.equal(fotos.yaSeMandaron(await repos.conversaciones.obtener(id), PRODUCTO.id).si, false);

      // Se enciende y ahora si salen.
      const fetchImpl = espia();
      const encendido = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });
      const r = await fotos.enviarFotosDeProducto({
        emisor: encendido, repos, producto: PRODUCTO,
        conversacion: await repos.conversaciones.obtener(id), para: id, permiso: PERMISOS.CONVERSACION,
      });
      assert.equal(r.enviadas, 5);
    } finally {
      await repos.cerrar();
    }
  });

  test("un envio PARCIAL se reporta: el cliente vio una galeria incompleta", async () => {
    const { repos, conv, id } = await conversacionNueva();
    try {
      const fetchImpl = espia({ fallaEn: 3 });
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });
      const informe = await fotos.enviarFotosDeProducto({
        emisor, repos, producto: PRODUCTO, conversacion: conv, para: id, permiso: PERMISOS.CONVERSACION,
      });
      assert.equal(informe.enviadas, 4);
      assert.equal(informe.fallidas, 1);
      assert.match(informe.problemas.join(" "), /4 de 5/);
      assert.match(informe.problemas.join(" "), /incompleta/);
    } finally {
      await repos.cerrar();
    }
  });

  test("un producto sin fotos lo dice, no revienta", async () => {
    const { repos, conv, id } = await conversacionNueva();
    try {
      const informe = await fotos.enviarFotosDeProducto({
        emisor: crearEmisor({ config: CONFIG, fetchImpl: espia() }),
        repos, producto: { id: "sin-fotos", imagenes: [] },
        conversacion: conv, para: id, permiso: PERMISOS.CONVERSACION,
      });
      assert.equal(informe.enviadas, 0);
      assert.match(informe.problemas.join(" "), /no tiene fotos/);
    } finally {
      await repos.cerrar();
    }
  });
});

// ==========================================================================
// 4 · EL HISTORIAL DICE LA VERDAD
// ==========================================================================

describe("4 · lo que queda en la conversacion", () => {
  test("cada foto queda con su resultado REAL", async () => {
    const { repos, conv, id } = await conversacionNueva();
    try {
      const fetchImpl = espia({ fallaEn: 2 });
      const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });
      await fotos.enviarFotosDeProducto({
        emisor, repos, producto: PRODUCTO, conversacion: conv, para: id, permiso: PERMISOS.CONVERSACION,
      });

      const guardada = await repos.conversaciones.obtener(id);
      const msgs = atencion.mensajes(guardada).filter((m) => m.texto.startsWith("[foto]"));
      assert.equal(msgs.length, 5, "las cinco tienen que quedar anotadas");
      assert.equal(msgs[0].estado, "enviado");
      assert.notEqual(msgs[1].estado, "enviado", "la que fallo no puede figurar como enviada");
      assert.equal(msgs[0].de, atencion.QUIEN.BOT);
      assert.ok(msgs[0].wamid, "la enviada tiene wamid");
      assert.equal(msgs[1].wamid, null, "la fallida no");
    } finally {
      await repos.cerrar();
    }
  });

  test("si las manda el operador, figuran como del operador", async () => {
    const { repos, conv, id } = await conversacionNueva();
    try {
      const emisor = crearEmisor({ config: CONFIG, fetchImpl: espia(), repos, atencion });
      await fotos.enviarFotosDeProducto({
        emisor, repos, producto: PRODUCTO, conversacion: conv, para: id, permiso: PERMISOS.ATENCION_MANUAL,
      });
      const msgs = atencion.mensajes(await repos.conversaciones.obtener(id)).filter((m) => m.texto.startsWith("[foto]"));
      assert.equal(msgs[0].de, atencion.QUIEN.OPERADOR);
      assert.equal(msgs[0].por, "panel");
    } finally {
      await repos.cerrar();
    }
  });

  test("se usa la descripcion de la foto, no la ruta del archivo", async () => {
    const { repos, conv, id } = await conversacionNueva();
    try {
      const emisor = crearEmisor({ config: CONFIG, fetchImpl: espia(), repos, atencion });
      await fotos.enviarFotosDeProducto({
        emisor, repos, producto: PRODUCTO, conversacion: conv, para: id, permiso: PERMISOS.CONVERSACION,
      });
      const msgs = atencion.mensajes(await repos.conversaciones.obtener(id)).filter((m) => m.texto.startsWith("[foto]"));
      assert.match(msgs[0].texto, /de frente/i, `salio: ${msgs[0].texto}`);
    } finally {
      await repos.cerrar();
    }
  });
});

// ==========================================================================
// 5 · DESDE EL PANEL, POR HTTP
// ==========================================================================

describe("5 · la ruta del panel", () => {
  test("sin sesion da 401 en JSON", async () => {
    const { crearApp } = require("../src/app");
    const s = await ayuda.levantar(crearApp());
    try {
      const r = await fetch(`${s.url}/panel/fotos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "573058742138" }),
      });
      assert.equal(r.status, 401);
      assert.match(r.headers.get("content-type") || "", /application\/json/);
      assert.equal(JSON.parse(await r.text()).ok, false);
    } finally {
      await s.cerrar();
    }
  });

  test("el chat ofrece el boton solo si el producto tiene fotos", async () => {
    const vistas = require("../src/panel/vistas");
    const base = {
      conversacion: { contactoId: "573058742138", estado: "producto", ficha: {} },
      mensajes: [], atencion: atencion.leer({}), pedidos: [], clase: "pendiente",
    };

    const con = vistas.chat({ ficha: { ...base, producto: PRODUCTO } });
    assert.match(con, /Enviar 5 fotos/);
    assert.match(con, /enviarFotos\(/);

    const sin = vistas.chat({ ficha: { ...base, producto: null } });
    assert.match(sin, /sin producto identificado/);
    assert.ok(!/Enviar \d+ fotos/.test(sin));
  });

  test("si ya se enviaron, el boton lo dice", async () => {
    const vistas = require("../src/panel/vistas");
    const html = vistas.chat({
      ficha: {
        conversacion: { contactoId: "x", estado: "producto", ficha: {} },
        mensajes: [], atencion: atencion.leer({}), pedidos: [], clase: "pendiente",
        producto: PRODUCTO, fotosYaEnviadas: true,
      },
    });
    assert.match(html, /ya se enviaron/i);
  });
});

module.exports = {};

// --------------------------------------------------------------------------
// A UN BSUID **SI** SE LE ESCRIBE — PERO EN SU CAMPO
//
// ESTA PRUEBA DECIA LO CONTRARIO, y era una conclusion sin comprobar.
//
// Venia de una auditoria real: 8 fallos de envio, todos
// `CO.1667873168388823` con `error 131026 · Message undeliverable`. De ahi
// se concluyo "a estos clientes no se les puede escribir", y el propio
// comentario dejaba el pendiente anotado: "hay que comprobar en la
// documentacion de Meta si la API admite responder a un usuario sin numero".
//
// Marco insistio en que si se podia. Tenia razon. Comprobado en la
// documentacion de Meta (Business-scoped user IDs, actualizada el
// 15-sep-2026):
//
//   · con telefono -> se pone `to` y se OMITE `recipient`
//   · con BSUID    -> se pone `recipient` y se OMITE `to`
//
// Los 8 fallos no fueron porque no se pueda: fue porque se mandaba el BSUID
// EN `to`, que es exactamente lo que Meta rechaza. El bloqueo que se puso
// entonces evitaba el error... y tambien evitaba la venta.
//
// ⚠️ La documentacion de Azure dice que `to` acepta las dos cosas y que el
// servicio detecta el formato. Eso vale para EL WRAPPER DE AZURE, no para la
// API de Meta, que es la que usamos. Seguir esa frase habria dejado el mismo
// fallo con otra cara.
// --------------------------------------------------------------------------
test("a un BSUID se le escribe con `recipient`, y sin `to`", async () => {
  const llamadas = [];
  const emisor = crearEmisor({
    config: { ...require("../src/config").config, respuestaAutomatica: true, whatsappToken: "t", idNumero: "000" },
    repos: null,
    fetchImpl: async (url, opc) => {
      llamadas.push(opc);
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "w1" }] }) };
    },
  });

  const r = await emisor.enviarTexto({
    para: "CO.1667873168388823",
    texto: "Hola, con gusto te cuento…",
    permiso: PERMISOS.CONVERSACION,
  });

  assert.equal(r.enviado, true, `no le escribió a un cliente al que SÍ se puede escribir: ${r.motivo || ""}`);
  assert.equal(llamadas.length, 1, "no salió la llamada a la API");

  const cuerpo = JSON.parse(llamadas[0].body);
  assert.equal(cuerpo.recipient, "CO.1667873168388823", "no mandó el BSUID en `recipient`");
  assert.equal("to" in cuerpo, false, "mandó también `to`: Meta exige uno de los dos, no los dos");
  // El BSUID va COMPLETO: Meta avisa de que recortar o modificar cualquier
  // parte -incluido el codigo de pais y el punto- hace fallar la peticion.
  assert.match(cuerpo.recipient, /^CO\./);
});

test("y un destinatario que no es ni teléfono ni BSUID sigue bloqueado sin gastar red", async () => {
  // La guarda no desaparece: lo que cambia es QUE se considera valido.
  // Reintentar contra un destinatario imposible llena el diario y tapa el
  // motivo real.
  const llamadas = [];
  const emisor = crearEmisor({
    config: { ...require("../src/config").config, respuestaAutomatica: true, whatsappToken: "t", idNumero: "000" },
    repos: null,
    fetchImpl: async (url, opc) => {
      llamadas.push(opc);
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "w1" }] }) };
    },
  });

  for (const para of ["basura", "CO.", "12345"]) {
    const r = await emisor.enviarTexto({ para, texto: "hola", permiso: PERMISOS.CONVERSACION });
    assert.equal(r.enviado, false, `intentó enviar a "${para}"`);
    assert.equal(r.bloqueado, true);
  }
  assert.equal(llamadas.length, 0, "gastó llamadas a la API contra destinatarios inválidos");
});

test("pero un teléfono normal sigue saliendo", async () => {
  const llamadas = [];
  const emisor = crearEmisor({
    config: { ...require("../src/config").config, respuestaAutomatica: true, whatsappToken: "t", idNumero: "000" },
    repos: null,
    fetchImpl: async (url, opc) => {
      llamadas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "w1" }] }) };
    },
  });

  const r = await emisor.enviarTexto({
    para: "573058742138",
    texto: "Hola",
    permiso: PERMISOS.CONVERSACION,
  });

  assert.equal(r.enviado, true, `no salió un envío normal: ${JSON.stringify(r)}`);
  assert.equal(llamadas[0].to, "573058742138");
});
