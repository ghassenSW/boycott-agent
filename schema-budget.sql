-- Boycott Agent — spending counters (global budget across every website key).
-- Kept in the database so a restart can never "forget" what was already spent.

CREATE TABLE IF NOT EXISTS api_budget (
  period    TEXT    NOT NULL,          -- 'day:2026-10-06' or 'month:2026-10' (UTC)
  resource  TEXT    NOT NULL,          -- 'tavily_credits' | 'llm_calls'
  used      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period, resource)
);
