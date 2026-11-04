---
name: task-worker
# tools: read,write,edit,bash,grep,find,ls
---

## cryptophys-cloud-platform rules (appended to the taskplane base prompt)

- Read `taskplane-tasks/CONTEXT.md` first. Its hard rules override anything else.
- Never print or commit secret values. Report a secret by name, location and `sha256[:8]` only.
- Never deploy to Cloudflare, never merge, never move funds or place trades.
- Stop at every **OWNER GATE** and at every destructive step until the PR carries the required approval (owner in writing; orchestrator `VALIDATED`).
- Before opening a PR in this repository, run the fast checks that apply to what you changed:
  - `cd workers/control-plane-shared && npm ci && npm run typecheck && npm test`
  - `shellcheck .github/scripts/*.sh`
  - `actionlint`
