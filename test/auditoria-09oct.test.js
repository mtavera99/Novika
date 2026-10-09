"use strict";

// ==========================================================================
// LA AUDITORÍA DEL 2026-10-09 · 33 CHATS, 0 PEDIDOS
//
// Marco abrió esta sesión con un dato y una queja:
//
//   «llevamos casi 36 horas tratando de que el bot quede bien configurado»
//   «a veces no sabe qué decir, o me tira a contacto humano con cualquier
//    pregunta — y la idea de un bot es que pueda vender»
//
// Se auditó el panel de producción chat por chat. El dato que importaba
// estaba en /panel/indicadores: **33 conversaciones, 0 pedidos, 0 % de
// cierre**, con una campaña de Facebook encendida pagando cada uno de esos
// chats.
//
// Y una pista falsa: el embudo decía que los 33 se caían en la PRIMERA
// etapa. Era un defecto de medición (ver test/panel-despacho-analitica).
// El agujero real estaba en la conversación.
//
// --------------------------------------------------------------------------
// LA CAUSA RAÍZ, Y NO ERA DE TONO
// --------------------------------------------------------------------------
//
// `NEGACIONES` tenía un `/^no\b/`. El `\b` cierra en el espacio, así que
// casaba con CUALQUIER mensaje que empezara por "no". En un WhatsApp
// colombiano eso es media bandeja:
//
//   "No habría manera de que llegue hoy?"   una clienta con prisa
//   "No entiendo"                            alguien perdido
//   "No cargaron"                            las fotos no le llegaron
//   "no me alcanza"                          la objeción más común
//   "no confío en estas páginas"             la objeción de confianza
//   "no me ha llegado"                       posventa
//
// Los seis se clasificaban como NO → acción CANCELAR. Y como ninguno tenía
// un pedido que cancelar, `cancelarPedido` devolvía `cancelado:false`, el
// turno acababa en `situacion = "escalado"` y **el bot se pausaba 12 horas**.
//
// El cliente recibía "esto lo reviso con una persona del equipo" y después
// silencio. Tres conversaciones del 08-oct murieron exactamente así; dos las
// rescató una persona a mano, hora y media después.
//
// --------------------------------------------------------------------------
// Y LO QUE SÍ TENÍA QUE ESCALAR, NO ESCALABA
// --------------------------------------------------------------------------
//
// Medido con el código de producción:
//
//   "quiero hablar con una persona"
//     → "¡Perfecto, gracias! Para preparar tu pedido me pasas la ciudad…"
//   "me llegó dañado, quiero la garantía"
//     → "¡Claro que sí! Tiene 1 mes de garantía, así que compras con
//        tranquilidad. ¡Perfecto! Para preparar tu pedido me pasas…"
//   "esto es un robo, son unos estafadores, los voy a denunciar"
//     → "¡Perfecto, gracias! Para preparar tu pedido me pasas…"
//
// Le vendía la garantía a quien la estaba RECLAMANDO. Estaba exactamente al
// revés de lo que pidió Marco.
//
// Cada bloque de abajo fija uno de esos comportamientos. Si alguien vuelve a
// meter un patrón `^no` + cualquier cosa, o vuelve a dejar que una duda sin
// dato pause el bot, esto falla.
// ==========================================================================

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
const atencion = require("../src/almacen/atencion");
const mutex = require("../src/almacen/mutex");

const preguntas = require("../src/dominio/preguntas");
const { TEMAS } = preguntas;
const confirmacion = require("../src/dominio/confirmacion");
const estados = require("../src/dominio/estados");
const extraer = require("../src/dominio/extraer");
const destino = require("../src/dominio/destino");
const contestar = require("../src/cerebro/contestar");
const responder = require("../src/cerebro/responder");
const cotizador = require("../src/dominio/cotizador");

const RAIZ = path.join(__dirname, "..");
const CLIENTE = "573001112233";
const ANUNCIO = "Hola, quiero información sobre el cinturón térmico de $49.900.";

const elCinturon = () =>
  cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }).porId.get(
    "cinturon-termico-colicos"
  );

let SEQ = 0;
const wamidUnico = () => `wamid.A${++SEQ}_${process.pid}_${Date.now()}`;

/**
 * Una conversación contra el cerebro de verdad.
 *
 * ⚠️ EL EMISOR LLEVA `atencion`, COMO EN PRODUCCIÓN (ver cerebro/index.js).
 *
 * Sin eso el emisor no comprueba la pausa, y la pausa es justo el síntoma
 * que hay que vigilar aquí: el resto de los arneses del repositorio no la
 * pasan, así que el silencio de 12 h era invisible en local y solo se veía
 * en el panel de producción.
 */
