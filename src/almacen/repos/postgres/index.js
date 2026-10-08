"use strict";

// ==========================================================================
// REPOSITORIOS SOBRE POSTGRESQL
//
// Implementa EXACTAMENTE el mismo contrato que el adaptador de archivos
// (src/almacen/repos/contrato.js) y pasa las mismas pruebas. Ninguna regla
// de negocio cambia para acomodar la base de datos: si algo no encaja, se
// ajusta el esquema, no el dominio.
//
// --------------------------------------------------------------------------
// LO QUE ESTE ADAPTADOR APORTA FRENTE AL DE ARCHIVOS
// --------------------------------------------------------------------------
//
// La idempotencia deja de depender de un Map en memoria y de una cola de
// promesas, y pasa a apoyarse en el MOTOR:
//
//   crearSiNoExiste -> INSERT ... ON CONFLICT DO NOTHING contra dos indices
//                      UNICOS. Si dos procesos en dos maquinas lo intentan a
//                      la vez, el motor deja pasar uno. No hay ventana.
//
//   concurrencia    -> pg_advisory_xact_lock por contacto. Es un cerrojo de
//                      la BASE, no del proceso, asi que sirve con varias
//                      instancias. enSerie() en memoria sigue estando, pero
//                      deja de ser la unica garantia.
//
// --------------------------------------------------------------------------
// LO QUE NO CAMBIA
// --------------------------------------------------------------------------
//
// La bitacora de trabajo del webhook (src/almacen/trabajo.js) sigue en el
// disco, a proposito. Es lo unico que tiene que funcionar cuando la base no
// responda: el webhook no puede contestar 200 sin reclamo durable, y si ese
// reclamo dependiera de Postgres, una caida de la base obligaria a devolver
// 503 a Meta. Con suficientes 503, Meta desactiva la suscripcion.
//
// Es decir: migrar los pedidos a Postgres NO reabre la ventana
// 200 -> crash -> mensaje perdido, porque esa ventana la cierra el disco.
// ==========================================================================

const { MOTIVOS_NO_CREADO } = require("../contrato");
const { CERRADOS } = require("../../../dominio/pedido");

const TIPO = "postgres";

/** Estados que dejan de ocupar la oferta. */
const ESTADOS_MUERTOS = new Set(["cancelado"]);

// --------------------------------------------------------------------------
// Conexion
// --------------------------------------------------------------------------

/**
 * Render da dos URLs: la interna (sin TLS, dentro de su red) y la externa
 * (con TLS obligatorio). Se detecta por la propia URL en vez de obligar a
 * configurar una variable mas que alguien olvidara.
 */
/**
 * Host y base, SIN usuario ni contrasena.
 *
 * Existe para poder decir DONDE se va a escribir sin filtrar la credencial:
 * estas salidas se pegan en chats y en informes. Una sola implementacion
 * para los cuatro comandos, porque una copia que se olvide de recortar la
 * contrasena la publica.
 */
