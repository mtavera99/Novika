"use strict";

// ==========================================================================
// LA ENTREGA Y LA CAJA · VENDIDO NO ES RECAUDADO
//
// DE DONDE SALE: Marco pidio el panel de BIKERPRO y nombro, entre otras
// cosas, "pedidos entregados" y "cuanto vamos recaudado".
//
// Al ir a hacerlo aparecio que NO ERA UN INDICADOR QUE FALTABA: era un
// estado que faltaba. El sistema no sabia que un pedido se habia
// ENTREGADO, asi que "recaudado" se contestaba con el importe de los
// pedidos vivos — es decir, con lo VENDIDO.
//
// ESTE NEGOCIO ES CONTRAENTREGA: el cliente paga en la puerta. Un pedido
// confirmado, e incluso uno despachado, no es plata cobrada: es plata en
// riesgo, y encima el flete ya se gasto. La diferencia entre las dos cifras
// es la tasa de rechazo, que en la referencia de BIKERPRO es el numero que
// decide si el canal es rentable (al 5% lo era, al 32% no).
//
// Lo que estas pruebas protegen:
//
//   1. Que no se pueda cuadrar la caja con pedidos que nunca salieron.
//   2. Que el importe recaudado quede CONGELADO al entregar.
//   3. EL FAN-OUT: añadir un valor a un enum rompe los sitios que usaban
//      `!== "despachado"` para decir "pendiente". El peor es la pila de
//      trabajo del dia.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");

const ayuda = require("./ayuda");
const DIR = ayuda.entornoDePrueba();

const dominioPedido = require("../src/dominio/pedido");
const cotizador = require("../src/dominio/cotizador");
const analitica = require("../src/panel/analitica");
const atencion = require("../src/almacen/atencion");

const PRODUCTO = {
  id: "cinturon",
  nombre: "Cinturón",
  activo: true,
  motorDePrecio: "tabla",
  precios: { 1: 100000, 2: 180000 },
  pago: { metodo: "contraentrega", etiqueta: "Pagas al recibir" },
  logistica: { politicaEnvio: { tipo: "incluido" } },
};

let n = 0;
function unPedido({ cantidad = 1 } = {}) {
  n++;
  const cot = cotizador.cotizar({
    producto: PRODUCTO,
    cantidad,
    destino: { ciudad: "Palmira", departamento: "Valle del Cauca" },
  });
  const r = dominioPedido.construir({
    cotizacion: cot.cotizacion,
    datos: {
      nombre: "Luz Marina",
      telefono: "3001110001",
      ciudad: "Palmira",
      departamento: "Valle del Cauca",
      direccion: "Calle 20 # 15-30",
    },
    contactoId: `57300111${String(n).padStart(4, "0")}`,
    conversacionId: `conv-${n}`,
    ofertaId: `of-${n}`,
    wamidConfirmacion: `wamid.of-${n}`,
  });
  assert.equal(r.ok, true, `el pedido de prueba no se armo: ${(r.falta || []).join(",")}`);
  return r.pedido;
}

const despachado = (p, guia = "G-1") => {
  const r = dominioPedido.despachar({ pedido: p, guia });
  assert.ok(r.ok, r.motivo);
  return r.pedido;
};

const entregado = (p) => {
  const r = dominioPedido.entregar({ pedido: p });
  assert.ok(r.ok, r.motivo);
  return r.pedido;
};

// --------------------------------------------------------------------------
// 1 · LA TRANSICION
// --------------------------------------------------------------------------

