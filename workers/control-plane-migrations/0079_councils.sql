-- HAIC H1.5b, Call for Councils (ADR-0017, docs/design/HAIC-H0-H1.md §4; owner answers of 2026-11-16, Q6, Q8, Q9).
--
-- Additive only. Each council's transcript lives in its Durable Object (CouncilAgent); D1 holds one index row per council:
-- its topic, state and spend, so the limits (2 open, 4 a UTC day) are counted and operators can list councils. The
-- transcript's sha256 is set when the council closes and is in the audit chain too. No message text here.

CREATE TABLE IF NOT EXISTS councils (
  session_id TEXT PRIMARY KEY CHECK (length(session_id) = 39 AND substr(session_id, 1, 3) = 'cs_'),
  side TEXT NOT NULL CHECK (side IN ('cerebrum', 'nexus')),
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK (state IN ('proposed', 'convening', 'positions', 'rebuttals', 'synthesis', 'awaiting_owner', 'decided', 'handed_off', 'dismissed', 'aborted', 'expired')),
  owner_present INTEGER NOT NULL DEFAULT 0 CHECK (owner_present IN (0, 1)),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  spent_calls INTEGER NOT NULL DEFAULT 0 CHECK (spent_calls >= 0),
  spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  reason TEXT,
  transcript_sha256 TEXT CHECK (transcript_sha256 IS NULL OR length(transcript_sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deadline TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_councils_state ON councils(state, created_at);
