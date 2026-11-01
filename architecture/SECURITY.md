# Security Baseline

- Use a dedicated Cloudflare API token scoped to the minimum permissions required for this repository's deployment.
- Store `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Environment secrets in a protected environment named `production`.
- Never use Global API Keys, personal access tokens, or secrets from existing Cryptophys projects.
- Require review for changes to `.github/workflows/`, Worker configuration, authentication, authorization, bindings, and deployment scripts.
- Keep production deployment manual and environment-gated. Configure required reviewers in GitHub Environment settings.
- Do not expose administrative operations in the initial API. Add authentication, authorization, audit events, rate limiting, and abuse controls before mutation endpoints.
- Never log secrets, authorization headers, full tokens, or user payloads by default.
- Pin GitHub Actions to immutable commit SHAs before production hardening.
- Enable repository secret scanning, push protection, Dependabot alerts, and branch protection in GitHub settings.
- If a secret is exposed, revoke/rotate it at the issuer; deleting Git history alone is insufficient.
