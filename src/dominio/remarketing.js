"use strict";

// ==========================================================================
// REMARKETING FUERA DE LA VENTANA DE 24 H
//
// Modulo puro: decide si a una conversacion le toca UN toque por plantilla
// aprobada, y con que variables. Sin I/O.
//
// POR QUE EXISTE (2026-11-17). Los recordatorios caben dentro de las 24 h
// en que Meta deja escribir texto libre. Pasado eso solo entran plantillas
// aprobadas, y Marco quiere poder volver a escribirle a quien se quedo
// callado. La plantilla que hay hoy en Meta (`promo_canas`) trae impreso el
// precio viejo de $120.000, y NO se conecta: un mensaje que cobra otra cosa
// es un cliente que reclama en la puerta.
//
// Los candados, y por que cada uno:
//
//   · PRECIOS DECLARADOS Y COMPROBADOS. El texto de una plantilla vive en
//     Meta, no aqui, asi que el filtro de importes no lo puede leer. Quien
//     la configura declara que importes trae (REMARKETING_PRECIOS) y aqui se
//     comprueba que cada uno salga del cotizador del producto. Si no, no se
//     manda. «ninguno» vale para una plantilla sin cifras.
//   · RETIRADAS. Una lista de nombres que no se mandan aunque se configuren:
//     `promo_canas` por defecto.
//   · LAS MISMAS GUARDAS QUE UN RECORDATORIO: sin pedido, sin pausa, sin
//     «no», sin persona dentro, con horario de Bogota. Y UNA vez por
//     silencio: dos plantillas seguidas sin respuesta es spam desde el
//     numero de la empresa, y un reporte de spam cuesta la calidad del
//     numero.
//   · NUNCA EL NOMBRE DE PERFIL. Si la plantilla lleva el nombre, solo el
//     que escribio el cliente; si no lo hay, no se manda (Meta rechaza un
//     parametro vacio, y un «Hola, 🤪» suena a envio masivo).
// ==========================================================================

const estados = require("./estados");
const campos = require("./campos");
const cotizador = require("./cotizador");
const atencion = require("../almacen/atencion");
const recordatorios = require("./recordatorios");

const MOTIVOS = {
  APAGADO: "sin plantilla de remarketing configurada",
  RETIRADA: "la plantilla esta retirada (precio viejo)",
  SIN_PRECIOS_DECLARADOS: "falta REMARKETING_PRECIOS: no se sabe que importes trae la plantilla",
  PRECIO_NO_AUTORIZADO: "la plantilla trae un importe que el cotizador no da",
  SIN_PRODUCTO: "la conversacion no tiene un producto activo",
  NO_SALUDADO: "el bot nunca le dijo nada",
  TURNO_DEL_BOT: "el ultimo mensaje es del cliente",
  TIENE_PEDIDO: "ya tiene un pedido",
  BLINDADO: "la tiene una persona",
  PAUSADO: "el chat esta pausado",
  DECLINO: "dijo que no",
  SIN_MARCA: "no se sabe cuando escribio el cliente",
  DENTRO_DE_VENTANA: "todavia esta dentro de las 24 h: le toca al recordatorio normal",
  DEMASIADO_TARDE: "paso demasiado tiempo desde su ultimo mensaje",
  YA_ENVIADO: "ya recibio el remarketing de este silencio",
  FUERA_DE_HORARIO: "fuera del horario permitido",
  SIN_NOMBRE: "la plantilla pide el nombre y el cliente no lo escribio",
  VARIABLE_DESCONOCIDA: "la plantilla pide una variable que el bot no sabe llenar",
};

/** Los importes que trae un producto en su tabla, segun el cotizador. */
function importesDelProducto(producto) {
  const autorizados = new Set();
  for (const n of Object.keys((producto && producto.precios) || {})) {
    const r = cotizador.cotizar({ producto, cantidad: Number(n) });
    if (r && r.ok) autorizados.add(r.cotizacion.total);
  }
  return autorizados;
}

/**
 * ¿Los precios declarados de la plantilla salen del cotizador?
 * @returns {{ok: boolean, motivo?: string, sobran?: number[]}}
 */
