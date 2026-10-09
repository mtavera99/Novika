"use strict";

// ==========================================================================
// EL JAVASCRIPT DEL PANEL TIENE QUE PARSEAR
//
// EL DEFECTO QUE ESTO ARREGLA DEJO EL PANEL ENTERO INUTILIZABLE, y pasó
// todas las pruebas que había.
//
// Marco, probando desde su WhatsApp:
//
//   «cuando le doy en devolver al bot se queda quieto, no hace nada […] lo
//    mismo que el botón de cancelar pedido tampoco»
//
// La causa: una cadena de `confirm()` escrita con `\n` dentro de un TEMPLATE
// LITERAL. El `\n` se interpreta al generar el HTML, así que a la página
// llegaba un salto de línea **de verdad** en medio de una cadena entre
// comillas dobles:
//
//     if (!confirm("El bot volvera a tratar este chat como nuevo.
//     NO se borra el historial...
//
// Eso es un `SyntaxError`. Y un SyntaxError **no rompe una función: rompe el
// bloque `<script>` completo**. Ninguna función de la página llegaba a
// existir, así que TODOS los botones estaban muertos a la vez:
//
//     Devolver al bot · Tomar el control · Marcar atendido ·
//     Empezar de cero · Reenviar fotos · Responder · Cancelar pedido
//
// --------------------------------------------------------------------------
// POR QUE NINGUNA PRUEBA LO VIO
// --------------------------------------------------------------------------
//
// Las pruebas del panel comprueban que las rutas **devuelven 200** y que el
// HTML contiene los textos esperados. Y la página devolvía 200 perfectamente,
// con el JavaScript roto dentro. El servidor estaba impecable: las rutas
// `/panel/control` y `/panel/pedido/cancelar` se probaron contra producción
// con `curl` y devuelven `{"ok":true}`.
//
// Esa es la parte cara del defecto: **no hay petición, no hay log, no hay
// error**. Desde el lado del servidor no existe.
//
// Es el mismo tipo de agujero que la lección del 403 que ya está documentada
// en `panel/auth.js` —«un 403 devuelve el texto Forbidden, no JSON», y les
// pasó dos veces—: el fallo vive en el navegador y el servidor no se entera.
//
// --------------------------------------------------------------------------
// POR QUE SE LEVANTA EL SERVIDOR EN VEZ DE LLAMAR A LAS VISTAS
// --------------------------------------------------------------------------
//
// La primera versión de esta prueba llamaba a `vistas.chat(...)` con datos
// inventados. Dos problemas, y el segundo es grave:
//
//   1. cada vista espera una forma distinta de datos, y acertarlas a mano es
//      frágil: la prueba se rompe cuando cambia una vista, no cuando se
//      rompe el panel;
//   2. las que no se construían se SALTABAN — y `vistas.chat`, la única
//      pantalla que de verdad tenía el JavaScript roto, era una de ellas. La
//      prueba pasaba en verde sin haber revisado nada.
//
// Una prueba que se salta lo que no entiende no es una prueba. Así que esto
// recorre las rutas DE VERDAD, con sesión, y revisa el HTML que se sirve. Es
// lo mismo que vería el navegador de Marco.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const ayuda = require("./ayuda");
const dir = ayuda.entornoDePrueba({ PANEL_TOKEN: "token_del_panel_de_prueba" });

const { crearApp } = require("../src/app");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { cotizar } = require("../src/dominio/cotizador");
const dominioPedido = require("../src/dominio/pedido");
const { cargarCatalogo } = require("../src/catalogo");

const RAIZ = path.join(__dirname, "..");
const CLIENTE = "573001112233";

/** Todos los <script> en línea de una página. */
function guionesDe(html) {
  const fuera = [];
  const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    if (m[1].trim()) fuera.push(m[1]);
  }
  return fuera;
}

/**
 * Siembra un chat con un pedido confirmado.
 *
 * Con datos dentro, porque una pantalla vacía no renderiza los botones: el
 * de cancelar un pedido solo existe si hay un pedido.
 */
async function sembrar() {
  // ⚠️ LA SUBCARPETA "transaccional" NO ES OPCIONAL.
  //
  // `almacen/repos/index.js` monta los repos en
  // `path.join(DATA_DIR, "transaccional")`. Sembrando en DATA_DIR a secas el
  // servidor no ve nada y /panel/chat devuelve 404 — y entonces esta prueba
  // pasaria revisando pantallas vacias, que es justo como se escapo el
  // defecto que vino a cazar.
  const repos = await crearReposDeArchivos({ dir: path.join(dir, "transaccional") });
  const producto = cargarCatalogo({
    carpeta: path.join(RAIZ, "catalogo", "productos"),
    refrescar: true,
  }).porId.get("cinturon-termico-colicos");

  const cot = cotizar({ producto, cantidad: 1 }).cotizacion;

  await repos.contactos.guardar({ id: CLIENTE, nombre: "Ana Pérez" });

  await repos.conversaciones.guardar({
    contactoId: CLIENTE,
    estado: "confirmado",
    ficha: {},
    productoId: producto.id,
    mensajes: [
      { de: "cliente", texto: "Hola", en: new Date().toISOString() },
      { de: "negocio", texto: "¡Hola! ¿En qué te puedo ayudar?", en: new Date().toISOString() },
    ],
  });

  const armado = dominioPedido.construir({
    cotizacion: cot,
    datos: {
      nombre: "Ana Pérez",
      telefono: "3001112233",
      ciudad: "Cali",
      departamento: "Valle del Cauca",
      direccion: "Calle 1 # 2-3",
    },
    contactoId: CLIENTE,
    conversacionId: CLIENTE,
    ofertaId: "of-panel-js",
    wamidConfirmacion: "wamid.panel-js",
  });
  assert.equal(armado.ok, true, `el pedido de prueba no se armó: ${(armado.falta || []).join(",")}`);
  await repos.pedidos.crearSiNoExiste(armado.pedido);

  await repos.cerrar();
}

