"use strict";

// ==========================================================================
// REVIVIR LAS VENTAS QUE SE PERDIERON
//
// POR QUE EXISTE
//
// `conversar.js` lee dialogos inventados y `sondear.js` mide preguntas
// sueltas. Falta la prueba que de verdad importa: coger una conversacion
// REAL que no se cerro, pasarla entera por el bot otra vez, y ver si ahora
// acaba en un pedido.
//
// Las tres de aqui son del panel de produccion del 2026-10-08, el dia que
// hubo 33 chats y CERO pedidos. Dos las tuvo que rescatar una persona a mano
// hora y media despues; la tercera es el chat de pruebas de Marco.
//
// Los mensajes del cliente estan copiados literalmente, con sus erratas y su
// puntuacion. No se "limpian": las erratas son parte del caso.
//
// LO QUE SE MIDE: que la conversacion llegue a PEDIDO. No el tono, no las
// frases — el pedido. Es el unico numero que le importaba a Marco: de 33
// chats, 0 ventas.
//
//   node herramientas/revivir.js            las tres
//   node herramientas/revivir.js --lista
//   node herramientas/revivir.js moises
// ==========================================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RAIZ = path.join(__dirname, "..");
require(path.join(RAIZ, "test", "ayuda")).entornoDePrueba();

const { config } = require(path.join(RAIZ, "src", "config"));
const { crearCerebro } = require(path.join(RAIZ, "src", "cerebro", "orquestar"));
const { crearReposDeArchivos } = require(path.join(RAIZ, "src", "almacen", "repos", "archivos"));
const { crearCliente } = require(path.join(RAIZ, "src", "ia", "cliente"));
const { crearEmisor } = require(path.join(RAIZ, "src", "whatsapp", "enviar"));
const { cargarCatalogo } = require(path.join(RAIZ, "src", "catalogo"));
const atencion = require(path.join(RAIZ, "src", "almacen", "atencion"));
const mutex = require(path.join(RAIZ, "src", "almacen", "mutex"));

let SEQ = 0;