async function conversacion({ nombrePerfil = null } = {}) {
  mutex._reiniciar();
  const repos = await crearReposDeArchivos({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "novika-aud-")) });
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
    atencion,
    fetchImpl: async (url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.E${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true }),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  const dice = async (texto) => {
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: wamidUnico(),
      idCliente: CLIENTE,
      telefono: CLIENTE,
      nombre: nombrePerfil,
      tipo: "text",
      texto,
      origenTexto: "escrito",
      referral: null,
    });
    const conv = await repos.conversaciones.obtener(CLIENTE);
    return {
      traza,
      // Lo que SALIÓ de verdad. Si la pausa muerde, esto queda vacío.
      enviado: salidas
        .filter((s) => s.type === "text")
        .map((s) => s.text.body)
        .join(" "),
      // Lo que se preparó, enviado o no.
      preparado: (traza && traza.respuesta && traza.respuesta.texto) || "",
      pausado: atencion.leer(conv || {}).pausado === true,
      conversacion: conv,
    };
  };

  const pedidos = async () => {
    const l = await repos.pedidos.listar({ limite: 20 });
    return Array.isArray(l) ? l : l.filas || [];
  };

  return { dice, pedidos, repos };
}

// --------------------------------------------------------------------------
// 1 · EL "no" QUE SILENCIABA EL BOT
// --------------------------------------------------------------------------

describe("1 · un mensaje que empieza por «no» no es una cancelación", () => {
  // Los seis son mensajes reales o formas normalísimas de escribir. Ninguno
  // cancela nada: cinco son dudas y una es una objeción.
  const NO_SON_CANCELACION = [
    "No habría manera de que llegue hoy?",
    "No entiendo",
    "No cargaron",
    "no me alcanza",
    "no confío en estas páginas",
    "no me ha llegado",
    "No es muy caro?",
    "no sé si me sirve",
    "no tengo efectivo ahorita",
  ];

  test("ninguno se clasifica como NO", () => {
    for (const texto of NO_SON_CANCELACION) {
      const d = confirmacion.evaluar({ texto, estado: estados.ESTADOS.CAPTURANDO_DATOS, resumenMostrado: false });
      assert.notEqual(
        d.clase,
        confirmacion.CLASES.NO,
        `"${texto}" se leyó como una negación: eso pausaba el bot 12 h`
      );
      assert.notEqual(d.accion, confirmacion.ACCIONES.CANCELAR, `"${texto}" pedía CANCELAR`);
    }
  });

  test("pero un «no» de verdad sigue siendo un no", () => {
    // El arreglo no puede dejar de reconocer las negaciones reales: eso
    // crearía el defecto opuesto, seguir vendiendo a quien dijo que no.
    for (const texto of [
      "no",
      "No.",
      "no gracias",
      "no, muchas gracias",
      "no quiero",
      "no me interesa",
      "ya no",
      "mejor no",
      "cancelar",
      "no por ahora",
    ]) {
      const d = confirmacion.evaluar({ texto, estado: estados.ESTADOS.CAPTURANDO_DATOS, resumenMostrado: false });
      assert.equal(d.clase, confirmacion.CLASES.NO, `"${texto}" tenía que leerse como negación`);
    }
  });

  test("y en la conversación real el bot NO se calla", async () => {
    // La prueba que de verdad protege la plata: que después de un mensaje
    // así el bot siga atendiendo. Antes se pausaba y el cliente se perdía.
    for (const texto of ["No habría manera de que llegue hoy?", "No entiendo", "no me alcanza"]) {
      const c = await conversacion();
      await c.dice(ANUNCIO);
      const r = await c.dice(texto);

      assert.equal(r.pausado, false, `"${texto}" pausó el bot`);
      assert.ok(r.enviado, `"${texto}" dejó al cliente sin respuesta`);

      // Y el turno siguiente se atiende: el silencio empezaba justo aquí.
      const sigue = await c.dice("cuánto vale?");
      assert.match(sigue.enviado, /49\.900/, `tras "${texto}" el bot dejó de contestar el precio`);
    }
  });

  test("declinar sin pedido se cierra con calidez y sin escalar", async () => {
    const c = await conversacion();
    await c.dice(ANUNCIO);
    const r = await c.dice("no gracias");

    assert.equal(r.traza.respuesta.situacion, "declina");
    assert.equal(r.pausado, false, "declinar no puede pausar el bot");
    assert.equal(/una persona del equipo/i.test(r.enviado), false, `no hay nada que escalar: ${r.enviado}`);
    // No se le pide ni un dato a quien acaba de decir que no.
    assert.equal(/me pasas/i.test(r.enviado), false, `le pidió datos tras un "no": ${r.enviado}`);

    // Y la puerta queda abierta: en contraentrega el "no por ahora" se
    // convierte en compra con mucha frecuencia.
    const vuelve = await c.dice("bueno, listo, lo quiero");
    assert.match(vuelve.enviado, /me pasas/i, "tras declinar, el cliente ya no podía comprar");
  });
});

// --------------------------------------------------------------------------
// 2 · LAS TRES RAZONES QUE SÍ LLEVAN A UNA PERSONA
// --------------------------------------------------------------------------

