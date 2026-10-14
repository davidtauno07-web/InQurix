import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

/** Bump when extraction output changes so documents are re-processed. */
export const EXTRACTOR_VERSION = 1;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'folder',
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    paused INTEGER NOT NULL DEFAULT 0,
    include_hidden INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL,
    last_scan_started_at TEXT,
    last_scan_at TEXT
  );
  CREATE TABLE exclusions (
    id INTEGER PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL
  );
  CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    attachment_name TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'unknown',
    mime TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    hash TEXT,
    status TEXT NOT NULL DEFAULT 'discovered',
    status_detail TEXT,
    warnings TEXT,
    title TEXT,
    author TEXT,
    doc_created_at TEXT,
    doc_modified_at TEXT,
    page_count INTEGER,
    metadata TEXT,
    ocr_confidence REAL,
    segment_count INTEGER NOT NULL DEFAULT 0,
    extractor_version INTEGER NOT NULL DEFAULT 0,
    discovered_at TEXT NOT NULL,
    indexed_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE (path, attachment_name)
  );
  CREATE INDEX documents_source ON documents(source_id);
  CREATE INDEX documents_status ON documents(status);
  CREATE INDEX documents_hash ON documents(hash);
  CREATE INDEX documents_parent ON documents(parent_id);

  CREATE TABLE segments (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    heading TEXT,
    location TEXT NOT NULL,
    method TEXT NOT NULL,
    confidence REAL,
    fields TEXT,
    cells TEXT
  );
  CREATE INDEX segments_doc ON segments(doc_id, ordinal);

  CREATE VIRTUAL TABLE segments_fts USING fts5(text, heading, content='segments', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
  CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
    INSERT INTO segments_fts(rowid, text, heading) VALUES (new.id, new.text, new.heading);
  END;
  CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
    INSERT INTO segments_fts(segments_fts, rowid, text, heading) VALUES ('delete', old.id, old.text, old.heading);
  END;

  CREATE VIRTUAL TABLE documents_fts USING fts5(name, title, folder, tokenize='unicode61 remove_diacritics 2');

  CREATE TABLE entities (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    original TEXT NOT NULL,
    normalized TEXT NOT NULL,
    numeric REAL,
    iso_date TEXT,
    currency TEXT,
    label TEXT,
    confidence REAL NOT NULL,
    offset INTEGER NOT NULL,
    origin TEXT NOT NULL DEFAULT 'extracted'
  );
  CREATE INDEX entities_type_norm ON entities(type, normalized);
  CREATE INDEX entities_norm ON entities(normalized);
  CREATE INDEX entities_numeric ON entities(type, numeric);
  CREATE INDEX entities_doc ON entities(doc_id);

  CREATE TABLE records (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL,
    number TEXT,
    number_norm TEXT,
    supplier TEXT,
    supplier_norm TEXT,
    date TEXT,
    total REAL,
    currency TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX records_type ON records(doc_type);
  CREATE INDEX records_number ON records(number_norm);
  CREATE INDEX records_supplier ON records(supplier_norm);
  CREATE INDEX records_doc ON records(doc_id);

  CREATE TABLE embeddings (
    segment_id INTEGER PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
    doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    vec BLOB NOT NULL
  );
  CREATE INDEX embeddings_doc ON embeddings(doc_id);

  CREATE TABLE history (id INTEGER PRIMARY KEY, query TEXT NOT NULL, filters TEXT, at TEXT NOT NULL, result_count INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE saved_searches (id INTEGER PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, filters TEXT, created_at TEXT NOT NULL);
  CREATE TABLE pins (doc_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, at TEXT NOT NULL);
  CREATE TABLE opens (id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, query TEXT, at TEXT NOT NULL);
  CREATE INDEX opens_doc ON opens(doc_id);

  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    due_date TEXT NOT NULL,
    date_basis TEXT NOT NULL,
    evidence TEXT,
    created_at TEXT NOT NULL,
    dismissed_at TEXT,
    notified_at TEXT
  );

  CREATE TABLE investigations (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    params TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    result TEXT,
    error TEXT
  );

  CREATE TABLE events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, doc_id INTEGER, source_id INTEGER);
  CREATE INDEX events_at ON events(at);
  `,
];

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;');
  migrate(db);
  if (file !== ':memory:') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on platforms without POSIX modes */ }
  }
  return db;
}

function migrate(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  let version = row ? Number(row.value) : 0;
  for (; version < MIGRATIONS.length; version++) {
    const sql = version === 0 ? MIGRATIONS[0].replace('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);', '') : MIGRATIONS[version];
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version + 1));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const now = () => new Date().toISOString();

export function logEvent(db: DB, level: 'info' | 'warn' | 'error', kind: string, message: string, ids: { docId?: number; sourceId?: number } = {}): void {
  db.prepare('INSERT INTO events(at, level, kind, message, doc_id, source_id) VALUES (?, ?, ?, ?, ?, ?)').run(now(), level, kind, message, ids.docId ?? null, ids.sourceId ?? null);
}
