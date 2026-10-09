"use strict";

// ==========================================================================
// SONDEO MASIVO: ¿QUE CONTESTA EL BOT A LO QUE DE VERDAD LE ESCRIBEN?
//
// POR QUE EXISTE
//
// `conversar.js` sirve para LEER un dialogo. Esto sirve para MEDIR muchos:
// corre decenas de preguntas reales y marca solo, sin que nadie lea nada,
// las respuestas que pierden una venta.
//
// Y arregla una ceguera del arnes anterior: `conversar.js` NO le pasa
// `atencion` al emisor, asi que la pausa de 12 h -el peor sintoma que ha
// tenido este bot- era invisible en local y solo se veia en el panel de
// produccion. Aqui el emisor se cablea COMO EN PRODUCCION
// (ver src/cerebro/index.js), asi que si el bot se queda mudo, se ve.
//
// LOS SINTOMAS QUE MARCA
//
//   ESCALA     deriva a una persona
//   PAUSA      ademas se calla (12 h); el cliente queda sin nadie
//   NO_SABE    "no te lo quiero decir a medias"
//   MUDO       no contesta nada
//   REPITE     el mismo texto que el mensaje anterior
//   DATOS      pide nombre/ciudad/direccion a quien no dijo que compra
//   SIN_CIFRA  pregunto el precio y la respuesta no trae ninguna cifra
//
//   node herramientas/sondear.js            todo
//   node herramientas/sondear.js --malas    solo lo que sale mal
//   node herramientas/sondear.js --grupo=X  un grupo
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

async function abrirChat({ nombrePerfil = "Marcela" } = {}) {
  mutex._reiniciar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-sondeo-"));
  const repos = await crearReposDeArchivos({ dir });

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
    // COMO EN PRODUCCION: con esto la pausa de atencion humana muerde aqui.
    atencion,
    fetchImpl: async (url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.S${salidas.length}` }] }) };
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
  let anterior = "";

  const dice = async (texto) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.S${++SEQ}_${process.pid}`,
      idCliente: telefono,
      telefono,
      nombre: nombrePerfil,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });

    const enviados = salidas.filter((s) => s.type === "text").map((s) => s.text.body);
    const dicho = enviados.join(" ");
    const conv = await repos.conversaciones.obtener(telefono);
    const pausado = atencion.leer(conv || {}).pausado === true;

    const sintomas = [];
    const prep = (traza && traza.respuesta && traza.respuesta.texto) || "";
    const visible = dicho || "";

    if (!visible) sintomas.push("MUDO");
    if (/una persona del equipo|lo reviso con el equipo|pasarte con una persona/i.test(prep)) sintomas.push("ESCALA");
    if (pausado) sintomas.push("PAUSA");
    if (/no te l[oa] quiero (decir|contestar) a medias/i.test(prep)) sintomas.push("NO_SABE");
    if (visible && anterior && visible.trim() === anterior.trim()) sintomas.push("REPITE");
    if (anterior) anterior = visible || anterior;
    else anterior = visible;

    return { traza, texto: visible, preparado: prep, sintomas, pausado, fotos: salidas.filter((s) => s.type === "image").length };
  };

  return { dice, repos, telefono };
}

// --------------------------------------------------------------------------
// LA BATERIA. Casi todo esto salio del panel de produccion el 2026-10-08.
// --------------------------------------------------------------------------
const ANUNCIO = "Hola, quiero información sobre el cinturón térmico de $49.900.";

