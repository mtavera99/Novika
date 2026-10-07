"use strict";

// ==========================================================================
// CRASH Y RECUPERACION, DE PRINCIPIO A FIN
//
// Esta bateria reproduce el escenario exacto que destapo el agujero, con un
// PROCESO REAL y SIGKILL. No con dobles: el fallo solo aparece cuando el
// proceso muere de verdad entre el 200 y el final del procesamiento.
//
//   1. Meta envia un mensaje
//   2. NOVIKA lo persiste
//   3. NOVIKA contesta 200
//   4. el proceso muere (SIGKILL, sin apagado ordenado)
//   5. reinicia
//   -> ¿se procesa sin depender de que Meta reintente?
//
// Antes del arreglo la respuesta era NO, y medido daba:
//   turno_procesado: 0 · duplicado_descartado: 1
//
// Lo segundo era lo grave: el wamid ya figuraba como "visto", asi que ni una
// retransmision de Meta lo habria salvado.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const RAIZ = path.join(__dirname, "..");
const SECRETO = "secreto_de_crash";
const ID_NUMERO = "555000111222333";

// --------------------------------------------------------------------------
// Utilidades del proceso real
// --------------------------------------------------------------------------

function carpetaNueva() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "novika-recup-"));
}

function puertoLibre() {
  return 20000 + Math.floor(Math.random() * 20000);
}

function cuerpoDeMensaje(wamid, texto = "quiero comprar", idNumero = ID_NUMERO) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "W",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: idNumero },
              contacts: [{ profile: { name: "Ana" }, wa_id: "573009998877" }],
              messages: [{ from: "573009998877", id: wamid, timestamp: "1790000000", type: "text", text: { body: texto } }],
            },
          },
        ],
      },
    ],
  });
}

function firmar(cuerpo) {
  return `sha256=${crypto.createHmac("sha256", SECRETO).update(cuerpo).digest("hex")}`;
}

/** Levanta el servidor REAL en un proceso aparte. */
async function arrancarServidor({ dir, puerto, extra = {} }) {
  const hijo = spawn(process.execPath, [path.join(RAIZ, "src", "server.js")], {
    cwd: RAIZ,
    env: {
      ...process.env,
      DATA_DIR: dir,
      PORT: String(puerto),
      WHATSAPP_VERIFY_TOKEN: "token_de_verificacion_de_prueba_0123456789",
      META_APP_SECRET: SECRETO,
      WHATSAPP_PHONE_NUMBER_ID: ID_NUMERO,
      PANEL_TOKEN: "panel_de_prueba",
      RESPUESTA_AUTOMATICA: "0",
      MODO_SOMBRA: "1",
      LOG_NIVEL: "error",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let salida = "";
  hijo.stdout.on("data", (d) => (salida += d));
  hijo.stderr.on("data", (d) => (salida += d));
  hijo.leer = () => salida;

  // Esperar a que responda, sin asumir un tiempo fijo.
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const r = await fetch(`http://127.0.0.1:${puerto}/health`);
      if (r.ok) return hijo;
    } catch {
      /* todavia no */
    }
  }
  hijo.kill("SIGKILL");
  throw new Error(`el servidor no arranco. Salida:\n${salida}`);
}

function matarDeGolpe(hijo) {
  return new Promise((listo) => {
    hijo.once("exit", () => listo());
    hijo.kill("SIGKILL"); // sin SIGTERM: no hay apagado ordenado
  });
}

function leerDiario(dir) {
  const carpeta = path.join(dir, "diario");
  if (!fs.existsSync(carpeta)) return [];
  return fs
    .readdirSync(carpeta)
    .filter((n) => n.endsWith(".jsonl"))
    .flatMap((n) =>
      fs
        .readFileSync(path.join(carpeta, n), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { tipo: "ilegible" };
          }
        })
    );
}

const tipos = (dir) => leerDiario(dir).map((e) => e.tipo);

// --------------------------------------------------------------------------
// ESCENARIO COMPLETO: crash + reinicio + recuperacion automatica
// --------------------------------------------------------------------------

