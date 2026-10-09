"use strict";

// ==========================================================================
// QUE ESTA PREGUNTANDO EL CLIENTE
//
// Modulo puro. Sin I/O, sin IA, sin catalogo.
//
// POR QUE EXISTE
//
// Antes el cerebro sabia en que PASO DE LA VENTA estaba -faltan datos, hay
// resumen, esta confirmado- y contestaba segun el paso. Eso produce
// conversaciones como esta, que es real y salio de probar la activacion:
//
//   clienta: "Quiero un cinturón. ¿Cuánto vale con envío?"
//   bot:     "Para continuar me falta la ciudad, la dirección de entrega."
//
// El paso de la venta era correcto -faltaban datos- y la respuesta era
// inservible: le pide los datos a alguien que acaba de preguntar el precio.
//
// Para contestar primero lo que preguntan hay que SABER que preguntaron. Eso
// es lo que hace este modulo: clasifica el mensaje en temas, sin decidir que
// se responde. Quien responde es el cerebro, con datos del catalogo.
//
// DOS REGLAS DE DISEÑO
//
// 1. UN TEMA NO RECONOCIDO NO ES UN ERROR. Si no se reconoce nada, el cerebro
//    sigue su camino normal. Este modulo solo puede MEJORAR una respuesta,
//    nunca bloquearla.
//
// 2. PREGUNTAR NO ES COMPRAR, Y ESA DISTINCION ES LO MAS VALIOSO DE AQUI.
//    Documentado en la referencia de BIKERPRO: el bot contestaba cada duda
//    informativa pidiendo ademas nombre, celular y direccion, y el cliente
//    que estaba averiguando se sentia perseguido y se iba. La diferencia
//    entre "¿tiene garantia?" y "lo quiero" tiene que estar en codigo, no en
//    una instruccion al modelo.
// ==========================================================================

const { aplanar, cantidadesEn, PREGUNTA_PRECIO } = require("./texto");

/**
 * Temas que el cliente puede preguntar.
 *
 * Cada tema se responde desde el catalogo o desde el cotizador. Si un tema no
 * tiene dato aprobado, el cerebro dice que lo confirma una persona: por eso
 * aqui no hay ninguna respuesta escrita, solo la clasificacion.
 */
const TEMAS = {
  PRECIO: "precio",
  ENVIO: "envio",
  PAGO: "pago",
  COLOR: "color",
  TALLA: "talla",
  MEDIDAS: "medidas",
  GARANTIA: "garantia",
  /** Como se hace efectiva / que cubre: el PLAZO esta confirmado, esto no. */
  GARANTIA_TRAMITE: "garantia_tramite",
  ENTREGA: "tiempo_de_entrega",
  MATERIAL: "material",
  USO: "uso",
  CONFIANZA: "confianza",
  FOTOS: "fotos",
  /**
   * "Esta muy caro", "hay descuento?", "me lo dejas mas barato".
   *
   * NO es una pregunta de precio: quien objeta YA sabe el precio. Es la
   * objecion que mas plata mueve y hasta ahora caia en el camino generico,
   * donde el bot contestaba "dime que necesitas" a quien estaba a un paso
   * de comprar.
   */
  OBJECION_PRECIO: "objecion_precio",
  /**
   * Como se alimenta: bateria, cargador, enchufe, cuanto dura.
   *
   * Aparte de USO porque la ficha lo declara NO CONFIRMADO. Dentro de USO,
   * preguntar por el cargador recibia la frase de "para que sirve" -el
   * calor alivia el colico-, que no contesta nada de lo que pregunto.
   */
  ENERGIA: "energia",

  // ======================================================================
  // LOS DIECISEIS TEMAS DE ABAJO SON DEL 2026-10-09, Y SALEN DE MEDIR.
  //
  // Se corrio la bateria de `herramientas/sondear.js` -65 preguntas, casi
  // todas copiadas literalmente del panel de produccion- y 22 de ellas
  // recibian la misma frase:
  //
  //   "Esa no te la quiero contestar a medias. La dejo anotada para el
  //    equipo: una persona la revisa y te responde por aquí."
  //
  // Esa frase es correcta cuando de verdad falta el dato. El problema era
  // otro: se disparaba por NO TENER TEMA, no por no tener dato. Preguntas
  // cuya respuesta estaba en la ficha -o que se contestan sin ningun dato
  // nuevo- acababan en un callejon porque el detector no las reconocia.
  //
  // Un tema nuevo NO inventa informacion: solo permite contestar con lo que
  // ya esta aprobado. Donde de verdad falta el dato, sigue saliendo la
  // frase honesta — pero sabiendo DE QUE se habla, que es lo que permite
  // seguir vendiendo en el mismo mensaje.
  // ======================================================================

  /** "¿se puede lavar?", "¿cómo lo limpio?". La ficha dice que mojarlo NO lo cubre la garantia. */
  CUIDADO: "cuidado",
  /** "¿me lo dejo puesto toda la noche?", "¿se puede quemar?". Seguridad de uso. */
  SEGURIDAD: "seguridad",
  /** Embarazo, DIU, lactancia, marcapasos. PROHIBIDO decir que si. */
  CONTRAINDICACION: "contraindicacion",
  /** "¿a cuántos grados llega?", "¿cuánto demora en calentar?" */
  TEMPERATURA: "temperatura",
  /** "¿es original?", "¿qué marca es?", "¿es chino?" */
  MARCA: "marca",
  /** "¿viene en caja?", "¿sirve para regalo?", "¿trae manual?" */
  EMPAQUE: "empaque",
  /** "¿dan factura?" */
  FACTURA: "factura",
  /** "¿venden al por mayor?", "soy revendedora". Es un lead grande. */
  MAYORISTA: "mayorista",
  /** "¿a qué hora atienden?", "¿trabajan domingos?" */
  HORARIO: "horario",
  /** "¿me pueden llamar?", "¿tienen página?", "¿Instagram?" */
  CANAL: "canal",
  /** "¿sirve para una niña de 13?", "¿es para hombre?" */
  DESTINATARIO: "destinatario",
  /** "¿qué diferencia tiene con una bolsa de agua caliente?" */
  COMPARATIVA: "comparativa",
  /** "¿llega a una vereda?", "¿tienen cobertura en todo el país?" */
  COBERTURA: "cobertura",
  /** "¿tienen otro modelo?", "¿qué más venden?" */
  OTRO_MODELO: "otro_modelo",
  /** "¿en qué ciudad están?", "¿dónde quedan?". Es confianza, pero con respuesta propia. */
  UBICACION: "ubicacion",
  /** "¿y si no me funciona?". No es garantia a secas: es miedo a perder la plata. */
  SI_NO_FUNCIONA: "si_no_funciona",
};

/**
 * Patrones por tema, sobre el texto APLANADO (minusculas, sin tildes).
 *
 * Se escriben sin tildes a proposito: el cliente escribe desde el movil y el
 * teclado las pone solas, asi que comparar contra el texto crudo haria que
 * "¿cuánto vale?" no coincidiera con `cuanto vale`. Ese error ya se cometio
 * una vez en los alias del catalogo.
 */
