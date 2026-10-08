"use strict";

// ==========================================================================
// LAS CUATRO CONVERSACIONES, CON QUIEN REDACTA CADA MENSAJE
//
// Marco pidio ver cuatro conversaciones completas y evaluar naturalidad,
// comprension y cierre. Lo que hace falta para evaluarlas de verdad no es
// solo el texto: es saber QUIEN lo escribio.
//
// Desde el 2026-10-08 el reparto es explicito: si la pregunta esta en el
// catalogo redacta el codigo -la respuesta ya existe, con su tono y sus
// pruebas-; si no lo esta, redacta el modelo. Asi que la misma
// conversacion puede traer mensajes de los dos, y mezclarlos sin decir
// cual es cual hace imposible juzgar el tono.
//
// Cada mensaje sale etiquetado:
//
//   [codigo]  lo escribio el camino determinista
//   [modelo]  lo redacto la IA y paso los filtros
//   [codigo · la IA se descarto: motivo]   el filtro tumbo el borrador
//
//   node herramientas/demostrar.js            las cuatro, sin modelo
//   node herramientas/demostrar.js --con-ia   las cuatro, con modelo
//
// --con-ia usa IA_API_KEY si esta puesta. Si no lo esta, usa un proveedor
// SIMULADO y lo dice en pantalla: borradores escritos a mano con la forma
// que devuelve un LLM. Sirve para ver el reparto y los filtros, NO para
// juzgar la prosa del modelo de verdad.
//
// No manda nada: el emisor se sustituye. No toca produccion: almacen nuevo
// en una carpeta temporal.
// ==========================================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RAIZ = path.join(__dirname, "..");
require(path.join(RAIZ, "test", "ayuda")).entornoDePrueba({
  RESPUESTA_AUTOMATICA: "1",
  URL_PUBLICA: "https://pruebas.invalido",
  WHATSAPP_TOKEN: "token-de-mentira",
});

const { config } = require(path.join(RAIZ, "src", "config"));
const { crearCerebro } = require(path.join(RAIZ, "src", "cerebro", "orquestar"));
const { crearReposDeArchivos } = require(path.join(RAIZ, "src", "almacen", "repos", "archivos"));
const { crearCliente } = require(path.join(RAIZ, "src", "ia", "cliente"));
const { crearProveedorFalso } = require(path.join(RAIZ, "src", "ia", "proveedores", "falso"));
const { crearEmisor } = require(path.join(RAIZ, "src", "whatsapp", "enviar"));
const { cargarCatalogo } = require(path.join(RAIZ, "src", "catalogo"));
const campos = require(path.join(RAIZ, "src", "dominio", "campos"));
const atencion = require(path.join(RAIZ, "src", "almacen", "atencion"));
const mutex = require(path.join(RAIZ, "src", "almacen", "mutex"));

const CON_IA = process.argv.includes("--con-ia");
let SEQ = 0;

// --------------------------------------------------------------------------
// EL MODELO SIMULADO
//
// Devuelve lo que devuelve un LLM: intencion, candidatos y un borrador de
// respuesta. Los borradores estan escritos como escribe un modelo bien
// instruido -correctos y algo planos- porque es justo lo que Marco vio en
// produccion y lo que motivo que el catalogo tenga prioridad.
//
// El ultimo de la cola INVENTA UN PRECIO a proposito: es la unica forma de
// ver trabajar al filtro de importes.
// --------------------------------------------------------------------------
const respuesta = (intencion, borrador, candidatos = {}) => ({
  texto: JSON.stringify({ intencion, candidatos, borradorRespuesta: borrador }),
});

function modeloSimulado() {
  // Se responde segun lo que diga el mensaje, no por orden: las
  // conversaciones tienen numero de turnos distinto.
  return crearProveedorFalso([
    (entrada) => {
      const u = String(entrada.usuario || "").toLowerCase();

      if (/dormida toda la noche/.test(u)) {
        return respuesta(
          "pregunta_producto",
          "Hola, sobre usarlo toda la noche no tengo el dato confirmado. Te lo verifico con el equipo y te cuento."
        );
      }
      if (/foto/.test(u)) {
        return respuesta("pregunta_producto", "Hola, con gusto te comparto las fotos del cinturón térmico.");
      }
      if (/valen dos|cuestan dos|valen 2/.test(u)) {
        // El modelo inventa: 2 x 49.900. El combo vale 85.000.
        return respuesta("pregunta_precio", "Las dos unidades te quedan en $99.800 con envío incluido.");
      }
      if (/direccion|carrera|calle/.test(u)) {
        return respuesta("da_datos", "Perfecto, actualizo tu dirección de entrega.");
      }
      if (/cuanto vale|precio/.test(u)) {
        return respuesta("pregunta_precio", "Hola, cuéntame en qué te puedo ayudar con el cinturón térmico.");
      }
      if (/garantia/.test(u)) {
        return respuesta("pregunta_producto", "El producto cuenta con garantía. ¿Te gustaría realizar tu pedido?");
      }
      return respuesta("saludo", "Hola, ¿en qué te puedo ayudar?");
    },
  ]);
}

