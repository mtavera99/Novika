"use strict";

// ==========================================================================
// COTIZADOR DETERMINISTA
//
// Modulo puro. Sin I/O, sin IA, sin process.env.
//
// EL MODELO NO PUEDE PRODUCIR UN IMPORTE. Todos los numeros salen de aqui, y
// aqui todos los numeros salen del catalogo. No hay una sola constante
// monetaria en este archivo, a proposito: si manana aparece una, es que
// alguien metio una politica comercial en el codigo.
//
// Dos decisiones que evitan cobrar mal:
//
//   1. SI FALTA UN DATO, NO SE COTIZA. Se devuelve QUE falta.
//      No hay valores por defecto. Un envio asumido en 0 porque no estaba
//      configurado es regalar el flete en cada venta.
//
//   2. UNA CANTIDAD FUERA DE LA TABLA NO SE INTERPOLA.
//      Si el catalogo tiene precio para 1 y para 2, y el cliente pide 5, NO
//      se calcula "el de 2 mas tres veces el de 1". Eso seria inventar una
//      politica de mayoreo que nadie aprobo. Se escala a una persona.
//
// Devuelve ademas `importesAutorizados`: la lista blanca de cifras que el
// texto de respuesta puede contener. Cualquier otra cifra en el mensaje al
// cliente es un numero que el codigo no calculo, y se bloquea antes de
// enviar.
// ==========================================================================

const crypto = require("node:crypto");

/**
 * Version de las reglas de cotizacion. Se guarda en el pedido.
 *
 * Sirve para poder responder "con que reglas se cotizo esto" meses despues,
 * cuando las reglas ya cambiaron. Subirla es obligatorio al cambiar como se
 * calcula algo.
 */
const POLITICA_VERSION = "2026.10-fase2.2";

const MONEDA = "COP";

/** Motores de precio que este modulo sabe aplicar. */
const MOTORES = {
  TABLA: "tabla",                       // precios[cantidad] = total del producto
  PRODUCTO_MAS_ENVIO: "producto_mas_envio", // unitario * cantidad + envio
};

/** Politicas de envio reconocidas. */
const POLITICAS_ENVIO = {
  INCLUIDO: "incluido",       // el precio de tabla ya lo incluye
  FIJO: "fijo",               // valorFijo del catalogo
  POR_DESTINO: "por_destino", // tabla por departamento en el catalogo
};

/** Huella estable de los campos comerciales del producto. */
function versionDeCatalogo(producto) {
  const comercial = {
    id: producto.id,
    precios: producto.precios || null,
    motorDePrecio: producto.motorDePrecio || null,
    precioUnitario: producto.precioUnitario ?? null,
    politicaEnvio: (producto.logistica && producto.logistica.politicaEnvio) || null,
    promociones: producto.promociones || null,
    // El metodo de cobro es parte de las condiciones, no de la redaccion.
    // Si pasa de contraentrega a pago anticipado, lo que el cliente acepto
    // deja de aplicar: tiene que caducar la oferta igual que un cambio de
    // precio. Sin esto, alguien confirmaria "pago al recibir" y el pedido se
    // despacharia esperando una transferencia previa.
    pago: (producto.pago && producto.pago.metodo) || null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(comercial)).digest("hex").slice(0, 12);
}

/**
 * Condiciones de cobro y envio tal y como se le muestran al cliente.
 *
 * Salen del catalogo, nunca del modelo. Devuelve `null` en lo que el
 * producto no declare: un hueco explicito es mejor que una frase amable
 * puesta por defecto, porque "envio incluido" asumido es el flete regalado
 * en cada venta.
 */
function condicionesDe(producto) {
  const politica = (producto.logistica && producto.logistica.politicaEnvio) || null;
  const pago = producto.pago || null;
  return {
    politicaEnvio: (politica && politica.tipo) || null,
    envioIncluido: !!politica && politica.tipo === POLITICAS_ENVIO.INCLUIDO,
    pagoMetodo: (pago && pago.metodo) || null,
    pagoEtiqueta: (pago && pago.etiquetaCliente) || null,
  };
}

