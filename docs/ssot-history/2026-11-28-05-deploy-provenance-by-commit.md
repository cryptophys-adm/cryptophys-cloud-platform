# SSOT review entry (moved out of line 5 on 2026-11-28)

deploy provenance by commit, 2026-11-27 (review, after the Forge's workflow deploy of 0754003 was recorded as a code upload at 00:40 UTC: a deploy request without a `version_tag`, as a consensus deploy through the unit's GitHub workflow records it, is trusted by its requested commit's first 12 characters, and a request for one Worker of a deploy unit covers every Worker of that unit (`platformTags` in `provenance.ts`); only an approved, running or succeeded request counts, by either tag; the 48 h window is unchanged)
