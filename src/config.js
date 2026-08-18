import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const RAW_DIR = path.join(DATA_DIR, 'raw');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const DB_PATH = path.join(DATA_DIR, 'mailzen.db');

for (const dir of [DATA_DIR, RAW_DIR, BACKUP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const PORT = Number(process.env.PORT || 3016);
export const APP_SECRET = process.env.APP_SECRET || 'mailzen-default-insecure-secret';
export const APP_PASSWORD = process.env.APP_PASSWORD || '';
export const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://host.docker.internal:11434').replace(/\/$/, '');
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';
export const MAX_MESSAGES_PER_FOLDER = Number(process.env.MAX_MESSAGES_PER_FOLDER || 0);
