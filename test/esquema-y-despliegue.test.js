"use strict";

// ==========================================================================
// EL PANEL SE QUEDO SIN UN SOLO CHAT · 2026-10-08
//
// --------------------------------------------------------------------------
// QUE PASO
// --------------------------------------------------------------------------
//
// Al añadir el estado `entregado` se creo la columna `pedidos.entrega` en la
// migracion 004, el adaptador empezo a escribirla, y se añadio a
// `COLUMNAS_REQUERIDAS`. Todo coherente... salvo UNA cosa: las migraciones
// de este proyecto SE APLICAN A MANO, a proposito (`npm run migrar` es un
// comando aparte, no un efecto de desplegar).
//
// Asi que en produccion el codigo nuevo arranco contra una base SIN esa
// columna:
//
//   revisarEsquema lanza -> crearRepos lanza -> no hay cerebro ->
//   el panel no muestra NI UN CHAT y el webhook no procesa nada.
//
// Y lo peor es como se ve desde fuera: no se ve un error de esquema, se ve
// un panel VACIO. Es indistinguible de haber perdido los datos. Marco lo
// reporto asi: "ni siquiera salen los chats de ayer... escribo desde mi
// numero y cero chats".
//
// Los datos estaban intactos. El servicio no podia leer la base.
//
// --------------------------------------------------------------------------
// LA LECCION, Y POR QUE ESTA PRUEBA
// --------------------------------------------------------------------------
//
// La leccion NO es "no comprobar el esquema": esa comprobacion es buena y se
// queda, porque un arranque que falla es ruidoso y barato comparado con un
// "column does not exist" a mitad de una venta.
//
// La leccion es que hay DOS listas que tienen que decir lo mismo, y nadie
// las comparaba:
//
//   · lo que el adaptador ESCRIBE  (COLUMNAS_PEDIDO)
//   · lo que el arranque EXIGE     (COLUMNAS_REQUERIDAS)
//
// Exigir una columna que no se escribe convierte un despliegue normal en una
// caida total, y no aporta nada: si no se escribe, no puede faltar.
//
// Es el mismo patron que ya mordio dos veces en este repo -dos listas de
// "pregunta de precio" separadas, y el filtro de pedido activo duplicado en
// cada backend-. Aqui la copia no se puede unificar, porque son dos cosas
// distintas; lo que se puede es exigir que una sea subconjunto de la otra.
// ==========================================================================

const { test, describe } = require("node:test");
const assert = require("node:assert");

const ayuda = require("./ayuda");
ayuda.entornoDePrueba();

const { COLUMNAS_REQUERIDAS, TABLAS_REQUERIDAS } = require("../src/almacen/repos");
const pg = require("../src/almacen/repos/postgres");
const dominioPedido = require("../src/dominio/pedido");
const cotizador = require("../src/dominio/cotizador");

const PRODUCTO = {
  id: "cinturon",
  nombre: "Cinturón",
  activo: true,
  motorDePrecio: "tabla",
  precios: { 1: 100000, 2: 180000 },
  pago: { metodo: "contraentrega", etiqueta: "Pagas al recibir" },
  logistica: { politicaEnvio: { tipo: "incluido" } },
};

function unPedidoEntregado() {
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
    contactoId: "573001110001",
    conversacionId: "conv-1",
    ofertaId: "of-1",
    wamidConfirmacion: "wamid.of-1",
  });
  assert.equal(armado.ok, true, (armado.falta || []).join(","));

  const d = dominioPedido.despachar({ pedido: armado.pedido, guia: "G-1" });
  assert.ok(d.ok, d.motivo);
  const e = dominioPedido.entregar({ pedido: d.pedido });
  assert.ok(e.ok, e.motivo);
  return e.pedido;
}

// --------------------------------------------------------------------------
// 1 · LO QUE SE EXIGE AL ARRANCAR TIENE QUE SER LO QUE SE ESCRIBE
// --------------------------------------------------------------------------

