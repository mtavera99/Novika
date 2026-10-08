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
  function candidatosHeuristicos(evento) {
    const propuestas = {};

    // El telefono con el que escribe es el mejor candidato que existe: es un
    // hecho del canal, no una inferencia. Ojo: los clientes con nombre de
    // usuario de WhatsApp NO tienen telefono, y en ese caso no se inventa.
    if (evento.telefono) propuestas.telefono = evento.telefono;
    if (evento.nombre) propuestas.nombre = evento.nombre;

    // Cantidad, ciudad y direccion salen del texto con reglas, no con
    // modelo. Ver dominio/extraer.js: ante la duda, no propone.
    const { candidatos } = extraer.deTexto(evento.texto || "");
    return { ...propuestas, ...candidatos };
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
  function aplicarCandidatos(ficha, propuestas, origen) {
    let actualizada = { ...ficha };
    for (const [campo, valor] of Object.entries(propuestas || {})) {
      if (!campos.CAMPOS.includes(campo)) continue;
      let antes = actualizada[campo];

      const confirmado = campos.valorConfirmado(antes);
      const esCorreccionDelCliente =
        origen === campos.ORIGENES.CLIENTE &&
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
    conversacion.ficha = aplicarCandidatos(conversacion.ficha, candidatosHeuristicos(evento), campos.ORIGENES.CLIENTE);

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
      turnoDeCompra.lectura.compra &&
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

    const validacion = validarYConfirmar(conversacion.ficha);
    conversacion.ficha = validacion.ficha;

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
    const datosAportados = Object.keys(campos.soloConfirmado(conversacion.ficha)).filter(
      (c) => !confirmadosAntes.has(c) && DATOS_DE_DESPACHO.includes(c)
    );
    traza.datosAportados = datosAportados;
    traza.revisiones = validacion.revisiones;
    traza.ambiguedades = validacion.ambiguedades;

    // ------------------------------------------------------------------
    // Accion
    // ------------------------------------------------------------------
    let situacion = "escalado";
    let estadoDestino = conversacion.estado;

    if (decision.accion === confirmacion.ACCIONES.NINGUNA && estados.estaBlindado(conversacion.estado)) {
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
    } else if (decision.accion === confirmacion.ACCIONES.CANCELAR) {
      const r = await cancelarPedido(pedidoActivo, evento);
      situacion = r.cancelado ? "cancelado" : "escalado";
      traza.pedido = r.pedido ? { id: r.pedido.id, estado: r.pedido.estado } : null;
      estadoDestino = estados.ESTADOS.CANCELADO;
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
    const loQuePregunta = preguntas.leer(evento.texto || "");
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
    const preparada = responder.preparar({
      situacion,
      cotizacion: conversacion.cotizacion,
      cotizacionInformativa: cotizacionConsultada,
      faltan: traza.faltan || [],
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
      preguntaReconocida: temasAhora.length > 0 || datosAportados.length > 0,
    });

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
        conversacion.atencion = {
          ...atencionDeChat.leer(conversacion),
          pausado: true,
          por: "bucle_de_respuesta",
          desde: new Date().toISOString(),
        };
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

    if (situacion === "escalado" || preguntoAlgoNoCatalogado) {
      atencionDeChat.anotarPendiente(conversacion, {
        motivo: atencionDeChat.MOTIVOS_PENDIENTE.SIN_DATO,
        pregunta: evento.texto || "",
      });
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

    if (situacion === "escalado" && !estabaPausadoAlEmpezar) {
      conversacion.atencion = {
        ...atencionDeChat.leer(conversacion),
        pausado: true,
        por: "escalado",
        desde: new Date().toISOString(),
      };
      traza.avisos.push("escalado: se avisa una vez y el bot deja de responder hasta que lo atienda una persona");
      contar("escalado_pausa_el_bot");
    } else if (situacion === "ya_confirmado" && (loQuePregunta.compra || loQuePregunta.quiereOtro)) {
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
    const yaEscalado = estabaPausadoAlEmpezar && situacion === "escalado";
    if (yaEscalado) {
      traza.avisos.push("ya escalado y pausado: el bot no responde, espera a una persona");
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
    }
      if (situacion === "faltan_datos" && !turno.soloAveriguando) conversacion.datosPedidos = true;
      conversacion.pasoPropuesto = true;

    conversacion.ventana = [...(conversacion.ventana || []), { texto: evento.texto || "", wamid: evento.wamid }].slice(-8);
    conversacion.ultimoWamid = evento.wamid;

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

    // Todo listo: se muestra el resumen y se marca que esta mostrado. Ese
    // marcador es lo que permite que un "si" posterior cuente.
    conversacion.resumenMostrado = true;
    return { situacion: "resumen", estadoDestino: estados.ESTADOS.PENDIENTE_CONFIRMACION, cotizacion: cot.cotizacion, faltan: [] };
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

    const construido = pedidos.construir({
      cotizacion: conversacion.cotizacion,
      datos: campos.soloConfirmado(conversacion.ficha),
      contactoId: conversacion.contactoId,
      conversacionId: conversacion.contactoId,
      ofertaId: conversacion.ofertaId,
      wamidConfirmacion: evento.wamid,
      origen: evento.referral ? { tipo: "anuncio", referral: evento.referral } : null,
      revisiones: revisiones || [],
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
