"use strict";

// ==========================================================================
// DEFECTOS DE LA VENTANA DE CONGELACION Y DEL FALLO DE TURNO
//
// Cuatro agujeros encontrados por una revision independiente sobre 5649e27.
// Los tres primeros los reporto la revision; el cuarto salio de comprobar
// que pasa con la RETRANSMISION despues de un fallo de escritura, y es el
// peor de los cuatro.
//
//   1. La recuperacion ignoraba la congelacion: al arrancar llamaba al
//      cerebro y marcaba el evento como terminado aunque siguiera congelado,
//      consumiendo un intento. La congelacion dejaba de ser una compuerta y
//      pasaba a ser un retraso de un reinicio.
//
//   2. Si el cerebro lanzaba, manejarMensaje() devolvia `fallo:true` pero
//      atenderEvento() llamaba a trabajo.terminar() de todas formas. El
//      evento quedaba cerrado sin haberse procesado: ni se recuperaba, ni
//      se agotaba, ni aparecia en ninguna lista. Se perdia en silencio.
//
//   3. Congelado + fallo al escribir trabajo.jsonl: el `continue` de la rama
//      de congelacion saltaba la comprobacion de `persistido`, asi que
//      admitir() devolvia durable:true y se contestaba 200 sin respaldo.
//
//   4. Tras un fallo de escritura se devuelve 503 y Meta retransmite. Pero
//      el registro SI estaba en el indice en memoria, asi que la
//      retransmision se descartaba como "en_curso" y se contestaba 200.
//      El mensaje quedaba sin rastro en disco y sin nadie que lo reclamara:
//      perdido. El propio mecanismo de rescate lo mataba.
//
// Las pruebas estan escritas como ESCENARIOS, no como comprobaciones de
// implementacion: describen lo que le pasa al mensaje de un cliente.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ayuda = require("./ayuda");
const dir = ayuda.entornoDePrueba();

// El cerebro se sustituye ANTES de requerir procesar.js, porque procesar.js
// desestructura `obtenerCerebro` al cargarse. Asi ninguna prueba de este
// archivo necesita IA, red ni catalogo, y el fallo del cerebro se puede
// provocar a voluntad.
const moduloCerebro = require("../src/cerebro");
let modoCerebro = "ok";
let vecesQueSeLlamoAlCerebro = 0;

moduloCerebro.obtenerCerebro = async () => ({
  procesar: async () => {
    vecesQueSeLlamoAlCerebro++;
    if (modoCerebro === "lanza") throw new Error("fallo simulado del cerebro");
    return {
      enviada: false,
      estadoNuevo: "saludo",
      respuesta: { situacion: "saludo" },
      pedido: null,
    };
  },
});

const procesar = require("../src/webhook/procesar");
const trabajo = require("../src/almacen/trabajo");
const congelacion = require("../src/almacen/congelar");
const { recuperarPendientes } = require("../src/webhook/recuperar");

/** Deja el entorno como recien arrancado, sin marca de congelacion. */
function limpiar() {
  modoCerebro = "ok";
  vecesQueSeLlamoAlCerebro = 0;
  congelacion.descongelar(dir);
  // rmSync recursivo porque algunas pruebas ponen una CARPETA en la ruta del
  // archivo para forzar el fallo de escritura.
  try {
    fs.rmSync(trabajo.ARCHIVO, { recursive: true, force: true });
  } catch {
    /* ignorado */
  }
  trabajo._olvidarMemoria();
}

/** Convierte la ruta de trabajo.jsonl en una carpeta: appendFileSync -> EISDIR. */
function romperLaEscrituraDeTrabajo() {
  try {
    fs.rmSync(trabajo.ARCHIVO, { recursive: true, force: true });
  } catch {
    /* ignorado */
  }
  fs.mkdirSync(trabajo.ARCHIVO, { recursive: true });
}

function repararLaEscrituraDeTrabajo() {
  fs.rmSync(trabajo.ARCHIVO, { recursive: true, force: true });
}

/** Entradas del diario de un tipo concreto. */
function delDiario(tipo) {
  return ayuda.leerDiario(dir).filter((e) => e.tipo === tipo);
}

