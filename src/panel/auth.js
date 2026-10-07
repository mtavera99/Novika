"use strict";

// ==========================================================================
// ACCESO AL PANEL
//
// Inicio de sesion propio de NOVIKA. No se reutiliza ninguna credencial de
// otro sistema, y en particular NO se usa el token de verificacion de Meta
// como contrasena.
//
// --------------------------------------------------------------------------
// POR QUE UNA COOKIE Y NO EL TOKEN EN LA URL
// --------------------------------------------------------------------------
//
// BIKERPRO lleva el token en la URL: /panel?token=... Funciona, pero una
// URL con un secreto dentro se queda en sitios donde nadie la borra:
//
//   - el historial del navegador del celular;
//   - la cabecera Referer de cualquier recurso externo que cargue la pagina;
//   - los logs de acceso del hosting y de cualquier proxy en medio;
//   - el portapapeles, cuando se comparte "el link del panel".
//
// Aqui el token se manda UNA VEZ por POST y lo que queda es una cookie
// firmada, HttpOnly, que el JavaScript de la pagina no puede leer.
//
// `/metricas` y `/eventos` siguen aceptando ?token= para no romper lo que ya
// se usa; eso no cambia en esta entrega.
//
// --------------------------------------------------------------------------
// LA LECCION DEL 403 DE BIKERPRO
// --------------------------------------------------------------------------
//
// Su bateria lo deja escrito: un 403 devuelve el texto "Forbidden", no JSON.
// Si la pantalla hace r.json() sin mirar el estado, el dueno ve
// "Unexpected token 'F'" y se va a buscar el problema donde no esta. Les
// paso DOS VECES, en /responder y en /guias.
//
// Por eso aqui toda respuesta de error de una ruta que se consume por fetch
// sale como JSON con su `error` dentro, y el cliente mira el estado antes de
// interpretar el cuerpo.
// ==========================================================================

const crypto = require("node:crypto");

const COOKIE = "novika_panel";
/** 12 horas: una jornada, sin obligar a entrar dos veces al dia. */
const VIGENCIA_MS = 12 * 60 * 60 * 1000;

/**
 * Clave de firma derivada del token del panel.
 *
 * Derivada y no el token tal cual: asi la cookie no contiene -ni permite
 * reconstruir- la contrasena. Si alguien se lleva una cookie, tiene una
 * sesion; no tiene la credencial para entrar cuando caduque.
 */
function clave(token) {
  return crypto.createHmac("sha256", "novika.panel.sesion.v1").update(String(token)).digest();
}

function firmar(datos, token) {
  return crypto.createHmac("sha256", clave(token)).update(datos).digest("base64url");
}

/** Crea el valor de la cookie: "<expira>.<firma>". */
function crearSesion(token, ahora = Date.now()) {
  const expira = String(ahora + VIGENCIA_MS);
  return `${expira}.${firmar(expira, token)}`;
}

/**
 * ¿Es valida esta sesion?
 *
 * La comparacion de la firma es de tiempo constante. Con una comparacion
 * normal, el tiempo de respuesta filtra cuantos caracteres coinciden, y eso
 * permite reconstruir una firma valida byte a byte.
 */
function sesionValida(valor, token, ahora = Date.now()) {
  if (!valor || !token) return false;
  const partes = String(valor).split(".");
  if (partes.length !== 2) return false;
  const [expira, firma] = partes;
  if (!/^\d+$/.test(expira)) return false;
  if (Number(expira) < ahora) return false;

  const esperada = Buffer.from(firmar(expira, token));
  const recibida = Buffer.from(String(firma));
  if (esperada.length !== recibida.length) return false;
  return crypto.timingSafeEqual(esperada, recibida);
}

/**
 * ¿Es correcta la contrasena? Comparacion de tiempo constante.
 *
 * Tambien aqui: comparar con === filtra por tiempo cuanto prefijo acerto.
 */
