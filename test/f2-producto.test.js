"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Confundir el producto es la prioridad 6 de Marco, y en un catalogo
// multicategoria es el error mas facil de cometer.
//
// El incidente de BIKERPRO: en una conversacion sobre intercomunicadores el
// cliente pregunto "¿son impermeables?". "Impermeable" era el nombre del
// otro producto, el sistema leyo un cambio, congelo el nuevo, y el pedido se
// guardo con el producto equivocado al precio equivocado.
//
// En NOVIKA eso va a pasar MAS: "termico", "inalambrico", "portatil" son a
// la vez adjetivos y nombres de producto. La prueba de la falsa señal es la
// que protege de eso.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const senales = require("../src/catalogo/senales");

/** Catalogo en memoria con alias ya compilados. */
function catalogoDePrueba(productos) {
  const conAliases = productos.map((p) => ({
    ...p,
    activo: true,
    _aliases: (p.aliases || []).map((a) => ({ ...a, re: new RegExp(a.patron, "i") })),
  }));
  return {
    productos: conAliases,
    activos: conAliases,
    porId: new Map(conAliases.map((p) => [p.id, p])),
    productoPorDefecto: null,
  };
}

const CATALOGO = catalogoDePrueba([
  {
    id: "cinturon-termico",
    nombre: "Cinturón térmico",
    nombreCorto: "el cinturón",
    aliases: [
      { patron: "\\bcinturon(es)?\\s+termic", confianza: "alta", senal: "cinturon termico" },
      { patron: "\\b(para|contra)\\s+(los\\s+)?colicos\\b", confianza: "alta", senal: "para colicos" },
    ],
    anuncios: ["111222333"],
  },
  {
    id: "manta-termica",
    nombre: "Manta térmica",
    nombreCorto: "la manta",
    aliases: [{ patron: "\\bmanta(s)?\\s+termic", confianza: "alta", senal: "manta termica" }],
  },
  {
    id: "organizador-cocina",
    nombre: "Organizador de cocina",
    nombreCorto: "el organizador",
    aliases: [{ patron: "\\borganiza[dc]", confianza: "alta", senal: "organizador" }],
  },
]);

// --------------------------------------------------------------------------
// Identificacion
// --------------------------------------------------------------------------

test("sin ninguna señal el producto es DESCONOCIDO, no uno por defecto", () => {
  const r = senales.resolver({ texto: "hola buenas", catalogo: CATALOGO });
  assert.equal(r.productoId, null);
  assert.match(r.motivo, /hay que preguntar/);
});

test("un alias identifica el producto", () => {
  const r = senales.resolver({ texto: "cuanto vale el cinturon termico?", catalogo: CATALOGO });
  assert.equal(r.productoId, "cinturon-termico");
  assert.equal(r.origen, senales.ORIGENES.TEXTO_ACTUAL);
  assert.equal(r.confianza, "alta");
});

test("los alias por raiz absorben plurales y erratas", () => {
  for (const frase of ["el organizador", "los organizadores", "un organizacor de cocina"]) {
    const r = senales.resolver({ texto: frase, catalogo: CATALOGO });
    assert.equal(r.productoId, "organizador-cocina", `no reconocio: ${frase}`);
  }
});

test("dos productos en la misma frase NO se eligen: se pregunta", () => {
  const r = senales.resolver({ texto: "tienes el cinturon termico y la manta termica?", catalogo: CATALOGO });
  assert.equal(r.productoId, null);
  assert.equal(r.ambiguo, true);
  assert.equal(r.opciones.length, 2);
});

// --------------------------------------------------------------------------
// Contexto y persistencia
// --------------------------------------------------------------------------

