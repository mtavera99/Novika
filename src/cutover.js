"use strict";

// ==========================================================================
// npm run cutover · archivos -> PostgreSQL
//
// Copia contactos, conversaciones y pedidos del disco a la base de datos.
//
// --------------------------------------------------------------------------
// LAS CUATRO PROPIEDADES QUE TIENE QUE CUMPLIR
// --------------------------------------------------------------------------
//
// 1. IDEMPOTENTE. Correrlo dos veces deja el mismo resultado. Todo entra con
//    ON CONFLICT DO NOTHING contra las claves naturales, asi que un segundo
//    pase no duplica nada. Importa porque la primera vez puede cortarse a
//    mitad y hay que poder repetirlo sin pensar.
//
// 2. NO PIERDE. Al final compara los conteos de origen y destino y FALLA si
//    no cuadran. Un cutover que dice "listo" habiendo dejado pedidos atras
//    es peor que uno que falla.
//
// 3. NO DUPLICA. Los pedidos llevan sus dos claves de idempotencia, y en
//    Postgres esas claves son indices UNICOS. Aunque el script se equivocara
//    e intentara insertar dos veces, el motor lo impide.
//
// 4. NO TOCA EL ORIGEN. Solo lee los archivos. Si algo sale mal, el disco
//    sigue siendo la verdad y basta con no configurar DATABASE_URL.
//
// --------------------------------------------------------------------------
// ORDEN DEL CUTOVER (importa)
// --------------------------------------------------------------------------
//
//   1. `npm run migrar`            crear el esquema
//   2. `npm run cutover --simular` ver que haria, sin escribir
//   3. `npm run cutover`           copiar
//   4. comprobar el informe        conteos iguales
//   5. configurar DATABASE_URL en Render y desplegar
//
// El paso 5 va AL FINAL a proposito: mientras DATABASE_URL no este puesta,
// produccion sigue leyendo y escribiendo en el disco, asi que el cutover se
// puede ensayar tantas veces como haga falta sin afectar a nadie.
//
// LA BITACORA DE TRABAJO DEL WEBHOOK NO SE MIGRA: se queda en el disco a
// proposito. Es lo unico que tiene que funcionar cuando la base no responda,
// porque de ella depende poder contestar 200 a Meta sin perder el mensaje.
// ==========================================================================

const path = require("node:path");
const { config } = require("./config");
const { crearReposDeArchivos } = require("./almacen/repos/archivos");

