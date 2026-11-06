-- Key/value app settings (branding and future preferences). Binary assets live in KV.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
