"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Porque un error aqui no es cosmetico: LA ETIQUETA LLEVA NOMBRE, DIRECCION
// Y TELEFONO IMPRESOS. Mandarle a un cliente la guia de otro es filtrarle
// datos personales de un tercero a un desconocido, y eso no se arregla
// pidiendo perdon.
//
// Casi todo lo que se prueba aqui viene de un fallo MEDIDO en BIKERPRO, que
// lleva mucho mas tiempo en produccion:
//
//   · "La Playa": usar solo la PRIMERA palabra de la ciudad dejaba 8
//     municipios reales en 45 puntos, justo debajo del minimo de 50. Dejo
//     una guia sin enviar.
//   · El telefono en 4 formatos: buscar solo /\b3\d{9}\b/ pierde
//     "315 555 1234", "315-555-1234" y "573155551234". Un telefono vale 50
//     puntos: es la unica senal que por si sola alcanza el minimo.
//   · El empate del mismo cliente: bloquear TODOS los empates dejaba sin
//     guia automatica justo al cliente que compra dos veces.
//   · El BSUID: "CO.1098944123092301" sin simbolos parece un telefono. Si
//     entra al pareo puede coincidir por casualidad.
//
// Y una cosa que esta bateria puede probar y la de BIKERPRO no: el pareo
// completo, sin ningun PDF. Por eso `guias.js` es puro y leer el archivo
// vive aparte.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const guias = require("../src/despacho/guias");

/** Un pedido con la forma de NOVIKA. */
function pedidoDePrueba(sobre = {}) {
  const { destinatario, ...resto } = sobre;
  return {
    id: "NOV-PRUEBA-1",
    estado: "confirmado",
    contactoId: "573001112233",
    destinatario: {
      nombre: "Ana Maria Perez",
      telefono: "3001112233",
      ciudad: "Medellin",
      direccion: "Calle 45 # 23-10",
      ...destinatario,
    },
    cotizacion: { total: 89000 },
    ...resto,
  };
}

/** Las lineas de una etiqueta, como las devuelve el lector de PDF. */
function etiqueta({
  guia = "240061604892",
  nombre = "ANA MARIA PEREZ",
  direccion = "CALLE 45 # 23-10",
  ciudad = "MEDELLIN",
  telefono = "3001112233",
  transportadora = "INTER RAPIDISIMO",
} = {}) {
  return [
    transportadora,
    `GUIA No. ${guia}`,
    `DESTINATARIO: ${nombre}`,
    `DIRECCION: ${direccion}`,
    `CIUDAD: ${ciudad}`,
    `TELEFONO: ${telefono}`,
  ];
}

// --------------------------------------------------------------------------
// 1 · Leer la etiqueta
// --------------------------------------------------------------------------

test("lee la guia por su rotulo, no el numero mas largo que encuentre", () => {
  const campos = guias.extraerCampos(etiqueta({ guia: "240061604892" }));
  assert.equal(campos.guia, "240061604892");
});

test("no confunde un celular con la guia", () => {
  // Sin rotulo de guia: tiene que descartar el celular (10 digitos que
  // empiezan en 3) y quedarse con el otro numero largo.
  const campos = guias.extraerCampos([
    "SERVIENTREGA",
    "REMESA 2220956331",
    "DESTINATARIO: ANA PEREZ",
    "TEL 3001112233",
  ]);
  assert.equal(campos.guia, "2220956331");
  assert.ok(campos.telefonos.includes("3001112233"));
});

test("EL FALLO DE LOS CUATRO FORMATOS: encuentra el telefono escrito de todas las formas", () => {
  // Cada uno de estos se perdia con /\b(3\d{9})\b/ a secas, y perder el
  // telefono es perder los 50 puntos que alcanzan el minimo.
  const casos = [
    ["pegado", "3155551234"],
    ["con indicativo pegado", "573155551234"],
    ["con espacios", "315 555 1234"],
    ["con guiones", "315-555-1234"],
    ["partido 3+7", "315 5551234"],
    ["partido 4+6", "3155 551234"],
  ];

  for (const [como, escrito] of casos) {
    const campos = guias.extraerCampos([`DESTINATARIO: ANA PEREZ`, `TELEFONO: ${escrito}`]);
    assert.ok(
      campos.telefonos.includes("3155551234"),
      `no encontro el telefono escrito ${como} ("${escrito}")`
    );
  }
});

