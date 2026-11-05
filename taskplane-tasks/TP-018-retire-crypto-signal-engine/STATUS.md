# TP-018 status

State: complete — crypto Signal Engine source retired, migration 0020 deployed, and the Cloudflare Worker plus ingest Workflow deleted under explicit owner authorization.

## Merge and deployment record

- PR #109 removed the retired Worker from Control Plane validation and deploy matrices; merged as `8d0d0d97dcc23838610646dd54ac240df0bf5a6c`.
- PR #110 fixed cycle-time staleness evaluation; merged as `15799daefd670a15bb028a4ef089406d6b16d692`.
- TP-018 PR #108 merged by `cryptophys-adm` at 2026-11-05T13:52:53Z; merge SHA `d81ce4040ddc89e66b02656f311ba783bd5b4c2d`.
- Pre-merge validation: 117/117 endpoint/library tests passed, migration tests passed, and all seven remaining Worker dry-run bundles passed.
- Owner-dispatched Deploy Control Plane run [#42039749459](https://github.com/cryptophys-adm/cryptophys-cloud-platform/actions/runs/42039749459) succeeded. Migration 0020 applied; six Control Plane Workers were deployed and verified; the retired registry row was disabled and not probed; drift reported zero; the supervisor cycle, audit-chain verification and policy negative-decision test passed.

## Owner-authorized Cloudflare deletion

- PR #112 added the narrowly allow-listed Retire Worker workflow and removed the retired Worker from Access provisioning.
- The owner explicitly confirmed deletion on 2026-11-05.
- Retire Worker run [#42041570698](https://github.com/cryptophys-adm/cryptophys-cloud-platform/actions/runs/42041570698) ran from `main` via `workflow_dispatch`, used exact confirmation `DELETE`, and completed successfully in the `production` Environment.
- The run deleted Workflow `cryptophys-signal-ingest`, deleted Worker `cryptophys-signal-engine`, then verified the Worker settings endpoint returned HTTP 404.
- PR #113 records the deployment and deletion evidence in `APPROVAL.md`.

## Data preservation

Migration 0020 changes registry/agent state and removes the retired supervisor grant. It does not drop or delete crypto data. The owner verification record reports 4,461 historical candles plus Mizan, confluence and macro data retained in D1.

## Drift inventory reconciliation

This PR (#111) updates `.github/scripts/drift-summary.sh` and its hermetic tests to:
- exclude the disabled legacy Signal Engine from the active expected-worker set;
- ignore disabled rows for drift and stale-observation classification;
- avoid claiming every service has a desired-version pin when external XAUUSD services do not;
- report only that no drift or stale observations were found for the 12 active Worker services.

The old pre-merge failure notes and the former instruction to keep the Signal Engine in Access until deletion are historical and superseded by the completed deletion above.

## Governance

The repository's `main` branch is not protected and no rulesets are visible. This status records task execution; it does not waive independent review or repository governance for this follow-up PR.

No additional production dispatch is authorized by this status document.