/** El registro de trabajo de un wamid, leido del DISCO (no de memoria). */
function registroEnDisco(wamid) {
  if (!fs.existsSync(trabajo.ARCHIVO)) return null;
  if (fs.statSync(trabajo.ARCHIVO).isDirectory()) return null;
  const lineas = fs.readFileSync(trabajo.ARCHIVO, "utf8").split("\n").filter(Boolean);
  let ultimo = null;
  for (const l of lineas) {
    const r = JSON.parse(l);
    if (r.wamid === wamid) ultimo = r;
  }
  return ultimo;
}

// ==========================================================================
// 1 · La recuperacion tiene que respetar la congelacion
// ==========================================================================

describe("1 · congelado: la recuperacion no procesa ni gasta intentos", () => {
  test("ESCENARIO: congelado -> mensaje diferido -> reinicio -> sigue congelado", async () => {
    limpiar();
    congelacion.congelar(dir, "cutover");

    // El diario es un archivo por dia y acumula entre pruebas del mismo
    // archivo, asi que se mide la DIFERENCIA, no el total.
    const mensajesAntes = delDiario("mensaje").length;

    const wamid = "wamid.CONGELADO.1";
    const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid, texto: "quiero uno" }), "e1");

    // Se reclamo y se difirio, y se contesta 200: eso es lo correcto.
    assert.equal(admision.congelado, true);
    assert.equal(admision.durable, true, "el reclamo si llego al disco");
    assert.equal(admision.admitidos.length, 1);
    assert.equal(admision.admitidos[0].diferido, true);

    await procesar.procesarAdmitidos(admision.admitidos, "e1");
    assert.equal(vecesQueSeLlamoAlCerebro, 0, "diferido: el cerebro no se toca");
    assert.equal(trabajo.estado().reclamados, 1);
    assert.equal(trabajo.estado().terminados, 0);

    // --- Reinicio del proceso. La marca de congelacion vive en disco, asi
    //     que al arrancar SIGUE congelado. ---
    trabajo._olvidarMemoria();
    assert.equal(congelacion.estado(dir).congelado, true, "la congelacion sobrevive al reinicio");

    const resumen = await recuperarPendientes();

    // LO QUE IMPORTA: seguimos congelados, asi que el mensaje NO se procesa.
    assert.equal(vecesQueSeLlamoAlCerebro, 0, "congelado: la recuperacion NO puede llamar al cerebro");
    assert.equal(delDiario("mensaje").length, mensajesAntes, "congelado: no se maneja el mensaje");

    // Y sigue pendiente, no cerrado.
    const estado = trabajo.estado();
    assert.equal(estado.terminados, 0, "congelado: la recuperacion NO puede terminar el evento");
    assert.equal(estado.reclamados, 1, "el evento sigue pendiente");
    assert.equal(estado.agotados, 0);

    // Y no se gasto un intento: si no se intento nada, no se consume nada.
    // Sin esto, tres reinicios durante un cutover agotarian el mensaje y lo
    // dejarian fuera para siempre.
    assert.equal(registroEnDisco(wamid).intentos, 1, "congelado: no se consume un intento");

    assert.equal(resumen.recuperados, 0);
    assert.equal(resumen.fallidos, 0);
    assert.equal(resumen.agotados, 0);
  });

  test("y al descongelar y reiniciar, ese mismo mensaje SI se procesa", async () => {
    limpiar();
    congelacion.congelar(dir, "cutover");

    const wamid = "wamid.CONGELADO.2";
    const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid, texto: "quiero uno" }), "e2");
    await procesar.procesarAdmitidos(admision.admitidos, "e2");

    // Dos reinicios congelado: sigue intacto y sin gastar intentos.
    for (const _ of [1, 2]) {
      trabajo._olvidarMemoria();
      await recuperarPendientes();
    }
    assert.equal(trabajo.estado().reclamados, 1);
    assert.equal(registroEnDisco(wamid).intentos, 1, "ni dos reinicios gastan intentos");

    // Descongelar + reiniciar.
    congelacion.descongelar(dir);
    trabajo._olvidarMemoria();
    const resumen = await recuperarPendientes();

    assert.equal(vecesQueSeLlamoAlCerebro, 1, "descongelado: ahora si se procesa");
    assert.equal(resumen.recuperados, 1);
    assert.equal(trabajo.estado().terminados, 1);
    assert.equal(trabajo.estado().reclamados, 0);
  });

  test("atenderEvento respeta la congelacion aunque lo llamen directo", async () => {
    // El candado no puede depender de quien llame. Si solo estuviera en
    // recuperarPendientes(), cualquier camino nuevo lo saltaria.
    limpiar();
    congelacion.congelar(dir, "cutover");

    const { normalizar } = require("../src/webhook/normalizar");
    const [evento] = normalizar(ayuda.payloadDeTexto({ wamid: "wamid.DIRECTO.1" }));

    const r = await procesar.atenderEvento(evento, { idEntrega: "directo" });

    assert.equal(r.accion, "diferido", "congelado: atenderEvento difiere");
    assert.equal(vecesQueSeLlamoAlCerebro, 0);
    assert.equal(trabajo.estado().terminados, 0);
  });

  test("congelado, un acuse de entrega SI se registra", async () => {
    // La congelacion protege el almacen transaccional. Un acuse de entrega
    // no escribe ahi -solo en el diario-, y un `failed` es la unica senal de
    // que Meta acepto un mensaje y no lo entrego. Perderlo no ayuda a nadie.
    limpiar();
    congelacion.congelar(dir, "cutover");

    const antes = delDiario("estado").length;
    const admision = procesar.admitir(ayuda.payloadDeEstado({ wamid: "wamid.ESTADO.CONG" }), "e3");
    await procesar.procesarAdmitidos(admision.admitidos, "e3");

    assert.equal(delDiario("estado").length, antes + 1, "el acuse se registra igual");
  });
});

