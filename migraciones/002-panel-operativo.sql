-- ==========================================================================
-- 002 · PANEL OPERATIVO
--
-- Dos campos de la conversacion que el panel necesita y que hasta ahora no
-- existian.
--
-- Migracion NUEVA y no una edicion de la 001 a proposito: la 001 pudo
-- aplicarse ya en la base de Render, y el ejecutor guarda el checksum de
-- cada archivo. Editar una migracion aplicada deja la base en un estado que
-- no corresponde a ningun archivo del repositorio, y el ejecutor para.
--
-- --------------------------------------------------------------------------
-- POR QUE COLUMNAS Y NO `extra`
-- --------------------------------------------------------------------------
--
-- `extra JSONB` existe para que el adaptador de archivos -que no tiene
-- esquema- y el de PostgreSQL guarden lo mismo, y para que un campo nuevo no
-- se pierda en silencio. Pero su comentario en la 001 dice la regla: cuando
-- un campo de `extra` empieza a importar, se le hace columna.
--
-- `atencion` importa: de ella depende que el bot se calle. Es la diferencia
-- entre un cliente que habla con una persona y un cliente que recibe dos
-- voces. Eso no vive en un cajon de sobrantes.
--
-- `mensajes` importa porque es lo que se audita: es la conversacion como la
-- ve el operador.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- ATENCION HUMANA
--
--   { pausado, por, desde, atendidoEn, atendidoPor }
--
-- `pausado` es lo que consulta el emisor JUSTO ANTES de enviar. Se guarda
-- ademas como columna generada para poder indexarla: el panel pregunta
-- "que chats tiene tomados una persona" en cada carga.
--
-- `atendidoEn` es una FECHA, no un si/no. "Esta atendido" se calcula
-- comparandola con el ultimo mensaje del cliente, asi que un cliente que
-- vuelve a escribir reaparece solo. Un si/no habria que acordarse de
-- borrarlo en cada camino que reciba un mensaje, y el dia que un camino
-- nuevo se olvide, el chat queda silenciado para siempre: una venta perdida
-- sin error.
-- --------------------------------------------------------------------------
ALTER TABLE conversaciones
  ADD COLUMN IF NOT EXISTS atencion JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Indice parcial: solo interesan las pausadas, que son unas pocas.
CREATE INDEX IF NOT EXISTS conversaciones_pausadas_idx
  ON conversaciones ((atencion->>'pausado'))
  WHERE atencion->>'pausado' = 'true';

-- --------------------------------------------------------------------------
-- HISTORIAL DE LA CONVERSACION
--
--   [{ de, texto, wamid, por, estado, ts }]
--
-- `ventana` no sirve para esto: son los ultimos textos del CLIENTE, sin
-- direccion ni hora, y existe para resolver el producto cuando se rota.
--
-- `estado` guarda el resultado REAL de cada mensaje del negocio: enviado,
-- bloqueado por un interruptor, bloqueado por la pausa, o preparado sin
-- enviar (modo sombra). Sin ese campo el panel mostraria como dicho algo
-- que nunca salio, que es la peor forma de equivocarse atendiendo.
--
-- Se recorta a los ultimos N en el codigo, no aqui: el limite es una
-- decision de producto, no del esquema.
-- --------------------------------------------------------------------------
ALTER TABLE conversaciones
  ADD COLUMN IF NOT EXISTS mensajes JSONB NOT NULL DEFAULT '[]'::jsonb;
