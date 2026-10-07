"use strict";

// ==========================================================================
// AISLAMIENTO NOVIKA <-> BIKERPRO
//
// NOVIKA y BIKERPRO comparten aprendizajes tecnicos. No comparten nada
// operativo: ni numero, ni token, ni webhook, ni disco, ni catalogo.
//
// El riesgo real no es teorico. Son dos proyectos del mismo dueno, en la
// misma cuenta de Meta y en el mismo hosting. Basta pegar una variable en
// el servicio equivocado para que NOVIKA empiece a contestarles a los
// clientes de BIKERPRO con precios de NOVIKA. Eso no se arregla con un
// recordatorio en la documentacion: se arregla con un candado.
//
// Hay dos candados, en dos momentos distintos:
//
//   1. ARRANQUE  -> revisarConfiguracion(). Si alguna variable de entorno
//      tiene un valor que pertenece a BIKERPRO, el proceso no arranca.
//      Fallar al arrancar es ruidoso y barato; fallar en produccion
//      contesta mal a un cliente real.
//
//   2. POR EVENTO -> eventoEsDeNovika(). Si el webhook recibe un evento
//      cuyo metadata.phone_number_id no es el de NOVIKA, se descarta.
//      Esto cubre el caso en que las dos apps de Meta acaben apuntando a
//      la misma URL.
//
// Sobre los hashes: los identificadores publicos de BIKERPRO viven en un
// repositorio publico, pero copiarlos aqui seria republicarlos. Se guardan
// como SHA-256, que sirve igual para comparar y no revela nada.
// ==========================================================================

const crypto = require("node:crypto");

function sha256(texto) {
  return crypto.createHash("sha256").update(String(texto)).digest("hex");
}

// Valores que pertenecen a BIKERPRO. Si aparecen en la configuracion de
// NOVIKA es que alguien pego la variable en el servicio equivocado.
const HUELLAS_PROHIBIDAS = new Map([
  ["e64dad538b8483ebbedd3f8b8dc0f0c3d5810520217f9c364124ebe9b1c818fd", "token de verificacion de BIKERPRO"],
  ["4a838d65ed69111b46a86de2e1c8b0cd199f554c2859f55e103bd1ce8b830962", "numero del dueno de BIKERPRO"],
  ["8007d2b241dca016966bcaefbb15ef156b8a9aa6bbe692a5a105a50daf7ec949", "numero del bot de BIKERPRO"],
  ["7514a773d82f2428a6a9111fc6b06b45b8dd8a25947ab5c7377f51e4f0706fd7", "host del despliegue de BIKERPRO"],
]);

// Palabras que no tienen ninguna razon para aparecer en la configuracion de
// NOVIKA. Cubre casos que los hashes no anticipan (un DATA_DIR compartido,
// una URL nueva de BIKERPRO, un nombre de servicio reutilizado).
const PALABRAS_PROHIBIDAS = ["bikerpro", "biker-pro", "impermeables", "impermeable"];

/**
 * Revisa un mapa de { nombreDeVariable: valor } buscando rastros de BIKERPRO.
 * Devuelve la lista de problemas encontrados (vacia si todo esta limpio).
 */
function revisarConfiguracion(variables) {
  const problemas = [];

  for (const [nombre, valor] of Object.entries(variables || {})) {
    if (valor === null || valor === undefined || valor === "") continue;
    const texto = String(valor);

    const motivo = HUELLAS_PROHIBIDAS.get(sha256(texto));
    if (motivo) {
      problemas.push(
        `${nombre} tiene el ${motivo}. NOVIKA necesita su propio valor, no el de BIKERPRO.`
      );
      continue;
    }

    const enMinusculas = texto.toLowerCase();
    const palabra = PALABRAS_PROHIBIDAS.find((p) => enMinusculas.includes(p));
    if (palabra) {
      problemas.push(
        `${nombre} contiene "${palabra}", que es de BIKERPRO. Revisa si pegaste la variable en el servicio equivocado.`
      );
    }
  }

  return problemas;
}

/**
 * Candado por evento. Un evento solo se procesa si viene del numero de
 * NOVIKA.
 *
 * Si WHATSAPP_PHONE_NUMBER_ID no esta configurado todavia (fase de montaje),
 * no se puede comparar nada: se deja pasar y se avisa, porque bloquear aqui
 * impediria recibir el primer mensaje de prueba. En cuanto la variable este
 * puesta, el filtro es estricto.
 *
 * @returns {{ok: boolean, motivo: string}}
 */
function eventoEsDeNovika(evento, idNumeroDeNovika) {
  if (!idNumeroDeNovika) {
    return { ok: true, motivo: "sin_id_configurado" };
  }
  const idDelEvento = evento && evento.idNumero;
  if (!idDelEvento) {
    return { ok: true, motivo: "evento_sin_id" };
  }
  if (String(idDelEvento) !== String(idNumeroDeNovika)) {
    return { ok: false, motivo: "numero_ajeno" };
  }
  return { ok: true, motivo: "coincide" };
}

module.exports = {
  revisarConfiguracion,
  eventoEsDeNovika,
  // expuestos para las pruebas
  sha256,
  PALABRAS_PROHIBIDAS,
};
