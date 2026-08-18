import fs from 'node:fs';
import path from 'node:path';
import { RAW_DIR } from './config.js';

/** Stockage des messages bruts (.eml) sur disque : base de la robustesse anti-perte. */
export function rawPathFor(accountId, folderId, uid) {
  return path.join(RAW_DIR, String(accountId), String(folderId), `${uid}.eml`);
}

export function saveRaw(accountId, folderId, uid, buffer) {
  const file = rawPathFor(accountId, folderId, uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
  return file;
}

export function readRaw(file) {
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

export function rawExists(file) {
  return !!file && fs.existsSync(file);
}
