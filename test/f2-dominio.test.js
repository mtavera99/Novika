"use strict";

// ==========================================================================
// POR QUE EXISTE ESTA BATERIA
//
// Cubre las piezas puras que sostienen todo lo demas: estados, candidatos
// frente a datos confirmados, y validacion del destino.
//
// La asercion mas importante es la de valorConfirmado(): devuelve null
// cuando el dato no esta confirmado, y NO el candidato "por si sirve". Esa
// linea es la frontera entre lo que propuso el modelo y lo que se puede
// despachar. Si alguien la "mejora" para que devuelva el candidato, el
// sistema entero deja de tener esa frontera.
// ==========================================================================

const { test } = require("node:test");
const assert = require("node:assert");

require("./ayuda").entornoDePrueba();
const estados = require("../src/dominio/estados");
const campos = require("../src/dominio/campos");
const destino = require("../src/dominio/destino");
const texto = require("../src/dominio/texto");

// --------------------------------------------------------------------------
// Estados
// --------------------------------------------------------------------------

test("las transiciones validas se permiten", () => {
  const r = estados.transicionar(estados.ESTADOS.PENDIENTE_CONFIRMACION, estados.ESTADOS.CONFIRMADO);
  assert.equal(r.ok, true);
  assert.equal(r.estado, estados.ESTADOS.CONFIRMADO);
});

test("CONFIRMADO no puede volver a COTIZADO", () => {
  // Un pedido confirmado no se recotiza por un mensaje suelto. Para cambiar
  // algo hay que pasar por MODIFICANDO, que tiene nombre y deja rastro.
  const r = estados.transicionar(estados.ESTADOS.CONFIRMADO, estados.ESTADOS.COTIZADO);
  assert.equal(r.ok, false);
  assert.equal(r.estado, estados.ESTADOS.CONFIRMADO, "ante una transicion invalida se queda donde estaba");
});

test("CONFIRMADO no puede volver a capturar datos", () => {
  assert.equal(estados.puedeTransicionar(estados.ESTADOS.CONFIRMADO, estados.ESTADOS.CAPTURANDO_DATOS), false);
});

test("desde CONFIRMADO solo salen caminos con nombre", () => {
  const permitidos = estados.TRANSICIONES[estados.ESTADOS.CONFIRMADO];
  assert.deepEqual(
    [...permitidos].sort(),
    [
      estados.ESTADOS.CANCELADO,
      estados.ESTADOS.CONFIRMADO,
      estados.ESTADOS.ESCALADO,
      estados.ESTADOS.MODIFICANDO,
      estados.ESTADOS.POSVENTA,
    ].sort()
  );
});

test("los estados con pedido vivo estan blindados contra recotizar", () => {
  assert.equal(estados.estaBlindado(estados.ESTADOS.CONFIRMADO), true);
  assert.equal(estados.estaBlindado(estados.ESTADOS.MODIFICANDO), true);
  assert.equal(estados.estaBlindado(estados.ESTADOS.POSVENTA), true);
  assert.equal(estados.estaBlindado(estados.ESTADOS.COTIZADO), false);
});

test("ESCALADO es absorbente: el bot no retoma una conversacion con una persona dentro", () => {
  for (const hacia of [estados.ESTADOS.COTIZADO, estados.ESTADOS.CONFIRMADO, estados.ESTADOS.EXPLORANDO]) {
    assert.equal(estados.puedeTransicionar(estados.ESTADOS.ESCALADO, hacia), false, `no deberia ir a ${hacia}`);
  }
});

test("un estado inventado se rechaza sin lanzar", () => {
  const r = estados.transicionar(estados.ESTADOS.NUEVO, "inventado");
  assert.equal(r.ok, false);
  assert.match(r.motivo, /no es un estado conocido/);
});

// --------------------------------------------------------------------------
// Candidato vs confirmado
// --------------------------------------------------------------------------

test("una ficha nueva tiene todos los campos vacios y explicitos", () => {
  const f = campos.fichaVacia();
  for (const nombre of campos.CAMPOS) {
    assert.equal(f[nombre].estado, campos.ESTADO_CAMPO.VACIO, `${nombre} deberia estar vacio`);
    assert.equal(f[nombre].valor, null);
  }
});

