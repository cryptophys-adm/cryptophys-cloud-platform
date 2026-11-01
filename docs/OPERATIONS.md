# Operations

## Health checks

- GET /health or /healthz: process-level health metadata.
- GET /ready or /readyz: readiness; currently no external dependencies.
- GET /: service metadata and implemented endpoints.
- Unsupported paths return JSON 404; non-GET/HEAD methods return JSON 405.

## Incident handling

1. Restrict the GitHub production Environment if further deployments must be paused.
2. Inspect the GitHub Actions run, commit SHA, and Cloudflare Worker logs.
3. Revert through a reviewed commit and deploy manually; do not use force-push as routine rollback.
4. If a token or secret is exposed, revoke/rotate it at its issuer immediately.
5. Record the timeline, impact, mitigation, and follow-up work in a reviewed document or issue.

## Recovery posture

The first release has no durable platform data store. Once durable resources are introduced, define backup/export cadence, retention, restore verification, RPO/RTO, and ownership before declaring the platform production-ready.
