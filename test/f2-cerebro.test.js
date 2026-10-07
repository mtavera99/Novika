"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Es el recorrido completo, con dobles de prueba en lugar de la red:
//
//   mensaje -> contexto -> producto -> intencion -> respuesta
//           -> cotizacion -> captura -> confirmacion -> pedido
//
// Y sobre todo, las dos garantias que Marco pidio por escrito:
//
//   1. CON RESPUESTA_AUTOMATICA EN 0, NUNCA SE ENVIA NADA. Se comprueba de
//      la forma mas dura posible: el `fetch` que usaria el emisor es un
//      doble que falla la prueba si alguien lo llama.
//
//   2. DESPUES DE CONFIRMAR, UN "SI" NO CREA OTRO PEDIDO. Ni un "gracias",
//      ni un "ok", ni una retransmision del webhook.
//
// Ninguna prueba de este archivo sale a internet ni necesita credenciales.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba({ RESPUESTA_AUTOMATICA: "0", MODO_SOMBRA: "1" });

const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearProveedorFalso, analisisValido } = require("../src/ia/proveedores/falso");
const { crearEmisor } = require("../src/whatsapp/enviar");
const metricas = require("../src/metricas");
const mutex = require("../src/almacen/mutex");

// --------------------------------------------------------------------------
// Dobles
// --------------------------------------------------------------------------

/** Catalogo en memoria con UN producto activo. Importes de fixture. */
function catalogoDePrueba() {
  const productos = [
    {
      id: "cinturon-termico",
      nombre: "Cinturón térmico",
      nombreCorto: "el cinturón",
      categoria: "bienestar",
      activo: true,
      aliases: [{ patron: "\\bcinturon(es)?\\s+termic", confianza: "alta", senal: "cinturon termico" }],
      descripcionAutorizada: "Cinturón con función de calor.",
      caracteristicasAutorizadas: ["se recarga por cable USB-C"],
      claimsProhibidos: ["cura los colicos", "es un dispositivo medico"],
      motorDePrecio: "tabla",
      precios: { 1: 89000, 2: 150000 },
      logistica: { politicaEnvio: { tipo: "incluido" } },
      datosRequeridos: [],
    },
    {
      id: "manta-termica",
      nombre: "Manta térmica",
      nombreCorto: "la manta",
      categoria: "hogar",
      activo: true,
      aliases: [{ patron: "\\bmanta(s)?\\s+termic", confianza: "alta", senal: "manta termica" }],
      descripcionAutorizada: "Manta con función de calor.",
      motorDePrecio: "tabla",
      precios: { 1: 60000 },
      logistica: { politicaEnvio: { tipo: "incluido" } },
    },
  ].map((p) => ({ ...p, _aliases: p.aliases.map((a) => ({ ...a, re: new RegExp(a.patron, "i") })) }));

  return {
    productos,
    activos: productos,
    porId: new Map(productos.map((p) => [p.id, p])),
    productoPorDefecto: null,
    problemas: [],
    avisos: [],
  };
}

/** fetch que hace fallar la prueba si alguien intenta enviar. */
function fetchProhibido() {
  return async () => {
    throw new Error("PRUEBA FALLIDA: se intento enviar un mensaje real con RESPUESTA_AUTOMATICA=0");
  };
}

async function montar({ respuestasIA = [], respuestaAutomatica = false } = {}) {
  mutex._reiniciar();
  metricas._reiniciar();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-cerebro-"));
  const repos = await crearReposDeArchivos({ dir });

  const cfg = { ...config, respuestaAutomatica };
  const llamadasDeEnvio = [];
  const emisor = crearEmisor({
    config: cfg,
    fetchImpl: respuestaAutomatica
      ? async (...args) => {
          llamadasDeEnvio.push(args);
          return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.SALIDA" }] }) };
        }
      : fetchProhibido(),
  });

  const anotaciones = [];
  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: catalogoDePrueba(),
    ia: crearCliente({ proveedor: crearProveedorFalso(respuestasIA), intentos: 1 }),
    emisor,
    metricas,
    diario: { anotar: (tipo, datos) => anotaciones.push({ tipo, datos }) },
  });

  return { cerebro, repos, dir, anotaciones, llamadasDeEnvio };
}

