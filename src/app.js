"use strict";

// ==========================================================================
// APLICACION HTTP
//
// Fabrica de la app de Express, separada de server.js a proposito: las
// pruebas crean la app y la levantan en un puerto efimero sin arrancar el
// servicio real ni tocar el entorno de produccion.
//
// Aqui solo hay cableado: middlewares, rutas y el manejador de errores.
// Nada de logica de negocio. En BIKERPRO este archivo tiene 3.077 lineas y
// mezcla rutas, parseo del webhook, HTML del panel y avisos al dueno; un
// cambio en cualquiera de esas cosas obliga a leer las otras tres.
// ==========================================================================

const express = require("express");
const { config } = require("./config");
const log = require("./log");
const diario = require("./almacen/diario");
const trabajo = require("./almacen/trabajo");
const persistencia = require("./almacen/persistencia");
const metricas = require("./metricas");
const congelacion = require("./almacen/congelar");
const { capturarCuerpoCrudo } = require("./webhook/firma");
const webhook = require("./webhook/rutas");
const { crearRutasDelPanel } = require("./panel/rutas");

const ARRANCADO_EN = Date.now();
const MARCADOR = persistencia.registrarArranque(config.dirDatos);

/** Puerta unica para las rutas de diagnostico. */
function exigePanelToken(req, res, siguiente) {
  const recibido = req.query.token || req.get("x-panel-token") || "";
  if (!config.panelToken || recibido !== config.panelToken) {
    return res.status(403).json({ ok: false, error: "token invalido" });
  }
  return siguiente();
}

