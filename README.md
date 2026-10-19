# InQurix

**The Local Intelligence and Analysis Engine**

*Discover. Connect. Analyze. Understand.*

InQurix is a local-first intelligence and analysis platform for individuals, professionals and organisations. It helps you discover information, search within documents, connect related records, analyse data, investigate inconsistencies and uncover evidence-backed insights across the files and business records you authorise. Every finding points back to the original source, so conclusions can always be checked.

> People should not have to remember where information was stored to retrieve it. InQurix helps them find the information **and its original source**.
>
> The user searches. InQurix discovers. The user examines the evidence.

The desktop app (Windows and macOS; Linux for development) indexes only the folders you authorise and works **inside** your documents: words, amounts, invoice/PO numbers, dates, people, organisations and meaning. Every result links back to the exact page, sheet cell, slide or email it came from. User-started **investigations** compare financial documents (duplicate invoices and payments, invoice vs PO/quote/contract/delivery note, supplier bank-detail changes, payment-redirection indicators, missing records, cost savings, important dates) and show evidence, calculations and verification steps. They never state conclusions such as "fraud".

## What it does today

- **Discover**: index authorised folders (PDF, Word, Excel, PowerPoint, CSV, text, RTF, HTML, email and scanned images via OCR) and search them by words, exact references, amounts, dates and meaning.
- **Connect**: show related documents that share invoice, PO, quote, contract or payment references, suppliers and bank details.
- **Analyze**: run user-started investigations for duplicate invoices and payments, invoice-vs-PO/quote/contract/delivery differences, supplier bank-detail changes, payment-redirection indicators, missing records, possible cost savings and important dates, with the calculations shown.
- **Understand**: every result and finding shows its evidence and exact location, cautious wording, what remains unresolved, and review states you can export.

The current state of each feature, including what is not finished, is tracked in [docs/STATUS.md](docs/STATUS.md).

## Local-first and offline by design

Document contents, the index and your searches stay on your computer, and searching or analysing local files does not use a cloud AI service. Offline operation depends on the necessary components being installed locally:

- the local index (built on your machine);
- the semantic-search model (bundled in installers; `npm run models -w @inqurix/desktop` when running from source). Without it, keyword, reference and amount search still work;
- OCR language data for scanned documents. When running from source on Windows or macOS it is downloaded on first use, so the first OCR run needs internet.

Features that are network services by nature need a connection and a running InQurix server: company workspaces, accounts, Google sign-in and billing.

## Optional server

An optional **server** adds accounts, company workspaces with per-source permissions, plans, credits and Paddle billing.

| Part | Path | Stack |
|---|---|---|
| Shared engine | `packages/core` | TypeScript: file identification, extractors, entities, records, finance engine |
| Desktop app | `apps/desktop` | Electron + React + Vite, SQLite FTS5 index, local MiniLM embeddings |
| Server | `apps/server` | Express + PostgreSQL + Prisma |

## Quick start (Windows, VS Code terminal)

Requirements: Node.js 22.12+ (24 recommended), Git, and PostgreSQL only if you run the server.

```powershell
git clone https://github.com/davidtauno07-web/InQurix.git
cd InQurix
npm ci                                  # one install at the root for all packages
npm run models -w @inqurix/desktop      # downloads the local search model (~23 MB) once
npm run dev:desktop                     # opens the desktop app
```

Server (optional, uses **your local PostgreSQL**):

```powershell
copy .env.example .env                  # then edit DATABASE_URL and SECRET_KEY in .env
psql -U postgres -c "CREATE DATABASE inqurix"
npm run build:core
npm run db:migrate -w @inqurix/server
npm run keys -w @inqurix/server         # paste the two printed lines into .env
npm run db:seed -w @inqurix/server      # optional demo company; prints a demo password
npm run dev:server                      # http://localhost:4100/api/health
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for tests, packaging and troubleshooting.

## Documentation

- [docs/USER-GUIDE.md](docs/USER-GUIDE.md): using search, Quick Search and investigations
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how indexing, search and the finance engine work
- [docs/PRIVACY-SECURITY.md](docs/PRIVACY-SECURITY.md): what stays local, threat model, known limits
- [docs/BILLING.md](docs/BILLING.md): plans, credits, Paddle setup and webhooks
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): setup, tests, packaging and releases
- [docs/STATUS.md](docs/STATUS.md): what is implemented, tested, incomplete or needs credentials
- [Source configuration & connectors](docs/SOURCES.md)
- [Indexing & search troubleshooting](docs/TROUBLESHOOTING.md)
- [Databases & migrations](docs/DATABASE.md)
- [Release checklist](docs/RELEASE-CHECKLIST.md)
