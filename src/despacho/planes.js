"use strict";

// ==========================================================================
// PLANES: EL PASO INTERMEDIO ENTRE "REVISAR" Y "ENVIAR"
//
// Los dos flujos de despacho -guias y novedades- tienen la misma forma, y no
// es casualidad: los dos mandan mensajes a clientes reales a partir de un
// archivo que subio una persona.
//
//     1. subir el archivo  ->  se propone un plan     NO SE ENVIA NADA
//     2. revisar en pantalla  ->  el operador marca cuales
//     3. enviar               ->  solo las marcadas
//
// El paso 2 es el que da todo el valor: es donde se ve que la guia de Henry
// quedo sin parear, o que una novedad cayo en "motivo no reconocido". Un
// flujo de un solo paso seria mas corto y mandaria la etiqueta equivocada.
//
// Este modulo guarda ese plan entre el paso 1 y el 3.
//
// ==========================================================================
// POR QUE NO VA A LA BASE DE DATOS
// ==========================================================================
//
// Un plan de guias contiene LAS HOJAS DEL PDF: un PDF completo por pagina,
// decenas de MB en un lote grande. Y es reproducible: volver a subir el
// mismo archivo da el mismo plan.
//
// Guardar en la base algo pesado, efimero y reproducible es pagar su coste
// sin ganar nada. Lo que NO se puede perder -el pedido, la guia enviada- se
// guarda en los repositorios en el momento en que se envia.
//
// EL PRECIO, Y SE PAGA EXPLICITO: un reinicio entre revisar y enviar pierde
// el plan. En BIKERPRO eso devolvia un 400 sin explicacion y parecia un
// fallo del panel. Aqui `obtener()` distingue los tres casos -nunca existio,
// caduco, se reinicio el servicio- para que la pantalla diga que hacer en
// vez de un numero de error.
// ==========================================================================

const crypto = require("node:crypto");

/**
 * Cuanto vive un plan sin que nadie lo toque.
 *
 * Dos horas: lo que puede tardar el operador en revisar un lote grande,
 * contestar el telefono y volver. SE REFRESCA en cada uso, para que un
 * reintento de las que fallaron no obligue a subir el PDF otra vez.
 */
const TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Cuanto vive un plan EN TOTAL, por mucho que se refresque.
 *
 * Seis horas, y este NO se refresca nunca. Sin este tope, un plan que se
 * reintenta cada hora y media se queda en memoria para siempre con sus hojas
 * de PDF dentro: una fuga lenta que solo se nota cuando Render mata el
 * proceso por memoria.
 *
 * Ademas, a las seis horas el plan ya no describe la realidad: puede haber
 * pedidos nuevos, o alguien ya mando esa guia a mano.
 */
const VIDA_MAX_MS = 6 * 60 * 60 * 1000;

/** Cada cuanto se barren los planes vencidos. */
const BARRIDO_MS = 10 * 60 * 1000;

/**
 * Tope de planes vivos a la vez.
 *
 * Un operador revisa un lote, no veinte. Mas de esto significa que algo esta
 * creando planes y nadie los esta enviando, y el tope lo convierte en un
 * plan descartado en vez de un proceso muerto por memoria.
 */
const MAX_PLANES = 8;

const MOTIVOS = {
  NO_EXISTE: "no_existe",
  CADUCADO: "caducado",
  REINICIADO: "servicio_reiniciado",
};

/**
 * Crea un almacen de planes.
 *
 * Se inyecta el reloj para poder probar la caducidad sin esperar seis horas.
 *
 * @param {object} [opciones]
 * @param {() => number} [opciones.ahora]
 * @param {object} [opciones.log]
 */
