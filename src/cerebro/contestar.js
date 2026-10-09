"use strict";

// ==========================================================================
// RESPONDER LA DUDA, CON DATOS DEL CATALOGO
//
// Este modulo convierte un tema -lo que pregunto el cliente- en una frase
// para el cliente. Todas las frases salen de aqui o del cotizador, nunca del
// modelo.
//
// POR QUE EXISTE: "LA CALIDEZ NO PUEDE DEPENDER DE QUE GEMINI RESPONDA"
//
// El camino determinista era el de respaldo, y se notaba: "Para continuar me
// falta la ciudad, la dirección de entrega." Correcto y frio. Y ese camino se
// usa MAS de lo que parece, porque se usa siempre que:
//
//   · no hay proveedor de IA configurado,
//   · la IA falla, tarda o devuelve vacio,
//   · el borrador del modelo menciona un importe no autorizado,
//   · el borrador toca un claim prohibido,
//   · el producto esta en borrador (ahi el modelo no redacta a proposito).
//
// O sea: el respaldo atiende clientes reales. Si es seco, la tienda suena
// seca. Mejorarlo no es cosmetica.
//
// DOS LIMITES QUE NO SE CRUZAN
//
// 1. NINGUN IMPORTE SE ESCRIBE AQUI. Las cifras llegan ya calculadas en la
//    cotizacion. No hay una sola constante monetaria en este archivo.
//
// 2. LO QUE NO ESTA APROBADO SE ADMITE, NO SE RELLENA. Si el catalogo no
//    tiene el dato, la respuesta dice que lo confirma una persona. Eso es
//    mejor que una frase amable con un dato inventado dentro.
// ==========================================================================

const { TEMAS } = require("../dominio/preguntas");
const cotizador = require("../dominio/cotizador");
const { aplanar } = require("../dominio/texto");

// ==========================================================================
// EL PLAZO DE ENTREGA DEPENDE DE LA CIUDAD, Y EL DATO YA ESTABA
//
// ⚠️ DEFECTO MEDIDO POR MARCO EL 2026-10-10: a Bogota el bot contestaba
//    "1 a 3 días hábiles". A Bogota son 1 a 2.
//
// Lo mas llamativo es que el dato correcto estaba en el catalogo desde el
// 09-oct —`logistica.tiempoDeEntrega.porCiudad.bogota`— y NO LO LEIA NADIE.
// Un campo que nadie consulta es peor que un campo que falta: parece que el
// dato esta y en realidad no se usa.
//
// Y HAY UN SEGUNDO ARREGLO AQUI, el del matiz. Cuando ya sabemos la ciudad,
// "según la ciudad" sobra y suena a letra pequeña:
//
//   antes:  "A Duitama te llega en 1 a 3 días hábiles según la ciudad"
//   ahora:  "A Duitama te llega en 1 a 3 días hábiles"
//
// El matiz solo tiene sentido cuando NO sabemos a donde va, que es cuando
// el rango de verdad depende de algo que todavia no se conoce.
// ==========================================================================
/**
 * Plazo de entrega para una ciudad concreta, o el general si no se sabe.
 *
 * @param {object|null} producto
 * @param {string|null} ciudad  Ciudad ya confirmada, o null.
 * @returns {{texto: string, matiz: string}|null}
 */
function plazoDeEntrega(producto, ciudad) {
  const t = (producto && producto.logistica && producto.logistica.tiempoDeEntrega) || null;
  if (!t || !t.texto) return null;

  const plano = aplanar(ciudad || "");
  if (plano) {
    const porCiudad = t.porCiudad || {};
    // "bogota dc" y "bogota" tienen que dar el mismo plazo: se prueba la
    // ciudad tal cual y, si no, su primera palabra.
    const exacto = porCiudad[plano] || porCiudad[plano.split(/\s+/)[0]];
    // Se sabe la ciudad: el matiz "segun la ciudad" ya no aporta nada.
    return { texto: exacto || t.texto, matiz: "" };
  }

  return { texto: t.texto, matiz: t.matiz || "" };
}

/** Formato de moneda colombiana. Solo para cifras ya calculadas. */
function pesos(n) {
  return `$${Number(n).toLocaleString("es-CO", { maximumFractionDigits: 0 })}`;
}

/** Como nombrar el producto en una frase. */
function comoSeLlama(producto) {
  if (!producto) return "el producto";
  return producto.nombreCorto || producto.nombre || "el producto";
}

/**
 * Busca un dato entre las caracteristicas APROBADAS del producto.
 *
 * Devuelve la caracteristica tal y como la aprobo el dueño, sin reescribirla:
 * si el catalogo dice "viene unicamente en color rosado", eso es lo que se
 * dice. Reformularla seria editar un dato aprobado.
 */
function caracteristica(producto, re) {
  const lista = (producto && producto.caracteristicasAutorizadas) || [];
  return lista.find((c) => re.test(String(c).toLowerCase())) || null;
}

/**
 * La oferta de DOS, si de verdad conviene. Si no, `null`.
 *
 * Se le pregunta AL COTIZADOR, que es la unica fuente de importes de esta
 * casa: aqui no se lee `producto.precios` ni se escribe ninguna cifra.
 *
 * Y se COMPRUEBA que la pareja sale mejor que dos sueltas, en vez de darlo
 * por hecho. Asi la frase se sostiene sola: si la tabla cambia y dos dejan
 * de convenir -o si el producto no tiene precio para dos-, esto devuelve
 * `null` y el bot deja de ofrecerla sin que nadie se acuerde de venir a
 * borrar el texto.
 *
 * Devuelve LA COTIZACION ENTERA, no un si/no, porque Marco autorizo decir
 * el precio: "lo que si podemos hacer es ofrecerle las 2 unidades para que
 * lleven dos y le salga mas barato... sale por 85.000 pesos".
 *
 * ⚠️ Quien use esto tiene que llevar sus `importesAutorizados` al filtro de
 * importes. Si no, el propio candado bloquea la cifra por decir la verdad.
 */
function ofertaDeDos(producto) {
  if (!producto) return null;
  const una = cotizador.cotizar({ producto, cantidad: 1 });
  const dos = cotizador.cotizar({ producto, cantidad: 2 });
  if (!una.cotizacion || !dos.cotizacion) return null;
  if (dos.cotizacion.total >= una.cotizacion.total * 2) return null;
  return dos.cotizacion;
}

/**
 * ¿Se paga al recibir? ¿Va incluido el envio?
 *
 * SON POLITICAS, NO IMPORTES, y por eso se pueden contestar SIN cotizar.
 * Se prefiere la cotizacion -es la fuente de la verdad del turno- y si no
 * hay, se lee la ficha, que es donde el dueño las aprobo.
 *
 * Mezclar las dos cosas costo una venta el 08-oct: sin cotizacion, una
 * pregunta por el contraentrega recibia "el precio no te lo quiero decir a
 * medias". El importe no se sabia; el metodo de pago, si.
 */
function pagaAlRecibir(producto, cotizacion) {
  const c = cotizacion && cotizacion.condiciones;
  if (c && c.pagoMetodo) return c.pagoMetodo === "contraentrega";
  const p = producto && producto.pago;
  return Boolean(p && p.metodo === "contraentrega");
}

function envioVaIncluido(producto, cotizacion) {
  const c = cotizacion && cotizacion.condiciones;
  if (c && typeof c.envioIncluido === "boolean") return c.envioIncluido;
  const pol = producto && producto.logistica && producto.logistica.politicaEnvio;
  const tipo = typeof pol === "string" ? pol : pol && pol.tipo;
  return tipo === "incluido";
}

/** ¿El producto declara explicitamente que este tema NO esta confirmado? */
function declaradoSinConfirmar(producto, re) {
  const lista = (producto && producto.sinDatoConfirmado) || [];
  return lista.some((s) => re.test(String(s).toLowerCase()));
}

/**
 * Frase para "este dato todavia no lo tengo".
 *
 * Se escribe en primera persona y sin excusas raras. Y dice POR QUE no lo
 * dice -para no darte un dato equivocado-, que es la diferencia entre sonar
 * desinformado y sonar cuidadoso.
 */
function loConfirmo(que, pronombre = "lo", producto = null, cotizacion = null) {
  // El pronombre va explicito porque el castellano concuerda: "la garantía te
  // LA confirmo", no "te lo confirmo". Sin esto salia "La garantía te lo
  // confirmo", que es exactamente el tipo de error que hace sonar a maquina.
  // Y en MINUSCULA, porque estas frases van detras de una apertura. Las
  // aperturas de varios temas acaban en dos puntos -"Te cuento:"- y salia
  // "Te cuento: El material te lo confirmo", con una mayuscula en medio de
  // la oracion que delata a la maquina. Si la frase abre el mensaje, el
  // compositor ya le pone la mayuscula: `componer` llama a `mayuscula()`.
  const sujeto = String(que || "");
  const enMinuscula = sujeto ? sujeto.charAt(0).toLowerCase() + sujeto.slice(1) : sujeto;

  // SIN "EN UN MOMENTO". Decia "te lo confirmo con el equipo en un momento",
  // y eso es una promesa de tiempo que nadie puede cumplir: no hay nadie de
  // guardia, ni aviso, ni plazo. Si la clienta escribe un domingo por la
  // noche, "en un momento" es falso.
  //
  // Lo que SI es verdad y ademas tranquiliza: que la pregunta queda anotada
  // y que una persona responde por aqui. Eso lo respalda el registro de
  // tareas pendientes del cerebro, que existe de verdad.
  // Y SE SIGUE VENDIENDO EN LA MISMA FRASE.
  //
  // Esto decia "lo dejo anotado para el equipo y te responden por aquí" y
  // ahi se moria la conversacion. Honesto, y un callejon sin salida: el
  // cliente no tiene nada que hacer con esa respuesta.
  //
  // BIKERPRO resuelve el mismo problema sin pararse, y lo tiene documentado
  // como "la regla mas importante" de su guion:
  //
  //   "Ese dato específico prefiero confirmártelo para no darte información
  //    incorrecta 🙌 ¿Querés que te lo confirme y te escribo?"  Y SEGUI CON
  //    LA VENTA.
  //
  // La diferencia es la que hay entre un bot honesto y un VENDEDOR honesto:
  // los dos admiten que no lo saben, pero uno deja al cliente parado y el
  // otro le deja algo que hacer. Admitir un hueco no obliga a soltar la
  // conversacion.
  // ----------------------------------------------------------------------
  // ⚠️ ESTA RESPUESTA SE BORRO EL 2026-10-10, Y LA BORRO MARCO.
  //
  // Decia: "no te lo quiero decir a medias: lo confirmo con el equipo y te
  // cuento". Honesta, bien intencionada, y SALIO SIETE VECES en diecinueve
  // conversaciones. Entre ellas:
  //
  //   "Y si lo pido hoy cuándo me está llegando"   <- el plazo SI se sabe
  //   "Como se llama eso"                          <- el nombre SI se sabe
  //   "Funciona también con frío"                  <- se sabe que no
  //   "Pero que sea cierto"                        <- era una objecion de
  //   "Porque en otras páginas he pedido y no      <- confianza, el momento
  //    llega nada"                                    de dar seguridad
  //
  // Ninguna necesitaba al equipo. El problema de fondo no era la honestidad
  // del texto: era que admitir el hueco se habia convertido en la salida por
  // defecto, y cada vez que salia la conversacion se paraba.
  //
  // AHORA SE VUELVE A LA VENTA con lo que SI se sabe, que es lo que pidio
  // Marco palabra por palabra. Los datos salen del catalogo, no del texto:
  // si el precio cambia, esta frase cambia con el.
  //
  // ⚠️ Y LO QUE SE CAMBIA ES LA FRASE, NO EL MECANISMO.
  //
  // La primera version de este arreglo devolvia aqui la RESERVA DE VENTA
  // -"te cuento lo principal: $49.900, pagas al recibir..."- y estaba mal
  // por dos motivos que saltaron en las pruebas:
  //
  //   · `loConfirmo` se llama para VEINTICUATRO huecos distintos, y muchos
  //     salen DETRAS de la linea comercial. El mensaje acababa diciendo el
  //     precio dos veces en dos frases seguidas.
  //   · a una pregunta de PRECIO sin cotizacion le contestaba "pagas al
  //     recibir y llega en 1 a 3 días"… sin decir el precio. Evasiva, y
  //     justo en el dato que se pregunto.
  //
  // La reserva de venta es la respuesta correcta para una pregunta QUE NO SE
  // ENTENDIO (eso vive en `responder.js`). Para un dato concreto que falta,
  // lo honesto sigue siendo nombrarlo y decir que se confirma — sin la
  // frase que Marco prohibio y sin dejar al cliente parado, porque quien
  // compone el mensaje le añade el cierre detras.
  // ----------------------------------------------------------------------
  return `${enMinuscula} te ${pronombre} confirmo con el equipo para no darte un dato equivocado.`;
}

