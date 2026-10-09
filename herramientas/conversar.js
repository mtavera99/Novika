"use strict";

// ==========================================================================
// VER LA CONVERSACION COMO LA VE EL CLIENTE
//
// POR QUE EXISTE
//
// "Pasan 800 pruebas" no demuestra que el bot venda bien. Las pruebas
// comprueban afirmaciones sueltas -que aparezca un precio, que no aparezca
// una promesa- y una conversacion puede cumplirlas TODAS y seguir siendo
// insufrible de leer.
//
// Los tres peores defectos que ha tenido este bot se vieron leyendo el
// dialogo entero, no en una prueba:
//
//   · el estribillo repetido palabra por palabra en dos mensajes seguidos
//   · el "¡Perfecto, gracias!" a quien no habia dado ningun dato
//   · la direccion que se tiraba por venir con el telefono al lado
//
// Esto corre la conversacion contra el cerebro de verdad -con su almacen,
// su cotizador y su catalogo- SIN red y SIN WhatsApp: el emisor se
// sustituye, asi que no sale ni un mensaje real.
//
//   node herramientas/conversar.js            todos los escenarios
//   node herramientas/conversar.js palmira    uno solo, por nombre
//   node herramientas/conversar.js --lista    los nombres disponibles
// ==========================================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RAIZ = path.join(__dirname, "..");

// El entorno de prueba: sin esto, config exige las credenciales de verdad.
require(path.join(RAIZ, "test", "ayuda")).entornoDePrueba();

const { config } = require(path.join(RAIZ, "src", "config"));
const { crearCerebro } = require(path.join(RAIZ, "src", "cerebro", "orquestar"));
const { crearReposDeArchivos } = require(path.join(RAIZ, "src", "almacen", "repos", "archivos"));
const { crearCliente } = require(path.join(RAIZ, "src", "ia", "cliente"));
const { crearEmisor } = require(path.join(RAIZ, "src", "whatsapp", "enviar"));
const { cargarCatalogo } = require(path.join(RAIZ, "src", "catalogo"));
const mutex = require(path.join(RAIZ, "src", "almacen", "mutex"));

let SEQ = 0;

/**
 * Abre una conversacion aislada.
 *
 * @param {object} opc
 * @param {string|null} opc.nombrePerfil  Lo que trae el perfil de WhatsApp.
 * @param {object|null} opc.ia            Proveedor de IA; null = sin modelo.
 */