describe("2 · lo que sí tiene que atender una persona", () => {
  test("pide hablar con alguien: se le pasa, sin discutir", async () => {
    const c = await conversacion();
    await c.dice(ANUNCIO);
    const r = await c.dice("quiero hablar con una persona");

    assert.equal(r.traza.motivoEscalado, "pidio_una_persona");
    assert.match(r.enviado, /persona del equipo/i);
    // Y NO se le pide un dato de entrega: era lo que recibía antes.
    assert.equal(/me pasas/i.test(r.enviado), false, `ignoró la petición y pidió datos: ${r.enviado}`);
  });

  test("un reclamo de garantía NO se contesta vendiendo la garantía", async () => {
    // El peor de los tres. Recibía: "¡Claro que sí! Tiene 1 mes de garantía,
    // así que compras con tranquilidad. ¡Perfecto! Para preparar tu pedido
    // me pasas la ciudad y la dirección."
    const c = await conversacion();
    await c.dice(ANUNCIO);
    const r = await c.dice("me llegó dañado, quiero la garantía");

    assert.equal(r.traza.motivoEscalado, "reclamo_de_garantia");
    assert.equal(
      /compras con tranquilidad/i.test(r.enviado),
      false,
      `le vendió la garantía a quien la reclama: ${r.enviado}`
    );
    assert.equal(/me pasas/i.test(r.enviado), false, `le pidió datos a quien ya recibió el pedido: ${r.enviado}`);
    assert.match(r.enviado, /persona del equipo/i, "un reclamo lo gestiona una persona");

    // Y queda tarea: prometerlo sin anotarlo es dejar al cliente esperando.
    assert.equal(atencion.pendienteDe(r.conversacion).hay, true, "el reclamo no dejó tarea");
  });

  test("un cliente molesto no recibe un argumento de venta", async () => {
    const c = await conversacion();
    await c.dice(ANUNCIO);
    const r = await c.dice("esto es un robo, son unos estafadores, los voy a denunciar");

    assert.equal(r.traza.motivoEscalado, "cliente_molesto");
    assert.equal(/me pasas|te lo aparto|49\.900/i.test(r.enviado), false, `siguió vendiendo: ${r.enviado}`);
    assert.match(r.enviado, /persona del equipo/i);
  });

  test("«¿será estafa?» NO es un cliente molesto: es una objeción que se vende", () => {
    // La distinción que mantiene separados los dos casos. Quien pregunta si
    // será estafa todavía no ha comprado: es desconfianza, y se rebate con
    // el contraentrega. Confundirlo con enfado perdería la venta.
    const l = preguntas.leer("esto es real o será estafa?");
    assert.equal(l.estaMolesto, false, "una duda de confianza no es enfado");
    assert.ok(l.temas.includes(TEMAS.CONFIANZA));

    const t = contestar.deTema(TEMAS.CONFIANZA, { producto: elCinturon() });
    assert.match(t, /no arriesgas nada|pagas cuando/i, `la confianza se rebate con el contraentrega: ${t}`);
  });

  test("«y si no me funciona?» tampoco es un reclamo", () => {
    // Condicional = miedo antes de comprar. Indicativo = algo roto.
    assert.equal(preguntas.leer("y si no me funciona?").reclamaGarantia, false);
    assert.equal(preguntas.leer("no me funciona").reclamaGarantia, true);
  });
});

// --------------------------------------------------------------------------
// 3 · LAS PREGUNTAS QUE EL BOT NO SABÍA CONTESTAR
// --------------------------------------------------------------------------

