# Pi worker guide (code tasks from TP-012)

> **Role change (owner, 2026-11-06, ADR-0009 §4).** From now on **Claude (the orchestrator session) writes and deploys the code**. **pi and agy are validators and auditors**:
> - they re-run the tests, review the diffs of Claude's merged PRs, and check production against each task's `APPROVAL.md`;
> - they report findings as a PR comment or an issue.
>
> They do not merge, deploy or push to `main` or `claude/*`. The code-worker instructions below remain for reference only.


Antigravity has run out of quota. From TP-012 onwards, the **code worker** is the **pi agent** on the VPS, running Reflection's `beam` model. Its role and rules are the same as Antigravity's:

- The orchestrator and validator is the Claude cloud session. It reviews PRs, merges them and runs every deployment.
- The owner is the repository owner.

## Read in this order (and only these, to save quota)

1. This file.
2. `taskplane-tasks/CONTEXT.md`, for the hard rules.
3. `taskplane-tasks/ANTIGRAVITY.md`, sections "Non-negotiable rules for code tasks" and "Definition of done". These apply to you word for word, with two exceptions:
   - the branch prefix is `worker/` (not `antigravity/`);
   - where it says "Antigravity", read "pi".
4. The task's `PROMPT.md`.
5. Only the source files listed in the task's **Files** and **Read first** sections.

Do not explore the rest of the repository. Every file you need is named in the task.

## How to work (quota-saving)

- **One task per PR**, in order. Start each task from the latest `main`:

  ```bash
  git fetch origin main
  ```

  ```bash
  git checkout -B worker/TP-xxx-<slug> origin/main
  ```

- **Edit narrowly.** Change only what the specification asks for. Never reformat, rename or reorder code you were not asked to touch.
- **Run tests locally before opening the PR**, and fix failures yourself. A red CI run costs a full review round.
- **Copy existing patterns rather than inventing new ones.** For example, the TP-012 code must look like the `publishAgentReport` calls that already exist in `signal-engine/src/index.ts` and `drift-detector/src/index.ts`.
- **If you are blocked for more than two attempts on the same error, stop.** Write the exact error and what you tried under `Open questions` in `STATUS.md`, push, and open the PR as a draft. The orchestrator will answer in `APPROVAL.md`.

## You never

- Deploy, run `wrangler deploy` (except `--dry-run`), `wrangler d1 execute --remote`, or make any Cloudflare API write.
- Merge, approve or close PRs, push to `main`, or push to `claude/*` branches.
- Edit `.github/workflows/*`, add npm dependencies, or edit a merged migration.
- Print or commit a secret.
- Touch `cryptophys-adm/xauusd-ai-trading-assistant`.
- Write anything that executes trades, places orders or moves funds. Everything is advisory only.

## After the PR is opened

The orchestrator replies `VALIDATED`, or `CHANGES REQUESTED` with a numbered list. Fix only the numbered items, push to the same branch, and do not open a new PR.

After the merge, the orchestrator deploys through ops-dispatch and verifies production. You are done when `APPROVAL.md` on `main` says `DEPLOYED AND VERIFIED`.
