# TP-023 status

State: done

Branch `worker/TP-023-console-worker` from `origin/main` at `13d2868`. The code was written by the agy worker and validated by the orchestrator. An independent pi-written suite was also run against it (10/10 after correcting that suite's missing CSRF headers in criterion 8). The pi suite is not committed.

## Evidence

Run from `workers/control-plane-shared` on the committed tree, one command at a time. Output tails as observed.

### `npm run typecheck`

```

> @cryptophys/control-plane@1.0.0 typecheck
> tsc --noEmit -p ../control-plane-tsconfig.json

typecheck exit=0
```

### `npm test` (baseline on `13d2868`: 143 tests)

```
ok 71 - 1. access: no JWT and outsiders are denied without a forward; operators get the shell with the exact CSP
ok 72 - 2. whoami: operator is not an approver, a dual identity is, and the actor is lower-case
ok 73 - 3. allow-list: every row forwards to the right binding; everything else is 404 not_allowed
ok 74 - 4. path safety: dot segments, percent escapes and over-long segments are 400 invalid_path
ok 75 - 5. csrf: a POST without Origin, with a foreign Origin or without the custom header is 403 csrf
ok 76 - 6. header hygiene: only the JWT is forwarded, set-cookie is dropped, the GET query passes and is capped
ok 77 - 7. bodies and failures: >32 KiB is 413, non-JSON is 415, a throwing or missing binding is 502 upstream_unavailable
ok 78 - 8. identity is preserved end to end through the real recovery-manager Worker
ok 79 - 9. health and ready: health matches the deploy filter fields; ready is 200, and 503 without APPROVER_IDENTITIES
ok 80 - 10. no regressions: the allow-list holds exactly the specified rows (typecheck, test count and dry-run are verified by commands)
1..153
# tests 153
# suites 0
# pass 153
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 34209.857553
test exit=0
```

### `npx wrangler deploy --dry-run --config ../console/wrangler.toml --outdir /tmp/dry-console`

```
 ⛅️ wrangler 4.156.2
────────────────────
Total Upload: 17.82 KiB / gzip: 6.00 KiB
Your Worker has access to the following bindings:
Binding                                                            Resource                     
env.KERNEL (cryptophys-ai-kernel)                                  Worker                       
env.RECOVERY (cryptophys-recovery-manager)                         Worker                       
env.REGISTRY (cryptophys-platform-registry)                        Worker                       
env.POLICY (cryptophys-policy-engine)                              Worker                       
env.DRIFT (cryptophys-drift-detector)                              Worker                       
env.AUDIT (cryptophys-audit-ledger)                                Worker                       
env.ORCHESTRATOR (cryptophys-deployment-orchestrator)              Worker                       
env.PLATFORM (cryptophys-platform-api)                             Worker                       
env.CF_VERSION_METADATA                                            Worker Version Metadata      
env.SERVICE_NAME ("cryptophys-console")                            Environment Variable         
env.SERVICE_ENVIRONMENT ("production")                             Environment Variable         
env.API_CONTRACT_VERSION ("v1")                                    Environment Variable         

--dry-run: exiting now.
dry-run exit=0
```

## Changes

- `workers/console/` (new): `wrangler.toml`, `package.json`, `tsconfig.json` (same as platform-api's), `README.md`, `src/index.ts`, `src/worker.ts`, `src/ui.ts`.
  - `CONSOLE_ALLOW_LIST` (exported) holds exactly the 33 rows of PROMPT §3. The kernel `/mcp`, the audit `POST /v1/events` and the targets' `/health`, `/ready` and `/` are not forwarded.
  - Every request except `/health` and `/ready` goes through `requireOperator`. `/health` and `/ready` use `accessGate`.
  - Path safety (segment regex, no `.`, `..` or `%`) is checked before routing. CSRF (same-origin `Origin` plus `x-cryptophys-console: 1`) is checked before forwarding. Bodies: JSON only, at most `MAX_BODY_BYTES`.
  - The forwarded request carries only `cf-access-jwt-assertion`, plus `content-type` when there is a body. The response headers are replaced; upstream `set-cookie` is dropped.
  - One `console_forward` log line per forward, carrying `route` = the allow-list pattern. No JWT, actor, body or query is logged.
  - Security headers go on every response, and the exact CSP on the HTML.
  - The shell UI has no dependencies, no CDN, no inline script or style, and uses `textContent` only. A shared `api()` helper; no action buttons.
- `workers/control-plane-tsconfig.json`: added `"console/src/**/*.ts"` to `include`.
- `workers/control-plane-shared/test/console-tp023.test.ts` (new): 10 tests, one per criterion. Criterion 8 runs the real `recovery-manager` Worker on a migrated `FakeD1`.
- `docs/OPERATIONS.md`: added a "Console" paragraph.
- No npm dependency added. Nothing deployed (dry-run only).
- Revert: revert the commit; the Console is not deployed.

## Open questions

- None. Note: the GET query limit counts the leading `?` (`url.search.length > 512`), so the effective limit is 511 characters after `?`.
