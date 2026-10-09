"use strict";

// ==========================================================================
// PANTALLAS DEL PANEL
//
// HTML servido desde el servidor, sin framework y sin recursos externos.
// Para una herramienta que un dueno abre desde el celular en la calle, eso
// es una ventaja: carga en una peticion y funciona con mala senal.
//
// --------------------------------------------------------------------------
// LO QUE SE REUTILIZA DE BIKERPRO (cada punto viene de un incidente suyo)
// --------------------------------------------------------------------------
//
//   - Los inputs tienen 16px MINIMO. iOS hace zoom solo al enfocar un input
//     mas pequeno, y la pagina salta. Pasaba justo al escribirle a un
//     cliente: "el detalle que mas hacia sentir el panel roto".
//
//   - Los objetivos tactiles miden 44px de alto. Sus botones tenian ~30px.
//
//   - Las tablas se APILAN en pantalla estrecha usando data-label, y la
//     etiqueta va en el HTML, no solo en el CSS. Siete columnas en 390px no
//     se leen, y esa es la pantalla que se usa con el celular en la mano.
//
//   - Las acciones van por fetch y devuelven JSON: un redirect recargaria
//     la pagina y CERRARIA la conversacion abierta.
//
//   - Se mira el ESTADO HTTP antes de interpretar el cuerpo. Un 403
//     devuelve el texto "Forbidden"; hacer r.json() a ciegas muestra
//     "Unexpected token 'F'" y manda a buscar el problema donde no esta.
//     A ellos les paso dos veces.
//
//   - Se conservan el borrador, la conversacion abierta y la posicion del
//     scroll al actualizar.
// ==========================================================================

const fecha = require("./fecha");
const { CLASES } = require("./datos");
const fichaDe = require("./ficha");
const { esUnBsuid } = require("../whatsapp/enviar");
const atencion = require("../almacen/atencion");

/**
 * Los motivos de una tarea pendiente, dichos en castellano.
 *
 * El motivo guardado es una clave ("quiere_otra_compra"). Mostrarla tal
 * cual obliga a traducirla mentalmente, y quien atiende tiene prisa.
 */
const MOTIVOS_EN_CLARO = {
  [atencion.MOTIVOS_PENDIENTE.SIN_DATO]: "preguntó algo que no está en el catálogo",
  [atencion.MOTIVOS_PENDIENTE.OTRA_COMPRA]: "quiere otra compra y ya tiene un pedido",
  [atencion.MOTIVOS_PENDIENTE.CAMBIO_DE_PEDIDO]: "quiere cambiar algo de un pedido confirmado",
  [atencion.MOTIVOS_PENDIENTE.NO_SUPO]: "el bot no supo resolverlo y se detuvo",
  [atencion.MOTIVOS_PENDIENTE.SIN_TELEFONO]:
    "escribió con nombre de usuario y no tiene teléfono: el bot no puede responderle",
};

/** Escape de HTML. Todo lo que venga de un cliente pasa por aqui. */
function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Pesos colombianos, sin decimales: el dominio trabaja en pesos enteros. */
function pesos(n) {
  return "$" + Number(n || 0).toLocaleString("es-CO", { maximumFractionDigits: 0 });
}

/**
 * Marca un dato que NO esta confirmado.
 *
 * La ficha distingue candidato de confirmado a proposito: la IA propone y
 * el codigo confirma. Pintar los dos igual borra esa frontera justo donde
 * una persona decide, asi que un candidato se muestra con su valor Y con
 * el aviso de que nadie lo valido.
 */
function conEstado(campo) {
  if (!campo || !campo.hay) return `<span style="color:var(--suave)">${esc(SIN_DATO)}</span>`;
  if (campo.confirmado) return esc(campo.valor);
  return `${esc(campo.valor)} <span class="pastilla pendiente" title="lo propuso la IA o el cliente y nadie lo ha validado">sin confirmar</span>`;
}

const SIN_DATO = "—";

const ETIQUETAS = {
  [CLASES.URGENTE]: "Urgentes",
  [CLASES.PENDIENTE]: "Pendientes",
  [CLASES.POSVENTA]: "Posventa",
  [CLASES.ATENDIDA]: "Atendidas",
  [CLASES.EN_CURSO]: "En curso",
};

const ESTILO = `
:root { color-scheme: dark; --fondo:#0f1115; --caja:#171a21; --borde:#262b36;
        --texto:#e8eaed; --suave:#9aa3b2; --azul:#4f8cff; --verde:#3ddc84;
        --ambar:#ffc857; --rojo:#ff6b6b; }
* { box-sizing: border-box; }
html, body { margin:0; background:var(--fondo); color:var(--texto);
  font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
a { color:var(--azul); }
.envoltorio { max-width:1100px; margin:0 auto; padding:16px; }

header { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:14px; }
header h1 { margin:0; font-size:20px; letter-spacing:.5px; }
header .zona { color:var(--suave); font-size:13px; }
header .derecha { margin-left:auto; display:flex; gap:8px; align-items:center; }
header .derecha .boton[aria-current="page"] { background:var(--azul); border-color:var(--azul); color:#fff; }

.aviso { padding:10px 12px; border-radius:10px; font-size:14px; margin-bottom:14px; }
.aviso.ok { background:#13301f; border:1px solid #1f5c38; color:#9ff0c0; }
.aviso.mal { background:#3a1d1d; border:1px solid #6b2b2b; color:#ffb4b4; }
.aviso.info { background:#1a2435; border:1px solid #2b3f5c; color:#b8cdf0; }
.aviso.ambar { background:#3a2f16; border:1px solid #6b5524; color:#ffdf9e; }

.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:16px; }
.kpi { background:var(--caja); border:1px solid var(--borde); border-radius:12px; padding:14px; }
.kpi b { display:block; font-size:26px; line-height:1.2; }
.kpi span { color:var(--suave); font-size:13px; }
.kpi .nota { font-size:12px; color:var(--suave); margin-top:4px; }

/* 44px MINIMO de alto: guia de Apple. Los de BIKERPRO tenian ~30px. */
button, .boton { min-height:44px; padding:0 16px; font-size:15px; font-weight:600;
  border:1px solid var(--borde); border-radius:10px; background:var(--caja);
  color:var(--texto); cursor:pointer; display:inline-flex; align-items:center;
  justify-content:center; gap:6px; text-decoration:none; }
button.primario, .boton.primario { background:var(--azul); border-color:var(--azul); color:#fff; }
button.peligro { background:#3a1d1d; border-color:#6b2b2b; color:#ffb4b4; }
button:active { transform:translateY(1px); }
button[disabled] { opacity:.5; cursor:not-allowed; }

/* 16px MINIMO: por debajo, iOS hace zoom al enfocar y la pagina salta. */
input, textarea, select { font-size:16px; font-family:inherit; width:100%;
  padding:12px 13px; border-radius:10px; border:1px solid #2d3340;
  background:#0f1115; color:var(--texto); min-height:44px; }
textarea { min-height:88px; resize:vertical; }
input:focus, textarea:focus, select:focus { outline:2px solid var(--azul); outline-offset:1px; }

.pestanas { display:flex; gap:8px; overflow-x:auto; padding-bottom:4px; margin-bottom:12px;
  -webkit-overflow-scrolling:touch; }
.pestanas .boton { white-space:nowrap; }
.pestanas .boton[aria-current="true"] { background:var(--azul); border-color:var(--azul); color:#fff; }
.cuenta { background:#0f1115; border-radius:999px; padding:1px 8px; font-size:12px; }

/* ---- BANDEJA DE CHATS ----
   Pensada para el pulgar: filas altas, toda la fila es el enlace, y el
   ultimo mensaje visible para no tener que abrir cada chat. */
.buscador { display:flex; gap:8px; margin-bottom:10px; align-items:center; flex-wrap:wrap; }
.buscador input[type=search] { flex:1; min-width:180px; }
.buscador .limpiar { color:var(--suave); font-size:13px; }
.pests { display:flex; gap:8px; overflow-x:auto; padding-bottom:6px; margin-bottom:6px;
  -webkit-overflow-scrolling:touch; }
.pest { white-space:nowrap; background:var(--caja); border:1px solid var(--borde);
  border-radius:999px; padding:9px 13px; font-size:14px; text-decoration:none;
  color:var(--texto); display:inline-flex; align-items:center; gap:6px; min-height:40px; }
.pest.activa { background:var(--azul); border-color:var(--azul); color:#fff; }
.pest.activa .pastilla { background:rgba(255,255,255,.22); color:#fff; }
.listaChats { display:flex; flex-direction:column; gap:8px; }
.filaChat { display:block; background:var(--caja); border:1px solid var(--borde);
  border-radius:12px; padding:12px; text-decoration:none; color:var(--texto); }
.filaChat:active { background:#161a21; }
.filaTop { display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
.filaTop b { font-size:15px; }
.filaTop .cuando { color:var(--suave); font-size:12px; white-space:nowrap; }
.filaEtiquetas { display:flex; gap:5px; flex-wrap:wrap; margin:6px 0 5px; }
/* Un mensaje con una URL o una palabra larga desbordaria la fila y
   obligaria a hacer scroll lateral en toda la pantalla. */
.filaUltimo { font-size:14px; color:#c7ccd6; line-height:1.35;
  word-break:break-word; overflow-wrap:anywhere; }
.filaUltimo .quien { color:var(--suave); font-size:12px; text-transform:uppercase;
  letter-spacing:.3px; margin-right:3px; }
.filaPie { color:var(--suave); font-size:12px; margin-top:6px; }
.paginas { display:flex; justify-content:space-between; align-items:center; gap:10px;
  margin:14px 0 4px; }
.paginas a, .paginas span { font-size:14px; min-height:40px; display:inline-flex;
  align-items:center; }
.paginas a { color:var(--azul); text-decoration:none; }
.paginas span { color:var(--suave); }
.paginas .deque { font-size:13px; }

/* ---- DATOS DE ENTREGA ---- */
h2.seccion { font-size:16px; margin:20px 0 10px; }
.entregaTabla .difiere td { background:#2a2113; }
.entregaTabla .difiere td:first-child b::after { content:" ⚠"; color:#ffc857; }
.falta { color:#ff9aa4; font-size:13px; }
.entrega { background:var(--caja); border:1px solid var(--borde); border-radius:12px;
  padding:14px; margin-top:14px; display:flex; flex-direction:column; gap:10px; }
.entrega label { font-size:13px; color:var(--suave); display:flex; flex-direction:column; gap:5px; }
.entrega .botones { display:flex; gap:8px; flex-wrap:wrap; margin-top:4px; }
table.compacta td { padding:9px 12px; }

/* ---- CAUSAS DE SILENCIO ---- */
.causa { background:var(--caja); border:1px solid var(--borde); border-left-width:4px;
  border-radius:12px; padding:12px; margin-bottom:10px; }
.causa.alta { border-left-color:#ff6b6b; }
.causa.media { border-left-color:#ffc857; }
.causaTop { display:flex; justify-content:space-between; gap:10px; align-items:baseline;
  margin-bottom:6px; }
.causaTop b { font-size:15px; }
.causa .porque { color:var(--suave); font-size:13px; margin:0 0 6px; line-height:1.4; }
.causa .arreglo { font-size:14px; margin:0; line-height:1.4; }
.kpi.no b { color:#ff9aa4; }

table { width:100%; border-collapse:collapse; background:var(--caja);
  border:1px solid var(--borde); border-radius:12px; overflow:hidden; }
th, td { text-align:left; padding:11px 12px; border-bottom:1px solid var(--borde); font-size:14px; }
th { color:var(--suave); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
tr:last-child td { border-bottom:0; }

.pastilla { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--borde); }
.pastilla.urgente { background:#3a1d1d; border-color:#6b2b2b; color:#ffb4b4; }
.pastilla.pendiente { background:#3a2f16; border-color:#6b5524; color:var(--ambar); }
.pastilla.posventa { background:#1a2435; border-color:#2b3f5c; color:#b8cdf0; }
.pastilla.atendida { background:#13301f; border-color:#1f5c38; color:#9ff0c0; }
.pastilla.en_curso { color:var(--suave); }
.pastilla.pausado { background:#2d1f3a; border-color:#4a2f66; color:#d6b4ff; }

.vacio { background:var(--caja); border:1px dashed var(--borde); border-radius:12px;
  padding:26px; text-align:center; color:var(--suave); font-size:14px; }

/* ---- Chat ---- */
.chat { display:grid; gap:12px; }
.hilo { background:var(--caja); border:1px solid var(--borde); border-radius:12px;
  padding:12px; max-height:52vh; overflow-y:auto; display:flex; flex-direction:column; gap:8px; }
.burbuja { max-width:82%; padding:9px 12px; border-radius:14px; font-size:15px; }
.burbuja.cliente { align-self:flex-start; background:#1c2230; }
.burbuja.bot { align-self:flex-end; background:#1d3250; }
.burbuja.operador { align-self:flex-end; background:#1f4030; }
.burbuja .meta { display:block; font-size:11px; color:var(--suave); margin-top:4px; }
.burbuja .sinenviar { color:var(--ambar); }

/* ---- APILADO EN MOVIL ----
   Siete columnas en 390px no se leen. Cada celda muestra su etiqueta desde
   data-label, que va escrita en el HTML (y tambien en el JS que pinta
   filas: si solo estuviera en el CSS del servidor, las filas creadas
   dinamicamente saldrian sin etiqueta). */
@media (max-width: 760px) {
  .envoltorio { padding:12px; }
  table, thead, tbody, tr, th, td { display:block; }
  thead { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  table { border:0; background:transparent; }
  tr { background:var(--caja); border:1px solid var(--borde); border-radius:12px;
       margin-bottom:10px; padding:4px 0; }
  td { border-bottom:0; display:flex; gap:10px; align-items:baseline;
       padding:8px 12px; }
  td::before { content:attr(data-label); color:var(--suave); font-size:12px;
       text-transform:uppercase; letter-spacing:.4px; min-width:92px; flex:0 0 92px; }
  td.acciones { flex-wrap:wrap; }
  td.acciones::before { flex-basis:100%; }
  .kpi b { font-size:22px; }
  .burbuja { max-width:92%; }

  /* ======================================================================
     OPTIMIZACION PARA CELULAR
     ======================================================================
     Marco trabaja desde el movil. Cada regla de aqui sale de un problema
     concreto a 390px de ancho, que es un iPhone normal. */

  /* 1. LA NAVEGACION OCUPABA TRES FILAS.
        Seis secciones mas "Salir" con flex-wrap se envuelven y empujan el
        contenido util media pantalla hacia abajo: al abrir el panel se veia
        el menu y nada mas. Ahora va en su propio carril deslizable, como
        las pestañas de una app, y no roba alto. */
  header { position:sticky; top:0; z-index:20; background:var(--fondo);
    margin:-12px -12px 10px; padding:10px 12px 8px; gap:4px;
    border-bottom:1px solid var(--borde); flex-wrap:wrap; }
  header h1 { font-size:17px; }
  header .zona { font-size:11px; width:100%; order:3; }
  header .derecha { margin-left:auto; order:2; width:100%;
    overflow-x:auto; -webkit-overflow-scrolling:touch;
    padding-bottom:2px; gap:6px; }
  header .derecha::-webkit-scrollbar { display:none; }
  header .derecha .boton, header .derecha button { min-height:38px; padding:0 12px;
    font-size:13px; white-space:nowrap; flex:0 0 auto; }

  /* 2. LOS KPI DE UNA COLUMNA SE LEEN COMO UNA LISTA INTERMINABLE.
        Dos por fila entran bien en 390px y dejan ver el resto. */
  .kpis { grid-template-columns:repeat(2,1fr); gap:8px; }
  .kpi { padding:11px; }
  .kpi b { font-size:19px; }
  .kpi span { font-size:12px; }

  /* 3. LA TABLA DE ENTREGA DECIA "CAMPO: Destinatario".
        Con el apilado genérico, la primera celda repetia la palabra "Campo"
        delante del nombre del campo. Aqui el nombre del campo es el TITULO
        de la tarjeta, que es como se lee de verdad. */
  .entregaTabla td:first-child { display:block; padding:10px 12px 4px;
    border-bottom:1px solid var(--borde); margin-bottom:4px; }
  .entregaTabla td:first-child::before { display:none; }
  .entregaTabla td:first-child b { font-size:14px; }
  .entregaTabla td::before { min-width:84px; flex:0 0 84px; }

  /* 4. EL AREA DE ESCRIBIR QUEDABA TAPADA POR EL TECLADO.
        Con el teclado abierto, en un movil quedan ~350px de alto: un
        textarea de 88px mas los botones no cabian sin hacer scroll a
        ciegas. */
  textarea { min-height:72px; }
  .chat .hilo { max-height:48vh; overflow-y:auto; }

  /* 5. LA BANDEJA: filas mas compactas sin perder el area tactil. */
  .filaChat { padding:11px; }
  .filaTop b { font-size:14px; }
  .filaUltimo { font-size:13px; }

  /* 6. EL MUESCA DEL IPHONE se comia el ultimo boton de la pagina. */
  body { padding-bottom:calc(16px + env(safe-area-inset-bottom)); }

  /* 7. VOLVER ARRIBA. La pagina es larga a proposito -el historial no se
        borra- y subir deslizando es el gesto que mas se repite. */
  .subir { display:flex; }
}

/* Fuera del movil no hace falta: el menu cabe y la pagina es mas corta. */
.subir { position:fixed; right:14px; bottom:calc(14px + env(safe-area-inset-bottom));
  width:46px; height:46px; border-radius:999px; background:var(--azul); color:#fff;
  align-items:center; justify-content:center; text-decoration:none; font-size:20px;
  box-shadow:0 4px 14px rgba(0,0,0,.45); z-index:30; display:none; }
`;