async function abrirChat({ nombrePerfil = null, ia = null } = {}) {
  mutex._reiniciar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-conversar-"));
  const repos = await crearReposDeArchivos({ dir });

  const cfg = {
    ...config,
    respuestaAutomatica: true,
    whatsappToken: "token-de-mentira",
    idNumero: "000",
    urlPublica: "https://no-existe.invalido",
  };

  // El emisor no habla con WhatsApp: recoge lo que se habria enviado.
  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    fetchImpl: async (url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: `wamid.H${salidas.length}` }] }),
      };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: ia || crearCliente({ proveedor: null }),
    emisor,
  });

  const telefono = "573001112233";

  const dice = async (texto) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.H${++SEQ}_${process.pid}`,
      idCliente: telefono,
      telefono,
      nombre: nombrePerfil,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });

    const textos = salidas.filter((s) => s.type === "text").map((s) => s.text.body);
    const fotos = salidas.filter((s) => s.type === "image").length;

    console.log(`\n  cliente ·  ${texto}`);
    const respuesta = textos.join("\n             ") || "(no respondio)";
    console.log(`  NOVIKA  ·  ${respuesta.replace(/\n/g, "\n             ")}`);
    if (fotos) console.log(`             (+ ${fotos} foto${fotos > 1 ? "s" : ""})`);

    const etiquetas = [];
    if (traza && traza.situacion) etiquetas.push(traza.situacion);
    if (traza && traza.origenTexto) etiquetas.push(`redacta:${traza.origenTexto}`);
    if (traza && traza.datosAportados && traza.datosAportados.length) {
      etiquetas.push(`aporto:${traza.datosAportados.join("+")}`);
    }
    if (etiquetas.length) console.log(`             ‹${etiquetas.join(" · ")}›`);

    return { traza, texto: textos.join("\n"), fotos, repos };
  };

  return { dice, repos, telefono };
}

/** Cuenta los pedidos creados, para comprobar que no se crean de mas. */
async function pedidosDe(repos) {
  if (!repos.pedidos || !repos.pedidos.listar) return null;
  try {
    const lista = await repos.pedidos.listar({ limite: 100 });
    return Array.isArray(lista) ? lista : lista && lista.filas ? lista.filas : [];
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// LOS ESCENARIOS
// --------------------------------------------------------------------------
const ESCENARIOS = {
  saludo: {
    titulo: "Un «hola» pelado",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("Hola");
    },
  },

  "precio-con-envio": {
    titulo: "«Quiero un cinturón. ¿Cuánto vale con envío?»",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("Quiero un cinturón. ¿Cuánto vale con envío?");
    },
  },

  esmeralda: {
    titulo: "LA VENTA PERDIDA DEL 08-OCT 08:10 — los mensajes exactos de la clienta",
    correr: async () => {
      // Capturado del panel de produccion. Marco: "un cliente escribio hace
      // media hora y el bot no cerro venta".
      //
      // Lo que recibio de verdad, por si se vuelve a romper:
      //   "Con cables para cargar" -> le explico para que sirve el producto
      //   "Trae cargador"          -> le pidio los datos
      //   "Algo contra entrega"    -> "el precio no te lo quiero decir a medias"
      //   "Que costó tiene"        -> "esa no te la quiero contestar"
      //   "Solo 1"                 -> "¡Perfecto, gracias!" y ahi se murio
      //   "Ayuda con pedido"       -> le explico para que sirve, otra vez
      const c = await abrirChat();
      for (const m of [
        "Hola, quiero información sobre el cinturón térmico de $49.900.",
        "Con cables para cargar",
        "Trae cargador",
        "Para Bogotá",
        "Y Bogotá cuanto se demora",
        "Algo contra entrega",
        "Que costó tiene",
        "Solo 1",
        "Ayuda con pedido",
      ]) {
        await c.dice(m);
      }
    },
  },

  caro: {
    titulo: "«Está muy caro» — la escalera, y que NUNCA salga un descuento",
    correr: async () => {
      // Las cuatro formas que mas llegan, cada una en un chat nuevo: lo que
      // se mira aqui es que ninguna reciba una cifra inventada ni una
      // rebaja, y que la respuesta siga vendiendo en vez de disculparse.
      for (const frase of ["Está muy caro", "hay descuento?", "no me alcanza", "me lo dejas más barato?"]) {
        const c = await abrirChat();
        await c.dice(frase);
      }
    },
  },

  "caro-insistiendo": {
    titulo: "Objeta el precio DOS veces seguidas: no puede aparecer una rebaja",
    correr: async () => {
      // El momento en que el bot de BIKERPRO se invento un precio con pago
      // anticipado. Aqui el final de la escalera es una persona, no una
      // cifra: si en el segundo o tercer turno sale un importe nuevo o un
      // descuento, esto lo deja a la vista.
      const c = await abrirChat();
      await c.dice("¿cuánto vale?");
      await c.dice("uy, está muy caro");
      await c.dice("no me lo puedes dejar más barato?");
      await c.dice("y si llevo dos?");
    },
  },

  dos: {
    titulo: "Las variantes de preguntar por DOS",
    correr: async () => {
      for (const frase of ["Qué valen dos", "cuánto cuestan 2", "Que valen dos unidades?", "y las dos"]) {
        const c = await abrirChat();
        await c.dice(frase);
      }
    },
  },

  "dos-tras-confirmar": {
    titulo: "EL CASO DE LA CAPTURA: preguntar precios con un pedido YA confirmado",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("Quiero uno");
      await c.dice("soy Luz Marina, Palmira, Calle 20 # 15-30");
      await c.dice("sí");
      // A partir de aqui el pedido esta confirmado.
      await c.dice("Qué precio tiene el envío");
      await c.dice("Que valen dos?");
      await c.dice("Que valen dos unidades?");
      await c.dice("Quiero saber cuánto valen dos unidades");
      const pedidos = await pedidosDe(c.repos);
      if (pedidos) console.log(`\n  » pedidos en el almacen: ${pedidos.length} (debe seguir siendo 1)`);
    },
  },

  "repregunta": {
    titulo: "Repregunta porque la primera respuesta no resolvio",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("cuánto vale");
      await c.dice("cuánto vale?");
      await c.dice("pero cuánto vale con el envío");
    },
  },

  "las-quiero": {
    titulo: "«Las quiero» despues de consultar dos unidades",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("cuánto cuestan dos");
      await c.dice("Las quiero");
    },
  },

  dudas: {
    titulo: "Garantia, ajuste, entrega y confianza",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("tiene garantía?");
      await c.dice("¿me sirve a mí? uso talla XL");
      await c.dice("cuánto tarda en llegar a Palmira");
      await c.dice("esto es real o es estafa?");
    },
  },

  direccion: {
    titulo: "Direcciones con numeros, sin confundirlos con cantidad",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("Lo quiero");
      await c.dice("Calle 45 # 23-10, Palmira, mi celular es 3058742138");
      await c.dice("soy Luz Marina");
    },
  },

  "corregir-direccion": {
    titulo: "Corregir la direccion antes de confirmar",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("quiero uno");
      await c.dice("soy Ana, Cali, Carrera 7 # 12-34");
      await c.dice("espera, la dirección es Carrera 9 # 45-67");
      await c.dice("sí");
      const pedidos = await pedidosDe(c.repos);
      if (pedidos) console.log(`\n  » pedidos en el almacen: ${pedidos.length}`);
    },
  },

  "doble-confirmacion": {
    titulo: "Doble «sí»: no debe crear dos pedidos",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("quiero uno");
      await c.dice("soy Ana, Cali, Carrera 7 # 12-34");
      await c.dice("sí");
      await c.dice("sí");
      const pedidos = await pedidosDe(c.repos);
      if (pedidos) console.log(`\n  » pedidos en el almacen: ${pedidos.length} (debe ser 1)`);
    },
  },

  "otra-compra": {
    titulo: "Pide OTRA compra teniendo un pedido confirmado",
    correr: async () => {
      const c = await abrirChat();
      await c.dice("quiero uno");
      await c.dice("soy Ana, Cali, Carrera 7 # 12-34");
      await c.dice("sí");
      await c.dice("quiero pedir otro más");
      const pedidos = await pedidosDe(c.repos);
      if (pedidos) console.log(`\n  » pedidos en el almacen: ${pedidos.length}`);
    },
  },

  // ========================================================================
  // LAS CUATRO DE ABAJO SON DEL 2026-10-09 Y SON PARA LEERLAS COMPLETAS.
  //
  // El resto de los escenarios comprueba momentos sueltos. Estos cuatro son
  // conversaciones de principio a fin, del tipo que de verdad entra por el
  // anuncio, y existen para contestar la pregunta que ninguna prueba
  // contesta: ¿esto se lee como una persona que vende, o como un formulario
  // con emojis?
  //
  // Marco lo dijo asi: "muy seco, sin emojis y muy tipo robot". Esa clase de
  // defecto no lo caza una assertion; se ve leyendo.
  // ========================================================================

  "duda-y-cierra": {
    titulo: "LA CLIENTA QUE PREGUNTA TODO ANTES DE COMPRAR — y acaba comprando",
    correr: async () => {
      // El perfil mas comun del anuncio: no pregunta el precio primero,
      // pregunta si le va a servir. Cada respuesta tiene que dejarla un paso
      // mas cerca sin empujarla.
      const c = await abrirChat({ nombrePerfil: "Daniela" });
      for (const m of [
        "Hola, quiero información sobre el cinturón térmico de $49.900.",
        "sirve para los cólicos?",
        "y me sirve a mi? soy gordita",
        "se puede lavar?",
        "me lo puedo dejar puesto dormida?",
        "tiene garantía?",
        "y si no me funciona?",
        "listo, lo quiero",
        "Daniela Sarmiento",
        "Medellín, Carrera 70 # 45-12",
        "si",
      ]) {
        await c.dice(m);
      }
    },
  },

  "desconfia-y-cierra": {
    titulo: "LA QUE NO CONFIA — el contraentrega es todo el argumento",
    correr: async () => {
      const c = await abrirChat({ nombrePerfil: "Yuli" });
      for (const m of [
        "Hola, quiero información sobre el cinturón térmico de $49.900.",
        "no confío en estas páginas",
        "ya me estafaron una vez",
        "es original?",
        "tienen tienda física?",
        "en qué ciudad están",
        "y si no me llega?",
        "bueno, dale",
        "Yulieth Carmona, Pereira, barrio Cuba, casa esquinera blanca",
        "si",
      ]) {
        await c.dice(m);
      }
    },
  },

  "pueblo-sin-nomenclatura": {
    titulo: "EL CLIENTE DE PUEBLO — sin calle ni numero, y hay que poder venderle",
    correr: async () => {
      // La venta que se perdio el 08-oct. En media Colombia la direccion es
      // el barrio mas un punto de referencia.
      const c = await abrirChat({ nombrePerfil: "Mauricio" });
      for (const m of [
        "Hola, quiero información sobre el cinturón térmico de $49.900.",
        "llega a un corregimiento?",
        "cuanto se demora",
        "me interesa",
        "San andres de sotavento Córdoba",
        "uno",
        "Barrio buenos aires",
        "Mauricio Benítez",
        "si",
      ]) {
        await c.dice(m);
      }
    },
  },

  "regatea-y-cierra": {
    titulo: "LA QUE REGATEA TRES VECES — la escalera, y que el bot siga vivo",
    correr: async () => {
      const c = await abrirChat({ nombrePerfil: "Marcela" });
      for (const m of [
        "Hola, quiero información sobre el cinturón térmico de $49.900.",
        "uy está muy caro",
        "no me alcanza",
        "me lo dejas en 40?",
        "y si llevo dos?",
        "las quiero",
        "Marcela Rios, Cali, Calle 9 # 30-15",
        "si",
      ]) {
        await c.dice(m);
      }
    },
  },

  "falla-el-modelo": {
    titulo: "El modelo falla: la respuesta de respaldo",
    correr: async () => {
      // Un proveedor que siempre revienta.
      const roto = {
        nombre: "roto",
        disponible: () => true,
        async analizar() { throw new Error("502 del proveedor"); },
        async redactar() { throw new Error("502 del proveedor"); },
      };
      const c = await abrirChat({ ia: roto });
      await c.dice("Hola");
      await c.dice("cuánto vale");
      await c.dice("oye y esto me lo puedo poner dormida toda la noche?");
    },
  },
};

// --------------------------------------------------------------------------
(async () => {
  const pedido = process.argv[2];

  if (pedido === "--lista") {
    for (const [nombre, e] of Object.entries(ESCENARIOS)) console.log(`${nombre.padEnd(22)} ${e.titulo}`);
    return;
  }

  const aCorrer = pedido
    ? Object.entries(ESCENARIOS).filter(([n]) => n === pedido)
    : Object.entries(ESCENARIOS);

  if (!aCorrer.length) {
    console.error(`No existe el escenario "${pedido}". Prueba --lista.`);
    process.exitCode = 1;
    return;
  }

  for (const [nombre, e] of aCorrer) {
    console.log(`\n${"=".repeat(78)}`);
    console.log(`  ${e.titulo}`);
    console.log(`  (${nombre})`);
    console.log("=".repeat(78));
    await e.correr();
  }
  console.log("");
})();
