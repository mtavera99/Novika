-- ==========================================================================
-- 004 · ENTREGA Y RECAUDO
--
-- --------------------------------------------------------------------------
-- POR QUE HACE FALTA UN ESTADO "ENTREGADO"
-- --------------------------------------------------------------------------
--
-- ESTE NEGOCIO ES CONTRAENTREGA. El cliente paga cuando el paquete esta en
-- su mano, asi que un pedido confirmado -o incluso despachado- NO es plata
-- cobrada: es plata en riesgo. Si la entrega se cae, el importe no entra y
-- encima el flete ya se gasto.
--
-- Hasta aqui el panel sumaba los pedidos vivos del dia y lo presentaba como
-- el importe. Para una venta anticipada eso seria correcto; para
-- contraentrega contesta OTRA PREGUNTA. Marco pregunto "cuanto vamos
-- recaudado" y lo que el sistema sabia decir era cuanto se habia VENDIDO.
--
-- La diferencia entre las dos cifras es la tasa de rechazo, que en la
-- referencia de BIKERPRO es el numero que decide si el negocio gana o
-- pierde: con el rechazo al 5% el canal es rentable y al 32% no lo es. Sin
-- un estado de entrega, ese numero no se puede ni calcular.
--
-- --------------------------------------------------------------------------
-- POR QUE SE TOCA EL CHECK Y NO SE AÑADE UNA COLUMNA "ENTREGADO BOOLEANO"
-- --------------------------------------------------------------------------
--
-- Un booleano al lado del estado permite la combinacion imposible
-- "cancelado + entregado", y entonces la caja depende de que el codigo no
-- se equivoque. El estado es UNO, y el motor es quien debe saber cuales
-- existen: es la misma razon por la que la 001 puso el CHECK en vez de
-- confiar en el dominio.
--
-- La 001 no se edita: el ejecutor de migraciones compara el checksum de
-- cada archivo ya aplicado y falla si cambio. Asi que el CHECK viejo se
-- quita y se vuelve a poner con el valor nuevo, dentro de la transaccion
-- que el ejecutor ya abre por cada migracion.
--
-- --------------------------------------------------------------------------
-- EL INVARIANTE: ENTREGADO IMPLICA GUIA
-- --------------------------------------------------------------------------
--
-- Solo se entrega lo que salio, y lo que salio tiene guia (invariante de la
-- 003). Un "entregado" sin guia seria plata cuadrada contra un paquete que
-- nunca se envio, que es justo la forma de cuadrar una caja que no existe.
-- El dominio ya lo impide -solo deja entregar desde despachado- y aqui el
-- motor lo sostiene tambien.
-- ==========================================================================

-- El estado nuevo.
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_estado_check;

ALTER TABLE pedidos
  ADD CONSTRAINT pedidos_estado_check
  CHECK (estado IN ('confirmado','en_revision','modificado','cancelado','despachado','entregado'));

-- La fecha y el importe recaudado viven en su columna porque son la caja:
-- es por donde se suma el dia y por donde se filtra un rango. El adaptador
-- manda a `extra JSONB` todo lo que no tiene columna, y sumar sobre un JSON
-- sin indice es recorrerlo entero.
--
-- El importe se CONGELA al entregar: si manana alguien modifica la
-- cotizacion, la caja de ayer no se mueve. Por eso es una columna propia y
-- no un JOIN contra el total del pedido.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega JSONB;

-- Un entregado SIEMPRE tiene guia, igual que un despachado.
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_entregado_con_guia;

ALTER TABLE pedidos
  ADD CONSTRAINT pedidos_entregado_con_guia
  CHECK (estado <> 'entregado' OR guia IS NOT NULL);

-- Por donde se lee la caja: "lo entregado de este dia". Parcial, porque
-- preguntar por entregas solo tiene sentido sobre las que existen.
CREATE INDEX IF NOT EXISTS pedidos_entregados_idx
  ON pedidos ((entrega->>'entregadoEn'))
  WHERE estado = 'entregado';
