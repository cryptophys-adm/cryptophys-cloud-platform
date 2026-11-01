# Cryptophys Cloud Platform

Canonical source of truth for the Cloudflare-native Cryptophys platform.

## Repository contract

- Architecture baseline: architecture/BASELINE.md
- Security baseline: architecture/SECURITY.md
- Resource ownership: architecture/RESOURCE-OWNERSHIP.md
- Deployment runbook: docs/DEPLOYMENT.md
- Operations runbook: docs/OPERATIONS.md
- Initial Worker: workers/platform-api/

Git is the source of truth for platform design and code. This repository contains no production secrets. Merging code does not deploy production infrastructure; production deployment is manually triggered and gated by the GitHub production Environment.

## Implemented in this revision

- Initial architecture and security baselines.
- Dedicated TypeScript Cloudflare Worker named cryptophys-platform-api.
- Health/readiness API routes.
- Pull-request/push validation workflow.
- Manually triggered production deployment workflow.
- Deployment and incident runbooks.
- Dependabot configuration.

## Not yet provisioned or implemented

D1, KV, R2, Queues, Durable Objects, Workflows, custom domains, DNS, identity/authentication, administrative mutation endpoints, and the remaining control-plane services are not provisioned by this revision. Add them in reviewed increments with explicit ownership, account-specific configuration, tests, and recovery plans. No production deployment has been performed by these commits.
