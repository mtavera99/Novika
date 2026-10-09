"use strict";

// ==========================================================================
// EL PRIMER PRODUCTO ACTIVO DE NOVIKA
//
// Marco cerro la ficha el 2026-10-07 y el cinturon paso a `activo: true`.
// Activar cambia mas cosas de las que parece, y esta bateria existe por lo
// que se encontro al hacerlo: TRES defectos que solo aparecian con el
// producto activo y que en borrador no se veian.
//
//   1. Las fotos dejaban de salir. La condicion de envio era
//      `producto_en_borrador || cotizacion`, y "cotizacion" no es una
//      situacion que exista: `avanzarVenta` nunca la devuelve. Activar el
//      producto habria apagado las fotos en silencio.
//
//   2. A "¿cuánto cuesta?" el bot contestaba "me falta la ciudad y la
//      direccion". Pedirle los datos a quien todavia no sabe el precio es
//      la forma mas rapida de perder la venta, y pasaba teniendo el precio
//      en el catalogo, solo porque faltaba la cantidad.
//
//   3. Tras un escalado -por ejemplo al pedir 2 unidades, que no tienen
//      precio aprobado- el bot contestaba "Tu pedido ya está confirmado"
//      SIN que existiera ningun pedido.
//
// El tercero es el que mas importa: no era un mensaje feo, era mentirle a
// la clienta sobre el estado de su compra.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const { cargarCatalogo } = require("../src/catalogo");
const { validarProducto } = require("../src/catalogo/esquema");
const texto = require("../src/dominio/texto");
const responder = require("../src/cerebro/responder");
const cotizador = require("../src/dominio/cotizador");
const { config } = require("../src/config");
const { crearCerebro } = require("../src/cerebro/orquestar");
const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
const { crearCliente } = require("../src/ia/cliente");
const { crearEmisor } = require("../src/whatsapp/enviar");
const mutex = require("../src/almacen/mutex");

const RAIZ = path.join(__dirname, "..");
const ID = "cinturon-termico-colicos";

function catalogoReal() {
  const c = cargarCatalogo({ carpeta: path.join(RAIZ, "catalogo", "productos"), refrescar: true });
  assert.deepEqual(c.problemas, [], "el catalogo real tiene que cargar limpio");
  return c;
}

function elCinturon() {
  return catalogoReal().porId.get(ID);
}

// --------------------------------------------------------------------------
// UN WAMID QUE NO PUEDE COLISIONAR
//
// Estaba construido con `Date.now()` y un contador por conversacion, y eso
// produjo un fallo INTERMITENTE: dos pruebas distintas que arrancan en el
// mismo milisegundo generan el mismo wamid, y el deduplicador -que hace
// bien su trabajo- descarta el segundo mensaje. La prueba fallaba una vez
// cada tantas corridas sin que nada estuviera mal en el codigo.
//
// Una prueba intermitente es peor que ninguna: enseña a volver a correrla
// en vez de a leer el fallo. El contador es de modulo y es unico.
// --------------------------------------------------------------------------
let SECUENCIA = 0;
const wamidUnico = (prefijo) => `wamid.${prefijo}${++SECUENCIA}_${process.pid}`;

// --------------------------------------------------------------------------
// 1 · LA FICHA CONFIRMADA
// --------------------------------------------------------------------------