/** Host y base, SIN usuario ni contrasena. Para saber DONDE se va a migrar. */
function describirDestino(dsn) {
  try {
    const u = new URL(dsn);
    const host = u.hostname || u.searchParams.get("host") || "socket local";
    return `${host}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    // Nunca se devuelve el DSN crudo: lleva la contrasena dentro.
    return "(destino no interpretable)";
  }
}

/**
 * @param {object} opciones
 * @param {object} opciones.origen   repos de archivos
 * @param {object} opciones.destino  repos de postgres
 * @param {boolean} [opciones.simular]
 * @param {Function} [opciones.contar]  callback de progreso
 */
async function copiar({ origen, destino, simular = false, contar = null }) {
  const informe = {
    simulado: simular,
    contactos: { origen: 0, copiados: 0, yaEstaban: 0 },
    conversaciones: { origen: 0, copiados: 0, yaEstaban: 0 },
    pedidos: { origen: 0, copiados: 0, yaEstaban: 0, noCreados: [] },
    problemas: [],
  };

  const avisar = (texto) => {
    if (contar) contar(texto);
  };

  // --- 1. Inventario del origen -------------------------------------------
  // El adaptador de archivos no tiene "listar todo" en el contrato, asi que
  // se recorre el disco. Es deliberado que el contrato no lo tenga: el
  // sistema en marcha nunca necesita leer todos los pedidos de golpe, y una
  // operacion asi es exactamente lo que no se quiere que alguien use por
  // comodidad en un camino caliente.
  const inventario = await origen._inventario();
  informe.contactos.origen = inventario.contactos.length;
  informe.conversaciones.origen = inventario.conversaciones.length;
  informe.pedidos.origen = inventario.pedidos.length;

  avisar(
    `origen: ${informe.contactos.origen} contacto(s), ${informe.conversaciones.origen} conversacion(es), ${informe.pedidos.origen} pedido(s)`
  );

  if (simular) return informe;

  // --- 2. Contactos primero (los pedidos los referencian) -----------------
  for (const c of inventario.contactos) {
    const previo = await destino.contactos.obtener(c.id);
    await destino.contactos.guardar(c);
    if (previo) informe.contactos.yaEstaban++;
    else informe.contactos.copiados++;
  }

  // --- 3. Conversaciones --------------------------------------------------
  for (const conv of inventario.conversaciones) {
    const previo = await destino.conversaciones.obtener(conv.contactoId);
    // El contacto tiene que existir: una conversacion sin contacto es una
    // conversacion que no se puede atender.
    if (!(await destino.contactos.obtener(conv.contactoId))) {
      await destino.contactos.guardar({ id: conv.contactoId });
    }
    await destino.conversaciones.guardar(conv);
    if (previo) informe.conversaciones.yaEstaban++;
    else informe.conversaciones.copiados++;
  }

  // --- 4. Pedidos ---------------------------------------------------------
  for (const p of inventario.pedidos) {
    if (!(await destino.contactos.obtener(p.contactoId))) {
      await destino.contactos.guardar({ id: p.contactoId });
    }

    const r = await destino.pedidos.crearSiNoExiste(p);

    if (r.creado) {
      informe.pedidos.copiados++;
      // Un pedido cancelado o modificado no se crea en su estado final:
      // `construir` siempre nace confirmado. Se reemplaza para que el estado
      // y el historial queden como estaban en el disco.
      if (p.estado !== r.pedido.estado || (p.historial || []).length > (r.pedido.historial || []).length) {
        await destino.pedidos.reemplazar(p);
      }
    } else if (r.pedido && r.pedido.id === p.id) {
      // Ya estaba: segundo pase del cutover. Se reemplaza para traer la
      // version mas reciente del disco.
      informe.pedidos.yaEstaban++;
      await destino.pedidos.reemplazar(p);
    } else {
      // No se creo y lo que hay en destino es OTRO pedido. Es el unico caso
      // que no se puede resolver sin una persona: dos pedidos distintos
      // comparten una clave de idempotencia.
      informe.pedidos.noCreados.push({ id: p.id, motivo: r.motivo, choca_con: r.pedido && r.pedido.id });
      informe.problemas.push(
        `el pedido ${p.id} no se pudo copiar (${r.motivo}); en destino hay ${r.pedido && r.pedido.id}`
      );
    }
  }

  // --- 5. Verificacion ----------------------------------------------------
  const estadoDestino = await destino.estado();
  informe.destino = estadoDestino;

  if (estadoDestino.pedidos < informe.pedidos.origen) {
    informe.problemas.push(
      `faltan pedidos en destino: origen ${informe.pedidos.origen}, destino ${estadoDestino.pedidos}`
    );
  }
  if (estadoDestino.conversaciones !== undefined && estadoDestino.conversaciones < informe.conversaciones.origen) {
    informe.problemas.push(
      `faltan conversaciones en destino: origen ${informe.conversaciones.origen}, destino ${estadoDestino.conversaciones}`
    );
  }

  return informe;
}

async function principal() {
  const simular = process.argv.includes("--simular");

  if (!config.databaseUrl) {
    console.error("");
    console.error("No hay DATABASE_URL configurada: no hay destino al que copiar.");
    console.error("Pon DATABASE_URL en el entorno de este comando (no hace falta en el servicio todavia).");
    console.error("");
    process.exit(1);
  }

  const { crearReposDePostgres } = require("./almacen/repos/postgres");

  console.log("");
  console.log(`NOVIKA · cutover archivos -> ${describirDestino(config.databaseUrl)}${simular ? "  (SIMULACION)" : ""}`);
  console.log("".padEnd(70, "-"));

  const origen = await crearReposDeArchivos({ dir: path.join(config.dirDatos, "transaccional") });
  const destino = await crearReposDePostgres({ dsn: config.databaseUrl });

  try {
    const informe = await copiar({
      origen,
      destino,
      simular,
      contar: (t) => console.log(`  ${t}`),
    });

    console.log("".padEnd(70, "-"));
    for (const tabla of ["contactos", "conversaciones", "pedidos"]) {
      const i = informe[tabla];
      console.log(`  ${tabla.padEnd(16)} origen=${i.origen}  copiados=${i.copiados}  ya estaban=${i.yaEstaban}`);
    }
    if (informe.destino) {
      console.log(`  destino: ${JSON.stringify(informe.destino)}`);
    }

    if (informe.problemas.length) {
      console.log("");
      console.log("  PROBLEMAS (el cutover NO esta completo):");
      for (const p of informe.problemas) console.log(`    [X] ${p}`);
      console.log("");
      console.log("  El disco sigue siendo la verdad. NO configures DATABASE_URL en el servicio.");
      console.log("");
      process.exit(1);
    }

    console.log("");
    if (simular) {
      console.log("  Simulacion: no se escribio nada. Quita --simular para copiar de verdad.");
    } else {
      console.log("  Cutover completo y verificado. Ya se puede configurar DATABASE_URL en el servicio.");
      console.log("  La bitacora de trabajo del webhook se queda en el disco a proposito.");
    }
    console.log("");
  } finally {
    await destino.cerrar();
    await origen.cerrar();
  }
}

if (require.main === module) {
  principal().catch((e) => {
    console.error("");
    console.error("El cutover fallo:");
    console.error(`  ${e.message}`);
    console.error("");
    console.error("No se toco el origen: el disco sigue siendo la verdad.");
    console.error("");
    process.exit(1);
  });
}

module.exports = { copiar };