/** Se repite el mismo proveedor para todos los turnos de la conversacion. */
function proveedorParaLaCharla() {
  if (!CON_IA) return null;
  if (config.iaApiKey) {
    const { crearProveedorOpenAI } = require(path.join(RAIZ, "src", "ia", "proveedores", "openai"));
    return crearProveedorOpenAI({
      apiKey: config.iaApiKey,
      baseUrl: config.iaBaseUrl,
      modelo: config.iaModelo,
    });
  }
  // Cola infinita: el proveedor falso consume de una lista, asi que se le
  // dan muchas copias de la misma funcion.
  return crearProveedorFalso(Array.from({ length: 40 }, () => modeloSimulado().completar)).__esFalso
    ? null
    : (() => {
        const f = crearProveedorFalso([]);
        // Un proveedor que nunca se agota, con la misma logica.
        return {
          completar: async (entrada) => {
            const uno = modeloSimulado();
            return uno.completar(entrada);
          },
        };
      })();
}

async function abrirChat() {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-demo-")) });
  const cfg = {
    ...config,
    respuestaAutomatica: true,
    whatsappToken: "token-de-mentira",
    idNumero: "000",
    urlPublica: "https://pruebas.invalido",
  };

  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    fetchImpl: async (url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.D${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: crearCliente({ proveedor: proveedorParaLaCharla() }),
    emisor,
  });

  const telefono = "573001114455";

  const dice = async (texto) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.DEMO${++SEQ}_${process.pid}`,
      idCliente: telefono,
      telefono,
      nombre: null,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });

    const textos = salidas.filter((s) => s.type === "text").map((s) => s.text.body);
    const fotos = salidas.filter((s) => s.type === "image").length;

    // QUIEN REDACTO, que es la mitad de la informacion.
    const r = traza.respuesta || {};
    const bloqueos = (traza.bloqueos || []).map((b) => b.tipo);
    let quien;
    if (r.origen === "ia") {
      quien = "modelo";
    } else if (bloqueos.includes("cubierto_por_el_catalogo")) {
      quien = "codigo · el catálogo tiene la respuesta";
    } else if (bloqueos.includes("sin_borrador")) {
      // Sin modelo configurado no hay borrador que descartar: decir "la IA
      // se descartó" ahi es ruido que confunde al leer la transcripcion.
      quien = CON_IA ? "codigo · el modelo no dio borrador" : "codigo";
    } else if (bloqueos.length) {
      quien = `codigo · la IA se descartó: ${bloqueos.join(", ")}`;
    } else {
      quien = "codigo";
    }

    console.log(`\n  cliente ·  ${texto}`);
    const cuerpo = textos.join("\n") || "(no respondió)";
    console.log(`  NOVIKA  ·  ${cuerpo.replace(/\n/g, "\n             ")}`);
    if (fotos) console.log(`             (+ ${fotos} foto${fotos > 1 ? "s" : ""} reales del producto)`);
    console.log(`             └─ [${quien}]  situación: ${r.situacion || "?"}`);

    return { traza, texto: textos.join("\n"), fotos, repos };
  };

  return { dice, repos, telefono };
}

const titulo = (n, t) => {
  console.log(`\n\n${"█".repeat(74)}`);
  console.log(`  ${n} · ${t}`);
  console.log("█".repeat(74));
};

// ==========================================================================
(async () => {
  console.log(
    CON_IA
      ? config.iaApiKey
        ? `\n MODO: con modelo REAL (${config.iaModelo} en ${config.iaBaseUrl})`
        : "\n MODO: con modelo SIMULADO — no hay IA_API_KEY en este entorno.\n" +
          " Los borradores son escritos a mano con la forma que devuelve un LLM.\n" +
          " Sirve para ver el reparto y los filtros, NO para juzgar la prosa real."
      : "\n MODO: sin modelo. Solo el camino determinista."
  );

  // ----------------------------------------------------------------------
  titulo(1, "Cliente nuevo: precio, fotos, resuelve una duda y compra");
  {
    const c = await abrirChat();
    await c.dice("Hola, buenas tardes");
    await c.dice("¿cuánto vale el cinturón?");
    await c.dice("me mandas fotos?");
    await c.dice("¿tiene garantía?");
    await c.dice("listo, lo quiero");
    await c.dice("soy Luz Marina Ospina, Palmira, Calle 20 # 15-30");
    await c.dice("sí");

    const pedidos = await c.repos.pedidos.porContacto(c.telefono);
    console.log(`\n  » pedidos creados: ${pedidos.length}`);
    if (pedidos[0]) {
      const p = pedidos[0];
      console.log(`  » ${p.id} · ${p.estado} · ${p.cotizacion.cantidad} u · $${p.cotizacion.total.toLocaleString("es-CO")}`);
      console.log(`  » destino: ${p.destinatario.nombre} · ${p.destinatario.ciudad} · ${p.destinatario.direccion}`);
    }
  }

  // ----------------------------------------------------------------------
  titulo(2, "Con pedido confirmado pregunta «qué valen dos»");
  {
    const c = await abrirChat();
    await c.dice("quiero uno");
    await c.dice("soy Ana Restrepo, Cali, Carrera 7 # 12-34");
    await c.dice("sí");

    const antes = await c.repos.pedidos.porContacto(c.telefono);
    const idAntes = antes[0].id;
    const cantidadAntes = antes[0].cotizacion.cantidad;
    const totalAntes = antes[0].cotizacion.total;

    await c.dice("qué valen dos");
    await c.dice("y cuánto cuestan 2 con envío");

    const despues = await c.repos.pedidos.porContacto(c.telefono);
    const conv = await c.repos.conversaciones.obtener(c.telefono);
    console.log(`\n  » pedidos: ${antes.length} antes → ${despues.length} después`);
    console.log(
      `  » el pedido ${idAntes}: ${cantidadAntes} u / $${totalAntes.toLocaleString("es-CO")}` +
        ` → ${despues[0].cotizacion.cantidad} u / $${despues[0].cotizacion.total.toLocaleString("es-CO")}` +
        `  ${despues[0].id === idAntes && despues[0].cotizacion.cantidad === cantidadAntes ? "(INTACTO)" : "(CAMBIÓ)"}`
    );
    console.log(
      `  » cantidad en la ficha: ${JSON.stringify(campos.valorConfirmado(conv.ficha.cantidad))}` +
        "  (preguntar no debe fijarla en 2)"
    );
  }

  // ----------------------------------------------------------------------
  titulo(3, "Corrige la dirección: aplicada, visible para despacho y registrada");
  {
    const c = await abrirChat();
    await c.dice("quiero uno");
    await c.dice("soy Carolina Mejía, Pereira, Carrera 9 # 45-67");
    await c.dice("espera, la dirección es Avenida 30 de Agosto # 102-15");
    await c.dice("sí");

    const conv = await c.repos.conversaciones.obtener(c.telefono);
    const pedidos = await c.repos.pedidos.porContacto(c.telefono);

    console.log("\n  » DÓNDE QUEDÓ APLICADO");
    console.log(`     ficha de la conversación : ${campos.valorConfirmado(conv.ficha.direccion)}`);
    console.log(`     destinatario del pedido  : ${pedidos[0].destinatario.direccion}`);
    console.log(`     (es lo que lee quien despacha e imprime la guía)`);

    console.log("\n  » REGISTRO DE LA MODIFICACIÓN (historial del campo)");
    for (const h of conv.ficha.direccion.historial || []) {
      const detalle = h.porQue ? ` — ${h.porQue}` : h.valor ? ` — "${h.valor}"` : "";
      console.log(`     ${String(h.accion).padEnd(12)} ${String(h.origen || "").padEnd(8)}${detalle}`);
    }
    console.log(`\n  » pedidos creados: ${pedidos.length} (una corrección no debe crear otro)`);
  }

  // ----------------------------------------------------------------------
  titulo(4, "Pregunta algo sin dato confirmado: respuesta concreta + tarea");
  {
    const c = await abrirChat();
    await c.dice("hola, cuánto vale");
    await c.dice("oye y esto me lo puedo poner dormida toda la noche?");

    const conv = await c.repos.conversaciones.obtener(c.telefono);
    const p = atencion.pendienteDe(conv);
    console.log("\n  » LA TAREA QUE QUEDA");
    console.log(`     ¿hay?   : ${p.hay}`);
    console.log(`     motivo  : ${p.motivo}`);
    console.log(`     pregunta: «${p.pregunta}»`);
    console.log(`     desde   : ${p.desde}`);
    console.log(`     se cierra sola cuando una persona responde o la marca atendida`);

    // Y una pregunta de un dato que SÍ está declarado como no confirmado.
    await c.dice("de qué material es?");
    await c.dice("y cuánto cuestan tres?");
  }

  console.log("");
})().catch((e) => {
  console.error("REVENTÓ:", e.message);
  console.error(e.stack);
  process.exitCode = 1;
});
