# Cryptophys Cloud Platform

> **Read first.** The canonical repository is `cryptophys/platform` on Cloudflare Artifacts (the Forge, ADR-0012).
> A copy anywhere else, including GitHub, is a mirror that can be days behind; it merges nothing and deploys nothing.
> What runs where today is in [`docs/SSOT.md`](docs/SSOT.md). Rules for agents are in [`AGENTS.md`](AGENTS.md).
> **Never deploy from a checkout** (no `wrangler deploy`, no `wrangler secret put`): platform Workers are deployed
> only by consensus through the Deployment Orchestrator, or by the owner's break-glass plan
> ([`docs/OPERATIONS.md`](docs/OPERATIONS.md)). A code upload from anywhere else is detected as an
> out-of-band deploy and raised to the owner (incident 2026-11-21).

The Cloudflare-native platform that runs, observes and governs the Cryptophys Workers.

## Where to read

| Question | Page |
|---|---|
| Which Workers, data stores, crons and agents exist today | [`docs/SSOT.md`](docs/SSOT.md) |
| Why it is built this way | [`architecture/adr/`](architecture/adr/README.md) (index, with each ADR's progress manifest) |
| How a change reaches `main` and production | `docs/SSOT.md`, section "Source, CI and deploy (ADR-0012)", and `AGENTS.md` |
| Operating it, break-glass, recovery | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) |
| Every Worker's capability and endpoints | [`docs/CONTROL-PLANE-WORKERS.md`](docs/CONTROL-PLANE-WORKERS.md) |
| The AI requirement for every platform Worker | [`architecture/AI-ENGINE-REQUIREMENT.md`](architecture/AI-ENGINE-REQUIREMENT.md) |

The baseline documents of early November (`architecture/BASELINE.md`, `SECURITY.md`, `STATE-AND-RECOVERY.md`,
`RESOURCE-OWNERSHIP.md`, `docs/DEPLOYMENT.md`, `docs/CONTROL-PLANE-DEPLOYMENT.md`,
`docs/POST-DEPLOYMENT-VERIFICATION.md`) are kept as history. Each one says at its top where it is
superseded. When they disagree with `docs/SSOT.md`, `docs/SSOT.md` is right.

## Contributing

Push a `claude/…`, `agent/…` or `cr/…` branch, based on the current canonical `main`, to the work repository
`cryptophys/platform-work`. The Forge checks it, the agents' council merges it (a guard path waits for the
owner's click), and the agents deploy it. Nobody merges or deploys by hand. Details: `AGENTS.md`.

This repository contains no production secrets.