describe("3 · 22 de 65 preguntas reales caían en el camino genérico", () => {
  // Cada una recibía: "Esa no te la quiero contestar a medias. La dejo
  // anotada para el equipo: una persona la revisa y te responde por aquí."
  //
  // No faltaba el dato: faltaba el TEMA. El detector no las reconocía, así
  // que ni siquiera llegaba a mirar si el catálogo tenía la respuesta.
  const RECONOCIBLES = [
    ["se puede lavar?", TEMAS.CUIDADO],
    ["me lo puedo poner dormida toda la noche?", TEMAS.SEGURIDAD],
    ["sirve si estoy embarazada?", TEMAS.CONTRAINDICACION],
    ["a cuántos grados llega?", TEMAS.TEMPERATURA],
    ["es original?", TEMAS.MARCA],
    ["viene en caja?", TEMAS.EMPAQUE],
    ["dan factura?", TEMAS.FACTURA],
    ["venden al por mayor?", TEMAS.MAYORISTA],
    ["a qué hora atienden?", TEMAS.HORARIO],
    ["me pueden llamar?", TEMAS.CANAL],
    ["sirve para una niña de 13 años?", TEMAS.DESTINATARIO],
    ["qué diferencia tiene con una bolsa de agua caliente?", TEMAS.COMPARATIVA],
    ["llega a una vereda?", TEMAS.COBERTURA],
    ["tienen otro modelo?", TEMAS.OTRO_MODELO],
    ["En qué ciudad", TEMAS.UBICACION],
    ["tienen tienda física?", TEMAS.UBICACION],
    ["y si no me funciona?", TEMAS.SI_NO_FUNCIONA],
  ];

  test("todas tienen tema", () => {
    for (const [texto, tema] of RECONOCIBLES) {
      const l = preguntas.leer(texto);
      assert.ok(l.temas.includes(tema), `"${texto}" no se reconoce como ${tema}: temas=${JSON.stringify(l.temas)}`);
    }
  });

  test("todas tienen respuesta, y ninguna es el muro genérico", () => {
    for (const [texto, tema] of RECONOCIBLES) {
      const t = contestar.deTema(tema, {
        producto: elCinturon(),
        cotizacion: cotizador.cotizar({ producto: elCinturon(), cantidad: 1 }).cotizacion,
      });
      assert.ok(t, `el tema ${tema} ("${texto}") no tiene respuesta`);
      assert.equal(
        /esa no te la quiero contestar/i.test(t),
        false,
        `${tema} sigue cayendo en el muro genérico: ${t}`
      );
    }
  });

  test("y NINGUNA afirma nada prohibido por la ficha", () => {
    // ⚠️ LA PRUEBA QUE MÁS PROTEGE DE AQUÍ.
    //
    // Se investigaron fichas de otros vendedores del mismo producto para
    // entender qué pregunta la gente. Nada de lo que dicen -3 niveles de
    // calor, infrarrojos, calienta en 3 segundos, batería recargable- puede
    // acabar en una respuesta: no lo autorizó esta marca, y si el bot lo
    // afirma y llega otra cosa, la devolución es nuestra.
    //
    // Y es un producto que se compra por dolor: el riesgo no es exagerar el
    // precio, es una promesa médica.
    const producto = elCinturon();
    for (const tema of Object.values(TEMAS)) {
      const t = contestar.deTema(tema, {
        producto,
        cotizacion: cotizador.cotizar({ producto, cantidad: 1 }).cotizacion,
      });
      if (!t) continue;
      const v = responder.revisarClaims(t, producto);
      assert.equal(v.ok, true, `la respuesta de ${tema} afirma algo prohibido (${JSON.stringify(v)}): ${t}`);
    }
  });

  test("el embarazo se deriva al médico, y NO se dice que sirve", () => {
    const t = contestar.deTema(TEMAS.CONTRAINDICACION, { producto: elCinturon() });
    assert.match(t, /m[ée]dico/i, `tiene que derivar al médico: ${t}`);
    assert.equal(/claro que s[íi]|s[íi], (sirve|es apto)/i.test(t), false, `insinuó que sirve: ${t}`);
  });

  test("el lavado sale de la ficha, no de una suposición", () => {
    // `garantiaNoCubre` incluye "mojarlo". Eso convierte una pregunta sin
    // respuesta en un dato útil Y en un aviso que conviene dar ANTES.
    const t = contestar.deTema(TEMAS.CUIDADO, { producto: elCinturon() });
    assert.match(t, /no se moja|mojarlo/i, t);
    assert.equal(/es lavable|se puede lavar en/i.test(t), false, `afirmó que se lava: ${t}`);
  });

  test("la cobertura usa el dato que SÍ está confirmado", () => {
    // La nota de la ficha es explícita: Marco dijo "envío incluido" sin
    // acotar ciudades, así que para la clienta no hay riesgo en ningún
    // destino. Fuera de las capitales es el argumento que más vende.
    const t = contestar.deTema(TEMAS.COBERTURA, { producto: elCinturon() });
    assert.match(t, /todo el pa[íi]s/i, t);
    assert.match(t, /incluido/i, t);
  });

  test("DESTINATARIO habla de quién RECIBE, no de a quién le queda", () => {
    // ⚠️ ESTA PRUEBA CAMBIO DE OBJETO EL 2026-10-09, Y POR UN DEFECTO REAL.
    //
    // Pedia que DESTINATARIO -"¿lo puede recibir mi mamá?"- hablara del
    // ajuste ("graduable|talla única") sin prometer que le queda a
    // cualquiera. Y eso era el defecto, no la proteccion: a quien pregunta
    // quién puede RECIBIR el paquete se le estaba contestando por la TALLA.
    // Son dos cosas distintas —quien USA es talla, quien RECIBE es
    // logistica— y mezclarlas deja la pregunta sin contestar.
    //
    // Asi que ahora se exige lo correcto: que conteste de la entrega. La
    // talla se comprueba en MEDIDAS, que es su tema.
    const t = contestar.deTema(TEMAS.DESTINATARIO, { producto: elCinturon() });
    assert.match(t, /recibir|dirección|nombre/i, t);
    assert.equal(/talla|contorno|graduable|cm\b/i.test(t), false, `contestó por la talla a quien preguntó por la entrega: ${t}`);
  });

  test("MEDIDAS da la medida confirmada sin prometer ajuste universal", () => {
    // La otra mitad de lo de arriba: el dato de ajuste vive aqui, y desde
    // el parche 4 existe. Lo que sigue prohibido es la frase facil.
    const t = contestar.deTema(TEMAS.MEDIDAS, { producto: elCinturon() });
    assert.match(t, /130 a 150 cm/, t);
    assert.match(t, /graduable/i, "se perdió la palabra que tranquiliza a quien pregunta «¿me queda?»");
    assert.equal(/cualquier (contorno|cintura|talla)|a cualquiera|a todas/i.test(t), false, t);
  });
});

// --------------------------------------------------------------------------
// 4 · TRES ENRUTAMIENTOS QUE CONTESTABAN OTRA COSA
// --------------------------------------------------------------------------

