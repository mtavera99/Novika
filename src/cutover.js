"use strict";

// ==========================================================================
// npm run cutover              · archivos  -> PostgreSQL
// npm run cutover -- --inverso · PostgreSQL -> archivos   (rollback)
// npm run cutover -- --simular · dice que haria, sin escribir
//
// --------------------------------------------------------------------------
// LA VENTANA DE ESCRITURAS, Y POR QUE ESTE ARCHIVO EXIGE CONGELAR
// --------------------------------------------------------------------------
//
// La primera version copiaba y comparaba conteos al final. Si llegaba un
// mensaje MIENTRAS copiaba, el pedido nuevo quedaba fuera y el cutover se
// declaraba exitoso. Medido:
//
//   pedidos en el origen al terminar : 3
//   pedidos copiados al destino      : 2
//   problemas que reporta el cutover : []
//
// Un cutover "exitoso" con un pedido fuera es la peor forma de fallar,
// porque nadie va a volver a mirar.
//
// La correccion tiene dos mitades, y hacen falta las dos:
//
//   1. EXIGIR LA CONGELACION. Sin la marca en disco, este comando se niega
//      a copiar. No basta con pedirlo en la documentacion: un paso que se
//      puede olvidar se olvida.
//
//   2. VERIFICARLO, no confiar. Se toma una HUELLA del origen antes y
//      despues de copiar. Si cambio algo -un alta, una baja, una
//      modificacion-, el cutover FALLA. Asi que aunque la congelacion
//      fallara o alguien escribiera por otro camino, se detecta.
//
// La huella es lo que convierte "creemos que nadie escribio" en "sabemos que
// nadie escribio".
//
// --------------------------------------------------------------------------
// LAS CUATRO PROPIEDADES
// --------------------------------------------------------------------------
//
// 1. IDEMPOTENTE. Todo entra con las claves naturales y ON CONFLICT DO
//    NOTHING. Un segundo pase no duplica. Importa porque la primera vez
//    puede cortarse a mitad.
// 2. NO PIERDE. Compara conteos Y huellas, y falla si no cuadran.
// 3. NO DUPLICA. Las claves de idempotencia son UNIQUE en PostgreSQL:
//    aunque el script se equivocara, el motor lo impide.
// 4. NO TOCA EL ORIGEN. Solo lee.
//
// LA BITACORA DE TRABAJO DEL WEBHOOK NO SE MIGRA: se queda en el disco a
// proposito. Es lo unico que tiene que funcionar cuando la base no responda.
// ==========================================================================

const path = require("node:path");
const crypto = require("node:crypto");
const { config } = require("./config");
const { crearReposDeArchivos } = require("./almacen/repos/archivos");
const congelacion = require("./almacen/congelar");

const { describirDestino } = require("./almacen/repos/postgres");

/**
 * Barrera de reposo: cuanto se espera entre dos miradas al origen.
 *
 * 2 segundos porque un turno pasa por catalogo, cotizador y pedido, todo
 * sobre disco local, y eso se mide en decenas de milisegundos. 2 s da dos
 * ordenes de magnitud de margen sin alargar una operacion que ya exige
 * tener el bot congelado.
 */
const REPOSO_MS = 2000;

/**
 * Cuantas veces se vuelve a esperar si el origen seguia moviendose.
 *
 * Tres, no infinitas: si despues de 6 segundos congelado alguien sigue
 * escribiendo, no es un turno drenando. Es que la congelacion no esta
 * puesta donde creemos, y seguir esperando solo retrasa el diagnostico.
 */
const INTENTOS_DE_REPOSO = 3;

/**
 * Huella del contenido de un almacen.
 *
 * Incluye los identificadores Y las marcas de actualizacion, para que
 * detecte las tres formas de cambiar: alta, baja y modificacion. Un conteo
 * solo detecta las dos primeras, y una modificacion silenciosa durante la
 * copia es igual de grave.
 */
function huella(inventario) {
  const trozos = [
    ...inventario.contactos.map((c) => `c:${c.id}:${c.actualizadoEn || ""}`),
    ...inventario.conversaciones.map((v) => `v:${v.contactoId}:${v.actualizadoEn || ""}`),
    ...inventario.pedidos.map((p) => `p:${p.id}:${p.version}:${p.estado}:${p.actualizadoEn || ""}`),
  ].sort();

  return {
    resumen: crypto.createHash("sha256").update(trozos.join("|")).digest("hex").slice(0, 16),
    contactos: inventario.contactos.length,
    conversaciones: inventario.conversaciones.length,
    pedidos: inventario.pedidos.length,
  };
}

