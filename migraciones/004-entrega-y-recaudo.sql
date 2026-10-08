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
-- La 001 no se edita: el ejecutor compara el checksum de cada archivo ya
-- aplicado y falla si cambio. Asi que el CHECK viejo se quita y se vuelve a
-- poner con el valor nuevo, dentro de la transaccion que el ejecutor abre
-- por cada migracion.
--
-- --------------------------------------------------------------------------
-- ⚠️ ESTA MIGRACION NO CREA NINGUNA COLUMNA, Y ESO ES DELIBERADO
-- --------------------------------------------------------------------------
--
-- La primera version de este archivo creaba `pedidos.entrega` con su indice,
-- y el adaptador la escribia. El mismo dia tumbo el servicio: la columna se
-- exigio en `COLUMNAS_REQUERIDAS` sin que esta migracion estuviera aplicada
-- en produccion -se aplican a mano, a proposito-, `revisarEsquema` lanzo al
-- arrancar, y el panel se quedo SIN UN SOLO CHAT. Desde fuera no se ve un
-- error de esquema: se ve un panel vacio, indistinguible de haber perdido
-- los datos.
--
-- El dato de la entrega viaja en `extra JSONB`, que es sin esquema, asi que
-- el pedido entregado se guarda y se lee en CUALQUIER version de la base.
-- Lo unico que esta migracion cambia son RESTRICCIONES, que es lo que de
-- verdad hacia falta: sin ellas el motor rechaza el estado nuevo.
--
-- Cuando la caja haya que sumarla EN SQL -y entonces si convenga la columna
-- y su indice-, el orden es: migrar, comprobar que esta aplicada, y DESPUES
-- desplegar el codigo que la escribe. Nunca en el mismo despliegue.
-- ==========================================================================

-- El estado nuevo. Sin esto el motor RECHAZA marcar un pedido como
-- entregado, y el boton del panel falla con una violacion de CHECK.
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_estado_check;

ALTER TABLE pedidos
  ADD CONSTRAINT pedidos_estado_check
  CHECK (estado IN ('confirmado','en_revision','modificado','cancelado','despachado','entregado'));

-- --------------------------------------------------------------------------
-- EL INVARIANTE: ENTREGADO IMPLICA GUIA
-- --------------------------------------------------------------------------
--
-- Solo se entrega lo que salio, y lo que salio tiene guia (invariante de la
-- 003). Un "entregado" sin guia seria plata cuadrada contra un paquete que
-- nunca se envio, que es justo la forma de cuadrar una caja que no existe.
-- El dominio ya lo impide -solo deja entregar desde despachado- y aqui lo
-- sostiene tambien el motor.
--
-- `guia` es una columna GENERADA desde `despacho->>'guia'` (003), asi que
-- esto no depende de ninguna columna nueva.
ALTER TABLE pedidos DROP CONSTRAINT IF EXISTS pedidos_entregado_con_guia;

ALTER TABLE pedidos
  ADD CONSTRAINT pedidos_entregado_con_guia
  CHECK (estado <> 'entregado' OR guia IS NOT NULL);