test(
  "ESCENARIO: crash tras el 200, reinicio, y el mensaje se procesa SIN retransmision de Meta",
  { timeout: 60000 },
  async () => {
    const dir = carpetaNueva();
    const puerto = puertoLibre();
    const wamid = "wamid.CRASH_E2E";
    const cuerpo = cuerpoDeMensaje(wamid);

    // --- 1 y 2 y 3: Meta envia, NOVIKA persiste y contesta 200 ---
    const primero = await arrancarServidor({ dir, puerto });
    const respuesta = await fetch(`http://127.0.0.1:${puerto}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": firmar(cuerpo) },
      body: cuerpo,
    });
    assert.equal(respuesta.status, 200, "Meta tiene que recibir su 200");

    // --- 4: el proceso muere inmediatamente ---
    await matarDeGolpe(primero);

    const trasElCrash = tipos(dir);
    assert.ok(trasElCrash.includes("entrada_cruda"), "el evento no se persistio antes del 200");

    // Si el crash llego antes de terminar, queda trabajo reclamado. Si llego
    // despues, ya estaba terminado. Las dos situaciones son validas; lo que
    // NO puede pasar es quedarse sin procesar tras el reinicio.
    const seTerminoAntes = trasElCrash.includes("turno_procesado");

    // --- 5: reinicio, como haria Render ---
    const segundo = await arrancarServidor({ dir, puerto: puertoLibre() });
    // La recuperacion arranca despues de escuchar; se le da margen.
    await new Promise((r) => setTimeout(r, 1500));
    await matarDeGolpe(segundo);

    const entradas = leerDiario(dir);
    const procesados = entradas.filter((e) => e.tipo === "turno_procesado" && e.wamid === wamid);

    // LA PREGUNTA: ¿se proceso?
    assert.equal(
      procesados.length >= 1,
      true,
      `el mensaje NO se proceso tras el reinicio. Tipos en el diario: ${[...new Set(tipos(dir))].join(", ")}`
    );

    // Y SOLO UNA VEZ: ni el crash ni la recuperacion pueden duplicarlo.
    assert.equal(procesados.length, 1, `el mensaje se proceso ${procesados.length} veces`);

    if (!seTerminoAntes) {
      // El crash cayo en medio: tuvo que haber recuperacion explicita.
      assert.ok(
        tipos(dir).includes("recuperacion_iniciada"),
        "el crash dejo trabajo a medias y no hubo recuperacion"
      );
      assert.ok(entradas.some((e) => e.tipo === "evento_recuperado" && e.wamid === wamid));
    }

    // Y en ningun momento se envio nada: el interruptor estaba apagado.
    assert.equal(tipos(dir).includes("respuesta_enviada"), false);
  }
);

test(
  "ESCENARIO: tras recuperar, un replay de Meta NO vuelve a procesar",
  { timeout: 60000 },
  async () => {
    const dir = carpetaNueva();
    const puerto = puertoLibre();
    const wamid = "wamid.REPLAY_E2E";
    const cuerpo = cuerpoDeMensaje(wamid);

    const servidor = await arrancarServidor({ dir, puerto });
    const enviar = () =>
      fetch(`http://127.0.0.1:${puerto}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": firmar(cuerpo) },
        body: cuerpo,
      });

    assert.equal((await enviar()).status, 200);
    await new Promise((r) => setTimeout(r, 800)); // que termine

    // Replay: el mismo evento otra vez.
    assert.equal((await enviar()).status, 200);
    await new Promise((r) => setTimeout(r, 800));
    await matarDeGolpe(servidor);

    const entradas = leerDiario(dir);
    const procesados = entradas.filter((e) => e.tipo === "turno_procesado" && e.wamid === wamid);
    assert.equal(procesados.length, 1, "el replay volvio a procesar el evento");

    const duplicados = entradas.filter((e) => e.tipo === "duplicado_descartado" && e.wamid === wamid);
    assert.equal(duplicados.length, 1);
    // Y el motivo dice QUE paso: terminado, no "visto".
    assert.equal(duplicados[0].motivo, "terminado");
  }
);

