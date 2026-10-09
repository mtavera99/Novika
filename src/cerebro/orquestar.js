"use strict";

// ==========================================================================
// EL CEREBRO
//
// Coordina el camino completo de un mensaje:
//
//   mensaje -> contexto -> producto -> intencion -> respuesta
//           -> cotizacion -> captura -> confirmacion -> pedido
//
// Este modulo COORDINA. No decide hechos. Cada hecho lo decide el modulo de
// dominio que le corresponde, y aqui solo se encadenan:
//
//   que producto es .......... catalogo/senales.js
//   si confirmo o no ......... dominio/confirmacion.js
//   cuanto vale .............. dominio/cotizador.js
//   si un dato es valido ..... dominio/destino.js  +  dominio/campos.js
//   si puede haber pedido .... dominio/pedido.js
//   si el estado permite X ... dominio/estados.js
//
// TRES REGLAS DE ORDEN, Y LAS TRES SON DELIBERADAS:
//
//   1. LA CONFIRMACION SE EVALUA ANTES DE LLAMAR A LA IA.
//      Asi el modelo no puede influir en si hay pedido. Aunque devolviera
//      intencion "confirma", la decision ya esta tomada por codigo.
//
//   2. TODO EL TURNO VA DENTRO DE UNA COLA POR CONTACTO.
//      Leer, decidir y guardar tiene que ser indivisible para un mismo
//      cliente. Sin eso, dos mensajes seguidos del mismo numero crean dos
//      pedidos: cada uno comprueba "no hay pedido" antes de que el otro
//      acabe de escribir.
//
//   3. LA RESPUESTA SE PREPARA SIEMPRE, SE ENVIA SOLO SI EL INTERRUPTOR LO
//      PERMITE. Es el modo sombra: se procesa la conversacion real, se
//      genera lo que se habria dicho, se valida contra los hechos, se
//      registra, y no sale. Permite auditar con trafico real antes de
//      soltar el bot.
// ==========================================================================

const estados = require("../dominio/estados");
const confirmacion = require("../dominio/confirmacion");
const cotizador = require("../dominio/cotizador");
const campos = require("../dominio/campos");
const destino = require("../dominio/destino");
const pedidos = require("../dominio/pedido");
const texto = require("../dominio/texto");
const preguntas = require("../dominio/preguntas");
const extraer = require("../dominio/extraer");
const senales = require("../catalogo/senales");
const responder = require("./responder");
// Solo para `prometeConfirmar`: el cerebro necesita saber si el texto que va
// a enviar prometio que una persona confirma algo, para dejar la tarea.
const contestar = require("./contestar");
const { enSerie } = require("../almacen/mutex");
const { PERMISOS } = require("../whatsapp/enviar");
const atencionDeChat = require("../almacen/atencion");
const fotos = require("../whatsapp/fotos");

/** Datos del destinatario que se piden siempre. */
const REQUERIDOS_BASE = ["nombre", "telefono", "ciudad", "direccion"];

// ==========================================================================
// EL GUION DEL MODELO
//
// Lo que el modelo hace en NOVIKA es MAS PEQUEÑO de lo que suele hacer un bot
// de ventas, y a proposito: no decide el precio, no decide si hay pedido y no
// decide las condiciones. Eso lo resuelve el dominio y esta probado. El modelo
// aporta la redaccion.
//
// Por eso este guion no trae tablas de precios ni politicas: trae TONO y
// ORDEN. Las condiciones comerciales no se escriben aqui, se leen del
// catalogo. Un guion con precios dentro es un precio que se desactualiza en
// silencio.
//
// Las reglas de abajo son mecanica conversacional adaptada de la referencia de
// BIKERPRO, que las aprendio midiendo miles de conversaciones reales. Lo que
// se adapta es COMO se conversa; ninguna condicion comercial suya aplica aqui.
//
// Y ninguna de estas lineas es un candado: todas estan respaldadas por codigo
// -el filtro de importes, el de claims, y el texto determinista que se usa si
// el borrador no pasa-. Una instruccion al modelo no es un candado.
// ==========================================================================
const SISTEMA_BASE = [
  "Eres quien atiende el WhatsApp de NOVIKA, una tienda colombiana.",
  "Tu trabajo es entender al cliente y REDACTAR. NO decides precios, totales, envios ni confirmaciones: esos los calcula el sistema.",
  "",
  "TONO",
  "- Colombiano, cercano y natural. Tutea.",
  "- Mensajes CORTOS: dos o tres frases, como un chat de verdad. Nunca parrafos ni listas con viñetas.",
  "- Emojis: ninguno o uno. Nunca mas de uno.",
  "- NO repitas el saludo. Si ya se saludo en esta conversacion, sigue desde donde quedo.",
  "- NO vuelvas a preguntar algo que el cliente ya te dijo. Lee la conversacion antes.",
  "",
  "ORDEN DE CADA RESPUESTA",
  "1. Responde PRIMERO lo que el cliente pregunto.",
  "2. Solo despues, si procede, propon el siguiente paso.",
  "Contestarle con una pedida de datos a quien pregunto otra cosa es la forma mas rapida de perder la venta.",
  "",
  "PREGUNTAR NO ES COMPRAR",
  "- Si el cliente esta averiguando (garantia, medidas, material, como funciona), responde su duda y NADA MAS. No le pidas nombre, ciudad ni direccion.",
  "- Pide los datos de entrega solo cuando diga que lo quiere.",
  "- NO termines todas tus respuestas con una pregunta comercial. A veces lo correcto es responder y callarse.",
  "",
  "LO QUE NO PUEDES ESCRIBIR",
  "- NUNCA precios, totales, importes ni cifras de dinero. Ni aproximados, ni rangos. Los pone el sistema.",
  "- NUNCA caracteristicas, garantias, plazos de entrega ni medidas que no aparezcan en los datos autorizados de este mensaje.",
  "- Si no tienes el dato autorizado, dilo: que queda anotado para el equipo y le responden por aqui. NUNCA prometas un plazo ('en un momento', 'enseguida'): no hay nadie de guardia. Decir que no lo sabes es mejor que una respuesta amable con un dato inventado.",
    "- NUNCA prometas despacho, y menos hoy: no tienes horario, disponibilidad ni capacidad de despacho. Di 'preparar tu pedido'. Confirmar un pedido no significa que ya salio.",
  "",
  "Responde SIEMPRE en JSON con esta forma:",
  '{"intencion":"...","candidatos":{},"productoSugerido":null,"borradorRespuesta":null,"preguntasDelCliente":[]}',
].join("\n");

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.repos
 * @param {object} deps.catalogo
 * @param {object} [deps.ia]        cliente de IA (puede faltar)
 * @param {object} [deps.emisor]
 * @param {object} [deps.log]
 * @param {object} [deps.metricas]
 * @param {object} [deps.diario]
 */
