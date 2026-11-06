-- Content groups: named sets of pages matched by URL path patterns.
CREATE TABLE content_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  include_patterns TEXT NOT NULL,
  exclude_patterns TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (property_id, name)
);

-- Annotations: notes on dates. property_id NULL = applies to every property.
CREATE TABLE annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER,
  date TEXT NOT NULL,
  end_date TEXT,
  title TEXT NOT NULL,
  note TEXT,
  category TEXT NOT NULL DEFAULT 'note',
  source TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT UNIQUE,
  url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX annotations_date ON annotations(date);

ALTER TABLE properties ADD COLUMN show_google_updates INTEGER NOT NULL DEFAULT 1;

-- Confirmed Google ranking updates older than the live status feed covers.
-- Newer ones are imported daily from https://status.search.google.com/incidents.json.
INSERT INTO annotations (property_id, date, end_date, title, category, source, external_id, url, created_at) VALUES
  (NULL, '2024-08-15', '2024-09-03', 'August 2024 core update', 'google', 'google', 'archive:2024-08-core', 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history', '2026-11-06'),
  (NULL, '2024-11-11', '2024-12-05', 'November 2024 core update', 'google', 'google', 'archive:2024-11-core', 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history', '2026-11-06'),
  (NULL, '2024-12-12', '2024-12-18', 'December 2024 core update', 'google', 'google', 'archive:2024-12-core', 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history', '2026-11-06'),
  (NULL, '2024-12-19', '2024-12-26', 'December 2024 spam update', 'google', 'google', 'archive:2024-12-spam', 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history', '2026-11-06'),
  (NULL, '2025-03-13', '2025-03-27', 'March 2025 core update', 'google', 'google', 'archive:2025-03-core', 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history', '2026-11-06'),
  (NULL, '2025-06-30', '2025-07-17', 'June 2025 core update', 'google', 'google', 'archive:2025-06-core', 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history', '2026-11-06'),
  (NULL, '2025-08-26', '2025-09-22', 'August 2025 spam update', 'google', 'google', 'archive:2025-08-spam', 'https://status.search.google.com/products/rGHU1u87FJnkP6W2GwMi/history', '2026-11-06');

-- Alert delivery channels. Targets (webhook URLs, addresses) are AES-GCM encrypted.
CREATE TABLE alert_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'slack', 'discord', 'teams', 'webhook')),
  name TEXT NOT NULL,
  target_ciphertext TEXT NOT NULL,
  target_iv TEXT NOT NULL,
  target_hint TEXT NOT NULL,
  secret_ciphertext TEXT,
  secret_iv TEXT,
  created_at TEXT NOT NULL,
  last_sent_at TEXT,
  last_error TEXT
);

-- Alert rules. property_id NULL = every property.
CREATE TABLE alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER,
  kind TEXT NOT NULL,
  threshold REAL,
  params TEXT NOT NULL DEFAULT '{}',
  channels TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_checked_at TEXT
);

-- Fired alerts. fingerprint de-duplicates the same problem across runs.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER,
  property_id INTEGER,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL DEFAULT 'warning',
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  link TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  delivered_at TEXT
);
CREATE INDEX alerts_status ON alerts(status, created_at);