describe("4 · el tema correcto, no el que casó primero", () => {
  test("«No cargaron» habla de FOTOS, no de la batería", () => {
    // `carga\w*` casaba "cargaron". Del chat de Marco: el bot le habló de
    // la batería a quien le decía que las fotos no le llegaron, y además
    // escaló.
    const l = preguntas.leer("No cargaron");
    assert.equal(l.temas.includes(TEMAS.ENERGIA), false, `"No cargaron" marcó ENERGIA: ${JSON.stringify(l.temas)}`);
  });

  test("pero preguntar por el cargador SÍ es energía", () => {
    for (const t of ["Trae cargador", "es recargable?", "con cables para cargar", "funciona con batería?"]) {
      assert.ok(preguntas.leer(t).temas.includes(TEMAS.ENERGIA), `"${t}" dejó de ser ENERGIA`);
    }
  });

  test("«cuánto demora en calentar» NO es el plazo de la transportadora", () => {
    const l = preguntas.leer("cuánto se demora en calentar?");
    assert.ok(l.temas.includes(TEMAS.TEMPERATURA));
    assert.equal(l.temas.includes(TEMAS.ENTREGA), false, "contestó el plazo de la transportadora");
  });

  test("«viene en caja» no es una pregunta de color", () => {
    const l = preguntas.leer("viene en caja? es para un regalo");
    assert.ok(l.temas.includes(TEMAS.EMPAQUE));
    assert.equal(l.temas.includes(TEMAS.COLOR), false);
  });

  test("«¿no habría manera de que llegue hoy?» es una pregunta de entrega", () => {
    // El cliente más caliente que entra: tiene el cólico HOY. Recibió el
    // silencio de 12 h. La respuesta honesta es el rango de la ficha.
    const l = preguntas.leer("No habría manera de que llegue hoy?");
    assert.ok(l.temas.includes(TEMAS.ENTREGA), `temas=${JSON.stringify(l.temas)}`);

    const t = contestar.deTema(TEMAS.ENTREGA, { producto: elCinturon() });
    assert.match(t, /1 a 3 d[íi]as/i, t);
    // Y jamás un día concreto: está en claimsProhibidos frase por frase.
    assert.equal(/hoy|mañana/i.test(t), false, `prometió un día: ${t}`);
  });

  test("«¿hay descuento por mayor?» es un lead mayorista, no la escalera", () => {
    const l = preguntas.leer("hay descuento por mayor?");
    assert.ok(l.temas.includes(TEMAS.MAYORISTA));
    assert.equal(l.temas.includes(TEMAS.OBJECION_PRECIO), false);
  });
});

// --------------------------------------------------------------------------
// 5 · LA ESCALERA DE PRECIO ES UNA ESCALERA
// --------------------------------------------------------------------------

describe("5 · objetar el precio cuatro veces no recibe el mismo párrafo", () => {
  test("los escalones son distintos", () => {
    const producto = elCinturon();
    const cot = cotizador.cotizar({ producto, cantidad: 1 }).cotizacion;
    const paso = (vez) => contestar.deTema(TEMAS.OBJECION_PRECIO, { producto, cotizacion: cot, vezDeLaObjecion: vez });

    const uno = paso(1);
    const dos = paso(2);
    const tres = paso(3);

    assert.notEqual(uno, dos, "la segunda objeción recibía el mismo párrafo palabra por palabra");
    assert.notEqual(dos, tres);

    // El primer escalón son los dos argumentos que no cuestan plata.
    assert.match(uno, /env[íi]o ya va incluido/i, uno);
    assert.match(uno, /no arriesgas nada/i, uno);
    // El tercero es una persona, nunca una cifra nueva.
    assert.match(tres, /persona del equipo/i, tres);
  });

  test("a «no me alcanza» no se le ofrece gastar más de entrada", () => {
    // Era la respuesta real: «si llevas dos, te quedan en $85.000». A quien
    // acaba de decir que no le alcanza. Es la respuesta más sorda posible.
    const t = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizador.cotizar({ producto: elCinturon(), cantidad: 1 }).cotizacion,
      faltan: ["nombre", "direccion"],
      producto: elCinturon(),
      mensajeCliente: "no me alcanza",
      vezDeLaObjecion: 1,
      memoria: { saludado: true, precioInformado: true },
    });
    assert.match(t, /env[íi]o ya va incluido|no arriesgas nada/i, `no dio los argumentos que no cuestan plata: ${t}`);
  });

  test("NUNCA un descuento, en ningún escalón", () => {
    // NOVIKA no tiene política de descuento aprobada y el catálogo declara
    // "si hay descuento por cantidad" como dato NO confirmado. En BIKERPRO
    // el bot se inventó "$55.900 con pago anticipado" en la primera
    // objeción; ese riesgo estaba tasado en ~$482.400/mes.
    const producto = elCinturon();
    const cot = cotizador.cotizar({ producto, cantidad: 1 }).cotizacion;
    const PROHIBIDO =
      /te (hago|doy) (un )?descuento|te (rebajo|bajo)|te lo dejo en|precio especial|pago anticipado|te regalo/i;

    for (const vez of [1, 2, 3, 4, 5]) {
      const t = contestar.deTema(TEMAS.OBJECION_PRECIO, { producto, cotizacion: cot, vezDeLaObjecion: vez });
      if (!t) continue;
      assert.equal(PROHIBIDO.test(t), false, `escalón ${vez} ofreció una rebaja: ${t}`);
    }
  });

  test("y el bot sigue vivo después de tres objeciones", async () => {
    const c = await conversacion();
    await c.dice(ANUNCIO);
    await c.dice("está muy caro");
    await c.dice("no me alcanza");
    const tercera = await c.dice("me lo dejas más barato?");
    assert.equal(tercera.pausado, false, "la objeción de precio pausó el bot");

    const cierra = await c.dice("bueno dale, lo quiero");
    assert.match(cierra.enviado, /me pasas/i, "tras objetar tres veces ya no podía comprar");
  });
});

