"use strict";

// ==========================================================================
// PREPARACION DE LA RESPUESTA
//
// Modulo casi puro: recibe hechos ya calculados y produce texto.
//
// Dos cosas pasan aqui, y el orden es el que importa:
//
//   1. SE CONSTRUYE UN TEXTO DETERMINISTA con los datos autorizados. Este
//      texto no depende del modelo y siempre existe. Es el que se usa si
//      algo falla.
//
//   2. SI LA IA PROPUSO UN BORRADOR, SE REVISA. Tiene que pasar dos filtros:
//
//        - importes: ninguna cifra de dinero que el cotizador no calculo;
//        - claims: ninguna frase de la lista de prohibidos del producto.
//
//      Si falla cualquiera, SE DESCARTA EL BORRADOR COMPLETO y se usa el
//      determinista. No se corrige, no se recorta: un texto que intenta
//      afirmar algo prohibido es un texto en el que no se puede confiar, y
//      arreglar la frase mala deja las demas sin revisar.
//
// Por que el filtro de claims importa tanto en NOVIKA: el primer producto es
// para dolor menstrual. Ahi el riesgo no es exagerar un precio, es hacer una
// promesa medica. "Cura los colicos" no es una venta agresiva: es una
// devolucion y, potencialmente, un problema regulatorio.
// ==========================================================================

const { revisarImportes } = require("../dominio/cotizador");
const { aplanar } = require("../dominio/texto");
const preguntas = require("../dominio/preguntas");
const contestar = require("./contestar");

const BLOQUEOS = {
  IMPORTE_NO_AUTORIZADO: "importe_no_autorizado",
  CLAIM_PROHIBIDO: "claim_prohibido",
  SIN_BORRADOR: "sin_borrador",
  /** El producto se reconoce pero no tiene ficha: el modelo no redacta. */
  PRODUCTO_SIN_FICHA: "producto_sin_ficha",
};

/**
 * ¿El texto afirma algo de la lista de prohibidos del producto?
 *
 * Se compara sobre el texto aplanado (sin tildes, minusculas) para que
 * "cura los cólicos" y "CURA LOS COLICOS" cuenten igual.
 */
/**
 * Marcas de que una frase ADMITE no saber el dato en vez de afirmarlo.
 *
 * "La garantía te la confirmo" y "la garantía es de un año" mencionan las dos
 * la garantia, y son opuestas: la primera es honesta y la segunda es un dato
 * inventado. Sin esta distincion las dos se bloqueaban igual.
 */
const ADMITE_NO_SABER = [
  /\bconfirm/, // confirmo, confirmar, te la confirmo
  /\bno\s+(tengo|se|sabria|te\s+puedo\s+decir)\b/,
  /\bno\s+quiero\s+darte\b/,
  /\b(averiguo|reviso|consulto|pregunto)\b/,
  /\bte\s+(escribo|aviso|digo)\b/,
  /\bno\s+esta\s+(publicado|confirmado)\b/,
];

/** ¿Esta frase coincide con una clave de la lista? */
function mencionaClave(frasePlana, clave) {
  const k = aplanar(clave);
  if (!k) return false;
  // Para frases largas se busca la frase; para terminos de una palabra, la
  // palabra con limites, para no marcar "embarazo" dentro de otra palabra.
  if (k.includes(" ")) return frasePlana.includes(k);
  return new RegExp(`\\b${k}\\b`).test(frasePlana);
}

/**
 * ¿El texto afirma algo de la lista de prohibidos del producto?
 *
 * DOS LISTAS CON DOS REGLAS DISTINTAS, Y LA DIFERENCIA IMPORTA:
 *
 *   claimsProhibidos   -> frases que NO pueden aparecer nunca. "Cura los
 *                         cólicos" no se salva con ningun contexto.
 *
 *   sinDatoConfirmado  -> TEMAS sobre los que no se puede AFIRMAR. Mencionar
 *                         el tema para decir que no se sabe es correcto; es
 *                         justo lo que se le pide al bot que haga.
 *
 * Antes las dos listas se trataban igual, y eso bloqueaba la respuesta
 * correcta: el texto "La garantía te la confirmo con el equipo" contiene "la
 * garantia", que esta en sinDatoConfirmado, asi que se marcaba como claim
 * prohibido. Consecuencia real: cualquier borrador del modelo que manejara
 * bien una duda se descartaba, y el cliente recibia el texto seco de
 * respaldo. El filtro estaba castigando la honestidad.
 *
 * Se evalua FRASE POR FRASE, no sobre el texto entero: si no, un mensaje que
 * admite una cosa ("la garantía te la confirmo") podria colar una afirmacion
 * sobre otra ("y llega en dos días") amparandose en la palabra "confirmo" de
 * la frase anterior.
 */