test("no mete el telefono del remitente entre los del destinatario", () => {
  const campos = guias.extraerCampos(
    ["REMITENTE: NOVIKA TEL 3109998877", "DESTINATARIO: ANA PEREZ", "TELEFONO: 3001112233"],
    { telefonosRemitente: ["3109998877"] }
  );
  assert.deepEqual(campos.telefonos, ["3001112233"]);
});

test("reconoce la transportadora de la etiqueta", () => {
  assert.equal(guias.transportadoraDe("INTER RAPIDISIMO S A S").clave, "interrapidisimo");
  assert.equal(guias.transportadoraDe("SERVIENTREGA").clave, "servientrega");
  assert.equal(guias.transportadoraDe("COORDINADORA MERCANTIL").clave, "coordinadora");
  // Si no la reconoce NO adivina: el enlace de rastreo iria a un cliente.
  assert.equal(guias.transportadoraDe("TRANSPORTES QUE NO CONOCEMOS"), null);
});

// --------------------------------------------------------------------------
// 2 · El puntaje
// --------------------------------------------------------------------------

test("un telefono exacto vale 50: por si solo alcanza el minimo", () => {
  const campos = guias.extraerCampos(etiqueta({ nombre: "QUIEN SEA", direccion: "OTRA PARTE", ciudad: "CALI" }));
  const { puntos } = guias.puntuar(campos, pedidoDePrueba());
  assert.ok(puntos >= guias.MINIMO, `el telefono solo dio ${puntos} puntos`);
});

test("el WhatsApp del cliente NO se cuenta dos veces si es el mismo numero", () => {
  // Contarlo doble infla la certeza sin mas evidencia.
  const campos = guias.extraerCampos(etiqueta());
  const { senales } = guias.puntuar(
    campos,
    // telefono del pedido == contactoId
    pedidoDePrueba({ contactoId: "573001112233", destinatario: { telefono: "3001112233" } })
  );
  assert.ok(senales.includes("telefono del pedido"));
  assert.ok(!senales.includes("numero de WhatsApp"), "conto el mismo numero como dos senales");
});

test("el WhatsApp SI suma cuando el cliente dio otro numero para la entrega", () => {
  // El caso real: el cliente da el numero del marido o del vecino que recibe.
  const campos = guias.extraerCampos(etiqueta({ telefono: "3001112233" }));
  const p = pedidoDePrueba({
    contactoId: "573009998877",
    destinatario: { telefono: "3001112233" },
  });
  const sinSegundo = guias.puntuar(campos, p);
  assert.ok(sinSegundo.senales.includes("telefono del pedido"));

  const campos2 = guias.extraerCampos(etiqueta({ telefono: "3009998877" }));
  const conChat = guias.puntuar(campos2, p);
  assert.ok(conChat.senales.includes("numero de WhatsApp"));
});

test("UN SOLO numero de direccion que coincide vale la mitad", () => {
  // "calle 80" coincide con cualquier direccion que tenga un 80. Dos o mas
  // ya es una direccion, no una casualidad.
  const unoSolo = guias.puntuar(
    guias.extraerCampos(["DIRECCION: CARRERA 80 SIN NADA MAS", "CIUDAD: CALI"]),
    pedidoDePrueba({ destinatario: { telefono: "", direccion: "Calle 80 # 12-34", ciudad: "Bogota" } })
  );
  assert.ok(unoSolo.puntos <= guias.PESOS.direccion / 2 + guias.PESOS.ciudad);
});

