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
const diario = require(path.join(RAIZ, "src", "almacen", "diario"));

// --------------------------------------------------------------------------
// Argumentos
// --------------------------------------------------------------------------
const arg = (nombre, pordefecto = null) => {
  const encontrado = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado ? encontrado.slice(nombre.length + 3) : pordefecto;
};
const DESDE = arg("desde");
const DETALLE = process.argv.includes("--detalle");
// Para separar los fallos HISTORICOS de los que siguen pasando con la
// version de ahora: todo lo anterior a esta fecha/hora es historico.
const DESDE_VERSION = arg("desde-version");
// --crudo: NO enmascara. Es para mirarlo en el panel propio, donde los
// datos ya son tuyos. El enmascarado existe para poder PEGARME la salida
// sin exponer a nadie, no para esconderte tus clientes — y me hizo
// afirmar de donde era un numero mirando cinco digitos recortados.
const CRUDO = process.argv.includes("--crudo");

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
  if (CRUDO) return String(id || "(vacío)");
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
// ==========================================================================
// INTENTO, ACEPTACION Y ENTREGA SON TRES COSAS DISTINTAS
//
// LA PRIMERA VERSION DE ESTA HERRAMIENTA SE EQUIVOCO AQUI, y Marco lo cazo:
// contaba CUALQUIER mensaje del negocio como "respuesta recibida", incluido
// uno que no salio. Una pregunta seguida de un envio fallido quedaba
// clasificada como atendida. El cliente no recibio nada y la auditoria
// decia que si.
//
// Y clasificar mal en una auditoria es peor que no auditar: lleva a
// conclusiones con numeros detras, que son las que mas se creen.
//
// LOS TRES NIVELES, y lo que cada uno significa de verdad:
//
//   intento    -> el texto se preparo. Puede no haber salido: modo sombra,
//                 chat pausado, lista de prueba, fallo de red.
//   aceptado   -> Meta devolvio 200 y un wamid. ES LO MAXIMO QUE SABE EL
//                 EMISOR, y no significa que el cliente lo recibiera.
//   entregado  -> llego el acuse `delivered` o `read` por el webhook de
//                 `statuses`. Es el unico nivel que demuestra recepcion.
//   fallido    -> acuse `failed`, con el error del proveedor.
//
// Los acuses SI se procesan y se anotan en el diario -con destinatario y
// errores- pero NO se escriben en el mensaje de la conversacion. Por eso
// esto cruza las dos fuentes: el chat dice que se intento, el diario dice
// que paso.
// ==========================================================================
const NIVELES = { INTENTO: "intento", ACEPTADO: "aceptado", ENTREGADO: "entregado", FALLIDO: "fallido" };

/**
 * Lo que el diario sabe de cada wamid: el acuse mas avanzado y, si fallo,
 * el error del proveedor y el destinatario.
 */
function acusesDelDiario(entradas) {
  const porWamid = new Map();
  const RANGO = { sent: 1, delivered: 2, read: 3 };

  for (const e of entradas || []) {
    const d = e.datos || e;
    if (!d || !d.wamid) continue;

    if (e.tipo === "estado" || d.estado) {
      const estado = String(d.estado || "");
      const previo = porWamid.get(d.wamid) || {};
      if (estado === "failed") {
        porWamid.set(d.wamid, {
          ...previo,
          nivel: NIVELES.FALLIDO,
          errores: d.errores || null,
          para: d.para || previo.para || null,
          cuando: e.cuando || d.cuando || previo.cuando || null,
        });
        continue;
      }
      const rango = RANGO[estado] || 0;
      const rangoPrevio = RANGO[previo.acuse] || 0;
      if (previo.nivel === NIVELES.FALLIDO) continue;
      if (rango >= rangoPrevio) {
        porWamid.set(d.wamid, {
          ...previo,
          acuse: estado,
          nivel: rango >= 2 ? NIVELES.ENTREGADO : NIVELES.ACEPTADO,
          para: d.para || previo.para || null,
          cuando: e.cuando || d.cuando || previo.cuando || null,
        });
      }
    }
  }
  return porWamid;
}