describe("1 · la ficha que confirmo Marco", () => {
  test("el producto esta ACTIVO, sin pendientes y la validacion no objeta nada", () => {
    const p = elCinturon();
    assert.equal(p.activo, true);
    assert.deepEqual(p.pendientes, []);

    const r = validarProducto(p, "archivo");
    assert.deepEqual(r.errores, []);
    assert.deepEqual(r.avisos, [], `avisos: ${JSON.stringify(r.avisos)}`);

    const c = catalogoReal();
    assert.equal(c.activos.length, 1);
    // Activar UN producto no crea un producto por defecto. Con un solo
    // producto la tentacion es asumirlo siempre, y eso es exactamente como
    // se despacha el equivocado el dia que haya dos.
    assert.equal(c.productoPorDefecto, null);
  });

  test("nombre, color y talla estan como datos, no como frases suyas", () => {
    const p = elCinturon();
    assert.equal(p.nombre, "Cinturón térmico NOVIKA");
    assert.equal(
      p.descripcionAutorizada,
      "Cinturón térmico con correa ajustable y panel de control. Se entrega con su empaque."
    );

    // El color y la talla son hechos aprobados: el bot TIENE que poder
    // decirlos cuando se los preguntan.
    // Se compara APLANADO: estas frases las lee la clienta, asi que llevan
    // tildes ("talla única"), y una prueba que exija la forma sin tilde
    // obligaria a escribirlas mal.
    const { aplanar } = require("../src/dominio/texto");
    const rasgos = p.caracteristicasAutorizadas.map(aplanar);
    assert.ok(rasgos.some((c) => /rosado/.test(c)), "el color no esta autorizado");
    assert.ok(rasgos.some((c) => /talla unica/.test(c)), "la talla no esta autorizada");
  });

  test("el color y la talla SALIERON de los datos sin confirmar", () => {
    // Si se quedaran ahi, pasaria lo peor de dos mundos: el bot no podria
    // decir que es rosado -que es verdad y se lo van a preguntar- y a la vez
    // estaria tratando como dudoso algo que Marco ya decidio.
    const p = elCinturon();
    assert.equal(
      p.sinDatoConfirmado.some((s) => /color|tallas/.test(s)),
      false,
      `color o talla siguen declarados como no confirmados: ${JSON.stringify(p.sinDatoConfirmado)}`
    );
  });
});

// --------------------------------------------------------------------------
// 2 · EL LIMITE DEL AJUSTE
//
// "No tenemos medidas del ajuste: no prometas que sirve para cualquier
// contorno." El riesgo nace de un dato VERDADERO: "talla unica con correa
// ajustable" invita a seguir la frase con "asi que le sirve a cualquiera",
// que es justo lo que nadie sabe.
// --------------------------------------------------------------------------

