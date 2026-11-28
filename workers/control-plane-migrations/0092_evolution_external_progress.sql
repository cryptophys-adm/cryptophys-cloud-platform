-- 0092 (Issue #327 C2; owner 2026-11-28: "Ya Kerjakan", on "jadikan autonomous hasil council dikirim ke cerebrum untuk
-- ditindak lanjut ... harus selalu segar ada umur kadaluarsa dan ada arsip beserta statusnya"): who works an external
-- evolution intent, and until when it stays fresh. ADR-0014 §11, ADR-0018 X1 amendment 2026-11-28.
--
-- Additive only: two nullable columns on evolution_intents_v2. The state CHECK of 0077 is not rebuilt (a rebuild is
-- destructive and the table has two foreign keys onto it), so:
--   - queued_external is a waiting_external intent with an assignee (the council task's worker, e.g. xauusd-worker);
--   - why an intent ended is close_code, machine-readable (state_reason stays the human text): owner_closed (CT1),
--     expired (no progress in time; the return-path row says "expired"), refused, completed (closed after deployed).
--     NULL while the intent is open.
--   assignee: the worker that does the external task, or NULL (nobody assigned; the owner assigns or closes).
--   expires_at: when an intent whose worker owes the next step (queued_external, in_progress) returns to the council
--     (7 days after its last real change); NULL never expires. Existing rows stay NULL, so nothing old expires here.
ALTER TABLE evolution_intents_v2 ADD COLUMN assignee TEXT CHECK (assignee IS NULL OR (length(assignee) BETWEEN 1 AND 80));
ALTER TABLE evolution_intents_v2 ADD COLUMN expires_at TEXT CHECK (expires_at IS NULL OR length(expires_at) = 24);
ALTER TABLE evolution_intents_v2 ADD COLUMN close_code TEXT CHECK (close_code IS NULL OR close_code IN ('owner_closed', 'expired', 'refused', 'completed'));
CREATE INDEX IF NOT EXISTS idx_evolution_intents_v2_expiry ON evolution_intents_v2 (expires_at) WHERE expires_at IS NOT NULL;
