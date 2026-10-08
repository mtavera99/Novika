"use strict";

// ==========================================================================
// RUTAS DEL PANEL
//
// Todas las acciones pasan por los repositorios y las reglas de NOVIKA. No
// hay un segundo almacen de pedidos: el store de BIKERPRO no se copia,
// porque dos sitios donde viven los pedidos son dos contabilidades que
// acaban discrepando.
//
// Reglas de esta capa:
//   - cada accion exige sesion;
//   - lo que se consume por fetch responde JSON, con el estado HTTP correcto;
//   - nada se muestra como enviado si no se envio.
// ==========================================================================

const express = require("express");

const { config } = require("../config");
const log = require("../log");
const diario = require("../almacen/diario");
const metricas = require("../metricas");
const atencion = require("../almacen/atencion");
const auth = require("./auth");
const datos = require("./datos");
const vistas = require("./vistas");
const fecha = require("./fecha");
const fichaDe = require("./ficha");
const analitica = require("./analitica");
const silencios = require("./silencios");
const fotos = require("../whatsapp/fotos");
const dominioPedido = require("../dominio/pedido");
const campos = require("../dominio/campos");
const dominioDestino = require("../dominio/destino");
const responder = require("../cerebro/responder");
const planes = require("../despacho/planes");
const guias = require("../despacho/guias");
const pdf = require("../despacho/pdf");
const novedadesDeEntrega = require("../despacho/novedades");
const hojaDeCalculo = require("../despacho/hoja-de-calculo");
const ventana = require("../whatsapp/ventana");

const { PERMISOS, MOTIVOS_BLOQUEO } = require("../whatsapp/enviar");

/**
 * Motivos de bloqueo en lenguaje del dueno.
 *
 * El panel nunca muestra el codigo interno: "envio_manual_apagado" no le
 * dice a nadie que hay que cambiar una variable en Render.
 */
const EXPLICACION = {
  [MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO]:
    "Los envios manuales estan APAGADOS, asi que el mensaje quedo registrado en la conversacion pero NO salio. " +
    "Para encenderlos: Render -> novika-bot -> Environment -> PANEL_ENVIO_MANUAL = 1, y guardar (el servicio se " +
    "reinicia solo). Puedes comprobarlo en /health: panel_envio_manual debe decir true.",
  [MOTIVOS_BLOQUEO.INTERRUPTOR]:
    "Las respuestas automaticas estan apagadas (RESPUESTA_AUTOMATICA=0). El mensaje NO salio.",
  [MOTIVOS_BLOQUEO.SIN_CREDENCIALES]:
    "Faltan las credenciales de WhatsApp en el servicio. El mensaje NO salio.",
  [MOTIVOS_BLOQUEO.CONVERSACION_PAUSADA]:
    "Una persona tiene el control de este chat, asi que el bot no escribe.",
  [MOTIVOS_BLOQUEO.SIN_DESTINO]: "Falta el numero del cliente.",
  // Sin esta entrada, Marco recibia "Bloqueado: destinatario_sin_telefono"
  // -jerga- y volvia a intentarlo. Lo hizo dos veces el 07-oct contra el
  // mismo cliente. No es un fallo que se arregle reintentando.
  [MOTIVOS_BLOQUEO.SIN_TELEFONO]:
    "El destinatario no es ni un telefono ni un identificador de WhatsApp con la forma que exige Meta, " +
    "asi que no habia a donde enviar y NO se gasto el intento. " +
    "Ojo: a los clientes que entran con NOMBRE DE USUARIO (su id empieza por `CO.`) SI se les puede " +
    "escribir — el mensaje sale con su identificador—, lo que no tenemos de ellos es el telefono, y " +
    "ese si hace falta para despachar.",
  [MOTIVOS_BLOQUEO.TEXTO_VACIO]: "El mensaje estaba vacio.",
  [MOTIVOS_BLOQUEO.SIN_PERMISO]: "Ese envio no declaro permiso. Es un fallo interno, no tuyo.",
};

/** Traduce un error de Meta a algo accionable. */
function explicarFalloDeMeta(envio) {
  const codigo = envio && envio.codigo;
  if (codigo === 131047 || codigo === 470) {
    return (
      "Pasaron mas de 24 horas desde el ultimo mensaje del cliente. Meta no permite texto libre fuera de " +
      "esa ventana: hace falta una plantilla aprobada. El mensaje NO salio."
    );
  }
  if (envio && envio.estado === 401) return "Meta rechazo las credenciales (401). El mensaje NO salio.";
  return `No se pudo enviar${envio && envio.estado ? ` (HTTP ${envio.estado})` : ""}. El mensaje NO salio.`;
}

/**
 * Memoria corta para frenar el doble envio.
 *
 * BIKERPRO lo tiene porque pasaba: un doble clic mandaba dos mensajes al
 * cliente. El boton tambien se desactiva en la pantalla, pero eso no basta
 * -una pestana duplicada, un reintento- y el candado de verdad va aqui.
 *
 * En memoria a proposito: su unico trabajo es cubrir los segundos del doble
 * clic. Si el proceso se reinicia, no hay doble clic que cubrir.
 */
const VENTANA_DOBLE_MS = 8000;
const ultimosEnvios = new Map();

function esRepetido(destino, texto, ahora = Date.now()) {
  const clave = `${destino}|${String(texto).trim()}`;
  const previo = ultimosEnvios.get(clave);
  // Limpieza perezosa: sin esto el mapa crece para siempre.
  if (ultimosEnvios.size > 500) {
    for (const [k, t] of ultimosEnvios) if (ahora - t > VENTANA_DOBLE_MS) ultimosEnvios.delete(k);
  }
  if (previo && ahora - previo < VENTANA_DOBLE_MS) return true;
  ultimosEnvios.set(clave, ahora);
  return false;
}

/**
 * @param {object} dependencias
 * @param {Function} dependencias.obtenerCerebro  para repos, catalogo y emisor
 */