async function levantar() {
  const servidor = await ayuda.levantar(crearApp());
  const r = await fetch(`${servidor.url}/panel/entrar`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "token=token_del_panel_de_prueba",
    redirect: "manual",
  });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return { ...servidor, cookie };
}

/** Las pantallas del panel, por su ruta real. */
const RUTAS = [
  "/panel",
  `/panel/chat?id=${CLIENTE}`,
  "/panel/chats",
  "/panel/buscar?q=ana",
  "/panel/sin-responder",
  "/panel/guias",
  "/panel/novedades",
  "/panel/indicadores",
  "/panel/auditoria",
  "/panel/venta-manual",
];

describe("el JavaScript del panel parsea en TODAS las pantallas", () => {
  test("ninguna pantalla sirve un <script> con error de sintaxis", async () => {
    await sembrar();
    const s = await levantar();
    const roto = [];
    let revisados = 0;

    try {
      for (const ruta of RUTAS) {
        const r = await fetch(`${s.url}${ruta}`, { headers: { cookie: s.cookie } });
        assert.equal(r.status, 200, `${ruta} devolvió ${r.status}`);
        const html = await r.text();

        const guiones = guionesDe(html);
        assert.ok(guiones.length > 0, `${ruta} no sirvió ningún <script>: ¿se movió el guion?`);

        for (const [i, guion] of guiones.entries()) {
          revisados += 1;
          try {
            // `new vm.Script` solo PARSEA: no ejecuta nada, así que no hace
            // falta un DOM. Es exactamente lo que hace el navegador antes de
            // ejecutar la primera línea.
            new vm.Script(guion, { filename: `${ruta}#script${i}` });
          } catch (e) {
            // La línea exacta: un SyntaxError sin contexto no dice nada útil.
            const linea = Number(String(e.stack || "").match(/#script\d+:(\d+)/)?.[1] || 0);
            const alrededor = guion
              .split("\n")
              .slice(Math.max(0, linea - 2), linea + 1)
              .join("\n");
            roto.push(`${ruta}: ${e.message}\n      ${alrededor.trim()}`);
          }
        }
      }
    } finally {
      await s.cerrar();
    }

    assert.ok(revisados >= RUTAS.length, `solo se revisaron ${revisados} guiones`);
    assert.deepEqual(roto, [], `JavaScript roto en el panel:\n    ${roto.join("\n    ")}`);
  });

  test("y cada botón llama a una función que existe", async () => {
    // La otra mitad del defecto: un `onclick="control(true)"` que apunta a
    // una función inexistente falla en el mismo silencio que el SyntaxError.
    await sembrar();
    const s = await levantar();

    try {
      for (const ruta of [`/panel/chat?id=${CLIENTE}`, "/panel/guias", "/panel/sin-responder"]) {
        const r = await fetch(`${s.url}${ruta}`, { headers: { cookie: s.cookie } });
        const html = await r.text();
        const guion = guionesDe(html).join("\n");

        const invocadas = new Set();
        for (const m of html.matchAll(/on(?:click|change|submit)="([A-Za-z_$][\w$]*)\s*\(/g)) {
          invocadas.add(m[1]);
        }

        const sinDeclarar = [...invocadas].filter(
          (nombre) =>
            !new RegExp(`(?:async\\s+)?function\\s+${nombre}\\b|\\b(?:var|let|const)\\s+${nombre}\\s*=`).test(guion)
        );
        assert.deepEqual(sinDeclarar, [], `${ruta}: botones sin función (${sinDeclarar.join(", ")})`);
      }

      // Y que el chat tenga los botones que Marco usa, para que esta prueba
      // no se quede verde si alguien los borra.
      const r = await fetch(`${s.url}/panel/chat?id=${CLIENTE}`, { headers: { cookie: s.cookie } });
      const html = await r.text();
      for (const fn of ["control", "atendido", "empezarDeCero", "cancelar", "responder"]) {
        assert.match(html, new RegExp(`${fn}\\(`), `el chat ya no ofrece "${fn}"`);
      }
    } finally {
      await s.cerrar();
    }
  });
});
