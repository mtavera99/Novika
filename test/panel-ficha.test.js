"use strict";

// ==========================================================================
// LA FICHA EN EL PANEL
//
// Reproduce el defecto que se vio en produccion desde el celular: el
// titulo del chat, la tarjeta del cliente y la ciudad mostraban
// "[object Object]".
//
// La causa: cada campo de la ficha es un objeto con estado -{valor,
// estado, origen}- y el panel lo interpolaba como si fuera texto.
//
// Y hay un segundo defecto detras, peor que el visible: la correccion
// obvia -poner `.valor`- habria mostrado un CANDIDATO con la misma
// tipografia que un dato confirmado. "[object Object]" molesta pero no
// engana; "Ana Perez" cuando nadie valido ese nombre, si. Es la frontera
// que el dominio existe para marcar: la IA propone, el codigo confirma.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const campos = require("../src/dominio/campos");
const fichaDe = require("../src/panel/ficha");
const datos = require("../src/panel/datos");
const vistas = require("../src/panel/vistas");
const atencion = require("../src/almacen/atencion");

/** Una ficha como la que de verdad construye el cerebro. */
function fichaReal({ nombre = null, ciudad = null, telefono = null, confirmar = [] } = {}) {
  let f = campos.fichaVacia();
  const proponer = (campo, valor) => {
    if (valor === null) return;
    f = { ...f, [campo]: campos.proponer(f[campo], valor, campos.ORIGENES.CLIENTE) };
  };
  proponer("nombre", nombre);
  proponer("ciudad", ciudad);
  proponer("telefono", telefono);
  for (const campo of confirmar) {
    f = { ...f, [campo]: campos.confirmar(f[campo], () => ({ ok: true, valor: f[campo].valor })) };
  }
  return f;
}

// ==========================================================================
// 1 · EL DEFECTO VISIBLE
// ==========================================================================

describe("1 · nunca sale [object Object]", () => {
  test("ESCENARIO: la ficha real del cerebro NO produce [object Object]", () => {
    const ficha = fichaReal({ nombre: "Ana Pérez", ciudad: "Medellín", telefono: "3001112233" });

    // Asi se veia el defecto: el campo es un objeto.
    assert.equal(typeof ficha.nombre, "object", "la ficha guarda objetos, no texto");
    assert.match(String(ficha.nombre), /\[object Object\]/, "interpolarlo directo da esto");

    // Y asi se lee bien.
    assert.equal(fichaDe.leer(ficha, "nombre").valor, "Ana Pérez");
    assert.equal(fichaDe.texto(ficha, "ciudad"), "Medellín");
    assert.equal(fichaDe.nombreParaMostrar(ficha).texto, "Ana Pérez");
  });

  test("ninguna pantalla del panel imprime [object Object]", () => {
    const ficha = fichaReal({
      nombre: "Ana Pérez",
      ciudad: "Medellín",
      telefono: "3001112233",
      confirmar: ["nombre", "ciudad", "telefono"],
    });
    const conversacion = { contactoId: "573058742138", estado: "explorando", ficha };
    atencion.anotarMensaje(conversacion, { de: atencion.QUIEN.CLIENTE, texto: "Hola" });

    const pantallas = [
      vistas.chat({ ficha: { conversacion, mensajes: atencion.mensajes(conversacion), atencion: atencion.leer(conversacion), pedidos: [], clase: datos.CLASES.PENDIENTE } }),
      vistas.buscar({ q: "ana", resultados: [conversacion] }),
      vistas.tablero({
        datos: {
          dia: "2026-10-07",
          resumen: datos.resumirPedidos([]),
          pedidos: [],
          chats: [],
          porClase: { pendiente: [] },
          cuentas: {},
        },
      }),
    ];

    for (const html of pantallas) {
      assert.ok(!html.includes("[object Object]"), "una pantalla imprimio [object Object]");
    }
  });

  test("el tablero tampoco, con la conversacion pasando por datos.tablero", async () => {
    const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-ficha-"));
    const repos = await crearReposDeArchivos({ dir });
    try {
      const ficha = fichaReal({ nombre: "Ana Pérez", ciudad: "Medellín", confirmar: ["nombre"] });
      await repos.contactos.guardar({ id: "573058742138" });
      const conv = { contactoId: "573058742138", estado: "explorando", ficha };
      atencion.anotarMensaje(conv, { de: atencion.QUIEN.CLIENTE, texto: "Hola" });
      await repos.conversaciones.guardar(conv);

      const tabla = await datos.tablero(repos, { dia: require("../src/panel/fecha").hoyBogota() });
      const html = vistas.tablero({ datos: tabla, clase: datos.CLASES.PENDIENTE });

      assert.ok(!html.includes("[object Object]"));
      assert.match(html, /Ana Pérez/, "el nombre tiene que verse");
    } finally {
      await repos.cerrar();
    }
  });

  test("un valor anidado por error no se interpola: se dice que falta", () => {
    // Si `valor` fuera a su vez un objeto, poner `.valor` a secas habria
    // vuelto a imprimir "[object Object]".
    const ficha = { nombre: { valor: { raro: true }, estado: "confirmado" } };
    const c = fichaDe.leer(ficha, "nombre");
    assert.equal(c.valor, null);
    assert.equal(c.hay, false);
    assert.ok(!String(c.texto).includes("[object"));
  });
});