const PATRONES = [
  // ======================================================================
  // BLOQUE DEL 2026-10-09 — VA PRIMERO POR UN MOTIVO MECANICO
  //
  // El orden de esta tabla es el orden de `temas`, y de `temas[0]` sale la
  // apertura del mensaje. Estos patrones son MAS ESPECIFICOS que los
  // generales de abajo, asi que tienen que ganar: "¿cuánto demora en
  // calentar?" casa con `/\bdemora\w*/` de ENTREGA, y contestarle el plazo
  // de la transportadora a quien pregunta por el calor es no contestar.
  //
  // Todos son estrechos a proposito. Un patron ancho aqui le robaria el
  // tema a PRECIO, que es el que mas plata mueve.
  // ======================================================================

  // ---- Al por mayor: va ANTES de OBJECION_PRECIO ----
  //
  // "¿hay descuento por mayor?" casa con `/\b(descuento|rebaja)\b/`, asi
  // que caia en la objecion de precio y recibia la escalera de siempre. Y
  // es el lead mas grande que entra por aqui: quien revende compra todos
  // los meses. Tiene que ir a una persona, pero reconocido como lo que es.
  [TEMAS.MAYORISTA, /\b(al\s+)?por\s+mayor\b/],
  [TEMAS.MAYORISTA, /\bal\s+mayor\b/],
  [TEMAS.MAYORISTA, /\bmayorista/],
  [TEMAS.MAYORISTA, /\brevende(r|dora|dor|rlo)?\b/],
  [TEMAS.MAYORISTA, /\bdistribuidor/],
  [TEMAS.MAYORISTA, /\bpara\s+vender\b/],
  [TEMAS.MAYORISTA, /\bcantidad(es)?\s+grandes?\b/],

  // ---- Contraindicaciones: va ANTES de USO ----
  //
  // ⚠️ ESTE TEMA EXISTE PARA PODER DECIR QUE NO.
  //
  // "apto durante el embarazo", "sirve para la endometriosis" y "sirve para
  // quistes" estan en `claimsProhibidos` de la ficha, pero esa lista solo
  // revisa lo que REDACTA EL MODELO: no habia nada que enrutara la pregunta
  // a una respuesta honesta. Sin tema, caia en el camino generico.
  //
  // Es un producto que se compra por dolor. La respuesta correcta no es un
  // "lo confirmo con el equipo": es decir que eso lo decide su medico.
  [TEMAS.CONTRAINDICACION, /\bembaraz(o|ada|adas|ado)\b/],
  [TEMAS.CONTRAINDICACION, /\bgestante/],
  [TEMAS.CONTRAINDICACION, /\b(lactancia|amamant\w*)\b/],
  [TEMAS.CONTRAINDICACION, /\bdiu\b/],
  [TEMAS.CONTRAINDICACION, /\bmarcapaso/],
  [TEMAS.CONTRAINDICACION, /\b(endometriosis|quiste|quistes|mioma|miomas)\b/],
  [TEMAS.CONTRAINDICACION, /\b(cesarea|operada\s+(hace|de))\b/],

  // ---- Temperatura: va ANTES de ENTREGA (por "demora") y de ENERGIA ----
  [TEMAS.TEMPERATURA, /\bgrados\b/],
  [TEMAS.TEMPERATURA, /\btemperatura\b/],
  [TEMAS.TEMPERATURA, /\b(demora|tarda)\w*\s+(mucho\s+)?(en|para)\s+calentar\b/],
  [TEMAS.TEMPERATURA, /\bcuanto\s+(se\s+)?(demora|tarda)\w*\s+(en\s+)?calent/],
  [TEMAS.TEMPERATURA, /\bcalienta\s+(rapido|mucho|bien|harto)\b/],
  [TEMAS.TEMPERATURA, /\bque\s+(tan|tanto)\s+(caliente|calienta)\b/],
  [TEMAS.TEMPERATURA, /\bniveles?\s+de\s+(calor|temperatura)\b/],

  // ---- Seguridad de uso: va ANTES de USO ----
  //
  // El caso que estaba escrito como defecto conocido y sin arreglar:
  //   clienta · "oye y esto me lo puedo poner dormida toda la noche?"
  //   bot     · "Esa no te la quiero contestar a medias…"
  [TEMAS.SEGURIDAD, /\b(dormir|dormida|dormido|durmiendo|acostada)\b/],
  [TEMAS.SEGURIDAD, /\btoda\s+la\s+noche\b/],
  [TEMAS.SEGURIDAD, /\bhoras\s+seguidas\b/],
  [TEMAS.SEGURIDAD, /\bcuanto\s+tiempo\s+(lo|la)?\s*(puedo|se\s+puede)?\s*(usar|dejar|tener|poner|usarlo|usarla)\b/],
  [TEMAS.SEGURIDAD, /\bse\s+(puede\s+)?quem(a|ar|aria)\b/],
  [TEMAS.SEGURIDAD, /\bes\s+seguro\s+(usar|usarlo|usarla|poner|ponerlo|ponerla|dejar|dejarlo)/],
  [TEMAS.SEGURIDAD, /\bhace\s+da[nñ]o\b/],
  [TEMAS.SEGURIDAD, /\bpeligros[oa]\b/],

  // ---- Cuidado y lavado ----
  //
  // La ficha SI tiene la respuesta, y es un dato que conviene que la
  // clienta sepa ANTES de usarlo: `garantiaNoCubre` incluye "mojarlo". Era
  // la pregunta mas frecuente sin tema.
  [TEMAS.CUIDADO, /\blav(a|ar|able|arlo|arla|arse|o)\b/],
  [TEMAS.CUIDADO, /\bes\s+lavable\b/],
  [TEMAS.CUIDADO, /\bcomo\s+(lo|la)\s+(limpio|lavo|cuido)\b/],
  [TEMAS.CUIDADO, /\blimpi(a|ar|arlo|arla|eza)\b/],
  [TEMAS.CUIDADO, /\bse\s+(puede\s+)?moj(a|ar|arlo|arla)\b/],
  [TEMAS.CUIDADO, /\bsumergi/],
  [TEMAS.CUIDADO, /\bmeter\s+(a\s+)?(la\s+)?lavadora\b/],

  // ---- "¿Y si no me funciona?" : va ANTES de GARANTIA ----
  //
  // No es una pregunta por la garantia: es miedo a perder la plata. La
  // respuesta que convierte es el contraentrega, y la garantia detras.
  [TEMAS.SI_NO_FUNCIONA, /\bsi\s+no\s+(me\s+)?(funciona|sirve|resulta|gusta|queda)\b/],
  [TEMAS.SI_NO_FUNCIONA, /\by\s+si\s+no\b/],
  [TEMAS.SI_NO_FUNCIONA, /\bsi\s+no\s+me\s+(convence|hace\s+efecto)\b/],

  // ---- Para quien es: va ANTES de USO y de MEDIDAS ----
  //
  // "¿sirve para una niña de 13?" casa con `sirve para` y recibia la frase
  // de los colicos, que no contesta la pregunta. Y "¿es para hombre?"
  // tampoco tenia tema.
  [TEMAS.DESTINATARIO, /\b(ni[nñ]a|ni[nñ]o|nena|adolescente|muchacha|jovencita)\b/],
  [TEMAS.DESTINATARIO, /\b(sirve|es|funciona|vale)\s+para\s+(un\s+)?(hombre|hombres|var[oó]n|se[nñ]or)\b/],
  [TEMAS.DESTINATARIO, /\bpara\s+(mi\s+)?(hija|mama|mami|abuela|hermana|esposa|novia|suegra)\b/],
  [TEMAS.DESTINATARIO, /\bde\s+\d{1,2}\s+a[nñ]os\b/],
  [TEMAS.DESTINATARIO, /\bes\s+para\s+hombre\b/],

  // ---- Comparativa con lo que ya usa ----
  //
  // Quien compara YA esta decidido a resolver el dolor; solo elige como. Es
  // la pregunta mas facil de convertir y no tenia respuesta.
  [TEMAS.COMPARATIVA, /\bque\s+diferencia\b/],
  [TEMAS.COMPARATIVA, /\bdiferencia\s+(con|entre)\b/],
  [TEMAS.COMPARATIVA, /\bbolsa\s+de\s+agua\b/],
  [TEMAS.COMPARATIVA, /\b(es|son)\s+mejor\s+que\b/],
  [TEMAS.COMPARATIVA, /\ben\s+vez\s+de\s+(una\s+|las\s+|la\s+)?(bolsa|pastilla|pastillas|buscapina|dolex)/],

  // ---- Marca y originalidad ----
  [TEMAS.MARCA, /\bmarca\b/],
  [TEMAS.MARCA, /\b(es|son)\s+original(es)?\b/],
  [TEMAS.MARCA, /\bes\s+(chin[oa]|generic[oa]|replica|imitacion)\b/],
  [TEMAS.MARCA, /\bbuena\s+calidad\b/],
  [TEMAS.MARCA, /\bes\s+de\s+calidad\b/],

  // ---- Empaque, regalo, instrucciones ----
  [TEMAS.EMPAQUE, /\bempaque\b/],
  [TEMAS.EMPAQUE, /\bviene\s+en\s+caja\b/],
  [TEMAS.EMPAQUE, /\bpara\s+regal(o|ar|arlo|arle)\b/],
  [TEMAS.EMPAQUE, /\bes\s+(un\s+)?regalo\b/],
  [TEMAS.EMPAQUE, /\b(manual|instruccion(es)?)\b/],
  [TEMAS.EMPAQUE, /\bque\s+(trae|incluye|viene\s+con)\b/],

  // ---- Factura ----
  [TEMAS.FACTURA, /\bfactura\w*/],
  [TEMAS.FACTURA, /\b(rut|dian)\b/],

  // ---- Cobertura geografica ----
  //
  // Va antes de ENVIO porque "¿llega a mi vereda?" casa con `llega a`, y la
  // respuesta correcta no es el plazo: es que SI llega y que el envio va
  // incluido en cualquier destino. Eso esta confirmado en la ficha y es uno
  // de los argumentos que mas vende fuera de las capitales.
  [TEMAS.COBERTURA, /\b(vereda|corregimiento|zona\s+rural|resguardo)\b/],
  [TEMAS.COBERTURA, /\bcobertura\b/],
  [TEMAS.COBERTURA, /\b(a\s+)?todo\s+el\s+pais\b/],
  [TEMAS.COBERTURA, /\btod[ao]\s+colombia\b/],
  [TEMAS.COBERTURA, /\bllegan?\s+a\s+(mi\s+)?(vereda|pueblo|municipio|corregimiento|finca)\b/],
  [TEMAS.COBERTURA, /\benvian?\s+a\s+(todo|cualquier)\b/],

  // ---- Donde estan ----
  //
  // "En qué ciudad" y "Te encuentras" son de un chat real del 08-oct: el
  // cliente pregunto donde estamos y recibio "esa no te la quiero
  // contestar a medias". A quien desconfia, eso suena a que escondemos
  // algo — y era la respuesta a la pregunta mas facil del mundo.
  [TEMAS.UBICACION, /\ben\s+que\s+ciudad\b/],
  [TEMAS.UBICACION, /\bde\s+que\s+ciudad\b/],
  [TEMAS.UBICACION, /\bde\s+donde\s+(son|escriben|es|hablan)\b/],
  [TEMAS.UBICACION, /\bdonde\s+(te|se)\s+(encuentras|encuentran|ubican)\b/],
  [TEMAS.UBICACION, /\bte\s+encuentras\b/],
  [TEMAS.UBICACION, /\bubicad[oa]s?\b/],
  [TEMAS.UBICACION, /\bdonde\s+(estan|quedan|queda)\b/],
  // "¿tienen tienda física?" casaba con CONFIANZA (`tienen (tienda|local)`)
  // y recibia el fallback «cualquier duda te la resuelve una persona del
  // equipo». Es una pregunta por la ubicacion, y la respuesta buena es que
  // se vende en linea con envio incluido y pago al recibir.
  [TEMAS.UBICACION, /\btienen?\s+(tienda|local|punto\s+de\s+venta|sede)\b/],
  [TEMAS.UBICACION, /\btienda\s+fisica\b/],

  // ---- Horario de atencion ----
  [TEMAS.HORARIO, /\bhorario\b/],
  [TEMAS.HORARIO, /\ba\s+que\s+hora(s)?\s+(atienden|abren|trabajan|contestan|responden)\b/],
  [TEMAS.HORARIO, /\bestan\s+abiertos?\b/],
  [TEMAS.HORARIO, /\b(trabajan|atienden)\s+(los\s+)?(domingos?|sabados?|festivos?|fines?\s+de\s+semana)\b/],

  // ---- Otro canal de contacto ----
  [TEMAS.CANAL, /\bme\s+(pueden|puede|podrian|podria)\s+llamar\b/],
  [TEMAS.CANAL, /\btelefono\s+fijo\b/],
  [TEMAS.CANAL, /\b(pagina|sitio)\s+web\b/],
  [TEMAS.CANAL, /\b(instagram|facebook|tiktok)\b/],
  [TEMAS.CANAL, /\bhacen\s+llamadas?\b/],

  // ---- Otro modelo / que mas venden ----
  [TEMAS.OTRO_MODELO, /\botro\s+(modelo|tipo|dise[nñ]o|producto)\b/],
  [TEMAS.OTRO_MODELO, /\botros\s+(modelos|productos|articulos)\b/],
  [TEMAS.OTRO_MODELO, /\bque\s+mas\s+(venden|tienen|manejan|hay)\b/],
  [TEMAS.OTRO_MODELO, /\bcatalogo\b/],

  // ---- Objecion de precio ----
  //
  // VA ANTES QUE PRECIO a proposito: el orden de esta tabla es el orden de
  // los temas, y de ahi sale la apertura del mensaje. A quien dice "esta muy
  // caro" no se le abre con "Claro que si,".
  //
  // ⚠️ NO VA UN `caro` SUELTO, y el motivo es de esta casa: "Caro" es como
  // se llama media Carolina en Colombia, y el bot EXTRAE EL NOMBRE del
  // texto. Con `\bcaro\b`, un "soy Caro, vivo en Bogota" se leeria como una
  // objecion de precio y le rebatiriamos el precio a quien estaba dando sus
  // datos para comprar. Siempre con el modificador delante ("muy caro",
  // "esta caro") o en superlativo ("carisimo").
  //
  // ⚠️ Y NO VA UN `mucho` SUELTO: "demora mucho?" pregunta por el tiempo de
  // entrega. BIKERPRO lo tiene documentado como defecto real -clasificarlo
  // como objecion hacia que el bot le rebatiera el precio a quien pregunto
  // cuando le llega- y aqui `demora` ya marca ENTREGA. Por eso `es mucho`
  // lleva el lookahead que descarta el tiempo.
  [TEMAS.OBJECION_PRECIO, /\b(muy|tan|que|bien|super|demasiado)\s+car[oa]s?\b/],
  [TEMAS.OBJECION_PRECIO, /\bestan?\s+(muy\s+|bien\s+|algo\s+)?car[oa]s?\b/],
  [TEMAS.OBJECION_PRECIO, /\bes\s+(muy\s+|algo\s+)?car[oa]\b/],
  [TEMAS.OBJECION_PRECIO, /\bcar[ií]sim[oa]s?\b/],
  [TEMAS.OBJECION_PRECIO, /\bcostos[oa]s?\b/],
  [TEMAS.OBJECION_PRECIO, /\bno\s+me\s+alcanza\b/],
  // EL DIMINUTIVO. "Esta carito" es la forma SUAVE de decir que es caro, y
  // es la que mas se usa: quien dice "carito" no quiere pelear el precio,
  // quiere que le den una razon. Caia en el camino generico.
  [TEMAS.OBJECION_PRECIO, /\bcar(ito|ita|itos|itas)\b/],
  [TEMAS.OBJECION_PRECIO, /\bno\s+tengo\s+(plata|dinero|efectivo)\b/],
  [TEMAS.OBJECION_PRECIO, /\bestoy\s+(corta|corto)\s+de\s+plata\b/],
  [TEMAS.OBJECION_PRECIO, /\bno\s+tengo\s+(tanto|esa\s+plata)\b/],
  [TEMAS.OBJECION_PRECIO, /\bes\s+mucha\s+plata\b/],
  [TEMAS.OBJECION_PRECIO, /\bes\s+mucho\b(?!\s+(tiempo|rato))/],
  [TEMAS.OBJECION_PRECIO, /\b(descuento|rebaja|rebajas)\b/],
  [TEMAS.OBJECION_PRECIO, /\bmas\s+(barat[oa]s?|economic[oa]s?)\b/],
  [TEMAS.OBJECION_PRECIO, /\b(ultimo|mejor)\s+precio\b/],
  [TEMAS.OBJECION_PRECIO, /\bprecio\s+especial\b/],
  [TEMAS.OBJECION_PRECIO, /\bme\s+lo\s+dej(as|a|arias)\s+en\b/],
  [TEMAS.OBJECION_PRECIO, /\b(me\s+)?(baja|bajas|rebaja|rebajas)\s+(algo|el\s+precio)\b/],
  [TEMAS.OBJECION_PRECIO, /\bpresupuesto\b/],
  [TEMAS.OBJECION_PRECIO, /\besta\s+en\s+promocion\b/],

  // ---- Precio ----
  //
  // La lista vive en `texto.js` porque el cerebro tambien la necesita para
  // decidir si repite una cifra. Tenerla DOS veces fue un defecto real: las
  // dos copias se separaron y el plural ("que valen dos") no estaba en
  // ninguna, asi que preguntar por dos unidades no se reconocia.
  ...PREGUNTA_PRECIO.map((re) => [TEMAS.PRECIO, re]),
  [TEMAS.PRECIO, /\b(cual\s+es\s+el)\s+precio\b/],
  [TEMAS.PRECIO, /\bcuanto\b.*\bcon\s+envio\b/],

  // ---- Envio ----
  // "como es el envio", "hacen envios", "envian a", "domicilio", "flete".
  [TEMAS.ENVIO, /\benvi(o|os|an|a)\b/],
  [TEMAS.ENVIO, /\bdomicilio\b/],
  [TEMAS.ENVIO, /\bflete\b/],
  [TEMAS.ENVIO, /\bmandan?\s+a\b/],
  [TEMAS.ENVIO, /\bllega\s+a\b/],

  // ---- Pago ----
  [TEMAS.PAGO, /\bcontra\s*entrega\b/],
  [TEMAS.PAGO, /\bcontraentrega\b/],
  [TEMAS.PAGO, /\b(como|cuando)\s+(se\s+)?pag(a|o|ar)\b/],
  [TEMAS.PAGO, /\bpago\s+(al|contra)\b/],
  [TEMAS.PAGO, /\b(acepta|aceptan|reciben|puedo\s+pagar)\b.*\b(nequi|daviplata|transferencia|tarjeta|efectivo)\b/],
  [TEMAS.PAGO, /\b(nequi|daviplata|transferencia)\b/],
  [TEMAS.PAGO, /\bpago\s+anticipado\b/],
  // "se paga al recibir?", "tengo que pagar antes?". Son LA pregunta del
  // contraentrega, y caian en el camino generico: el bot admitia no saber
  // algo que esta aprobado en la ficha.
  [TEMAS.PAGO, /\bse\s+pag(a|an)\s+(al|cuando|contra|despues)\b/],
  [TEMAS.PAGO, /\b(tengo|hay|toca)\s+que\s+pagar\b/],
  [TEMAS.PAGO, /\bpagar\s+(antes|adelantado|anticipado|al\s+recibir)\b/],
  [TEMAS.PAGO, /\bpago\s+(antes|adelantado|al\s+recibir)\b/],

  // ---- Color ----
  [TEMAS.COLOR, /\bcolor(es)?\b/],
  [TEMAS.COLOR, /\bviene\s+en\s+\w+/],
  [TEMAS.COLOR, /\b(rosado|rosa|negro|blanco|azul|rojo|verde|morado|gris)\b/],

  // ---- Talla ----
  [TEMAS.TALLA, /\btallas?\b/],
  [TEMAS.TALLA, /\bes\s+unitalla\b/],
  [TEMAS.TALLA, /\bque\s+tamano\b/],
  [TEMAS.TALLA, /\b(es|hay)\s+talla\s+unica\b/],

  // ---- Medidas y ajuste: el tema sensible de este producto ----
  // Marco fue explicito: no hay medidas del ajuste y no se promete que sirva
  // para cualquier contorno. Se clasifica aparte de TALLA para poder dar la
  // respuesta honesta en vez de la del dato aprobado.
  [TEMAS.MEDIDAS, /\bme\s+(sirve|queda|servira|quedara|serviria|quedaria)\b/],
  // "¿le sirve a una persona delgada?": pregunta por OTRA persona, o en
  // tercera persona. Es la misma duda -la mas frecuente del producto- y
  // solo se reconocia en primera.
  [TEMAS.MEDIDAS, /\b(le|les)\s+(sirve|queda|servira|quedara|serviria|quedaria)\b/],
  [TEMAS.MEDIDAS, /\bsirve\s+(a|para)\s+(una|un)\s+(persona|señora|senora|mujer|chica)\b/],
  [TEMAS.MEDIDAS, /\bpersona\s+(delgada|flaca|gruesa|gorda|grande|robusta)\b/],
  [TEMAS.MEDIDAS, /\b(contorno|cintura|abdomen|barriga|cadera)\b/],
  [TEMAS.MEDIDAS, /\bcuanto\s+(mide|estira|ajusta)\b/],
  [TEMAS.MEDIDAS, /\b(medidas?|centimetros|cm)\b/],
  [TEMAS.MEDIDAS, /\buso\s+talla\b/],
  [TEMAS.MEDIDAS, /\bsoy\s+(gordita|gorda|delgada|grande|pequena)\b/],

  // ---- Garantia: el plazo ----
  [TEMAS.GARANTIA, /\bgarantia\b/],

  // ---- Garantia: el tramite y la cobertura ----
  // Se separa del plazo porque son dos datos distintos: el plazo lo
  // confirmo Marco (1 mes) y el tramite NO esta definido. Responder "1 mes"
  // a "¿cómo la hago efectiva?" contesta otra pregunta.
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+(la\s+)?(hago|hacer)\s+efectiva\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+(reclamo|la\s+reclamo|pido\s+la\s+garantia)\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bcomo\s+funciona\s+la\s+garantia\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bque\s+cubre\b/],
  [TEMAS.GARANTIA_TRAMITE, /\bquien\s+paga\s+(el\s+)?(envio\s+de\s+)?(la\s+)?(devoluci|cambio)/],
  [TEMAS.GARANTIA, /\bsi\s+(sale|viene)\s+(malo|dañado|danado|defectuoso)\b/],
  [TEMAS.GARANTIA, /\b(puedo|se\s+puede)\s+(devolver|cambiar)\b/],
  [TEMAS.GARANTIA, /\bdevoluci(on|ones)\b/],

  // ---- Tiempo de entrega ----
  //
  // ⚠️ EL CONDICIONAL TAMBIEN CUENTA, y es la forma MAS natural de
  // preguntarlo en castellano: "¿cuándo me llegaría?".
  //
  // Esto solo conocia el presente -"cuando me llega"- y Marco lo cazo
  // probando desde su numero el 08-oct:
  //
  //   Marco · "Cuando me llegaría"
  //   bot   · "Esa no te la quiero contestar a medias..."
  //
  // El plazo esta en la ficha, aprobado. Negarse a decirlo por una "r" y
  // dos letras mas es el mismo error que "costó" frente a "cuesta".
  [TEMAS.ENTREGA, /\bcuando\s+(?:me\s+|lo\s+|la\s+|le\s+|nos\s+)?(?:llega|llegaria|llegara|llegarian)\b/],
  [TEMAS.ENTREGA, /\bcuando\s+(?:lo\s+|la\s+|los\s+|las\s+)?(?:recibo|recibiria|recibiera|recibimos)\b/],
  [TEMAS.ENTREGA, /\bcuant[oa]s?\s+(?:se\s+)?(?:tarda|tardaria|tardan|demora|demoraria|demoran)\b/],
  [TEMAS.ENTREGA, /\bcuantos\s+dias\b/],
  [TEMAS.ENTREGA, /\bdemora\w*/],
  [TEMAS.ENTREGA, /\bpara\s+cuando\b/],
  // "¿llega el lunes?", "¿hacen entregas los sábados?". Preguntan por un
  // DIA CONCRETO, y la respuesta honesta es el plazo de la ficha: el dia
  // exacto esta declarado como dato NO confirmado y prometerlo esta
  // prohibido. Pero callarse no: caia en el camino generico.
  [
    TEMAS.ENTREGA,
    /\b(llega|llegaria|entregan|despachan|reparten|hacen\s+(entregas|envios))\b[^?]{0,20}\b(lunes|martes|miercoles|jueves|viernes|sabado|sabados|domingo|domingos|festivo|festivos|fin\s+de\s+semana)\b/,
  ],
  [TEMAS.ENTREGA, /\ben\s+cuanto\s+(?:me\s+|lo\s+|la\s+)?(?:llega|llegaria|lleg\w+|recib\w+)\b/],
  // ----------------------------------------------------------------------
  // LA PRISA: "¿no habría manera de que llegue hoy?"
  //
  // Es un mensaje REAL del 08-oct (chat de Steven, Popayán) y es el cliente
  // mas caliente que entra por aqui: quien pregunta si llega hoy tiene el
  // colico HOY. Recibio "esto lo reviso con una persona del equipo" y el bot
  // se callo 12 horas; una persona lo rescato a mano hora y media despues.
  //
  // La respuesta honesta no es el silencio ni una promesa: es el rango de la
  // ficha. Prometer el dia exacto sigue PROHIBIDO -esta en claimsProhibidos
  // frase por frase- y el redactor no puede escribirlo; lo que si se puede
  // es contestar "1 a 3 días hábiles según tu ciudad", que es lo que el
  // cliente necesita para decidir.
  [TEMAS.ENTREGA, /\b(llegue|llega|llegaria|llegar)\s+(hoy|ya|rapido|pronto|esta\s+tarde|esta\s+noche)\b/],
  [TEMAS.ENTREGA, /\b(para|por)\s+hoy\b/],
  [TEMAS.ENTREGA, /\bhoy\s+mismo\b/],
  [TEMAS.ENTREGA, /\bmanera\s+de\s+que\s+llegue\b/],
  [TEMAS.ENTREGA, /\bcuanto\s+antes\b/],
  [TEMAS.ENTREGA, /\blo\s+necesito\s+(hoy|ya|urgente|para\s+hoy)\b/],
  [TEMAS.ENTREGA, /\burgente\b/],

  // ---- Material ----
  [TEMAS.MATERIAL, /\bmaterial\b/],
  [TEMAS.MATERIAL, /\bde\s+que\s+(esta\s+hecho|es)\b/],
  [TEMAS.MATERIAL, /\b(tela|cuero|plastico|algodon)\b/],

  // ---- Como funciona / para que sirve ----
  [TEMAS.USO, /\bcomo\s+(funciona|se\s+usa|se\s+pone|lo\s+uso)\b/],
  [TEMAS.USO, /\bpara\s+que\s+sirve\b/],
  // "¿esto sirve para los cólicos?" es EL EJEMPLO que dio Marco, y no se
  // reconocia: no casa con "para que sirve". Caia en el camino de la duda
  // no catalogada y recibia "esa no te la quiero contestar a medias",
  // teniendo la respuesta autorizada en la ficha.
  //
  // De un producto que se llama "cinturón térmico para cólicos", no
  // entender esa pregunta es el colmo.
  [TEMAS.USO, /\bsirve\s+(para|contra|de\s+verdad|realmente)\b/],
  // ⚠️ EL LOOKAHEAD NO ES UN ADORNO: "AYUDA CON PEDIDO" NO ES ESTE TEMA.
  //
  // Esto era `\b(funciona|ayuda)\s+(para|con|contra)\b` y casaba con "ayuda
  // con pedido". El 08-oct una clienta escribio justo eso -pidiendo ayuda
  // para comprar- y el bot le explico para que sirve el cinturon. Dos veces
  // en la misma conversacion, y no se cerro la venta.
  //
  // Quien pide ayuda CON EL PEDIDO esta comprando, no preguntando que hace
  // el producto.
  // Y tampoco es este tema "funciona con bateria": eso es ENERGIA, que se
  // contesta admitiendo que el dato no esta confirmado. Si cayera aqui,
  // recibiria la frase de los colicos — el mismo defecto que el cargador.
  [
    TEMAS.USO,
    /\b(funciona|ayuda)\s+(para|con|contra)\s+(?!(?:el\s+|la\s+|mi\s+|un\s+|una\s+)?(?:pedido|compra|orden|pago|envio|comprar|pedir|bateria|pila|cable|cargador|corriente|enchufe|luz)\b)/,
  ],
  [TEMAS.USO, /\bes\s+(para|bueno\s+para)\s+(los\s+)?(colicos|dolor|menstrual)/],
  [TEMAS.USO, /\bquita\s+(el\s+)?dolor\b/],
  [TEMAS.USO, /\bniveles?\s+de\s+(calor|temperatura|intensidad)\b/],
  [TEMAS.USO, /\bcalienta\b/],

  // ---- Como se alimenta: bateria, cargador, enchufe ----
  //
  // TEMA APARTE, y por un motivo concreto: la ficha declara "si funciona
  // con bateria o enchufado, y cuanto dura" como dato NO CONFIRMADO. Estaba
  // dentro de USO, y USO responde con `paraQueSirve`, asi que preguntar por
  // el cargador recibia la frase de los colicos:
  //
  //   clienta: "Con cables para cargar"
  //   bot:     "Sí, es justo para eso: el calor en la zona baja del
  //             abdomen ayuda a relajar y alivia el cólico."
  //
  // Paso el 08-oct. Y "Trae cargador" no casaba con nada, asi que recibio
  // una peticion de datos. Dos mensajes seguidos sin respuesta a lo que
  // pregunto.
  //
  // Separarlo permite contestar lo honesto -que ese dato lo confirma una
  // persona- sin tocar la respuesta de "para que sirve", que es correcta.
  [TEMAS.ENERGIA, /\bes\s+(recargable|electrico|electrica)\b/],
  // ⚠️ `carga` NO LLEVA `\w*`, Y ES UN DEFECTO MEDIDO EN PRODUCCION.
  //
  // Era `/\b(bateria|pila|cable|usb|enchuf|cargador|carga)\w*/`, y ese
  // `carga\w*` casaba con "cargaron". El 08-oct, en el chat de Marco:
  //
  //   Marco  · "Quiero ver fotos"
  //   NOVIKA · "Te las mandé aquí arriba; si no te cargaron, dime…"
  //   Marco  · "No cargaron"
  //   NOVIKA · "Buena pregunta: en las fotos se ve el panel de control…
  //             Si funciona con batería o enchufado no te lo quiero decir
  //             a medias…"
  //
  // El bot le hablo de la bateria a quien le estaba diciendo que las fotos
  // no le llegaron — y ademas escalo. Las formas que de verdad preguntan
  // por la energia se enumeran: "carga", "cargar", "recargable". El
  // pasado ("cargaron", "cargo") es SIEMPRE de las fotos.
  [TEMAS.ENERGIA, /\b(bateria|pila|cable|cables|usb|enchuf\w*|cargador|recargable|recarga)\b/],
  [TEMAS.ENERGIA, /\bcargar?\b/],
  [TEMAS.ENERGIA, /\bcuantos\s+niveles\b/],
  [TEMAS.ENERGIA, /\bniveles?\s+(de|tiene|trae|maneja)\b/],
  [TEMAS.ENERGIA, /\bcuanto\s+(dura|le\s+dura)\b/],

  // ---- Desconfianza ----
  [TEMAS.CONFIANZA, /\bes\s+(real|confiable|seguro|estafa)\b/],
  [TEMAS.CONFIANZA, /\bson\s+(reales|confiables|seguros)\b/],
  [TEMAS.CONFIANZA, /\bno\s+es\s+estafa\b/],
  // "no sera estafa?", "sera confiable?": el FUTURO y el CONDICIONAL, que
  // es como se pregunta cuando de verdad hay desconfianza. Solo conocia el
  // presente, asi que la duda que mas venta mata caia en el camino
  // generico — y a quien desconfia, un "esa no te la quiero contestar" se
  // le lee como que escondemos algo.
  [TEMAS.CONFIANZA, /\b(sera|seria)\s+(estafa|confiable|seguro|real|robo)\b/],
  [TEMAS.CONFIANZA, /\bno\s+(sera|seria|iran?\s+a)\s+(estafa|robar|estafar)/],
  [TEMAS.CONFIANZA, /\bson\s+(serios|formales|de\s+fiar)\b/],
  [TEMAS.CONFIANZA, /\bme\s+(van|iran)\s+a\s+(estafar|robar)\b/],
  [TEMAS.CONFIANZA, /\bdonde\s+(estan|quedan|es)\b/],
  [TEMAS.CONFIANZA, /\btienen\s+(tienda|local|direccion)\b/],
  // LA DESCONFIANZA SE DICE EN PRIMERA PERSONA, Y NO ESTABA CUBIERTA.
  //
  // Medido el 09-oct: "no confío en estas páginas" no tenia tema, asi que
  // el bot le contestaba "¿Cuántos quieres? Y para preparar tu pedido me
  // pasas la ciudad y la dirección". Pedirle los datos a quien acaba de
  // decir que no confia es la forma mas rapida de confirmarle el miedo.
  [TEMAS.CONFIANZA, /\bno\s+(confio|me\s+confio|me\s+fio)\b/],
  [TEMAS.CONFIANZA, /\bdesconfi/],
  [TEMAS.CONFIANZA, /\bme\s+da\s+(miedo|cosa|desconfianza)\b/],
  [TEMAS.CONFIANZA, /\bme\s+han\s+(estafado|robado|tumbado)\b/],
  [TEMAS.CONFIANZA, /\bya\s+me\s+(estafaron|tumbaron|robaron)\b/],
  [TEMAS.CONFIANZA, /\bcomo\s+se\s+que\s+(es|son|no\s+es)\b/],
  [TEMAS.CONFIANZA, /\bes\s+seguro\s+(comprar|pedir|pagar)\b/],

  // ---- Fotos ----
  [TEMAS.FOTOS, /\bfotos?\b/],
  [TEMAS.FOTOS, /\bimagen(es)?\b/],
  [TEMAS.FOTOS, /\bver(lo|la)?\b/],
];