test(
  "ESCENARIO: un reinicio sin trabajo pendiente no reprocesa nada",
  { timeout: 60000 },
  async () => {
    const dir = carpetaNueva();
    const puerto = puertoLibre();
    const wamid = "wamid.LIMPIO";
    const cuerpo = cuerpoDeMensaje(wamid);

    const primero = await arrancarServidor({ dir, puerto });
    await fetch(`http://127.0.0.1:${puerto}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": firmar(cuerpo) },
      body: cuerpo,
    });
    await new Promise((r) => setTimeout(r, 900)); // dejar terminar
    await matarDeGolpe(primero);

    const antes = leerDiario(dir).filter((e) => e.tipo === "turno_procesado").length;
    assert.equal(antes, 1);

    const segundo = await arrancarServidor({ dir, puerto: puertoLibre() });
    await new Promise((r) => setTimeout(r, 1500));
    await matarDeGolpe(segundo);

    const despues = leerDiario(dir).filter((e) => e.tipo === "turno_procesado").length;
    assert.equal(despues, 1, "un reinicio limpio reproceso trabajo ya terminado");
  }
);

// --------------------------------------------------------------------------
// El recuperador, aislado
// --------------------------------------------------------------------------

const trabajo = require("../src/almacen/trabajo");
const { recuperarPendientes } = require("../src/webhook/recuperar");

test("recuperarPendientes reprocesa lo reclamado, por el MISMO camino", async () => {
  trabajo._reiniciar();
  const evento = { clase: "mensaje", wamid: "wamid.U1", idCliente: "573001112233", texto: "hola" };
  trabajo.reclamar("wamid.U1", { evento });
  trabajo._olvidarMemoria();

  const atendidos = [];
  const resumen = await recuperarPendientes({
    atender: async (ev, opciones) => {
      atendidos.push({ ev, opciones });
      trabajo.terminar(ev.wamid);
      return { accion: "procesado" };
    },
  });

  assert.equal(resumen.recuperados, 1);
  assert.equal(atendidos.length, 1);
  assert.equal(atendidos[0].ev.wamid, "wamid.U1");
  // La bandera importa: es lo que permite reclamar algo ya reclamado.
  assert.equal(atendidos[0].opciones.enRecuperacion, true);
});

test("recuperarPendientes no hace nada si no hay pendientes", async () => {
  trabajo._reiniciar();
  const resumen = await recuperarPendientes({ atender: async () => assert.fail("no deberia atender nada") });
  assert.equal(resumen.revisados, 0);
});

test("recuperarPendientes NUNCA lanza, aunque el atendedor falle", async () => {
  // Un problema con mensajes viejos no puede impedir atender los nuevos.
  trabajo._reiniciar();
  trabajo.reclamar("wamid.U2", { evento: { clase: "mensaje", wamid: "wamid.U2", idCliente: "c", texto: "x" } });
  trabajo._olvidarMemoria();

  await assert.doesNotReject(() =>
    recuperarPendientes({
      atender: async () => {
        throw new Error("todo mal");
      },
    })
  );
});

test("un evento agotado se registra a gritos y no se reintenta", async () => {
  trabajo._reiniciar();
  const evento = { clase: "mensaje", wamid: "wamid.U3", idCliente: "c", texto: "x" };
  fs.writeFileSync(
    trabajo.ARCHIVO,
    `${JSON.stringify({ wamid: "wamid.U3", estado: "agotado", intentos: 3, creadoEn: Date.now(), actualizadoEn: Date.now(), evento })}\n`
  );
  trabajo._olvidarMemoria();

  const resumen = await recuperarPendientes({ atender: async () => assert.fail("no deberia reintentar un agotado") });
  assert.equal(resumen.agotados, 1);
  assert.equal(resumen.revisados, 0);
});

// --------------------------------------------------------------------------
// EL CANDADO DE ENVIO, incluso durante la recuperacion
// --------------------------------------------------------------------------

test("RESPUESTA_AUTOMATICA=0 impide enviar tambien durante la recuperacion", async () => {
  // La recuperacion no tiene un camino de envio propio: usa el cerebro, que
  // usa el emisor, que comprueba el interruptor. Hereda el candado sin tener
  // que acordarse de nada.
  const { crearEmisor, PERMISOS } = require("../src/whatsapp/enviar");
  let intentos = 0;
  const emisor = crearEmisor({
    config: { respuestaAutomatica: false, whatsappToken: "t", idNumero: "1", versionGraph: "v21.0" },
    fetchImpl: async () => {
      intentos++;
      throw new Error("no deberia llamarse");
    },
  });

  const r = await emisor.enviarTexto({ para: "573001234567", texto: "recuperado", permiso: PERMISOS.CONVERSACION });
  assert.equal(r.enviado, false);
  assert.equal(intentos, 0);
});

test("MODO_SOMBRA=0 no puede saltarse el candado de envio", () => {
  // MODO_SOMBRA decide si se PROCESA el mensaje. El envio lo decide
  // RESPUESTA_AUTOMATICA, en otro modulo. Son dos interruptores distintos y
  // apagar uno no enciende el otro.
  const { crearEmisor, PERMISOS, MOTIVOS_BLOQUEO } = require("../src/whatsapp/enviar");
  for (const modoSombra of [true, false]) {
    const emisor = crearEmisor({
      config: { modoSombra, respuestaAutomatica: false, whatsappToken: "t", idNumero: "1", versionGraph: "v21.0" },
      fetchImpl: async () => assert.fail("se intento enviar"),
    });
    const r = emisor.revisarPermiso({ para: "5730011", texto: "hola", permiso: PERMISOS.CONVERSACION });
    assert.equal(r.puede, false, `con MODO_SOMBRA=${modoSombra} se permitio enviar`);
    assert.equal(r.motivo, MOTIVOS_BLOQUEO.INTERRUPTOR);
  }
});

test(
  "ESCENARIO: con MODO_SOMBRA=0 el servidor no envia nada",
  { timeout: 60000 },
  async () => {
    const dir = carpetaNueva();
    const puerto = puertoLibre();
    const cuerpo = cuerpoDeMensaje("wamid.SINSOMBRA");

    const servidor = await arrancarServidor({ dir, puerto, extra: { MODO_SOMBRA: "0" } });
    await fetch(`http://127.0.0.1:${puerto}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": firmar(cuerpo) },
      body: cuerpo,
    });
    await new Promise((r) => setTimeout(r, 900));

    const metricas = await (await fetch(`http://127.0.0.1:${puerto}/metricas?token=panel_de_prueba`)).json();
    await matarDeGolpe(servidor);

    assert.equal(metricas.salud.respuestas_enviadas, 0);
    // Con el modo sombra apagado el evento se registra pero no se procesa.
    assert.ok(tipos(dir).includes("sin_responder"));
  }
);