// --------------------------------------------------------------------------
// 6 · LOS CUATRO DATOS QUE EL BOT PEDÍA Y LUEGO TIRABA
// --------------------------------------------------------------------------

describe("6 · los datos que se perdían", () => {
  test("«Barrio buenos aires» es una dirección", () => {
    // Había DOS candados en serie rechazándola, mientras el propio bot le
    // pedía *«dime el barrio y, si tienes, la calle con el número, o un
    // punto de referencia»*. Pedía el barrio y no lo aceptaba.
    assert.ok(extraer.direccionEn("Barrio buenos aires").valor, "el extractor la tira");
    const v = destino.validarDireccion("Barrio buenos aires");
    assert.equal(v.ok, true, `la validación la tira: ${v.motivo}`);
    // Aceptada, pero MARCADA: una persona confirma el punto de referencia
    // antes de generar la guía.
    assert.equal(v.revisar, true, "una zona sin nomenclatura tiene que quedar marcada");
  });

  test("pero «mi casa» y «barrio» a secas siguen fuera", () => {
    for (const malo of ["mi casa", "barrio", "vivo en el barrio", "por aca"]) {
      const r = extraer.direccionEn(malo);
      assert.equal(r.valor, null, `"${malo}" pasó como dirección`);
    }
  });

  test("«San andres de sotavento» NO es «San Andres»", () => {
    // ⚠️ CASI-INCIDENTE DE DESPACHO: el archipiélago está a 700 km de
    //    Córdoba y con flete aéreo.
    const c = extraer.ciudadEn("San andres de sotavento Córdoba");
    assert.equal(c.valor, "san andres de sotavento", `se quedó con "${c.valor}"`);

    const r = destino.resolverCiudad(c.valor);
    assert.equal(r.departamento, "Córdoba", `resolvió el departamento como "${r.departamento}"`);
  });

  test("un nombre corto no se come uno compuesto, aunque no esté en la semilla", () => {
    // La regla general, que es la que protege los mil municipios que la
    // semilla no tiene. "Santa Cruz" no está, pero tampoco puede ganarle a
    // "Santa Cruz de Lorica".
    const c = extraer.ciudadEn("vivo en san andres de providencia");
    assert.equal(c.valor, "san andres de providencia", `se quedó con "${c.valor}"`);
  });

  test("«1 a Bogotá» dice la cantidad Y la ciudad", () => {
    // El cliente tuvo que decir la cantidad tres veces.
    assert.equal(extraer.cantidadEn("1 a Bogotá").valor, 1);
    assert.equal(extraer.ciudadEn("1 a Bogotá").valor, "bogota");
    assert.equal(extraer.cantidadEn("2 para Cali").valor, 2);
  });

  test("y «calle 45» sigue sin ser 45 unidades", () => {
    // El candado que no se puede aflojar al arreglar lo de arriba.
    for (const d of ["vivo en la calle 45", "Calle 45 # 23-10, Palmira", "cra 7 # 12-34"]) {
      assert.equal(extraer.cantidadEn(d).valor, null, `"${d}" se leyó como una cantidad`);
    }
  });

  test("el nombre a secas vale SOLO si se le acaba de pedir", () => {
    // Sin la condición, "Buenos Aires" o "Interapidisimo" se leerían como
    // nombres de persona.
    assert.equal(extraer.nombreEn("Mauricio Benítez").valor, null, "sin pedirlo no se puede suponer");
    assert.equal(extraer.nombreEn("Mauricio Benítez", { seLoPidieron: true }).valor, "Mauricio Benítez");

    // Y ni una ciudad, ni una dirección, ni algo con cifras.
    for (const noEsNombre of ["Popayán", "Calle 45 # 23-10", "3058742138", "quiero dos"]) {
      assert.equal(
        extraer.nombreEn(noEsNombre, { seLoPidieron: true }).valor,
        null,
        `"${noEsNombre}" se guardó como nombre`
      );
    }
  });
});

// --------------------------------------------------------------------------
// 7 · EL FORMULARIO NO ES LA RESPUESTA POR DEFECTO
// --------------------------------------------------------------------------