function revisarClaims(texto, producto) {
  const prohibidos = (producto && producto.claimsProhibidos) || [];
  const temasSinDato = (producto && producto.sinDatoConfirmado) || [];
  if (!prohibidos.length && !temasSinDato.length) return { ok: true, encontrados: [] };

  const encontrados = [];
  const completo = aplanar(texto);

  // Los prohibidos se miran sobre el texto completo: una promesa partida en
  // dos frases sigue siendo una promesa.
  for (const claim of prohibidos) {
    if (mencionaClave(completo, claim)) encontrados.push(claim);
  }

  // Los temas sin dato, frase por frase.
  const frases = String(texto ?? "")
    .split(/[.!?\n]+/)
    .map((f) => aplanar(f))
    .filter(Boolean);

  for (const tema of temasSinDato) {
    for (const frase of frases) {
      if (!mencionaClave(frase, tema)) continue;
      const admite = ADMITE_NO_SABER.some((re) => re.test(frase));
      if (!admite) {
        encontrados.push(tema);
        break;
      }
    }
  }

  return { ok: encontrados.length === 0, encontrados: [...new Set(encontrados)] };
}

/** Formato de moneda colombiana. Solo para cifras ya calculadas. */
function pesos(n) {
  return `$${Number(n).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

/**
 * Lineas de condiciones -envio y cobro- que acompañan a un total.
 *
 * Salen de `cotizacion.condiciones`, que el cotizador copia del catalogo. Si
 * el producto no declara una condicion, NO se escribe nada: no hay texto por
 * defecto. Dos motivos concretos:
 *
 *   - "Envío incluido" dicho por costumbre, sobre un producto cuya politica
 *     es "fijo", es un flete que el cliente no espera pagar y una discusion
 *     en la puerta.
 *   - En contraentrega, si el mensaje NO dice que paga al recibir, el
 *     cliente puede entender que ya debe transferir. Decirlo es parte del
 *     cierre, no un adorno.
 *
 * Ninguna etiqueta puede traer cifras -el esquema lo impide-, asi que estas
 * lineas nunca activan el filtro de importes no autorizados.
 */
function lineasDeCondiciones(cotizacion) {
  const c = (cotizacion && cotizacion.condiciones) || null;
  if (!c) return [];

  const partes = [];
  // Solo cuando el envio va realmente incluido. Con envio > 0 ya se desglosa
  // arriba como una linea de importe, y repetirlo seria confuso.
  if (c.envioIncluido && !cotizacion.envio) partes.push("Envío incluido");
  if (c.pagoEtiqueta) partes.push(c.pagoEtiqueta);

  return partes.length ? [partes.join(" · ")] : [];
}

// --------------------------------------------------------------------------
// ENUMERAR EN CASTELLANO
//
// "nombre, ciudad y dirección" en vez de "nombre, ciudad, dirección". Es un
// detalle de una linea y es la diferencia entre un mensaje escrito por una
// persona y una lista de campos de formulario.
// --------------------------------------------------------------------------
function enumerar(lista, conjuncion = "y") {
  const xs = (lista || []).filter(Boolean);
  if (xs.length <= 1) return xs[0] || "";
  return `${xs.slice(0, -1).join(", ")} ${conjuncion} ${xs[xs.length - 1]}`;
}

function mayuscula(texto) {
  const t = String(texto || "");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/**
 * La linea comercial: cuanto vale, con que condiciones.
 *
 * UNA sola frase para precio, envio y pago. Antes cada tema producia su
 * propia frase y "¿cuánto vale con envío?" devolvia tres oraciones seguidas
 * diciendo casi lo mismo. El cliente lee una linea, no un parrafo.
 *
 * Todas las cifras vienen de la cotizacion. Las condiciones vienen del
 * catalogo a traves de `cotizacion.condiciones`: si el producto no las
 * declara, no se escriben.
 */
function lineaComercial(cotizacion, producto, { asumida = false } = {}) {
  if (!cotizacion) return "";
  const nombre = (producto && producto.nombreCorto) || cotizacion.productoNombre || "el producto";
  const varias = cotizacion.cantidad > 1;

  // ----------------------------------------------------------------------
  // "UNA UNIDAD" CUANDO LA CANTIDAD ES ASUMIDA, NO DICHA
  //
  // Si el cliente todavia no dijo cuantas quiere, el precio que se le
  // informa es el de UNA, y hay que decirlo con esa palabra. Llamarlo "el
  // cinturón te queda en..." cuando pensaba pedir tres le hace creer que ese
  // es el total de su pedido, y la sorpresa aparece en el resumen.
  //
  // Cuando la cantidad SI la dijo, se usa el nombre del producto: repetir
  // "una unidad" a quien ya dijo que quiere una suena a formulario.
  // ----------------------------------------------------------------------
  const sujeto = varias ? `${cotizacion.cantidad} unidades` : asumida ? "una unidad" : nombre;

  const condiciones = [];
  const c = cotizacion.condiciones || {};
  if (c.envioIncluido && !cotizacion.envio) condiciones.push("envío incluido");
  else if (cotizacion.envio > 0) condiciones.push(`envío ${pesos(cotizacion.envio)}`);
  if (c.pagoMetodo === "contraentrega") condiciones.push("pagas al recibir");

  const cola = condiciones.length ? `, con ${enumerar(condiciones)}` : "";
  return mayuscula(`${sujeto} te ${varias ? "quedan" : "queda"} en ${pesos(cotizacion.total)}${cola}.`);
}

/**
 * EL ARRANQUE: que decirle a quien solo saluda.
 *
 * Un "hola" pelado no es una pregunta, asi que no hay nada que responder; y
 * tampoco es una señal de compra, asi que pedirle la direccion es atropellarlo.
 * Lo que corresponde es presentar el producto.
 *
 * Adelanta las dudas que mas se repiten -cuanto vale, como llega, como se
 * paga, de que talla y color es- para ahorrarle dos o tres mensajes. La
 * mecanica esta tomada de la referencia de BIKERPRO, donde el arranque fijo
 * existe justamente porque es el mensaje de mas trafico de la operacion y no
 * conviene improvisarlo. Los DATOS son los de NOVIKA: salen del catalogo.
 *
 * Termina sin pedir nada. Deja la puerta abierta y se calla.
 */
function arranque(cotizacion, producto, { asumida = false } = {}) {
  const partes = ["¡Hola!"];

  if (cotizacion) partes.push(lineaComercial(cotizacion, producto, { asumida }));

  // Las dos primeras caracteristicas aprobadas, no las cuatro: un muro de
  // texto en el primer mensaje se deja de leer.
  const rasgos = ((producto && producto.caracteristicasAutorizadas) || []).slice(0, 2);
  if (rasgos.length) partes.push(`${mayuscula(enumerar(rasgos))}.`);

  if (producto && (producto.imagenes || []).length) partes.push("Te muestro las fotos.");

  return partes.filter(Boolean).join(" ");
}

/**
 * Lo que falta para despachar, pedido como lo pediria una persona.
 *
 * `cantidadInformada` evita el peor efecto de pedir la cantidad: si la
 * clienta pregunto "¿cuánto me salen dos?" y se le acaba de responder por
 * dos, volver a preguntarle cuantas quiere es no haberla leido.
 */
function pedirLoQueFalta(faltan, { cantidadInformada = null } = {}) {
  const nombres = {
    nombre: "tu nombre completo",
    telefono: "un número de contacto",
    ciudad: "la ciudad",
    departamento: "el departamento",
    direccion: "la dirección",
    referencia: "un punto de referencia",
  };

  const pide = (faltan || []).filter((f) => f !== "cantidad").map((f) => nombres[f] || f);
  // Si ya se le informo el precio de N unidades, la cantidad esta dicha: lo
  // que falta es que confirme, no que la repita.
  const yaSeSabeCuantas = Number(cantidadInformada) > 1;
  const faltaCantidad = (faltan || []).includes("cantidad") && !yaSeSabeCuantas;

  if (yaSeSabeCuantas) {
    return pide.length
      ? `Si te llevas las dos, me pasas ${enumerar(pide)} y te las despacho.`
      : "¿Te las despacho?";
  }

  if (faltaCantidad && !pide.length) return "¿Cuántos quieres?";
  if (faltaCantidad) return `¿Cuántos quieres? Y para despacharlo me pasas ${enumerar(pide)}.`;
  if (!pide.length) return "¿Te lo despacho?";
  return `Para despacharlo me pasas ${enumerar(pide)}.`;
}

// --------------------------------------------------------------------------
// LOS TEMAS QUE SE RESPONDEN CON LA LINEA COMERCIAL
//
// Precio, envio y pago son el mismo hecho mirado de tres formas, y los tres
// los contesta `lineaComercial`. Se agrupan para no decir tres veces lo
// mismo en el mismo mensaje.
// --------------------------------------------------------------------------
const TEMAS_COMERCIALES = [preguntas.TEMAS.PRECIO, preguntas.TEMAS.ENVIO, preguntas.TEMAS.PAGO];

/**
 * Que esta haciendo el cliente en este turno.
 *
 * Vive aqui y se exporta para que el cerebro y el texto usen LA MISMA
 * decision. Si cada uno la calculara por su cuenta, el texto podria pedir los
 * datos y el cerebro anotar que no los pidio -o al reves-, y la conversacion
 * siguiente arrancaria con una memoria que no corresponde a lo que el cliente
 * leyo.
 */
function analizarTurno(mensajeCliente) {
  const lectura = preguntas.leer(mensajeCliente);
  const preguntoComercial = lectura.temas.some((t) => TEMAS_COMERCIALES.includes(t));
  return {
    lectura,
    preguntoComercial,
    // Preguntar no es comprar: si solo esta averiguando algo que no es
    // precio, envio ni pago, no se le piden los datos de entrega.
    soloAveriguando: lectura.pregunta && !lectura.compra && !preguntoComercial,
  };
}

/**
 * Texto determinista segun la situacion.
 *
 * NO contiene ni un dato comercial escrito a mano: todo sale de la
 * cotizacion o del catalogo. Si manana cambia un precio, aqui no se toca
 * nada.
 *
 * LA ESTRUCTURA DE TODO MENSAJE DE VENTA, Y EL ORDEN ES EL PUNTO:
 *
 *   1. saludo .................. solo la primera vez
 *   2. la respuesta a lo que preguntó .... PRIMERO, siempre
 *   3. el siguiente paso ....... solo si procede
 *
 * El paso 2 antes del 3 es la correccion de fondo. La conversacion que
 * provoco este cambio:
 *
 *   clienta: "Quiero un cinturón. ¿Cuánto vale con envío?"
 *   bot:     "Para continuar me falta la ciudad, la dirección de entrega."
 *
 * El bot TENIA el precio calculado -49.900, envio incluido- y contesto
 * pidiendo la direccion. Pedirle los datos a quien acaba de preguntar el
 * precio es la forma mas rapida de perder la venta.
 *
 * Y el paso 3 es CONDICIONAL, que es la otra mitad. Si el turno es una duda
 * informativa -garantia, medidas, material- se responde la duda y NADA MAS.
 * Documentado en la referencia de BIKERPRO: contestar cada duda pidiendo
 * ademas nombre, celular y direccion hace que el cliente que estaba
 * averiguando se sienta perseguido y se vaya.
 *
 * @param {object} e
 * @param {string} [e.mensajeCliente] el texto del turno, para saber que pregunto
 * @param {object} [e.memoria] {saludado, datosPedidos, pasoPropuesto}
 */
function textoDeterminista({
  situacion,
  cotizacion = null,
  cotizacionInformativa = null,
  faltan = [],
  opciones = [],
  pedido = null,
  producto = null,
  mensajeCliente = "",
  memoria = {},
}) {
  const { lectura, preguntoComercial, soloAveriguando } = analizarTurno(mensajeCliente);

  // El saludo va UNA vez por conversacion. Repetir "¡Hola!" en cada mensaje
  // es la marca mas reconocible de un bot.
  const saludo = !memoria.saludado && (lectura.saludo || !memoria.datosPedidos) && lectura.saludo ? "¡Hola!" : "";

  switch (situacion) {
    case "producto_desconocido":
      return [saludo, "Cuéntame qué producto te interesa y te ayudo con el precio y el envío."]
        .filter(Boolean)
        .join(" ");

    // ----------------------------------------------------------------------
    // PRODUCTO EN BORRADOR: se sabe cual es, pero no tiene ficha.
    //
    // Este texto es DETERMINISTA y no pasa por el modelo a proposito. El
    // cliente acaba de preguntar un precio; es justo el momento en el que un
    // modelo rellena el hueco con una cifra plausible. Aqui no hay hueco que
    // rellenar: no se nombra ningun importe, ningun plazo y ninguna
    // caracteristica, porque ninguno esta aprobado.
    //
    // Y NO vuelve a preguntar que producto es. Preguntar lo que el cliente ya
    // respondio es la forma mas rapida de que deje de escribir.
    // ----------------------------------------------------------------------
    case "producto_en_borrador": {
      const nombre = (producto && (producto.nombreCorto || producto.nombre)) || null;
      const lo = nombre ? nombre : "ese producto";
      const hayFotos = Boolean(producto && (producto.imagenes || []).length);
      return [
        saludo,
        `Sí, ${lo} lo tenemos.`,
        hayFotos ? "Te muestro las fotos." : "",
        "El precio y el envío te los confirma una persona del equipo en un momento: todavía no los tengo publicados y no quiero darte un dato equivocado.",
      ]
        .filter(Boolean)
        .join(" ");
    }

    case "producto_ambiguo":
      return opciones.length
        ? `¿Cuál te interesa, ${enumerar(opciones, "o")}?`
        : "¿Me confirmas cuál producto te interesa?";

    case "cotizacion": {
      if (!cotizacion) return "Dame un momento y te confirmo.";
      return lineaComercial(cotizacion, producto);
    }

    // ----------------------------------------------------------------------
    // FALTAN DATOS: el caso mas frecuente, y donde estaba el defecto
    // ----------------------------------------------------------------------
    case "faltan_datos": {
      // ------------------------------------------------------------------
      // LA COTIZACION REAL TAMBIEN SIRVE PARA INFORMAR EL PRECIO
      //
      // AQUI ESTABA EL DEFECTO QUE REPORTO MARCO. El texto solo miraba
      // `cotizacionInformativa`, que se calcula unicamente cuando falta la
      // cantidad. Con "Quiero un cinturón. ¿Cuánto vale con envío?" la
      // cantidad SE IDENTIFICA -es "un"-, asi que:
      //
      //   · `faltan` = ["ciudad","direccion"]  -> sin "cantidad"
      //   · no se calculaba informativa        -> quedaba null
      //   · PERO `cotizacion` ya traia el total de 49.900
      //
      // ...y el mensaje salia sin precio. La condicion
      // `faltan.includes("cantidad")` no estaba mal para lo que hacia; el
      // error fue creer que la informativa era la UNICA fuente de precio
      // para este texto. Con la cantidad conocida hay algo mejor: la
      // cotizacion de verdad.
      // ------------------------------------------------------------------
      const cot = cotizacion || cotizacionInformativa;

      // Solo saludo, y es la primera vez: se presenta el producto y no se le
      // pide nada. Ver `arranque`.
      if (lectura.soloSaludo && !memoria.saludado) {
        return arranque(cot, producto, { asumida: !cotizacion && Boolean(cotizacionInformativa) });
      }

      const partes = [];
      if (saludo) partes.push(saludo);

      // La cantidad es ASUMIDA cuando no hay cotizacion real: ahi el precio
      // que se informa es el de una unidad, y hay que decirlo con esa
      // palabra para que nadie lo lea como el total de su pedido.
      const asumida = !cotizacion && Boolean(cotizacionInformativa);

      // ---- 2. RESPONDER LO QUE PREGUNTO ----
      if (preguntoComercial) {
        partes.push(cot ? lineaComercial(cot, producto, { asumida }) : contestar.loConfirmo("El precio", "lo"));
      }

      // Las demas dudas -garantia, medidas, color, material...- las responde
      // el catalogo. Van despues del precio porque el precio es lo que se
      // pregunta primero cuando se preguntan las dos cosas.
      const otros = lectura.temas.filter(
        (t) => !TEMAS_COMERCIALES.includes(t) && t !== preguntas.TEMAS.FOTOS
      );
      const resto = contestar.aTemas(otros, { producto, cotizacion: cot }, { maximo: 2 });
      if (resto.texto) partes.push(resto.texto);

      // Si no pregunto nada y todavia no sabe el precio, se le dice. Es la
      // primera cosa que querria saber.
      if (!preguntoComercial && !resto.texto && cot && !memoria.precioInformado) {
        partes.push(lineaComercial(cot, producto, { asumida }));
      }

      // ---- 3. EL SIGUIENTE PASO, SOLO SI PROCEDE ----
      //
      // Una duda informativa NO autoriza a pedir los datos de entrega. Se
      // piden cuando hay señal de compra, cuando la duda era comercial -ahi
      // el siguiente paso es natural- o cuando el cliente no pregunto nada.
      if (lectura.compra || (!lectura.pregunta && !lectura.soloSaludo)) {
        // Hay señal de compra, o el cliente esta ya en la captura y no
        // pregunto nada: se piden los datos que falten.
        partes.push(pedirLoQueFalta(faltan, { cantidadInformada: cot && cot.cantidad }));
      } else if (preguntoComercial) {
        // ----------------------------------------------------------------
        // PREGUNTO EL PRECIO, PERO NO DIJO QUE LO QUIERA
        //
        // Aqui NO se le piden los cuatro datos de golpe. Se le pregunta si
        // le sirve, que es una sola cosa y facil de contestar. La mecanica
        // viene de la referencia de BIKERPRO -"el microcierre"-: pedir los
        // datos a quien acaba de ver el precio y todavia no dijo nada
        // suena a presion, y el que esta decidiendo se va.
        //
        // Cuando conteste que si, el turno siguiente SI tiene señal de
        // compra y ahi se piden los datos.
        // ----------------------------------------------------------------
        partes.push("¿Te sirve? Si quieres, me pasas los datos y lo despachamos.");
      } else if (!memoria.pasoPropuesto) {
        // Se deja la puerta abierta UNA vez, sin pedir nada.
        partes.push("Cuando quieras te lo despachamos.");
      }

      return partes.filter(Boolean).join(" ");
    }

    case "resumen": {
      if (!cotizacion) return "Dame un momento y te confirmo.";
      // ------------------------------------------------------------------
      // EL RESUMEN LLEVA EL NOMBRE COMERCIAL COMPLETO
      //
      // En una frase suelta se usa el nombre corto ("el cinturón térmico te
      // queda en..."), pero el resumen es el documento que la clienta
      // CONFIRMA y que queda copiado en el pedido. Ahi va el nombre con el
      // que se vende: "Cinturón térmico NOVIKA". Un pedido que dice "el
      // cinturón térmico" es mas pobre para quien despacha y para cualquier
      // reclamo posterior.
      // ------------------------------------------------------------------
      const nombre = cotizacion.productoNombre || (producto && producto.nombre) || "Producto";
      return [
        "Confirmemos tu pedido:",
        `${nombre} · ${cotizacion.cantidad} unidad(es)`,
        `Total: ${pesos(cotizacion.total)}`,
        ...lineasDeCondiciones(cotizacion),
        "",
        '¿Está todo bien? Respóndeme "sí" y lo despacho.',
      ].join("\n");
    }

    case "confirmado":
      return pedido
        ? `¡Listo! Tu pedido quedó registrado con el número ${pedido.id}. Te avisamos cuando salga.`
        : "¡Listo! Tu pedido quedó registrado.";

    // ----------------------------------------------------------------------
    // YA CONFIRMADO: ES POSVENTA, NO UN ECO
    //
    // ESTE ERA EL DEFECTO MAS GRAVE QUE QUEDABA, Y SE VIO EN PRODUCCION:
    //
    //   Marco: "Ese tiene garantía?"
    //   bot:   "Tu pedido NOV-... ya está confirmado. Si necesitas cambiar
    //           algo, dime qué y lo revisamos."
    //   Marco: "Pregunto si tiene garantía"
    //   bot:   (el mismo texto)
    //   Marco: "Si"
    //   bot:   (el mismo texto otra vez)
    //
    // Tras un pedido confirmado, el estado queda BLINDADO -con razon: un
    // "si" no puede recotizar ni crear otro pedido- y esta situacion
    // devolvia la misma frase a CUALQUIER cosa que escribiera el cliente.
    // La conversacion quedaba muerta para siempre: ninguna duda se
    // respondia, y un "¿cuánto vale otro?" -una venta adicional- recibia
    // tambien el eco.
    //
    // El blindaje no era el problema; el problema era creer que "no
    // recotizar" significa "no conversar". Quien ya compro es quien MAS
    // merece que le contesten: son garantias, cambios de direccion y
    // seguimientos.
    //
    // Ahora se responde primero su duda, con los mismos datos del catalogo
    // que en el resto de la conversacion, y el pedido se menciona solo
    // cuando viene al caso. Lo que NO cambia: de aqui no sale ninguna
    // cotizacion ni ningun pedido nuevo.
    // ----------------------------------------------------------------------
    case "ya_confirmado": {
      const partes = [];
      if (saludo) partes.push(saludo);

      // Su duda, respondida. El precio se puede decir -es informativo- pero
      // NO crea oferta: el estado sigue blindado.
      const respuesta = contestar.aTemas(lectura.temas, { producto, cotizacion }, { maximo: 2 });
      if (respuesta.texto) partes.push(respuesta.texto);

      // El pedido se nombra cuando el cliente pregunta por el -entrega,
      // envio- o cuando no pregunto nada. Repetir el numero de pedido en
      // cada mensaje es justo lo que producia el eco.
      const preguntaPorSuPedido =
        lectura.temas.includes(preguntas.TEMAS.ENTREGA) || lectura.temas.includes(preguntas.TEMAS.ENVIO);

      if (!respuesta.texto || preguntaPorSuPedido) {
        partes.push(
          pedido
            ? `Tu pedido ${pedido.id} ya está confirmado y te avisamos cuando salga.`
            : "Tu pedido ya está confirmado."
        );
      }

      // Si pidio otro, se le dice que lo gestiona una persona. NO se abre un
      // pedido nuevo por iniciativa del bot: BIKERPRO documento un pedido
      // falso creado asi, y casi se despacho un paquete que nadie pidio.
      if (lectura.compra || lectura.temas.includes(preguntas.TEMAS.PRECIO)) {
        partes.push("Si quieres pedir otro, le digo a una persona del equipo que te lo arme.");
      } else if (!preguntaPorSuPedido && respuesta.texto) {
        partes.push("Cualquier otra cosa de tu pedido, dime.");
      }

      return partes.filter(Boolean).join(" ");
    }

    case "cancelado":
      return "Listo, lo cancelamos. Si cambias de opinión escríbeme y lo armamos de nuevo.";

    // ----------------------------------------------------------------------
    // ESCALADO: se pasa a una persona. Y SE RESPONDE LO QUE PREGUNTO IGUAL.
    //
    // "Dame un momento, te confirmo en seguida" era lo unico que salia, y
    // dejaba al cliente sin nada. Si la duda se puede contestar con el
    // catalogo, se contesta, y ademas se avisa de que sigue una persona.
    // ----------------------------------------------------------------------
    case "escalado": {
      const resto = contestar.aTemas(lectura.temas, { producto, cotizacion }, { maximo: 2 });
      return [saludo, resto.texto, "Déjame revisarlo con el equipo y te escribo en un momento."]
        .filter(Boolean)
        .join(" ");
    }

    case "sin_respuesta_automatica":
    default:
      return "Dame un momento, te confirmo en seguida.";
  }
}

// ==========================================================================
// NO REPETIR PALABRA POR PALABRA LO ULTIMO QUE SE DIJO
//
// En la captura de produccion el mismo texto salio TRES veces seguidas, y
// reproduciendolo salio cinco. Aunque la situacion se arregle, esto tiene
// que existir aparte: un bot que repite el mismo parrafo es un bot roto a
// ojos del cliente, y la causa puede ser cualquier rama futura.
//
// DOS NIVELES, Y EL SEGUNDO ES EL QUE IMPORTA:
//
//   1. Si el texto es idéntico al anterior, se cambia por uno que pide
//      concretar. Puede que el cliente escribiera algo que no entendimos.
//
//   2. Si YA se dijo eso y volveria a repetirse, el bot no esta avanzando.
//      Ahi se para y se pasa a una persona, en vez de seguir dando vueltas.
//      Es la misma decision que BIKERPRO documento como "bucle cortado".
// ==========================================================================

const PEDIR_CONCRETAR =
  "Perdón, no quiero repetirme. Dime concretamente qué necesitas y lo reviso con el equipo.";
const PASAR_A_PERSONA =
  "Déjame pasarte con una persona del equipo para no darte vueltas. Te escribe en un momento.";

/**
 * Evita el texto repetido.
 *
 * OJO CON UNA DISTINCION QUE LA PRIMERA VERSION NO HACIA:
 *
 * Si el cliente pregunta DOS VECES LO MISMO, repetir la respuesta correcta
 * no es un eco: es contestarle. La primera version comparaba solo el texto
 * de salida, asi que ante "¿tiene garantía?" y "pregunto si tiene garantía"
 * -la misma duda escrita de dos formas- la segunda recibia "perdón, no
 * quiero repetirme" en lugar de la respuesta. Peor que repetir.
 *
 * El eco de verdad es responder LO MISMO a preguntas DISTINTAS. Por eso la
 * guarda solo actua cuando los temas del turno cambian.
 *
 * @param {string} texto             el que se iba a enviar
 * @param {string|null} ultimoDicho  el ultimo texto que mando el negocio
 * @param {object} [opciones]
 * @param {boolean} [opciones.mismaPregunta] el cliente pregunto lo mismo
 * @returns {{texto: string, repetido: boolean, escalar: boolean}}
 */
function sinRepetir(texto, ultimoDicho, { mismaPregunta = false } = {}) {
  const a = String(texto || "").trim();
  const b = String(ultimoDicho || "").trim();
  if (!a || !b || a !== b) return { texto: a, repetido: false, escalar: false };
  if (mismaPregunta) return { texto: a, repetido: false, escalar: false };

  // Ya se habia pedido concretar y seguimos en el mismo sitio: no hay una
  // tercera forma de decir lo mismo. Pasa a una persona.
  if (b === PEDIR_CONCRETAR) return { texto: PASAR_A_PERSONA, repetido: true, escalar: true };
  if (b === PASAR_A_PERSONA) return { texto: PASAR_A_PERSONA, repetido: true, escalar: true };

  return { texto: PEDIR_CONCRETAR, repetido: true, escalar: false };
}

/**
 * Prepara la respuesta final.
 *
 * @returns {{texto: string, origen: "determinista"|"ia", bloqueos: object[]}}
 */
function preparar({
  situacion,
  cotizacion = null,
  cotizacionInformativa = null,
  faltan = [],
  opciones = [],
  pedido = null,
  producto = null,
  borradorIA = null,
  mensajeCliente = "",
  memoria = {},
}) {
  const determinista = textoDeterminista({
    situacion,
    cotizacion,
    cotizacionInformativa,
    faltan,
    opciones,
    pedido,
    producto,
    mensajeCliente,
    memoria,
  });
  const bloqueos = [];

  // --------------------------------------------------------------------------
  // CON EL PRODUCTO EN BORRADOR, EL MODELO NO REDACTA.
  //
  // El cliente acaba de preguntar un precio que no existe. Es el momento
  // exacto en el que un modelo rellena el hueco con una cifra plausible, y
  // una cifra plausible es un cobro equivocado.
  //
  // El filtro de importes ya lo frenaria -sin cotizacion no hay importes
  // autorizados, asi que cualquier cifra se bloquea-, pero depender de eso
  // seria confiar en que el modelo se equivoque de una forma concreta.
  // Aqui no se le pide nada: el texto es el nuestro.
  // --------------------------------------------------------------------------
  if (situacion === "producto_en_borrador") {
    return { texto: determinista, origen: "determinista", bloqueos: [{ tipo: BLOQUEOS.PRODUCTO_SIN_FICHA }] };
  }

  if (!borradorIA || !String(borradorIA).trim()) {
    return { texto: determinista, origen: "determinista", bloqueos: [{ tipo: BLOQUEOS.SIN_BORRADOR }] };
  }

  // Los importes de la informativa tambien cuentan: si no, un borrador que
  // repite el precio correcto se bloquearia por decir la verdad.
  const autorizados = [
    ...((cotizacion && cotizacion.importesAutorizados) || []),
    ...((cotizacionInformativa && cotizacionInformativa.importesAutorizados) || []),
  ];
  const importes = revisarImportes(borradorIA, autorizados);
  if (!importes.ok) {
    bloqueos.push({
      tipo: BLOQUEOS.IMPORTE_NO_AUTORIZADO,
      detalle: importes.sospechosos.map((s) => s.valor),
    });
  }

  const claims = revisarClaims(borradorIA, producto);
  if (!claims.ok) {
    bloqueos.push({ tipo: BLOQUEOS.CLAIM_PROHIBIDO, detalle: claims.encontrados });
  }

  if (bloqueos.length) {
    // Borrador descartado completo. El cliente recibe el texto determinista,
    // que es correcto aunque sea mas seco.
    return { texto: determinista, origen: "determinista", bloqueos };
  }

  return { texto: borradorIA, origen: "ia", bloqueos: [] };
}

module.exports = {
  preparar,
  textoDeterminista,
  analizarTurno,
  arranque,
  sinRepetir,
  PEDIR_CONCRETAR,
  PASAR_A_PERSONA,
  revisarClaims,
  lineaComercial,
  pedirLoQueFalta,
  enumerar,
  BLOQUEOS,
  pesos,
};