// --------------------------------------------------------------------------
// El producto inactivo no se puede vender
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// UN BORRADOR SE IDENTIFICA, PERO NO SE VENDE
//
// Estas pruebas miraban el cinturon del repositorio y exigian que estuviera
// INACTIVO. Servia mientras el cinturon era el unico producto y estaba en
// borrador; Marco cerro su ficha el 2026-10-07 y ya esta activo.
//
// La garantia NO era "el cinturon esta inactivo", era "un producto sin ficha
// se reconoce pero no se puede cobrar". Eso hay que seguir vigilandolo,
// porque se repite con cada producto nuevo: siempre entran antes las fotos y
// el nombre que los precios aprobados.
//
// Asi que ahora se comprueba sobre un BORRADOR SINTETICO, escrito a disco y
// cargado por el cargador de verdad -con sus alias compilados igual que los
// reales-. Ademas de seguir cubriendo la garantia, la prueba deja de
// depender del estado comercial de un producto de la tienda.
// --------------------------------------------------------------------------

const ID_BORRADOR = "producto-en-borrador-de-prueba";

/** Carpeta de catalogo con UN borrador. Devuelve el catalogo ya cargado. */
function catalogoConBorrador() {
  const { cargarCatalogo } = require("../src/catalogo");
  const carpeta = carpetaNueva();
  fs.writeFileSync(
    path.join(carpeta, `${ID_BORRADOR}.json`),
    JSON.stringify({
      id: ID_BORRADOR,
      nombre: "",
      categoria: "bienestar",
      activo: false,
      aliases: [
        { patron: "\\bmanta\\s+termic", confianza: "alta", senal: "manta termica" },
        { patron: "\\bmanta(s)?\\b", confianza: "media", senal: "manta" },
      ],
      descripcionAutorizada: "",
      motorDePrecio: "tabla",
      precios: {},
      claimsProhibidos: ["cura el dolor"],
      pendientes: ["precio", "descripcion autorizada"],
    })
  );
  return cargarCatalogo({ carpeta, refrescar: true });
}

