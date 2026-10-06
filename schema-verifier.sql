-- Boycott Agent — Verifier table (Agent 2)
-- Run this ONCE, in addition to schema.sql.

CREATE TABLE IF NOT EXISTS link_verifications (
  id                  SERIAL PRIMARY KEY,

  -- inputs
  url                 TEXT NOT NULL,
  product             TEXT NOT NULL,
  cause               TEXT NOT NULL,
  cache_key           TEXT NOT NULL UNIQUE,   -- url|product|cause (normalized) — the dedupe key

  -- availability
  available           BOOLEAN,                -- was the page reachable AND readable?
  availability_note   TEXT,                   -- why not, if unavailable
  domain              TEXT,
  content_length      INTEGER,

  -- verification result
  verdict             TEXT,                   -- verified | weak_support | unrelated | contradicts_claim | unreachable
  support_strength    INTEGER,                -- 0-100: how strongly the page backs THIS product + THIS cause
  credibility         INTEGER,                -- 0-100: hybrid (code base from domain/metadata + LLM adjustment)
  credibility_base    INTEGER,                -- the deterministic part, kept for transparency
  credibility_adjust  INTEGER,                -- the LLM's bounded nudge (-15..+15)
  credibility_reason  TEXT,
  mentions_product    BOOLEAN,
  mentions_cause      BOOLEAN,
  content_type        TEXT,                   -- news_report | opinion | activist_campaign | social_post | ...
  summary             TEXT,
  evidence            JSONB,                  -- ["short verbatim quote", ...] — validated to exist in the page
  evidence_dropped    INTEGER,                -- how many quotes were discarded as not found in the page
  notes               TEXT,

  checked_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_verifications_key    ON link_verifications (cache_key);
CREATE INDEX IF NOT EXISTS idx_link_verifications_domain ON link_verifications (domain);
