"use strict";

// ==========================================================================
// PANEL OPERATIVO
//
// Los recorridos principales, y sobre todo el que mas me preocupaba:
// tomar el control MIENTRAS el bot espera una respuesta de la IA.
//
// Ese es el defecto que tiene BIKERPRO en server.js:
//
//   2780   if (store.isPaused(from)) continue;    <- comprueba la pausa aqui
//   2786   await ...                              <- la IA piensa, segundos
//   2791   await sendText(from, reply);           <- envia sin volver a mirar
//
// Con Gemini en medio esa ventana son segundos de verdad. Aqui la
// comprobacion esta en el punto unico de salida y se hace cuando la IA ya
// respondio, asi que la carrera no existe.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
const dir = ayuda.entornoDePrueba({ PANEL_TOKEN: "token_del_panel_de_prueba" });

const { crearApp } = require("../src/app");
const { crearEmisor, PERMISOS, MOTIVOS_BLOQUEO } = require("../src/whatsapp/enviar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const atencion = require("../src/almacen/atencion");
const auth = require("../src/panel/auth");
const datos = require("../src/panel/datos");
const vistas = require("../src/panel/vistas");
const fechaBogota = require("../src/panel/fecha");
const { cotizar } = require("../src/dominio/cotizador");
const dominioPedido = require("../src/dominio/pedido");

const CONFIG = {
  respuestaAutomatica: true,
  panelEnvioManual: true,
  whatsappToken: "token_de_prueba",
  idNumero: "111111111111111",
  versionGraph: "v21.0",
  panelToken: "token_del_panel_de_prueba",
};

/** fetch espia: cuenta lo que SALDRIA a la red, sin salir. */
function fetchEspia() {
  const llamadas = [];
  const f = async (url, opciones) => {
    llamadas.push({ url, cuerpo: JSON.parse(opciones.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.ENVIADO" }] }),
      text: async () => "",
    };
  };
  f.llamadas = llamadas;
  return f;
}

const PRODUCTO = {
  id: "producto-x",
  nombre: "Producto X",
  activo: true,
  motorDePrecio: "tabla",
  // La tabla cubre 1 y 2 unidades: con solo el 1, cotizar({cantidad:2})
  // falla con "no hay precio para 2 unidad(es)" y el pedido sale vacio.
  precios: { 1: 89000, 2: 178000 },
  logistica: { politicaEnvio: { tipo: "incluido" } },
};

async function reposLimpios() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "novika-panel-"));
  return { dir: d, repos: await crearReposDeArchivos({ dir: d }) };
}

async function conversacionDe(repos, id, extra = {}) {
  await repos.contactos.guardar({ id, telefono: id });
  const conv = {
    contactoId: id,
    estado: "cotizado",
    productoId: PRODUCTO.id,
    ficha: { nombre: "Ana Pérez", telefono: id, ciudad: "Medellín" },
    ...extra,
  };
  atencion.anotarMensaje(conv, { de: atencion.QUIEN.CLIENTE, texto: "quiero uno", wamid: "wamid.1" });
  await repos.conversaciones.guardar(conv);
  return repos.conversaciones.obtener(id);
}

// ==========================================================================
// 1 · LA CARRERA CON LA IA
// ==========================================================================

describe("1 · tomar el control mientras la IA piensa", () => {
  test("ESCENARIO: el operador toma el control y el bot YA NO envia", async () => {
    const { repos } = await reposLimpios();
    const id = "573001112233";
    await conversacionDe(repos, id);

    const fetchImpl = fetchEspia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });

    // --- El turno arranca. En este momento NADIE tiene el control, asi que
    //     la compuerta de entrada del bot lo habria dejado pasar. ---
    assert.equal(await atencion.estaPausada(repos, id), false);

    // --- La IA piensa. Aqui es donde BIKERPRO pierde la carrera: su
    //     comprobacion ya paso y el envio todavia no ha ocurrido. ---
    await new Promise((listo) => setTimeout(listo, 15));

    // --- Y en esa ventana, el operador toma el control desde el panel. ---
    await atencion.tomarControl(repos, id, { por: "panel" });

    // --- La IA responde y el bot intenta enviar. ---
    const envio = await emisor.enviarTexto({
      para: id,
      texto: "Hola, te cuento los precios...",
      permiso: PERMISOS.CONVERSACION,
      conversacionId: id,
    });

    // LO QUE IMPORTA: no sale nada.
    assert.equal(envio.enviado, false, "el bot NO puede enviar tras perder el control");
    assert.equal(envio.bloqueado, true);
    assert.equal(envio.motivo, MOTIVOS_BLOQUEO.CONVERSACION_PAUSADA);
    assert.equal(fetchImpl.llamadas.length, 0, "no se llamo a la API de Meta");
  });

  test("y sin que nadie tome el control, el bot SI envia", async () => {
    // El contraste importa: si el candado bloqueara siempre, la prueba
    // anterior pasaria por el motivo equivocado.
    const { repos } = await reposLimpios();
    const id = "573001112244";
    await conversacionDe(repos, id);

    const fetchImpl = fetchEspia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });

    const envio = await emisor.enviarTexto({
      para: id,
      texto: "Hola",
      permiso: PERMISOS.CONVERSACION,
      conversacionId: id,
    });

    assert.equal(envio.enviado, true);
    assert.equal(fetchImpl.llamadas.length, 1);
  });

  test("devolver el chat al bot vuelve a permitir el envio", async () => {
    const { repos } = await reposLimpios();
    const id = "573001112255";
    await conversacionDe(repos, id);
    const fetchImpl = fetchEspia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });

    await atencion.tomarControl(repos, id, { por: "panel" });
    const bloqueado = await emisor.enviarTexto({
      para: id, texto: "x", permiso: PERMISOS.CONVERSACION, conversacionId: id,
    });
    assert.equal(bloqueado.bloqueado, true);

    await atencion.devolverAlBot(repos, id);
    const pasa = await emisor.enviarTexto({
      para: id, texto: "x", permiso: PERMISOS.CONVERSACION, conversacionId: id,
    });
    assert.equal(pasa.enviado, true);
  });

  test("la respuesta MANUAL si sale con el chat pausado", async () => {
    // Al contrario: tomar el control pausa el bot precisamente para que
    // escriba la persona. Si la pausa frenara tambien al operador, tomar el
    // control seria dejar al cliente sin nadie.
    const { repos } = await reposLimpios();
    const id = "573001112266";
    await conversacionDe(repos, id);
    const fetchImpl = fetchEspia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos, atencion });

    await atencion.tomarControl(repos, id, { por: "panel" });
    const envio = await emisor.enviarTexto({
      para: id, texto: "Hola, te escribe Marco", permiso: PERMISOS.ATENCION_MANUAL, conversacionId: id,
    });

    assert.equal(envio.enviado, true, "una persona si puede escribir en el chat que tomo");
    assert.equal(fetchImpl.llamadas.length, 1);
  });

  test("la pausa persiste a un reinicio del proceso", async () => {
    // En Render un disco persistente desactiva los despliegues sin
    // interrupcion: cada despliegue reinicia. Si la pausa viviera en
    // memoria, el bot volveria a hablar sin que nadie toque un boton.
    const { dir: d, repos } = await reposLimpios();
    const id = "573001112277";
    await conversacionDe(repos, id);
    await atencion.tomarControl(repos, id, { por: "panel" });
    await repos.cerrar();

    // Otro conjunto de repositorios sobre el mismo disco = proceso nuevo.
    const otros = await crearReposDeArchivos({ dir: d });
    try {
      assert.equal(await atencion.estaPausada(otros, id), true, "la pausa tiene que sobrevivir al reinicio");
    } finally {
      await otros.cerrar();
    }
  });

  test("si no se puede leer la conversacion, NO se envia", async () => {
    // Ante la duda, callarse. Escribirle a un cliente que ya esta hablando
    // con una persona no es recuperable; un silencio de mas si.
    const reposRotos = {
      conversaciones: {
        async obtener() {
          throw new Error("disco caido");
        },
      },
    };
    const fetchImpl = fetchEspia();
    const emisor = crearEmisor({ config: CONFIG, fetchImpl, repos: reposRotos, atencion });

    const envio = await emisor.enviarTexto({
      para: "573001112288", texto: "x", permiso: PERMISOS.CONVERSACION, conversacionId: "573001112288",
    });
    assert.equal(envio.bloqueado, true);
    assert.equal(fetchImpl.llamadas.length, 0);
  });
});

