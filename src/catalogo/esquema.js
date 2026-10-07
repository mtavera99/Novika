"use strict";

// ==========================================================================
// ESQUEMA DE PRODUCTO
//
// NOVIKA vende hogar, tecnologia, bienestar, herramientas, accesorios y lo
// que venga. Por eso el producto es DATO, no codigo: un archivo JSON por
// producto en /catalogo/productos. Añadir un producto no es desplegar.
//
// En BIKERPRO los productos viven en un objeto literal dentro de un .js de
// 875 lineas, y encima hay un segundo catalogo (el CSV del feed de Meta) que
// puede divergir del motor de precios: su propio README admite que un
// producto esta en el feed pero su precio no esta automatizado. Un catalogo
// que puede contradecirse a si mismo es una fuente de cobros incorrectos.
// Aqui la fuente de verdad es una sola, y el feed de Meta se GENERARA desde
// ella cuando haga falta.
//
// La regla que mas importa de todo este archivo:
//
//   UN PRODUCTO NO PUEDE ESTAR ACTIVO SI LE FALTA UN DATO CRITICO.
//
// Un producto con `activo: true` y `precios` vacio no es un borrador
// incompleto: es un cobro incorrecto esperando a pasar. Por eso la
// validacion es asimetrica: borrador -> permisivo; activo -> estricto.
// ==========================================================================

/** Los unicos motores de precio que el sistema sabe aplicar. */
const MOTORES_DE_PRECIO = ["tabla", "producto_mas_envio"];

/** Politicas de envio reconocidas por el cotizador. */
const POLITICAS_ENVIO = ["incluido", "fijo", "por_destino"];

// --------------------------------------------------------------------------
// METODOS DE COBRO
//
// Estos son los metodos que el SISTEMA sabe representar, no los que NOVIKA
// ofrece. Cada producto declara el suyo en `pago.metodo`, y de ahi sale lo
// que se le dice al cliente y lo que queda estampado en el pedido.
//
// Por que es un campo del catalogo y no una frase del prompt: en
// contraentrega el dinero se recauda en la puerta. Si el pedido no dice que
// hay que cobrar al entregar, el paquete se entrega sin cobrar y la venta se
// convierte en un regalo con flete pagado. El metodo de cobro es un dato
// operativo del despacho, no un adorno del mensaje.
//
// Va DENTRO de la cotizacion, y por tanto dentro de la firma de condiciones:
// pasar de contraentrega a pago anticipado cambia lo que el cliente acepto,
// asi que tiene que caducar las ofertas vivas igual que lo hace un cambio de
// precio.
// --------------------------------------------------------------------------
const METODOS_DE_PAGO = ["contraentrega", "anticipado"];

/** Niveles de confianza de una señal (alias) de producto. */
const CONFIANZAS = ["alta", "media", "baja"];

// --------------------------------------------------------------------------
// IMAGENES
//
// Los limites NO son de NOVIKA, son de Meta, y por eso estan aqui como
// datos y no repartidos por el codigo. De su documentacion de la Cloud API:
//
//   - solo image/jpeg y image/png;
//   - 8 bits, RGB o RGBA;
//   - maximo 5 MB por imagen.
//
// Una imagen que incumpla cualquiera de los tres se rechaza en el envio con
// un error 131053 ("Media upload error"), y eso ocurre DESPUES de que el
// cliente haya preguntado por el producto. Validarlo al cargar el catalogo
// convierte un fallo en la conversacion de una venta en un fallo al
// arrancar, que es ruidoso y barato.
//
// El formato real se comprueba por los BYTES del archivo, no por la
// extension: un .jpg que en realidad es un HEIC renombrado pasaria
// cualquier comprobacion de nombre y fallaria en Meta.
// --------------------------------------------------------------------------
const FORMATOS_DE_IMAGEN = {
  jpeg: { mime: "image/jpeg", firma: [0xff, 0xd8, 0xff] },
  png: { mime: "image/png", firma: [0x89, 0x50, 0x4e, 0x47] },
};
const MAX_BYTES_IMAGEN = 5 * 1024 * 1024;
/** Carpeta raiz de las imagenes, relativa a la raiz del repositorio. */
const RAIZ_IMAGENES = "catalogo/imagenes";