/**
 * Señales de que el cliente QUIERE COMPRAR, no solo averiguar.
 *
 * Es la lista que autoriza a pedir los datos de entrega. Tiene que ser
 * explicita: "lo quiero", "me sirve", "dale". Una duda no entra aqui.
 */
const SENALES_DE_COMPRA = [
  // ----------------------------------------------------------------------
  // EL PLURAL TAMBIEN ES UNA SEÑAL DE COMPRA
  //
  // Esto solo cubria singular -"lo quiero", "la quiero"- y el combo de dos
  // era casi imposible de cerrar hablando:
  //
  //   clienta: "¿cuánto me salen dos?"
  //   bot:     "2 unidades te quedan en $85.000..."
  //   clienta: "las quiero"
  //   bot:     "¿Cuántos quieres?"     <- no lo leyo como compra
  //
  // "las quiero", "me las llevo" y "las dos" son justo lo que dice quien
  // compra dos. Sin el plural, el precio del combo no servia para nada.
  // ----------------------------------------------------------------------
  /\b(lo|la|los|las)\s+(quiero|llevo|compro|necesito)\b/,
  /\bme\s+(lo|la|los|las)\s+(llevo|quedo)\b/,
  // "AYUDA CON PEDIDO", "ayudame a pedirlo", "quiero hacer el pedido".
  //
  // Es alguien pidiendo que le ayuden a COMPRAR, y no se reconocia: casaba
  // con el tema USO -por "ayuda con"- y recibia una explicacion de para
  // que sirve el producto. El 08-oct una clienta lo escribio despues de
  // haber dado ciudad y cantidad, y el bot le volvio a explicar el
  // producto en vez de cerrarle la venta.
  /\bayud(a|ame|arme)\s+(con|a)\s+(el\s+|la\s+|mi\s+)?(pedido|compra|comprar|pedir)/,
  /\bquiero\s+(hacer\s+)?(el\s+|un\s+)?pedido\b/,
  // "¿cómo hago el pedido?", "¿cómo compro?". Es pedir el siguiente paso
  // para comprar, y recibia "esa no te la quiero contestar a medias".
  /\bcomo\s+(hago|hacer|se\s+hace|realizo)\s+(el\s+|un\s+)?(pedido|la\s+compra)\b/,
  /\bcomo\s+(compro|comprar|lo\s+compro|lo\s+pido|pido)\b/,
  /\bcomo\s+hago\s+para\s+(comprar|pedir|que\s+me\s+llegue)\b/,
  // EL IMPERATIVO. "Deme 2", "mándeme uno", "regáleme uno" es como se
  // compra hablando en Colombia, y no se reconocia: la lista solo tenia
  // "quiero/llevo/compro". Quien escribe "deme 2" ya decidio.
  /\b(deme|dame|demel[oa]|damel[oa]|mandeme|mandame|mandemel[oa]|envieme|enviame|regaleme|regalame|separeme|separame|apunteme|anoteme)\b/,
  /\bnecesito\s+(\d{1,2}|un|uno|una|dos|tres|cuatro)\b/,
  /^\s*si\s*[,.]?\s*(lo\s+|la\s+|los\s+|las\s+)?quiero\b/,
  /\b(quiero|llevo|dame|mandame|enviame)\s+(los|las)\s+dos\b/,
  // El DIGITO tambien: "quiero 2 unidades" no se leia como compra porque
  // esto solo cubria los numeros escritos con letras.
  /\bquiero\s+(\d{1,2}|uno|una|un|dos|tres|cuatro|cinco|comprarlo|comprarla|pedirlo|pedirla|ese|esa|el|la)\b/,
  /\b(quiero|llevo|dame|mandame|enviame|necesito)\s+\d{1,2}\s*(unidades?|cinturones|cinturon)?\b/,
  /\b(dale|hagale|hagamoslo|de\s+una|despachalo|despachelo)\b/,
  /\b(como\s+)?(hago|hacemos)\s+para\s+(pedir|comprar|que\s+me\s+llegue)\b/,
  /\b(mandem?el[oa]|envielo|enviamelo|envienmelo|despachenlo)\b/,
  /\bvoy\s+a\s+(llevar|comprar|pedir)\b/,
  /\bcomo\s+pido\b/,
  /\bquiero\s+(hacer|realizar)\s+(el|un)\s+pedido\b/,
];