/** Qué cambió entre dos huellas, en palabras. */
function diferencias(antes, despues) {
  const partes = [];
  for (const k of ["contactos", "conversaciones", "pedidos"]) {
    if (antes[k] !== despues[k]) partes.push(`${k}: ${antes[k]} -> ${despues[k]}`);
  }
  if (!partes.length && antes.resumen !== despues.resumen) {
    partes.push("mismos conteos pero contenido distinto: algo se modifico durante la copia");
  }
  return partes;
}

/**
 * @param {object} opciones
 * @param {object} opciones.origen   repos de origen
 * @param {object} opciones.destino  repos de destino
 * @param {boolean} [opciones.simular]
 * @param {boolean} [opciones.exigirCongelacion] por defecto true
 * @param {string} [opciones.dirDatos]
 * @param {Function} [opciones.contar]
 */
async function copiar({
  origen,
  destino,
  simular = false,
  exigirCongelacion = true,
  dirDatos = null,
  contar = null,
  // Barrera de reposo: cuanto se espera entre dos miradas al origen para
  // dar por drenados los turnos que ya estaban en curso al congelar, y
  // cuantas veces se reintenta. 0 la desactiva (las pruebas que no la
  // ejercitan la apagan para no dormir en cada caso).
  reposoMs = REPOSO_MS,
  intentosDeReposo = INTENTOS_DE_REPOSO,
}) {
  const informe = {
    simulado: simular,
    contactos: { origen: 0, copiados: 0, yaEstaban: 0 },
    conversaciones: { origen: 0, copiados: 0, yaEstaban: 0 },
    pedidos: { origen: 0, copiados: 0, yaEstaban: 0, noCreados: [] },
    problemas: [],
  };
  const avisar = (t) => contar && contar(t);

  // --- 0. La congelacion es un requisito, no una recomendacion ------------
  if (exigirCongelacion) {
    const estadoCongelacion = congelacion.estado(dirDatos || config.dirDatos);
    informe.congelacion = estadoCongelacion;
    if (!estadoCongelacion.congelado) {
      informe.problemas.push(
        "las escrituras NO estan congeladas: un mensaje que llegue durante la copia quedaria fuera. " +
          "Ejecuta `npm run congelar` antes del cutover."
      );
      return informe;
    }
    avisar(`escrituras congeladas desde ${estadoCongelacion.desde}`);
  }

  // --- 0.b BARRERA DE REPOSO ----------------------------------------------
  //
  // Congelar frena los turnos NUEVOS. No frena los que ya estaban en curso.
  //
  // El webhook contesta 200 a Meta y procesa DESPUES, de forma asincrona. Un
  // turno que ya habia pasado la compuerta cuando se congelo sigue su
  // camino: identifica el producto, cotiza, y puede GUARDAR UN PEDIDO varios
  // cientos de milisegundos despues de que la marca de congelacion exista.
  //
  // Es decir: "congelado" no significa "quieto" en el instante en que se
  // congela. Significa "no entra trabajo nuevo". Y el cutover no necesita lo
  // primero, necesita lo segundo.
  //
  // La huella de antes/despues ya detectaba esto, pero solo DESPUES de haber
  // copiado: el cutover fallaba y habia que repetirlo, sin decir por que. Y
  // repetirlo podia volver a caer en la misma ventana.
  //
  // Esta barrera lo resuelve antes: se mira el origen, se espera, y se
  // vuelve a mirar. Si las dos huellas coinciden, nadie esta escribiendo y
  // se puede copiar. Si no coinciden, hay turnos drenando y se espera otra
  // vez. No hace falta coordinar procesos ni leer memoria ajena -el cutover
  // es otro proceso-: el disco ya dice la verdad.
  //
  // Se usa la ultima muestra como huella de partida, asi no se lee dos veces
  // para nada.
  // ------------------------------------------------------------------------
  let antes = await origen._inventario();
  let huellaAntes = huella(antes);
  const muestras = [huellaAntes.resumen];

  if (reposoMs > 0) {
    let quieto = false;
    for (let intento = 1; intento <= intentosDeReposo; intento++) {
      await new Promise((listo) => setTimeout(listo, reposoMs));
      const otra = await origen._inventario();
      const huellaOtra = huella(otra);
      muestras.push(huellaOtra.resumen);

      if (huellaOtra.resumen === huellaAntes.resumen) {
        quieto = true;
        antes = otra;
        huellaAntes = huellaOtra;
        break;
      }

      // Se movio: hay turnos en curso drenando. Se adopta la muestra nueva y
      // se vuelve a esperar.
      avisar(`el origen se movio (${diferencias(huellaAntes, huellaOtra).join("; ")}); esperando a que drene`);
      antes = otra;
      huellaAntes = huellaOtra;
    }

    informe.reposo = { quieto, muestras, reposoMs, intentos: muestras.length - 1 };

    if (!quieto) {
      informe.problemas.push(
        `el origen sigue cambiando despues de ${intentosDeReposo} espera(s) de ${reposoMs} ms: hay turnos en curso escribiendo. ` +
          "No se copio nada. Comprueba que las escrituras esten congeladas (`npm run congelado`) y repite el cutover."
      );
      return informe;
    }
    avisar(`origen en reposo tras ${informe.reposo.intentos} comprobacion(es) de ${reposoMs} ms`);
  }

  // --- 1. Huella del origen ANTES -----------------------------------------
  informe.huellaAntes = huellaAntes;

  informe.contactos.origen = huellaAntes.contactos;
  informe.conversaciones.origen = huellaAntes.conversaciones;
  informe.pedidos.origen = huellaAntes.pedidos;

  avisar(
    `origen: ${huellaAntes.contactos} contacto(s), ${huellaAntes.conversaciones} conversacion(es), ${huellaAntes.pedidos} pedido(s) · huella ${huellaAntes.resumen}`
  );

  if (simular) return informe;

  // --- 2. Contactos primero (los pedidos los referencian) -----------------
  for (const c of antes.contactos) {
    const previo = await destino.contactos.obtener(c.id);
    await destino.contactos.guardar(c);
    previo ? informe.contactos.yaEstaban++ : informe.contactos.copiados++;
  }

  // --- 3. Conversaciones --------------------------------------------------
  for (const conv of antes.conversaciones) {
    const previo = await destino.conversaciones.obtener(conv.contactoId);
    if (!(await destino.contactos.obtener(conv.contactoId))) {
      await destino.contactos.guardar({ id: conv.contactoId });
    }
    await destino.conversaciones.guardar(conv);
    previo ? informe.conversaciones.yaEstaban++ : informe.conversaciones.copiados++;
  }

  // --- 4. Pedidos ---------------------------------------------------------
  for (const p of antes.pedidos) {
    if (!(await destino.contactos.obtener(p.contactoId))) {
      await destino.contactos.guardar({ id: p.contactoId });
    }

    const r = await destino.pedidos.crearSiNoExiste(p);

    if (r.creado) {
      informe.pedidos.copiados++;
      // `construir` siempre nace confirmado, asi que un pedido cancelado o
      // modificado hay que reescribirlo para que llegue con su estado final.
      // Si no, un pedido que el cliente cancelo volveria a la cola de
      // despacho: la peor forma de duplicar.
      if (p.estado !== r.pedido.estado || (p.historial || []).length > (r.pedido.historial || []).length) {
        await destino.pedidos.reemplazar(p);
      }
    } else if (r.pedido && r.pedido.id === p.id) {
      informe.pedidos.yaEstaban++;
      await destino.pedidos.reemplazar(p);
    } else {
      // No se creo y en destino hay OTRO pedido: dos pedidos distintos
      // comparten una clave de idempotencia. Es el unico caso que no se
      // puede resolver sin una persona.
      informe.pedidos.noCreados.push({ id: p.id, motivo: r.motivo, chocaCon: r.pedido && r.pedido.id });
      informe.problemas.push(
        `el pedido ${p.id} no se pudo copiar (${r.motivo}); en destino hay ${r.pedido && r.pedido.id}`
      );
    }
  }

  // --- 5. Huella del origen DESPUES: ¿se movio algo? ----------------------
  const despues = await origen._inventario();
  const huellaDespues = huella(despues);
  informe.huellaDespues = huellaDespues;

  if (huellaAntes.resumen !== huellaDespues.resumen) {
    const cambios = diferencias(huellaAntes, huellaDespues);
    informe.problemas.push(
      `EL ORIGEN CAMBIO DURANTE LA COPIA (${cambios.join("; ")}). ` +
        "La copia esta incompleta. Comprueba que las escrituras esten congeladas y repite el cutover: " +
        "es idempotente, asi que repetirlo es seguro."
    );
  }

  // --- 6. Verificacion de conteos -----------------------------------------
  const estadoDestino = await destino.estado();
  informe.destino = estadoDestino;

  const pedidosEnDestino = estadoDestino.pedidos ?? 0;
  if (pedidosEnDestino < huellaAntes.pedidos) {
    informe.problemas.push(`faltan pedidos en destino: origen ${huellaAntes.pedidos}, destino ${pedidosEnDestino}`);
  }
  if (estadoDestino.conversaciones !== undefined && estadoDestino.conversaciones < huellaAntes.conversaciones) {
    informe.problemas.push(
      `faltan conversaciones en destino: origen ${huellaAntes.conversaciones}, destino ${estadoDestino.conversaciones}`
    );
  }

  return informe;
}

