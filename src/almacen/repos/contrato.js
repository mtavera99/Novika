"use strict";

// ==========================================================================
// CONTRATO DE LOS REPOSITORIOS
//
// Este archivo define QUE tiene que saber hacer el almacenamiento, sin decir
// como. Hay dos implementaciones previstas:
//
//   archivos/   la de hoy, sobre el disco persistente de Render
//   postgres/   la de manana, cuando Marco cree la base
//
// Y una sola forma de aceptar la segunda: PASAR LAS MISMAS PRUEBAS. Las
// pruebas de contrato viven aqui mismo (pruebasDeContrato) y se ejecutan
// contra cualquier implementacion. Migrar deja de ser "esperemos que
// funcione" y pasa a ser "la bateria esta verde o no lo esta".
//
// --------------------------------------------------------------------------
// LA PARTE QUE IMPORTA: crearPedidoSiNoExiste
// --------------------------------------------------------------------------
//
// No es un `guardar`. Es una operacion que CREA O NO CREA, y lo dice. Toda
// la idempotencia transaccional del sistema cuelga de que esta operacion sea
// atomica, porque hay dos duplicados distintos que hay que frenar:
//
//   claveDeEvento  -> Meta retransmite el mismo evento (mismo wamid).
//   claveDeOferta  -> el cliente escribe "si" dos veces (wamid distinto,
//                     misma oferta).
//
// Con una sola clave se escapa uno de los dos. En archivos la atomicidad la
// da la cola por conversacion mas un indice append-only; en PostgreSQL la
// daran dos restricciones UNIQUE, que es la version que de verdad no se
// puede saltar.
// ==========================================================================

/** Firma esperada de un repositorio completo. */
const METODOS = {
  contactos: ["obtener", "guardar"],
  conversaciones: ["obtener", "guardar", "listar"],
  pedidos: [
    "crearSiNoExiste",
    "obtener",
    "reemplazar",
    "porContacto",
    "activoDeContacto",
    "porClaveDeEvento",
    // Para el panel. Siempre con tope: una pantalla no puede pedir "todo".
    "listar",
  ],
  // Operaciones transversales
  raiz: ["cerrar", "estado"],
};

/** Comprueba que una implementacion tenga la forma del contrato. */
function revisarForma(repos) {
  const faltan = [];
  for (const [grupo, metodos] of Object.entries(METODOS)) {
    if (grupo === "raiz") {
      for (const m of metodos) {
        if (typeof repos?.[m] !== "function") faltan.push(m);
      }
      continue;
    }
    for (const m of metodos) {
      if (typeof repos?.[grupo]?.[m] !== "function") faltan.push(`${grupo}.${m}`);
    }
  }
  return { ok: faltan.length === 0, faltan };
}

const MOTIVOS_NO_CREADO = {
  EVENTO_REPETIDO: "evento_repetido",   // retransmision del webhook
  OFERTA_YA_TIENE_PEDIDO: "oferta_ya_tiene_pedido", // "si" repetido
};

/**
 * Bateria de contrato. Cualquier implementacion tiene que pasarla igual.
 *
 * Se recibe `test` y `assert` por parametro para no acoplar este modulo al
 * ejecutor de pruebas.
 *
 * @param {object} arg
 * @param {string} arg.nombre          como se llama la implementacion
 * @param {() => Promise<object>} arg.crear  devuelve repos recien creados y vacios
 * @param {Function} arg.test
 * @param {object} arg.assert
 */