test("EL FALLO DE LA PLAYA: los municipios cuya primera palabra es corta tambien puntuan", () => {
  // Con solo la primera palabra, "LA" (2 letras) no se comparaba nunca y se
  // perdian los 10 puntos de la ciudad. Ocho municipios reales se quedaban
  // en 45 de 50.
  const municipios = [
    "La Playa", "El Cerrito", "La Dorada", "Los Patios",
    "La Union", "El Bagre", "San Gil", "La Virginia",
  ];

  for (const ciudad of municipios) {
    const campos = guias.extraerCampos([`CIUDAD: ${ciudad.toUpperCase()}`]);
    const { senales } = guias.puntuar(
      campos,
      pedidoDePrueba({ destinatario: { ciudad, telefono: "", direccion: "", nombre: "" } })
    );
    assert.ok(senales.includes("ciudad"), `no reconocio la ciudad "${ciudad}"`);
  }
});

test("la ciudad sola NUNCA alcanza el minimo", () => {
  // Vale 10 a proposito: coincidir en ciudad casi no informa, y un acierto
  // por casualidad no puede mandar nada.
  const campos = guias.extraerCampos(["CIUDAD: MEDELLIN"]);
  const { puntos } = guias.puntuar(
    campos,
    pedidoDePrueba({ destinatario: { ciudad: "Medellin", nombre: "", telefono: "", direccion: "" } })
  );
  assert.ok(puntos < guias.MINIMO);
});

test("un BSUID no se convierte en digitos ni entra al pareo como telefono", () => {
  // "CO.1098944123092301" sin simbolos da "1098944123092301", que parece un
  // telefono. Si entrara, podria coincidir por casualidad.
  const campos = guias.extraerCampos(["DESTINATARIO: QUIEN SEA", "TELEFONO: 3155551234", "1098944123092301"]);
  const { senales } = guias.puntuar(
    campos,
    pedidoDePrueba({
      contactoId: "CO.1098944123092301",
      destinatario: { telefono: "", nombre: "", ciudad: "", direccion: "" },
    })
  );
  assert.ok(!senales.includes("numero de WhatsApp"), "uso el BSUID como si fuera un telefono");
});

// --------------------------------------------------------------------------
// 3 · Los dos candados
// --------------------------------------------------------------------------

test("por debajo del minimo no se envia, y se dice CONTRA QUIEN y QUE falto", () => {
  // El mensaje viejo era "no corresponde a ningun pedido (mejor
  // coincidencia 45 de 50)". El dueno lo leyo y pregunto "no se por que".
  // Un error que no permite actuar no sirve.
  const campos = guias.extraerCampos(etiqueta({ nombre: "ANA MARIA PEREZ", telefono: "3209998877", ciudad: "CALI", direccion: "OTRA" }));
  const r = guias.emparejar(campos, [
    pedidoDePrueba({ destinatario: { nombre: "Ana Maria Perez", telefono: "3001112233", ciudad: "Medellin", direccion: "Calle 45 # 23-10" } }),
  ]);

  assert.equal(r.pedido, null, "envio una guia que no alcanzaba el minimo");
  assert.match(r.motivo, /Ana Maria Perez/, "no dice contra quien casi coincidio");
  assert.match(r.motivo, /Le falto/, "no dice que senal falto");
  assert.match(r.motivo, /3209998877/, "no dice el telefono que leyo en la etiqueta");
});

test("con 0 puntos NO se nombra a nadie", () => {
  // Decir "el mas parecido es Jorge" cuando Jorge no coincide en nada manda
  // al operador a mirar un pedido sin ninguna relacion con la etiqueta.
  const campos = guias.extraerCampos(["GUIA No. 999888777666", "DESTINATARIO: ZZZZ QQQQ", "CIUDAD: LETICIA"]);
  const r = guias.emparejar(campos, [pedidoDePrueba()]);
  assert.equal(r.pedido, null);
  assert.ok(!/Ana/.test(r.motivo), `nombro a un pedido que no coincide en nada: ${r.motivo}`);
  assert.match(r.motivo, /no se parece a ningun pedido/);
});

