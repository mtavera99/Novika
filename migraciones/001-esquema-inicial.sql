-- ==========================================================================
-- NOVIKA · 001 · esquema transaccional inicial
--
-- Destino: Render Postgres (instancia DE PAGO; la gratuita expira a los 30
-- dias y despues se elimina con sus datos).
--
-- Esta migracion SE REESCRIBIO en la Fase 3A. Es seguro hacerlo porque nunca
-- se aplico en ningun entorno: DATABASE_URL jamas se configuro, y el
-- ejecutor de migraciones guarda un checksum por archivo, asi que si alguien
-- la hubiera aplicado la reescritura se detectaria al migrar en vez de
-- pasar inadvertida.
--
-- Lo que se corrigio, auditando el esquema anterior contra el contrato real
-- de repositorios de Fase 2:
--
--   1. FALTABAN TRES CAMPOS DE LA CONVERSACION: `cotizacion`,
--      `resumen_mostrado` y `ventana`. Son exactamente los que deciden si un
--      "si" crea un pedido: sin `resumen_mostrado` la confirmacion nunca
--      cuenta, y sin `cotizacion` no hay oferta vigente que confirmar.
--      Migrar con ese esquema habria roto el cierre de ventas en silencio.
--
--   2. IMPORTES EN CENTAVOS. El dominio calcula en pesos enteros (el peso
--      colombiano no usa centavos en la practica). Obligar al adaptador a
--      multiplicar por 100 en cada lectura y escritura es invitar a un error
--      de x100 en un total. La base se adapta al dominio, no al contrario.
--
--   3. CLAVES SUBROGADAS (BIGSERIAL) para contactos y conversaciones. El
--      dominio identifica al contacto por su id de WhatsApp y guarda
--      `conversacionId` como ESE MISMO TEXTO, no como un entero. Mantener
--      ids subrogados obligaba a traducir en los dos sentidos, y una
--      traduccion mal hecha mezcla las conversaciones de dos clientes.
--
--   4. `pedidos_historial` con UNIQUE(pedido_id, version). Cancelar es
--      idempotente y no sube la version, asi que reescribir un pedido
--      cancelado chocaba contra esa restriccion. Ahora la clave incluye la
--      accion y los insertados usan ON CONFLICT DO NOTHING.
--
--   5. `eventos_procesados` NO SERVIA PARA LA RECUPERACION DURABLE. Tenia
--      wamid y fecha, pero no el estado (reclamado/terminado/agotado) ni el
--      evento, que es lo que permite reprocesar tras un crash. Se elimina:
--      la bitacora de trabajo se queda en el disco a proposito (ver abajo).
--
--   6. `respuestas_preparadas` era una tabla muerta. El modo sombra escribe
--      en el diario, que es el registro de auditoria. Dos sitios para lo
--      mismo es como se acaba con dos fuentes de verdad.
--
-- --------------------------------------------------------------------------
-- QUE NO ESTA AQUI, Y POR QUE
-- --------------------------------------------------------------------------
--
-- LA BITACORA DE TRABAJO (src/almacen/trabajo.js) SE QUEDA EN EL DISCO.
--
-- Es lo unico que tiene que funcionar cuando la base de datos NO responda.
-- El webhook no puede contestar 200 sin haber reclamado el trabajo de forma
-- durable; si ese reclamo dependiera de Postgres, una caida de la base
-- obligaria a devolver 503 a Meta y, con suficientes 503, Meta desactiva la
-- suscripcion. Un append sincrono al disco local no tiene ese modo de fallo.
--
-- Ademas el reclamo es SINCRONO y ocurre antes del acuse; una escritura a
-- Postgres es asincrona y cambiaria la forma de ese camino, que es el que
-- mas cuidado necesita.
--
-- Mover la bitacora a Postgres solo tendra sentido cuando se quiera quitar
-- el disco (y con el disco se va la unica instancia). Ese dia sera una
-- migracion propia, con sus pruebas.
--
-- --------------------------------------------------------------------------
-- LO QUE MAS IMPORTA DE TODO EL ARCHIVO
-- --------------------------------------------------------------------------
--
-- Las dos restricciones UNIQUE de `pedidos`. Hoy la idempotencia la sostiene
-- una cola en memoria mas un indice en disco: vale para un proceso. Estas
-- dos la convierten en una garantia del motor, que no se puede saltar ni con
-- dos procesos, ni con una condicion de carrera, ni con un despliegue en
-- medio:
--
--   clave_de_evento  -> Meta retransmite el mismo evento (mismo wamid)
--   clave_de_oferta  -> el cliente escribe "si" dos veces (otro wamid,
--                       misma oferta)
--
-- La segunda es PARCIAL: solo aplica a pedidos no cancelados, porque un
-- cliente que se arrepiente de cancelar tiene que poder volver a comprar.
-- ==========================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- CONTACTOS
--
-- La clave es el identificador de WhatsApp tal como llega: un telefono o un
-- BSUID (los clientes con nombre de usuario no tienen telefono). Se guardan
-- ademas en columnas separadas, porque la clave de la conversacion y el
-- telefono al que se despacha son cosas distintas y confundirlas rompe el
-- despacho.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contactos (
  id             TEXT        PRIMARY KEY,
  telefono       TEXT        NULL,
  bsuid          TEXT        NULL,
  nombre_perfil  TEXT        NULL,
  -- Campos que el dominio guarde y no tengan columna. Ver la nota sobre
  -- `extra` al final del archivo: es lo que hace que los dos adaptadores
  -- sean intercambiables de verdad.
  extra          JSONB       NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- CONVERSACIONES
--
-- Una por contacto. El estado es EXPLICITO y se guarda; no se deduce leyendo
-- los mensajes con expresiones regulares.
--
-- `resumen_mostrado` y `cotizacion` son COLUMNAS DE PRIMERA CLASE y no
-- campos dentro de un JSON: son los dos datos que deciden si un "si" crea un
-- pedido. Tienen que poder consultarse y verse.
--
-- `ficha` si es JSONB: guarda cada campo del cliente con su estado
-- (candidato / confirmado / rechazado) y su historial. Su forma la define el
-- dominio y va a cambiar; lo que no cambia son los hechos, y esos tienen
-- columna.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversaciones (
  contacto_id      TEXT        PRIMARY KEY REFERENCES contactos(id) ON DELETE CASCADE,
  estado           TEXT        NOT NULL,
  producto_id      TEXT        NULL,          -- NULL = DESCONOCIDO. No hay producto por defecto.
  oferta_id        TEXT        NULL,
  resumen_mostrado BOOLEAN     NOT NULL DEFAULT false,
  cotizacion       JSONB       NULL,          -- oferta vigente; NULL = no hay nada que confirmar
  ficha            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ventana          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  ultimo_wamid     TEXT        NULL,
  extra            JSONB       NULL,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversaciones_estado_idx ON conversaciones (estado);

-- --------------------------------------------------------------------------
-- PEDIDOS
--
-- `codigo` (NOV-XXXX-YYYY) es la clave primaria: es el id del dominio, el
-- que se le dice al cliente y el que viaja en la guia. No hay id subrogado
-- que traducir.
--
-- `cotizacion` y `destinatario` son SNAPSHOTS, no referencias. Si manana
-- sube el precio del producto, el pedido de ayer sigue valiendo lo que el
-- cliente acepto. Guardar solo un producto_id y recalcular al consultar
-- significa que el historico cambia solo, y entonces la contabilidad del
-- negocio no es auditable.
--
-- Los importes se desnormalizan a columnas ADEMAS de vivir en el snapshot:
-- el snapshot es la verdad, las columnas permiten sumar, indexar y que el
-- motor compruebe que el total cuadra.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pedidos (
  codigo               TEXT        PRIMARY KEY,
  version              INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
  estado               TEXT        NOT NULL
                         CHECK (estado IN ('confirmado','en_revision','modificado','cancelado','despachado')),

  -- Las dos claves de idempotencia.
  clave_de_evento      TEXT        NOT NULL,
  clave_de_oferta      TEXT        NOT NULL,

  contacto_id          TEXT        NOT NULL REFERENCES contactos(id) ON DELETE RESTRICT,
  -- El dominio guarda aqui el id del contacto, no un entero. Se conserva tal
  -- cual, sin clave ajena, para poder round-trip exacto.
  conversacion_externa TEXT        NULL,
  oferta_id            TEXT        NOT NULL,
  wamid_confirmacion   TEXT        NOT NULL,

  producto_id          TEXT        NOT NULL,
  producto_nombre      TEXT        NOT NULL,
  variante             JSONB       NULL,
  cantidad             INTEGER     NOT NULL CHECK (cantidad >= 1),

  -- PESOS ENTEROS, no centavos: es como calcula el dominio. BIGINT, nunca
  -- float: 0,1 no se puede representar en binario y un redondeo en un total
  -- es una discusion con un cliente.
  subtotal_pesos       BIGINT      NOT NULL CHECK (subtotal_pesos >= 0),
  envio_pesos          BIGINT      NOT NULL CHECK (envio_pesos >= 0),
  descuento_pesos      BIGINT      NOT NULL DEFAULT 0 CHECK (descuento_pesos >= 0),
  total_pesos          BIGINT      NOT NULL CHECK (total_pesos > 0),
  moneda               TEXT        NOT NULL DEFAULT 'COP',

  destinatario         JSONB       NOT NULL,
  cotizacion           JSONB       NOT NULL,
  firma_condiciones    TEXT        NULL,
  politica_version     TEXT        NOT NULL,
  version_catalogo     TEXT        NOT NULL,

  origen               JSONB       NULL,
  revisiones           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  extra                JSONB       NULL,

  creado_en            TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelado_en         TIMESTAMPTZ NULL,
  motivo_cancelacion   TEXT        NULL,

  -- El total tiene que cuadrar con sus partes. Lo comprueba el motor, no la
  -- confianza en que el codigo lo hizo bien.
  CONSTRAINT total_cuadra CHECK (total_pesos = subtotal_pesos + envio_pesos - descuento_pesos),

  -- Un pedido cancelado tiene fecha de cancelacion, y uno que no lo esta no
  -- la tiene. Evita el estado a medias que luego nadie sabe interpretar.
  CONSTRAINT cancelacion_coherente CHECK (
    (estado = 'cancelado' AND cancelado_en IS NOT NULL)
    OR (estado <> 'cancelado' AND cancelado_en IS NULL)
  )
);

-- CANDADO 1: la retransmision del webhook no puede crear un segundo pedido.
CREATE UNIQUE INDEX IF NOT EXISTS pedidos_clave_evento_uniq
  ON pedidos (clave_de_evento);

-- CANDADO 2: un "si" repetido no puede crear un segundo pedido sobre la
-- misma oferta. PARCIAL: los cancelados liberan la oferta, porque un cliente
-- que se arrepiente de cancelar tiene que poder volver a comprar.
CREATE UNIQUE INDEX IF NOT EXISTS pedidos_clave_oferta_vivo_uniq
  ON pedidos (clave_de_oferta)
  WHERE estado <> 'cancelado';

CREATE INDEX IF NOT EXISTS pedidos_contacto_idx ON pedidos (contacto_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS pedidos_estado_idx   ON pedidos (estado);
CREATE INDEX IF NOT EXISTS pedidos_producto_idx ON pedidos (producto_id);

-- --------------------------------------------------------------------------
-- HISTORIAL DE PEDIDOS
--
-- Append-only. Las modificaciones no pisan: versionan. "Que le dijimos al
-- cliente y cuando" tiene que poder responderse meses despues, y un UPDATE
-- sobre la fila del pedido borra esa respuesta.
--
-- La clave unica incluye la ACCION, no solo la version: cancelar es
-- idempotente y no sube la version, asi que (pedido, version) chocaba al
-- reescribir un pedido ya cancelado.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pedidos_historial (
  id             BIGSERIAL   PRIMARY KEY,
  pedido_codigo  TEXT        NOT NULL REFERENCES pedidos(codigo) ON DELETE CASCADE,
  version        INTEGER     NOT NULL,
  accion         TEXT        NOT NULL,
  entrada        JSONB       NOT NULL,   -- la entrada tal cual la escribio el dominio
  cuando         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT entrada_unica_de_historial UNIQUE (pedido_codigo, version, accion)
);

CREATE INDEX IF NOT EXISTS pedidos_historial_pedido_idx ON pedidos_historial (pedido_codigo, id);

-- --------------------------------------------------------------------------
-- SOBRE LA COLUMNA `extra`
--
-- El adaptador de archivos no tiene esquema: guarda el objeto tal cual, asi
-- que un campo nuevo del dominio sobrevive sin tocar nada. Postgres solo
-- guarda lo que tiene columna, y eso rompe la promesa del contrato -"un
-- registro guardado se recupera igual"- de la forma mas silenciosa posible:
-- el campo desaparece y nadie se entera hasta que algo lo necesita.
--
-- Lo descubrieron las propias pruebas de contrato: un contacto guardado con
-- un campo sin mapear volvia sin el.
--
-- `extra` cierra esa diferencia. NO es un cajon de sastre para evitar
-- modelar: es lo que hace que los dos adaptadores sean intercambiables de
-- verdad durante el cutover. Cuando un campo de `extra` empiece a importar
-- -se consulta, se suma, se indexa-, se le hace columna en una migracion
-- nueva.
-- --------------------------------------------------------------------------

COMMIT;
