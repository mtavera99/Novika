"use strict";

// ==========================================================================
// CONTRATO DE LA IA
//
// Modulo puro: define QUE se le puede pedir al modelo y QUE se acepta de
// vuelta. Sin red, sin proveedor, sin claves.
//
// La idea central de todo el diseño esta aqui:
//
//   LA IA NO DEVUELVE HECHOS. DEVUELVE CANDIDATOS.
//
// No hay ningun campo en el que el modelo pueda poner un precio, un total,
// un id de pedido o una confirmacion. No es que se valide despues: es que no
// existe el campo. Lo que no se puede expresar no se puede colar.
//
// Si el modelo devuelve algo que no encaja en este contrato, su salida se
// DESCARTA COMPLETA. No se rescata "la parte buena": una respuesta que no
// cumple el contrato es una respuesta que no entendemos, y usar la mitad de
// algo que no entendemos es como se cuelan los datos inventados.
// ==========================================================================

/** Intenciones que el modelo puede reconocer. Vocabulario cerrado. */
const INTENCIONES = {
  SALUDO: "saludo",
  PREGUNTA_PRODUCTO: "pregunta_producto",
  PREGUNTA_PRECIO: "pregunta_precio",
  PREGUNTA_ENVIO: "pregunta_envio",
  PREGUNTA_ESTADO: "pregunta_estado",
  INTENCION_COMPRA: "intencion_compra",
  DA_DATOS: "da_datos",
  CONFIRMA: "confirma",
  RECHAZA: "rechaza",
  MODIFICA: "modifica",
  CANCELA: "cancela",
  OBJECION: "objecion",
  FUERA_DE_TEMA: "fuera_de_tema",
  NO_SE_ENTIENDE: "no_se_entiende",
};

/**
 * Que significa cada intencion, para decirselo al modelo.
 *
 * ⚠ EL GUION NO LAS ENUMERABA, Y ESO TIRABA TODOS LOS TURNOS CON IA.
 *
 * Medido en produccion el 2026-11-11 con el numero nuevo: el guion pedia
 * `{"intencion":"..."}` sin decir cuales existen, el modelo contestaba
 * "informacion_producto" o "explicacion_producto", el contrato lo rechazaba
 * dos veces seguidas (`ia_contrato_incumplido` -> `ia_agotada`) y el turno
 * caia al respaldo determinista. Pedirle una lista cerrada sin darle la
 * lista es pedirle que adivine.
 *
 * Vive aqui, junto al vocabulario, para que el guion se construya desde la
 * misma lista que valida: si alguien añade una intencion, el modelo la ve.
 */
const DESCRIPCION_DE_INTENCIONES = {
  [INTENCIONES.SALUDO]: "solo saluda o abre la conversacion",
  [INTENCIONES.PREGUNTA_PRODUCTO]:
    "pregunta que venden, como es un producto, para que sirve, como funciona, material, medidas, garantia o pide fotos",
  [INTENCIONES.PREGUNTA_PRECIO]: "pregunta cuanto vale, el precio de una o varias unidades, o si hay descuento",
  [INTENCIONES.PREGUNTA_ENVIO]: "pregunta por el envio, cuanto tarda, a que ciudades llega o como se paga",
  [INTENCIONES.PREGUNTA_ESTADO]: "pregunta por un pedido que ya hizo: si salio, la guia, cuando le llega",
  [INTENCIONES.INTENCION_COMPRA]: "dice que lo quiere, pide que se lo manden o pregunta como pedirlo",
  [INTENCIONES.DA_DATOS]: "da su nombre, celular, ciudad, direccion, cantidad o una referencia",
  [INTENCIONES.CONFIRMA]: "dice que si a un resumen o a una pregunta de cierre",
  [INTENCIONES.RECHAZA]: "dice que no le interesa o que ya no",
  [INTENCIONES.MODIFICA]: "corrige un dato o cambia la cantidad de su pedido",
  [INTENCIONES.CANCELA]: "pide cancelar o anular un pedido",
  [INTENCIONES.OBJECION]: "duda o se queja: esta caro, lo vio mas barato, no confia, lo va a pensar",
  [INTENCIONES.FUERA_DE_TEMA]: "habla de algo que no tiene que ver con la tienda",
  [INTENCIONES.NO_SE_ENTIENDE]: "no se entiende lo que quiere",
};

/**
 * Nombres que los modelos usan de verdad para una intencion que SI existe.
 *
 * Es una traduccion explicita y cerrada, no un "acepta lo que se parezca":
 * cada entrada se escribio a mano y apunta a UNA intencion del vocabulario.
 * Lo que no esta aqui sigue rechazandose entero, igual que antes.
 *
 * Por que no rompe el contrato: la intencion es una CLASIFICACION, no un
 * hecho. No fija precio, ni pedido, ni confirmacion -la confirmacion se
 * decide en codigo antes de llamar al modelo-. Descartar un turno completo
 * porque el modelo escribio "informacion_producto" en vez de
 * "pregunta_producto" no protegia nada: tiraba un borrador bueno y dejaba al
 * cliente con el texto rigido.
 *
 * Las dos primeras son las que se vieron en produccion el 2026-11-11.
 */
