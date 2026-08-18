import crypto from 'node:crypto';
import { APP_SECRET } from './config.js';

const key = crypto.createHash('sha256').update(APP_SECRET).digest();

/** Chiffre un secret (mot de passe IMAP/SMTP) en AES-256-GCM. */
export function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(payload) {
  if (!payload) return '';
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1') return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error("Impossible de déchiffrer le mot de passe : la clé APP_SECRET a probablement changé.");
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
