"use strict";

// ==========================================================================
// LA BANDEJA Y LOS DATOS DE ENTREGA
//
// Dos huecos del panel que se cerraron juntos porque son el mismo problema
// visto de dos formas: no habia donde ver una conversacion que no estuviera
// pendiente, y no habia donde ver los datos con los que se va a despachar.
//
//   · El tablero muestra lo que ESPERA RESPUESTA. Correcto para trabajar el
//     dia, inservible para auditar: la conversacion de quien pregunto y no
//     compro -la mayoria- solo se podia abrir si recordabas su nombre.
//
//   · La ficha mostraba la conversacion O el pedido, nunca las dos. Si el
//     cliente corrige su direccion despues de confirmar, la ficha dice una
//     cosa y el pedido otra, y despachar mirando la equivocada es un paquete
//     perdido.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const datos = require("../src/panel/datos");
const vistas = require("../src/panel/vistas");
const campos = require("../src/dominio/campos");
const atencion = require("../src/almacen/atencion");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");

const CLIENTE = "573001112222";

/** Ficha con los campos ya confirmados, como la deja el cerebro. */
function fichaCon(valores) {
  const f = campos.fichaVacia();
  for (const [campo, valor] of Object.entries(valores)) {
    f[campo] = { valor, estado: campos.ESTADO_CAMPO.CONFIRMADO, origen: campos.ORIGENES.CLIENTE, historial: [] };
  }
  return f;
}

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function conRepos() {
  // Carpeta nueva por prueba: si compartieran una, las conversaciones de una
  // prueba apareceran en los contadores de la siguiente y los numeros serian
  // falsos sin que nadie se entere.
  return crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-bandeja-")) });
}

/** Guarda una conversacion con mensajes y, opcionalmente, un pedido. */
async function sembrar(repos, { id, nombre, ciudad, mensajes = [], atendido = false, pedido = null, estado = "explorando" }) {
  const conv = {
    contactoId: id,
    estado,
    productoId: "cinturon-termico-colicos",
    ficha: fichaCon({ nombre, ciudad, telefono: id, direccion: "Calle 1 # 2-3" }),
    ventana: [],
  };
  for (const m of mensajes) {
    atencion.anotarMensaje(conv, { de: m.de, texto: m.texto, estado: m.estado || "enviado" });
  }
  if (atendido) {
    conv.atencion = { ...atencion.leer(conv), atendidoEn: new Date().toISOString(), atendidoPor: "panel" };
  }
  await repos.conversaciones.guardar(conv);

  if (pedido) {
    await repos.pedidos.crearSiNoExiste({
      id: pedido.id,
      version: 1,
      estado: pedido.estado || "confirmado",
      claveDeEvento: `${id}:${pedido.id}`,
      claveDeOferta: `${id}:of-${pedido.id}`,
      contactoId: id,
      conversacionId: id,
      ofertaId: `of-${pedido.id}`,
      wamidConfirmacion: `wamid.${pedido.id}`,
      producto: { id: "cinturon-termico-colicos", nombre: "Cinturón térmico NOVIKA", variante: null },
      cantidad: 1,
      destinatario: {
        nombre: pedido.nombre || nombre,
        telefono: id,
        ciudad: pedido.ciudad || ciudad,
        departamento: pedido.departamento || null,
        direccion: pedido.direccion || "Calle 1 # 2-3",
        referencia: null,
        documento: null,
      },
      cotizacion: {
        productoId: "cinturon-termico-colicos",
        productoNombre: "Cinturón térmico NOVIKA",
        cantidad: 1,
        total: 49900,
        subtotal: 49900,
        envio: 0,
        descuento: 0,
        condiciones: { pagoMetodo: "contraentrega", envioIncluido: true, politicaEnvio: "incluido" },
      },
      creadoEn: new Date().toISOString(),
      revisiones: [],
    });
  }
  return conv;
}

// --------------------------------------------------------------------------
// 1 · LA BANDEJA LISTA TODO
// --------------------------------------------------------------------------

