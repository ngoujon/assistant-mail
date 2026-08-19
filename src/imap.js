import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { db } from './db.js';
import { decrypt } from './crypto.js';

/**
 * Gestion des connexions IMAP : une seule connexion active par compte,
 * les opérations sont sérialisées par compte pour éviter toute concurrence
 * destructrice sur les boîtes (copie/suppression simultanées).
 */
const queues = new Map();

export function getAccount(id) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  if (!acc) throw new Error(`Compte introuvable (#${id})`);
  return acc;
}

function buildClient(acc) {
  return new ImapFlow({
    host: acc.imap_host,
    port: acc.imap_port,
    secure: !!acc.imap_secure,
    auth: { user: acc.imap_user, pass: decrypt(acc.imap_pass) },
    logger: false,
    tls: { rejectUnauthorized: !acc.allow_invalid_cert },
    socketTimeout: 120000,
    greetingTimeout: 20000
  });
}

/**
 * Exécute `fn(client)` sur une connexion IMAP du compte.
 * Les appels d'un même compte sont mis en file d'attente.
 */
export function withImap(accountOrId, fn) {
  const acc = typeof accountOrId === 'object' ? accountOrId : getAccount(accountOrId);
  const previous = queues.get(acc.id) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const client = buildClient(acc);
    try {
      await client.connect();
      return await fn(client);
    } finally {
      try { await client.logout(); } catch { try { client.close(); } catch {} }
    }
  });
  queues.set(acc.id, run.catch(() => {}));
  return run;
}

export async function testImap(acc) {
  const client = buildClient(acc);
  await client.connect();
  const list = await client.list();
  await client.logout();
  return list.length;
}

export function buildTransport(acc) {
  if (!acc.smtp_host) throw new Error("Aucun serveur SMTP n'est configuré pour ce compte.");
  return nodemailer.createTransport({
    host: acc.smtp_host,
    port: acc.smtp_port,
    secure: !!acc.smtp_secure,
    auth: { user: acc.smtp_user || acc.imap_user, pass: decrypt(acc.smtp_pass || acc.imap_pass) },
    tls: { rejectUnauthorized: !acc.allow_invalid_cert }
  });
}

export async function testSmtp(acc) {
  const transport = buildTransport(acc);
  await transport.verify();
  return true;
}

/**
 * Variantes de test utilisées pour l'auto-détection : les identifiants sont
 * fournis en clair (formulaire, pas encore enregistrés/chiffrés en base).
 */
export async function testImapRaw({ host, port, secure, user, pass, allowInvalidCert = false }) {
  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: !allowInvalidCert },
    socketTimeout: 15000,
    greetingTimeout: 10000
  });
  await client.connect();
  const list = await client.list();
  await client.logout();
  return list.length;
}

export async function testSmtpRaw({ host, port, secure, user, pass, allowInvalidCert = false }) {
  const transport = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: !allowInvalidCert },
    connectionTimeout: 10000
  });
  await transport.verify();
  return true;
}

/** Crée un dossier IMAP (et ses parents) si nécessaire. */
export async function ensureMailbox(client, path, delimiter = '/') {
  const list = await client.list();
  const existing = new Set(list.map((m) => m.path));
  if (existing.has(path)) return false;
  const parts = path.split(delimiter);
  let current = '';
  let created = false;
  for (const part of parts) {
    current = current ? current + delimiter + part : part;
    if (!existing.has(current)) {
      try {
        await client.mailboxCreate(current);
        created = true;
      } catch (err) {
        if (!/already exists/i.test(err.message)) throw err;
      }
      existing.add(current);
    }
  }
  return created;
}
