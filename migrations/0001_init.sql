-- Search Console properties this deployment tracks.
CREATE TABLE properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_url TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  search_types TEXT NOT NULL DEFAULT 'web',
  brand_terms TEXT NOT NULL DEFAULT '[]',
  inspection_budget INTEGER NOT NULL DEFAULT 500,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dimension tables. ids are a deterministic 53-bit hash of (property, text),
-- so sync never needs a lookup round trip.
CREATE TABLE pages (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL,
  url TEXT NOT NULL
);
CREATE INDEX pages_property ON pages(property_id);

CREATE TABLE queries (
  id INTEGER PRIMARY KEY,
  property_id INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX queries_property ON queries(property_id);

-- Fact tables. pos_sum = position * impressions so averages re-aggregate correctly.
CREATE TABLE daily_totals (
  property_id INTEGER NOT NULL,
  search_type TEXT NOT NULL,
  date TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  pos_sum REAL NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (property_id, search_type, date)
) WITHOUT ROWID;

CREATE TABLE page_daily (
  property_id INTEGER NOT NULL,
  search_type TEXT NOT NULL,
  date TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  pos_sum REAL NOT NULL,
  PRIMARY KEY (property_id, search_type, date, page_id)
) WITHOUT ROWID;
CREATE INDEX page_daily_page ON page_daily(property_id, page_id, date);

CREATE TABLE query_daily (
  property_id INTEGER NOT NULL,
  search_type TEXT NOT NULL,
  date TEXT NOT NULL,
  query_id INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  pos_sum REAL NOT NULL,
  PRIMARY KEY (property_id, search_type, date, query_id)
) WITHOUT ROWID;
CREATE INDEX query_daily_query ON query_daily(property_id, query_id, date);

CREATE TABLE query_page_daily (
  property_id INTEGER NOT NULL,
  search_type TEXT NOT NULL,
  date TEXT NOT NULL,
  query_id INTEGER NOT NULL,
  page_id INTEGER NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  pos_sum REAL NOT NULL,
  PRIMARY KEY (property_id, search_type, date, query_id, page_id)
) WITHOUT ROWID;
CREATE INDEX qpd_page ON query_page_daily(property_id, page_id, date);
CREATE INDEX qpd_query ON query_page_daily(property_id, query_id, date);

-- country, device and searchAppearance breakdowns.
CREATE TABLE dim_daily (
  property_id INTEGER NOT NULL,
  search_type TEXT NOT NULL,
  date TEXT NOT NULL,
  dim TEXT NOT NULL,
  value TEXT NOT NULL,
  clicks INTEGER NOT NULL,
  impressions INTEGER NOT NULL,
  pos_sum REAL NOT NULL,
  PRIMARY KEY (property_id, search_type, date, dim, value)
) WITHOUT ROWID;

CREATE TABLE sync_jobs (
  property_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  search_type TEXT NOT NULL,
  data_state TEXT NOT NULL,
  status TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (property_id, search_type, data_state, date)
) WITHOUT ROWID;

-- Latest URL Inspection result per page, with the previous state for change alerts.
CREATE TABLE url_inspections (
  property_id INTEGER NOT NULL,
  page_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  verdict TEXT,
  coverage_state TEXT,
  indexing_state TEXT,
  page_fetch_state TEXT,
  robots_state TEXT,
  last_crawl_time TEXT,
  crawled_as TEXT,
  google_canonical TEXT,
  user_canonical TEXT,
  rich_results TEXT,
  inspection_link TEXT,
  prev_verdict TEXT,
  prev_coverage_state TEXT,
  changed_at TEXT,
  PRIMARY KEY (property_id, page_id)
) WITHOUT ROWID;
CREATE INDEX url_inspections_checked ON url_inspections(property_id, checked_at);

CREATE TABLE sitemaps (
  property_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  type TEXT,
  is_index INTEGER,
  is_pending INTEGER,
  last_submitted TEXT,
  last_downloaded TEXT,
  warnings INTEGER,
  errors INTEGER,
  submitted INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (property_id, path)
) WITHOUT ROWID;

-- Keyword groups: a rank tracker without a quota.
CREATE TABLE keyword_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (property_id, name)
);

CREATE TABLE keyword_group_terms (
  group_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  match TEXT NOT NULL DEFAULT 'exact',
  query_id INTEGER,
  PRIMARY KEY (group_id, term, match)
) WITHOUT ROWID;

CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
