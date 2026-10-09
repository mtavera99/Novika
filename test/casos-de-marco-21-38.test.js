"use strict";

// ==========================================================================
// LOS CASOS 21 AL 38 DE MARCO · PARCHE 3
//
// Los escribió uno por uno a partir de las 19 conversaciones del panel entre
// el 8 de octubre a las 22:40 y el 9 a las 00:39, con los mensajes literales
// de los clientes.
//
// Dos de esas conversaciones costaron una venta de $85.000 cada una:
//
//   · Ailid (Bogotá) confirmó un pedido de 2 unidades CON EL NOMBRE
//     EQUIVOCADO después de intentar corregirlo cuatro veces, y acabó
//     pidiendo que lo cancelaran.
//   · ANDRE (Medellín) confirmó 1 unidad, pidió 2 enseguida, y el pedido se
//     quedó en 1 unidad y $49.900 pese a que un operador cerró la venta de
//     dos a mano.
//
// Cada caso lleva: lo que escribió el cliente, y lo que debe pasar ahora.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearEmisor } = require("../src/whatsapp/enviar");
const { cargarCatalogo } = require("../src/catalogo");
const atencion = require("../src/almacen/atencion");
const mutex = require("../src/almacen/mutex");
const campos = require("../src/dominio/campos");
const extraer = require("../src/dominio/extraer");
const recordatorios = require("../src/dominio/recordatorios");

const RAIZ = path.join(__dirname, "..");
const ANUNCIO = "Hola, quiero información sobre el cinturón térmico de $49.900.";

/** Las frases que Marco prohibió expresamente. */
const PROHIBIDAS = /no quiero repetirme|dime concretamente|no te l[ao]s? quiero (decir|contestar) a medias|no te entend/i;

let SEQ = 0;