describe("7 · a quien no dijo que compra no se le piden cuatro datos", () => {
  // Cinco clientes distintos del panel del 08-oct recibieron "¿Cuántos
  // quieres? Y para preparar tu pedido me pasas la ciudad y la dirección"
  // por decir cosas que no son un "lo quiero".
  const NO_SON_COMPRA = ["Me gusta", "A ve r", "Por favor", "Interapidisimo", "👍", ""];

  test("ninguno recibe la pedida de datos", async () => {
    for (const texto of NO_SON_COMPRA) {
      const c = await conversacion();
      await c.dice(ANUNCIO);
      const r = await c.dice(texto);
      assert.equal(
        /me pasas|Cuántos quieres/i.test(r.enviado),
        false,
        `"${texto || "(vacío)"}" recibió el formulario: ${r.enviado}`
      );
      assert.ok(r.enviado, `"${texto || "(vacío)"}" se quedó sin respuesta`);
    }
  });

  test("pero quien SÍ dice que lo quiere recibe la pedida de datos", async () => {
    const c = await conversacion();
    await c.dice(ANUNCIO);
    const r = await c.dice("lo quiero");
    assert.match(r.enviado, /me pasas/i, `no pidió los datos a quien compra: ${r.enviado}`);
  });

  test("dos stickers seguidos no cortan la conversación", async () => {
    // Dos chats reales son clientes que solo mandan emojis. El segundo
    // recibía "no quiero repetirme" y el tercero la pausa de 12 h.
    const c = await conversacion();
    await c.dice(ANUNCIO);
    await c.dice("");
    const segundo = await c.dice("");
    assert.equal(/no quiero repetirme/i.test(segundo.enviado), false, segundo.enviado);
    assert.equal(segundo.pausado, false, "un sticker repetido pausó el bot");
  });

  test("un «?» se reorienta, no se admite un hueco que no existe", async () => {
    const c = await conversacion();
    await c.dice(ANUNCIO);
    const r = await c.dice("?");
    assert.equal(/no te la quiero contestar a medias/i.test(r.enviado), false, r.enviado);
    assert.match(r.enviado, /cu[ée]ntame|qu[ée] quieres saber/i, r.enviado);
  });

  test("«ola ke presio tiene» recibe el precio", () => {
    // La lista ya toleraba `bale`, `kuanto` y `kuesta`. A `precio` se le
    // había olvidado, y es la palabra que más cuesta fallar.
    assert.ok(preguntas.leer("ola ke presio tiene").temas.includes(TEMAS.PRECIO));
  });

  test("a quien agradece o se lo piensa no se le insiste", async () => {
    for (const texto of [
      "Gracias",
      "mejor después",
      "déjame preguntarle a mi esposo",
      "Vale mil gracias, apenas vaya a pedirlo de fijo te aviso, bendiciones",
    ]) {
      const c = await conversacion();
      await c.dice(ANUNCIO);
      const r = await c.dice(texto);
      assert.equal(/me pasas|Cuántos quieres/i.test(r.enviado), false, `"${texto}" recibió el formulario: ${r.enviado}`);
    }
  });
});

// --------------------------------------------------------------------------
// 8 · LO QUE SE PROMETE, QUEDA ANOTADO
// --------------------------------------------------------------------------

describe("8 · una promesa sin tarea es un cliente esperando", () => {
  test("si el bot dice que lo confirma el equipo, hay tarea", async () => {
    // La condición era `preguntoAlgoNoCatalogado`, un proxy que dejó de
    // valer al añadir los temas nuevos: "¿a cuántos grados llega?" YA tiene
    // tema, así que no abría tarea, y la respuesta promete que el equipo lo
    // confirma. Una promesa que nadie recibe.
    const c = await conversacion();
    await c.dice(ANUNCIO);
    // ⚠️ EL EJEMPLO HA CAMBIADO DOS VECES, Y ESO ES LA PRUEBA DE QUE EL
    //    DEFECTO QUE VIGILA ES REAL.
    //
    //    Era "¿a cuántos grados llega?" hasta que Marco autorizó la ficha
    //    técnica el 09-oct. Pasó a ser el contorno de la correa, que él
    //    había dejado como [CONFIRMAR]... y lo confirmó en el parche 4 ese
    //    mismo día. Cada vez que un hueco se tapa, esta prueba se queda sin
    //    sujeto y hay que buscarle otro.
    //
    //    Hoy quedan dos respuestas que prometen confirmar algo: la factura
    //    y el precio al por mayor. Se usa la factura porque es una pregunta
    //    corriente -quien compra para un negocio la hace siempre- y porque
    //    no tiene ningún campo en la ficha, así que no va a dejar de ser un
    //    hueco por accidente.
    const r = await c.dice("me dan factura?");

    assert.ok(contestar.prometeConfirmar(r.enviado), `la respuesta ya no promete confirmar: ${r.enviado}`);
    const p = atencion.pendienteDe(r.conversacion);
    assert.equal(p.hay, true, "prometió confirmar un dato y no dejó tarea");
    assert.match(p.pregunta, /factura/i, "la tarea no guarda la pregunta");
  });

  test("y si contesta del todo, NO hay tarea", async () => {
    // El error opuesto: llenar la bandeja de ruido.
    const c = await conversacion();
    await c.dice(ANUNCIO);
    const r = await c.dice("llega a una vereda?");

    assert.equal(contestar.prometeConfirmar(r.enviado), false, r.enviado);
    assert.equal(atencion.pendienteDe(r.conversacion).hay, false, `abrió tarea por una pregunta contestada: ${r.enviado}`);
  });

  test("el detector cubre TODAS las respuestas que prometen", () => {
    // ⚠️ ESTA PRUEBA ES EL PRECIO DE DETECTAR SOBRE EL TEXTO.
    //
    // `prometeConfirmar` mira el texto que se va a enviar. Si alguien
    // reescribe una respuesta y cambia la redacción de la promesa, el
    // detector dejaría de verla EN SILENCIO y el cliente se quedaría
    // esperando. Aquí se recorren todos los temas: el que admita un hueco
    // tiene que casar.
    const producto = elCinturon();
    const ADMITE_HUECO = /no te l[oa]s? quiero (decir|contestar) a medias|confirmo con el equipo|te paso con una persona/i;

    for (const tema of Object.values(TEMAS)) {
      const t = contestar.deTema(tema, { producto, cotizacion: null });
      if (!t) continue;
      if (!ADMITE_HUECO.test(t)) continue;
      assert.equal(
        contestar.prometeConfirmar(t),
        true,
        `${tema} admite un hueco y el detector no lo ve, así que no dejaría tarea: ${t}`
      );
    }
  });

  test("repetir el mismo «no lo sé» no es contestar", () => {
    // Del chat de Marco: "Con cables para cargar" y "Trae cargador"
    // recibieron el MISMO párrafo de "lo confirmo con el equipo". La clienta
    // reformuló porque la primera no le sirvió, y recibió el mismo muro.
    // ⚠️ ENERGIA ya no es un muro: tiene dato desde el 09-oct. El que sigue
    //    siéndolo es la factura, que no tiene política aprobada.
    const muro = contestar.deTema(TEMAS.FACTURA, { producto: elCinturon() });
    const r = responder.sinRepetir(muro, muro, { mismaPregunta: true, preguntaReconocida: true });
    assert.equal(r.repetido, true, "dejó pasar el mismo muro dos veces");
    assert.notEqual(r.texto, muro);
    // Y NO escala: sigue siendo una venta viva.
    assert.equal(r.escalar, false);
    assert.match(r.texto, /pagas al recibir|aparto/i, `se quedó sin nada que ofrecer: ${r.texto}`);
  });

  test("con el resumen en pantalla nunca se pide «concretar»", async () => {
    // El peor sitio posible: es el último paso antes del pedido.
    const resumen = 'Confirmemos tu pedido:\nTotal: $49.900\n¿Está todo bien? Respóndeme "sí" y lo dejo listo ✅';
    const r = responder.sinRepetir(resumen, resumen, { mismaPregunta: false, preguntaReconocida: false });
    assert.equal(/no quiero repetirme|concretamente/i.test(r.texto), false, r.texto);
    assert.match(r.texto, /s[íi]/i, `no pidió el sí, que es lo único que falta: ${r.texto}`);
  });
});