function crearCerebro({ config, repos, catalogo, ia = null, emisor = null, log = null, metricas = null, diario = null }) {
  function contar(n) {
    if (metricas && typeof metricas.incrementar === "function") metricas.incrementar(n);
  }
  function registrar(nivel, evento, datos) {
    if (log && typeof log[nivel] === "function") log[nivel](evento, datos);
  }
  function anotar(tipo, datos) {
    if (diario && typeof diario.anotar === "function") diario.anotar(tipo, datos);
  }

  // ----------------------------------------------------------------------
  // Contexto
  // ----------------------------------------------------------------------
  function conversacionNueva(contactoId) {
    return {
      contactoId,
      estado: estados.ESTADOS.NUEVO,
      productoId: null, // DESCONOCIDO. No hay producto por defecto.
      ofertaId: null,
      cotizacion: null,
      resumenMostrado: false,
      // Si ya se le dijo el precio de una unidad. Evita repetir la misma
      // frase en cada turno. Sin columna propia: viaja en `extra`.
      precioInformado: false,
      // La cantidad que se le informo en el ultimo precio, para entender un
      // "las quiero" sin volver a preguntar. Sin columna propia: viaja en
      // `extra`.
      cantidadInformada: null,
      // ¿El ultimo mensaje enviado le hizo una pregunta de cierre? Es lo
      // que permite entender un "si" pelado en el turno siguiente.
      cierrePropuesto: false,
      // Lo que ya se le dijo, para no repetirlo. Sin columna propia: viajan
      // en `extra`, igual que precioInformado.
      saludado: false,
      datosPedidos: false,
      pasoPropuesto: false,
      ficha: campos.fichaVacia(),
      ventana: [], // ultimos mensajes, para resolver producto si se rota
      creadoEn: new Date().toISOString(),
    };
  }

  async function cargarContexto(evento) {
    const id = evento.idCliente;

    let contacto = await repos.contactos.obtener(id);
    if (!contacto) {
      contacto = {
        id,
        telefono: evento.telefono || null,
        bsuid: evento.bsuid || null,
        nombrePerfil: evento.nombre || null,
        creadoEn: new Date().toISOString(),
      };
      await repos.contactos.guardar(contacto);
    }

    let conversacion = await repos.conversaciones.obtener(id);
    if (!conversacion) conversacion = conversacionNueva(id);
    // Una ficha que viene del disco de una version anterior puede no tener
    // todos los campos. Se completa en vez de fallar.
    conversacion.ficha = { ...campos.fichaVacia(), ...(conversacion.ficha || {}) };

    return { contacto, conversacion };
  }

  // ----------------------------------------------------------------------
  // Candidatos: la IA y las heuristicas PROPONEN
  // ----------------------------------------------------------------------

  /**
   * Heuristicas que no necesitan modelo. Son las mas fiables que hay:
   * el telefono del chat es un hecho, no una inferencia.
   */
  function candidatosHeuristicos(
    evento,
    {
      seLePidioElNombre = false,
      yaHayNombre = false,
      seLePidioLaCiudad = false,
      yaTieneCiudad = false,
      seLePidioLaReferencia = false,
    } = {}
  ) {
    const propuestas = {};
    // Lo que trae WhatsApp de serie, separado de lo que escribio el cliente.
    const perfil = {};

    // El telefono con el que escribe es el mejor candidato que existe: es un
    // hecho del canal, no una inferencia. Ojo: los clientes con nombre de
    // usuario de WhatsApp NO tienen telefono, y en ese caso no se inventa.
    // ⚠️ VA AL CUBO DEL PERFIL, NO AL DEL CLIENTE, y por el mismo motivo
    //    que el nombre: es lo que trae WhatsApp, no lo que dijo nadie.
    //
    // Como CLIENTE producia una CORRECCION FALSA EN CADA TURNO: el evento
    // trae "573116391876" y la ficha guarda "3116391876" ya normalizado, asi
    // que los dos valores "no coinciden" y `aplicarCandidatos` lo leia como
    // "el cliente corrigio su telefono". Inflaba la metrica
    // `dato_corregido_por_el_cliente` en todos los turnos, y al empezar a
    // DECIR los cambios salio a la luz: el resumen anunciaba "ya cambié el
    // teléfono" a quien solo habia corregido su nombre.
    //
    // En el cubo del perfil no cuenta como correccion, y un telefono que el
    // cliente escriba a mano sigue pudiendo pisarlo.
    if (evento.telefono) perfil.telefono = evento.telefono;

    // ------------------------------------------------------------------
    // ⚠️ EL NOMBRE DEL PERFIL ES UN RESPALDO, NO UNA CORRECCION.
    //
    // Esto era `if (evento.nombre) propuestas.nombre = evento.nombre;` sin
    // condicion, y DESTRUIA EL NOMBRE QUE ESCRIBIA EL CLIENTE.
    //
    // El nombre de perfil de WhatsApp viaja en CADA mensaje. Se proponia en
    // cada turno con origen CLIENTE, y `aplicarCandidatos` trata un valor
    // distinto sobre un campo confirmado como "el cliente lo corrigio":
    // reabre el campo y mete el nuevo valor. Resultado, con el chat real de
    // Popayan, cuyo perfil de WhatsApp es un emoji:
    //
    //   cliente · "Alejandro león Garzón / Popayán Cauca / Barrio..."
    //   bot     · (resumen correcto, con el nombre bien)
    //   cliente · "Si"
    //             -> el perfil "🤪" "corrige" a "Alejandro león Garzón"
    //             -> "🤪" no pasa validarNombre, el campo queda VACIO
    //             -> "no se puede crear el pedido, falta: nombre"
    //             -> escalado
    //
    // El cliente dijo que si a un resumen correcto y perdio el pedido y el
    // nombre en el mismo turno. Y el defecto no se veia porque hasta hoy el
    // nombre escrito en el mensaje no se capturaba nunca: no habia nada
    // bueno que pisar.
    //
    // La regla: el perfil solo rellena el hueco. Si ya hay un nombre
    // confirmado -lo escribio el cliente o lo puso una persona- el perfil
    // se calla. Corregir el nombre sigue siendo posible diciendolo ("me
    // llamo X"), que es una correccion de verdad.
    // ------------------------------------------------------------------
    // ⚠️ Y VA APARTE DEL RESTO, con origen PERFIL. Ver `campos.ORIGENES`:
    //    el 09-oct, un nombre de perfil confirmado dejo a una clienta sin
    //    poder corregir el suyo en cuatro intentos, y la venta se cayo.
    if (evento.nombre && !yaHayNombre) perfil.nombre = evento.nombre;

    // Cantidad, ciudad y direccion salen del texto con reglas, no con
    // modelo. Ver dominio/extraer.js: ante la duda, no propone.
    // `seLoPidieron` abre la captura del nombre A SECAS. Solo cuando el bot
    // acaba de pedirlo: sin esa condicion, "Buenos Aires" o
    // "Interapidisimo" se leerian como nombres de persona.
    const { candidatos } = extraer.deTexto(evento.texto || "", {
      seLoPidieron: seLePidioElNombre,
      seLaPidieronCiudad: seLePidioLaCiudad,
      // Para que una direccion no cambie la ciudad ya dada. Ver el bloque de
      // `ciudadEn`: "Barrio pueblillo en la cantera la pintada" movia el
      // pedido de Popayán a La Pintada (Antioquia).
      yaHayCiudad: yaTieneCiudad,
    });

    // ------------------------------------------------------------------
    // EL PUNTO DE REFERENCIA, CUANDO SE ACABA DE PEDIR
    //
    // ⚠️ SIN ESTO LA PREGUNTA ERA UN ADORNO. El bot ya pedia "¿me das un
    //    punto de referencia?" y la clienta contestaba "al frente de la
    //    droguería Cristal"... y esa frase no se guardaba en ningun sitio:
    //    el resumen seguia diciendo "Dirección: barrio centenario" y el
    //    pedido seguia sin poder despacharse.
    //
    // Una referencia no tiene forma reconocible -puede ser cualquier cosa:
    // una tienda, un color, "la casa de la esquina"-, asi que no se puede
    // extraer por patron. Se toma el mensaje tal cual, y SOLO cuando el bot
    // acaba de pedirla, igual que el nombre a secas.
    //
    // No se toma si el mensaje trae otro dato reconocible: quien contesta
    // "mejor Calle 10 # 5-20" esta corrigiendo la direccion, no dando una
    // referencia. Ni si es un "si" o un "gracias".
    // ------------------------------------------------------------------
    if (seLePidioLaReferencia) {
      const crudo = String(evento.texto || "").trim();
      const plano = texto.aplanar(crudo);
      const otroDato = candidatos.direccion || candidatos.ciudad || candidatos.telefono || candidatos.nombre;
      const esRelleno = /^(s+i+|sip|no+|ok|listo|gracias|ya|nada|ninguno|ninguna)\b/.test(plano);
      if (!otroDato && !esRelleno && plano.length >= 4) candidatos.referencia = crudo;
    }

    return { delCliente: { ...propuestas, ...candidatos }, delPerfil: perfil };
  }

  // ------------------------------------------------------------------
  // EL CLIENTE PUEDE CORREGIR SUS PROPIOS DATOS
  //
  // EL DEFECTO, Y ES EL MAS CARO DE TODOS LOS ENCONTRADOS: corregir la
  // direccion no hacia NADA.
  //
  //   clienta: "soy Ana, Cali, Carrera 7 # 12-34"
  //   bot:     (cuadro de confirmacion)
  //   clienta: "espera, la dirección es Carrera 9 # 45-67"
  //   bot:     "Perdón, no quiero repetirme. Dime concretamente qué necesitas"
  //   clienta: "sí"
  //   bot:     pedido creado... A LA CARRERA 7
  //
  // El paquete sale a la direccion vieja. Eso es el producto, el flete y la
  // clienta, los tres perdidos, y nadie se enteraba hasta la devolucion.
  //
  // LA CAUSA: `campos.proponer` no pisa un dato confirmado, y el comentario
  // que lo explica dice por que —"no por una propuesta silenciosa DEL
  // MODELO"— y manda usar `reabrir()`. Pero `reabrir()` solo se llamaba
  // desde el panel y por cambio de producto. Desde la conversacion, jamas.
  // El candado estaba bien pensado y le faltaba la puerta.
  //
  // LA REGLA: el candado se mantiene para la IA y se abre para el CLIENTE.
  // Nadie sabe mejor que ella cual es su direccion, y lo que el guardia
  // protege es que el modelo invente, no que la dueña del dato lo corrija.
  //
  // Y NO queda sin red: el cuadro de confirmacion ahora muestra el destino
  // y hace falta un "sí" explicito, asi que un cambio mal entendido se ve
  // ANTES de despachar. Ignorarlo en silencio no se veia nunca.
  // ------------------------------------------------------------------
  function aplicarCandidatos(ficha, propuestas, origen, registroDeCambios = null) {
    let actualizada = { ...ficha };
    for (const [campo, valor] of Object.entries(propuestas || {})) {
      if (!campos.CAMPOS.includes(campo)) continue;
      let antes = actualizada[campo];

      const confirmado = campos.valorConfirmado(antes);
      // Pisar el relleno del PERFIL no es una correccion del cliente: es
      // rellenar un hueco. Se distingue para que la metrica
      // `dato_corregido_por_el_cliente` siga significando algo -el cliente
      // cambio un dato que el mismo habia dado- y para que el aviso del
      // panel no diga que corrigio algo que nunca dijo.
      const soloEraElPerfil = campos.vieneDelPerfil(antes);
      const esCorreccionDelCliente =
        origen === campos.ORIGENES.CLIENTE &&
        !soloEraElPerfil &&
        confirmado !== null &&
        valor !== null &&
        valor !== undefined &&
        valor !== "" &&
        String(valor).trim().toLowerCase() !== String(confirmado).trim().toLowerCase();

      if (esCorreccionDelCliente) {
        antes = campos.reabrir(antes, `el cliente lo corrigio: "${confirmado}" -> "${valor}"`);
        actualizada[campo] = antes;
        contar("dato_corregido_por_el_cliente");
        registrar("info", "dato_corregido_por_el_cliente", { campo });
        // Se apunta para que el mensaje pueda DECIR que se cambio. Sin esto,
        // una correccion aplicada se ve igual que una ignorada: el resumen
        // sale con una linea distinta en un cuadro de seis, y el cliente no
        // tiene forma de saber si lo oyeron. Chat de Ailid, 09-oct.
        if (Array.isArray(registroDeCambios)) registroDeCambios.push(campo);
      } else if (
        soloEraElPerfil &&
        origen === campos.ORIGENES.CLIENTE &&
        valor &&
        String(valor).trim().toLowerCase() !== String(confirmado).trim().toLowerCase()
      ) {
        // `proponer` no pisa un campo confirmado, asi que hay que abrirlo:
        // sin esto el nombre del perfil se queda puesto aunque el cliente
        // escriba el suyo, que es exactamente el defecto del 09-oct.
        antes = campos.reabrir(antes, `lo dijo el cliente y antes solo estaba el perfil: "${confirmado}" -> "${valor}"`);
        actualizada[campo] = antes;
        registrar("info", "nombre_de_perfil_reemplazado", { campo });
      }

      actualizada[campo] = campos.proponer(antes, valor, origen);
      if (actualizada[campo] !== antes) contar("dato_propuesto");
    }
    return actualizada;
  }

  /**
   * Valida los candidatos y confirma los que pasan.
   *
   * Aqui es donde una frase deja de ser una ciudad. El modelo puede proponer
   * "a mi casa" como direccion; esta funcion lo rechaza y lo deja marcado.
   */
  function validarYConfirmar(ficha) {
    let f = { ...ficha };
    const revisiones = [];
    const ambiguedades = [];

    // Telefono: candado duro. Sin telefono valido no hay despacho posible.
    f.telefono = campos.confirmar(f.telefono, (v) => destino.validarTelefono(v));

    f.nombre = campos.confirmar(f.nombre, (v) => {
      const r = destino.validarNombre(v);
      if (r.ok && r.revisar) revisiones.push({ campo: "nombre", motivo: r.motivo });
      return r;
    });

    // Ciudad: se resuelve contra el listado, usando el departamento si ya se
    // conoce, para poder desambiguar homonimos.
    const depCandidato = campos.valorConfirmado(f.departamento) || campos.valorCandidato(f.departamento);
    f.ciudad = campos.confirmar(f.ciudad, (v) => {
      const r = destino.resolverCiudad(v, depCandidato);
      if (r.ambigua) {
        ambiguedades.push({ campo: "ciudad", opciones: r.opciones, motivo: r.motivo });
        return { ok: false, motivo: r.motivo };
      }
      if (!r.ok) return { ok: false, motivo: r.motivo };
      if (r.revisar) revisiones.push({ campo: "ciudad", motivo: r.motivo });
      // El departamento se deriva de la ciudad: lo calcula el codigo, no se
      // le pregunta al cliente ni se le pide al modelo.
      if (r.departamento && !campos.estaConfirmado(f.departamento)) {
        f.departamento = campos.confirmar(
          campos.proponer(f.departamento, r.departamento, campos.ORIGENES.CODIGO),
          () => ({ ok: true, valor: r.departamento })
        );
      }
      return { ok: true, valor: r.ciudad };
    });

    f.direccion = campos.confirmar(f.direccion, (v) => {
      const r = destino.validarDireccion(v);
      if (r.ok && r.revisar) revisiones.push({ campo: "direccion", motivo: r.motivo });
      return r;
    });

    // El punto de referencia no tiene formato: es texto libre que el cliente
    // da cuando se le pide ("al frente de la droguería Cristal"). Lo unico
    // que se exige es que diga algo.
    f.referencia = campos.confirmar(f.referencia, (v) => {
      const t = String(v || "").trim();
      return t.length >= 4 ? { ok: true, valor: t } : { ok: false, motivo: "referencia demasiado corta" };
    });

    f.cantidad = campos.confirmar(f.cantidad, (v) =>
      Number.isInteger(v) && v >= 1 && v <= 50
        ? { ok: true, valor: v }
        : { ok: false, motivo: `cantidad "${v}" fuera de rango razonable` }
    );

    for (const r of campos.rechazados(f)) contar("dato_rechazado");
    for (const nombre of campos.CAMPOS) {
      if (campos.estaConfirmado(f[nombre]) && !campos.estaConfirmado(ficha[nombre])) contar("dato_confirmado");
    }

    return { ficha: f, revisiones, ambiguedades };
  }

  // ----------------------------------------------------------------------
  // Cotizacion
  // ----------------------------------------------------------------------
  function intentarCotizar(conversacion, producto) {
    if (!producto) return { ok: false, motivo: "producto desconocido", falta: ["producto"] };

    const datos = campos.soloConfirmado(conversacion.ficha);
    const cantidad = datos.cantidad ?? null;
    if (!cantidad) return { ok: false, motivo: "cantidad no confirmada", falta: ["cantidad"] };

    const r = cotizador.cotizar({
      producto,
      cantidad,
      destino: datos.ciudad ? { ciudad: datos.ciudad, departamento: datos.departamento || null } : null,
      variante: datos.variante || null,
    });

    if (r.ok) contar("cotizacion_correcta");
    else if (r.escalar) contar("cotizacion_escalada");
    else contar("cotizacion_datos_faltantes");

    return r;
  }

  /** Emite oferta nueva solo si las condiciones cambiaron. */
  function actualizarOferta(conversacion, cotizacion) {
    const firmaNueva = cotizador.firmaDeCondiciones(cotizacion);
    const firmaVieja = conversacion.cotizacion ? cotizador.firmaDeCondiciones(conversacion.cotizacion) : null;

    if (!conversacion.ofertaId || firmaNueva !== firmaVieja) {
      // Condiciones distintas: lo que el cliente pudo haber confirmado antes
      // YA NO APLICA. Oferta nueva, y el resumen deja de estar mostrado.
      return {
        ofertaId: pedidos.nuevoIdDeOferta(),
        cotizacion,
        resumenMostrado: false,
        ofertaCambio: Boolean(firmaVieja && firmaNueva !== firmaVieja),
      };
    }
    return { ofertaId: conversacion.ofertaId, cotizacion, resumenMostrado: conversacion.resumenMostrado, ofertaCambio: false };
  }

  // ----------------------------------------------------------------------
  // Turno completo
  // ----------------------------------------------------------------------

  /**
   * Procesa un mensaje entrante ya normalizado y deduplicado por el webhook.
   *
   * @param {object} evento  evento de src/webhook/normalizar.js
   * @returns {Promise<object>} traza de lo que se decidio
   */
  async function procesar(evento) {
    const contactoId = evento.idCliente;
    if (!contactoId) {
      contar("error_interno");
      return { ok: false, motivo: "evento sin identificador de cliente" };
    }

    // REGLA 2: todo el turno, en exclusiva para este contacto.
    return enSerie(`turno:${contactoId}`, () => turno(evento, contactoId));
  }

  async function turno(evento, contactoId) {
    const traza = {
      ok: true,
      contactoId,
      wamid: evento.wamid,
      estadoPrevio: null,
      estadoNuevo: null,
      producto: null,
      intencion: null,
      accion: null,
      cotizacion: null,
      pedido: null,
      respuesta: null,
      enviada: false,
      bloqueos: [],
      avisos: [],
    };

    const { conversacion } = await cargarContexto(evento);
    traza.estadoPrevio = conversacion.estado;

    const pedidoActivo = await repos.pedidos.activoDeContacto(contactoId);

    // ------------------------------------------------------------------
    // REGLA 1: la confirmacion se decide ANTES de la IA
    // ------------------------------------------------------------------
    const decision = confirmacion.evaluar({
      texto: evento.texto || "",
      estado: conversacion.estado,
      resumenMostrado: conversacion.resumenMostrado === true,
    });
    traza.accion = decision.accion;
    traza.clase = decision.clase;

    // ------------------------------------------------------------------
    // ¿ACABA DE DECIR QUE SI A LA PREGUNTA DE CIERRE?
    //
    // ⚠️ EL DEFECTO MAS CARO DEL 10-OCT. Cuatro conversaciones del panel,
    //    cuatro clientes diciendo que si, cero pedidos:
    //
    //   Santiago · "Mándamelo"          -> el bot repitio la pregunta
    //   Jhon     · "Si claro por favor" -> repitio el precio y pregunto otra vez
    //   Precioso · "Si Agame el favor"  -> otra vez "¿Te lo aparto...?"
    //   Popayan  · "Si" y luego "Claro" -> "Perdón, creo que no te entendí bien"
    //
    // La pieza que faltaba era la MEMORIA de haber preguntado. El permiso
    // para pedir los datos es `lectura.compra || huboSenalDeCompra ||
    // datosAportados.length`, y "Mándamelo" no es ninguna de las tres: no
    // trae dato, y `SENALES_DE_COMPRA` no lo reconocia. Sin permiso, el
    // redactor volvia a soltar el mismo cierre; y al ser texto identico, la
    // guarda anti-eco remataba con "no te entendí bien".
    //
    // `cierrePropuesto` se escribe al final del turno SOLO si el mensaje
    // salio de verdad y llevaba una pregunta de cierre. Aqui se lee, y un
    // "si" vale como señal de compra: es lo que el cliente quiso decir.
    //
    // POR QUE ES SEGURO ACEPTAR UNA LISTA TAN AMPLIA ("listo", "ok", "por
    // favor"): porque solo se consulta con `cierrePropuesto` puesto. Fuera
    // de ese contexto esas palabras no afirman nada y la funcion no se
    // llama. Y no crea el pedido: lleva a PEDIR LO QUE FALTA. El pedido
    // sigue exigiendo el resumen a la vista y su propia confirmacion.
    // ------------------------------------------------------------------
    // ⚠️ EL CIERRE TAMBIEN CUENTA SI LO HIZO UNA PERSONA DESDE EL PANEL.
    //
    // La bandera `cierrePropuesto` solo la escribe el BOT al enviar. Pero
    // Marco lo señalo en su punto 6: "cuando el cliente responde a un
    // mensaje del operador, interpretar la respuesta según ese mensaje".
    //
    // Su caso: el operador escribio "¿Me confirmas?" y el "Si" del cliente
    // volvia a "¿Te lo aparto...?". El mensaje del operador SI queda en el
    // historial, asi que basta con mirar el ultimo mensaje del negocio —
    // venga del bot o de una persona.
    const ultimoDelNegocioAhora = [...atencionDeChat.mensajes(conversacion)]
      .reverse()
      .find((m) => m && m.de && m.de !== atencionDeChat.QUIEN.CLIENTE);
    const huboCierre =
      conversacion.cierrePropuesto === true ||
      responder.prometeCierre((ultimoDelNegocioAhora && ultimoDelNegocioAhora.texto) || "");

    const afirmoElCierre = huboCierre && confirmacion.esAfirmacionDeCierre(evento.texto || "");
    if (afirmoElCierre) {
      // Se guarda como señal de compra permanente, igual que un "lo quiero":
      // una vez que dijo que si, sigue siendo verdad en el turno siguiente.
      conversacion.huboSenalDeCompra = true;
      traza.avisos.push("dijo que si a la pregunta de cierre: cuenta como señal de compra");
      contar("afirmo_el_cierre");
    }

    // ------------------------------------------------------------------
    // Producto
    // ------------------------------------------------------------------
    const resolucion = senales.resolver({
      texto: evento.texto || "",
      referral: evento.referral,
      conversacion,
      catalogo,
      ventana: conversacion.ventana || [],
    });
    traza.producto = { ...resolucion };

    if (resolucion.ambiguo) contar("producto_ambiguo");
    else if (resolucion.productoId) contar("producto_identificado");
    else contar("producto_desconocido");

    // Un cambio de producto solo se acepta si NO hay un pedido confirmado.
    // Cambiar el producto de una conversacion con pedido vivo es como se
    // despacha el articulo equivocado.
    const blindado = estados.estaBlindado(conversacion.estado);
    if (resolucion.esCambio && !blindado) {
      contar("producto_cambiado");
      // La cotizacion anterior era de otro producto: se descarta entera.
      conversacion.cotizacion = null;
      conversacion.ofertaId = null;
      conversacion.resumenMostrado = false;
      conversacion.ficha.cantidad = campos.reabrir(conversacion.ficha.cantidad, "cambio de producto");
    } else if (resolucion.esCambio && blindado) {
      traza.avisos.push("se menciono otro producto pero hay un pedido vivo: no se cambia");
    }

    if (resolucion.productoId && !blindado) conversacion.productoId = resolucion.productoId;
    if (resolucion.esCambio === false && resolucion.motivo && /pregunta sobre el producto actual/.test(resolucion.motivo)) {
      contar("falsa_senal_de_cambio");
    }

    // SOLO PRODUCTOS ACTIVOS. `porId` incluye tambien los borradores, y un
    // borrador tiene los datos comerciales a medias: precios vacios,
    // descripcion sin aprobar, claims sin revisar.
    //
    // El caso concreto que esto cierra: una conversacion guardada con el id
    // de un producto que luego se desactiva -o que nunca estuvo activo y
    // entro por un referral mal configurado- volveria a cargarse del disco y
    // el cerebro intentaria venderlo. El cotizador se negaria, pero el bot ya
    // habria dado el producto por bueno en la conversacion. Mejor no llegar
    // ahi: si no esta activo, es como si no existiera.
    const candidato = conversacion.productoId ? catalogo.porId.get(conversacion.productoId) || null : null;
    // `producto` es el que se puede VENDER: solo si esta activo. Es el que
    // llega al cotizador y al pedido.
    const producto = candidato && candidato.activo === true ? candidato : null;

    // ------------------------------------------------------------------
    // UN BORRADOR SE RECONOCE, PERO NO SE VENDE
    //
    // Antes esto hacia `conversacion.productoId = null` y volvia a
    // preguntar que producto queria. Con el unico producto en borrador, el
    // cliente escribia "fotos del cinturon" y el bot le preguntaba cual
    // producto. En cada mensaje. En bucle.
    //
    // Era un error de concepto: olvidar lo que el cliente dijo porque
    // todavia no se le puede cotizar. Son dos cosas distintas, y ahora se
    // guardan aparte:
    //
    //   `producto`  -> se puede vender (activo). Va al cotizador.
    //   `candidato` -> se sabe de que habla. Sirve para contestarle con
    //                  sentido y para mandarle las fotos.
    //
    // La identificacion se CONSERVA, asi que la conversacion avanza: el
    // bot dice que todavia no puede dar el precio, en vez de preguntar lo
    // que el cliente ya respondio.
    //
    // Lo que impide venderlo sigue siendo duro y no depende de esto:
    // `cotizar()` se niega con "el producto no esta activo", y sin
    // cotizacion no hay pedido.
    // ------------------------------------------------------------------
    if (candidato && !producto) {
      traza.avisos.push(
        `el producto "${candidato.id}" esta en borrador: se reconoce y se puede mostrar, pero no se puede cotizar`
      );
      contar("producto_en_borrador");
    }

    // ------------------------------------------------------------------
    // IA: intencion, candidatos y borrador. Nunca hechos.
    // ------------------------------------------------------------------
    let analisis = null;
    if (ia && ia.disponible) {
      // ----------------------------------------------------------------
      // LA IA PUEDE FALLAR DE DOS FORMAS, Y SOLO UNA ESTABA CUBIERTA
      //
      // `cliente.js` devuelve {ok:false} cuando el proveedor da error, da
      // timeout o contesta algo ilegible, y eso se maneja justo abajo.
      //
      // Lo que NO estaba cubierto es que la llamada LANCE. Probando el
      // escenario "falla el modelo" con un proveedor que revienta, el
      // turno entero moria: la excepcion subia hasta el webhook, que la
      // registra bien -el mensaje no se pierde y el trabajo queda
      // reclamable- pero EL CLIENTE NO RECIBE NADA. Una venta en silencio.
      //
      // Hoy el cliente real envuelve al proveedor en try/catch, asi que
      // esto no pasa en produccion. Se blinda igual porque el cerebro no
      // debe depender de que una dependencia inyectada nunca lance: el dia
      // que `construirPrompt` falle con un dato raro, o que se cambie el
      // cliente, el modo de fallo seria perder la respuesta.
      //
      // Y no hace falta nada mejor que degradar: TODO este modulo esta
      // construido para funcionar sin modelo. El camino determinista da la
      // respuesta buena; la IA solo la mejora.
      // ----------------------------------------------------------------
      let r = null;
      try {
        r = await ia.analizar({
          sistema: SISTEMA_BASE,
          usuario: construirPrompt(evento, conversacion, producto),
        });
      } catch (e) {
        contar("ia_excepcion");
        registrar("warn", "ia_lanzo_excepcion", {
          wamid: evento.wamid,
          detalle: e && e.message ? String(e.message).slice(0, 200) : "sin detalle",
        });
        traza.avisos.push("la ia lanzo una excepcion: se sigue solo con el camino determinista");
        r = null;
      }

      if (r) {
        analisis = r.analisis;
        traza.intencion = analisis.intencion;
        if (!r.ok) {
          traza.avisos.push(`ia no utilizable: ${r.motivo}`);
          // La IA fallo. El mensaje NO se pierde y NO se inventa nada: se
          // sigue con el camino determinista y, si hace falta, se escala.
        } else {
          contar("intencion_detectada");
        }
      }
    } else {
      traza.avisos.push("sin proveedor de IA: solo camino determinista");
    }

    // ------------------------------------------------------------------
    // Candidatos -> validacion -> confirmacion de datos
    // ------------------------------------------------------------------
    // Lo que YA estaba confirmado antes de este turno. Sirve para saber si
    // el cliente acaba de APORTAR un dato, que es una señal de avance muy
    // distinta de una pregunta: quien escribe su ciudad esta comprando.
    const confirmadosAntes = new Set(Object.keys(campos.soloConfirmado(conversacion.ficha)));

    // La IA propone primero y la heuristica despues, porque en combinar()
    // gana la heuristica: ella solo propone lo que reconocio contra una
    // lista o un patron, mientras el modelo propone lo que le parece.
    if (analisis && analisis.candidatos) {
      conversacion.ficha = aplicarCandidatos(conversacion.ficha, analisis.candidatos, campos.ORIGENES.IA);
    }
    // ¿Se le pidio el nombre y todavia no lo tenemos? Entonces un mensaje
    // que solo trae un nombre ES la respuesta a esa pregunta. Lo sabe el
    // cerebro, que es quien guarda la memoria de lo que ya se pidio.
    // ⚠️ "VIENE DEL PERFIL" CUENTA COMO "NO TENEMOS NOMBRE".
    //
    // Sin esta condicion, el nombre del perfil de WhatsApp cerraba la
    // captura para siempre: el campo no estaba vacio, asi que un mensaje
    // con solo el nombre no se leia. Es lo que dejo a Ailid sin poder dar
    // el suyo en cuatro intentos el 09-oct.
    const seLePidioElNombre =
      conversacion.datosPedidos === true &&
      (!campos.valorConfirmado(conversacion.ficha && conversacion.ficha.nombre) ||
        campos.vieneDelPerfil(conversacion.ficha && conversacion.ficha.nombre));
    const heuristicos = candidatosHeuristicos(evento, {
      seLePidioElNombre,
      // Para que el nombre de perfil de WhatsApp no pise el que escribio
      // el cliente. Ver el comentario en `candidatosHeuristicos`.
      //
      // Un nombre que solo viene del PERFIL no cuenta como "ya hay nombre":
      // si contara, el perfil se quedaria pegado para siempre y el cliente
      // no podria dar el suyo. Es lo que paso el 09-oct.
      yaHayNombre:
        Boolean(campos.valorConfirmado(conversacion.ficha && conversacion.ficha.nombre)) &&
        !campos.vieneDelPerfil(conversacion.ficha && conversacion.ficha.nombre),
        // ¿Se le pidio la ciudad y todavia no la tenemos? Entonces una
        // ciudad fuera del listado -un corregimiento, una vereda- se acepta
        // marcada para revisar, en vez de perderse. Se exige que el NOMBRE
        // ya este resuelto: con los dos pendientes, un mensaje de dos
        // palabras es ambiguo y se lo queda el nombre, que se pidio primero.
      yaTieneCiudad: Boolean(campos.valorConfirmado(conversacion.ficha && conversacion.ficha.ciudad)),
      seLePidioLaCiudad:
        (conversacion.saludado === true || conversacion.datosPedidos === true) &&
        !campos.valorConfirmado(conversacion.ficha && conversacion.ficha.ciudad) &&
        Boolean(campos.valorConfirmado(conversacion.ficha && conversacion.ficha.nombre)),
      // El turno siguiente a "¿me das un punto de referencia?". Se cierra en
      // cuanto hay referencia, para no quedarse tragando mensajes.
      seLePidioLaReferencia:
        conversacion.referenciaPedida === true &&
        !campos.valorConfirmado(conversacion.ficha && conversacion.ficha.referencia),
    });

    // El perfil PRIMERO, para que lo que escriba el cliente pueda pisarlo.
    const corregidosEnEsteTurno = [];
    conversacion.ficha = aplicarCandidatos(conversacion.ficha, heuristicos.delPerfil, campos.ORIGENES.PERFIL);
    conversacion.ficha = aplicarCandidatos(
      conversacion.ficha,
      heuristicos.delCliente,
      campos.ORIGENES.CLIENTE,
      corregidosEnEsteTurno
    );

    // ------------------------------------------------------------------
    // "LAS QUIERO" DESPUES DE UN PRECIO DE DOS SIGNIFICA DOS
    //
    // Se propone la cantidad que se le informo, y SOLO con las tres
    // condiciones juntas:
    //
    //   1. el turno trae una señal de compra explicita,
    //   2. el bot le informo una cantidad mayor que una,
    //   3. el mensaje NO menciona ninguna cantidad propia.
    //
    // La tercera es la que evita el error caro: si dice "mejor una", eso
    // manda sobre lo que se informo antes. Y se PROPONE -no se confirma-,
    // asi que pasa por la misma validacion que cualquier dato del cliente.
    // ------------------------------------------------------------------
    const turnoDeCompra = responder.analizarTurno(evento.texto || "");
    if (
      // `afirmoElCierre` entra aqui el 10-oct: si el bot informo el precio
      // de dos y la clienta contesta "claro" o "mándamelas" a la pregunta
      // de cierre, esta aceptando LAS DOS. Antes solo valia un "las quiero"
      // reconocido como compra, y "claro" se quedaba fuera.
      (turnoDeCompra.lectura.compra || afirmoElCierre) &&
      Number(conversacion.cantidadInformada) > 1 &&
      !texto.cantidadesEn(evento.texto || "").length &&
      !campos.valorConfirmado(conversacion.ficha.cantidad)
    ) {
      conversacion.ficha = aplicarCandidatos(
        conversacion.ficha,
        { cantidad: conversacion.cantidadInformada },
        campos.ORIGENES.CODIGO
      );
      traza.avisos.push(
        `"${evento.texto}" tras informar ${conversacion.cantidadInformada} unidades: se toma esa cantidad`
      );
    }

    // ------------------------------------------------------------------
    // SI LO UNICO QUE FALTA ES LA CANTIDAD, SE TOMA UNA
    //
    // El callejon, visto en una conversacion de prueba del 09-oct: la
    // clienta ya habia dado nombre, ciudad y direccion, y el bot le pedia
    // "si quieres uno o dos". Contesto "si" -que no es un numero- y recibio
    // "¿Cuántos quieres? 🙌". Otro "si" habria dado lo mismo: un bucle con
    // la venta entera ya armada.
    //
    // UNA, Y NO DOS, POR LA REGLA DE LA CASA: *ante ambigüedad de cantidad,
    // se elige la menor*. Nunca se cobra de mas.
    //
    // Y es seguro porque NO crea el pedido: con la cantidad puesta, el turno
    // llega a "resumen" y la clienta ve "1 unidad · $49.900" antes de
    // confirmar. Si queria dos, lo dice ahi y se recotiza. Cambiar un
    // callejon por un resumen corregible es un buen cambio.
    //
    // Se exige que TODO lo demas este confirmado: mientras falte la
    // direccion, preguntar la cantidad es lo correcto.
    let validacion = validarYConfirmar(conversacion.ficha);
    conversacion.ficha = validacion.ficha;

    // ⚠️ VA DESPUES DE `validarYConfirmar`, Y ESO NO ES UN DETALLE.
    //
    // La primera version iba antes, y no se disparaba nunca: `faltantes()`
    // mira lo CONFIRMADO, y antes de validar los datos de este turno todavia
    // son candidatos. Habia que preguntarse "¿falta algo mas que la
    // cantidad?" sobre la ficha ya validada.
    const REQUERIDOS_SIN_CANTIDAD = [...REQUERIDOS_BASE, ...((producto && producto.datosRequeridos) || [])];
    // ⚠️ YA NO SE EXIGE SEÑAL DE COMPRA (2026-10-09). Lo pidio Marco:
    //    "Cantidad por defecto: 1".
    //
    // La condicion pedia `compra || huboSenalDeCompra`, y eso dejaba fuera el
    // caso mas comun de todos — el del caso 1 de su lista:
    //
    //   cliente · "Alejandro león Garzón"
    //   cliente · "Popayán Cauca"
    //   cliente · "Barrio pueblillo en la cantera la pintada"
    //   bot     · "¡Perfecto, gracias! Para preparar tu pedido me pasas si
    //              quieres uno o dos 🙌"
    //
    // Nunca dijo "lo quiero" con esas palabras. Pero acababa de dar su
    // nombre completo, su ciudad y su direccion: no hay señal de compra mas
    // fuerte que esa, y el bot le pedia un dato mas en vez de mostrarle el
    // resumen.
    //
    // Sigue siendo seguro porque NO crea el pedido: con la cantidad puesta
    // el turno llega a "resumen" y el cliente ve "1 unidad · $49.900" antes
    // de confirmar. Y si queria dos, lo dice ahi. Se elige UNA porque es la
    // menor: nunca se cobra de mas.
    // ⚠️ SE PREGUNTA POR `extraer.cantidadEn`, NO POR `texto.cantidadesEn`.
    //
    // `cantidadesEn` devuelve TODOS los numeros del mensaje, y una direccion
    // esta llena de numeros. Con el guardia escrito asi:
    //
    //   cliente · "lo quiero, soy Santiago, Bogotá, Calle 62bis 67-12"
    //
    // los "62", "67" y "12" contaban como "ya dijo una cantidad", la regla
    // no se disparaba, y el bot le pedia la cantidad a quien acababa de dar
    // TODOS sus datos de entrega. Un turno perdido en el peor momento.
    //
    // `extraer.cantidadEn` ya resuelve esto bien y esta probado: si el
    // mensaje parece una direccion, sus numeros no son cantidades.
    // ------------------------------------------------------------------
    // ⚠️ Y TAMBIEN CUANDO YA DIJO QUE SI: "CANTIDAD POR DEFECTO 1", QUE LO
    //    PIDIO MARCO EL 10-OCT.
    //
    // Hasta hoy esta regla exigia que TODO lo demas estuviera completo. El
    // resultado, en el chat de Santiago:
    //
    //   bot      · "¿Te lo aparto...?"
    //   Santiago · "Envíamelo"
    //   bot      · "¡Perfecto! ¿Cuántos quieres? Y para preparar tu pedido
    //               me pasas la dirección 🙌"
    //
    // Preguntarle cuantos quiere a alguien que acaba de decir "envíamelo"
    // es ponerle un trabajo extra en el unico momento en que ya habia
    // decidido. Lo normal es uno; si quiere dos, lo dice.
    //
    // DOS CANDADOS SE MANTIENEN:
    //   · si el mensaje trae un numero, manda el numero;
    //   · si el bot informo el precio de DOS, no se baja a 1 a sus espaldas
    //     (de eso se encarga la regla de arriba, que respeta esa cantidad).
    //
    // Y no se cobra de mas nunca: se elige la menor, y la vera escrita en
    // el resumen antes de confirmar.
    // ------------------------------------------------------------------
    // OJO: se mira la señal de compra DE ESTE TURNO, no la de la
    // conversacion entera. La diferencia la pidio Marco en sus dos
    // instrucciones, que a primera vista parecen chocar y no chocan:
    //
    //   · tras un SI ("mándamelo") -> no preguntarle cuantos, se toma 1.
    //   · en el mensaje de la CIUDAD -> ofrecerle "si quieres uno o dos".
    //
    // Si esto mirara `huboSenalDeCompra` -que es permanente- un "me
    // interesa" de hace cinco mensajes fijaria la cantidad en 1 y el
    // mensaje de la ciudad perderia el ofrecimiento de las dos. Mirando el
    // turno, cada instruccion se cumple donde toca.
    // Y se mira la AFIRMACION, no cualquier señal de compra. "Me interesa"
    // es compra -y abre la puerta a pedir datos- pero no es "mándamelo": a
    // quien apenas muestra interes todavia se le ofrece "si quieres uno o
    // dos", que es el upsell del combo. A quien ya dijo "mándamelo" se le
    // toma 1 y se le piden solo los datos, que es lo que pidio Marco.
    // Dos caminos, y los dos exigen contexto o intencion explicita:
    //   · `afirmoElCierre`: contesto que si a la pregunta de cierre.
    //   · un imperativo de compra RECONOCIDO como tal ("mándamelo", "lo
    //     quiero"). Se exige `lectura.compra` ADEMAS de la forma de
    //     afirmacion: sin eso, un "Por favor" suelto -que no es compra-
    //     fijaba la cantidad y le disparaba el formulario a quien no habia
    //     pedido nada. Lo cazo una prueba del 09-oct.
    const dijoQueSiEnEsteTurno =
      afirmoElCierre ||
      (turnoDeCompra.lectura.compra === true && confirmacion.esAfirmacionDeCierre(evento.texto || ""));
    if (
      !campos.valorConfirmado(conversacion.ficha.cantidad) &&
      extraer.cantidadEn(evento.texto || "").valor === null &&
      !(Number(conversacion.cantidadInformada) > 1) &&
      (campos.faltantes(conversacion.ficha, REQUERIDOS_SIN_CANTIDAD).length === 0 || dijoQueSiEnEsteTurno)
    ) {
      conversacion.ficha = aplicarCandidatos(conversacion.ficha, { cantidad: 1 }, campos.ORIGENES.CODIGO);
      validacion = validarYConfirmar(conversacion.ficha);
      conversacion.ficha = validacion.ficha;
      traza.avisos.push("no dijo cuantos y ya mostro intencion de compra: se toma 1, la menor, y lo vera en el resumen");
    }

    // Que datos se confirmaron EN ESTE TURNO.
    //
    // SOLO LOS DATOS DE DESPACHO, y esto importa: `productoId` tambien es un
    // campo de la ficha, asi que "me interesa el cinturón" lo confirmaba y
    // el bot abria con "¡Perfecto, gracias!" a alguien que no habia dado
    // ningun dato. Sonaba a acuse de recibo de algo que nunca llego.
    //
    // El telefono tampoco cuenta: llega gratis con el mensaje de WhatsApp,
    // no lo APORTA nadie, y agradecerlo seria agradecerse a si mismo.
    const DATOS_DE_DESPACHO = ["nombre", "documento", "ciudad", "departamento", "direccion", "referencia", "cantidad"];
    // ------------------------------------------------------------------
    // ⚠️ Y LO QUE PONE EL CODIGO NO LO "APORTA" EL CLIENTE.
    //
    // `datosAportados` se usa como señal de que el cliente avanza la venta.
    // Pero hay dos campos que los rellena el sistema: la cantidad por
    // defecto (1) y el departamento derivado de la ciudad. Contarlos como
    // aportados es atribuirle al cliente algo que no dijo.
    //
    // Se vio al añadir la cantidad por defecto el 10-oct: "Por favor" no
    // aporta ningun dato, el codigo le ponia cantidad 1, y eso bastaba para
    // dispararle la pedida de los cuatro datos. Justo el "formulario por
    // defecto" que una prueba del 09-oct existe para impedir.
    // ------------------------------------------------------------------
    const puestoPorElCodigo = (campo) => {
      const c = conversacion.ficha && conversacion.ficha[campo];
      return Boolean(c && c.origen === campos.ORIGENES.CODIGO);
    };
    const datosAportados = Object.keys(campos.soloConfirmado(conversacion.ficha)).filter(
      (c) => !confirmadosAntes.has(c) && DATOS_DE_DESPACHO.includes(c) && !puestoPorElCodigo(c)
    );
    traza.datosAportados = datosAportados;
    traza.revisiones = validacion.revisiones;
    traza.ambiguedades = validacion.ambiguedades;

    // ------------------------------------------------------------------
    // Accion
    // ------------------------------------------------------------------
    let situacion = "escalado";
    let estadoDestino = conversacion.estado;

    // ------------------------------------------------------------------
    // LAS TRES RAZONES POR LAS QUE SI HAY QUE LLAMAR A UNA PERSONA
    //
    // Marco lo dijo con un ejemplo: "si la persona está pidiendo una
    // garantía, eso lo tiene que solucionar el humano; pero estaba pasando
    // que con cualquier pregunta de una vez lo dejaba para contacto humano".
    //
    // Estaba exactamente al reves. Medido el 09-oct, con el codigo de
    // produccion:
    //
    //   "quiero hablar con una persona"
    //     -> "¡Perfecto, gracias! Para preparar tu pedido me pasas la
    //         ciudad y la dirección"
    //   "me llegó dañado, quiero la garantía"
    //     -> "¡Claro que sí! Tiene 1 mes de garantía, así que compras con
    //         tranquilidad. ¡Perfecto! Para preparar tu pedido me pasas…"
    //   "esto es un robo, son unos estafadores, los voy a denunciar"
    //     -> "¡Perfecto, gracias! Para preparar tu pedido me pasas…"
    //
    // Las tres son las que NINGUN bot debe atender, y las tres seguian
    // dentro del embudo de venta. Mientras tanto, una duda sobre el
    // material si escalaba.
    //
    // Esta rama va ANTES de todo lo demas -incluida la cotizacion- porque
    // ninguna de las tres se arregla vendiendo. Y es el unico escalado que
    // se puede provocar desde el TEXTO del cliente, asi que las tres listas
    // son estrechas y estan en `src/dominio/preguntas.js` con su motivo.
    // ------------------------------------------------------------------
    const intencion = preguntas.leer(evento.texto || "");
    const motivoDeHumano = intencion.reclamaGarantia
      ? "reclamo_de_garantia"
      : intencion.estaMolesto
        ? "cliente_molesto"
        : intencion.pideHumano
          ? "pidio_una_persona"
          : // UN PEDIDO MAYORISTA ES UN LEAD, NO UN PROBLEMA, y por eso
            // escala: nadie puede cotizarle seis unidades desde una tabla que
            // cubre una y dos, y quien revende compra todos los meses.
            //
            // Va al final de la cadena a proposito: si la misma clienta esta
            // enfadada o reclamando algo, eso manda sobre la venta.
            intencion.temas.includes(preguntas.TEMAS.MAYORISTA)
            ? "pedido_mayorista"
            : null;

    // ⚠️ SE LEE AQUI, ANTES DE LA CADENA DE ACCIONES, y no mas abajo.
    //
    // La cadena necesita saber si el cliente pide cambiar la cantidad de un
    // pedido ya confirmado, y esa rama va ANTES del blindaje de
    // "ya_confirmado" -si no, el blindaje gana y contesta "tu pedido está
    // confirmado" a quien pide dos unidades-. Declararla abajo producia
    // "Cannot access 'loQuePregunta' before initialization".
    //
    // Solo depende del texto del evento, asi que subirla no cambia nada.
    const loQuePregunta = preguntas.leer(evento.texto || "");

    if (motivoDeHumano) {
      situacion = "escalado";
      estadoDestino = estados.ESTADOS.ESCALADO;
      traza.motivoEscalado = motivoDeHumano;
      traza.avisos.push(`escalado legitimo: ${motivoDeHumano}`);
      contar("escalado_a_persona");
      atencionDeChat.anotarPendiente(conversacion, {
        motivo:
          motivoDeHumano === "reclamo_de_garantia"
            ? atencionDeChat.MOTIVOS_PENDIENTE.CAMBIO_DE_PEDIDO
            : atencionDeChat.MOTIVOS_PENDIENTE.NO_SUPO,
        pregunta: evento.texto || "",
      });
    } else if (
      // ------------------------------------------------------------------
      // CAMBIAR LA CANTIDAD DE UN PEDIDO YA CONFIRMADO Y SIN DESPACHAR.
      //
      // ⚠️ VENTA DE $85.000 PERDIDA POR NO TENER ESTA RAMA (ANDRE, 09-oct):
      //
      //   cliente · "Si"                  -> pedido de 1 confirmado
      //   cliente · "Mejor me mandas los 2"
      //   bot     · "Tu pedido está confirmado…"
      //   cliente · "Por favor"
      //   bot     · "Perdón, creo que no te entendí"
      //   cliente · "Quiero 2 equipos"
      //   bot     · "Para pedir otro te ayuda una persona del equipo"
      //
      // Un operador salvo la venta a mano, pero el pedido se quedo en 1
      // unidad y $49.900: se despacho de menos y se cobro de menos.
      //
      // EL BOT PROPONE, NO CAMBIA. Se calcula el total nuevo, se muestra y
      // se pide un "sí". Mutar un pedido confirmado sin que el cliente vea
      // el precio nuevo es como cambiarle las condiciones a sus espaldas —
      // y aqui el cambio SUBE el total, asi que tiene que verlo.
      //
      // Marco lo pidio explicito: "No escalar por esto".
      // ------------------------------------------------------------------
      pedidoActivo &&
      loQuePregunta.cambioDeCantidad !== null &&
      loQuePregunta.cambioDeCantidad !== undefined &&
      pedidoActivo.estado !== "despachado" &&
      pedidoActivo.estado !== "cancelado" &&
      producto
    ) {
      const pedida = loQuePregunta.cambioDeCantidad;
      // 0 significa "uno mas": lo resuelve aqui, que es quien sabe cuantos hay.
      const nueva = pedida === 0 ? Number(pedidoActivo.cantidad || 1) + 1 : pedida;
      const otra = cotizador.cotizar({
        producto,
        cantidad: nueva,
        destino: null,
        variante: (pedidoActivo.producto && pedidoActivo.producto.variante) || null,
      });

      if (!otra.ok || nueva === Number(pedidoActivo.cantidad)) {
        // Sin tarifa aprobada para esa cantidad no se improvisa un precio:
        // eso lo mira una persona. Es el mismo candado del cotizador.
        situacion = "ya_confirmado";
        estadoDestino = conversacion.estado;
        atencionDeChat.anotarPendiente(conversacion, {
          motivo: atencionDeChat.MOTIVOS_PENDIENTE.CAMBIO_DE_PEDIDO,
          pregunta: evento.texto || "",
        });
        traza.avisos.push(`pidio cambiar a ${nueva} unidades y no hay tarifa aprobada: lo mira una persona`);
      } else {
        conversacion.cambioPropuesto = {
          cantidad: nueva,
          total: otra.cotizacion.total,
          pedidoId: pedidoActivo.id,
        };
        conversacion.cotizacion = otra.cotizacion;
        traza.cotizacion = otra.cotizacion;
        traza.cambioDeCantidad = { de: Number(pedidoActivo.cantidad), a: nueva, total: otra.cotizacion.total };
        situacion = "cambio_de_cantidad";
        estadoDestino = estados.ESTADOS.MODIFICANDO;
        contar("cambio_de_cantidad_propuesto");
      }
    } else if (decision.accion === confirmacion.ACCIONES.NINGUNA && estados.estaBlindado(conversacion.estado)) {
      // "si" / "ok" / "gracias" sobre un pedido ya confirmado. NO se cotiza,
      // NO se crea pedido. Esta es la regla que pidio Marco.
      //
      // PERO BLINDADO NO SIEMPRE SIGNIFICA QUE HAYA UN PEDIDO.
      //
      // ESCALADO tambien esta blindado -con razon: si una persona entro, el
      // bot no puede seguir cotizando por su cuenta- y se llega a ESCALADO
      // sin pedido alguno. El caso real: la clienta pide 2 unidades, no hay
      // precio aprobado para 2, se escala. A partir de ahi, cualquier
      // mensaje suyo caia aqui y el bot le contestaba "Tu pedido ya está
      // confirmado", que es falso: no existia ningun pedido.
      //
      // Decirle a alguien que su pedido esta confirmado cuando no lo esta es
      // peor que no contestarle. Sin pedido, esto es un escalado y se dice
      // como tal: una persona le responde.
      if (pedidoActivo) {
        situacion = "ya_confirmado";
        traza.pedido = {
        id: pedidoActivo.id,
        estado: pedidoActivo.estado,
        // La guia, para poder decir que YA SALIO en vez de "te avisamos
        // en cuanto salga". Solo existe si una persona despacho de
        // verdad: el dominio no deja marcar despachado sin guia.
        guia: (pedidoActivo.despacho && pedidoActivo.despacho.guia) || null,
        transportadora: (pedidoActivo.despacho && pedidoActivo.despacho.transportadora) || null,
      };
      } else {
        situacion = "escalado";
        traza.pedido = null;
        traza.avisos.push(
          `estado "${conversacion.estado}" blindado sin pedido: se responde como escalado, no como confirmado`
        );
      }
      estadoDestino = conversacion.estado;
    } else if (decision.accion === confirmacion.ACCIONES.RESPONDER_ESTADO && pedidoActivo) {
      situacion = "ya_confirmado";
      traza.pedido = {
        id: pedidoActivo.id,
        estado: pedidoActivo.estado,
        // La guia, para poder decir que YA SALIO en vez de "te avisamos
        // en cuanto salga". Solo existe si una persona despacho de
        // verdad: el dominio no deja marcar despachado sin guia.
        guia: (pedidoActivo.despacho && pedidoActivo.despacho.guia) || null,
        transportadora: (pedidoActivo.despacho && pedidoActivo.despacho.transportadora) || null,
      };
      estadoDestino = estados.ESTADOS.POSVENTA;
    } else if (decision.accion === confirmacion.ACCIONES.CORREGIR && !estados.tienePedido(conversacion.estado)) {
      // ----------------------------------------------------------------
      // "ALGO ESTA MAL" — Y HABIA QUE PREGUNTAR QUE.
      //
      // ⚠️ ESTA RAMA NO EXISTIA, Y SU AUSENCIA COSTO $85.000.
      //
      // `CORREGIR` caia al flujo normal (`avanzarVenta`). Si el mensaje
      // traia el dato corregido, bien: el resumen se rehacia. Pero si era
      // un "No" pelado -que es lo que escribe quien ya se cansó- no habia
      // ningun dato nuevo, el resumen salia IDENTICO, y la guarda anti-eco
      // remataba con "Te dejé el resumen aquí arriba 👆".
      //
      // Chat de Ailid (09-oct), cuatro veces seguidas. El bot nunca le
      // pregunto QUE estaba mal. Ella tampoco podia adivinar que el bot no
      // la entendia.
      //
      // Dos caminos, y la diferencia es si el turno trajo un dato:
      //   · trajo dato -> sigue al flujo normal, que rehace el resumen, y
      //     se le pone delante "¡Listo, ya lo cambié!" diciendo QUE cambio.
      //   · no trajo nada -> se pregunta que esta mal. Una pregunta
      //     concreta, no un empujon al resumen.
      // ----------------------------------------------------------------
      if (datosAportados.length) {
        const r = avanzarVenta({ conversacion, producto, resolucion, candidato, evento });
        situacion = r.situacion;
        estadoDestino = r.estadoDestino;
        traza.cotizacion = r.cotizacion;
        traza.cotizacionInformativa = r.cotizacionInformativa || null;
        traza.faltan = r.faltan;
        traza.faltaReferencia = r.faltaReferencia === true;
        // Para que el resumen diga QUE se cambio y el cliente lo vea.
        traza.cambiosAplicados = datosAportados;
      } else {
        situacion = "corregir_que";
        estadoDestino = conversacion.estado;
        contar("pregunto_que_dato_esta_mal");
        traza.avisos.push('dijo que algo esta mal sin decir que: se le pregunta en vez de repetir el resumen');
      }
    } else if (decision.accion === confirmacion.ACCIONES.CANCELAR) {
      // ----------------------------------------------------------------
      // CANCELAR ALGO QUE NO EXISTE NO ES UN ESCALADO.
      //
      // Esto era `situacion = r.cancelado ? "cancelado" : "escalado"`, y el
      // "escalado" pausaba el bot 12 h. Resultado: a quien decia "no
      // gracias" SIN tener ningun pedido, el bot le contestaba "esto lo
      // revisa una persona" y se callaba medio dia. No hay nada que
      // revisar: la clienta dijo que no.
      //
      // Dos caminos distintos y por eso se separan:
      //
      //   con pedido  -> "cancelado". Hay plata y logistica de por medio.
      //   sin pedido  -> "declina". Es una conversacion que no cuajo; se
      //                  cierra con calidez, se deja la puerta abierta y el
      //                  bot SIGUE VIVO, porque "no por ahora" se convierte
      //                  en compra con una frecuencia altisima.
      //
      // Y el estado NO se mueve a CANCELADO cuando no habia pedido: si la
      // clienta vuelve con "bueno, listo, lo quiero", tiene que poder
      // comprar sin que nadie toque el panel.
      // ----------------------------------------------------------------
      if (!pedidoActivo) {
        situacion = "declina";
        // Para que los RECORDATORIOS no insistan a quien dijo que no.
        // Insistirle no es vender: es la via rapida a que reporte el numero
        // como spam, y un reporte cuesta la calidad del numero — que vale
        // mucho mas que esta venta.
        conversacion.declino = true;
        traza.pedido = null;
        estadoDestino = conversacion.estado;
        traza.avisos.push("dijo que no sin tener pedido: se cierra con calidez, no se escala ni se pausa");
        contar("declino_sin_pedido");
      } else {
        const r = await cancelarPedido(pedidoActivo, evento);
        situacion = r.cancelado ? "cancelado" : "escalado";
        traza.pedido = r.pedido ? { id: r.pedido.id, estado: r.pedido.estado } : null;
        estadoDestino = r.cancelado ? estados.ESTADOS.CANCELADO : estados.ESTADOS.ESCALADO;
        if (!r.cancelado) {
          traza.avisos.push("hay pedido y no se pudo cancelar: lo gestiona una persona");
          contar("escalado_a_persona");
        }
      }
    } else if (
      // El "sí" al cambio de cantidad: AQUI se aplica sobre el pedido.
      decision.accion === confirmacion.ACCIONES.CONFIRMAR &&
      conversacion.estado === estados.ESTADOS.MODIFICANDO &&
      conversacion.cambioPropuesto &&
      pedidoActivo &&
      pedidoActivo.id === conversacion.cambioPropuesto.pedidoId
    ) {
      const r = pedidos.modificar({
        pedido: pedidoActivo,
        cambios: { cantidad: conversacion.cambioPropuesto.cantidad },
        cotizacionNueva: conversacion.cotizacion,
        porQue: "el cliente pidio cambiar la cantidad por WhatsApp",
        wamid: evento.wamid,
      });
      if (r.ok) {
        await repos.pedidos.reemplazar(r.pedido);
        contar("cambio_de_cantidad_aplicado");
        registrar("info", "cantidad_cambiada", {
          pedidoId: r.pedido.id,
          cantidad: r.pedido.cantidad,
          total: r.pedido.cotizacion.total,
        });
        conversacion.cambioPropuesto = null;
        traza.pedido = { id: r.pedido.id, estado: r.pedido.estado, creado: false };
        traza.cotizacion = r.pedido.cotizacion;
        situacion = "confirmado";
        estadoDestino = estados.ESTADOS.CONFIRMADO;
      } else {
        // No se pudo aplicar -ya salio, por ejemplo-: lo mira una persona y
        // NO se le dice que quedo cambiado.
        situacion = "escalado";
        estadoDestino = estados.ESTADOS.ESCALADO;
        traza.avisos.push(`no se pudo cambiar la cantidad: ${r.motivo}`);
        atencionDeChat.anotarPendiente(conversacion, {
          motivo: atencionDeChat.MOTIVOS_PENDIENTE.CAMBIO_DE_PEDIDO,
          pregunta: evento.texto || "",
        });
      }
    } else if (decision.accion === confirmacion.ACCIONES.CONFIRMAR) {
      const r = await confirmarPedido({ conversacion, producto, evento, revisiones: validacion.revisiones });
      traza.pedido = r.pedido ? { id: r.pedido.id, estado: r.pedido.estado, creado: r.creado } : null;
      traza.cotizacion = conversacion.cotizacion;
      if (r.ok) {
        situacion = r.creado ? "confirmado" : "ya_confirmado";
        estadoDestino = estados.ESTADOS.CONFIRMADO;
      } else {
        situacion = "escalado";
        traza.avisos.push(`no se pudo confirmar: ${r.motivo}`);
        contar("escalado_a_persona");
        estadoDestino = estados.ESTADOS.ESCALADO;
      }
    } else {
      // Flujo normal: identificar, cotizar, pedir lo que falte.
      const r = avanzarVenta({ conversacion, producto, resolucion, candidato, evento });
      situacion = r.situacion;
      estadoDestino = r.estadoDestino;
      traza.cotizacion = r.cotizacion;
      traza.cotizacionInformativa = r.cotizacionInformativa || null;
      traza.faltan = r.faltan;
      traza.faltaReferencia = r.faltaReferencia === true;
    }

    // ------------------------------------------------------------------
    // Estado
    // ------------------------------------------------------------------
    const transicion = estados.transicionar(conversacion.estado, estadoDestino, decision.accion);
    if (!transicion.ok) {
      contar("transicion_invalida");
      registrar("warn", "transicion_invalida", { motivo: transicion.motivo });
      traza.avisos.push(transicion.motivo);
    }
    conversacion.estado = transicion.estado;
    traza.estadoNuevo = conversacion.estado;

    // ------------------------------------------------------------------
    // PREGUNTAR POR DOS NO ES PEDIR DOS
    //
    // "Nunca contestes el precio de una unidad a una pregunta sobre dos",
    // y eso pasaba de la forma mas cara posible: con un pedido de 1 unidad
    // ya confirmado, "¿que valen dos?" o se ignoraba o se contestaba con el
    // precio de una. Tres mensajes seguidos de la misma clienta intentando
    // comprar MAS, y ninguno atendido.
    //
    // Se cotiza la cantidad PREGUNTADA solo para informarla. Lo que NO pasa
    // aqui, y es deliberado:
    //
    //   · no se toca la ficha  -> preguntar no fija la cantidad
    //   · no se toca la oferta -> no hay nada nuevo que confirmar con un "si"
    //   · no se toca el pedido -> el confirmado sigue intacto
    //
    // Si quiere las dos de verdad, lo dira ("las quiero"), y entonces pasa
    // por el camino normal con su resumen y su confirmacion.
    // ------------------------------------------------------------------
    let cotizacionConsultada = traza.cotizacionInformativa || null;
    let cantidadSinTarifa = null;

    if (loQuePregunta.cantidadPreguntada && (producto || candidato)) {
      const prod = producto || candidato;
      const yaCotizada = conversacion.cotizacion && conversacion.cotizacion.cantidad;
      if (loQuePregunta.cantidadPreguntada !== yaCotizada) {
        const datos = campos.soloConfirmado(conversacion.ficha);
        const otra = cotizador.cotizar({
          producto: prod,
          cantidad: loQuePregunta.cantidadPreguntada,
          destino: datos.ciudad ? { ciudad: datos.ciudad, departamento: datos.departamento || null } : null,
          variante: datos.variante || null,
        });
        // Si el catalogo no tiene precio para esa cantidad, `cotizar` se
        // niega y aqui no se informa nada: el cerebro escala. Inventar el
        // precio de tres multiplicando por tres es exactamente lo que no
        // puede hacer.
        if (otra.ok) {
          cotizacionConsultada = otra.cotizacion;
          traza.cantidadPreguntada = loQuePregunta.cantidadPreguntada;
        } else {
          // La tabla no cubre esa cantidad. Se marca para que el texto lo
          // DIGA, en vez de contestar con el precio de otra cantidad: a
          // "¿cuanto cuestan tres?" se respondia "una unidad te queda en
          // $49.900", y la clienta puede leerlo como que tres salen a eso.
          cantidadSinTarifa = loQuePregunta.cantidadPreguntada;
          traza.cantidadSinTarifa = cantidadSinTarifa;
          traza.avisos.push(
            `pregunta por ${loQuePregunta.cantidadPreguntada} unidades y el catalogo no tiene ese precio: ${otra.motivo || "sin precio"}`
          );
        }
      }
    }

    // ------------------------------------------------------------------
    // REGLA 3: preparar siempre, enviar solo si procede
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // LA CUENTA DE LAS OBJECIONES DE PRECIO
    //
    // Vive en la conversacion PERSISTIDA, no en memoria: en Render cada
    // despliegue reinicia el proceso, y una escalera que se reinicia a la
    // mitad vuelve a empezar por el primer escalon con un cliente que ya
    // objeto tres veces.
    //
    // Se cuenta aqui -y no en el redactor- porque el redactor se llama
    // tambien desde el panel y desde las pruebas, y contar ahi inflaria la
    // cuenta sin que el cliente hubiera dicho nada.
    // ------------------------------------------------------------------
    if (loQuePregunta.temas.includes(preguntas.TEMAS.OBJECION_PRECIO)) {
      conversacion.objecionesDePrecio = Number(conversacion.objecionesDePrecio || 0) + 1;
      traza.objecionesDePrecio = conversacion.objecionesDePrecio;
    }

    // ------------------------------------------------------------------
    // Y LA CUENTA DE CADA TEMA, por el mismo motivo: no soltar el mismo
    // parrafo dos veces ante la misma duda reformulada.
    //
    // Tambien persistida. Y se incrementa ANTES de redactar, asi que la
    // primera vez llega como 1: una respuesta solo necesita saber si es la
    // primera vez que la da.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // "SERA OTRO DIA" SE ANOTA, PARA VOLVER UNA SOLA VEZ.
    //
    // Punto 7 de Marco: a quien aplaza no se le insiste ahora -su respuesta
    // no lleva cierre, ver TEMAS_SIN_CIERRE- pero tampoco se le olvida.
    // Pidio un recordatorio a las 20 horas, UNA vez.
    //
    // Se guarda la marca aqui y el barrido de recordatorios usa su propio
    // plazo para estos: ver `dominio/recordatorios.js`.
    // ------------------------------------------------------------------
    if (loQuePregunta.temas.includes(preguntas.TEMAS.OTRO_DIA)) {
      conversacion.aplazadoEn = new Date().toISOString();
      contar("cliente_aplazo");
    }

    // Y quien pide para una FECHA concreta queda en la bandeja.
    //
    // ⚠️ PORQUE EL BOT NO PUEDE CUMPLIR ESE SEGUIMIENTO SOLO. Marco pidio
    //    "te escribo unos dias antes para confirmar", y pasada la ventana de
    //    24 h de WhatsApp hace falta una plantilla aprobada que todavia no
    //    existe. La respuesta no lo promete -dice que queda anotado- y la
    //    nota es lo que hace que eso sea verdad: alguien lo ve y lo retoma.
    if (loQuePregunta.temas.includes(preguntas.TEMAS.PARA_DESPUES)) {
      atencionDeChat.anotarPendiente(conversacion, {
        motivo: atencionDeChat.MOTIVOS_PENDIENTE.SIN_DATO,
        pregunta: evento.texto || "",
      });
      contar("compra_para_mas_adelante");
    }

    conversacion.vecesPorTema = { ...(conversacion.vecesPorTema || {}) };
    for (const t of loQuePregunta.temas) {
      conversacion.vecesPorTema[t] = Number(conversacion.vecesPorTema[t] || 0) + 1;
    }

    const preparada = responder.preparar({
      situacion,
      // El tipo de media, para que un audio o un sticker no caigan en el
      // flujo de texto. `normalizar.js` ya lo trae en el evento.
      tipoDeMedia: (evento.media && evento.media.tipo) || null,
      vecesPorTema: conversacion.vecesPorTema || {},
      vezDeLaObjecion: Math.max(1, Number(conversacion.objecionesDePrecio || 0)),
      // POR QUE se escala, cuando se escala. Sin esto, las tres situaciones
      // que de verdad necesitan una persona -un reclamo, un cliente
      // molesto y quien pide hablar con alguien- recibian la misma frase
      // generica, y a quien esta enfadado una frase de tramite lo enfada
      // mas. Es `null` en el resto de los turnos.
      motivoEscalado: traza.motivoEscalado || null,
      cotizacion: conversacion.cotizacion,
      cotizacionInformativa: cotizacionConsultada,
      faltan: traza.faltan || [],
      // Lo decide `avanzarVenta`: la direccion es solo el barrio. El resumen
      // pide entonces un punto de referencia u ofrece la oficina.
      faltaReferencia: traza.faltaReferencia === true,
      opciones: (resolucion.opciones || []).map((id) => {
        const p = catalogo.porId.get(id);
        return (p && (p.nombreCorto || p.nombre)) || id;
      }),
      pedido: traza.pedido,
      // El CANDIDATO, no solo el activo. Dos razones:
      //
      //   - con el producto en borrador, `producto` es null y el texto
      //     saldria sin nombre y sin mencionar las fotos que SI se mandan.
      //     El bot mandaria cinco imagenes sin anunciarlas.
      //   - `revisarClaims` compara el texto contra `claimsProhibidos` del
      //     producto, y esa lista SI esta llena en el borrador. Con null no
      //     se revisaba ninguno, y es un producto que se compra por dolor:
      //     el riesgo no es exagerar el precio, es prometer algo medico.
      producto: producto || candidato,
      borradorIA: analisis ? analisis.borradorRespuesta : null,

      // El texto del turno y lo que ya se le dijo. Sin esto el texto no puede
      // responder lo que pregunto ni evitar repetir el saludo y la pedida de
      // datos en cada mensaje.
      mensajeCliente: evento.texto || "",
      // El nombre SOLO si esta confirmado: llamar a alguien por un nombre
      // que propuso el modelo y nadie valido es peor que no nombrarlo.
      nombreCliente: campos.valorConfirmado(conversacion.ficha && conversacion.ficha.nombre),
      // Lo que acaba de aportar, y su valor, para poder acusar recibo con
      // el dato en la mano: "¡Perfecto! A Palmira te llega en...".
      datosAportados,
      ciudadConfirmada: campos.valorConfirmado(conversacion.ficha && conversacion.ficha.ciudad),
      // Los datos CONFIRMADOS, para que el cuadro de confirmacion diga a
      // donde va el paquete. Sin esto la clienta aprobaba un envio sin ver
      // el destino, y corregir la direccion no cambiaba el mensaje.
      datosDeEntrega: campos.soloConfirmado(conversacion.ficha),
      // Pregunto por una cantidad que la tabla no cubre: el texto lo dice
      // en vez de contestar con el precio de otra cantidad.
      cantidadSinTarifa,
      // Los datos que se acaban de CORREGIR, para que el resumen diga que
      // cambio en vez de salir calcado y parecer que no se leyo nada.
      cambiosAplicados: [...new Set([...(traza.cambiosAplicados || []), ...corregidosEnEsteTurno])],
      // Para no prometer fotos que la deduplicacion no va a reenviar.
      // El campo lo anota el envio por producto: `fotosEnviadas[productoId]`.
      // La señal de compra de ESTE turno o de cualquiera anterior.
      huboSenalDeCompra: conversacion.huboSenalDeCompra === true || loQuePregunta.compra === true,
      pideReenvioDeFotos: preguntas.pideReenvioDeFotos(evento.texto || "", {
        fotosRecientes: preguntas.fotosRecientes(
          ((conversacion.fotosEnviadas || {})[(producto || candidato || {}).id || conversacion.productoId] || {}).cuando || null
        ),
      }),
      fotosYaEnviadas: Boolean(
        (conversacion.fotosEnviadas || {})[(producto || candidato || {}).id || conversacion.productoId]
      ),
      // ¿Tiene el resumen del pedido en pantalla? Lo necesita el cierre: con
      // el resumen puesto, el unico paso que falta es el "sí", y ofrecerle
      // apartarlo otra vez es retroceder. Lo lee tambien `recordar.js`.
      resumenMostrado: conversacion.resumenMostrado === true,
      memoria: {
        saludado: conversacion.saludado === true,
        datosPedidos: conversacion.datosPedidos === true,
        pasoPropuesto: conversacion.pasoPropuesto === true,
        precioInformado: conversacion.precioInformado === true,
      },
    });

    // ------------------------------------------------------------------
    // GUARDA CONTRA EL ECO
    //
    // Se comprueba contra el historial ANTES de anotar el mensaje de este
    // turno, asi que `ultimoDelNegocio` es de verdad el anterior.
    //
    // Si el bot va a repetir palabra por palabra lo que acaba de decir, no
    // esta aportando nada: o cambia de frase, o para y llama a una persona.
    // En produccion salio el mismo parrafo tres veces seguidas.
    // ------------------------------------------------------------------
    const dichosAntes = atencionDeChat.mensajes(conversacion);
    const ultimoDelNegocio = [...dichosAntes]
      .reverse()
      .find((m) => m && m.de !== atencionDeChat.QUIEN.CLIENTE);
    // El ultimo mensaje del cliente EN EL HISTORIAL es el anterior a este:
    // el de ahora se anota mas abajo. Si trae los mismos temas, el cliente
    // pregunto lo mismo y repetir la respuesta es correcto.
    const previoDelCliente = [...dichosAntes]
      .reverse()
      .find((m) => m && m.de === atencionDeChat.QUIEN.CLIENTE);
    const temasAhora = responder.analizarTurno(evento.texto || "").lectura.temas;
    const temasAntes = previoDelCliente ? responder.analizarTurno(previoDelCliente.texto).lectura.temas : [];
    const turnoAhora = responder.analizarTurno(evento.texto || "");
    const turnoAntes = previoDelCliente ? responder.analizarTurno(previoDelCliente.texto) : null;

    const mismaPregunta =
      // Los mismos temas, o PARTE de ellos: la misma duda escrita de dos
      // formas. Antes se exigia que los conjuntos fueran identicos, y eso
      // dejaba fuera el caso mas comun de repregunta: "cuanto vale" ->
      // [precio] y luego "pero cuanto vale con el envio" -> [precio, envio].
      // Conjuntos distintos, misma duda, y la clienta acababa recibiendo
      // "dime qué necesitas" por insistir.
      (temasAhora.length > 0 && temasAntes.length > 0 && temasAhora.some((t) => temasAntes.includes(t))) ||
      // O DOS SALUDOS SEGUIDOS. Un saludo no tiene temas, asi que la regla
      // de arriba no lo cubria: en la captura de Marco, "Hola" y "Buenas
      // noches" seguidos acababan en "perdón, no quiero repetirme".
      // Saludar dos veces merece que te saluden dos veces.
      Boolean(turnoAhora.lectura.soloSaludo && turnoAntes && turnoAntes.lectura.soloSaludo);

    const noRepetir = responder.sinRepetir(preparada.texto, ultimoDelNegocio && ultimoDelNegocio.texto, {
      mismaPregunta,
      // Si se sabe que esta preguntando, se le contesta. Nunca se le pide
      // concretar a quien ya concreto.
      //
      // Y tampoco a quien acaba de DAR un dato: corregir la direccion es lo
      // mas concreto que puede hacer un cliente, y recibia "dime qué
      // necesitas" porque el cuadro de confirmacion salia igual que antes.
      //
      // ⚠️ NI A QUIEN ACABA DE DECIR QUE LO QUIERE. Añadido el 10-oct, y lo
      //    saco el chat de Santiago:
      //
      //   Santiago · "Mándamelo"   -> "dime el barrio, o un punto de
      //                               referencia"
      //   Santiago · "Envíamelo"   -> "Perdón, creo que no te entendí bien"
      //
      // Las dos son compra, las dos se entendieron perfectamente, y como el
      // texto que tocaba era el mismo -falta la direccion, se vuelve a
      // pedir- la guarda lo leyo como un bot atascado. Decirle "no te
      // entendí" a quien lleva dos mensajes diciendo que compra es la peor
      // respuesta posible en el mejor momento posible.
      //
      // Un turno reconocido como compra o como afirmacion del cierre ES un
      // turno entendido. Si hay que repetir, se repite con otra envoltura,
      // que es lo que hace `sinRepetir` cuando `preguntaReconocida` es true.
      preguntaReconocida:
        temasAhora.length > 0 ||
        datosAportados.length > 0 ||
        turnoAhora.lectura.compra === true ||
        afirmoElCierre,
    });

    // ------------------------------------------------------------------
    // UN STICKER REPETIDO NO ES UN BOT ATASCADO
    //
    // Medido el 09-oct, y hay dos chats reales del 08 con exactamente esto
    // (dos chats de stickers y dos chats de stickers): clientes que solo mandan stickers y
    // emojis. El texto llega VACIO, el bot contesta lo mismo las dos veces
    // -porque no hay nada nuevo que contestar- y la guarda anti-eco lo leia
    // como un bucle propio: "Perdón, no quiero repetirme", y a la siguiente
    // la pausa de 12 h.
    //
    // La guarda existe para cazar al bot repitiendose ante preguntas
    // DISTINTAS. Si el cliente no ha dicho nada, no hay dos preguntas
    // distintas: hay un cliente mirando. Repetir una invitacion amable es
    // lo correcto; cortarle la conversacion y llamar a una persona porque
    // mando dos caritas, no.
    // ------------------------------------------------------------------
    const clienteNoDijoNada = !String(evento.texto || "").replace(/[^\p{L}\p{N}]/gu, "").trim();

    // ------------------------------------------------------------------
    // NI "NO TE ENTENDI" A QUIEN SOLO FUE AMABLE, NI EL MISMO TEXTO DOS
    // VECES A QUIEN MANDO UN STICKER. Puntos 6 y 8 de Marco.
    //
    // Dos casos reales del 09-oct, con la misma raiz: un mensaje que no
    // aporta nada que contestar.
    //
    //   ANDRE     · "Por favor"   (tras pedirle el barrio)
    //               -> "Perdón, creo que no te entendí bien"
    //   José Polo · un sticker, y otro
    //               -> "¡Gracias! 🙌 ¿Me cuentas por escrito...?" DOS VECES,
    //                  y a la tercera con "Te confirmo 👇" delante.
    //
    // "Por favor" se entiende perfectamente: es un sí cortés a lo que se le
    // acaba de pedir. Y dos stickers no son un bot atascado.
    //
    // En los dos casos lo correcto es lo mismo: RETOMAR EL PASO. Pedir UN
    // dato, el primero que falte, en vez de disculparse o repetirse.
    // ------------------------------------------------------------------
    // ⚠️ Y SOLO CUANDO LA ALTERNATIVA ES MALA. La primera version de esta
    //    guarda se disparaba en todos los turnos sin tema y pisaba tres
    //    respuestas buenas, que las pruebas cazaron:
    //
    //      · el AUDIO, que tiene su propio mensaje ("mándamelo por escrito")
    //        y pasaba a recibir "¿para qué ciudad sería?";
    //      · el "?" suelto, que se reorienta a proposito;
    //      · "Si claro por favor", que SI es una señal de compra y merece la
    //        pedida de datos completa, no una pregunta de un solo campo.
    //
    // La leccion: esto no es "que decir cuando el mensaje es flojo", es "que
    // decir en vez de disculparse o repetirse". Solo entra ahi.
    const soloFueAmable =
      !clienteNoDijoNada &&
      !loQuePregunta.temas.length &&
      !datosAportados.length &&
      // Una señal de compra NO es "solo ser amable": se le piden los datos.
      !loQuePregunta.compra &&
      confirmacion.esAfirmacionDeCierre(evento.texto || "");
    const faltanAhora = traza.faltan || [];
    // Un audio o una foto tienen su propia respuesta: no se pisan.
    const sinTextoDeVerdad = Boolean(evento.media && evento.media.tipo);
    // La alternativa real: o la guarda anti-eco ya salto, o el texto iba a
    // ser la disculpa.
    const laAlternativaEsMala =
      noRepetir.repetido === true ||
      String(preparada.texto || "").includes(responder.PEDIR_CONCRETAR.slice(0, 30));

    if (
      (clienteNoDijoNada || soloFueAmable) &&
      !sinTextoDeVerdad &&
      laAlternativaEsMala &&
      faltanAhora.length &&
      situacion === "faltan_datos"
    ) {
      const retomado = responder.retomarElPaso(
        faltanAhora,
        campos.valorConfirmado(conversacion.ficha && conversacion.ficha.nombre)
      );
      if (retomado && retomado.trim() && retomado.trim() !== String(preparada.texto || "").trim()) {
        preparada.texto = retomado;
        noRepetir.repetido = false;
        noRepetir.escalar = false;
        contar("paso_retomado");
        traza.avisos.push(
          clienteNoDijoNada
            ? "el cliente no dijo nada: se retoma el paso en vez de repetir"
            : "solo fue amable: se retoma el paso en vez de decirle que no se le entendio"
        );
      }
    }

    if (clienteNoDijoNada) {
      noRepetir.repetido = false;
      noRepetir.escalar = false;
    }

    // ======================================================================
    // PROHIBIDO MANDAR DOS VECES SEGUIDAS EL MISMO TEXTO. SIN EXCEPCIONES.
    //
    // Lo puso Marco en la lista de NUNCA: "Enviar el mismo mensaje dos veces
    // seguidas". Y su caso 12 es exactamente eso:
    //
    //   cliente · "Hola"
    //   bot     · "¡Hola, Santiago! ¿En qué te puedo ayudar? 😊"
    //   cliente · "Hola?"
    //   bot     · "¡Hola, Santiago! ¿En qué te puedo ayudar? 😊"
    //
    // La guarda anti-eco tenia una excepcion deliberada para esto -"saludar
    // dos veces merece que te saluden dos veces"- y era razonable en su
    // momento. Pero el "Hola?" con interrogacion no es un saludo: es alguien
    // comprobando si hay alguien del otro lado. Recibir el mismo mensaje
    // calcado le confirma que esta hablando con una maquina.
    //
    // Esta guarda va AL FINAL, despues de `sinRepetir`, y es la ultima red:
    // si por cualquier camino el texto sale identico al anterior, se cambia
    // por el siguiente paso del pedido — que es lo que de verdad hace falta.
    // ======================================================================
    // ⚠️ SE VARIA EL MENSAJE, NO SE QUITA LA RESPUESTA. Y esta distincion es
    //    la que hace que esta guarda sea segura.
    //
    // La primera version sustituia el texto repetido por "¿Te lo aparto?", y
    // rompio tres pruebas que protegen algo importante: si el cliente
    // pregunta DOS VECES LO MISMO, repetir la respuesta correcta no es un
    // eco, es contestarle. Este repositorio ya lo aprendio caro con el
    // "cuánto vale" preguntado tres veces.
    //
    // Asi que hay dos casos distintos:
    //
    //   · el texto repetido LLEVA INFORMACION (un precio, un dato) -> se
    //     mantiene entero y se le pone un reconocimiento delante. El mensaje
    //     deja de ser identico y la clienta recibe su respuesta.
    //   · el texto repetido era el SALUDO generico -> ahi no hay nada que
    //     conservar: se retoma el paso del pedido, que es lo que falta.
    const ultimoTexto = ((ultimoDelNegocio && ultimoDelNegocio.texto) || "").trim();
    // Y NO se toca si el cliente APORTO UN DATO en este turno: ahi repetir
    // el cuadro de confirmacion es lo correcto, porque el cuadro cambio -o
    // porque la clienta acaba de confirmar con sus palabras algo que el
    // codigo habia asumido-. Es el caso de "uno" despues de que el bot
    // preguntara "¿uno o dos?".
    const aportoAlgo = datosAportados.length > 0;
    if (!aportoAlgo && preparada.texto && ultimoTexto && preparada.texto.trim() === ultimoTexto && !noRepetir.repetido) {
      const esSaludoGenerico = /en qu[eé] te puedo ayudar/i.test(ultimoTexto);
      const nombre = campos.valorConfirmado(conversacion.ficha && conversacion.ficha.nombre);

      if (esSaludoGenerico) {
        const retomado = responder.retomarElPaso(traza.faltan || [], nombre);
        if (retomado && retomado.trim() !== ultimoTexto) {
          traza.avisos.push("el saludo salia identico al anterior: se retoma el paso del pedido");
          contar("respuesta_repetida_evitada");
          preparada.texto = retomado;
        }
      } else {
        traza.avisos.push("el texto salia identico al anterior: se reconoce y se repite el dato");
        contar("respuesta_repetida_evitada");
        preparada.texto = `Te confirmo 👇 ${preparada.texto}`;
      }
    }

    if (noRepetir.repetido) {
      preparada.texto = noRepetir.texto;
      contar("respuesta_repetida_evitada");
      traza.avisos.push(
        `se iba a repetir el mismo texto: se cambio${noRepetir.escalar ? " y se pasa a una persona" : ""}`
      );
      registrar("warn", "respuesta_repetida_evitada", {
        wamid: evento.wamid,
        situacion,
        escalado: noRepetir.escalar,
      });

      // Dos veces en el mismo sitio: el bot no va a resolverlo. Se toma el
      // chat para que una persona lo vea en el panel, y el bot se calla.
      if (noRepetir.escalar) {
        // ⚠️ AQUI TAMBIEN SE QUITO LA PAUSA AUTOMATICA (2026-10-09).
        //
        // El bucle se corta igual -el texto cambia y queda la tarea- pero el
        // bot NO se calla. La regla de Marco: "no entiendes el mismo mensaje
        // 2 veces seguidas" es motivo para AVISAR a una persona, no para
        // dejar de atender. Si el cliente escribe despues "listo, lo
        // quiero", hay que podersela vender.
        contar("escalado_a_persona");
        // Y queda la tarea, con la pregunta que el bot no supo resolver.
        // Pausar el chat sin anotar la pregunta obligaba a leer el
        // historial entero para saber que faltaba contestar.
        atencionDeChat.anotarPendiente(conversacion, {
          motivo: atencionDeChat.MOTIVOS_PENDIENTE.NO_SUPO,
          pregunta: evento.texto || "",
        });
      }
    }

    // ------------------------------------------------------------------
    // LO QUE SE PROMETE, QUEDA ANOTADO
    //
    // Cada vez que el bot dice que una persona lo revisa, aqui queda una
    // tarea con el motivo y la pregunta. Antes la frase salia sola y no
    // generaba nada: el cliente esperaba una respuesta que nadie sabia que
    // tenia que dar.
    // ------------------------------------------------------------------
    const preguntoAlgoNoCatalogado =
      !loQuePregunta.compra && !loQuePregunta.temas.length && loQuePregunta.pareceUnaPregunta && !loQuePregunta.soloSaludo;

    // Preguntar por una cantidad sin tarifa es una venta MAYOR que la que
    // tenemos aprobada: quien pide tres se lleva mas que quien pide uno.
    // No se puede cotizar, pero perderla por no anotarla seria tonto.
    if (cantidadSinTarifa) {
      atencionDeChat.anotarPendiente(conversacion, {
        motivo: atencionDeChat.MOTIVOS_PENDIENTE.SIN_DATO,
        pregunta: `pregunta el precio por ${cantidadSinTarifa} unidades: "${evento.texto || ""}"`,
      });
    }

    // LO QUE SE PROMETE, QUEDA ANOTADO — AHORA MIRANDO LA PROMESA.
    //
    // La condicion era `situacion === "escalado" || preguntoAlgoNoCatalogado`,
    // y el segundo termino es un proxy que dejo de valer al añadir los
    // dieciseis temas del 09-oct: "¿a cuántos grados llega?" YA tiene tema,
    // asi que no abria tarea, y sin embargo la respuesta dice "los confirmo
    // con el equipo y te cuento". Una promesa que no deja tarea es una
    // promesa que nadie va a cumplir, y el cliente se queda esperando.
    //
    // Se mira el TEXTO PREPARADO, que es donde esta la promesa. Y se
    // conserva `preguntoAlgoNoCatalogado`: una pregunta que no se entendio
    // tiene que verla una persona aunque el texto no prometa nada.
    const prometioConfirmar = contestar.prometeConfirmar(preparada.texto);
    // ------------------------------------------------------------------
    // LA RESPUESTA DE RESERVA TAMBIEN DEJA NOTA, Y SIN FRENAR AL CLIENTE.
    //
    // Al borrar el "no te la quiero contestar a medias" (10-oct) se perdia
    // la unica señal que abria la tarea: el texto ya no promete nada, asi
    // que `prometeConfirmar` no lo ve.
    //
    // Pero la nota sigue valiendo. Marco lo pidio asi: "dejar una nota
    // interna, sin frenar el bot". Cada una de estas es una pregunta que el
    // catalogo no cubre, y la bandeja es donde se ve QUE hay que añadirle.
    // De las siete del 09-oct, cinco se podian contestar con datos que ya
    // existian: la bandeja es justo lo que habria hecho verlo antes.
    // ------------------------------------------------------------------
    const salioLaReserva = contestar.esReservaDeVenta(preparada.texto);
    if (situacion === "escalado" || preguntoAlgoNoCatalogado || prometioConfirmar || salioLaReserva) {
      atencionDeChat.anotarPendiente(conversacion, {
        motivo: atencionDeChat.MOTIVOS_PENDIENTE.SIN_DATO,
        pregunta: evento.texto || "",
      });
      if (prometioConfirmar && !preguntoAlgoNoCatalogado) contar("promesa_anotada");
      if (salioLaReserva) contar("respuesta_de_reserva");
    }

    // ------------------------------------------------------------------
    // TRAS ESCALAR, EL BOT SE CALLA. ASI LO HACE BIKERPRO.
    //
    // Leido del panel de produccion, en el chat de Marco: la rama de
    // escalado tenia UNA frase, la repetia siempre, la guarda anti-eco la
    // cambiaba por "no quiero repetirme", y al turno siguiente volvia la
    // primera. Dos protecciones peleandose, un bucle infinito, y un
    // cliente convencido de que el bot esta roto.
    //
    // BIKERPRO lo resuelve con `##HANDOFF##`: avisa UNA vez y deja de
    // responder. Un bot que insiste sin aportar nada es peor que uno
    // callado — el silencio se lee como "me estan mirando el caso", el
    // bucle como "esto no funciona".
    //
    // La pausa es lo que produce el silencio de verdad: el emisor la
    // comprueba justo antes de escribir a la red, asi que no se puede
    // colar otro mensaje. Y caduca a las 12 h, asi que si nadie lo
    // atiende el bot retoma en vez de quedarse mudo para siempre.
    //
    // NO se pausa por `preguntoAlgoNoCatalogado`: ahi el bot SI puede
    // seguir vendiendo, solo le falta un dato. Pausar por una duda suelta
    // dejaria el chat sin bot por una pregunta sobre el material.
    // ------------------------------------------------------------------
    // ¿Estaba YA pausado al llegar este mensaje? Es lo que separa el primer
    // aviso -que SI se manda- del bucle -que no-.
    const estabaPausadoAlEmpezar = atencionDeChat.leer(conversacion).pausado === true;

    // ======================================================================
    // ESCALAR YA NO CALLA AL BOT. LO PIDIO MARCO, Y ESTABA COSTANDO VENTAS.
    //
    // Aqui habia un `pausado: true` automatico: cualquier escalado dejaba el
    // chat mudo 12 horas. La idea venia de BIKERPRO y era razonable -que el
    // bot no hable por encima de una persona-, pero en la practica hacia
    // justo lo contrario de lo que se buscaba.
    //
    // LO QUE MEDIMOS EN EL PANEL:
    //
    //   · escalados de las 08:49 y las 18:52 se contestaron a las 13:13 y
    //     19:45. Entre cuatro y cinco horas. Durante todo ese rato el bot
    //     estaba mudo y el cliente escribiendo.
    //   · un cliente escribio "Por favor" y no recibio nada.
    //   · otro mando su direccion completa y tampoco.
    //
    // Marco lo dijo asi: "no pausar el flujo de venta. Si el cliente sigue
    // escribiendo cosas de compra, el bot sigue atendiendo".
    //
    // LA DISTINCION QUE ARREGLA LAS DOS COSAS A LA VEZ:
    //
    //   escalar  = AVISAR a una persona. Queda la tarea en la bandeja, y el
    //              bot sigue vendiendo mientras alguien llega.
    //   pausar   = que una persona TOME el chat. Es una decision humana,
    //              explicita, desde el boton "Tomar el control" del panel.
    //
    // Antes el bot decidia callarse solo. Ahora solo se calla cuando alguien
    // de verdad entro, que es cuando el riesgo de las dos voces existe. Un
    // bot callado esperando a nadie no protege nada: pierde al cliente.
    //
    // El ESTADO sigue pasando a ESCALADO y la tarea sigue abriendose, asi
    // que el chat aparece igual en /panel/sin-responder.
    // ======================================================================
    // ======================================================================
    // ⚠️ CORRECCION DEL 10-OCT: CUANDO EL BOT PASA EL CASO A UNA PERSONA, SE
    //    CALLA. Lo pidio Marco, y cierra la otra mitad de esta decision.
    //
    // El bloque de arriba sigue siendo verdad para el MANUAL: que una
    // persona escriba un mensaje NO calla al bot. Eso se quito hoy de
    // `panel/rutas.js` y es lo que costo el chat de Popayan.
    //
    // Pero hay un caso en el que callarse SI es lo correcto, y es este: el
    // bot acaba de decirle al cliente, con sus palabras, "te paso con una
    // persona del equipo". Seguir vendiendo detras de esa frase la convierte
    // en mentira. Marco lo dijo asi: «a menos de que yo lo silencie, o
    // cuando ya la respuesta del bot literalmente es que estamos pasándolo
    // al humano».
    //
    // POR QUE AHORA ES SEGURO Y EL 09-OCT NO LO ERA. No ha cambiado la idea,
    // ha cambiado CUANTO se escala. El 09-oct cualquier pregunta sin tema
    // acababa en escalado -29 de 65 respuestas malas, 7 con pausa- asi que
    // pausar al escalar equivalia a pausar por cualquier cosa. Hoy el
    // sondeo da 5 de 65 y los cinco son legitimos: pide una persona, reclama
    // garantia, esta molesto, o pide al mayor. En esos cinco, el bot callado
    // es lo correcto.
    //
    // LA RED QUE SE MANTIENE, y hay que decirla porque el riesgo medido
    // sigue ahi: los escalados del 08-oct tardaron entre 4 y 5 horas en
    // contestarse. Durante ese rato este chat queda mudo. Lo que lo limita:
    //   · la pausa CADUCA (HORAS_DE_PAUSA, 12 h por defecto);
    //   · el chat sale en /panel/sin-responder desde el primer minuto;
    //   · y "Devolver al bot" lo reactiva en un clic.
    // ======================================================================
    if (situacion === "escalado") {
      contar("escalado_a_persona");
      // `por: "bot"` distingue en el panel quien se llevo el chat: no fue un
      // operador pulsando un boton, fue el bot admitiendo que esto no lo
      // contesta el. Con `desde` arranca el reloj de la caducidad.
      conversacion.atencion = {
        ...atencionDeChat.leer(conversacion),
        pausado: true,
        por: "bot",
        desde: new Date().toISOString(),
      };
      contar("pausado_por_escalado");
      traza.avisos.push("escalado: el bot paso el caso a una persona y se calla en este chat");
    }

    if (situacion === "ya_confirmado" && (loQuePregunta.compra || loQuePregunta.quiereOtro) && !traza.cambioDeCantidad) {
      // Quiere otro teniendo uno confirmado. El bot NO abre el pedido -eso
      // es lo que casi despacho un paquete que nadie pidio en BIKERPRO-
      // pero la intencion de comprar mas no se puede perder.
      atencionDeChat.anotarPendiente(conversacion, {
        motivo: atencionDeChat.MOTIVOS_PENDIENTE.OTRA_COMPRA,
        pregunta: evento.texto || "",
      });
    }

    contar("respuesta_preparada");
    for (const b of preparada.bloqueos) {
      if (b.tipo === responder.BLOQUEOS.IMPORTE_NO_AUTORIZADO) contar("importe_no_autorizado_bloqueado");
      if (b.tipo === responder.BLOQUEOS.CLAIM_PROHIBIDO) contar("claim_prohibido_bloqueado");
    }
    traza.respuesta = { texto: preparada.texto, origen: preparada.origen, situacion };
    traza.bloqueos = preparada.bloqueos;

    // ------------------------------------------------------------------
    // SI YA SE ESCALO, NO SE MANDA NADA MAS
    //
    // El emisor comprueba la pausa leyendola del almacen, y la pausa de
    // ESTE turno todavia no esta guardada -se guarda al final-, asi que
    // por ahi no se corta el bucle. Se corta aqui, con el estado en la
    // mano: ya se le aviso una vez, el chat esta en la bandeja de una
    // persona, y cualquier mensaje mas es el bucle que Marco vio.
    //
    // La pausa caduca a las 12 h, asi que si nadie lo atiende el bot
    // retoma en vez de quedarse mudo para siempre.
    // ------------------------------------------------------------------
    // ⚠️ `estabaPausadoAlEmpezar` YA NO SIGNIFICA "el bot se escalo solo".
    //
    // Desde el 09-oct el bot no se pausa nunca por su cuenta: la pausa solo
    // la pone una PERSONA desde el panel ("Tomar el control"). Asi que esto
    // dejo de ser "el bot espera a que alguien llegue" y pasa a ser "alguien
    // ya esta escribiendo en este chat, no hables por encima".
    //
    // El candado de verdad esta en el emisor, que comprueba la pausa justo
    // antes de salir a la red. Esto es la red de seguridad del turno.
    const yaEscalado = estabaPausadoAlEmpezar && situacion === "escalado";
    if (yaEscalado) {
      traza.avisos.push("una persona tiene el chat: el bot no escribe por encima");
      traza.enviada = false;
      traza.bloqueoDeEnvio = "escalado_esperando_persona";
      contar("silencio_por_escalado");
    }

    if (emisor && config.respuestaAutomatica && !yaEscalado) {
      const envio = await emisor.enviarTexto({
        para: evento.telefono || evento.idCliente,
        texto: preparada.texto,
        permiso: PERMISOS.CONVERSACION,
        // Con esto el emisor puede comprobar la pausa justo antes de
        // escribir a la red. Sin el id no hay nada que consultar.
        conversacionId: conversacion.contactoId,
      });
      traza.enviada = envio.enviado === true;
      traza.bloqueoDeEnvio = envio.bloqueado ? envio.motivo : null;
      // Si no tiene telefono, el bot NO puede responderle nunca. No es un
      // fallo que se reintente: es un cliente que hay que atender a mano,
      // y tiene que verse en el panel.
      if (envio.motivo === "destinatario_sin_telefono") {
        atencionDeChat.anotarPendiente(conversacion, {
          motivo: atencionDeChat.MOTIVOS_PENDIENTE.SIN_TELEFONO,
          pregunta: evento.texto || "",
        });
        contar("cliente_sin_telefono");
      }
    }

    // ------------------------------------------------------------------
    // LAS FOTOS DEL PRODUCTO
    //
    // Van DESPUES del texto, y a proposito: el texto dice "te muestro las
    // fotos", asi que primero llega la frase y luego las imagenes. Al
    // reves, el cliente ve cinco fotos sin contexto.
    //
    // Se mandan cuando se SABE de que producto habla, aunque ese producto
    // este en borrador: una foto no afirma un precio ni una
    // caracteristica, asi que es lo unico de la conversacion que no
    // depende de la ficha.
    //
    // Todos los candados estan en enviarFotosDeProducto y en el emisor:
    // interruptor, pausa del chat, formato de la imagen, y la guarda para
    // no repetirlas. Aqui solo se decide CUANDO tiene sentido ofrecerlas.
    // ------------------------------------------------------------------
    const productoParaFotos = producto || candidato;

    // ------------------------------------------------------------------
    // CUANDO TIENE SENTIDO MANDAR LAS FOTOS
    //
    // Antes la condicion era `producto_en_borrador || cotizacion`, y tenia
    // DOS fallos que solo se veian al activar un producto:
    //
    //   1. "cotizacion" no existe. `avanzarVenta` nunca devuelve esa
    //      situacion -devuelve faltan_datos o resumen-, asi que esa mitad
    //      de la condicion nunca se cumplia.
    //   2. Por tanto, con el producto ACTIVO las fotos no salian nunca. El
    //      mismo mensaje que las recibia en borrador ("muestrame fotos del
    //      cinturon") cae en faltan_datos al activarlo, y activar el
    //      producto habria apagado las fotos sin que nadie lo notara.
    //
    // Ahora manda el cliente, no el punto de la venta: si pide ver el
    // producto, se le muestra. Sigue mandandolas sin pedirlas mientras el
    // producto esta en borrador, porque ahi el texto se las promete.
    //
    // Lo que NO se hace: mandarlas cuando no se sabe de que producto se
    // habla. Con dos candidatos o ninguno, cinco fotos del producto
    // equivocado confunden mas que preguntar.
    // ------------------------------------------------------------------
    const pidioVerlo = texto.pideFotos(evento.texto || "");
    // "No me cargaron" es un acto explicito: ahi SI se repiten. La
    // deduplicacion evita llenar la pantalla sin que nadie lo pida; no
    // puede ganarle a un cliente que dice que no las recibio, porque el
    // propio mensaje le ofrece reenviarlas.
    // El contexto: ¿se le mandaron fotos hace poco? Sin esto, "no las veo"
    // referido a cualquier otra cosa disparaba cinco imagenes.
    const idParaFotos = (productoParaFotos && productoParaFotos.id) || conversacion.productoId;
    const cuandoFotos =
      ((conversacion.fotosEnviadas || {})[idParaFotos] || {}).cuando || null;
    const pidioReenvio = preguntas.pideReenvioDeFotos(evento.texto || "", {
      fotosRecientes: preguntas.fotosRecientes(cuandoFotos),
    });

    // ------------------------------------------------------------------
    // SI EL MENSAJE PROMETE FOTOS, LAS FOTOS SALEN
    //
    // Esta condicion cierra el defecto de raiz en vez de caso por caso.
    // Volvio a aparecer al mejorar la respuesta de "¿para qué sirve?": el
    // texto decia "te paso las fotos para que lo veas bien" y no salia
    // ninguna, porque esa pregunta no activaba `pideFotos`.
    //
    // Es el mismo fallo que ya se habia corregido una vez, reintroducido
    // por otro camino — señal de que la condicion estaba en el sitio
    // equivocado. Mirando el TEXTO YA PREPARADO, el mensaje y las fotos no
    // se pueden desalinear: cualquier frase futura que las prometa las
    // manda, sin que nadie tenga que acordarse de añadir su caso aqui.
    // ------------------------------------------------------------------
    const textoPrometeFotos = /\bfotos?\b/i.test(preparada.texto || "");
    // El arranque las anuncia ("Te muestro las fotos"), asi que tienen que
    // salir. Si no, el primer mensaje promete algo que no llega.
    const turnoDeFotos = responder.analizarTurno(evento.texto || "");
    const esArranque = turnoDeFotos.lectura.soloSaludo && conversacion.saludado !== true;
    const sabemosDeQueProducto = situacion !== "producto_ambiguo" && situacion !== "producto_desconocido";

    if (
      emisor &&
      config.respuestaAutomatica &&
      productoParaFotos &&
      (productoParaFotos.imagenes || []).length &&
      sabemosDeQueProducto &&
      (situacion === "producto_en_borrador" || pidioVerlo || pidioReenvio || esArranque || textoPrometeFotos)
    ) {
      const informeFotos = await fotos.enviarFotosDeProducto({
        emisor,
        repos,
        producto: productoParaFotos,
        conversacion,
        para: evento.telefono || evento.idCliente,
        permiso: PERMISOS.CONVERSACION,
        pie: "",
        // Lo pidio: se repiten.
        forzar: pidioReenvio,
        // ----------------------------------------------------------------
        // TRES FOTOS, NO CINCO. Y el tope lo pidio Marco.
        //
        // Cinco imagenes seguidas detras del primer mensaje llenan la
        // pantalla del movil y empujan el texto -con el precio y la
        // pregunta de cierre- fuera de la vista. Medido en el panel: de 25
        // chats, 10 clientes recibieron ese primer mensaje con las cinco
        // fotos y NO VOLVIERON A ESCRIBIR.
        //
        // Cuales son las tres lo decide el ORDEN del catalogo, no este
        // numero: frente encendido, puesto, y con su caja. El detalle de la
        // pantalla y la correa quedan al final de la lista y se pueden
        // mandar desde el panel.
        // ----------------------------------------------------------------
        max: 3,
      });
      traza.fotos = {
        enviadas: informeFotos.enviadas,
        de: informeFotos.cuantas,
        repetido: informeFotos.repetido,
        problemas: informeFotos.problemas,
      };
      // Si el texto prometia fotos y no salio ninguna, hay que verlo: el
      // cliente se quedo esperando.
      if (informeFotos.enviadas === 0 && !informeFotos.repetido) {
        traza.avisos.push(`se anunciaron fotos y no salio ninguna: ${informeFotos.problemas.join("; ")}`);
      }
    }

    // ------------------------------------------------------------------
    // Guardar
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // LO QUE YA SE LE DIJO
    //
    // Se anota SOLO si el mensaje SALIO. En modo sombra el texto se prepara y
    // no se envia: darlo por dicho haria que al encender el interruptor el
    // cliente nunca reciba el saludo ni el precio, porque el bot creeria que
    // ya los dijo.
    // ------------------------------------------------------------------
    if (traza.enviada) {
      const turno = responder.analizarTurno(evento.texto || "");
      conversacion.saludado = true;
      if (traza.cotizacionInformativa || traza.cotizacion) conversacion.precioInformado = true;
      // ¿Mostro intencion de comprar ALGUNA VEZ? Es lo que distingue a
      // quien escribe su ciudad porque esta comprando de quien la escribe
      // para saber si le llega. Se guarda y no se borra: una vez que dijo
      // que lo quiere, sigue siendo verdad en el turno siguiente.
      if (loQuePregunta.compra) conversacion.huboSenalDeCompra = true;
      // ----------------------------------------------------------------
      // QUE CANTIDAD SE LE INFORMO
      //
      // Sin esto se perdia la venta del combo, y asi:
      //
      //   clienta: "¿cuánto me salen dos?"
      //   bot:     "2 unidades te quedan en $85.000..."
      //   clienta: "las quiero"
      //   bot:     "¿Cuántos quieres?"        <- acaba de decirlo
      //
      // "las quiero" no trae ningun numero, asi que el extractor no saca
      // cantidad — y hace bien, no la hay. La cantidad estaba en el TURNO
      // ANTERIOR, en lo que el bot informo. Guardarla es lo que permite
      // entender un "las quiero" sin volver a preguntar.
      // ----------------------------------------------------------------
      const informada = traza.cotizacionInformativa || traza.cotizacion;
      if (informada && informada.cantidad > 1) conversacion.cantidadInformada = informada.cantidad;

      // ----------------------------------------------------------------
      // ⚠️ ESTAS DOS LINEAS ESTABAN FUERA DEL BLOQUE, Y UNA DE ELLAS NO
      //    HACIA LO QUE DICE. Arreglado el 10-oct.
      //
      // Vivian detras del cierre del `if (traza.enviada)`, con la
      // indentacion de dentro pero el alcance de fuera. Dos consecuencias:
      //
      // 1. `turno` se declara con `const` DENTRO de este bloque, asi que
      //    ahi fuera no existia... pero no explotaba: `turno` resolvia al
      //    NOMBRE DE ESTA MISMA FUNCION (`async function turno`), que es
      //    visible en su propio cuerpo. Y `funcion.soloAveriguando` es
      //    `undefined`, asi que `!turno.soloAveriguando` era SIEMPRE true:
      //    la guarda estaba muerta y `datosPedidos` se marcaba tambien
      //    cuando el cliente solo estaba averiguando. Por eso no aparecia
      //    en las metricas: no hay error, hay una condicion que no condiciona.
      //
      // 2. `pasoPropuesto` se ponia a true en TODOS los turnos, incluso con
      //    el mensaje sin enviar (modo sombra o chat pausado). Y como
      //    `INVITAR` solo sale `if (!memoria.pasoPropuesto)`, la invitacion
      //    desaparecia desde el segundo mensaje de la conversacion.
      //
      // Ahora las dos van dentro, con `turno` en su alcance de verdad, y
      // `pasoPropuesto` refleja lo que se PROPUSO de verdad.
      // ----------------------------------------------------------------
      if (situacion === "faltan_datos" && !turno.soloAveriguando) conversacion.datosPedidos = true;
      conversacion.pasoPropuesto = true;

      // ¿Este mensaje le hizo una pregunta de cierre? Es la memoria que
      // permite entender el "si" del turno siguiente. Se reescribe en cada
      // turno enviado: si el ultimo mensaje no cerro, la bandera baja y un
      // "listo" vuelve a no significar nada.
      conversacion.cierrePropuesto = responder.prometeCierre(preparada.texto || "");
    }

    conversacion.ventana = [...(conversacion.ventana || []), { texto: evento.texto || "", wamid: evento.wamid }].slice(-8);
    conversacion.ultimoWamid = evento.wamid;

    // ------------------------------------------------------------------
    // CUANDO ESCRIBIO EL CLIENTE POR ULTIMA VEZ, EN SU PROPIO CAMPO.
    //
    // Existe por los RECORDATORIOS y por la VENTANA DE 24 H, que necesitan
    // esta marca para no escribirle fuera de plazo. Y no se saca del
    // historial a proposito: `atencion` lo recorta a los ultimos 60
    // mensajes, asi que en un chat largo donde los ultimos sesenta son del
    // bot y del operador, el mensaje del cliente SE CAE de la lista.
    //
    // Buscarlo alli devolveria "no se sabe" justo en los chats mas
    // trabajados, que son los que mas cerca estan de cerrar. Un campo
    // propio no se recorta nunca.
    //
    // Se escribe SIEMPRE, enviada o no la respuesta: el cliente escribio,
    // y eso es un hecho suyo que no depende de lo que hiciera el bot.
    // ------------------------------------------------------------------
    conversacion.ultimoDelClienteEn = new Date().toISOString();

    // Historial para el panel. `ventana` no sirve: son solo los ultimos
    // textos del cliente, sin direccion ni hora, y existe para resolver el
    // producto. El panel necesita la conversacion como la ve una persona.
    atencionDeChat.anotarMensaje(conversacion, {
      de: atencionDeChat.QUIEN.CLIENTE,
      texto: evento.texto || "",
      wamid: evento.wamid,
    });
    if (preparada.texto) {
      atencionDeChat.anotarMensaje(conversacion, {
        de: atencionDeChat.QUIEN.BOT,
        texto: preparada.texto,
        // El estado dice la VERDAD de lo que paso con ese texto: si salio,
        // si lo freno un interruptor, o si lo freno la pausa. En modo
        // sombra se prepara y no se envia, y el panel lo tiene que mostrar
        // asi en vez de dar a entender que el cliente lo leyo.
        estado: traza.enviada ? "enviado" : traza.bloqueoDeEnvio || "preparado_sin_enviar",
      });
    }

    await repos.conversaciones.guardar(conversacion);

    // Registro del modo sombra. El texto preparado SI se guarda -es lo que
    // hay que auditar- pero en el diario, que vive en el disco privado del
    // servicio, no en los logs del hosting.
    anotar("turno_procesado", {
      wamid: evento.wamid,
      estadoPrevio: traza.estadoPrevio,
      estadoNuevo: traza.estadoNuevo,
      productoId: conversacion.productoId,
      productoOrigen: resolucion.origen,
      intencion: traza.intencion,
      accion: traza.accion,
      situacion,
      respuestaPreparada: preparada.texto,
      respuestaOrigen: preparada.origen,
      bloqueos: preparada.bloqueos,
      enviada: traza.enviada,
      pedido: traza.pedido,
      total: conversacion.cotizacion ? conversacion.cotizacion.total : null,
      avisos: traza.avisos,
    });

    // En los logs, nada de contenido: solo lo que permite diagnosticar.
    registrar("info", "turno", {
      wamid: evento.wamid,
      estado: traza.estadoNuevo,
      accion: traza.accion,
      situacion,
      productoId: conversacion.productoId,
      origenRespuesta: preparada.origen,
      bloqueos: preparada.bloqueos.length,
      enviada: traza.enviada,
    });

    return traza;
  }

  // ----------------------------------------------------------------------
  // Sub-acciones
  // ----------------------------------------------------------------------

  function avanzarVenta({ conversacion, producto, resolucion, candidato = null, evento = {} }) {
    if (resolucion.ambiguo) {
      return { situacion: "producto_ambiguo", estadoDestino: estados.ESTADOS.EXPLORANDO, cotizacion: null, faltan: [] };
    }

    // Se sabe que producto es, pero esta en borrador: no se puede cotizar y
    // NO se vuelve a preguntar. Se explica.
    if (!producto && candidato) {
      return {
        situacion: "producto_en_borrador",
        estadoDestino: estados.ESTADOS.PRODUCTO_IDENTIFICADO,
        cotizacion: null,
        faltan: [],
      };
    }

    if (!producto) {
      return { situacion: "producto_desconocido", estadoDestino: estados.ESTADOS.EXPLORANDO, cotizacion: null, faltan: [] };
    }

    const cot = intentarCotizar(conversacion, producto);

    if (!cot.ok) {
      if (cot.escalar) {
        return { situacion: "escalado", estadoDestino: estados.ESTADOS.ESCALADO, cotizacion: null, faltan: cot.falta || [] };
      }
      // Faltan datos: se piden, no se inventan.
      const requeridos = [...new Set([...REQUERIDOS_BASE, ...(producto.datosRequeridos || []), "cantidad"])];
      const faltan = [...new Set([...(cot.falta || []), ...campos.faltantes(conversacion.ficha, requeridos)])];

      // ----------------------------------------------------------------
      // PRECIO DE UNA UNIDAD, A TITULO INFORMATIVO
      //
      // Si lo unico que impide cotizar es que no se sabe CUANTAS quiere,
      // el precio de una unidad si se puede decir, y hay que decirlo: a
      // "¿cuánto cuesta?" el bot contestaba "me falta la ciudad y la
      // direccion", que es pedirle los datos a alguien que todavia no
      // sabe el precio.
      //
      // Se calcula con el cotizador -nunca a mano- para que la cifra
      // venga del catalogo y entre en la lista de importes autorizados.
      //
      // NO se guarda en la conversacion y NO crea ofertaId ni marca
      // resumenMostrado. Es la diferencia entre informar y ofertar: un
      // "si" a este mensaje no confirma nada, porque la confirmacion
      // exige un resumen mostrado.
      // ----------------------------------------------------------------
      // Se informa UNA vez, no en cada turno: repetir la misma frase ante
      // tres preguntas distintas parece un bot averiado. Salvo que vuelvan a
      // preguntar el precio, que entonces hay que volver a decirlo.
      const vuelveAPreguntar = texto.preguntaPrecio(evento.texto || "");
      let cotizacionInformativa = null;
      if (faltan.includes("cantidad") && (!conversacion.precioInformado || vuelveAPreguntar)) {
        const datos = campos.soloConfirmado(conversacion.ficha);

        // ----------------------------------------------------------------
        // SE INFORMA EL PRECIO DE LA CANTIDAD QUE PREGUNTO
        //
        // Salio al añadir el precio de 2 unidades:
        //
        //   clienta: "¿cuánto me salen dos?"
        //   bot:     "Una unidad te queda en $49.900... ¿Cuántos quieres?"
        //
        // Dos errores en una frase: contesta por una cuando preguntaron por
        // dos, y pregunta algo que la clienta acababa de decir.
        //
        // La causa es correcta en su sitio: `extraer` NO toma la cantidad de
        // una PREGUNTA de precio, solo de una peticion ("quiero 2"), porque
        // preguntar cuanto cuestan dos no significa que vaya a comprar dos.
        // Eso esta bien para el PEDIDO. Para INFORMAR el precio, no.
        //
        // EL RIESGO ACOTADO POR LA TABLA: solo se usa la cantidad mencionada
        // si existe en `precios`. "Calle 45 # 23-10" menciona 45, 23 y 10 y
        // ninguno esta en la tabla, asi que se ignoran solos — sin volver a
        // escribir la heuristica que ya confundio una direccion con una
        // cantidad.
        //
        // Y NO se toca la ficha: informar no es confirmar. Si se confirmara
        // la cantidad desde una pregunta, quien pregunta por dos y luego
        // quiere una se quedaria con dos fijadas.
        // ----------------------------------------------------------------
        const enLaTabla = texto
          .cantidadesEn(evento.texto || "")
          .map((c) => c.valor)
          .filter((n) => producto.precios && producto.precios[String(n)] !== undefined);
        // Con varias mencionadas no se elige: "¿uno o dos?" se informa por
        // una y la clienta concreta.
        const cantidadAInformar = new Set(enLaTabla).size === 1 ? enLaTabla[0] : 1;

        const estimada = cotizador.cotizar({
          producto,
          cantidad: cantidadAInformar,
          destino: datos.ciudad ? { ciudad: datos.ciudad, departamento: datos.departamento || null } : null,
          variante: datos.variante || null,
        });
        // Si no sale, no se informa nada. Un producto cuyo envio depende del
        // destino no puede dar un precio antes de saber la ciudad.
        if (estimada.ok) cotizacionInformativa = estimada.cotizacion;
      }

      return {
        situacion: faltan.length ? "faltan_datos" : "escalado",
        estadoDestino: conversacion.cotizacion ? estados.ESTADOS.CAPTURANDO_DATOS : estados.ESTADOS.PRODUCTO_IDENTIFICADO,
        cotizacion: conversacion.cotizacion,
        cotizacionInformativa,
        faltan,
      };
    }

    const oferta = actualizarOferta(conversacion, cot.cotizacion);
    conversacion.ofertaId = oferta.ofertaId;
    conversacion.cotizacion = oferta.cotizacion;
    conversacion.resumenMostrado = oferta.resumenMostrado;

    const requeridos = [...new Set([...REQUERIDOS_BASE, ...(producto.datosRequeridos || [])])];
    const faltan = campos.faltantes(conversacion.ficha, requeridos);

    if (faltan.length) {
      return { situacion: "faltan_datos", estadoDestino: estados.ESTADOS.CAPTURANDO_DATOS, cotizacion: cot.cotizacion, faltan };
    }

    // ----------------------------------------------------------------------
    // SI LA DIRECCION ES SOLO EL BARRIO, SE PREGUNTA ANTES DEL RESUMEN.
    //
    // ⚠️ LO PIDIO MARCO: «se supone que el Bot siempre debe pedir la
    //    direccion». En el pedido de Ipiales el bot recibio "barrio
    //    centenario" y salto directo al resumen, cerro la venta, y la
    //    direccion de verdad la consiguio Marco llamando por telefono.
    //
    // SE PREGUNTA UNA SOLA VEZ, y eso es deliberado. Repetir la pregunta es
    // lo que costo la venta del 08-oct en San Andres de Sotavento: la
    // clienta contesto "No entiendo" y se fue. Si no da la referencia, la
    // conversacion sigue y el pedido se cierra MARCADO -no despachable-, que
    // es la otra mitad de la regla de Marco.
    //
    // Y la pregunta lleva la salida dentro: un punto de referencia, o la
    // oficina de la transportadora.
    // ----------------------------------------------------------------------
    const dirConfirmada = [
      campos.valorConfirmado(conversacion.ficha.direccion),
      campos.valorConfirmado(conversacion.ficha.referencia),
    ]
      .filter(Boolean)
      .join(" ");
    // ⚠️ SE PIDE DENTRO DEL RESUMEN, NO EN UN MENSAJE APARTE.
    //
    // La primera version cortaba aqui y mandaba un turno nuevo preguntando
    // la referencia. Tumbo dos pruebas, y las dos tenian razon: el caso 2 de
    // los 20 de Marco exige que "Barrio buenos aires" llegue AL RESUMEN y
    // que el "sí" siguiente confirme. Rechazar o volver a preguntar es lo
    // que dejo a la clienta de San Andres de Sotavento contestando "No
    // entiendo" hasta que se fue.
    //
    // Asi que el resumen sale igual y lleva la peticion dentro, como una
    // FRASE y no como una segunda pregunta -el mensaje sigue teniendo una
    // sola interrogacion, que es la regla de tono-. El cliente puede
    // contestar la referencia o decir "sí" y seguir: si dice "sí", el pedido
    // se cierra MARCADO y no se puede despachar, que es la regla dura de
    // Marco.
    let faltaReferencia = false;
    if (dirConfirmada) {
      const v = destino.validarDireccion(dirConfirmada);
      faltaReferencia = Boolean(v.ok && v.faltaReferencia);
      if (faltaReferencia && conversacion.referenciaPedida !== true) {
        conversacion.referenciaPedida = true;
        contar("pidio_punto_de_referencia");
      }
    }

    // Todo listo: se muestra el resumen y se marca que esta mostrado. Ese
    // marcador es lo que permite que un "si" posterior cuente.
    conversacion.resumenMostrado = true;
    return {
      situacion: "resumen",
      estadoDestino: estados.ESTADOS.PENDIENTE_CONFIRMACION,
      cotizacion: cot.cotizacion,
      faltan: [],
      faltaReferencia,
    };
  }

  /**
   * Las dudas que dejan los datos TAL COMO QUEDARON en la ficha.
   *
   * No mira banderas ni turnos: coge el valor guardado y lo vuelve a pasar
   * por el mismo validador. Por eso no se le escapa una duda levantada tres
   * mensajes antes, que es lo que dejo salir un pedido a "barrio centenario".
   */
  function revisionesDeLosDatos(datos) {
    const d = datos || {};
    const out = [];
    if (d.nombre) {
      const r = destino.validarNombre(d.nombre);
      if (r.ok && r.revisar) out.push({ campo: "nombre", motivo: r.motivo });
    }
    if (d.direccion) {
      // ⚠️ SE VALIDAN JUNTAS, DIRECCION Y REFERENCIA.
      //
      // Es lo mismo que hace `guias.datosDe` para imprimir la etiqueta: lo
      // que el mensajero lee es la suma de las dos. Validar solo la
      // direccion dejaba el pedido marcado para siempre aunque el cliente
      // hubiera dado una referencia perfecta, porque "barrio centenario"
      // sigue siendo "barrio centenario" por su cuenta.
      const completa = [d.direccion, d.referencia].filter(Boolean).join(" ");
      const r = destino.validarDireccion(completa);
      if (r.ok && r.revisar) out.push({ campo: "direccion", motivo: r.motivo });
    }
    if (d.ciudad) {
      const r = destino.resolverCiudad(d.ciudad);
      if (r.ok && r.revisar) out.push({ campo: "ciudad", motivo: r.motivo });
    }
    return out;
  }

  async function confirmarPedido({ conversacion, producto, evento, revisiones }) {
    if (!conversacion.cotizacion || !conversacion.ofertaId) {
      return { ok: false, motivo: "no hay una cotizacion vigente que confirmar" };
    }
    if (!producto) {
      return { ok: false, motivo: "no se sabe que producto se esta confirmando" };
    }

    // Se recotiza en el momento de confirmar y se compara. Si el catalogo
    // cambio entre la cotizacion y el "si", el cliente estaria confirmando
    // un precio que ya no existe.
    const ahora = intentarCotizar(conversacion, producto);
    if (ahora.ok) {
      const firmaGuardada = cotizador.firmaDeCondiciones(conversacion.cotizacion);
      const firmaActual = cotizador.firmaDeCondiciones(ahora.cotizacion);
      if (firmaGuardada !== firmaActual) {
        return {
          ok: false,
          motivo: `las condiciones cambiaron entre la cotizacion y la confirmacion (${conversacion.cotizacion.total} -> ${ahora.cotizacion.total})`,
        };
      }
    }

    // ----------------------------------------------------------------------
    // LAS DUDAS SE RECALCULAN SOBRE LOS DATOS FINALES, NO SOBRE ESTE TURNO.
    //
    // ⚠️ ESTE ERA EL DEFECTO DE FONDO DE LA VENTA DE IPIALES (09-oct), Y ES
    //    EL QUE OBLIGO A MARCO A LLAMAR POR TELEFONO.
    //
    // `revisiones` llega de `validarYConfirmar`, que SOLO mira los campos
    // que se confirmaron EN ESTE TURNO. Y el turno del "sí" no confirma
    // nada: los datos llegaron antes. Asi que la duda sobre la direccion
    // -"barrio centenario", sin un punto por el que encontrarla- se
    // levantaba en su turno, nadie la guardaba, y al crear el pedido la
    // lista llegaba vacia.
    //
    // Medido con el pedido real: estado `confirmado`, direccion "barrio
    // centenario", `revisiones: []`. Un pedido despachable con una direccion
    // a la que no se puede llegar. La marca existia y se perdia por el
    // camino.
    //
    // Ahora se vuelven a validar los datos QUE DE VERDAD QUEDARON en la
    // ficha. Es la misma idea que `prometeConfirmar`: preguntarle al hecho,
    // no a una bandera que alguien tiene que acordarse de propagar.
    //
    // Se unen con las del turno en vez de sustituirlas, y se deduplican por
    // campo: si una validacion futura deja de levantar una duda que el turno
    // si vio, no se pierde.
    // ----------------------------------------------------------------------
    const datosFinales = campos.soloConfirmado(conversacion.ficha);
    const dudas = new Map();
    for (const r of revisiones || []) if (r && r.campo) dudas.set(r.campo, r);
    for (const r of revisionesDeLosDatos(datosFinales)) dudas.set(r.campo, r);
    const revisionesFinales = [...dudas.values()];
    if (revisionesFinales.length > (revisiones || []).length) contar("duda_recuperada_al_cerrar");

    const construido = pedidos.construir({
      cotizacion: conversacion.cotizacion,
      datos: datosFinales,
      contactoId: conversacion.contactoId,
      conversacionId: conversacion.contactoId,
      ofertaId: conversacion.ofertaId,
      wamidConfirmacion: evento.wamid,
      origen: evento.referral ? { tipo: "anuncio", referral: evento.referral } : null,
      revisiones: revisionesFinales,
    });

    if (!construido.ok) {
      return { ok: false, motivo: construido.motivo };
    }

    const r = await repos.pedidos.crearSiNoExiste(construido.pedido);

    if (!r.creado) {
      // Idempotencia: la retransmision o el "si" repetido no crean otro.
      contar("pedido_duplicado_evitado");
      registrar("warn", "pedido_duplicado_evitado", { motivo: r.motivo, pedidoId: r.pedido && r.pedido.id });
      return { ok: true, creado: false, pedido: r.pedido, motivo: r.motivo };
    }

    contar(construido.pedido.estado === pedidos.ESTADOS_PEDIDO.EN_REVISION ? "pedido_en_revision" : "pedido_confirmado");
    registrar("info", "pedido_creado", { pedidoId: r.pedido.id, estado: r.pedido.estado, total: r.pedido.cotizacion.total });
    return { ok: true, creado: true, pedido: r.pedido };
  }

  async function cancelarPedido(pedidoActivo, evento) {
    if (!pedidoActivo) return { cancelado: false, pedido: null };
    const r = pedidos.cancelar({ pedido: pedidoActivo, motivo: "el cliente lo pidio por WhatsApp", wamid: evento.wamid });
    if (!r.ok) return { cancelado: false, pedido: pedidoActivo };
    if (!r.yaEstaba) {
      await repos.pedidos.reemplazar(r.pedido);
      contar("pedido_cancelado");
    }
    return { cancelado: true, pedido: r.pedido };
  }

  /**
   * Prompt del turno.
   *
   * Solo lleva datos AUTORIZADOS del producto. No lleva precios: el modelo
   * no tiene por que verlos, porque no los va a escribir. Lo que no entra en
   * el prompt no se puede filtrar en la respuesta.
   */
  function construirPrompt(evento, conversacion, producto) {
    const partes = [`Mensaje del cliente: ${evento.texto || "(sin texto)"}`, `Estado de la conversacion: ${conversacion.estado}`];

    if (producto) {
      partes.push(`Producto en contexto: ${producto.nombre || producto.id}`);
      if (producto.descripcionAutorizada) partes.push(`Descripcion autorizada: ${producto.descripcionAutorizada}`);
      if ((producto.caracteristicasAutorizadas || []).length) {
        partes.push(`Caracteristicas autorizadas: ${producto.caracteristicasAutorizadas.join("; ")}`);
      }
      if ((producto.claimsProhibidos || []).length) {
        partes.push(`PROHIBIDO AFIRMAR: ${producto.claimsProhibidos.join("; ")}`);
      }
      if ((producto.sinDatoConfirmado || []).length) {
        partes.push(`Si el cliente pregunta por esto, di que lo confirmas: ${producto.sinDatoConfirmado.join("; ")}`);
      }
    } else {
      partes.push("Producto en contexto: DESCONOCIDO. Pregunta cual le interesa; no supongas ninguno.");
    }

    const faltan = campos.faltantes(conversacion.ficha, REQUERIDOS_BASE);
    if (faltan.length) partes.push(`Datos que faltan: ${faltan.join(", ")}`);

    // ------------------------------------------------------------------
    // LO QUE YA SE LE DIJO
    //
    // Sin esto el modelo no tiene forma de saber que ya se saludo ni que ya
    // se dio el precio, y lo repite. El historial rota, asi que no alcanza
    // con que "este en la conversacion": a los pocos turnos se cae de la
    // ventana y el bot vuelve a saludar como si fuera el primer mensaje.
    // ------------------------------------------------------------------
    const yaDicho = [];
    if (conversacion.saludado) yaDicho.push("ya se saludo: NO vuelvas a saludar");
    if (conversacion.precioInformado) yaDicho.push("ya se le dijo el precio: no lo repitas salvo que lo pregunte otra vez");
    if (conversacion.datosPedidos) yaDicho.push("ya se le pidieron los datos de entrega: no se los vuelvas a pedir en cada mensaje");
    if (yaDicho.length) partes.push(`En esta conversacion ${yaDicho.join("; ")}.`);

    // Que esta haciendo en este turno, decidido por codigo y no por el
    // modelo: si solo esta averiguando, no tiene que cerrar.
    const turno = responder.analizarTurno(evento.texto || "");
    if (turno.soloAveriguando) {
      partes.push("ESTE TURNO ES UNA DUDA, no una señal de compra: responde la duda y NO pidas datos de entrega.");
    }

    return partes.join("\n");
  }

  return {
    procesar,
    SISTEMA_BASE,
    REQUERIDOS_BASE,
    /**
     * Piezas ya construidas, para el panel.
     *
     * El panel necesita los MISMOS repositorios, catalogo y emisor que el
     * bot. Si se construyera los suyos, habria dos pools de conexiones, dos
     * cargas del catalogo y -lo grave- dos caminos de escritura sobre los
     * mismos pedidos. Pasa por aqui para que haya una sola instancia.
     */
    _piezas: () => ({ repos, catalogo, emisor, ia }),
    _interno: { avanzarVenta, validarYConfirmar, intentarCotizar },
  };
}

module.exports = { crearCerebro, REQUERIDOS_BASE };