test("un borrador existe en el catalogo pero no entra en los activos", () => {
  const catalogo = catalogoConBorrador();
  const borrador = catalogo.porId.get(ID_BORRADOR);

  assert.ok(borrador, "el borrador tiene que existir en el catalogo");
  assert.equal(borrador.activo, false);
  assert.ok(borrador.pendientes.length > 0, "un borrador sin pendientes podria activarse por descuido");

  assert.equal(catalogo.activos.length, 0);
  assert.equal(catalogo.productoPorDefecto, null);
});

test("las señales SI identifican un borrador, pero lo marcan como no vendible", () => {
  // La version original de esta prueba afirmaba lo contrario -"las señales
  // NUNCA proponen un producto inactivo"- y estaba mal: confundia
  // IDENTIFICAR con OFRECER. Con el unico producto en borrador, NINGUN
  // mensaje podia identificar nada, y el bot preguntaba que producto queria
  // en cada turno, para siempre. No perdia la venta por prudencia: la perdia
  // por no saber de que le hablaban.
  const senales = require("../src/catalogo/senales");
  const catalogo = catalogoConBorrador();

  // Con tilde y sin tilde: la clienta escribe desde el movil y el teclado
  // pone la tilde sola.
  for (const frase of ["quiero la manta termica", "muéstrame fotos de la manta", "tienes mantas térmicas?"]) {
    const encontradas = senales.senalesEnTexto(frase, catalogo);
    assert.equal(encontradas.length, 1, `"${frase}" no identifico el producto del que habla la clienta`);
    assert.equal(encontradas[0].productoId, ID_BORRADOR);

    // La marca que sostiene todo lo demas: quien recibe la señal sabe que no
    // se puede vender sin volver a consultar el catalogo.
    assert.equal(encontradas[0].activo, false, `"${frase}" presento un borrador como vendible`);

    const r = senales.resolver({ texto: frase, catalogo });
    assert.equal(r.productoId, ID_BORRADOR);
    assert.equal(catalogo.porId.get(r.productoId).activo, false);
  }

  // Identificarlo no lo mete en los activos, que es la lista de la que se
  // vende.
  assert.equal(catalogo.activos.length, 0);
});

test("identificar un borrador no abre ninguna puerta: no se cotiza", () => {
  // La contraparte: si la señal llega hasta un borrador, hay que demostrar
  // que el camino se corta DESPUES, en el candado real.
  const { cotizar } = require("../src/dominio/cotizador");
  const borrador = catalogoConBorrador().porId.get(ID_BORRADOR);

  for (const cantidad of [1, 2, 3]) {
    const r = cotizar({ producto: borrador, cantidad });
    assert.equal(r.ok, false, `se cotizo un borrador para cantidad ${cantidad}`);
    assert.match(r.motivo, /no esta activo/);
    assert.equal(r.total, undefined);
  }
});

test("el cotizador se niega a cotizar un producto inactivo", () => {
  const { cotizar } = require("../src/dominio/cotizador");
  const r = cotizar({
    producto: { id: "cinturon-termico-colicos", nombre: "x", activo: false, motorDePrecio: "tabla", precios: { 1: 1000 } },
    cantidad: 1,
  });
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no esta activo/);
});