async function abrirChat(nombrePerfil) {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-revivir-")) });
  const cfg = {
    ...config,
    respuestaAutomatica: true,
    whatsappToken: "token-de-mentira",
    idNumero: "000",
    urlPublica: "https://no-existe.invalido",
  };

  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    // COMO EN PRODUCCION. Sin `atencion` el emisor no comprueba la pausa, y
    // el silencio de 12 h -el sintoma que mato estas tres conversaciones-
    // seria invisible justo en la herramienta que existe para verlo.
    atencion,
    fetchImpl: async (url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.R${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  const telefono = "573001112233";

  return {
    async dice(texto) {
      salidas.length = 0;
      await cerebro.procesar({
        clase: "mensaje",
        wamid: `wamid.R${++SEQ}_${process.pid}`,
        idCliente: telefono,
        telefono,
        nombre: nombrePerfil,
        tipo: "text",
        texto,
        origenTexto: "escrito",
        referral: null,
      });
      const dicho = salidas.filter((s) => s.type === "text").map((s) => s.text.body);
      const fotos = salidas.filter((s) => s.type === "image").length;
      const conv = await repos.conversaciones.obtener(telefono);
      const pausado = atencion.leer(conv || {}).pausado === true;

      console.log(`\n  cliente ·  ${texto || "(vacio)"}`);
      console.log(`  NOVIKA  ·  ${dicho.join(" ") || "⛔ SILENCIO"}${pausado ? "   ‹bot pausado›" : ""}`);
      if (fotos) console.log(`             (+ ${fotos} fotos)`);
    },
    async pedidos() {
      const l = await repos.pedidos.listar({ limite: 20 });
      return Array.isArray(l) ? l : l.filas || [];
    },
    async ficha() {
      const conv = await repos.conversaciones.obtener(telefono);
      return (conv && conv.ficha) || {};
    },
  };
}

// --------------------------------------------------------------------------
const CASOS = {
  moises: {
    titulo: "Mauricio · San Andrés de Sotavento (Córdoba) — la rescato una persona a mano",
    perfil: "Mauricio Benítez",
    // Del panel: el chat de San Andrés de Sotavento. Lo que recibio de verdad:
    //   "Barrio buenos aires" -> "Para preparar tu pedido me pasas la direccion"
    //   "No entiendo"         -> escalado, y el bot se callo 12 h
    //   "Interapidisimo"      -> no enviado: conversacion_pausada
    // A las 13:13 un operador escribio a mano para rescatarlo.
    //
    // DOS CANDADOS EN SERIE lo rechazaban: `extraer.direccionEn` exigia un
    // numero detras del tipo de via, y `destino.validarDireccion` exigia un
    // numero en toda la direccion. En un pueblo no hay nomenclatura.
    mensajes: [
      "Hola, quiero información sobre el cinturón térmico de $49.900.",
      "Me interesa",
      "Cuánto cuesta",
      "San andres de sotavento Córdoba",
      "Uno",
      "Barrio buenos aires",
      "Mauricio Benítez",
      "Al lado de la tienda La Esquina",
      "si",
    ],
    esperado: "1 pedido, ciudad San Andres de Sotavento (NO el archipielago)",
  },

  steven: {
    titulo: "Andrés · Popayán, con prisa — «No habría manera de que llegue hoy?»",
    perfil: "Andrés Quiceno",
    // Del panel: el chat de Popayán. El cliente mas caliente del dia -tiene
    // el colico HOY- y el bot se callo 12 horas, porque "No habria manera..."
    // empieza por "no" y se leyo como una CANCELACION.
    mensajes: [
      "Hola, quiero información sobre el cinturón térmico de $49.900.",
      "Hola buenos días",
      "Estoy en Popayán",
      "No habría manera de que llegue hoy?",
      "Por favor",
      "bueno listo lo quiero",
      "Andrés Quiceno",
      "barrio Pueblillo, calle 5 # 3-20",
      "si",
    ],
    esperado: "1 pedido, y NUNCA el silencio por 'no'",
  },

  santiago: {
    titulo: "Santiago · el chat de pruebas de Marco — seis defectos seguidos",
    perfil: "Santiago",
    // Del panel: el chat de pruebas de Marco. En un solo chat: "1 a Bogotá" no tomaba
    // la cantidad, "Gracias" recibia una peticion de datos, "Tienes
    // cinturones" recibia "no quiero repetirme", "Cuando me llegaría" se
    // escalaba y "No cargaron" le hablaba de la bateria.
    mensajes: [
      "Hola",
      "Me gusta",
      "1 a Bogotá",
      "Cuando me llegaría",
      "Gracias",
      "Tienes cinturones",
      "Quiero ver fotos",
      "No cargaron",
      "Tiene garantía",
      "listo lo quiero",
      "Calle 62bis 67-12",
      "Si",
    ],
    esperado: "1 pedido, sin un solo 'no quiero repetirme'",
  },
};

// --------------------------------------------------------------------------
(async () => {
  const pedido = process.argv[2];
  if (pedido === "--lista") {
    for (const [k, c] of Object.entries(CASOS)) console.log(`${k.padEnd(12)} ${c.titulo}`);
    return;
  }

  const aCorrer = pedido ? Object.entries(CASOS).filter(([k]) => k === pedido) : Object.entries(CASOS);
  if (!aCorrer.length) {
    console.error(`No existe el caso "${pedido}". Prueba --lista.`);
    process.exitCode = 1;
    return;
  }

  let cerrados = 0;
  for (const [clave, caso] of aCorrer) {
    console.log(`\n${"=".repeat(78)}\n  ${caso.titulo}\n  (${clave})\n${"=".repeat(78)}`);
    const c = await abrirChat(caso.perfil);
    for (const m of caso.mensajes) await c.dice(m);

    const pedidos = await c.pedidos();
    const ficha = await c.ficha();
    const ciudad = ficha.ciudad && (ficha.ciudad.confirmado || ficha.ciudad.valor);
    console.log(`\n  ── esperado: ${caso.esperado}`);
    console.log(`  ── PEDIDOS: ${pedidos.length}${pedidos.length ? `  ${pedidos[0].id}` : "   ⛔ SE PERDIO OTRA VEZ"}`);
    if (ciudad) console.log(`  ── ciudad en la ficha: ${JSON.stringify(ciudad)}`);
    if (pedidos.length) cerrados += 1;
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`  ${cerrados} de ${aCorrer.length} conversaciones reales acaban en pedido`);
  console.log("=".repeat(78));
  if (cerrados < aCorrer.length) process.exitCode = 1;
})();