describe("2 · no se promete que sirva para cualquier contorno", () => {
  test("las promesas de ajuste universal estan prohibidas como frases concretas", () => {
    const p = elCinturon();
    const promesas = [
      "Sí, sirve para cualquier contorno.",
      "Es talla única, se ajusta a cualquier cintura.",
      "Tranquila, le queda a cualquiera.",
      "Sirve para todas las tallas.",
      "Tiene ajuste universal.",
      "Se adapta a cualquier cuerpo.",
    ];
    for (const frase of promesas) {
      const r = responder.revisarClaims(frase, p);
      assert.equal(r.ok, false, `se permitio prometer ajuste: "${frase}"`);
    }
  });

  test("funciona tambien con tildes y en mayusculas", () => {
    // Las claves estan sin tildes y la comparacion aplana el texto. Sin eso,
    // la frase que de verdad escribiria un modelo -con tildes- pasaria.
    for (const frase of [
      "SÍ, SE AJUSTA A CUALQUIER CINTURA.",
      "Sírve para cualquier contórno, tranquila.",
      "LE QUEDA A CUALQUIERA",
    ]) {
      const r = responder.revisarClaims(frase, elCinturon());
      assert.equal(r.ok, false, `paso con tildes o mayusculas: "${frase}"`);
    }
  });

  test("pero SI puede decir que es talla unica con correa ajustable", () => {
    // El dato aprobado no se puede quedar bloqueado por protegerse del
    // claim. Si esto fallara, la proteccion habria silenciado un hecho.
    const r = responder.revisarClaims("Es talla única y la correa es ajustable. Viene en rosado.", elCinturon());
    assert.equal(r.ok, true, `se bloqueo un dato aprobado: ${JSON.stringify(r.encontrados)}`);
  });

  test("el contorno YA esta confirmado, y por eso no se declara dudoso", () => {
    // ESTA PRUEBA AFIRMABA LO CONTRARIO HASTA EL 2026-10-09, y tenia razon
    // mientras la medida no existia. Marco la confirmo en el parche 4: la
    // correa abarca de 130 a 150 cm, hasta talla 4XL.
    //
    // Se le da la vuelta en vez de borrarla, porque el riesgo no desaparece:
    // cambia de sitio. Antes era "el bot promete una medida que no tiene";
    // ahora es "el bot tiene la medida y sigue diciendo que la consulta".
    const p = elCinturon();
    assert.equal(p.ajuste.contornoMaximoCm, 150);
    assert.equal(p.ajuste.contornoMinCm, 130);
    assert.equal(p.ajuste.hastaTalla, "4XL");
    assert.equal(
      p.sinDatoConfirmado.some((s) => /contorno/.test(s)),
      false,
      "la medida esta en la ficha y a la vez declarada sin confirmar"
    );
  });

  test("y aun asi NO se puede prometer que le queda a cualquiera", () => {
    // El matiz que Marco pidio sostener: 150 cm es una medida concreta y hay
    // cuerpos por encima. Tener el dato no autoriza la frase facil.
    const p = elCinturon();
    for (const frase of ["le sirve a cualquiera", "es talla unica universal", "se ajusta a cualquier cintura"]) {
      assert.equal(responder.revisarClaims(frase, p).ok, false, `se permitio con la medida puesta: "${frase}"`);
    }
    // Y lo que SI se puede decir, se puede decir.
    assert.equal(
      responder.revisarClaims("La correa es graduable: elástica, se estira hasta unos 130 a 150 cm, así que le sirve a casi cualquier persona, hasta talla 4XL.", p).ok,
      true,
      "se bloqueo la frase aprobada por Marco"
    );
  });
});

// --------------------------------------------------------------------------
// 3 · CUANDO SE MANDAN LAS FOTOS
// --------------------------------------------------------------------------

describe("3 · pedir ver el producto", () => {
  test("se reconoce la peticion de fotos", () => {
    for (const frase of [
      "Muéstrame fotos del cinturón",
      "tienes imagenes?",
      "mandame una foto",
      "quiero verlo",
      "enséñame cómo es",
      "me puedes mostrar el producto",
    ]) {
      assert.equal(texto.pideFotos(frase), true, `no se reconocio: "${frase}"`);
    }
  });

  test('"cómo es el envío" NO es pedir fotos', () => {
    // El mensaje que fallaba decia "...y como es el envio". Si eso contara
    // como peticion de imagenes, quien pregunta por el flete recibe cinco
    // fotos.
    assert.equal(texto.pideFotos("¿y cómo es el envío?"), false);
    assert.equal(texto.pideFotos("cuanto cuesta y como es el envio"), false);
    assert.equal(texto.pideFotos("si confirmo"), false);
    assert.equal(texto.pideFotos("Ana Pérez, Medellín, Calle 45 # 23-10"), false);
  });
});

// --------------------------------------------------------------------------
// 4 · PRECIO INFORMATIVO
// --------------------------------------------------------------------------

