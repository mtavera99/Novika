# Catálogo de NOVIKA

Un archivo JSON por producto en `productos/`. Esta carpeta es la **única fuente de verdad** de todo lo que el bot puede afirmar, cotizar y despachar.

## Por qué los productos son datos y no código

NOVIKA vende hogar, tecnología, bienestar, herramientas, accesorios y categorías que todavía no existen. Si cada producto nuevo obliga a tocar código, cada producto nuevo es un despliegue y un riesgo.

Añadir un producto a NOVIKA debe ser: copiar `productos/_plantilla.json`, rellenarlo, poner `activo: true`. Nada más.

## Reglas

**1. Los archivos que empiezan por `_` no entran al catálogo.** Por eso la plantilla puede vivir aquí al lado.

**2. No hay producto por defecto.** Si el bot no puede identificar de qué producto habla el cliente, pregunta. En un catálogo multicategoría, adivinar el producto es despachar el equivocado.

**3. Un producto no puede estar `activo: true` si le falta un dato crítico.** La validación lo rechaza. Concretamente, un producto activo necesita:

- `descripcionAutorizada`
- `motorDePrecio`
- `precios`, con al menos el precio de 1 unidad
- `logistica.politicaEnvio.tipo`
- `pendientes` vacío

Un producto activo sin precio no es un borrador incompleto: es un cobro incorrecto esperando a pasar.

**4. Lo que el bot puede afirmar está escrito, palabra por palabra.**

- `datosConfirmados` → lo que el bot **sí** puede decir, con la respuesta ya redactada y aprobada.
- `sinDatoConfirmado` → términos que obligan a responder "te lo confirmo".

Si una frase del cliente toca las dos listas, **gana la duda**. Ejemplo: si "resistente al agua" está confirmado y "sumergible" no, la pregunta "¿lo puedo sumergir?" no se responde, se escala.

**5. Una cantidad que no está en la tabla de precios no se interpola.** Se escala a una persona. Interpolar es inventar una política de mayoreo que nadie aprobó.

**6. `noHeredar` es un candado entre productos.** Lista las políticas de envío de otros productos que este nunca debe usar. Existe porque un artículo voluminoso de hogar y un accesorio pequeño no comparten tarifa, y heredarla en silencio es cobrar mal. La validación del catálogo comprueba que no se viole.

**7. Un alias ambiguo entre dos productos no es alias de ninguno.** Si "combo" puede referirse a dos productos, no identifica producto: identifica cantidad, y eso lo resuelve otra capa.

**8. Los alias usan raíces, no palabras completas.** `\borganiza[dc]` cubre *organizador*, *organizadores* y la errata *organizacor*. La clase de caracteres va cerrada (`[dc]`, no `.`) para no capturar palabras ajenas.

## Validar

```bash
npm test                   # incluye la batería del catálogo
npm run comprobar-config   # imprime cuántos productos hay y qué problemas tienen
```

## Pendiente

- **Los productos reales de NOVIKA todavía no están definidos.** La carpeta solo tiene la plantilla, a propósito. Precios, promociones, garantías, tiempos de entrega, cobertura y costos de envío se definen con el dueño antes de escribirlos aquí.
- El feed de producto para Meta Commerce Manager se **generará** desde esta carpeta cuando haga falta. No se mantendrá a mano: dos catálogos que pueden contradecirse son una fuente de cobros incorrectos.