function auditar(conv, susPedidos, acuses) {
  const mensajes = atencion.mensajes(conv).filter((m) => m && m.ts);
  const hallazgos = [];

  const delCliente = (m) => m.de === atencion.QUIEN.CLIENTE;
  const delNegocio = (m) => !delCliente(m);

  /** El nivel real de un mensaje del negocio, cruzando chat y diario. */
  const nivelDe = (m) => {
    const delDiario = m.wamid ? acuses.get(m.wamid) : null;
    if (delDiario && delDiario.nivel) return delDiario;
    // Sin acuse, lo maximo que sabemos es lo que anoto el emisor.
    if (m.estado === "enviado") return { nivel: NIVELES.ACEPTADO };
    return { nivel: NIVELES.INTENTO, motivo: m.estado || "sin estado" };
  };

  // LO QUE CUENTA COMO RESPUESTA RECIBIDA: aceptado por el proveedor o
  // entregado. Un intento que no salio NO es una respuesta.
  const llegoAlCliente = (m) => {
    const n = nivelDe(m).nivel;
    return n === NIVELES.ACEPTADO || n === NIVELES.ENTREGADO;
  };
  const respondieron = (lista) => lista.some((m) => delNegocio(m) && llegoAlCliente(m));

  // ---- 1. PREGUNTAS SIN RESPUESTA ----
  //
  // Una pregunta del cliente sin NINGUN mensaje del negocio despues. Esto
  // si es un fallo: el cliente escribio y nadie dijo nada.
  for (let i = 0; i < mensajes.length; i++) {
    const m = mensajes[i];
    if (!delCliente(m)) continue;
    const lectura = preguntas.leer(m.texto || "");
    // Pedir INFORMACION cuenta como pregunta: es el primer mensaje tipico
    // de quien llega por la publicidad, y no atenderlo es el fallo mas caro.
    const esPregunta = lectura.pregunta || lectura.pareceUnaPregunta || lectura.pideInformacion;
    if (!esPregunta) continue;
    // Solo cuenta si LLEGO. Antes contaba cualquier mensaje del negocio,
    // asi que una pregunta seguida de un envio fallido salia como atendida.
    const huboRespuesta = respondieron(mensajes.slice(i + 1));
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
    const contestaron = respondieron(mensajes.slice(i + 1));
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
  const noLlegaron = mensajes.filter((m) => delNegocio(m) && !llegoAlCliente(m));
  for (const m of noLlegaron) {
    const n = nivelDe(m);
    // LOS CAMPOS VAN EN CASTELLANO, como todo el repo: `normalizar.js` los
    // guarda como {codigo, titulo, detalle}. Esta funcion los leia como
    // {code, title, details} -en ingles- asi que `filter(Boolean)` se
    // quedaba sin nada y la auditoria decia "el proveedor no reportó
    // error" habiendo guardado el error.
    //
    // Era el dato mas importante de los tres fallos de envio: sin el codigo
    // no se puede saber si es la ventana de 24 horas, un numero sin
    // WhatsApp o una restriccion de la cuenta — y cada causa se arregla en
    // un sitio distinto. Se aceptan los dos nombres por si algun evento
    // viejo quedo guardado con el otro.
    const err = n.errores && (Array.isArray(n.errores) ? n.errores.length : true)
      ? (Array.isArray(n.errores) ? n.errores : [n.errores])
          .map((e) =>
            [e.codigo || e.code, e.titulo || e.title || e.message, e.detalle || e.details]
              .filter(Boolean)
              .join(" · ")
          )
          .filter(Boolean)
          .join(" | ")
      : null;
    hallazgos.push({
      clase: n.nivel === NIVELES.FALLIDO ? "fallo_de_envio" : "no_salio",
      gravedad: "alta",
      cuando: m.ts,
      // DE DONDE SALE CADA IDENTIFICADOR, dicho en la propia linea.
      //
      // Se imprimia uno solo, sin decir si venia del `recipient_id` del
      // acuse de Meta o del contacto de la conversacion. Si los dos no
      // coinciden, hay un cruce — y mirando un numero recortado no se
      // puede saber cual es cual. Ahora se ven los dos y su origen.
      detalle:
        `canal whatsapp · contacto ${tapar(conv.contactoId)}` +
        (n.para && String(n.para) !== String(conv.contactoId)
          ? ` · recipient_id del acuse ${tapar(n.para)}  <-- NO COINCIDE`
          : n.para
            ? " · recipient_id del acuse coincide"
            : " · el acuse no trajo recipient_id") +
        ` · ` +
        `nivel ${n.nivel}${n.motivo ? ` (${n.motivo})` : ""}` +
        (err ? ` · error del proveedor: ${err}` : " · el proveedor no reportó error"),
      texto: m.texto || "",
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
  else if (!llegoAlCliente(ultimo)) desenlace = "nuestra última respuesta NO salió";
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
    // La transcripcion con el nivel real de cada mensaje del negocio.
    transcripcion: mensajes.map((m) => (delNegocio(m) ? { ...m, nivel: nivelDe(m) } : m)),
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

  // El diario: es donde viven los acuses del proveedor y sus errores. Sin
  // esto, "enviado" se confunde con "recibido".
  let entradas = [];
  try {
    entradas = diario.ultimas(20000) || [];
  } catch (e) {
    console.log(`  (no se pudo leer el diario: ${e.message} — se audita solo con el chat)`);
  }
  const acuses = acusesDelDiario(entradas);
  console.log(`Diario: ${entradas.length} entradas · ${acuses.size} wamid con acuse del proveedor\n`);

  const porContacto = new Map();
  for (const p of pedidos) {
    const l = porContacto.get(p.contactoId) || [];
    l.push(p);
    porContacto.set(p.contactoId, l);
  }

  // ------------------------------------------------------------------
  // UNA FECHA MAL ESCRITA NO PUEDE PASAR EN SILENCIO
  //
  // `new Date("basura")` da NaN, y NaN es falsy: el filtro lo trataba como
  // "sin fecha" y auditaba TODO. Se comportaba bien por casualidad y sin
  // decir nada, asi que quien pidio un rango creia tenerlo y estaba viendo
  // el historico completo. En una auditoria eso es una conclusion
  // equivocada con numeros detras.
  // ------------------------------------------------------------------
  let desdeTs = null;
  if (DESDE) {
    const limpio = /^\d{4}-\d{2}-\d{2}$/.test(DESDE) ? `${DESDE}T00:00:00.000Z` : DESDE;
    const t = new Date(limpio).getTime();
    if (Number.isFinite(t)) {
      desdeTs = t;
    } else {
      console.log(
        `  OJO: no entiendo la fecha "${DESDE}". Se ignora el filtro y se auditan TODAS\n` +
          "  las conversaciones. El formato es AAAA-MM-DD, por ejemplo --desde=2026-10-01\n"
      );
    }
  }

  const todos = todas.map((c) => auditar(c, porContacto.get(c.contactoId) || [], acuses));

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
  if (desdeTs) console.log(`  empezadas desde ${DESDE}            ${enRango.length}`);
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

  // Lo que de verdad llego, por niveles. "aceptado" es lo maximo que sabe
  // el emisor; solo "entregado" demuestra que el cliente lo recibio.
  const porNivel = { intento: 0, aceptado: 0, entregado: 0, fallido: 0 };
  for (const a of reales) {
    for (const m of a.transcripcion) {
      if (m.nivel && m.nivel.nivel) porNivel[m.nivel.nivel] = (porNivel[m.nivel.nivel] || 0) + 1;
    }
  }
  console.log(`\n  mensajes nuestros: ${porNivel.intento} solo intento · ${porNivel.aceptado} aceptados por Meta · ` +
    `${porNivel.entregado} con acuse de entrega · ${porNivel.fallido} fallidos`);
  if (!porNivel.entregado) {
    console.log("  (sin acuses de entrega: o no llegan los webhooks de `statuses`, o el diario no los conserva)");
  }

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
    fallo_de_envio: "FALLO DE ENVÍO (el proveedor lo rechazó)",
    no_salio: "Se preparó y no salió (interruptor, pausa o lista de prueba)",
    repitio: "El bot repitió el mismo texto",
    datos_pronto: "Pidió datos antes de cualquier señal de compra",
    pendiente: "Esperando a una persona",
  };
  const ORDEN = ["fallo_de_envio", "sin_respuesta", "compra_sin_atender", "no_salio", "repitio", "datos_pronto", "pendiente"];

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
      const cuando = c.cuando || c.ultimoTs;
      const viejo = DESDE_VERSION && cuando && new Date(cuando) < new Date(DESDE_VERSION);
      const marca = DESDE_VERSION ? (viejo ? "  [histórico]" : "  [CON LA VERSIÓN ACTUAL]") : "";
      console.log(`     ${tapar(c.contactoId)} · ${inicial(c.nombre)} · ${c.ciudad || "sin ciudad"} · ${c.mensajes} msj · ${cuando || "sin fecha"}${marca}`);
      console.log(`        ${c.detalle}`);
      if (c.texto) console.log(`        texto completo: «${c.texto}»`);
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
        const n = m.nivel ? `  [${m.nivel.nivel}${m.nivel.acuse ? `/${m.nivel.acuse}` : ""}]` : "";
        console.log(`     ${String(m.ts).slice(0, 19)}  ${quien} · ${m.texto}${n}`);
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