// ==========================================================================
// 2 · CANDIDATO NO SE MUESTRA COMO HECHO
// ==========================================================================

describe("2 · la frontera candidato / confirmado se respeta al pintar", () => {
  test("un nombre CANDIDATO se marca «sin confirmar»", () => {
    const ficha = fichaReal({ nombre: "Ana Pérez" }); // propuesto, sin confirmar
    const c = fichaDe.leer(ficha, "nombre");
    assert.equal(c.valor, "Ana Pérez");
    assert.equal(c.estado, campos.ESTADO_CAMPO.CANDIDATO);
    assert.equal(c.confirmado, false);

    const conversacion = { contactoId: "573058742138", estado: "explorando", ficha };
    const html = vistas.chat({
      ficha: { conversacion, mensajes: [], atencion: atencion.leer(conversacion), pedidos: [], clase: datos.CLASES.PENDIENTE },
    });
    assert.match(html, /Ana Pérez/);
    assert.match(html, /sin confirmar/, "un candidato tiene que marcarse");
  });

  test("y un nombre CONFIRMADO no lleva esa marca", () => {
    const ficha = fichaReal({ nombre: "Ana Pérez", confirmar: ["nombre"] });
    assert.equal(fichaDe.leer(ficha, "nombre").confirmado, true);

    const conversacion = { contactoId: "573058742138", estado: "explorando", ficha };
    const html = vistas.chat({
      ficha: { conversacion, mensajes: [], atencion: atencion.leer(conversacion), pedidos: [], clase: datos.CLASES.PENDIENTE },
    });
    assert.match(html, /Ana Pérez/);
    // La marca no puede aparecer por el nombre. (La ciudad no existe aqui,
    // asi que no hay otro campo que la ponga.)
    assert.ok(!html.includes("sin confirmar"), "un dato confirmado no se marca");
  });

  test("confirmado() devuelve null si el dato NO esta confirmado", () => {
    const candidato = fichaReal({ telefono: "3001112233" });
    const seguro = fichaReal({ telefono: "3001112233", confirmar: ["telefono"] });
    assert.equal(fichaDe.confirmado(candidato, "telefono"), null);
    assert.equal(fichaDe.confirmado(seguro, "telefono"), "3001112233");
  });

  test("responder usa el id de WhatsApp si el telefono NO esta confirmado", () => {
    // A quien se le escribe no puede salir de un candidato: un telefono que
    // propuso el modelo y nadie valido manda el mensaje a otra persona.
    const fs = require("node:fs"), path = require("node:path");
    const rutas = fs.readFileSync(path.join(__dirname, "..", "src", "panel", "rutas.js"), "utf8");
    const trozo = rutas.slice(rutas.indexOf('router.post("/responder"'));
    assert.ok(
      trozo.includes('fichaDe.confirmado(conv.ficha, "telefono")'),
      "el destino del mensaje tiene que exigir un telefono CONFIRMADO"
    );
    assert.ok(
      !/conv\.ficha\.telefono/.test(trozo),
      "lee el telefono crudo de la ficha, sin comprobar el estado"
    );
  });
});