describe("4 · el precio va antes de pedir la direccion", () => {
  function informativa() {
    return cotizador.cotizar({ producto: elCinturon(), cantidad: 1 }).cotizacion;
  }

  test("el texto dice el precio y luego pide los datos", () => {
    const t = responder.preparar({
      situacion: "faltan_datos",
      cotizacionInformativa: informativa(),
      faltan: ["cantidad", "ciudad", "direccion"],
      producto: elCinturon(),
      // ⚠️ `huboSenalDeCompra` ES NUEVO AQUI, Y ES EL ARREGLO DE UN DEFECTO
      //    DE LA PRUEBA, NO UNA CONCESION.
      //
      // Esta llamada no pasaba `mensajeCliente`, asi que el turno no tenia
      // NINGUNA señal de intencion — y seguia esperando que el bot pidiera
      // nombre, ciudad y direccion. Eso es justo lo que se corrigio el
      // 09-oct: pedir los cuatro datos a quien no ha dicho que quiere
      // comprar. Del panel: "Me gusta", "A ve r", "Por favor" y un sticker
      // recibian los cuatro campos.
      //
      // Lo que esta prueba protege -el precio ANTES de la peticion de
      // datos- solo tiene sentido con un cliente que ya dijo que lo quiere.
      // Asi que se dice explicitamente, que es lo que el cerebro hace de
      // verdad: lleva `huboSenalDeCompra` en la conversacion.
      huboSenalDeCompra: true,
    }).texto;

    assert.match(t, /49\.900/);
    // Con la cantidad sin decir, el precio informado es el de UNA unidad y
    // hay que decirlo asi: si no, quien pensaba pedir tres lo lee como el
    // total de su pedido.
    assert.match(t, /una unidad/i, "tiene que quedar claro que es el precio de UNA unidad");
    assert.match(t, /incluido/);
    assert.match(t, /al recibir/);
    assert.match(t, /me pasas|me falta/, "tiene que pedir lo que falta");
  });

  test("sin cotizacion informativa, el texto no se inventa ninguna cifra", () => {
    const t = responder.preparar({
      situacion: "faltan_datos",
      faltan: ["cantidad", "ciudad"],
      producto: elCinturon(),
    }).texto;
    assert.equal(/\$|\d{3,}/.test(t), false, `aparecio un importe sin cotizacion: ${t}`);
  });

  test("el filtro de importes autoriza la cifra informativa", () => {
    // Si no la autorizara, un borrador de la IA que repitiera el precio
    // correcto se bloquearia por decir la verdad.
    const k = informativa();
    const r = cotizador.revisarImportes("Una unidad cuesta $49.900.", k.importesAutorizados);
    assert.equal(r.ok, true, JSON.stringify(r.sospechosos));
  });
});

// --------------------------------------------------------------------------
// 5 · LA CONVERSACION COMPLETA, CONTRA EL CATALOGO REAL
// --------------------------------------------------------------------------