describe("1 · entregar un pedido", () => {
  test("solo se entrega lo que YA SALIO despachado", () => {
    // Dejar marcar entregado un pedido que nunca se envio permite cuadrar
    // la caja contra un paquete que no existe. Es la forma mas facil de que
    // los numeros del panel dejen de significar algo.
    const sinSalir = unPedido();
    const r = dominioPedido.entregar({ pedido: sinSalir });
    assert.equal(r.ok, false);
    assert.match(r.motivo, /ya salio despachado/i, r.motivo);
  });

  test("un cancelado tampoco se entrega", () => {
    const c = dominioPedido.cancelar({ pedido: unPedido(), motivo: "la clienta cambio de idea" });
    assert.ok(c.ok, c.motivo);
    assert.equal(dominioPedido.entregar({ pedido: c.pedido }).ok, false);
  });

  test("desde despachado sí, y sube la versión", () => {
    const d = despachado(unPedido());
    const r = dominioPedido.entregar({ pedido: d });
    assert.ok(r.ok, r.motivo);
    assert.equal(r.pedido.estado, "entregado");
    assert.equal(r.pedido.version, d.version + 1);
    assert.equal(r.yaEstaba, false);
    // La guia se conserva: un entregado sigue siendo rastreable, y el motor
    // lo exige (restriccion `pedidos_entregado_con_guia` de la 004).
    assert.equal(r.pedido.despacho.guia, "G-1");
  });

  test("queda en el historial, que es lo que explica la caja", () => {
    const e = entregado(despachado(unPedido()));
    const ultimo = e.historial[e.historial.length - 1];
    assert.equal(ultimo.accion, "entregado");
    assert.equal(ultimo.importeRecaudado, 100000);
  });

  test("el importe recaudado se CONGELA al entregar", () => {
    // Si manana alguien modifica la cotizacion, la caja de ayer no se
    // mueve. Por eso el importe se guarda, en vez de leerse del total
    // actual del pedido cada vez que se suma el dia.
    const e = entregado(despachado(unPedido({ cantidad: 2 })));
    assert.equal(e.entrega.importeRecaudado, 180000);

    const tocado = JSON.parse(JSON.stringify(e));
    tocado.cotizacion.total = 1;
    const c = analitica.caja({ pedidos: [tocado] });
    assert.equal(c.recaudado, 180000, "la caja se movió al cambiar la cotización");
  });

  test("marcarlo dos veces no duplica nada", () => {
    const e = entregado(despachado(unPedido()));
    const otra = dominioPedido.entregar({ pedido: e });
    assert.ok(otra.ok);
    assert.equal(otra.yaEstaba, true);
    assert.equal(otra.pedido.version, e.version, "subió la versión sin que cambiara nada");
  });
});

// --------------------------------------------------------------------------
// 2 · LA CAJA
// --------------------------------------------------------------------------

