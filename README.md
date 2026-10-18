# InQurix

> People should not have to remember where information was stored to retrieve it. InQurix helps them find the information **and its original source**.
>
> The user searches. InQurix discovers. The user examines the evidence.

InQurix is a desktop app (Windows and macOS; Linux for development) that indexes the folders you authorise and searches **inside** your documents: words, amounts, invoice/PO numbers, dates, people, organisations and meaning. Every result links back to the exact page, sheet cell, slide or email it came from. User-started **investigations** compare financial documents (duplicate invoices and payments, invoice vs PO/quote/contract/delivery note, supplier bank-detail changes, payment-redirection indicators, missing records, cost savings, important dates) and show evidence, calculations and verification steps. They never state conclusions such as "fraud".

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