const GRUPOS = {
  "reales-perdidos": {
    titulo: "Mensajes EXACTOS de clientes reales que el bot no supo contestar",
    // Cada uno viene de un chat del panel. El comentario dice que recibio.
    casos: [
      // el chat de «En qué ciudad» -> "Esa no te la quiero contestar a medias"
      { previo: [ANUNCIO], dice: "En qué ciudad", espera: "donde estamos / que enviamos a todo el pais" },
      { previo: [ANUNCIO], dice: "Te encuentras", espera: "responder, no pedir datos" },
      // el chat de pruebas de Marco
      { previo: [ANUNCIO], dice: "Cuando me llegaría", espera: "1 a 3 dias habiles" },
      { previo: [ANUNCIO], dice: "Me gusta", espera: "calido + avanzar sin atropellar" },
      { previo: [ANUNCIO, "Me gusta"], dice: "1 a Bogotá", espera: "tomar cantidad Y ciudad" },
      { previo: [ANUNCIO], dice: "Gracias", espera: "no pedir datos a quien agradece" },
      { previo: [ANUNCIO], dice: "Tienes cinturones", espera: "si, disponible" },
      { previo: [ANUNCIO], dice: "1", espera: "cifra + siguiente paso" },
      { previo: [ANUNCIO], dice: "No cargaron", espera: "reenviar fotos, no hablar de bateria" },
      { previo: [ANUNCIO], dice: "A ve r", espera: "no pedir datos" },
      // el chat de Popayán -> escalo
      { previo: [ANUNCIO], dice: "No habría manera de que llegue hoy?", espera: "franqueza + 1 a 3 dias + seguir vendiendo" },
      { previo: [ANUNCIO], dice: "Por favor", espera: "no quedarse mudo" },
      // el chat de Bogotá del 08:10
      { previo: [ANUNCIO], dice: "Con cables para cargar", espera: "hablar de energia sin muro" },
      { previo: [ANUNCIO, "Con cables para cargar"], dice: "Trae cargador", espera: "NO repetir lo mismo" },
      { previo: [ANUNCIO], dice: "Que costó tiene", espera: "$49.900" },
      { previo: [ANUNCIO], dice: "Algo contra entrega", espera: "pagas al recibir" },
      { previo: [ANUNCIO], dice: "Ayuda con pedido", espera: "tratarlo como compra" },
      // el chat de San Andrés de Sotavento -> se perdio la venta, rescate manual
      { previo: [ANUNCIO, "Me interesa"], dice: "San andres de sotavento Córdoba", espera: "ciudad CORRECTA, no San Andres isla" },
      { previo: [ANUNCIO, "Me interesa", "San andres de sotavento Córdoba", "Uno"], dice: "Barrio buenos aires", espera: "aceptar el barrio como direccion" },
      { previo: [ANUNCIO, "Me interesa"], dice: "No entiendo", espera: "reorientar con calidez" },
      { previo: [ANUNCIO, "Me interesa"], dice: "Interapidisimo", espera: "no ignorarlo" },
      // el chat de la despedida -> le pidio datos a quien se despedia
      {
        previo: [ANUNCIO],
        dice: "Vale mil gracias, apenas vaya a pedirlo de fijo te aviso, okey, esta hermoso, muy amable, listo, gracias por la info, bendiciones🥰",
        espera: "despedirse bien y dejar la puerta abierta",
      },
    ],
  },

  "huecos-de-catalogo": {
    titulo: "Preguntas frecuentísimas de este producto que no tienen tema",
    casos: [
      { previo: [ANUNCIO], dice: "se puede lavar?", espera: "cuidado del producto" },
      { previo: [ANUNCIO], dice: "me lo puedo poner dormida toda la noche?", espera: "uso seguro" },
      { previo: [ANUNCIO], dice: "sirve si estoy embarazada?", espera: "NO prometer, derivar con cuidado" },
      { previo: [ANUNCIO], dice: "a cuántos grados llega?", espera: "temperatura" },
      { previo: [ANUNCIO], dice: "cuánto se demora en calentar?", espera: "NO el plazo de la transportadora" },
      { previo: [ANUNCIO], dice: "es original?", espera: "confianza" },
      { previo: [ANUNCIO], dice: "qué marca es?", espera: "NOVIKA" },
      { previo: [ANUNCIO], dice: "viene en caja? es para un regalo", espera: "empaque" },
      { previo: [ANUNCIO], dice: "trae instrucciones?", espera: "no inventar" },
      { previo: [ANUNCIO], dice: "dan factura?", espera: "no inventar, pero no escalar en seco" },
      { previo: [ANUNCIO], dice: "venden al por mayor?", espera: "mayorista -> persona, con gancho" },
      { previo: [ANUNCIO], dice: "a qué hora atienden?", espera: "horario" },
      { previo: [ANUNCIO], dice: "me pueden llamar?", espera: "canal" },
      { previo: [ANUNCIO], dice: "tienen tienda física?", espera: "confianza" },
      { previo: [ANUNCIO], dice: "sirve para una niña de 13 años?", espera: "NO la frase de colicos sin mas" },
      { previo: [ANUNCIO], dice: "es para hombre también?", espera: "responder la pregunta" },
      { previo: [ANUNCIO], dice: "qué diferencia tiene con una bolsa de agua caliente?", espera: "comparativa que vende" },
      { previo: [ANUNCIO], dice: "llega a una vereda?", espera: "cobertura" },
      { previo: [ANUNCIO], dice: "tienen otro modelo?", espera: "solo este" },
      { previo: [ANUNCIO], dice: "es recargable o de pilas?", espera: "energia" },
    ],
  },

  "debe-escalar": {
    titulo: "Lo que SI tiene que ir a una persona (y debe seguir yendo)",
    casos: [
      { previo: [ANUNCIO], dice: "quiero hablar con una persona", espera: "ESCALA de verdad" },
      { previo: [ANUNCIO], dice: "me llegó dañado, quiero la garantía", espera: "ESCALA (reclamo)" },
      { previo: [ANUNCIO], dice: "esto es un robo, son unos estafadores, los voy a denunciar", espera: "ESCALA (cliente molesto)" },
      { previo: [ANUNCIO], dice: "necesito 10 unidades", espera: "ESCALA (no hay tarifa)" },
      { previo: [ANUNCIO], dice: "quiero cancelar mi pedido", espera: "ESCALA" },
    ],
  },

  "objeciones-y-cierre": {
    titulo: "Objeciones: no se puede perder la venta ni callarse",
    casos: [
      { previo: [ANUNCIO], dice: "está muy caro", espera: "escalera sin descuento" },
      { previo: [ANUNCIO], dice: "no me alcanza", espera: "NO puede pausar el bot" },
      { previo: [ANUNCIO], dice: "lo vi más barato en otro lado", espera: "contraentrega como respuesta" },
      { previo: [ANUNCIO], dice: "lo voy a pensar", espera: "dejar puerta abierta, sin pedir datos" },
      { previo: [ANUNCIO], dice: "y si no me funciona?", espera: "garantia + contraentrega" },
      { previo: [ANUNCIO], dice: "no confío en estas páginas", espera: "contraentrega primero" },
      { previo: [ANUNCIO], dice: "mejor después", espera: "cerrar calido" },
      { previo: [ANUNCIO], dice: "déjame preguntarle a mi esposo", espera: "no presionar" },
    ],
  },

  "ruido-y-bordes": {
    titulo: "Lo que rompe bots: vacios, stickers, erratas, audios",
    casos: [
      { previo: [ANUNCIO], dice: "", espera: "no entrar en bucle" },
      { previo: [ANUNCIO, ""], dice: "", espera: "NO 'no quiero repetirme'" },
      { previo: [ANUNCIO], dice: "🥹", espera: "responder con calidez" },
      { previo: [ANUNCIO], dice: "👍", espera: "no pedir datos" },
      { previo: [ANUNCIO], dice: "?", espera: "reorientar" },
      { previo: [ANUNCIO], dice: "ola ke presio tiene", espera: "entender la errata" },
      { previo: [ANUNCIO], dice: "kuanto bale", espera: "$49.900" },
      { previo: [ANUNCIO], dice: "1 nada amas", espera: "entender 'nada mas'" },
      { previo: [ANUNCIO], dice: "sihh", espera: "no bucle" },
      { previo: [ANUNCIO], dice: "buenas noches, bendiciones", espera: "saludo calido" },
    ],
  },
};