// ==========================================================================
// 3 · BUSCAR POR EL VALOR, NO POR EL ENVOLTORIO
// ==========================================================================

describe("3 · la busqueda mira dentro del campo", () => {
  async function conRepos(fn) {
    const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-busca-"));
    const repos = await crearReposDeArchivos({ dir });
    try {
      return await fn(repos);
    } finally {
      await repos.cerrar();
    }
  }

  test("ESCENARIO: buscar el nombre de un cliente lo encuentra", async () => {
    // Antes se comparaba contra "[object Object]", asi que buscar "ana" no
    // encontraba nada y el panel parecia vacio.
    await conRepos(async (repos) => {
      await repos.contactos.guardar({ id: "573058742138" });
      await repos.conversaciones.guardar({
        contactoId: "573058742138",
        estado: "explorando",
        ficha: fichaReal({ nombre: "Ana Pérez", ciudad: "Medellín", confirmar: ["nombre"] }),
      });

      for (const q of ["ana", "Ana", "pérez", "medell"]) {
        const r = await datos.buscar(repos, q);
        assert.equal(r.length, 1, `buscar "${q}" no encontro nada`);
      }
      assert.equal((await datos.buscar(repos, "zzz")).length, 0);
    });
  });

  test("y tambien por el id de WhatsApp", async () => {
    await conRepos(async (repos) => {
      await repos.contactos.guardar({ id: "573058742138" });
      await repos.conversaciones.guardar({
        contactoId: "573058742138",
        estado: "explorando",
        ficha: campos.fichaVacia(),
      });
      assert.equal((await datos.buscar(repos, "5730587")).length, 1);
    });
  });
});

// ==========================================================================
// 4 · TOLERANCIA
// ==========================================================================

describe("4 · formas que hay que tolerar", () => {
  test("texto plano se acepta y cuenta como confirmado", () => {
    // La venta manual guarda el contacto con texto plano, y lo escribio una
    // persona. Tratarlo como un fallo dejaria esas pantallas vacias.
    const c = fichaDe.leer({ nombre: "Ana Pérez" }, "nombre");
    assert.equal(c.valor, "Ana Pérez");
    assert.equal(c.confirmado, true);
    assert.equal(c.origen, campos.ORIGENES.PERSONA);
  });

  test("una ficha vacia, ausente o rara no revienta", () => {
    for (const ficha of [undefined, null, {}, campos.fichaVacia(), { nombre: null }, { nombre: "" }, { nombre: {} }]) {
      assert.doesNotThrow(() => fichaDe.leer(ficha, "nombre"), `lanzo con ${JSON.stringify(ficha)}`);
      const c = fichaDe.leer(ficha, "nombre");
      assert.equal(c.hay, false);
      assert.equal(c.texto, fichaDe.SIN_DATO);
      assert.equal(fichaDe.nombreParaMostrar(ficha).texto, "(sin nombre)");
    }
  });

  test("un campo RECHAZADO no se muestra como bueno", () => {
    let f = campos.fichaVacia();
    f = { ...f, ciudad: campos.proponer(f.ciudad, "Ciudad Inventada", campos.ORIGENES.IA) };
    f = { ...f, ciudad: campos.confirmar(f.ciudad, () => ({ ok: false, porQue: "no esta en la cobertura" })) };

    const c = fichaDe.leer(f, "ciudad");
    assert.equal(c.estado, campos.ESTADO_CAMPO.RECHAZADO);
    assert.equal(c.confirmado, false, "un rechazado NO puede contar como confirmado");
    assert.equal(fichaDe.confirmado(f, "ciudad"), null);
  });

  test("un numero se lee como texto, no como [object Object] ni como vacio", () => {
    let f = campos.fichaVacia();
    f = { ...f, cantidad: campos.proponer(f.cantidad, 2, campos.ORIGENES.CLIENTE) };
    assert.equal(fichaDe.leer(f, "cantidad").valor, "2");
  });
});

