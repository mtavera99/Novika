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
function loConfirmo(que, pronombre = "lo") {
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
  return (
    `${enMinuscula} no te ${pronombre} quiero decir a medias: lo confirmo con el equipo ` +
    `y te cuento. Mientras tanto, si quieres te lo voy dejando apartado.`
  );
}

/**
 * Respuesta a un tema.
 *
 * @param {string} tema
 * @param {{producto: object|null, cotizacion: object|null}} contexto
 * @returns {string|null} la frase, o null si este tema no se responde aqui
 */
function deTema(tema, { producto = null, cotizacion = null } = {}) {
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
      if (c && c.envioIncluido) return "el envío va incluido, no pagas nada aparte.";
      if (cotizacion && cotizacion.envio > 0) return `El envío a tu ciudad son ${pesos(cotizacion.envio)}.`;
      return loConfirmo("El envío", "lo");
    }

    // ----------------------------------------------------------------------
    // PAGO. La etiqueta la escribe el catalogo.
    // ----------------------------------------------------------------------
    case TEMAS.PAGO: {
      const c = cotizacion && cotizacion.condiciones;
      if (c && c.pagoMetodo === "contraentrega") {
        return "pagas cuando lo recibes, en la puerta de tu casa. Nada por adelantado.";
      }
      if (c && c.pagoEtiqueta) return c.pagoEtiqueta;
      // Preguntar por Nequi o transferencia cuando el metodo es contraentrega
      // es frecuente, y la respuesta honesta es que eso lo confirma alguien.
      return loConfirmo("La forma de pago", "la");
    }

    case TEMAS.COLOR: {
      // SIN capitalizar: esta frase puede ir detras de una apertura ("Sí,
      // viene únicamente en color rosado"). Capitalizarla aqui producia
      // "Sí, Viene únicamente...", con mayuscula en medio de la frase.
      const dato = caracteristica(producto, /color|rosad|negr|blanc|azul/);
      if (dato) return `${dato}.`;
      return loConfirmo("Los colores disponibles", "los");
    }

    case TEMAS.TALLA: {
      const dato = caracteristica(producto, /talla/);
      if (dato) return `${dato}.`;
      return loConfirmo("Las tallas", "las");
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
        partes.push("La correa es graduable, así que se ajusta a distintas medidas.");
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
      if (!ajuste || !ajuste.contornoMaximoCm) {
        // Ofrecer confirmarlo ANTES de que pida es lo que convierte un "no
        // lo sé" en atencion: la clienta no tiene que arriesgarse ni
        // esperar a recibirlo para saberlo.
        partes.push("Si quieres te confirmo el contorno máximo exacto antes de que lo pidas, para que vayas segura.");
      } else {
        partes.push(`Ajusta hasta ${ajuste.contornoMaximoCm} cm de contorno.`);
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
      if (!plazo) return loConfirmo("La garantía", "la");
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
      if (!plazo) return loConfirmo("La garantía", "la");

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
      const t = (producto && producto.logistica && producto.logistica.tiempoDeEntrega) || null;
      if (!t || !t.texto) return loConfirmo("El tiempo de entrega", "lo");
      // ANTES: "La transportadora normalmente entrega en 1 a 3 días hábiles
      // según la ciudad." Correcto y escrito como un aviso legal: hablaba de
      // la transportadora en tercera persona cuando la clienta pregunta por
      // SU pedido. "Te llega en..." dice lo mismo y lo dice alguien.
      //
      // Sigue siendo un RANGO con su matiz: lo que esta prohibido es el dia
      // concreto, no hablar en segunda persona.
      const matiz = t.matiz ? ` ${t.matiz.replace(/^según la ciudad$/, "según tu ciudad")}` : "";
      return `te llega en ${t.texto}${matiz}.`;
    }

    case TEMAS.MATERIAL: {
      // Autorizado por Marco el 2026-10-08. Era una de las preguntas que
      // mas llegan y el bot no la podia contestar.
      if (producto && producto.material && producto.material.texto) return producto.material.texto;
      const dato = caracteristica(producto, /material|tela|cuero/);
      if (dato) return `${dato}.`;
      return loConfirmo("El material", "lo");
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
        const conFotos = (producto.imagenes || []).length;
        return conFotos ? `${paraQue} Te paso las fotos para que lo veas bien.` : paraQue;
      }

      const descripcion = producto && producto.descripcionAutorizada;
      if (!descripcion) return loConfirmo("Para qué sirve", "lo");

      const partes = [String(descripcion)];
      if (producto && (producto.imagenes || []).length) {
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
      const c = cotizacion && cotizacion.condiciones;
      if (c && c.pagoMetodo === "contraentrega") {
        return "Pagas cuando el pedido llega a tus manos, así que no arriesgas nada: si no te llega, no pagas.";
      }
      return "Somos NOVIKA, una tienda colombiana, y cualquier duda te la resuelve una persona del equipo.";
    }

    case TEMAS.FOTOS:
      // Solo se prometen si existen: el cerebro decide si las manda y pasa
      // `producto`. Un bot que anuncia fotos y no manda ninguna deja al
      // cliente esperando algo que no llega.
      if (producto && (producto.imagenes || []).length) return "Te muestro las fotos.";
      return null;

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

  for (const tema of lista) {
    if (respondidos.length >= maximo) break;
    const frase = deTema(tema, contexto);
    if (!frase) continue;
    // Sin repetir la misma frase dos veces: "¿cuánto vale con envío?" marca
    // PRECIO y ENVIO, y las dos respuestas pueden coincidir en el texto.
    if (frases.includes(frase)) continue;
    frases.push(frase);
    respondidos.push(tema);
  }

  return { texto: frases.join(" "), temas: respondidos };
}

module.exports = { deTema, aTemas, pesos, comoSeLlama, loConfirmo };
