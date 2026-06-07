CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  address TEXT,
  city TEXT,
  price INTEGER,
  price_text TEXT,
  price_per_m2 INTEGER,
  living_area_m2 INTEGER,
  rooms TEXT,
  bedrooms INTEGER,
  energy_label TEXT,
  build_year INTEGER,
  acceptance TEXT,
  apartment_type TEXT,
  outdoor_space TEXT,
  storage TEXT,
  service_costs TEXT,
  description TEXT,
  summary TEXT,
  photos_json TEXT,
  features_json TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_detail_fetch_at TEXT,
  last_analysis_at TEXT,
  analysis_json TEXT,
  ranking_score REAL,
  interior_score REAL,
  ready_score REAL,
  value_score REAL,
  decision TEXT,
  decision_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_last_seen_at ON listings(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_ranking_score ON listings(ranking_score);
CREATE INDEX IF NOT EXISTS idx_jobs_status_type ON jobs(status, type);