test("valorConfirmado devuelve null para un candidato: la frontera del sistema", () => {
  let c = campos.proponer(campos.campoVacio(), "Medellín", campos.ORIGENES.IA);
  assert.equal(c.estado, campos.ESTADO_CAMPO.CANDIDATO);
  assert.equal(campos.valorConfirmado(c), null, "un candidato NO es un hecho");
  assert.equal(campos.valorCandidato(c), "Medellín");
});

test("un candidato validado se confirma y se normaliza", () => {
  let c = campos.proponer(campos.campoVacio(), "medellin", campos.ORIGENES.IA);
  c = campos.confirmar(c, (v) => ({ ok: true, valor: destino.titular(v) }));
  assert.equal(c.estado, campos.ESTADO_CAMPO.CONFIRMADO);
  assert.equal(campos.valorConfirmado(c), "Medellin");
});

test("un candidato que falla la validacion queda RECHAZADO con su motivo", () => {
  let c = campos.proponer(campos.campoVacio(), "mi casa", campos.ORIGENES.IA);
  c = campos.confirmar(c, () => ({ ok: false, motivo: "no es una direccion" }));
  assert.equal(c.estado, campos.ESTADO_CAMPO.RECHAZADO);
  assert.equal(c.motivo, "no es una direccion");
  // Se conserva el valor: "el cliente dijo algo que no supimos validar" es
  // informacion util para una persona. Borrarlo lo convierte en un hueco.
  assert.equal(c.valor, "mi casa");
});

test("un candidato NO pisa un dato ya confirmado", () => {
  let c = campos.proponer(campos.campoVacio(), "Medellín", campos.ORIGENES.CLIENTE);
  c = campos.confirmar(c, (v) => ({ ok: true, valor: v }));
  const despues = campos.proponer(c, "Cali", campos.ORIGENES.IA);
  assert.equal(campos.valorConfirmado(despues), "Medellín", "la IA sobrescribio un dato confirmado");
  assert.ok(despues.historial.some((h) => h.accion === "propuesta_ignorada"));
});

test("reabrir permite modificar un dato confirmado, y deja rastro", () => {
  let c = campos.proponer(campos.campoVacio(), "Medellín", campos.ORIGENES.CLIENTE);
  c = campos.confirmar(c, (v) => ({ ok: true, valor: v }));
  c = campos.reabrir(c, "el cliente pidio cambiar la ciudad");
  assert.equal(c.estado, campos.ESTADO_CAMPO.CANDIDATO);
  assert.ok(c.historial.some((h) => h.accion === "reabierto"));
});

test("faltantes devuelve nombres, para poder decir exactamente que falta", () => {
  const f = campos.fichaVacia();
  const faltan = campos.faltantes(f, ["nombre", "telefono", "ciudad"]);
  assert.deepEqual(faltan, ["nombre", "telefono", "ciudad"]);
});

test("soloConfirmado es lo unico que se despacha", () => {
  const f = campos.fichaVacia();
  f.nombre = campos.confirmar(campos.proponer(f.nombre, "Ana Perez", campos.ORIGENES.CLIENTE), (v) => ({ ok: true, valor: v }));
  f.ciudad = campos.proponer(f.ciudad, "por aqui cerca", campos.ORIGENES.IA); // candidato sin confirmar
  const plano = campos.soloConfirmado(f);
  assert.equal(plano.nombre, "Ana Perez");
  assert.equal(plano.ciudad, undefined, "un candidato se colo en los datos de despacho");
});

// --------------------------------------------------------------------------
// Destino: una frase no es una ciudad
// --------------------------------------------------------------------------

test("las frases semanticas NO son una ciudad", () => {
  for (const frase of ["mi casa", "aqui cerca", "por aqui cerca", "donde siempre", "el mismo", "si", "contraentrega", "123"]) {
    const r = destino.resolverCiudad(frase);
    assert.equal(r.ok, false, `"${frase}" se acepto como ciudad`);
  }
});

test("una ciudad conocida resuelve con su departamento", () => {
  const r = destino.resolverCiudad("medellin");
  assert.equal(r.ok, true);
  assert.equal(r.ciudad, "Medellin");
  assert.equal(r.departamento, "Antioquia");
  assert.equal(r.revisar, false);
});