const ALIAS_DE_INTENCION = {
  informacion_producto: INTENCIONES.PREGUNTA_PRODUCTO,
  explicacion_producto: INTENCIONES.PREGUNTA_PRODUCTO,
  consulta_producto: INTENCIONES.PREGUNTA_PRODUCTO,
  pregunta_catalogo: INTENCIONES.PREGUNTA_PRODUCTO,
  consulta_catalogo: INTENCIONES.PREGUNTA_PRODUCTO,
  pide_informacion: INTENCIONES.PREGUNTA_PRODUCTO,
  pide_fotos: INTENCIONES.PREGUNTA_PRODUCTO,
  consulta_precio: INTENCIONES.PREGUNTA_PRECIO,
  pregunta_precios: INTENCIONES.PREGUNTA_PRECIO,
  consulta_envio: INTENCIONES.PREGUNTA_ENVIO,
  pregunta_pago: INTENCIONES.PREGUNTA_ENVIO,
  consulta_estado: INTENCIONES.PREGUNTA_ESTADO,
  compra: INTENCIONES.INTENCION_COMPRA,
  quiere_comprar: INTENCIONES.INTENCION_COMPRA,
  datos: INTENCIONES.DA_DATOS,
  datos_envio: INTENCIONES.DA_DATOS,
  confirmacion: INTENCIONES.CONFIRMA,
  rechazo: INTENCIONES.RECHAZA,
  modificacion: INTENCIONES.MODIFICA,
  cancelacion: INTENCIONES.CANCELA,
  agradecimiento: INTENCIONES.SALUDO,
  despedida: INTENCIONES.SALUDO,
  queja: INTENCIONES.OBJECION,
  otro: INTENCIONES.FUERA_DE_TEMA,
};

/**
 * La intencion del modelo llevada al vocabulario cerrado, o null.
 *
 * Normaliza la forma -mayusculas, espacios, guiones- antes de buscar: "Pregunta
 * Producto" y "pregunta-producto" son la misma palabra mal escrita.
 */
function normalizarIntencion(valor) {
  if (typeof valor !== "string") return null;
  const limpia = valor
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s-]+/g, "_");
  if (Object.values(INTENCIONES).includes(limpia)) return limpia;
  return ALIAS_DE_INTENCION[limpia] || null;
}

/**
 * Campos que el modelo PUEDE proponer. Lista cerrada.
 *
 * Fijate en lo que no esta: precio, total, envio, descuento, pedidoId,
 * confirmado. El modelo no tiene donde escribirlos.
 */
const CAMPOS_PROPONIBLES = [
  "nombre",
  "telefono",
  "documento",
  "ciudad",
  "departamento",
  "direccion",
  "referencia",
  "cantidad",
  "variante",
];

/**
 * Lo que el modelo NO puede proponer nunca. Si aparece, la respuesta entera
 * se descarta y se registra: significa que el prompt se desvio o que el
 * modelo esta improvisando, y las dos cosas hay que verlas.
 */
const CAMPOS_PROHIBIDOS = [
  "precio",
  "precioUnitario",
  "total",
  "subtotal",
  "envio",
  "descuento",
  "pedidoId",
  "ofertaId",
  "confirmado",
  "estado",
  "productoActivo",
  "importe",
  "valor",
];

function esTextoCorto(v, max) {
  return typeof v === "string" && v.trim() !== "" && v.length <= max;
}

/**
 * Valida la salida del modelo contra el contrato.
 *
 * @returns {{ok: true, analisis: object} | {ok: false, motivo: string}}
 */