// ==========================================================================
// 2 · INTERRUPTOR PROPIO DEL PANEL
// ==========================================================================

describe("2 · el envio manual tiene su propio interruptor", () => {
  test("con PANEL_ENVIO_MANUAL apagado no sale nada, y lo dice", async () => {
    const fetchImpl = fetchEspia();
    const emisor = crearEmisor({ config: { ...CONFIG, panelEnvioManual: false }, fetchImpl });
    const envio = await emisor.enviarTexto({
      para: "573001112233", texto: "hola", permiso: PERMISOS.ATENCION_MANUAL,
    });
    assert.equal(envio.enviado, false);
    assert.equal(envio.motivo, MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO);
    assert.equal(fetchImpl.llamadas.length, 0);
  });

  test("el envio manual NO depende de RESPUESTA_AUTOMATICA", async () => {
    // Ese interruptor existe para que el BOT no hable. Una persona que
    // pulsa enviar no es el bot, y si dependiera de el no se podria
    // atender a nadie a mano antes de encender el bot.
    const fetchImpl = fetchEspia();
    const emisor = crearEmisor({
      config: { ...CONFIG, respuestaAutomatica: false, panelEnvioManual: true },
      fetchImpl,
    });
    const envio = await emisor.enviarTexto({
      para: "573001112233", texto: "hola", permiso: PERMISOS.ATENCION_MANUAL,
    });
    assert.equal(envio.enviado, true);
  });

  test("y el BOT sigue callado con RESPUESTA_AUTOMATICA apagada", async () => {
    const fetchImpl = fetchEspia();
    const emisor = crearEmisor({
      config: { ...CONFIG, respuestaAutomatica: false, panelEnvioManual: true },
      fetchImpl,
    });
    const envio = await emisor.enviarTexto({
      para: "573001112233", texto: "hola", permiso: PERMISOS.CONVERSACION,
    });
    assert.equal(envio.enviado, false);
    assert.equal(envio.motivo, MOTIVOS_BLOQUEO.INTERRUPTOR);
  });
});

// ==========================================================================
// 3 · FECHAS DE COLOMBIA
// ==========================================================================

describe("3 · hora de Colombia", () => {
  test("el borde del dia: 19:00 en Bogota ya es manana en UTC", () => {
    // Es el error que BIKERPRO cometio. Un pedido de las 19:30 del lunes
    // tiene que contar en el lunes.
    assert.equal(fechaBogota.diaBogota("2026-10-06T23:30:00Z"), "2026-10-06", "18:30 de Bogota");
    assert.equal(fechaBogota.diaBogota("2026-10-07T00:30:00Z"), "2026-10-06", "19:30 de Bogota, sigue siendo el 6");
    assert.equal(fechaBogota.diaBogota("2026-10-07T05:00:00Z"), "2026-10-07", "medianoche de Bogota");
  });

  test("un dia entero hora por hora cae siempre en uno de los dos dias posibles", () => {
    // La version larga de la prueba anterior: cualquier hora del dia tiene
    // que caer en el mismo dia UTC o en el anterior, nunca en otro.
    for (let h = 0; h < 24; h++) {
      const iso = `2026-03-15T${String(h).padStart(2, "0")}:00:00Z`;
      const dia = fechaBogota.diaBogota(iso);
      assert.ok(
        dia === "2026-03-15" || dia === "2026-03-14",
        `${iso} dio ${dia}`
      );
      // Y antes de las 05:00 UTC siempre es el dia anterior en Bogota.
      assert.equal(dia, h < 5 ? "2026-03-14" : "2026-03-15");
    }
  });

  test("una entrada que no se entiende devuelve null y NO lanza", () => {
    // `Intl.format` LANZA con una fecha invalida, y eso tumbaba el panel
    // entero de BIKERPRO por un pedido sin fecha.
    for (const malo of [undefined, null, "", "no es una fecha", NaN, {}]) {
      assert.doesNotThrow(() => fechaBogota.diaBogota(malo), `lanzo con ${JSON.stringify(malo)}`);
      assert.equal(fechaBogota.diaBogota(malo), null);
    }
    assert.equal(fechaBogota.horaBogota(undefined), "");
  });

  test("diaBogota es pura: el mismo valor da siempre el mismo dia", () => {
    // Si guardara estado, los chats apareceriian en el dia equivocado de
    // forma intermitente, que es imposible de diagnosticar.
    const v = "2026-10-07T00:30:00Z";
    const primera = fechaBogota.diaBogota(v);
    for (let i = 0; i < 50; i++) assert.equal(fechaBogota.diaBogota(v), primera);
  });

  test("diaAnterior no se tropieza con el cambio de mes", () => {
    assert.equal(fechaBogota.diaAnterior("2026-03-01"), "2026-02-28");
    assert.equal(fechaBogota.diaAnterior("2024-03-01"), "2024-02-29", "ano bisiesto");
    assert.equal(fechaBogota.diaAnterior("2026-01-01"), "2025-12-31");
    assert.equal(fechaBogota.diaAnterior("basura"), null);
  });
});

// ==========================================================================
// 4 · CUENTAS DEL TABLERO
// ==========================================================================

