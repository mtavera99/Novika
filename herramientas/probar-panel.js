"use strict";

// ==========================================================================
// COMPROBAR EL PANEL DE VERDAD
//
// No "leer el codigo y decir que esta bien": arranca el servidor, siembra
// conversaciones de todas las clases y recorre las rutas con peticiones
// reales, comprobando lo que sale en el HTML.
//
// Siembra a proposito los casos que mas se esconden:
//
//   · un chat SIN pedido (el que pregunto y no compro: ahi estan las fugas)
//   · uno en posventa, con pedido confirmado
//   · uno tomado por una persona
//   · uno ya atendido
//   · uno con una pregunta PENDIENTE de contestar
//   · 60 de relleno, para que la paginacion tenga algo que paginar
//
//   node herramientas/probar-panel.js
// ==========================================================================

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const RAIZ = path.join(__dirname, "..");
// OJO: se siembra en EL MISMO almacen que lee la app. `entornoDePrueba`
// crea la carpeta y pone DATA_DIR; si se sembrara en otra, el panel
// responderia 200 con la bandeja VACIA y pareceria que todo funciona.
const DIR = require(path.join(RAIZ, "test", "ayuda")).entornoDePrueba({
  PANEL_TOKEN: "token-de-comprobacion",
});

// EL MISMO constructor que usa la app, no `crearReposDeArchivos` a pelo:
// la app abre `DATA_DIR/transaccional`, asi que sembrar en `DATA_DIR` deja
// el panel respondiendo 200 con la bandeja vacia. Pasa por desapercibido
// justo porque no da error.
const { crearRepos } = require(path.join(RAIZ, "src", "almacen", "repos"));
const { config: cfgDatos } = require(path.join(RAIZ, "src", "config"));
const atencion = require(path.join(RAIZ, "src", "almacen", "atencion"));
const campos = require(path.join(RAIZ, "src", "dominio", "campos"));
const datos = require(path.join(RAIZ, "src", "panel", "datos"));
const vistas = require(path.join(RAIZ, "src", "panel", "vistas"));

const confirmado = (valor) => {
  let c = campos.proponer(undefined, valor, campos.ORIGENES.CLIENTE);
  return campos.confirmar(c, (v) => ({ ok: true, valor: v }));
};

/** Una conversacion con la forma que espera el panel. */
function conv(id, { nombre, ciudad, direccion, mensajes = [], estado = "captura", extra = {} }) {
  return {
    contactoId: id,
    telefono: id,
    estado,
    productoId: "cinturon-termico-colicos",
    ficha: {
      nombre: nombre ? confirmado(nombre) : campos.campoVacio ? campos.campoVacio() : undefined,
      telefono: confirmado(id.replace(/^57/, "")),
      ciudad: ciudad ? confirmado(ciudad) : undefined,
      direccion: direccion ? confirmado(direccion) : undefined,
    },
    mensajes,
    ...extra,
  };
}

const m = (de, texto, minutosAtras) => ({
  de,
  texto,
  ts: new Date(Date.now() - minutosAtras * 60000).toISOString(),
});

