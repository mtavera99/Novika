"use strict";

// ==========================================================================
// REPOSITORIOS SOBRE ARCHIVOS
//
// Implementacion del contrato (ver contrato.js) sobre el disco persistente
// de Render. Es la de HOY. La de manana es PostgreSQL, y tendra que pasar
// las mismas pruebas.
//
// Decisiones y su motivo:
//
//   UN ARCHIVO POR ENTIDAD, no un JSON gigante que se reescribe entero.
//   En BIKERPRO cada operacion leia y reescribia el archivo completo de
//   pedidos; eso le costo archivos truncados cuando el hosting mandaba
//   SIGTERM a mitad de escritura. Aqui se escribe un archivo pequeño con
//   tmp + rename, que es atomico.
//
//   NOMBRES DE ARCHIVO HASHEADOS. El id de contacto es un numero de
//   telefono. Un listado de directorio, un backup o una captura de pantalla
//   del disco no tienen por que exponer la agenda de clientes. El telefono
//   vive DENTRO del archivo, donde hace falta; no en su nombre.
//
//   INDICE APPEND-ONLY PARA LA IDEMPOTENCIA. Las claves de evento y de
//   oferta se anotan en un .jsonl y se cargan en memoria al abrir. Asi
//   comprobar un duplicado es O(1) y no obliga a releer todos los pedidos,
//   y sobre todo: SOBREVIVE AL REINICIO. Un Set en memoria se borra en cada
//   despliegue, y el reintento de Meta puede llegar 36 horas despues.
//
//   TODA ESCRITURA DE PEDIDO VA DENTRO DE LA COLA POR CONTACTO. Node es
//   monohilo pero cada `await` es un punto de entrada para otra tarea; sin
//   la cola, dos eventos del mismo cliente comprueban "no hay pedido" antes
//   de que el primero acabe de escribir, y nacen dos.
//
// LIMITE HONESTO: esto vale para el volumen de hoy y para una sola
// instancia. No tiene transacciones de verdad ni soporta dos procesos. Es
// exactamente por eso que el contrato existe y que la migracion esta
// preparada.
// ==========================================================================

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { enSerie } = require("../mutex");
const { MOTIVOS_NO_CREADO } = require("./contrato");

const TIPO = "archivos";

/** Nombre de archivo sin PII. */
function claveDeArchivo(id) {
  return crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 24);
}