/**
 * Formato real de un archivo, leyendo sus primeros bytes.
 *
 * @returns {{formato: string, mime: string}|null}
 */
function formatoReal(ruta) {
  const fs = require("node:fs");
  let cabeza;
  try {
    const fd = fs.openSync(ruta, "r");
    cabeza = Buffer.alloc(8);
    fs.readSync(fd, cabeza, 0, 8, 0);
    fs.closeSync(fd);
  } catch {
    return null;
  }
  for (const [formato, { mime, firma }] of Object.entries(FORMATOS_DE_IMAGEN)) {
    if (firma.every((b, i) => cabeza[i] === b)) return { formato, mime };
  }
  return null;
}

/** Campos del cliente que un producto puede exigir ademas de los de siempre. */
const DATOS_EXIGIBLES = [
  "nombre",
  "telefono",
  "documento",
  "ciudad",
  "departamento",
  "direccion",
  "referencia",
  "variante",
  "cantidad",
];

/**
 * Forma de un producto. Esto es documentacion ejecutable: la validacion de
 * abajo la hace cumplir.
 *
 *  id                        string   obligatorio, unico, minusculas-con-guiones
 *  nombre                    string   obligatorio
 *  nombreCorto               string   como lo nombra el bot en una frase
 *  categoria                 string   obligatorio: hogar | tecnologia | bienestar | herramientas | accesorios | ...
 *  activo                    boolean  obligatorio. true = el bot puede venderlo HOY
 *
 *  aliases                   array    [{ patron, confianza, senal }]
 *                                     `patron` es una expresion regular en texto.
 *                                     Un alias ambiguo entre dos productos NO es alias.
 *
 *  descripcionAutorizada     string   lo que el bot puede decir del producto
 *  caracteristicasAutorizadas array   frases afirmables, una por elemento
 *  datosConfirmados          objeto   { clave: { preguntas: [...], respuesta: "..." } }
 *                                     respuesta literal y aprobada
 *  sinDatoConfirmado         array    terminos que obligan a "te lo confirmo",
 *                                     aunque la frase toque tambien un dato confirmado
 *
 *  motorDePrecio             string   uno de MOTORES_DE_PRECIO
 *  precios                   objeto   { "1": 00000, "2": 00000 }  cantidad -> precio total
 *  ofertaPrincipal           string   como se presenta la oferta
 *  promociones               array    [{ id, descripcion, desde, hasta, condiciones }]
 *
 *  variantes                 array    [{ clave, etiqueta, obligatoria, opciones: [] }]
 *                                     generico a proposito: talla, color, voltaje, sabor...
 *
 *  logistica                 objeto   { pesoGr, dimensionesCm: {largo,ancho,alto},
 *                                       politicaEnvio: { tipo, hastaUnidades,
 *                                                        provisional, porQue,
 *                                                        noHeredar: [], revisarCuando } }
 *
 *  faq                       array    [{ pregunta, respuesta }]
 *  garantia                  string
 *  restricciones             array    donde no se vende, que no se promete
 *  pendientes                array    TODOs explicitos. Si tiene alguno, no puede estar activo.
 */

function esTexto(v) {
  return typeof v === "string" && v.trim() !== "";
}

function esListaDeTexto(v) {
  return Array.isArray(v) && v.every(esTexto);
}

/**
 * Valida un producto.
 * @returns {{errores: string[], avisos: string[]}}
 */