/**
 * La respuesta de reserva: lo principal, y de vuelta a la venta.
 *
 * Se usa cuando no hay dato en el catalogo para lo que preguntaron. Dice las
 * tres cosas que mueven la decision -precio, contraentrega y plazo- y cierra
 * con la pregunta mas facil de contestar.
 */
function reservaDeVenta(producto, cotizacion, { yaDijoElPrecio = false } = {}) {
  const piezas = [];

  // El precio solo si el mensaje no lo ha dicho ya. Esta frase sale muchas
  // veces detras de la linea comercial, y repetir la cifra en dos frases
  // seguidas es lo que mas delata un mensaje armado por partes.
  if (!yaDijoElPrecio) {
    const total = cotizacion && cotizacion.total;
    if (total) piezas.push(`${pesos(total)} con envío incluido`);
    else {
      const base = producto && producto.precio && producto.precio.unidad;
      if (base) piezas.push(`${pesos(base)} con envío incluido`);
    }
  }

  // Ni el contraentrega: la linea comercial ya lo dice, y repetirlo en la
  // frase siguiente es el mismo defecto que el precio repetido.
  if (!yaDijoElPrecio && pagaAlRecibir(producto, cotizacion)) piezas.push("pagas al recibir");

  const plazo = plazoDeEntrega(producto, null);
  if (plazo && plazo.texto) piezas.push(`llega en ${plazo.texto}`);

  // Sin ningun dato del catalogo no se rellena con adjetivos: se pregunta.
  if (!piezas.length) {
    return "Buena pregunta 🙌 Cuéntame para qué ciudad sería y te confirmo todo con calma.";
  }

  return `Buena pregunta 🙌 Te cuento lo principal: ${piezas.join(", ")}. ¿Para qué ciudad sería?`;
}

/**
 * ¿Este texto es la respuesta de reserva?
 *
 * El cerebro la usa para abrir la nota interna: alguien pregunto algo que el
 * catalogo no cubre, y eso hay que saberlo aunque el bot no se haya parado.
 *
 * Se detecta sobre el texto por el mismo motivo que `prometeConfirmar`: una
 * bandera que cada rama tiene que acordarse de devolver falla en silencio el
 * dia que alguien añade una rama nueva.
 */
// Sin ancla `^` a proposito: la reserva sale DENTRO de un mensaje compuesto,
// normalmente detras de una apertura ("Claro que sí, ..."), asi que anclarla
// al principio hacia que la nota interna no se abriera nunca. Lo cazo una
// prueba que comprueba justo eso.
const ES_RESERVA = /Buena pregunta 🙌 (Te cuento lo principal|Cuéntame para qué ciudad)/;
function esReservaDeVenta(texto) {
  return ES_RESERVA.test(String(texto || "").trim());
}

/**
 * Respuesta a un tema.
 *
 * @param {string} tema
 * @param {{producto: object|null, cotizacion: object|null}} contexto
 * @returns {string|null} la frase, o null si este tema no se responde aqui
 */