async function montar({ respuestaAutomatica = true } = {}) {
  mutex._reiniciar();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "novika-activo-"));
  const repos = await crearReposDeArchivos({ dir });

  // urlPublica hace falta para las fotos: Meta las descarga por enlace, asi
  // que sin dominio publico no hay nada que mandar. En Render la pone
  // RENDER_EXTERNAL_URL; en las pruebas se fija aqui.
  const cfg = {
    ...config,
    respuestaAutomatica,
    whatsappToken: "TOKEN_DE_PRUEBA",
    idNumero: "000",
    urlPublica: "https://pruebas.invalido",
  };
  const salidas = [];
  const emisor = crearEmisor({
    config: cfg,
    repos,
    fetchImpl: async (url, opc) => {
      salidas.push(JSON.parse(opc.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.OUT${salidas.length}` }] }) };
    },
  });

  const cerebro = crearCerebro({
    config: cfg,
    repos,
    catalogo: catalogoReal(),
    ia: crearCliente({ proveedor: null }),
    emisor,
  });

  let n = 0;
  const hablar = async (t) => {
    n += 1;
    salidas.length = 0;
    const traza = await cerebro.procesar({
      clase: "mensaje",
      wamid: wamidUnico("ACT"),
      idCliente: "573001234567",
      telefono: "573001234567",
      nombre: "Ana Pérez",
      tipo: "text",
      texto: t,
      origenTexto: "escrito",
      referral: null,
    });
    return { traza, salidas: [...salidas] };
  };

  return { hablar, repos };
}

const textos = (salidas) => salidas.filter((s) => s.type === "text").map((s) => s.text.body);
const imagenes = (salidas) => salidas.filter((s) => s.type === "image").map((s) => s.image.link);

describe("5 · la conversacion completa", () => {
  test("EL MENSAJE QUE FALLABA: precio, condiciones y las tres fotos", async () => {
    const { hablar } = await montar();
    const { traza, salidas } = await hablar("Muéstrame fotos del cinturón y dime cuánto cuesta y cómo es el envío");

    // Ya no vuelve a preguntar que producto quiere, y ya no esta en borrador.
    assert.notEqual(traza.respuesta.situacion, "producto_desconocido");
    assert.notEqual(traza.respuesta.situacion, "producto_en_borrador");

    const t = textos(salidas);
    assert.equal(t.length, 1, "un solo texto");
    assert.match(t[0], /49\.900/);
    assert.match(t[0], /incluido/);
    assert.match(t[0], /al recibir/);

    // Las TRES fotos, en orden. Van DESPUES del texto.
    //
    // ⚠️ 2026-10-09: eran cinco. Se limito a tres porque cinco imagenes
    //    empujan el texto -con el precio y la pregunta de cierre- fuera de
    //    la pantalla del movil, y 10 de 25 clientes recibieron ese primer
    //    mensaje y no volvieron a escribir. Las tres las eligio Marco: el
    //    cinturon de frente encendido, puesto, y con su caja.
    const fotos = imagenes(salidas);
    assert.equal(fotos.length, 3, `salieron ${fotos.length} fotos`);
    assert.ok(/01-frente/.test(fotos[0]) && /05-empaque/.test(fotos[2]), "llegaron desordenadas");
    assert.ok(salidas.findIndex((s) => s.type === "text") < salidas.findIndex((s) => s.type === "image"));
  });

  test("las fotos no se repiten solas en el turno siguiente", async () => {
    // El candado es contra el SPAM: cinco imagenes en cada mensaje llenan
    // la pantalla del telefono. Preguntar otra cosa no las vuelve a traer.
    const { hablar } = await montar();
    await hablar("Muéstrame fotos del cinturón");
    const segunda = await hablar("¿y tiene garantía?");
    assert.equal(imagenes(segunda.salidas).length, 0, "se reenviaron las fotos sin que nadie las pidiera");
  });

  // ------------------------------------------------------------------------
  // PERO SI DICE QUE NO LE LLEGARON, SE REPITEN
  //
  // El bot ofrece reenviarlas -"si no te cargaron, dime y te las paso otra
  // vez"- y la deduplicacion lo impedia. El ofrecimiento era una promesa
  // falsa: la clienta pedia las fotos otra vez y no pasaba nada.
  //
  // Escribir y resolver no son lo mismo, y aqui tampoco: evitar el spam no
  // puede ganarle a un cliente que dice que no recibio lo que le ofrecimos.
  // ------------------------------------------------------------------------
  test("«no me cargaron las fotos» SÍ las reenvía", async () => {
    const { hablar } = await montar();
    const primera = await hablar("Muéstrame fotos del cinturón");
    assert.ok(imagenes(primera.salidas).length > 0, "no mandó fotos la primera vez");

    const segunda = await hablar("no me cargaron las fotos");
    assert.ok(
      imagenes(segunda.salidas).length > 0,
      "dijo que no le cargaron y no se reenviaron: el ofrecimiento era falso"
    );
  });

  test("y pedirlas otra vez explícitamente también", async () => {
    const { hablar } = await montar();
    await hablar("Muéstrame fotos del cinturón");
    const segunda = await hablar("me las mandas otra vez? no las veo");
    assert.ok(imagenes(segunda.salidas).length > 0, "las pidió otra vez y no llegaron");
  });

  test("el precio se dice una vez, y se repite solo si lo vuelven a preguntar", async () => {
    const { hablar } = await montar();

    const primera = await hablar("¿cuánto cuesta el cinturón?");
    assert.match(textos(primera.salidas)[0], /49\.900/);

    const segunda = await hablar("¿me sirve? uso talla XL");
    assert.equal(/49\.900/.test(textos(segunda.salidas)[0] || ""), false, "repitio el precio sin que se lo pidieran");

    const tercera = await hablar("¿y cuánto cuesta otra vez?");
    assert.match(textos(tercera.salidas)[0], /49\.900/, "no repitio el precio cuando se lo volvieron a preguntar");
  });

  test('un "si" al precio informativo NO crea ningun pedido', async () => {
    // Es la diferencia entre informar y ofertar. El informativo no crea
    // oferta ni marca resumen mostrado, asi que no hay nada que confirmar.
    const { hablar, repos } = await montar();
    await hablar("¿cuánto cuesta el cinturón?");
    const r = await hablar("sí, confirmo");

    assert.notEqual(r.traza.respuesta.situacion, "confirmado");
    assert.equal((await repos.pedidos.porContacto("573001234567")).length, 0, "se creo un pedido sin resumen");
  });

  test("venta completa: UN pedido, con 49.900 y contraentrega", async () => {
    const { hablar, repos } = await montar();

    await hablar("hola, quiero el cinturón térmico");
    await hablar("quiero 1");
    const resumen = await hablar("Ana Pérez, Medellín, Calle 45 # 23-10");
    assert.equal(resumen.traza.respuesta.situacion, "resumen");
    assert.match(textos(resumen.salidas)[0], /Cinturón térmico NOVIKA/);
    assert.match(textos(resumen.salidas)[0], /49\.900/);

    const conf = await hablar("sí confirmo");
    assert.equal(conf.traza.respuesta.situacion, "confirmado");

    const pedidos = await repos.pedidos.porContacto("573001234567");
    assert.equal(pedidos.length, 1, "el pedido tiene que aparecer UNA vez");
    assert.equal(pedidos[0].cotizacion.total, 49900);
    assert.equal(pedidos[0].producto.nombre, "Cinturón térmico NOVIKA");
    assert.equal(pedidos[0].cotizacion.condiciones.pagoMetodo, "contraentrega");

    // Y repetir el "si" no duplica.
    const otra = await hablar("sí confirmo");
    assert.equal(otra.traza.respuesta.situacion, "ya_confirmado");
    assert.equal((await repos.pedidos.porContacto("573001234567")).length, 1);
  });

  test("pedir 8 unidades no inventa precio ni crea pedido", async () => {
    // ERA DE 2 UNIDADES, y luego de 3. Marco amplio la tabla hasta 5 el
    // 2026-10-09, asi que el caso sin precio aprobado es ahora ocho.
    const { hablar, repos } = await montar();
    await hablar("quiero 8 cinturones térmicos");
    const r = await hablar("Ana Pérez, Medellín, Calle 45 # 23-10");

    assert.notEqual(r.traza.respuesta.situacion, "resumen");
    assert.equal((await repos.pedidos.porContacto("573001234567")).length, 0);
    for (const t of textos(r.salidas)) {
      assert.equal(/\$|\d{4,}/.test(t), false, `insinuó un importe por 8 unidades: ${t}`);
    }
  });

  test("REGRESION: escalado sin pedido NO dice que el pedido esta confirmado", async () => {
    // El defecto: la clienta pide 2 unidades -no hay precio aprobado- y se
    // escala. A partir de ahi el bot contestaba "Tu pedido ya está
    // confirmado" a cualquier cosa que escribiera, sin que existiera pedido.
    const { hablar, repos } = await montar();
    // SE CAMBIO DE 2 A 3 UNIDADES, Y EL 2026-10-09 DE 3 A 8. Esta prueba
    // necesita una cantidad SIN precio aprobado para forzar el escalado;
    // cada vez que Marco aprueba un escalon hay que subirla.
    //
    // ⚠️ Y ESTA NO FALLO AL AMPLIAR LA TABLA, QUE ES LO PELIGROSO: con 3 ya
    //    cotizando, el escalado no ocurria, no habia "escalado sin pedido"
    //    que comprobar y las aserciones se cumplian solas. Una prueba verde
    //    que ya no prueba nada es peor que una roja. Se encontro revisando
    //    a mano todos los usos del 3, no porque avisara.
    await hablar("quiero 8 cinturones térmicos");
    await hablar("quiero 8"); // fuerza el escalado por cantidad sin precio

    const despues = await hablar("mejor 1 entonces");
    assert.notEqual(despues.traza.respuesta.situacion, "ya_confirmado");
    assert.equal((await repos.pedidos.porContacto("573001234567")).length, 0);

    for (const t of textos(despues.salidas)) {
      assert.equal(
        /ya está confirmado|quedó registrado/i.test(t),
        false,
        `le dijo a la clienta que tenia un pedido confirmado: ${t}`
      );
    }
  });


  // ------------------------------------------------------------------------
  // EL PLURAL CIERRA EL COMBO
  //
  // Van en ESTE archivo y no en ficha-cinturon.test.js por un motivo que
  // vale la pena anotar: alli el montaje tiene el envio APAGADO, y los
  // marcadores de "lo que ya se le dijo" -incluida la cantidad informada-
  // se anotan SOLO si el mensaje salio de verdad.
  //
  // Es coherente y es el comportamiento correcto: si la clienta no leyo el
  // precio de dos, su "las quiero" no puede referirse a el. Pero significa
  // que esta conversacion solo se puede probar donde el bot si envia.
  // ------------------------------------------------------------------------
  test('"las quiero" tras ver el precio de dos CIERRA la venta de dos', async () => {
    // La venta del combo se perdia: el bot informaba 85.000 por dos y al
    // "las quiero" preguntaba "¿cuántos quieres?" en bucle, hasta que la
    // guarda anti-eco cortaba la conversacion.
    const { hablar, repos } = await montar();

    await hablar("¿cuánto me salen dos?");
    await hablar("las quiero");
    const resumen = await hablar("Ana Pérez, Medellín, Calle 45 # 23-10");

    assert.equal(resumen.traza.respuesta.situacion, "resumen", `situación: ${resumen.traza.respuesta.situacion}`);
    assert.match(textos(resumen.salidas)[0], /85\.000/, "no usó el precio del combo");
    assert.match(textos(resumen.salidas)[0], /2 unidades/);

    const conf = await hablar("sí confirmo");
    assert.equal(conf.traza.respuesta.situacion, "confirmado");

    const pedidos = await repos.pedidos.porContacto("573001234567");
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].cotizacion.cantidad, 2);
    assert.equal(pedidos[0].cotizacion.total, 85000);
  });

  test('pero "mejor quiero 1" MANDA sobre la cantidad informada', async () => {
    // El error caro de ese arreglo seria fijar dos porque se informo dos.
    // Lo que diga el cliente en ESTE turno manda siempre.
    const { hablar, repos } = await montar();

    await hablar("¿cuánto me salen dos?");
    await hablar("mejor quiero 1");
    const resumen = await hablar("Ana Pérez, Medellín, Calle 45 # 23-10");

    assert.equal(resumen.traza.respuesta.situacion, "resumen");
    assert.match(textos(resumen.salidas)[0], /49\.900/, "le cobró el combo a quien pidió una");
    assert.equal(/85\.000/.test(textos(resumen.salidas)[0]), false);

    await hablar("sí confirmo");
    const pedidos = await repos.pedidos.porContacto("573001234567");
    assert.equal(pedidos[0].cotizacion.cantidad, 1);
  });

  test("con RESPUESTA_AUTOMATICA apagada no sale nada, ni texto ni fotos", async () => {
    const { hablar } = await montar({ respuestaAutomatica: false });
    const { traza, salidas } = await hablar("Muéstrame fotos del cinturón y dime cuánto cuesta");

    assert.equal(salidas.length, 0, "salio algo con el interruptor apagado");
    assert.equal(traza.enviada, false);
    // La respuesta SI se prepara: es lo que se audita en modo sombra.
    assert.ok(traza.respuesta.texto.length > 0);
  });
});

void DIR;
