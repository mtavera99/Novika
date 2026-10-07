"use strict";

// ==========================================================================
// FECHAS Y HORAS DE COLOMBIA
//
// Todo el panel se lee en hora de Bogota, porque el dueno decide con ella:
// "las ventas de hoy" significa hoy en Colombia, no hoy en UTC.
//
// --------------------------------------------------------------------------
// POR QUE ESTE MODULO EXISTE Y NO ES UNA LINEA SUELTA
// --------------------------------------------------------------------------
//
// BIKERPRO se equivoco aqui, y sus pruebas lo dejaron documentado. Tres
// defectos distintos, los tres reutilizados como requisitos:
//
//   1. EL BORDE DEL DIA. Bogota es UTC-5. A las 19:00 de Bogota en UTC ya es
//      el dia siguiente. Un pedido hecho a las 19:30 del lunes aparecia en
//      el martes, asi que el cierre del lunes no cuadraba con lo que el
//      dueno habia vendido. Su bateria recorre un ano entero HORA POR HORA
//      para cubrir los dos cambios de dia.
//
//   2. LA ENTRADA VACIA. `toLocaleDateString` con una fecha invalida
//      devuelve el texto "Invalid Date" -y entonces el dia es la cadena
//      "Invalid Date", que agrupa mal sin quejarse-, pero `Intl.format`
//      LANZA RangeError. El panel se caia entero por un pedido sin fecha.
//      Por eso aqui una entrada que no se entiende devuelve null y quien
//      llama decide, en vez de reventar.
//
//   3. SIN ESTADO. Si estas funciones cachearan algo, dos llamadas con el
//      mismo valor podrian dar dias distintos, y los chats apareceriian en
//      el dia equivocado de forma intermitente. Son puras a proposito.
// ==========================================================================

const ZONA = "America/Bogota";

/** Partes de la fecha en Bogota, o null si la entrada no se entiende. */
function partesEnBogota(valor) {
  const ms = aMilisegundos(valor);
  if (ms === null) return null;
  try {
    // `en-CA` da directamente AAAA-MM-DD, sin tener que reordenar nada.
    const fecha = new Intl.DateTimeFormat("en-CA", {
      timeZone: ZONA,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
    const hora = new Intl.DateTimeFormat("es-CO", {
      timeZone: ZONA,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(ms);
    return { dia: fecha, hora };
  } catch {
    return null;
  }
}

/**
 * Cualquier cosa razonable -> milisegundos. null si no se entiende.
 *
 * Acepta numero (ms), Date e ISO. Devolver null en vez de NaN es
 * deliberado: NaN se propaga en silencio y acaba agrupando pedidos en un
 * dia que no existe.
 */
function aMilisegundos(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (valor instanceof Date) {
    const t = valor.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  const t = Date.parse(String(valor));
  return Number.isFinite(t) ? t : null;
}

/**
 * Dia AAAA-MM-DD en Bogota. null si la entrada no se entiende.
 *
 * Es la funcion de la que cuelga todo el agrupado por fecha del panel.
 */
function diaBogota(valor) {
  const p = partesEnBogota(valor);
  return p ? p.dia : null;
}

/** HH:MM en Bogota. "" si no se entiende: en una tabla es mejor un hueco. */
function horaBogota(valor) {
  const p = partesEnBogota(valor);
  return p ? p.hora : "";
}

/** "AAAA-MM-DD HH:MM" en Bogota. */
function fechaYHoraBogota(valor) {
  const p = partesEnBogota(valor);
  return p ? `${p.dia} ${p.hora}` : "";
}

/** Hoy en Bogota. */
function hoyBogota(ahora = Date.now()) {
  return diaBogota(ahora);
}

/** El dia anterior a uno dado (AAAA-MM-DD), sin pasar por zonas horarias. */
function diaAnterior(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dia || ""));
  if (!m) return null;
  // Se calcula en UTC a proposito: `dia` ya es una fecha civil de Bogota, y
  // volver a convertirla introduciria el desfase otra vez.
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Lista de dias hacia atras desde uno dado, el mas reciente primero. */
function ultimosDias(cuantos, desde = hoyBogota()) {
  const dias = [];
  let d = desde;
  for (let i = 0; i < cuantos && d; i++) {
    dias.push(d);
    d = diaAnterior(d);
  }
  return dias;
}

/** "hace 3 min", "hace 2 h", "hace 4 d". Para saber si un chat esta caliente. */
function hace(valor, ahora = Date.now()) {
  const ms = aMilisegundos(valor);
  if (ms === null) return "";
  const seg = Math.max(0, Math.round((ahora - ms) / 1000));
  if (seg < 60) return "hace un momento";
  const min = Math.round(seg / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/** Minutos desde un instante. null si no se entiende. */
function minutosDesde(valor, ahora = Date.now()) {
  const ms = aMilisegundos(valor);
  if (ms === null) return null;
  return Math.max(0, (ahora - ms) / 60000);
}

module.exports = {
  ZONA,
  diaBogota,
  horaBogota,
  fechaYHoraBogota,
  hoyBogota,
  diaAnterior,
  ultimosDias,
  hace,
  minutosDesde,
  aMilisegundos,
};