describe("2 · facturado, recaudado y en riesgo son tres cifras", () => {
  test("solo lo entregado cuenta como recaudado", () => {
    const pedidos = [
      unPedido(), // confirmado, sin salir
      despachado(unPedido(), "G-2"), // en la calle
      entregado(despachado(unPedido(), "G-3")), // cobrado
    ];
    const c = analitica.caja({ pedidos });

    assert.equal(c.facturado, 300000, "el facturado son los tres");
    assert.equal(c.recaudado, 100000, "solo el entregado es plata que entró");
    assert.equal(c.enRiesgo, 200000, "lo que salió y lo que no ha salido");
    assert.equal(c.pedidos.entregados, 1);
    assert.equal(c.pedidos.despachados, 1);
    assert.equal(c.pedidos.sinSalir, 1);
  });

  test("un cancelado no es facturado ni recaudado", () => {
    const cancelado = dominioPedido.cancelar({ pedido: unPedido(), motivo: "se arrepintio" }).pedido;
    const c = analitica.caja({ pedidos: [cancelado, entregado(despachado(unPedido(), "G-4"))] });
    assert.equal(c.facturado, 100000);
    assert.equal(c.recaudado, 100000);
    assert.equal(c.pedidos.cancelados, 1);
  });

  test("«de lo que salió, entregado» se mide SOLO sobre lo que salió", () => {
    // Una cancelacion de antes de despachar no es una entrega fallida:
    // nunca hubo intento. Meterla en el denominador daria un porcentaje que
    // no habla de entregas.
    const canceladoAntes = dominioPedido.cancelar({ pedido: unPedido(), motivo: "se arrepintio" }).pedido;
    const sinSalir = unPedido();
    const enCamino = despachado(unPedido(), "G-5");
    const llego = entregado(despachado(unPedido(), "G-6"));

    const c = analitica.caja({ pedidos: [canceladoAntes, sinSalir, enCamino, llego] });
    // Salieron 2 (uno en la calle + uno entregado). Entregado 1 -> 50%.
    assert.equal(c.entregadoDeLoQueSalio, 50);
  });

  test("y NO se presenta como la tasa de rechazo, porque no lo es", () => {
    // Hallazgo al construir esto: `cancelar` se NIEGA sobre un pedido
    // despachado, asi que una entrega FALLIDA no se puede registrar. Un
    // paquete que volvio es hoy indistinguible de uno que va en camino.
    //
    // Por eso la cifra no se llama tasa de entrega: llamarla asi daria por
    // rechazado todo lo que va en camino. La pantalla lo dice.
    const despachadoYa = despachado(unPedido(), "G-7");
    const r = dominioPedido.cancelar({ pedido: despachadoYa, motivo: "rechazado en la entrega" });
    assert.equal(r.ok, false, "si esto ya se puede cancelar, la tasa de rechazo YA se puede medir");
    assert.match(r.motivo, /ya salio/i);

    assert.equal(analitica.caja({ pedidos: [despachadoYa] }).faltaEstadoDevuelto, true);
  });

  test("sin datos devuelve null, NUNCA 0", () => {
    // Un 0% inventado se lee como "esto va malisimo". Es la misma regla que
    // ya sigue el embudo.
    const c = analitica.caja({ pedidos: [] });
    assert.equal(c.entregadoDeLoQueSalio, null);
    assert.equal(c.hayDatos, false);
  });

  test("avisa cuando NADIE ha marcado entregas", () => {
    // $0 recaudado con ventas confirmadas no significa que no se haya
    // cobrado: significa que no se registro. La vista tiene que decirlo en
    // vez de mostrar un cero a secas.
    const c = analitica.caja({ pedidos: [despachado(unPedido(), "G-8")] });
    assert.equal(c.recaudado, 0);
    assert.equal(c.hayDatos, true);
    assert.equal(c.hayEntregasRegistradas, false);
  });
});

// --------------------------------------------------------------------------
// 3 · EL FAN-OUT DEL ESTADO NUEVO
//
// Es el riesgo de verdad de añadir un valor a un enum: los sitios que
// decian "pendiente" con un `!== "despachado"`.
// --------------------------------------------------------------------------