// --------------------------------------------------------------------------
// 9 · LAS TRES CONVERSACIONES REALES, DE PUNTA A PUNTA
// --------------------------------------------------------------------------

describe("9 · las ventas que se perdieron el 08-oct ahora cierran", () => {
  // Mensajes copiados literalmente del panel, con sus erratas. Lo que se
  // mide es lo único que le importaba a Marco: que acabe en PEDIDO.
  //
  // La versión con el diálogo completo a la vista:
  //   node herramientas/revivir.js

  test("Mauricio · San Andrés de Sotavento — y a la ciudad correcta", async () => {
    const c = await conversacion({ nombrePerfil: "Mauricio Benítez" });
    for (const m of [
      ANUNCIO,
      "Me interesa",
      "Cuánto cuesta",
      "San andres de sotavento Córdoba",
      "Uno",
      "Barrio buenos aires",
      "si",
    ]) {
      await c.dice(m);
    }

    const p = await c.pedidos();
    assert.equal(p.length, 1, "la venta se volvió a perder");
    const entrega = p[0].entrega || (p[0].cotizacion && p[0].cotizacion.destino) || {};
    const ciudad = JSON.stringify(entrega);
    assert.equal(/Archipi|"San Andres"/.test(ciudad), false, `iba a despachar al archipiélago: ${ciudad}`);
  });

  test("Andrés · Popayán, con prisa — y sin un solo silencio", async () => {
    const c = await conversacion({ nombrePerfil: "Andrés Quiceno" });
    const dichos = [];
    for (const m of [
      ANUNCIO,
      "Hola buenos días",
      "Estoy en Popayán",
      "No habría manera de que llegue hoy?",
      "Por favor",
      "bueno listo lo quiero",
      "Andrés Quiceno",
      "barrio Pueblillo, calle 5 # 3-20",
      "si",
    ]) {
      const r = await c.dice(m);
      dichos.push({ m, enviado: r.enviado, pausado: r.pausado });
    }

    for (const d of dichos) {
      assert.ok(d.enviado, `se quedó callado tras "${d.m}"`);
      assert.equal(d.pausado, false, `se pausó tras "${d.m}"`);
    }
    assert.equal((await c.pedidos()).length, 1, "la venta se volvió a perder");
  });

  test("Santiago · el chat de Marco — sin un «no quiero repetirme»", async () => {
    const c = await conversacion({ nombrePerfil: "Santiago" });
    const dichos = [];
    for (const m of [
      "Hola",
      "Me gusta",
      "1 a Bogotá",
      "Cuando me llegaría",
      "Gracias",
      "Tienes cinturones",
      "Tiene garantía",
      "listo lo quiero",
      "Calle 62bis 67-12",
      "Si",
    ]) {
      const r = await c.dice(m);
      dichos.push({ m, enviado: r.enviado });
    }

    for (const d of dichos) {
      assert.equal(
        /no quiero repetirme/i.test(d.enviado),
        false,
        `tras "${d.m}" le pidió concretar: ${d.enviado}`
      );
    }
    assert.equal((await c.pedidos()).length, 1, "la venta se volvió a perder");
  });
});
