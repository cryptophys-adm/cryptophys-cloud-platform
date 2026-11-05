# TP-025 status

State: done

## Who wrote what

- `workers/home/wrangler.toml`, `package.json`, `tsconfig.json`, `README.md`: pi.
- `workers/home/src/index.ts`, `src/worker.ts`, `src/ui.ts`, `src/ui/css.ts`, `src/ui/app-js.ts`: pi.
- `workers/control-plane-tsconfig.json`: pi.
- `workers/control-plane-shared/test/home-tp025.test.ts`: pi.
- `taskplane-tasks/TP-025-cerebrum-home/STATUS.md`: pi.

## Evidence

- `npm run typecheck`: completed, no errors.
- `npm test`: 176 tests, 176 pass, 0 fail, 0 skipped, 0 todo.
- `npx wrangler deploy --dry-run --config ../home/wrangler.toml --outdir /tmp/dry-home`: Total Upload 16.91 KiB / gzip 5.82 KiB.

## Changes

- Added new Worker `cryptophys-home` (Cerebrum) with PLATFORM binding.
- Fixed CHANGES REQUESTED items: wrapped overview reading, latest_critical, layout, error banner format, dead code, wrangler comment, STATUS accuracy.
- Added test for wrapped overview formatter.

## Open questions

- None.
