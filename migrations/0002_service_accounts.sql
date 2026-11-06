-- Service accounts uploaded from Settings. The JSON key is AES-GCM encrypted with
-- the SA_ENCRYPTION_KEY Worker secret; only client_email and metadata are plain.
CREATE TABLE service_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_email TEXT NOT NULL UNIQUE,
  project_id TEXT,
  private_key_id TEXT,
  key_ciphertext TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT
);

-- NULL = use the GSC_SA_KEY secret (the original single-account setup).
ALTER TABLE properties ADD COLUMN service_account_id INTEGER REFERENCES service_accounts(id);
