# Status (October 2026)

Verified on Ubuntu 22.04 with Node 24 and Electron 43. Windows and macOS have **not** yet been tested on real machines.

## Implemented and tested

| Area | Evidence |
|---|---|
| File identification, extractors (PDF + OCR, DOCX, XLSX, PPTX, CSV, TXT, RTF, HTML, EML, images), entities, records | `packages/core/test` (32 tests including the finance engine) |
| Finance engine: duplicates, payments, comparisons, bank details, payment-redirection indicators, gaps, savings, dates, plus false-positive cases | `packages/core/test/finance.test.ts` |
| Desktop index, hybrid search, history/saved/pins, investigations persistence and exports | `apps/desktop/test` (12 tests) |
| Real Electron app: onboarding, folder authorisation, indexing, Quick Search keys, search results with locations, watcher updates, source removal, investigations, no network while searching | `apps/desktop/e2e` (8 Playwright tests) |
| Server: accounts, lockout, recovery, TOTP + recovery codes, CSRF, organisations/roles/invitations, per-source permissions and revocation, permission-filtered search/preview/download, dangerous-file refusal, credits ledger (idempotent, no overdraft), signed entitlements, signed + idempotent Paddle webhooks | `apps/server/test` (15 tests against PostgreSQL) |
| Linux packaging | AppImage and .deb built with `npm run dist:linux`. The packaged AppImage starts and creates its profile. |
| Lint and type-check | `npm run lint`, `npm run typecheck` clean |

## Implemented, needs credentials or infrastructure

- **Google sign-in**: real OAuth code + PKCE flow. Needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; until they are set it returns `not_configured`.
- **Paddle checkout and live webhooks**: code is complete and tested with signed synthetic events. Needs a Paddle sandbox account, price ids and a public HTTPS URL for webhooks.
- **Email** (verification, password reset, invitations): needs `SMTP_URL`. In development, messages go to an in-memory outbox and the server log.

## Not done yet

- **Windows installer and macOS build**: configured in `electron-builder.yml`, but not built or tested here. The Windows NSIS build needs Windows (or Wine). The macOS build needs a Mac and an Apple Developer ID for signing and notarisation. Global shortcut, tray/menu bar and "show in folder" are written for both OSes, but only exercised on Linux.
- **Code signing** for all platforms.
- **SQLCipher encryption of the local index** (see PRIVACY-SECURITY.md). Use BitLocker/FileVault meanwhile.
- **Desktop ↔ server connection**: the desktop app does not yet have a sign-in screen or company-search tab. The server API is complete and tested, and the desktop uses Free-plan features without an account.
- **Connectors** (Google Drive, OneDrive/SharePoint, Outlook/Gmail mailboxes): not built. Company sources currently accept uploaded files.
- **Server-side OCR**: company uploads of scanned PDFs are stored but not OCR'd on the server.
- **Installer size**: about 500 MB (AppImage), mostly the Electron runtime, ONNX runtime and image libraries that come with the embedding stack. Could be trimmed.
- **sprintf-js advisory** (moderate, no upstream fix; see PRIVACY-SECURITY.md).