/** Guion comun. Preserva borrador, conversacion abierta y scroll. */
const GUION = `
// ---------------------------------------------------------------------------
// Estado que NO se puede perder al actualizar.
//
// BIKERPRO lo aprendio a base de quejas: si el panel recarga y se pierde el
// borrador a medio escribir, o se cierra la conversacion abierta, o salta el
// scroll, la herramienta deja de usarse. Se guarda en sessionStorage, que
// sobrevive a la recarga y muere al cerrar la pestana.
// ---------------------------------------------------------------------------
var LLAVE = "novika.panel.";

// ---------------------------------------------------------------------------
// VOLVER ARRIBA
//
// El CSS lo limita al movil; esto lo limita a cuando hace falta. Un boton
// flotante en una pantalla que no scrollea tapa contenido sin servir de nada.
// ---------------------------------------------------------------------------
(function () {
  var b = document.getElementById("subir");
  if (!b) return;
  function revisar() {
    var hay = (document.documentElement.scrollHeight - window.innerHeight) > 400;
    b.style.visibility = hay && window.scrollY > 240 ? "visible" : "hidden";
  }
  revisar();
  window.addEventListener("scroll", revisar, { passive: true });
  window.addEventListener("resize", revisar);
})();

function recordar(k, v) { try { sessionStorage.setItem(LLAVE + k, v); } catch (e) {} }
function recordado(k) { try { return sessionStorage.getItem(LLAVE + k); } catch (e) { return null; } }

// Borradores: uno por conversacion, para no mezclar lo escrito a dos
// clientes distintos.
function guardarBorrador(id, texto) { recordar("borrador." + id, texto); }
function leerBorrador(id) { return recordado("borrador." + id) || ""; }
function borrarBorrador(id) { try { sessionStorage.removeItem(LLAVE + "borrador." + id); } catch (e) {} }

// Posicion del scroll, por pantalla.
function guardarScroll() { recordar("scroll." + location.pathname, String(window.scrollY)); }
function restaurarScroll() {
  var y = recordado("scroll." + location.pathname);
  if (y) window.scrollTo(0, Number(y));
}

/**
 * fetch que MIRA EL ESTADO antes de interpretar el cuerpo.
 *
 * Un 401/403 devuelve texto, no JSON. Hacer r.json() a ciegas muestra
 * "Unexpected token 'F'" (de "Forbidden") y manda a buscar el problema
 * donde no esta. A BIKERPRO le paso dos veces, en /responder y en /guias.
 */
async function pedir(url, cuerpo) {
  var r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo || {})
    });
  } catch (e) {
    return { ok: false, error: "Sin conexion. El mensaje NO se envio." };
  }

  var texto = await r.text();
  var datos = null;
  try { datos = JSON.parse(texto); } catch (e) {}

  if (!r.ok) {
    if (r.status === 401) {
      return { ok: false, error: "La sesion caduco. Vuelve a entrar.", caducada: true };
    }
    return { ok: false, error: (datos && datos.error) || ("Error " + r.status + ": " + texto.slice(0, 120)) };
  }
  if (!datos) return { ok: false, error: "El servidor respondio algo que no es JSON." };
  return datos;
}

function avisar(texto, clase) {
  var caja = document.getElementById("aviso");
  if (!caja) return;
  caja.className = "aviso " + (clase || "info");
  caja.textContent = texto;
  caja.hidden = false;
}

window.addEventListener("scroll", function () { guardarScroll(); }, { passive: true });
window.addEventListener("DOMContentLoaded", function () { restaurarScroll(); });
`;

/**
 * Cabecera comun.
 *
 * `seccion` marca el boton de la seccion actual. En el movil el menu es un
 * carril deslizable, asi que sin la marca no hay forma de saber en que
 * pantalla estas: en escritorio se deducia por la posicion.
 */
