"use strict";

// ==========================================================================
// AUDITAR LAS CONVERSACIONES REALES
//
// MODO LECTURA ESTRICTO. No escribe en el almacen, no manda mensajes, no
// toca pedidos, no cambia interruptores. No construye el emisor ni el
// cerebro: solo lee conversaciones y pedidos y clasifica lo que ya paso.
//
// POR QUE EXISTE: desde que hay publicidad, cada conversacion cuesta
// dinero. Saber cuantas se perdieron es menos util que saber POR QUE, y la
// distincion que mas importa es la que Marco pidio: un cliente que se calla
// no demuestra un fallo del bot. La mayoria de los abandonos en WhatsApp
// son gente que estaba mirando. Confundirlos con defectos lleva a
// "arreglar" cosas que no estan rotas y a no ver las que si.
//
// LO QUE ESTA HERRAMIENTA SI PUEDE AFIRMAR, porque se lee en el historial:
//
//   · una pregunta del cliente sin ninguna respuesta del negocio detras
//   · dos mensajes del negocio con el MISMO texto
//   · que se pidieron datos de entrega antes de cualquier señal de compra
//   · una señal de compra sin que el negocio contestara nada
//   · un mensaje del negocio que se preparo y NO salio
//
// LO QUE NO PUEDE AFIRMAR, y por eso lo cuenta aparte:
//
//   · que el cliente se fue "por culpa" del bot. Si el bot respondio y el
//     cliente no volvio a escribir, eso es SILENCIO, no un defecto.
//
// DATOS PERSONALES: los telefonos salen enmascarados y los nombres como
// inicial. Para auditar hace falta saber QUE paso, no quien es.
//
//   node herramientas/auditar.js
//   node herramientas/auditar.js --desde=2026-10-01
//   node herramientas/auditar.js --mios=573058742138,573001112233
//   node herramientas/auditar.js --detalle          transcripciones completas
// ==========================================================================

const path = require("node:path");

const RAIZ = path.join(__dirname, "..");
const { config } = require(path.join(RAIZ, "src", "config"));
const { crearRepos } = require(path.join(RAIZ, "src", "almacen", "repos"));
const atencion = require(path.join(RAIZ, "src", "almacen", "atencion"));
const preguntas = require(path.join(RAIZ, "src", "dominio", "preguntas"));
const fichaDe = require(path.join(RAIZ, "src", "panel", "ficha"));

// --------------------------------------------------------------------------
// Argumentos
// --------------------------------------------------------------------------
const arg = (nombre, pordefecto = null) => {
  const encontrado = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.slice(nombre.length + 3) : pordefecto;
};
const DESDE = arg("desde");
const DETALLE = process.argv.includes("--detalle");

// Los numeros de Marco y de quien pruebe. Por defecto, la lista de prueba
// que ya esta configurada: si alguna vez se uso, son exactamente los
// numeros con los que se probaba.
const MIOS = new Set(
  String(arg("mios", (config.numerosDePrueba || []).join(",")) || "")
    .split(",")
    .map((n) => n.replace(/\D/g, ""))
    .filter(Boolean)
);

/** Telefono enmascarado: suficiente para distinguir, no para identificar. */
const tapar = (id) => {
  const d = String(id || "").replace(/\D/g, "");
  if (d.length < 6) return "***";
  return `${d.slice(0, 5)}***${d.slice(-2)}`;
};

/** Nombre reducido a inicial. */
const inicial = (nombre) => {
  const n = String(nombre || "").trim();
  return n ? `${n.charAt(0).toUpperCase()}.` : "—";
};

const corto = (t, max = 70) => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

