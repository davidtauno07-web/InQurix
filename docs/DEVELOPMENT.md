# Development

## Layout and commands

Run everything from the repository root; npm workspaces link the packages, so there is **one** `npm ci` for the whole repo.

| Command | What it does |
|---|---|
| `npm run build:core` | Compiles `packages/core` (the desktop and server import its `dist/`) |
| `npm run typecheck` | Type-checks all packages |
| `npm run lint` | ESLint for the whole repo |
| `npm test` | Unit/integration tests (core, desktop, server; the server needs `TEST_DATABASE_URL`) |
| `npm run fixtures` | Regenerates the synthetic test documents in `fixtures/out` |
| `npm run e2e -w @inqurix/desktop` | Builds and drives the real Electron app with Playwright |
| `npm run dev:desktop` / `npm run dev:server` | Development mode |

## Server database

The server uses PostgreSQL through Prisma. Point `DATABASE_URL` in `.env` at your own database:

```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/inqurix?schema=public"
```

`npm run db:migrate -w @inqurix/server` applies `apps/server/prisma/migrations`. During development, change `schema.prisma`, then run `npm run db:migrate:dev -w @inqurix/server -- --name <change>`.

**Server tests wipe their database.** They refuse to run unless `TEST_DATABASE_URL` points to a separate, disposable database:

```powershell
psql -U postgres -c "CREATE DATABASE inqurix_test"
# add to .env:
# TEST_DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/inqurix_test?schema=public"
$env:DATABASE_URL=(Select-String -Path .env -Pattern '^TEST_DATABASE_URL=(.*)$').Matches.Groups[1].Value.Trim('"'); npm run db:migrate -w @inqurix/server
npm test -w @inqurix/server
```

## Desktop

- The search model (`Xenova/all-MiniLM-L6-v2`, quantised ONNX) is downloaded once by `npm run models -w @inqurix/desktop` into `apps/desktop/resources/models` (git-ignored) and bundled into installers. Without it, search still works but meaning-based search is turned off.
- OCR uses Tesseract.js with the English model fetched into the same folder.
- `INQURIX_USER_DATA=<dir>` runs the app with a separate profile (used by the E2E tests).

## Packaging

| Target | Command | Where it can be built |
|---|---|---|
| Windows installer (NSIS, x64) | `npm run dist:win -w @inqurix/desktop` | Windows; or Linux with Wine |
| Linux AppImage + .deb | `npm run dist:linux -w @inqurix/desktop` | Linux |
| macOS dmg + zip | `npm run dist:mac -w @inqurix/desktop` | **macOS only** (signing and notarisation need an Apple Developer ID) |

Output goes to `apps/desktop/release/`. The configuration is in `apps/desktop/electron-builder.yml`. Code signing is not configured yet: unsigned Windows builds show a SmartScreen warning, and unsigned macOS builds are blocked by Gatekeeper.

## Releasing

1. Update the versions in `apps/desktop/package.json`.
2. Run `npm run lint && npm run typecheck && npm test && npm run e2e -w @inqurix/desktop`.
3. Build installers on each OS (or in CI runners for each OS), sign them, and publish them.
4. Deploy the server: `npm ci && npm run build && npm run db:migrate -w @inqurix/server && npm start -w @inqurix/server` behind HTTPS (set `APP_URL` to the https origin so cookies are marked `Secure`).

### Cross-building the Windows installer on Linux
This needs `wine64` installed, plus the Windows `sharp` binary: `npm install --no-save --force @img/sharp-win32-x64@<installed sharp version>`. Then run `cd apps/desktop && npx electron-builder --win nsis --x64`. The resulting `release/InQurix-Setup-<version>.exe` is unsigned, and the installer built this way has not been run on real Windows.