function cabecera({ titulo, dia = null, extra = "", seccion = null }) {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>NOVIKA · ${esc(titulo)}</title>
<style>${ESTILO}</style>
</head><body><div class="envoltorio">
<span id="arriba"></span>
<header>
  <h1>NOVIKA</h1>
  <span class="zona">${esc(titulo)}${dia ? ` · ${esc(dia)}` : ""} · hora de Colombia</span>
  <div class="derecha">
    <a class="boton" href="/panel"${seccion === "tablero" ? ' aria-current="page"' : ""}>Tablero</a>
    <a class="boton" href="/panel/chats"${seccion === "chats" ? ' aria-current="page"' : ""}>Chats</a>
    <a class="boton" href="/panel/sin-responder"${seccion === "sin-responder" ? ' aria-current="page"' : ""}>Sin responder</a>
    <a class="boton" href="/panel/buscar"${seccion === "buscar" ? ' aria-current="page"' : ""}>Buscar</a>
    <a class="boton" href="/panel/guias"${seccion === "guias" ? ' aria-current="page"' : ""}>Guías</a>
    <a class="boton" href="/panel/novedades"${seccion === "novedades" ? ' aria-current="page"' : ""}>Novedades</a>
    <a class="boton" href="/panel/indicadores"${seccion === "indicadores" ? ' aria-current="page"' : ""}>Indicadores</a>
    <a class="boton" href="/panel/auditoria"${seccion === "auditoria" ? ' aria-current="page"' : ""}>Auditoría</a>
    <form method="post" action="/panel/salir" style="display:inline">
      <button type="submit">Salir</button>
    </form>
  </div>
</header>
<div id="aviso" class="aviso info" hidden></div>
${extra}`;
}

/**
 * Pie comun: el boton de volver arriba y el guion compartido.
 *
 * El boton solo se muestra en movil (lo decide el CSS) y solo cuando hay
 * algo de scroll (lo decide el guion): un boton fijo en una pantalla corta
 * tapa contenido sin aportar nada.
 */
function pie(guionExtra = "") {
  return `</div>
<a href="#arriba" class="subir" id="subir" title="Volver arriba" aria-label="Volver arriba">↑</a>
<script>${GUION}${guionExtra}</script></body></html>`;
}

/** Fila de pestanas con las cuentas por clase. */
function pestanas(cuentas, activa, dia) {
  const q = (c) => `/panel?dia=${encodeURIComponent(dia)}&clase=${encodeURIComponent(c)}`;
  return `<nav class="pestanas">${Object.entries(ETIQUETAS)
    .map(
      ([clase, etiqueta]) =>
        `<a class="boton" href="${q(clase)}" aria-current="${activa === clase}">${esc(etiqueta)} <span class="cuenta">${
          cuentas[clase] || 0
        }</span></a>`
    )
    .join("")}</nav>`;
}

/** TABLERO */
function tablero({ datos, clase = CLASES.PENDIENTE, aviso = null, envioManualActivo = false }) {
  const r = datos.resumen;
  const chats = datos.porClase[clase] || [];

  const filas = chats.length
    ? chats
        .map(
          (c) => `<tr>
  <td data-label="Cliente">${esc(c.nombre.texto)}${
            c.nombre.hay && !c.nombre.confirmado ? ` <span class="pastilla pendiente">sin confirmar</span>` : ""
          }</td>
  <td data-label="Telefono">${esc(c.telefono)}</td>
  <td data-label="Estado"><span class="pastilla ${esc(c.clase)}">${esc(ETIQUETAS[c.clase] || c.clase)}</span>${
            c.atencion.pausado ? ` <span class="pastilla pausado">bot pausado</span>` : ""
          }</td>
  <td data-label="Ultimo">${esc(c.ultimoMensaje ? fecha.hace(c.ultimoMensaje.ts) : "")}</td>
  <td data-label="Mensajes">${c.cuantosMensajes}</td>
  <td class="acciones" data-label="Acciones">
    <a class="boton primario" href="/panel/chat?id=${encodeURIComponent(c.contactoId)}">Abrir</a>
  </td>
</tr>`
        )
        .join("")
    : "";

  const tabla = chats.length
    ? `<table>
<thead><tr><th>Cliente</th><th>Telefono</th><th>Estado</th><th>Ultimo</th><th>Mensajes</th><th>Acciones</th></tr></thead>
<tbody>${filas}</tbody></table>`
    : `<div class="vacio">No hay conversaciones en <b>${esc(ETIQUETAS[clase] || clase)}</b>.</div>`;

  const desglose = r.porProducto.length
    ? `<h2 style="font-size:16px;margin:22px 0 10px">Por producto</h2>
<table>
<thead><tr><th>Producto</th><th>Pedidos</th><th>Unidades</th><th>Importe</th></tr></thead>
<tbody>${r.porProducto
        .map(
          (p) => `<tr>
  <td data-label="Producto">${esc(p.productoId)}</td>
  <td data-label="Pedidos">${p.pedidos}</td>
  <td data-label="Unidades">${p.unidades}</td>
  <td data-label="Importe">${esc(pesos(p.importe))}</td>
</tr>`
        )
        .join("")}</tbody></table>`
    : "";

  return (
    cabecera({ titulo: "Tablero", dia: datos.dia, seccion: "tablero" }) +
    (aviso ? `<div class="aviso ${esc(aviso.clase)}">${esc(aviso.texto)}</div>` : "") +
    (!envioManualActivo
      ? `<div class="aviso info">Los envios manuales estan <b>apagados</b> (<code>PANEL_ENVIO_MANUAL=0</code>).
         El panel funciona completo y te dira el resultado real de cada intento, pero no saldra ningun WhatsApp.</div>`
      : "") +
    `<form method="get" action="/panel" style="display:flex;gap:8px;align-items:flex-end;margin-bottom:14px;flex-wrap:wrap">
  <div style="flex:0 0 190px">
    <label for="dia" style="font-size:13px;color:var(--suave)">Dia (hora de Colombia)</label>
    <input id="dia" name="dia" type="date" value="${esc(datos.dia)}">
  </div>
  <input type="hidden" name="clase" value="${esc(clase)}">
  <button class="primario" type="submit">Ver</button>
  <a class="boton" href="/panel/pedidos.csv?dia=${encodeURIComponent(datos.dia)}">Exportar CSV</a>
  <a class="boton" href="/panel/venta-manual">Venta manual</a>
</form>` +
    `<div class="kpis">
  <div class="kpi"><b>${r.pedidos}</b><span>pedidos</span></div>
  <div class="kpi"><b>${r.unidades}</b><span>unidades</span></div>
  <div class="kpi"><b>${esc(pesos(r.importe))}</b><span>importe</span></div>
  <div class="kpi"><b>${r.cancelados}</b><span>cancelados</span>
    ${r.cancelados ? `<div class="nota">${esc(pesos(r.importeCancelado))} anulados</div>` : ""}</div>
</div>` +
    pestanas(datos.cuentas, clase, datos.dia) +
    tabla +
    desglose +
    pie()
  );
}

/** CHAT */
function chat({ ficha, aviso = null, envioManualActivo = false }) {
  const { conversacion, mensajes, atencion: a, pedidos, clase, producto = null, fotosYaEnviadas = null } = ficha;
  const id = conversacion.contactoId;
  const n = fichaDe.nombreParaMostrar(conversacion.ficha);
  const nombre = n.texto;
  const ciudad = fichaDe.leer(conversacion.ficha, "ciudad");

  // ¿Entro con nombre de usuario? Se calcula con LA MISMA funcion que usa
  // el emisor, sobre el mismo destino que usaria la ruta de responder.
  //
  // Ya NO es un impedimento para escribirle -Meta admite enviar al BSUID
  // desde junio de 2026- pero si lo es para DESPACHAR: sin telefono la
  // transportadora no puede llamar, y el pedido lo exige.
  const destinoReal = fichaDe.confirmado(conversacion.ficha, "telefono") || id;
  const esPorNombreDeUsuario = esUnBsuid(destinoReal);

  const burbujas = mensajes.length
    ? mensajes
        .map((m) => {
          const quien = m.de === "cliente" ? "cliente" : m.por ? "operador" : "bot";
          const autor = m.de === "cliente" ? "cliente" : m.por ? `operador (${esc(m.por)})` : "bot";
          // El estado REAL. Nunca se muestra como dicho algo que no salio.
          // Un mensaje guarda el resultado REAL del intento en su momento.
          // Un intento hecho con el interruptor apagado seguira diciendo
          // "no enviado" para siempre, aunque despues se encienda: no salio,
          // y cambiarlo seria reescribir lo que paso.
          const noSalio = m.estado && m.estado !== "enviado";
          return `<div class="burbuja ${quien}">${esc(m.texto)}
<span class="meta">${esc(fecha.horaBogota(m.ts))} · ${autor}${
            noSalio ? ` · <span class="sinenviar">no enviado: ${esc(m.estado)}</span>` : ""
          }</span></div>`;
        })
        .join("")
    : `<div class="vacio">Sin mensajes todavia.</div>`;

  // ------------------------------------------------------------------
  // QUE SE DESPACHA Y COMO SE COBRA, no solo cuanto
  //
  // La tabla decia codigo, estado, unidades, total y fecha. NO decia el
  // PRODUCTO ni el METODO DE PAGO.
  //
  // El producto faltaba porque hoy solo hay uno, y eso se arregla justo
  // antes de que haya dos: el dia que entre el segundo, esta tabla no
  // dejaria distinguir que lleva cada pedido.
  //
  // Y EL PAGO ES EL PEOR DE LOS DOS. Es contraentrega: quien despacha
  // tiene que saber que hay que RECAUDAR. Un pedido contraentrega que no
  // dice que se cobra al entregar es un paquete entregado sin cobrar. El
  // dato ya viaja dentro de la cotizacion -el pedido la guarda como
  // snapshot-, solo no se mostraba.
  // ------------------------------------------------------------------
  // Los nombres salen de `condiciones` de la cotizacion, que es donde el
  // cotizador los deja de verdad: `pagoEtiqueta` es la frase que vio la
  // clienta y `pagoMetodo` la clave. Se prefiere la etiqueta porque es la
  // que ella aprobo, palabra por palabra.
  const comoPaga = (p) => {
    const c = (p.cotizacion && p.cotizacion.condiciones) || {};
    return c.pagoEtiqueta || c.pagoMetodo || "—";
  };
  const queLleva = (p) =>
    (p.producto && (p.producto.nombre || p.producto.id)) ||
    (p.cotizacion && p.cotizacion.productoNombre) ||
    "—";

  const tablaPedidos = pedidos.length
    ? `<h2 style="font-size:16px;margin:18px 0 10px">Pedidos de este cliente</h2>
<table>
<thead><tr><th>Codigo</th><th>Producto</th><th>Estado</th><th>Unidades</th><th>Total</th><th>Pago</th><th>Creado</th><th>Acciones</th></tr></thead>
<tbody>${pedidos
        .map(
          (p) => `<tr>
  <td data-label="Codigo">${esc(p.id)}</td>
  <td data-label="Producto">${esc(queLleva(p))}</td>
  <td data-label="Estado">${esc(p.estado)} <span class="pastilla">v${esc(p.version)}</span></td>
  <td data-label="Unidades">${esc((p.cotizacion && p.cotizacion.cantidad) || 1)}</td>
  <td data-label="Total">${esc(pesos((p.cotizacion && p.cotizacion.total) || 0))}</td>
  <td data-label="Pago">${esc(comoPaga(p))}</td>
  <td data-label="Creado">${esc(fecha.fechaYHoraBogota(p.creadoEn))}</td>
  <td class="acciones" data-label="Acciones">
    ${
      p.estado === "cancelado"
        ? `<span style="font-size:13px;color:var(--suave)">cancelado · queda en el historial</span>`
        : `<button class="peligro" onclick="cancelar('${esc(p.id)}')">Cancelar</button>`
    }
  </td>
</tr>`
        )
        .join("")}</tbody></table>`
    : `<div class="vacio" style="margin-top:16px">Este cliente todavia no tiene pedidos.</div>`;

  // ------------------------------------------------------------------
  // LO QUE EL BOT PROMETIO Y NADIE HA CONTESTADO
  //
  // Cuando el bot dice "se la paso a una persona del equipo", el cerebro
  // deja una tarea con el motivo y la pregunta. Si esa tarea no se VE,
  // la promesa sigue siendo vacia: solo cambia de sitio.
  //
  // Va arriba y en amarillo porque es lo unico de esta pantalla que tiene
  // una persona esperando al otro lado.
  // ------------------------------------------------------------------
  const porContestar = atencion.pendienteDe(conversacion);
  const avisoPendiente = porContestar.hay
    ? `<div class="aviso ambar">
         <b>Pendiente de contestar</b> · ${esc(MOTIVOS_EN_CLARO[porContestar.motivo] || porContestar.motivo)}
         <div style="margin-top:4px">Preguntó: «${esc(porContestar.pregunta)}»</div>
         <div class="nota">Espera desde ${esc(fecha.fechaYHoraBogota(porContestar.desde))}. Se cierra sola cuando respondas o la marques atendida.</div>
       </div>`
    : "";

  return (
    cabecera({ titulo: `Chat · ${nombre}`, seccion: "chats" }) +
    (aviso ? `<div class="aviso ${esc(aviso.clase)}">${esc(aviso.texto)}</div>` : "") +
    avisoPendiente +
    `<div class="kpis">
  <div class="kpi"><b>${esc(nombre)}</b>${
    n.hay && !n.confirmado ? ` <span class="pastilla pendiente">sin confirmar</span>` : ""
  }<span>${esc(id)}</span>
    <div class="nota">${ciudad.hay ? conEstado(ciudad) : "sin ciudad"}</div></div>
  <div class="kpi"><b>${esc(conversacion.estado)}</b><span>estado</span>
    <div class="nota"><span class="pastilla ${esc(clase)}">${esc(ETIQUETAS[clase] || clase)}</span></div></div>
  <div class="kpi"><b>${a.pausado ? "Persona" : "Bot"}</b><span>quien atiende</span>
    <div class="nota">${a.pausado ? `desde ${esc(fecha.fechaYHoraBogota(a.desde))}` : "el bot responde"}</div></div>
</div>` +
    `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
  ${
    a.pausado
      ? `<button class="primario" onclick="control(false)">Devolver al bot</button>`
      : `<button class="primario" onclick="control(true)">Tomar el control</button>`
  }
  <button onclick="atendido(${a.atendidoEn ? "true" : "false"})">${a.atendidoEn ? "Deshacer atendido" : "Marcar atendido"}</button>
  <button onclick="empezarDeCero()" title="El bot vuelve a tratar este chat como nuevo. NO borra el historial ni los pedidos.">Empezar de cero</button>
  ${
    producto && (producto.imagenes || []).length
      ? `<button onclick="enviarFotos(${fotosYaEnviadas ? "true" : "false"})">
           ${fotosYaEnviadas ? `Reenviar fotos (ya se enviaron)` : `Enviar ${producto.imagenes.length} fotos`}
         </button>`
      : `<span style="font-size:13px;color:var(--suave);align-self:center">${
          producto ? "este producto no tiene fotos" : "sin producto identificado: no hay fotos que mandar"
        }</span>`
  }
</div>` +
    `<div class="chat">
  <div class="hilo" id="hilo">${burbujas}</div>
  <div>
    ${
      // --------------------------------------------------------------
      // AVISAR ANTES, NO DESPUES DE ESCRIBIR
      //
      // Marco escribio DOS VECES a un cliente con nombre de usuario de
      // WhatsApp -17:25 y 00:46- y las dos veces el mensaje no salio. No
      // es un fallo que se arregle reintentando: ese cliente NO TIENE
      // numero, y Meta rechaza el destino (131026).
      //
      // Teniendo el dato antes de que escriba, dejarle redactar y fallar
      // es hacerle perder el tiempo dos veces. Se le dice aqui.
      esPorNombreDeUsuario
        ? `<div class="aviso info" style="margin-bottom:10px">
             Este cliente entró con su <b>nombre de usuario</b> de WhatsApp, así que oculta su número.
             <b>Sí se le puede escribir</b>: el mensaje sale con su identificador. Lo que no tenemos es
             su teléfono, y para <b>despachar</b> hace falta — pídeselo en el chat.
           </div>`
        : ""
    }
    <label for="texto" style="font-size:13px;color:var(--suave)">Responder como NOVIKA</label>
    <textarea id="texto" placeholder="Escribe la respuesta..."></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
      <button class="primario" id="enviar" onclick="responder()">Enviar</button>
      <span style="font-size:13px;color:var(--suave);align-self:center">
        ${
          /*
           * ⚠️ ESTE AVISO HA DICHO LAS DOS COSAS, Y AHORA DICE LA VERDAD.
           *
           * Historia corta, porque explica por que hay tanto comentario para
           * una frase:
           *
           *  · hasta el 09-oct decia "el bot queda pausado", y era verdad.
           *  · el 09-oct se cambio a "sigue atendiendo" SIN cambiar el
           *    codigo, que seguia poniendo `pausado: true`. El panel se
           *    contradecia consigo mismo: el formulario prometia una cosa y
           *    la respuesta de la API, otra.
           *  · el 10-oct Marco decidio el COMPORTAMIENTO: responder a mano
           *    NO debe callar al bot. «Si yo me meto en una conversación y
           *    respondo, el bot debería seguir ahí, a menos de que yo lo
           *    silencie». Se quito el `pausado: true` de `rutas.js`, y
           *    ahora el aviso dice lo que el codigo hace.
           *
           * Lo que costo la contradiccion: el chat de Popayan del 08-oct. Un
           * operador escribio "Me confirmas" a las 21:33, eso callo al bot,
           * el cliente contesto "Si" a las 21:36 y su respuesta murio con
           * "no enviado: conversacion_pausada".
           *
           * Hay una prueba que ata esta frase al codigo: si alguien vuelve a
           * cambiar uno sin el otro, falla ahi y no delante de un cliente.
           */
          envioManualActivo
            ? "Al enviar, el bot <strong>sigue atendiendo</strong> este chat. Si quieres que se calle, pulsa «Tomar el control»."
            : "Los env\u00edos manuales est\u00e1n <b>apagados</b>: se registrar\u00e1 el intento y su motivo real, pero no saldr\u00e1 nada. " +
              "Se encienden con <code>PANEL_ENVIO_MANUAL=1</code> en Render."
        }
      </span>
    </div>
  </div>
</div>` +
    datosDeEntrega({
      conversacion,
      // El ultimo pedido vivo: es el que se despacha. Un cancelado no sirve
      // para comparar datos de entrega.
      pedido: [...pedidos].reverse().find((p) => p.estado !== "cancelado") || null,
      editable: true,
      envioManualActivo,
    }) +
    tablaPedidos +
    pie(`
var ID = ${JSON.stringify(id)};

// Borrador: se guarda al teclear y se restaura al abrir. Perder lo escrito a
// medias es la forma mas rapida de que nadie use el panel.
var caja = document.getElementById("texto");
caja.value = leerBorrador(ID);
caja.addEventListener("input", function () { guardarBorrador(ID, caja.value); });

// El hilo arranca abajo, donde esta lo ultimo.
var hilo = document.getElementById("hilo");
hilo.scrollTop = hilo.scrollHeight;

async function responder() {
  var texto = caja.value.trim();
  if (!texto) { avisar("Escribe algo antes de enviar.", "mal"); return; }
  var boton = document.getElementById("enviar");
  boton.disabled = true;                 // evita el doble clic
  var r = await pedir("/panel/responder", { id: ID, texto: texto });
  boton.disabled = false;

  if (r.ok) {
    // El borrador SOLO se borra si el intento se registro. Si fallo, lo
    // escrito sigue ahi para poder reintentar.
    borrarBorrador(ID);
    caja.value = "";
    avisar(r.aviso || "Registrado.", r.enviado ? "ok" : "info");
    setTimeout(function () { location.reload(); }, 900);
  } else {
    avisar(r.error, "mal");
  }
}

async function control(tomar) {
  var r = await pedir("/panel/control", { id: ID, tomar: tomar });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 600); }
  else avisar(r.error, "mal");
}

async function atendido(deshacer) {
  var r = await pedir("/panel/atendido", { id: ID, deshacer: deshacer });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 600); }
  else avisar(r.error, "mal");
}

async function enviarFotos(yaSeEnviaron) {
  if (yaSeEnviaron && !confirm("Ya se le enviaron las fotos de este producto. ¿Reenviarlas?")) return;
  var pie = prompt("Pie de la primera foto (opcional, se puede dejar vacio):") || "";
  if (pie === null) return;
  var r = await pedir("/panel/fotos", { id: ID, pie: pie, forzar: yaSeEnviaron === true });
  if (r.ok) { avisar(r.aviso, r.enviadas > 0 ? "ok" : "info"); setTimeout(function(){ location.reload(); }, 1200); }
  else avisar(r.error, "mal");
}

