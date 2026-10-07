"use strict";

// ==========================================================================
// LISTA BLANCA DE NUMEROS PARA PROBAR EN PRODUCCION
//
// --------------------------------------------------------------------------
// EL PROBLEMA QUE RESUELVE
// --------------------------------------------------------------------------
//
// Para probar el bot de punta a punta hay que encender
// RESPUESTA_AUTOMATICA. Pero ese interruptor no distingue: con el encendido,
// el bot le contesta a CUALQUIERA que escriba — un anuncio activo, un
// cliente viejo, alguien que vio el numero.
//
// Es decir: probar en produccion y abrir al publico eran la misma palanca.
//
// Y `filtro_de_numero`, que suena a esto, no lo es: compara el
// phone_number_id NUESTRO para que no entren eventos de otra app de Meta.
// No dice nada sobre que cliente escribe.
//
// Ahora son dos palancas, y el orden importa: se prueba con la lista
// puesta, y abrir al publico es BORRARLA.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");

const ayuda = require("./ayuda");

// La lista se lee al cargar config, asi que se fija ANTES de requerir src/.
const MI_NUMERO = "573058742138";
const dir = ayuda.entornoDePrueba({
  NUMEROS_DE_PRUEBA: MI_NUMERO,
  RESPUESTA_AUTOMATICA: "0",
  MODO_SOMBRA: "1",
});

const { config } = require("../src/config");

// Cerebro sustituido: ninguna prueba necesita IA ni red, y asi se puede
// contar exactamente cuantas veces se le pidio redactar.
const moduloCerebro = require("../src/cerebro");
let vecesQueSeLlamoAlCerebro = 0;
const cerebroFalso = {
  procesar: async () => {
    vecesQueSeLlamoAlCerebro++;
    return { enviada: false, estadoNuevo: "explorando", respuesta: { situacion: "saludo" }, pedido: null };
  },
};
let repos = null;
moduloCerebro.obtenerCerebro = async () => ({
  ...cerebroFalso,
  _piezas: () => ({ repos, catalogo: { activos: [] }, emisor: null }),
});

const procesar = require("../src/webhook/procesar");
const trabajo = require("../src/almacen/trabajo");
const atencion = require("../src/almacen/atencion");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearApp } = require("../src/app");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function entorno() {
  vecesQueSeLlamoAlCerebro = 0;
  trabajo._reiniciar();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "novika-lista-"));
  repos = await crearReposDeArchivos({ dir: d });
  return repos;
}

/** Manda un mensaje como si viniera de Meta, de principio a fin. */
async function escribe({ de, texto = "hola", wamid = `wamid.${Math.random()}` }) {
  const cuerpo = ayuda.payloadDeTexto({ wamid, texto, de });
  const admision = procesar.admitir(cuerpo, "prueba");
  const resultados = await procesar.procesarAdmitidos(admision.admitidos, "prueba");
  return { admision, resultados };
}

// ==========================================================================
// 1 · LA LISTA SE RESPETA
// ==========================================================================

describe("1 · con la lista puesta, solo mi numero recibe respuesta", () => {
  test("la lista se leyo de NUMEROS_DE_PRUEBA", () => {
    assert.deepEqual(config.numerosDePrueba, [MI_NUMERO]);
  });

  test("ESCENARIO: mi numero SI pasa al cerebro", async () => {
    await entorno();
    const { resultados } = await escribe({ de: MI_NUMERO });
    assert.equal(vecesQueSeLlamoAlCerebro, 1, "mi numero tiene que atenderse");
    assert.notEqual(resultados[0].accion, "fuera_de_la_lista_de_prueba");
    await repos.cerrar();
  });

  test("ESCENARIO: otro cliente NO pasa al cerebro", async () => {
    // Es el caso que importa: un cliente de verdad escribe durante la
    // prueba y el bot NO le habla.
    await entorno();
    const { resultados } = await escribe({ de: "573009998877", texto: "cuanto vale?" });
    assert.equal(vecesQueSeLlamoAlCerebro, 0, "el bot no puede redactarle nada");
    assert.equal(resultados[0].accion, "fuera_de_la_lista_de_prueba");
    assert.equal(resultados[0].respondido, false);
    await repos.cerrar();
  });

  test("pero su mensaje NO se pierde: queda en el diario", async () => {
    // Descartarlo seria perder una venta en silencio.
    await entorno();
    await escribe({ de: "573009998877", texto: "me interesa" });
    const diario = ayuda.leerDiario(dir);
    const fuera = diario.filter((e) => e.tipo === "fuera_de_la_lista_de_prueba");
    assert.equal(fuera.length >= 1, true, "no quedo registrado");
    assert.ok(diario.some((e) => e.tipo === "mensaje"), "el mensaje crudo tiene que estar igual");
    await repos.cerrar();
  });

  test("y aparece en el panel como PENDIENTE, para contestarle a mano", async () => {
    await entorno();
    await escribe({ de: "573009998877", texto: "me interesa el cinturon" });

    const conv = await repos.conversaciones.obtener("573009998877");
    assert.ok(conv, "no se guardo la conversacion");
    const mensajes = atencion.mensajes(conv);
    assert.equal(mensajes.length, 1);
    assert.equal(mensajes[0].de, atencion.QUIEN.CLIENTE);
    assert.equal(mensajes[0].texto, "me interesa el cinturon");

    const datos = require("../src/panel/datos");
    assert.equal(datos.clasificar(conv), datos.CLASES.PENDIENTE, "tiene que verse como pendiente");
    await repos.cerrar();
  });

  test("a Meta se le contesta 200 igual: no puede reintentar en bucle", async () => {
    // Un 4xx/5xx repetido acaba desactivando la suscripcion, y entonces se
    // pierden TODOS los mensajes, no uno.
    await entorno();
    const { admision } = await escribe({ de: "573009998877" });
    assert.equal(admision.durable, true);
    assert.equal(admision.mensajes, 1);
    await repos.cerrar();
  });

  test("el evento queda TERMINADO: no se acumula ni se reprocesa", async () => {
    await entorno();
    await escribe({ de: "573009998877", wamid: "wamid.FUERA.1" });
    const e = trabajo.estado();
    assert.equal(e.terminados, 1);
    assert.equal(e.reclamados, 0, "si quedara reclamado, se reprocesaria en cada arranque");
    await repos.cerrar();
  });
});

