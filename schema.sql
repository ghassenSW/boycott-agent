-- Boycott Agent — Postgres schema
-- Run this ONCE against your database before importing the workflows.

CREATE TABLE IF NOT EXISTS brand_boycott_status (
  id               SERIAL PRIMARY KEY,
  brand_name       TEXT        NOT NULL,          -- original casing as first seen, e.g. "Coca-Cola"
  brand_normalized TEXT        NOT NULL UNIQUE,   -- lowercased/trimmed key, e.g. "coca-cola"
  status           TEXT,                          -- active_boycott | no_evidence | unclear
  confidence       INTEGER,                       -- 0-100  (Option A: confidence an active boycott exists)
  reason           TEXT,                          -- short neutral summary of WHY
  who_is_calling   TEXT,                          -- who is calling for the boycott
  recency          TEXT,                          -- human-readable recency of newest source
  sources          JSONB,                         -- [{ "title": "...", "url": "...", "date": "..." }]
  notes            TEXT,                          -- caveat text (what the % means / does not mean)
  last_checked     TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- Fast lookups by the normalized key.
CREATE INDEX IF NOT EXISTS idx_brand_normalized ON brand_boycott_status (brand_normalized);

-- Optional: seed a few brands so the refresher has something to update on day one.
-- (The live-lookup API will also auto-insert any new brand people query.)
-- INSERT INTO brand_boycott_status (brand_name, brand_normalized, last_checked)
-- VALUES ('Coca-Cola','coca-cola', now() - interval '30 days'),
--        ('Nike','nike', now() - interval '30 days')
-- ON CONFLICT (brand_normalized) DO NOTHING;
