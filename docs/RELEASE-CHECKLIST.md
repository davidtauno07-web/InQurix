# Release checklist

1. Bump `version` in `apps/desktop/package.json` and `apps/server/package.json`.
2. `npm ci`, then lint, type-check and all tests (core, desktop, server). See `DEVELOPMENT.md`.
3. `npm run fixtures && npm run build:core`, then `cd apps/desktop && npm run build && npx playwright test`.
4. Build installers on each target OS: Windows `npx electron-builder --win nsis`, macOS `--mac dmg zip`, Linux `--linux AppImage deb`.
5. Sign: Windows Authenticode certificate. macOS Developer ID certificate, hardened runtime and notarisation (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
6. Manual smoke test on a clean Windows and macOS machine, using the synthetic fixtures only:
   - [ ] A: authorise a folder → index → global shortcut → natural-language search → open the original
   - [ ] B: search `INV-1048` / `14,317.50` → source location shown → open the record → related documents
   - [ ] C: duplicate-invoice investigation shows grouped candidates and their differences
   - [ ] D: invoice-vs-PO comparison shows calculations and unresolved items
   - [ ] E: disconnect the network → Quick Search still works
   - [ ] F: server: two users with different grants → revoke one → their results disappear
   - [ ] G: edit, then delete, an indexed file → results update
   - [ ] H: shortcut from another app focuses Quick Search; Enter opens; Ctrl/⌘+Enter reveals the file
   - [ ] Exports contain no word "fraud"; findings are cautious
7. Server: `npx prisma migrate deploy` → deploy → check the Paddle webhook signature with a sandbox event → switch the Paddle keys to live.
8. Update `STATUS.md` (known limitations and the incomplete-work register).