// ==========================================================================
// EL ANALISIS DE UNA CONVERSACION
// ==========================================================================
function auditar(conv, susPedidos) {
  const mensajes = atencion.mensajes(conv).filter((m) => m && m.ts);
  const hallazgos = [];

  const delCliente = (m) => m.de === atencion.QUIEN.CLIENTE;
  const delNegocio = (m) => !delCliente(m);

  // ---- 1. PREGUNTAS SIN RESPUESTA ----
  //
  // Una pregunta del cliente sin NINGUN mensaje del negocio despues. Esto
  // si es un fallo: el cliente escribio y nadie dijo nada.
  for (let i = 0; i < mensajes.length; i++) {
    const m = mensajes[i];
    if (!delCliente(m)) continue;
    const lectura = preguntas.leer(m.texto || "");
    const esPregunta = lectura.pregunta || lectura.pareceUnaPregunta;
    if (!esPregunta) continue;
    const huboRespuesta = mensajes.slice(i + 1).some(delNegocio);
    if (!huboRespuesta) {
      hallazgos.push({
        clase: "sin_respuesta",
        gravedad: "alta",
        detalle: `preguntó y nadie respondió: «${corto(m.texto)}»`,
      });
      break;
    }
  }

  // ---- 2. REPETICION LITERAL ----
  for (let i = 1; i < mensajes.length; i++) {
    const a = mensajes[i - 1];
    const b = mensajes[i];
    if (!delNegocio(a) || !delNegocio(b)) continue;
    if (!a.texto || !b.texto) continue;
    if (String(a.texto).trim() === String(b.texto).trim()) {
      hallazgos.push({
        clase: "repitio",
        gravedad: "media",
        detalle: `mandó el mismo texto dos veces: «${corto(a.texto, 50)}»`,
      });
      break;
    }
  }

  // ---- 3. PIDIO DATOS DEMASIADO PRONTO ----
  //
  // Datos de entrega antes de cualquier señal de compra. Es el defecto que
  // BIKERPRO documento como el que mas espanta a quien esta averiguando.
  const PIDE_DATOS = /\bme pasas\b|\bnombre completo\b|\bla direcci[oó]n\b|\bcu[aá]l es tu ciudad\b/i;
  let huboCompraAntes = false;
  for (const m of mensajes) {
    if (delCliente(m)) {
      if (preguntas.leer(m.texto || "").compra) huboCompraAntes = true;
      continue;
    }
    if (!huboCompraAntes && PIDE_DATOS.test(m.texto || "")) {
      hallazgos.push({
        clase: "datos_pronto",
        gravedad: "media",
        detalle: "pidió datos de entrega antes de cualquier señal de compra",
      });
      break;
    }
  }

  // ---- 4. INTENCION DE COMPRA SIN ATENDER ----
  //
  // Dijo que lo quiere y el negocio no contesto nada despues. Es la perdida
  // mas cara de todas: no es alguien mirando, es alguien comprando.
  for (let i = 0; i < mensajes.length; i++) {
    const m = mensajes[i];
    if (!delCliente(m)) continue;
    if (!preguntas.leer(m.texto || "").compra) continue;
    const contestaron = mensajes.slice(i + 1).some(delNegocio);
    if (!contestaron) {
      hallazgos.push({
        clase: "compra_sin_atender",
        gravedad: "alta",
        detalle: `dijo que lo quería y nadie contestó: «${corto(m.texto)}»`,
      });
      break;
    }
  }

  // ---- 5. MENSAJES QUE NO SALIERON ----
  const noSalieron = mensajes.filter((m) => delNegocio(m) && m.estado && m.estado !== "enviado");
  if (noSalieron.length) {
    hallazgos.push({
      clase: "no_salio",
      gravedad: "alta",
      detalle: `${noSalieron.length} mensaje(s) del negocio no se enviaron (estado: ${noSalieron[0].estado})`,
    });
  }

  // ---- 6. TAREA PENDIENTE ----
  const pendiente = atencion.pendienteDe(conv);
  if (pendiente.hay) {
    hallazgos.push({
      clase: "pendiente",
      gravedad: "media",
      detalle: `espera a una persona desde ${pendiente.desde} · ${pendiente.motivo}`,
    });
  }

  // ---- DONDE SE DETUVO, Y DE QUIEN FUE EL ULTIMO TURNO ----
  const ultimo = mensajes.length ? mensajes[mensajes.length - 1] : null;
  const vivos = susPedidos.filter((p) => p.estado !== "cancelado");

  let desenlace;
  if (vivos.length) desenlace = "compró";
  else if (!ultimo) desenlace = "sin mensajes";
  else if (delCliente(ultimo)) desenlace = "se quedó esperando respuesta";
  else desenlace = "silencio del cliente";

  return {
    contactoId: conv.contactoId,
    nombre: fichaDe.leer(conv.ficha, "nombre").valor,
    ciudad: fichaDe.leer(conv.ficha, "ciudad").valor,
    estado: conv.estado,
    mensajes: mensajes.length,
    delCliente: mensajes.filter(delCliente).length,
    primero: mensajes.length ? mensajes[0].ts : null,
    ultimoTs: ultimo ? ultimo.ts : null,
    desenlace,
    pedidos: vivos.length,
    hallazgos,
    transcripcion: mensajes,
  };
}