let n = 0;
function mensaje(texto, sobre = {}) {
  n += 1;
  return {
    clase: "mensaje",
    wamid: sobre.wamid || `wamid.T${n}`,
    idCliente: sobre.idCliente || "573001234567",
    telefono: sobre.telefono !== undefined ? sobre.telefono : "573001234567",
    bsuid: null,
    nombre: sobre.nombre !== undefined ? sobre.nombre : "Ana Pérez",
    tipo: "text",
    texto,
    origenTexto: "escrito",
    referral: sobre.referral || null,
    ...sobre,
  };
}

/** Lleva la conversacion hasta PENDIENTE_CONFIRMACION. */
async function hastaElResumen(cerebro) {
  await cerebro.procesar(mensaje("hola, quiero el cinturon termico"));
  return cerebro.procesar(mensaje("vivo en Medellin, Calle 45 # 23-10"));
}

// --------------------------------------------------------------------------
// GARANTIA 1: con el interruptor apagado no se envia nada
// --------------------------------------------------------------------------

test("RESPUESTA_AUTOMATICA=0: se procesa todo y NO se envia nada", async () => {
  const { cerebro } = await montar({
    respuestasIA: [analisisValido({ intencion: "intencion_compra", borrador: "Claro, te cuento." })],
  });

  // El fetch del emisor lanza si se le llama. Si llegamos al final, no se
  // intento enviar.
  const traza = await cerebro.procesar(mensaje("quiero el cinturon termico"));

  assert.equal(traza.enviada, false);
  assert.ok(traza.respuesta.texto, "no se preparo ninguna respuesta");
  assert.equal(metricas.valor("respuesta_preparada") >= 1, true);
  assert.equal(metricas.valor("respuesta_enviada"), 0, "se envio algo con el interruptor apagado");
});

test("la respuesta SI se prepara: es la diferencia entre no saber y callar", async () => {
  const { cerebro, anotaciones } = await montar();
  await cerebro.procesar(mensaje("quiero el cinturon termico"));
  const turno = anotaciones.find((a) => a.tipo === "turno_procesado");
  assert.ok(turno, "el turno no quedo en el diario");
  assert.ok(turno.datos.respuestaPreparada, "no se guardo la respuesta preparada para auditar");
  assert.equal(turno.datos.enviada, false);
});

test("ningun recorrido completo intenta enviar con el interruptor apagado", async () => {
  const { cerebro } = await montar({
    respuestasIA: Array.from({ length: 6 }, () => analisisValido({ intencion: "da_datos" })),
  });
  // Si cualquiera de estos pasos enviara, el fetch prohibido lo delataria.
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));
  await cerebro.procesar(mensaje("gracias"));
  await cerebro.procesar(mensaje("cancela"));
  assert.equal(metricas.valor("respuesta_enviada"), 0);
});

// --------------------------------------------------------------------------
// Producto
// --------------------------------------------------------------------------

test("un mensaje sin señal de producto deja el producto DESCONOCIDO y pregunta", async () => {
  const { cerebro } = await montar();
  const traza = await cerebro.procesar(mensaje("hola buenas"));
  assert.equal(traza.producto.productoId, null);
  assert.equal(traza.respuesta.situacion, "producto_desconocido");
  // El texto se volvio mas cercano ("Cuéntame qué producto te interesa") pero
  // la garantia es la misma: se PREGUNTA en vez de adivinar.
  assert.match(traza.respuesta.texto, /qué producto|cuál producto/i);
  assert.equal(metricas.valor("producto_desconocido") >= 1, true);
});

test("un alias identifica el producto y lo recuerda en el turno siguiente", async () => {
  const { cerebro } = await montar();
  const a = await cerebro.procesar(mensaje("cuanto vale el cinturon termico"));
  assert.equal(a.producto.productoId, "cinturon-termico");

  // Sin volver a nombrarlo: el producto persiste en la conversacion.
  const b = await cerebro.procesar(mensaje("y cuanto demora"));
  assert.equal(b.producto.productoId, "cinturon-termico");
  assert.equal(b.producto.origen, "contexto_confirmado");
});

