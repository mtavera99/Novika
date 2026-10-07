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

const { PERMISOS, MOTIVOS_BLOQUEO } = require("../whatsapp/enviar");

/**
 * Motivos de bloqueo en lenguaje del dueno.
 *
 * El panel nunca muestra el codigo interno: "envio_manual_apagado" no le
 * dice a nadie que hay que cambiar una variable en Render.
 */
const EXPLICACION = {
  [MOTIVOS_BLOQUEO.ENVIO_MANUAL_APAGADO]:
    "Los envios manuales estan apagados (PANEL_ENVIO_MANUAL=0). El mensaje quedo registrado en la conversacion pero NO salio.",
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
      html(res, vistas.chat({ ficha, envioManualActivo: config.panelEnvioManual }));
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

      const telefono = (conv.ficha && conv.ficha.telefono) || id;
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
  // Pantallas que NO estan operativas. Se dicen, no se disimulan.
  // ----------------------------------------------------------------------
  router.get("/guias", (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    html(
      res,
      vistas.bloqueada({
        titulo: "Guias y despachos",
        queFalta:
          "Decidir la transportadora de NOVIKA y tener <b>un PDF real de guias</b> contra el que ajustar el lector.",
        porQue:
          "El flujo de BIKERPRO parte un PDF de 99 Envios y reparte una guia por cliente. No hay API ni credenciales: " +
          "se sube el PDF a mano. Pero el lector esta ajustado al formato exacto de ese PDF, y portarlo sin un " +
          "ejemplo real seria escribir codigo que no se puede verificar. Una guia asignada al cliente equivocado " +
          "manda el paquete a otra persona.",
        comoSeDesbloquea:
          "<ol><li>Elegir transportadora.</li><li>Pasarme un PDF de guias de verdad (puede ser de una sola).</li>" +
          "<li>Se ajusta el lector contra ese formato y se prueba con el.</li></ol>",
      })
    );
  });

  router.get("/novedades", (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    html(
      res,
      vistas.bloqueada({
        titulo: "Novedades de entrega",
        queFalta: "Tres plantillas <b>aprobadas por Meta</b> para NOVIKA.",
        porQue:
          "Una novedad se avisa dias despues del pedido, cuando la ventana de 24 horas ya se cerro. Fuera de esa " +
          "ventana Meta solo entrega plantillas aprobadas: con texto libre acepta el mensaje y no lo entrega, " +
          "asi que el cliente nunca se enteraria y nosotros creeriamos que si.",
        comoSeDesbloquea:
          "<p>Crear en Meta Business Manager y esperar aprobacion:</p><ul>" +
          "<li><code>PLANTILLA_NOVEDAD_AUSENTE</code></li>" +
          "<li><code>PLANTILLA_NOVEDAD_DIRECCION</code></li>" +
          "<li><code>PLANTILLA_NOVEDAD_OFICINA</code></li></ul>" +
          "<p>Despues se configuran como variables de entorno en el servicio.</p>",
      })
    );
  });

  router.get("/auditoria", async (req, res) => {
    if (!auth.exigirSesion(req, res, config)) return;
    try {
      const { repos } = await piezas();
      const serie = await datos.serie(repos, { dias: 14 });
      const hayDatos = serie.some((d) => d.pedidos > 0);
      if (!hayDatos) {
        return html(
          res,
          vistas.bloqueada({
            titulo: "Auditoria, embudo y atribucion",
            queFalta: "Datos reales: pedidos y, para la atribucion, campanas con <code>referral</code>.",
            porQue:
              "El embudo y la atribucion cruzan el origen del anuncio con los pedidos. NOVIKA todavia no tiene " +
              "productos activos ni pedidos, asi que cualquier numero aqui seria inventado. " +
              "Un dato comercial inventado que se cuela es una decision tomada sobre algo falso.",
            comoSeDesbloquea:
              "<p>Esta pantalla se enciende sola en cuanto haya pedidos. La atribucion necesita ademas anuncios " +
              "de Click-to-WhatsApp activos, que es de donde Meta manda el <code>referral</code>.</p>",
          })
        );
      }
      const filas = serie
        .map(
          (d) => `<tr>
  <td data-label="Dia">${vistas.esc(d.dia)}</td>
  <td data-label="Pedidos">${d.pedidos}</td>
  <td data-label="Unidades">${d.unidades}</td>
  <td data-label="Importe">${vistas.esc(vistas.pesos(d.importe))}</td>
  <td data-label="Cancelados">${d.cancelados}</td>
</tr>`
        )
        .join("");
      html(
        res,
        `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NOVIKA · auditoria</title><style>${vistas.ESTILO}</style></head><body><div class="envoltorio">
<header><h1>NOVIKA</h1><span class="zona">Ultimos 14 dias · hora de Colombia</span>
<div class="derecha"><a class="boton" href="/panel">Tablero</a></div></header>
<table><thead><tr><th>Dia</th><th>Pedidos</th><th>Unidades</th><th>Importe</th><th>Cancelados</th></tr></thead>
<tbody>${filas}</tbody></table></div></body></html>`
      );
    } catch (e) {
      res.status(500).send(`No se pudo armar la auditoria: ${e.message}`);
    }
  });

  return router;
}

module.exports = { crearRutasDelPanel, esRepetido, EXPLICACION, explicarFalloDeMeta };