test("una ciudad homonima NO se adivina", () => {
  // Hay varias Santa Rosa en Colombia. Elegir una es despachar a otro
  // departamento.
  const r = destino.resolverCiudad("santa rosa");
  assert.equal(r.ok, false);
  assert.equal(r.ambigua, true);
  assert.ok(r.opciones.length > 1);
});

test("una ciudad homonima con departamento SI resuelve", () => {
  const r = destino.resolverCiudad("santa rosa", "Cauca");
  assert.equal(r.ok, true);
  assert.equal(r.departamento, "Cauca");
});

test("una ciudad que no esta en el listado se acepta MARCADA, no se rechaza", () => {
  // El listado esta incompleto por definicion. Rechazar aqui seria perder
  // una venta real por un municipio que falta, que es el peor resultado.
  const r = destino.resolverCiudad("Pueblo Nuevo de Abajo");
  assert.equal(r.ok, true);
  assert.equal(r.revisar, true);
  assert.match(r.motivo, /revisar antes de despachar/);
});

test("las frases semanticas NO son una direccion", () => {
  for (const frase of ["mi casa", "la misma", "aqui", "el mismo", "contraentrega", "ok"]) {
    assert.equal(destino.validarDireccion(frase).ok, false, `"${frase}" se acepto como direccion`);
  }
});

test("una zona CON punto de referencia se acepta, aunque no traiga ningun numero", () => {
  // ⚠️ ESTA PRUEBA DECIA LO CONTRARIO, y el ejemplo que usaba la delataba:
  //    "barrio la esperanza cerca del parque" es una direccion a la que un
  //    mensajero SI puede llegar. Rechazarla es la venta perdida del 08-oct
  //    en San Andres de Sotavento, otra vez.
  //
  // Lo que importa no es el numero: es que haya algo mas que el nombre del
  // barrio. Se acepta marcada, porque una persona confirma el destino antes
  // de la guia.
  const r = destino.validarDireccion("barrio la esperanza cerca del parque");
  assert.equal(r.ok, true);
  assert.equal(r.revisar, true);
});

test("pero SOLO el barrio no se puede despachar: Marco lo pidio el 09-oct", () => {
  // Su regla: «hay una regla basica para despachar un pedido y es que nos den
  // direccion... sin eso no podemos dejar que el Bot lo tome como pedido
  // porque si no no se va a generar [la guia]».
  //
  // Nace de un caso real: el bot acepto "barrio centenario" como direccion
  // final de un pedido de Ipiales, lo cerro, y Marco tuvo que LLAMAR al
  // celular para conseguir la direccion de verdad.
  //
  // Se acepta -no se le repite la pregunta al cliente, que es lo que costo la
  // otra venta- pero queda MARCADA, y marcada significa que no se despacha.
  for (const sola of ["barrio centenario", "Barrio buenos aires", "barrio centro", "vereda alta"]) {
    const r = destino.validarDireccion(sola);
    assert.equal(r.revisar, true, `"${sola}" no quedó marcada: se despacharía sin poder entregarse`);
    assert.equal(r.faltaReferencia, true, `"${sola}" no pide el punto de referencia`);
  }
});

test("la oficina de la transportadora ES una direccion valida y completa", () => {
  // Autorizado por Marco el 09-oct: «nosotros tambien podemos llevar a la
  // oficina inter rapidisimo o a la oficina de coordinadora». Antes se
  // rechazaba por no traer numero, que es justo el caso donde no hace falta.
  for (const o of ["oficina de interrapidisimo", "en la oficina de coordinadora", "la recojo en interrapidisimo"]) {
    const r = destino.validarDireccion(o);
    assert.equal(r.ok, true, `rechazó un envío a oficina: "${o}"`);
    assert.equal(r.revisar, false, `marcó para revisión un envío a oficina: "${o}"`);
    assert.equal(r.aOficina, true);
  }
  // Y se normaliza, porque esto acaba impreso en una guía.
  assert.equal(destino.oficinaEn("la recojo en inter rapidisimo"), "Oficina Interrapidísimo");
  assert.equal(destino.oficinaEn("en la oficina de coordinadora"), "Oficina Coordinadora");
  // "mi oficina" es el trabajo del cliente, no una transportadora.
  assert.equal(destino.oficinaEn("mi oficina"), null);
});