test("dos productos en la misma frase: se pregunta cual", async () => {
  const { cerebro } = await montar();
  const traza = await cerebro.procesar(mensaje("tienes el cinturon termico y la manta termica"));
  assert.equal(traza.producto.ambiguo, true);
  assert.equal(traza.respuesta.situacion, "producto_ambiguo");
  // "¿Cuál de estos?" paso a "¿Cuál te interesa, el cinturón o la manta?".
  // El cambio que importa es la conjuncion: con "y" la pregunta se leia como
  // si se ofrecieran los dos juntos.
  assert.match(traza.respuesta.texto, /cuál te interesa|cuál de estos/i);
  assert.match(traza.respuesta.texto, / o /, "las opciones son alternativas: van con «o», no con «y»");
});

test("una falsa señal NO cambia el producto de la conversacion", async () => {
  const { cerebro } = await montar();
  await cerebro.procesar(mensaje("quiero la manta termica"));
  const traza = await cerebro.procesar(mensaje("y eso es igual que el cinturon termico?"));
  assert.equal(traza.producto.productoId, "manta-termica", "una pregunta cambio el producto");
  assert.equal(traza.producto.esCambio, false);
});

test("un cambio legitimo de producto descarta la cotizacion anterior", async () => {
  const { cerebro } = await montar();
  await cerebro.procesar(mensaje("quiero el cinturon termico"));
  const traza = await cerebro.procesar(mensaje("mejor quiero la manta termica"));
  assert.equal(traza.producto.productoId, "manta-termica");
  assert.equal(traza.producto.esCambio, true);
  assert.equal(metricas.valor("producto_cambiado") >= 1, true);
});

// --------------------------------------------------------------------------
// Cotizacion y captura de datos
// --------------------------------------------------------------------------

test("sin datos suficientes se piden, no se inventan", async () => {
  const { cerebro } = await montar();
  const traza = await cerebro.procesar(mensaje("quiero el cinturon termico"));
  assert.equal(traza.respuesta.situacion, "faltan_datos");
  assert.ok(traza.faltan.length > 0);

  // ANTES SE EXIGIA "me falta" Y YA NO CORRESPONDE.
  //
  // El texto era "Para continuar me falta la ciudad, la dirección de
  // entrega." y ahora es "El cinturón te queda en $89.000, con envío
  // incluido. Para despacharlo me pasas la ciudad y la dirección."
  //
  // La garantia no era la palabra "falta": era que se PIDAN los datos en vez
  // de inventarlos. Eso sigue, y ahora ademas se dice el precio primero, que
  // es lo que el cliente pregunto. Se comprueban las dos cosas.
  assert.match(traza.respuesta.texto, /me pasas|me falta/i, "tiene que pedir los datos que faltan");
  assert.match(traza.respuesta.texto, /\$89\.000/, "y decir el precio antes de pedirlos");
  assert.ok(
    traza.respuesta.texto.indexOf("89.000") < traza.respuesta.texto.search(/me pasas|me falta/i),
    "el precio va antes de la pedida de datos"
  );
});

test("con todos los datos se cotiza y se muestra el resumen", async () => {
  const { cerebro } = await montar();
  const traza = await hastaElResumen(cerebro);

  assert.equal(traza.respuesta.situacion, "resumen");
  assert.equal(traza.estadoNuevo, "pendiente_confirmacion");
  assert.equal(traza.cotizacion.total, 89000);
  assert.match(traza.respuesta.texto, /\$89\.000/);
  // El cierre del resumen paso de "¿Confirmas?" a '¿Está todo bien?
  // Respóndeme "sí" y lo despacho.' — dice QUE contestar, que es lo que
  // convierte un resumen en una confirmacion.
  assert.match(traza.respuesta.texto, /¿Está todo bien\?|¿Confirmas\?/);
  assert.match(traza.respuesta.texto, /Confirmemos tu pedido/);
});

test('"vivo en la calle 45" NO se lee como 45 unidades', async () => {
  // REGRESION. La primera version de la heuristica proponia cualquier numero
  // entre 1 y 50 como cantidad, y la direccion es donde mas numeros escribe
  // un cliente. Cotizar 45 unidades es cobrar mal de la forma mas tonta.
  const { cerebro } = await montar();
  await cerebro.procesar(mensaje("quiero el cinturon termico"));
  const traza = await cerebro.procesar(mensaje("vivo en la calle 45 # 23-10, Medellin"));
  assert.notEqual(traza.cotizacion && traza.cotizacion.cantidad, 45);
  assert.equal(traza.cotizacion.cantidad, 1);
});