/** Calcula el envio. Devuelve null y el faltante si no se puede saber. */
function calcularEnvio(producto, destino) {
  const politica = (producto.logistica && producto.logistica.politicaEnvio) || null;

  if (!politica || !politica.tipo) {
    return { falta: ["logistica.politicaEnvio.tipo"], porQue: "el producto no declara politica de envio" };
  }

  if (politica.tipo === POLITICAS_ENVIO.INCLUIDO) {
    return { importe: 0, porQue: "envio incluido en el precio" };
  }

  if (politica.tipo === POLITICAS_ENVIO.FIJO) {
    if (!Number.isInteger(politica.valorFijo) || politica.valorFijo < 0) {
      return {
        falta: ["logistica.politicaEnvio.valorFijo"],
        porQue: "politica de envio fijo sin un valor entero configurado",
      };
    }
    return { importe: politica.valorFijo, porQue: "envio fijo" };
  }

  if (politica.tipo === POLITICAS_ENVIO.POR_DESTINO) {
    const tabla = politica.tablaPorDepartamento;
    if (!tabla || typeof tabla !== "object") {
      return {
        falta: ["logistica.politicaEnvio.tablaPorDepartamento"],
        porQue: "politica de envio por destino sin tabla configurada",
      };
    }
    if (!destino || !destino.departamento) {
      return { falta: ["departamento"], porQue: "el envio depende del departamento y no se conoce" };
    }
    const valor = tabla[destino.departamento];
    if (!Number.isInteger(valor) || valor < 0) {
      // Departamento sin tarifa. NO se usa un promedio ni el de al lado.
      return {
        falta: [`logistica.politicaEnvio.tablaPorDepartamento["${destino.departamento}"]`],
        porQue: `no hay tarifa configurada para ${destino.departamento}`,
      };
    }
    return { importe: valor, porQue: `envio a ${destino.departamento}` };
  }

  return { falta: ["logistica.politicaEnvio.tipo"], porQue: `politica de envio "${politica.tipo}" desconocida` };
}

/** Precio del producto segun su motor. */
function calcularProducto(producto, cantidad) {
  const motor = producto.motorDePrecio;

  if (motor === MOTORES.TABLA) {
    const precios = producto.precios || {};
    const enTabla = precios[String(cantidad)];
    if (Number.isInteger(enTabla) && enTabla > 0) {
      return { importe: enTabla, porQue: `precio de tabla para ${cantidad} unidad(es)` };
    }
    const disponibles = Object.keys(precios)
      .map(Number)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!disponibles.length) {
      return { falta: ["precios"], porQue: "el producto no tiene tabla de precios" };
    }
    // Fuera de tabla: NO se interpola.
    return {
      fueraDeTabla: true,
      porQue: `no hay precio para ${cantidad} unidad(es); la tabla cubre ${disponibles.join(", ")}`,
    };
  }

  if (motor === MOTORES.PRODUCTO_MAS_ENVIO) {
    const unitario = producto.precioUnitario;
    if (!Number.isInteger(unitario) || unitario <= 0) {
      return { falta: ["precioUnitario"], porQue: "el producto no tiene precio unitario entero" };
    }
    return { importe: unitario * cantidad, porQue: `${cantidad} x precio unitario` };
  }

  return { falta: ["motorDePrecio"], porQue: `motor de precio "${motor}" desconocido` };
}

/**
 * Descuento por promocion. Solo promociones del catalogo, vigentes y con
 * importe entero. Sin promociones, descuento 0.
 */
function calcularDescuento(producto, cantidad, ahora) {
  const promos = Array.isArray(producto.promociones) ? producto.promociones : [];
  const vigentes = promos.filter((p) => {
    if (!p || !Number.isInteger(p.descuento) || p.descuento <= 0) return false;
    if (p.minimoUnidades && cantidad < p.minimoUnidades) return false;
    if (p.desde && new Date(p.desde) > ahora) return false;
    if (p.hasta && new Date(p.hasta) < ahora) return false;
    return true;
  });

  if (!vigentes.length) return { importe: 0, porQue: "sin promociones vigentes", aplicadas: [] };

  // Si hay varias, se aplica LA MAYOR, no la suma. Sumar descuentos que
  // nadie definio como acumulables es regalar margen.
  const mejor = vigentes.reduce((a, b) => (b.descuento > a.descuento ? b : a));
  return {
    importe: mejor.descuento,
    porQue: `promocion ${mejor.id || "sin id"}`,
    aplicadas: [mejor.id || "sin id"],
  };
}

