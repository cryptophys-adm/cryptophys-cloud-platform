# SSOT review entry (moved out of line 5 on 2026-11-26)

git backup streamed, 2026-11-26 (review: main's pack passed 32 MiB; the backup streams to an R2 multipart upload with incremental hashes, and the verify refuses a bundle over 40 MiB as `bundle_too_large_to_verify`)