test("el producto confirmado de la conversacion se mantiene sin señales nuevas", () => {
  // Imprescindible: el historial se rota, y el turno donde se nombro el
  // producto se cae de la ventana. Sin esto el bot olvida de que hablaban a
  // mitad de la venta.
  const r = senales.resolver({
    texto: "y cuanto demora en llegar?",
    conversacion: { productoId: "cinturon-termico" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, "cinturon-termico");
  assert.equal(r.origen, senales.ORIGENES.CONTEXTO);
});

test("una señal del turno actual manda sobre el contexto", () => {
  const r = senales.resolver({
    texto: "mejor quiero la manta termica",
    conversacion: { productoId: "cinturon-termico" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, "manta-termica");
  assert.equal(r.esCambio, true);
});

// --------------------------------------------------------------------------
// FALSA SEÑAL DE CAMBIO: el incidente de BIKERPRO
// --------------------------------------------------------------------------

test("una pregunta comparativa NO cambia el producto", () => {
  // "¿sirve para los colicos?" en una conversacion sobre la manta menciona
  // el alias del cinturon. Es una pregunta sobre lo que ya se esta viendo.
  const r = senales.resolver({
    texto: "y eso sirve para los colicos?",
    conversacion: { productoId: "manta-termica" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, "manta-termica", "una pregunta cambio el producto");
  assert.equal(r.esCambio, false);
  assert.match(r.motivo, /pregunta sobre el producto actual/);
});

test("varias formas de pregunta comparativa estan cubiertas", () => {
  for (const frase of [
    "funciona para los colicos?",
    "es igual que el cinturon termico?",
    "tambien sirve para colicos",
    "que diferencia hay con el cinturon termico",
    "viene con cinturon termico incluido?",
  ]) {
    const r = senales.resolver({
      texto: frase,
      conversacion: { productoId: "manta-termica" },
      catalogo: CATALOGO,
    });
    assert.equal(r.productoId, "manta-termica", `"${frase}" cambio el producto indebidamente`);
  }
});

test("un cambio EXPLICITO si cambia el producto, aunque la frase tambien compare", () => {
  // "mejor quiero" es inequivoco: pide el otro producto.
  const r = senales.resolver({
    texto: "y eso sirve igual? mejor quiero el cinturon termico",
    conversacion: { productoId: "manta-termica" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, "cinturon-termico");
  assert.equal(r.esCambio, true);
});

test("preguntar el precio de otro producto SI cuenta como cambio", () => {
  const r = senales.resolver({
    texto: "cuanto vale el cinturon termico?",
    conversacion: { productoId: "manta-termica" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, "cinturon-termico");
  assert.equal(r.esCambio, true);
});

// --------------------------------------------------------------------------
// Referral del anuncio
// --------------------------------------------------------------------------

test("el referral con productoId identifica con confianza alta", () => {
  const r = senales.resolver({
    texto: "hola",
    referral: { productoId: "cinturon-termico" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, "cinturon-termico");
  assert.equal(r.origen, senales.ORIGENES.REFERRAL);
  assert.equal(r.confianza, "alta");
});

test("el referral mapeado por id de anuncio identifica", () => {
  const r = senales.resolver({ texto: "hola", referral: { source_id: "111222333" }, catalogo: CATALOGO });
  assert.equal(r.productoId, "cinturon-termico");
});

test("el referral por texto del anuncio identifica con confianza media", () => {
  const r = senales.resolver({
    texto: "hola",
    referral: { headline: "Manta termica para el frio" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, "manta-termica");
  assert.equal(r.confianza, "media");
});

test("un anuncio que menciona dos productos no identifica ninguno", () => {
  const r = senales.resolver({
    texto: "hola",
    referral: { headline: "Cinturon termico y manta termica en oferta" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, null);
});

test("lo que dijo el cliente pesa mas que el anuncio por el que entro", () => {
  const r = senales.resolver({
    texto: "quiero el organizador de cocina",
    referral: { productoId: "cinturon-termico" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, "organizador-cocina");
});

// --------------------------------------------------------------------------
// Ventana reciente
// --------------------------------------------------------------------------

test("una señal en la ventana reciente rescata el producto", () => {
  const r = senales.resolver({
    texto: "y el envio?",
    catalogo: CATALOGO,
    ventana: [{ texto: "hola" }, { texto: "me interesa el organizador de cocina" }],
  });
  assert.equal(r.productoId, "organizador-cocina");
  assert.equal(r.origen, senales.ORIGENES.VENTANA);
  assert.equal(r.confianza, "media");
});

test("un producto que no existe en el catalogo no se arrastra del contexto", () => {
  const r = senales.resolver({
    texto: "y el envio?",
    conversacion: { productoId: "producto-que-ya-no-existe" },
    catalogo: CATALOGO,
  });
  assert.equal(r.productoId, null);
});

// --------------------------------------------------------------------------
// Detectores
// --------------------------------------------------------------------------

test("esGiroComparativo distingue preguntar de pedir", () => {
  assert.equal(senales.esGiroComparativo("sirve para la espalda?"), true);
  assert.equal(senales.esGiroComparativo("es igual que el otro"), true);
  assert.equal(senales.esGiroComparativo("quiero dos"), false);
});

test("pideOtroProducto exige un verbo de intencion", () => {
  assert.equal(senales.pideOtroProducto("quiero el otro"), true);
  assert.equal(senales.pideOtroProducto("cuanto vale"), true);
  assert.equal(senales.pideOtroProducto("que bonito"), false);
});
