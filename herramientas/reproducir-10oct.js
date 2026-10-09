"use strict";

// ==========================================================================
// REPRODUCIR LOS CHATS DEL 10-OCT
//
// Los ocho defectos que Marco reporto tras revisar las 15 conversaciones
// mas recientes del panel. Cada caso son los mensajes LITERALES del cliente,
// copiados del panel de produccion con sus erratas.
//
// A diferencia de `revivir.js`, esto no mide "¿acaba en pedido?" sino
// "¿que hace el bot en el turno exacto donde se rompio?", y ademas imprime
// la FICHA despues de cada turno: sin eso no se ve que el dato entro como
// candidato y nunca se confirmo.
//
//   node herramientas/reproducir-10oct.js
//   node herramientas/reproducir-10oct.js popayan
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
const campos = require(path.join(RAIZ, "src", "dominio", "campos"));

let SEQ = 0;

async function abrirChat(nombrePerfil) {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-10oct-")) });
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
    atencion,
    fetchImpl: async (_url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.X${salidas.length}` }] }) };
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
        wamid: `wamid.X${++SEQ}_${process.pid}`,
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
      const f = (conv && conv.ficha) || {};

      // La ficha en una linea: lo CONFIRMADO en mayuscula util, lo que solo
      // es candidato entre parentesis. Esa diferencia es el defecto 3.
      const resumen = ["nombre", "ciudad", "direccion", "cantidad"]
        .map((c) => {
          const conf = campos.valorConfirmado(f[c]);
          const cand = campos.valorCandidato(f[c]);
          if (conf) return `${c}=${conf}`;
          if (cand) return `${c}=(${cand})?`;
          return `${c}=–`;
        })
        .join("  ");

      console.log(`\n  cliente ·  ${JSON.stringify(texto)}`);
      console.log(`  NOVIKA  ·  ${dicho.join(" ⏎ ") || "⛔ SILENCIO"}`);
      if (fotos) console.log(`             (+ ${fotos} fotos)`);
      console.log(`  ficha   ·  ${resumen}   estado=${conv && conv.estado}`);
    },
  };
}

// --------------------------------------------------------------------------
const CASOS = {
  // DEFECTO 3: dio nombre + ciudad + barrio en UN mensaje de tres lineas.
  // El panel quedo con "Destinatario sin confirmar" y "Direccion — falta".
  popayan: {
    titulo: "Popayán · dio los tres datos en un mensaje y el bot no mostro resumen",
    perfil: "🤪",
    mensajes: [
      "Hola, quiero información sobre el cinturón térmico de $49.900.",
      "En qué ciudad",
      "Te encuentras",
      "Sólo necesito una unidad",
      "Alejandro león Garzón\nPopayán Cauca\nBarrio pueblillo en la cantera la pintada",
      "Si",
      "Claro",
    ],
  },

  // DEFECTO 1: el "si" tras la pregunta de cierre no se reconoce.
  santiago: {
    titulo: "Santiago · «Mándamelo» y «Envíamelo» no se leen como compra",
    perfil: "Santiago",
    mensajes: ["Hola, quiero información sobre el cinturón térmico de $49.900.", "Bogotá", "Mándamelo", "Envíamelo"],
  },

  jhon: {
    titulo: "Jhon Jaider · «Si claro por favor» repite el precio",
    perfil: "Jhon Jaider",
    mensajes: ["Hola, quiero información sobre el cinturón térmico de $49.900.", "Si claro por favor"],
  },

  precioso: {
    titulo: "Precioso · «Si Agame el favor» vuelve a preguntar",
    perfil: "Precioso",
    mensajes: ["Hola, quiero información sobre el cinturón térmico de $49.900.", "Si Agame el favor"],
  },

  // DEFECTO 2: tras la ciudad no pide los datos.
  duitama: {
    titulo: "Duitama · tras la ciudad la conversacion se muere",
    perfil: "Cliente Duitama",
    mensajes: ["Hola, quiero información sobre el cinturón térmico de $49.900.", "Duitama boyaca"],
  },

  // DEFECTO 4 y 5: funciones / como funciona.
  david: {
    titulo: "David · «Cómo funciona» repetido y «qué funciones trae»",
    perfil: "David",
    mensajes: [
      "Hola, quiero información sobre el cinturón térmico de $49.900.",
      "Cómo funciona",
      "Cómo funciona",
      "Ese que funciones trae",
    ],
  },

  // DEFECTO 7: ciudad fuera del listado.
  guacamayal: {
    titulo: "Guacamayal · corregimiento que no esta en el listado",
    perfil: "Cliente Magdalena",
    mensajes: ["Hola, quiero información sobre el cinturón térmico de $49.900.", "Ciénaga guacamayal"],
  },
};

async function correr(clave) {
  const caso = CASOS[clave];
  console.log(`\n${"=".repeat(74)}\n${caso.titulo}\n${"=".repeat(74)}`);
  const chat = await abrirChat(caso.perfil);
  for (const m of caso.mensajes) await chat.dice(m);
}

(async () => {
  const pedido = process.argv[2];
  const claves = pedido ? [pedido] : Object.keys(CASOS);
  for (const c of claves) {
    if (!CASOS[c]) {
      console.error(`No existe el caso "${c}". Hay: ${Object.keys(CASOS).join(", ")}`);
      process.exit(1);
    }
    await correr(c);
  }
  console.log("");
})();
