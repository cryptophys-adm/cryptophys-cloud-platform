# Resource Ownership Register

Every Cloudflare resource must have an owner, purpose, environment, data classification, lifecycle, and recovery plan before production binding.

| Resource class | Initial status | Rule |
|---|---|---|
| Worker: `cryptophys-platform-api` | Defined in Git; not deployed | Dedicated Worker name; manual production deploy |
| D1 | Not provisioned | Define schema, migrations, backups, recovery, and data owner first |
| KV | Not provisioned | Define purpose, TTL, and consistency expectations |
| R2 | Not provisioned | Define purpose, lifecycle, retention, and access policy |
| Queues | Not provisioned | Define delivery semantics, retries, dead-letter strategy, and consumer |
| Durable Objects | Not provisioned | Define state model, migrations, concurrency, and alarms |
| Workflows | Not provisioned | Define idempotency, retries, timeout, and compensation behavior |
| DNS/routes/custom domains | Not configured | Require reviewed change and verified domain ownership |
| Secrets | Never stored in Git | Provision via GitHub Environment/Cloudflare secret mechanisms |

Never commit credentials or environment-specific secrets. Update this register through reviewed changes as resources are provisioned.