// ==========================================================================
// 2 · COMPARAR NUMEROS SIN TROPEZAR CON EL PREFIJO
// ==========================================================================

describe("2 · el prefijo no rompe la lista", () => {
  test("573001112233 y 3001112233 son el mismo numero", async () => {
    // WhatsApp entrega 573001112233 y en Render es facil escribir
    // 3001112233. Comparar por igualdad exacta haria que la lista no
    // funcionara por un prefijo, y eso se diagnostica muy mal: parece que
    // el bot esta roto.
    const { config: c } = require("../src/config");
    const guardado = c.numerosDePrueba;
    try {
      c.numerosDePrueba = ["3058742138"]; // sin el 57
      await entorno();
      await escribe({ de: MI_NUMERO }); // con el 57
      assert.equal(vecesQueSeLlamoAlCerebro, 1, "el prefijo no deberia importar");
      await repos.cerrar();
    } finally {
      c.numerosDePrueba = guardado;
    }
  });

  test("se aceptan varios numeros separados por coma, con espacios y '+'", () => {
    // Se prueba la normalizacion tal como la hace config, sin recargarlo.
    const normalizar = (t) =>
      String(t)
        .split(",")
        .map((n) => n.replace(/\D/g, ""))
        .filter(Boolean);
    assert.deepEqual(normalizar(" +57 300 111 2233 , 573058742138 "), ["573001112233", "573058742138"]);
    assert.deepEqual(normalizar(""), []);
    assert.deepEqual(normalizar("   "), []);
  });
});

// ==========================================================================
// 3 · SIN LISTA NO HAY RESTRICCION
// ==========================================================================

describe("3 · la lista vacia no restringe nada", () => {
  test("sin NUMEROS_DE_PRUEBA, cualquier cliente pasa al cerebro", async () => {
    // Es el comportamiento de produccion abierta. Borrar la lista ES abrir
    // al publico, y por eso tiene que ser una decision explicita.
    const { config: c } = require("../src/config");
    const guardado = c.numerosDePrueba;
    try {
      c.numerosDePrueba = [];
      await entorno();
      await escribe({ de: "573009998877" });
      assert.equal(vecesQueSeLlamoAlCerebro, 1);
      await repos.cerrar();
    } finally {
      c.numerosDePrueba = guardado;
    }
  });
});

// ==========================================================================
// 4 · SE VE DESDE FUERA
// ==========================================================================

describe("4 · /health dice si estamos probando o abiertos", () => {
  test("publica CUANTOS numeros hay, no cuales", async () => {
    // Un telefono es un dato de una persona y /health es publico. Pero el
    // numero de elementos es la diferencia entre "estamos probando" y
    // "estamos abiertos", y eso tiene que verse.
    const s = await ayuda.levantar(crearApp());
    try {
      const j = await (await fetch(`${s.url}/health`)).json();
      assert.equal(typeof j.numeros_de_prueba, "number");
      assert.equal(j.numeros_de_prueba, 1);
      const crudo = JSON.stringify(j);
      assert.ok(!crudo.includes(MI_NUMERO), "/health no puede publicar un telefono");
    } finally {
      await s.cerrar();
    }
  });

  test("y el interruptor del bot sigue aparte", async () => {
    const s = await ayuda.levantar(crearApp());
    try {
      const j = await (await fetch(`${s.url}/health`)).json();
      // Los dos tienen que verse: la lista no sirve de nada si el bot esta
      // apagado, y el bot abierto sin lista es atencion al publico.
      assert.equal(j.respuesta_automatica, false);
      assert.equal(j.numeros_de_prueba, 1);
    } finally {
      await s.cerrar();
    }
  });
});

module.exports = {};