// --------------------------------------------------------------------------
// SEÑALES DEBILES: LAS QUE CAMBIAN DE SENTIDO CON UN SIGNO DE PREGUNTA
//
// "me sirve" afirmando es una señal de compra clarisima. "¿me sirve?" es la
// duda mas frecuente de un producto que se pone en el cuerpo, y es lo
// CONTRARIO: el cliente todavia no sabe si le queda.
//
// Estaban en la lista de arriba y produjeron esto, que salio al probar el
// dialogo completo:
//
//   clienta: "¿me sirve a mí? uso talla XL"
//   bot:     "...¿Cuántos quieres? Y para despacharlo me pasas la ciudad y
//             la dirección."
//
// Le pidio la direccion a alguien que acababa de preguntar si el producto le
// iba a quedar. Por eso estas solo cuentan como compra cuando la frase NO es
// una pregunta.
// --------------------------------------------------------------------------
const SENALES_DEBILES = [
  /\b(me\s+)?(sirve|interesa|conviene|parece\s+bien)\b/,
  // "las dos" suelto es una señal DEBIL, no fuerte: afirmando es aceptar el
  // combo ("las dos"), pero preguntando es pedir su precio ("¿cuánto
  // cuestan las dos?"). Aqui solo vale sin interrogacion.
  // El lookbehind excluye la hora: "a las dos de la tarde".
  /(?<!\ba\s)\blas\s+dos\b/,
  // "vale" en Colombia es "de acuerdo", y por eso esta aqui... pero tambien
  // es el verbo de "¿cuánto VALE?". Sin el lookbehind, preguntar el precio
  // contaba como aceptar la compra, y el bot le pedia los datos de entrega a
  // quien solo estaba averiguando — justo lo que este modulo existe para
  // evitar. Lo mismo con "a como vale".
  /(?<!\b(?:cuanto|cuantos|cuantas|que|cual|como)\s)\b(listo|perfecto|vale|bueno)\b/,
];

