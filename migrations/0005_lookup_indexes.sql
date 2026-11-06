-- Per-page and per-query lookups: equality columns first, then date, so a page or
-- query detail reads only its own rows instead of scanning the whole property.
-- query_page_daily keeps qpd_page / qpd_query (rebuilding them on a large table
-- exceeds D1's memory); queries name them with INDEXED BY instead.
CREATE INDEX IF NOT EXISTS page_daily_lookup ON page_daily(property_id, search_type, page_id, date);
CREATE INDEX IF NOT EXISTS query_daily_lookup ON query_daily(property_id, search_type, query_id, date);
DROP INDEX IF EXISTS page_daily_page;
DROP INDEX IF EXISTS query_daily_query;