function crearRutasDelPanel({ obtenerCerebro }) {
  const router = express.Router();

  // El panel manda formularios y JSON. Se acotan al router del panel para no
  // cambiar como se parsea el webhook, que necesita el cuerpo crudo para la
  // firma.
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));
  router.use(express.json({ limit: "64kb" }));

  /** Atajo: repos y compania. */
  async function piezas() {
    const cerebro = await obtenerCerebro();
    return cerebro._piezas ? cerebro._piezas() : cerebro;
  }

  // ----------------------------------------------------------------------
  // Los planes de despacho: el paso entre "revisar" y "enviar".
  //
  // Uno por flujo, porque caducan distinto en la practica y porque un
  // reintento de guias no tiene por que tocar las novedades. El detalle de
  // por que no van a la base esta en `despacho/planes.js`.
  // ----------------------------------------------------------------------
  const planesDeGuias = planes.crearAlmacenDePlanes({ log, nombre: "planes_de_guias" });
  const planesDeNovedades = planes.crearAlmacenDePlanes({ log, nombre: "planes_de_novedades" });

  /** Las plantillas de novedad configuradas, por tipo. */
  function plantillasDeNovedad() {
    return {
      [dominioPedido.TIPOS_DE_NOVEDAD.DIRECCION]: config.plantillaNovedadDireccion,
      [dominioPedido.TIPOS_DE_NOVEDAD.AUSENTE]: config.plantillaNovedadAusente,
      [dominioPedido.TIPOS_DE_NOVEDAD.OFICINA]: config.plantillaNovedadOficina,
    };
  }

  /**
   * ¿Ya se le aviso de esta guia? Se pregunta AL PEDIDO.
   *
   * No hay un registro aparte de "guias enviadas" a proposito. Un segundo
   * sitio donde vive ese hecho es una segunda fuente de verdad, y el dia que
   * discrepen una deja pasar un aviso duplicado -justo el patron que la
   * convencion del proyecto prohibe con la deduplicacion-.
   *
   * El pedido ya tiene donde guardarlo: `despacho.avisoAlCliente`.
   */
  function indiceDeAvisos(pedidos) {
    const porGuia = new Map();
    for (const p of pedidos) {
      const g = String((p.despacho && p.despacho.guia) || "").trim();
      if (!g) continue;
      const aviso = p.despacho && p.despacho.avisoAlCliente;
      if (aviso && aviso.enviado) {
        porGuia.set(g, {
          nombre: (p.destinatario && p.destinatario.nombre) || null,
          cuando: fecha.fechaYHoraBogota(aviso.cuando),
          codigo: p.id,
        });
      }
    }
    return (guia) => porGuia.get(String(guia || "").trim()) || null;
  }

  /**
   * Manda UNA hoja de guia a su cliente y anota el resultado real.
   *
   * Es una sola funcion porque hay dos caminos que llegan aqui -el envio por
   * lote y la asignacion a mano- y en BIKERPRO eran dos copias: la de
   * asignar a mano se quedo sin el registro de la guia enviada, asi que la
   * misma guia se podia mandar dos veces.
   */
  async function mandarHojaDeGuia({ repos, emisor, fila, pedido: original, aMano = false }) {
    const transportadora = fila.transportadora || null;

    // ----------------------------------------------------------------------
    // MANDAR LA GUIA **ES** DESPACHAR, Y SE REGISTRA ANTES DE ENVIAR
    //
    // Si no se registrara, el pedido seguiria en "por despachar" con su guia
    // ya en manos del cliente: la lista de pendientes mentiria, y en el
    // siguiente lote esa misma guia volveria a ofrecerse para enviar.
    //
    // VA ANTES DEL ENVIO a proposito. Si el envio falla despues, queda un
    // pedido despachado con su guia y un aviso que dice que no salio: eso se
    // reintenta, y mientras tanto la informacion es correcta -el paquete
    // salio-. Al reves seria peor: el cliente con la guia en la mano y el
    // sistema creyendo que el pedido no ha salido.
    //
    // Y `despachar` exige que el pedido este listo, asi que un pedido sin
    // direccion completa no puede colarse por aqui.
    // ----------------------------------------------------------------------
    let pedido = original;
    const despacho = dominioPedido.despachar({
      pedido: original,
      guia: fila.guia,
      transportadora: transportadora ? transportadora.nombre : null,
    });

    if (!despacho.ok) {
      diario.anotar("panel_guia_no_despachada", {
        codigo: original.id,
        guia: fila.guia,
        motivo: despacho.motivo,
      });
      return { enviado: false, bloqueado: true, motivo: null, detalle: despacho.motivo };
    }
    if (!despacho.yaEstaba) {
      await repos.pedidos.reemplazar(despacho.pedido);
      pedido = despacho.pedido;
    } else {
      pedido = despacho.pedido;
    }

    const destino = guias.destinoDe(pedido);
    const conv = await repos.conversaciones.obtener(pedido.contactoId).catch(() => null);
    const v = ventana.estado(conv);

    const envio = await emisor.enviarDocumento({
      para: destino,
      datos: fila.hoja,
      nombreArchivo: guias.nombreArchivo(fila.guia),
      pie: guias.textoParaCliente(pedido, fila.guia, transportadora),
      ventanaAbierta: v.abierta,
      // Con la ventana cerrada -el caso normal, porque la guia sale al dia
      // siguiente- el PDF viaja en la cabecera de la plantilla.
      plantilla: config.plantillaGuia,
      permiso: PERMISOS.ATENCION_MANUAL,
      conversacionId: pedido.contactoId,
    });

    // El resultado se anota SIEMPRE, salga o no. Un intento que fallo y no
    // queda escrito es un cliente que nadie sabe que no fue avisado.
    const r = dominioPedido.registrarAvisoDeGuia({
      pedido,
      resultado: { ...envio, certeza: fila.certeza, aMano },
    });
    if (r.ok && !r.yaEstaba) await repos.pedidos.reemplazar(r.pedido);

    // La guia tambien queda en el historial del chat, para que quien abra la
    // conversacion vea lo que el cliente recibio.
    if (envio.enviado && conv) {
      atencion.anotarMensaje(conv, {
        de: atencion.QUIEN.BOT,
        texto: envio.porPlantilla
          ? `[guia ${fila.guia} enviada por plantilla aprobada]`
          : guias.textoParaCliente(pedido, fila.guia, transportadora),
        por: "operador",
        estado: "enviado",
      });
      await repos.conversaciones.guardar(conv).catch(() => null);
    }

    diario.anotar("panel_guia_enviada", {
      codigo: pedido.id,
      guia: fila.guia,
      enviado: envio.enviado,
      porPlantilla: Boolean(envio.porPlantilla),
      motivo: envio.motivo || null,
      certeza: fila.certeza,
      aMano,
      yaEstabaDespachado: despacho.yaEstaba,
    });
    metricas.incrementar(envio.enviado ? "panel_guia_enviada" : "panel_guia_no_enviada");

    return envio;
  }

  const html = (res, cuerpo, estado = 200) =>
    res.status(estado).set("Content-Type", "text/html; charset=utf-8").send(cuerpo);

  // ----------------------------------------------------------------------
  // Entrar y salir
  // ----------------------------------------------------------------------
  router.post("/entrar", (req, res) => {
    const recibido = (req.body && req.body.token) || "";
    if (!auth.tokenCorrecto(recibido, config.panelToken)) {
      // No se distingue "token vacio" de "token equivocado": decirlo
      // ayudaria a quien esta probando a ciegas.
      log.warn("panel_entrada_rechazada", {});
      return html(res, auth.pantallaDeEntrada("Token incorrecto."), 401);
    }
    auth.ponerCookie(res, config);
    log.info("panel_entrada", {});
    res.redirect("/panel");
  });

  router.post("/salir", (req, res) => {
    auth.quitarCookie(res);
    html(res, auth.pantallaDeEntrada("Sesion cerrada."));
  });

  // ----------------------------------------------------------------------
  // Tablero
  // ----------------------------------------------------------------------
  router.get("/", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { repos } = await piezas();
      const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dia || "")) ? req.query.dia : fecha.hoyBogota();
      const clase = Object.values(datos.CLASES).includes(req.query.clase)
        ? req.query.clase
        : datos.CLASES.PENDIENTE;
      const tabla = await datos.tablero(repos, { dia });
      html(res, vistas.tablero({ datos: tabla, clase, envioManualActivo: config.panelEnvioManual }));
    } catch (e) {
      log.error("panel_tablero_fallo", { detalle: e.message });
      html(res, vistas.tablero({
        datos: { dia: fecha.hoyBogota(), resumen: datos.resumirPedidos([]), chats: [], porClase: {}, cuentas: {}, pedidos: [] },
        aviso: { clase: "mal", texto: `No se pudo armar el tablero: ${e.message}` },
        envioManualActivo: config.panelEnvioManual,
      }), 500);
    }
  });

  // ----------------------------------------------------------------------
  // Buscar
  // ----------------------------------------------------------------------
  router.get("/buscar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    const q = String(req.query.q || "");
    try {
      const { repos } = await piezas();
      const resultados = q ? await datos.buscar(repos, q) : [];
      html(res, vistas.buscar({ q, resultados }));
    } catch (e) {
      html(res, vistas.buscar({ q, resultados: [] }), 500);
    }
  });

  /**
   * Manda un texto al cliente desde el panel y anota el resultado REAL.
   *
   * Se extrajo para que /responder y /entrega usen el mismo camino. Si cada
   * ruta tuviera el suyo, una de las dos acabaria sin anotar el estado real
   * del envio, y el panel mostraria como dicho algo que no salio.
   */
  async function enviarDesdeElPanel({ id, texto, conv, repos }) {
    const { emisor } = await piezas();
    const telefono = fichaDe.confirmado(conv.ficha, "telefono") || id;
    const envio = await emisor.enviarTexto({ para: telefono, texto, permiso: PERMISOS.ATENCION_MANUAL });

    const estado = envio.enviado ? "enviado" : envio.bloqueado ? envio.motivo : "fallo_de_envio";
    atencion.anotarMensaje(conv, {
      de: atencion.QUIEN.OPERADOR,
      texto,
      por: "panel",
      estado,
      wamid: envio.wamid || null,
    });
    // Igual que al responder a mano: si una persona escribe, el bot se calla
    // en ese chat para que el cliente no reciba dos voces.
    conv.atencion = { ...atencion.leer(conv), pausado: true, por: "panel", desde: new Date().toISOString() };
    await repos.conversaciones.guardar(conv);

    diario.anotar("panel_confirmacion_manual", { idCliente: id, texto, estado, wamid: envio.wamid || null });
    metricas.incrementar(envio.enviado ? "panel_confirmacion_enviada" : "panel_confirmacion_no_enviada");
    return { envio, estado };
  }

  // ----------------------------------------------------------------------
  // POR QUE EL BOT NO CONTESTO
  //
  // La pantalla que faltaba. Marco encontro mensajes sin responder y no
  // tenia donde ver el motivo: estaba en el diario y en los logs de Render,
  // y el panel mostraba un dia normal.
  // ----------------------------------------------------------------------
  router.get("/sin-responder", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    const dia = String(req.query.dia || "") || null;
    try {
      const { repos } = await piezas();
      const d = await silencios.diagnostico(repos, { dia });
      html(res, vistas.sinResponder({ datos: d, config }));
    } catch (e) {
      log.error("panel_sin_responder_fallo", { detalle: e.message });
      html(res, vistas.bloqueada({
        titulo: "Sin responder",
        queFalta: "No se pudo leer el diagnostico",
        porQue: e.message,
        comoSeDesbloquea: "Reintenta en un momento.",
      }), 500);
    }
  });

  // ----------------------------------------------------------------------
  // Devolver TODOS los chats al bot
  //
  // Existe porque el problema se acumula: cada chat atendido a mano quedaba
  // sin bot, y desatascarlos de uno en uno no es viable cuando ya hay
  // varios. Es una accion destructiva en un sentido -si alguien esta
  // atendiendo ahora mismo, el bot vuelve a hablar en ese chat-, asi que va
  // por POST y dice cuantos solto.
  // ----------------------------------------------------------------------
  router.post("/devolver-todos", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { repos } = await piezas();
      const convs = await repos.conversaciones.listar({ limite: 2000 });
      let soltados = 0;
      for (const conv of convs) {
        if (atencion.leer(conv).pausado !== true) continue;
        await atencion.devolverAlBot(repos, conv.contactoId);
        soltados += 1;
      }
      log.info("panel_devolver_todos", { soltados });
      diario.anotar("panel_devolver_todos", { soltados });
      return res.redirect("/panel/sin-responder");
    } catch (e) {
      log.error("panel_devolver_todos_fallo", { detalle: e.message });
      return res.redirect("/panel/sin-responder");
    }
  });

  // ----------------------------------------------------------------------
  // Bandeja: TODOS los chats
  //
  // El tablero muestra lo que espera respuesta. Esta pantalla muestra todo,
  // con filtros y paginacion, y es la unica forma de llegar a la
  // conversacion de quien pregunto y no compro sin recordar su nombre.
  // ----------------------------------------------------------------------
  router.get("/chats", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;

    const filtro = Object.values(datos.FILTROS).includes(String(req.query.filtro || ""))
      ? String(req.query.filtro)
      : datos.FILTROS.TODOS;
    const q = String(req.query.q || "");
    const pagina = Number(req.query.pagina) || 1;

    try {
      const { repos } = await piezas();
      const bandeja = await datos.bandeja(repos, { filtro, q, pagina });
      html(res, vistas.bandeja({ datos: bandeja }));
    } catch (e) {
      log.error("panel_bandeja_fallo", { detalle: e.message });
      html(
        res,
        vistas.bandeja({
          datos: { filas: [], total: 0, pagina: 1, paginas: 1, filtro, q, cuentas: {} },
          aviso: { clase: "malo", texto: "No se pudo cargar la bandeja." },
        }),
        500
      );
    }
  });

  // ----------------------------------------------------------------------
  // Corregir los datos de entrega
  //
  // DOS ACCIONES EN EL MISMO FORMULARIO, Y LA DIFERENCIA IMPORTA:
  //
  //   guardar   -> corrige la ficha de la conversacion. No le escribe al
  //                cliente. Es lo que se usa cuando el cliente dicto mal la
  //                direccion por WhatsApp.
  //   confirmar -> guarda Y le manda el resumen para que confirme.
  //
  // EL TOTAL NO SE ESCRIBE AQUI. El texto del resumen lo arma el dominio
  // con la cotizacion vigente, igual que cuando lo manda el bot. Si el panel
  // pudiera teclear un importe, habria dos fuentes de precio.
  // ----------------------------------------------------------------------
  router.post("/entrega", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;

    const id = String((req.body && req.body.id) || "").trim();
    const accion = String((req.body && req.body.accion) || "guardar");
    if (!id) return res.redirect("/panel/chats");

    try {
      const { repos, catalogo } = await piezas();
      const conv = await repos.conversaciones.obtener(id);
      if (!conv) return res.redirect("/panel/chats");

      // ------------------------------------------------------------------
      // LA CORRECCION DE UNA PERSONA QUEDA MARCADA COMO TAL
      //
      // Se guarda con origen OPERADOR y estado confirmado: lo escribio
      // alguien del equipo mirando el chat, asi que vale mas que lo que el
      // extractor leyo del texto. Y queda registrado QUIEN lo puso, que es
      // lo que permite auditar un despacho a una direccion corregida.
      // ------------------------------------------------------------------
      const VALIDADORES = {
        telefono: (v) => dominioDestino.validarTelefono(v),
        nombre: (v) => dominioDestino.validarNombre(v),
        ciudad: (v) => dominioDestino.resolverCiudad(v, null),
        direccion: (v) => dominioDestino.validarDireccion(v),
        // Departamento y referencia no tienen validador propio en el
        // dominio: basta que no esten vacios. No se inventa una validacion
        // para que parezca mas estricto de lo que es.
        departamento: (v) => ({ ok: Boolean(String(v || "").trim()), valor: String(v || "").trim() }),
        referencia: (v) => ({ ok: Boolean(String(v || "").trim()), valor: String(v || "").trim() }),
      };

      const corregidos = [];
      const rechazados = [];
      for (const campo of Object.keys(VALIDADORES)) {
        const v = String((req.body && req.body[campo]) || "").trim();
        if (!v) continue;

        const actual = fichaDe.leer(conv.ficha, campo);
        if (actual.hay && String(actual.valor).trim() === v) continue; // sin cambios

        // `proponer` NO pisa un dato confirmado, y aqui hay que pisarlo: el
        // caso de uso es justamente que el cliente dicto mal la direccion y
        // una persona la corrige mirando el chat. Por eso se REABRE primero,
        // y queda anotado en el historial del campo quien lo reabrio.
        let c = campos.reabrir(conv.ficha[campo], "corregido desde el panel");
        c = campos.proponer(c, v, campos.ORIGENES.PERSONA);
        c = campos.confirmar(c, VALIDADORES[campo]);

        conv.ficha[campo] = c;
        if (c.estado === campos.ESTADO_CAMPO.CONFIRMADO) corregidos.push(campo);
        else rechazados.push({ campo, motivo: c.motivo });
      }

      await repos.conversaciones.guardar(conv);
      log.info("panel_entrega_corregida", { contactoId: id, corregidos, rechazados: rechazados.length });
      if (rechazados.length) {
        // No se traga en silencio: un campo que el validador rechaza queda
        // como estaba, y quien lo escribio tiene que saberlo.
        log.warn("panel_entrega_rechazada", { contactoId: id, rechazados });
      }
      diario.anotar("panel_entrega_corregida", { idCliente: id, corregidos, rechazados });

      if (accion !== "confirmar") {
        return res.redirect(`/panel/chat?id=${encodeURIComponent(id)}`);
      }

      // ---- Confirmar por WhatsApp ----
      if (!config.panelEnvioManual) {
        log.info("panel_entrega_confirmar_bloqueado", { contactoId: id, motivo: "envio_manual_apagado" });
        return res.redirect(`/panel/chat?id=${encodeURIComponent(id)}`);
      }

      const todos = catalogo.productos || catalogo.activos || [];
      const producto = todos.find((p) => p.id === conv.productoId) || null;

      // El texto lo arma el dominio con la cotizacion vigente. Si no hay
      // cotizacion, NO se manda nada: pedirle a alguien que confirme sin
      // decirle cuanto paga es el defecto que BIKERPRO documento.
      if (!conv.cotizacion) {
        log.warn("panel_entrega_sin_cotizacion", { contactoId: id });
        return res.redirect(`/panel/chat?id=${encodeURIComponent(id)}`);
      }

      const texto = responder.textoDeterminista({
        situacion: "resumen",
        cotizacion: conv.cotizacion,
        producto,
      });

      await enviarDesdeElPanel({ id, texto, conv, repos });
      return res.redirect(`/panel/chat?id=${encodeURIComponent(id)}`);
    } catch (e) {
      log.error("panel_entrega_fallo", { detalle: e.message });
      return res.redirect(`/panel/chat?id=${encodeURIComponent(id)}`);
    }
  });

  // ----------------------------------------------------------------------
  // Chat
  // ----------------------------------------------------------------------
  router.get("/chat", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    const id = String(req.query.id || "");
    try {
      const { repos } = await piezas();
      const ficha = await datos.conversacionCompleta(repos, id);
      if (!ficha) return html(res, vistas.buscar({ q: id, resultados: [] }), 404);

      // El producto de la conversacion, del catalogo COMPLETO: el cinturon
      // es un borrador y aun asi se quieren poder mandar sus fotos.
      const { catalogo } = await piezas();
      const todos = catalogo.productos || catalogo.todos || catalogo.activos || [];
      const producto = todos.find((p) => p.id === ficha.conversacion.productoId) || null;

      html(res, vistas.chat({ ficha: { ...ficha, producto }, envioManualActivo: config.panelEnvioManual }));
    } catch (e) {
      log.error("panel_chat_fallo", { detalle: e.message });
      html(res, vistas.buscar({ q: id, resultados: [] }), 500);
    }
  });

  // ----------------------------------------------------------------------
  // Responder a mano
  // ----------------------------------------------------------------------
  router.post("/responder", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;

    const id = String((req.body && req.body.id) || "").trim();
    const texto = String((req.body && req.body.texto) || "").trim();
    if (!id || !texto) {
      return res.status(400).json({ ok: false, error: "Falta el cliente o el texto." });
    }

    try {
      const { repos, emisor } = await piezas();
      const conv = await repos.conversaciones.obtener(id);
      if (!conv) return res.status(404).json({ ok: false, error: "Esa conversacion no existe." });

      if (esRepetido(id, texto)) {
        return res.json({
          ok: true,
          enviado: false,
          repetido: true,
          aviso: "Ese mismo mensaje se acaba de registrar. No se repitio.",
        });
      }

      // A quien se le escribe NO puede salir de un candidato sin validar:
      // un telefono que propuso el modelo y nadie confirmo manda el mensaje
      // a otra persona. Si no esta confirmado se usa el id de WhatsApp, que
      // es de donde llego el mensaje y por tanto el unico dato seguro.
      const telefono = fichaDe.confirmado(conv.ficha, "telefono") || id;
      const envio = await emisor.enviarTexto({
        para: telefono,
        texto,
        permiso: PERMISOS.ATENCION_MANUAL,
      });

      // --------------------------------------------------------------
      // EL RESULTADO QUE SE GUARDA ES EL REAL.
      //
      // Tres finales distintos, y el panel los distingue:
      //   aceptado por Meta  -> "enviado" (con su wamid)
      //   bloqueado          -> el motivo, y por que
      //   fallido            -> el error traducido
      //
      // Que Meta acepte un mensaje no significa que lo entregue: BIKERPRO
      // lo midio con su cierre diario (ok:true con wamid, nunca entregado).
      // La entrega real solo se da por buena cuando llega el acuse
      // `delivered` por el webhook.
      // --------------------------------------------------------------
      const estado = envio.enviado
        ? "enviado"
        : envio.bloqueado
        ? envio.motivo
        : "fallo_de_envio";

      atencion.anotarMensaje(conv, {
        de: atencion.QUIEN.OPERADOR,
        texto,
        por: "panel",
        estado,
        wamid: envio.wamid || null,
      });

      // Tomar el control va JUNTO con la respuesta manual: si una persona
      // contesta y el bot sigue suelto, el cliente recibe dos voces. Es la
      // misma decision que tomo BIKERPRO, y por el mismo motivo.
      conv.atencion = { ...atencion.leer(conv), pausado: true, por: "panel", desde: new Date().toISOString() };
      await repos.conversaciones.guardar(conv);

      diario.anotar("panel_respuesta_manual", {
        idCliente: id,
        texto,
        estado,
        wamid: envio.wamid || null,
      });
      metricas.incrementar(envio.enviado ? "panel_respuesta_enviada" : "panel_respuesta_no_enviada");

      if (envio.enviado) {
        return res.json({
          ok: true,
          enviado: true,
          wamid: envio.wamid,
          hora: fecha.horaBogota(Date.now()),
          aviso: "Meta acepto el mensaje. El bot queda pausado en este chat. La entrega se confirma con el acuse.",
        });
      }

      return res.json({
        ok: true,
        enviado: false,
        motivo: estado,
        aviso: envio.bloqueado ? EXPLICACION[envio.motivo] || `Bloqueado: ${envio.motivo}` : explicarFalloDeMeta(envio),
      });
    } catch (e) {
      log.error("panel_responder_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: `No se pudo registrar: ${e.message}` });
    }
  });

  // ----------------------------------------------------------------------
  // Mandar las fotos de un producto
  //
  // Mismo permiso que una respuesta manual (ATENCION_MANUAL), mismo
  // interruptor (PANEL_ENVIO_MANUAL) y mismo resultado real en el
  // historial. Y como una respuesta manual, toma el control del chat: si
  // una persona manda las fotos y el bot sigue suelto, el cliente recibe
  // dos voces.
  // ----------------------------------------------------------------------
  router.post("/fotos", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;

    const id = String((req.body && req.body.id) || "").trim();
    const productoId = String((req.body && req.body.productoId) || "").trim();
    const pie = String((req.body && req.body.pie) || "");
    const forzar = (req.body && req.body.forzar) === true;
    if (!id) return res.status(400).json({ ok: false, error: "Falta el cliente." });

    try {
      const { repos, catalogo, emisor } = await piezas();
      const conv = await repos.conversaciones.obtener(id);
      if (!conv) return res.status(404).json({ ok: false, error: "Esa conversacion no existe." });

      // Si no se dice que producto, el de la conversacion.
      const quiero = productoId || conv.productoId;
      if (!quiero) {
        return res.status(400).json({
          ok: false,
          error: "No se sabe de que producto mandar fotos: esta conversacion no tiene producto identificado.",
        });
      }

      // Del catalogo COMPLETO, no solo de los activos: el cinturon es un
      // borrador y aun asi queremos poder mandar sus fotos para probar.
      const todos = catalogo.productos || catalogo.todos || catalogo.activos || [];
      const producto = todos.find((p) => p.id === quiero);
      if (!producto) {
        return res.status(404).json({ ok: false, error: `El producto "${quiero}" no esta en el catalogo.` });
      }

      const telefono = fichaDe.confirmado(conv.ficha, "telefono") || id;

      const informe = await fotos.enviarFotosDeProducto({
        emisor,
        repos,
        producto,
        conversacion: conv,
        para: telefono,
        permiso: PERMISOS.ATENCION_MANUAL,
        pie,
        forzar,
      });

      // Tomar el control, igual que al responder a mano.
      if (informe.enviadas > 0) {
        conv.atencion = { ...atencion.leer(conv), pausado: true, por: "panel", desde: new Date().toISOString() };
        await repos.conversaciones.guardar(conv);
      }

      diario.anotar("panel_fotos", {
        idCliente: id,
        productoId: quiero,
        enviadas: informe.enviadas,
        de: informe.cuantas,
        problemas: informe.problemas,
      });
      metricas.incrementar(informe.enviadas > 0 ? "panel_fotos_enviadas" : "panel_fotos_no_enviadas");

      if (informe.repetido) {
        return res.json({
          ok: true,
          enviadas: 0,
          aviso: `${informe.problemas[0]} Si quieres repetirlas, usa "forzar".`,
        });
      }

      if (informe.enviadas === 0) {
        const primero = informe.resultados[0];
        const motivo = primero ? primero.estado : "sin resultado";
        return res.json({
          ok: true,
          enviadas: 0,
          aviso:
            EXPLICACION[motivo] ||
            `No se mando ninguna foto (${motivo}${primero && primero.detalle ? `: ${primero.detalle}` : ""}).`,
        });
      }

      return res.json({
        ok: true,
        enviadas: informe.enviadas,
        de: informe.cuantas,
        aviso:
          informe.enviadas === informe.cuantas
            ? `Meta acepto las ${informe.enviadas} fotos. El bot queda pausado en este chat. La entrega se confirma con los acuses.`
            : `Se mandaron ${informe.enviadas} de ${informe.cuantas}. ${informe.problemas.join(" ")}`,
      });
    } catch (e) {
      log.error("panel_fotos_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // Tomar el control / devolver al bot
  // ----------------------------------------------------------------------
  router.post("/control", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const id = String((req.body && req.body.id) || "").trim();
    const tomar = (req.body && req.body.tomar) === true;
    if (!id) return res.status(400).json({ ok: false, error: "Falta el cliente." });

    try {
      const { repos } = await piezas();
      const conv = tomar
        ? await atencion.tomarControl(repos, id, { por: "panel" })
        : await atencion.devolverAlBot(repos, id);
      if (!conv) return res.status(404).json({ ok: false, error: "Esa conversacion no existe." });

      diario.anotar(tomar ? "panel_control_tomado" : "panel_control_devuelto", { idCliente: id });
      return res.json({
        ok: true,
        pausado: tomar,
        aviso: tomar
          ? "Tienes el control. El bot no escribira en este chat, ni aunque ya estuviera preparando una respuesta."
          : "El chat vuelve al bot.",
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // Atendido
  // ----------------------------------------------------------------------
  // ----------------------------------------------------------------------
  // EMPEZAR DE CERO
  //
  // Para poder PROBAR. El chat de pruebas de Marco lleva dias de mensajes,
  // y con la memoria acumulada el bot no se comporta como con un cliente
  // nuevo: no se presenta, no repite el precio, y si hubo un escalado sigue
  // callado. Sin esto no se puede comprobar ningun cambio.
  //
  // Borra la memoria del BOT. NO borra el historial ni los pedidos: el
  // historial es la unica prueba de lo que se le dijo a una persona, y un
  // pedido es un compromiso con quien despacha.
  // ----------------------------------------------------------------------
  router.post("/empezar-de-cero", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const id = String((req.body && req.body.id) || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Falta el cliente." });

    try {
      const { repos } = await piezas();
      const conv = await atencion.empezarDeCero(repos, id, { por: "panel" });
      if (!conv) return res.status(404).json({ ok: false, error: "Esa conversacion no existe." });

      diario.anotar("panel_conversacion_reiniciada", { idCliente: id });
      log.info("panel_conversacion_reiniciada", { idCliente: id });
      return res.json({ ok: true, aviso: "Listo: el bot vuelve a tratar este chat como nuevo." });
    } catch (e) {
      log.error("panel_empezar_de_cero_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: "No se pudo reiniciar." });
    }
  });

  router.post("/atendido", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const id = String((req.body && req.body.id) || "").trim();
    const deshacer = (req.body && req.body.deshacer) === true;
    if (!id) return res.status(400).json({ ok: false, error: "Falta el cliente." });

    try {
      const { repos } = await piezas();
      const conv = deshacer
        ? await atencion.desmarcarAtendido(repos, id)
        : await atencion.marcarAtendido(repos, id, { por: "panel" });
      if (!conv) return res.status(404).json({ ok: false, error: "Esa conversacion no existe." });

      diario.anotar(deshacer ? "panel_atendido_deshecho" : "panel_atendido", { idCliente: id });
      return res.json({
        ok: true,
        aviso: deshacer
          ? "Vuelve a la lista de pendientes."
          : "Fuera de pendientes. Si el cliente vuelve a escribir, reaparece solo.",
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // Pedidos: cancelar y reactivar
  //
  // CANCELAR NO BORRA. El pedido se queda con su motivo, su version y su
  // historial, y deja de contar como venta en todas las pantallas a la vez
  // porque el filtro esta en un solo sitio (datos.resumirPedidos). Un
  // pedido borrado es contabilidad que desaparece.
  // ----------------------------------------------------------------------
  router.post("/pedido/cancelar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const codigo = String((req.body && req.body.codigo) || "").trim();
    const motivo = String((req.body && req.body.motivo) || "").trim() || "cancelado desde el panel";
    if (!codigo) return res.status(400).json({ ok: false, error: "Falta el codigo del pedido." });

    try {
      const { repos } = await piezas();
      const dominioPedido = require("../dominio/pedido");
const campos = require("../dominio/campos");
const dominioDestino = require("../dominio/destino");
const responder = require("../cerebro/responder");
      const pedido = await repos.pedidos.obtener(codigo);
      if (!pedido) return res.status(404).json({ ok: false, error: "Ese pedido no existe." });

      // Se usa la transicion del dominio, no un campo a mano: asi la
      // cancelacion queda versionada y en el historial, igual que si la
      // hubiera hecho el bot.
      //
      // `cancelar` recibe UN OBJETO. Llamarlo como (pedido, opciones) -que
      // es lo que parece natural- le pasa `pedido: undefined` y devuelve
      // "no hay pedido que cancelar" sin lanzar. Lo destapo la prueba.
      const r = dominioPedido.cancelar({ pedido, motivo: `${motivo} (desde el panel)` });
      if (!r.ok) return res.status(409).json({ ok: false, error: r.motivo || "No se pudo cancelar." });

      await repos.pedidos.reemplazar(r.pedido);
      diario.anotar("panel_pedido_cancelado", { codigo, motivo });
      return res.json({ ok: true, aviso: `Pedido ${codigo} cancelado. Queda en el historial con su motivo.` });
    } catch (e) {
      log.error("panel_cancelar_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // NO hay "reactivar un pedido cancelado", y es deliberado.
  //
  // El indice unico de la clave de oferta es PARCIAL: solo aplica a los
  // pedidos vivos (WHERE estado <> 'cancelado'). Eso existe para que un
  // cliente que cancela pueda volver a comprar. Pero significa que, despues
  // de una cancelacion, puede haber YA otro pedido vivo con la misma clave.
  //
  // Reactivar el viejo chocaria contra ese indice -o, peor, dejaria dos
  // pedidos vivos para la misma oferta si el indice no estuviera-. Un boton
  // que falla la mitad de las veces por un motivo que nadie entiende es peor
  // que no tenerlo: lo correcto es registrar una venta nueva, que ademas
  // deja el rastro de lo que de verdad paso.

  // ----------------------------------------------------------------------
  // Venta manual
  // ----------------------------------------------------------------------
  router.get("/venta-manual", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { catalogo } = await piezas();
      html(res, vistas.ventaManual({ productos: catalogo.activos || [] }));
    } catch (e) {
      html(res, vistas.ventaManual({ productos: [], aviso: { clase: "mal", texto: e.message } }), 500);
    }
  });

  router.post("/venta-manual", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    const b = req.body || {};
    try {
      const { repos, catalogo } = await piezas();
      const { cotizar } = require("../dominio/cotizador");
      const dominioPedido = require("../dominio/pedido");
const campos = require("../dominio/campos");
const dominioDestino = require("../dominio/destino");
const responder = require("../cerebro/responder");

      const producto = (catalogo.activos || []).find((p) => p.id === String(b.productoId || ""));
      if (!producto) {
        return html(
          res,
          vistas.ventaManual({
            productos: catalogo.activos || [],
            valores: b,
            aviso: { clase: "mal", texto: "Ese producto no esta activo en el catalogo." },
          }),
          400
        );
      }

      const cantidad = Math.max(1, Number(b.cantidad) || 1);
      const destino = { ciudad: String(b.ciudad || ""), departamento: String(b.departamento || "") };

      // El precio lo calcula el COTIZADOR, igual que en una venta del bot.
      // El panel no acepta un importe escrito a mano: seria la via mas
      // facil de meter un cobro equivocado en la contabilidad.
      const cot = cotizar({ producto, cantidad, destino });
      if (!cot || !cot.cotizacion) {
        return html(
          res,
          vistas.ventaManual({
            productos: catalogo.activos || [],
            valores: b,
            aviso: { clase: "mal", texto: `No se pudo cotizar: ${(cot && cot.motivo) || "faltan datos"}` },
          }),
          400
        );
      }

      const contactoId = String(b.contactoId || "").trim();

      // Claves de idempotencia propias del panel. Derivadas del cliente y
      // del producto, no de un azar: si se pulsa dos veces "registrar", la
      // segunda encuentra el pedido que ya existe en vez de crear otro.
      const claveDeEvento = `panel:${contactoId}:${producto.id}:${fecha.hoyBogota()}`;

      const armado = dominioPedido.construir({
        cotizacion: cot.cotizacion,
        datos: {
          nombre: String(b.nombre || ""),
          telefono: contactoId,
          ciudad: destino.ciudad,
          departamento: destino.departamento,
          direccion: String(b.direccion || ""),
        },
        contactoId,
        conversacionId: contactoId,
        ofertaId: claveDeEvento,
        wamidConfirmacion: claveDeEvento,
        origen: { via: "panel", nota: String(b.nota || "") },
      });

      if (!armado.ok) {
        return html(
          res,
          vistas.ventaManual({
            productos: catalogo.activos || [],
            valores: b,
            aviso: { clase: "mal", texto: `Faltan datos: ${(armado.falta || []).join(", ")}` },
          }),
          400
        );
      }

      await repos.contactos.guardar({ id: contactoId, telefono: contactoId });
      const r = await repos.pedidos.crearSiNoExiste(armado.pedido);

      diario.anotar("panel_venta_manual", {
        idCliente: contactoId,
        codigo: r.pedido && r.pedido.id,
        creado: r.creado,
        productoId: producto.id,
      });

      if (!r.creado) {
        return html(
          res,
          vistas.ventaManual({
            productos: catalogo.activos || [],
            aviso: {
              clase: "info",
              texto: `Ya existia un pedido para este cliente y producto hoy (${
                r.pedido ? r.pedido.id : "?"
              }). No se duplico.`,
            },
          })
        );
      }

      return res.redirect(`/panel/chat?id=${encodeURIComponent(contactoId)}`);
    } catch (e) {
      log.error("panel_venta_manual_fallo", { detalle: e.message });
      return html(
        res,
        vistas.ventaManual({ productos: [], valores: b, aviso: { clase: "mal", texto: e.message } }),
        500
      );
    }
  });

  // ----------------------------------------------------------------------
  // Exportar
  // ----------------------------------------------------------------------
  router.get("/pedidos.csv", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { repos } = await piezas();
      const dia = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.dia || "")) ? req.query.dia : null;
      const pedidos = await repos.pedidos.listar(dia ? { desde: dia, hasta: dia } : { limite: 5000 });

      const columnas = [
        "codigo", "version", "estado", "creado_bogota", "actualizado_bogota",
        "contacto", "nombre", "telefono", "ciudad", "departamento", "direccion",
        "producto", "cantidad", "subtotal", "envio", "descuento", "total", "origen",
      ];

      // Se antepone un apostrofo a los codigos: sin el, Excel convierte
      // "NOV-0001-2026" en una fecha y el codigo del pedido se pierde.
      const celda = (v) => {
        const s = String(v === null || v === undefined ? "" : v);
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };

      const filas = pedidos.map((p) => {
        const c = p.cotizacion || {};
        const d = p.destinatario || {};
        return [
          `'${p.id}`, p.version, p.estado,
          fecha.fechaYHoraBogota(p.creadoEn), fecha.fechaYHoraBogota(p.actualizadoEn),
          `'${p.contactoId}`, d.nombre, d.telefono, d.ciudad, d.departamento, d.direccion,
          c.productoId, c.cantidad, c.subtotal, c.envio, c.descuento, c.total,
          (p.origen && p.origen.via) || "bot",
        ].map(celda).join(";");
      });

      // Punto y coma y BOM: Excel en español no abre bien un CSV con comas,
      // y sin BOM los acentos salen mal.
      const csv = "\uFEFF" + [columnas.join(";"), ...filas].join("\r\n");
      res
        .set("Content-Type", "text/csv; charset=utf-8")
        .set("Content-Disposition", `attachment; filename="novika-pedidos-${dia || "todos"}.csv"`)
        .send(csv);
    } catch (e) {
      res.status(500).send(`No se pudo exportar: ${e.message}`);
    }
  });

  // ----------------------------------------------------------------------
  // Guias y despachos
  //
  // Lo IMPLEMENTADO: registrar la guia a mano y despachar, con la
  // transicion del dominio (versionada, en el historial, idempotente).
  // Lo BLOQUEADO: partir el PDF de la transportadora, que necesita un PDF
  // real contra el que ajustar el lector. Se separa en la pantalla en vez
  // de bloquearla entera.
  // ----------------------------------------------------------------------
  const TRANSPORTADORAS = ["99 Envios", "Coordinadora", "Interrapidisimo", "Envia", "Servientrega", "otra"];

  router.get("/guias", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { repos } = await piezas();
      const pedidos = await repos.pedidos.listar({ limite: 2000 });
      const d = analitica.despachos({ pedidos });
      // Se anota si cada uno esta listo: despachar un pedido sin direccion
      // completa manda un paquete que vuelve.
      d.porDespachar = d.porDespachar.map((p) => ({ ...p, _listo: dominioPedido.listoParaDespachar(p) }));
      html(
        res,
        vistas.guias({
          datos: d,
          transportadoras: TRANSPORTADORAS,
          envioManualActivo: config.panelEnvioManual,
        })
      );
    } catch (e) {
      log.error("panel_guias_fallo", { detalle: e.message });
      res.status(500).send(`No se pudo armar la pantalla de guias: ${e.message}`);
    }
  });

  router.post("/guias/despachar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const codigo = String((req.body && req.body.codigo) || "").trim();
    const guia = String((req.body && req.body.guia) || "").trim();
    const transportadora = String((req.body && req.body.transportadora) || "").trim() || null;
    if (!codigo || !guia) {
      return res.status(400).json({ ok: false, error: "Falta el pedido o el numero de guia." });
    }

    try {
      const { repos } = await piezas();
      const pedido = await repos.pedidos.obtener(codigo);
      if (!pedido) return res.status(404).json({ ok: false, error: "Ese pedido no existe." });

      const r = dominioPedido.despachar({ pedido, guia, transportadora });
      if (!r.ok) return res.status(409).json({ ok: false, error: r.motivo });

      if (!r.yaEstaba) await repos.pedidos.reemplazar(r.pedido);
      diario.anotar("panel_despachado", { codigo, guia, transportadora, yaEstaba: r.yaEstaba });
      metricas.incrementar("panel_despachado");

      return res.json({
        ok: true,
        aviso: r.yaEstaba
          ? `El pedido ${codigo} ya estaba despachado con esa misma guia. No se duplico nada.`
          : `Pedido ${codigo} despachado con la guia ${guia}.`,
      });
    } catch (e) {
      log.error("panel_despachar_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // EL PDF DE LA TRANSPORTADORA, EN TRES PASOS
  //
  // 1. /guias/revisar  sube el PDF y PROPONE el pareo. No envia nada.
  // 2. /guias/asignar  el operador elige el pedido de una hoja que no cruzo.
  // 3. /guias/enviar   salen solo las hojas marcadas.
  //
  // El paso 2 es el que da el valor: es donde se ve que una guia quedo sin
  // parear y se arregla, en vez de descubrirlo cuando el cliente reclama.
  // ----------------------------------------------------------------------

  /**
   * El PDF llega como CUERPO CRUDO, no como formulario.
   *
   * `express.raw` acotado a esta ruta: el router del panel parsea
   * urlencoded y json, y un PDF por cualquiera de los dos llega corrupto.
   *
   * Y no se usa multipart a proposito. En BIKERPRO el `FormData` del
   * navegador llegaba vacio a Express -`req.body.token` undefined, 403- y en
   * Safari de iOS el fetch con FormData falla con "The string did not match
   * the expected pattern". Un cuerpo crudo no tiene ninguno de los dos
   * problemas y no necesita una dependencia de subida.
   */
  router.post(
    "/guias/revisar",
    express.raw({ type: () => true, limit: "40mb" }),
    async (req, res) => {
      if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;

      try {
        // ------------------------------------------------------------------
        // EL ORDEN DE LAS COMPROBACIONES ES PARTE DEL MENSAJE
        //
        // Primero se mira SI ESTO ES UN PDF, que es una comprobacion de la
        // cabecera y no cuesta nada. Si se comprobara antes que hay pedidos,
        // subir un archivo equivocado contestaria "no hay pedidos guardados"
        // -una queja sobre otra cosa- y el operador se pondria a buscar
        // pedidos en vez de a mirar el archivo que acaba de subir.
        //
        // Despues los pedidos, y solo al final el parseo, que es lo caro.
        // ------------------------------------------------------------------
        const revision = pdf.revisarPdf(req.body);
        if (!revision.ok) return res.status(400).json({ ok: false, error: revision.motivo });

        const { repos } = await piezas();
        const pedidos = await repos.pedidos.listar({ limite: 2000 });
        if (!pedidos.length) {
          return res.status(409).json({
            ok: false,
            error:
              "Todavia no hay pedidos guardados contra los que comparar las etiquetas. " +
              "El pareo necesita pedidos para saber de quien es cada guia.",
          });
        }

        const lote = await pdf.abrirLote(revision.datos);
        if (!lote.ok) return res.status(400).json({ ok: false, error: lote.motivo });

        const filas = guias.parear({
          paginas: lote.paginas,
          pedidos,
          telefonosRemitente: config.telefonosRemitente,
          yaEnviada: indiceDeAvisos(pedidos),
        });

        // Las hojas se guardan en el plan, del lado del servidor.
        for (let i = 0; i < filas.length; i++) filas[i].hoja = lote.hojas[i];

        const id = planesDeGuias.guardar({ filas });

        diario.anotar("panel_guias_revisadas", {
          paginas: filas.length,
          listas: filas.filter((f) => f.enviar).length,
          // Si esto sale `false`, la lectura cayo al camino que NO devuelve
          // la memoria: ~71 MB por lote. Queda anotado para poder explicar
          // un reinicio por memoria en vez de buscarlo a ciegas.
          enProcesoAparte: lote.enProcesoAparte === true,
          retenido: planesDeGuias.estado(),
        });

        return res.json({
          ok: true,
          id,
          // ------------------------------------------------------------------
          // LAS HOJAS NO SALEN DEL SERVIDOR
          //
          // Cada hoja es la etiqueta de un cliente con su nombre, direccion y
          // telefono impresos. El navegador no necesita el PDF para revisar el
          // pareo: le basta lo que se leyo. Mandarselas seria publicar los
          // datos de todos los clientes del lote en una pestana.
          // ------------------------------------------------------------------
          filas: filas.map((f) => ({
            pagina: f.pagina,
            guia: f.guia,
            transportadora: f.transportadora ? f.transportadora.nombre : null,
            etiqueta: f.etiqueta,
            certeza: f.certeza,
            senales: f.senales,
            motivo: f.motivo,
            enviar: f.enviar,
            asignable: f.asignable,
            mejores: f.mejores,
            pedido: f.pedido
              ? {
                  codigo: f.pedido.id,
                  nombre: (f.pedido.destinatario || {}).nombre || null,
                  ciudad: (f.pedido.destinatario || {}).ciudad || null,
                  total: (f.pedido.cotizacion || {}).total || 0,
                }
              : null,
          })),
          // TODOS los pedidos como candidatos para asignar a mano. En
          // BIKERPRO esta lista venia recortada a 60 y filtrada por "sin
          // guia", y las dos cosas escondian justo al cliente que hacia
          // falta. Solo van los ultimos cuatro digitos del telefono: para
          // reconocerlo alcanza, y la lista entera no tiene por que llevar
          // los telefonos completos de todos.
          candidatos: pedidos.map((p) => ({
            codigo: p.id,
            nombre: (p.destinatario || {}).nombre || null,
            ciudad: (p.destinatario || {}).ciudad || null,
            cel4: String((p.destinatario || {}).telefono || "").slice(-4),
            total: (p.cotizacion || {}).total || 0,
            estado: p.estado,
            guia: (p.despacho && p.despacho.guia) || null,
          })),
          aviso: lote.aviso || null,
          recortado: lote.recortado || null,
        });
      } catch (e) {
        log.error("panel_guias_revisar_fallo", { detalle: e.message });
        return res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  /** El operador elige a mano el pedido de una hoja que no cruzo sola. */
  router.post("/guias/asignar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const id = String((req.body && req.body.id) || "");
    const pagina = Number((req.body && req.body.pagina) || 0);
    const codigo = String((req.body && req.body.codigo) || "").trim();
    if (!id || !pagina || !codigo) {
      return res.status(400).json({ ok: false, error: "Falta el plan, la pagina o el pedido." });
    }

    const plan = planesDeGuias.obtener(id);
    if (!plan.ok) return res.status(410).json({ ok: false, error: plan.explicacion, motivo: plan.motivo });

    const fila = plan.contenido.filas.find((f) => f.pagina === pagina);
    if (!fila) return res.status(404).json({ ok: false, error: "Esa pagina no esta en el plan." });

    try {
      const { repos } = await piezas();
      const pedido = await repos.pedidos.obtener(codigo);
      if (!pedido) return res.status(404).json({ ok: false, error: "Ese pedido no existe." });

      // Asignar NO es reenviar. Si a esa guia ya se le aviso, se para aqui.
      const pedidos = await repos.pedidos.listar({ limite: 2000 });
      const previa = indiceDeAvisos(pedidos)(fila.guia);
      if (previa) {
        return res.status(409).json({
          ok: false,
          error: `A la guia ${fila.guia} ya se le aviso${previa.cuando ? " el " + previa.cuando : ""}.`,
        });
      }

      fila.pedido = pedido;
      // Certeza 0 y `aMano`: manana, ante un error, dice si fallo el puntaje
      // o la persona. Sin distinguirlo no se puede corregir ninguno de los dos.
      fila.certeza = 0;
      fila.aMano = true;
      fila.senales = ["asignada a mano"];
      fila.motivo = null;
      fila.enviar = true;
      fila.asignable = false;

      diario.anotar("panel_guia_asignada", { guia: fila.guia, codigo, pagina });

      return res.json({
        ok: true,
        pagina,
        guia: fila.guia,
        pedido: {
          codigo: pedido.id,
          nombre: (pedido.destinatario || {}).nombre || null,
          ciudad: (pedido.destinatario || {}).ciudad || null,
        },
        aviso: `Pagina ${pagina} asignada a ${(pedido.destinatario || {}).nombre || codigo}. Todavia no se envio.`,
      });
    } catch (e) {
      log.error("panel_guia_asignar_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /** Envia las hojas marcadas. */
  router.post("/guias/enviar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const id = String((req.body && req.body.id) || "");
    const paginas = Array.isArray(req.body && req.body.paginas) ? req.body.paginas.map(Number) : [];
    if (!id) return res.status(400).json({ ok: false, error: "Falta el plan." });
    if (!paginas.length) return res.status(400).json({ ok: false, error: "No marcaste ninguna guia." });

    const plan = planesDeGuias.obtener(id);
    if (!plan.ok) return res.status(410).json({ ok: false, error: plan.explicacion, motivo: plan.motivo });

    try {
      const { repos, emisor } = await piezas();
      const resultados = [];

      for (const pagina of paginas) {
        const fila = plan.contenido.filas.find((f) => f.pagina === pagina);
        // SE REVALIDA EN EL SERVIDOR. Que el navegador mande una pagina no
        // significa que se pueda enviar: pudo quedar sin pedido, o alguien
        // pudo mandarla desde otra pestana.
        if (!fila || !fila.enviar || !fila.pedido) {
          resultados.push({
            pagina,
            guia: fila ? fila.guia : null,
            enviado: false,
            porQue: "esta guia no esta lista para enviar",
          });
          continue;
        }

        const envio = await mandarHojaDeGuia({
          repos,
          emisor,
          fila,
          pedido: fila.pedido,
          aMano: Boolean(fila.aMano),
        });

        resultados.push({
          pagina,
          guia: fila.guia,
          cliente: (fila.pedido.destinatario || {}).nombre || null,
          enviado: Boolean(envio.enviado),
          porPlantilla: Boolean(envio.porPlantilla),
          porQue: envio.enviado
            ? null
            : EXPLICACION[envio.motivo] ||
              ventana.explicarCodigo(envio.codigoMeta) ||
              envio.detalle ||
              explicarFalloDeMeta({ codigo: envio.codigoMeta, estado: envio.estado }),
        });

        // Lo que ya salio no se vuelve a ofrecer, ni en un reintento.
        if (envio.enviado) fila.enviar = false;
      }

      const enviadas = resultados.filter((r) => r.enviado).length;
      const fallaron = resultados.length - enviadas;

      // Si TODO salio, el plan se descarta: sus hojas son decenas de MB.
      // Si algo fallo SE CONSERVA, para poder reintentar sin volver a subir
      // el PDF. `obtener()` ya refresco su vigencia.
      const quedanPorEnviar = plan.contenido.filas.some((f) => f.enviar && f.pedido);
      if (!quedanPorEnviar) planesDeGuias.borrar(id);

      return res.json({
        ok: true,
        intentadas: resultados.length,
        enviadas,
        fallaron,
        resultados,
        planVivo: quedanPorEnviar,
        aviso: fallaron
          ? `Salieron ${enviadas} de ${resultados.length}. Las que fallaron siguen marcadas: puedes reintentar sin volver a subir el PDF.`
          : `Salieron las ${enviadas}.`,
      });
    } catch (e) {
      log.error("panel_guias_enviar_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // MARCAR ENTREGADO: la plata que de verdad entro
  //
  // En contraentrega el pedido se cobra en la puerta, asi que esta accion
  // es la que convierte una venta en caja. Sin ella, "cuanto vamos
  // recaudado" solo se podia contestar con lo VENDIDO.
  //
  // No pide ningun dato: el importe lo congela el dominio desde la
  // cotizacion del pedido. Pedirlo a mano seria dejar que la caja dependa
  // de lo que alguien teclee.
  // ----------------------------------------------------------------------
  router.post("/guias/entregar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const codigo = String((req.body && req.body.codigo) || "").trim();
    if (!codigo) return res.status(400).json({ ok: false, error: "Falta el pedido." });

    try {
      const { repos } = await piezas();
      const pedido = await repos.pedidos.obtener(codigo);
      if (!pedido) return res.status(404).json({ ok: false, error: "Ese pedido no existe." });

      const r = dominioPedido.entregar({ pedido });
      if (!r.ok) return res.status(409).json({ ok: false, error: r.motivo });

      if (!r.yaEstaba) await repos.pedidos.reemplazar(r.pedido);
      diario.anotar("panel_entregado", { codigo, yaEstaba: r.yaEstaba });
      metricas.incrementar("panel_entregado");

      return res.json({
        ok: true,
        aviso: r.yaEstaba
          ? `El pedido ${codigo} ya estaba marcado como entregado. No se duplicó nada.`
          : `Pedido ${codigo} entregado. Entra en la caja del día.`,
      });
    } catch (e) {
      log.error("panel_entregar_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // INDICADORES: los numeros del dia en una pantalla
  //
  // Marco los pidio juntos y casi todos EXISTIAN ya, repartidos entre
  // /panel, /guias y /auditoria. Leer el dia obligaba a sumar a mano.
  //
  // Aqui no se calcula nada: todo sale de `analitica` y `datos`, que son
  // puros y estan probados.
  // ----------------------------------------------------------------------
  router.get("/indicadores", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { repos } = await piezas();
      const dias = Math.min(90, Math.max(1, Number(req.query.dias) || 14));
      const [serie, pedidos, conversaciones] = await Promise.all([
        datos.serie(repos, { dias }),
        repos.pedidos.listar({ limite: 5000 }),
        repos.conversaciones.listar({ limite: 2000 }),
      ]);

      html(
        res,
        vistas.indicadores({
          caja: analitica.caja({ pedidos }),
          despachos: analitica.despachos({ pedidos }),
          embudo: analitica.embudo({ conversaciones, pedidos }),
          atendidos: analitica.atendidos({ conversaciones }),
          serie,
          dias,
          hoy: fecha.hoyBogota(),
        })
      );
    } catch (e) {
      log.error("panel_indicadores_fallo", { detalle: e.message });
      res.status(500).send(`No se pudieron armar los indicadores: ${e.message}`);
    }
  });

  // ----------------------------------------------------------------------
  // Novedades de entrega
  //
  // Lo IMPLEMENTADO: registrar, listar y resolver novedades.
  // Lo BLOQUEADO: avisar al cliente, que necesita plantillas aprobadas por
  // Meta porque la ventana de 24h ya se cerro cuando llega una novedad.
  // ----------------------------------------------------------------------
  router.get("/novedades", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { repos } = await piezas();
      const pedidos = await repos.pedidos.listar({ limite: 2000 });
      const d = analitica.despachos({ pedidos });
      d.despachados = d.despachados.map((p) => ({
        ...p,
        _dias: analitica.diasDesde(p.despacho && p.despacho.despachadoEn),
      }));
      html(
        res,
        vistas.novedades({
          datos: d,
          tipos: Object.values(dominioPedido.TIPOS_DE_NOVEDAD),
          envioManualActivo: config.panelEnvioManual,
          // Las plantillas que faltan se dicen ARRIBA, antes de que el
          // operador suba nada: es una tarea para una persona -crearlas en
          // Meta- y descubrirla fila por fila al final del flujo es tarde.
          faltanPlantillas: Object.entries(plantillasDeNovedad())
            .filter(([, nombre]) => !nombre)
            .map(([tipo]) => tipo),
        })
      );
    } catch (e) {
      log.error("panel_novedades_fallo", { detalle: e.message });
      res.status(500).send(`No se pudo armar la pantalla de novedades: ${e.message}`);
    }
  });

  router.post("/novedades/registrar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const codigo = String((req.body && req.body.codigo) || "").trim();
    const tipo = String((req.body && req.body.tipo) || "").trim();
    const detalle = String((req.body && req.body.detalle) || "");
    if (!codigo || !tipo) return res.status(400).json({ ok: false, error: "Falta el pedido o el tipo." });

    try {
      const { repos } = await piezas();
      const pedido = await repos.pedidos.obtener(codigo);
      if (!pedido) return res.status(404).json({ ok: false, error: "Ese pedido no existe." });

      const r = dominioPedido.registrarNovedad({ pedido, tipo, detalle });
      if (!r.ok) return res.status(409).json({ ok: false, error: r.motivo });
      if (!r.yaEstaba) await repos.pedidos.reemplazar(r.pedido);

      diario.anotar("panel_novedad", { codigo, tipo, detalle, yaEstaba: r.yaEstaba });

      // REGISTRAR Y AVISAR SON DOS ACCIONES. Esta solo deja constancia de
      // que la novedad existe; el aviso al cliente va por /novedades/avisar,
      // que calcula la ventana de 24 h y elige texto libre o plantilla.
      //
      // Separadas a proposito: una novedad hay que poder anotarla aunque
      // todavia no se pueda avisar -porque falte la plantilla-, y el numero
      // de novedades es lo que dice si la gestion se esta aflojando.
      const plantilla = plantillasDeNovedad()[tipo];
      return res.json({
        ok: true,
        puedeAvisar: Boolean(plantilla),
        aviso: r.yaEstaba
          ? `Ya habia una novedad "${tipo}" abierta en ${codigo}. No se duplico.`
          : `Novedad "${tipo}" registrada en ${codigo}.` +
            (plantilla
              ? " Para avisarle al cliente, usa la pantalla de novedades."
              : ` Para avisar al cliente hace falta la plantilla de "${tipo}" aprobada en Meta: todavia no esta configurada.`),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // AVISARLE AL CLIENTE, EN TRES PASOS
  //
  // 1. /novedades/archivo  convierte el CSV/XLSX de la transportadora en texto.
  // 2. /novedades/revisar  cruza con los pedidos y PROPONE el plan.
  // 3. /novedades/avisar   manda solo las marcadas.
  //
  // El paso 1 es opcional: se puede pegar el texto a mano, y es lo que hace
  // que esto funcione hoy sin saber que formato exportara la transportadora.
  // ----------------------------------------------------------------------

  router.post(
    "/novedades/archivo",
    express.raw({ type: () => true, limit: "10mb" }),
    async (req, res) => {
      if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
      try {
        const nombre = String(req.query.nombre || "");
        const r = hojaDeCalculo.aTexto(req.body, nombre);
        if (!r.ok) return res.status(400).json({ ok: false, error: r.motivo });

        return res.json({
          ok: true,
          formato: r.formato,
          cuantas: r.cuantas,
          texto: r.texto,
          columnas: r.columnas,
          // Si no se reconocieron las columnas se dice, porque la causa
          // suele ser que la transportadora cambio el encabezado. Sin este
          // aviso parece que el archivo no trae novedades.
          aviso: r.columnas
            ? r.columnas.conOficina
              ? null
              : "El archivo no trae columna de oficina: las novedades de oficina van a pedir que la escribas a mano."
            : "No se reconocieron los encabezados, asi que se lee cada linea entera buscando un numero de guia. " +
              "Revisa bien el resultado: puede que la transportadora haya cambiado el formato.",
        });
      } catch (e) {
        log.error("panel_novedades_archivo_fallo", { detalle: e.message });
        return res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  router.post("/novedades/revisar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const texto = String((req.body && req.body.texto) || "");
    const datosAMano = (req.body && req.body.datos) || {};
    if (!texto.trim()) {
      return res.status(400).json({ ok: false, error: "No hay nada que revisar: pega el texto o sube el archivo." });
    }

    try {
      const { repos } = await piezas();
      const todos = await repos.pedidos.listar({ limite: 2000 });
      // Solo lo despachado puede tener una novedad de entrega. Cruzar contra
      // pedidos sin despachar haria coincidir una novedad con un pedido que
      // nunca salio, y avisar a ese cliente de algo que no le paso.
      const pedidos = todos.filter((p) => p.despacho && p.despacho.guia);

      // Las conversaciones de esos clientes, para la ventana de 24 h.
      const conversaciones = new Map();
      for (const p of pedidos) {
        if (conversaciones.has(p.contactoId)) continue;
        const c = await repos.conversaciones.obtener(p.contactoId).catch(() => null);
        if (c) conversaciones.set(p.contactoId, c);
      }

      const avisos = indiceDeAvisos(pedidos);
      const plan = novedadesDeEntrega.revisar({
        texto,
        pedidos,
        conversaciones,
        plantillas: plantillasDeNovedad(),
        yaAvisada: avisos,
        datos: datosAMano,
      });

      // El plan se guarda con el TEXTO y los DATOS, no con los pedidos: al
      // enviar se vuelven a leer de los repositorios, por si algo cambio
      // entre revisar y enviar.
      const id = planesDeNovedades.guardar({ texto, datos: datosAMano });

      diario.anotar("panel_novedades_revisadas", {
        filas: plan.filas.length,
        listas: plan.listas,
        bloqueadas: plan.bloqueadas,
      });

      return res.json({
        ok: true,
        id,
        listas: plan.listas,
        bloqueadas: plan.bloqueadas,
        porConfirmar: plan.porConfirmar,
        plantillasQueFaltan: plan.plantillasQueFaltan,
        filas: plan.filas.map((f, i) => ({
          i,
          guia: f.guia,
          motivo: f.motivo,
          tipo: f.tipo.nombre,
          tipoClave: f.tipo.clave,
          cliente: f.pedido ? (f.pedido.destinatario || {}).nombre || null : null,
          codigo: f.pedido ? f.pedido.id : null,
          comoSeEncontro: f.comoSeEncontro,
          requiereConfirmacion: Boolean(f.requiereConfirmacion),
          ventana: f.ventana ? { abierta: f.ventana.abierta, restante: f.ventana.restante } : null,
          porPlantilla: f.porPlantilla,
          plantilla: f.plantilla,
          // El mensaje exacto que veria el cliente, para poder leerlo ANTES.
          mensaje: f.mensaje || null,
          variables: f.variables,
          oficina: f.oficina,
          plazo: f.plazo,
          pide: f.pide || [],
          enviar: f.enviar,
          bloqueada: f.bloqueada,
        })),
      });
    } catch (e) {
      log.error("panel_novedades_revisar_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post("/novedades/avisar", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const id = String((req.body && req.body.id) || "");
    const indices = Array.isArray(req.body && req.body.indices) ? req.body.indices.map(Number) : [];
    const datosAMano = (req.body && req.body.datos) || {};
    if (!id) return res.status(400).json({ ok: false, error: "Falta el plan." });
    if (!indices.length) return res.status(400).json({ ok: false, error: "No marcaste ninguna novedad." });

    const plan = planesDeNovedades.obtener(id);
    if (!plan.ok) return res.status(410).json({ ok: false, error: plan.explicacion, motivo: plan.motivo });

    try {
      const { repos, emisor } = await piezas();
      const todos = await repos.pedidos.listar({ limite: 2000 });
      const pedidos = todos.filter((p) => p.despacho && p.despacho.guia);

      const conversaciones = new Map();
      for (const p of pedidos) {
        if (conversaciones.has(p.contactoId)) continue;
        const c = await repos.conversaciones.obtener(p.contactoId).catch(() => null);
        if (c) conversaciones.set(p.contactoId, c);
      }

      // ------------------------------------------------------------------
      // SE RECALCULA, NO SE CONFIA EN LO QUE MANDE EL NAVEGADOR
      //
      // Entre revisar y enviar pueden haber pasado minutos: una ventana de
      // 24 h pudo cerrarse, y entonces el texto libre que se iba a mandar ya
      // no lo entrega Meta. Recalcular lo convierte en plantilla solo.
      //
      // Los datos escritos a mano se UNEN con los del plan, no lo
      // reemplazan. Es un fallo real de BIKERPRO del 30-sep: la pantalla
      // deja de dibujar los campos de las filas ya resueltas, asi que esos
      // datos no viajaban en el segundo envio y las filas volvian a
      // bloquearse pidiendo lo que ya se habia escrito.
      // ------------------------------------------------------------------
      const datosUnidos = { ...(plan.contenido.datos || {}) };
      for (const [guia, v] of Object.entries(datosAMano)) {
        datosUnidos[guia] = { ...(datosUnidos[guia] || {}), ...(v || {}) };
      }
      plan.contenido.datos = datosUnidos;

      const recalculado = novedadesDeEntrega.revisar({
        texto: plan.contenido.texto,
        pedidos,
        conversaciones,
        plantillas: plantillasDeNovedad(),
        yaAvisada: indiceDeAvisos(pedidos),
        datos: datosUnidos,
      });

      const resultados = [];

      for (const i of indices) {
        const fila = recalculado.filas[i];
        if (!fila || !fila.enviar || !fila.pedido) {
          resultados.push({
            i,
            guia: fila ? fila.guia : null,
            enviado: false,
            porQue: (fila && fila.bloqueada) || "esta novedad no esta lista para avisar",
          });
          continue;
        }

        // La novedad se REGISTRA en el pedido antes de avisar. Asi, si el
        // envio falla, la novedad sigue existiendo y se puede reintentar;
        // registrarla despues del envio la perderia justo cuando hace falta.
        let pedido = fila.pedido;
        const reg = dominioPedido.registrarNovedad({
          pedido,
          tipo: fila.tipo.clave,
          detalle: fila.motivo,
        });
        if (!reg.ok) {
          resultados.push({ i, guia: fila.guia, enviado: false, porQue: reg.motivo });
          continue;
        }
        if (!reg.yaEstaba) {
          await repos.pedidos.reemplazar(reg.pedido);
          pedido = reg.pedido;
        }
        const novedad =
          reg.novedad || dominioPedido.novedadesAbiertas(pedido).find((n) => n.tipo === fila.tipo.clave);

        const destino = guias.destinoDe(pedido);
        const envio = fila.porPlantilla
          ? await emisor.enviarPlantilla({
              para: destino,
              plantilla: fila.plantilla,
              variables: fila.variables,
              permiso: PERMISOS.ATENCION_MANUAL,
              conversacionId: pedido.contactoId,
            })
          : await emisor.enviarTexto({
              para: destino,
              texto: fila.mensaje,
              permiso: PERMISOS.ATENCION_MANUAL,
              conversacionId: pedido.contactoId,
            });

        if (novedad) {
          const anot = dominioPedido.registrarAvisoDeNovedad({
            pedido,
            id: novedad.id,
            resultado: envio,
          });
          if (anot.ok && !anot.yaEstaba) await repos.pedidos.reemplazar(anot.pedido);
        }

        const conv = conversaciones.get(pedido.contactoId);
        if (envio.enviado && conv) {
          atencion.anotarMensaje(conv, {
            de: atencion.QUIEN.BOT,
            texto: fila.porPlantilla
              ? `[novedad "${fila.tipo.nombre}" avisada por plantilla aprobada]`
              : fila.mensaje,
            por: "operador",
            estado: "enviado",
          });
          await repos.conversaciones.guardar(conv).catch(() => null);
        }

        diario.anotar("panel_novedad_avisada", {
          codigo: pedido.id,
          guia: fila.guia,
          tipo: fila.tipo.clave,
          enviado: envio.enviado,
          porPlantilla: Boolean(envio.porPlantilla),
          motivo: envio.motivo || null,
        });
        metricas.incrementar(envio.enviado ? "panel_novedad_avisada" : "panel_novedad_no_avisada");

        resultados.push({
          i,
          guia: fila.guia,
          cliente: (pedido.destinatario || {}).nombre || null,
          enviado: Boolean(envio.enviado),
          porPlantilla: Boolean(envio.porPlantilla),
          porQue: envio.enviado
            ? null
            : EXPLICACION[envio.motivo] ||
              ventana.explicarCodigo(envio.codigoMeta) ||
              envio.detalle ||
              explicarFalloDeMeta({ codigo: envio.codigoMeta, estado: envio.estado }),
        });
      }

      const enviadas = resultados.filter((r) => r.enviado).length;
      const fallaron = resultados.length - enviadas;

      return res.json({
        ok: true,
        intentadas: resultados.length,
        enviadas,
        fallaron,
        resultados,
        aviso: fallaron
          ? `Se avisó a ${enviadas} de ${resultados.length}. Las que fallaron se pueden reintentar: el plan sigue vivo.`
          : `Se avisó a ${enviadas}.`,
      });
    } catch (e) {
      log.error("panel_novedades_avisar_fallo", { detalle: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  router.post("/novedades/resolver", async (req, res) => {
    if (!auth.exigirSesion(req, res, config, { comoJson: true })) return;
    const codigo = String((req.body && req.body.codigo) || "").trim();
    const id = String((req.body && req.body.id) || "").trim();
    const comoSeResolvio = String((req.body && req.body.comoSeResolvio) || "");
    if (!codigo || !id) return res.status(400).json({ ok: false, error: "Falta el pedido o la novedad." });

    try {
      const { repos } = await piezas();
      const pedido = await repos.pedidos.obtener(codigo);
      if (!pedido) return res.status(404).json({ ok: false, error: "Ese pedido no existe." });

      const r = dominioPedido.resolverNovedad({ pedido, id, comoSeResolvio });
      if (!r.ok) return res.status(409).json({ ok: false, error: r.motivo });
      if (!r.yaEstaba) await repos.pedidos.reemplazar(r.pedido);

      diario.anotar("panel_novedad_resuelta", { codigo, id, comoSeResolvio });
      return res.json({ ok: true, aviso: r.yaEstaba ? "Ya estaba resuelta." : "Novedad resuelta." });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // Auditoria: dias, embudo y atribucion
  //
  // El CALCULO esta implementado y probado con datos ficticios. Lo que
  // falta de fuera es el dato -campanas que generen `referral`-, no la
  // regla. La pantalla lo dice cuando todo sale como "directo".
  // ----------------------------------------------------------------------
  router.get("/auditoria", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { repos } = await piezas();
      const dias = Math.min(90, Math.max(1, Number(req.query.dias) || 14));
      const [serie, pedidos, conversaciones] = await Promise.all([
        datos.serie(repos, { dias }),
        repos.pedidos.listar({ limite: 5000 }),
        repos.conversaciones.listar({ limite: 2000 }),
      ]);
      html(
        res,
        vistas.auditoria({
          serie,
          dias,
          embudo: analitica.embudo({ conversaciones, pedidos }),
          atribucion: analitica.atribucion({ conversaciones, pedidos }),
        })
      );
    } catch (e) {
      log.error("panel_auditoria_fallo", { detalle: e.message });
      res.status(500).send(`No se pudo armar la auditoria: ${e.message}`);
    }
  });

  return router;
}

module.exports = { crearRutasDelPanel, esRepetido, EXPLICACION, explicarFalloDeMeta };