async function empezarDeCero() {
  // ⚠️ \\n CON DOS BARRAS, Y NO ES UN DESCUIDO: ES EL ARREGLO DE UN DEFECTO
  //    QUE DEJO MUERTO EL PANEL ENTERO.
  //
  // Esto vive dentro de un TEMPLATE LITERAL de JavaScript, asi que \\n se
  // interpreta AL GENERAR el HTML y lo que salia a la pagina era un salto de
  // linea de verdad, en medio de una cadena entre comillas dobles:
  //
  //     if (!confirm("El bot volvera a tratar este chat como nuevo.
  //     <-- salto real
  //     NO se borra el historial...
  //
  // Eso es un SyntaxError. Y un SyntaxError no rompe una funcion: rompe EL
  // BLOQUE <script> COMPLETO. Ninguna de las funciones de la pagina llegaba
  // a existir, asi que TODOS los botones del chat no hacian nada:
  //
  //     Devolver al bot · Tomar el control · Marcar atendido ·
  //     Empezar de cero · Reenviar fotos · Responder · Cancelar pedido
  //
  // Marco lo reporto asi: "cuando le doy en devolver al bot se queda quieto
  // no hace nada... lo mismo que el boton de cancelar pedido tampoco". Y las
  // rutas del servidor estaban PERFECTAS -se comprobaron contra produccion
  // con curl y devuelven {"ok":true}-, lo que hace que el fallo sea
  // especialmente dificil de encontrar desde el lado del servidor: no hay
  // peticion, no hay log, no hay error. El panel simplemente no responde.
  //
  // Con \\n, al HTML llega el texto de dos caracteres \\n y el navegador lo
  // lee como el salto de linea que quiere el confirm().
  //
  // Lo vigila test/panel-javascript.test.js, que extrae el <script> de cada
  // pantalla y comprueba que PARSEA. No existia esa prueba: las que hay
  // comprueban que la ruta devuelve 200, y la pagina devolvia 200 con el
  // JavaScript roto dentro.
  if (!confirm("El bot volvera a tratar este chat como nuevo.\\n\\nNO se borra el historial ni los pedidos: solo la memoria del bot (que ya saludo, que ya dijo el precio, el escalado y la pausa).\\n\\n¿Seguimos?")) return;
  var r = await pedir("/panel/empezar-de-cero", { id: ID });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 700); }
  else avisar(r.error || "No se pudo.", "mal");
}

async function cancelar(codigo) {
  var motivo = prompt("Motivo de la cancelacion (queda en el historial):");
  if (motivo === null) return;
  var r = await pedir("/panel/pedido/cancelar", { codigo: codigo, motivo: motivo });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 600); }
  else avisar(r.error, "mal");
}

`)
  );
}

/** BUSCAR */
function buscar({ q = "", resultados = [] }) {
  const filas = resultados
    .map(
      (c) => `<tr>
  <td data-label="Cliente">${conEstado(fichaDe.nombreParaMostrar(c.ficha).hay ? fichaDe.leer(c.ficha, "nombre") : null)}</td>
  <td data-label="Telefono">${esc(fichaDe.leer(c.ficha, "telefono").valor || c.contactoId)}</td>
  <td data-label="Ciudad">${conEstado(fichaDe.leer(c.ficha, "ciudad"))}</td>
  <td data-label="Estado">${esc(c.estado)}</td>
  <td class="acciones" data-label="Acciones">
    <a class="boton primario" href="/panel/chat?id=${encodeURIComponent(c.contactoId)}">Abrir</a>
  </td>
</tr>`
    )
    .join("");

  return (
    cabecera({ titulo: "Buscar clientes", seccion: "buscar" }) +
    `<form method="get" action="/panel/buscar" style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
  <div style="flex:1 1 240px">
    <label for="q" style="font-size:13px;color:var(--suave)">Telefono, nombre o ciudad</label>
    <input id="q" name="q" value="${esc(q)}" autocomplete="off" autofocus>
  </div>
  <button class="primario" type="submit" style="align-self:flex-end">Buscar</button>
</form>` +
    (q
      ? resultados.length
        ? `<table><thead><tr><th>Cliente</th><th>Telefono</th><th>Ciudad</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${filas}</tbody></table>`
        : `<div class="vacio">Nada coincide con <b>${esc(q)}</b>.</div>`
      : `<div class="vacio">Escribe un telefono, un nombre o una ciudad.</div>`) +
    pie()
  );
}

/** VENTA MANUAL */
function ventaManual({ aviso = null, productos = [], valores = {} }) {
  return (
    cabecera({ titulo: "Venta manual" }) +
    (aviso ? `<div class="aviso ${esc(aviso.clase)}">${esc(aviso.texto)}</div>` : "") +
    `<div class="aviso info">
  Para ventas que se cerraron <b>fuera del bot</b> — por telefono, o en un chat que atendiste a mano.
  El pedido se crea con las mismas reglas que uno automatico: lleva clave de idempotencia, version e
  historial, y <b>no puede duplicar</b> uno que ya exista para el mismo cliente y producto.
</div>` +
    `<form method="post" action="/panel/venta-manual" style="display:grid;gap:12px;max-width:560px">
  <div>
    <label for="contactoId">Telefono del cliente (como lo ve WhatsApp)</label>
    <input id="contactoId" name="contactoId" required value="${esc(valores.contactoId || "")}"
           placeholder="573001112233" inputmode="numeric">
  </div>
  <div>
    <label for="nombre">Nombre</label>
    <input id="nombre" name="nombre" required value="${esc(valores.nombre || "")}">
  </div>
  <div>
    <label for="productoId">Producto</label>
    <select id="productoId" name="productoId" required>
      <option value="">— elige —</option>
      ${productos
        .map(
          (p) =>
            `<option value="${esc(p.id)}" ${valores.productoId === p.id ? "selected" : ""}>${esc(p.nombre)} (${esc(p.id)})</option>`
        )
        .join("")}
    </select>
    ${
      productos.length
        ? ""
        : `<p style="color:var(--ambar);font-size:13px">No hay productos activos en el catalogo. Sin producto no se puede cotizar, y el panel no inventa precios.</p>`
    }
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
    <div>
      <label for="cantidad">Cantidad</label>
      <input id="cantidad" name="cantidad" type="number" min="1" value="${esc(valores.cantidad || 1)}">
    </div>
    <div>
      <label for="ciudad">Ciudad</label>
      <input id="ciudad" name="ciudad" required value="${esc(valores.ciudad || "")}">
    </div>
  </div>
  <div>
    <label for="departamento">Departamento</label>
    <input id="departamento" name="departamento" required value="${esc(valores.departamento || "")}">
  </div>
  <div>
    <label for="direccion">Direccion</label>
    <input id="direccion" name="direccion" required value="${esc(valores.direccion || "")}">
  </div>
  <div>
    <label for="nota">Por que se registra a mano (queda en el historial)</label>
    <input id="nota" name="nota" placeholder="cerrada por telefono" value="${esc(valores.nota || "")}">
  </div>
  <button class="primario" type="submit" ${productos.length ? "" : "disabled"}>Registrar la venta</button>
</form>` +
    pie()
  );
}

/** Aviso para una parte de una pantalla que SI funciona a medias. */
function bloqueParcial({ titulo, texto, comoSeDesbloquea = "" }) {
  return `<div style="background:#1a2435;border:1px solid #2b3f5c;border-radius:12px;padding:14px;margin:16px 0">
  <b style="color:#b8cdf0">${titulo}</b>
  <p style="margin:6px 0 0;font-size:14px;color:var(--suave)">${texto}</p>
  ${comoSeDesbloquea ? `<p style="margin:8px 0 0;font-size:13px;color:var(--suave)">${comoSeDesbloquea}</p>` : ""}
</div>`;
}

/** GUIAS Y DESPACHOS */
function guias({ datos: d, transportadoras = [], aviso = null, envioManualActivo = false }) {
  const filaPorDespachar = (p) => {
    const listo = p._listo;
    return `<tr>
  <td data-label="Codigo">${esc(p.id)}</td>
  <td data-label="Cliente">${esc((p.destinatario && p.destinatario.nombre) || "")}</td>
  <td data-label="Ciudad">${esc((p.destinatario && p.destinatario.ciudad) || "")}</td>
  <td data-label="Total">${esc(pesos((p.cotizacion && p.cotizacion.total) || 0))}</td>
  <td data-label="Estado">${
    listo && listo.ok
      ? `<span class="pastilla atendida">listo</span>`
      : `<span class="pastilla urgente">${esc((listo && listo.motivo) || "no listo")}</span>`
  }</td>
  <td class="acciones" data-label="Guia">
    ${
      listo && listo.ok
        ? `<input id="g-${esc(p.id)}" placeholder="numero de guia" style="max-width:190px" autocomplete="off">
           <select id="t-${esc(p.id)}" style="max-width:170px">
             ${transportadoras.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}
           </select>
           <button class="primario" onclick="despachar('${esc(p.id)}')">Despachar</button>`
        : `<span style="font-size:13px;color:var(--suave)">hay que completar los datos antes</span>`
    }
  </td>
</tr>`;
  };

  const filaDespachado = (p) => {
    const abiertas = (p.novedades || []).filter((n) => !n.resueltaEn);
    return `<tr>
  <td data-label="Codigo">${esc(p.id)}</td>
  <td data-label="Cliente">${esc((p.destinatario && p.destinatario.nombre) || "")}</td>
  <td data-label="Guia">${esc((p.despacho && p.despacho.guia) || "")}</td>
  <td data-label="Transportadora">${esc((p.despacho && p.despacho.transportadora) || "—")}</td>
  <td data-label="Despachado">${esc(fecha.fechaYHoraBogota(p.despacho && p.despacho.despachadoEn))}</td>
  <td data-label="Novedades">${
    abiertas.length
      ? abiertas.map((n) => `<span class="pastilla urgente">${esc(n.tipo)}</span>`).join(" ")
      : `<span class="pastilla atendida">sin novedad</span>`
  }</td>
  <td class="acciones" data-label="Entrega">
    <button class="primario" onclick="entregar('${esc(p.id)}')">Marcar entregado</button>
  </td>
</tr>`;
  };

  // Los ya entregados se listan aparte y SIN boton: lo que se cobro no se
  // vuelve a cobrar, y un boton ahi solo sirve para equivocarse.
  const filaEntregado = (p) => `<tr>
  <td data-label="Codigo">${esc(p.id)}</td>
  <td data-label="Cliente">${esc((p.destinatario && p.destinatario.nombre) || "")}</td>
  <td data-label="Guia">${esc((p.despacho && p.despacho.guia) || "")}</td>
  <td data-label="Entregado">${esc(fecha.fechaYHoraBogota(p.entrega && p.entrega.entregadoEn))}</td>
  <td data-label="Recaudado">${esc(pesos((p.entrega && p.entrega.importeRecaudado) || 0))}</td>
</tr>`;

  return (
    cabecera({ titulo: "Guías y despachos", seccion: "guias" }) +
    (aviso ? `<div class="aviso ${esc(aviso.clase)}">${esc(aviso.texto)}</div>` : "") +
    `<div class="kpis">
  <div class="kpi"><b>${d.porDespachar.length}</b><span>por despachar</span></div>
  <div class="kpi"><b>${d.despachados.length}</b><span>en la calle</span></div>
  <div class="kpi"><b>${(d.entregados || []).length}</b><span>entregados</span></div>
  <div class="kpi"><b>${d.conNovedad.length}</b><span>con novedad abierta</span></div>
</div>` +
    `<h2 style="font-size:16px;margin:20px 0 10px">Por despachar</h2>` +
    (d.porDespachar.length
      ? `<table><thead><tr><th>Codigo</th><th>Cliente</th><th>Ciudad</th><th>Total</th><th>Estado</th><th>Guía</th></tr></thead>
<tbody>${d.porDespachar.map(filaPorDespachar).join("")}</tbody></table>`
      : `<div class="vacio">Nada pendiente de despachar.</div>`) +
    `<h2 style="font-size:16px;margin:24px 0 10px">En la calle</h2>` +
    (d.despachados.length
      ? `<table><thead><tr><th>Codigo</th><th>Cliente</th><th>Guía</th><th>Transportadora</th><th>Despachado</th><th>Novedades</th><th>Entrega</th></tr></thead>
<tbody>${d.despachados.map(filaDespachado).join("")}</tbody></table>
<p style="font-size:13px;color:var(--suave);margin-top:8px">
  Esto es <b>contraentrega</b>: hasta que no se marque entregado, ese importe no entró en la caja.
  Es lo que separa <i>facturado</i> de <i>recaudado</i> en <a href="/panel/indicadores">Indicadores</a>.
</p>`
      : `<div class="vacio">Todavía no hay despachos.</div>`) +
    `<h2 style="font-size:16px;margin:24px 0 10px">Entregados</h2>` +
    ((d.entregados || []).length
      ? `<table><thead><tr><th>Codigo</th><th>Cliente</th><th>Guía</th><th>Entregado</th><th>Recaudado</th></tr></thead>
<tbody>${d.entregados.map(filaEntregado).join("")}</tbody></table>`
      : `<div class="vacio">Ninguna entrega registrada todavía.</div>`) +
    // ----------------------------------------------------------------------
    // EL LOTE DE GUIAS, EN TRES PASOS
    //
    // Revisar -> asignar lo que no cruzo -> enviar. El paso del medio es el
    // que da el valor: es donde se ve que una guia quedo sin parear y se
    // arregla, en vez de descubrirlo cuando el cliente reclama.
    // ----------------------------------------------------------------------
    `<h2 style="font-size:16px;margin:28px 0 10px">Lote de guías (PDF de la transportadora)</h2>
<div style="background:var(--tarjeta);border:1px solid var(--linea);border-radius:12px;padding:14px">
  <p style="margin:0 0 10px;font-size:14px;color:var(--suave)">
    Sube el PDF con todas las etiquetas. Se parte en una hoja por guía y se propone a qué cliente
    corresponde cada una. <b>Revisar no envía nada</b>: primero lo ves, después decides.
  </p>
  ${
    envioManualActivo
      ? ""
      : `<p class="aviso info" style="margin:0 0 10px">
           Los envíos manuales están <b>apagados</b> (<code>PANEL_ENVIO_MANUAL=0</code>). Puedes subir el PDF y
           revisar el pareo igual; al enviar, cada guía dirá que la frenó el interruptor en vez de salir.
         </p>`
  }
  <div class="acciones">
    <input type="file" id="pdfGuias" accept="application/pdf,.pdf">
    <button class="primario" id="btnRevisarPdf" onclick="revisarPdf()">Revisar el PDF (no envía nada)</button>
  </div>
  <p style="margin:10px 0 0;font-size:13px;color:var(--suave)">
    Las etiquetas <b>no salen del servidor</b>: el navegador recibe solo lo que se leyó de cada una.
    Cada hoja lleva el nombre, la dirección y el teléfono de un cliente impresos.
  </p>