// ==========================================================================
// 2 · Un turno que falla no puede quedar cerrado
// ==========================================================================

describe("2 · si el cerebro lanza, el evento queda recuperable", () => {
  test("ESCENARIO: el cerebro lanza -> el evento NO se termina", async () => {
    limpiar();
    modoCerebro = "lanza";

    const wamid = "wamid.FALLO.1";
    const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid }), "f1");
    assert.equal(admision.durable, true);

    const [r] = await procesar.procesarAdmitidos(admision.admitidos, "f1");

    assert.equal(vecesQueSeLlamoAlCerebro, 1);
    assert.equal(r.fallo, true, "el fallo se reporta");
    assert.equal(delDiario("fallo_del_cerebro").length, 1, "y queda en el diario");

    // LO QUE IMPORTA: un turno que fallo NO esta terminado.
    const enDisco = registroEnDisco(wamid);
    assert.notEqual(enDisco.estado, trabajo.ESTADOS.TERMINADO, "un turno fallido NO puede quedar terminado");
    assert.equal(enDisco.estado, trabajo.ESTADOS.RECLAMADO, "queda reclamado, es decir recuperable");
    assert.equal(trabajo.estado().terminados, 0);
    assert.equal(trabajo.estado().reclamados, 1);

    // Y aparece en la lista de pendientes, que es lo que lo rescata.
    trabajo._olvidarMemoria();
    assert.equal(
      trabajo.paraRecuperar().filter((p) => p.wamid === wamid).length,
      1,
      "tiene que estar en la lista de recuperacion"
    );
  });

  test("y se recupera en cuanto el fallo desaparece", async () => {
    limpiar();
    modoCerebro = "lanza";

    const wamid = "wamid.FALLO.2";
    const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid }), "f2");
    await procesar.procesarAdmitidos(admision.admitidos, "f2");
    assert.equal(trabajo.estado().terminados, 0);

    // El cerebro se arregla (se despliega el arreglo) y el servicio arranca.
    modoCerebro = "ok";
    trabajo._olvidarMemoria();
    const mensajesAntes = delDiario("mensaje").length;
    const resumen = await recuperarPendientes();

    assert.equal(resumen.recuperados, 1, "se recupera solo");
    assert.equal(trabajo.estado().terminados, 1, "ahora si queda terminado");
    assert.equal(delDiario("mensaje").length, mensajesAntes + 1, "y el mensaje se manejo de verdad");
  });

  test("un fallo determinista se agota en MAX_INTENTOS, no reintenta para siempre", async () => {
    limpiar();
    modoCerebro = "lanza";

    const wamid = "wamid.FALLO.3";
    const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid }), "f3");
    await procesar.procesarAdmitidos(admision.admitidos, "f3");

    // Reinicios sucesivos con el fallo siempre presente.
    for (let i = 0; i < trabajo.MAX_INTENTOS + 2; i++) {
      trabajo._olvidarMemoria();
      await recuperarPendientes();
    }

    const enDisco = registroEnDisco(wamid);
    assert.equal(enDisco.estado, trabajo.ESTADOS.AGOTADO, "se rinde en vez de girar para siempre");
    assert.ok(enDisco.intentos >= trabajo.MAX_INTENTOS, `intentos=${enDisco.intentos}`);

    // Agotado = una persona tiene que mirarlo. No puede desaparecer callado.
    trabajo._olvidarMemoria();
    assert.equal(trabajo.agotados().filter((r) => r.wamid === wamid).length, 1);
    assert.ok(delDiario("trabajo_agotado").length >= 1, "se grita en el diario");
  });
});