describe("4 · ventas, unidades e importes", () => {
  function pedidoDe(ofertaId, cantidad = 1) {
    const cot = cotizar({
      producto: PRODUCTO,
      cantidad,
      destino: { ciudad: "Medellín", departamento: "Antioquia" },
    }).cotizacion;
    return dominioPedido.construir({
      cotizacion: cot,
      datos: {
        nombre: "Ana Pérez", telefono: "3001112233", ciudad: "Medellín",
        departamento: "Antioquia", direccion: "Calle 45 # 23-10",
      },
      contactoId: "573001112233",
      conversacionId: "573001112233",
      ofertaId,
      wamidConfirmacion: `wamid.${ofertaId}`,
    }).pedido;
  }

  test("suma pedidos, unidades e importes, y separa los cancelados", async () => {
    const { repos } = await reposLimpios();
    await repos.contactos.guardar({ id: "573001112233" });
    await repos.pedidos.crearSiNoExiste(pedidoDe("of-1", 1));
    await repos.pedidos.crearSiNoExiste(pedidoDe("of-2", 2));

    const cancelado = pedidoDe("of-3", 1);
    await repos.pedidos.crearSiNoExiste(cancelado);
    const r = dominioPedido.cancelar({ pedido: await repos.pedidos.obtener(cancelado.id), motivo: "prueba" });
    await repos.pedidos.reemplazar(r.pedido);

    const todos = await repos.pedidos.listar({ limite: 100 });
    const resumen = datos.resumirPedidos(todos);

    assert.equal(resumen.pedidos, 2, "el cancelado NO cuenta como venta");
    assert.equal(resumen.unidades, 3, "1 + 2 unidades");
    assert.equal(resumen.importe, 89000 + 178000, "1 unidad + el precio de 2 unidades");
    assert.equal(resumen.cancelados, 1, "pero SI se informa");
    assert.ok(resumen.importeCancelado > 0);
  });

  test("desglosa por producto, porque NOVIKA es multiproducto", async () => {
    const { repos } = await reposLimpios();
    await repos.contactos.guardar({ id: "573001112233" });
    await repos.pedidos.crearSiNoExiste(pedidoDe("of-a", 1));
    const resumen = datos.resumirPedidos(await repos.pedidos.listar({ limite: 100 }));
    assert.equal(resumen.porProducto.length, 1);
    assert.equal(resumen.porProducto[0].productoId, PRODUCTO.id);
  });

  test("listar filtra por dia de Bogota, no por el ISO en UTC", async () => {
    const { repos } = await reposLimpios();
    await repos.contactos.guardar({ id: "573001112233" });
    const p = pedidoDe("of-borde", 1);
    // 19:30 de Bogota del 6 = 00:30 UTC del 7.
    p.creadoEn = "2026-10-07T00:30:00Z";
    await repos.pedidos.crearSiNoExiste(p);

    const enElSeis = await repos.pedidos.listar({ desde: "2026-10-06", hasta: "2026-10-06" });
    const enElSiete = await repos.pedidos.listar({ desde: "2026-10-07", hasta: "2026-10-07" });

    assert.equal(enElSeis.length, 1, "tiene que contar en el 6, que es cuando se vendio en Colombia");
    assert.equal(enElSiete.length, 0);
  });
});

// ==========================================================================
// 5 · CLASIFICACION DE CONVERSACIONES
// ==========================================================================

describe("5 · pendientes, urgentes, atendidas y posventa", () => {
  test("un mensaje del cliente sin contestar es PENDIENTE", async () => {
    const { repos } = await reposLimpios();
    const conv = await conversacionDe(repos, "573001110001");
    assert.equal(datos.clasificar(conv), datos.CLASES.PENDIENTE);
  });

  test("y si lleva mas de 15 minutos es URGENTE", async () => {
    const { repos } = await reposLimpios();
    const conv = await conversacionDe(repos, "573001110002");
    const ahora = Date.now() + (datos.MINUTOS_URGENTE + 1) * 60000;
    assert.equal(datos.clasificar(conv, { ahora }), datos.CLASES.URGENTE);
  });

  test("marcar atendido lo saca de la lista", async () => {
    const { repos } = await reposLimpios();
    const id = "573001110003";
    await conversacionDe(repos, id);
    const conv = await atencion.marcarAtendido(repos, id, { por: "panel" });
    assert.equal(datos.clasificar(conv), datos.CLASES.ATENDIDA);
  });

  test("pero REAPARECE si el cliente vuelve a escribir", async () => {
    // Es la correccion de BIKERPRO: "atendido" no es un ocultar. Un chat
    // silenciado para siempre es una venta perdida en silencio. Aqui se
    // calcula comparando con el ultimo mensaje del cliente, asi que no hay
    // nada que acordarse de borrar.
    const { repos } = await reposLimpios();
    const id = "573001110004";
    await conversacionDe(repos, id);
    await atencion.marcarAtendido(repos, id, { por: "panel" });

    const conv = await repos.conversaciones.obtener(id);
    assert.equal(datos.clasificar(conv), datos.CLASES.ATENDIDA);

    // El cliente escribe otra vez, un instante despues.
    atencion.anotarMensaje(conv, {
      de: atencion.QUIEN.CLIENTE,
      texto: "sigo ahi?",
      ts: new Date(Date.now() + 1000).toISOString(),
    });
    await repos.conversaciones.guardar(conv);

    const vuelto = await repos.conversaciones.obtener(id);
    assert.notEqual(datos.clasificar(vuelto), datos.CLASES.ATENDIDA, "tiene que reaparecer");
    assert.equal(datos.clasificar(vuelto), datos.CLASES.PENDIENTE);
  });

  test("un pedido confirmado y la conversacion sigue = POSVENTA", async () => {
    const { repos } = await reposLimpios();
    const id = "573001110005";
    const conv = await conversacionDe(repos, id, { estado: "confirmado" });
    // El bot ya contesto, asi que no esta esperando.
    atencion.anotarMensaje(conv, { de: atencion.QUIEN.BOT, texto: "listo, tu pedido es NOV-1" });
    assert.equal(datos.clasificar(conv), datos.CLASES.POSVENTA);
  });
});

// ==========================================================================
// 6 · SESION Y ACCESO
// ==========================================================================

describe("6 · acceso al panel", () => {
  test("el token del panel NO es el de verificacion de Meta", () => {
    // BIKERPRO lo prueba con dos valores distintos a proposito, porque el
    // error de confundirlos ya ocurrio. Aqui se fija el mismo requisito.
    assert.notEqual(
      process.env.PANEL_TOKEN,
      process.env.WHATSAPP_VERIFY_TOKEN,
      "el panel no puede autenticarse con la credencial de Meta"
    );
    assert.equal(auth.tokenCorrecto(process.env.WHATSAPP_VERIFY_TOKEN, process.env.PANEL_TOKEN), false);
  });

  test("sin PANEL_TOKEN configurado no se entra", () => {
    // Si no, un servicio sin la variable tendria el panel abierto.
    assert.equal(auth.tokenCorrecto("", ""), false);
    assert.equal(auth.tokenCorrecto("lo-que-sea", ""), false);
    assert.equal(auth.tokenCorrecto("", "el-bueno"), false);
  });

  test("una sesion valida se acepta y una manipulada no", () => {
    const token = "token_del_panel_de_prueba";
    const buena = auth.crearSesion(token);
    assert.equal(auth.sesionValida(buena, token), true);

    // Firmada con otro token.
    assert.equal(auth.sesionValida(auth.crearSesion("otro"), token), false);
    // Caducidad estirada a mano: la firma cubre la fecha.
    const [, firma] = buena.split(".");
    assert.equal(auth.sesionValida(`${Date.now() + 9e12}.${firma}`, token), false);
    // Basura.
    for (const malo of ["", "a.b.c", "x.y", "9999999999999"]) {
      assert.equal(auth.sesionValida(malo, token), false, `acepto ${malo}`);
    }
  });

  test("una sesion caducada no vale", () => {
    const token = "token_del_panel_de_prueba";
    const vieja = auth.crearSesion(token, Date.now() - auth.VIGENCIA_MS - 1000);
    assert.equal(auth.sesionValida(vieja, token), false);
  });
});

