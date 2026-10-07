-- ==========================================================================
-- NOVIKA · esquema transaccional inicial
--
-- Destino: Render Postgres (instancia DE PAGO; la gratuita expira a los 30
-- dias y despues se elimina con sus datos).
--
-- Este archivo es el esquema de referencia. TODAVIA NO SE HA EJECUTADO: el
-- adaptador de PostgreSQL se escribira cuando exista una base contra la que
-- poder correr las pruebas de contrato (src/almacen/repos/contrato.js).
--
-- LO QUE MAS IMPORTA DE TODO EL ARCHIVO son las dos restricciones UNIQUE de
-- la tabla `pedidos`. Hoy la idempotencia la sostienen una cola en memoria y
-- un indice en disco; eso vale para un proceso y un volumen pequeno. Estas
-- dos restricciones la convierten en una garantia del motor, que no se puede
-- saltar ni con dos procesos, ni con una condicion de carrera, ni con un
-- despliegue en medio:
--
--   clave_de_evento  -> Meta retransmite el mismo evento (mismo wamid).
--   clave_de_oferta  -> el cliente escribe "si" dos veces (otro wamid,
--                       misma oferta).
--
-- La segunda es PARCIAL: solo aplica a pedidos no cancelados. Si un cliente
-- cancela y se arrepiente, tiene que poder volver a comprar la misma oferta.
--
-- Importes en CENTAVOS y en BIGINT, nunca en float. 0,1 no se puede
-- representar en binario, y un redondeo en un total es una discusion con un
-- cliente.
-- ==========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS migraciones (
  nombre      TEXT PRIMARY KEY,
  aplicada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- CONTACTOS
--
-- `id_externo` es el identificador de WhatsApp: puede ser un telefono o un
-- BSUID (los clientes con nombre de usuario no tienen telefono). Se guardan
-- en columnas distintas a proposito: la clave de la conversacion y el
-- telefono al que se despacha son cosas diferentes, y confundirlas rompe el
-- despacho.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contactos (
  id             BIGSERIAL PRIMARY KEY,
  id_externo     TEXT        NOT NULL UNIQUE,
  telefono       TEXT        NULL,
  bsuid          TEXT        NULL,
  nombre_perfil  TEXT        NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- CONVERSACIONES
--
-- Una por contacto. El estado es EXPLICITO y se guarda; no se deduce leyendo
-- los mensajes con expresiones regulares. En BIKERPRO las etapas se
-- inferian del texto y un detector laxo marco como "cotizado" el 97% de las
-- conversaciones cuando la realidad era el 54%, escondiendo durante semanas
-- la segunda fuga de ingresos del negocio.
--
-- `ficha` guarda los campos del cliente con su estado (candidato /
-- confirmado / rechazado). Es JSONB porque su forma la define el dominio y
-- va a cambiar; lo que no cambia son los hechos, y esos tienen columna.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversaciones (
  id             BIGSERIAL PRIMARY KEY,
  contacto_id    BIGINT      NOT NULL REFERENCES contactos(id) ON DELETE RESTRICT,
  estado         TEXT        NOT NULL,
  producto_id    TEXT        NULL,          -- NULL = desconocido. No hay producto por defecto.
  oferta_id      TEXT        NULL,
  ficha          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ultimo_wamid   TEXT        NULL,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversacion_unica_por_contacto UNIQUE (contacto_id)
);

CREATE INDEX IF NOT EXISTS conversaciones_estado_idx ON conversaciones (estado);

-- --------------------------------------------------------------------------
-- PEDIDOS
--
-- `cotizacion` y `destinatario` son SNAPSHOTS, no referencias. Si manana
-- sube el precio del producto, el pedido de ayer sigue valiendo lo que el
-- cliente acepto. Guardar solo un producto_id y recalcular al consultar
-- significa que el historico cambia solo, y entonces la contabilidad del
-- negocio no es auditable.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pedidos (
  id                 BIGSERIAL PRIMARY KEY,
  codigo             TEXT        NOT NULL UNIQUE,   -- NOV-XXXX-YYYY, el que se le dice al cliente
  version            INTEGER     NOT NULL DEFAULT 1,
  estado             TEXT        NOT NULL,          -- confirmado | en_revision | modificado | cancelado | despachado

  -- Las dos claves de idempotencia.
  clave_de_evento    TEXT        NOT NULL,
  clave_de_oferta    TEXT        NOT NULL,

  contacto_id        BIGINT      NOT NULL REFERENCES contactos(id) ON DELETE RESTRICT,
  conversacion_id    BIGINT      NULL REFERENCES conversaciones(id) ON DELETE SET NULL,
  oferta_id          TEXT        NOT NULL,
  wamid_confirmacion TEXT        NOT NULL,

  producto_id        TEXT        NOT NULL,
  producto_nombre    TEXT        NOT NULL,
  variante           JSONB       NULL,
  cantidad           INTEGER     NOT NULL CHECK (cantidad >= 1),

  -- Importes en centavos. BIGINT, nunca float.
  subtotal_centavos  BIGINT      NOT NULL CHECK (subtotal_centavos >= 0),
  envio_centavos     BIGINT      NOT NULL CHECK (envio_centavos >= 0),
  descuento_centavos BIGINT      NOT NULL DEFAULT 0 CHECK (descuento_centavos >= 0),
  total_centavos     BIGINT      NOT NULL CHECK (total_centavos > 0),
  moneda             TEXT        NOT NULL DEFAULT 'COP',

  destinatario       JSONB       NOT NULL,
  cotizacion         JSONB       NOT NULL,
  firma_condiciones  TEXT        NULL,
  politica_version   TEXT        NOT NULL,
  version_catalogo   TEXT        NOT NULL,

  origen             JSONB       NULL,
  revisiones         JSONB       NOT NULL DEFAULT '[]'::jsonb,

  creado_en          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelado_en       TIMESTAMPTZ NULL,
  motivo_cancelacion TEXT        NULL,

  -- El total tiene que cuadrar con sus partes. Lo comprueba el motor, no la
  -- confianza en que el codigo lo hizo bien.
  CONSTRAINT total_cuadra CHECK (
    total_centavos = subtotal_centavos + envio_centavos - descuento_centavos
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
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pedidos_historial (
  id            BIGSERIAL PRIMARY KEY,
  pedido_id     BIGINT      NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  version       INTEGER     NOT NULL,
  accion        TEXT        NOT NULL,     -- creado | modificado | cancelado | despachado
  estado        TEXT        NOT NULL,
  cambios       JSONB       NULL,
  antes         JSONB       NULL,
  despues       JSONB       NULL,
  total_centavos BIGINT     NULL,
  recotizado    BOOLEAN     NOT NULL DEFAULT false,
  porque        TEXT        NULL,
  wamid         TEXT        NULL,
  cuando        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT version_unica_por_pedido UNIQUE (pedido_id, version)
);

-- --------------------------------------------------------------------------
-- EVENTOS PROCESADOS
--
-- La deduplicacion por wamid, con garantia del motor. Hoy vive en un .jsonl
-- mas un Map en memoria; aqui pasa a ser una restriccion que no se puede
-- saltar.
--
-- La ventana de retencion es de 7 dias y no de 36 horas a proposito: Meta
-- reintenta durante 36 horas, y 7 dias dejan margen para un fin de semana
-- con incidencias.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eventos_procesados (
  wamid       TEXT        PRIMARY KEY,
  contacto_id BIGINT      NULL REFERENCES contactos(id) ON DELETE SET NULL,
  tipo        TEXT        NOT NULL,
  procesado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eventos_procesados_fecha_idx ON eventos_procesados (procesado_en);

-- --------------------------------------------------------------------------
-- RESPUESTAS PREPARADAS (modo sombra)
--
-- Lo que el bot HABRIA enviado, para poder auditarlo antes de activar las
-- respuestas automaticas. `enviada` arranca en false y solo lo cambia un
-- envio real.
--
-- Si alguna vez hay filas con enviada = true mientras RESPUESTA_AUTOMATICA
-- esta en 0, es un incidente.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS respuestas_preparadas (
  id              BIGSERIAL PRIMARY KEY,
  contacto_id     BIGINT      NOT NULL REFERENCES contactos(id) ON DELETE CASCADE,
  conversacion_id BIGINT      NULL REFERENCES conversaciones(id) ON DELETE SET NULL,
  wamid_origen    TEXT        NOT NULL,
  estado_conv     TEXT        NOT NULL,
  intencion       TEXT        NULL,
  producto_id     TEXT        NULL,
  texto           TEXT        NOT NULL,
  bloqueos        JSONB       NOT NULL DEFAULT '[]'::jsonb, -- por que no se habria enviado
  enviada         BOOLEAN     NOT NULL DEFAULT false,
  creado_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT respuesta_unica_por_evento UNIQUE (wamid_origen)
);

INSERT INTO migraciones (nombre) VALUES ('001-esquema-inicial')
  ON CONFLICT (nombre) DO NOTHING;

COMMIT;