/**
 * Cotiza.
 *
 * @param {object} entrada
 * @param {object} entrada.producto     producto del catalogo (fuente de verdad)
 * @param {number} entrada.cantidad
 * @param {object} [entrada.destino]    {ciudad, departamento}
 * @param {string} [entrada.variante]
 * @param {Date}   [entrada.ahora]
 *
 * @returns {{ok: true, cotizacion: object} |
 *           {ok: false, falta: string[], motivo: string, escalar?: boolean}}
 */
function cotizar({ producto, cantidad, destino = null, variante = null, ahora = new Date() }) {
  const falta = [];

  if (!producto || !producto.id) {
    return { ok: false, falta: ["producto"], motivo: "no se sabe que producto es" };
  }
  if (producto.activo !== true) {
    return {
      ok: false,
      falta: [],
      motivo: `el producto "${producto.id}" no esta activo: no se puede cotizar`,
      escalar: true,
    };
  }
  if (!Number.isInteger(cantidad) || cantidad < 1) {
    falta.push("cantidad");
  }

  // Variante obligatoria sin elegir: no se cotiza a medias.
  const variantesObligatorias = (producto.variantes || []).filter((v) => v && v.obligatoria === true);
  for (const v of variantesObligatorias) {
    const elegida = variante && typeof variante === "object" ? variante[v.clave] : null;
    if (!elegida) {
      falta.push(`variante.${v.clave}`);
    } else if (Array.isArray(v.opciones) && v.opciones.length && !v.opciones.includes(elegida)) {
      return {
        ok: false,
        falta: [`variante.${v.clave}`],
        motivo: `"${elegida}" no es una opcion de ${v.clave}. Opciones: ${v.opciones.join(", ")}`,
      };
    }
  }

  if (falta.length) {
    return { ok: false, falta, motivo: `faltan datos para cotizar: ${falta.join(", ")}` };
  }

  const prod = calcularProducto(producto, cantidad);
  if (prod.fueraDeTabla) {
    return { ok: false, falta: [], motivo: prod.porQue, escalar: true };
  }
  if (prod.falta) {
    return { ok: false, falta: prod.falta, motivo: prod.porQue };
  }

  const env = calcularEnvio(producto, destino);
  if (env.falta) {
    return { ok: false, falta: env.falta, motivo: env.porQue };
  }

  const desc = calcularDescuento(producto, cantidad, ahora);

  const subtotal = prod.importe;
  const envio = env.importe;
  const descuento = Math.min(desc.importe, subtotal); // nunca un total negativo
  const total = subtotal + envio - descuento;

  if (!Number.isInteger(total) || total <= 0) {
    return { ok: false, falta: [], motivo: `el total calculado (${total}) no es valido`, escalar: true };
  }

  const cotizacion = {
    productoId: producto.id,
    productoNombre: producto.nombre,
    variante: variante || null,
    cantidad,
    destino: destino ? { ciudad: destino.ciudad || null, departamento: destino.departamento || null } : null,

    moneda: MONEDA,
    subtotal,
    envio,
    descuento,
    total,

    desglose: [
      { concepto: "producto", importe: subtotal, porQue: prod.porQue },
      { concepto: "envio", importe: envio, porQue: env.porQue },
      ...(descuento > 0 ? [{ concepto: "descuento", importe: -descuento, porQue: desc.porQue }] : []),
      { concepto: "total", importe: total, porQue: "subtotal + envio - descuento" },
    ],

    motorDePrecio: producto.motorDePrecio,
    promocionesAplicadas: desc.aplicadas,

    // Condiciones comerciales del catalogo. Viajan DENTRO de la cotizacion
    // porque el pedido guarda la cotizacion como copia: asi el metodo de
    // cobro queda estampado en el pedido sin que `pedido.js` tenga que
    // saber que existe, y quien despacha lee en el propio pedido si hay que
    // recaudar en la puerta.
    condiciones: condicionesDe(producto),

    politicaVersion: POLITICA_VERSION,
    versionCatalogo: versionDeCatalogo(producto),
    calculadoEn: ahora.toISOString(),

    // Lista blanca: las unicas cifras que puede contener el mensaje al
    // cliente. Cualquier otra es un numero que el codigo no calculo.
    importesAutorizados: [...new Set([subtotal, envio, descuento, total, cantidad].filter((n) => n > 0))],
  };

  return { ok: true, cotizacion };
}

