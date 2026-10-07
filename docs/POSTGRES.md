# PostgreSQL en NOVIKA

Estado: **preparado y verificado, sin activar.** `DATABASE_URL` no está configurada en producción y el servicio sigue usando archivos sobre el Render Disk.

---

## Lo que encontré al auditar el esquema anterior

El `001-esquema-inicial.sql` de la Fase 1 nunca se aplicó en ningún entorno (`DATABASE_URL` jamás se configuró), así que se reescribió. Seis problemas, y el primero habría roto las ventas en silencio:

**1. Faltaban tres campos de la conversación.** El esquema tenía `estado`, `producto_id`, `oferta_id` y `ficha`, pero no `cotizacion`, `resumen_mostrado` ni `ventana`.

Son exactamente los tres que deciden si un "sí" crea un pedido: sin `resumen_mostrado` la confirmación **nunca** cuenta, y sin `cotizacion` no hay oferta vigente que confirmar. Migrar con ese esquema habría dejado el bot incapaz de cerrar una venta, sin un solo error en los logs.

**2. Importes en centavos.** El dominio calcula en pesos enteros. Obligar al adaptador a multiplicar por 100 en cada lectura y escritura es invitar a un error de ×100 en un total. Ahora las columnas son `_pesos`.

**3. Claves subrogadas.** `contactos.id BIGSERIAL` + `id_externo`, cuando el dominio identifica al contacto por su id de WhatsApp y guarda `conversacionId` como **ese mismo texto**. Mantener ids subrogados obligaba a traducir en los dos sentidos, y una traducción mal hecha mezcla las conversaciones de dos clientes.

**4. `UNIQUE(pedido_id, version)` en el historial.** Cancelar es idempotente y no sube la versión, así que reescribir un pedido cancelado chocaba contra esa restricción. La clave ahora incluye la acción.

**5. `eventos_procesados` no servía para la recuperación durable.** Tenía `wamid` y fecha, pero no el estado (`reclamado`/`terminado`/`agotado`) ni el evento, que es lo que permite reprocesar tras un crash. Eliminada.

**6. `respuestas_preparadas` era una tabla muerta.** El modo sombra escribe en el diario. Dos sitios para lo mismo es cómo se acaba con dos fuentes de verdad.

Y dos hallazgos más, que salieron de las propias pruebas de contrato:

**7. Postgres perdía campos que el adaptador de archivos conserva.** El de archivos no tiene esquema: guarda el objeto tal cual. Postgres solo guarda lo que tiene columna, y eso rompe la promesa del contrato —*"un registro guardado se recupera igual"*— de la forma más silenciosa posible. Lo destapó la prueba `un contacto guardado se recupera igual`. Se añadió una columna `extra JSONB` a las tres tablas.

**8. El total podía quedar descuadrado** si el snapshot no traía el desglose. Ahora el subtotal se despeja por álgebra y el motor comprueba `total = subtotal + envio - descuento`.

---

## Arquitectura

```
cerebro  →  src/almacen/repos/index.js   (fábrica)
                    ├─ archivos/   disco persistente     ← hoy
                    └─ postgres/   PostgreSQL            ← preparado
```

Ambos pasan **las mismas pruebas de contrato** (`src/almacen/repos/contrato.js`). Eso es lo que hace posible el cutover: el resto del sistema no distingue uno de otro.

### Lo que la base aporta

| | Archivos | PostgreSQL |
|---|---|---|
| No duplicar pedidos | índice en disco + cola en memoria | **dos índices `UNIQUE` del motor** |
| Concurrencia por contacto | `enSerie()` en memoria del proceso | **`pg_advisory_xact_lock`** |
| Atomicidad | `tmp+rename` por archivo | **transacciones** |
| Total coherente | confianza en el código | **`CHECK total_cuadra`** |
| Varias instancias | imposible | posible |

Los dos candados que importan:

```sql
CREATE UNIQUE INDEX pedidos_clave_evento_uniq ON pedidos (clave_de_evento);

CREATE UNIQUE INDEX pedidos_clave_oferta_vivo_uniq ON pedidos (clave_de_oferta)
  WHERE estado <> 'cancelado';
```

El primero frena la retransmisión de Meta. El segundo, el "sí" repetido. El segundo es **parcial** porque un cliente que se arrepiente de cancelar tiene que poder volver a comprar.

**`ON CONFLICT DO NOTHING` sin objetivo** cubre las dos a la vez; si no insertó nada, el adaptador busca cuál fue y devuelve el pedido que ya estaba. El advisory lock no es lo que evita el duplicado —el índice lo evita igual—, es lo que hace que el perdedor reciba una respuesta limpia en vez de un error de restricción.