function deTema(
  tema,
  {
    producto = null,
    cotizacion = null,
    yaDijoLasCondiciones = false,
    // CUANTAS VECES HA OBJETADO EL PRECIO EN ESTA CONVERSACION (1 = la
    // primera). Es lo que convierte la escalera en una escalera de verdad:
    // sin esto, las cuatro objeciones seguidas de un cliente real recibian
    // el mismo parrafo palabra por palabra.
    vezDeLaObjecion = 1,
    // CUANTAS VECES SE HA CONTESTADO YA ESTE TEMA en la conversacion (1 = la
    // primera). Dos respuestas identicas seguidas son la marca mas
    // reconocible de un bot, y en la objecion de CONFIANZA pasaba con dos
    // mensajes normalisimos: "no confío en estas páginas" y "ya me estafaron
    // una vez" recibian el mismo parrafo palabra por palabra.
    vecesEsteTema = 1,
    // ----------------------------------------------------------------------
    // ¿YA SE LE MANDARON LAS FOTOS DE ESTE PRODUCTO?
    //
    // ⚠️ SIN ESTO SE PROMETEN FOTOS QUE NO LLEGAN, y Marco lo midio el
    //    2026-10-10: la respuesta de "¿cómo funciona?" terminaba en "Te paso
    //    las fotos para que lo veas bien" y no salia ninguna imagen.
    //
    // El motivo es que las fotos estan DEDUPLICADAS por producto
    // (`conversacion.fotosEnviadas`): se mandan una vez y no se repiten, que
    // es lo correcto —nadie quiere la misma galeria cinco veces—. Pero el
    // texto no se enteraba y seguia anunciandolas.
    //
    // Las promete solo si de verdad van a salir. Si ya se enviaron, la frase
    // se cae y el resto de la respuesta queda intacta.
    // ----------------------------------------------------------------------
    fotosYaEnviadas = false,
    // Ciudad ya confirmada del cliente. La usa el plazo de entrega para dar
    // el de SU ciudad (Bogota 1 a 2) en vez del rango general.
    ciudadConfirmada = null,
  } = {}
) {
  const nombre = comoSeLlama(producto);

  switch (tema) {
    // ----------------------------------------------------------------------
    // PRECIO. La cifra SIEMPRE viene de la cotizacion.
    // ----------------------------------------------------------------------
    case TEMAS.PRECIO: {
      if (!cotizacion) return null;
      const varias = cotizacion.cantidad > 1;
      const sujeto = varias ? `${cotizacion.cantidad} unidades` : nombre;
      // Mayuscula: esta frase empieza el mensaje. Salia "el cinturón térmico
      // te queda en $49.900", en minuscula, que se lee como un fragmento.
      // En minuscula: estas frases ahora van detras de una apertura
      // ("Claro que sí, el cinturón te queda en..."). Quien compone el
      // mensaje se encarga de la mayuscula inicial.
      return `${sujeto} te ${varias ? "quedan" : "queda"} en ${pesos(cotizacion.total)}.`;
    }

    // ----------------------------------------------------------------------
    // ENVIO. Sale de la politica del catalogo, nunca por costumbre.
    // ----------------------------------------------------------------------
    case TEMAS.ENVIO: {
      const c = cotizacion && cotizacion.condiciones;
      // Igual que el pago: la POLITICA de envio esta en la ficha y no
      // necesita cotizacion. Lo que necesita cotizacion es el IMPORTE.
      if (envioVaIncluido(producto, cotizacion)) return "el envío va incluido, no pagas nada aparte.";
      if (cotizacion && cotizacion.envio > 0) return `El envío a tu ciudad son ${pesos(cotizacion.envio)}.`;
      return loConfirmo("El envío", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // PAGO. La etiqueta la escribe el catalogo.
    // ----------------------------------------------------------------------
    case TEMAS.PAGO: {
      const c = cotizacion && cotizacion.condiciones;
      // LA FORMA DE PAGO NO ES UN IMPORTE: NO HACE FALTA COTIZAR PARA DECIRLA.
      //
      // Antes solo se leia de `cotizacion.condiciones`, asi que sin
      // cotizacion -y sin cotizacion no se esta cuando el cliente todavia
      // no dijo cuantas quiere- esto devolvia `loConfirmo`. El 08-oct una
      // clienta pregunto "Algo contra entrega" y recibio "el precio no te
      // lo quiero decir a medias": ni contesto lo que pregunto, ni era
      // verdad -el metodo de pago esta en la ficha, aprobado-.
      if (pagaAlRecibir(producto, cotizacion)) {
        // ⚠️ LOS MEDIOS DE PAGO SE CONFIRMARON EL 2026-10-09 (parche 4):
        //    efectivo, Nequi, Daviplata o transferencia.
        //
        // Llevaban desde el 07-oct en DATOS-PENDIENTES, y el bot solo podia
        // decir "efectivo al mensajero". En Colombia mucha gente no carga
        // efectivo: a quien preguntaba por Nequi se le estaba diciendo, sin
        // querer, que no se podia.
        const medios = producto && producto.pago && producto.pago.mediosAlRecibir;
        if (Array.isArray(medios) && medios.length) {
          const lista = medios.length > 1 ? `${medios.slice(0, -1).join(", ")} o ${medios[medios.length - 1]}` : medios[0];
          // ⚠️ "pagas cuando lo recibes" VA SEGUIDO Y SIN NADA EN MEDIO.
          //
          // Al añadir los medios escribi "le pagas al mensajero cuando lo
          // recibes", y eso rompio tres pruebas a la vez -las del caso 4 de
          // Marco y las dos de la venta perdida del 08-oct- porque todas
          // buscan esa frase literal. No eran pruebas fragiles: es LA frase
          // que contesta "¿es contra entrega?", y partirla con "al
          // mensajero" en medio la deja sin decir lo que importa.
          return `pagas cuando lo recibes, al mensajero, como te quede más fácil: ${lista}. Nada por adelantado.`;
        }
        return "pagas cuando lo recibes, en la puerta de tu casa. Nada por adelantado.";
      }
      if (c && c.pagoEtiqueta) return c.pagoEtiqueta;
      if (producto && producto.pago && producto.pago.etiqueta) return String(producto.pago.etiqueta);
      // Preguntar por Nequi o transferencia cuando el metodo es contraentrega
      // es frecuente, y la respuesta honesta es que eso lo confirma alguien.
      return loConfirmo("La forma de pago", "la", producto, cotizacion);
    }

    case TEMAS.COLOR: {
      // SIN capitalizar: esta frase puede ir detras de una apertura ("Sí,
      // viene únicamente en color rosado"). Capitalizarla aqui producia
      // "Sí, Viene únicamente...", con mayuscula en medio de la frase.
      const dato = caracteristica(producto, /color|rosad|negr|blanc|azul/);
      if (dato) return `${dato}.`;
      return loConfirmo("Los colores disponibles", "los", producto, cotizacion);
    }

    case TEMAS.TALLA: {
      const dato = caracteristica(producto, /talla/);
      if (dato) return `${dato}.`;
      return loConfirmo("Las tallas", "las", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // MEDIDAS Y AJUSTE: EL TEMA SENSIBLE DE ESTE PRODUCTO
    //
    // Marco fue explicito: no hay medidas del ajuste y no se promete que
    // sirva para cualquier contorno. Y la pregunta llega siempre, porque "me
    // sirve a mi?" es lo primero que pregunta quien compra algo que se pone.
    //
    // La tentacion es contestar con el dato aprobado -"es talla unica con
    // correa ajustable"- y dejar que la clienta concluya que le sirve. Eso es
    // la promesa prohibida dicha a medias. Se dice el dato Y se dice que el
    // contorno exacto no lo tenemos.
    // ----------------------------------------------------------------------
    case TEMAS.MEDIDAS: {
      const partes = [];

      // Lo que SI se sabe y es verificable: la correa es graduable. Marco lo
      // confirmo y se ve en la foto 04. Esto ya desatasca la pregunta: antes
      // la respuesta era "no tengo las medidas y te confirmo", que frena la
      // venta en la duda mas frecuente del producto.
      const ajuste = producto && producto.ajuste;
      if (ajuste && ajuste.graduable) {
        // En MINUSCULA, como el resto de las frases de este archivo: va
        // detras de una apertura y la mayuscula la pone `voz.unir`. Con la
        // "L" fija salia "Sí, La correa es graduable".
        // Si hay medida concreta, esta frase sobra: la siguiente ya dice que
        // es elastica Y hasta cuanto. Decir las dos cosas salia "la correa es
        // graduable... Es elástica y se estira", que suena a relleno.
        if (!(ajuste && ajuste.contornoMaximoCm)) {
          partes.push("la correa es graduable, así que se ajusta a distintas medidas.");
        }
      } else {
        const talla = caracteristica(producto, /talla/);
        if (talla) partes.push(`${talla.charAt(0).toUpperCase()}${talla.slice(1)}.`);
      }

      // Y LO QUE NO SE SABE SIGUE SIN DECIRSE. "Le queda a cualquiera" es
      // una promesa que necesita un numero detras, y ese numero no existe
      // todavia: nadie midio hasta que contorno llega la correa.
      //
      // Importa mas de lo que parece por como quedo la garantia: cubre
      // defecto de fabrica, NO "no me quedo". Si se le promete a una
      // clienta que le va a quedar y no le queda, no tiene garantia — y la
      // queja seria justa, porque se lo dijimos nosotros.
      // ------------------------------------------------------------------
      // ⚠️ YA HAY NUMERO. Marco lo confirmo el 2026-10-09 (parche 4):
      //    "la correa elastica se estira hasta unos 130 a 150 cm. Le sirve a
      //    casi cualquier persona, hasta talla 4XL".
      //
      // Esto estuvo DOS DIAS en [CONFIRMAR] y era el dato que mas vendia:
      // "¿me queda?" es la duda numero uno de este producto, y la respuesta
      // era "te confirmo el contorno maximo" — pedirle a la clienta que
      // espere justo cuando estaba decidiendo.
      //
      // SIGUE PROHIBIDO "le sirve a cualquiera" y "talla unica universal":
      // la medida es concreta y hay cuerpos por encima. "Casi cualquier
      // persona" es lo que se puede sostener, y lo dijo asi Marco.
      // ------------------------------------------------------------------
      if (ajuste && ajuste.contornoMaximoCm) {
        const desde = ajuste.contornoMinCm ? `${ajuste.contornoMinCm} a ` : "hasta ";
        const talla = ajuste.hastaTalla ? `, así que le sirve a casi cualquier persona, hasta talla ${ajuste.hastaTalla}` : "";
        // ⚠️ "LA CORREA ES GRADUABLE" NO SE QUITA AL AÑADIR LA MEDIDA.
        //
        // Al meter los centimetros escribi "Es elástica y se estira hasta
        // unos 130 a 150 cm" y borre la palabra `graduable`, que llevaba
        // desde el 08-oct en caracteristicasAutorizadas. Rompio dos pruebas
        // -voz y tono- y las dos tenian razon: el numero dice CUANTO, pero
        // "graduable" dice que se AJUSTA, y es lo que tranquiliza a quien
        // pregunta "¿me queda?". El dato nuevo se suma al que ya vendia, no
        // lo reemplaza.
        partes.push(`La correa es graduable: elástica, se estira hasta unos ${desde}${ajuste.contornoMaximoCm} cm${talla}.`);
      } else {
        // Sin numero se sigue ofreciendo confirmarlo: es lo que convierte un
        // "no lo sé" en atencion.
        partes.push("Si quieres te confirmo el contorno máximo exacto antes de que lo pidas, para que vayas segura.");
      }

      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // GARANTIA. El plazo esta confirmado; lo que CUBRE, no.
    //
    // Se dice el plazo y se para ahi. La tentacion es completar con "te lo
    // cambiamos si sale defectuoso", que suena razonable y nadie aprobo: el
    // alcance de la garantia y como se tramita siguen sin definir, y una
    // promesa de cambio es la que acaba en una discusion.
    // ----------------------------------------------------------------------
    case TEMAS.GARANTIA: {
      const plazo = producto && producto.garantia;
      if (!plazo) return loConfirmo("La garantía", "la", producto, cotizacion);
      const cubre = producto.garantiaCubre;
      // El plazo y QUE cubre. Las exclusiones no van aqui: ver la nota del
      // catalogo. Abrir con "no cubre si lo mojas" enfria una venta que iba
      // bien; cuando preguntan por el alcance, se dicen completas.
      //
      // Y se cierra con el beneficio REAL de tener garantia -comprar
      // tranquila- en vez de dejar el dato suelto. No promete nada que no
      // exista: la garantia esta confirmada.
      return cubre
        ? `tiene ${plazo} de garantía por ${cubre}, así que compras con tranquilidad.`
        : `tiene garantía de ${plazo}.`;
    }

    // ----------------------------------------------------------------------
    // EL TRAMITE DE LA GARANTIA: SE DICE EL PLAZO Y SE ADMITE EL RESTO
    //
    // Marco confirmo el plazo, no el procedimiento. Contestar "1 mes" a
    // "¿cómo la hago efectiva?" responde otra pregunta, y completarlo con
    // "te lo cambiamos" es la promesa que nadie aprobo y la que acaba en
    // una discusion cuando el cliente la invoca.
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // EL TRAMITE Y EL ALCANCE: AQUI SI VAN LAS EXCLUSIONES
    //
    // Quien pregunta "¿qué cubre?" o "¿cómo la hago efectiva?" esta pidiendo
    // justamente el limite. Contestarle solo lo bueno y dejar que descubra
    // la exclusion el dia del reclamo es la forma de convertir una garantia
    // en una discusion.
    // ----------------------------------------------------------------------
    case TEMAS.GARANTIA_TRAMITE: {
      const plazo = producto && producto.garantia;
      if (!plazo) return loConfirmo("La garantía", "la", producto, cotizacion);

      const partes = [];
      const cubre = producto.garantiaCubre;
      partes.push(cubre ? `tiene ${plazo} de garantía por ${cubre}.` : `tiene garantía de ${plazo}.`);

      const tramite = producto.garantiaComoSeTramita;
      if (tramite) partes.push(`Si te llega con algún daño, ${tramite} sin ningún costo.`);
      else partes.push("Cómo se tramita te lo explica una persona del equipo.");

      const noCubre = producto.garantiaNoCubre || [];
      if (noCubre.length) {
        const lista =
          noCubre.length === 1
            ? noCubre[0]
            : `${noCubre.slice(0, -1).join(", ")} ni ${noCubre[noCubre.length - 1]}`;
        partes.push(`No cubre ${lista}.`);
      }

      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // CUANDO LLEGA. UN RANGO, NUNCA UN DIA.
    //
    // El dato es de la transportadora y es aproximado. El matiz "según la
    // ciudad" NO es un adorno: sin el, el rango se lee como un compromiso,
    // y en un pueblo apartado no se cumple.
    //
    // Y se escribe aqui, en codigo, y no se deja al modelo: la frase
    // siguiente natural -"te llega mañana"- es la que el modelo completa
    // solo, depende de la hora de corte de la transportadora y no la
    // controla nadie de NOVIKA. Esas promesas estan en claimsProhibidos.
    // ----------------------------------------------------------------------
    case TEMAS.ENTREGA: {
      // `plazoDeEntrega` resuelve Bogota (1 a 2) frente al resto (1 a 3) y
      // quita el matiz cuando ya se sabe la ciudad. `ciudadConfirmada` llega
      // del cerebro; si todavia no la sabemos, sale el rango general con su
      // matiz, que es lo honesto.
      const t = plazoDeEntrega(producto, ciudadConfirmada);
      if (!t || !t.texto) return loConfirmo("El tiempo de entrega", "lo", producto, cotizacion);
      // ANTES: "La transportadora normalmente entrega en 1 a 3 días hábiles
      // según la ciudad." Correcto y escrito como un aviso legal: hablaba de
      // la transportadora en tercera persona cuando la clienta pregunta por
      // SU pedido. "Te llega en..." dice lo mismo y lo dice alguien.
      //
      // Sigue siendo un RANGO con su matiz: lo que esta prohibido es el dia
      // concreto, no hablar en segunda persona.
      // Con ciudad conocida `plazoDeEntrega` ya devuelve el matiz vacio.
      const matiz = t.matiz ? ` ${t.matiz.replace(/^según la ciudad$/, "según tu ciudad")}` : "";
      return `te llega en ${t.texto}${matiz}.`;
    }

    // ----------------------------------------------------------------------
    // "¿ME LLEGA HOY?" — SE CONTESTA QUE NO, Y LUEGO EL PLAZO.
    //
    // Antes caia en ENTREGA y salia «Claro, te llega en 1 a 3 días hábiles».
    // El "Claro," lo pone la apertura y, delante de una pregunta de si o no,
    // lo que se lee es un SI. Y "te llega hoy" es un claim PROHIBIDO: no se
    // puede prometer porque depende de la transportadora y de la hora de
    // corte.
    //
    // ⚠️ OJO AL REDACTARLO: la frase no puede contener la secuencia "te
    //    llega hoy" NI "llega hoy" ni siquiera dentro de una negacion. "No
    //    te llega hoy" las contiene las dos, y `revisarClaims` busca
    //    subcadenas sobre el texto aplanado — tumbaria el mensaje entero.
    //    Por eso se dice "hoy mismo no" y el verbo va despues.
    // ----------------------------------------------------------------------
    case TEMAS.LLEGA_HOY: {
      const t = plazoDeEntrega(producto, ciudadConfirmada);
      if (!t || !t.texto) return loConfirmo("El tiempo de entrega", "lo", producto, cotizacion);
      const matiz = t.matiz ? ` ${t.matiz.replace(/^según la ciudad$/, "según tu ciudad")}` : "";
      return `hoy mismo no alcanza, pero va rápido: son ${t.texto}${matiz} desde que lo confirmas.`;
    }

    case TEMAS.MATERIAL: {
      // Autorizado por Marco el 2026-10-08. Era una de las preguntas que
      // mas llegan y el bot no la podia contestar.
      if (producto && producto.material && producto.material.texto) return producto.material.texto;
      const dato = caracteristica(producto, /material|tela|cuero/);
      if (dato) return `${dato}.`;
      return loConfirmo("El material", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // "¿PARA QUE SIRVE?" — LA PREGUNTA QUE NO TENEMOS APROBADA
    //
    // En la captura de Marco: "Para que sirve?" recibio "Cinturón térmico
    // con correa ajustable y panel de control. Se entrega con su empaque."
    // Eso describe el OBJETO, no responde PARA QUE sirve.
    //
    // Y no se puede completar sin inventar: lo unico aprobado es la
    // descripcion fisica. El proposito -para que lo usan las clientas- es
    // justo lo que esta prohibido afirmar sin respaldo, porque este
    // producto se compra por dolor y cualquier frase de alivio es una
    // promesa medica.
    //
    // Asi que se dice lo que SI se sabe, se ofrecen las fotos -que
    // muestran el producto mejor que cualquier frase- y se admite el
    // resto. Es lo honesto, y es lo unico que se puede hacer hasta que
    // Marco apruebe que decir: esta pedido en docs/DATOS-PENDIENTES.md.
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // "¿COMO FUNCIONA?" — LA MECANICA, Y SALE DE LA FICHA
    //
    // ⚠️ ESTA RAMA NACIO DE UN DEFECTO MEDIDO POR MARCO EL 2026-10-10.
    //
    // "Como funciona" caia en TEMAS.USO y recibia `paraQueSirve.texto`:
    //
    //   David:  "Cómo funciona"
    //   bot:    "Con gusto: Sí, es justo para eso: da calor y masaje..."
    //   David:  "Cómo funciona"          <- lo volvio a preguntar
    //   bot:    (el mismo parrafo, palabra por palabra)
    //
    // Dos cosas mal: empieza con un "Sí" que no contesta a nada -nadie
    // pregunto si sirve- y no dice NADA de la mecanica, que es justo lo que
    // se pregunta. Y la segunda vez repitio el texto exacto.
    //
    // El texto lo dicto Marco y cada dato que afirma ya estaba autorizado en
    // esta ficha desde el 09-oct: los 10 segundos, los tres niveles, los
    // cuatro modos y lo de ir sin cable. No se añade ninguna afirmacion
    // nueva: se ordenan para contestar la pregunta que de verdad se hizo.
    //
    // La segunda vez se contesta con OTRAS PALABRAS, no con el mismo
    // parrafo, porque repetir literal es la marca mas reconocible de un bot.
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // "¿COMO SE LLAMA ESO?" — la pregunta mas facil que existe, y se
    // contestaba con "no te la quiero contestar a medias".
    // ----------------------------------------------------------------------
    case TEMAS.NOMBRE_DEL_PRODUCTO: {
      const n = (producto && (producto.nombre || producto.nombreCorto)) || null;
      if (!n) return loConfirmo("Cómo se llama", "lo", producto, cotizacion);
      const paraQue = producto && producto.paraQueSirve && producto.paraQueSirve.texto;
      // Y detras PARA QUE SIRVE, porque quien pregunta el nombre lo que
      // quiere es saber que es. El nombre solo no le dice nada.
      const resumen = paraQue
        ? " Da calor y masaje en la parte baja del abdomen."
        : "";
      return `es el ${n} 💗${resumen}`;
    }

    // ----------------------------------------------------------------------
    // "¿FUNCIONA CON FRIO?" — SE SABE QUE NO, Y DECIRLO ES LA RESPUESTA.
    //
    // Salio "a medias" el 09-oct. La ficha declara calor y masaje, y nada de
    // frio: eso es un NO, no un hueco. Decir "no lo sé" deja al cliente
    // creyendo que a lo mejor sí, y es una devolucion esperando.
    // ----------------------------------------------------------------------
    case TEMAS.FRIO: {
      const t = producto && producto.temperatura;
      const niveles = t && Array.isArray(t.niveles) && t.niveles.length ? ` (${t.niveles.length} niveles)` : "";
      const m = producto && producto.masaje;
      const conMasaje = m && m.modos ? " y masaje" : "";
      return `solo da calor 🔥${niveles}${conMasaje}. No tiene función de frío.`;
    }

    // ----------------------------------------------------------------------
    // "SERIA PARA FIN DE MES" — no es un no, es un sí con fecha.
    //
    // ⚠️ OJO CON LO QUE SE PROMETE AQUI. Marco pidio "te escribo unos dias
    //    antes para confirmar", y eso el bot NO lo puede hacer solo: pasada
    //    la ventana de 24 h de WhatsApp hace falta una plantilla aprobada, y
    //    todavia no hay ninguna.
    //
    // Asi que la frase dice que lo dejamos anotado -que es verdad: se abre la
    // tarea en la bandeja- y NO promete quien escribe ni cuando. Cuando la
    // plantilla exista, esta respuesta puede prometer el recordatorio.
    // ----------------------------------------------------------------------
    case TEMAS.PARA_DESPUES:
      return (
        "¡claro que sí! Te lo podemos despachar cuando me digas 😊 " +
        "Te lo dejo anotado con tu fecha y lo tenemos listo para cuando lo necesites."
      );

    // ----------------------------------------------------------------------
    // "SOY MENOR DE EDAD" — ni se rechaza ni se ignora.
    //
    // El 09-oct el bot lo IGNORO y siguio pidiendo la direccion. El dato
    // importa porque el pago es contraentrega: alguien mayor tiene que
    // recibir y pagar. El texto es el que escribio Marco.
    // ----------------------------------------------------------------------
    case TEMAS.MENOR_DE_EDAD:
      return (
        "¡claro! Solo necesitamos que una persona mayor de edad lo reciba y lo pague cuando llegue 😊 " +
        "¿A nombre de quién lo dejamos?"
      );

    // ----------------------------------------------------------------------
    // "SERA OTRO DIA" — se le deja la puerta abierta y NO se le insiste.
    //
    // edgar, 09-oct: recibio "¿Te lo aparto, o quieres que te cuente algo
    // más...?" — la misma pregunta que acababa de aplazar. Quien dice "otro
    // día" no quiere una pregunta mas: quiere poder volver sin incomodidad.
    //
    // ⚠️ ESTA RESPUESTA NO TERMINA EN PREGUNTA, Y ES DELIBERADO. Es la unica
    //    del catalogo que no empuja, porque empujar aqui es justo el error.
    // ----------------------------------------------------------------------
    case TEMAS.OTRO_DIA: {
      const partes = ["¡sin problema! Cuando quieras me escribes y te lo dejo listo 😊"];
      if (pagaAlRecibir(producto, cotizacion)) {
        partes.push("Aquí seguimos, y recuerda que pagas solo cuando te llegue.");
      }
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // LOS TEMAS DEL PARCHE 4. Cada uno con el dato que confirmo Marco.
    // ----------------------------------------------------------------------
    case TEMAS.RELAJA: {
      const m = producto && producto.masaje;
      const conMasaje = m && m.modos ? " y el masaje" : "";
      return `sí: el calor${conMasaje} relajan la zona donde lo pones y dan una sensación de descanso muy rica.`;
    }

    // "¿Puedo dormir con él?" — y la respuesta es NO, dicha con cariño.
    //
    // ⚠️ "puedes dormir con el" sigue en claimsProhibidos, y esta rama no lo
    //    contradice: dice lo contrario. Antes caia en SEGURIDAD -que habla de
    //    quemaduras- y la clienta se quedaba sin saber si podia o no.
    case TEMAS.DORMIR: {
      const d = producto && producto.dormir;
      if (d && d.texto) return d.texto;
      return "mejor no: te recomiendo quitártelo antes de dormir, por seguridad.";
    }

    // "¿Se apaga solo?" — NO, y decirlo bien importa.
    //
    // Si el cliente cree que se apaga solo, se duerme con el puesto, que es
    // justo lo que la ficha pide no hacer. Confirmado por Marco el 09-oct.
    case TEMAS.APAGADO_AUTO: {
      const sg = producto && producto.seguridad;
      if (sg && sg.textoApagado) return sg.textoApagado;
      return "lo apagas tú con el botón cuando termines. Lo ideal son ratos de 15 a 20 minutos.";
    }

    case TEMAS.HOMBRES:
      return "¡claro! Para la espalda baja o la cintura lo puede usar cualquier persona.";

    case TEMAS.EN_MOVIMIENTO: {
      const e = producto && producto.energia;
      const sinCable = e && e.recargable ? "Por eso es inalámbrico: " : "";
      return `¡sí! ${sinCable}lo llevas puesto trabajando, estudiando o en la casa.`;
    }

    case TEMAS.FACIL_USO: {
      const pa = producto && producto.pantalla;
      const conPantalla = pa && pa.texto ? ", y la pantalla te muestra todo" : "";
      return `¡facilísimo! Un botón para prender, uno para el calor y otro para el masaje${conPantalla}.`;
    }

    case TEMAS.TIEMPO_DE_USO:
      return "lo ideal son ratos de 15 a 20 minutos y luego descansas un poco. Lo puedes repetir varias veces al día.";

    // "¿Por qué transportadora?", "¿me mandan la guía?"
    //
    // NO SE NOMBRA LA TRANSPORTADORA: cual va cada pedido lo decide el
    // despacho, y prometer una concreta es una promesa que no controla el
    // bot. Lo que si es verdad es que la guia se manda por aqui.
    case TEMAS.TRANSPORTADORA:
      return "va por transportadora nacional, y te mandamos el número de guía por aquí en cuanto salga.";

    case TEMAS.COMO_SE_USA: {
      const u = producto && producto.comoSeUsa;
      if (u && u.texto) {
        // Se ALTERNA, no se cambia una sola vez: con `>= 2` fijo, la tercera
        // vez repetia la segunda palabra por palabra, que es justo lo que
        // Marco pidio no hacer nunca. Alternando, dos mensajes seguidos
        // nunca son iguales.
        const par = vecesEsteTema % 2 === 0;
        if (par && u.textoAlternativo) return u.textoAlternativo;
        return u.texto;
      }

      // Sin `comoSeUsa` en la ficha se compone con los datos que SI haya.
      // Existe para que otro producto del catalogo no se quede sin respuesta
      // por no tener el bloque redactado, y para no volver a caer en el
      // "no te lo quiero contestar a medias" teniendo los datos sueltos.
      const piezas = [];
      const t = producto && producto.temperatura;
      const m = producto && producto.masaje;
      const e = producto && producto.energia;
      if (t && Array.isArray(t.niveles) && t.niveles.length) {
        piezas.push(`tiene ${t.niveles.length} niveles de calor (${t.niveles.join(", ")} ${t.unidad || "°C"})`);
      }
      if (m && m.modos) piezas.push(`${m.modos} modos de masaje`);
      if (e && e.recargable) piezas.push("y es recargable, así que no va conectado mientras lo usas");
      if (!piezas.length) return loConfirmo("Cómo funciona", "lo", producto, cotizacion);
      return `${piezas.join(", ").replace(/^(\w)/, (c) => c.toUpperCase())}.`;
    }

    case TEMAS.USO: {
      // PARA QUE SIRVE, cuando Marco lo autorizo. Era la peor respuesta
      // del bot: a "¿para qué sirve?" contestaba una lista de piezas
      // -"cinturón térmico con correa ajustable y panel de control"- o se
      // negaba a decirlo. De un producto que se llama "cinturón térmico
      // para cólicos", negarse a explicar para qué sirve es absurdo.
      //
      // Lo que se dice es el USO PREVISTO, no una promesa clinica: "el
      // calor alivia el cólico" describe el producto; "cura los cólicos"
      // sigue prohibido, igual que embarazo, DIU o medicacion.
      const paraQue = producto && producto.paraQueSirve && producto.paraQueSirve.texto;
      if (paraQue) {
        // Y se ofrecen las fotos: a quien pregunta para que sirve, verlo
        // puesto le dice mas que cualquier frase. La prueba que lo exige
        // cazo la primera version de esta respuesta.
        //
        // `fotosYaEnviadas` es el candado del 10-oct: si ya las tiene, no se
        // le vuelven a prometer, porque la deduplicacion no las reenvia.
        const conFotos = (producto.imagenes || []).length && !fotosYaEnviadas;
        return conFotos ? `${paraQue} Te paso las fotos para que lo veas bien.` : paraQue;
      }

      const descripcion = producto && producto.descripcionAutorizada;
      if (!descripcion) return loConfirmo("Para qué sirve", "lo", producto, cotizacion);

      const partes = [String(descripcion)];
      if (producto && (producto.imagenes || []).length && !fotosYaEnviadas) {
        partes.push("Te paso las fotos para que lo veas bien.");
      }
      partes.push("Si quieres que te cuente más de cómo se usa, te lo explica una persona del equipo.");
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // DESCONFIANZA. Se responde con un hecho verificable, no con adjetivos.
    //
    // "Somos serios, confía en nosotros" no convence a nadie. Que pagues
    // cuando lo recibas si: es el argumento que quita el riesgo, y sale del
    // catalogo, no de una promesa.
    // ----------------------------------------------------------------------
    case TEMAS.CONFIANZA: {
      // ⚠️ ANTES MIRABA SOLO `cotizacion.condiciones`, Y ESO ERA UN DEFECTO
      //    DE LA MISMA FAMILIA QUE YA COSTO UNA VENTA EL 08-OCT CON EL PAGO:
      //    el metodo de cobro es una POLITICA del producto, no un importe,
      //    asi que se puede contestar SIN haber cotizado.
      //
      // Medido el 09-oct: "¿tienen tienda física?" y "esto es real o es
      // estafa?" caian al fallback -«cualquier duda te la resuelve una
      // persona del equipo»- porque no habia cotizacion en ese turno. A
      // quien desconfia se le estaba contestando con un "ya te dira
      // alguien", que es lo contrario de dar confianza, teniendo el
      // argumento bueno -el contraentrega- en la ficha.
      if (pagaAlRecibir(producto, cotizacion)) {
        // ------------------------------------------------------------
        // LA SEGUNDA VEZ SE DICE DISTINTO, Y NO ES COSMETICA.
        //
        // Lo caza una conversacion de prueba del 09-oct:
        //
        //   clienta · "no confío en estas páginas"
        //   bot     · "Pagas cuando el pedido llega a tus manos…"
        //   clienta · "ya me estafaron una vez"
        //   bot     · (el mismo parrafo, palabra por palabra)
        //
        // Las dos frases son la MISMA objecion dicha de dos formas, asi que
        // la guarda anti-eco no actua -y no debe: la respuesta es correcta-.
        // Pero quien insiste en que no confia no necesita el mismo argumento
        // otra vez: necesita que le reconozcan lo que acaba de contar.
        //
        // El hecho de fondo no cambia -el contraentrega sigue siendo el
        // argumento- pero se dice desde el lado de ella, no del nuestro.
        if (vecesEsteTema >= 2) {
          // Y NO empieza por "te entiendo": la apertura de CONFIANZA ya es
          // "Te entiendo perfectamente.", y las dos juntas salian como
          // «Te entiendo perfectamente. Te entiendo de verdad…».
          const partes = [
            "con más razón te sirve así: no pones un peso hasta tenerlo en la mano. " +
              "Si no llega, no pagas nada — el riesgo lo corremos nosotros, no tú.",
          ];
          if ((producto && (producto.imagenes || []).length) > 0) {
            partes.push("Y ahí arriba te dejé las fotos reales del producto, no son de catálogo.");
          }
          return partes.join(" ");
        }

        const partes = [
          "pagas cuando el pedido llega a tus manos, así que no arriesgas nada: si no te llega, no pagas.",
        ];
        const plazo = producto && producto.garantia;
        if (plazo) partes.push(`Y te va con ${plazo} de garantía.`);
        return partes.join(" ");
      }
      return "somos NOVIKA, una tienda colombiana, y te llega a tu casa con envíos a todo el país.";
    }

    // ----------------------------------------------------------------------
    // LA OBJECION DE PRECIO. LA ESCALERA, Y NUNCA UN DESCUENTO.
    //
    // Es la objecion que mas plata mueve y hasta ahora no se reconocia:
    // "esta muy caro" caia en el camino generico.
    //
    // La FORMA viene de BIKERPRO, que la tiene medida: no saltar al
    // descuento, porque las jugadas que no cuestan nada cierran igual o
    // mejor. Las CONDICIONES no se copian -su tope de $3.000, su envio
    // cobrado aparte y su politica de anticipado son suyos-.
    //
    // 🚫 AQUI NO SE OFRECE NINGUN DESCUENTO, y no es timidez: NOVIKA no
    // tiene politica de descuento aprobada. El catalogo declara "si hay
    // descuento por cantidad" como dato NO confirmado. El riesgo es medido:
    // el bot de BIKERPRO se invento "$55.900 con pago anticipado" en la
    // primera objecion, y eso estaba tasado en ~$482.400/mes. Si la clienta
    // insiste, el final de la escalera es una persona, no una cifra.
    //
    // Lo que SI se puede decir, y es verdad en NOVIKA -Marco lo autorizo
    // con su propio ejemplo, "esta en valor promocion, el envio esta
    // totalmente gratuito"-:
    //
    //   1. el envio va incluido, asi que el precio que vio es el final;
    //   2. paga al recibir, asi que no arriesga plata;
    //   3. la pareja sale mejor que dos sueltas.
    //
    // El paso 3 es el mas fuerte de la escalera y el unico donde bajarle el
    // costo a la clienta nos deja MAS plata. Y se comprueba CONTRA EL
    // COTIZADOR en vez de afirmarlo: si algun dia la tabla cambia y dos
    // dejan de convenir, la frase desaparece sola.
    //
    // ⚠️ SIN CIFRAS. Se ofrece pasar el precio de dos, no se escribe: el
    // importe autorizado de este turno es el de la cantidad cotizada, y
    // colar aqui el de otra cantidad es justo lo que `revisarImportes`
    // existe para cazar. Cuando la clienta diga que si, el cotizador lo
    // calcula por el camino normal.
    // ----------------------------------------------------------------------
    case TEMAS.OBJECION_PRECIO: {
      const c = cotizacion && cotizacion.condiciones;
      const partes = [];

      // TODAS EN MINUSCULA: las une `voz.unir`, que capitaliza despues de
      // punto. Escribirlas con mayuscula dejaba "Te entiendo, y te explico:
      // Si llevas dos..." cuando esta era la unica frase que quedaba, y una
      // mayuscula tras dos puntos es de las cosas que delatan a la maquina.
      //
      // `yaDijoLasCondiciones` lo pone quien compone el mensaje. Si el turno
      // ya encabezo con la linea comercial -que dice "con envio incluido y
      // pagas al recibir"-, repetirlo aqui sacaba las condiciones DOS VECES
      // en el mismo mensaje. Lo cazo "esta caro, el envio cuanto vale?".
      // ⚠️ EN ESTA RAMA `yaDijoLasCondiciones` YA NO SILENCIA LOS PASOS 1 Y
      //    2, Y ES UN CAMBIO DELIBERADO DEL 09-OCT.
      //
      // La regla de no repetir las condiciones es buena en general, pero
      // aqui producia el peor resultado posible. Todos los clientes entran
      // por un anuncio, y el primer mensaje del bot YA dice "con envío
      // incluido y pagas al recibir". Asi que en la practica
      // `yaDijoLasCondiciones` era SIEMPRE true cuando llegaba la objecion,
      // y la escalera empezaba directamente por el paso 3.
      //
      // Resultado medido: a "no me alcanza" el bot contestaba *«si llevas
      // dos, te quedan en $85.000 las dos juntas»*. A quien acaba de decir
      // que no le alcanza se le ofrecia gastar MAS. Es la respuesta mas
      // sorda que puede dar un vendedor.
      //
      // Contestar una objecion de precio ES repetir las condiciones: son el
      // argumento, no un dato de contexto. Que la clienta las haya leido en
      // el saludo no significa que haya caido en la cuenta de lo que
      // implican, y ponerlas delante de "está muy caro" es exactamente lo
      // que hace que el precio se lea distinto.
      //
      // Y ADEMAS SE USA LA FICHA, NO SOLO LA COTIZACION. Antes exigia
      // `cotizacion.condiciones`, asi que una objecion sin cotizacion en el
      // turno se quedaba sin los dos pasos buenos — el mismo defecto que ya
      // costo una venta el 08-oct con el metodo de pago.
      // `yaDijoLasCondiciones` sigue mandando SOLO contra la duplicacion
      // DENTRO DEL MISMO MENSAJE: si el turno ya encabezo con la linea
      // comercial -"con envío incluido y pagas al recibir"-, repetirla aqui
      // la saca dos veces. Lo caza "está caro, ¿y el envío cuánto vale?".
      //
      // Lo que SI cambio el 09-oct es que ya no decide la escalera: eso lo
      // hace `vezDeLaObjecion`. Antes, como todos los clientes entran por
      // un anuncio cuyo primer mensaje ya canta las condiciones, en la
      // practica esta guarda estaba SIEMPRE activa cuando llegaba la
      // objecion y la escalera arrancaba por el paso 3. Medido: a "no me
      // alcanza" el bot contestaba «si llevas dos, te quedan en $85.000».
      // A quien dice que no le alcanza se le ofrecia gastar mas.
      // SOLO EN LA PRIMERA. Repetir los dos argumentos en la segunda
      // objecion es lo que producia dos mensajes identicos seguidos.
      if (!yaDijoLasCondiciones && vezDeLaObjecion === 1) {
        if (envioVaIncluido(producto, cotizacion)) {
          partes.push("el envío ya va incluido en ese precio, así que no hay nada extra que pagar al final.");
        }
        if (pagaAlRecibir(producto, cotizacion)) {
          partes.push("pagas cuando lo tienes en la mano, así que no arriesgas nada.");
        }
      }

      // EL PASO MAS FUERTE, Y AHORA CON LA CIFRA.
      //
      // Decia "te paso el precio de las dos si quieres", sin el numero,
      // porque el importe autorizado del turno era el de la cantidad
      // cotizada. Marco lo autorizo expresamente -"ofrecerle las 2 unidades
      // para que lleven dos y le salga mas barato... sale por 85.000"- y una
      // oferta con el precio puesto cierra; una que promete pasarlo obliga a
      // un turno mas y a que la clienta vuelva a preguntar.
      //
      // La cifra sale del COTIZADOR y sus importes se autorizan en
      // `preparar`, igual que los de la cotizacion informativa.
      const dos = ofertaDeDos(producto);
      if (dos && vezDeLaObjecion <= 2) {
        // La MISMA oferta, dicha de dos formas. En la primera objecion va
        // detras de las condiciones, como el tercer argumento. En la
        // segunda es LO UNICO que se dice, asi que se encabeza -y se
        // enmarca como lo que es: lo mejor que hay-, porque soltar la misma
        // frase subordinada dos veces se lee como un disco rayado.
        partes.push(
          vezDeLaObjecion === 1
            ? `si llevas dos, te quedan en ${pesos(dos.total)} las dos juntas, que sale mejor que dos por separado.`
            : `lo mejor que te puedo hacer es la pareja: dos te quedan en ${pesos(dos.total)}, ` +
              `que te sale bastante mejor que dos sueltas. Y si te sobra una, es el regalo perfecto para una amiga.`
        );
      }

      // ----------------------------------------------------------------
      // TERCER ESCALON: UNA PERSONA, NO UNA CIFRA
      //
      // ⚠️ POR QUE HAY UN CONTADOR Y NO UNA SOLA RESPUESTA.
      //
      // Medido el 09-oct: cuatro objeciones seguidas -"está muy caro",
      // "hay descuento?", "no me alcanza", "me lo dejas más barato?"-
      // recibian las CUATRO el mismo parrafo, palabra por palabra. Un
      // vendedor que repite el mismo argumento cuatro veces le esta
      // diciendo al cliente que no lo escucha, y es justo el punto donde
      // se decide la venta.
      //
      // Insistir despues del segundo intento no aporta nada nuevo: los
      // dos argumentos que no cuestan plata ya se dieron y la pareja ya
      // se ofrecio. A partir de ahi lo honesto es una persona.
      //
      // 🚫 Y SIGUE SIN HABER DESCUENTO. NOVIKA no tiene politica
      //    aprobada; el catalogo declara "si hay descuento por cantidad"
      //    como dato NO confirmado. El final de la escalera es una
      //    persona, nunca una cifra. Si Marco aprueba un tope algun dia,
      //    el sitio es el catalogo y este es el escalon donde entra.
      // ----------------------------------------------------------------
      if (vezDeLaObjecion >= 3) {
        return (
          "ya te di lo mejor que tengo por aquí. Déjame pasarle tu caso a una persona del equipo, " +
          "que es quien puede mirar si hay algo más que hacer, y te responde por este chat."
        );
      }

      if (partes.length) return partes.join(" ");

      // Si las condiciones ya se dijeron y la pareja no conviene, no queda
      // nada que añadir: callar es mejor que rellenar.
      if (yaDijoLasCondiciones) return null;

      // Sin condiciones y sin pareja no queda argumento honesto que dar, y
      // un "esta muy caro" sin respuesta es una venta perdida en silencio.
      // Se admite y se pasa a una persona, que es el final de la escalera.
      return loConfirmo("Un precio especial", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // COMO SE ALIMENTA: BATERIA, CARGADOR, ENCHUFE
    //
    // La ficha declara "si funciona con bateria o enchufado, y cuanto dura"
    // como dato NO CONFIRMADO, asi que aqui la respuesta honesta es que lo
    // confirma una persona. Y la pregunta llega: es un aparato que se
    // calienta, lo primero que se piensa es como se enciende.
    //
    // Estaba dentro de USO, que responde con `paraQueSirve`, y el resultado
    // era contestar otra cosa:
    //
    //   clienta: "Con cables para cargar"
    //   bot:     "Sí, es justo para eso: el calor... alivia el cólico."
    //
    // Se ofrecen las fotos porque el cable y el panel SE VEN en la 03 y la
    // 04: es lo unico verificable que se puede dar ahora mismo.
    // ----------------------------------------------------------------------
    case TEMAS.ENERGIA: {
      // ⚠️ ESTA RESPUESTA DEJO DE SER UN "NO LO SE" EL 2026-10-09.
      //
      // Era la pregunta que mas veces quedaba sin contestar: de las cinco que
      // seguian fallando, TRES eran de energia ("Trae cargador", "Con cables
      // para cargar", "es recargable o de pilas?"). Y una clienta la
      // pregunto DOS VECES SEGUIDAS porque la primera respuesta -que era
      // admitir el hueco- no le servia de nada.
      //
      // Marco autorizo la ficha del fabricante, asi que ahora hay dato. Lo
      // que mas vende de aqui no es el mAh: es "mientras lo usas no va
      // conectado a nada", porque la duda de fondo de quien pregunta por el
      // cable es si va a quedar amarrada a un enchufe.
      const e = producto && producto.energia;
      if (e && e.texto) return e.texto;
      return loConfirmo("Si funciona con batería o enchufado", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // USARLO MIENTRAS SE CARGA. Dato confirmado por Marco el 2026-10-09.
    //
    // ⚠️ ESTO ERA UN DEFECTO DE MI PROPIO PARCHE, y de la peor clase: el
    //    dato estaba escrito en la ficha (`energia.usarMientrasCarga`) y
    //    NO estaba conectado a ninguna respuesta. O sea que el bot lo tenia
    //    y seguia contestando lo contrario.
    //
    // A "¿se puede usar mientras se carga?" respondia el texto de ENERGIA,
    // que termina en "mientras lo usas no va conectado a nada". Para quien
    // pregunta eso, es un NO. Y la respuesta es SI.
    //
    // Es exactamente la trampa que el catalogo documenta tres veces: un
    // dato confirmado hay que escribirlo Y usarlo, y olvidar lo segundo no
    // rompe ninguna prueba.
    // ----------------------------------------------------------------------
    case TEMAS.USAR_CARGANDO: {
      const e = producto && producto.energia;
      if (e && e.usarMientrasCarga === true && e.textoUsarCargando) return `sí, ${e.textoUsarCargando}`;
      if (e && e.usarMientrasCarga === false) return "no se usa mientras se carga: primero lo cargas y después lo usas sin cables.";
      if (e && e.texto) return e.texto;
      return loConfirmo("Si se puede usar mientras se carga", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // MASAJE. Es lo que convierte "una almohadilla mas" en un aparato.
    // ----------------------------------------------------------------------
    case TEMAS.MASAJE: {
      const m = producto && producto.masaje;
      if (m && m.texto) return m.texto;
      return loConfirmo("Si tiene masaje", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // ESPALDA / LUMBAR. Amplia el producto sin inventar nada.
    //
    // "¿sirve para la espalda?" casaba con `sirve para` y recibia la frase de
    // los colicos, que no contesta la pregunta. Y la respuesta es si.
    // ----------------------------------------------------------------------
    case TEMAS.ESPALDA: {
      const z = producto && producto.zonasDeUso;
      if (z && z.texto) return `¡sí! ${z.texto}`;
      return loConfirmo("Si sirve para la espalda", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // RUIDO. La duda de quien lo quiere usar en la oficina.
    // ----------------------------------------------------------------------
    case TEMAS.RUIDO: {
      const m = producto && producto.masaje;
      if (m && m.ruido) return m.ruido.charAt(0).toLowerCase() + m.ruido.slice(1);
      return loConfirmo("Si hace ruido", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // DISCRECION. Lo puede llevar puesto trabajando, y eso vende.
    // ----------------------------------------------------------------------
    case TEMAS.DISCRECION: {
      const z = producto && producto.zonasDeUso;
      if (z && z.discrecion) return z.discrecion.charAt(0).toLowerCase() + z.discrecion.slice(1);
      return loConfirmo("Si se nota debajo de la ropa", "lo", producto, cotizacion);
    }

    case TEMAS.FOTOS:
      // Solo se prometen si existen: el cerebro decide si las manda y pasa
      // `producto`. Un bot que anuncia fotos y no manda ninguna deja al
      // cliente esperando algo que no llega.
      if (producto && (producto.imagenes || []).length) return "Te muestro las fotos.";
      return null;

    // ======================================================================
    // LAS DIECISEIS RESPUESTAS DE ABAJO SON DEL 2026-10-09
    //
    // Todas salen de medir: `herramientas/sondear.js` corrio 65 preguntas
    // copiadas del panel y 22 recibieron la misma frase de "no te la quiero
    // contestar a medias". No faltaba el dato: faltaba el tema.
    //
    // ⚠️ REGLA QUE NO SE NEGOCIA Y QUE ESTAS RESPUESTAS CUMPLEN UNA A UNA:
    //    ninguna afirma nada que no este ya aprobado en la ficha.
    //
    // Se investigaron fichas de otros vendedores del mismo producto para
    // ENTENDER que pregunta la gente. NADA de lo que dicen esas fichas
    // -3 niveles de calor, 3 modos de vibracion, infrarrojos, calienta en 3
    // segundos, bateria recargable- entra aqui: no es nuestra marca la que
    // lo autorizo, y si el bot lo afirma y llega otra cosa, la devolucion es
    // nuestra. Lo que falta esta en `docs/DATOS-PENDIENTES.md` para que
    // Marco lo confirme.
    //
    // Lo que SI se puede decir, y es mucho, sale de tres sitios de la ficha:
    //   · `caracteristicasAutorizadas` (rosado, talla unica, empaque, panel)
    //   · `garantiaNoCubre` (mojarlo) -> permite contestar el lavado
    //   · `pago.metodo` + `politicaEnvio` -> contraentrega y envio incluido
    // ======================================================================

    // ----------------------------------------------------------------------
    // CUIDADO Y LAVADO
    //
    // La ficha YA tiene la respuesta y nadie la estaba usando:
    // `garantiaNoCubre` incluye "mojarlo". Eso convierte una pregunta sin
    // respuesta en una respuesta clara Y en un aviso util: es un aparato con
    // panel de control, y es mejor que la clienta lo sepa ANTES de usarlo
    // que cuando reclame.
    // ----------------------------------------------------------------------
    case TEMAS.CUIDADO: {
      // El dato propio de la ficha (2026-10-09) manda sobre la deduccion que
      // se hacia desde `garantiaNoCubre`. La deduccion era correcta -si
      // mojarlo no lo cubre la garantia, no se moja- pero decia menos: no
      // explicaba COMO se limpia, que es lo que preguntan.
      const c = producto && producto.cuidado;
      if (c && c.texto) return c.texto;

      const noCubre = (producto && producto.garantiaNoCubre) || [];
      if (noCubre.some((x) => /moj/i.test(String(x)))) {
        return (
          "no se moja ni se mete al agua: lleva panel de control, y la garantía no cubre daños por mojarlo. " +
          "Por fuera lo pasas con un paño apenas húmedo y listo."
        );
      }
      return loConfirmo("Cómo se limpia", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // SEGURIDAD DE USO
    //
    // "¿me lo puedo poner dormida toda la noche?" estaba ANOTADO en el
    // repositorio como la peor respuesta del bot y seguia sin arreglar.
    //
    // No hay dato aprobado de horas de uso, asi que NO se dice un numero. Lo
    // que si es verdad y ya esta aprobado: tiene panel de control, o sea que
    // se regula y se apaga. Eso responde el fondo de la pregunta -"¿me puede
    // pasar algo?"- sin inventar una especificacion.
    // ----------------------------------------------------------------------
    case TEMAS.SEGURIDAD: {
      // ⚠️ "¿me lo puedo poner dormida toda la noche?" ERA EL EJEMPLO QUE
      //    ESTE REPOSITORIO LLEVABA ANOTADO COMO "la peor respuesta del bot",
      //    y hasta el 09-oct seguia contestandose admitiendo el hueco.
      //
      // Ahora hay dato y es un NO claro, autorizado por Marco en la seccion
      // de SEGURIDAD de su guia. Y un "no" concreto vende MAS que un "lo
      // confirmo": la clienta ve que sabemos de lo que hablamos.
      const d = producto && producto.dormir;
      const avisos = (producto && producto.seguridad && producto.seguridad.avisos) || [];
      const partes = [];
      if (d && d.texto) partes.push(d.texto);
      if (avisos.length) partes.push(avisos[0]);
      if (!partes.length) {
        const tienePanel = caracteristica(producto, /panel\s+de\s+control/i);
        return tienePanel
          ? "lleva panel de control, así que lo regulas y lo apagas cuando quieras."
          : loConfirmo("Cuánto tiempo se puede usar", "lo", producto, cotizacion);
      }
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // CONTRAINDICACIONES: EL UNICO TEMA DONDE LA RESPUESTA CORRECTA ES "NO"
    //
    // Embarazo, DIU, lactancia, quistes, endometriosis. Cinco de estos estan
    // literalmente en `claimsProhibidos`, pero esa lista solo revisa lo que
    // redacta el modelo: no habia nada que enrutara la PREGUNTA.
    //
    // Y no se contesta con "lo confirmo con el equipo", porque el equipo
    // tampoco puede autorizarlo: no somos quien. Se dice que lo mire con su
    // medico, y se sostiene la venta con lo unico que de verdad la sostiene
    // aqui: que paga al recibir.
    //
    // 🚫 NO SE AMPLIA PARA DECIR QUE SI. Ni "en embarazo no hay problema",
    //    ni "para quistes sirve". Eso lo decide un medico, no un catalogo.
    // ----------------------------------------------------------------------
    case TEMAS.CONTRAINDICACION: {
      const partes = [
        "con el embarazo o cualquier condición médica no me quiero adelantar: eso sí te lo recomiendo " +
          "preguntarlo con tu médico, que es quien te conoce.",
      ];
      if (pagaAlRecibir(producto, cotizacion)) {
        partes.push("Si te da luz verde, aquí estoy — y recuerda que pagas al recibir.");
      }
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // TEMPERATURA
    //
    // `sinDatoConfirmado` declara "los niveles de temperatura o de
    // intensidad", asi que NO sale ningun numero de grados. Lo que si se
    // dice: que se regula -el panel de control esta aprobado- y para que es
    // ese calor, que es el motivo por el que lo esta comprando.
    // ----------------------------------------------------------------------
    case TEMAS.TEMPERATURA: {
      // ⚠️ DEJO DE SER UN "NO LO SE" EL 2026-10-09: Marco autorizo los tres
      //    niveles (50, 55 y 60 °C) y los 10 segundos de calentamiento.
      //
      // LA RECOMENDACION DEL NIVEL BAJO VA SIEMPRE PEGADA AL DATO, y no es
      // relleno: son 60 °C sobre el abdomen. Decir la cifra sin decir por
      // donde empezar es dar media informacion de la peligrosa.
      //
      // Por aqui entra tambien "¿quema?", que es la misma pregunta hecha con
      // miedo. La respuesta correcta es la misma: los niveles y el consejo.
      const t = producto && producto.temperatura;
      if (t && t.texto) {
        const partes = [t.texto];
        if (t.recomendacion) partes.push(t.recomendacion);
        return partes.join(" ");
      }
      return loConfirmo("A cuántos grados llega", "lo", producto, cotizacion);
    }

    // ----------------------------------------------------------------------
    // ¿QUEMA? Es TEMPERATURA preguntada con miedo, y se contesta primero.
    //
    // Antes caia en TEMPERATURA y recibia los tres niveles de calor. El dato
    // es correcto y hace falta, pero no es lo que se pregunto: quien escribe
    // "¿eso quema?" quiere un si o un no antes de nada.
    //
    // LA FORMULA LA AUTORIZO MARCO: «Si lo usas bien, no». Y es condicional
    // a proposito. "nunca quema" y "no se calienta de mas" estan en
    // claimsProhibidos porque de un aparato que llega a 60 °C sobre el
    // abdomen no se puede afirmar nada en absoluto; lo honesto —y lo que
    // ademas tranquiliza de verdad— es decir que si, calienta fuerte, y que
    // por eso se empieza por el nivel bajo.
    // ----------------------------------------------------------------------
    case TEMAS.QUEMA: {
      const t = producto && producto.temperatura;
      const partes = ["si lo usas bien, no 😊"];
      if (t && t.texto) partes.push(`${t.texto.charAt(0).toUpperCase()}${t.texto.slice(1)}`);
      if (t && t.recomendacion) partes.push(t.recomendacion);
      if (partes.length === 1) partes.push("Empieza siempre por el nivel de calor más bajo y sube según cómo te sientas.");
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // MARCA Y ORIGINALIDAD
    //
    // "¿es original?" no pregunta por una marca: pregunta si lo van a
    // estafar. Se contesta con los dos hechos verificables que tenemos
    // -marca propia y garantia- y con el contraentrega, que es el que de
    // verdad quita el miedo.
    // ----------------------------------------------------------------------
    case TEMAS.MARCA: {
      const partes = ["es de NOVIKA, es nuestra marca y te responde este mismo WhatsApp."];
      const plazo = producto && producto.garantia;
      if (plazo) partes.push(`Te va con ${plazo} de garantía.`);
      if (pagaAlRecibir(producto, cotizacion) && !yaDijoLasCondiciones) {
        partes.push("Y lo revisas cuando llegue, porque pagas al recibir.");
      }
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // EMPAQUE Y REGALO
    //
    // "se entrega con su empaque" esta en `caracteristicasAutorizadas`. Lo
    // que trae DENTRO sigue en `sinDatoConfirmado` ("que trae exactamente el
    // paquete"), asi que se separan las dos cosas: el empaque se afirma, el
    // contenido se confirma.
    //
    // Y lo del regalo no es adorno: una parte de quien compra esto lo compra
    // para su hija, su mama o su pareja. Reconocerlo vende.
    // ----------------------------------------------------------------------
    case TEMAS.EMPAQUE: {
      // El contenido del paquete se confirmo el 2026-10-09, asi que esto deja
      // de ser un "lo confirmo con el equipo".
      //
      // ⚠️ EL CARGADOR DE PARED NO ESTA EN LA LISTA, Y ES A PROPOSITO: Marco
      //    lo dejo como [CONFIRMAR] con instruccion de decir que NO lo
      //    incluye. Esta en claimsProhibidos. Prometerlo es un paquete que
      //    llega incompleto.
      const trae = (producto && producto.contenidoDelPaquete) || [];
      if (trae.length) {
        const lista = trae.length > 1 ? `${trae.slice(0, -1).join(", ")} y ${trae[trae.length - 1]}` : trae[0];
        return `viene en su caja con ${lista}. Por eso queda divino para regalo 🎁`;
      }
      const conEmpaque = caracteristica(producto, /empaque/i);
      if (!conEmpaque) return loConfirmo("Qué trae el paquete", "lo", producto, cotizacion);
      // Sin "a medias": el catalogo SI dice que va en su empaque y que sirve
      // de regalo. Eso es una respuesta, no un hueco. Lo que no se sabe es
      // el contenido exacto, y para eso no hace falta parar la conversacion.
      return "se entrega en su empaque, así que sirve para regalo 🎁 El detalle de lo que trae dentro te lo confirmo con el equipo.";
    }

    // ----------------------------------------------------------------------
    // FACTURA
    //
    // No hay politica de facturacion aprobada. Pero hay algo verdadero y
    // concreto que decir, y es justo lo que a esta clienta le preocupa: que
    // no paga nada por adelantado.
    // ----------------------------------------------------------------------
    case TEMAS.FACTURA: {
      const partes = ["lo de la factura te lo confirmo con el equipo, para no decirte algo que no sea."];
      if (pagaAlRecibir(producto, cotizacion)) {
        partes.push("Lo que sí: pagas cuando lo recibes, nada por adelantado.");
      }
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // AL POR MAYOR
    //
    // El lead mas grande que entra por este WhatsApp: quien revende compra
    // todos los meses. El catalogo solo tiene tarifa para 1 y 2 unidades y
    // el motor "tabla" no interpola, asi que un precio de mayorista HAY que
    // escalarlo — pero reconociendo lo que es, no con la escalera de la
    // objecion de precio, que es lo que recibia ("¿hay descuento por
    // mayor?" casaba con `descuento`).
    // ----------------------------------------------------------------------
    case TEMAS.MAYORISTA:
      return (
        "para cantidades al por mayor te paso con una persona del equipo, que es quien maneja esos precios. " +
        "Queda anotado y te responden por aquí."
      );

    // ----------------------------------------------------------------------
    // HORARIO
    //
    // NO se promete un horario: no hay ninguno aprobado y no hay nadie de
    // guardia. Lo que se dice es lo que se puede sostener -que el chat queda
    // y se responde- sin un plazo.
    // ----------------------------------------------------------------------
    case TEMAS.HORARIO:
      return (
        "por aquí me escribes a la hora que quieras y te respondo. " +
        "Y si queda algo por revisar, queda anotado y te contestan por este mismo chat."
      );

    // ----------------------------------------------------------------------
    // OTRO CANAL
    //
    // No se promete una llamada: no hay quien la haga. Se reconduce al canal
    // que si funciona, y se recuerda que no arriesga plata.
    // ----------------------------------------------------------------------
    case TEMAS.CANAL: {
      const partes = ["todo lo manejamos por este WhatsApp, así te queda por escrito el pedido y lo que acordamos."];
      if (pagaAlRecibir(producto, cotizacion) && !yaDijoLasCondiciones) {
        partes.push("Y no pagas nada por adelantado: pagas al recibir.");
      }
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // PARA QUIEN ES
    //
    // "¿sirve para una niña de 13?" recibia la frase de los colicos, que no
    // contesta la pregunta. Lo que de verdad pregunta es si le va a quedar.
    //
    // ⚠️ AQUI NO SE PROMETE AJUSTE UNIVERSAL. "le queda a cualquiera", "le
    //    sirve a cualquiera" y "sirve para cualquier contorno" estan en
    //    `claimsProhibidos` porque Marco fue explicito: no hay medida del
    //    contorno. Se dice que es graduable -que es verdad y esta aprobado-
    //    y se ofrece confirmar el maximo.
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // "¿LO PUEDE RECIBIR MI MAMA?" — Y ESTO CONTESTABA SOBRE LA TALLA.
    //
    // ⚠️ El tema se llama DESTINATARIO y la respuesta hablaba de la correa
    //    graduable. Nacio para "¿es para regalar, le quedara a ella?" y al
    //    añadir el 10-oct los patrones de "lo puede recibir" -que es quien
    //    ABRE LA PUERTA, no quien lo usa- la respuesta se quedo contestando
    //    otra cosa.
    //
    // Son dos preguntas distintas: quien lo USA es talla, quien lo RECIBE es
    // logistica. Y la de recibir tiene una respuesta util: si, y dime a
    // nombre de quien — que ademas captura el dato que falta.
    // ----------------------------------------------------------------------
    case TEMAS.DESTINATARIO:
      return (
        "¡claro! Lo puede recibir otra persona mayor de edad, o lo enviamos a la dirección que quieras. " +
        "Solo dime a nombre de quién lo dejamos."
      );

    // ----------------------------------------------------------------------
    // COMPARATIVA CON LO QUE YA USA
    //
    // La pregunta mas facil de convertir que habia sin respuesta: quien
    // compara con una bolsa de agua YA decidio que quiere resolver el dolor,
    // solo esta eligiendo como.
    //
    // Y se contesta SIN desprestigiar la bolsa de agua y SIN inventar
    // especificaciones: solo con lo aprobado -correa graduable y panel de
    // control- y con la consecuencia obvia de llevarlo puesto.
    // ----------------------------------------------------------------------
    case TEMAS.COMPARATIVA: {
      const graduable = producto && producto.ajuste && producto.ajuste.graduable === true;
      const tienePanel = caracteristica(producto, /panel\s+de\s+control/i);
      const partes = ["la diferencia es que este te lo dejas puesto y sigues con tus cosas."];
      if (graduable) partes.push("Se asegura con la correa graduable, no hay que sostenerlo.");
      if (tienePanel) partes.push("Y el calor lo regulas desde el panel, no se va enfriando.");
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // COBERTURA
    //
    // Esto SI esta confirmado y era oro sin usar. La nota `_nota_envio` de la
    // ficha es explicita: Marco dijo "envio incluido" SIN acotar ciudades, y
    // para la clienta no hay riesgo — paga 49.900 y nada mas, en cualquier
    // destino. Fuera de las capitales ese es el argumento que mas vende, y
    // la pregunta caia en el camino generico porque "llega a" la enrutaba al
    // tema ENVIO, que contesta otra cosa.
    // ----------------------------------------------------------------------
    case TEMAS.COBERTURA: {
      if (!envioVaIncluido(producto, cotizacion)) return loConfirmo("La cobertura", "la", producto, cotizacion);
      return "sí llega, enviamos a todo el país y el envío va incluido: no pagas nada aparte por la zona.";
    }

    // ----------------------------------------------------------------------
    // OTRO MODELO
    //
    // Se lee del catalogo, no de una frase: si algun dia hay dos productos
    // activos, esta respuesta deja de ser verdad sola.
    // ----------------------------------------------------------------------
    case TEMAS.OTRO_MODELO: {
      const partes = ["por ahora manejamos este modelo."];
      const color = caracteristica(producto, /color|rosad/i);
      if (color) partes.push("Viene únicamente en rosado y es talla única.");
      partes.push("Si quieres te aviso cuando entren más referencias.");
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // DONDE ESTAMOS
    //
    // De un chat real del 08-oct: el cliente pregunto "En qué ciudad" y
    // recibio "esa no te la quiero contestar a medias". A quien desconfia,
    // negarse a decir donde estamos le confirma el miedo — y era la pregunta
    // mas facil de todas.
    //
    // ⚠️ NO SE INVENTA UNA CIUDAD NI UNA DIRECCION. No hay ninguna aprobada
    //    en la ficha. Lo que se dice es verdad y es lo que la clienta
    //    necesita saber: que es una tienda colombiana, que envia a todo el
    //    pais y que no paga por adelantado.
    // ----------------------------------------------------------------------
    case TEMAS.UBICACION: {
      const partes = ["somos NOVIKA, una tienda colombiana, y vendemos en línea con envíos a todo el país."];
      if (pagaAlRecibir(producto, cotizacion)) {
        partes.push("No tienes que ir a ningún lado ni pagar por adelantado: te llega a tu casa y pagas al recibir.");
      } else {
        partes.push("Te llega a tu casa.");
      }
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // "¿Y SI NO ME FUNCIONA?"
    //
    // No es una pregunta por la garantia: es miedo a perder la plata. Por eso
    // el orden es contraentrega PRIMERO y garantia despues — al reves suena
    // a tramite, y asi suena a que no arriesga nada.
    //
    // ⚠️ Y NO SE PROMETE DEVOLUCION DE DINERO. La garantia cubre defecto de
    //    fabrica, NO "no me gusto": decir "si no te funciona te devolvemos la
    //    plata" seria inventar una politica que no existe, y la queja
    //    posterior seria justa.
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // "PERO EL ANUNCIO DICE QUE ME DEVUELVEN LA PLATA"
    //
    // ⚠️ LA RESPUESTA MAS DELICADA DE TODO EL CATALOGO, porque el bot tiene
    //    que sostener una contradiccion que no creo el.
    //
    // El anuncio de Facebook promete «Pruébalo 7 días: si no sientes alivio,
    // te devolvemos tu dinero». Marco confirmo el 2026-10-09 que lo que vale
    // es «1 mes por defecto de fábrica». No son lo mismo.
    //
    // Hay tres cosas que NO se pueden hacer, y cada una por su motivo:
    //
    //   · PROMETER la devolucion -> no esta aprobada. Decirla crea una
    //     obligacion de devolver plata que nadie autorizo.
    //   · NEGAR que el anuncio lo diga -> lo dice. Llamar mentirosa a la
    //     clienta que esta citando nuestra propia publicidad es la peor
    //     salida posible.
    //   · CONTESTAR el plazo de la garantia como si fuera lo mismo -> es
    //     cambiarle las condiciones sin avisar, y lo va a notar.
    //
    // Lo que SI se puede: decir lo que de verdad cubre la garantia, poner
    // delante el argumento que de verdad quita el riesgo en contraentrega
    // -ve el producto ANTES de pagar, asi que no necesita que nadie le
    // devuelva nada- y dejar la pregunta para una persona.
    //
    // Cada tarea que esto genere en la bandeja es evidencia medida de que el
    // anuncio esta prometiendo algo que la politica no cubre. La decision es
    // de negocio: o se cambia el anuncio, o se aprueba la devolucion.
    // ----------------------------------------------------------------------
    // ----------------------------------------------------------------------
    // LA PROMESA DEL ANUNCIO: «PRUÉBALO 7 DÍAS O TE DEVOLVEMOS TU DINERO»
    //
    // ⚠️ ESTA RESPUESTA ERA UNA EVASIVA, Y DURANTE DOS DIAS NO HIZO FALTA
    //    QUE LO FUERA.
    //
    // El 09-oct se le pregunto a Marco cual de las dos promesas valia -la
    // del anuncio o la garantia- COMO SI FUERAN ALTERNATIVAS. Contesto «Si
    // garantia 1 mes», se interpreto que la prueba de 7 dias no existia, y
    // sus cinco frases entraron en `claimsProhibidos`. Resultado: a quien
    // citaba el anuncio de la propia empresa, el bot le contestaba "te lo
    // confirmo con el equipo".
    //
    // El 10-oct Marco lo aclaro: los 7 dias SON REALES y son el gancho del
    // anuncio. «Se le envia el producto [...] es un gancho para que la
    // persona compre y pueda probar el producto».
    //
    // LA LECCION FUE LA PREGUNTA, NO EL DATO: no eran alternativas, conviven.
    // Una pregunta mal planteada guardo un dato mal, y el bot fue fiel al
    // dato.
    //
    // Y SON DOS COSAS DISTINTAS, que es lo que no se puede volver a mezclar:
    //
    //   · los 7 DIAS cubren que NO LE SIRVA -> se devuelve EL DINERO
    //   · la GARANTIA cubre DEFECTO DE FABRICA -> se CAMBIA el producto
    //
    // Aqui se contesta lo primero, porque es lo que se pregunto.
    // ----------------------------------------------------------------------
    case TEMAS.PROMESA_DEL_ANUNCIO: {
      const prueba = producto && producto.pruebaDeSieteDias;
      const partes = [];

      if (prueba && prueba.activa && prueba.texto) {
        // Se confirma de frente y en primera persona: es la promesa de la
        // casa, no una concesion que haya que arrancarnos.
        partes.push(`sí, es verdad: ${prueba.texto.replace(/^Y\s+/, "").replace(/^(\w)/, (c) => c.toLowerCase())}`);
      }

      if (pagaAlRecibir(producto, cotizacion)) {
        // Y detras el argumento que de verdad quita el miedo: ni siquiera
        // necesita la devolucion, porque no ha soltado la plata todavia.
        partes.push("Y ni siquiera arriesgas nada por adelantado: pagas cuando el pedido está en tus manos.");
      }

      // Sin `pruebaDeSieteDias` en la ficha no se inventa: se admite. Pasa
      // si algun dia se desactiva la promocion y el anuncio sigue vivo.
      if (!partes.length) {
        return loConfirmo("Lo de la devolución del dinero", "lo", producto, cotizacion);
      }
      return partes.join(" ");
    }

    // ----------------------------------------------------------------------
    // "¿Y SI NO ME FUNCIONA?" — AHORA HAY UNA RESPUESTA DE VERDAD
    //
    // Esta es LA pregunta que cubre la prueba de 7 dias, y hasta el 10-oct
    // se contestaba con la garantia, que es otra cosa: la garantia cambia un
    // aparato roto, no le devuelve la plata a quien dice que no le sirvio.
    //
    // Orden deliberado: primero los 7 dias (responde exactamente lo que
    // pregunto), luego el contraentrega (quita el riesgo del adelanto) y al
    // final la garantia, que cubre un caso distinto y conviene no mezclar.
    // ----------------------------------------------------------------------
    case TEMAS.SI_NO_FUNCIONA: {
      const partes = [];
      const prueba = producto && producto.pruebaDeSieteDias;
      if (prueba && prueba.activa && prueba.texto) {
        partes.push(prueba.texto.replace(/^Y\s+/, "").replace(/^(\w)/, (c) => c.toLowerCase()));
      }
      if (pagaAlRecibir(producto, cotizacion)) {
        partes.push("Y pagas cuando el pedido está en tus manos, así que no arriesgas plata por adelantado.");
      }
      const plazo = producto && producto.garantia;
      const cubre = producto && producto.garantiaCubre;
      // La garantia va al final y DICE QUE CUBRE OTRA COSA. Sin ese "y
      // aparte", las dos promesas se leen como una y queda la duda de si son
      // 7 dias o un mes para lo mismo.
      if (plazo && cubre) partes.push(`Y aparte, si llega con ${cubre}, tienes ${plazo} de garantía y te lo cambiamos.`);
      else if (plazo) partes.push(`Y aparte te va con ${plazo} de garantía.`);
      if (!partes.length) return loConfirmo("Qué pasa si no te funciona", "lo", producto, cotizacion);
      return partes.join(" ");
    }

    default:
      return null;
  }
}

/**
 * Responde a TODOS los temas del mensaje, en el orden en que se preguntaron.
 *
 * Se limita a dos temas. Una clienta que pregunta tres cosas y recibe tres
 * parrafos deja de leer: es el muro de texto que BIKERPRO aprendio a evitar.
 * Los temas que no entran se responden en el turno siguiente, cuando los
 * vuelva a preguntar, o los cubre la respuesta de la IA.
 *
 * @returns {{texto: string, temas: string[]}}
 */
function aTemas(temas, contexto, { maximo = 2 } = {}) {
  const frases = [];
  const respondidos = [];

  // MEDIDAS ya dice la talla y ademas aclara que el contorno no se sabe. Si
  // los dos temas vienen juntos -"¿me sirve? uso talla XL" marca los dos- la
  // respuesta salia con la frase de la talla repetida dos veces.
  let lista = [...(temas || [])];
  if (lista.includes(TEMAS.MEDIDAS)) lista = lista.filter((t) => t !== TEMAS.TALLA);
  // El tramite ya dice el plazo: si vienen los dos, el plazo solo sobra.
  if (lista.includes(TEMAS.GARANTIA_TRAMITE)) lista = lista.filter((t) => t !== TEMAS.GARANTIA);
  // DORMIR gana a SEGURIDAD: las dos hablan de usarlo con cuidado, pero
  // "¿puedo dormir con él?" tiene una respuesta concreta -mejor no- y la de
  // seguridad habla de quemaduras, que no es lo que se pregunto.
  if (lista.includes(TEMAS.DORMIR)) lista = lista.filter((t) => t !== TEMAS.SEGURIDAD);
  // RELAJA gana a USO: "¿sirve para relajar los músculos?" marca los dos
  // porque lleva "sirve para", y la respuesta de relajacion es la que
  // contesta de verdad.
  if (lista.includes(TEMAS.RELAJA)) lista = lista.filter((t) => t !== TEMAS.USO);
  // APAGADO_AUTO gana a SEGURIDAD por el mismo motivo.
  if (lista.includes(TEMAS.APAGADO_AUTO)) lista = lista.filter((t) => t !== TEMAS.SEGURIDAD);
  // USAR_CARGANDO gana a ENERGIA y a USO, y aqui no es cuestion de estilo:
  // las dos respuestas se CONTRADICEN. La de energia termina en "mientras
  // lo usas no va conectado a nada" y la de aqui dice que si se puede usar
  // cargando. Juntas en un mensaje dejan a la clienta peor que antes.
  if (lista.includes(TEMAS.USAR_CARGANDO)) {
    lista = lista.filter((t) => t !== TEMAS.ENERGIA && t !== TEMAS.USO);
  }
  // QUEMA gana a TEMPERATURA y a SEGURIDAD: su respuesta ya lleva dentro los
  // niveles de calor y el consejo de empezar por el bajo, asi que dejar
  // TEMPERATURA repetiria el mismo dato dos veces en el mismo mensaje.
  if (lista.includes(TEMAS.QUEMA)) {
    lista = lista.filter((t) => t !== TEMAS.TEMPERATURA && t !== TEMAS.SEGURIDAD);
  }
  // LLEGA_HOY gana a ENTREGA: su respuesta ya lleva el plazo dentro, y las
  // dos juntas decian el rango dos veces en el mismo mensaje.
  if (lista.includes(TEMAS.LLEGA_HOY)) lista = lista.filter((t) => t !== TEMAS.ENTREGA);
  // La respuesta a la objecion YA dice que el envio va incluido y que paga
  // al recibir: son dos de sus tres pasos. Sin esto, "esta caro, y el envio
  // cuanto vale?" repetia el envio dos veces en el mismo mensaje.
  if (lista.includes(TEMAS.OBJECION_PRECIO)) {
    lista = lista.filter((t) => t !== TEMAS.ENVIO && t !== TEMAS.PAGO);
  }

  for (const tema of lista) {
    if (respondidos.length >= maximo) break;
    // `vecesPorTema` viaja en el contexto y aqui se resuelve al numero de
    // ESTE tema. Asi `deTema` recibe un escalar y no tiene que saber nada
    // del mapa: una respuesta solo necesita saber si es la primera vez que
    // la da.
    const veces = Number((contexto && contexto.vecesPorTema && contexto.vecesPorTema[tema]) || 1);
    const frase = deTema(tema, { ...contexto, vecesEsteTema: Math.max(1, veces) });
    if (!frase) continue;
    // Sin repetir la misma frase dos veces: "¿cuánto vale con envío?" marca
    // PRECIO y ENVIO, y las dos respuestas pueden coincidir en el texto.
    if (frases.includes(frase)) continue;
    frases.push(frase);
    respondidos.push(tema);
  }

  return { texto: frases.join(" "), temas: respondidos };
}

// ==========================================================================
// ¿ESTE TEXTO PROMETIO QUE ALGUIEN VA A CONFIRMAR ALGO?
//
// LA REGLA DEL REPOSITORIO ES "LO QUE SE PROMETE, QUEDA ANOTADO", y hasta el
// 09-oct estaba implementada con el proxy equivocado: el cerebro abria la
// tarea cuando el mensaje del cliente NO TENIA TEMA RECONOCIDO.
//
// Funcionaba por casualidad, porque entonces casi todo lo que llevaba una
// promesa era tambien una pregunta sin tema. Al añadir los dieciseis temas
// nuevos las dos cosas se separaron, y aparecieron los dos errores opuestos:
//
//   · preguntas CON tema y CON promesa -"¿a cuántos grados llega?"- que ya
//     no abrian tarea: el bot prometia que el equipo lo confirmaba y nadie
//     se enteraba. Es la peor de las dos: una promesa que nadie recibe.
//   · preguntas SIN tema y SIN promesa que abrian tarea igual, llenando la
//     bandeja de ruido.
//
// Ahora se mira EL TEXTO QUE SE VA A ENVIAR, que es donde esta la promesa.
// Si el bot dijo que lo confirma, hay tarea; si contesto del todo, no.
//
// ⚠️ SI SE CAMBIA LA REDACCION DE `loConfirmo` O DE UNA RESPUESTA QUE
//    PROMETA CONFIRMAR, HAY QUE TOCAR ESTE PATRON. Es el precio de detectar
//    sobre el texto, y se asume a sabiendas: la alternativa -que cada rama
//    devuelva una bandera- obligaba a cambiar la firma de `deTema`,
//    `aTemas` y las once llamadas de `textoDeterminista`, y una bandera que
//    se olvida de propagar falla en silencio. Esto lo vigila una prueba que
//    recorre TODAS las respuestas de `deTema` y comprueba que las que
//    prometen casan con el patron.
// ==========================================================================
const PROMETE_CONFIRMAR =
  // "te confirmo el contorno máximo" TAMBIEN es una promesa, y no casaba.
  // Es la respuesta de MEDIDAS -la duda que mas vende en este producto- y
  // prometia una confirmacion que no dejaba ninguna tarea: la clienta se
  // quedaba esperando un dato que nadie sabia que tenia que buscar.
  /no te l[oa]s? quiero (decir|contestar) a medias|l[oa]s? confirmo con el equipo|te l[oa] confirmo con el equipo|te confirmo (el|la|los|las)\s|te paso con una persona|pasarle tu caso a una persona|lo gestiona (directamente )?una persona/i;

/** ¿El texto que se va a enviar promete que una persona confirma algo? */
function prometeConfirmar(texto) {
  return PROMETE_CONFIRMAR.test(String(texto || ""));
}

module.exports = {
  deTema,
  aTemas,
  plazoDeEntrega,
  pesos,
  comoSeLlama,
  loConfirmo,
  reservaDeVenta,
  esReservaDeVenta,
  ES_RESERVA,
  prometeConfirmar,
  PROMETE_CONFIRMAR,
  ofertaDeDos,
  // Los dos hechos comerciales que mas veces hay que consultar desde fuera
  // (la rama "declina" los usa para recordar que no se arriesga plata).
  // Salen del catalogo, nunca de un texto escrito a mano.
  pagaAlRecibir,
  envioVaIncluido,
};