describe("3 · un entregado no se cuela donde no debe", () => {
  test("NO aparece en la pila de «por despachar»", () => {
    // El peor de los sitios: es la lista por la que se trabaja. Con el
    // filtro viejo, los paquetes ya entregados habrian engordado la pila
    // de pendientes del dia.
    const d = analitica.despachos({
      pedidos: [unPedido(), despachado(unPedido(), "G-9"), entregado(despachado(unPedido(), "G-10"))],
    });
    assert.equal(d.porDespachar.length, 1, "un entregado o un despachado se colaron como pendientes");
    assert.equal(d.despachados.length, 1);
    assert.equal(d.entregados.length, 1);
  });

  test("llega a la ÚLTIMA etapa del embudo, no se queda en «confirmado»", () => {
    const p = entregado(despachado(unPedido(), "G-11"));
    assert.equal(analitica.etapaDe({ estado: "cotizado" }, [p]), "entregado");
    // Y el embudo termina en entregado: un embudo que acaba en "despachado"
    // da por ganada una venta que todavia puede caerse.
    assert.equal(analitica.ETAPAS[analitica.ETAPAS.length - 1].id, "entregado");
  });

  test("una novedad abierta sigue viéndose aunque el pedido se entregara", () => {
    const conNovedad = dominioPedido.registrarNovedad({
      pedido: despachado(unPedido(), "G-12"),
      tipo: "ausente",
    }).pedido;
    const e = entregado(conNovedad);
    const d = analitica.despachos({ pedidos: [e] });
    assert.equal(d.conNovedad.length, 1, "se perdió una incidencia abierta al entregar");
    assert.equal(d.porTipo.ausente, 1);
  });

  test("y deja de ser el pedido «vivo» del contacto", async () => {
    // A quien ya recibio su pedido hay que dejarle comprar otra vez. Si un
    // entregado contara como vivo, la clienta que vuelve acabaria
    // modificando el pedido que ya tiene en casa.
    //
    // La lista de estados cerrados vive en el DOMINIO porque los dos
    // backends del almacen la necesitan. Dos copias se separan.
    assert.ok(dominioPedido.CERRADOS.has("entregado"));
    assert.ok(dominioPedido.CERRADOS.has("despachado"));
    assert.ok(dominioPedido.CERRADOS.has("cancelado"));
    assert.equal(dominioPedido.CERRADOS.has("confirmado"), false);

    const { crearReposDeArchivos } = require("../src/almacen/repos/archivos");
    const repos = await crearReposDeArchivos({ dir: DIR });
    const p = unPedido();
    await repos.pedidos.crearSiNoExiste(p);
    assert.ok(await repos.pedidos.activoDeContacto(p.contactoId), "debería estar vivo al confirmarse");

    await repos.pedidos.reemplazar(entregado(despachado(p, "G-13")));
    assert.equal(
      await repos.pedidos.activoDeContacto(p.contactoId),
      null,
      "un pedido entregado seguía siendo el pedido vivo del contacto"
    );
  });
});

// --------------------------------------------------------------------------
// 4 · QUIEN CONTESTO: EL BOT O UNA PERSONA
// --------------------------------------------------------------------------

describe("4 · cuántos chats resolvió el bot", () => {
  const chat = (mensajes) => ({ mensajes });
  const delBot = { de: atencion.QUIEN.BOT, estado: "enviado" };
  const dePersona = { de: atencion.QUIEN.OPERADOR, estado: "enviado" };
  const delCliente = { de: atencion.QUIEN.CLIENTE };

  test("separa los que resolvió el bot de los que tocó una persona", () => {
    const a = analitica.atendidos({
      conversaciones: [
        chat([delCliente, delBot]), // solo bot
        chat([delCliente, delBot, dePersona]), // entró una persona
        chat([delCliente]), // sin responder
      ],
    });
    assert.equal(a.soloBot, 1);
    assert.equal(a.conPersona, 1);
    assert.equal(a.sinRespuesta, 1);
    assert.equal(a.contestados, 2);
    // Sobre los CONTESTADOS, no sobre el total: un chat sin responder no es
    // merito ni demerito del bot.
    assert.equal(a.porcentajeDelBot, 50);
  });

  test("un mensaje BLOQUEADO no cuenta como respondido", () => {
    // El emisor puede bloquear un mensaje -fuera de la lista de prueba,
    // chat pausado, fallo de envio-. Contarlo diria que atendimos a alguien
    // que nunca recibio nada.
    const a = analitica.atendidos({
      conversaciones: [chat([delCliente, { de: atencion.QUIEN.BOT, estado: "conversacion_pausada" }])],
    });
    assert.equal(a.soloBot, 0);
    assert.equal(a.sinRespuesta, 1);
  });

  test("sin conversaciones devuelve null, no 0%", () => {
    const a = analitica.atendidos({ conversaciones: [] });
    assert.equal(a.porcentajeDelBot, null);
    assert.equal(a.total, 0);
  });
});

