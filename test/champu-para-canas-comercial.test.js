"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearEmisor } = require("../src/whatsapp/enviar");
const { cargarCatalogo } = require("../src/catalogo");
const responder = require("../src/cerebro/responder");
const mutex = require("../src/almacen/mutex");

const RAIZ = path.join(__dirname, "..");
const catalogoReal = () => cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true });
const champu = () => catalogoReal().porId.get("champu-para-canas");

let SEQ = 0;

async function chatChampu() {
  mutex._reiniciar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-champu-test-"));
  const repos = await crearReposDeArchivos({ dir });
  const cfg = {
    ...config,
    respuestaAutomatica: true,
    whatsappToken: "token-de-prueba",
    idNumero: "000",
    urlPublica: "https://pruebas.invalido",
  };
  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    fetchImpl: async (_url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.CH${salidas.length}` }] }) };
    },
  });
  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: catalogoReal(),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  const dice = async (texto) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: `wamid.CH${++SEQ}_${process.pid}_${Date.now()}`,
      idCliente: "573001239999",
      telefono: "573001239999",
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });
    return {
      traza,
      texto: salidas.filter((s) => s.type === "text").map((s) => s.text.body).join(" "),
      fotos: salidas.filter((s) => s.type === "image").length,
    };
  };

  return { dice };
}

describe("Champú Cubre Canas Dexe - Respuestas autorizadas y cero fugas", () => {
  test("reconoce el producto desde el primer mensaje de interés en champú", async () => {
    const { dice } = await chatChampu();
    const r = await dice("Hola, quiero información del champú para canas");
    assert.equal(r.traza.producto.productoId, "champu-para-canas");
    assert.match(r.texto, /cubre las canas/i);
    assert.match(r.texto, /89\.000/);
    assert.match(r.texto, /119\.000/);
    assert.match(r.texto, /59\.900/);
    assert.equal(/cintur[oó]n|c[oó]lico|abdomen/i.test(r.texto), false, `Fuga del cinturón: ${r.texto}`);
  });

  test("¿qué combos manejan? responde con la tabla autorizada de 1, 2 y 3 cajas", async () => {
    const { dice } = await chatChampu();
    await dice("Hola, me interesa el champú dexe");
    const r = await dice("¿Qué combos manejan o si llevo más?");
    assert.match(r.texto, /59\.900/);
    assert.match(r.texto, /89\.000/);
    assert.match(r.texto, /119\.000/);
    assert.match(r.texto, /10 sobres|20 sobres|30 sobres/i);
    assert.equal(/descuento especial autom[aá]ticamente/i.test(r.texto), false, "Alucinó descuento genérico");
    assert.equal(/cintur[oó]n|c[oó]lico/i.test(r.texto), false, `Fuga del cinturón: ${r.texto}`);
  });

  test("¿cuánto mide o qué talla es? responde con la presentación en sobres y NO con contorno", async () => {
    const { dice } = await chatChampu();
    await dice("Hola, quiero el champú para canas");
    const r = await dice("¿Cuánto mide o qué talla es?");
    assert.match(r.texto, /sobres|25\s*ml|guantes/i);
    assert.equal(/contorno|correa|graduable|cintura|el[aá]stica|130 a 150/i.test(r.texto), false, `Fuga de medidas de faja: ${r.texto}`);
  });

  test("¿sirve para la espalda? responde con franqueza que es para cabello y barba", async () => {
    const { dice } = await chatChampu();
    await dice("Hola, quiero el champú");
    const r = await dice("¿Sirve para la espalda?");
    assert.match(r.texto, /cabello|barba/i);
    assert.match(r.texto, /no es para la espalda|no es para el cuerpo/i);
    assert.equal(/¡s[íi]!\s+sirve\s+para/i.test(r.texto), false, `Dijo que sí servía para la espalda: ${r.texto}`);
  });

  test("¿cómo se limpia o cuida? responde sobre almacenaje en lugar fresco, no sobre panel de control", async () => {
    const { dice } = await chatChampu();
    await dice("Hola, el champú cubre canas");
    const r = await dice("¿Cómo se debe cuidar o limpiar?");
    assert.match(r.texto, /lugar fresco|seco|sellado/i);
    assert.equal(/no se moja|panel de control|daños por mojarlo/i.test(r.texto), false, `Fuga de panel de control: ${r.texto}`);
  });

  test("¿se apaga solo o usa batería? responde que no es aparato eléctrico", async () => {
    const { dice } = await chatChampu();
    await dice("Hola, quiero el champú dexe");
    const r = await dice("¿Trae cargador o tiene apagado automático?");
    assert.match(r.texto, /no es (un )?aparato el[eé]ctrico|no usa bater[íi]a/i);
    assert.equal(/cable|cargador usb|bot[oó]n para prender/i.test(r.texto), false, `Fuga eléctrica: ${r.texto}`);
  });

  test("¿quema o tiene contraindicaciones? responde con fórmula herbal suave", async () => {
    const { dice } = await chatChampu();
    await dice("Hola, del champú para canas");
    const r = await dice("¿Eso quema la piel?");
    assert.match(r.texto, /no quema|f[oó]rmula herbal/i);
    assert.match(r.texto, /guantes/i);
    assert.equal(/60\s*°C|nivel de calor/i.test(r.texto), false, `Fuga de temperatura: ${r.texto}`);
  });

  test("¿cuánto dura el efecto del champú? responde con 3-4 semanas y puente a combos", async () => {
    const { dice } = await chatChampu();
    const r = await dice("¿Cuánto dura el efecto del champú?");
    assert.match(r.texto, /3 y 4 semanas|semanas/i);
    assert.match(r.texto, /89\.000/);
    assert.match(r.texto, /119\.000/);
    assert.match(r.texto, /ciudad/i);
  });

  test("con cinturón inactivo, un pedido genérico ('¿Cómo puedo realizar mi pedido?') no pregunta qué producto", async () => {
    const { dice } = await chatChampu();
    const r = await dice("¿Cómo puedo realizar mi pedido por WhatsApp?");
    assert.equal(/qu[eé] producto te interesa/i.test(r.texto), false, `Preguntó qué producto quería: ${r.texto}`);
    assert.equal(/cintur[oó]n|c[oó]lico/i.test(r.texto), false, `Fuga de cinturón: ${r.texto}`);
  });
});