test("EL EMPATE ENTRE PERSONAS DISTINTAS NO SE ENVIA", () => {
  // Dos hermanos en la misma casa. Mandar la guia es filtrar la direccion y
  // el telefono de uno al otro.
  const campos = guias.extraerCampos(etiqueta({ nombre: "PEREZ", telefono: "3001112233", direccion: "CALLE 45 # 23-10" }));
  const r = guias.emparejar(campos, [
    pedidoDePrueba({ id: "NOV-A", contactoId: "573001112233", destinatario: { nombre: "Juan Perez", telefono: "3001112233" } }),
    pedidoDePrueba({ id: "NOV-B", contactoId: "573004445566", destinatario: { nombre: "Luis Perez", telefono: "3001112233" } }),
  ]);

  assert.equal(r.pedido, null, "envio una guia con un empate entre dos personas");
  assert.match(r.motivo, /[Ee]mpate/);
  assert.match(r.motivo, /datos personales/);
});

test("EL EMPATE DEL MISMO CLIENTE SI SE ENVIA, y queda anotado", () => {
  // El cliente que compra dos veces era justo el que nunca recibia su guia
  // automaticamente. Mandarsela no le filtra nada a nadie: es el mismo.
  const campos = guias.extraerCampos(etiqueta());
  const r = guias.emparejar(campos, [
    pedidoDePrueba({ id: "NOV-A", contactoId: "573001112233" }),
    pedidoDePrueba({ id: "NOV-B", contactoId: "573001112233" }),
  ]);

  assert.ok(r.pedido, "bloqueo el empate de dos pedidos del mismo cliente");
  assert.ok(
    r.senales.some((s) => /mismo cliente/.test(s)),
    "no dejo anotado que fue un empate del mismo cliente"
  );
});

test("ofrece los tres candidatos mas parecidos para asignar a mano", () => {
  // Sin esto, una guia que no cruza no tiene ninguna salida mas que mandarla
  // desde el WhatsApp del celular, que es lo que este flujo viene a quitar.
  const campos = guias.extraerCampos(etiqueta({ nombre: "PEREZ", telefono: "3209998877", ciudad: "CALI", direccion: "X" }));
  const r = guias.emparejar(campos, [
    pedidoDePrueba({ id: "NOV-A", destinatario: { nombre: "Juan Perez" } }),
    pedidoDePrueba({ id: "NOV-B", destinatario: { nombre: "Luis Perez" } }),
  ]);
  assert.equal(r.pedido, null);
  assert.ok(r.mejores.length >= 1);
  assert.ok(r.mejores.every((m) => m.pedidoId && typeof m.puntos === "number"));
});

// --------------------------------------------------------------------------
// 4 · El lote completo
// --------------------------------------------------------------------------

test("parea un lote y marca para enviar solo las que cruzan", () => {
  const ana = pedidoDePrueba({ id: "NOV-ANA", contactoId: "573001112233" });
  const filas = guias.parear({
    paginas: [
      etiqueta({ guia: "111111111111" }),
      etiqueta({ guia: "222222222222", nombre: "ZZZZ QQQQ", telefono: "3209990000", ciudad: "LETICIA", direccion: "X" }),
    ],
    pedidos: [ana],
  });

  assert.equal(filas.length, 2);
  assert.equal(filas[0].enviar, true);
  assert.equal(filas[0].pedido.id, "NOV-ANA");
  assert.equal(filas[1].enviar, false);
  // La que no cruzo SI se puede asignar a mano; la que cruzo no lo necesita.
  assert.equal(filas[1].asignable, true);
  assert.equal(filas[0].asignable, false);
});