function pruebasDeContrato({ nombre, crear, test, assert }) {
  const pedidoDeEjemplo = (sobre = {}) => ({
    id: sobre.id || `NOV-PRUEBA-${Math.random().toString(36).slice(2, 8)}`,
    version: 1,
    estado: "confirmado",
    claveDeEvento: sobre.claveDeEvento || "evento-aaa",
    claveDeOferta: sobre.claveDeOferta || "oferta-aaa",
    contactoId: sobre.contactoId || "573001112233",
    conversacionId: sobre.conversacionId || "conv-1",
    ofertaId: sobre.ofertaId || "of-1",
    wamidConfirmacion: sobre.wamidConfirmacion || "wamid.CONF1",
    producto: { id: "producto-x", nombre: "Producto X", variante: null },
    cantidad: 1,
    destinatario: {
      nombre: "Nombre Apellido",
      telefono: "3001112233",
      ciudad: "Medellín",
      direccion: "Calle 1 # 2-3",
    },
    cotizacion: { total: 1000, moneda: "COP", cantidad: 1, productoId: "producto-x" },
    historial: [],
    creadoEn: new Date().toISOString(),
    actualizadoEn: new Date().toISOString(),
    ...sobre,
  });

  // --------------------------------------------------------------------
  // Contactos y conversaciones
  // --------------------------------------------------------------------

  test(`[${nombre}] un contacto que no existe se devuelve como null, no se inventa`, async () => {
    const repos = await crear();
    try {
      assert.equal(await repos.contactos.obtener("no-existe"), null);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] un contacto guardado se recupera igual`, async () => {
    const repos = await crear();
    try {
      await repos.contactos.guardar({ id: "c1", nombre: "Ana", telefono: "3001112233" });
      const leido = await repos.contactos.obtener("c1");
      assert.equal(leido.nombre, "Ana");
      assert.equal(leido.telefono, "3001112233");
    } finally {
      await repos.cerrar();
    }
  });

  // --------------------------------------------------------------------------
  // ORDEN ESTABLE, Y LOS DOS BACKENDS IGUAL
  //
  // `listar` ordenaba por fecha sin desempate. Con LIMIT -y lo hay- eso
  // significa que una conversacion empatada en la frontera del limite puede
  // aparecer dos veces o NINGUNA, y el panel pagina sobre esa lista.
  //
  // Los empates no son raros: varios mensajes del mismo lote de webhook se
  // guardan en el mismo instante.
  //
  // Se prueba en el CONTRATO para que los dos backends lo garanticen igual:
  // con archivos salia estable por casualidad -el sort de JS lo es- y una
  // casualidad no es una garantia.
  // --------------------------------------------------------------------------
  test(`[${nombre}] listar conversaciones tiene un orden estable con empates`, async () => {
    const repos = await crear();
    try {
      const mismoInstante = "2026-10-08T00:00:00.000Z";
      const ids = [];
      for (let i = 0; i < 12; i++) {
        const id = `5730${String(i).padStart(7, "0")}`;
        ids.push(id);
        await repos.contactos.guardar({ id, telefono: id });
        await repos.conversaciones.guardar({
          contactoId: id,
          estado: "captura",
          ficha: {},
          mensajes: [],
          actualizadoEn: mismoInstante,
        });
      }

      // Tres lecturas seguidas: el orden tiene que ser el mismo.
      const una = (await repos.conversaciones.listar({ limite: 50 })).map((c) => c.contactoId);
      const dos = (await repos.conversaciones.listar({ limite: 50 })).map((c) => c.contactoId);
      const tres = (await repos.conversaciones.listar({ limite: 50 })).map((c) => c.contactoId);
      assert.deepEqual(una, dos, "dos lecturas devolvieron los empates en orden distinto");
      assert.deepEqual(dos, tres, "el orden cambia entre lecturas");

      // Y con LIMIT, la primera pagina tiene que ser un prefijo del total:
      // es lo que hace que paginar no pierda ni repita filas.
      const cortada = (await repos.conversaciones.listar({ limite: 5 })).map((c) => c.contactoId);
      assert.deepEqual(cortada, una.slice(0, 5), "con LIMIT se devuelven filas distintas de las primeras");
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] una conversacion sobrevive a reabrir el almacen`, async () => {
    const repos = await crear();
    try {
      await repos.conversaciones.guardar({ contactoId: "c1", estado: "cotizado", ofertaId: "of-9" });
      const otra = await repos.reabrir();
      const leida = await otra.conversaciones.obtener("c1");
      assert.equal(leida.estado, "cotizado");
      assert.equal(leida.ofertaId, "of-9");
    } finally {
      await repos.cerrar();
    }
  });

  // --------------------------------------------------------------------
  // Idempotencia de pedidos: el nucleo del contrato
  // --------------------------------------------------------------------

  test(`[${nombre}] un pedido nuevo se crea`, async () => {
    const repos = await crear();
    try {
      const r = await repos.pedidos.crearSiNoExiste(pedidoDeEjemplo());
      assert.equal(r.creado, true);
      assert.ok(r.pedido.id);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] la retransmision del webhook NO crea un segundo pedido`, async () => {
    const repos = await crear();
    try {
      const primero = pedidoDeEjemplo({ claveDeEvento: "ev-1", claveDeOferta: "of-1" });
      const a = await repos.pedidos.crearSiNoExiste(primero);
      assert.equal(a.creado, true);

      // Mismo evento, id de pedido distinto: es el mismo mensaje otra vez.
      const b = await repos.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ id: "NOV-OTRO", claveDeEvento: "ev-1", claveDeOferta: "of-1" })
      );
      assert.equal(b.creado, false);
      assert.equal(b.motivo, MOTIVOS_NO_CREADO.EVENTO_REPETIDO);
      // Y devuelve el pedido original, para poder responder con el de verdad.
      assert.equal(b.pedido.id, a.pedido.id);

      const todos = await repos.pedidos.porContacto(primero.contactoId);
      assert.equal(todos.length, 1);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] un "si" repetido (otro wamid, misma oferta) NO crea un segundo pedido`, async () => {
    const repos = await crear();
    try {
      const a = await repos.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ claveDeEvento: "ev-1", claveDeOferta: "of-compartida" })
      );
      assert.equal(a.creado, true);

      const b = await repos.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ id: "NOV-OTRO", claveDeEvento: "ev-2", claveDeOferta: "of-compartida" })
      );
      assert.equal(b.creado, false);
      assert.equal(b.motivo, MOTIVOS_NO_CREADO.OFERTA_YA_TIENE_PEDIDO);
      assert.equal(b.pedido.id, a.pedido.id);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] una oferta NUEVA del mismo contacto si puede crear otro pedido`, async () => {
    const repos = await crear();
    try {
      // Compra legitima repetida: el cliente vuelve y pide otra cosa.
      await repos.pedidos.crearSiNoExiste(pedidoDeEjemplo({ claveDeEvento: "ev-1", claveDeOferta: "of-1" }));
      const b = await repos.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ id: "NOV-DOS", claveDeEvento: "ev-2", claveDeOferta: "of-2" })
      );
      assert.equal(b.creado, true);
      const todos = await repos.pedidos.porContacto("573001112233");
      assert.equal(todos.length, 2);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] la idempotencia sobrevive a reabrir el almacen`, async () => {
    const repos = await crear();
    try {
      await repos.pedidos.crearSiNoExiste(pedidoDeEjemplo({ claveDeEvento: "ev-persiste", claveDeOferta: "of-p" }));

      // Simula el reinicio del proceso: el reintento de Meta puede llegar
      // hasta 36 horas despues, con un despliegue en medio.
      const otra = await repos.reabrir();
      const b = await otra.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ id: "NOV-TRAS-REINICIO", claveDeEvento: "ev-persiste", claveDeOferta: "of-p" })
      );
      assert.equal(b.creado, false, "tras reiniciar, el duplicado se colo");
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] N creaciones simultaneas de la misma oferta dejan UN pedido`, async () => {
    const repos = await crear();
    try {
      // Sin serializacion, varias de estas pasarian la comprobacion antes de
      // que la primera termine de escribir.
      const intentos = Array.from({ length: 8 }, (_, i) =>
        repos.pedidos.crearSiNoExiste(
          pedidoDeEjemplo({ id: `NOV-CARRERA-${i}`, claveDeEvento: `ev-${i}`, claveDeOferta: "of-carrera" })
        )
      );
      const resultados = await Promise.all(intentos);
      const creados = resultados.filter((r) => r.creado);
      assert.equal(creados.length, 1, `se crearon ${creados.length} pedidos para la misma oferta`);

      const todos = await repos.pedidos.porContacto("573001112233");
      assert.equal(todos.length, 1);
    } finally {
      await repos.cerrar();
    }
  });

  // --------------------------------------------------------------------
  // Lectura y actualizacion
  // --------------------------------------------------------------------

  test(`[${nombre}] reemplazar guarda la version nueva y conserva la identidad`, async () => {
    const repos = await crear();
    try {
      const { pedido } = await repos.pedidos.crearSiNoExiste(pedidoDeEjemplo({ id: "NOV-MOD" }));
      const modificado = { ...pedido, version: 2, estado: "modificado" };
      await repos.pedidos.reemplazar(modificado);

      const leido = await repos.pedidos.obtener("NOV-MOD");
      assert.equal(leido.version, 2);
      assert.equal(leido.estado, "modificado");
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] activoDeContacto ignora los cancelados`, async () => {
    const repos = await crear();
    try {
      const { pedido } = await repos.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ id: "NOV-CANC", claveDeOferta: "of-c" })
      );
      assert.ok(await repos.pedidos.activoDeContacto("573001112233"));

      await repos.pedidos.reemplazar({ ...pedido, estado: "cancelado", version: 2 });
      assert.equal(await repos.pedidos.activoDeContacto("573001112233"), null);

      // Pero sigue consultable: un cancelado no se borra, se marca.
      assert.equal((await repos.pedidos.porContacto("573001112233", { incluirCancelados: true })).length, 1);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] tras cancelar, la misma oferta SI puede volver a crear pedido`, async () => {
    const repos = await crear();
    try {
      const { pedido } = await repos.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ claveDeEvento: "ev-1", claveDeOferta: "of-recuperable" })
      );
      await repos.pedidos.reemplazar({ ...pedido, estado: "cancelado", version: 2 });

      // El cliente se arrepintio de cancelar. No se le puede bloquear la
      // compra por una oferta que ya no tiene pedido vivo.
      const b = await repos.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ id: "NOV-RETOMA", claveDeEvento: "ev-3", claveDeOferta: "of-recuperable" })
      );
      assert.equal(b.creado, true);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] porClaveDeEvento encuentra el pedido de un wamid`, async () => {
    const repos = await crear();
    try {
      await repos.pedidos.crearSiNoExiste(pedidoDeEjemplo({ id: "NOV-EV", claveDeEvento: "ev-buscado" }));
      const hallado = await repos.pedidos.porClaveDeEvento("ev-buscado");
      assert.equal(hallado.id, "NOV-EV");
      assert.equal(await repos.pedidos.porClaveDeEvento("ev-inexistente"), null);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] un pedido sin claves de idempotencia se rechaza`, async () => {
    const repos = await crear();
    try {
      const r = await repos.pedidos.crearSiNoExiste(
        pedidoDeEjemplo({ claveDeEvento: null, claveDeOferta: null })
      );
      assert.equal(r.creado, false);
      // Guardar un pedido que no se puede deduplicar es abrir la puerta al
      // duplicado por la unica via que no vigila nadie.
      assert.match(r.motivo, /clave/i);
    } finally {
      await repos.cerrar();
    }
  });

  test(`[${nombre}] el almacen informa de su estado`, async () => {
    const repos = await crear();
    try {
      const e = await repos.estado();
      assert.equal(typeof e.tipo, "string");
      assert.equal(typeof e.pedidos, "number");
    } finally {
      await repos.cerrar();
    }
  });
}

module.exports = { METODOS, revisarForma, pruebasDeContrato, MOTIVOS_NO_CREADO };