// ==========================================================================
// 3 · No se contesta 200 sin respaldo en disco, ni congelado
// ==========================================================================

describe("3 · congelado + fallo de escritura: no hay 200", () => {
  test("ESCENARIO: congelado y el disco no acepta la escritura", async () => {
    limpiar();
    congelacion.congelar(dir, "cutover");
    romperLaEscrituraDeTrabajo();

    try {
      const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid: "wamid.NODURABLE.1" }), "n1");

      assert.equal(admision.congelado, true);
      assert.equal(admision.mensajes, 1);

      // LO QUE IMPORTA: sin respaldo en disco no hay recuperacion posible,
      // asi que no se puede contestar 200 -ni estando congelado-. Que Meta
      // reintente es la unica salida que no pierde el mensaje.
      assert.equal(admision.sinRespaldoEnDisco, 1, "se tiene que contar el fallo de escritura");
      assert.equal(admision.durable, false, "congelado NO exime de tener respaldo en disco");
    } finally {
      repararLaEscrituraDeTrabajo();
    }
  });

  test("sin congelar, el fallo de escritura ya se detectaba (no se rompe)", async () => {
    limpiar();
    romperLaEscrituraDeTrabajo();
    try {
      const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid: "wamid.NODURABLE.2" }), "n2");
      assert.equal(admision.durable, false);
      assert.equal(admision.sinRespaldoEnDisco, 1);
    } finally {
      repararLaEscrituraDeTrabajo();
    }
  });

  // ----------------------------------------------------------------------
  // Y lo mismo por HTTP, porque lo que importa es el CODIGO que ve Meta.
  // `durable:false` es un detalle interno; el 503 es el contrato.
  // ----------------------------------------------------------------------
  test("ESCENARIO POR HTTP: congelado + disco roto -> Meta recibe 503, no 200", async () => {
    limpiar();
    const crypto = require("node:crypto");
    const { crearApp } = require("../src/app");

    const firmar = (cuerpo) =>
      `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(cuerpo).digest("hex")}`;

    const servidor = await ayuda.levantar(crearApp());
    try {
      congelacion.congelar(dir, "cutover");
      romperLaEscrituraDeTrabajo();

      const crudo = JSON.stringify(ayuda.payloadDeTexto({ wamid: "wamid.HTTP.NODURABLE" }));
      const r = await fetch(`${servidor.url}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": firmar(crudo) },
        body: crudo,
      });

      // LO QUE IMPORTA: 503. Meta reintenta durante 36 horas, asi que el
      // mensaje sobrevive. Un 200 aqui lo habria dado por entregado con
      // nada en disco que lo respaldara.
      assert.equal(r.status, 503, "congelado y sin disco: no se puede contestar 200");
    } finally {
      repararLaEscrituraDeTrabajo();
      await servidor.cerrar();
    }
  });

  test("y con el disco bien, congelado SI contesta 200", async () => {
    // El contraste importa: congelar no puede costar ventas. Si congelado
    // devolviera 503 siempre, un cutover de 10 minutos seria una carrera
    // contra la ventana de reintentos de Meta.
    limpiar();
    const crypto = require("node:crypto");
    const { crearApp } = require("../src/app");

    const firmar = (cuerpo) =>
      `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(cuerpo).digest("hex")}`;

    const servidor = await ayuda.levantar(crearApp());
    try {
      congelacion.congelar(dir, "cutover");

      const crudo = JSON.stringify(ayuda.payloadDeTexto({ wamid: "wamid.HTTP.CONGELADO" }));
      const r = await fetch(`${servidor.url}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": firmar(crudo) },
        body: crudo,
      });

      assert.equal(r.status, 200, "congelado con disco sano: 200 y el trabajo queda reclamado");
      await new Promise((listo) => setTimeout(listo, 60));

      assert.equal(vecesQueSeLlamoAlCerebro, 0, "pero NO se procesa");
      assert.equal(trabajo.estado().reclamados, 1, "queda pendiente para cuando se descongele");
      assert.equal(trabajo.estado().terminados, 0);
    } finally {
      await servidor.cerrar();
    }
  });
});