function revisarPrecios(declarados, producto) {
  const texto = String(declarados || "").trim().toLowerCase();
  if (!texto) return { ok: false, motivo: MOTIVOS.SIN_PRECIOS_DECLARADOS };
  if (texto === "ninguno" || texto === "ninguna" || texto === "0") return { ok: true };
  const cifras = texto
    .split(/[,;\s]+/)
    .map((x) => Number(String(x).replace(/\D/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!cifras.length) return { ok: false, motivo: MOTIVOS.SIN_PRECIOS_DECLARADOS };
  const autorizados = importesDelProducto(producto);
  const sobran = cifras.filter((n) => !autorizados.has(n));
  return sobran.length ? { ok: false, motivo: MOTIVOS.PRECIO_NO_AUTORIZADO, sobran } : { ok: true };
}

/** El nombre de pila SOLO si lo escribio el cliente. */
function nombreDelCliente(conversacion) {
  const f = (conversacion && conversacion.ficha && conversacion.ficha.nombre) || null;
  if (!f || f.origen !== campos.ORIGENES.CLIENTE) return "";
  const v = String(campos.valorConfirmado(f) || "").trim().split(/\s+/)[0] || "";
  return /^[\p{L}]{3,}$/u.test(v) ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : "";
}

/**
 * ¿Le toca el remarketing a esta conversacion?
 *
 * @returns {{debe: boolean, motivo: string, variables?: string[], base?: string}}
 */
function decidir({
  conversacion,
  producto = null,
  config = {},
  ahora = Date.now(),
  desdeHora = 8,
  hastaHora = 21,
  horaBogota = null,
} = {}) {
  const no = (motivo, extra = {}) => ({ debe: false, motivo, ...extra });
  const plantilla = String(config.remarketingPlantilla || "").trim();
  if (!plantilla) return no(MOTIVOS.APAGADO);
  if ((config.remarketingRetiradas || []).includes(plantilla.toLowerCase())) return no(MOTIVOS.RETIRADA);
  if (!producto || producto.activo !== true) return no(MOTIVOS.SIN_PRODUCTO);

  const precios = revisarPrecios(config.remarketingPrecios, producto);
  if (!precios.ok) return no(precios.motivo, { sobran: precios.sobran || [] });

  if (!conversacion || conversacion.saludado !== true) return no(MOTIVOS.NO_SALUDADO);
  if (!recordatorios.habloElNegocioDeUltimo(conversacion)) return no(MOTIVOS.TURNO_DEL_BOT);
  if (estados.tienePedido(conversacion.estado)) return no(MOTIVOS.TIENE_PEDIDO);
  if (estados.estaBlindado(conversacion.estado)) return no(MOTIVOS.BLINDADO);
  if (atencion.leer(conversacion).pausado === true) return no(MOTIVOS.PAUSADO);
  if (conversacion.declino === true) return no(MOTIVOS.DECLINO);

  const marca = recordatorios.ultimoDelClienteMs(conversacion);
  if (marca === null) return no(MOTIVOS.SIN_MARCA);
  const horas = (ahora - marca) / 3600000;
  const desde = Math.max(24, Number(config.remarketingDesdeHoras) || 24);
  const hasta = Math.max(desde + 1, Number(config.remarketingHastaHoras) || 72);
  if (horas < desde) return no(MOTIVOS.DENTRO_DE_VENTANA);
  if (horas > hasta) return no(MOTIVOS.DEMASIADO_TARDE);

  const base = new Date(marca).toISOString();
  if (conversacion.remarketing && conversacion.remarketing.base === base) return no(MOTIVOS.YA_ENVIADO);

  const hora = Number.parseInt(String(horaBogota || "").slice(0, 2), 10);
  if (Number.isFinite(hora) && (hora < desdeHora || hora >= hastaHora)) return no(MOTIVOS.FUERA_DE_HORARIO);

  const variables = [];
  for (const v of config.remarketingVariables || []) {
    if (v === "nombre") {
      const n = nombreDelCliente(conversacion);
      if (!n) return no(MOTIVOS.SIN_NOMBRE);
      variables.push(n);
    } else if (v === "producto") {
      variables.push(String(producto.nombre || producto.nombreCorto || "").trim());
    } else {
      return no(MOTIVOS.VARIABLE_DESCONOCIDA);
    }
  }

  return { debe: true, motivo: `silencio de ${Math.floor(horas)} h`, variables, base, plantilla };
}

module.exports = { decidir, revisarPrecios, importesDelProducto, nombreDelCliente, MOTIVOS };