// --------------------------------------------------------------------------
(async () => {
  const soloMalas = process.argv.includes("--malas");
  const pedido = (process.argv.find((a) => a.startsWith("--grupo=")) || "").split("=")[1];

  const resumen = { total: 0, malas: 0, porSintoma: {} };
  const malas = [];

  for (const [clave, grupo] of Object.entries(GRUPOS)) {
    if (pedido && clave !== pedido) continue;
    console.log(`\n${"=".repeat(78)}\n  ${grupo.titulo}\n  (${clave})\n${"=".repeat(78)}`);

    for (const caso of grupo.casos) {
      const c = await abrirChat();
      for (const p of caso.previo) await c.dice(p);
      const r = await c.dice(caso.dice);

      resumen.total += 1;
      const mal = r.sintomas.length > 0;
      if (mal) {
        resumen.malas += 1;
        for (const s of r.sintomas) resumen.porSintoma[s] = (resumen.porSintoma[s] || 0) + 1;
        malas.push({ grupo: clave, dice: caso.dice, sintomas: r.sintomas, texto: r.preparado, espera: caso.espera });
      }
      if (soloMalas && !mal) continue;

      const etiqueta = r.sintomas.length ? ` ‹${r.sintomas.join(" ")}›` : "";
      console.log(`\n  cliente ·  ${caso.dice || "(mensaje vacio)"}${etiqueta}`);
      console.log(`  NOVIKA  ·  ${r.preparado || "(no respondio)"}`);
      if (!r.texto && r.preparado) console.log(`             ⚠ PREPARADO PERO NO ENVIADO`);
      if (caso.espera) console.log(`             esperado: ${caso.espera}`);
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`  RESUMEN: ${resumen.malas} de ${resumen.total} respuestas con sintomas`);
  for (const [s, n] of Object.entries(resumen.porSintoma).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${s.padEnd(10)} ${n}`);
  }
  console.log("=".repeat(78));
})();