</div>
<div id="zonaPareo" hidden style="margin-top:16px"></div>
<div id="zonaReporte" hidden style="margin-top:16px"></div>` +
    pie(`
async function despachar(codigo) {
  var guia = (document.getElementById("g-" + codigo) || {}).value || "";
  var transportadora = (document.getElementById("t-" + codigo) || {}).value || "";
  if (!guia.trim()) { avisar("Falta el número de guía: sin él el pedido no se puede rastrear.", "mal"); return; }
  var r = await pedir("/panel/guias/despachar", { codigo: codigo, guia: guia, transportadora: transportadora });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 700); }
  else avisar(r.error, "mal");
}
async function entregar(codigo) {
  var r = await pedir("/panel/guias/entregar", { codigo: codigo });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 700); }
  else avisar(r.error, "mal");
}

// ---------------------------------------------------------------------------
// EL LOTE DE GUIAS
//
// OJO: este codigo vive dentro de una plantilla de JavaScript del servidor,
// asi que NO se pueden usar acentos graves ni la interpolacion con dolar y
// llave, ni siquiera en un comentario. Todo con concatenacion. En BIKERPRO
// eso rompio el panel dos veces con un SyntaxError.
// ---------------------------------------------------------------------------
var PLAN_GUIAS = null;
var CANDIDATOS = [];

function claseDeCerteza(n) {
  if (n >= 90) return "atendida";
  if (n >= 70) return "pendiente";
  return "urgente";
}

async function revisarPdf() {
  var entrada = document.getElementById("pdfGuias");
  var archivo = entrada && entrada.files && entrada.files[0];
  if (!archivo) { avisar("Elige primero el PDF de la transportadora.", "mal"); return; }

  var boton = document.getElementById("btnRevisarPdf");
  boton.disabled = true;
  boton.textContent = "Leyendo el PDF...";
  avisar("Leyendo el PDF. No se envía nada todavía.", "info");

  var r;
  try {
    // El PDF va como CUERPO CRUDO. No se usa FormData: en BIKERPRO llegaba
    // vacio a Express, y en Safari de iOS el fetch con FormData falla con
    // "The string did not match the expected pattern".
    var resp = await fetch("/panel/guias/revisar", {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: archivo
    });
    var texto = await resp.text();
    try { r = JSON.parse(texto); } catch (e) { r = null; }
    // Se mira el ESTADO antes de interpretar el cuerpo: un 401 devuelve
    // texto, y hacer JSON.parse a ciegas muestra un error que manda a buscar
    // el problema donde no esta.
    if (!resp.ok) {
      r = { ok: false, error: (r && r.error) || ("Error " + resp.status + ": " + texto.slice(0, 160)) };
    }
  } catch (e) {
    r = { ok: false, error: "Sin conexión. No se subió nada." };
  }

  boton.disabled = false;
  boton.textContent = "Revisar el PDF (no envía nada)";

  if (!r || !r.ok) { avisar((r && r.error) || "No se pudo leer el PDF.", "mal"); return; }

  PLAN_GUIAS = r.id;
  CANDIDATOS = r.candidatos || [];
  pintarPareo(r);
  var listas = r.filas.filter(function (f) { return f.enviar; }).length;
  avisar("Leídas " + r.filas.length + " hojas. " + listas + " cruzan solas. Nada se ha enviado.", listas ? "ok" : "info");
}

function opcionesDeCandidatos(sel) {
  var out = '<option value="">— elegir el pedido —</option>';
  for (var i = 0; i < CANDIDATOS.length; i++) {
    var c = CANDIDATOS[i];
    var etiqueta = (c.nombre || "sin nombre") + " · " + (c.ciudad || "?") +
      (c.cel4 ? " · ..." + c.cel4 : "") + (c.guia ? " · YA TIENE GUIA" : "");
    out += '<option value="' + c.codigo + '"' + (sel === c.codigo ? " selected" : "") + ">" +
      etiqueta.replace(/</g, "&lt;") + "</option>";
  }
  return out;
}

function pintarPareo(r) {
  var zona = document.getElementById("zonaPareo");
  var filas = "";

  for (var i = 0; i < r.filas.length; i++) {
    var f = r.filas[i];
    var dice = [];
    if (f.etiqueta.nombre) dice.push(f.etiqueta.nombre);
    if (f.etiqueta.ciudad) dice.push(f.etiqueta.ciudad);
    if (f.etiqueta.telefonos && f.etiqueta.telefonos.length) dice.push(f.etiqueta.telefonos.join(", "));

    var corresponde = f.pedido
      ? "<b>" + (f.pedido.nombre || f.pedido.codigo) + "</b><br><span style='font-size:12px;color:var(--suave)'>" +
        (f.pedido.ciudad || "") + "</span>"
      : "<span style='font-size:13px;color:var(--suave)'>" + (f.motivo || "sin pareo") + "</span>";

    if (f.asignable) {
      corresponde += "<div style='margin-top:8px'><select id='asig-" + f.pagina + "' style='max-width:260px'>" +
        opcionesDeCandidatos("") + "</select> " +
        "<button onclick='asignar(" + f.pagina + ")' style='min-height:40px;padding:0 10px;font-size:13px'>Asignar</button></div>";
    }

    filas += "<tr id='fila-" + f.pagina + "'>" +
      "<td data-label='Marcar'>" +
        (f.enviar ? "<input type='checkbox' class='marcaGuia' value='" + f.pagina + "' checked>" : "") +
      "</td>" +
      "<td data-label='Pág'>" + f.pagina + "</td>" +
      "<td data-label='Guía'>" + (f.guia || "—") + (f.transportadora ? "<div class='sub'>" + f.transportadora + "</div>" : "") + "</td>" +
      "<td data-label='Dice la etiqueta'>" + (dice.join("<br>") || "—") + "</td>" +
      "<td data-label='Le corresponde a'>" + corresponde + "</td>" +
      "<td data-label='Certeza'>" +
        (f.pedido
          ? "<span class='pastilla " + claseDeCerteza(f.certeza) + "'>" + f.certeza + "</span>" +
            "<div class='sub'>" + (f.senales || []).join(", ") + "</div>"
          : "—") +
      "</td>" +
    "</tr>";
  }

  zona.hidden = false;
  zona.innerHTML =
    "<h2 style='font-size:16px;margin:0 0 10px'>Revisión del lote</h2>" +
    (r.aviso ? "<div class='aviso info'>" + r.aviso + "</div>" : "") +
    "<table><thead><tr><th>Marcar</th><th>Pág</th><th>Guía</th><th>Dice la etiqueta</th>" +
    "<th>Le corresponde a</th><th>Certeza</th></tr></thead><tbody>" + filas + "</tbody></table>" +
    "<div class='acciones' style='margin-top:12px'>" +
    "<button class='primario' id='btnEnviarGuias' onclick='enviarGuias()'>Enviar las guías marcadas</button>" +
    "<button onclick='marcarTodasLasGuias(false)'>Desmarcar todas</button>" +
    "</div>" +
    "<p style='font-size:13px;color:var(--suave);margin-top:8px'>" +
    "Una guía por debajo de 50 puntos, o empatada entre dos personas distintas, <b>no se envía sola</b>: " +
    "la etiqueta lleva la dirección y el teléfono del cliente, y mandársela a otro es filtrar datos personales." +
    "</p>";
}

function marcarTodasLasGuias(valor) {
  var cajas = document.querySelectorAll(".marcaGuia");
  for (var i = 0; i < cajas.length; i++) cajas[i].checked = valor;
}

async function asignar(pagina) {
  var sel = document.getElementById("asig-" + pagina);
  var codigo = sel && sel.value;
  if (!codigo) { avisar("Elige a qué pedido corresponde esa hoja.", "mal"); return; }

  var r = await pedir("/panel/guias/asignar", { id: PLAN_GUIAS, pagina: pagina, codigo: codigo });
  if (!r.ok) { avisar(r.error, "mal"); return; }

  avisar(r.aviso, "ok");
  var fila = document.getElementById("fila-" + pagina);
  if (fila) {
    var celdas = fila.getElementsByTagName("td");
    celdas[0].innerHTML = "<input type='checkbox' class='marcaGuia' value='" + pagina + "' checked>";
    celdas[4].innerHTML = "<b>" + (r.pedido.nombre || r.pedido.codigo) + "</b>" +
      "<div class='sub'>asignada a mano</div>";
  }
}

async function enviarGuias() {
  var cajas = document.querySelectorAll(".marcaGuia:checked");
  var paginas = [];
  for (var i = 0; i < cajas.length; i++) paginas.push(Number(cajas[i].value));
  if (!paginas.length) { avisar("No marcaste ninguna guía.", "mal"); return; }

  var boton = document.getElementById("btnEnviarGuias");
  boton.disabled = true;
  boton.textContent = "Enviando " + paginas.length + "...";

  var r = await pedir("/panel/guias/enviar", { id: PLAN_GUIAS, paginas: paginas });

  boton.disabled = false;
  boton.textContent = "Enviar las guías marcadas";

  if (!r.ok) { avisar(r.error, "mal"); return; }
  pintarReporteDeGuias(r);
  avisar(r.aviso, r.fallaron ? "mal" : "ok");
}

function pintarReporteDeGuias(r) {
  var zona = document.getElementById("zonaReporte");
  var filas = "";
  for (var i = 0; i < r.resultados.length; i++) {
    var x = r.resultados[i];
    filas += "<tr>" +
      "<td data-label='Guía'>" + (x.guia || "—") + "</td>" +
      "<td data-label='Cliente'>" + (x.cliente || "—") + "</td>" +
      "<td data-label='Estado'>" +
        (x.enviado
          ? "<span class='pastilla atendida'>" + (x.porPlantilla ? "aceptado por Meta (plantilla)" : "aceptado por Meta") + "</span>"
          : "<span class='pastilla urgente'>no salió</span><div class='sub'>" + (x.porQue || "") + "</div>") +
      "</td>" +
    "</tr>";
  }

  zona.hidden = false;
  zona.innerHTML =
    "<h2 style='font-size:16px;margin:0 0 10px'>Resultado del envío</h2>" +
    "<table><thead><tr><th>Guía</th><th>Cliente</th><th>Estado</th></tr></thead><tbody>" + filas + "</tbody></table>" +
    "<p style='font-size:13px;color:var(--suave);margin-top:8px'>" +
    "<b>Aceptado por Meta no es entregado.</b> Meta puede aceptar un mensaje y no entregarlo; la entrega real " +
    "se confirma con el acuse del webhook." +
    (r.planVivo
      ? " Las que no salieron siguen marcadas: puedes reintentar sin volver a subir el PDF."
      : "") +
    "</p>";
}
`)
  );
}

/** NOVEDADES DE ENTREGA */
function novedades({
  datos: d,
  tipos = [],
  envioManualActivo = false,
  aviso = null,
  faltanPlantillas = [],
}) {
  const fila = (p) => {
    const abiertas = (p.novedades || []).filter((n) => !n.resueltaEn);
    return `<tr>
  <td data-label="Codigo">${esc(p.id)}</td>
  <td data-label="Cliente">${esc((p.destinatario && p.destinatario.nombre) || "")}</td>
  <td data-label="Guia">${esc((p.despacho && p.despacho.guia) || "")}</td>
  <td data-label="Dias">${esc(String(p._dias === null || p._dias === undefined ? "—" : p._dias))}</td>
  <td data-label="Abiertas">${
    abiertas.length
      ? abiertas
          .map(
            (n) =>
              `<span class="pastilla urgente">${esc(n.tipo)}</span>
               <button onclick="resolver('${esc(p.id)}','${esc(n.id)}')" style="min-height:36px;padding:0 10px;font-size:13px">Resolver</button>`
          )
          .join(" ")
      : `<span class="pastilla atendida">ninguna</span>`
  }</td>
  <td class="acciones" data-label="Registrar">
    <select id="n-${esc(p.id)}" style="max-width:160px">
      ${tipos.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}
    </select>
    <button onclick="registrar('${esc(p.id)}')">Registrar</button>
  </td>
</tr>`;
  };

  return (
    cabecera({ titulo: "Novedades de entrega", seccion: "novedades" }) +
    (aviso ? `<div class="aviso ${esc(aviso.clase)}">${esc(aviso.texto)}</div>` : "") +
    `<div class="kpis">
  <div class="kpi"><b>${d.conNovedad.length}</b><span>con novedad abierta</span></div>
  ${Object.entries(d.porTipo)
    .map(([t, n]) => `<div class="kpi"><b>${n}</b><span>${esc(t)}</span></div>`)
    .join("")}
</div>` +
    (d.despachados.length
      ? `<table><thead><tr><th>Codigo</th><th>Cliente</th><th>Guía</th><th>Días</th><th>Abiertas</th><th>Registrar</th></tr></thead>
<tbody>${d.despachados.map(fila).join("")}</tbody></table>`
      : `<div class="vacio">No hay pedidos despachados todavía. Una novedad solo existe sobre un paquete que salió.</div>`) +
    // ----------------------------------------------------------------------
    // AVISAR A LOS CLIENTES, DESDE EL ARCHIVO DE LA TRANSPORTADORA
    //
    // Se puede subir el archivo O pegar el texto. Pegar funciona hoy, sin
    // depender de que la transportadora exporte nada ni de que su formato
    // sea el que esperamos.
    // ----------------------------------------------------------------------
    `<h2 style="font-size:16px;margin:28px 0 10px">Avisar a los clientes</h2>