// ==========================================================================
// 7 · RECORRIDOS POR HTTP
// ==========================================================================

describe("7 · recorridos por HTTP", () => {
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

  test("sin sesion: una pagina da la pantalla de entrada", async () => {
    const s = await levantar();
    try {
      const r = await fetch(`${s.url}/panel`);
      assert.equal(r.status, 401);
      assert.match(await r.text(), /Token del panel/);
    } finally {
      await s.cerrar();
    }
  });

  test("sin sesion: una accion da 401 en JSON, no texto suelto", async () => {
    // LA LECCION DEL 403 DE BIKERPRO. Un error que devuelve "Forbidden" en
    // texto hace que la pantalla muestre "Unexpected token 'F'" al hacer
    // r.json(), y manda al dueno a buscar el problema donde no esta. Les
    // paso dos veces.
    const s = await levantar();
    try {
      const r = await fetch(`${s.url}/panel/responder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "x", texto: "y" }),
      });
      assert.equal(r.status, 401);
      assert.match(r.headers.get("content-type") || "", /application\/json/);
      const cuerpo = JSON.parse(await r.text()); // no lanza
      assert.equal(cuerpo.ok, false);
      assert.ok(cuerpo.error);
    } finally {
      await s.cerrar();
    }
  });

  test("token equivocado no entra", async () => {
    const s = await levantar();
    try {
      const r = await fetch(`${s.url}/panel/entrar`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=equivocado",
        redirect: "manual",
      });
      assert.equal(r.status, 401);
      assert.equal(r.headers.get("set-cookie"), null, "no puede dar sesion");
    } finally {
      await s.cerrar();
    }
  });

  test("con sesion: el tablero carga y la cookie es HttpOnly", async () => {
    const s = await levantar();
    try {
      const r = await fetch(`${s.url}/panel/entrar`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=token_del_panel_de_prueba",
        redirect: "manual",
      });
      const puesta = r.headers.get("set-cookie") || "";
      assert.match(puesta, /HttpOnly/, "el JavaScript de la pagina no puede leer la sesion");
      assert.match(puesta, /SameSite=Lax/);

      const cookie = puesta.split(";")[0];
      const t = await fetch(`${s.url}/panel`, { headers: { cookie } });
      assert.equal(t.status, 200);
      const html = await t.text();
      assert.match(html, /unidades/);
      assert.match(html, /hora de Colombia/);
    } finally {
      await s.cerrar();
    }
  });

  test("el CSV se exporta con cabecera y separador para Excel en espanol", async () => {
    const s = await levantar();
    try {
      const cookie = await s.entrar();
      const r = await fetch(`${s.url}/panel/pedidos.csv`, { headers: { cookie } });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") || "", /text\/csv/);
      assert.match(r.headers.get("content-disposition") || "", /attachment/);
      // `r.text()` DESCARTA el BOM por especificacion, asi que comprobarlo
      // ahi daria un falso negativo. Se miran los bytes.
      const bytes = new Uint8Array(await r.arrayBuffer());
      assert.deepEqual(
        [bytes[0], bytes[1], bytes[2]],
        [0xef, 0xbb, 0xbf],
        "sin BOM los acentos salen mal en Excel"
      );
      const texto = new TextDecoder().decode(bytes);
      assert.match(texto.replace(/^\uFEFF/, "").split("\r\n")[0], /codigo;version;estado/);
    } finally {
      await s.cerrar();
    }
  });

  test("guias y novedades traen su flujo completo, y lo que depende de Meta lo dice ANTES", async () => {
    // ----------------------------------------------------------------------
    // ESTA PRUEBA CAMBIO DE SIGNIFICADO, Y EL CAMBIO ES EL PUNTO
    //
    // Antes comprobaba que las dos pantallas DIJERAN que les faltaba algo: el
    // lector del PDF de la transportadora y el aviso por plantilla. Las dos
    // cosas ya estan construidas, asi que ese texto ya no existe y la prueba
    // vigila lo que importa ahora:
    //
    //   · que el flujo de tres pasos este en la pantalla (subir, revisar,
    //     enviar), porque revisar antes de enviar es lo que evita mandarle a
    //     un cliente la etiqueta de otro;
    //
    //   · que la dependencia que SIGUE siendo externa -las plantillas tienen
    //     que crearse en Meta y que Meta las apruebe- se diga ARRIBA, antes
    //     de que alguien suba un archivo. Es una tarea para una persona, y
    //     descubrirla fila por fila al final del flujo es tarde.
    //
    // En el entorno de prueba no hay ninguna plantilla configurada, asi que
    // la pantalla tiene que nombrarlas todas.
    // ----------------------------------------------------------------------
    const s = await levantar();
    try {
      const cookie = await s.entrar();

      const g = await fetch(`${s.url}/panel/guias`, { headers: { cookie } });
      assert.equal(g.status, 200);
      const htmlG = await g.text();
      assert.match(htmlG, /por despachar/i, "la parte de registrar a mano tiene que seguir ahi");
      assert.match(htmlG, /PDF de la transportadora/i, "falta el flujo del lote de guias");
      assert.match(htmlG, /no env[ií]a nada/i, "revisar tiene que decir explicitamente que no envia");
      assert.match(
        htmlG,
        /no salen del servidor/i,
        "tiene que decir que las etiquetas, con los datos del cliente, no se mandan al navegador"
      );

      // ⚠️ EL PANEL NO ES UNA PUERTA TRASERA PARA LOS NOMBRES MALOS.
      //
      // La ruta para corregir el destinatario nacio de la guia bloqueada del
      // 09-oct («Cliente: Sii»). Valida el nombre con el MISMO candado del
      // bot: si no, acabariamos imprimiendo a mano justo lo que el bot
      // rechaza.
      const mal = await fetch(`${s.url}/panel/pedido/destinatario`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ codigo: "NOV-X", nombre: "Sii" }),
      });
      assert.equal(mal.status, 400, "el panel aceptó «Sii» como nombre de una guía");
      assert.match((await mal.json()).error, /no sirve para la guia/i);

      const n = await fetch(`${s.url}/panel/novedades`, { headers: { cookie } });
      assert.equal(n.status, 200);
      const htmlN = await n.text();
      assert.match(htmlN, /con novedad abierta/i);
      assert.match(htmlN, /Avisar a los clientes/i, "falta el flujo de aviso");
      assert.match(
        htmlN,
        /Faltan plantillas aprobadas/i,
        "sin plantillas configuradas, la pantalla tiene que avisarlo antes de que se suba nada"
      );
      // Los tres tipos, por su nombre, para que se sepa cuales crear.
      for (const tipo of ["direccion", "ausente", "oficina"]) {
        assert.match(htmlN, new RegExp(tipo), `no nombra la plantilla que falta para "${tipo}"`);
      }
      assert.match(htmlN, /solo entrega plantillas/i, "tiene que explicar la regla de la ventana de 24 h");
    } finally {
      await s.cerrar();
    }
  });

  test("la auditoria trae embudo y atribucion", async () => {
    const s = await levantar();
    try {
      const cookie = await s.entrar();
      const r = await fetch(`${s.url}/panel/auditoria`, { headers: { cookie } });
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /Embudo/);
      assert.match(html, /Atribución/);
      assert.match(html, /Por día/);
    } finally {
      await s.cerrar();
    }
  });

  test("responder a una conversacion que no existe da 404 en JSON", async () => {
    const s = await levantar();
    try {
      const cookie = await s.entrar();
      const r = await fetch(`${s.url}/panel/responder`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ id: "573009999999", texto: "hola" }),
      });
      assert.equal(r.status, 404);
      const cuerpo = JSON.parse(await r.text());
      assert.equal(cuerpo.ok, false);
    } finally {
      await s.cerrar();
    }
  });

  test("salir invalida la sesion", async () => {
    const s = await levantar();
    try {
      const cookie = await s.entrar();
      const r = await fetch(`${s.url}/panel/salir`, { method: "POST", headers: { cookie } });
      assert.match(r.headers.get("set-cookie") || "", /Max-Age=0/);
      assert.match(await r.text(), /Sesion cerrada/);
    } finally {
      await s.cerrar();
    }
  });
});

// ==========================================================================
// 8 · MOVIL
// ==========================================================================

describe("8 · el panel se usa desde el celular", () => {
  const conDatos = {
    dia: "2026-10-07",
    hoy: "2026-10-07",
    resumen: datos.resumirPedidos([]),
    pedidos: [],
    chats: [],
    porClase: { pendiente: [] },
    cuentas: {},
  };

  test("ningun input baja de 16px: por debajo, iOS hace zoom y la pagina salta", () => {
    // Era "el detalle que mas hacia sentir el panel roto" en BIKERPRO, y
    // pasaba justo al escribirle a un cliente.
    const css = vistas.ESTILO;
    const m = /input, textarea, select \{[^}]*font-size:\s*(\d+)px/.exec(css);
    assert.ok(m, "no se encontro el tamano de los campos");
    assert.ok(Number(m[1]) >= 16, `los campos miden ${m[1]}px`);

    // Y en la pantalla de entrada, que es otro archivo.
    const entrada = auth.pantallaDeEntrada();
    const m2 = /input \{[^}]*font-size:\s*(\d+)px/.exec(entrada);
    assert.ok(m2 && Number(m2[1]) >= 16, "el campo de la pantalla de entrada hace zoom en iOS");
  });

  test("los objetivos tactiles miden 44px, la guia de Apple", () => {
    const m = /button, \.boton \{[^}]*min-height:\s*(\d+)px/.exec(vistas.ESTILO);
    assert.ok(m, "no se encontro el alto de los botones");
    assert.ok(Number(m[1]) >= 44, `los botones miden ${m[1]}px`);
  });

  test("hay viewport, sin el nada de lo anterior sirve", () => {
    const html = vistas.tablero({ datos: conDatos });
    assert.match(html, /<meta name="viewport"[^>]*width=device-width/);
  });

  test("las tablas se apilan en pantalla estrecha", () => {
    assert.match(vistas.ESTILO, /@media \(max-width: 760px\)/);
    assert.match(vistas.ESTILO, /td::before \{ content:attr\(data-label\)/);
  });

  test("y las etiquetas estan en el HTML, no solo en el CSS", async () => {
    // Si solo estuvieran en el CSS, una fila sin data-label saldria sin
    // etiqueta y en el celular no se sabria que es cada dato. BIKERPRO lo
    // sufrio en su tabla de pareo, de siete columnas.
    const { repos } = await reposLimpios();
    await conversacionDe(repos, "573001110009");
    const tabla = await datos.tablero(repos, { dia: fechaBogota.hoyBogota() });
    const html = vistas.tablero({ datos: tabla, clase: datos.CLASES.PENDIENTE });

    const celdas = html.match(/<td[^>]*>/g) || [];
    assert.ok(celdas.length > 0, "la tabla salio vacia");
    for (const celda of celdas) {
      assert.match(celda, /data-label="/, `una celda sin etiqueta: ${celda}`);
    }
  });

  test("el chat tambien lleva etiquetas en todas sus celdas", async () => {
    const { repos } = await reposLimpios();
    const id = "573001110010";
    await conversacionDe(repos, id);
    const ficha = await datos.conversacionCompleta(repos, id);
    const html = vistas.chat({ ficha });
    for (const celda of html.match(/<td[^>]*>/g) || []) {
      assert.match(celda, /data-label="/, `celda sin etiqueta: ${celda}`);
    }
  });
});

// ==========================================================================
// 9 · ESTADO QUE NO SE PUEDE PERDER
// ==========================================================================

describe("9 · borradores, conversacion abierta y scroll", () => {
  test("el guion guarda y restaura el borrador por conversacion", async () => {
    const { repos } = await reposLimpios();
    const id = "573001110011";
    await conversacionDe(repos, id);
    const ficha = await datos.conversacionCompleta(repos, id);
    const html = vistas.chat({ ficha });

    // Uno por conversacion: un borrador compartido mezclaria lo escrito a
    // dos clientes distintos, que es peor que perderlo.
    assert.match(html, /guardarBorrador\(ID, caja\.value\)/);
    assert.match(html, /caja\.value = leerBorrador\(ID\)/);
    assert.match(html, /"borrador\." \+ id/);
  });

  test("el borrador NO se borra si el envio fallo", async () => {
    const { repos } = await reposLimpios();
    const id = "573001110012";
    await conversacionDe(repos, id);
    const ficha = await datos.conversacionCompleta(repos, id);
    const html = vistas.chat({ ficha });
    // borrarBorrador solo dentro de la rama de exito.
    const trozo = html.slice(html.indexOf("async function responder()"));
    const exito = trozo.indexOf("if (r.ok)");
    const fallo = trozo.indexOf("} else {");
    const posBorrar = trozo.indexOf("borrarBorrador(ID)");
    assert.ok(posBorrar > exito && posBorrar < fallo, "el borrador se borra incluso cuando falla");
  });

  test("se conserva la posicion del scroll", async () => {
    const html = vistas.buscar({ q: "", resultados: [] });
    assert.match(html, /guardarScroll/);
    assert.match(html, /restaurarScroll/);
  });

  test("las acciones van por fetch, no por redirect que cerraria el chat", async () => {
    const { repos } = await reposLimpios();
    const id = "573001110013";
    await conversacionDe(repos, id);
    const ficha = await datos.conversacionCompleta(repos, id);
    const html = vistas.chat({ ficha });
    assert.match(html, /await pedir\("\/panel\/responder"/);
    assert.match(html, /await pedir\("\/panel\/control"/);
  });

  test("el guion mira el estado HTTP antes de interpretar el cuerpo", () => {
    const html = vistas.buscar({ q: "", resultados: [] });
    assert.match(html, /if \(!r\.ok\)/, "sin esto, un 403 muestra Unexpected token 'F'");
    assert.match(html, /r\.status === 401/);
  });

  test("el boton de enviar se desactiva para que un doble clic no mande dos", async () => {
    const { repos } = await reposLimpios();
    const id = "573001110014";
    await conversacionDe(repos, id);
    const ficha = await datos.conversacionCompleta(repos, id);
    const html = vistas.chat({ ficha });
    assert.match(html, /boton\.disabled = true/);
  });
});

// ==========================================================================
// 10 · PEDIDOS DESDE EL PANEL
// ==========================================================================

describe("10 · cancelar y registrar sin duplicar", () => {
  test("cancelar NO borra: queda con su motivo, version e historial", async () => {
    const { repos } = await reposLimpios();
    await repos.contactos.guardar({ id: "573001112233" });
    const cot = cotizar({
      producto: PRODUCTO, cantidad: 1,
      destino: { ciudad: "Medellín", departamento: "Antioquia" },
    }).cotizacion;
    const armado = dominioPedido.construir({
      cotizacion: cot,
      datos: {
        nombre: "Ana Pérez", telefono: "3001112233", ciudad: "Medellín",
        departamento: "Antioquia", direccion: "Calle 45 # 23-10",
      },
      contactoId: "573001112233", conversacionId: "573001112233",
      ofertaId: "of-cancelar", wamidConfirmacion: "wamid.cancelar",
    });
    await repos.pedidos.crearSiNoExiste(armado.pedido);

    const guardado = await repos.pedidos.obtener(armado.pedido.id);
    const r = dominioPedido.cancelar({ pedido: guardado, motivo: "el cliente se arrepintio" });
    assert.equal(r.ok, true);
    await repos.pedidos.reemplazar(r.pedido);

    const despues = await repos.pedidos.obtener(armado.pedido.id);
    assert.ok(despues, "un pedido cancelado NO desaparece");
    assert.equal(despues.estado, "cancelado");
    assert.ok((despues.historial || []).length >= 1, "la cancelacion queda en el historial");

    // Y deja de contar como venta en un solo sitio.
    assert.equal(datos.resumirPedidos([despues]).pedidos, 0);
    assert.equal(datos.resumirPedidos([despues]).cancelados, 1);
  });

  test("una venta manual repetida NO duplica el pedido", async () => {
    // La clave de idempotencia se deriva del cliente, el producto y el dia.
    // Pulsar dos veces "registrar" encuentra el que ya existe.
    const { repos } = await reposLimpios();
    const contactoId = "573001112299";
    await repos.contactos.guardar({ id: contactoId });

    const clave = `panel:${contactoId}:${PRODUCTO.id}:${fechaBogota.hoyBogota()}`;
    const hacer = () => {
      const cot = cotizar({
        producto: PRODUCTO, cantidad: 1,
        destino: { ciudad: "Medellín", departamento: "Antioquia" },
      }).cotizacion;
      return dominioPedido.construir({
        cotizacion: cot,
        datos: {
          nombre: "Ana Pérez", telefono: contactoId, ciudad: "Medellín",
          departamento: "Antioquia", direccion: "Calle 45 # 23-10",
        },
        contactoId, conversacionId: contactoId,
        ofertaId: clave, wamidConfirmacion: clave,
        origen: { via: "panel" },
      }).pedido;
    };

    const primera = await repos.pedidos.crearSiNoExiste(hacer());
    const segunda = await repos.pedidos.crearSiNoExiste(hacer());

    assert.equal(primera.creado, true);
    assert.equal(segunda.creado, false, "la segunda no puede crear otro pedido");
    assert.equal(segunda.pedido.id, primera.pedido.id);
    assert.equal((await repos.pedidos.listar({ limite: 100 })).length, 1);
  });

  test("el panel NO acepta un importe escrito a mano", async () => {
    // El precio lo calcula el cotizador, igual que en una venta del bot.
    // Aceptar un importe del formulario seria la via mas facil de meter un
    // cobro equivocado en la contabilidad.
    const rutas = fs.readFileSync(path.join(__dirname, "..", "src", "panel", "rutas.js"), "utf8");
    const trozo = rutas.slice(rutas.indexOf('router.post("/venta-manual"'));
    assert.ok(trozo.includes("cotizar({"), "la venta manual tiene que cotizar");
    assert.ok(!/b\.(total|precio|importe)/.test(trozo), "la venta manual lee un importe del formulario");
  });
});

// ==========================================================================
// 11 · EL RESULTADO QUE SE MUESTRA ES EL REAL
// ==========================================================================

describe("11 · nada se muestra como entregado sin estarlo", () => {
  test("un mensaje bloqueado se guarda con su motivo, no como enviado", async () => {
    const { repos } = await reposLimpios();
    const id = "573001110020";
    const conv = await conversacionDe(repos, id);

    atencion.anotarMensaje(conv, {
      de: atencion.QUIEN.OPERADOR,
      texto: "hola",
      por: "panel",
      estado: MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO,
    });
    await repos.conversaciones.guardar(conv);

    const ficha = await datos.conversacionCompleta(repos, id);
    const html = vistas.chat({ ficha });
    assert.match(html, /no enviado/, "el panel tiene que decir que no salio");
    assert.match(html, /envio_manual_apagado/);
  });

  test("Meta acepta no es Meta entrega, y el aviso lo dice", () => {
    const { EXPLICACION, explicarFalloDeMeta } = require("../src/panel/rutas");
    // La ventana de 24h traducida a algo accionable.
    assert.match(explicarFalloDeMeta({ codigo: 131047 }), /24 horas/);
    assert.match(explicarFalloDeMeta({ codigo: 131047 }), /plantilla/);
    assert.match(explicarFalloDeMeta({ codigo: 131047 }), /NO salio/);
    // Y los bloqueos explican que hay que cambiar, sin codigos internos.
    assert.match(EXPLICACION[MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO], /PANEL_ENVIO_MANUAL/);
    assert.match(EXPLICACION[MOTIVOS_BLOQUEO.CONVERSACION_PAUSADA], /persona/);
  });

  test("un doble clic no manda el mismo texto dos veces", () => {
    const { esRepetido } = require("../src/panel/rutas");
    const ahora = Date.now();
    assert.equal(esRepetido("573001110021", "hola", ahora), false, "el primero pasa");
    assert.equal(esRepetido("573001110021", "hola", ahora + 100), true, "el repetido se frena");
    // Otro texto al mismo cliente si pasa.
    assert.equal(esRepetido("573001110021", "otra cosa", ahora + 150), false);
    // Y pasado el tiempo, el mismo texto se puede volver a mandar.
    assert.equal(esRepetido("573001110021", "hola", ahora + 60000), false);
  });
});

// ==========================================================================
// 12 · EL PANEL NO ABRE UNA SEGUNDA FUENTE DE VERDAD
// ==========================================================================

describe("12 · una sola fuente de pedidos", () => {
  test("el panel usa las piezas del cerebro, no construye las suyas", () => {
    const rutas = fs.readFileSync(path.join(__dirname, "..", "src", "panel", "rutas.js"), "utf8");
    assert.ok(rutas.includes("obtenerCerebro"), "el panel tiene que reutilizar el cerebro");
    assert.ok(!rutas.includes("crearReposDePostgres"), "el panel se construye su propio pool");
    assert.ok(!rutas.includes("crearReposDeArchivos"), "el panel se construye sus propios repos");
  });

  test("y no hay ningun store copiado de BIKERPRO", () => {
    const panel = fs.readdirSync(path.join(__dirname, "..", "src", "panel"));
    for (const archivo of panel) {
      const texto = fs.readFileSync(path.join(__dirname, "..", "src", "panel", archivo), "utf8");
      assert.ok(!/BikerPro|bikerpro/.test(texto.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")),
        `${archivo} referencia BIKERPRO fuera de un comentario`);
    }
  });
});

// ==========================================================================
// LA TABLA DESDE LA QUE SE ESCRIBEN LAS GUIAS
//
// Marco entra a /panel/guias y copia los datos a mano en la web de la
// transportadora. Le faltaban tres columnas -celular, direccion y producto-
// y la del celular era la mas importante: sin ella hay que abrir el chat de
// cada pedido uno por uno, que es el trabajo que esta pantalla quita.
//
// No habia NINGUNA prueba que fijara las columnas de esta tabla. Estas lo
// hacen, porque es una pantalla operativa: si alguien quita una columna, se
// nota el dia que hay diez pedidos que despachar.
// ==========================================================================

describe("13 · la tabla de guias trae lo que pide la transportadora", () => {
  /** Un pedido listo para despachar, con un BSUID como clave de chat. */
  const unPedido = (extra = {}) => ({
    id: "NOV-ABC123",
    estado: "confirmado",
    // ⚠️ UN BSUID, A PROPOSITO. Es la trampa de esta pantalla.
    contactoId: "CO.1098944221",
    producto: { id: "cinturon-termico-colicos", nombre: "Cinturón térmico NOVIKA" },
    cantidad: 2,
    destinatario: {
      nombre: "Nevis Johana Sánchez López",
      telefono: "3105177896",
      ciudad: "Bogota",
      departamento: "Cundinamarca",
      direccion: "KR 101 #29c-07",
      referencia: "Lagos de suba",
    },
    cotizacion: { total: 85000, condiciones: { pagoEtiqueta: "contra entrega" } },
    novedades: [],
    ...extra,
  });

  const pintar = (pedidos) =>
    vistas.guias({
      datos: {
        porDespachar: pedidos.map((p) => ({ ...p, _listo: dominioPedido.listoParaDespachar(p) })),
        despachados: [],
        entregados: [],
        conNovedad: [],
      },
      transportadoras: ["Interrapidisimo"],
    });

  test("estan las seis cosas que Marco necesita para la guia", () => {
    const html = pintar([unPedido()]);

    // Las cabeceras.
    for (const col of ["Cliente", "Celular", "Ciudad", "Direccion", "Producto", "Total"]) {
      assert.match(html, new RegExp(`<th>${col}</th>`), `falta la columna ${col}`);
    }

    // Y los datos de verdad en la fila.
    assert.match(html, /Nevis Johana Sánchez López/, "falta el nombre");
    assert.match(html, /3105177896/, "falta el celular, que es el que pidió");
    assert.match(html, /Bogota/, "falta la ciudad");
    assert.match(html, /KR 101 #29c-07/, "falta la dirección");
    assert.match(html, /Cinturón térmico NOVIKA/, "falta el producto que se despacha");
    assert.match(html, /\$85\.000/, "falta el total a pagar");
  });

  test("el celular es el del DESTINATARIO, nunca la clave del chat", () => {
    // ⚠️ LA EQUIVOCACION QUE IMPRIMIRIA UNA GUIA INSERVIBLE.
    //
    // `contactoId` es la clave de la conversacion y puede ser un BSUID
    // (`CO.1098944…`) cuando el cliente escribe con nombre de usuario — el
    // 07-oct eran tres de los quince chats del dia. Si la columna saliera
    // de ahi, la transportadora tendria un numero que no existe y el
    // paquete se devuelve.
    const html = pintar([unPedido()]);
    assert.match(html, /3105177896/, "no mostró el celular del destinatario");
    assert.equal(/CO\.1098944221/.test(html), false, "mostró el BSUID del chat como celular de la guía");
  });

  test("la direccion lleva el punto de referencia, que es lo que busca el mensajero", () => {
    // En los pueblos la referencia ES la direccion ("Barrio pueblillo en la
    // cantera la pintada"). Se pegan las dos con `guias.datosDe`, que es la
    // misma funcion que usa el pareo de etiquetas: una sola fuente.
    const html = pintar([unPedido()]);
    assert.match(html, /KR 101 #29c-07 Lagos de suba/, "la dirección no lleva la referencia");
  });

  test("y la cantidad se ve, porque despachar dos no es despachar uno", () => {
    const html = pintar([unPedido({ cantidad: 2 })]);
    assert.match(html, /×\s*2/, "no se ve que son dos unidades");
    // Con una sola unidad no se ensucia la celda.
    const una = pintar([unPedido({ cantidad: 1 })]);
    assert.equal(/×\s*1/.test(una), false, "puso «× 1», que es ruido");
  });

  test("un pedido al que le falta un dato lo dice, y no finge tenerlo", () => {
    const sinTelefono = unPedido({
      id: "NOV-SINTEL",
      destinatario: { ...unPedido().destinatario, telefono: "" },
    });
    const html = pintar([sinTelefono]);
    assert.match(html, /falta telefono/i, "no avisó de que falta el celular");
    // Y la celda queda con una raya, no vacía: una celda vacía parece un
    // error de la pantalla, no un dato que falta.
    assert.match(html, /—/, "la celda sin dato tiene que mostrar una raya");
  });

  test("cada celda lleva su data-label, o en el móvil la tabla no se lee", () => {
    // El panel apila las filas como tarjetas por debajo de 760px usando
    // `content: attr(data-label)`. Una celda sin su etiqueta sale sin
    // título, y con nueve columnas eso es ilegible. Marco mira esto desde
    // el teléfono.
    const html = pintar([unPedido()]);
    for (const col of ["Codigo", "Cliente", "Celular", "Ciudad", "Direccion", "Producto", "Total", "Estado"]) {
      assert.match(html, new RegExp(`data-label="${col}"`), `la celda ${col} no tiene data-label`);
    }
  });
});

// ==========================================================================
// LA GUIA QUE NO SE PODIA MANDAR (09-oct)
//
// Marco: «no me deja mandar esa guía, arréglalo». En el panel, el pedido
// NOV-MV1GEEAT-E4E8F4D3 salia asi:
//
//   Cliente: Sii | Ipiales | $49.900 | en revision: solo un nombre: puede
//   faltar el apellido | hay que completar los datos antes
//
// "Sii" era el «sí» con el que la clienta confirmo el pedido. Se guardo como
// su nombre, el pedido quedo EN_REVISION, y EN_REVISION impide despachar.
// Una venta de $49.900 parada, sin ninguna forma de arreglarla desde el
// panel: no habia ruta para tocar el destinatario de un pedido.
// ==========================================================================

describe("14 · la guia bloqueada por un nombre que no era un nombre", () => {
  const dominioDestino = require("../src/dominio/destino");
  const extraer = require("../src/dominio/extraer");

  test('«Sii» y sus variantes no se guardan como nombre', () => {
    // Se colaba por un fallo de UNA LETRA: la lista decia /^(si|no|ok|...)\b/
    // y el \b detras de "si" no casa dentro de "sii" — las dos son letras,
    // no hay frontera. Asi que "si" se rechazaba y "sii" pasaba.
    for (const falso of ["Sii", "sii", "Siii", "sip", "sisi", "Noo", "ok", "listo", "confirmo", "sii señor"]) {
      assert.equal(
        dominioDestino.validarNombre(falso).ok,
        false,
        `validarNombre aceptó "${falso}" como nombre de una guía`
      );
      assert.equal(
        (extraer.nombreEn(falso, { seLoPidieron: true }) || {}).valor,
        null,
        `extraer guardó "${falso}" como nombre del cliente`
      );
    }
  });

  test("y los nombres de verdad que empiezan por «si» siguen pasando", () => {
    // La trampa de arreglarlo con un prefijo: "Silvia", "Simón" y "Sixta"
    // empiezan por "si". El patrón va anclado al final, así que no casan.
    for (const real of ["Simon Bolivar", "Sixta Tulia", "Sonia", "Nohora Vallejo", "Nelly Esperanza Burbano"]) {
      assert.equal(dominioDestino.validarNombre(real).ok, true, `rechazó un nombre real: "${real}"`);
    }
  });

  /** El pedido de Marco, tal como quedó en producción. */
  const elPedidoDeIpiales = (revisiones = [{ campo: "nombre", motivo: "solo un nombre: puede faltar el apellido" }]) =>
    dominioPedido.construir({
      cotizacion: {
        productoId: "cinturon-termico-colicos",
        productoNombre: "Cinturón térmico NOVIKA",
        cantidad: 1,
        total: 49900,
        subtotal: 49900,
        envio: 0,
        descuento: 0,
        condiciones: { pagoMetodo: "contraentrega", envioIncluido: true },
      },
      datos: { nombre: "Sii", telefono: "3001112233", ciudad: "Ipiales", direccion: "Calle 10 # 5-20" },
      contactoId: "573001112233",
      ofertaId: "OF-1",
      wamidConfirmacion: "wamid.X",
      revisiones,
    }).pedido;

  test("un pedido en revision no se despacha: eso estaba bien y sigue igual", () => {
    const p = elPedidoDeIpiales();
    const listo = dominioPedido.listoParaDespachar(p);
    assert.equal(listo.ok, false, "dejó despachar una guía a nombre de «Sii»");
    assert.match(listo.motivo, /en revision/i);
  });

  test("corregir el dato CIERRA su revision y desbloquea el despacho", () => {
    // Era el agujero: las revisiones se escribían al crear el pedido y nadie
    // las borraba nunca. El único final posible era cancelar y rehacerlo.
    const p = elPedidoDeIpiales();
    const r = dominioPedido.modificar({
      pedido: p,
      cambios: { nombre: "Nelly Esperanza Burbano" },
      porQue: "los corrigio una persona desde el panel",
    });

    assert.equal(r.ok, true, r.motivo);
    assert.equal(r.pedido.destinatario.nombre, "Nelly Esperanza Burbano");
    assert.deepEqual(r.pedido.revisiones, [], "la revisión del nombre no se cerró al corregirlo");
    assert.equal(dominioPedido.listoParaDespachar(r.pedido).ok, true, "sigue sin poder despacharse");

    // Y queda escrito quién lo cambió y qué había antes: si un pedido pasa
    // de «en revisión» a despachable, tiene que poder leerse por qué.
    const h = r.pedido.historial[r.pedido.historial.length - 1];
    assert.equal(h.antes.nombre, "Sii", "el historial no guarda el valor que había");
    assert.equal(h.revisionesCerradas, 1);
    assert.match(h.porQue, /persona desde el panel/);
  });

  test("corregir UN campo no cierra las dudas de los OTROS", () => {
    // Arreglar el nombre no dice nada sobre la dirección.
    const p = elPedidoDeIpiales([
      { campo: "nombre", motivo: "solo un nombre" },
      { campo: "direccion", motivo: "direccion corta" },
    ]);
    const r = dominioPedido.modificar({ pedido: p, cambios: { nombre: "Nelly Burbano" }, porQue: "panel" });

    assert.deepEqual(r.pedido.revisiones, [{ campo: "direccion", motivo: "direccion corta" }]);
    const listo = dominioPedido.listoParaDespachar(r.pedido);
    assert.equal(listo.ok, false, "desbloqueó el despacho con una duda sin resolver");
    assert.match(listo.motivo, /direccion corta/);
  });

  test("una duda sin resolver bloquea aunque el pedido ya no esté «en revision»", () => {
    // El hueco que abrió permitir corregir: `modificar` deja el pedido en
    // MODIFICADO, así que mirar solo el estado dejaba pasar un pedido con
    // dudas pendientes. Con el cambio de cantidad ya pasaba: cambiar de 1 a
    // 2 unidades «limpiaba» una duda del nombre que nadie había mirado.
    const p = elPedidoDeIpiales();
    const r = dominioPedido.modificar({ pedido: p, cambios: { telefono: "3001119999" }, porQue: "panel" });

    assert.notEqual(r.pedido.estado, "en_revision", "el estado ya no es en_revision");
    assert.ok(r.pedido.revisiones.length, "la duda del nombre sigue ahí");
    assert.equal(
      dominioPedido.listoParaDespachar(r.pedido).ok,
      false,
      "dejó despachar un pedido con una duda que nadie resolvió"
    );
  });

  test("el panel trae el formulario para corregirlo, en la propia fila", () => {
    // Antes aquí solo decía «hay que completar los datos antes», sin ninguna
    // forma de completarlos.
    const p = elPedidoDeIpiales();
    const html = vistas.guias({
      datos: {
        porDespachar: [{ ...p, _listo: dominioPedido.listoParaDespachar(p) }],
        despachados: [],
        entregados: [],
        conNovedad: [],
      },
      transportadoras: ["Interrapidisimo"],
    });

    assert.match(html, new RegExp(`id="n-${p.id}"`), "no hay campo para corregir el nombre");
    assert.match(html, new RegExp(`onclick="corregir\\('${p.id}'\\)"`), "no hay botón para guardar la corrección");
    // Pre-rellenado con lo que hay, para corregir y no reescribir de cero.
    assert.match(html, /value="Sii"/, "el campo no viene con el valor que hay que corregir");
    assert.equal(/hay que completar los datos antes/.test(html), false, "sigue el mensaje sin salida");
  });

});

module.exports = {};
