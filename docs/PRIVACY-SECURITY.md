# Privacy and security

## What stays on your computer

- **Documents and their extracted text never leave the computer** in the desktop app. Indexing, search, meaning-based search (local MiniLM model), OCR and investigations all run locally. The desktop app makes no network requests while searching or investigating; the E2E suite checks this.
- InQurix only indexes folders **you explicitly authorise**. It never scans the whole computer. You can pause indexing, exclude paths, or remove a folder, and removing a folder deletes its index entries.
- Search history can be turned off or cleared in Settings.
- The company server only receives documents that a user deliberately uploads to a shared company source.

## The local index

- Stored in the app's user-data folder (`%APPDATA%\InQurix` on Windows, `~/Library/Application Support/InQurix` on macOS) as a SQLite database, readable only by your OS account (`0600` where supported).
- **It is not separately encrypted yet.** SQLCipher was deferred because it must be compiled natively for each Electron/OS target. Until it is added, use full-disk encryption (BitLocker on Windows, FileVault on macOS), which protects the index and your original files alike.

## Handling untrusted documents

- Files are identified by their **content**, not just their extension; a mismatch is flagged.
- Executables, scripts and macro-enabled Office files (`.exe`, `.dll`, `.js`, `.docm`, `.xlsm`…) are refused and never parsed.
- No macros, scripts or embedded active content are ever executed. HTML and email bodies are converted to text, and remote content is never loaded.
- Per-file limits apply to size, page count, extracted text, ZIP entry count and total uncompressed size (zip-bomb protection), plus a parsing timeout. Encrypted or corrupt files get a clear status instead of crashing the indexer.
- Extraction runs in a separate background process from the window, so a parser crash cannot take down the UI.
- Extracted text is treated as untrusted data: snippets are rendered as text nodes, never as HTML.

## Desktop app hardening

- Renderer: `contextIsolation`, `sandbox`, no `nodeIntegration`, and a strict Content-Security-Policy (no remote scripts and no remote connections).
- The preload exposes a fixed allowlist of IPC channels; the main process validates every argument (ids, paths inside authorised folders, investigation types).
- Only `https:` links open externally. Files open with the OS default handler.
- CSV exports neutralise spreadsheet formulas (cells starting with `= + - @`).

## Server

- Passwords: Argon2id. Sessions: random 256-bit tokens; only their SHA-256 is stored. HttpOnly, SameSite=Lax cookies (`Secure` when `APP_URL` is https) or a Bearer token for the desktop app.
- Cookie-authenticated state changes must come from the app's own origin (CSRF protection).
- Login lockout after repeated failures, rate limits on login/registration/email endpoints, and identical messages for unknown accounts (no account enumeration).
- Email verification, single-use 1-hour password-reset links (a reset signs out all sessions), optional TOTP two-factor with ten one-time recovery codes (TOTP seeds encrypted with AES-256-GCM).
- Google sign-in uses the authorisation-code flow with PKCE, a state cookie and ID-token verification against Google's keys.
- **Permissions are checked on every search, preview and download, in the database query itself.** Search only ever queries sources the user can read. Revoking a grant or removing a member takes effect on the next request. Owners and admins *manage* sources, but they only *read* a source's contents if it is open to all members, they created it, or they were granted access.
- Unknown and forbidden resources both return 404, so ids cannot be probed.
- Audit log of sign-ins, permission changes, uploads, previews and downloads.
- Paddle webhooks: HMAC-SHA256 signature check with a 5-minute timestamp window, stored event ids (idempotent), and out-of-order events ignored.

## Dependency audit (October 2026)

`npm audit --omit=dev` findings and their handling:

| Package | Issue | Status |
|---|---|---|
| sharp < 0.35 (via @huggingface/transformers) | libvips/libheif CVEs | Overridden to sharp ^0.35.5. InQurix does not pass images to sharp; OCR uses Tesseract. |
| uuid < 11.1.1 (via exceljs) | buffer bounds check in v3/v5/v6 | Overridden to ^11.1.1. exceljs only uses v4. |
| deepmerge-ts < 8 (via Prisma CLI config) | stack exhaustion on recursive objects | Overridden to ^8.0.2. Build-time CLI only. |
| sprintf-js ≤ 1.1.3 (via argparse in mammoth, and global-agent in onnxruntime-node) | DoS with huge precision specifiers | **No fixed release exists.** Neither path passes user input to sprintf (argparse is mammoth's CLI; global-agent is proxy logging). Accepted risk; revisit when a fix ships. |