<div style="background:var(--tarjeta);border:1px solid var(--linea);border-radius:12px;padding:14px">
  ${
    faltanPlantillas.length
      ? `<p class="aviso mal" style="margin:0 0 10px">
           Faltan plantillas aprobadas en Meta: ${faltanPlantillas.map((t) => `<code>${esc(t)}</code>`).join(", ")}.
           Una novedad llega días después del pedido, cuando la ventana de 24&nbsp;h ya se cerró, y fuera de ella
           Meta <b>solo entrega plantillas</b>. A los clientes que sí tengan la ventana abierta se les puede
           escribir igual; al resto, su fila dirá que está bloqueada en vez de fingir el envío.
         </p>`
      : `<p class="aviso ok" style="margin:0 0 10px">Las tres plantillas de novedad están configuradas.</p>`
  }
  ${
    envioManualActivo
      ? ""
      : `<p class="aviso info" style="margin:0 0 10px">
           Los envíos manuales están <b>apagados</b> (<code>PANEL_ENVIO_MANUAL=0</code>). Puedes revisar el plan
           completo; al avisar, cada fila dirá que la frenó el interruptor.
         </p>`
  }
  <p style="margin:0 0 10px;font-size:14px;color:var(--suave)">
    Sube el reporte de novedades de la transportadora (CSV o XLSX), o pega lo que ves en su pantalla.
    <b>Revisar no envía nada.</b>
  </p>
  <div class="acciones">
    <input type="file" id="archivoNovedades" accept=".csv,.xlsx,text/csv">
    <button onclick="subirNovedades()">Leer el archivo</button>
  </div>
  <textarea id="textoNovedades" rows="6" placeholder="O pega aquí las novedades, una por línea. Cada línea necesita el número de guía y el motivo."
    style="width:100%;margin-top:10px"></textarea>
  <div class="acciones" style="margin-top:8px">
    <button class="primario" id="btnRevisarNovedades" onclick="revisarNovedades()">Revisar (no envía nada)</button>
  </div>
</div>
<div id="zonaNovedades" hidden style="margin-top:16px"></div>
<div id="zonaReporteNovedades" hidden style="margin-top:16px"></div>` +
    pie(`
async function registrar(codigo) {
  var tipo = (document.getElementById("n-" + codigo) || {}).value || "";
  var detalle = prompt("Detalle de la novedad (lo que reportó la transportadora):") || "";
  var r = await pedir("/panel/novedades/registrar", { codigo: codigo, tipo: tipo, detalle: detalle });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 700); }
  else avisar(r.error, "mal");
}
async function resolver(codigo, id) {
  var como = prompt("¿Cómo se resolvió?") || "";
  var r = await pedir("/panel/novedades/resolver", { codigo: codigo, id: id, comoSeResolvio: como });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 700); }
  else avisar(r.error, "mal");
}

// ---------------------------------------------------------------------------
// AVISAR A LOS CLIENTES
//
// Sin acentos graves ni interpolacion: esto vive dentro de una plantilla del
// servidor. Ver el aviso en la pantalla de guias.
// ---------------------------------------------------------------------------
var PLAN_NOVEDADES = null;

async function subirNovedades() {
  var entrada = document.getElementById("archivoNovedades");
  var archivo = entrada && entrada.files && entrada.files[0];
  if (!archivo) { avisar("Elige primero el archivo de la transportadora.", "mal"); return; }

  var r;
  try {
    var resp = await fetch("/panel/novedades/archivo?nombre=" + encodeURIComponent(archivo.name), {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: archivo
    });
    var texto = await resp.text();
    try { r = JSON.parse(texto); } catch (e) { r = null; }
    if (!resp.ok) r = { ok: false, error: (r && r.error) || ("Error " + resp.status + ": " + texto.slice(0, 160)) };
  } catch (e) {
    r = { ok: false, error: "Sin conexión. No se subió nada." };
  }

  if (!r || !r.ok) { avisar((r && r.error) || "No se pudo leer el archivo.", "mal"); return; }

  document.getElementById("textoNovedades").value = r.texto;
  avisar("Leídas " + r.cuantas + " filas del " + r.formato + "." + (r.aviso ? " " + r.aviso : "") +
    " Revisa antes de avisar a nadie.", r.aviso ? "info" : "ok");
}

async function revisarNovedades() {
  var texto = (document.getElementById("textoNovedades") || {}).value || "";
  if (!texto.trim()) { avisar("No hay nada que revisar: pega el texto o sube el archivo.", "mal"); return; }

  var boton = document.getElementById("btnRevisarNovedades");
  boton.disabled = true;
  boton.textContent = "Revisando...";

  var r = await pedir("/panel/novedades/revisar", { texto: texto, datos: datosEscritosAMano() });

  boton.disabled = false;
  boton.textContent = "Revisar (no envía nada)";

  if (!r.ok) { avisar(r.error, "mal"); return; }

  PLAN_NOVEDADES = r.id;
  pintarNovedades(r);
  avisar(r.listas + " listas para avisar, " + r.bloqueadas + " bloqueadas. Nada se ha enviado.",
    r.listas ? "ok" : "info");
}

// Lo escrito a mano se recoge de la pantalla y VIAJA SIEMPRE, tambien en el
// segundo envio. En BIKERPRO las filas ya resueltas dejaban de dibujar sus
// campos, esos datos no viajaban, y las filas volvian a bloquearse pidiendo
// lo que ya se habia escrito.
function datosEscritosAMano() {
  var out = {};
  var campos = document.querySelectorAll("[data-guia]");
  for (var i = 0; i < campos.length; i++) {
    var c = campos[i];
    var g = c.getAttribute("data-guia");
    var campo = c.getAttribute("data-campo");
    if (!c.value) continue;
    if (!out[g]) out[g] = {};
    out[g][campo] = c.value;
  }
  return out;
}