function validarProducto(p, origen = "(sin origen)") {
  const errores = [];
  const avisos = [];
  const donde = (campo) => `${origen} -> ${campo}`;

  // ---- Siempre obligatorio, borrador incluido ----
  if (!esTexto(p && p.id)) {
    errores.push(`${donde("id")}: falta. Sin id no se puede estampar el producto en un pedido.`);
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.id)) {
    errores.push(`${donde("id")}: "${p.id}" debe ser minusculas-con-guiones, sin espacios ni acentos.`);
  }
  if (!esTexto(p && p.categoria)) errores.push(`${donde("categoria")}: falta.`);
  // El nombre comercial se exige solo al activar. Un borrador es un hueco
  // reservado en el catalogo: puede existir con el id puesto y el nombre
  // pendiente, que es justo el estado de un producto cuya ficha todavia no
  // llego. Exigirlo antes obligaria a inventar un nombre provisional, y un
  // nombre provisional es un dato comercial inventado.
  if (p && p.activo !== true && !esTexto(p.nombre)) {
    avisos.push(`${donde("nombre")}: borrador sin nombre comercial todavia.`);
  }
  if (typeof (p && p.activo) !== "boolean") {
    errores.push(`${donde("activo")}: debe ser true o false, explicito. No se asume.`);
  }

  // ---- Imagenes ----
  //
  // Opcionales: un borrador sin fotos es legitimo. Pero si estan, se
  // comprueban de verdad -que el archivo exista, que sea jpeg o png por sus
  // bytes y que no pase de 5 MB-, porque una ruta que no existe es un
  // mensaje que el cliente nunca recibe.
  if (p && p.imagenes !== undefined) {
    if (!Array.isArray(p.imagenes)) {
      errores.push(`${donde("imagenes")}: debe ser una lista.`);
    } else {
      const fs = require("node:fs");
      const path = require("node:path");
      const raiz = path.join(__dirname, "..", "..");
      const vistas = new Set();

      p.imagenes.forEach((img, i) => {
        const campo = `imagenes[${i}]`;
        if (!img || typeof img !== "object") {
          errores.push(`${donde(campo)}: cada imagen es un objeto { archivo, alt }.`);
          return;
        }
        if (!esTexto(img.archivo)) {
          errores.push(`${donde(campo + ".archivo")}: falta la ruta.`);
          return;
        }
        // La ruta se exige RELATIVA y dentro de catalogo/imagenes. Una ruta
        // absoluta o con ".." permitiria servir cualquier archivo del disco
        // cuando se publiquen por HTTP.
        if (path.isAbsolute(img.archivo) || img.archivo.split("/").includes("..")) {
          errores.push(`${donde(campo + ".archivo")}: tiene que ser relativa y sin "..".`);
          return;
        }
        if (!img.archivo.startsWith(RAIZ_IMAGENES + "/")) {
          errores.push(`${donde(campo + ".archivo")}: tiene que estar dentro de ${RAIZ_IMAGENES}/.`);
          return;
        }
        if (vistas.has(img.archivo)) {
          avisos.push(`${donde(campo + ".archivo")}: repetida (${img.archivo}).`);
        }
        vistas.add(img.archivo);

        const absoluta = path.join(raiz, img.archivo);
        let st;
        try {
          st = fs.statSync(absoluta);
        } catch {
          errores.push(`${donde(campo + ".archivo")}: no existe (${img.archivo}).`);
          return;
        }
        if (st.size > MAX_BYTES_IMAGEN) {
          errores.push(
            `${donde(campo)}: pesa ${Math.round(st.size / 1024)} KB y Meta no acepta mas de 5 MB (${img.archivo}).`
          );
        }
        const real = formatoReal(absoluta);
        if (!real) {
          errores.push(
            `${donde(campo)}: no es jpeg ni png por sus bytes; Meta solo acepta esos dos (${img.archivo}).`
          );
        }
        // El alt no es decorativo: es lo que se manda como caption cuando no
        // hay texto, y lo que lee una persona en el panel.
        if (!esTexto(img.alt)) {
          avisos.push(`${donde(campo + ".alt")}: sin descripcion.`);
        }
      });
    }
  }

  // ---- Coherencia de los campos que esten presentes ----
  for (const alias of Array.isArray(p && p.aliases) ? p.aliases : []) {
    if (!esTexto(alias && alias.patron)) {
      errores.push(`${donde("aliases")}: hay un alias sin "patron".`);
      continue;
    }
    try {
      new RegExp(alias.patron, "i");
    } catch (e) {
      errores.push(`${donde("aliases")}: el patron ${JSON.stringify(alias.patron)} no es una expresion regular valida (${e.message}).`);
    }
    if (alias.confianza && !CONFIANZAS.includes(alias.confianza)) {
      errores.push(`${donde("aliases")}: confianza "${alias.confianza}" no valida. Usa: ${CONFIANZAS.join(", ")}.`);
    }
  }

  if (p && p.motorDePrecio !== undefined && !MOTORES_DE_PRECIO.includes(p.motorDePrecio)) {
    errores.push(`${donde("motorDePrecio")}: "${p.motorDePrecio}" no existe. Usa: ${MOTORES_DE_PRECIO.join(", ")}.`);
  }

  if (p && p.precios !== undefined) {
    if (typeof p.precios !== "object" || p.precios === null || Array.isArray(p.precios)) {
      errores.push(`${donde("precios")}: debe ser un objeto { "1": precio, "2": precio }.`);
    } else {
      for (const [cantidad, precio] of Object.entries(p.precios)) {
        if (!/^\d+$/.test(cantidad) || Number(cantidad) < 1) {
          errores.push(`${donde("precios")}: la clave "${cantidad}" debe ser una cantidad entera positiva.`);
        }
        if (!Number.isInteger(precio) || precio <= 0) {
          errores.push(
            `${donde("precios")}: el precio de "${cantidad}" debe ser un entero positivo en pesos, sin decimales ni separadores.`
          );
        }
      }
    }
  }

  for (const v of Array.isArray(p && p.variantes) ? p.variantes : []) {
    if (!esTexto(v && v.clave)) errores.push(`${donde("variantes")}: hay una variante sin "clave".`);
    if (!Array.isArray(v && v.opciones) || !v.opciones.length) {
      errores.push(`${donde("variantes")}: la variante "${(v && v.clave) || "?"}" no tiene opciones.`);
    }
    if (typeof (v && v.obligatoria) !== "boolean") {
      avisos.push(`${donde("variantes")}: "${(v && v.clave) || "?"}" no dice si es obligatoria; se asumira que no.`);
    }
  }

  if (p && p.sinDatoConfirmado !== undefined && !esListaDeTexto(p.sinDatoConfirmado)) {
    errores.push(`${donde("sinDatoConfirmado")}: debe ser una lista de textos.`);
  }
  if (p && p.caracteristicasAutorizadas !== undefined && !esListaDeTexto(p.caracteristicasAutorizadas)) {
    errores.push(`${donde("caracteristicasAutorizadas")}: debe ser una lista de textos.`);
  }
  if (p && p.pendientes !== undefined && !esListaDeTexto(p.pendientes)) {
    errores.push(`${donde("pendientes")}: debe ser una lista de textos.`);
  }

  // ---- Campos añadidos en Fase 2 ----

  if (p && p.slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(p.slug))) {
    errores.push(`${donde("slug")}: "${p.slug}" debe ser minusculas-con-guiones.`);
  }

  for (const lista of ["claimsPermitidos", "claimsProhibidos", "contenidoDelPaquete", "presentaciones", "anuncios"]) {
    if (p && p[lista] !== undefined && !esListaDeTexto(p[lista])) {
      errores.push(`${donde(lista)}: debe ser una lista de textos.`);
    }
  }

  // Un claim que esta permitido Y prohibido a la vez no es un descuido de
  // redaccion: es una contradiccion que acaba en informacion inventada,
  // porque el resultado depende de cual de las dos listas se consulte antes.
  if (Array.isArray(p && p.claimsPermitidos) && Array.isArray(p.claimsProhibidos)) {
    const prohibidos = new Set(p.claimsProhibidos.map((c) => String(c).toLowerCase().trim()));
    const choque = p.claimsPermitidos.filter((c) => prohibidos.has(String(c).toLowerCase().trim()));
    if (choque.length) {
      errores.push(
        `${donde("claims")}: ${choque.length} claim(s) estan a la vez permitidos y prohibidos (${choque.join("; ")}). Decide uno.`
      );
    }
  }

  if (p && p.datosRequeridos !== undefined) {
    if (!esListaDeTexto(p.datosRequeridos)) {
      errores.push(`${donde("datosRequeridos")}: debe ser una lista de textos.`);
    } else {
      const desconocidos = p.datosRequeridos.filter((d) => !DATOS_EXIGIBLES.includes(d));
      if (desconocidos.length) {
        errores.push(
          `${donde("datosRequeridos")}: el sistema no sabe capturar ${desconocidos.join(", ")}. Validos: ${DATOS_EXIGIBLES.join(", ")}.`
        );
      }
    }
  }

  if (p && p.precioUnitario !== undefined && (!Number.isInteger(p.precioUnitario) || p.precioUnitario <= 0)) {
    errores.push(`${donde("precioUnitario")}: debe ser un entero positivo en pesos, sin decimales ni separadores.`);
  }

  if (p && p.pago !== undefined && p.pago !== null) {
    if (typeof p.pago !== "object") {
      errores.push(`${donde("pago")}: debe ser un objeto { metodo, etiquetaCliente }.`);
    } else {
      if (!METODOS_DE_PAGO.includes(p.pago.metodo)) {
        errores.push(
          `${donde("pago.metodo")}: "${p.pago.metodo}" no existe. Validos: ${METODOS_DE_PAGO.join(", ")}.`
        );
      }
      // La etiqueta es lo que LEE el cliente. Si falta, el bot tendria que
      // redactarla, y redactar como se cobra es justo lo que no puede hacer
      // el modelo.
      if (p.pago.etiquetaCliente !== undefined && !esTexto(p.pago.etiquetaCliente)) {
        errores.push(`${donde("pago.etiquetaCliente")}: si esta, debe ser un texto no vacio.`);
      }
      // Una etiqueta no puede contener cifras: el filtro de importes las
      // leeria como un cobro no autorizado y bloquearia el mensaje entero.
      if (esTexto(p.pago.etiquetaCliente) && /\d/.test(p.pago.etiquetaCliente)) {
        errores.push(
          `${donde("pago.etiquetaCliente")}: no puede llevar cifras ("${p.pago.etiquetaCliente}"). Los importes los pone el cotizador.`
        );
      }
    }
  }

  for (const promo of Array.isArray(p && p.promociones) ? p.promociones : []) {
    if (!esTexto(promo && promo.id)) {
      errores.push(`${donde("promociones")}: hay una promocion sin "id"; sin id no se puede auditar que se aplico.`);
    }
    if (!Number.isInteger(promo && promo.descuento) || promo.descuento <= 0) {
      errores.push(`${donde("promociones")}: la promocion "${(promo && promo.id) || "?"}" necesita un descuento entero positivo.`);
    }
    if (promo && promo.desde && Number.isNaN(Date.parse(promo.desde))) {
      errores.push(`${donde("promociones")}: "desde" de "${promo.id}" no es una fecha valida.`);
    }
    if (promo && promo.hasta && Number.isNaN(Date.parse(promo.hasta))) {
      errores.push(`${donde("promociones")}: "hasta" de "${promo.id}" no es una fecha valida.`);
    }
  }

  const log = (p && p.logistica) || null;
  if (log) {
    if (log.pesoGr !== null && log.pesoGr !== undefined && (!Number.isFinite(log.pesoGr) || log.pesoGr <= 0)) {
      errores.push(`${donde("logistica.pesoGr")}: debe ser un numero positivo en gramos, o null si no se sabe.`);
    }
    const dim = log.dimensionesCm;
    if (dim && typeof dim === "object") {
      for (const lado of ["largo", "ancho", "alto"]) {
        const v = dim[lado];
        if (v !== null && v !== undefined && (!Number.isFinite(v) || v <= 0)) {
          errores.push(`${donde(`logistica.dimensionesCm.${lado}`)}: debe ser un numero positivo, o null.`);
        }
      }
    }
    const pol = log.politicaEnvio;
    if (pol && esTexto(pol.tipo) && !POLITICAS_ENVIO.includes(pol.tipo)) {
      errores.push(
        `${donde("logistica.politicaEnvio.tipo")}: "${pol.tipo}" no existe. Validos: ${POLITICAS_ENVIO.join(", ")}.`
      );
    }
    if (pol && pol.tipo === "fijo" && pol.valorFijo !== undefined && (!Number.isInteger(pol.valorFijo) || pol.valorFijo < 0)) {
      errores.push(`${donde("logistica.politicaEnvio.valorFijo")}: debe ser un entero en pesos >= 0.`);
    }
    if (pol && pol.tipo === "por_destino" && pol.tablaPorDepartamento !== undefined) {
      const tabla = pol.tablaPorDepartamento;
      if (typeof tabla !== "object" || tabla === null || Array.isArray(tabla)) {
        errores.push(`${donde("logistica.politicaEnvio.tablaPorDepartamento")}: debe ser un objeto departamento -> importe.`);
      } else {
        for (const [dep, valor] of Object.entries(tabla)) {
          if (!Number.isInteger(valor) || valor < 0) {
            errores.push(`${donde("logistica.politicaEnvio.tablaPorDepartamento")}: el importe de "${dep}" debe ser un entero >= 0.`);
          }
        }
      }
    }
  }

  // ---- Exigencias SOLO para productos activos ----
  if (p && p.activo === true) {
    const pendientes = Array.isArray(p.pendientes) ? p.pendientes : [];
    if (pendientes.length) {
      errores.push(
        `${donde("activo")}: no puede estar activo con ${pendientes.length} pendiente(s) sin resolver: ${pendientes.join("; ")}`
      );
    }
    if (!esTexto(p.descripcionAutorizada)) {
      errores.push(`${donde("descripcionAutorizada")}: obligatoria para un producto activo. Sin ella el bot improvisa.`);
    }
    if (!esTexto(p.motorDePrecio)) {
      errores.push(`${donde("motorDePrecio")}: obligatorio para un producto activo.`);
    }
    // Cada motor de precio exige lo suyo. Un producto activo con el motor
    // equivocado para sus datos no falla al cotizar: cotiza mal.
    if (p.motorDePrecio === "producto_mas_envio") {
      if (!Number.isInteger(p.precioUnitario) || p.precioUnitario <= 0) {
        errores.push(`${donde("precioUnitario")}: el motor "producto_mas_envio" lo necesita y falta.`);
      }
    } else if (!p.precios || !Object.keys(p.precios).length) {
      errores.push(`${donde("precios")}: un producto activo sin precios acabaria cotizandose mal.`);
    } else if (p.precios["1"] === undefined) {
      errores.push(`${donde("precios")}: falta el precio de 1 unidad, que es el caso mas comun.`);
    }

    // Como se cobra es un dato del despacho, no del mensaje. Un producto
    // activo sin metodo declarado se vende, se despacha, y nadie sabe si
    // habia que recaudar en la puerta.
    if (!p.pago || !METODOS_DE_PAGO.includes(p.pago.metodo)) {
      errores.push(
        `${donde("pago.metodo")}: obligatorio para un producto activo. Validos: ${METODOS_DE_PAGO.join(", ")}.`
      );
    }

    // Una politica de envio que necesita un importe y no lo tiene haria que
    // el cotizador se negara a cotizar en produccion. Mejor saberlo ahora.
    const pol = (p.logistica && p.logistica.politicaEnvio) || {};
    if (pol.tipo === "fijo" && !Number.isInteger(pol.valorFijo)) {
      errores.push(`${donde("logistica.politicaEnvio.valorFijo")}: la politica "fijo" necesita un importe y no lo tiene.`);
    }
    if (pol.tipo === "por_destino" && (!pol.tablaPorDepartamento || !Object.keys(pol.tablaPorDepartamento).length)) {
      errores.push(
        `${donde("logistica.politicaEnvio.tablaPorDepartamento")}: la politica "por_destino" necesita la tabla y esta vacia.`
      );
    }

    // Un producto activo tiene que declarar que NO puede afirmar el bot. Una
    // lista vacia es una decision explicita; que falte el campo significa
    // que nadie penso en los limites, y entonces el modelo los inventa.
    if (p.claimsProhibidos === undefined && p.sinDatoConfirmado === undefined) {
      avisos.push(
        `${donde("claimsProhibidos")}: un producto activo deberia declarar que NO se puede afirmar. Sin limites escritos, el modelo improvisa.`
      );
    }
    const politica = p.logistica && p.logistica.politicaEnvio;
    if (!politica || !esTexto(politica.tipo)) {
      errores.push(`${donde("logistica.politicaEnvio.tipo")}: obligatorio para un producto activo.`);
    } else if (politica.provisional === true && !esTexto(politica.revisarCuando)) {
      avisos.push(
        `${donde("logistica.politicaEnvio")}: marcada como provisional sin "revisarCuando". Una decision provisional sin fecha de revision se vuelve permanente.`
      );
    }
    if (!Array.isArray(p.aliases) || !p.aliases.length) {
      avisos.push(
        `${donde("aliases")}: sin alias, el producto solo se identificara por el anuncio de origen. Añade al menos uno.`
      );
    }
  }

  return { errores, avisos };
}