// ==========================================================================
(async () => {
  if (!config.databaseUrl && !config.dirDatos) {
    console.error("No hay almacen configurado: hace falta DATABASE_URL o DATA_DIR.");
    process.exitCode = 1;
    return;
  }

  const repos = await crearRepos({ dirDatos: config.dirDatos, databaseUrl: config.databaseUrl });

  console.log(`\nAlmacén: ${repos.tipo}${config.databaseUrl ? " (DATABASE_URL)" : ` (${config.dirDatos})`}`);
  console.log("MODO LECTURA: no se escribe, no se envía, no se toca ningún pedido.\n");

  const todas = await repos.conversaciones.listar({ limite: 20000 });
  const pedidos = await repos.pedidos.listar({ limite: 40000 });

  const porContacto = new Map();
  for (const p of pedidos) {
    const l = porContacto.get(p.contactoId) || [];
    l.push(p);
    porContacto.set(p.contactoId, l);
  }

  const desdeTs = DESDE ? new Date(`${DESDE}T00:00:00.000Z`).getTime() : null;

  const todos = todas.map((c) => auditar(c, porContacto.get(c.contactoId) || []));

  // Filtro por fecha, sobre el PRIMER mensaje: "desde que activamos la
  // publicidad" son las conversaciones que EMPEZARON despues.
  const enRango = todos.filter((a) => {
    if (!desdeTs) return true;
    if (!a.primero) return false;
    return new Date(a.primero).getTime() >= desdeTs;
  });

  // SEPARAR MIS PRUEBAS DE LOS CLIENTES REALES. Mezclarlas falsea todo:
  // las pruebas tienen conversaciones raras a proposito.
  const esMio = (a) => MIOS.has(String(a.contactoId).replace(/\D/g, ""));
  const mias = enRango.filter(esMio);
  const reales = enRango.filter((a) => !esMio(a));

  const linea = "─".repeat(74);

  console.log(linea);
  console.log("  RESUMEN");
  console.log(linea);
  console.log(`  conversaciones en el almacén        ${todas.length}`);
  if (DESDE) console.log(`  empezadas desde ${DESDE}            ${enRango.length}`);
  console.log(`  mis pruebas (excluidas del análisis) ${mias.length}` + (MIOS.size ? "" : "   ← no hay números de prueba configurados"));
  console.log(`  CLIENTES REALES                      ${reales.length}`);

  if (!reales.length) {
    console.log("\n  No hay conversaciones de clientes reales en el rango.");
    if (!MIOS.size) {
      console.log("  OJO: sin --mios= no se puede separar tus pruebas. Pásalos para que el análisis sea válido.");
    }
    await repos.cerrar();
    return;
  }

  const compraron = reales.filter((a) => a.pedidos > 0);
  const esperando = reales.filter((a) => a.desenlace === "se quedó esperando respuesta");
  const silencio = reales.filter((a) => a.desenlace === "silencio del cliente");

  console.log(`\n  compraron                            ${compraron.length}  (${((compraron.length / reales.length) * 100).toFixed(1)}%)`);
  console.log(`  se quedaron esperando respuesta      ${esperando.length}   ← esto SÍ es un fallo nuestro`);
  console.log(`  silencio del cliente tras responder  ${silencio.length}   ← NO demuestra un defecto`);

  // ---- LOS HALLAZGOS, AGRUPADOS ----
  const porClase = new Map();
  for (const a of reales) {
    for (const h of a.hallazgos) {
      const l = porClase.get(h.clase) || [];
      l.push({ ...a, detalle: h.detalle, gravedad: h.gravedad });
      porClase.set(h.clase, l);
    }
  }

  const NOMBRES = {
    sin_respuesta: "Preguntó y NADIE respondió",
    compra_sin_atender: "Dijo que lo quería y nadie contestó",
    no_salio: "Mensajes del negocio que no se enviaron",
    repitio: "El bot repitió el mismo texto",
    datos_pronto: "Pidió datos antes de cualquier señal de compra",
    pendiente: "Esperando a una persona",
  };
  const ORDEN = ["sin_respuesta", "compra_sin_atender", "no_salio", "repitio", "datos_pronto", "pendiente"];

  console.log(`\n${linea}`);
  console.log("  HALLAZGOS (solo clientes reales)");
  console.log(linea);
  let hubo = false;
  for (const clase of ORDEN) {
    const lista = porClase.get(clase);
    if (!lista || !lista.length) continue;
    hubo = true;
    console.log(`\n  ${NOMBRES[clase]} — ${lista.length} caso(s)`);
    for (const c of lista.slice(0, 12)) {
      console.log(`     ${tapar(c.contactoId)} · ${inicial(c.nombre)} · ${c.ciudad || "sin ciudad"} · ${c.mensajes} msj`);
      console.log(`        ${c.detalle}`);
    }
    if (lista.length > 12) console.log(`     … y ${lista.length - 12} más`);
  }
  if (!hubo) console.log("\n  Ningún hallazgo: ninguna conversación real muestra un fallo del bot.");

  // ---- DONDE SE DETUVIERON LAS QUE NO COMPRARON ----
  console.log(`\n${linea}`);
  console.log("  DÓNDE SE DETUVO (las que no compraron)");
  console.log(linea);
  const porEstado = new Map();
  for (const a of reales.filter((x) => !x.pedidos)) {
    porEstado.set(a.estado, (porEstado.get(a.estado) || 0) + 1);
  }
  for (const [estado, n] of [...porEstado.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(estado).padEnd(26)} ${n}`);
  }

  // ---- TRANSCRIPCIONES ----
  if (DETALLE) {
    console.log(`\n${linea}`);
    console.log("  TRANSCRIPCIONES DE LOS CASOS CON HALLAZGOS");
    console.log(linea);
    for (const a of reales.filter((x) => x.hallazgos.length).slice(0, 15)) {
      console.log(`\n  ── ${tapar(a.contactoId)} · ${inicial(a.nombre)} · ${a.estado} · ${a.desenlace}`);
      for (const h of a.hallazgos) console.log(`     ! ${h.detalle}`);
      for (const m of a.transcripcion) {
        const quien = m.de === atencion.QUIEN.CLIENTE ? "cliente" : m.de === atencion.QUIEN.OPERADOR ? "persona" : "NOVIKA ";
        const fallo = m.estado && m.estado !== "enviado" ? `  [${m.estado}]` : "";
        console.log(`     ${quien} · ${corto(m.texto, 90)}${fallo}`);
      }
    }
  }

  console.log("");
  await repos.cerrar();
})().catch((e) => {
  console.error("REVENTÓ:", e.message);
  console.error(e.stack);
  process.exitCode = 1;
});