// ==========================================================================
// 4 · La retransmision despues de un fallo de escritura
// ==========================================================================

describe("4 · tras el 503, la retransmision de Meta se tiene que poder reclamar", () => {
  test("ESCENARIO: falla la escritura -> 503 -> Meta retransmite -> el disco ya va bien", async () => {
    limpiar();
    const wamid = "wamid.RETRANS.1";

    // --- Primera entrega: el disco no acepta la escritura. ---
    romperLaEscrituraDeTrabajo();
    let primera;
    try {
      primera = procesar.admitir(ayuda.payloadDeTexto({ wamid }), "r1");
      assert.equal(primera.durable, false, "no durable -> la ruta contesta 503");
    } finally {
      repararLaEscrituraDeTrabajo();
    }

    // Nada se proceso: con durable:false la ruta devuelve 503 y no procesa.
    assert.equal(vecesQueSeLlamoAlCerebro, 0);

    // --- Meta retransmite. El disco ya funciona. ---
    // EL DEFECTO: el registro habia quedado en el indice EN MEMORIA, asi que
    // la retransmision se veia como "en_curso", se descartaba como duplicado
    // y se contestaba 200. El mensaje no estaba en disco y nadie lo iba a
    // reclamar: perdido, y justo por el mecanismo que deberia rescatarlo.
    const segunda = procesar.admitir(ayuda.payloadDeTexto({ wamid }), "r2");

    assert.equal(segunda.durable, true, "la retransmision si se puede reclamar ahora");
    assert.equal(segunda.admitidos.length, 1);
    const { reclamo } = segunda.admitidos[0];
    assert.equal(reclamo.ok, true, "la retransmision NO es un duplicado: nunca se acepto la primera");

    await procesar.procesarAdmitidos(segunda.admitidos, "r2");

    assert.equal(vecesQueSeLlamoAlCerebro, 1, "el mensaje acaba procesandose");
    assert.equal(trabajo.estado().terminados, 1);
    assert.equal(registroEnDisco(wamid).estado, trabajo.ESTADOS.TERMINADO);
  });

  test("un fallo de escritura no deja un registro fantasma en memoria", () => {
    limpiar();
    const wamid = "wamid.RETRANS.2";

    romperLaEscrituraDeTrabajo();
    try {
      const r = trabajo.reclamar(wamid, { evento: { wamid } });
      assert.equal(r.ok, true);
      assert.equal(r.persistido, false, "el disco no acepto la escritura");

      // Si el reclamo no llego al disco, para todos los efectos no ocurrio.
      // Dejarlo en memoria envenena la retransmision.
      assert.equal(trabajo.estado().reclamados, 0, "no puede quedar un reclamo que no esta en disco");
    } finally {
      repararLaEscrituraDeTrabajo();
    }

    // Y el siguiente intento se trata como nuevo, no como duplicado.
    const otra = trabajo.reclamar(wamid, { evento: { wamid } });
    assert.equal(otra.ok, true);
    assert.equal(otra.motivo, "nuevo");
    assert.equal(otra.persistido, true);
  });

  test("y el duplicado de verdad -uno ya terminado- sigue descartandose", () => {
    // La correccion no puede abrir la puerta a reprocesar lo ya hecho.
    limpiar();
    const wamid = "wamid.RETRANS.3";

    const primera = trabajo.reclamar(wamid, { evento: { wamid } });
    assert.equal(primera.ok, true);
    trabajo.terminar(wamid, { accion: "procesado" });

    const replay = trabajo.reclamar(wamid, { evento: { wamid } });
    assert.equal(replay.ok, false);
    assert.equal(replay.motivo, "terminado", "el candado antiduplicados sigue cerrado");
  });

  test("y una segunda entrega mientras se procesa sigue siendo 'en_curso'", () => {
    limpiar();
    const wamid = "wamid.RETRANS.4";

    const primera = trabajo.reclamar(wamid, { evento: { wamid } });
    assert.equal(primera.ok, true);
    assert.equal(primera.persistido, true, "esta si llego al disco");

    // Reclamado y persistido: una segunda entrega es el mismo trabajo en
    // curso, no trabajo nuevo.
    const segunda = trabajo.reclamar(wamid, { evento: { wamid } });
    assert.equal(segunda.ok, false);
    assert.equal(segunda.motivo, "en_curso");
  });
});

