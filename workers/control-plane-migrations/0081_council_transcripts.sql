-- HAIC H1.5e, council transcripts in R2 (docs/design/HAIC-H0-H1.md §4.4 "Records"; ADR-0015 §8, long memory in R2).
--
-- Additive only: one column on councils (0079). When a council closes (decided, dismissed, aborted, expired), its
-- transcript (the messages exactly as hashed into transcript_sha256) is written once to the R2 bucket
-- cryptophys-council-transcripts at councils/<session id>.json, and transcript_key records where. NULL until stored; a
-- council whose transcript is not stored yet is retried by the kernel's hourly pass. Existing rows read NULL.
ALTER TABLE councils ADD COLUMN transcript_key TEXT CHECK (transcript_key IS NULL OR (transcript_key LIKE 'councils/cs_%.json' AND length(transcript_key) <= 64));