function pintarNovedades(r) {
  var zona = document.getElementById("zonaNovedades");
  var filas = "";

  for (var i = 0; i < r.filas.length; i++) {
    var f = r.filas[i];

    var quien = f.cliente
      ? "<b>" + f.cliente + "</b>" +
        (f.comoSeEncontro && f.comoSeEncontro !== "por la guia"
          ? "<div class='sub'>" + f.comoSeEncontro + "</div>"
          : "")
      : "<span style='font-size:13px;color:var(--suave)'>no identificado</span>";

    if (f.requiereConfirmacion) {
      quien += "<div class='sub'><b>Confírmalo antes de enviar:</b> cruzó por nombre, no por la guía.</div>";
    }

    var canal = f.bloqueada
      ? "<span class='pastilla urgente'>bloqueada</span><div class='sub'>" + f.bloqueada + "</div>"
      : (f.porPlantilla
          ? "<span class='pastilla pendiente'>plantilla</span><div class='sub'>" + f.plantilla + "</div>"
          : "<span class='pastilla atendida'>texto libre</span><div class='sub'>ventana abierta" +
            (f.ventana && f.ventana.restante ? ", quedan " + f.ventana.restante : "") + "</div>");

    // Los campos que la plantilla de oficina necesita. Se dibujan SIEMPRE que
    // el tipo los pida, tambien en las filas ya listas, para que lo escrito
    // sobreviva a un segundo envio.
    var pide = "";
    if (f.tipoClave === "oficina") {
      pide =
        "<div style='margin-top:6px'>" +
        "<input data-guia='" + f.guia + "' data-campo='oficina' placeholder='oficina' value='" +
          (f.oficina || "").replace(/'/g, "&#39;") + "' style='max-width:170px'> " +
        "<input data-guia='" + f.guia + "' data-campo='plazo' placeholder='hasta cuándo' value='" +
          (f.plazo || "").replace(/'/g, "&#39;") + "' style='max-width:150px'>" +
        "</div>";
    }

    var queVeElCliente = f.mensaje
      ? "<details><summary style='cursor:pointer;font-size:13px;color:var(--suave)'>ver el mensaje</summary>" +
        "<div style='white-space:pre-wrap;font-size:13px;margin-top:6px'>" +
        f.mensaje.replace(/</g, "&lt;") + "</div></details>"
      : (f.porPlantilla
          ? "<div class='sub'>lo arma Meta con la plantilla aprobada" +
            (f.variables && f.variables.length ? " (" + f.variables.join(" · ") + ")" : "") + "</div>"
          : "");

    filas += "<tr>" +
      "<td data-label='Marcar'>" +
        (f.enviar ? "<input type='checkbox' class='marcaNov' value='" + f.i + "' checked>" : "") +
      "</td>" +
      "<td data-label='Guía'>" + (f.guia || "—") + "</td>" +
      "<td data-label='Novedad'>" + f.tipo + "<div class='sub'>" + (f.motivo || "").replace(/</g, "&lt;") + "</div>" + pide + "</td>" +
      "<td data-label='Cliente'>" + quien + "</td>" +
      "<td data-label='Cómo sale'>" + canal + "</td>" +
      "<td data-label='Mensaje'>" + queVeElCliente + "</td>" +
    "</tr>";
  }

  zona.hidden = false;
  zona.innerHTML =
    "<h2 style='font-size:16px;margin:0 0 10px'>Revisión de las novedades</h2>" +
    (r.plantillasQueFaltan && r.plantillasQueFaltan.length
      ? "<div class='aviso mal'>Hay filas que no pueden salir porque falta su plantilla en Meta: " +
        r.plantillasQueFaltan.join(", ") + "</div>"
      : "") +
    "<table><thead><tr><th>Marcar</th><th>Guía</th><th>Novedad</th><th>Cliente</th>" +
    "<th>Cómo sale</th><th>Mensaje</th></tr></thead><tbody>" + filas + "</tbody></table>" +
    "<div class='acciones' style='margin-top:12px'>" +
    "<button class='primario' id='btnAvisar' onclick='avisarNovedades()'>Avisar a los marcados</button>" +
    "<button onclick='revisarNovedades()'>Volver a revisar con lo que escribí</button>" +
    "</div>" +
    "<p style='font-size:13px;color:var(--suave);margin-top:8px'>" +
    "Si escribiste una oficina o un plazo, pulsa <b>volver a revisar</b> para que esa fila se desbloquee." +
    "</p>";
}

async function avisarNovedades() {
  var cajas = document.querySelectorAll(".marcaNov:checked");
  var indices = [];
  for (var i = 0; i < cajas.length; i++) indices.push(Number(cajas[i].value));
  if (!indices.length) { avisar("No marcaste ninguna novedad.", "mal"); return; }

  var boton = document.getElementById("btnAvisar");
  boton.disabled = true;
  boton.textContent = "Avisando a " + indices.length + "...";

  var r = await pedir("/panel/novedades/avisar", {
    id: PLAN_NOVEDADES,
    indices: indices,
    datos: datosEscritosAMano()
  });

  boton.disabled = false;
  boton.textContent = "Avisar a los marcados";

  if (!r.ok) { avisar(r.error, "mal"); return; }

  var zona = document.getElementById("zonaReporteNovedades");
  var filas = "";
  for (var j = 0; j < r.resultados.length; j++) {
    var x = r.resultados[j];
    filas += "<tr>" +
      "<td data-label='Guía'>" + (x.guia || "—") + "</td>" +
      "<td data-label='Cliente'>" + (x.cliente || "—") + "</td>" +
      "<td data-label='Estado'>" +
        (x.enviado
          ? "<span class='pastilla atendida'>" + (x.porPlantilla ? "aceptado por Meta (plantilla)" : "aceptado por Meta") + "</span>"
          : "<span class='pastilla urgente'>no salió</span><div class='sub'>" + (x.porQue || "") + "</div>") +
      "</td>" +
    "</tr>";
  }

  zona.hidden = false;
  zona.innerHTML =
    "<h2 style='font-size:16px;margin:0 0 10px'>Resultado</h2>" +
    "<table><thead><tr><th>Guía</th><th>Cliente</th><th>Estado</th></tr></thead><tbody>" + filas + "</tbody></table>" +
    "<p style='font-size:13px;color:var(--suave);margin-top:8px'>" +
    "<b>Aceptado por Meta no es entregado.</b> La novedad queda registrada en el pedido con el resultado real " +
    "del intento, salga o no." +
    "</p>";
  avisar(r.aviso, r.fallaron ? "mal" : "ok");
}
`)
  );
}

/** AUDITORIA: dias, embudo y atribucion */
function auditoria({ serie = [], embudo: emb, atribucion: atr, dias = 14 }) {
  const filasSerie = serie
    .map(
      (d) => `<tr>
  <td data-label="Dia">${esc(d.dia)}</td>
  <td data-label="Pedidos">${d.pedidos}</td>
  <td data-label="Unidades">${d.unidades}</td>
  <td data-label="Importe">${esc(pesos(d.importe))}</td>
  <td data-label="Cancelados">${d.cancelados}</td>
</tr>`
    )
    .join("");

  const filasEmbudo = emb.filas
    .map(
      (f) => `<tr>
  <td data-label="Etapa">${esc(f.etiqueta)}</td>
  <td data-label="Llegaron">${f.cuantos}</td>
  <td data-label="Del total">${f.conversionDesdeArriba === null ? "—" : esc(f.conversionDesdeArriba) + "%"}</td>
  <td data-label="Del paso">${f.conversionDelPaso === null ? "—" : esc(f.conversionDelPaso) + "%"}</td>
  <td data-label="Se cayeron">${f.perdidosEnElPaso}</td>
  <td data-label="Se quedaron aqui">${f.seQuedaronAqui}</td>
</tr>`
    )
    .join("");

  const filasAtr = atr.filas
    .map(
      (f) => `<tr>
  <td data-label="Origen">${esc(f.fuente)}</td>
  <td data-label="Conversaciones">${f.conversaciones}</td>
  <td data-label="Pedidos">${f.pedidos}</td>
  <td data-label="Conversion">${f.conversion === null ? "—" : esc(f.conversion) + "%"}</td>
  <td data-label="Unidades">${f.unidades}</td>
  <td data-label="Importe">${esc(pesos(f.importe))}</td>
  <td data-label="Ticket medio">${f.ticketMedio === null ? "—" : esc(pesos(f.ticketMedio))}</td>
  <td data-label="Cancelados">${f.cancelados}</td>
</tr>`
    )
    .join("");

  return (
    cabecera({ titulo: `Auditoría · últimos ${dias} días`, seccion: "auditoria" }) +
    `<h2 style="font-size:16px;margin:0 0 10px">Por día</h2>` +
    (serie.some((d) => d.pedidos > 0)
      ? `<table><thead><tr><th>Día</th><th>Pedidos</th><th>Unidades</th><th>Importe</th><th>Cancelados</th></tr></thead><tbody>${filasSerie}</tbody></table>`
      : `<div class="vacio">Sin pedidos en los últimos ${dias} días.</div>`) +
    `<h2 style="font-size:16px;margin:24px 0 10px">Embudo</h2>` +
    (emb.hayDatos
      ? `<table><thead><tr><th>Etapa</th><th>Llegaron</th><th>Del total</th><th>Del paso</th><th>Se cayeron</th><th>Se quedaron aquí</th></tr></thead><tbody>${filasEmbudo}</tbody></table>
<p style="font-size:13px;color:var(--suave);margin-top:8px">
  Las etapas son acumulativas: quien confirmó también cuenta en "recibió cotización".
  <b>Del paso</b> es sobre la etapa anterior — es la columna que dice dónde arreglar algo.
</p>`
      : `<div class="vacio">Sin conversaciones todavía.</div>`) +
    `<h2 style="font-size:16px;margin:24px 0 10px">Atribución</h2>` +
    (atr.hayDatos
      ? `<table><thead><tr><th>Origen</th><th>Conversaciones</th><th>Pedidos</th><th>Conversión</th><th>Unidades</th><th>Importe</th><th>Ticket medio</th><th>Cancelados</th></tr></thead><tbody>${filasAtr}</tbody></table>` +
        (!atr.hayAtribucionReal
          ? bloqueParcial({
              titulo: "Todo aparece como «directo» o «panel»",
              texto:
                "El cálculo está implementado y probado, pero no hay nada que atribuir: Meta manda el " +
                "<code>referral</code> solo cuando el cliente entra por un anuncio de Click-to-WhatsApp. " +
                "Mientras no haya campañas activas, estas ventas son de origen desconocido — y no se reparten " +
                "entre campañas inventadas, porque con esto se decide gasto de publicidad.",
            })
          : "")
      : `<div class="vacio">Sin datos de origen todavía.</div>`) +
    pie()
  );
}

// --------------------------------------------------------------------------
// INDICADORES: LOS NUMEROS DEL DIA EN UNA PANTALLA
//
// Marco los pidio juntos -"pedidos entregados, despachados, los que no han
// despachado, el porcentaje de cierre, donde se escapan los clientes,
// cuantas ventas diarias, cuanto vamos recaudado, cuantos respondio el
// bot"- y casi todos EXISTIAN ya, repartidos entre tres pantallas. Leer el
// dia obligaba a recorrer /panel, /guias y /auditoria sumando a mano.
//
// REGLA DE ESTA PANTALLA: ninguna cifra se calcula aqui. Todas vienen de
// `analitica` y `datos`, que son puros y estan probados. Esto solo pinta.
//
// Y NINGUN CERO SE PRESENTA COMO UN HECHO SI NO SE SABE. Un "recaudado: $0"
// cuando nadie marca entregas no significa que no se haya cobrado:
// significa que no se registro. Se dice, con `bloqueParcial`, en vez de
// mostrar un cero que se lee como una mala noticia.
// --------------------------------------------------------------------------
function indicadores({ caja, despachos: d, embudo: emb, atendidos: at, hoy, serie, dias }) {
  const pct = (v) => (v === null || v === undefined ? "—" : `${esc(v)}%`);

  // Donde se escapan: el paso con mas gente perdida. Es la respuesta
  // concreta a "donde se escapan los clientes", en vez de dejar la tabla
  // entera para que alguien la interprete.
  const fuga = emb.hayDatos
    ? [...emb.filas].filter((f) => f.perdidosEnElPaso > 0).sort((a, b) => b.perdidosEnElPaso - a.perdidosEnElPaso)[0]
    : null;

  // El cierre: de quien escribio, cuantos confirmaron.
  const cierre = emb.hayDatos ? emb.filas.find((f) => f.id === "confirmado") : null;

  const filasSerie = (serie || [])
    .map(
      (x) => `<tr>
  <td data-label="Día">${esc(x.dia)}</td>
  <td data-label="Pedidos">${x.pedidos}</td>
  <td data-label="Unidades">${x.unidades}</td>
  <td data-label="Facturado">${esc(pesos(x.importe))}</td>
  <td data-label="Cancelados">${x.cancelados}</td>
</tr>`
    )
    .join("");

  return (
    cabecera({ titulo: "Indicadores", dia: hoy, seccion: "indicadores" }) +
    // ---- LA CAJA ----
    `<h2 style="font-size:16px;margin:0 0 10px">La caja</h2>
<div class="kpis">
  <div class="kpi"><b>${esc(pesos(caja.recaudado))}</b><span>recaudado</span>
    <div class="nota">${caja.pedidos.entregados} entregado${caja.pedidos.entregados === 1 ? "" : "s"} · plata que YA entró</div></div>
  <div class="kpi"><b>${esc(pesos(caja.facturado))}</b><span>facturado</span>
    <div class="nota">${caja.pedidos.vivos} pedido${caja.pedidos.vivos === 1 ? "" : "s"} sin cancelar</div></div>
  <div class="kpi ${caja.enRiesgo > 0 ? "no" : ""}"><b>${esc(pesos(caja.enRiesgo))}</b><span>en riesgo</span>
    <div class="nota">${caja.pedidos.despachados} en la calle · ${caja.pedidos.sinSalir} sin salir</div></div>
  <div class="kpi"><b>${pct(caja.entregadoDeLoQueSalio)}</b><span>de lo que salió, entregado</span>
    <div class="nota">no es la tasa de rechazo — ver abajo</div></div>
</div>
<p style="font-size:13px;color:var(--suave);margin:-6px 0 18px">
  Esto es <b>contraentrega</b>: el cliente paga en la puerta, así que <b>facturado no es recaudado</b>.
  Lo <i>en riesgo</i> es plata que todavía puede no entrar — y el flete ya se gastó.
</p>` +
    (caja.faltaEstadoDevuelto && caja.hayDatos
      ? bloqueParcial({
          titulo: "La tasa de rechazo todavía no se puede calcular",
          texto:
            "Es el número que decide si el canal es rentable, y <b>falta un estado para una entrega que " +
            "FALLÓ</b>. Hoy un pedido despachado no se puede marcar como devuelto: cancelarlo se niega a " +
            "propósito («el pedido ya salió: la cancelación la gestiona una persona»), así que un paquete " +
            "que volvió queda indistinguible de uno que va en camino. Por eso arriba dice <i>de lo que " +
            "salió, entregado</i> y no <i>tasa de entrega</i>: esa cifra sube sola a medida que alguien " +
            "marca entregas, y no resta los rechazos porque no hay dónde anotarlos.",
          comoSeDesbloquea:
            "Para desbloquearlo: un estado «devuelto» con su motivo, que es también lo que permitiría " +
            "medir cuánto cuesta cada rechazo en flete.",
        })
      : "") +
    (!caja.hayEntregasRegistradas && caja.hayDatos
      ? bloqueParcial({
          titulo: "Nadie ha marcado entregas todavía",
          texto:
            "El cálculo está implementado y probado, pero <b>recaudado sale $0 porque no se ha registrado " +
            "ninguna entrega</b>, no porque no se haya cobrado. Se marca en <a href='/panel/guias'>Guías</a>, " +
            "en los pedidos que ya salieron. Mientras nadie lo marque, la tasa de entrega tampoco significa nada.",
        })
      : "") +
    // ---- EL DESPACHO ----
    `<h2 style="font-size:16px;margin:24px 0 10px">El despacho</h2>
<div class="kpis">
  <div class="kpi ${d.porDespachar.length > 0 ? "no" : ""}"><b>${d.porDespachar.length}</b><span>por despachar</span>
    <div class="nota">confirmados que no han salido</div></div>
  <div class="kpi"><b>${d.despachados.length}</b><span>despachados</span>
    <div class="nota">salieron y aún no constan entregados</div></div>
  <div class="kpi"><b>${d.entregados.length}</b><span>entregados</span>
    <div class="nota">llegaron y se cobraron</div></div>
  <div class="kpi ${d.conNovedad.length > 0 ? "no" : ""}"><b>${d.conNovedad.length}</b><span>con novedad abierta</span>
    <div class="nota">${d.conNovedad.length > 0 ? "<a href='/panel/novedades'>revisar</a>" : "ninguna"}</div></div>
</div>` +
    // ---- EL CIERRE ----
    `<h2 style="font-size:16px;margin:24px 0 10px">El cierre</h2>` +
    (emb.hayDatos
      ? `<div class="kpis">
  <div class="kpi"><b>${pct(cierre ? cierre.conversionDesdeArriba : null)}</b><span>% de cierre</span>
    <div class="nota">de quien escribió, cuántos confirmaron</div></div>
  <div class="kpi"><b>${esc(fuga ? fuga.etiqueta : "—")}</b><span>dónde se escapan</span>
    <div class="nota">${fuga ? `se caen ${fuga.perdidosEnElPaso} ahí` : "sin caídas registradas"}</div></div>
  <div class="kpi"><b>${at.soloBot}</b><span>resolvió el bot</span>
    <div class="nota">${pct(at.porcentajeDelBot)} de los ${at.contestados} contestados</div></div>
  <div class="kpi"><b>${at.conPersona}</b><span>tocó una persona</span>
    <div class="nota">${at.sinRespuesta} sin responder</div></div>
</div>
<p style="font-size:13px;color:var(--suave);margin:-6px 0 0">
  El detalle del embudo, paso por paso, está en <a href="/panel/auditoria">Auditoría</a>.
  «Resolvió el bot» cuenta <b>chats</b>, no mensajes: el historial guarda los últimos 60.
</p>`
      : `<div class="vacio">Sin conversaciones todavía.</div>`) +
    // ---- POR DIA ----
    `<h2 style="font-size:16px;margin:24px 0 10px">Ventas por día · últimos ${esc(dias)}</h2>` +
    ((serie || []).some((x) => x.pedidos > 0)
      ? `<table><thead><tr><th>Día</th><th>Pedidos</th><th>Unidades</th><th>Facturado</th><th>Cancelados</th></tr></thead><tbody>${filasSerie}</tbody></table>`
      : `<div class="vacio">Sin pedidos en los últimos ${esc(dias)} días.</div>`) +
    pie()
  );
}

/** Pantalla honesta para lo que necesita configuracion externa. */
function bloqueada({ titulo, queFalta, porQue, comoSeDesbloquea }) {
  return (
    cabecera({ titulo }) +
    `<div class="aviso mal"><b>Esta pantalla no esta operativa.</b> No se presenta como si funcionara.</div>
<div style="background:var(--caja);border:1px solid var(--borde);border-radius:12px;padding:18px;max-width:720px">
  <h2 style="font-size:16px;margin:0 0 10px">Que falta</h2>
  <p style="margin:0 0 16px">${queFalta}</p>
  <h2 style="font-size:16px;margin:0 0 10px">Por que no se puede dar por hecho</h2>
  <p style="margin:0 0 16px">${porQue}</p>
  <h2 style="font-size:16px;margin:0 0 10px">Como se desbloquea</h2>
  <div>${comoSeDesbloquea}</div>
</div>` +
    pie()
  );
}


// ==========================================================================
// LA BANDEJA: TODOS LOS CHATS
//
// El tablero es la pantalla para TRABAJAR el dia: lo que espera respuesta.
// Esta es la pantalla para BUSCAR y para AUDITAR, y son dos necesidades
// distintas. Sin ella, la conversacion de quien pregunto y no compro -que
// son la mayoria- solo se podia abrir si recordabas su nombre.
// ==========================================================================

const ETIQUETAS_FILTRO = {
  todos: "Todos",
  esperando: "Esperando",
  en_curso: "En curso",
  atendidos: "Atendidos",
  con_pedido: "Con pedido",
  sin_pedido: "Sin pedido",
};

/** Quien hablo el ultimo mensaje, para la fila. */
const QUIEN_CORTO = { cliente: "cliente", bot: "bot", operador: "tú" };

function bandeja({ datos, aviso = null }) {
  const { filas, total, pagina, paginas, filtro, q, cuentas, recortada, techo, pedidosRecortados } = datos;

  const enlace = (f, p = 1) =>
    `/panel/chats?filtro=${encodeURIComponent(f)}${q ? `&q=${encodeURIComponent(q)}` : ""}${p > 1 ? `&pagina=${p}` : ""}`;

  const pestanasFiltro = Object.entries(ETIQUETAS_FILTRO)
    .map(
      ([clave, etiqueta]) =>
        `<a class="pest ${filtro === clave ? "activa" : ""}" href="${esc(enlace(clave))}">${esc(etiqueta)}
           <span class="pastilla">${esc(cuentas[clave] ?? 0)}</span></a>`
    )
    .join("");

  const fila = (f) => {
    const quien = f.ultimo ? QUIEN_CORTO[f.ultimo.de] || f.ultimo.de : "";
    // Un mensaje del negocio que NO salio se marca: una fila que parece
    // contestada cuando el envio fallo es un cliente que nadie atendio.
    const noSalio = f.ultimo && f.ultimo.de !== "cliente" && f.ultimo.estado && f.ultimo.estado !== "enviado";
    const etiquetas = [
      `<span class="pastilla ${esc(f.clase)}">${esc(ETIQUETAS[f.clase] || f.clase)}</span>`,
      f.pedidosVivos ? `<span class="pastilla ok">${f.pedidosVivos} pedido(s)</span>` : "",
      f.atencion && f.atencion.pausado ? `<span class="pastilla pendiente">persona</span>` : "",
      // La promesa del bot, visible SIN abrir el chat. Si hay que entrar en
      // cada conversacion para saber cual espera respuesta de una persona,
      // la lista no sirve para repartir el trabajo.
      f.pendiente && f.pendiente.hay ? `<span class="pastilla pendiente">por contestar</span>` : "",
      noSalio ? `<span class="pastilla no">no salió</span>` : "",
    ].join("");

    return `<a class="filaChat" href="/panel/chat?id=${encodeURIComponent(f.contactoId)}">
      <div class="filaTop">
        <b>${esc(f.nombre || f.telefono)}</b>
        <span class="cuando">${esc(f.ultimo ? fecha.hace(f.ultimo.ts) : "—")}</span>
      </div>
      <div class="filaEtiquetas">${etiquetas}</div>
      ${
        f.ultimo
          ? `<div class="filaUltimo"><span class="quien">${esc(quien)}:</span> ${esc(f.ultimo.texto) || "<i>(sin texto)</i>"}</div>`
          : `<div class="filaUltimo"><i>sin mensajes</i></div>`
      }
      <div class="filaPie">${esc(f.telefono)}${f.ciudad ? ` · ${esc(f.ciudad)}` : ""}${
        f.importe ? ` · ${esc(pesos(f.importe))}` : ""
      }${f.minutosEsperando !== null ? ` · esperando ${esc(f.minutosEsperando)} min` : ""}</div>
    </a>`;
  };

  const paginacion =
    paginas > 1
      ? `<div class="paginas">
           ${pagina > 1 ? `<a href="${esc(enlace(filtro, pagina - 1))}">‹ anterior</a>` : `<span>‹ anterior</span>`}
           <span class="deque">página ${pagina} de ${paginas}</span>
           ${pagina < paginas ? `<a href="${esc(enlace(filtro, pagina + 1))}">siguiente ›</a>` : `<span>siguiente ›</span>`}
         </div>`
      : "";

  return (
    cabecera({ titulo: "Todos los chats", seccion: "chats" }) +
    (aviso ? `<div class="aviso ${esc(aviso.clase)}">${esc(aviso.texto)}</div>` : "") +
    `<form class="buscador" method="get" action="/panel/chats">
       <input type="hidden" name="filtro" value="${esc(filtro)}">
       <input type="search" name="q" value="${esc(q)}" placeholder="Buscar por nombre, teléfono, ciudad o texto…"
              autocomplete="off" inputmode="search">
       <button class="primario" type="submit">Buscar</button>
       ${q ? `<a class="limpiar" href="${esc(enlace(filtro))}">limpiar</a>` : ""}
     </form>` +
    `<div class="pests">${pestanasFiltro}</div>` +
    // Un límite que no se ve es un error silencioso: la bandeja diría un
    // total que no es, y el chat que falta es justo el que nadie atendió.
    (recortada
      ? `<div class="aviso ambar">Se están leyendo las ${esc(techo)} conversaciones más recientes, y hay más.
           Los totales y las pestañas cuentan solo esas. Usa la búsqueda para llegar a una conversación concreta,
           o sube <code>PANEL_TECHO_CHATS</code> en Render.</div>`
      : "") +
    // Este aviso es mas grave que el de arriba: no falta informacion, hay
    // informacion equivocada. Un cliente que compro aparece como "sin
    // pedido", que es justo la pestaña donde se buscan las fugas.
    (pedidosRecortados
      ? `<div class="aviso mal">No se leyeron todos los pedidos, así que algunas filas pueden decir
           «sin pedido» siendo falso. Sube <code>PANEL_TECHO_CHATS</code> en Render antes de sacar
           conclusiones de esta pantalla.</div>`
      : "") +
    `<div class="nota" style="margin:4px 0 10px">${esc(total)} conversación(es)${
      q ? ` que coinciden con “${esc(q)}”` : ""
    }.</div>` +
    (filas.length
      ? `<div class="listaChats">${filas.map(fila).join("")}</div>`
      : `<div class="vacio">No hay conversaciones con ese filtro.</div>`) +
    paginacion +
    pie()
  );
}

// ==========================================================================
// LOS DATOS DE ENTREGA, Y DE DONDE SALE CADA UNO
//
// Marco pidio distinguir "los datos actuales del contacto" de "los guardados
// en el pedido", y la distincion no es un detalle de presentacion: son dos
// cosas que pueden NO coincidir, y cuando no coinciden hay que saber cual
// manda.
//
//   · La FICHA de la conversacion es lo ultimo que dijo el cliente. Cambia.
//   · El PEDIDO es una copia congelada del momento en que confirmo. No
//     cambia, y es lo que se despacha.
//
// Si el cliente corrige su direccion despues de confirmar, la ficha dice una
// cosa y el pedido otra. Mostrar solo una de las dos lleva a despachar a la
// direccion equivocada creyendo que estaba bien.
// ==========================================================================

const CAMPOS_ENTREGA = [
  ["nombre", "Destinatario"],
  ["telefono", "Teléfono"],
  ["ciudad", "Ciudad"],
  ["departamento", "Departamento"],
  ["direccion", "Dirección"],
  ["referencia", "Referencia"],
];

/** Lee un campo del pedido guardado. */
function delPedido(pedido, campo) {
  if (!pedido) return null;
  const d = pedido.destinatario || {};
  return d[campo] ?? null;
}

/**
 * Tabla comparativa: lo que dice la conversacion vs lo que quedo en el pedido.
 *
 * Las diferencias se marcan. Un campo que difiere no es un error por si
 * mismo -el cliente pudo corregirse- pero es exactamente lo que alguien
 * tiene que mirar antes de despachar.
 */
function datosDeEntrega({ conversacion, pedido = null, editable = false, envioManualActivo = false }) {
  const filas = CAMPOS_ENTREGA.map(([campo, etiqueta]) => {
    const enFicha = fichaDe.leer(conversacion.ficha, campo);
    const enPedido = delPedido(pedido, campo);
    const difiere =
      pedido && enFicha.hay && enPedido && String(enFicha.valor).trim() !== String(enPedido).trim();

    // El departamento solo se muestra si existe en alguna de las dos
    // fuentes: una fila vacia permanente ensucia la pantalla y enseña a
    // ignorar los huecos.
    if (campo === "departamento" && !enFicha.hay && !enPedido) return "";

    return `<tr class="${difiere ? "difiere" : ""}">
      <td data-label="Campo"><b>${esc(etiqueta)}</b></td>
      <td data-label="Dice el cliente">${enFicha.hay ? conEstado(enFicha) : `<span class="falta">— falta</span>`}</td>
      ${pedido ? `<td data-label="En el pedido">${enPedido ? esc(enPedido) : `<span class="falta">—</span>`}</td>` : ""}
    </tr>`;
  }).join("");

  const cot = (pedido && pedido.cotizacion) || conversacion.cotizacion || null;
  const lineasPedido = cot
    ? `<table class="compacta"><tbody>
        <tr><td data-label="Producto"><b>Producto</b></td><td>${esc(cot.productoNombre || cot.productoId || "—")}</td></tr>
        ${
          cot.variante
            ? `<tr><td data-label="Variante"><b>Variante</b></td><td>${esc(
                typeof cot.variante === "object" ? Object.values(cot.variante).join(" · ") : cot.variante
              )}</td></tr>`
            : ""
        }
        <tr><td data-label="Cantidad"><b>Cantidad</b></td><td>${esc(cot.cantidad || 1)}</td></tr>
        <tr><td data-label="Total"><b>Total</b></td><td>${esc(pesos(cot.total || 0))}</td></tr>
        <tr><td data-label="Pago"><b>Pago</b></td><td>${esc(
          (cot.condiciones && cot.condiciones.pagoMetodo) || "no declarado"
        )}${
          cot.condiciones && cot.condiciones.envioIncluido ? " · envío incluido" : ""
        }</td></tr>
        ${
          pedido
            ? `<tr><td data-label="Estado"><b>Estado del pedido</b></td><td>${esc(pedido.estado)} <span class="pastilla">${esc(
                pedido.id
              )}</span></td></tr>`
            : ""
        }
      </tbody></table>`
    : `<div class="nota">Todavía no hay cotización para este cliente.</div>`;

  const formulario = editable
    ? `<form class="entrega" method="post" action="/panel/entrega">
         <input type="hidden" name="id" value="${esc(conversacion.contactoId)}">
         ${CAMPOS_ENTREGA.map(([campo, etiqueta]) => {
           const v = fichaDe.leer(conversacion.ficha, campo);
           return `<label>${esc(etiqueta)}
             <input name="${esc(campo)}" value="${esc(v.hay ? v.valor : "")}" autocomplete="off"></label>`;
         }).join("")}
         <div class="botones">
           <button class="primario" type="submit" name="accion" value="guardar">Guardar correcciones</button>
           <button type="submit" name="accion" value="confirmar" ${envioManualActivo ? "" : "disabled"}>
             Confirmar por WhatsApp</button>
         </div>
         <p class="nota">
           ${
             envioManualActivo
               ? "Al confirmar se le manda el resumen con estos datos. El total y las condiciones los calcula el sistema, no se escriben aquí."
               : "Los envíos manuales están <b>apagados</b>: puedes guardar correcciones, pero el botón de confirmar no enviará nada. Se encienden con <code>PANEL_ENVIO_MANUAL=1</code>."
           }
         </p>
       </form>`
    : "";

  return `<h2 class="seccion">Datos de entrega</h2>
    <table class="entregaTabla">
      <thead><tr><th>Campo</th><th>Dice el cliente</th>${pedido ? "<th>En el pedido</th>" : ""}</tr></thead>
      <tbody>${filas}</tbody>
    </table>
    ${
      pedido
        ? `<p class="nota">La columna <b>“En el pedido”</b> es una copia congelada del momento en que el cliente
             confirmó, y es la que se despacha. Si una fila sale marcada, el cliente dijo algo distinto después.</p>`
        : ""
    }
    <h2 class="seccion">Pedido</h2>
    ${lineasPedido}
    ${formulario}`;
}


// ==========================================================================
// POR QUE EL BOT NO CONTESTO
//
// La pantalla que faltaba, y la razon de que faltara es instructiva: cada
// causa estaba prevista, registrada en el diario y en los logs de Render...
// y ninguna se veia en el panel. El bot se callaba y el tablero seguia
// mostrando un dia normal.
//
// Esta pantalla responde tres cosas, en este orden:
//   1. a cuantos clientes no se contesto
//   2. por que, con la palanca concreta para arreglarlo
//   3. quienes son, para poder contestarles ahora
// ==========================================================================

function sinResponder({ datos, config: cfg = {} }) {
  const { total, causas, pausados, esperando, cuantosEsperan, nuncaRespondidos } = datos;

  const titular = cuantosEsperan
    ? `<div class="aviso mal" style="font-size:16px">
         <b>${esc(cuantosEsperan)} cliente(s) están esperando respuesta.</b>
         ${nuncaRespondidos ? `De esos, <b>${esc(nuncaRespondidos)}</b> no han recibido NINGUNA respuesta.` : ""}
       </div>`
    : `<div class="aviso ok" style="font-size:16px"><b>Nadie está esperando respuesta.</b>
         Todos los chats tienen una respuesta después del último mensaje del cliente.</div>`;

  // El estado de los interruptores, aqui mismo. Es la primera cosa que se
  // mira cuando el bot no contesta, y estaba solo en /health.
  const interruptores = `<div class="kpis">
    <div class="kpi ${cfg.respuestaAutomatica ? "" : "no"}">
      <b>${cfg.respuestaAutomatica ? "Encendida" : "APAGADA"}</b><span>respuesta automática</span>
      <div class="nota">${cfg.respuestaAutomatica ? "el bot contesta" : "prepara y no envía"}</div></div>
    <div class="kpi ${(cfg.numerosDePrueba || []).length ? "no" : ""}">
      <b>${(cfg.numerosDePrueba || []).length || "ninguno"}</b><span>números de prueba</span>
      <div class="nota">${
        (cfg.numerosDePrueba || []).length
          ? "SOLO esos números reciben respuesta"
          : "abierto al público"
      }</div></div>
    <div class="kpi ${pausados.length ? "no" : ""}">
      <b>${esc(pausados.length)}</b><span>chats sin bot</span>
      <div class="nota">${pausados.length ? "una persona tomó el control" : "el bot atiende todos"}</div></div>
  </div>`;

  const bloqueCausas = causas.length
    ? causas
        .map(
          (c) => `<div class="causa ${esc(c.gravedad)}">
            <div class="causaTop"><b>${esc(c.titulo)}</b><span class="pastilla">${esc(c.cuantos)}</span></div>
            <p class="porque">${esc(c.porQue)}</p>
            <p class="arreglo"><b>Qué hacer:</b> ${esc(c.comoSeArregla)}</p>
          </div>`
        )
        .join("")
    : `<div class="vacio">No se registró ningún mensaje sin enviar.</div>`;

  const bloquePausados = pausados.length
    ? `<h2 class="seccion">Chats donde el bot está callado · ${pausados.length}</h2>
       <p class="nota">El bot se calla cuando una persona responde, para que el cliente no reciba dos
         voces. La pausa caduca sola a las ${esc(require("../almacen/atencion").HORAS_DE_PAUSA)} horas,
         pero puedes devolverlos ahora.</p>
       <div class="listaChats">${pausados
         .map(
           (p) => `<a class="filaChat" href="/panel/chat?id=${encodeURIComponent(p.contactoId)}">
             <div class="filaTop"><b>${esc(p.contactoId)}</b>
               <span class="cuando">${p.horas !== null ? `hace ${esc(p.horas)} h` : "sin fecha"}</span></div>
             <div class="filaPie">lo tomó: ${esc(p.por)}</div>
           </a>`
         )
         .join("")}</div>
       <form method="post" action="/panel/devolver-todos" style="margin-top:12px"
             onsubmit="return confirm('¿Devolver ${pausados.length} chat(s) al bot? Si alguien está atendiendo ahora mismo, el bot volverá a hablar ahí.')">
         <button type="submit">Devolver los ${esc(pausados.length)} al bot</button>
       </form>`
    : "";

  const bloqueEsperando = esperando.length
    ? `<h2 class="seccion">Esperando respuesta · ${esc(cuantosEsperan)}</h2>
       <p class="nota">El último mensaje es del cliente y nadie ha contestado después.
         Los que llevan más tiempo, arriba.</p>
       <div class="listaChats">${esperando
         .map(
           (e) => `<a class="filaChat" href="/panel/chat?id=${encodeURIComponent(e.contactoId)}">
             <div class="filaTop"><b>${esc(e.contactoId)}</b>
               <span class="cuando">${esc(e.minutos)} min</span></div>
             <div class="filaEtiquetas">
               ${e.nuncaRespondido ? `<span class="pastilla no">sin ninguna respuesta</span>` : ""}
               ${e.pausado ? `<span class="pastilla pausado">bot pausado</span>` : ""}
             </div>
             <div class="filaUltimo">${esc(e.texto) || "<i>(sin texto)</i>"}</div>
           </a>`
         )
         .join("")}</div>`
    : "";

  return (
    cabecera({ titulo: "Por qué el bot no contestó", dia: datos.dia, seccion: "sin-responder" }) +
    titular +
    interruptores +
    `<h2 class="seccion">Causas · ${esc(total)} mensaje(s) sin salir</h2>` +
    bloqueCausas +
    bloquePausados +
    bloqueEsperando +
    pie()
  );
}

module.exports = {
  sinResponder,
  bandeja,
  datosDeEntrega,
  esc,
  pesos,
  ETIQUETAS,
  ESTILO,
  tablero,
  chat,
  buscar,
  ventaManual,
  guias,
  novedades,
  auditoria,
  indicadores,
  bloqueParcial,
  bloqueada,
};