// --------------------------------------------------------------------------
// LA CANTIDAD POR LA QUE PREGUNTA, QUE NO ES LA DEL PEDIDO
//
// "Nunca contestes el precio de una unidad a una pregunta sobre dos". Para
// cumplirlo hay que saber por cuantas pregunta, y eso es un dato DISTINTO
// de la cantidad que ya tiene en su ficha o en un pedido confirmado.
//
// SE LEE PEGADO AL VERBO, no en todo el mensaje, y el motivo es una
// direccion: "cuanto vale a Calle 20 # 15-30" tiene un 20 y un 15, y leer
// cualquier numero del mensaje haria que preguntara por 20 unidades. El
// mismo error que ya se cometio una vez leyendo "calle 45" como 45 unidades.
// --------------------------------------------------------------------------
const UNIDADES_CONSULTADAS = [
  // "que valen dos", "cuanto cuestan 2", "cuanto sale el par", "precio de 3"
  // Con las erratas de dedo, igual que la lista de `texto.js`: si ahi se
  // reconoce "cuanto balen 2" como pregunta de precio pero aqui no se saca
  // el 2, se contesta el precio de UNA a una pregunta por DOS — que es
  // justo el defecto que el PR #2 arreglo.
  /\b(?:vale|valen|bale|balen|cuesta|cuestan|kuesta|kuestan|sale|salen|saldria|saldrian|seria|serian|precio\s+de|por|como)\s+(?:las?\s+|los?\s+|el\s+)?(\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|par|docena)\b/,
  // "¿y el par?" a secas.
  /^\s*y\s+(?:el\s+(par)|(?:los|las)\s+(dos))\s*\??\s*$/,
  // "y las dos", "los dos", "el par"
  /\b(?:las|los)\s+(dos|tres|cuatro)\b/,
  /\bel\s+(par)\b/,
  // "dos unidades", "2 cinturones"
  /\b(\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|par|docena)\s+(?:unidades?|cinturones|cinturon|fajas?)\b/,
  // LA CANTIDAD DE LA PREGUNTA CONDICIONAL: "y si llevo dos?", "llevando
  // tres". El patron que la reconoce como pregunta de precio vive en
  // `texto.js`; aqui hay que sacarle el numero, o se cotizaria por la
  // cantidad de la ficha en vez de por la que pregunto.
  /\b(?:y\s+si\s+(?:me\s+)?(?:llevo|pido|compro)|si\s+(?:me\s+)?(?:llevara|llevaria|pidiera|comprara)|llevando)\s+(?:las?\s+|los?\s+|el\s+)?(\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|par|docena)\b/,
  // EL NUMERO DELANTE DEL VERBO: "y tres cuánto valen?", "2 cuánto cuestan".
  // Faltaba, y el hueco se colaba justo donde mas duele: con un pedido ya
  // confirmado, "y tres cuanto valen?" contestaba el precio de SU pedido.
  //
  // Va anclado al principio del mensaje -con un "y" opcional- a proposito.
  // Sin el ancla, "Calle 20 cuanto vale el envio" leeria 20 unidades: el
  // mismo error de confundir una direccion con una cantidad, otra vez.
  /^\s*(?:y\s+)?(\d{1,2}|dos|tres|cuatro|cinco|seis|par)\s+(?:cuanto|cuantos|que)\s+(?:vale|valen|cuesta|cuestan|sale|salen)/,
];

/**
 * Por cuantas unidades pregunta, si lo dice.
 *
 * @returns {number|null} null cuando no lo dice: entonces NO se adivina.
 */
function cantidadPreguntadaEn(plano) {
  const { NUMEROS_EN_PALABRAS } = require("./texto");
  for (const re of UNIDADES_CONSULTADAS) {
    const m = plano.match(re);
    if (!m) continue;
    const bruto = m[1];
    const valor = /^\d+$/.test(bruto) ? Number(bruto) : NUMEROS_EN_PALABRAS[bruto];
    // Fuera de 1..20 no es una cantidad: es un precio, un año o una calle.
    if (Number.isFinite(valor) && valor >= 1 && valor <= 20) return valor;
  }
  return null;
}

// --------------------------------------------------------------------------
// "OTRO" ES UNA INTENCION DISTINTA DE "CUANTO VALE"
//
// Con un pedido ya confirmado hay dos preguntas que se parecen y no son lo
// mismo:
//
//   "¿que valen dos?"      -> quiere SABER un precio. Se le dice y punto.
//   "¿cuanto vale otro?"   -> quiere OTRO. Eso es una venta adicional.
//
// La diferencia importa porque la segunda necesita que una persona la arme
// -el bot no toca un pedido confirmado- y la primera no necesita a nadie.
// Confundirlas en un sentido pierde una venta; en el otro, convierte la
// respuesta en el estribillo "le digo a una persona" en cada mensaje.
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// PREGUNTAR POR SU PEDIDO NO ES PREGUNTAR POR EL ENVIO
//
// Con un pedido confirmado, el numero de pedido se añadia a cualquier
// mensaje que mencionara envio o entrega. Y "¿cuánto cuestan 2 con envío?"
// menciona el envio sin preguntar nada de su pedido:
//
//   clienta: "y cuánto cuestan 2 con envío"
//   bot:     "2 unidades te quedan en $85.000. El envío va incluido...
//             Tu pedido NOV-... ya está confirmado y te avisamos..."
//
// Esa ultima frase no la pidio nadie. Mezcla una consulta NUEVA -quiere
// comprar mas- con el estado de una compra vieja, y convierte una respuesta
// de dos lineas en un parrafo donde lo importante queda enterrado.
//
// El estado del pedido se dice cuando pregunta POR EL PEDIDO: "¿ya salió?",
// "¿cuándo me llega lo que pedí?", "mi guía".
// --------------------------------------------------------------------------
const PREGUNTA_POR_SU_PEDIDO = [
  /\b(mi|el)\s+(pedido|compra|paquete|envio|guia|orden)\b/,
  /\b(ya\s+)?(salio|despacharon|despacho|enviaron|mandaron)\b/,
  /\bnumero\s+de\s+(pedido|guia)\b/,
  /\b(cuando|donde)\s+(me\s+)?(llega|va\s+a\s+llegar|esta)\b.*\b(lo\s+que\s+pedi|mi\s+pedido|mi\s+paquete)\b/,
  /\b(lo\s+que|el\s+que)\s+pedi\b/,
  /\bestado\s+de\s+mi\b/,
  /\brastre(o|ar)\b/,
];

const QUIERE_OTRO = [
  /\b(otro|otra|otros|otras)\b/,
  /\b(uno|una|dos)\s+mas\b/,
  /\bmas\s+unidades?\b/,
  /\b(pedir|comprar|llevar)\s+(mas|otro|otra)\b/,
];

// --------------------------------------------------------------------------
// "NO ME CARGARON LAS FOTOS"
//
// El bot ofrece reenviarlas -"si no te cargaron, dime y te las paso otra
// vez"- y la deduplicacion lo impedia: no reenvia dos veces las mismas
// imagenes al mismo chat, que es correcto para no llenar la pantalla pero
// convierte el ofrecimiento en una promesa falsa.
//
// Lo que faltaba era distinguir "muestrame fotos" de "las fotos no me
// llegaron". La segunda es un acto explicito del cliente, y entonces se
// fuerza el reenvio: `enviarFotosDeProducto` ya acepta `forzar`.
// --------------------------------------------------------------------------
/**
 * SE QUEJA DE QUE NO LE LLEGARON. Basta por si sola: es lo que se escribe
 * justo despues de recibir unas imagenes que no abren, y no se dice de
 * ninguna otra cosa de esta conversacion.
 */
const NO_LE_LLEGARON = [
  /\bno\s+(me\s+)?(las|los|la|lo)?\s*(cargaron|cargan|carga|llegaron|llego|llegan|abren|abre|abrieron)\b/,
  /\bno\s+(las|los|la|lo)\s+(veo|puedo\s+ver|recibi|recibo)\b/,
  /\bno\s+(me\s+)?(se\s+ven|se\s+ve|veo)\b/,
  /\bestan?\s+(borrosas?|en\s+blanco|cortadas?)\b/,
];

/**
 * PIDE QUE SE REPITAN. Necesita que nombre las imagenes: "otra vez" suelto
 * tambien sirve para "dime el precio otra vez", que no es pedir fotos.
 */
const OTRA_VEZ = /\b(otra\s+vez|de\s+nuevo|nuevamente|repite|reenvia|reenviame|mandalas|pasalas)\b/;
const NOMBRA_IMAGENES = /\b(fotos?|imagen(es)?|videos?|fotico|fotitos)\b/;

/**
 * ¿Pide que se le reenvien las fotos?
 *
 * EL CONTEXTO IMPORTA, y es la correccion de Marco: "no las veo" o "estan
 * borrosas" solo se refieren a las fotos cuando la conversacion va de las
 * fotos. La primera version aceptaba la queja SOLA, y entonces "no veo el
 * boton", "no veo la direccion que puse" o "no se ve bien el precio"
 * disparaban cinco imagenes que nadie habia pedido.
 *
 * Dos contextos valen, y los dos son explicitos:
 *
 *   · NOMBRA las imagenes -"las fotos no cargan"-, que no deja duda.
 *   · O acabamos de mandarlas. Una queja de "no las veo" justo despues de
 *     recibir unas imagenes se refiere a esas imagenes; la misma frase tres
 *     dias despues, no.
 *
 * @param {string} texto
 * @param {object} [contexto]
 * @param {boolean} [contexto.fotosRecientes] se le mandaron fotos hace poco
 */