// ==========================================================================
// 5 · Los turnos que ya estaban EN CURSO al congelar
// ==========================================================================
//
// Congelar frena los turnos nuevos, no los que ya pasaron la compuerta. El
// webhook contesta 200 y procesa despues, asi que un turno en vuelo puede
// guardar un pedido cientos de milisegundos despues de que la marca de
// congelacion exista.
//
// La barrera de reposo es como se espera a que drenen: se mira el origen, se
// espera, y se vuelve a mirar. Dos miradas iguales = nadie escribiendo.
//
// Se prueba con archivos a los dos lados a proposito: la barrera usa
// `_inventario()`, que es parte del contrato, asi que no depende del backend
// y esta prueba corre siempre, con base de datos o sin ella.
// ==========================================================================

describe("5 · barrera de reposo: los turnos en curso al congelar", () => {
  const os = require("node:os");
  const { copiar, REPOSO_MS, INTENTOS_DE_REPOSO } = require("../src/cutover");
  const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
  const { cotizar } = require("../src/dominio/cotizador");
  const dominioPedido = require("../src/dominio/pedido");

  const producto = {
    id: "producto-x",
    nombre: "Producto X",
    activo: true,
    motorDePrecio: "tabla",
    precios: { 1: 89000 },
    logistica: { politicaEnvio: { tipo: "incluido" } },
  };

  function pedidoNuevo(ofertaId, wamid) {
    const cot = cotizar({
      producto,
      cantidad: 1,
      destino: { ciudad: "Medellín", departamento: "Antioquia" },
    }).cotizacion;
    return dominioPedido.construir({
      cotizacion: cot,
      datos: {
        nombre: "Ana Pérez",
        telefono: "3001112233",
        ciudad: "Medellín",
        departamento: "Antioquia",
        direccion: "Calle 45 # 23-10",
      },
      contactoId: "573001112233",
      conversacionId: "573001112233",
      ofertaId,
      wamidConfirmacion: wamid,
    }).pedido;
  }

  async function dosLados() {
    const dirOrigen = fs.mkdtempSync(path.join(os.tmpdir(), "novika-rep-o-"));
    const dirDestino = fs.mkdtempSync(path.join(os.tmpdir(), "novika-rep-d-"));
    const origen = await crearReposDeArchivos({ dir: dirOrigen });
    const destino = await crearReposDeArchivos({ dir: dirDestino });
    await origen.contactos.guardar({ id: "573001112233", telefono: "3001112233" });
    await origen.pedidos.crearSiNoExiste(pedidoNuevo("of-1", "wamid.rep.1"));
    return { dirOrigen, origen, destino };
  }

  test("ESCENARIO: un turno en vuelo escribe justo despues de congelar", async () => {
    const { dirOrigen, origen, destino } = await dosLados();
    try {
      congelacion.congelar(dirOrigen, "cutover");

      // El turno en vuelo: guarda un pedido 20 ms despues de arrancar el
      // cutover, es decir DENTRO de la primera espera de la barrera.
      const enVuelo = new Promise((listo) => {
        setTimeout(async () => {
          await origen.pedidos.crearSiNoExiste(pedidoNuevo("of-en-vuelo", "wamid.rep.vuelo"));
          listo();
        }, 20);
      });

      const informe = await copiar({
        origen,
        destino,
        dirDatos: dirOrigen,
        reposoMs: 60,
        intentosDeReposo: 1,
      });
      await enVuelo;

      // LO QUE IMPORTA: no se copio NADA. La barrera lo paro antes, en vez
      // de copiar un origen en movimiento y descubrirlo al final.
      assert.ok(informe.problemas.length > 0, "la barrera tiene que parar el cutover");
      assert.match(informe.problemas.join(" "), /sigue cambiando/);
      assert.match(informe.problemas.join(" "), /turnos en curso/);
      assert.match(informe.problemas.join(" "), /No se copio nada/);

      assert.equal(informe.reposo.quieto, false);
      assert.equal((await destino.estado()).pedidos, 0, "destino intacto");
      // Y no se llego ni a la fase de copia.
      assert.equal(informe.pedidos.copiados, 0);
      assert.equal(informe.huellaDespues, undefined, "no hubo copia, no hay huella de despues");
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("en cuanto drenan, la barrera deja pasar y el cutover completa", async () => {
    const { dirOrigen, origen, destino } = await dosLados();
    try {
      congelacion.congelar(dirOrigen, "cutover");

      // Un turno que drena durante la PRIMERA espera y despues para. Con
      // varios intentos, la barrera lo absorbe sola.
      setTimeout(async () => {
        await origen.pedidos.crearSiNoExiste(pedidoNuevo("of-drena", "wamid.rep.drena"));
      }, 20);

      const informe = await copiar({
        origen,
        destino,
        dirDatos: dirOrigen,
        reposoMs: 60,
        intentosDeReposo: 3,
      });

      assert.deepEqual(informe.problemas, [], "tras drenar, el cutover completa");
      assert.equal(informe.reposo.quieto, true);
      assert.ok(informe.reposo.intentos >= 2, "hizo falta mas de una mirada");

      // Los DOS pedidos estan: el de antes y el que escribio el turno en
      // vuelo. Esperar a que drene es lo que impide dejarlo fuera.
      assert.equal(informe.pedidos.origen, 2);
      assert.equal((await destino.estado()).pedidos, 2, "no se perdio el pedido del turno en vuelo");
      assert.equal(informe.huellaAntes.resumen, informe.huellaDespues.resumen);
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("con el origen quieto, la barrera pasa a la primera", async () => {
    const { dirOrigen, origen, destino } = await dosLados();
    try {
      congelacion.congelar(dirOrigen, "cutover");
      const informe = await copiar({
        origen,
        destino,
        dirDatos: dirOrigen,
        reposoMs: 20,
        intentosDeReposo: 3,
      });

      assert.deepEqual(informe.problemas, []);
      assert.equal(informe.reposo.quieto, true);
      assert.equal(informe.reposo.intentos, 1, "una sola espera basta si nadie escribe");
      assert.equal((await destino.estado()).pedidos, 1);
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("la barrera NO sustituye a la huella de antes/despues", async () => {
    // Las dos hacen falta, y cubren ventanas distintas:
    //   barrera -> lo que se escribe ANTES de empezar a copiar
    //   huella  -> lo que se escribe DURANTE la copia
    // Quitar cualquiera de las dos deja un hueco.
    const { dirOrigen, origen, destino } = await dosLados();
    try {
      congelacion.congelar(dirOrigen, "cutover");

      // La escritura concurrente se engancha a la primera escritura del
      // destino, no a un setTimeout. Asi es DETERMINISTA: cuando ocurre, la
      // copia esta en marcha con seguridad, y la prueba no depende de que
      // el destino sea mas lento que el reloj.
      let yaEscribio = false;
      const destinoQueEscribeEnMedio = {
        ...destino,
        contactos: {
          ...destino.contactos,
          guardar: async (c) => {
            if (!yaEscribio) {
              yaEscribio = true;
              await origen.pedidos.crearSiNoExiste(pedidoNuevo("of-durante", "wamid.rep.durante"));
            }
            return destino.contactos.guardar(c);
          },
        },
      };

      // Barrera desactivada a proposito: se esta midiendo la huella sola.
      const informe = await copiar({
        origen,
        destino: destinoQueEscribeEnMedio,
        dirDatos: dirOrigen,
        reposoMs: 0,
      });

      assert.ok(yaEscribio, "el escenario no se reprodujo");
      assert.ok(informe.problemas.length > 0, "la huella tiene que cazar la escritura de en medio");
      assert.match(informe.problemas.join(" "), /EL ORIGEN CAMBIO DURANTE LA COPIA/);
      assert.notEqual(informe.huellaAntes.resumen, informe.huellaDespues.resumen);
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("los valores por defecto de la barrera son razonables", () => {
    // Si alguien los pone a 0 por comodidad, la barrera desaparece sin que
    // ninguna prueba se queje. Esto lo nota.
    assert.ok(REPOSO_MS >= 1000, `REPOSO_MS=${REPOSO_MS}: demasiado corto para un turno real`);
    assert.ok(INTENTOS_DE_REPOSO >= 2, `INTENTOS_DE_REPOSO=${INTENTOS_DE_REPOSO}: sin margen para drenar`);
  });
});

module.exports = {};