test("una conversacion con un producto inactivo no se cotiza, pero tampoco se olvida", async () => {
  // El caso real: se guarda la conversacion con un producto, el producto se
  // desactiva, y la conversacion se recarga del disco. El cerebro no puede
  // seguir vendiendolo.
  //
  // ESTA PRUEBA ANTES EXIGIA LO PEOR DE DOS MUNDOS.
  //
  // Se llamaba "...vuelve a DESCONOCIDO" y comprobaba dos cosas:
  // situacion === "producto_desconocido" y conv.productoId === null. La
  // segunda era el defecto, no la proteccion: borrar el productoId hacia
  // que el turno siguiente tampoco supiera de que se hablaba, asi que el
  // bot preguntaba "¿que producto te interesa?" indefinidamente -incluso
  // despues de que la clienta lo hubiera dicho con todas sus letras.
  //
  // Olvidar el producto no impedia venderlo: eso lo impide `cotizar()`.
  // Solo impedia CONVERSAR. Ahora el producto se conserva, la situacion
  // dice la verdad ("esta en borrador"), y se comprueba aqui que de ahi no
  // sale ni una cotizacion, ni un pedido, ni una cifra.
  const { config } = require("../src/config");
  const { crearCerebro } = require("../src/cerebro/orquestar");
  const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
  const { crearCliente } = require("../src/ia/cliente");
  const { crearEmisor } = require("../src/whatsapp/enviar");

  const inactivo = {
    id: "borrador-x",
    nombre: "Borrador",
    activo: false,
    aliases: [],
    _aliases: [],
    motorDePrecio: "tabla",
    precios: {},
  };
  const catalogo = {
    productos: [inactivo],
    activos: [],
    porId: new Map([[inactivo.id, inactivo]]),
    productoPorDefecto: null,
  };

  const repos = await crearReposDeArchivos({ dir: carpetaNueva() });
  await repos.conversaciones.guardar({
    contactoId: "573001234567",
    estado: "cotizado",
    productoId: "borrador-x", // quedo guardado de antes
    ficha: {},
  });

  const cfg = { ...config, respuestaAutomatica: false };
  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo,
    ia: crearCliente({ proveedor: null }),
    emisor: crearEmisor({ config: cfg, fetchImpl: async () => assert.fail("se intento enviar") }),
  });

  const traza = await cerebro.procesar({
    clase: "mensaje",
    wamid: "wamid.INACTIVO",
    idCliente: "573001234567",
    telefono: "573001234567",
    texto: "cuanto vale?",
  });

  assert.ok(
    traza.avisos.some((a) => /en borrador/.test(a) && /no se puede cotizar/.test(a)),
    `la traza tiene que decir por que no se cotiza. avisos: ${JSON.stringify(traza.avisos)}`
  );
  assert.equal(traza.respuesta.situacion, "producto_en_borrador");

  // Lo que NO pasa, que es el punto de la prueba:
  assert.equal(traza.cotizacion, null, "se cotizo un producto en borrador");
  assert.equal(traza.pedido, null, "se creo un pedido de un producto en borrador");
  assert.equal(traza.enviada, false, "en modo sombra no sale nada");

  // Ni una cifra en el texto. El mensaje de la clienta era "cuanto vale?",
  // que es justo el hueco donde un modelo rellena con un precio plausible.
  // Por eso este caso lo redacta el texto determinista y no la IA.
  const texto = traza.respuesta.texto || "";
  assert.ok(texto.length > 0, "contestar con un texto vacio es dejar a la clienta sin respuesta");
  assert.equal(/\$|\d{3,}/.test(texto), false, `el texto insinua un importe: ${texto}`);

  // Y lo que SI se conserva: de que se estaba hablando.
  const conv = await repos.conversaciones.obtener("573001234567");
  assert.equal(conv.productoId, "borrador-x", "se olvido el producto y el bot va a volver a preguntar");
  assert.notEqual(conv.estado, "confirmado");
});

// --------------------------------------------------------------------------
// REGRESIONES DEL PROPIO ARREGLO
//
// Los dos aparecieron al verificar la correccion, no al escribirla. Dejarlos
// anotados aqui importa porque los dos eran formas de romper algo que ya
// funcionaba mientras se arreglaba otra cosa.
// --------------------------------------------------------------------------

const { admitir } = require("../src/webhook/procesar");