describe("1 · la bandeja", () => {
  test("incluye las conversaciones SIN pedido, que el tablero no mostraba", async () => {
    const repos = await conRepos();
    await sembrar(repos, {
      id: "573000000001",
      nombre: "Sin Pedido",
      ciudad: "Cali",
      mensajes: [{ de: "cliente", texto: "¿cuánto vale?" }, { de: "bot", texto: "Te queda en..." }],
    });

    const b = await datos.bandeja(repos, { filtro: datos.FILTROS.TODOS });
    assert.equal(b.total, 1);
    assert.equal(b.filas[0].pedidosVivos, 0);
    assert.equal(b.filas[0].nombre, "Sin Pedido");
  });

  test("cada fila trae el último mensaje y quién lo dijo", async () => {
    // Sin esto la lista es una guia de telefonos: hay que abrir cada chat
    // para saber de que iba.
    const repos = await conRepos();
    await sembrar(repos, {
      id: "573000000002",
      nombre: "Con Mensajes",
      ciudad: "Cali",
      mensajes: [
        { de: "cliente", texto: "hola" },
        { de: "bot", texto: "El cinturón térmico te queda en $49.900" },
        { de: "cliente", texto: "¿y tiene garantía?" },
      ],
    });

    const b = await datos.bandeja(repos, {});
    assert.equal(b.filas[0].ultimo.de, "cliente");
    assert.match(b.filas[0].ultimo.texto, /garantía/);
    assert.equal(b.filas[0].mensajes, 3);
  });

  test("filtra por esperando, atendidos, con pedido y sin pedido", async () => {
    const repos = await conRepos();
    // Espera respuesta: el ultimo mensaje es del cliente.
    await sembrar(repos, { id: "573000000011", nombre: "Espera", ciudad: "Cali", mensajes: [{ de: "cliente", texto: "hola?" }] });
    // Atendida por una persona.
    await sembrar(repos, {
      id: "573000000012",
      nombre: "Atendida",
      ciudad: "Cali",
      mensajes: [{ de: "cliente", texto: "hola" }],
      atendido: true,
    });
    // Con pedido.
    await sembrar(repos, {
      id: "573000000013",
      nombre: "Compro",
      ciudad: "Cali",
      estado: "confirmado",
      mensajes: [{ de: "cliente", texto: "si confirmo" }, { de: "bot", texto: "Listo" }],
      pedido: { id: "NOV-UNO" },
    });

    const esperando = await datos.bandeja(repos, { filtro: datos.FILTROS.ESPERANDO });
    assert.deepEqual(esperando.filas.map((f) => f.nombre), ["Espera"]);

    const atendidos = await datos.bandeja(repos, { filtro: datos.FILTROS.ATENDIDOS });
    assert.deepEqual(atendidos.filas.map((f) => f.nombre), ["Atendida"]);

    const conPedido = await datos.bandeja(repos, { filtro: datos.FILTROS.CON_PEDIDO });
    assert.deepEqual(conPedido.filas.map((f) => f.nombre), ["Compro"]);

    const sinPedido = await datos.bandeja(repos, { filtro: datos.FILTROS.SIN_PEDIDO });
    assert.equal(sinPedido.filas.length, 2);
    assert.equal(sinPedido.filas.some((f) => f.nombre === "Compro"), false);
  });

  test("los contadores de las pestañas se calculan sobre TODO, no sobre la página", async () => {
    // Una pestaña que dice "3" porque solo mira la pagina actual miente, y
    // es el numero que se usa para decidir si queda trabajo.
    const repos = await conRepos();
    for (let i = 0; i < 7; i++) {
      await sembrar(repos, {
        id: `5730000001${i}`,
        nombre: `Cliente ${i}`,
        ciudad: "Cali",
        mensajes: [{ de: "cliente", texto: `mensaje ${i}` }],
      });
    }
    const b = await datos.bandeja(repos, { porPagina: 3 });
    assert.equal(b.filas.length, 3, "la página trae 3");
    assert.equal(b.total, 7);
    assert.equal(b.cuentas.todos, 7, "el contador cuenta las 7");
    assert.equal(b.paginas, 3);
  });

  test("pagina de verdad y no se sale de rango", async () => {
    const repos = await conRepos();
    for (let i = 0; i < 5; i++) {
      await sembrar(repos, { id: `5730000002${i}`, nombre: `C${i}`, ciudad: "Cali", mensajes: [{ de: "cliente", texto: "x" }] });
    }
    const p2 = await datos.bandeja(repos, { porPagina: 2, pagina: 2 });
    assert.equal(p2.pagina, 2);
    assert.equal(p2.filas.length, 2);

    // Una pagina que no existe devuelve la ultima, no una pantalla vacia.
    const fuera = await datos.bandeja(repos, { porPagina: 2, pagina: 99 });
    assert.equal(fuera.pagina, 3);
    assert.ok(fuera.filas.length > 0);
  });

  test("busca por nombre, teléfono, ciudad y texto del mensaje", async () => {
    const repos = await conRepos();
    await sembrar(repos, {
      id: "573009998888",
      nombre: "Marcela Ruiz",
      ciudad: "Bucaramanga",
      mensajes: [{ de: "cliente", texto: "me interesa el cinturón rosado" }],
    });
    await sembrar(repos, { id: "573007776666", nombre: "Otro", ciudad: "Pasto", mensajes: [{ de: "cliente", texto: "hola" }] });

    for (const q of ["Marcela", "9998888", "Bucaramanga", "rosado"]) {
      const b = await datos.bandeja(repos, { q });
      assert.equal(b.total, 1, `la búsqueda "${q}" no encontró a Marcela`);
      assert.equal(b.filas[0].nombre, "Marcela Ruiz");
    }
  });

  test("lo que espera respuesta va primero", async () => {
    const repos = await conRepos();
    await sembrar(repos, {
      id: "573000000031",
      nombre: "Contestada",
      ciudad: "Cali",
      mensajes: [{ de: "cliente", texto: "hola" }, { de: "bot", texto: "¡Hola!" }],
    });
    await sembrar(repos, { id: "573000000032", nombre: "Esperando", ciudad: "Cali", mensajes: [{ de: "cliente", texto: "hola?" }] });

    const b = await datos.bandeja(repos, {});
    assert.equal(b.filas[0].nombre, "Esperando", "lo pendiente tiene que salir arriba");
  });

  test("la vista se dibuja y marca un mensaje que NO salió", async () => {
    // Una fila que parece contestada cuando el envio fallo es un cliente que
    // nadie atendio.
    const repos = await conRepos();
    await sembrar(repos, {
      id: "573000000041",
      nombre: "Falló",
      ciudad: "Cali",
      mensajes: [
        { de: "cliente", texto: "hola" },
        { de: "bot", texto: "respuesta preparada", estado: "respuesta_automatica_apagada" },
      ],
    });
    const b = await datos.bandeja(repos, {});
    const html = vistas.bandeja({ datos: b });

    assert.match(html, /Todos los chats/);
    assert.match(html, /no salió/, "no marcó el mensaje que no salió");
    assert.match(html, /Falló/);
    // Enlace al chat, que es para lo que existe la lista.
    assert.match(html, /\/panel\/chat\?id=573000000041/);
  });
});