/** Valida el catalogo completo: lo de cada producto mas lo que es global. */
function validarCatalogo(productos) {
  const errores = [];
  const avisos = [];
  const vistos = new Map();

  for (const { producto, origen } of productos) {
    const r = validarProducto(producto, origen);
    errores.push(...r.errores);
    avisos.push(...r.avisos);

    const id = producto && producto.id;
    if (id) {
      if (vistos.has(id)) {
        errores.push(`id duplicado "${id}": esta en ${vistos.get(id)} y en ${origen}. Un id apunta a un producto y solo uno.`);
      } else {
        vistos.set(id, origen);
      }
    }
  }

  // Candado anti-contaminacion: ninguna constante logistica declarada como
  // "no heredable" por un producto puede aparecer en otro. En un catalogo
  // multicategoria, un articulo de hogar voluminoso y un accesorio pequeño
  // no comparten tarifa, y heredarla en silencio es un cobro incorrecto.
  for (const { producto, origen } of productos) {
    const noHeredar =
      (producto && producto.logistica && producto.logistica.politicaEnvio && producto.logistica.politicaEnvio.noHeredar) || [];
    for (const constante of noHeredar) {
      for (const otro of productos) {
        if (otro.producto === producto) continue;
        const politicaAjena = (otro.producto && otro.producto.logistica && otro.producto.logistica.politicaEnvio) || {};
        if (politicaAjena.tipo === constante) {
          errores.push(
            `${origen} declara que "${constante}" no se hereda, pero ${otro.origen} lo usa como politica de envio. Uno de los dos esta mal.`
          );
        }
      }
    }
  }

  return { errores, avisos };
}

module.exports = {
  FORMATOS_DE_IMAGEN,
  MAX_BYTES_IMAGEN,
  RAIZ_IMAGENES,
  formatoReal,
  validarProducto,
  validarCatalogo,
  MOTORES_DE_PRECIO,
  POLITICAS_ENVIO,
  METODOS_DE_PAGO,
  CONFIANZAS,
  DATOS_EXIGIBLES,
};