function describirDestino(dsn) {
  const texto = String(dsn || "");
  try {
    const u = new URL(texto);
    const host = u.hostname || u.searchParams.get("host") || "socket local";
    return `${host}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    // Las URLs con socket unix (sin host) no las parsea URL. Se recorta a
    // mano, siempre quitando lo que haya antes de la arroba.
    const sinCredencial = texto.replace(/^[a-z]+:\/\/[^@/]*@/i, "");
    const base = (sinCredencial.match(/\/([^/?]+)/) || [])[1] || "";
    const socket = (texto.match(/host=([^&]+)/) || [])[1] || "";
    if (base || socket) return `${socket ? `socket ${socket}` : "local"}/${base}`;
    return "(destino no interpretable)";
  }
}

function opcionesDeSsl(dsn) {
  const texto = String(dsn || "");
  if (/sslmode=disable/.test(texto)) return false;
  if (/sslmode=(require|verify-ca|verify-full)/.test(texto)) return { rejectUnauthorized: false };
  // Host local o socket unix: sin TLS.
  if (/@(127\.0\.0\.1|localhost)[:/]/.test(texto) || /host=\//.test(texto) || texto.startsWith("/")) return false;
  // Interno de Render: red privada, sin TLS.
  if (/\.internal[:/]/.test(texto) || /-internal[:/]/.test(texto)) return false;
  return { rejectUnauthorized: false };
}

// --------------------------------------------------------------------------
// Traduccion dominio <-> fila
// --------------------------------------------------------------------------

/** Campos del pedido que tienen columna propia. El resto va a `extra`. */
const CAMPOS_PEDIDO_CONOCIDOS = new Set([
  "id", "version", "estado", "claveDeEvento", "claveDeOferta", "contactoId", "conversacionId",
  "ofertaId", "wamidConfirmacion", "producto", "cantidad", "destinatario", "cotizacion",
  "firmaDeCondiciones", "origen", "revisiones", "historial", "creadoEn", "actualizadoEn",
  "canceladoEn", "motivoCancelacion", "despacho", "novedades",
  // ⚠️ `entrega` NO VA AQUI, Y ES A PROPOSITO.
  //
  // Al no estar, cae en `extra` y el pedido entregado se guarda y se lee
  // igual EN CUALQUIER VERSION DEL ESQUEMA. Darle columna propia obliga a
  // migrar antes de desplegar, y eso tumbo el servicio el 2026-10-08: la
  // columna se exigio en `COLUMNAS_REQUERIDAS` sin que la 004 estuviera
  // aplicada, `revisarEsquema` lanzo, y el panel se quedo sin un solo chat.
  //
  // Si algun dia hace falta sumar la caja EN SQL -y entonces si conviene la
  // columna y su indice-, el orden es: migrar, comprobar, y despues añadirla
  // aqui y a `COLUMNAS_REQUERIDAS`. Nunca en el mismo despliegue.
]);

/**
 * Lo que el dominio guardo y no tiene columna.
 *
 * El adaptador de archivos es sin esquema: guarda el objeto tal cual, asi que
 * un campo nuevo sobrevive sin tocar nada. Postgres solo guarda lo que tiene
 * columna, y eso rompe la promesa del contrato ("un registro guardado se
 * recupera igual") de la forma mas silenciosa posible: el campo desaparece y
 * nadie se entera hasta que algo lo necesita.
 *
 * `extra` cierra esa diferencia. No es un cajon de sastre para evitar
 * modelar: es lo que hace que los dos adaptadores sean intercambiables de
 * verdad. Cuando un campo de `extra` empiece a importar, se le hace columna.
 */
function sobrantes(objeto, conocidos) {
  const extra = {};
  for (const [k, v] of Object.entries(objeto || {})) {
    if (!conocidos.has(k) && !k.startsWith("_")) extra[k] = v;
  }
  return Object.keys(extra).length ? extra : null;
}

function pedidoAFila(p) {
  const cot = p.cotizacion || {};

  // Los importes son una PROYECCION del snapshot, que es la verdad. Si el
  // snapshot no trae el desglose, el subtotal se deriva por algebra: es el
  // unico reparto que mantiene el invariante total = subtotal + envio -
  // descuento. No se inventa un numero, se despeja el que falta.
  const total = cot.total ?? 0;
  const envio = cot.envio ?? 0;
  const descuento = cot.descuento ?? 0;
  const subtotal = cot.subtotal ?? Math.max(0, total - envio + descuento);

  if (cot.subtotal !== undefined && total !== subtotal + envio - descuento) {
    // Dinero incoherente. Se para aqui con un mensaje legible, en vez de
    // dejar que el motor devuelva un error de restriccion sin contexto.
    throw new Error(
      `la cotizacion del pedido ${p.id} no cuadra: ${subtotal} + ${envio} - ${descuento} != ${total}`
    );
  }

  return {
    codigo: p.id,
    version: p.version || 1,
    estado: p.estado,
    clave_de_evento: p.claveDeEvento,
    clave_de_oferta: p.claveDeOferta,
    contacto_id: p.contactoId,
    conversacion_externa: p.conversacionId || null,
    oferta_id: p.ofertaId,
    wamid_confirmacion: p.wamidConfirmacion,
    producto_id: (p.producto && p.producto.id) || null,
    producto_nombre: (p.producto && p.producto.nombre) || null,
    variante: (p.producto && p.producto.variante) || null,
    cantidad: p.cantidad,
    subtotal_pesos: subtotal,
    envio_pesos: envio,
    descuento_pesos: descuento,
    total_pesos: total,
    moneda: cot.moneda || "COP",
    destinatario: p.destinatario || {},
    cotizacion: cot,
    firma_condiciones: p.firmaDeCondiciones || null,
    // El dominio los lleva dentro de la cotizacion; se desnormalizan para
    // poder auditar con que reglas se cotizo sin abrir el JSON.
    politica_version: cot.politicaVersion || "sin-version",
    version_catalogo: cot.versionCatalogo || "sin-version",
    origen: p.origen || null,
    revisiones: p.revisiones || [],
    creado_en: p.creadoEn || new Date().toISOString(),
    actualizado_en: p.actualizadoEn || new Date().toISOString(),
    // La restriccion `cancelacion_coherente` exige que vayan de la mano.
    cancelado_en: p.estado === "cancelado" ? p.canceladoEn || new Date().toISOString() : null,
    motivo_cancelacion: p.estado === "cancelado" ? p.motivoCancelacion || "sin motivo registrado" : null,
    despacho: p.despacho || null,
    novedades: p.novedades || [],
    extra: sobrantes(p, CAMPOS_PEDIDO_CONOCIDOS),
  };
}

const aIso = (v) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

function filaAPedido(f, historial = []) {
  if (!f) return null;
  return {
    // `extra` primero: lo conocido manda sobre lo sobrante si algun dia
    // chocaran.
    ...(f.extra || {}),
    id: f.codigo,
    version: f.version,
    estado: f.estado,
    claveDeEvento: f.clave_de_evento,
    claveDeOferta: f.clave_de_oferta,
    contactoId: f.contacto_id,
    conversacionId: f.conversacion_externa,
    ofertaId: f.oferta_id,
    wamidConfirmacion: f.wamid_confirmacion,
    producto: { id: f.producto_id, nombre: f.producto_nombre, variante: f.variante || null },
    cantidad: f.cantidad,
    destinatario: f.destinatario,
    cotizacion: f.cotizacion,
    firmaDeCondiciones: f.firma_condiciones,
    origen: f.origen || null,
    revisiones: f.revisiones || [],
    historial,
    creadoEn: aIso(f.creado_en),
    actualizadoEn: aIso(f.actualizado_en),
    canceladoEn: aIso(f.cancelado_en),
    motivoCancelacion: f.motivo_cancelacion,
    despacho: f.despacho || null,
    novedades: f.novedades || [],
  };
}

const CAMPOS_CONVERSACION_CONOCIDOS = new Set([
  "contactoId", "estado", "productoId", "ofertaId", "resumenMostrado", "cotizacion",
  "ficha", "ventana", "ultimoWamid", "atencion", "mensajes", "creadoEn", "actualizadoEn",
]);

function filaAConversacion(f) {
  if (!f) return null;
  return {
    ...(f.extra || {}),
    contactoId: f.contacto_id,
    estado: f.estado,
    productoId: f.producto_id,
    ofertaId: f.oferta_id,
    resumenMostrado: f.resumen_mostrado,
    atencion: f.atencion || {},
    mensajes: f.mensajes || [],
    cotizacion: f.cotizacion,
    ficha: f.ficha || {},
    ventana: f.ventana || [],
    ultimoWamid: f.ultimo_wamid,
    creadoEn: aIso(f.creado_en),
    actualizadoEn: aIso(f.actualizado_en),
  };
}

const CAMPOS_CONTACTO_CONOCIDOS = new Set(["id", "telefono", "bsuid", "nombrePerfil", "creadoEn", "actualizadoEn"]);

function filaAContacto(f) {
  if (!f) return null;
  return {
    ...(f.extra || {}),
    id: f.id,
    telefono: f.telefono,
    bsuid: f.bsuid,
    nombrePerfil: f.nombre_perfil,
    creadoEn: aIso(f.creado_en),
    actualizadoEn: aIso(f.actualizado_en),
  };
}

const COLUMNAS_PEDIDO = [
  "codigo", "version", "estado", "clave_de_evento", "clave_de_oferta",
  "contacto_id", "conversacion_externa", "oferta_id", "wamid_confirmacion",
  "producto_id", "producto_nombre", "variante", "cantidad",
  "subtotal_pesos", "envio_pesos", "descuento_pesos", "total_pesos", "moneda",
  "destinatario", "cotizacion", "firma_condiciones", "politica_version", "version_catalogo",
  "origen", "revisiones", "creado_en", "actualizado_en", "cancelado_en", "motivo_cancelacion",
  // `guia` NO va aqui: es una columna GENERADA a partir de despacho->>'guia'
  // y PostgreSQL rechaza que se escriba. Existe solo para poder indexarla.
  "despacho", "novedades",
  "extra",
];

const JSONB_PEDIDO = new Set([
  "variante", "destinatario", "cotizacion", "origen", "revisiones", "despacho", "novedades", "extra",
]);

function valoresDePedido(fila) {
  return COLUMNAS_PEDIDO.map((c) => (JSONB_PEDIDO.has(c) ? (fila[c] === null ? null : JSON.stringify(fila[c])) : fila[c]));
}

// --------------------------------------------------------------------------
// Fabrica
// --------------------------------------------------------------------------

/**
 * @param {object} opciones
 * @param {string} opciones.dsn        cadena de conexion (NUNCA se registra)
 * @param {object} [opciones.pg]       modulo pg inyectable para pruebas
 * @param {number} [opciones.maxConexiones]
 */
async function crearReposDePostgres({ dsn, pg = null, maxConexiones = 8, log = null }) {
  if (!dsn) throw new Error("crearReposDePostgres necesita dsn");

  const { Pool } = pg || require("pg");
  const pool = new Pool({
    connectionString: dsn,
    ssl: opcionesDeSsl(dsn),
    max: maxConexiones,
    idleTimeoutMillis: 30000,
    // Sin esto, una base que no responde deja la peticion colgada y el
    // cliente de WhatsApp sin respuesta.
    connectionTimeoutMillis: 8000,
  });

  pool.on("error", (e) => {
    // El DSN lleva la contrasena: nunca se registra el error crudo completo.
    if (log && log.error) log.error("postgres_error_de_pool", { detalle: e.message });
  });

  // Falla ya si no se puede hablar con la base, en vez de a mitad de una venta.
  const sonda = await pool.connect();
  try {
    await sonda.query("SELECT 1");
  } finally {
    sonda.release();
  }

  /**
   * Ejecuta `fn` dentro de una transaccion, con el contacto bloqueado.
   *
   * El advisory lock es DE LA BASE, no del proceso: dos instancias en dos
   * maquinas se serializan igual. Es lo que hace que la concurrencia deje de
   * depender de enSerie() en memoria.
   *
   * Es `xact`, asi que se suelta solo al terminar la transaccion. Un cerrojo
   * que hay que soltar a mano se queda tomado el dia que algo lance.
   */
  async function enTransaccion(contactoId, fn) {
    const cli = await pool.connect();
    try {
      await cli.query("BEGIN");
      if (contactoId) {
        await cli.query("SELECT pg_advisory_xact_lock(hashtext($1))", [String(contactoId)]);
      }
      const r = await fn(cli);
      await cli.query("COMMIT");
      return r;
    } catch (e) {
      await cli.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      cli.release();
    }
  }

  /** El contacto tiene que existir antes del pedido (clave ajena). */
  async function asegurarContacto(cli, id, datos = {}) {
    await cli.query(
      `INSERT INTO contactos (id, telefono, bsuid, nombre_perfil)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, datos.telefono || null, datos.bsuid || null, datos.nombrePerfil || null]
    );
  }

  async function historialDe(cli, codigo) {
    const { rows } = await cli.query(
      "SELECT entrada FROM pedidos_historial WHERE pedido_codigo = $1 ORDER BY id",
      [codigo]
    );
    return rows.map((r) => r.entrada);
  }

  /** Inserta las entradas de historial que falten. Idempotente. */
  async function guardarHistorial(cli, codigo, historial) {
    for (const entrada of historial || []) {
      await cli.query(
        `INSERT INTO pedidos_historial (pedido_codigo, version, accion, entrada, cuando)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
         ON CONFLICT (pedido_codigo, version, accion) DO NOTHING`,
        [codigo, entrada.version || 1, entrada.accion || "sin_accion", JSON.stringify(entrada), entrada.cuando || null]
      );
    }
  }

  // ----------------------------------------------------------------------
  // Contactos
  // ----------------------------------------------------------------------
  const contactos = {
    async obtener(id) {
      if (!id) return null;
      const { rows } = await pool.query("SELECT * FROM contactos WHERE id = $1", [id]);
      return filaAContacto(rows[0]);
    },
    async guardar(contacto) {
      if (!contacto || !contacto.id) throw new Error("un contacto necesita id");
      const extra = sobrantes(contacto, CAMPOS_CONTACTO_CONOCIDOS);
      const { rows } = await pool.query(
        `INSERT INTO contactos (id, telefono, bsuid, nombre_perfil, extra, actualizado_en)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (id) DO UPDATE SET
           telefono      = COALESCE(EXCLUDED.telefono, contactos.telefono),
           bsuid         = COALESCE(EXCLUDED.bsuid, contactos.bsuid),
           nombre_perfil = COALESCE(EXCLUDED.nombre_perfil, contactos.nombre_perfil),
           extra         = COALESCE(contactos.extra, '{}'::jsonb) || COALESCE(EXCLUDED.extra, '{}'::jsonb),
           actualizado_en = now()
         RETURNING *`,
        [
          contacto.id,
          contacto.telefono || null,
          contacto.bsuid || null,
          contacto.nombrePerfil || null,
          extra ? JSON.stringify(extra) : null,
        ]
      );
      return filaAContacto(rows[0]);
    },
  };

  // ----------------------------------------------------------------------
  // Conversaciones
  // ----------------------------------------------------------------------
  const conversaciones = {
    async obtener(contactoId) {
      if (!contactoId) return null;
      const { rows } = await pool.query("SELECT * FROM conversaciones WHERE contacto_id = $1", [contactoId]);
      return filaAConversacion(rows[0]);
    },

    async guardar(conversacion) {
      const c = conversacion;
      if (!c || !c.contactoId) throw new Error("una conversacion necesita contactoId");

      // Bloqueo por contacto: guardar una conversacion es leer-modificar-
      // escribir aguas arriba, y dos mensajes del mismo cliente no pueden
      // pisarse.
      return enTransaccion(c.contactoId, async (cli) => {
        await asegurarContacto(cli, c.contactoId);
        const { rows } = await cli.query(
          `INSERT INTO conversaciones
             (contacto_id, estado, producto_id, oferta_id, resumen_mostrado, cotizacion, ficha, ventana, ultimo_wamid, atencion, mensajes, extra, actualizado_en)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
           ON CONFLICT (contacto_id) DO UPDATE SET
             estado           = EXCLUDED.estado,
             producto_id      = EXCLUDED.producto_id,
             oferta_id        = EXCLUDED.oferta_id,
             resumen_mostrado = EXCLUDED.resumen_mostrado,
             cotizacion       = EXCLUDED.cotizacion,
             ficha            = EXCLUDED.ficha,
             ventana          = EXCLUDED.ventana,
             ultimo_wamid     = EXCLUDED.ultimo_wamid,
             atencion         = EXCLUDED.atencion,
             mensajes         = EXCLUDED.mensajes,
             extra            = EXCLUDED.extra,
             actualizado_en   = now()
           RETURNING *`,
          [
            c.contactoId,
            c.estado,
            c.productoId || null,
            c.ofertaId || null,
            c.resumenMostrado === true,
            c.cotizacion ? JSON.stringify(c.cotizacion) : null,
            JSON.stringify(c.ficha || {}),
            JSON.stringify(c.ventana || []),
            c.ultimoWamid || null,
            JSON.stringify(c.atencion || {}),
            JSON.stringify(c.mensajes || []),
            (() => { const e = sobrantes(c, CAMPOS_CONVERSACION_CONOCIDOS); return e ? JSON.stringify(e) : null; })(),
          ]
        );
        return filaAConversacion(rows[0]);
      });
    },

    /**
     * Conversaciones, la mas recientemente actualizada primero.
     *
     * `limite` siempre tiene tope: una pantalla no puede pedir "todo". El
     * dia que haya decenas de miles de conversaciones, una consulta sin
     * tope tumba el servicio justo cuando mas se usa el panel.
     */
    // ORDEN ESTABLE: el desempate por contacto_id no es decorativo.
    //
    // Estaba solo `ORDER BY actualizado_en DESC`, y con ese orden PostgreSQL
    // NO garantiza que dos ejecuciones devuelvan los empates en el mismo
    // sitio. Mientras se lea todo, da igual. En cuanto hay LIMIT -y lo hay-
    // el conjunto leido puede variar entre llamadas, asi que una
    // conversacion empatada en la frontera del limite puede aparecer en dos
    // paginas o en NINGUNA.
    //
    // Y los empates no son raros: varios mensajes del mismo lote de webhook
    // se guardan en el mismo instante.
    //
    // El patron correcto ya estaba en este mismo fichero -los pedidos de un
    // contacto ordenan por `creado_en, codigo`- y faltaba justo en las dos
    // consultas que alimentan el panel.
    async listar({ limite = 200 } = {}) {
      const { rows } = await pool.query(
        "SELECT * FROM conversaciones ORDER BY actualizado_en DESC NULLS LAST, contacto_id ASC LIMIT $1",
        [limite]
      );
      return rows.map(filaAConversacion);
    },
  };

  // ----------------------------------------------------------------------
  // Pedidos
  // ----------------------------------------------------------------------
  const pedidos = {
    async obtener(codigo) {
      if (!codigo) return null;
      const { rows } = await pool.query("SELECT * FROM pedidos WHERE codigo = $1", [codigo]);
      if (!rows[0]) return null;
      const cli = await pool.connect();
      try {
        return filaAPedido(rows[0], await historialDe(cli, codigo));
      } finally {
        cli.release();
      }
    },

    /**
     * Pedidos, el mas reciente primero. Opcionalmente por rango de dias.
     *
     * El filtro se hace EN LA BASE y en hora de Bogota:
     *
     *   (creado_en AT TIME ZONE 'America/Bogota')::date
     *
     * Comparar el timestamp en UTC mandaria los pedidos de despues de las
     * 19:00 al dia siguiente, que es el error que el panel de BIKERPRO ya
     * cometio. Y filtrar en JavaScript obligaria a traerse todo primero.
     */
    async listar({ limite = 500, desde = null, hasta = null } = {}) {
      const condiciones = [];
      const valores = [];
      if (desde) {
        valores.push(desde);
        condiciones.push(`(creado_en AT TIME ZONE 'America/Bogota')::date >= $${valores.length}::date`);
      }
      if (hasta) {
        valores.push(hasta);
        condiciones.push(`(creado_en AT TIME ZONE 'America/Bogota')::date <= $${valores.length}::date`);
      }
      valores.push(limite);

      const { rows } = await pool.query(
        `SELECT * FROM pedidos
          ${condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : ""}
          ORDER BY creado_en DESC NULLS LAST, codigo ASC
          LIMIT $${valores.length}`,
        valores
      );

      const cli = await pool.connect();
      try {
        const salida = [];
        for (const f of rows) salida.push(filaAPedido(f, await historialDe(cli, f.codigo)));
        return salida;
      } finally {
        cli.release();
      }
    },

    async porClaveDeEvento(clave) {
      if (!clave) return null;
      const { rows } = await pool.query("SELECT codigo FROM pedidos WHERE clave_de_evento = $1", [clave]);
      return rows[0] ? pedidos.obtener(rows[0].codigo) : null;
    },

    /**
     * EL NUCLEO DEL CONTRATO.
     *
     * La no duplicacion la garantizan los dos indices UNICOS, no este
     * codigo: `ON CONFLICT DO NOTHING` sin objetivo cubre CUALQUIER
     * restriccion unica, y si no inserto nada es porque ya existia algo
     * equivalente. Entonces se busca que fue y se devuelve el pedido que ya
     * estaba, que es lo que el contrato exige para poder responderle al
     * cliente con el pedido de verdad.
     *
     * El advisory lock no es lo que evita el duplicado -el indice lo evita
     * igual-, es lo que hace que el perdedor reciba una respuesta limpia en
     * vez de un error de restriccion.
     */
    async crearSiNoExiste(pedido) {
      if (!pedido || !pedido.id) throw new Error("un pedido necesita id");
      if (!pedido.claveDeEvento || !pedido.claveDeOferta) {
        return {
          creado: false,
          pedido: null,
          motivo:
            "el pedido no trae clave de evento y de oferta: sin ellas no se puede garantizar que no se duplique",
        };
      }

      return enTransaccion(pedido.contactoId, async (cli) => {
        await asegurarContacto(cli, pedido.contactoId);

        const fila = pedidoAFila(pedido);
        const marcadores = COLUMNAS_PEDIDO.map((_, i) => `$${i + 1}`).join(", ");

        const insercion = await cli.query(
          `INSERT INTO pedidos (${COLUMNAS_PEDIDO.join(", ")})
           VALUES (${marcadores})
           ON CONFLICT DO NOTHING
           RETURNING *`,
          valoresDePedido(fila)
        );

        if (insercion.rowCount === 1) {
          await guardarHistorial(cli, pedido.id, pedido.historial);
          return { creado: true, pedido: filaAPedido(insercion.rows[0], await historialDe(cli, pedido.id)) };
        }

        // No se inserto: ya habia algo equivalente. Que fue, en el mismo
        // orden de precedencia que el adaptador de archivos.
        const porEvento = await cli.query("SELECT * FROM pedidos WHERE clave_de_evento = $1", [pedido.claveDeEvento]);
        if (porEvento.rows[0]) {
          return {
            creado: false,
            pedido: filaAPedido(porEvento.rows[0], await historialDe(cli, porEvento.rows[0].codigo)),
            motivo: MOTIVOS_NO_CREADO.EVENTO_REPETIDO,
          };
        }

        const porOferta = await cli.query(
          "SELECT * FROM pedidos WHERE clave_de_oferta = $1 AND estado <> 'cancelado'",
          [pedido.claveDeOferta]
        );
        if (porOferta.rows[0]) {
          return {
            creado: false,
            pedido: filaAPedido(porOferta.rows[0], await historialDe(cli, porOferta.rows[0].codigo)),
            motivo: MOTIVOS_NO_CREADO.OFERTA_YA_TIENE_PEDIDO,
          };
        }

        // Quedo una tercera posibilidad: el mismo codigo de pedido. Es un id
        // generado con tiempo y azar, asi que no deberia pasar, pero si pasa
        // hay que decirlo y no devolver "creado" en falso.
        const porCodigo = await cli.query("SELECT * FROM pedidos WHERE codigo = $1", [pedido.id]);
        if (porCodigo.rows[0]) {
          return {
            creado: false,
            pedido: filaAPedido(porCodigo.rows[0], await historialDe(cli, pedido.id)),
            motivo: MOTIVOS_NO_CREADO.EVENTO_REPETIDO,
          };
        }

        return { creado: false, pedido: null, motivo: "no se inserto y no se encontro el equivalente" };
      });
    },

    async reemplazar(pedido) {
      if (!pedido || !pedido.id) throw new Error("un pedido necesita id");

      return enTransaccion(pedido.contactoId, async (cli) => {
        const fila = pedidoAFila(pedido);
        const asignaciones = COLUMNAS_PEDIDO.filter((c) => c !== "codigo")
          .map((c, i) => `${c} = $${i + 2}`)
          .join(", ");
        const valores = [fila.codigo, ...COLUMNAS_PEDIDO.filter((c) => c !== "codigo").map((c) =>
          JSONB_PEDIDO.has(c) ? (fila[c] === null ? null : JSON.stringify(fila[c])) : fila[c]
        )];

        const { rows } = await cli.query(
          `UPDATE pedidos SET ${asignaciones} WHERE codigo = $1 RETURNING *`,
          valores
        );
        if (!rows[0]) throw new Error(`no existe el pedido ${pedido.id}`);

        // El historial es append-only: se añade lo que falte, no se pisa.
        await guardarHistorial(cli, pedido.id, pedido.historial);
        return filaAPedido(rows[0], await historialDe(cli, pedido.id));
      });
    },

    async porContacto(contactoId, { incluirCancelados = false } = {}) {
      const sql = incluirCancelados
        ? "SELECT * FROM pedidos WHERE contacto_id = $1 ORDER BY creado_en, codigo"
        : "SELECT * FROM pedidos WHERE contacto_id = $1 AND estado <> 'cancelado' ORDER BY creado_en, codigo";
      const { rows } = await pool.query(sql, [contactoId]);
      const cli = await pool.connect();
      try {
        const salida = [];
        for (const f of rows) salida.push(filaAPedido(f, await historialDe(cli, f.codigo)));
        return salida;
      } finally {
        cli.release();
      }
    },

    /** El pedido vivo del contacto. Si hay mas de uno, NO elige. */
    async activoDeContacto(contactoId) {
      // La lista de estados cerrados sale del DOMINIO, no de un literal
      // escrito aqui: este mismo filtro existe en el backend de archivos y
      // dos copias de la misma regla se separan. Cuando se añadio
      // `entregado`, un literal en cada backend habria dejado uno de los
      // dos tratando el pedido entregado como el pedido vivo del contacto.
      const { rows } = await pool.query(
        "SELECT codigo FROM pedidos WHERE contacto_id = $1 AND NOT (estado = ANY($2))",
        [contactoId, [...CERRADOS]]
      );
      if (rows.length === 1) return pedidos.obtener(rows[0].codigo);
      // Cero o mas de uno. Mas de uno es una anomalia, y devolver "alguno"
      // seria modificar el pedido equivocado.
      return null;
    },
  };

  // ----------------------------------------------------------------------
  // Transversales
  // ----------------------------------------------------------------------
  async function estado() {
    const { rows } = await pool.query(`
      SELECT
        (SELECT count(*) FROM pedidos)::int                             AS pedidos,
        (SELECT count(*) FROM pedidos WHERE estado <> 'cancelado')::int AS pedidos_vivos,
        (SELECT count(*) FROM conversaciones)::int                      AS conversaciones,
        (SELECT count(*) FROM contactos)::int                           AS contactos
    `);
    return { tipo: TIPO, ...rows[0] };
  }

  async function cerrar() {
    await pool.end();
  }

  /** Reabre sobre la misma base. Simula el reinicio del proceso. */
  async function reabrir() {
    return crearReposDePostgres({ dsn, pg, maxConexiones, log });
  }

  /**
   * TODO lo que hay en la base. FUERA DEL CONTRATO, solo para el cutover.
   *
   * Existe para que el cutover funcione en los DOS sentidos. El de vuelta
   * -PostgreSQL a archivos- no es un lujo: es el unico procedimiento de
   * rollback honesto una vez que la base ha recibido escrituras que el disco
   * no tiene. Sin esto, "volver atras" seria perder esas escrituras.
   */
  async function _inventario() {
    const cli = await pool.connect();
    try {
      const contactosFilas = await cli.query("SELECT * FROM contactos ORDER BY id");
      const convFilas = await cli.query("SELECT * FROM conversaciones ORDER BY contacto_id");
      const pedidoFilas = await cli.query("SELECT * FROM pedidos ORDER BY creado_en, codigo");

      const pedidosConHistorial = [];
      for (const f of pedidoFilas.rows) {
        pedidosConHistorial.push(filaAPedido(f, await historialDe(cli, f.codigo)));
      }

      return {
        contactos: contactosFilas.rows.map(filaAContacto),
        conversaciones: convFilas.rows.map(filaAConversacion),
        pedidos: pedidosConHistorial,
      };
    } finally {
      cli.release();
    }
  }

  return { tipo: TIPO, contactos, conversaciones, pedidos, estado, cerrar, reabrir, _inventario, _pool: pool };
}

module.exports = {
  crearReposDePostgres,
  TIPO,
  describirDestino,
  opcionesDeSsl,
  sobrantes,
  pedidoAFila,
  filaAPedido,
  filaAConversacion,
  COLUMNAS_PEDIDO,
  ESTADOS_MUERTOS,
};