// --------------------------------------------------------------------------
// 5 · EL CELULAR SIEMPRE SE EXIGE
//
// Marco: "no se te olvide SIEMPRE requerir el numero de celular para los
// pedidos".
//
// No es un capricho: la transportadora llama al celular, y sin el un pedido
// contraentrega se convierte en un paquete que vuelve. Y hay un caso donde
// el numero NO llega solo: los clientes con NOMBRE DE USUARIO de WhatsApp
// (BSUID `CO.…`), que no traen telefono. El 07-oct, TRES de los quince
// chats del dia eran de esos.
//
// Esta bateria existe para que esa exigencia no se caiga en silencio: es un
// requisito de negocio, no un detalle de implementacion.
// --------------------------------------------------------------------------

describe("5 · nunca un pedido sin número de celular", () => {
  test("el celular está entre los datos requeridos para despachar", () => {
    assert.ok(
      dominioPedido.REQUERIDOS_PARA_DESPACHAR.includes("telefono"),
      "se cayó la exigencia del celular: un pedido sin él es un paquete que vuelve"
    );
  });

  test("un pedido SIN celular no se construye", () => {
    const cot = cotizador.cotizar({
      producto: PRODUCTO,
      cantidad: 1,
      destino: { ciudad: "Palmira", departamento: "Valle del Cauca" },
    });
    const r = dominioPedido.construir({
      cotizacion: cot.cotizacion,
      datos: {
        nombre: "Luz Marina",
        ciudad: "Palmira",
        departamento: "Valle del Cauca",
        direccion: "Calle 20 # 15-30",
      },
      // Un cliente con nombre de usuario de WhatsApp: no trae telefono.
      contactoId: "CO.1667873168388823",
      conversacionId: "conv-sin-tel",
      ofertaId: "of-sin-tel",
      wamidConfirmacion: "wamid.sin-tel",
    });

    assert.equal(r.ok, false, "dejó crear un pedido sin celular");
    assert.ok(r.falta.includes("telefono"), JSON.stringify(r.falta));
  });

  test("y tampoco se despacha, aunque alguien lo fuerce", () => {
    // La segunda red: si un pedido llegara sin celular por otro camino, el
    // despacho tiene que negarse igual.
    const cot = cotizador.cotizar({
      producto: PRODUCTO,
      cantidad: 1,
      destino: { ciudad: "Palmira", departamento: "Valle del Cauca" },
    });
    const armado = dominioPedido.construir({
      cotizacion: cot.cotizacion,
      datos: {
        nombre: "Luz Marina",
        telefono: "3001110001",
        ciudad: "Palmira",
        departamento: "Valle del Cauca",
        direccion: "Calle 20 # 15-30",
      },
      contactoId: "573001110099",
      conversacionId: "conv-f",
      ofertaId: "of-f",
      wamidConfirmacion: "wamid.f",
    });
    assert.equal(armado.ok, true);

    const sinTelefono = JSON.parse(JSON.stringify(armado.pedido));
    delete sinTelefono.destinatario.telefono;

    const listo = dominioPedido.listoParaDespachar(sinTelefono);
    assert.equal(listo.ok, false, "habría despachado un pedido sin celular");
    assert.match(listo.motivo, /telefono/i, listo.motivo);
  });

  test("y cuando no lo tenemos, el bot LO PIDE con esa palabra", () => {
    // El caso real: cliente con nombre de usuario, sin telefono. Si el bot
    // no lo pide, el pedido se queda a medias y nadie sabe por que.
    const responder = require("../src/cerebro/responder");
    const path = require("node:path");
    const { cargarCatalogo } = require("../src/catalogo");
    const producto = cargarCatalogo({
      carpeta: path.join(__dirname, "..", "catalogo", "productos"),
      refrescar: true,
    }).porId.get("cinturon-termico-colicos");

    const texto = responder.textoDeterminista({
      situacion: "faltan_datos",
      cotizacion: cotizador.cotizar({ producto, cantidad: 1 }).cotizacion,
      faltan: ["nombre", "telefono", "ciudad", "direccion"],
      producto,
      mensajeCliente: "lo quiero",
      memoria: { saludado: true },
    });

    assert.match(texto, /n[úu]mero de celular/i, `no pidió el celular: ${texto}`);
  });
});
