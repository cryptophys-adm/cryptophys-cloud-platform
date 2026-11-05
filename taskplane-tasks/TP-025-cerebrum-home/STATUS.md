# TP-025 status

State: done

## Who wrote what

- `workers/home/wrangler.toml`, `package.json`, `tsconfig.json`, `README.md`: pi.
- `workers/home/src/index.ts`, `src/worker.ts`, `src/ui.ts`, `src/ui/css.ts`, `src/ui/app-js.ts`: pi.
- `workers/control-plane-tsconfig.json`: pi (added home include).
- `workers/control-plane-shared/test/home-tp025.test.ts`: pi.
- `docs/OPERATIONS.md`: pi.
- `taskplane-tasks/TP-025-cerebrum-home/STATUS.md`: pi.

## Evidence

- `npm run typecheck`: completed, no errors.
- `npm test`: 175 tests, 175 pass, 0 fail, 0 skipped, 0 todo.
- `npx wrangler deploy --dry-run --config ../home/wrangler.toml --outdir /tmp/dry-home`: Total Upload 15.25 KiB / gzip 5.22 KiB.

## Changes

- Added new Worker `cryptophys-home` (Cerebrum) with PLATFORM binding.
- Read-only portal with navigation and platform status.
- Added 8 tests in home-tp025.test.ts.

## Open questions

- None.