test("una cantidad pedida explicitamente si se recoge", async () => {
  const { cerebro } = await montar();
  await cerebro.procesar(mensaje("quiero 2 cinturon termico"));
  const traza = await cerebro.procesar(mensaje("Medellin, Calle 45 # 23-10"));
  assert.equal(traza.cotizacion.cantidad, 2);
  assert.equal(traza.cotizacion.total, 150000);
});

test("una frase no se convierte en ciudad ni en direccion", async () => {
  const { cerebro } = await montar({
    respuestasIA: [
      analisisValido({ intencion: "pregunta_producto" }),
      // El modelo propone basura semantica, como hace de verdad.
      analisisValido({ intencion: "da_datos", candidatos: { ciudad: "por aqui cerca", direccion: "mi casa" } }),
    ],
  });
  await cerebro.procesar(mensaje("quiero el cinturon termico"));
  const traza = await cerebro.procesar(mensaje("mandalo a mi casa"));

  // No se llego al resumen porque esos datos no son validos.
  assert.notEqual(traza.respuesta.situacion, "resumen");
  assert.equal(metricas.valor("dato_rechazado") >= 1, true);
});

// --------------------------------------------------------------------------
// GARANTIA 2: confirmacion y no duplicados
// --------------------------------------------------------------------------

test("un si frente al resumen crea el pedido, una sola vez", async () => {
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);

  const traza = await cerebro.procesar(mensaje("si confirmo"));
  assert.equal(traza.estadoNuevo, "confirmado");
  assert.ok(traza.pedido.id);
  assert.equal(traza.pedido.creado, true);
  assert.match(traza.respuesta.texto, new RegExp(traza.pedido.id));

  const guardados = await repos.pedidos.porContacto("573001234567");
  assert.equal(guardados.length, 1);
  assert.equal(guardados[0].cotizacion.total, 89000);
  assert.equal(metricas.valor("pedido_confirmado"), 1);
});

test('un "si" DESPUES de confirmado NO crea otro pedido ni recotiza', async () => {
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));

  const segundo = await cerebro.procesar(mensaje("si"));
  assert.equal(segundo.accion, "ninguna");
  assert.equal(segundo.respuesta.situacion, "ya_confirmado");
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 1);
});

test('"gracias", "ok", "listo" y "perfecto" despues de confirmado no hacen nada', async () => {
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));

  for (const frase of ["gracias", "ok", "listo", "perfecto", "de una", "sí"]) {
    const t = await cerebro.procesar(mensaje(frase));
    assert.equal(t.accion, "ninguna", `"${frase}" produjo la accion ${t.accion}`);
  }
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 1);
});

test("una doble confirmacion seguida deja UN pedido", async () => {
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));
  await cerebro.procesar(mensaje("si confirmo"));
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 1);
});

test("dos confirmaciones SIMULTANEAS dejan UN pedido", async () => {
  // Sin la cola por conversacion, las dos comprobarian "no hay pedido"
  // antes de que la primera acabe de escribir.
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);

  await Promise.all([
    cerebro.procesar(mensaje("si confirmo", { wamid: "wamid.A" })),
    cerebro.procesar(mensaje("si confirmo", { wamid: "wamid.B" })),
  ]);

  const guardados = await repos.pedidos.porContacto("573001234567");
  assert.equal(guardados.length, 1, `se crearon ${guardados.length} pedidos`);
});

test("la retransmision del mismo wamid no crea otro pedido", async () => {
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);

  // El webhook deduplica por wamid, pero si ese candado fallara, el almacen
  // es la segunda linea: misma clave de evento.
  await cerebro.procesar(mensaje("si confirmo", { wamid: "wamid.MISMO" }));
  await cerebro.procesar(mensaje("si confirmo", { wamid: "wamid.MISMO" }));

  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 1);
});

test("confirmar sin cotizacion vigente escala, no inventa un pedido", async () => {
  const { cerebro, repos } = await montar();
  // "si confirmo" de la nada: no hay resumen ni cotizacion.
  const traza = await cerebro.procesar(mensaje("si confirmo"));
  assert.notEqual(traza.estadoNuevo, "confirmado");
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 0);
});

// --------------------------------------------------------------------------
// Cancelacion y modificacion
// --------------------------------------------------------------------------