// --------------------------------------------------------------------------
// 2 · DATOS DE ENTREGA: CONTACTO vs PEDIDO
// --------------------------------------------------------------------------

describe("2 · los datos con los que se despacha", () => {
  test("muestra las dos fuentes y MARCA las diferencias", async () => {
    const repos = await conRepos();
    // El pedido se guardo con una direccion y el cliente la corrigio despues.
    const conv = await sembrar(repos, {
      id: CLIENTE,
      nombre: "Ana Pérez",
      ciudad: "Medellín",
      estado: "confirmado",
      mensajes: [{ de: "cliente", texto: "si confirmo" }],
      pedido: { id: "NOV-DIF", direccion: "Calle VIEJA # 1-1" },
    });

    const pedidos = await repos.pedidos.porContacto(CLIENTE);
    const html = vistas.datosDeEntrega({ conversacion: conv, pedido: pedidos[0] });

    assert.match(html, /Dice el cliente/);
    assert.match(html, /En el pedido/);
    assert.match(html, /Calle VIEJA # 1-1/, "no muestra lo que quedó en el pedido");
    assert.match(html, /Calle 1 # 2-3/, "no muestra lo que dice el cliente ahora");
    assert.match(html, /difiere/, "no marcó la diferencia entre las dos fuentes");
  });

  test("muestra producto, cantidad, total, pago y estado del pedido", async () => {
    const repos = await conRepos();
    const conv = await sembrar(repos, {
      id: "573002223333",
      nombre: "Completa",
      ciudad: "Cali",
      estado: "confirmado",
      mensajes: [{ de: "cliente", texto: "si" }],
      pedido: { id: "NOV-COMPLETO" },
    });
    const pedidos = await repos.pedidos.porContacto("573002223333");
    const html = vistas.datosDeEntrega({ conversacion: conv, pedido: pedidos[0] });

    assert.match(html, /Cinturón térmico NOVIKA/);
    assert.match(html, /\$49\.900/);
    assert.match(html, /contraentrega/);
    assert.match(html, /envío incluido/);
    assert.match(html, /NOV-COMPLETO/);
    assert.match(html, /confirmado/);
  });

  test("un campo que falta se dice, no se deja en blanco", async () => {
    const repos = await conRepos();
    const conv = {
      contactoId: "573004445555",
      estado: "explorando",
      productoId: "cinturon-termico-colicos",
      ficha: fichaCon({ nombre: "Solo Nombre" }),
      ventana: [],
    };
    await repos.conversaciones.guardar(conv);

    const html = vistas.datosDeEntrega({ conversacion: conv });
    assert.match(html, /— falta/, "un campo vacío tiene que decirlo");
  });

  test("el departamento solo aparece si existe", async () => {
    const repos = await conRepos();
    const sinDep = {
      contactoId: "573006667777",
      estado: "explorando",
      ficha: fichaCon({ nombre: "X", ciudad: "Cali" }),
      ventana: [],
    };
    await repos.conversaciones.guardar(sinDep);
    const html = vistas.datosDeEntrega({ conversacion: sinDep });
    assert.equal(/Departamento/.test(html), false, "una fila vacía permanente enseña a ignorar los huecos");

    const conDep = { ...sinDep, contactoId: "573006667778", ficha: fichaCon({ ciudad: "Cali", departamento: "Valle del Cauca" }) };
    assert.match(vistas.datosDeEntrega({ conversacion: conDep }), /Valle del Cauca/);
  });

  test("el formulario editable aparece y respeta el interruptor de envío", async () => {
    const repos = await conRepos();
    const conv = await sembrar(repos, { id: "573008889999", nombre: "Editable", ciudad: "Cali", mensajes: [] });

    const apagado = vistas.datosDeEntrega({ conversacion: conv, editable: true, envioManualActivo: false });
    assert.match(apagado, /Guardar correcciones/);
    assert.match(apagado, /disabled/, "con el envío apagado el botón de confirmar no puede estar activo");
    assert.match(apagado, /PANEL_ENVIO_MANUAL/, "tiene que decir cómo se enciende");

    const encendido = vistas.datosDeEntrega({ conversacion: conv, editable: true, envioManualActivo: true });
    assert.match(encendido, /Confirmar por WhatsApp/);
    assert.equal(/disabled/.test(encendido), false);
  });

  test("el formulario NO permite teclear el total", () => {
    // El total lo calcula el dominio. Si el panel pudiera escribirlo, habria
    // dos fuentes de precio y la del panel no estaria probada.
    const conv = { contactoId: "x", estado: "explorando", ficha: fichaCon({ nombre: "X" }), ventana: [] };
    const html = vistas.datosDeEntrega({ conversacion: conv, editable: true, envioManualActivo: true });
    assert.equal(/name="total"/.test(html), false, "el panel no puede teclear importes");
    assert.equal(/name="precio"/.test(html), false);
  });
});

void DIR;

// --------------------------------------------------------------------------
// 3 · PANTALLAS MOVILES
//
// Marco trabaja desde el celular. No se puede tomar una captura desde aqui
// -el navegador de este entorno esta aislado del servidor local-, asi que lo
// que SI se puede hacer es comprobar las propiedades que hacen que una
// pantalla funcione con el pulgar. Son comprobables y no dependen de que
// alguien mire una imagen.
//
// Cada una viene de un problema concreto, y tres estan documentados en la
// referencia de BIKERPRO:
//
//   · sin `viewport` el movil renderiza a 980px y todo sale diminuto;
//   · por debajo de 16px en un input, iOS hace zoom al enfocar y la pagina
//     salta;
//   · un objetivo tactil de menos de 44px se falla con el pulgar;
//   · una tabla sin etiquetas por celda, en 390px de ancho, se lee como una
//     lista de numeros sin saber de que columna es cada uno.
// --------------------------------------------------------------------------

describe("3 · las pantallas sirven en un celular", () => {
  async function pantallas() {
    const repos = await conRepos();
    const conv = await sembrar(repos, {
      id: CLIENTE,
      nombre: "Ana Pérez",
      ciudad: "Medellín",
      estado: "confirmado",
      mensajes: [
        { de: "cliente", texto: "Quiero un cinturón. ¿Cuánto vale con envío?" },
        { de: "bot", texto: "El cinturón térmico te queda en $49.900." },
      ],
      pedido: { id: "NOV-MOVIL" },
    });
    const ficha = await datos.conversacionCompleta(repos, CLIENTE);
    const b = await datos.bandeja(repos, {});
    const pedidos = await repos.pedidos.porContacto(CLIENTE);
    return {
      bandeja: vistas.bandeja({ datos: b }),
      chat: vistas.chat({ ficha, envioManualActivo: true }),
      // CON pedido: la tercera columna -"En el pedido"- solo existe cuando
      // hay uno, y es justo la que hay que comprobar que trae etiqueta.
      entrega: vistas.datosDeEntrega({
        conversacion: conv,
        pedido: pedidos[0],
        editable: true,
        envioManualActivo: true,
      }),
    };
  }

  test("declaran el viewport", async () => {
    const p = await pantallas();
    for (const [nombre, html] of Object.entries(p)) {
      if (nombre === "entrega") continue; // es un fragmento, no una pagina
      assert.match(html, /name="viewport"/, `${nombre} sin viewport: el móvil renderiza a 980px`);
      assert.match(html, /width=device-width/, `${nombre} sin width=device-width`);
    }
  });

  test("ningún campo de texto baja de 16px", async () => {
    // Por debajo de 16px iOS hace zoom al enfocar y la pagina salta.
    const p = await pantallas();
    assert.match(p.bandeja, /input, textarea, select \{ font-size:16px/);
    const bajos = p.bandeja.match(/input[^}]*font-size:1[0-5]px/g) || [];
    assert.deepEqual(bajos, [], `inputs por debajo de 16px: ${JSON.stringify(bajos)}`);
  });

  test("los objetivos táctiles llegan a 44px", async () => {
    const p = await pantallas();
    assert.match(p.bandeja, /min-height:44px/, "los botones tienen que llegar a 44px");
    // Las pestañas y la paginación son enlaces, no botones: se comprueban
    // aparte porque la regla de `button` no les aplica.
    assert.match(p.bandeja, /\.pest \{[^}]*min-height:40px/);
    assert.match(p.bandeja, /\.paginas a, \.paginas span \{[^}]*min-height:40px/);
  });

  test("las tablas dicen de qué columna es cada celda", async () => {
    // En 390px una tabla se apila, y sin etiqueta por celda queda una lista
    // de valores sin saber a que corresponden.
    const p = await pantallas();
    assert.match(p.entrega, /data-label="Campo"/);
    assert.match(p.entrega, /data-label="Dice el cliente"/);
    assert.match(p.entrega, /data-label="En el pedido"/);
    assert.match(p.chat, /data-label="Codigo"/);
  });

  test("la fila de la bandeja es un enlace completo, no un texto con un enlace dentro", async () => {
    // Con el pulgar, acertarle a un enlace de dos palabras dentro de una
    // fila es un error de toque. Toda la fila es el area tactil.
    const p = await pantallas();
    assert.match(p.bandeja, /<a class="filaChat" href="\/panel\/chat\?id=/);
    assert.match(p.bandeja, /\.filaChat \{ display:block;/);
  });

  test("la bandeja no fuerza scroll horizontal", async () => {
    // Las dos fuentes de desborde en movil son las tablas anchas y las filas
    // sin salto. La bandeja no usa tabla, y las pestañas desbordan A
    // PROPOSITO en su propio carril (overflow-x) en vez de ensanchar la
    // pagina.
    const p = await pantallas();
    assert.equal(/<table/.test(p.bandeja), false, "la bandeja no debería usar tabla en móvil");
    assert.match(p.bandeja, /\.pests \{[^}]*overflow-x:auto/);
    assert.match(p.bandeja, /word-break:break-word|overflow-wrap|break-word/);
  });

  test("el buscador usa teclado de búsqueda", async () => {
    const p = await pantallas();
    assert.match(p.bandeja, /type="search"/);
    assert.match(p.bandeja, /inputmode="search"/);
  });
});

// --------------------------------------------------------------------------
// 4 · OPTIMIZACION PARA CELULAR
//
// Marco pidio optimizar el panel para el movil. Cada prueba de aqui
// corresponde a un problema concreto a 390px de ancho, que es un iPhone
// normal, y no a una preferencia estetica.
// --------------------------------------------------------------------------

describe("4 · optimización para celular", () => {
  async function unaPantalla() {
    const repos = await conRepos();
    await sembrar(repos, {
      id: CLIENTE,
      nombre: "Ana Pérez",
      ciudad: "Medellín",
      mensajes: [{ de: "cliente", texto: "hola" }],
    });
    const b = await datos.bandeja(repos, {});
    return vistas.bandeja({ datos: b });
  }

  test("la navegación va en un carril deslizable, no envuelta en tres filas", async () => {
    // Seis secciones mas "Salir" con flex-wrap ocupaban media pantalla: al
    // abrir el panel se veia el menu y nada mas.
    const html = await unaPantalla();
    assert.match(html, /header \.derecha \{[^}]*overflow-x:auto/, "el menú tiene que deslizarse, no envolverse");
    assert.match(html, /header \.derecha \.boton[^}]*white-space:nowrap/, "los botones no pueden partirse");
  });

  test("la cabecera queda fija al hacer scroll", async () => {
    // La pagina es larga a proposito -el historial no se borra- y volver al
    // menu obligaba a subir deslizando hasta arriba.
    const html = await unaPantalla();
    assert.match(html, /header \{ position:sticky/);
  });

  test("se marca en qué sección estás", async () => {
    // Con el menu deslizable, la posicion ya no dice donde estas.
    const html = await unaPantalla();
    assert.match(html, /href="\/panel\/chats" aria-current="page"/);
    assert.match(html, /aria-current="page"\] \{ background:var\(--azul\)/);
  });

  test("los KPI van de dos en dos, no en una columna infinita", async () => {
    const html = await unaPantalla();
    assert.match(html, /\.kpis \{ grid-template-columns:repeat\(2,1fr\)/);
  });

  test("la tabla de entrega no repite la palabra «Campo» en cada tarjeta", async () => {
    // Con el apilado genérico salia "CAMPO Destinatario". El nombre del
    // campo es el titulo de la tarjeta, que es como se lee de verdad.
    const html = await unaPantalla();
    assert.match(html, /\.entregaTabla td:first-child::before \{ display:none/);
  });

  test("el hilo del chat se limita para que el teclado no tape lo que escribes", async () => {
    // Con el teclado abierto quedan ~350px de alto. Un hilo sin limite
    // empujaba el area de escribir fuera de la pantalla.
    const html = await unaPantalla();
    assert.match(html, /\.chat \.hilo \{ max-height:48vh/);
  });

  test("respeta la muesca del iPhone", async () => {
    // Sin esto el ultimo boton de la pagina queda debajo de la barra de
    // gestos y no se puede tocar.
    const html = await unaPantalla();
    assert.match(html, /padding-bottom:calc\(16px \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(html, /viewport-fit=cover/);
  });

  test("hay botón de volver arriba, y solo aparece si hay scroll", async () => {
    const html = await unaPantalla();
    assert.match(html, /<a href="#arriba" class="subir"/);
    assert.match(html, /id="arriba"/, "sin el ancla el botón no lleva a ningún sitio");
    // El CSS lo limita al movil y el guion a cuando hace falta: un boton
    // flotante en una pantalla corta tapa contenido sin servir.
    assert.match(html, /\.subir \{[^}]*display:none/);
    assert.match(html, /\.subir \{ display:flex/);
    assert.match(html, /scrollHeight - window\.innerHeight\) > 400/);
  });

  test("el botón de volver arriba tiene nombre accesible", async () => {
    const html = await unaPantalla();
    assert.match(html, /aria-label="Volver arriba"/);
  });
});
