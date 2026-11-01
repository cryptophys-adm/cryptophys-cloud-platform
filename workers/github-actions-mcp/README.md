# Cryptophys GitHub Actions MCP Connector

A narrowly scoped Cloudflare Worker MCP endpoint for dispatching and monitoring only the
`Deploy Platform API` workflow in `cryptophys-adm/cryptophys-cloud-platform`.

## Tools

- `dispatch_production_deployment`: dispatches `deploy-platform-api.yml` on `main` with `confirm_production=DEPLOY`.
- `get_deployment_status`: lists recent workflow runs on `main`.
- `get_deployment_jobs`: returns job and step status for a run.

## Required secrets

Set Worker secrets outside Git and never commit them:

- `GITHUB_TOKEN`: a GitHub fine-grained PAT restricted to this repository, with Actions: Read and write, Contents: Read, and Metadata: Read. Contents read is needed for workflow access; no admin, packages, or organization permissions.
- `CONNECTOR_ACCESS_TOKEN`: a long random secret used to protect the MCP endpoint. Do not reuse the Cloudflare API token or GitHub token.

## Deployment

From this directory, with Wrangler authenticated to the intended Cloudflare account:

```sh
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put CONNECTOR_ACCESS_TOKEN
npx wrangler deploy
```

Use the intended account explicitly. Do not deploy until the two secrets are configured.

## Endpoints

- `GET /health`: liveness only; it does not prove GitHub authentication.
- `POST /mcp`: Streamable HTTP MCP JSON-RPC endpoint. Requires `Authorization: Bearer <CONNECTOR_ACCESS_TOKEN>`.

## Security notes

- The connector is hard-scoped in code to one repository and one workflow.
- Dispatch is permitted only with explicit `confirm=DEPLOY`; it always targets `main`.
- Never return token values from any tool.
- The connector does not read or change GitHub Environment secrets, repository settings, branches, or arbitrary workflows.
- GitHub's dispatch response is HTTP 204; after dispatch, call `get_deployment_status` to verify that a run actually started.
- Production deployment remains subject to the repository workflow's Environment and secret configuration.