(async () => {
  const repos = await crearRepos({ dirDatos: cfgDatos.dirDatos, databaseUrl: cfgDatos.databaseUrl });

  // ---- 1. SIN PEDIDO: pregunto y no compro ----
  await repos.conversaciones.guardar(
    conv("573001110001", {
      nombre: "Luz Marina",
      ciudad: "Palmira",
      mensajes: [m("cliente", "cuanto vale", 40), m("bot", "una unidad te queda en $49.900", 39)],
    })
  );

  // ---- 2. ESPERANDO: el cliente escribio y nadie contesto ----
  await repos.conversaciones.guardar(
    conv("573001110002", {
      nombre: "Ana",
      ciudad: "Cali",
      mensajes: [m("bot", "¿te lo despacho?", 30), m("cliente", "y esto sirve de noche?", 12)],
    })
  );

  // ---- 3. TOMADO POR UNA PERSONA ----
  await repos.conversaciones.guardar(
    conv("573001110003", {
      nombre: "Pedro",
      ciudad: "Medellin",
      mensajes: [m("cliente", "tienen local?", 50), m("operador", "te atiendo yo", 45)],
      extra: { atencion: { pausado: true, por: "marco", desde: new Date(Date.now() - 45 * 60000).toISOString() } },
    })
  );

  // ---- 4. ATENDIDO ----
  await repos.conversaciones.guardar(
    conv("573001110004", {
      nombre: "Sofia",
      ciudad: "Bogota",
      mensajes: [m("cliente", "ya me llego, gracias", 120)],
      extra: { atencion: { atendidoEn: new Date(Date.now() - 100 * 60000).toISOString(), atendidoPor: "marco" } },
    })
  );

  // ---- 5. CON PEDIDO + PREGUNTA PENDIENTE ----
  const conPedido = conv("573001110005", {
    nombre: "Carolina",
    ciudad: "Pereira",
    direccion: "Carrera 9 # 45-67",
    estado: "posventa",
    mensajes: [m("cliente", "cuanto vale otro?", 20), m("bot", "2 unidades te quedan en $85.000", 19)],
  });
  atencion.anotarPendiente(conPedido, {
    motivo: atencion.MOTIVOS_PENDIENTE.OTRA_COMPRA,
    pregunta: "cuanto vale otro?",
  });
  await repos.conversaciones.guardar(conPedido);
  await repos.pedidos.crearSiNoExiste({
    id: "NOV-PRUEBA1-AAAA1111",
    version: 1,
    // Sin estas dos claves el almacen RECHAZA el pedido, y con razon: un
    // pedido que no se puede deduplicar es un duplicado futuro.
    claveDeEvento: "wamid.SEMILLA1",
    claveDeOferta: "oferta-semilla-1",
    estado: "confirmado",
    contactoId: "573001110005",
    producto: { id: "cinturon-termico-colicos", nombre: "Cinturón térmico NOVIKA" },
    cantidad: 1,
    destinatario: {
      nombre: "Carolina",
      telefono: "3001110005",
      ciudad: "Pereira",
      departamento: "Risaralda",
      direccion: "Carrera 9 # 45-67",
    },
    // La cotizacion con la forma REAL que devuelve el cotizador: si se
    // siembra una inventada, el panel parece roto o parece bueno por el
    // motivo equivocado.
    cotizacion: {
      productoId: "cinturon-termico-colicos",
      productoNombre: "Cinturón térmico NOVIKA",
      cantidad: 1,
      subtotal: 49900,
      envio: 0,
      total: 49900,
      condiciones: {
        politicaEnvio: "incluido",
        envioIncluido: true,
        pagoMetodo: "contraentrega",
        pagoEtiqueta: "Pagas al recibir (contra entrega)",
      },
    },
    creadoEn: new Date().toISOString(),
    historial: [],
  });

  // ---- 6. RELLENO para la paginacion ----
  for (let i = 10; i < 70; i++) {
    await repos.conversaciones.guardar(
      conv(`5730011100${i}`, {
        nombre: `Cliente ${i}`,
        ciudad: "Cali",
        mensajes: [m("cliente", `mensaje de relleno ${i}`, 200 + i)],
      })
    );
  }

  const total = (await repos.conversaciones.listar({ limite: 5000 })).length;
  console.log(`Sembradas ${total} conversaciones y 1 pedido en ${DIR}\n`);

  // ======================================================================
  // COMPROBACIONES SOBRE LA CAPA DE DATOS
  // ======================================================================
  console.log("=".repeat(70));
  console.log("  FILTROS Y PAGINACION");
  console.log("=".repeat(70));

  for (const filtro of Object.values(datos.FILTROS)) {
    const b = await datos.bandeja(repos, { filtro, pagina: 1 });
    console.log(
      `  ${filtro.padEnd(12)} total:${String(b.total).padStart(3)}  ` +
        `paginas:${b.paginas}  en esta pagina:${b.filas.length}`
    );
  }

  console.log("\n  --- paginacion del filtro TODOS ---");
  const p1 = await datos.bandeja(repos, { pagina: 1 });
  const p2 = await datos.bandeja(repos, { pagina: 2 });
  const p3 = await datos.bandeja(repos, { pagina: 3 });
  console.log(`  pagina 1: ${p1.filas.length}  pagina 2: ${p2.filas.length}  pagina 3: ${p3.filas.length}`);
  const ids = new Set([...p1.filas, ...p2.filas, ...p3.filas].map((f) => f.contactoId));
  console.log(`  distintos en 3 paginas: ${ids.size} de ${p1.total} (no deben repetirse ni perderse)`);
  const fuera = p1.total - ids.size;
  console.log(`  ${fuera === 0 ? "OK: ninguna conversacion se queda fuera" : `OJO: ${fuera} sin mostrar`}`);

  console.log("\n  --- busqueda ---");
  for (const q of ["Carolina", "Palmira", "3001110002", "sirve de noche", "no-existe-nada"]) {
    const b = await datos.bandeja(repos, { q });
    console.log(`  "${q}".padEnd -> ${b.total} resultado(s)`);
  }

  console.log("\n" + "=".repeat(70));
  console.log("  LA FICHA DE UN CHAT");
  console.log("=".repeat(70));
  const ficha = await datos.conversacionCompleta(repos, "573001110005");
  if (!ficha) {
    console.log("  OJO: conversacionCompleta no devolvio nada");
  } else {
    console.log(`  claves: ${Object.keys(ficha).join(", ")}`);
    console.log(`  mensajes en el historial: ${(ficha.mensajes || []).length}`);
    console.log(`  pedidos: ${(ficha.pedidos || []).length}`);
    if (ficha.pedidos && ficha.pedidos[0]) {
      const p = ficha.pedidos[0];
      console.log(`  pedido -> ${p.id} · ${p.estado} · ${JSON.stringify(p.destinatario && p.destinatario.direccion)}`);
    }
  }

  // ======================================================================
  // EL PANEL POR HTTP, COMO LO VE MARCO
  // ======================================================================
  console.log("\n" + "=".repeat(70));
  console.log("  POR HTTP");
  console.log("=".repeat(70));

  const { crearApp } = require(path.join(RAIZ, "src", "app"));
  const app = crearApp();
  const servidor = http.createServer(app);
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  // El panel se autentica con COOKIE DE SESION, no con ?token=. Se entra
  // igual que Marco: POST al formulario y se guarda la cookie.
  const entrada = await fetch(`${base}/panel/entrar`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "token=token-de-comprobacion",
    redirect: "manual",
  });
  const galleta = (entrada.headers.get("set-cookie") || "").split(";")[0];
  console.log(`  entrada: ${entrada.status} · cookie ${galleta ? "recibida" : "NO RECIBIDA"}`);

  const pedir = async (ruta) => {
    const r = await fetch(`${base}${ruta}`, { redirect: "manual", headers: { Cookie: galleta } });
    const cuerpo = r.status < 400 ? await r.text() : "";
    return { estado: r.status, cuerpo };
  };

  const T = "x=1";
  const rutas = [
    `/panel/chats?${T}`,
    `/panel/chats?${T}&filtro=sin_pedido`,
    `/panel/chats?${T}&filtro=esperando`,
    `/panel/chats?${T}&filtro=con_pedido`,
    `/panel/chats?${T}&q=Carolina`,
    `/panel/chats?${T}&pagina=2`,
    `/panel/chat?${T}&id=573001110005`,
    `/panel/sin-responder?${T}`,
    `/panel?${T}`,
  ];

  for (const ruta of rutas) {
    const r = await pedir(ruta);
    const marca = r.estado === 200 ? "OK " : "FAL";
    console.log(`  [${marca}] ${String(r.estado).padEnd(4)} ${ruta}  (${r.cuerpo.length} bytes)`);
  }

  // Lo que tiene que APARECER en la ficha del chat, que es la lista del punto 5.
  console.log("\n  --- que se ve en la ficha del chat ---");
  const f = await pedir(`/panel/chat?${T}&id=573001110005`);
  const esperado = {
    nombre: /Carolina/,
    telefono: /3001110005/,
    ciudad: /Pereira/,
    "dirección completa": /Carrera 9 # 45-67/,
    producto: /[Cc]intur/,
    cantidad: />\s*1\s*</,
    total: /49\.900/,
    pago: /contra\s*entrega|al recibir/i,
    "estado del pedido": /confirmado/i,
    "numero de pedido": /NOV-PRUEBA1/,
    "quien atiende": /bot|persona|operador/i,
    "pregunta pendiente (marcada como tal)": /pendiente de|espera respuesta|otra compra|quiere_otra/i,
  };
  for (const [que, re] of Object.entries(esperado)) {
    console.log(`  ${re.test(f.cuerpo) ? "OK " : "FALTA"}  ${que}`);
  }

  console.log("\n  --- la bandeja distingue las clases ---");
  const b = await pedir(`/panel/chats?${T}&filtro=con_pedido`);
  const bEsp = await pedir(`/panel/chats?${T}&q=Pedro`);
  for (const [que, re] of Object.entries({
    "columna de ciudad": /Pereira/,
    "ultimo mensaje": /85\.000|cuanto vale/i,
    "pregunta pendiente marcada": /espera|pendiente/i,
  })) {
    console.log(`  ${re.test(b.cuerpo) ? "OK " : "FALTA"}  ${que}`);
  }
  for (const [que, re] of Object.entries({ "marca de persona (chat tomado)": /persona/i })) {
    console.log(`  ${re.test(bEsp.cuerpo) ? "OK " : "FALTA"}  ${que}`);
  }

  // ¿Se puede enviar algo sin querer con una peticion GET?
  console.log("\n  --- auditar sin tocar: los GET no deben actuar ---");
  const antes = (await repos.conversaciones.obtener("573001110001")).atencion;
  await pedir(`/panel/control?${T}&id=573001110001&accion=tomar`);
  await pedir(`/panel/responder?${T}&id=573001110001&texto=hola`);
  const despues = (await repos.conversaciones.obtener("573001110001")).atencion;
  console.log(
    `  ${JSON.stringify(antes) === JSON.stringify(despues) ? "OK " : "OJO"}  un GET no cambió el estado de atención`
  );

  servidor.close();
  console.log("");
})().catch((e) => {
  console.error("REVENTO:", e.message);
  console.error(e.stack);
  process.exitCode = 1;
});