function crearApp() {
  const app = express();

  app.disable("x-powered-by");

  // El `verify` captura los bytes originales. Sin esto no se puede
  // comprobar la firma de Meta, porque el HMAC va sobre el cuerpo crudo y no
  // sobre el objeto reserializado.
  app.use(
    express.json({
      verify: capturarCuerpoCrudo,
      // Meta agrupa hasta 1.000 actualizaciones en un solo POST (lo dice su
      // documentacion de webhooks). Un lote grande de acuses de entrega
      // supera 1 MB con facilidad, y rechazarlo seria perder el lote entero.
      limit: "5mb",
    })
  );

  // ------------------------------------------------------------------------
  // Salud
  //
  // Publico y escueto: sirve para que el hosting sepa si el proceso vive, y
  // para responder desde fuera "¿que codigo esta corriendo?" sin adivinar.
  // El detalle con datos operativos va detras del token.
  // ------------------------------------------------------------------------
  app.get("/", (_req, res) => {
    res.type("text/plain").send("NOVIKA · bot de WhatsApp · vivo");
  });

  app.get("/health", (req, res) => {
    const base = {
      ok: true,
      marca: config.marca,
      commit: config.commit ? config.commit.slice(0, 7) : null,
      rama: config.rama || null,
      arrancado_hace_seg: Math.round((Date.now() - ARRANCADO_EN) / 1000),

      // Estas banderas contestan casi cualquier "no funciona":
      firma_activa: config.firmaActiva, // false -> entran eventos pero no se procesan
      puede_enviar: config.puedeEnviar, // false -> no hay token o no hay id de numero
      respuesta_automatica: config.respuestaAutomatica, // false -> el BOT nunca escribe
      // --------------------------------------------------------------------
      // El interruptor del panel, publicado SIN token y junto a los otros.
      //
      // Faltaba, y la consecuencia fue concreta: el panel decia "no se pudo
      // enviar: envio_manual_apagado" y desde fuera no habia forma de
      // distinguir "el interruptor esta apagado, es lo esperado" de "hay un
      // defecto". Un interruptor que decide si le escribimos a un cliente y
      // que no se puede consultar obliga a adivinar.
      //
      // Es el mismo criterio que `escrituras_congeladas`: lo que apaga una
      // parte del servicio tiene que verse sin credenciales.
      //
      // OJO con leerlo en una conversacion vieja: cada mensaje guarda el
      // resultado REAL del intento en su momento, asi que un mensaje que se
      // intento con el interruptor apagado seguira diciendo "no enviado"
      // para siempre. Eso es correcto -no salio- y no cambia al encenderlo.
      // --------------------------------------------------------------------
      panel_envio_manual: config.panelEnvioManual, // false -> el PANEL no envia
      filtro_de_numero: config.idNumero ? "activo" : "inactivo",

      // Comprobado, no deducido de la variable de entorno. Si dice "efimera",
      // el diario y la memoria de duplicados se borran en cada despliegue.
      persistencia: config.persistencia.modo,
      almacenamiento_durable: config.persistencia.esDurable,

      // Fase 2
      modo_sombra: config.modoSombra,
      // Un congelado olvidado es un bot que acumula mensajes sin atender.
      // Por eso se publica sin token: tiene que verse.
      escrituras_congeladas: congelacion.estado(config.dirDatos).congelado,
      ia_configurada: Boolean(config.iaApiKey),
      almacen_transaccional: config.databaseUrl ? "postgres" : "archivos",
    };

    const conToken = config.panelToken && (req.query.token || req.get("x-panel-token")) === config.panelToken;
    if (!conToken) return res.json(base);

    return res.json({
      ...base,
      dir_datos: config.dirDatos,
      persistencia_motivo: config.persistencia.motivo,
      // La prueba empirica: si `arranques` sigue en 1 despues de varios
      // despliegues, la carpeta se esta borrando, diga lo que diga la
      // configuracion.
      marcador_de_disco: MARCADOR,
      trabajo: trabajo.estado(),
      congelacion: congelacion.estado(config.dirDatos),
      zona_horaria: config.zonaHoraria,
      version_graph: config.versionGraph,
      diario_de_hoy: diario.resumenDeHoy(),
      salud: metricas.salud(),
    });
  });

  // ------------------------------------------------------------------------
  // Diario
  //
  // La pregunta que esto responde no es "¿cuantos mensajes hay?" sino
  // "¿llego el evento y fallamos, o Meta no llego nunca?". Son dos problemas
  // distintos con arreglos distintos, y sin esta ruta se confunden.
  // ------------------------------------------------------------------------
  // ------------------------------------------------------------------------
  // Panel operativo
  //
  // Va en su propio router, con su propio parseo de cuerpo (formularios) y
  // su propia sesion. Se monta aqui y no antes del parseo del webhook para
  // que nada del panel pueda tocar como se lee el cuerpo crudo de Meta: esa
  // captura es lo que sostiene la comprobacion de la firma.
  //
  // Carga diferida del cerebro: `require` aqui arriba crearia un ciclo, y
  // construir el cerebro al montar la app obligaria a tener catalogo y
  // almacen listos para servir /health.
  // ------------------------------------------------------------------------
  app.use("/panel", crearRutasDelPanel({ obtenerCerebro: () => require("./cerebro").obtenerCerebro() }));

  app.get("/eventos", exigePanelToken, (req, res) => {
    const cuantas = Math.min(Math.max(Number.parseInt(req.query.n, 10) || 50, 1), 500);
    const entradas = diario.ultimas(cuantas);
    res.json({
      ok: true,
      total: entradas.length,
      nota: entradas.length
        ? undefined
        : "El diario esta vacio. Si Meta deberia estar entregando, el problema esta en la configuracion del webhook en Meta, no en el bot.",
      entradas,
    });
  });

  // ------------------------------------------------------------------------
  // Metricas
  //
  // Solo numeros: ni un telefono, ni un texto, ni un documento. Por eso la
  // vista completa se puede exponer sin filtrar nada.
  //
  // La linea que hay que mirar: con RESPUESTA_AUTOMATICA en 0,
  // respuestas_preparadas puede subir y respuestas_enviadas tiene que
  // quedarse en cero.
  // ------------------------------------------------------------------------
  app.get("/metricas", exigePanelToken, (_req, res) => {
    res.json({ ok: true, ...metricas.instantanea(), salud: metricas.salud() });
  });

  webhook.montar(app);

  // ------------------------------------------------------------------------
  // 404
  // ------------------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: `no existe ${req.method} ${req.path}` });
  });

  // ------------------------------------------------------------------------
  // Errores
  //
  // Cuatro argumentos y registrado al final: asi es como Express reconoce un
  // manejador de errores. Traduce los fallos tipicos del parseo a algo que
  // se pueda leer sin abrir el codigo, y nunca deja la peticion colgada.
  // ------------------------------------------------------------------------
  app.use((err, req, res, _siguiente) => {
    const porTipo = {
      "entity.too.large": "El cuerpo de la peticion supera el limite de 5 MB.",
      "entity.parse.failed": "El cuerpo no es JSON valido.",
      "request.aborted": "El cliente corto la conexion antes de terminar de enviar.",
      "request.size.invalid": "El tamaño declarado no coincide con lo recibido.",
    };
    const mensaje = porTipo[err.type] || "Error interno.";

    log.error("error_http", {
      ruta: `${req.method} ${req.path}`,
      tipo: err.type || null,
      detalle: err.message,
    });
    diario.anotar("error_http", { ruta: `${req.method} ${req.path}`, tipoError: err.type || null, error: err.message });

    if (res.headersSent) return;

    // Al webhook se le contesta 200 aunque el cuerpo viniera mal: un 4xx
    // repetido hace que Meta desactive la suscripcion, y entonces se dejan
    // de recibir TODOS los mensajes, no solo el que venia roto.
    if (req.path === "/webhook" && req.method === "POST") {
      return res.sendStatus(200);
    }

    res.status(400).json({ ok: false, error: mensaje });
  });

  return app;
}

module.exports = { crearApp };