### Lo que NO se mueve a Postgres

**La bitácora de trabajo del webhook (`src/almacen/trabajo.js`) se queda en el disco.** A propósito, y es la decisión de diseño más importante de esta fase:

- El reclamo es **síncrono** y ocurre **antes** del 200 a Meta. Una escritura a Postgres es asíncrona y cambiaría la forma de ese camino, que es el que menos conviene tocar.
- Es lo único que tiene que funcionar **cuando la base no responda**. Si el reclamo dependiera de Postgres, una caída de la base obligaría a devolver 503 a Meta — y con suficientes 503, Meta desactiva la suscripción. Se perderían *todos* los mensajes, no uno.

Es decir: **migrar los pedidos a Postgres no reabre la ventana `200 → crash → mensaje perdido`**, porque esa ventana la cierra el disco. Verificado matando el proceso con `SIGKILL` teniendo Postgres como almacén (`test/f3-recuperacion-postgres.test.js`).

Moverla tendrá sentido el día que se quiera quitar el disco — y con el disco se va la instancia única. Ese día será una migración propia, con sus pruebas.

---

## Migraciones

Archivos en `/migraciones`, aplicados por `npm run migrar`. Tres reglas:

**No se ejecutan al arrancar.** Un servicio que toca el esquema al arrancar hace cambios de estructura en un momento que nadie está mirando, y si el despliegue reinicia tres veces lo intenta tres veces. Migrar es una decisión.

Si el esquema no está aplicado, **el arranque falla y lo dice**:

```
La base de datos no tiene el esquema de NOVIKA. Faltan las tablas: pedidos.
Aplica las migraciones con `npm run migrar` y vuelve a desplegar.
El servicio NO crea tablas por su cuenta a propósito.
```

**Checksum por archivo.** Si un `.sql` ya aplicado cambia de contenido, el ejecutor para. Sin esto, editar una migración aplicada deja la base en un estado que no corresponde a ningún archivo del repositorio.

**Cerrojo de aviso.** Dos procesos migrando a la vez no pueden intentar crear la misma tabla. El cerrojo es de Postgres, así que funciona aunque los procesos estén en máquinas distintas.

Cada migración corre **dentro de una transacción** junto con su registro: o se aplica y queda anotada, o no pasa ninguna de las dos cosas.

```bash
npm run migrar-estado   # qué falta, sin tocar nada
npm run migrar          # aplicar
```

---

## Cutover archivos → PostgreSQL

`npm run cutover`. Cuatro propiedades:

| | |
|---|---|
| **Idempotente** | Correrlo dos veces deja el mismo resultado. La primera vez puede cortarse a mitad |
| **No pierde** | Compara conteos **y huellas** de origen, y **falla** si no cuadran |
| **No duplica** | Las claves de idempotencia son `UNIQUE` en destino: aunque el script se equivocara, el motor lo impide |
| **No toca el origen** | Solo lee |

### La ventana de escrituras

Un cutover no puede declararse exitoso si el origen cambia mientras copia. La primera versión no lo cubría, y se midió:

```
pedidos en el origen al terminar : 3
pedidos copiados al destino      : 2
problemas que reporta el cutover : []
```

Cutover "exitoso" con un pedido fuera. La peor forma de fallar, porque nadie va a volver a mirar.

**La solución tiene dos mitades, y hacen falta las dos:**

**1. Congelar las escrituras.** `npm run congelar` deja una marca en `DATA_DIR`. Mientras está puesta, el webhook **sigue contestando 200 a Meta** y **sigue reclamando** el trabajo en la bitácora del disco, pero **no lo procesa** ni lo marca como terminado.

Un evento reclamado y sin terminar es exactamente lo que el recuperador busca al arrancar. Así que al descongelar y reiniciar, esos mensajes se procesan solos, ya contra PostgreSQL. No hace falta inventar nada: se reutiliza la recuperación durable que ya existe y ya está probada.

> Devolver 503 también habría funcionado —Meta reintenta 36 horas— pero habría convertido una operación controlada en una carrera contra un reloj ajeno.

El cutover **se niega a copiar** si no está congelado. Un paso que se puede olvidar, se olvida.

**2. Verificarlo, no confiarlo.** Se toma una **huella** del origen antes y después de copiar: ids + versiones + estados + fechas de actualización. Si cambió algo, el cutover **falla**.

