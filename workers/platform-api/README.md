# Platform API Worker

Initial isolated Cloudflare Worker for Cryptophys Cloud Platform.

## Endpoints

- `GET /health`, `GET /healthz`
- `GET /ready`, `GET /readyz`
- `GET /`

No administrative mutation endpoints, storage bindings, secrets, custom domains, or production routes are included.

## Local development

```sh
npm install
npm run typecheck
npm run dev
```

Use the manually triggered GitHub Actions workflow for production deployment. Avoid ad hoc production deployments outside the reviewed process.