function pideReenvioDeFotos(texto, { fotosRecientes = false } = {}) {
  const plano = aplanar(texto);
  if (!plano) return false;

  // Si nombra las imagenes, no hace falta mas contexto.
  if (NOMBRA_IMAGENES.test(plano)) {
    return NO_LE_LLEGARON.some((re) => re.test(plano)) || OTRA_VEZ.test(plano);
  }

  // Si NO las nombra, solo vale la queja y solo si acabamos de mandarlas.
  if (!fotosRecientes) return false;
  return NO_LE_LLEGARON.some((re) => re.test(plano));
}

/** Cuanto tiempo despues de mandarlas una queja sigue siendo sobre ellas. */
const MINUTOS_DE_CONTEXTO_DE_FOTOS = 60;

/**
 * ¿Se le mandaron fotos hace poco? Es lo que convierte "no las veo" en una
 * queja sobre las fotos y no sobre cualquier otra cosa.
 */
function fotosRecientes(cuando, { ahora = Date.now(), minutos = MINUTOS_DE_CONTEXTO_DE_FOTOS } = {}) {
  if (!cuando) return false;
  const t = new Date(cuando).getTime();
  if (!Number.isFinite(t)) return false;
  return ahora - t <= minutos * 60000;
}

// --------------------------------------------------------------------------
// "QUIERO INFORMACION" NO ES "QUIERO UNO"
//
// EL CASO REAL, de un cliente que llego por la publicidad:
//
//   cliente: "Hola, quiero información sobre el cinturón térmico de $49.900."
//   bot:     "¡Hola! Una unidad te queda en $49.900... ¿Cuántos quieres? Y
//             para preparar tu pedido me pasas tu nombre completo, la ciudad
//             y la dirección."
//
// Le pidio nombre, ciudad y direccion a alguien que pidio INFORMACION. Y la
// palabra que lo disparo no fue ninguna señal de compra: el mensaje no se
// reconocia como NADA -sin temas, sin pregunta, sin saludo- y el camino de
// "no pregunto nada" acaba pidiendo los datos.
//
// Es el peor sitio donde fallar: es el PRIMER mensaje de alguien por el que
// estamos pagando publicidad.
//
// Pedir informacion es una intencion propia, distinta de las otras tres:
//
//   "¿tiene garantia?"   -> pregunta un TEMA concreto
//   "lo quiero"          -> compra
//   "hola"               -> saludo
//   "quiero informacion" -> quiere que le CUENTEN, sin preguntar nada aun
//
// Y se responde como se merece: presentando el producto con sus condiciones
// y dejando la puerta abierta a preguntar. Sin pedir un solo dato.
// --------------------------------------------------------------------------
const PIDE_INFORMACION = [
  /\b(quiero|quisiera|necesito|me\s+gustaria|podrias?\s+darme|me\s+das|mandame|me\s+puedes?\s+dar)\s+(mas\s+)?(informacion|info|detalles|datos)\b/,
  /\b(mas\s+)?(informacion|info)\s+(sobre|del|de\s+la|acerca)\b/,
  /^\s*(informacion|info)\b/,
  // "mas info" a secas. El patron de arriba exigia "sobre/del/acerca"
  // detras, y el otro que empiece el mensaje.
  /\b(mas|otra)\s+(info|informacion)\b/,
  /\bcuentame\s+(mas|sobre|del|de)\b/,
  /\bque\s+me\s+(puedes?|podrias?)\s+(decir|contar)\b/,
  /\bme\s+explicas?\b/,
  /\bde\s+que\s+se\s+trata\b/,
  // "que tal el producto", "como es el cinturon": piden que les cuenten.
  // Caian en la red de texto vacio y recibian un "¿en qué te puedo
  // ayudar?" generico, teniendo la ficha entera para contestarles.
  /\bque\s+tal\s+(el|la|ese|esa|los|las)\b/,
  /\bcomo\s+es\s+(el|la|ese|esa)\b/,
  /\bque\s+es\s+(eso|esto|el|la)\b/,
  // "TIENES CINTURONES", "¿hay disponible?", "¿todavía los tiene?".
  //
  // Es preguntar si HAY, y la respuesta es presentar el producto. No se
  // reconocia: `PALABRA_DE_PREGUNTA` conocia "tienen" pero no "tienes", asi
  // que el mensaje no era ni una pregunta y Marco recibio esto probando el
  // 08-oct:
  //
  //   Marco · "Tienes cinturones"
  //   bot   · "Perdón, no quiero repetirme. Dime concretamente qué
  //            necesitas y lo reviso con el equipo."
  //
  // A quien pregunta si hay producto no se le pide que se explique mejor.
  /\b(tienes|tiene|tienen|hay|queda|quedan|manejas|manejan|venden|vendes)\s+(\w+\s+)?(cinturon|cinturones|faja|fajas|disponible|disponibles|existencia|stock|unidades)\b/,
  /\b(hay|tienes|tienen)\s+disponib/,
];

/**
 * Un "gracias" pelado: ni pregunta ni compra.
 *
 * DEFECTO MEDIDO, y estaba anotado como conocido sin arreglar: a "gracias"
 * el bot respondia "¿cuántos quieres? y para preparar tu pedido me pasas la
 * ciudad y la dirección". Le pedia los datos a quien estaba despidiendose o
 * dando las gracias por una respuesta.
 *
 * Marco lo volvio a ver probando desde su numero el 08-oct.
 *
 * Va con `^` y con tope de palabras: "gracias, pero cuanto vale?" SI es una
 * pregunta, y "gracias, me lo llevo" SI es una compra. Lo que se quiere
 * cazar es el mensaje que SOLO agradece.
 */
const SOLO_AGRADECE = [
  /^(muchas\s+|mil\s+|muy\s+)?gracias\b/,
  /^(ok|oka|okey|listo|vale|bueno)\s*,?\s*(muchas\s+|mil\s+)?gracias\b/,
  /^(te\s+|le\s+)?agradezco\b/,
  // Acuses y cortesia a secas. "ok" y "bendiciones" recibian la peticion de
  // nombre y direccion, que es pedirle los datos a quien solo esta
  // acusando recibo.
  /^(ok|oka|okey|okay|dale|listo|entiendo|ya\s+vi|perfecto)\s*[.!]*$/,
  /^(bendiciones|feliz\s+(dia|noche|tarde)|que\s+este(s)?\s+bien|amen)\b/,
  /^(buenas\s+noches|hasta\s+luego|chao|adios|nos\s+hablamos)\b/,
];

/**
 * "AHI LE AVISO": el no cortes.
 *
 * No es un rechazo ni una compra: es alguien que se lo va a pensar. En
 * BIKERPRO es una intencion propia -"comparando"- y su regla es explicita:
 * NO insistir con el mismo mensaje ni meter urgencia inventada. Lo que
 * funciona es dejar algo concreto y sin costo de decidir.
 *
 * Aqui recibia "para preparar tu pedido me pasas tu nombre completo y la
 * direccion": justo la insistencia que espanta a quien esta dudando.
 */
const SE_LO_PIENSA = [
  /\bahi\s+(le|te)\s+aviso\b/,
  /\b(luego|despues|dsps|desp|mas\s+tarde|ahorita)\s+(le|te)\s+(aviso|escribo|digo|confirmo|hablo)\b/,
  /\blo\s+(voy\s+a\s+pensar|pienso|consulto)\b/,
  /\bdejame\s+pensarlo\b/,
  /\bcuando\s+(pueda|cobre|me\s+paguen|tenga)\b/,
  /\bmas\s+adelante\b/,
  // ----------------------------------------------------------------------
  // AMPLIADO EL 2026-10-09, TODO MEDIDO
  //
  // Tres formas muy comunes de decir "todavia no" recibian la peticion de
  // nombre, ciudad y direccion:
  //
  //   "mejor después"                   -> "¿Cuántos quieres? Y para…"
  //   "déjame preguntarle a mi esposo"  -> "¿Cuántos quieres? Y para…"
  //   "apenas vaya a pedirlo te aviso"  -> "¡Perfecto! ¿Cuántos quieres?…"
  //
  // La tercera es literal de un chat del 08-oct: una clienta se despidio
  // dando las gracias y diciendo que avisaria, y el bot le pidio los datos.
  // Insistir ahi no adelanta la venta, la quema.
  // ----------------------------------------------------------------------
  /\bmejor\s+(despues|luego|mas\s+tarde|manana|otro\s+dia)\b/,
  /\b(le\s+)?pregunt(o|arle|ar)\s+a\s+mi\s+(esposo|marido|mama|mami|pareja|novio|papa)\b/,
  /\blo\s+(hablo|consulto)\s+con\s+mi\b/,
  /\bapenas\s+(vaya|pueda|me\s+decida|tenga)\b/,
  /\bdespues\s+(lo|la|le)\s+(pido|compro|busco)\b/,
  /\bvoy\s+a\s+(mirar|ver|pensarlo|averiguar)\b/,
  /\btodavia\s+no\s+(me\s+)?(decido|he\s+decidido)\b/,
  /\bestoy\s+mirando\b/,
];

/**
 * PIDE HABLAR CON UNA PERSONA. Esto SI es un escalado, y no existia.
 *
 * Medido el 09-oct: "quiero hablar con una persona" recibia "¡Perfecto,
 * gracias! Para preparar tu pedido me pasas la ciudad y la dirección".
 * Ignorar esa peticion es lo que hace que un cliente escriba tres veces y
 * acabe yendose. `docs/VOZ-DE-BIKERPRO.md` lo tiene como comportamiento de
 * referencia desde el principio; en NOVIKA no estaba implementado.
 */
const PIDE_HUMANO = [
  /\b(hablar|habla|comunicar|comunicarme|contactar)\s+con\s+(una|un|alguna|algun)?\s*(persona|asesor|asesora|humano|agente|alguien|operador|vendedor|vendedora)\b/,
  /\b(me\s+)?(pasa|pasas|pase|comunica|comuniqueme)\s+con\s+(una|un)?\s*(persona|asesor|asesora|humano|agente|alguien)\b/,
  /\b(hay|habra)\s+(alguna\s+)?(persona|humano|asesor|alguien)\s+(real|de\s+verdad|ahi)\b/,
  /\beres\s+(un\s+)?(bot|robot|maquina|inteligencia)\b/,
  /\b(esto|eres)\s+es\s+un\s+bot\b/,
  /\bno\s+quiero\s+(hablar\s+con\s+)?(un\s+)?(bot|robot|maquina)\b/,
  /\batiende\s+(alguien|una\s+persona)\b/,
  /\bquiero\s+(un|una)\s+(asesor|asesora|persona|humano)\b/,
];

/**
 * EL CLIENTE ESTA MOLESTO. Tampoco existia.
 *
 * Medido el 09-oct: "esto es un robo, son unos estafadores, los voy a
 * denunciar" recibia "¡Perfecto, gracias! Para preparar tu pedido me pasas
 * la ciudad y la dirección". Seguir vendiendo a quien amenaza con denunciar
 * es la peor respuesta posible, y es la que daba.
 *
 * ⚠️ OJO: `estafa` a secas NO va aqui. "¿será estafa?" es DESCONFIANZA de
 * alguien que todavia no ha comprado -una objecion que se rebate y se
 * vende-, no un cliente enfadado. Lo que marca el enfado es el insulto, la
 * amenaza o la afirmacion en indicativo ("son unos estafadores").
 */
