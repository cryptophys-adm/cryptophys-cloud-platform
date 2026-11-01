# ADR-0001: Cloudflare-native platform runtime

- **Status:** Accepted baseline
- **Date:** 2026-11-01

## Context

The platform needs an auditable source of truth and deployment path isolated from existing Cryptophys services. Kubernetes, Talos, and container-based runtime deployment are excluded.

## Decision

Use Cloudflare Workers as the initial compute target and GitHub as the source of truth. Begin with a minimal TypeScript health API and a manual, protected deployment workflow. Add storage and stateful services only after their contracts and ownership are defined.

## Consequences

- Runtime behavior must fit the Workers execution model; do not assume a general-purpose Linux host or persistent local filesystem.
- Production credentials and account-specific resource identifiers are configured outside Git.
- Initial deployment has no public route or custom domain.
- Each additional platform capability needs tests, an owner, and an ADR when it changes a material architecture boundary.
