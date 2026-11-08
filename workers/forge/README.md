# cryptophys-forge

ADR-0012 phase 1: the Cloudflare-native source of the platform, on Artifacts (`cryptophys/platform`).

| Route | Who | What |
|---|---|---|
| `GET /health`, `GET /ready` | Access | Health and readiness (`artifacts_binding`, D1 schema, Access) |
| `GET /v1/forge/status` | operators, viewers | The repo and the head of `main` |
| `GET /v1/forge/commits?limit=` | operators, viewers | History of `main` (newest first) |
| `POST /v1/forge/import` `{confirm:"IMPORT"}` | operators | One-time import of the GitHub repository; an existing repo is left alone |
| `POST /v1/forge/mirror-token` `{confirm:"MIRROR"}` | the CI service token only | 10-minute write token for the mirror workflow |

While GitHub is still the source of truth (phases 1–4), `mirror-to-forge.yml` pushes `main` to the
Artifacts repo after every push, so both hold the same commit SHAs. Deployed by `deploy-forge.yml`.