function crearAlmacenDePlanes({ ahora = () => Date.now(), log = null, nombre = "planes" } = {}) {
  const planes = new Map();

  // El momento en que arranco este almacen. Sirve para distinguir "tu plan
  // caduco" de "se reinicio el servicio", que son dos explicaciones
  // distintas para el operador: una es esperar menos, la otra es que no hizo
  // nada mal.
  const arrancoEn = ahora();

  let reloj = null;

  function registrar(nivel, evento, datos) {
    if (log && typeof log[nivel] === "function") log[nivel](evento, datos);
  }

  /** Un identificador que no se puede adivinar. */
  function nuevoId() {
    return crypto.randomBytes(9).toString("hex");
  }

  function vencido(plan, t) {
    return t - plan.tocadoEn > TTL_MS || t - plan.nacioEn > VIDA_MAX_MS;
  }

  /** Borra los planes vencidos. */
  function barrer() {
    const t = ahora();
    let borrados = 0;
    for (const [id, plan] of planes) {
      if (vencido(plan, t)) {
        planes.delete(id);
        borrados++;
      }
    }
    if (borrados) registrar("info", `${nombre}_barridos`, { borrados, vivos: planes.size });
    return borrados;
  }

  /**
   * Guarda un plan y devuelve su id.
   *
   * @param {object} contenido lo que haga falta para enviar despues
   */
  function guardar(contenido) {
    barrer();

    // Si aun con el barrido se pasa del tope, se tira EL MAS VIEJO. Nunca el
    // nuevo: el nuevo es el que el operador tiene delante en la pantalla.
    while (planes.size >= MAX_PLANES) {
      let masViejo = null;
      for (const [id, plan] of planes) {
        if (!masViejo || plan.nacioEn < planes.get(masViejo).nacioEn) masViejo = id;
      }
      if (masViejo === null) break;
      planes.delete(masViejo);
      registrar("warn", `${nombre}_desalojado`, {
        porQue: `habia ${MAX_PLANES} planes vivos; se descarto el mas viejo para dejar sitio al nuevo`,
      });
    }

    const t = ahora();
    const id = nuevoId();
    planes.set(id, {
      id,
      contenido,
      // `nacioEn` NO se refresca nunca: es el que hace de tope absoluto.
      nacioEn: t,
      // `tocadoEn` si, en cada uso.
      tocadoEn: t,
    });

    arrancarBarrido();
    return id;
  }

  /**
   * Recupera un plan, o explica por que no esta.
   *
   * @returns {{ok:true, contenido:object, plan:object}
   *          | {ok:false, motivo:string, explicacion:string}}
   */
  function obtener(id) {
    const t = ahora();
    const plan = planes.get(String(id || ""));

    if (!plan) {
      // Si el almacen arranco DESPUES de que el plan se hubiera creado, lo
      // que paso es un reinicio -un despliegue, casi siempre-, y el operador
      // no hizo nada mal. Decirselo evita que busque el problema donde no
      // esta, que es lo que pasaba en BIKERPRO con un 400 pelado.
      const reinicio = t - arrancoEn < VIDA_MAX_MS;
      return {
        ok: false,
        motivo: reinicio ? MOTIVOS.REINICIADO : MOTIVOS.NO_EXISTE,
        explicacion: reinicio
          ? "el servicio se reinicio -un despliegue, normalmente- y los planes en curso se " +
            "pierden. No se envio nada. Vuelve a subir el archivo."
          : "ese plan no existe. Vuelve a subir el archivo.",
      };
    }

    if (vencido(plan, t)) {
      planes.delete(id);
      return {
        ok: false,
        motivo: MOTIVOS.CADUCADO,
        explicacion:
          `el plan caduco (vive ${TTL_MS / 3600000} h sin usarse, y ${VIDA_MAX_MS / 3600000} h en total). ` +
          "No se envio nada. Vuelve a subir el archivo.",
      };
    }

    // Refrescar al leer: mientras el operador trabaje sobre el plan, sigue
    // vivo. El tope absoluto lo sigue poniendo `nacioEn`.
    plan.tocadoEn = t;
    return { ok: true, contenido: plan.contenido, plan };
  }

  /** Lo descarta. Se llama cuando ya no queda nada que enviar. */
  function borrar(id) {
    return planes.delete(String(id || ""));
  }

  /**
   * Cuanto se esta reteniendo, para poder mirarlo antes de que Render mate
   * el proceso en vez de despues.
   */
  function estado() {
    const t = ahora();
    let bytes = 0;
    for (const plan of planes.values()) {
      for (const fila of (plan.contenido && plan.contenido.filas) || []) {
        if (fila && fila.hoja && fila.hoja.length) bytes += fila.hoja.length;
      }
    }
    return {
      vivos: planes.size,
      mbRetenidos: Math.round((bytes / 1048576) * 10) / 10,
      masViejoMin: planes.size
        ? Math.round(Math.max(...[...planes.values()].map((p) => t - p.nacioEn)) / 60000)
        : 0,
    };
  }

  function arrancarBarrido() {
    if (reloj) return;
    reloj = setInterval(barrer, BARRIDO_MS);
    // `unref` para que un temporizador no impida que el proceso termine: si
    // no, un apagado limpio se queda esperando diez minutos.
    if (typeof reloj.unref === "function") reloj.unref();
  }

  /** Para el barrido. La usan las pruebas y el apagado limpio. */
  function cerrar() {
    if (reloj) clearInterval(reloj);
    reloj = null;
    planes.clear();
  }

  return { guardar, obtener, borrar, barrer, estado, cerrar, MOTIVOS };
}

module.exports = {
  crearAlmacenDePlanes,
  TTL_MS,
  VIDA_MAX_MS,
  MAX_PLANES,
  MOTIVOS,
};