async function principal() {
  const simular = process.argv.includes("--simular");
  const inverso = process.argv.includes("--inverso");

  if (!config.databaseUrl) {
    console.error("");
    console.error("No hay DATABASE_URL configurada: no hay base de datos con la que trabajar.");
    console.error("Ponla en el entorno de ESTE comando (todavia no en el servicio).");
    console.error("");
    process.exit(1);
  }

  const { crearReposDePostgres } = require("./almacen/repos/postgres");

  console.log("");
  console.log(
    `NOVIKA · cutover ${inverso ? "PostgreSQL -> archivos  (ROLLBACK)" : `archivos -> ${describirDestino(config.databaseUrl)}`}${
      simular ? "  (SIMULACION)" : ""
    }`
  );
  console.log("".padEnd(72, "-"));

  const archivos = await crearReposDeArchivos({ dir: path.join(config.dirDatos, "transaccional") });
  const postgres = await crearReposDePostgres({ dsn: config.databaseUrl });

  const origen = inverso ? postgres : archivos;
  const destino = inverso ? archivos : postgres;

  try {
    const informe = await copiar({
      origen,
      destino,
      simular,
      dirDatos: config.dirDatos,
      contar: (t) => console.log(`  ${t}`),
    });

    console.log("".padEnd(72, "-"));
    for (const tabla of ["contactos", "conversaciones", "pedidos"]) {
      const i = informe[tabla];
      console.log(`  ${tabla.padEnd(16)} origen=${i.origen}  copiados=${i.copiados}  ya estaban=${i.yaEstaban}`);
    }
    if (informe.huellaAntes && informe.huellaDespues) {
      const igual = informe.huellaAntes.resumen === informe.huellaDespues.resumen;
      console.log(
        `  huella del origen: ${informe.huellaAntes.resumen} -> ${informe.huellaDespues.resumen}  ${
          igual ? "(no se movio)" : "(CAMBIO)"
        }`
      );
    }
    if (informe.destino) console.log(`  destino: ${JSON.stringify(informe.destino)}`);

    if (informe.problemas.length) {
      console.log("");
      console.log("  PROBLEMAS · EL CUTOVER NO ESTA COMPLETO:");
      for (const p of informe.problemas) console.log(`    [X] ${p}`);
      console.log("");
      console.log(`  ${inverso ? "PostgreSQL sigue" : "El disco sigue"} siendo la verdad.`);
      if (!inverso) console.log("  NO configures DATABASE_URL en el servicio.");
      console.log("");
      process.exit(1);
    }

    console.log("");
    if (simular) {
      console.log("  Simulacion: no se escribio nada. Quita --simular para copiar de verdad.");
    } else if (inverso) {
      console.log("  Rollback completo y verificado. Ya se puede quitar DATABASE_URL del servicio.");
    } else {
      console.log("  Cutover completo y verificado.");
      console.log("  Siguiente paso: configurar DATABASE_URL en Render y reiniciar el servicio.");
      console.log("  La bitacora de trabajo del webhook se queda en el disco a proposito.");
    }
    console.log("");
  } finally {
    await postgres.cerrar();
    await archivos.cerrar();
  }
}

if (require.main === module) {
  principal().catch((e) => {
    console.error("");
    console.error("El cutover fallo:");
    console.error(`  ${e.message}`);
    console.error("");
    console.error("No se toco el origen.");
    console.error("");
    process.exit(1);
  });
}

module.exports = { copiar, huella, diferencias, REPOSO_MS, INTENTOS_DE_REPOSO };