test("cancelar marca el pedido y lo saca de los activos", async () => {
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));

  const traza = await cerebro.procesar(mensaje("cancela el pedido"));
  assert.equal(traza.estadoNuevo, "cancelado");

  assert.equal(await repos.pedidos.activoDeContacto("573001234567"), null);
  const todos = await repos.pedidos.porContacto("573001234567", { incluirCancelados: true });
  assert.equal(todos.length, 1);
  assert.equal(todos[0].estado, "cancelado");
  assert.ok(todos[0].canceladoEn);
});

test("cancelar dos veces no rompe nada", async () => {
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));
  await cerebro.procesar(mensaje("cancela"));
  await assert.doesNotReject(() => cerebro.procesar(mensaje("cancela")));
  assert.equal((await repos.pedidos.porContacto("573001234567", { incluirCancelados: true })).length, 1);
});

test("pedir un cambio sobre un pedido confirmado abre modificacion, no un pedido nuevo", async () => {
  const { cerebro, repos } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));

  const traza = await cerebro.procesar(mensaje("cambia la direccion"));
  assert.equal(traza.accion, "corregir");
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 1);
});

test("preguntar por el envio de un pedido confirmado responde estado", async () => {
  const { cerebro } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));

  const traza = await cerebro.procesar(mensaje("ya lo enviaron?"));
  assert.equal(traza.accion, "responder_estado");
  assert.equal(traza.respuesta.situacion, "ya_confirmado");
});

test("mencionar otro producto con un pedido vivo NO cambia el producto", async () => {
  const { cerebro } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));

  const traza = await cerebro.procesar(mensaje("quiero la manta termica"));
  assert.ok(traza.avisos.some((a) => /pedido vivo/.test(a)), "se permitio cambiar el producto con un pedido confirmado");
});

// --------------------------------------------------------------------------
// La IA no puede alterar hechos
// --------------------------------------------------------------------------

test("un precio inventado por la IA se bloquea y se usa el texto determinista", async () => {
  const { cerebro } = await montar({
    respuestasIA: [
      analisisValido({ intencion: "pregunta_producto" }),
      analisisValido({ intencion: "pregunta_precio", borrador: "Te lo dejo en $45.000 con envio gratis" }),
    ],
  });
  await cerebro.procesar(mensaje("quiero el cinturon termico"));
  const traza = await cerebro.procesar(mensaje("Medellin, Calle 45 # 23-10"));

  assert.equal(traza.respuesta.origen, "determinista", "se envio el borrador con el precio inventado");
  assert.ok(traza.bloqueos.some((b) => b.tipo === "importe_no_autorizado"));
  assert.equal(traza.respuesta.texto.includes("45.000"), false);
  assert.match(traza.respuesta.texto, /\$89\.000/);
  assert.equal(metricas.valor("importe_no_autorizado_bloqueado") >= 1, true);
});

test("un claim prohibido por la IA se bloquea", async () => {
  const { cerebro } = await montar({
    respuestasIA: [analisisValido({ intencion: "pregunta_producto", borrador: "Claro, cura los colicos al instante" })],
  });
  const traza = await cerebro.procesar(mensaje("quiero el cinturon termico"));

  assert.equal(traza.respuesta.origen, "determinista");
  assert.ok(traza.bloqueos.some((b) => b.tipo === "claim_prohibido"));
  assert.equal(traza.respuesta.texto.includes("cura los colicos"), false);
  assert.equal(metricas.valor("claim_prohibido_bloqueado") >= 1, true);
});

test("si la IA falla, el mensaje NO se pierde y no se inventa nada", async () => {
  const { cerebro, anotaciones, repos } = await montar({ respuestasIA: [{ texto: "json roto {{" }] });
  const traza = await cerebro.procesar(mensaje("quiero el cinturon termico"));

  assert.ok(traza.avisos.some((a) => /ia no utilizable/.test(a)));
  assert.ok(traza.respuesta.texto, "el cliente se quedaria sin respuesta preparada");
  assert.ok(anotaciones.some((a) => a.tipo === "turno_procesado"), "el turno no quedo registrado");
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 0);
});

test("sin IA el camino determinista funciona igual", async () => {
  // Es el estado real de NOVIKA hoy: sin clave de IA configurada.
  const { cerebro, repos } = await montar({ respuestasIA: [] });
  await hastaElResumen(cerebro);
  const traza = await cerebro.procesar(mensaje("si confirmo"));
  assert.equal(traza.estadoNuevo, "confirmado");
  assert.equal((await repos.pedidos.porContacto("573001234567")).length, 1);
});