test("una guia repetida DENTRO del mismo PDF no se manda dos veces ni se ofrece asignar", () => {
  // El operador imprimio dos veces la misma etiqueta. Asignarla a mano
  // seria mandarle dos veces lo mismo a alguien.
  const filas = guias.parear({
    paginas: [etiqueta({ guia: "111111111111" }), etiqueta({ guia: "111111111111" })],
    pedidos: [pedidoDePrueba()],
  });

  assert.equal(filas[0].enviar, true);
  assert.equal(filas[1].enviar, false);
  assert.equal(filas[1].asignable, false, "ofrecio asignar una guia duplicada");
  assert.match(filas[1].motivo, /ya venia en la pagina 1/);
});

test("una guia que ya se le aviso no se vuelve a enviar", () => {
  const filas = guias.parear({
    paginas: [etiqueta({ guia: "111111111111" })],
    pedidos: [pedidoDePrueba()],
    yaEnviada: (g) => (g === "111111111111" ? { nombre: "Ana", cuando: "ayer" } : null),
  });

  assert.equal(filas[0].enviar, false);
  assert.equal(filas[0].asignable, false);
  assert.match(filas[0].motivo, /ya se le envio/);
});

// --------------------------------------------------------------------------
// 5 · A quien se le manda, y que se le dice
// --------------------------------------------------------------------------

test("la guia se manda al WhatsApp del chat, NO al telefono impreso en la etiqueta", () => {
  // El telefono de la etiqueta puede ser de quien recibe el paquete. Ahi el
  // mensaje no llegaria, o llegaria a un desconocido con los datos dentro.
  const p = pedidoDePrueba({ contactoId: "573009998877", destinatario: { telefono: "3001112233" } });
  assert.equal(guias.destinoDe(p), "573009998877");
});

test("a un cliente con nombre de usuario se le manda por su BSUID, tal cual", () => {
  const p = pedidoDePrueba({ contactoId: "CO.1098944123092301", destinatario: { telefono: "3001112233" } });
  assert.equal(guias.destinoDe(p), "CO.1098944123092301");
});

test("sin chat utilizable cae al telefono del pedido", () => {
  const p = pedidoDePrueba({ contactoId: "", destinatario: { telefono: "3001112233" } });
  assert.equal(guias.destinoDe(p), "3001112233");
});

test("el mensaje al cliente NO promete una fecha de entrega", () => {
  // Ese dato lo decide la transportadora. Prometerlo convierte un retraso
  // suyo en un incumplimiento nuestro.
  const texto = guias.textoParaCliente(
    pedidoDePrueba(),
    "240061604892",
    guias.transportadoraDe("INTER RAPIDISIMO")
  );
  assert.ok(!/\b\d+\s*(a|-)\s*\d+\s*d[ií]as?\b/i.test(texto), `promete un plazo: ${texto}`);
  assert.ok(!/manana|llega el|entrega el/i.test(texto), `promete una fecha: ${texto}`);
});

test("el mensaje dice el importe a pagar, tomado del snapshot del pedido", () => {
  // Es lo que mas consultan al recibir, y decirlo evita la discusion con el
  // mensajero en la puerta. Sale del pedido, no de una cotizacion nueva.
  const texto = guias.textoParaCliente(pedidoDePrueba({ cotizacion: { total: 89000 } }), "111", null);
  assert.match(texto, /89\.000/);
});

test("el mensaje lleva la guia y el enlace de rastreo de SU transportadora", () => {
  const texto = guias.textoParaCliente(
    pedidoDePrueba(),
    "240061604892",
    guias.transportadoraDe("SERVIENTREGA")
  );
  assert.match(texto, /240061604892/);
  assert.match(texto, /servientrega\.com/);
});

test("el nombre del archivo es de NOVIKA, no de otra marca", () => {
  // El cliente lo ve en WhatsApp. El aislamiento respecto a BIKERPRO
  // tambien es lo que el cliente lee.
  assert.match(guias.nombreArchivo("240061604892"), /^guia-240061604892-novika\.pdf$/);
  assert.ok(!/biker/i.test(guias.nombreArchivo("1")));
});