async function chat({ nombrePerfil = null, telefono = "573116391876" } = {}) {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-p3-")) });
  const cfg = {
    ...config,
    respuestaAutomatica: true,
    whatsappToken: "token-de-prueba",
    idNumero: "000",
    urlPublica: "https://pruebas.invalido",
  };

  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    atencion,
    fetchImpl: async (_url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.P${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  const dice = async (texto) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.P${++SEQ}_${process.pid}_${Date.now()}`,
      idCliente: telefono,
      telefono,
      nombre: nombrePerfil,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });
    const conv = await repos.conversaciones.obtener(telefono);
    return {
      traza,
      texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join(" "),
      conversacion: conv,
      ficha: (conv && conv.ficha) || {},
    };
  };

  const pedidos = async () => {
    const l = await repos.pedidos.listar({ limite: 20 });
    return Array.isArray(l) ? l : l.filas || [];
  };

  return { dice, pedidos, repos };
}

/** Deja un pedido de 1 unidad confirmado, que es el punto de partida de varios casos. */
async function conPedidoDeUno(c) {
  await c.dice(ANUNCIO);
  await c.dice("lo quiero, soy Andres Ramirez, Medellin, Calle 50 # 20-15");
  const r = await c.dice("Si");
  assert.equal(r.traza.respuesta.situacion, "confirmado", `la venta no se cerró: ${r.texto}`);
  return r;
}

// ==========================================================================
describe("Casos 21 al 38 de Marco", () => {
  // ------------------------------------------------------------------------
  test("21 · todos los datos en UN mensaje, separados por barras", async () => {
    // El mensaje literal de Ailid. El bot armó el resumen con "Ailid🥰" -el
    // nombre de su perfil- e ignoró el que ella escribió.
    const c = await chat({ nombrePerfil: "Ailid🥰" });
    await c.dice(ANUNCIO);
    const r = await c.dice(
      "Nevis Johana Sánchez López / 3105177896 / 3235340018 / KR 101#29c-07 / Lagos de suba / BOGOTÁ"
    );

    assert.match(r.texto, /Nevis Johana Sánchez López/, `el resumen no lleva su nombre: ${r.texto}`);
    assert.equal(/Ailid/.test(r.texto), false, `usó el nombre del perfil: ${r.texto}`);
    assert.equal(campos.valorConfirmado(r.ficha.ciudad), "Bogota", "no tomó la ciudad");
    // La dirección NO se come la ciudad: eso se imprime en la guía.
    const dir = campos.valorConfirmado(r.ficha.direccion) || "";
    assert.match(dir, /KR 101#29c-07/, `perdió la dirección: ${dir}`);
    assert.equal(/BOGOT/i.test(dir), false, `la dirección se comió la ciudad: ${dir}`);
  });

  test("22 · «Hay donde dice ailid, no es, es Nevis Johana» cambia el nombre y lo dice", async () => {
    const c = await chat({ nombrePerfil: "Ailid🥰" });
    await c.dice(ANUNCIO);
    await c.dice("Nevis Sánchez López / KR 101#29c-07 / Lagos de suba / BOGOTÁ");
    const r = await c.dice("Hay donde dice ailid, no es, es Nevis Johana Sánchez López");

    assert.match(r.texto, /ya lo cambié/i, `no avisó del cambio: ${r.texto}`);
    assert.match(r.texto, /Nevis Johana Sánchez López/, `no aplicó la corrección: ${r.texto}`);
    assert.equal(campos.valorConfirmado(r.ficha.nombre), "Nevis Johana Sánchez López");
  });

  test("23 · un «No» junto al resumen pregunta qué está mal, NO cancela", async () => {
    // Es el mensaje que remató la venta de Ailid: cansada de que no le
    // cambiaran el nombre escribió "No", y el bot se despidió.
    const c = await chat({ nombrePerfil: "Ailid🥰" });
    await c.dice(ANUNCIO);
    const resumen = await c.dice("Nevis Johana Sánchez López / KR 101#29c-07 / Lagos de suba / BOGOTÁ");
    assert.match(resumen.texto, /Confirmemos tu pedido/i, `no llegó al resumen: ${resumen.texto}`);

    const r = await c.dice("No");
    assert.match(r.texto, /qué dato está mal|corrijo/i, `no preguntó qué estaba mal: ${r.texto}`);
    assert.equal(/más adelante lo quieres|aquí estoy/i.test(r.texto), false, `se despidió: ${r.texto}`);
    assert.equal((await c.pedidos()).length, 0, "no debería haber pedido todavía");
  });

  test("23-bis · pero «no lo quiero» y «no gracias» SÍ cancelan", async () => {
    // La asimetría tiene un límite: si lo dice claro, se respeta.
    for (const frase of ["no lo quiero", "ya no me interesa", "no gracias"]) {
      const c = await chat({ nombrePerfil: "Cliente" });
      await c.dice(ANUNCIO);
      await c.dice("Nevis Johana Sánchez López / KR 101#29c-07 / Lagos de suba / BOGOTÁ");
      const r = await c.dice(frase);
      assert.equal(
        /qué dato está mal/i.test(r.texto),
        false,
        `"${frase}" es una cancelación clara y preguntó qué estaba mal: ${r.texto}`
      );
    }
  });

  test("25 · «A orocue» se reconoce (Casanare)", async () => {
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    const r = await c.dice("A orocue");

    assert.equal(campos.valorConfirmado(r.ficha.ciudad), "Orocue", `no reconoció Orocué: ${r.texto}`);
    assert.match(r.texto, /días hábiles/i, `no dio el tiempo de entrega: ${r.texto}`);
    assert.match(r.texto, /me pasas/i, `no pidió los datos: ${r.texto}`);
  });

  test("25-bis · y no se le vuelve a pedir la ciudad", async () => {
    // Marco: "más adelante volvió a pedirle la ciudad a la clienta de Orocué".
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    await c.dice("A orocue");
    const r = await c.dice("Calle 5 # 10-20");
    assert.equal(/qué ciudad|la ciudad/i.test(r.texto), false, `volvió a pedir la ciudad: ${r.texto}`);
  });

  test("26 · «Málaga Santander» se reconoce, y el departamento no cuenta como segunda ciudad", async () => {
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Málaga Santander");

    assert.equal(campos.valorConfirmado(r.ficha.ciudad), "Malaga", `no reconoció Málaga: ${r.texto}`);
    assert.match(r.texto, /días hábiles/i, `no dio el tiempo: ${r.texto}`);
    assert.match(r.texto, /me pasas/i, `no pidió los datos: ${r.texto}`);
  });

  test("27 · «Funciona también con frío» se contesta: solo da calor", async () => {
    const c = await chat({ nombrePerfil: "Andrés" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Funciona también con frío");

    assert.match(r.texto, /solo da calor/i, r.texto);
    assert.match(r.texto, /no tiene función de frío/i, r.texto);
    assert.equal(PROHIBIDAS.test(r.texto), false, `frase prohibida: ${r.texto}`);
  });

  test("28 · la objeción de confianza recibe seguridad, no una disculpa", async () => {
    // Las dos de José Polo. Marco: "era el momento de dar seguridad".
    for (const frase of ["Pero que sea cierto", "Porque en otras páginas he pedido y no llega nada"]) {
      const c = await chat({ nombrePerfil: "José Polo" });
      await c.dice(ANUNCIO);
      const r = await c.dice(frase);

      assert.equal(PROHIBIDAS.test(r.texto), false, `"${frase}" recibió una disculpa: ${r.texto}`);
      assert.match(r.texto, /pagas (cuando|solo cuando|al recibir)|no arriesgas/i, `sin el argumento del riesgo: ${r.texto}`);
    }
  });

  test("29 · «Sería para fin de este mes» se acepta y se anota", async () => {
    const c = await chat({ nombrePerfil: "Andrés" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Sería para fin de este mes se podría");

    assert.equal(PROHIBIDAS.test(r.texto), false, `frase prohibida: ${r.texto}`);
    assert.match(r.texto, /cuando me digas|cuando lo necesites|anotado/i, `no aceptó la fecha: ${r.texto}`);
    // Y queda en la bandeja, porque el recordatorio largo lo tiene que
    // hacer una persona hasta que exista la plantilla de WhatsApp.
    assert.equal(atencion.pendienteDe(r.conversacion).hay, true, "no quedó anotado para una persona");
  });

  test("30 · «Bogotá» da 1 a 2 días hábiles y pide los datos", async () => {
    const c = await chat({ nombrePerfil: "Diego Pérez" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Bogotá");

    assert.match(r.texto, /1 a 2 días hábiles/, `plazo incorrecto para Bogotá: ${r.texto}`);
    assert.equal(/según la ciudad/i.test(r.texto), false, `volvió el "según la ciudad": ${r.texto}`);
    assert.match(r.texto, /me pasas/i, `no pidió los datos: ${r.texto}`);
  });

  test("31 · «Para que es que sirve precisamente» se contesta antes de pedir datos", async () => {
    // Carlos Carvajal recibió "¡Perfecto! ¿Cuántos quieres?…" sin respuesta.
    const c = await chat({ nombrePerfil: "Carlos Carvajal" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Para que es que sirve precisamente");

    assert.match(r.texto, /cólico|abdomen|calor/i, `no explicó para qué sirve: ${r.texto}`);
    // Y la explicación va PRIMERO, no detrás de la pedida de datos.
    const iExplica = r.texto.search(/cólico|abdomen|calor/i);
    const iPide = r.texto.search(/me pasas|Cuántos quieres/i);
    if (iPide >= 0) assert.ok(iExplica < iPide, `pidió datos antes de contestar: ${r.texto}`);
  });

  test("32 · «Pero soy menor de edad» no se ignora", async () => {
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Pero soy menor de edad");

    assert.match(r.texto, /mayor de edad/i, `ignoró que es menor: ${r.texto}`);
    assert.match(r.texto, /reciba|pague/i, r.texto);
  });

  test("33 · «Será otro día» no recibe «¿te lo aparto?»", async () => {
    const c = await chat({ nombrePerfil: "edgar" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Será otro día");

    assert.equal(/te lo aparto/i.test(r.texto), false, `le insistió a quien aplazó: ${r.texto}`);
    assert.match(r.texto, /cuando quieras|aquí seguimos/i, `no le dejó la puerta abierta: ${r.texto}`);
    // Y queda anotado para volver UNA vez a las 20 horas.
    assert.ok(r.conversacion.aplazadoEn, "no anotó el aplazamiento");
  });

  test("33-bis · y el recordatorio del aplazado es a las 20 h, una sola vez", () => {
    const ahora = Date.parse("2026-10-10T20:00:00Z"); // 15:00 en Bogotá
    const hace = (min) => new Date(ahora - min * 60000).toISOString();
    const conv = (min) => ({
      contactoId: "57300",
      estado: "capturando_datos",
      saludado: true,
      datosPedidos: true,
      ultimoDelClienteEn: hace(min),
      aplazadoEn: hace(min),
      ficha: {},
      mensajes: [
        { de: "cliente", texto: "Será otro día", ts: hace(min) },
        { de: "bot", texto: "¡sin problema!", ts: new Date(ahora).toISOString() },
      ],
    });
    const dec = (min) =>
      recordatorios.decidir({
        conversacion: conv(min),
        ahora,
        activos: true,
        minutos: [30, 180],
        desdeHora: 0,
        hastaHora: 24,
      });

    // A los 30 min y a las 3 h NO: a quien aplaza, insistir enseguida le
    // dice que no se le escuchó.
    assert.equal(dec(35).debe, false, "le escribió a los 35 minutos");
    assert.equal(dec(200).debe, false, "le escribió a las 3 horas");
    // A las 20 h sí, y una sola vez.
    assert.equal(dec(20 * 60 + 5).debe, true, "no volvió a las 20 horas");
    assert.equal(dec(20 * 60 + 5).orden, 1);
  });

  test("34 · «Y si lo pido hoy cuándo me está llegando» da el plazo, no escala", async () => {
    const c = await chat({ nombrePerfil: "ANDRE" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Y si lo pido hoy cuándo me está llegando");

    assert.match(r.texto, /días hábiles/i, `no dio el plazo: ${r.texto}`);
    assert.equal(PROHIBIDAS.test(r.texto), false, `frase prohibida: ${r.texto}`);
  });

  test("35 · «Como se llama eso» dice el nombre y para qué sirve", async () => {
    const c = await chat({ nombrePerfil: "la china" });
    await c.dice(ANUNCIO);
    const r = await c.dice("Como se llama eso");

    assert.match(r.texto, /Cinturón térmico NOVIKA/i, `no dijo el nombre: ${r.texto}`);
    assert.equal(PROHIBIDAS.test(r.texto), false, `frase prohibida: ${r.texto}`);
  });

  // ------------------------------------------------------------------------
  // 36 y 37 · EL CASO ANDRE. La otra venta de $85.000.
  // ------------------------------------------------------------------------
  test("36 · con 1 confirmado, «Mejor me mandas los 2» cambia a 2 y $85.000", async () => {
    const c = await chat({ nombrePerfil: "ANDRE", telefono: "573135389163" });
    await conPedidoDeUno(c);

    const propuesta = await c.dice("Mejor me mandas los 2");
    assert.match(propuesta.texto, /2 unidades/i, `no propuso el cambio: ${propuesta.texto}`);
    assert.match(propuesta.texto, /\$85\.000/, `no dio el total nuevo: ${propuesta.texto}`);
    assert.match(propuesta.texto, /confirmo/i, `no pidió el sí: ${propuesta.texto}`);
    // Marco fue explícito: "No escalar por esto".
    assert.equal(/una persona|el equipo/i.test(propuesta.texto), false, `escaló: ${propuesta.texto}`);

    const r = await c.dice("Si");
    const pedidos = await c.pedidos();
    assert.equal(pedidos.length, 1, "creó un pedido nuevo en vez de cambiar el que había");
    assert.equal(pedidos[0].cantidad, 2, `el pedido se quedó en ${pedidos[0].cantidad} unidades: ${r.texto}`);
    assert.equal(pedidos[0].cotizacion.total, 85000, "no recalculó el total");
  });

  test("37 · «¿ese es el precio que pago cuando reciba?» responde el total DEL PEDIDO", async () => {
    // Con 2 unidades confirmadas, el bot preparó "$49.900". No salió porque
    // el chat estaba en manos de una persona, pero era un precio equivocado.
    const c = await chat({ nombrePerfil: "ANDRE", telefono: "573135389163" });
    await conPedidoDeUno(c);
    await c.dice("Mejor me mandas los 2");
    await c.dice("Si");

    const r = await c.dice("O sea que ese es el precio que pago cuando reciba?");
    assert.match(r.texto, /\$85\.000/, `contestó con el precio equivocado: ${r.texto}`);
    assert.equal(/\$49\.900/.test(r.texto), false, `dijo el precio de una unidad: ${r.texto}`);
  });

  test("38 · «Barrio bello oriente» no cambia Medellín por Bello", async () => {
    const c = await chat({ nombrePerfil: "ANDRE" });
    await c.dice(ANUNCIO);
    await c.dice("Medellín");
    const r = await c.dice("Barrio bello oriente");

    assert.equal(
      campos.valorConfirmado(r.ficha.ciudad),
      "Medellin",
      `la dirección cambió la ciudad a ${campos.valorConfirmado(r.ficha.ciudad)}`
    );
  });

  test("38-bis · y una dirección con un municipio dentro tampoco", () => {
    // El caso que apareció al cargar los 1.037 municipios: "La Pintada" es un
    // municipio de Antioquia, y estaba moviendo el pedido de Popayán a 400 km.
    assert.equal(
      extraer.ciudadEn("Barrio pueblillo en la cantera la pintada", { yaHayCiudad: true }).valor,
      null,
      "una dirección cambió la ciudad"
    );
  });

  // ------------------------------------------------------------------------
  // 6 y 8 · las respuestas que no se entendían
  // ------------------------------------------------------------------------
  test("6 · «Por favor» tras pedirle el barrio no recibe «no te entendí»", async () => {
    const c = await chat({ nombrePerfil: "ANDRE" });
    await c.dice(ANUNCIO);
    await c.dice("Medellin");
    await c.dice("lo quiero");
    const a = await c.dice("Por favor");
    const b = await c.dice("Por favor");

    for (const r of [a, b]) {
      assert.equal(PROHIBIDAS.test(r.texto), false, `le dijo que no lo entendía: ${r.texto}`);
      assert.match(r.texto, /dirección|barrio|referencia/i, `no retomó el paso: ${r.texto}`);
    }
    // Y no dos veces el mismo texto.
    assert.notEqual(a.texto, b.texto, "repitió el mismo mensaje palabra por palabra");
  });

  test("6-bis · un «Si» a un mensaje del OPERADOR se entiende", async () => {
    // Marco: después de que el operador escribe "¿Me confirmas?", un "Si"
    // del cliente volvía a "¿Te lo aparto…?".
    const c = await chat({ nombrePerfil: "Cliente" });
    await c.dice(ANUNCIO);
    await c.dice("Medellin");

    // El operador entra a mano, como desde el panel.
    const conv = await c.repos.conversaciones.obtener("573116391876");
    atencion.anotarMensaje(conv, {
      de: atencion.QUIEN.OPERADOR,
      texto: "¿Te lo aparto?",
      por: "panel",
      estado: "enviado",
    });
    await c.repos.conversaciones.guardar(conv);

    const r = await c.dice("Si");
    assert.equal(/te lo aparto/i.test(r.texto), false, `repitió la pregunta del operador: ${r.texto}`);
    // Avanzar es pedir lo que falta, con las palabras que toquen: la segunda
    // pedida de dirección se reformula a "dime el barrio… o un punto de
    // referencia", que es más fácil de contestar que repetir "la dirección".
    assert.match(
      r.texto,
      /me pasas|dirección|barrio|referencia|nombre/i,
      `no avanzó tras el sí: ${r.texto}`
    );
  });
});

// ==========================================================================
// 11-bis · LA PUERTA MANUAL DEL PANEL
//
// Marco: "El panel debe permitir cambiar la cantidad de un pedido confirmado
// y recalcular el total".
//
// Hace falta además de lo que hace el bot: el caso de ANDRE lo salvó un
// operador a mano y el pedido se quedó en 1 unidad y $49.900 porque no había
// por dónde corregirlo.
// ==========================================================================
describe("11-bis · el panel puede cambiar la cantidad de un pedido", () => {
  const dominioPedido = require("../src/dominio/pedido");
  const { cotizar } = require("../src/dominio/cotizador");

  const elCinturon = () =>
    cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).productos[0];

  test("cambia la cantidad y RECALCULA el total", async () => {
    const c = await chat({ nombrePerfil: "ANDRE" });
    await conPedidoDeUno(c);
    const [pedido] = await c.pedidos();
    assert.equal(pedido.cantidad, 1);

    // El mismo camino que usa la ruta del panel.
    const nueva = cotizar({ producto: elCinturon(), cantidad: 2, destino: null, variante: null });
    assert.equal(nueva.ok, true, "no se pudo cotizar 2 unidades");

    const r = dominioPedido.modificar({
      pedido,
      cambios: { cantidad: 2 },
      cotizacionNueva: nueva.cotizacion,
      porQue: "lo cambio una persona desde el panel",
    });
    assert.equal(r.ok, true, r.motivo);
    assert.equal(r.pedido.cantidad, 2);
    assert.equal(r.pedido.cotizacion.total, 85000, "no recalculó el total");
    // Y queda versionado, no sobreescrito: el historial del pedido es lo que
    // permite auditar un despacho.
    assert.equal(r.pedido.version, pedido.version + 1, "no subió la versión");
  });

  test("y se niega si el pedido YA SALIÓ", () => {
    // Cambiarle la cantidad a algo que va en camino es mentir sobre lo que
    // hay en la caja. La negativa vive en el dominio, así que vale igual
    // para el bot y para el panel.
    const nueva = cotizar({ producto: elCinturon(), cantidad: 2, destino: null, variante: null });
    const despachado = {
      codigo: "NOV-X",
      version: 1,
      estado: "despachado",
      cantidad: 1,
      producto: { id: "cinturon-termico-colicos" },
      destinatario: {},
      cotizacion: {},
      historial: [],
    };
    const r = dominioPedido.modificar({
      pedido: despachado,
      cambios: { cantidad: 2 },
      cotizacionNueva: nueva.cotizacion,
    });
    assert.equal(r.ok, false, "dejó cambiar un pedido ya despachado");
    assert.match(r.motivo, /despachado/i);
  });

  test("la ruta del panel existe y usa la operación del dominio", () => {
    // Si alguien escribe aquí un camino propio, el del panel acaba siendo el
    // que no comprueba nada: ni el despacho, ni la cotización nueva.
    const rutas = fs.readFileSync(path.join(RAIZ, "src", "panel", "rutas.js"), "utf8");
    const i = rutas.indexOf('router.post("/pedido/cantidad"');
    assert.ok(i > 0, "no existe la ruta de cambiar la cantidad");
    const bloque = rutas.slice(i, i + 3000);
    assert.match(bloque, /dominioPedido\.modificar/, "no usa la operación del dominio");
    assert.match(bloque, /cotizar\(/, "no recalcula el total");
  });
});
