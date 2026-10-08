"use strict";

// ==========================================================================
// EL LECTOR DE PDF, EN SU PROPIO PROCESO
//
// Existe por una sola razon: `pdfjs` no devuelve la memoria que usa (~71 MB
// por lote, medido). Cuando un PROCESO termina, el sistema lo recupera todo.
// Asi que este archivo lee el PDF, escribe el texto, y SE MUERE con la
// memoria dentro. El motivo completo esta en `pdf.js`.
//
// Se invoca con dos argumentos:
//     node leer-pdf-worker.js <entrada.pdf> <salida.json>
//
// El resultado va al ARCHIVO de salida, nunca a stdout: cualquier
// `console.log` de un modulo que se cargue aqui -hoy o dentro de tres
// meses- se mezclaria con el JSON y lo volveria ilegible.
// ==========================================================================

const fs = require("node:fs");

async function main() {
  const [entrada, salida] = process.argv.slice(2);
  if (!entrada || !salida) {
    process.stderr.write("uso: leer-pdf-worker.js <entrada.pdf> <salida.json>\n");
    process.exit(2);
  }

  const datos = fs.readFileSync(entrada);
  const paginas = await require("./pdf").enEsteProceso(datos);
  fs.writeFileSync(salida, JSON.stringify(paginas));
}

main()
  .then(() => {
    // SE SALE EXPLICITAMENTE. pdfjs deja temporizadores vivos, y sin esto el
    // proceso hijo se queda colgado hasta que el padre lo mate por tiempo:
    // justo la espera que este diseno venia a evitar.
    process.exit(0);
  })
  .catch((e) => {
    // El mensaje va por stderr, que el padre si lee, para que pueda
    // traducirlo a algo sobre lo que el operador actue.
    process.stderr.write(String((e && e.stack) || e) + "\n");
    process.exit(1);
  });
