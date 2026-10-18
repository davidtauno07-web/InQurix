# Architecture

```
packages/core   shared, framework-free TypeScript
  identify.ts       content-based file type detection; refuses executables and macro files
  limits.ts         size/page/zip/time limits
  extract/          PDF (per page, with OCR fallback for scanned pages), DOCX, XLSX (per cell/row), PPTX (per slide),
                    CSV/TSV, TXT/MD, RTF, HTML, EML (with attachments), images (OCR)
  entities.ts       amounts + currency, dates, invoice/PO/quote/contract numbers, bank accounts, emails, phones, people, organisations
  records.ts        structured business records (invoice, PO, quotation, contract, delivery note, payment, bank statement, …)
  normalize.ts      folding, money parsing, edit distance, date arithmetic
  finance/          the investigation engine (below)

apps/desktop    Electron
  main/index.ts         lifecycle, tray/menu bar, global shortcut, windows, reminder notifications
  main/indexer/         background indexer: a separate Node process (Electron run as Node), watcher (chokidar),
                        periodic reconciliation, content hashing, pause/resume, interruption recovery
  main/db/              SQLite (node:sqlite) schema + migrations: documents, segments, FTS5, entities, records,
                        embeddings, history, saved searches, pins, investigations, reminders
  main/search/          intent detection, FTS5 + exact + structured + semantic (MiniLM) hybrid ranking, explanations
  main/investigations.ts loads records/segments from the index, runs and stores investigations, reviews, exports
  main/ipc.ts           allowlisted IPC with argument validation
  renderer/             React UI: Quick Search, Workspace (search, investigations, history, sources, settings), onboarding

apps/server     Express + Prisma/PostgreSQL
  auth.ts      accounts, sessions, email verification, recovery, TOTP, Google OAuth
  orgs.ts      organisations, roles (owner/admin/member/viewer), invitations, removal
  sources.ts   shared sources, per-user grants, uploads, permission-filtered search/preview/download
  billing.ts   credits ledger, signed entitlements, Paddle checkout + webhooks
```

## Indexing

1. The user authorises a folder (an OS folder picker; nothing is indexed otherwise).
2. The indexer walks it, skips exclusions, hashes each file, and extracts only new or changed files.
3. Extraction yields **segments** with exact locations (page, sheet + cell range, slide, email part), plus entities and structured records with the segment they came from.
4. Segments go into FTS5; with meaning-based search on, segment embeddings are computed locally.
5. The watcher handles changes as they happen. A periodic reconciliation catches anything missed and removes deleted files. Every file has a visible status (indexed, empty, needs OCR, encrypted, too large, refused, failed).

## Search

Query intent (reference number, amount, date, person/organisation, question, plain text) chooses how the strategies are weighted:
exact identifier and amount matches, FTS5 BM25, structured record fields, and cosine similarity on embeddings. Results are grouped per document. Each shows the best segment, its location, highlighted matches, an explanation ("Contains the amount 14,317.50 on page 1"), extracted fields and related documents.

## Finance engine (`packages/core/src/finance`)

Investigations run **only when the user starts them**, on records from authorised sources.

| Type | Logic | Avoiding false positives |
|---|---|---|
| Duplicate invoices | Compares supplier, normalised and raw number, date, total, currency, PO, line items, service period and bank account; graded exact / likely / weak | Monthly/recurring invoices and different service periods or POs are not grouped |
| Duplicate payments | Same supplier + amount + invoice reference, or the same transaction id | Instalments, reversals/refunds, credit notes and regular monthly payments are excluded or explained |
| Invoice comparison | Invoice vs PO (by reference), quotation, contract (prices parsed from clauses), delivery note and payments: price, quantity, total, terms, account | Only lines that can be matched are compared; unmatched lines are listed as unresolved |
| Bank details | Accounts per supplier across invoices, payments and correspondence | Reported as "requires verification", never as fraud |
| Payment-redirection indicators | Urgency, secrecy, "new account", lookalike sender domains vs the supplier's known domain | Labelled "Possible impersonation indicator"; urgency alone is not flagged |
| Missing records | Invoices without PO/delivery/payment, payments without an invoice | "Not found in the authorised, indexed sources", which does not prove a document doesn't exist |
| Cost savings | Price precedence: contract > PO > quotation; quantity vs delivery note | Each overcharge is counted once (resent duplicates are not double-counted; a quotation difference is not counted when the PO price matches) |
| Important dates | Due dates, quote expiry, renewals, contract end, notice deadlines | Each date is marked as *stated* or *calculated*, with the calculation shown |

Every finding has a classification, evidence strength, matched and different attributes, calculations, assumptions, limitations, verification steps, unresolved questions and evidence excerpts with locations. Findings can be marked confirmed, not an issue or resolved, with notes, and exported as Markdown, CSV or JSON.
