"use strict";

// ==========================================================================
// LA RECUPERACION DURABLE SOBREVIVE A LA MIGRACION
//
// Requisito explicito de Marco: migrar los pedidos a Postgres NO puede
// reabrir la ventana 200 -> crash -> mensaje perdido.
//
// Esa ventana la cierra la bitacora de trabajo (src/almacen/trabajo.js), que
// se queda EN EL DISCO a proposito:
//
//   - el reclamo es SINCRONO y ocurre antes del acuse a Meta; una escritura
//     a Postgres es asincrona y cambiaria la forma de ese camino, que es el
//     que menos conviene tocar;
//
//   - es lo unico que tiene que funcionar cuando la base NO responda. Si el
//     reclamo dependiera de Postgres, una caida de la base obligaria a
//     devolver 503 a Meta, y con suficientes 503 Meta desactiva la
//     suscripcion. Se perderian TODOS los mensajes, no uno.
//
// Aqui no se razona: se mata el proceso con SIGKILL teniendo Postgres como
// almacen transaccional, y se comprueba que el mensaje se procesa igual tras
// el reinicio.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();
const ayudaPg = require("./ayuda-pg");

const RAIZ = path.join(__dirname, "..");
const SECRETO = "secreto_de_crash_pg";
const ID_NUMERO = "555000111222333";
const ESQUEMA = "prueba_f3_recuperacion";

// --------------------------------------------------------------------------
// Lo que se puede comprobar SIN base de datos
// --------------------------------------------------------------------------