module.exports = {};

// ==========================================================================
// 5 · EL INTERRUPTOR DEL PANEL SE PUEDE CONSULTAR
// ==========================================================================
//
// Faltaba en /health, y la consecuencia fue concreta: el panel decia
// "no se pudo enviar: envio_manual_apagado" y desde fuera no habia forma
// de distinguir "esta apagado, es lo esperado" de "hay un defecto".
//
// Un interruptor que decide si le escribimos a un cliente y que no se
// puede consultar obliga a adivinar.
// ==========================================================================

describe("5 · el interruptor del panel se ve en /health", () => {
  const { crearApp } = require("../src/app");

  test("ESCENARIO: /health publica panel_envio_manual SIN token", async () => {
    const servidor = await ayuda.levantar(crearApp());
    try {
      const r = await fetch(`${servidor.url}/health`);
      assert.equal(r.status, 200);
      const j = await r.json();

      assert.ok(
        Object.prototype.hasOwnProperty.call(j, "panel_envio_manual"),
        "sin este campo no se puede saber por que el panel no envia"
      );
      assert.equal(typeof j.panel_envio_manual, "boolean");
      // En las pruebas no esta configurado, asi que esta apagado.
      assert.equal(j.panel_envio_manual, false);
    } finally {
      await servidor.cerrar();
    }
  });

  test("va junto a los otros interruptores, no detras del token", async () => {
    // Es el mismo criterio que `escrituras_congeladas`: lo que apaga una
    // parte del servicio tiene que verse sin credenciales.
    const servidor = await ayuda.levantar(crearApp());
    try {
      const j = await (await fetch(`${servidor.url}/health`)).json();
      for (const campo of ["respuesta_automatica", "escrituras_congeladas", "panel_envio_manual"]) {
        assert.ok(Object.prototype.hasOwnProperty.call(j, campo), `falta ${campo} sin token`);
      }
    } finally {
      await servidor.cerrar();
    }
  });

  test("el bloqueo del panel dice DONDE se enciende, no solo que esta apagado", () => {
    const { EXPLICACION } = require("../src/panel/rutas");
    const { MOTIVOS_BLOQUEO } = require("../src/whatsapp/enviar");
    const texto = EXPLICACION[MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO];

    assert.match(texto, /NO salio/, "tiene que decir que no salio");
    assert.match(texto, /PANEL_ENVIO_MANUAL/, "y como se llama el interruptor");
    assert.match(texto, /Environment/, "y donde se cambia");
    assert.match(texto, /panel_envio_manual/, "y como comprobarlo");
  });

  test("un intento viejo sigue diciendo «no enviado» aunque se encienda despues", async () => {
    // El historial guarda el resultado REAL del intento en su momento.
    // Reescribirlo al encender el interruptor seria cambiar lo que paso: ese
    // mensaje NO llego al cliente.
    const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-hist-"));
    const repos = await crearReposDeArchivos({ dir });
    try {
      await repos.contactos.guardar({ id: "573058742138" });
      const conv = { contactoId: "573058742138", estado: "explorando", ficha: campos.fichaVacia() };
      atencion.anotarMensaje(conv, {
        de: atencion.QUIEN.OPERADOR,
        texto: "Hola",
        por: "panel",
        estado: "envio_manual_apagado",
      });
      await repos.conversaciones.guardar(conv);

      // Se "enciende" el interruptor: el historial no cambia.
      const ficha = await datos.conversacionCompleta(repos, "573058742138");
      const html = vistas.chat({ ficha, envioManualActivo: true });

      assert.match(html, /no enviado: envio_manual_apagado/, "el intento viejo tiene que seguir marcado");
      // Pero el aviso de abajo ya NO dice que esten apagados.
      assert.ok(!html.includes("Se encienden con"), "el aviso tiene que reflejar el estado ACTUAL");
    } finally {
      await repos.cerrar();
    }
  });
});
