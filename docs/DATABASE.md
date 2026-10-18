# Databases and migrations

## Desktop (SQLite)
- The schema and its numbered migrations are in `apps/desktop/src/main/db/index.ts`. They are applied automatically at startup, in order.
- Tables: sources, exclusions, documents (with FTS5 `documents_fts`), segments (passages, with FTS5), entities, records (structured finance data), vectors, history, saved searches, pins, investigations, reminders, events.
- Files are created `0600` inside a `0700` folder where the OS supports POSIX modes. They are not encrypted (no SQLCipher yet); use BitLocker or FileVault.

## Server (PostgreSQL + Prisma)
- The schema is `apps/server/prisma/schema.prisma`; migrations are in `apps/server/prisma/migrations/`.
- Development: `cd apps/server && npm run db:migrate:dev`. Production: `npx prisma migrate deploy`.
- Tests wipe their database. Point `TEST_DATABASE_URL` at a separate database and run `DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy` after schema changes.
- Seed demo data: `npm run db:seed -w @inqurix/server`. It reads the synthetic fixtures (`npm run fixtures`).
