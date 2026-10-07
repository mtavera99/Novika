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

// Para el escenario del turno bloqueado en el proveedor de IA (seccion 5):
// `puertaDeIA` es la promesa que lo deja esperando, y `escrituraDelTurno` es
// lo que el turno escribe cuando el proveedor por fin responde.
let puertaDeIA = null;
let escrituraDelTurno = null;
let turnoLlegoAlProveedor = null;

moduloCerebro.obtenerCerebro = async () => ({
  procesar: async () => {
    vecesQueSeLlamoAlCerebro++;
    if (modoCerebro === "lanza") throw new Error("fallo simulado del cerebro");

    if (modoCerebro === "bloquea") {
      // El turno ya paso la compuerta y tiene su trabajo RECLAMADO. Ahora
      // se queda esperando una respuesta de red que puede tardar lo que
      // quiera: es el caso que ninguna espera del cutover puede acotar.
      if (turnoLlegoAlProveedor) turnoLlegoAlProveedor();
      await puertaDeIA;
      if (escrituraDelTurno) await escrituraDelTurno();
    }

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
  puertaDeIA = null;
  escrituraDelTurno = null;
  turnoLlegoAlProveedor = null;
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
// 5 · DRENAJE VERIFICABLE DE LOS TURNOS EN VUELO
// ==========================================================================
//
// La version anterior del cutover esperaba 2 segundos y comparaba dos
// huellas del origen. Eso no prueba lo que hace falta: dos lecturas iguales
// solo dicen que no hubo escrituras ENTRE esas dos lecturas.
//
// El caso que la atraviesa entera -y el que se prueba aqui-:
//
//   1. un turno pasa la compuerta y se queda esperando al proveedor de IA
//   2. se congela
//   3. pasa la ventana de espera SIN una sola escritura
//      (el turno esta bloqueado en la red, no escribiendo)
//   4. el cutover se declara exitoso
//   5. el proveedor responde, el turno continua y GUARDA SU PEDIDO
//      en archivos, fuera de PostgreSQL
//
// Subir el tiempo de espera no lo arregla: el limite lo pone un servicio
// ajeno. Con Gemini configurado esto no es hipotetico.
//
// La solucion no es temporal, es estructural:
//
//   CONDICION 1  el servicio arranco DESPUES de congelar
//                (el reinicio mata el turno bloqueado; el proceso nuevo
//                 arranca congelado y su compuerta no deja empezar ninguno)
//
//   CONDICION 2  la bitacora no tiene turnos EN VUELO
//                (un turno solo puede escribir mientras su registro esta
//                 RECLAMADO sin marcar como diferido)
//
// Las pruebas simulan el reinicio llamando a registrarArranque() y
// recuperarPendientes(), que es exactamente lo que hace un arranque.
// ==========================================================================

describe("5 · drenaje verificable de los turnos en vuelo", () => {
  const os = require("node:os");
  const { copiar } = require("../src/cutover");
  const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
  const persistencia = require("../src/almacen/persistencia");
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

  /**
   * Origen DENTRO de DATA_DIR, como en produccion: el disco persistente
   * guarda `transaccional/`, `trabajo.jsonl`, `CONGELADO.json` y
   * `marcador-de-disco.json` juntos. Los candados del cutover leen los tres
   * ultimos, asi que tienen que estar donde de verdad estan.
   */
  async function montar() {
    // Se vacia: todas las pruebas de esta seccion comparten DATA_DIR -tiene
    // que ser el mismo para que los candados lean la bitacora y el marcador
    // de verdad- y una prueba anterior deja sus pedidos ahi.
    fs.rmSync(path.join(dir, "transaccional"), { recursive: true, force: true });
    const origen = await crearReposDeArchivos({ dir: path.join(dir, "transaccional") });
    const dirDestino = fs.mkdtempSync(path.join(os.tmpdir(), "novika-dest-"));
    const destino = await crearReposDeArchivos({ dir: dirDestino });
    await origen.contactos.guardar({ id: "573001112233", telefono: "3001112233" });
    await origen.pedidos.crearSiNoExiste(pedidoNuevo("of-previo", "wamid.previo"));
    return { origen, destino };
  }

  /**
   * Lo que hace un arranque de verdad, en el mismo orden.
   *
   * La espera de 3 ms no es un adorno: las marcas de congelacion y de
   * arranque son ISO con milisegundos, y el cutover exige que el arranque
   * sea ESTRICTAMENTE posterior. Dos marcas iguales no prueban el orden, asi
   * que el cutover se niega -el lado seguro-. En produccion median los
   * segundos que tarda un Restart de Render; en una prueba hay que
   * separarlas a mano.
   */
  const esperarUnPoco = () => new Promise((listo) => setTimeout(listo, 3));

  async function simularReinicio() {
    await esperarUnPoco();
    trabajo._olvidarMemoria();
    persistencia.registrarArranque(dir);
    return recuperarPendientes();
  }

  /** Deja un turno pasada la compuerta y bloqueado en el proveedor de IA. */
  async function turnoBloqueadoEnLaIA(origen, wamid) {
    modoCerebro = "bloquea";
    let abrir;
    puertaDeIA = new Promise((listo) => {
      abrir = listo;
    });
    let llego;
    const haLlegado = new Promise((listo) => {
      llego = listo;
    });
    turnoLlegoAlProveedor = llego;

    // Cuando el proveedor responda, el turno guarda su pedido.
    escrituraDelTurno = async () => {
      await origen.pedidos.crearSiNoExiste(pedidoNuevo("of-en-vuelo", wamid));
    };

    // SIN congelar: el turno entra y reclama con normalidad.
    const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid }), "vuelo");
    assert.equal(admision.congelado, false);
    assert.equal(admision.durable, true);

    // No se espera: el turno se queda dentro del cerebro.
    const turno = procesar.procesarAdmitidos(admision.admitidos, "vuelo");
    await haLlegado; // ahora sabemos que esta bloqueado, sin dormir

    return { turno, abrir };
  }

  // ----------------------------------------------------------------------
  // LA REGRESION QUE PIDE EL CASO PENDIENTE
  // ----------------------------------------------------------------------
  test("ESCENARIO: turno bloqueado en la IA, se libera DESPUES de la ventana de copia", async () => {
    limpiar();
    const { origen, destino } = await montar();

    try {
      const { turno, abrir } = await turnoBloqueadoEnLaIA(origen, "wamid.VUELO.1");

      // El turno esta en vuelo y el disco lo dice.
      const bitacora = trabajo.inspeccionar(dir);
      assert.equal(bitacora.enCurso.length, 1, "el turno en vuelo tiene que verse en la bitacora");
      assert.equal(bitacora.enCurso[0].wamid, "wamid.VUELO.1");

      // Se congela DESPUES de que el turno pasara la compuerta.
      congelacion.congelar(dir, "cutover");

      // Y se intenta el cutover. Aqui es donde la version anterior esperaba
      // 2 s, no veia ninguna escritura -el turno esta bloqueado en la red- y
      // se declaraba exitosa.
      const informe = await copiar({ origen, destino, dirDatos: dir });

      // ------------------------------------------------------------------
      // LO QUE IMPORTA: NO HAY CUTOVER EXITOSO.
      // ------------------------------------------------------------------
      assert.ok(informe.problemas.length > 0, "el cutover NO puede declararse exitoso con un turno en vuelo");
      assert.equal((await destino.estado()).pedidos, 0, "y no copio nada");

      // Ahora el proveedor responde y el turno escribe. Esta es la escritura
      // que la version anterior dejaba fuera de PostgreSQL.
      abrir();
      await turno;

      const pedidosEnOrigen = (await origen._inventario()).pedidos.length;
      assert.equal(pedidosEnOrigen, 2, "el turno en vuelo escribio, como en el caso real");

      // LA INVARIANTE: no existe un cutover declarado exitoso seguido de una
      // escritura al origen omitida del destino. El cutover se nego, asi que
      // esa escritura nunca quedo huerfana.
      const copiados = (await destino.estado()).pedidos;
      assert.equal(copiados, 0);
      assert.ok(
        informe.problemas.length > 0 || copiados === pedidosEnOrigen,
        "o el cutover se nego, o el destino tiene todo lo del origen. Nunca exitoso-e-incompleto."
      );
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("y tras el reinicio congelado, ese mismo cutover SI completa", async () => {
    // El procedimiento correcto, de principio a fin.
    limpiar();
    const { origen, destino } = await montar();

    try {
      const { turno, abrir } = await turnoBloqueadoEnLaIA(origen, "wamid.VUELO.2");
      congelacion.congelar(dir, "cutover");

      // Se niega, como en la prueba anterior.
      const primera = await copiar({ origen, destino, dirDatos: dir });
      assert.ok(primera.problemas.length > 0);

      // --- REINICIO CONGELADO ---
      //
      // En produccion el reinicio MATA el proceso con el turno dentro: su
      // escritura nunca ocurre Y su registro se queda en RECLAMADO, porque
      // nadie llego a llamar a terminar().
      //
      // Se modela igual: el turno NO se libera (sigue "dentro" del proceso
      // que acaba de morir) y se arranca de nuevo. Liberarlo aqui seria
      // modelar un turno que termina, que es justo lo que un reinicio
      // impide.
      const resumen = await simularReinicio();
      assert.ok(resumen.diferidos >= 1, "el arranque congelado marca los pendientes como diferidos");

      // La bitacora ya no ve turnos en vuelo, y lo dice por escrito.
      const bitacora = trabajo.inspeccionar(dir);
      assert.equal(bitacora.enCurso.length, 0, "tras el reinicio congelado no hay nada en vuelo");
      assert.ok(bitacora.diferidos.length >= 1, "pero si hay trabajo diferido esperando");

      // Y ahora el cutover completa.
      const segunda = await copiar({ origen, destino, dirDatos: dir });
      assert.deepEqual(segunda.problemas, [], "tras el reinicio congelado el cutover completa");
      assert.equal(segunda.drenaje.arrancoDespuesDeCongelar, true);
      assert.equal(segunda.drenaje.enCurso, 0);
      assert.equal(segunda.huellaAntes.resumen, segunda.huellaDespues.resumen);
      assert.equal((await destino.estado()).pedidos, 1, "el pedido previo se copio");

      // El mensaje del turno muerto no se perdio: quedo diferido y se
      // procesara al descongelar y reiniciar. Eso ya esta cubierto en la
      // seccion 1; aqui basta ver que sigue en la cola.
      assert.ok(
        trabajo.paraRecuperar().some((p) => p.wamid === "wamid.VUELO.2"),
        "el mensaje del turno interrumpido sigue recuperable"
      );

      // Limpieza: se suelta la promesa sin escritura, ya fuera de toda
      // ventana de cutover, para no dejarla pendiente al terminar.
      escrituraDelTurno = null;
      abrir();
      await turno;
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  // ----------------------------------------------------------------------
  // Las dos condiciones, por separado
  // ----------------------------------------------------------------------
  test("CONDICION 1: sin reinicio despues de congelar, el cutover se niega", async () => {
    limpiar();
    const { origen, destino } = await montar();
    try {
      // Arranque ANTES de congelar: es el orden que deja turnos posibles en
      // vuelo, y el que no se puede aceptar.
      persistencia.registrarArranque(dir);
      await new Promise((listo) => setTimeout(listo, 5));
      congelacion.congelar(dir, "cutover");

      const informe = await copiar({ origen, destino, dirDatos: dir });

      assert.ok(informe.problemas.length > 0);
      assert.match(informe.problemas.join(" "), /NO se ha reiniciado desde que se congelo/);
      assert.match(informe.problemas.join(" "), /proveedor de IA/);
      assert.match(informe.problemas.join(" "), /Restart service/);
      assert.equal(informe.drenaje.arrancoDespuesDeCongelar, false);
      assert.equal((await destino.estado()).pedidos, 0, "no copio nada");
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("CONDICION 2: con reinicio pero con un turno en vuelo, el cutover se niega", async () => {
    // La condicion 2 es la EVIDENCIA de que la 1 surtio efecto. Tiene que
    // funcionar por si sola: si alguien reinicia y luego descongela y
    // vuelve a congelar mal, o si la compuerta no cierra, esto lo caza.
    limpiar();
    const { origen, destino } = await montar();
    try {
      congelacion.congelar(dir, "cutover");
      await esperarUnPoco();
      persistencia.registrarArranque(dir); // reinicio DESPUES de congelar: condicion 1 ok

      // Y aun asi, un turno reclamado sin marcar como diferido.
      trabajo._olvidarMemoria();
      const reclamo = trabajo.reclamar("wamid.VUELO.3", { evento: { wamid: "wamid.VUELO.3" } });
      assert.equal(reclamo.ok, true);
      assert.equal(trabajo.inspeccionar(dir).enCurso.length, 1);

      const informe = await copiar({ origen, destino, dirDatos: dir });

      assert.ok(informe.problemas.length > 0);
      assert.match(informe.problemas.join(" "), /turno\(s\) EN VUELO/);
      assert.match(informe.problemas.join(" "), /wamid\.VUELO\.3/);
      assert.match(informe.problemas.join(" "), /No se copio nada/);
      assert.equal(informe.drenaje.enCurso, 1);
      assert.equal((await destino.estado()).pedidos, 0);
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("un evento DIFERIDO no bloquea el cutover: no es un turno en vuelo", async () => {
    // La distincion es el centro de todo. Si un diferido bloqueara, el
    // cutover seria imposible justo cuando hay mensajes esperando, que es
    // cuando mas falta hace poder hacerlo.
    limpiar();
    const { origen, destino } = await montar();
    try {
      congelacion.congelar(dir, "cutover");
      await esperarUnPoco();
      persistencia.registrarArranque(dir);

      // Mensaje que llega YA congelado: se reclama y se marca diferido en
      // la misma escritura.
      trabajo._olvidarMemoria();
      const admision = procesar.admitir(ayuda.payloadDeTexto({ wamid: "wamid.DIFER.1" }), "d1");
      assert.equal(admision.admitidos[0].diferido, true);
      await procesar.procesarAdmitidos(admision.admitidos, "d1");

      const bitacora = trabajo.inspeccionar(dir);
      assert.equal(bitacora.diferidos.length, 1, "diferido");
      assert.equal(bitacora.enCurso.length, 0, "y NO en vuelo");

      const informe = await copiar({ origen, destino, dirDatos: dir });
      assert.deepEqual(informe.problemas, [], "un diferido no puede bloquear el cutover");
      assert.equal(informe.drenaje.diferidos, 1);
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("si la bitacora no se puede leer, el cutover se niega", async () => {
    // Ante la duda no se copia. Suponer que no hay nada en vuelo porque no
    // se puede comprobar es exactamente el error que cerramos.
    limpiar();
    const { origen, destino } = await montar();
    try {
      congelacion.congelar(dir, "cutover");
      await esperarUnPoco();
      persistencia.registrarArranque(dir);
      romperLaEscrituraDeTrabajo(); // una CARPETA donde va el archivo

      const informe = await copiar({ origen, destino, dirDatos: dir });
      assert.ok(informe.problemas.length > 0);
      assert.match(informe.problemas.join(" "), /no se pudo leer la bitacora/);
      assert.equal((await destino.estado()).pedidos, 0);
    } finally {
      repararLaEscrituraDeTrabajo();
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("sin marcador de arranque, el cutover se niega", async () => {
    limpiar();
    const { origen, destino } = await montar();
    try {
      congelacion.congelar(dir, "cutover");
      fs.rmSync(path.join(dir, "marcador-de-disco.json"), { force: true });

      const informe = await copiar({ origen, destino, dirDatos: dir });
      assert.ok(informe.problemas.length > 0);
      assert.match(informe.problemas.join(" "), /no hay marcador de arranque/);
    } finally {
      await origen.cerrar();
      await destino.cerrar();
    }
  });

  test("inspeccionar() NO reescribe la bitacora", () => {
    // Si usara cargar(), podria compactar y llevarse por delante las lineas
    // que el servicio escribio entre la lectura y el rename. Eso es perder
    // reclamos, es decir perder mensajes.
    limpiar();
    trabajo.reclamar("wamid.INSP.1", { evento: { wamid: "wamid.INSP.1" } });
    const antes = fs.readFileSync(trabajo.ARCHIVO, "utf8");

    for (let i = 0; i < 3; i++) trabajo.inspeccionar(dir);

    assert.equal(fs.readFileSync(trabajo.ARCHIVO, "utf8"), antes, "inspeccionar tiene que ser de solo lectura");
  });

  test("leerMarcador() NO incrementa el contador de arranques", () => {
    // Si el cutover incrementara el contador, satisfaria su propia
    // comprobacion. Un candado que el interesado puede abrir no es candado.
    limpiar();
    const inicial = persistencia.registrarArranque(dir).arranques;

    for (let i = 0; i < 3; i++) persistencia.leerMarcador(dir);

    assert.equal(persistencia.leerMarcador(dir).arranques, inicial, "leer no puede contar como arrancar");
  });
});

module.exports = {};