/**
 * Huella de las condiciones de una oferta.
 *
 * Si esta huella cambia, lo que el cliente confirmo antes YA NO APLICA y hay
 * que emitir una oferta nueva. En BIKERPRO la identidad de la oferta se
 * construyo con politica|ciudad|unidades|total, que es una TARIFA y no una
 * oferta: dos compras distintas del mismo producto a la misma ciudad
 * producian la misma cadena, y el pedido de un destinatario se escribio
 * encima del de otro.
 *
 * Por eso aqui la huella sirve solo para DETECTAR CAMBIOS; la identidad de
 * la oferta es un id propio que vive en la conversacion.
 */
function firmaDeCondiciones(cotizacion) {
  if (!cotizacion) return null;
  const partes = [
    cotizacion.productoId,
    JSON.stringify(cotizacion.variante || null),
    cotizacion.cantidad,
    (cotizacion.destino && cotizacion.destino.ciudad) || "",
    (cotizacion.destino && cotizacion.destino.departamento) || "",
    cotizacion.total,
    cotizacion.politicaVersion,
    cotizacion.versionCatalogo,
  ];
  return crypto.createHash("sha256").update(partes.join("|")).digest("hex").slice(0, 16);
}

/**
 * ¿El texto que vamos a enviarle al cliente contiene alguna cifra de dinero
 * que el codigo no calculo?
 *
 * Es el ultimo filtro antes de enviar. Aunque el modelo invente un precio,
 * aqui se detecta y no sale.
 */
/**
 * Identificadores propios que NO son dinero aunque lleven cifras.
 *
 * EL DEFECTO QUE ARREGLA, y era intermitente: el numero de pedido tiene la
 * forma NOV-MUYR5558-508BAE67, y ese "5558" lo leia el filtro como un
 * importe no autorizado. Resultado: el mensaje "Tu pedido NOV-... ya está
 * confirmado" se BLOQUEABA — pero solo cuando al id le tocaban cuatro
 * digitos seguidos, asi que el mismo texto pasaba o fallaba segun el id.
 *
 * Un filtro que falla una vez de cada tantas es peor que uno que falla
 * siempre: el fallo se atribuye a cualquier otra cosa.
 *
 * SE EXIME EL IDENTIFICADOR COMPLETO, NO LAS CIFRAS SUELTAS. La tentacion
 * era pedir que la cifra no estuviera pegada a letras, y eso SI abriria un
 * agujero: "te queda en 49900pesos" dejaria de revisarse. Aqui solo se
 * exime un patron propio y reconocible -prefijo NOV-, dos bloques- que
 * genera el codigo y que ningun modelo va a usar para colar un precio.
 */
const ID_DE_PEDIDO = /\bNOV-[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/g;

function revisarImportes(texto, importesAutorizados) {
  const autorizados = new Set((importesAutorizados || []).map(Number));
  const sospechosos = [];

  // Los identificadores se tapan con guiones de la misma longitud: asi las
  // posiciones del resto del texto no se mueven y lo que queda se revisa
  // igual de estricto.
  const limpio = String(texto ?? "").replace(ID_DE_PEDIDO, (id) => "-".repeat(id.length));

  // Cifras con formato de dinero: $12.000, 12.000, 12000, $ 12,000
  const re = /\$?\s?(\d{1,3}(?:[.,]\d{3})+|\d{4,7})/g;
  let m;
  while ((m = re.exec(limpio)) !== null) {
    const n = Number(m[1].replace(/[.,]/g, ""));
    if (!Number.isFinite(n)) continue;
    if (!autorizados.has(n)) sospechosos.push({ texto: m[0].trim(), valor: n });
  }

  return { ok: sospechosos.length === 0, sospechosos };
}

module.exports = {
  POLITICA_VERSION,
  MONEDA,
  MOTORES,
  POLITICAS_ENVIO,
  condicionesDe,
  cotizar,
  firmaDeCondiciones,
  revisarImportes,
  versionDeCatalogo,
  ID_DE_PEDIDO,
};