const ESTA_MOLESTO = [
  /\bson\s+unos?\s+(estafadores|ladrones|sinverguenzas|mentirosos|tramposos)\b/,
  // ⚠️ LA ACUSACION TIENE QUE SER CONTRA NOSOTROS. ESTO LO CAZO UNA
  //    CONVERSACION DE PRUEBA, Y HABRIA SIDO UN DEFECTO PEOR QUE EL ORIGINAL.
  //
  // La primera version ponia `/\b(me|nos)\s+(estafaron|robaron|tumbaron)\b/`,
  // y con eso "ya me estafaron una vez" se leia como cliente enfadado:
  //
  //   clienta · "no confío en estas páginas"
  //   bot     · "Pagas cuando el pedido llega a tus manos…"     ✅
  //   clienta · "ya me estafaron una vez"
  //   bot     · "Prefiero que esto lo vea una persona del equipo"  ⛔
  //             …y el bot se callo 12 h. Los seis mensajes siguientes
  //             -incluido "bueno, dale" y la direccion completa- no se
  //             enviaron.
  //
  // Y es LO CONTRARIO de un cliente molesto: es la objecion de confianza en
  // su forma mas clara. Quien cuenta que ya la estafaron esta explicando por
  // que duda, y el contraentrega es la respuesta perfecta. Tiene tema propio
  // (CONFIANZA) con esa frase incluida.
  //
  // Un escalado en falso es ahora el fallo mas caro que puede tener este
  // bot -se lleva la conversacion entera por delante-, asi que las tres
  // señales que escalan son estrechas a proposito: hace falta un sujeto en
  // segunda persona, una amenaza o un insulto.
  /\b(ustedes|uds|usted|vos)\s+me\s+(estafaron|estafaste|robaron|robaste|tumbaron|enga[nñ]aron|enga[nñ]aste)\b/,
  /\bme\s+(estafaron|robaron|tumbaron|enga[nñ]aron)\s+(ustedes|uds)\b/,
  // `robo` NO va aqui: "está muy caro, es un robo" es una objecion de
  // precio, no una acusacion. Los otros tres no tienen ese doble uso.
  /\bes\s+un\s+(fraude|enga[nñ]o|descaro)\b/,
  /\b(los|te|le)\s+voy\s+a\s+(denunciar|demandar|reportar)\b/,
  /\b(denuncia|demanda)\s+(a|ante)\s+(la\s+)?(sic|superintendencia|fiscalia)\b/,
  /\bpesimo\s+servicio\b/,
  /\bque\s+falta\s+de\s+(respeto|seriedad)\b/,
  /\bestoy\s+(muy\s+)?(molesta|molesto|furiosa|furioso|indignada|indignado|cansada\s+de|harta|harto)\b/,
  /\b(malparid|hijueput|gonorrea|estupid|idiot|imbecil)\w*/,
];

/**
 * RECLAMA LA GARANTIA DE ALGO QUE YA RECIBIO. Esto SI va a una persona.
 *
 * Medido el 09-oct, y es el peor de los tres: a "me llegó dañado, quiero la
 * garantía" el bot contestaba *«¡Claro que sí! Tiene 1 mes de garantía por
 * defecto de fábrica, así que compras con tranquilidad. ¡Perfecto! Para
 * preparar tu pedido me pasas la ciudad y la dirección»*. Le vendia la
 * garantia como argumento de venta a quien la estaba RECLAMANDO, y encima
 * le pedia los datos otra vez.
 *
 * Un reclamo lo gestiona una persona siempre: hay que ver fotos, decidir si
 * es defecto de fabrica y coordinar el cambio. El bot no puede hacer nada
 * de eso.
 */
const RECLAMA_GARANTIA = [
  /\b(me|nos)\s+lleg(o|aron)\s+(da[nñ]ad|mal|roto|rota|incompleto|defectuos|quemad)/,
  /\blleg(o|aron)\s+(da[nñ]ad|roto|rota|defectuos|quemad|mal\s+empacad)/,
  // ⚠️ EL LOOKBEHIND SEPARA UN RECLAMO DE UNA OBJECION, Y SON OPUESTOS.
  //
  //   "no me funciona"       -> ya lo tiene y esta roto. Va a una persona.
  //   "¿y si no me funciona?" -> todavia no ha comprado y tiene miedo. Se
  //                              contesta con contraentrega y se VENDE.
  //
  // Sin el lookbehind, el condicional se trataba como reclamo y a una
  // clienta que dudaba antes de comprar se le abria un caso de garantia.
  /(?<!\bsi\s)(?<!\bsi\s\s)\bno\s+(me\s+)?(funciona|enciende|prende|calienta)\b/,
  /\bse\s+(da[nñ]o|quemo|rompio|descompuso|apago)\b/,
  /\bquiero\s+(la\s+)?garantia\b/,
  /\b(hacer|reclamar|aplicar)\s+(efectiva\s+)?(la\s+)?garantia\b/,
  /\bquiero\s+(que\s+me\s+)?(devolver|devuelvan|cambien|un\s+cambio|el\s+cambio)\b/,
  /\bvino\s+(da[nñ]ad|roto|mal)/,
  /\bllego\s+pero\s+(no|esta)\b/,
];

/** Saludos puros: no preguntan nada. */
const SALUDOS = [
  /^(hola|buenas|buenos\s+dias|buenas\s+tardes|buenas\s+noches|hey|que\s+tal|saludos|buen\s+dia)\b/,
  // Abreviados y el "¿hay alguien?". Un "tas ahi?" sin respuesta es la
  // forma mas rapida de perder a alguien que ya estaba escribiendo.
  /^(q\s*tal|qtal|ola|alo|aloo)\b/,
  /^(tas|stas|estas|esta|hay)\s+(ahi|alguien|por\s+ahi)\b/,
  /^(buen[ao]s?)\s*[?!.]*$/,
];

/**
 * ¿Qué pregunta este mensaje?
 *
 * @returns {{temas: string[], pregunta: boolean, compra: boolean,
 *            saludo: boolean, soloSaludo: boolean}}
 */
