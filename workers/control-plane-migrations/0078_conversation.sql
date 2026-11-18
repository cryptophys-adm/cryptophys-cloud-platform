-- HAIC H1b, "Ask the organism" (ADR-0017 H1, docs/design/HAIC-H0-H1.md §3; owner answers of 2026-11-16, Q1–Q4).
--
-- Additive only. The chat's turns live in each conversation's Durable Object (ConversationAgent); D1 holds only:
--   conversation_controls  the chat's own switch (Q3: the agents' kill switch does not stop it). kernel_controls admits
--                          only agents_enabled in its CHECK, and widening that is a table rebuild, so this is its own table.
--                          On from this migration: the owner approved the H1 design, only owners can chat, and the turn
--                          budget below bounds the cost.
--   conversation_budget    the turns used per UTC day, against CHAT_DAILY_TURN_LIMIT (Q2: 40, apart from ai_usage's cap).
--   conversations          each conversation's owner, turn count and how many cited numbers the post-check stripped. No
--                          question or answer text: that stays in the Durable Object, and the audit chain holds hashes.

CREATE TABLE IF NOT EXISTS conversation_controls (
  control TEXT PRIMARY KEY CHECK (control IN ('enabled')),
  value TEXT NOT NULL CHECK (value IN ('0', '1')),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO conversation_controls (control, value, updated_by, updated_at)
  VALUES ('enabled', '1', 'migration:0078', '2026-11-18T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS conversation_budget (
  day TEXT PRIMARY KEY CHECK (length(day) = 10),
  turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0)
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY CHECK (length(conversation_id) = 20 AND substr(conversation_id, 1, 4) = 'cnv_'),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  turns INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
  stripped INTEGER NOT NULL DEFAULT 0 CHECK (stripped >= 0),
  last_status TEXT CHECK (last_status IS NULL OR last_status IN ('answered', 'refused', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_actor ON conversations(actor, updated_at);