function tokenCorrecto(recibido, esperado) {
  if (!esperado) return false; // sin PANEL_TOKEN configurado no se entra
  const a = Buffer.from(String(recibido || ""));
  const b = Buffer.from(String(esperado));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Cookies de una peticion. Sin dependencias: es una cabecera sencilla. */
function cookies(req) {
  const salida = {};
  const bruto = (req.headers && req.headers.cookie) || "";
  for (const trozo of bruto.split(";")) {
    const i = trozo.indexOf("=");
    if (i < 0) continue;
    const k = trozo.slice(0, i).trim();
    if (k) salida[k] = decodeURIComponent(trozo.slice(i + 1).trim());
  }
  return salida;
}

/** ¿Esta autenticada esta peticion? */
function autenticada(req, config) {
  return sesionValida(cookies(req)[COOKIE], config.panelToken);
}

function ponerCookie(res, config) {
  const trozos = [
    `${COOKIE}=${crearSesion(config.panelToken)}`,
    "Path=/panel",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(VIGENCIA_MS / 1000)}`,
  ];
  // Secure solo en Render: en local se entra por http y una cookie Secure
  // no se guardaria, asi que el panel seria imposible de probar.
  if (process.env.RENDER) trozos.push("Secure");
  res.setHeader("Set-Cookie", trozos.join("; "));
}

function quitarCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/panel; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Compuerta para las rutas del panel.
 *
 * Devuelve true si se puede seguir. Si no, ya ha respondido:
 *   - a una peticion de datos (fetch), 401 en JSON;
 *   - a una pagina, la pantalla de entrada.
 */
function exigirSesion(req, res, config, { comoJson = false } = {}) {
  if (autenticada(req, config)) return true;
  if (comoJson) {
    res.status(401).json({ ok: false, error: "La sesion caduco. Vuelve a entrar al panel." });
  } else {
    res.status(401).set("Content-Type", "text/html; charset=utf-8").send(pantallaDeEntrada());
  }
  return false;
}

/** Pantalla de entrada. Sin dependencias y sin recursos externos. */
function pantallaDeEntrada(aviso = "") {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NOVIKA · panel</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
         background:#0f1115; color:#e8eaed; padding:24px; }
  .caja { width:100%; max-width:380px; background:#171a21; border:1px solid #262b36;
          border-radius:14px; padding:28px; }
  h1 { margin:0 0 4px; font-size:22px; letter-spacing:.5px; }
  p.sub { margin:0 0 22px; color:#9aa3b2; font-size:14px; }
  label { display:block; font-size:14px; margin-bottom:6px; color:#c6ccd8; }
  /* 16px MINIMO: iOS hace zoom solo si el input es menor, y la pagina salta. */
  input { width:100%; font-size:16px; padding:13px 14px; border-radius:10px;
          border:1px solid #2d3340; background:#0f1115; color:#e8eaed; }
  input:focus { outline:2px solid #4f8cff; outline-offset:1px; }
  /* 44px de alto: la guia de Apple para un objetivo tactil. */
  button { width:100%; min-height:44px; margin-top:16px; font-size:16px; font-weight:600;
           border:0; border-radius:10px; background:#4f8cff; color:#fff; cursor:pointer; }
  button:active { transform:translateY(1px); }
  .mal { background:#3a1d1d; border:1px solid #6b2b2b; color:#ffb4b4;
         padding:10px 12px; border-radius:10px; font-size:14px; margin-bottom:16px; }
  .pie { margin-top:18px; font-size:12px; color:#6f7787; }
</style>
</head><body>
  <form class="caja" method="post" action="/panel/entrar">
    <h1>NOVIKA</h1>
    <p class="sub">Panel operativo</p>
    ${aviso ? `<div class="mal">${aviso}</div>` : ""}
    <label for="t">Token del panel</label>
    <input id="t" name="token" type="password" autocomplete="current-password"
           autocapitalize="off" autocorrect="off" spellcheck="false" required autofocus>
    <button type="submit">Entrar</button>
    <p class="pie">Es el <code>PANEL_TOKEN</code> del servicio. No es el token de Meta.</p>
  </form>
</body></html>`;
}

module.exports = {
  COOKIE,
  VIGENCIA_MS,
  crearSesion,
  sesionValida,
  tokenCorrecto,
  cookies,
  autenticada,
  ponerCookie,
  quitarCookie,
  exigirSesion,
  pantallaDeEntrada,
};