test("una direccion con via y numero se acepta limpia", () => {
  const r = destino.validarDireccion("Calle 45 # 23-10 apto 302, barrio Laureles");
  assert.equal(r.ok, true);
  assert.equal(r.revisar, false);
});

test("una direccion rural con numeros pero sin via se acepta MARCADA", () => {
  const r = destino.validarDireccion("finca los naranjos lote 14 sector 3");
  assert.equal(r.ok, true);
  assert.equal(r.revisar, true);
});

test("el telefono es un candado duro, no una marca", () => {
  // La transportadora lo exige: sin telefono valido no hay despacho posible.
  assert.equal(destino.validarTelefono("3001234567").ok, true);
  assert.equal(destino.validarTelefono("573001234567").valor, "3001234567");
  assert.equal(destino.validarTelefono("300 123 4567").ok, true);
  assert.equal(destino.validarTelefono("12345").ok, false);
  assert.equal(destino.validarTelefono("6012345678").ok, false, "un fijo no sirve para WhatsApp/despacho movil");
  assert.equal(destino.validarTelefono("3333333333").ok, false, "todos los digitos iguales no es un numero real");
  assert.equal(destino.validarTelefono("").ok, false);
});

test("un nombre no lleva numeros ni es una cortesia", () => {
  assert.equal(destino.validarNombre("Ana María Pérez").ok, true);
  assert.equal(destino.validarNombre("Ana 123").ok, false);
  assert.equal(destino.validarNombre("gracias").ok, false);
  assert.equal(destino.validarNombre("si").ok, false);
});

test("un nombre de pila BASTA: no se marca por no traer apellido", () => {
  // ⚠️ ESTA PRUEBA EXIGIA `revisar: true`, Y MARCO LO CAMBIO EL 09-oct:
  //    «al igual que el nombre, no es necesario el nombre completo, pero sí
  //    un nombre por lo menos».
  //
  // Marcar era caro: `revisar` pone el pedido EN_REVISION y eso IMPIDE
  // despachar. "Duber" —el nombre real del cliente de Ipiales— bloqueaba su
  // propia guía por no traer apellido, y había que entrar al panel a
  // desbloquearlo a mano.
  for (const pila of ["Ana", "Duber", "Marcela"]) {
    const r = destino.validarNombre(pila);
    assert.equal(r.ok, true, `rechazó un nombre de pila: "${pila}"`);
    assert.equal(r.revisar, false, `marcó "${pila}" y eso bloquea el despacho`);
  }
  // Lo que sigue rechazándose es lo que NO es un nombre.
  for (const falso of ["Sii", "ok", "listo"]) {
    assert.equal(destino.validarNombre(falso).ok, false, `aceptó "${falso}" como nombre`);
  }
});

// --------------------------------------------------------------------------
// Texto y cantidades
// --------------------------------------------------------------------------

test("aplanar quita tildes y signos pero conserva los digitos", () => {
  assert.equal(texto.aplanar("¿Cuánto vale el cinturón térmico?"), "cuanto vale el cinturon termico");
  assert.equal(texto.aplanar("quiero 2!!"), "quiero 2");
});

test("vistas conserva la informacion de la tilde afirmativa", () => {
  assert.equal(texto.vistas("sí").tieneTildeAfirmativa, true);
  assert.equal(texto.vistas("si").tieneTildeAfirmativa, false);
});

test("cantidadesEn devuelve TODAS las señales, en orden", () => {
  // "queria dos, mejor uno" tiene dos señales en conflicto. Devolver una
  // sola obligaria a este modulo a decidir, y decidir aqui es cobrar mal.
  const c = texto.cantidadesEn("queria dos, mejor uno");
  assert.equal(c.length, 2);
  assert.equal(c[0].valor, 2);
  assert.equal(c[1].valor, 1);
});

test("cantidadesEn entiende digitos y palabras", () => {
  assert.equal(texto.cantidadesEn("quiero 3")[0].valor, 3);
  assert.equal(texto.cantidadesEn("mandame un par")[0].valor, 2);
  assert.equal(texto.cantidadesEn("una docena")[0].valor, 12);
});

test("sin numeros no se asume cantidad", () => {
  assert.deepEqual(texto.cantidadesEn("lo quiero"), []);
});
