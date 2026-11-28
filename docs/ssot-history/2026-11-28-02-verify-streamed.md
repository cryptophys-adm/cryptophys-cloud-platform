# SSOT review entry (moved out of line 5 on 2026-11-28)

verify streamed, 2026-11-26 (review, A2: the daily verify reads the stored bundle by range in 4 MiB pages with an 8 MiB page cache and never holds it whole; `r2_reads` counted, `verify_too_many_reads` past 900 and `verify_cpu_budget` past 240 s; bundles up to 256 MiB; verifier 4)
