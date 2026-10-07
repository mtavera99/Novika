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
const trabajo = require("./almacen/trabajo");
const persistencia = require("./almacen/persistencia");

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
  // Drenaje verificable de los turnos en vuelo: exige reinicio congelado y
  // bitacora sin turnos en curso. Las pruebas que miden OTRO mecanismo lo
  // apagan para no tener que simular un reinicio en cada caso.
  exigirDrenaje = true,
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

  // --- 0.b DRENAJE VERIFICABLE DE LOS TURNOS EN VUELO ---------------------
  //
  // Congelar frena los turnos NUEVOS. No frena los que ya pasaron la
  // compuerta. El webhook contesta 200 a Meta y procesa DESPUES, asi que un
  // turno en vuelo sigue su camino -catalogo, IA, cotizacion, pedido- y
  // puede escribir mucho despues de que la marca de congelacion exista.
  //
  // --------------------------------------------------------------------
  // LO QUE NO FUNCIONA: ESPERAR
  // --------------------------------------------------------------------
  //
  // La version anterior miraba el origen, esperaba 2 segundos y volvia a
  // mirar. Dos huellas iguales NO prueban que no haya turnos en vuelo:
  // prueban que no hubo escrituras entre esas dos lecturas.
  //
  // El caso que la atraviesa entera: un turno pasa la compuerta y se queda
  // esperando al proveedor de IA. Se congela. Pasan los 2 segundos sin una
  // sola escritura -el turno esta bloqueado en la red, no escribiendo-. El
  // cutover se declara exitoso. Y DESPUES el proveedor responde, el turno
  // continua y guarda su pedido en archivos, fuera de PostgreSQL.
  //
  // Subir el tiempo de espera no lo arregla: el limite lo pone un servicio
  // ajeno, no nosotros. Una espera no es un candado.
  //
  // --------------------------------------------------------------------
  // LO QUE SI FUNCIONA: PREGUNTARLE AL DISCO
  // --------------------------------------------------------------------
  //
  // Un turno solo puede escribir en el almacen transaccional mientras su
  // registro de trabajo esta RECLAMADO: el reclamo se escribe ANTES de
  // procesar y el `terminar` DESPUES de haber escrito. Asi que:
  //
  //   no hay registros RECLAMADO en vuelo  <=>  nadie puede estar escribiendo
  //
  // Eso no es una estimacion temporal, es un hecho leido del disco, y el
  // disco es el unico canal que comparten el servicio y este proceso.
  //
  // Hacen falta DOS condiciones, porque un registro RECLAMADO es ambiguo
  // visto desde fuera: puede ser un turno vivo o el resto de un proceso que
  // murio. La segunda condicion deshace la ambiguedad.
  // ------------------------------------------------------------------------
  const dirParaCandados = dirDatos || config.dirDatos;

  if (exigirDrenaje) {
    const marcaCongelacion = congelacion.estado(dirParaCandados);
    const marcador = persistencia.leerMarcador(dirParaCandados);
    const bitacora = trabajo.inspeccionar(dirParaCandados);

    informe.drenaje = {
      arrancoDespuesDeCongelar: null,
      ultimoArranque: marcador.ultimoArranque,
      congeladoDesde: marcaCongelacion.desde,
      enCurso: bitacora.enCurso.length,
      diferidos: bitacora.diferidos.length,
      bitacoraLegible: bitacora.legible,
    };

    // --- CONDICION 1: el servicio arranco DESPUES de congelar ---
    //
    // Es lo que garantiza que no queda ningun turno en vuelo: el reinicio
    // mata el proceso y con el cualquier turno bloqueado esperando a la IA
    // -su escritura nunca ocurre, el proceso ya no existe-. Y el proceso
    // nuevo arranca CONGELADO, asi que su compuerta no deja empezar ni uno.
    //
    // Estructural, no temporal: no depende de cuanto tarde nadie.
    const arranque = marcador.ultimoArranque ? Date.parse(marcador.ultimoArranque) : NaN;
    const congeladoDesde = marcaCongelacion.desde ? Date.parse(marcaCongelacion.desde) : NaN;

    if (!marcador.existe || Number.isNaN(arranque)) {
      informe.problemas.push(
        "no hay marcador de arranque en " +
          `${dirParaCandados}: no se puede comprobar que el servicio se haya reiniciado despues de congelar. ` +
          "Reinicia novika-bot con las escrituras ya congeladas y repite el cutover."
      );
      return informe;
    }

    if (Number.isNaN(congeladoDesde)) {
      // Marca de congelacion sin fecha: estado() ya devuelve congelado:true
      // cuando la marca es ilegible. Sin fecha no se puede comparar, y
      // suponer que el reinicio fue despues seria suponer justo lo que hay
      // que demostrar.
      informe.problemas.push(
        "la marca de congelacion no tiene fecha, asi que no se puede comprobar el reinicio. " +
          "Ejecuta `npm run descongelar` y `npm run congelar` de nuevo, reinicia el servicio y repite."
      );
      return informe;
    }

    informe.drenaje.arrancoDespuesDeCongelar = arranque > congeladoDesde;

    if (arranque <= congeladoDesde) {
      informe.problemas.push(
        `el servicio NO se ha reiniciado desde que se congelo (ultimo arranque ${marcador.ultimoArranque}, ` +
          `congelado desde ${marcaCongelacion.desde}). Puede haber un turno en vuelo esperando al proveedor de IA ` +
          "que escriba DESPUES de la copia y quede fuera de PostgreSQL. " +
          "Reinicia novika-bot (Render -> Manual Deploy -> Restart service) con las escrituras ya congeladas y repite el cutover."
      );
      return informe;
    }

    avisar(`servicio reiniciado despues de congelar (arranque ${marcador.ultimoArranque})`);

    // --- CONDICION 2: la bitacora confirma que no hay nada en vuelo ---
    //
    // Es la evidencia de que la condicion 1 surtio efecto. Tras un reinicio
    // congelado, la recuperacion marca los pendientes como DIFERIDOS, asi
    // que lo que quede sin marcar solo puede ser un turno empezado en el
    // proceso actual, es decir una compuerta que no cerro.
    if (!bitacora.legible) {
      informe.problemas.push(
        `no se pudo leer la bitacora de trabajo (${bitacora.error}): no se puede descartar que haya turnos en vuelo. ` +
          "No se copio nada."
      );
      return informe;
    }

    if (bitacora.enCurso.length > 0) {
      informe.problemas.push(
        `hay ${bitacora.enCurso.length} turno(s) EN VUELO (reclamados y sin terminar, sin marcar como diferidos): ` +
          `${bitacora.enCurso
            .slice(0, 5)
            .map((r) => r.wamid)
            .join(", ")}. ` +
          "Una escritura suya quedaria fuera de PostgreSQL. No se copio nada. " +
          "Reinicia novika-bot con las escrituras congeladas: el reinicio los deja diferidos y se procesaran al descongelar."
      );
      return informe;
    }

    avisar(
      `sin turnos en vuelo · ${bitacora.diferidos.length} diferido(s) esperando el descongelado`
    );
  }

  // --- 1. Huella del origen ANTES -----------------------------------------
  const antes = await origen._inventario();
  const huellaAntes = huella(antes);
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
    if (informe.drenaje) {
      const d = informe.drenaje;
      console.log(
        `  drenaje: reinicio tras congelar=${d.arrancoDespuesDeCongelar === null ? "?" : d.arrancoDespuesDeCongelar ? "si" : "NO"}  turnos en vuelo=${d.enCurso}  diferidos=${d.diferidos}`
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

module.exports = { copiar, huella, diferencias };
