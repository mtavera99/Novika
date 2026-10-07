-- ==========================================================================
-- 003 · DESPACHO Y NOVEDADES DE ENTREGA
--
-- --------------------------------------------------------------------------
-- POR QUE COLUMNAS Y NO `extra`
-- --------------------------------------------------------------------------
--
-- Sin esta migracion `despacho` y `novedades` ya se guardarian: el
-- adaptador manda a `extra JSONB` todo lo que no tiene columna, y al leer
-- lo vuelve a mezclar. Funcionaria.
--
-- Pero la regla del proyecto -escrita en la 001- es que cuando un campo de
-- `extra` empieza a importar, se le hace columna. Y el numero de guia
-- importa de una forma muy concreta: es por donde se BUSCA.
--
-- Cuando la transportadora llama diciendo "la guia 123456 tiene una
-- novedad", lo que hace falta es encontrar el pedido POR ESE NUMERO. Con la
-- guia enterrada en un JSON sin indice, eso es recorrer todos los pedidos.
-- Con 50 pedidos da igual; con 50.000 es una pantalla que no carga justo
-- cuando hay un paquete en juego.
--
-- Y hay un invariante que el motor puede sostener y el codigo no: un pedido
-- despachado SIEMPRE tiene guia. Un "despachado" sin numero de guia es un
-- paquete que no se puede rastrear, y es exactamente el estado en el que un
-- cliente pregunta donde va su pedido y nadie sabe responder.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- DESPACHO
--
--   { guia, transportadora, despachadoEn }
--
-- La guia se saca tambien a columna propia para poder indexarla. El JSONB
-- sigue siendo la verdad; la columna es una proyeccion para buscar, igual
-- que los importes del pedido se desnormalizan junto al snapshot.
-- --------------------------------------------------------------------------
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS despacho JSONB NULL;

ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS guia TEXT GENERATED ALWAYS AS (despacho->>'guia') STORED;

-- Buscar un pedido por su guia es la consulta del dia a dia cuando la
-- transportadora reporta algo.
CREATE INDEX IF NOT EXISTS pedidos_guia_idx ON pedidos (guia) WHERE guia IS NOT NULL;

-- --------------------------------------------------------------------------
-- EL INVARIANTE
--
-- Despachado implica guia. Se comprueba en el MOTOR y no solo en el codigo
-- porque es el tipo de regla que un camino nuevo olvida: un script de
-- importacion, una correccion a mano, un cutover mal hecho.
--
-- NOT VALID a proposito: no revalida las filas que ya existen. Hoy no hay
-- ningun pedido despachado -el estado existe desde la Fase 2 pero no habia
-- transicion que lo pusiera-, asi que no hay nada que romper; y si alguna
-- vez hubiera datos viejos raros, la migracion no debe fallar por ellos.
-- Las filas NUEVAS si se comprueban.
-- --------------------------------------------------------------------------
ALTER TABLE pedidos
  ADD CONSTRAINT pedidos_despachado_tiene_guia
  CHECK (estado <> 'despachado' OR (despacho->>'guia') IS NOT NULL)
  NOT VALID;

-- --------------------------------------------------------------------------
-- NOVEDADES DE ENTREGA
--
--   [{ id, tipo, detalle, creadaEn, resueltaEn, comoSeResolvio, avisoAlCliente }]
--
-- Una novedad NO cambia el estado del pedido: sigue despachado. Es algo que
-- le paso al paquete, no un estado distinto de la venta. Mezclarlas haria
-- que un pedido con novedad desapareciera de la lista de despachados, que
-- es justo donde hay que verlo.
--
-- `avisoAlCliente` guarda el resultado REAL del intento de avisar, no un
-- booleano "avisado". Hoy siempre queda sin avisar porque hace falta una
-- plantilla aprobada por Meta; el dia que exista, aqui se vera si Meta lo
-- acepto y si llego el acuse, que no es lo mismo.
-- --------------------------------------------------------------------------
ALTER TABLE pedidos
  ADD COLUMN IF NOT EXISTS novedades JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Pedidos con alguna novedad SIN resolver: es la lista que se mira.
CREATE INDEX IF NOT EXISTS pedidos_con_novedad_idx
  ON pedidos ((jsonb_array_length(novedades)))
  WHERE jsonb_array_length(novedades) > 0;
