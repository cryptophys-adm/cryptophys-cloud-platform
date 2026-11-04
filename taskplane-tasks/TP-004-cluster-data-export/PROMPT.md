# TP-004 — Export cluster data that must survive decommission (after TP-003 VALIDATED)

**Why:** some stores may hold history that is not in Cloudflare, such as Postgres application data, vector memory or ledgers. Losing it on shutdown would be irreversible.

## Steps

1. **Export.** For each store that TP-003 classified as "needs data export", take a consistent logical export: `pg_dump -Fc`, Qdrant snapshot, immudb export, or a MinIO bucket mirror.
   - Write the exports to an encrypted archive on the VPS. Use `age`, with the recipient the owner provides; the private key is never on the VPS.
   - Record per export its size, `sha256` (of the ciphertext) and a row or object count.
2. **Restore test.** Restore each export into a throwaway local container and compare the counts. Delete the throwaway afterwards.
3. **OWNER GATE: destination.** Propose where the archives live long-term. Options: a new R2 bucket created by a reviewed workflow in this repository, the owner's own storage, or deletion if the data is worthless. Do not create Cloudflare resources yourself.

**Done when:** every store flagged in TP-003 has a verified, encrypted export and the owner has chosen its destination.
