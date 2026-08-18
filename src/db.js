import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  color TEXT DEFAULT '#6c8cff',
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL DEFAULT 993,
  imap_secure INTEGER NOT NULL DEFAULT 1,
  imap_user TEXT NOT NULL,
  imap_pass TEXT NOT NULL,
  smtp_host TEXT,
  smtp_port INTEGER DEFAULT 587,
  smtp_secure INTEGER DEFAULT 0,
  smtp_user TEXT,
  smtp_pass TEXT,
  allow_invalid_cert INTEGER NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'nouveau',
  last_error TEXT,
  last_sync_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  delimiter TEXT DEFAULT '/',
  special_use TEXT,
  uid_validity TEXT,
  total INTEGER DEFAULT 0,
  unseen INTEGER DEFAULT 0,
  synced_at TEXT,
  UNIQUE(account_id, path)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid INTEGER NOT NULL,
  message_id TEXT,
  subject TEXT,
  from_name TEXT,
  from_addr TEXT,
  to_addr TEXT,
  cc_addr TEXT,
  date TEXT,
  size INTEGER DEFAULT 0,
  flags TEXT DEFAULT '',
  seen INTEGER DEFAULT 0,
  flagged INTEGER DEFAULT 0,
  answered INTEGER DEFAULT 0,
  has_attachments INTEGER DEFAULT 0,
  snippet TEXT,
  body_text TEXT,
  body_html TEXT,
  raw_path TEXT,
  UNIQUE(account_id, folder_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_messages_folder_date ON messages(folder_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(message_id);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'en_attente',
  params TEXT NOT NULL DEFAULT '{}',
  total INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  phase TEXT,
  error TEXT,
  cancel_requested INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS job_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ref TEXT,
  src_uid INTEGER,
  dst_uid INTEGER,
  status TEXT NOT NULL DEFAULT 'en_attente',
  detail TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_items_job ON job_items(job_id, status);

CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  level TEXT DEFAULT 'info',
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  account_label TEXT,
  label TEXT,
  scope TEXT,
  dir TEXT,
  message_count INTEGER DEFAULT 0,
  bytes INTEGER DEFAULT 0,
  status TEXT DEFAULT 'en_cours',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  plan TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