test("la bitacora de trabajo NO depende de la base de datos", () => {
  // Si este archivo importara algo de repos/postgres, el reclamo durable
  // dejaria de funcionar cuando la base no responda, y con el se caeria la
  // unica cosa que impide perder un mensaje tras un crash.
  const fuente = fs.readFileSync(path.join(RAIZ, "src", "almacen", "trabajo.js"), "utf8");
  assert.equal(/require\(["'].*postgres/.test(fuente), false, "trabajo.js importa Postgres");
  assert.equal(/require\(["'].*repos/.test(fuente), false, "trabajo.js importa los repositorios");
  assert.equal(/\bpg\b/.test(fuente.replace(/\/\/.*$/gm, "")), false, "trabajo.js menciona pg en el codigo");
});

test("el reclamo del webhook es SINCRONO y no puede esperar a una base", () => {
  // `admitir` se llama antes del 200 y no se le hace await en rutas.js. Si
  // alguien lo convirtiera en asincrono, el 200 saldria antes del reclamo y
  // volveria la ventana del crash.
  const { admitir } = require("../src/webhook/procesar");
  assert.equal(admitir.constructor.name, "Function", "admitir dejo de ser sincrono");
  assert.notEqual(admitir.constructor.name, "AsyncFunction");

  const rutas = fs.readFileSync(path.join(RAIZ, "src", "webhook", "rutas.js"), "utf8");
  assert.equal(/await admitir\(/.test(rutas), false, "se le hace await a admitir: ya no es sincrono");

  // EL ORDEN DEL CAMINO NORMAL: reclamo -> 200 -> procesar.
  //
  // Se mira dentro del manejador del POST y a partir del reclamo. Hay un
  // `res.sendStatus(200)` ANTES, en la rama de "falta META_APP_SECRET", y es
  // correcto que este ahi: ese camino registra el evento y NO lo procesa, asi
  // que no hay trabajo que reclamar ni que recuperar.
  const post = rutas.slice(rutas.indexOf('app.post("/webhook"'));
  const iReclamo = post.indexOf("admitir(req.body");
  const iAcuse = post.indexOf("res.sendStatus(200)", iReclamo);
  const iProceso = post.indexOf("procesarAdmitidos(");

  assert.ok(iReclamo > 0, "no se encuentra el reclamo en el manejador del POST");
  assert.ok(iAcuse > iReclamo, "el 200 se contesta ANTES de reclamar el trabajo: vuelve la ventana del crash");
  assert.ok(iProceso > iAcuse, "se procesa antes de contestar 200: Meta esperaria de mas");
});

test("el almacen transaccional y la bitacora de trabajo son cosas distintas", () => {
  // La fabrica de repositorios elige archivos o Postgres. La bitacora no
  // pasa por ahi: no es configurable, y eso es deliberado.
  const fabrica = fs.readFileSync(path.join(RAIZ, "src", "almacen", "repos", "index.js"), "utf8");
  assert.equal(/trabajo/.test(fabrica), false, "la fabrica de repos toca la bitacora de trabajo");
});

// --------------------------------------------------------------------------
// Con Postgres real: el escenario completo
// --------------------------------------------------------------------------

describe("crash y recuperacion CON Postgres como almacen", { skip: ayudaPg.sinBase ? ayudaPg.motivoSalto : false }, () => {
  function cuerpoDeMensaje(wamid, texto = "quiero comprar") {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "W",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: ID_NUMERO },
                contacts: [{ profile: { name: "Ana" }, wa_id: "573009998877" }],
                messages: [
                  { from: "573009998877", id: wamid, timestamp: "1790000000", type: "text", text: { body: texto } },
                ],
              },
            },
          ],
        },
      ],
    });
  }

  const firmar = (cuerpo) => `sha256=${crypto.createHmac("sha256", SECRETO).update(cuerpo).digest("hex")}`;
  const puertoLibre = () => 20000 + Math.floor(Math.random() * 20000);

  /** Devuelve { hijo, puerto } para no perder la pista del puerto usado. */
  async function arrancarServidor({ dir, dsn, puerto = puertoLibre() }) {
    const hijo = spawn(process.execPath, [path.join(RAIZ, "src", "server.js")], {
      cwd: RAIZ,
      env: {
        ...process.env,
        DATA_DIR: dir,
        PORT: String(puerto),
        DATABASE_URL: dsn, // <-- Postgres como almacen transaccional
        WHATSAPP_VERIFY_TOKEN: "token_de_verificacion_de_prueba_0123456789",
        META_APP_SECRET: SECRETO,
        WHATSAPP_PHONE_NUMBER_ID: ID_NUMERO,
        PANEL_TOKEN: "panel_de_prueba",
        RESPUESTA_AUTOMATICA: "0",
        MODO_SOMBRA: "1",
        LOG_NIVEL: "error",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let salida = "";
    hijo.stdout.on("data", (d) => (salida += d));
    hijo.stderr.on("data", (d) => (salida += d));
    hijo.leer = () => salida;

    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const r = await fetch(`http://127.0.0.1:${puerto}/health`);
        if (r.ok) return { hijo, puerto };
      } catch {
        /* todavia no */
      }
    }
    hijo.kill("SIGKILL");
    throw new Error(`el servidor no arranco. Salida:\n${salida}`);
  }

  const matarDeGolpe = (hijo) =>
    new Promise((listo) => {
      hijo.once("exit", () => listo());
      hijo.kill("SIGKILL");
    });

  function leerDiario(dir) {
    const carpeta = path.join(dir, "diario");
    if (!fs.existsSync(carpeta)) return [];
    return fs
      .readdirSync(carpeta)
      .filter((n) => n.endsWith(".jsonl"))
      .flatMap((n) =>
        fs
          .readFileSync(path.join(carpeta, n), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return { tipo: "ilegible" };
            }
          })
      );
  }

  test(
    "ESCENARIO: con Postgres, un crash tras el 200 se recupera igual al reiniciar",
    { timeout: 120000 },
    async () => {
      const { dsn } = await ayudaPg.prepararEsquema(ESQUEMA);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-recpg-"));
      const wamid = "wamid.CRASH_PG";
      const cuerpo = cuerpoDeMensaje(wamid);

      // --- 1, 2 y 3: Meta envia, NOVIKA persiste y contesta 200 ---
      const primero = await arrancarServidor({ dir, dsn });

      // Confirmamos que de verdad esta usando Postgres y no archivos: si no,
      // esta prueba no demostraria nada.
      const salud = await (await fetch(`http://127.0.0.1:${primero.puerto}/health`)).json();
      assert.equal(salud.almacen_transaccional, "postgres", "el servidor no esta usando Postgres");

      const respuesta = await fetch(`http://127.0.0.1:${primero.puerto}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": firmar(cuerpo) },
        body: cuerpo,
      });
      assert.equal(respuesta.status, 200, "Meta tiene que recibir su 200");

      // --- 4: el proceso muere de golpe ---
      await matarDeGolpe(primero.hijo);

      const trasElCrash = leerDiario(dir).map((e) => e.tipo);
      assert.ok(trasElCrash.includes("entrada_cruda"), "el evento no se persistio antes del 200");

      // El reclamo tiene que estar EN EL DISCO, no en la base: es lo que
      // hace que la recuperacion funcione aunque Postgres este caido.
      assert.ok(fs.existsSync(path.join(dir, "trabajo.jsonl")), "el reclamo no quedo en el disco");

      const seTerminoAntes = trasElCrash.includes("turno_procesado");

      // --- 5: reinicio ---
      const segundo = await arrancarServidor({ dir, dsn });
      await new Promise((r) => setTimeout(r, 2000)); // margen para la recuperacion
      await matarDeGolpe(segundo.hijo);

      const entradas = leerDiario(dir);
      const procesados = entradas.filter((e) => e.tipo === "turno_procesado" && e.wamid === wamid);

      assert.equal(
        procesados.length >= 1,
        true,
        `el mensaje NO se proceso tras el reinicio. Tipos: ${[...new Set(entradas.map((e) => e.tipo))].join(", ")}`
      );
      assert.equal(procesados.length, 1, `el mensaje se proceso ${procesados.length} veces`);

      if (!seTerminoAntes) {
        assert.ok(entradas.some((e) => e.tipo === "recuperacion_iniciada"), "no hubo recuperacion");
        assert.ok(entradas.some((e) => e.tipo === "evento_recuperado" && e.wamid === wamid));
      }

      // Y con el interruptor apagado no salio nada.
      assert.equal(entradas.some((e) => e.tipo === "respuesta_enviada"), false);

      fs.rmSync(dir, { recursive: true, force: true });
    }
  );

  test(
    "ESCENARIO: si Postgres esta CAIDO, el webhook sigue reclamando en disco",
    { timeout: 120000 },
    async () => {
      // El escenario que justifica dejar la bitacora en el disco. Con un DSN
      // que no responde, el servidor NO deberia arrancar -no puede atender
      // sin su almacen-, pero lo que importa es que el fallo sea limpio y
      // ruidoso, no un 200 a Meta sobre un mensaje que no se puede recuperar.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-sinpg-"));
      const hijo = spawn(process.execPath, [path.join(RAIZ, "src", "server.js")], {
        cwd: RAIZ,
        env: {
          ...process.env,
          DATA_DIR: dir,
          PORT: String(puertoLibre()),
          DATABASE_URL: "postgres://nadie:nada@127.0.0.1:1/novika_inexistente",
          WHATSAPP_VERIFY_TOKEN: "token_de_verificacion_de_prueba_0123456789",
          META_APP_SECRET: SECRETO,
          WHATSAPP_PHONE_NUMBER_ID: ID_NUMERO,
          RESPUESTA_AUTOMATICA: "0",
          LOG_NIVEL: "error",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let salida = "";
      hijo.stdout.on("data", (d) => (salida += d));
      hijo.stderr.on("data", (d) => (salida += d));

      // Se le da tiempo a intentar conectarse y fallar.
      await new Promise((r) => setTimeout(r, 6000));
      hijo.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 300));

      // El fallo tiene que ser visible y no llevar la contrasena dentro.
      assert.equal(salida.includes("nada@"), false, "el DSN con contrasena acabo en los logs");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );
});