La huella detecta las tres formas de cambiar, incluida la que un conteo no ve:

| Cambio | ¿Lo ve un conteo? | ¿Lo ve la huella? |
|---|---|---|
| Alta | sí | sí |
| Baja | sí | sí |
| **Modificación** | **no** | **sí** |

Es lo que convierte *"creemos que nadie escribió"* en *"sabemos que nadie escribió"*. Y si salta, el problema es recuperable: el cutover es idempotente, así que basta repetirlo.

### Procedimiento

```bash
# 1. crear el esquema
DATABASE_URL="..." npm run migrar

# 2. congelar las escrituras
DATA_DIR=/var/data npm run congelar

# 3. ensayar
DATABASE_URL="..." DATA_DIR=/var/data npm run cutover -- --simular

# 4. copiar
DATABASE_URL="..." DATA_DIR=/var/data npm run cutover
#    debe decir: "huella del origen: abc -> abc  (no se movio)"
#    y terminar con "Cutover completo y verificado"

# 5. Render: DATABASE_URL en el servicio -> reinicia
#    /health debe decir almacen_transaccional: "postgres"
#            y escrituras_congeladas: true

# 6. descongelar
DATA_DIR=/var/data npm run descongelar

# 7. Render: reiniciar otra vez
#    el recuperador procesa los mensajes diferidos, ya contra PostgreSQL
#    /health -> trabajo.reclamados debe volver a 0
```

**Dos reinicios, y el orden importa.** El paso 5 va antes del 6 a propósito: si se descongelara primero, el servicio procesaría los mensajes diferidos **contra archivos**, creando datos que PostgreSQL no tiene — y volveríamos al problema que acabamos de cerrar.

Los mensajes diferidos se retrasan un reinicio. No se pierden: están reclamados en el disco y `/health → trabajo.reclamados` dice cuántos quedan.

**No congeles más de unos minutos.** El techo duro son las 36 horas de la ventana de reintentos de Meta, pero un congelado olvidado es un bot que acumula mensajes sin atender a nadie. Por eso `/health` publica `escrituras_congeladas` **sin token**: tiene que verse.

### Si dos pedidos comparten clave

El cutover **lo dice y falla**. Es el único caso que no se puede resolver sin una persona, y taparlo dejaría un pedido fuera sin que nadie lo supiera.

---

## Rollback: el punto de no retorno

**Quitar `DATABASE_URL` es rollback seguro solo mientras PostgreSQL no haya recibido escrituras que el disco no tenga.**

```
                 cutover          DATABASE_URL        descongelar
                 verificado       en Render           + reinicio
 ───────────────────┬────────────────┬───────────────────┬──────────────▶
                    │                │                   │
  disco = verdad    │  disco = verdad│  disco = verdad   │  PG = verdad
                    │  PG = copia    │  PG = copia       │
                    │                │  (congelado)      │
 ◀── quitar DATABASE_URL es seguro ──────────────────────┤
                                                         │
                                     PUNTO DE NO RETORNO ┘
```

**El punto de no retorno es el paso 7**: el reinicio con `DATABASE_URL` puesta **y** las escrituras descongeladas. A partir de ahí, cada mensaje que entra escribe en PostgreSQL y **no** en el disco.

### Antes del punto de no retorno

Quitar `DATABASE_URL` del servicio y desplegar. El disco nunca se tocó y sigue siendo la verdad. No se pierde nada.

### Después del punto de no retorno

**Quitar `DATABASE_URL` directamente pierde todo lo que se haya escrito en PostgreSQL desde el cutover**: pedidos nuevos, confirmaciones, modificaciones, cancelaciones. El servicio volvería a leer un disco que se quedó en la foto del cutover, y esos pedidos dejarían de existir — sin ningún error, porque para el servicio nunca existieron.

El procedimiento correcto es el cutover **al revés**:

```bash
# 1. congelar (ahora frena las escrituras a PostgreSQL)
DATA_DIR=/var/data npm run congelar

# 2. ensayar la vuelta
DATABASE_URL="..." DATA_DIR=/var/data npm run cutover -- --inverso --simular

# 3. copiar PostgreSQL -> archivos
DATABASE_URL="..." DATA_DIR=/var/data npm run cutover -- --inverso
#    misma verificación de huella, en el otro sentido

# 4. Render: QUITAR DATABASE_URL -> reinicia

# 5. descongelar
DATA_DIR=/var/data npm run descongelar

# 6. Render: reiniciar para vaciar los diferidos
```

