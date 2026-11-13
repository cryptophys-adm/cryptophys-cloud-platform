-- 0056 (owner 2026-11-13): "buatkan panel alert di menu cerebrum user ... mengaktifkan/nonaktifkan atau
-- menambah/hapus telegram alert ... cukup input chat id atau token id telegram". The owner's Telegram alert channels,
-- managed from the Cerebrum Console (Alerts page) without a deploy. Additive: a new table and one seed row.
--
-- A channel is a Telegram chat that receives the owner notices of the topics it lists. Its bot token is never
-- stored here: D1 is shared by every platform Worker, so the token lives in the AI Kernel's own Durable Object
-- (AlertVault) and this row keeps only its last four characters, for the owner to recognise it.
--
-- The seed row `alc_default` is the bot that already sends the owner's notices: the xauusd AI Worker's
-- OwnerNotifier, reached through the Service Binding OWNER_TELEGRAM (kind telegram_default, no chat id, no token).
-- It can be disabled, never deleted.
CREATE TABLE alert_channels (
  channel_id TEXT PRIMARY KEY CHECK (channel_id GLOB 'alc_*' AND length(channel_id) <= 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('telegram', 'telegram_default')),
  chat_id TEXT CHECK (chat_id IS NULL OR length(chat_id) BETWEEN 1 AND 40),
  topics_json TEXT NOT NULL CHECK (json_valid(topics_json) AND json_type(topics_json) = 'array'),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  token_hint TEXT CHECK (token_hint IS NULL OR length(token_hint) = 4),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((kind = 'telegram_default' AND chat_id IS NULL AND token_hint IS NULL) OR (kind = 'telegram' AND chat_id IS NOT NULL AND token_hint IS NOT NULL))
);

INSERT INTO alert_channels (channel_id, name, kind, chat_id, topics_json, enabled, token_hint, created_by, created_at, updated_by, updated_at)
VALUES ('alc_default', 'Owner Telegram (xauusd bot)', 'telegram_default', NULL, '["owner_attention","critical_reports","production_unhandled"]', 1, NULL,
        'migration:0056', '2026-11-13T09:30:00.000Z', 'migration:0056', '2026-11-13T09:30:00.000Z');