function idDeArchivoSeguro(id) {
  // Los ids de pedido los generamos nosotros y ya son seguros, pero se
  // sanea por si acaso: nunca construir una ruta con texto sin revisar.
  return String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

async function escribirAtomico(ruta, contenido) {
  await fsp.mkdir(path.dirname(ruta), { recursive: true });
  const tmp = `${ruta}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, contenido);
  // rename es atomico en el mismo sistema de archivos: el archivo nunca
  // queda a medias, ni siquiera si el proceso muere aqui.
  await fsp.rename(tmp, ruta);
}

async function leerJson(ruta) {
  try {
    return JSON.parse(await fsp.readFile(ruta, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    if (e instanceof SyntaxError) {
      // Archivo corrupto: se aparta ANTES de que algo lo sobrescriba. Un
      // pedido ilegible se puede recuperar a mano; uno sobrescrito, no.
      try {
        await fsp.copyFile(ruta, `${ruta}.roto-${Date.now()}`);
      } catch {
        /* se intento */
      }
      const err = new Error(`archivo corrupto: ${path.basename(ruta)}`);
      err.corrupto = true;
      throw err;
    }
    throw e;
  }
}

/**
 * @param {object} opciones
 * @param {string} opciones.dir  carpeta base (dentro de DATA_DIR)
 */
async function crearReposDeArchivos({ dir }) {
  const DIR = dir;
  const DIR_CONTACTOS = path.join(DIR, "contactos");
  const DIR_CONVERSACIONES = path.join(DIR, "conversaciones");
  const DIR_PEDIDOS = path.join(DIR, "pedidos");
  const INDICE = path.join(DIR_PEDIDOS, "_indice.jsonl");

  await fsp.mkdir(DIR_CONTACTOS, { recursive: true });
  await fsp.mkdir(DIR_CONVERSACIONES, { recursive: true });
  await fsp.mkdir(DIR_PEDIDOS, { recursive: true });

  // --- Indice de idempotencia, cargado del disco ---
  /** @type {Map<string,string>} claveDeEvento -> pedidoId */
  const porEvento = new Map();
  /** @type {Map<string,string>} claveDeOferta -> pedidoId */
  const porOferta = new Map();

  try {
    const bruto = await fsp.readFile(INDICE, "utf8");
    for (const linea of bruto.split("\n")) {
      if (!linea.trim()) continue;
      try {
        const { tipo, clave, pedidoId } = JSON.parse(linea);
        if (tipo === "evento" && clave) porEvento.set(clave, pedidoId);
        if (tipo === "oferta" && clave) porOferta.set(clave, pedidoId);
      } catch {
        // Una linea ilegible no invalida el indice entero.
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }

  async function anotarEnIndice(entradas) {
    const texto = entradas.map((e) => JSON.stringify(e)).join("\n");
    await fsp.mkdir(DIR_PEDIDOS, { recursive: true });
    await fsp.appendFile(INDICE, `${texto}\n`);
  }

  const rutaPedido = (id) => path.join(DIR_PEDIDOS, `${idDeArchivoSeguro(id)}.json`);

  // ----------------------------------------------------------------------
  // Contactos
  // ----------------------------------------------------------------------
  const contactos = {
    async obtener(id) {
      if (!id) return null;
      return leerJson(path.join(DIR_CONTACTOS, `${claveDeArchivo(id)}.json`));
    },
    async guardar(contacto) {
      if (!contacto || !contacto.id) throw new Error("un contacto necesita id");
      return enSerie(`contacto:${contacto.id}`, async () => {
        const conMarca = { ...contacto, actualizadoEn: new Date().toISOString() };
        await escribirAtomico(
          path.join(DIR_CONTACTOS, `${claveDeArchivo(contacto.id)}.json`),
          JSON.stringify(conMarca, null, 2)
        );
        return conMarca;
      });
    },
  };

  /**
   * Nombres de los .json de una carpeta. Carpeta que no existe = vacia.
   *
   * Se salta los que empiezan por "_": son archivos internos (indices), no
   * registros, y colarlos en una lista del panel seria mostrar basura.
   */
  async function listarCarpeta(carpeta) {
    try {
      return (await fsp.readdir(carpeta)).filter((n) => n.endsWith(".json") && !n.startsWith("_"));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  // ----------------------------------------------------------------------
  // Conversaciones
  // ----------------------------------------------------------------------
  const conversaciones = {
    async obtener(contactoId) {
      if (!contactoId) return null;
      return leerJson(path.join(DIR_CONVERSACIONES, `${claveDeArchivo(contactoId)}.json`));
    },
    async guardar(conversacion) {
      if (!conversacion || !conversacion.contactoId) throw new Error("una conversacion necesita contactoId");
      return enSerie(`conv:${conversacion.contactoId}`, async () => {
        const conMarca = { ...conversacion, actualizadoEn: new Date().toISOString() };
        await escribirAtomico(
          path.join(DIR_CONVERSACIONES, `${claveDeArchivo(conversacion.contactoId)}.json`),
          JSON.stringify(conMarca, null, 2)
        );
        return conMarca;
      });
    },

    /**
     * Conversaciones, la mas recientemente actualizada primero.
     *
     * Para el panel. Tiene `limite` obligatorio con valor por defecto
     * porque una pantalla no puede pedir "todo": el dia que haya 50.000
     * conversaciones, una consulta sin tope tumba el servicio justo cuando
     * mas se usa el panel.
     */
    async listar({ limite = 200 } = {}) {
      const nombres = await listarCarpeta(DIR_CONVERSACIONES);
      const todas = [];
      for (const n of nombres) {
        const c = await leerJson(path.join(DIR_CONVERSACIONES, n));
        if (c) todas.push(c);
      }
      // Mismo orden estable que PostgreSQL: fecha descendente y, en los
      // empates, el id ascendente. Aqui salia estable por casualidad -el
      // sort de JS lo es y la carpeta se lee en orden- y depender de una
      // casualidad en los dos backends es como se separan.
      return todas
        .sort(
          (a, b) =>
            String(b.actualizadoEn || "").localeCompare(String(a.actualizadoEn || "")) ||
            String(a.contactoId || "").localeCompare(String(b.contactoId || ""))
        )
        .slice(0, limite);
    },
  };

  // ----------------------------------------------------------------------
  // Pedidos
  // ----------------------------------------------------------------------
  const pedidos = {
    async obtener(id) {
      if (!id) return null;
      return leerJson(rutaPedido(id));
    },

    /**
     * Pedidos, el mas reciente primero. Opcionalmente por rango de fechas.
     *
     * `desde` y `hasta` son dias de Bogota (AAAA-MM-DD) y se comparan
     * contra el dia de Bogota de `creadoEn`, no contra el UTC del ISO.
     * Comparar el ISO directamente mete los pedidos de despues de las 19:00
     * en el dia siguiente, que es el error que el panel de BIKERPRO ya
     * cometio.
     */
    async listar({ limite = 500, desde = null, hasta = null } = {}) {
      const { diaBogota } = require("../../panel/fecha");
      const nombres = await listarCarpeta(DIR_PEDIDOS);
      const todos = [];
      for (const n of nombres) {
        const p = await leerJson(path.join(DIR_PEDIDOS, n));
        if (!p) continue;
        if (desde || hasta) {
          const dia = diaBogota(p.creadoEn);
          if (!dia) continue;
          if (desde && dia < desde) continue;
          if (hasta && dia > hasta) continue;
        }
        todos.push(p);
      }
      return todos
        .sort((a, b) => String(b.creadoEn || "").localeCompare(String(a.creadoEn || "")))
        .slice(0, limite);
    },

    async porClaveDeEvento(clave) {
      const id = porEvento.get(clave);
      return id ? pedidos.obtener(id) : null;
    },

    /**
     * Crea el pedido si no existe ya uno equivalente. Operacion clave del
     * contrato: devuelve si creo, y si no, por que y cual es el pedido que
     * ya estaba.
     */
    async crearSiNoExiste(pedido) {
      if (!pedido || !pedido.id) throw new Error("un pedido necesita id");
      if (!pedido.claveDeEvento || !pedido.claveDeOferta) {
        // Un pedido que no se puede deduplicar es un duplicado futuro.
        return {
          creado: false,
          pedido: null,
          motivo: "el pedido no trae clave de evento y de oferta: sin ellas no se puede garantizar que no se duplique",
        };
      }

      // La cola por contacto es lo que hace atomica esta operacion: el
      // comprobar-y-escribir no se puede entrelazar con otro igual.
      return enSerie(`pedidos:${pedido.contactoId}`, async () => {
        // 1. ¿Mismo evento? Retransmision del webhook.
        const idPorEvento = porEvento.get(pedido.claveDeEvento);
        if (idPorEvento) {
          return {
            creado: false,
            pedido: await pedidos.obtener(idPorEvento),
            motivo: MOTIVOS_NO_CREADO.EVENTO_REPETIDO,
          };
        }

        // 2. ¿Misma oferta con pedido vivo? "Si" repetido.
        const idPorOferta = porOferta.get(pedido.claveDeOferta);
        if (idPorOferta) {
          const existente = await pedidos.obtener(idPorOferta);
          // Un pedido cancelado libera la oferta: si el cliente se
          // arrepiente de cancelar, no se le puede bloquear la compra.
          if (existente && existente.estado !== "cancelado") {
            return { creado: false, pedido: existente, motivo: MOTIVOS_NO_CREADO.OFERTA_YA_TIENE_PEDIDO };
          }
        }

        // 3. Escribir el pedido ANTES del indice. Si el proceso muere en
        //    medio, queda un pedido sin indexar (recuperable, visible) en
        //    vez de un indice que apunta a un pedido que no existe.
        await escribirAtomico(rutaPedido(pedido.id), JSON.stringify(pedido, null, 2));
        await anotarEnIndice([
          { tipo: "evento", clave: pedido.claveDeEvento, pedidoId: pedido.id },
          { tipo: "oferta", clave: pedido.claveDeOferta, pedidoId: pedido.id },
        ]);
        porEvento.set(pedido.claveDeEvento, pedido.id);
        porOferta.set(pedido.claveDeOferta, pedido.id);

        return { creado: true, pedido };
      });
    },

    /** Guarda una version nueva de un pedido existente. */
    async reemplazar(pedido) {
      if (!pedido || !pedido.id) throw new Error("un pedido necesita id");
      return enSerie(`pedidos:${pedido.contactoId}`, async () => {
        await escribirAtomico(rutaPedido(pedido.id), JSON.stringify(pedido, null, 2));
        return pedido;
      });
    },

    async porContacto(contactoId, { incluirCancelados = false } = {}) {
      let nombres = [];
      try {
        nombres = (await fsp.readdir(DIR_PEDIDOS)).filter((n) => n.endsWith(".json") && !n.startsWith("_"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }

      const salida = [];
      for (const nombre of nombres) {
        let p;
        try {
          p = await leerJson(path.join(DIR_PEDIDOS, nombre));
        } catch (e) {
          if (e.corrupto) continue; // ya quedo apartado y registrado
          throw e;
        }
        if (!p || p.contactoId !== contactoId) continue;
        if (!incluirCancelados && p.estado === "cancelado") continue;
        salida.push(p);
      }
      return salida.sort((a, b) => String(a.creadoEn).localeCompare(String(b.creadoEn)));
    },

    /** El pedido vivo del contacto. Si hay mas de uno, NO elige. */
    async activoDeContacto(contactoId) {
      const vivos = (await pedidos.porContacto(contactoId)).filter(
        (p) => p.estado !== "cancelado" && p.estado !== "despachado"
      );
      if (vivos.length === 1) return vivos[0];
      if (vivos.length === 0) return null;
      // Mas de uno vivo es una anomalia. Devolver "alguno" seria modificar
      // el pedido equivocado, que es justo el error que se quiere evitar.
      return null;
    },
  };

  // ----------------------------------------------------------------------
  // Transversales
  // ----------------------------------------------------------------------
  async function estado() {
    let cuantos = 0;
    try {
      cuantos = (await fsp.readdir(DIR_PEDIDOS)).filter((n) => n.endsWith(".json") && !n.startsWith("_")).length;
    } catch {
      /* carpeta aun sin crear */
    }
    return {
      tipo: TIPO,
      dir: DIR,
      pedidos: cuantos,
      clavesDeEvento: porEvento.size,
      clavesDeOferta: porOferta.size,
    };
  }

  async function cerrar() {
    // Nada que cerrar con archivos. El metodo existe porque el contrato lo
    // exige y PostgreSQL si tendra que devolver la conexion al pool.
  }

  /** Reabre desde el mismo disco. Simula el reinicio del proceso. */
  async function reabrir() {
    return crearReposDeArchivos({ dir: DIR });
  }

  /**
   * TODO lo que hay en disco. FUERA DEL CONTRATO, solo para el cutover.
   *
   * Lleva prefijo `_` y no esta en contrato.js a proposito: el sistema en
   * marcha nunca necesita leer todos los pedidos de golpe, y una operacion
   * asi es exactamente la que alguien usaria por comodidad en un camino
   * caliente. Que no forme parte del contrato significa que el adaptador de
   * PostgreSQL no tiene que implementarla, y que nadie puede depender de
   * ella sin darse cuenta de que esta pisando terreno de migracion.
   */
  async function _inventario() {
    const leerCarpeta = async (carpeta) => {
      let nombres = [];
      try {
        nombres = (await fsp.readdir(carpeta)).filter((n) => n.endsWith(".json") && !n.startsWith("_"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const salida = [];
      for (const nombre of nombres) {
        try {
          const dato = await leerJson(path.join(carpeta, nombre));
          if (dato) salida.push(dato);
        } catch (e) {
          if (!e.corrupto) throw e;
          // Un archivo corrupto ya quedo apartado por leerJson. No se
          // inventa su contenido: se deja fuera y el conteo final del
          // cutover lo delatara.
        }
      }
      return salida;
    };

    return {
      contactos: await leerCarpeta(DIR_CONTACTOS),
      conversaciones: await leerCarpeta(DIR_CONVERSACIONES),
      pedidos: await leerCarpeta(DIR_PEDIDOS),
    };
  }

  return { tipo: TIPO, contactos, conversaciones, pedidos, estado, cerrar, reabrir, _inventario };
}

module.exports = { crearReposDeArchivos, TIPO, claveDeArchivo };