`--inverso` usa la **misma** función de copia y las **mismas** verificaciones: congelación obligatoria, huella antes y después, idempotencia. Está probado en `test/f3-ventana-cutover.test.js` (`el ROLLBACK copia de PostgreSQL a archivos`), incluido el caso de un pedido que nació solo en PostgreSQL.

### Cómo saber de qué lado estás

```
GET /health
  "almacen_transaccional": "archivos" | "postgres"
  "escrituras_congeladas": true | false
```

`postgres` + `congeladas: false` = **estás después del punto de no retorno.** Volver atrás requiere el cutover inverso.

## Pruebas

| Batería | Qué cubre |
|---|---|
| `f3-postgres.test.js` | Las **mismas** pruebas de contrato que archivos, más las garantías del motor |
| `f3-cutover.test.js` | No perder, no duplicar, idempotencia, estados finales, snapshot |
| `f3-recuperacion-postgres.test.js` | Que la recuperación durable siga funcionando con Postgres |
| `f3-ventana-cutover.test.js` | La ventana de escrituras, la huella, el congelado y el rollback inverso |

Lo que solo se puede probar con una base real y **sí se probó**:

- **12 conexiones concurrentes** intentando la misma oferta → 1 pedido, y los 11 perdedores reciben el pedido de verdad
- 8 conexiones con el mismo evento → 1 pedido
- los índices `UNIQUE` existen y el de oferta es parcial (consultado en `pg_indexes`)
- el motor rechaza un `INSERT` duplicado **aunque alguien evite el adaptador**
- el motor rechaza un total descuadrado, un cancelado sin fecha y un estado inventado
- el ejecutor de migraciones para si un `.sql` aplicado cambió
- el arranque falla si falta el esquema
- **una escritura concurrente durante el cutover lo hace fallar** en vez de declararlo exitoso
- una **modificación** concurrente —que un conteo no ve— también lo hace fallar
- repetir el cutover tras detectar el cambio sí lo completa
- el rollback `--inverso` trae de vuelta un pedido que solo existía en PostgreSQL
- congelado, el webhook reclama el trabajo y **no** lo procesa; descongelado, sí

```bash
# sin base: las pruebas de Postgres se SALTAN, el resto corre
npm test

# con base
DATABASE_URL_PRUEBAS="postgres://..." npm test
```

Cada archivo de prueba trabaja en **su propio esquema** de Postgres: `node --test` lanza un proceso por archivo y los corre en paralelo, y la primera versión dejaba que dos archivos borrasen las mismas tablas. Era un fallo de la batería, no del producto, y de los peores: hacía dudar de un resultado correcto.

---

## Lo que necesito de ti en Render

**No aprovisioné nada.** Cuando quieras activarlo:

### 1. Crear la base

Render → **New +** → **Postgres**

| Campo | Valor |
|---|---|
| Name | `novika-db` |
| Database | `novika` |
| User | `novika` |
| Region | **Oregon** — la misma del servicio. Cruzar regiones añade latencia a cada consulta |
| PostgreSQL Version | 16 o 17 |
| Plan | **de pago** (desde ~US$6/mes) |

> **No el plan gratuito.** Expira 30 días después de crearse y luego se elimina con sus datos. Sobre la contabilidad del negocio eso es una fecha de caducidad silenciosa.

### 2. Pasarme el aviso

Dime que está creada. **No me pegues la URL en el chat** — lleva la contraseña dentro. Yo no la necesito: lo que necesito es saber que existe para darte los comandos del cutover con tus rutas reales.

### 3. Cuando hagamos el cutover

Copia la **Internal Database URL** (la interna, no la externa: no sale a internet) y úsala en los comandos de los pasos 1-3 de arriba. Yo te acompaño en el orden.

### 4. Solo al final

Render → `novika-bot` → Environment → `DATABASE_URL` = la Internal Database URL.

Hasta ese momento, producción no toca la base.

---

## Verificado contra Postgres 15.19

Las pruebas se ejecutaron contra un PostgreSQL 15.19 real, con conexiones concurrentes y advisory locks comprobados. Render ofrece 16/17; todo lo que se usa —índices únicos parciales, `ON CONFLICT`, advisory locks, JSONB, `CHECK`— es estable desde 15 y no cambia entre esas versiones.

Lo que **no** he podido verificar aquí y habrá que comprobar con la base real:

- la latencia real entre el servicio y la base en Oregon
- el comportamiento del TLS de Render (la detección está probada por unidad, no contra su certificado)
- el límite de conexiones del plan que elijas frente al `max: 8` del pool
