-- Deterministic synthetic sales data for the Office analysis evaluation.
-- Run as a superuser on a disposable database (see README.md). Synthetic only.
DROP SCHEMA IF EXISTS sales CASCADE;
CREATE SCHEMA sales;

CREATE TABLE sales.orders (
  order_id      integer PRIMARY KEY,
  order_date    date NOT NULL,
  region        text NOT NULL,
  channel       text NOT NULL,
  customer_id   integer NOT NULL,
  status        text NOT NULL,
  order_amount  numeric(12,2) NOT NULL,
  paid_amount   numeric(12,2) NOT NULL
);
COMMENT ON COLUMN sales.orders.order_amount IS 'CNY';
COMMENT ON COLUMN sales.orders.paid_amount IS 'CNY; 0 unless status = paid';

-- 24,000 orders from 2025-01-01 to 2026-10-31: more than one source page, so
-- row-level queries are truncated and totals must be computed in SQL.
INSERT INTO sales.orders
SELECT i,
       DATE '2025-01-01' + ((i * 37) % 669),
       (ARRAY['华东','华南','华北','西南','东北'])[1 + (i * 7) % 5],
       (ARRAY['线上','门店','经销商'])[1 + (i * 11) % 3],
       1 + (i * 131) % 3000,
       CASE WHEN i % 17 = 0 THEN 'refunded' WHEN i % 9 = 0 THEN 'cancelled' ELSE 'paid' END,
       round((50 + (i * 9973) % 4950 + ((i * 31) % 100) / 100.0)::numeric, 2),
       0
FROM generate_series(1, 24000) AS i;
UPDATE sales.orders SET paid_amount = order_amount WHERE status = 'paid';

CREATE TABLE sales.order_items (
  order_id    integer NOT NULL REFERENCES sales.orders(order_id),
  line_no     integer NOT NULL,
  category    text NOT NULL,
  product     text NOT NULL,
  quantity    integer NOT NULL,
  unit_price  numeric(12,2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);
INSERT INTO sales.order_items
SELECT o.order_id, l,
       (ARRAY['电子产品','家居','服装','食品','美妆','运动'])[1 + (o.order_id * 3 + l * 5) % 6],
       'P' || lpad((1 + (o.order_id * 17 + l * 23) % 120)::text, 3, '0'),
       1 + (o.order_id + l) % 4,
       round((10 + (o.order_id * 13 + l * 101) % 900)::numeric, 2)
FROM sales.orders o, generate_series(1, 1 + o.order_id % 3) AS l;

-- The read-only role the source connection uses; the server refuses roles
-- that can write, own objects, inherit privileges or create temp tables.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eval_analyst') THEN
    EXECUTE 'REASSIGN OWNED BY eval_analyst TO postgres';
    EXECUTE 'DROP OWNED BY eval_analyst';
    EXECUTE 'DROP ROLE eval_analyst';
  END IF;
END $$;
CREATE ROLE eval_analyst LOGIN PASSWORD 'eval-only-not-secret' NOINHERIT;
ALTER ROLE eval_analyst SET default_transaction_read_only = on;
REVOKE CREATE, TEMPORARY ON DATABASE sales_eval FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE sales_eval TO eval_analyst;
GRANT USAGE ON SCHEMA sales TO eval_analyst;
GRANT SELECT ON ALL TABLES IN SCHEMA sales TO eval_analyst;
ANALYZE sales.orders;
ANALYZE sales.order_items;
