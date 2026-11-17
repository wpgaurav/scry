-- D1 bills rows written (index updates included). Sync records what it writes per UTC day
-- so a daily budget can pause the backfill before it runs up a bill.
CREATE TABLE usage_daily (
  date TEXT PRIMARY KEY,
  rows_written INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