describe("1 · el arranque no exige columnas que el adaptador no escribe", () => {
  test("toda columna requerida de `pedidos` es una que el adaptador escribe", () => {
    // ESTA ES LA PRUEBA QUE HABRIA EVITADO LA CAIDA.
    //
    // Si alguien vuelve a exigir una columna sin que el adaptador la
    // escriba, esto falla aqui -en un segundo- en vez de fallar en
    // produccion dejando el panel vacio.
    const escribe = new Set(pg.COLUMNAS_PEDIDO);
    for (const col of COLUMNAS_REQUERIDAS.pedidos) {
      assert.ok(
        escribe.has(col),
        `se exige la columna "pedidos.${col}" al arrancar, pero el adaptador NO la escribe. ` +
          `Exigir lo que no se escribe convierte un despliegue normal en una caída total, ` +
          `y no protege de nada: si no se escribe, no puede faltar.`
      );
    }
  });

  test("y `entrega` NO está entre las exigidas, a propósito", () => {
    // El dato de la entrega viaja en `extra JSONB`, que es sin esquema. Si
    // algun dia se le da columna propia, el orden es: migrar, comprobar, y
    // DESPUES desplegar el codigo que la escribe. Nunca en el mismo
    // despliegue.
    assert.equal(
      COLUMNAS_REQUERIDAS.pedidos.includes("entrega"),
      false,
      "volvió la columna que tumbó el servicio el 2026-10-08"
    );
    assert.equal(pg.COLUMNAS_PEDIDO.includes("entrega"), false);
  });

  test("las tablas requeridas siguen siendo las cuatro de siempre", () => {
    // Una tabla que falta SI es un fallo de verdad: sin ella no hay nada
    // que leer. Esta comprobacion se queda.
    assert.deepEqual(
      [...TABLAS_REQUERIDAS].sort(),
      ["contactos", "conversaciones", "pedidos", "pedidos_historial"]
    );
  });
});

// --------------------------------------------------------------------------
// 2 · UN PEDIDO ENTREGADO SOBREVIVE EN CUALQUIER VERSION DEL ESQUEMA
// --------------------------------------------------------------------------

describe("2 · la entrega se guarda sin necesitar columna nueva", () => {
  test("`entrega` viaja en `extra`, no en una columna", () => {
    const fila = pg.pedidoAFila(unPedidoEntregado());
    assert.equal(fila.entrega, undefined, "le dio columna propia: vuelve a exigir migrar antes de desplegar");
    assert.ok(fila.extra && fila.extra.entrega, "la entrega no llegó a `extra`: se perdería al guardar");
    assert.equal(fila.extra.entrega.importeRecaudado, 100000);
  });

  test("y vuelve entera al leerla", () => {
    // La garantia del contrato: "un registro guardado se devuelve igual".
    // Es lo que hace que el dato no dependa de la version de la base.
    const original = unPedidoEntregado();
    const vuelta = pg.filaAPedido(pg.pedidoAFila(original), original.historial);

    assert.equal(vuelta.estado, "entregado");
    assert.deepEqual(vuelta.entrega, original.entrega);
    assert.equal(vuelta.despacho.guia, "G-1", "y sigue teniendo guía, que el motor exige");
  });

  test("el estado entregado NO está en el CHECK de la 001: lo añade la 004", () => {
    // Lo UNICO que la 004 necesita cambiar son restricciones. Si no esta
    // aplicada, marcar entregado falla con una violacion de CHECK -una
    // accion concreta que no sale- en vez de tumbar el arranque completo.
    const fs = require("node:fs");
    const path = require("node:path");
    const carpeta = path.join(__dirname, "..", "migraciones");

    const inicial = fs.readFileSync(path.join(carpeta, "001-esquema-inicial.sql"), "utf8");
    assert.equal(/entregado/.test(inicial), false, "la 001 no se edita: tiene checksum");

    const cuarta = fs.readFileSync(path.join(carpeta, "004-entrega-y-recaudo.sql"), "utf8");
    assert.match(cuarta, /CHECK \(estado IN \([^)]*'entregado'\)\)/, "la 004 debe permitir el estado nuevo");
    // Y NO crea columnas: fue lo que provoco la caida.
    assert.equal(
      /ADD COLUMN/i.test(cuarta),
      false,
      "la 004 volvió a crear una columna: eso obliga a migrar antes de desplegar"
    );
  });
});