// Las pruebas que llaman a admitir() DENTRO de este proceso tienen que usar
// el phone_number_id de la configuracion de prueba; si no, el filtro de
// aislamiento las descarta antes de llegar al reclamo, que es justo lo que
// se quiere comprobar.
const ID_LOCAL = require("../src/config").config.idNumero;
const cuerpoLocal = (wamid) => JSON.parse(cuerpoDeMensaje(wamid, "quiero comprar", ID_LOCAL));

test("REGRESION: un replay de un evento ya terminado NO rompe la admision", () => {
  // SINTOMA: el replay normal de Meta se contestaba con 503.
  //
  // CAUSA: `admitir` contaba como "no durable" cualquier reclamo rechazado.
  // Un replay siempre se rechaza -por "terminado"-, asi que un duplicado
  // perfectamente normal se trataba como fallo de disco.
  //
  // CONSECUENCIA: le dices a Meta que reintente algo que ya esta hecho, y un
  // 5xx repetido acaba desactivando la suscripcion. Es decir: arreglando la
  // perdida de un mensaje se abria la puerta a perderlos todos.
  trabajo._reiniciar();

  const cuerpo = cuerpoLocal("wamid.RE1");
  const primera = admitir(cuerpo, "e1");
  assert.equal(primera.durable, true);
  assert.equal(primera.mensajes, 1);

  trabajo.terminar("wamid.RE1");

  const segunda = admitir(cuerpo, "e2");
  assert.equal(segunda.durable, true, "un replay de algo ya terminado se trato como no durable");
  assert.equal(segunda.admitidos[0].reclamo.ok, false);
  assert.equal(segunda.admitidos[0].reclamo.motivo, "terminado");
});

test("un evento en curso tambien es durable: ya sabemos de el", () => {
  trabajo._reiniciar();
  const cuerpo = cuerpoLocal("wamid.RE2");
  admitir(cuerpo, "e1");
  const segunda = admitir(cuerpo, "e2"); // sin terminar: sigue reclamado
  assert.equal(segunda.durable, true);
  assert.equal(segunda.admitidos[0].reclamo.motivo, "en_curso");
});

test("un lote sin mensajes (solo acuses) es durable y no reclama trabajo", () => {
  trabajo._reiniciar();
  const soloEstado = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "W",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: ID_LOCAL },
              statuses: [{ id: "wamid.EST", status: "delivered", recipient_id: "573009998877" }],
            },
          },
        ],
      },
    ],
  };
  const r = admitir(soloEstado, "e1");
  assert.equal(r.durable, true);
  assert.equal(r.mensajes, 0);
  assert.equal(trabajo.estado().total, 0, "un acuse de entrega no deberia reclamar trabajo");
});

test("un evento de otro numero no reclama trabajo", () => {
  // No tiene sentido guardar trabajo pendiente de un numero que no es
  // nuestro: nunca habria que procesarlo.
  trabajo._reiniciar();
  const ajeno = cuerpoLocal("wamid.AJENO");
  ajeno.entry[0].changes[0].value.metadata.phone_number_id = "999999999999999";
  const r = admitir(ajeno, "e1");
  assert.equal(r.admitidos.length, 0);
  assert.equal(trabajo.estado().total, 0);
});

test("REGRESION: evento_recuperado se cuenta UNA vez, no dos", async () => {
  // SINTOMA: las metricas decian recuperados=2 habiendo recuperado 1.
  // CAUSA: el contador se incrementaba en atenderEvento y otra vez en
  // recuperarPendientes.
  // Un contador que miente es peor que no tenerlo: con el se toman
  // decisiones sobre si hay un problema de estabilidad o no.
  const metricas = require("../src/metricas");
  metricas._reiniciar();
  trabajo._reiniciar();

  const evento = { clase: "mensaje", wamid: "wamid.CONTEO", idCliente: "573001112233", texto: "hola" };
  trabajo.reclamar("wamid.CONTEO", { evento });
  trabajo._olvidarMemoria();

  await recuperarPendientes({
    atender: async (ev) => {
      metricas.incrementar("evento_recuperado"); // lo que hace atenderEvento
      trabajo.terminar(ev.wamid);
      return { accion: "procesado" };
    },
  });

  assert.equal(metricas.valor("evento_recuperado"), 1);
});