function validarAnalisis(crudo) {
  if (crudo === null || typeof crudo !== "object" || Array.isArray(crudo)) {
    return { ok: false, motivo: "la salida no es un objeto" };
  }

  // 1. Campos prohibidos, a cualquier profundidad. Se revisa ANTES que nada
  //    mas: si el modelo intento meter un importe, no interesa si el resto
  //    estaba bien.
  const encontrado = buscarProhibidos(crudo);
  if (encontrado) {
    return { ok: false, motivo: `la salida intenta fijar un hecho critico: "${encontrado}"` };
  }

  // 2. Intencion. Se traduce SOLO por la tabla cerrada de alias; lo que no
  //    este en el vocabulario ni en la tabla se rechaza como siempre.
  const intencion = normalizarIntencion(crudo.intencion);
  if (!intencion) {
    return { ok: false, motivo: `intencion "${crudo.intencion}" no esta en el vocabulario` };
  }

  // 3. Candidatos
  const candidatos = {};
  if (crudo.candidatos !== undefined) {
    if (crudo.candidatos === null || typeof crudo.candidatos !== "object" || Array.isArray(crudo.candidatos)) {
      return { ok: false, motivo: "candidatos tiene que ser un objeto" };
    }
    for (const [campo, valor] of Object.entries(crudo.candidatos)) {
      if (!CAMPOS_PROPONIBLES.includes(campo)) {
        return { ok: false, motivo: `el modelo no puede proponer "${campo}"` };
      }
      if (valor === null || valor === "") continue;

      if (campo === "cantidad") {
        if (!Number.isInteger(valor) || valor < 1 || valor > 999) {
          return { ok: false, motivo: `cantidad propuesta invalida: ${JSON.stringify(valor)}` };
        }
        candidatos[campo] = valor;
        continue;
      }
      if (campo === "variante") {
        if (typeof valor !== "object" || Array.isArray(valor)) {
          return { ok: false, motivo: "variante propuesta tiene que ser un objeto clave -> opcion" };
        }
        candidatos[campo] = valor;
        continue;
      }
      if (!esTextoCorto(valor, 200)) {
        return { ok: false, motivo: `el candidato "${campo}" no es un texto corto valido` };
      }
      candidatos[campo] = valor.trim();
    }
  }

  // 4. Producto: el modelo puede SUGERIR un id, pero no fijarlo. Quien
  //    resuelve el producto es src/catalogo/senales.js.
  let productoSugerido = null;
  if (crudo.productoSugerido !== undefined && crudo.productoSugerido !== null) {
    if (!esTextoCorto(crudo.productoSugerido, 80)) {
      return { ok: false, motivo: "productoSugerido no es un identificador valido" };
    }
    productoSugerido = crudo.productoSugerido.trim();
  }

  // 5. Borrador de respuesta. Es texto para una persona o para validar
  //    despues; no se envia sin pasar por los filtros de importes y claims.
  let borrador = null;
  if (crudo.borradorRespuesta !== undefined && crudo.borradorRespuesta !== null) {
    if (typeof crudo.borradorRespuesta !== "string" || crudo.borradorRespuesta.length > 2000) {
      return { ok: false, motivo: "borradorRespuesta tiene que ser texto de menos de 2000 caracteres" };
    }
    borrador = crudo.borradorRespuesta;
  }

  let preguntas = [];
  if (crudo.preguntasDelCliente !== undefined) {
    if (!Array.isArray(crudo.preguntasDelCliente)) {
      return { ok: false, motivo: "preguntasDelCliente tiene que ser una lista" };
    }
    preguntas = crudo.preguntasDelCliente.filter((q) => esTextoCorto(q, 300)).slice(0, 5);
  }

  return {
    ok: true,
    analisis: {
      intencion,
      // Lo que escribio el modelo, si hubo que traducirlo. Sirve para ver en
      // el diario que alias se usan y decidir si el guion necesita ajuste.
      intencionOriginal: intencion !== crudo.intencion ? String(crudo.intencion) : null,
      candidatos,
      productoSugerido,
      borradorRespuesta: borrador,
      preguntasDelCliente: preguntas,
      // Confianza declarada por el modelo. Se guarda como dato informativo;
      // NO se usa para decidir nada critico: un modelo seguro de si mismo se
      // equivoca igual.
      confianzaDeclarada: typeof crudo.confianza === "number" ? crudo.confianza : null,
    },
  };
}

/** Busca una clave prohibida en cualquier nivel del objeto. */
function buscarProhibidos(objeto, profundidad = 0) {
  if (profundidad > 6 || objeto === null || typeof objeto !== "object") return null;
  for (const [clave, valor] of Object.entries(objeto)) {
    if (CAMPOS_PROHIBIDOS.includes(clave)) return clave;
    if (typeof valor === "object" && valor !== null) {
      const dentro = buscarProhibidos(valor, profundidad + 1);
      if (dentro) return dentro;
    }
  }
  return null;
}

/** Analisis seguro para cuando la IA no esta disponible o falla. */
function analisisDeRespaldo(motivo) {
  return {
    intencion: INTENCIONES.NO_SE_ENTIENDE,
    candidatos: {},
    productoSugerido: null,
    borradorRespuesta: null,
    preguntasDelCliente: [],
    confianzaDeclarada: null,
    respaldo: true,
    motivoRespaldo: motivo,
  };
}

module.exports = {
  INTENCIONES,
  DESCRIPCION_DE_INTENCIONES,
  ALIAS_DE_INTENCION,
  normalizarIntencion,
  CAMPOS_PROPONIBLES,
  CAMPOS_PROHIBIDOS,
  validarAnalisis,
  analisisDeRespaldo,
};
