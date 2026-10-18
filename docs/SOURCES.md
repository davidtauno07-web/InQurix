# Source configuration and connectors

## Local folders (desktop)
- Add a folder from onboarding or **Sources & indexing → Add folder…**. Only folders chosen in the system folder picker are indexed; whole drives are refused.
- Per folder you can: enable/disable it (a disabled folder is hidden from search and investigations), include hidden files, set exclusion patterns (glob-style, relative to the folder), rescan, or remove it. Removing a folder deletes its index entries but never the files themselves.

## Company sources (server, Business plan)
- An organisation owner or admin creates a source, either visible to all members or restricted to explicit grants.
- Grants are per user: read, plus optional `canExport` and `canUpload`. Viewers can never upload.
- Access is checked on every search, preview, download and upload, so revoking a grant or removing a member takes effect on the next request. A removed member also loses creator rights over the sources they created.
- Documents get into a company source by upload through the server API (`apps/server/src/sources.ts`). The server extracts the text and makes it searchable with PostgreSQL full-text search.

## Third-party connectors
None yet: there are no Google Drive, SharePoint, OneDrive, Dropbox or email-mailbox connectors. Google is used only for sign-in (OAuth with PKCE; it needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`). See `STATUS.md`.
