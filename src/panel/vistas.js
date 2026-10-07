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

.aviso { padding:10px 12px; border-radius:10px; font-size:14px; margin-bottom:14px; }
.aviso.ok { background:#13301f; border:1px solid #1f5c38; color:#9ff0c0; }
.aviso.mal { background:#3a1d1d; border:1px solid #6b2b2b; color:#ffb4b4; }
.aviso.info { background:#1a2435; border:1px solid #2b3f5c; color:#b8cdf0; }

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
}
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

function cabecera({ titulo, dia = null, extra = "" }) {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>NOVIKA · ${esc(titulo)}</title>
<style>${ESTILO}</style>
</head><body><div class="envoltorio">
<header>
  <h1>NOVIKA</h1>
  <span class="zona">${esc(titulo)}${dia ? ` · ${esc(dia)}` : ""} · hora de Colombia</span>
  <div class="derecha">
    <a class="boton" href="/panel">Tablero</a>
    <a class="boton" href="/panel/buscar">Buscar</a>
    <a class="boton" href="/panel/guias">Guías</a>
    <a class="boton" href="/panel/novedades">Novedades</a>
    <a class="boton" href="/panel/auditoria">Auditoría</a>
    <form method="post" action="/panel/salir" style="display:inline">
      <button type="submit">Salir</button>
    </form>
  </div>
</header>
<div id="aviso" class="aviso info" hidden></div>
${extra}`;
}

function pie(guionExtra = "") {
  return `</div><script>${GUION}${guionExtra}</script></body></html>`;
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
    cabecera({ titulo: "Tablero", dia: datos.dia }) +
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
  const { conversacion, mensajes, atencion: a, pedidos, clase } = ficha;
  const id = conversacion.contactoId;
  const n = fichaDe.nombreParaMostrar(conversacion.ficha);
  const nombre = n.texto;
  const ciudad = fichaDe.leer(conversacion.ficha, "ciudad");

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

  const tablaPedidos = pedidos.length
    ? `<h2 style="font-size:16px;margin:18px 0 10px">Pedidos de este cliente</h2>
<table>
<thead><tr><th>Codigo</th><th>Estado</th><th>Unidades</th><th>Total</th><th>Creado</th><th>Acciones</th></tr></thead>
<tbody>${pedidos
        .map(
          (p) => `<tr>
  <td data-label="Codigo">${esc(p.id)}</td>
  <td data-label="Estado">${esc(p.estado)} <span class="pastilla">v${esc(p.version)}</span></td>
  <td data-label="Unidades">${esc((p.cotizacion && p.cotizacion.cantidad) || 1)}</td>
  <td data-label="Total">${esc(pesos((p.cotizacion && p.cotizacion.total) || 0))}</td>
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

  return (
    cabecera({ titulo: `Chat · ${nombre}` }) +
    (aviso ? `<div class="aviso ${esc(aviso.clase)}">${esc(aviso.texto)}</div>` : "") +
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
</div>` +
    `<div class="chat">
  <div class="hilo" id="hilo">${burbujas}</div>
  <div>
    <label for="texto" style="font-size:13px;color:var(--suave)">Responder como NOVIKA</label>
    <textarea id="texto" placeholder="Escribe la respuesta..."></textarea>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
      <button class="primario" id="enviar" onclick="responder()">Enviar</button>
      <span style="font-size:13px;color:var(--suave);align-self:center">
        ${
          envioManualActivo
            ? "Al enviar, el bot queda pausado en este chat."
            : "Los env\u00edos manuales est\u00e1n <b>apagados</b>: se registrar\u00e1 el intento y su motivo real, pero no saldr\u00e1 nada. " +
              "Se encienden con <code>PANEL_ENVIO_MANUAL=1</code> en Render."
        }
      </span>
    </div>
  </div>
</div>` +
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
    cabecera({ titulo: "Buscar clientes" }) +
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
function guias({ datos: d, transportadoras = [], aviso = null }) {
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
</tr>`;
  };

  return (
    cabecera({ titulo: "Guías y despachos" }) +
    (aviso ? `<div class="aviso ${esc(aviso.clase)}">${esc(aviso.texto)}</div>` : "") +
    `<div class="kpis">
  <div class="kpi"><b>${d.porDespachar.length}</b><span>por despachar</span></div>
  <div class="kpi"><b>${d.despachados.length}</b><span>despachados</span></div>
  <div class="kpi"><b>${d.conNovedad.length}</b><span>con novedad abierta</span></div>
</div>` +
    `<h2 style="font-size:16px;margin:20px 0 10px">Por despachar</h2>` +
    (d.porDespachar.length
      ? `<table><thead><tr><th>Codigo</th><th>Cliente</th><th>Ciudad</th><th>Total</th><th>Estado</th><th>Guía</th></tr></thead>
<tbody>${d.porDespachar.map(filaPorDespachar).join("")}</tbody></table>`
      : `<div class="vacio">Nada pendiente de despachar.</div>`) +
    `<h2 style="font-size:16px;margin:24px 0 10px">Despachados</h2>` +
    (d.despachados.length
      ? `<table><thead><tr><th>Codigo</th><th>Cliente</th><th>Guía</th><th>Transportadora</th><th>Despachado</th><th>Novedades</th></tr></thead>
<tbody>${d.despachados.map(filaDespachado).join("")}</tbody></table>`
      : `<div class="vacio">Todavía no hay despachos.</div>`) +
    bloqueParcial({
      titulo: "Lo que falta: partir el PDF de la transportadora automáticamente",
      texto:
        "Registrar la guía a mano <b>funciona</b> y es lo que ves arriba. Lo que no está es leer un PDF con " +
        "muchas guías y repartir cada una a su cliente: ese lector se ajusta al formato exacto del PDF de la " +
        "transportadora, y sin un ejemplo real sería código que no se puede verificar. Una guía asignada al " +
        "cliente equivocado manda el paquete a otra persona.",
      comoSeDesbloquea: "Para desbloquearlo: elegir transportadora y pasarme un PDF de guías de verdad.",
    }) +
    pie(`
async function despachar(codigo) {
  var guia = (document.getElementById("g-" + codigo) || {}).value || "";
  var transportadora = (document.getElementById("t-" + codigo) || {}).value || "";
  if (!guia.trim()) { avisar("Falta el número de guía: sin él el pedido no se puede rastrear.", "mal"); return; }
  var r = await pedir("/panel/guias/despachar", { codigo: codigo, guia: guia, transportadora: transportadora });
  if (r.ok) { avisar(r.aviso, "ok"); setTimeout(function(){ location.reload(); }, 700); }
  else avisar(r.error, "mal");
}
`)
  );
}

/** NOVEDADES DE ENTREGA */
function novedades({ datos: d, tipos = [], envioManualActivo = false, aviso = null }) {
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
    cabecera({ titulo: "Novedades de entrega" }) +
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
    bloqueParcial({
      titulo: "Lo que falta: avisar al cliente por WhatsApp",
      texto:
        "Registrar y resolver novedades <b>funciona</b>. Lo que no se puede todavía es avisar al cliente: una " +
        "novedad se reporta días después del pedido, cuando la ventana de 24 h de Meta ya se cerró, y fuera de " +
        "esa ventana Meta <b>solo entrega plantillas aprobadas</b>. Con texto libre acepta el mensaje y no lo " +
        "entrega: el cliente no se enteraría y nosotros creeríamos que sí.",
      comoSeDesbloquea:
        "Hay que crear en Meta Business Manager y esperar aprobación: " +
        "<code>PLANTILLA_NOVEDAD_AUSENTE</code>, <code>PLANTILLA_NOVEDAD_DIRECCION</code> y " +
        "<code>PLANTILLA_NOVEDAD_OFICINA</code>.",
    }) +
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
    cabecera({ titulo: `Auditoría · últimos ${dias} días` }) +
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

module.exports = {
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
  bloqueParcial,
  bloqueada,
};