test("un borrador de la IA limpio SI se usa", async () => {
  const { cerebro } = await montar({
    respuestasIA: [analisisValido({ intencion: "pregunta_producto", borrador: "Con gusto, ¿para qué lo necesitas?" })],
  });
  const traza = await cerebro.procesar(mensaje("cuentame del cinturon termico"));
  assert.equal(traza.respuesta.origen, "ia");
  assert.equal(traza.respuesta.texto, "Con gusto, ¿para qué lo necesitas?");
});

// --------------------------------------------------------------------------
// Persistencia y reinicio
// --------------------------------------------------------------------------

test("el estado de la conversacion sobrevive al reinicio del proceso", async () => {
  const { cerebro, repos, dir } = await montar();
  await hastaElResumen(cerebro);

  // Reinicio: repos nuevos sobre el mismo disco, cerebro nuevo.
  const otrosRepos = await crearReposDeArchivos({ dir });
  const otroCerebro = crearCerebro({
    config: { ...config, respuestaAutomatica: false },
    repos: otrosRepos,
    catalogo: catalogoDePrueba(),
    ia: crearCliente({ proveedor: null }),
    emisor: crearEmisor({ config: { ...config, respuestaAutomatica: false }, fetchImpl: fetchProhibido() }),
    metricas,
  });

  // El "si" tras el reinicio tiene que seguir funcionando: el resumen
  // mostrado y la cotizacion estaban en disco.
  const traza = await otroCerebro.procesar(mensaje("si confirmo"));
  assert.equal(traza.estadoNuevo, "confirmado");
  assert.equal((await otrosRepos.pedidos.porContacto("573001234567")).length, 1);
  assert.ok(repos);
});

test("tras reiniciar, un si repetido sigue sin duplicar el pedido", async () => {
  const { cerebro, dir } = await montar();
  await hastaElResumen(cerebro);
  await cerebro.procesar(mensaje("si confirmo"));

  const otrosRepos = await crearReposDeArchivos({ dir });
  const otroCerebro = crearCerebro({
    config: { ...config, respuestaAutomatica: false },
    repos: otrosRepos,
    catalogo: catalogoDePrueba(),
    ia: crearCliente({ proveedor: null }),
    emisor: crearEmisor({ config: { ...config, respuestaAutomatica: false }, fetchImpl: fetchProhibido() }),
    metricas,
  });

  await otroCerebro.procesar(mensaje("si confirmo"));
  assert.equal((await otrosRepos.pedidos.porContacto("573001234567")).length, 1);
});

// --------------------------------------------------------------------------
// Clientes sin telefono
// --------------------------------------------------------------------------

test("un cliente con nombre de usuario (sin telefono) no se queda sin atender", async () => {
  const { cerebro } = await montar();
  const traza = await cerebro.procesar(
    mensaje("quiero el cinturon termico", { idCliente: "ab.Ana123", telefono: null, bsuid: "ab.Ana123" })
  );
  // Se atiende, pero no se puede despachar sin telefono: lo pide.
  assert.ok(traza.respuesta.texto);
  assert.ok((traza.faltan || []).includes("telefono"));
});

// --------------------------------------------------------------------------
// Privacidad del registro
// --------------------------------------------------------------------------

test("el diario guarda la conversacion pero los logs no llevan PII", async () => {
  const registros = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-pii-"));
  const repos = await crearReposDeArchivos({ dir });
  const cfg = { ...config, respuestaAutomatica: false };

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: catalogoDePrueba(),
    ia: crearCliente({ proveedor: null }),
    emisor: crearEmisor({ config: cfg, fetchImpl: fetchProhibido() }),
    log: { info: (e, d) => registros.push({ e, d }), warn: (e, d) => registros.push({ e, d }), error: (e, d) => registros.push({ e, d }) },
    metricas,
    diario: { anotar() {} },
  });

  await cerebro.procesar(mensaje("soy Ana Perez y vivo en la Calle 45 # 23-10"));

  const todo = JSON.stringify(registros);
  assert.equal(todo.includes("Calle 45"), false, "la direccion acabo en los logs");
  assert.equal(todo.includes("573001234567"), false, "el telefono completo acabo en los logs");
});
