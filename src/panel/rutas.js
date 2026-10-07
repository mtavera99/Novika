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
const fotos = require("../whatsapp/fotos");
const dominioPedido = require("../dominio/pedido");

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
      html(res, vistas.guias({ datos: d, transportadoras: TRANSPORTADORAS }));
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

      // El aviso al cliente NO se intenta: necesita plantilla aprobada, y
      // fuera de la ventana de 24h Meta acepta el texto libre y no lo
      // entrega. Fingir el intento seria creer que el cliente se entero.
      return res.json({
        ok: true,
        aviso: r.yaEstaba
          ? `Ya habia una novedad "${tipo}" abierta en ${codigo}. No se duplico.`
          : `Novedad "${tipo}" registrada en ${codigo}. El aviso al cliente necesita plantilla aprobada de Meta: todavia no se envia.`,
      });
    } catch (e) {
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