function leer(texto) {
  const plano = aplanar(texto);
  const crudo = String(texto ?? "");

  const temas = [];
  for (const [tema, re] of PATRONES) {
    if (re.test(plano) && !temas.includes(tema)) temas.push(tema);
  }

  // ----------------------------------------------------------------------
  // "¿QUE PRECIO TIENE EL ENVIO?" PREGUNTA POR EL ENVIO, NO POR EL PRODUCTO
  //
  // La palabra "precio" marcaba el tema PRECIO y el bot contestaba las dos
  // cosas: "el cinturón te queda en $49.900. El envío va incluido". Le
  // soltaba una cifra que no habia pedido antes de contestar lo suyo.
  //
  // "con envio" es lo CONTRARIO -"¿cuánto vale con envío?" pregunta el
  // total- y por eso se distingue por la preposicion: "del/el envio" es el
  // envio en si, "con envio" es el producto ya sumado.
  // ----------------------------------------------------------------------
  const PRECIO_DEL_ENVIO = /\b(precio|valor|cuanto|vale|cuesta|sale)\b[^?]*\b(de|del)?\s*(el\s+)?envio\b/;
  const PRECIO_CON_ENVIO = /\bcon\s+(el\s+)?envio\b/;
  if (temas.includes(TEMAS.PRECIO) && PRECIO_DEL_ENVIO.test(plano) && !PRECIO_CON_ENVIO.test(plano)) {
    const i = temas.indexOf(TEMAS.PRECIO);
    temas.splice(i, 1);
    if (!temas.includes(TEMAS.ENVIO)) temas.unshift(TEMAS.ENVIO);
  }

  // ----------------------------------------------------------------------
  // A QUIEN SE QUEJA DEL PRECIO NO SE LE REPITE EL PRECIO
  //
  // "me lo dejas mas barato" marca las dos cosas: la objecion y -por la
  // palabra "precio" o el verbo- el tema PRECIO. Y PRECIO es un tema
  // comercial, asi que el cerebro encabezaba el mensaje volviendo a
  // cantarle la cifra a quien acababa de decir que le parecia alta. Eso no
  // es contestar: es insistir.
  //
  // EXCEPCION: si pregunta por una CANTIDAD concreta ("esta caro, y dos
  // cuanto me salen?") ahi si quiere una cifra, y se le da. Por eso la
  // cantidad se calcula ANTES de quitar el tema.
  // ----------------------------------------------------------------------
  const cantidadEnLaPregunta = temas.includes(TEMAS.PRECIO) ? cantidadPreguntadaEn(plano) : null;
  if (temas.includes(TEMAS.OBJECION_PRECIO) && temas.includes(TEMAS.PRECIO) && !cantidadEnLaPregunta) {
    temas.splice(temas.indexOf(TEMAS.PRECIO), 1);
  }

  // ----------------------------------------------------------------------
  // CUANDO DOS TEMAS HABLAN DE LO MISMO, MANDA EL ESPECIFICO
  //
  // ⚠️ ESTOS COLAPSOS VIVEN AQUI Y SOLO AQUI, A PROPOSITO.
  //
  // Ya habia colapsos (MEDIDAS>TALLA, GARANTIA_TRAMITE>GARANTIA,
  // OBJECION_PRECIO>{ENVIO,PAGO}) escritos DOS VECES: en `contestar.aTemas`
  // y en `voz.temasQueSeContestan`. Esa duplicacion ya causo un defecto
  // real -el mensaje abria por un tema y contestaba otro: «Sí, La correa es
  // graduable»- y el propio repositorio lo tiene documentado como la
  // leccion de las dos listas de "pregunta de precio" que se separaron.
  //
  // Los nuevos no se duplican: se aplican sobre `temas` antes de devolverlo,
  // asi que quien lee `temas` -el redactor, la voz, el prompt- ve ya la
  // lista colapsada. Una sola fuente.
  // ----------------------------------------------------------------------
  const quitar = (sobra) => {
    const i = temas.indexOf(sobra);
    if (i >= 0) temas.splice(i, 1);
  };

  // "¿cuánto demora en calentar?" casa con `/\bdemora\w*/` de ENTREGA. Si
  // se dejan los dos, al calor se le contesta con el plazo de la
  // transportadora.
  if (temas.includes(TEMAS.TEMPERATURA)) quitar(TEMAS.ENTREGA);
  // "¿en qué ciudad están?" es UBICACION, no una objecion de confianza.
  if (temas.includes(TEMAS.UBICACION)) quitar(TEMAS.CONFIANZA);
  // "¿hay descuento por mayor?" es un lead mayorista, no la escalera.
  if (temas.includes(TEMAS.MAYORISTA)) {
    quitar(TEMAS.OBJECION_PRECIO);
    quitar(TEMAS.PRECIO);
  }
  // "¿sirve si estoy embarazada?" y "¿me lo dejo dormida?" casan con
  // `sirve para` / USO, y la frase de los colicos no contesta ninguna.
  if (temas.includes(TEMAS.CONTRAINDICACION)) quitar(TEMAS.USO);
  if (temas.includes(TEMAS.SEGURIDAD)) quitar(TEMAS.USO);
  if (temas.includes(TEMAS.DESTINATARIO)) quitar(TEMAS.USO);
  // "¿y si no me funciona?" ya se contesta con contraentrega + garantia.
  if (temas.includes(TEMAS.SI_NO_FUNCIONA)) quitar(TEMAS.GARANTIA);
  // "¿llega a mi vereda?" casa con `llega a` de ENVIO; la respuesta es la
  // cobertura, y ya dice que el envio va incluido.
  if (temas.includes(TEMAS.COBERTURA)) quitar(TEMAS.ENVIO);
  // "¿viene en caja?" casa con `/\bviene\s+en\s+\w+/` de COLOR, y el
  // mensaje salia contestando el empaque Y el color rosado. Quien pregunta
  // por la caja no pregunto por el color.
  if (temas.includes(TEMAS.EMPAQUE)) quitar(TEMAS.COLOR);
  // "¿tienen tienda física?" ya se contesta con la ubicacion.
  if (temas.includes(TEMAS.UBICACION)) quitar(TEMAS.MARCA);

  // ----------------------------------------------------------------------
  // UN RECLAMO NO ES UNA PREGUNTA POR LA GARANTIA
  //
  // "me llegó dañado, quiero la garantía" marcaba el tema GARANTIA, y el
  // tema GARANTIA responde con el argumento de VENTA: «tiene 1 mes de
  // garantía, así que compras con tranquilidad». Se le vendia la garantia a
  // quien la estaba reclamando. Se quita el tema: esto lo atiende una
  // persona, y el texto lo pone la rama de escalado.
  // ----------------------------------------------------------------------
  const reclamaGarantia = RECLAMA_GARANTIA.some((re) => re.test(plano));
  if (reclamaGarantia) {
    quitar(TEMAS.GARANTIA);
    quitar(TEMAS.GARANTIA_TRAMITE);
    quitar(TEMAS.SI_NO_FUNCIONA);
  }

  const saludo = SALUDOS.some((re) => re.test(plano));
  const interrogacion = /\?/.test(crudo);
  // PEDIR INFORMACION GANA A LAS SEÑALES DE COMPRA.
  //
  // "quiero informacion" contiene "quiero", y "me interesa" es una señal
  // debil. Quien pide que le cuenten NO esta comprando todavia, y tratarlo
  // como comprador es lo que hizo que el primer mensaje de un cliente de
  // publicidad recibiera una peticion de nombre y direccion.
  //
  // Las señales FUERTES y explicitas siguen ganando: "quiero información y
  // me llevo dos" es las dos cosas, y ahi manda la compra.
  const pideInfo = PIDE_INFORMACION.some((re) => re.test(plano));
  const COMPRA_INEQUIVOCA = [
    /\b(lo|la|los|las)\s+(quiero|llevo|compro)\b/,
    /\bme\s+(lo|la|los|las)\s+(llevo|quedo)\b/,
    /\bme\s+llevo\s+(\d{1,2}|uno|una|dos|tres|el|la)\b/,
    /\bquiero\s+(\d{1,2}|uno|una|dos|tres)\b/,
    /\b(dale|de\s+una|hagale)\b/,
  ];

  // OBJETAR EL PRECIO NO ES COMPRAR, y una señal DEBIL no lo convierte.
  //
  // Defecto real medido antes de este cambio: "esta muy caro, pero bueno"
  // salia con `compra: true`. La culpa era de la señal debil `bueno` -que
  // ahi no significa "de acuerdo", es una muletilla de resignacion- y el
  // efecto era el peor posible: el bot le pedia nombre, ciudad y direccion
  // a quien acababa de decir que el precio le parecia alto.
  //
  // Las señales FUERTES siguen valiendo: "esta caro pero me lo llevo" es
  // una compra, y una objecion no puede bloquear un "me lo llevo".
  const objetaElPrecio = temas.includes(TEMAS.OBJECION_PRECIO);

  // ----------------------------------------------------------------------
  // "SE LO PIENSA" BLOQUEA LAS SEÑALES DEBILES, COMO YA HACIA LA OBJECION
  //
  // Mensaje literal de un chat del 08-oct:
  //
  //   "Vale mil gracias, apenas vaya a pedirlo de fijo te aviso, okey, esta
  //    hermoso, muy amable, listo, gracias por la info, bendiciones🥰"
  //
  // Es una despedida de manual: se lo va a pensar y avisara. Y recibio
  // *«¡Perfecto! ¿Cuántos quieres? Y para preparar tu pedido me pasas tu
  // nombre completo, la ciudad y la dirección»*.
  //
  // La culpa era de las señales DEBILES: ese mensaje contiene "vale" y
  // "listo" -dos de ellas- y como no lleva interrogacion ni objecion,
  // contaba como compra. Pero "vale" y "listo" ahi son cortesia, igual que
  // el "bueno" de resignacion que ya bloquea la objecion de precio.
  //
  // Las señales FUERTES siguen ganando: "lo pienso... bueno, me lo llevo"
  // es una compra, y pensarselo no puede bloquear un "me lo llevo".
  // ----------------------------------------------------------------------
  const seLoEstaPensando = SE_LO_PIENSA.some((re) => re.test(plano));

  const compraDeclarada = pideInfo
    ? COMPRA_INEQUIVOCA.some((re) => re.test(plano))
    : SENALES_DE_COMPRA.some((re) => re.test(plano)) ||
      // Las debiles solo valen si el cliente NO esta preguntando, NO esta
      // objetando y NO se lo esta pensando.
      (!interrogacion && !objetaElPrecio && !seLoEstaPensando && SENALES_DEBILES.some((re) => re.test(plano)));

  // ----------------------------------------------------------------------
  // UN RECLAMO NUNCA ES UNA COMPRA, AUNQUE CONTENGA "QUIERO"
  //
  // Medido el 09-oct: "me llegó dañado, quiero la garantía" salia con
  // `compra: true`, porque `/\bquiero\s+(...|el|la)\b/` casa con "quiero
  // la". Efecto compuesto y terrible: el bot le vendia la garantia como
  // argumento comercial Y ademas le pedia nombre, ciudad y direccion a
  // quien ya habia recibido el pedido.
  //
  // Un cliente molesto tampoco esta comprando: "son unos estafadores, los
  // voy a denunciar" no se contesta pidiendo la direccion.
  // ----------------------------------------------------------------------
  const compra = compraDeclarada && !reclamaGarantia && !ESTA_MOLESTO.some((re) => re.test(plano));

  // Un signo de interrogacion es una señal fuerte, pero no la unica: mucha
  // gente pregunta sin escribirlo ("cuanto vale").
  const interroga = interrogacion || temas.length > 0;

  // ----------------------------------------------------------------------
  // "ESTO ES UNA PREGUNTA" Y "SE DE QUE ME PREGUNTA" SON DOS COSAS
  //
  // `pregunta` exige un tema reconocido, asi que una duda que el catalogo
  // no cubre quedaba clasificada como "no pregunto nada". Y eso llevaba a
  // la peor respuesta que daba el bot:
  //
  //   clienta: "oye y esto me lo puedo poner dormida toda la noche?"
  //   bot:     "¿Cuántos quieres? Y para despachártelo me pasas tu nombre
  //             completo, la ciudad y la dirección."
  //
  // Le pide la direccion a quien pregunta por la seguridad del producto.
  // Es justo lo que este modulo existe para evitar, colandose por el hueco
  // de los temas NO catalogados.
  //
  // Saber que es una pregunta -aunque no se sepa de que- ya basta para no
  // contestar con un formulario.
  // ----------------------------------------------------------------------
  const PALABRA_DE_PREGUNTA =
    /\b(que|qué|cual|cuales|como|cuando|donde|cuanto|cuanta|cuantos|cuantas|quien|por\s+que|se\s+puede|puedo|podria|hay|tienes|tiene|tienen|manejas|manejan|venden|vendes|queda|quedan|sirve|funciona|es\s+seguro)\b/;

  return {
    temas,
    pregunta: interroga && temas.length > 0,
    compra,
    saludo,
    // Por cuantas pregunta. Solo interesa si pregunta el precio: en
    // cualquier otro sitio la cantidad la decide la ficha, no el detector.
    // Ya calculada arriba: se necesitaba ANTES de decidir si el tema PRECIO
    // sobra por venir junto a una objecion.
    cantidadPreguntada: cantidadEnLaPregunta,
    // ¿Habla de UNO MAS? Es lo que distingue una venta adicional de una
    // simple consulta de precio cuando ya hay un pedido confirmado.
    quiereOtro: QUIERE_OTRO.some((re) => re.test(plano)),
    // Parece una pregunta, aunque no se sepa de que. Basta para no
    // responder con un formulario.
    pareceUnaPregunta: interrogacion || PALABRA_DE_PREGUNTA.test(plano),
    // ¿Pregunta por SU pedido? Es lo unico que autoriza a mencionar su
    // numero de pedido y su estado.
    porSuPedido: PREGUNTA_POR_SU_PEDIDO.some((re) => re.test(plano)),
    // ¿Pide que le cuenten? Se presenta el producto y NO se pide un dato.
    pideInformacion: PIDE_INFORMACION.some((re) => re.test(plano)),
    // Un "hola" pelado: ni pregunta ni compra. Merece un arranque, no un
    // interrogatorio.
    soloSaludo: saludo && temas.length === 0 && !compra && plano.split(/\s+/).length <= 4,
    // Un "gracias" pelado. A quien agradece no se le pide la direccion.
    soloAgradece:
      SOLO_AGRADECE.some((re) => re.test(plano)) &&
      temas.length === 0 &&
      !compra &&
      !interrogacion &&
      plano.split(/\s+/).length <= 4,
    // "Ahi le aviso": se lo esta pensando. No se insiste.
    seLoPiensa: seLoEstaPensando && !compra,

    // ------------------------------------------------------------------
    // LAS TRES SEÑALES QUE SI TIENEN QUE LLEVAR A UNA PERSONA
    //
    // Hasta el 09-oct el bot escalaba por cosas que podia resolver -una
    // duda sobre el material- y NO escalaba por las tres cosas que no
    // puede resolver nadie mas que una persona. Estaba exactamente al
    // reves de lo que pedia Marco.
    // ------------------------------------------------------------------
    /** Pide hablar con alguien de verdad. Se le pasa, sin discutir. */
    pideHumano: PIDE_HUMANO.some((re) => re.test(plano)),
    /** Esta enfadado o amenaza. No se le sigue vendiendo. */
    estaMolesto: ESTA_MOLESTO.some((re) => re.test(plano)),
    /** Reclama la garantia de algo que ya tiene. Hay que ver fotos y decidir. */
    reclamaGarantia,
  };
}

/**
 * ¿Es un turno puramente informativo?
 *
 * Preguntar no es comprar. Si es informativo, el cerebro responde la duda y
 * NO pide los datos de entrega: pedirlos ahi es lo que hace que el cliente
 * que estaba averiguando se sienta perseguido.
 */
function esInformativo(texto) {
  const r = leer(texto);
  return r.pregunta && !r.compra;
}

module.exports = {
  TEMAS,
  leer,
  esInformativo,
  cantidadPreguntadaEn,
  pideReenvioDeFotos,
  fotosRecientes,
  MINUTOS_DE_CONTEXTO_DE_FOTOS,
  SENALES_DE_COMPRA,
  SENALES_DEBILES,
  PATRONES,
  // Expuestos para las pruebas de regresion del 09-oct: cada lista nacio de
  // un mensaje real que el bot contesto mal.
  PIDE_HUMANO,
  ESTA_MOLESTO,
  RECLAMA_GARANTIA,
  SE_LO_PIENSA,
};
