import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR } from './config.js';
import { db } from './db.js';
import { withImap, getAccount, ensureMailbox } from './imap.js';
import { registerRunner, addItem, setItem, updateJob } from './jobs.js';
import { syncFolders } from './sync.js';

const IGNORED_FLAGS = new Set(['\\Recent']);
const safe = (s) => s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);

export function listBackups() {
  return db.prepare('SELECT * FROM backups ORDER BY id DESC').all();
}

export function deleteBackup(id) {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  if (!row) throw new Error('Sauvegarde introuvable');
  if (row.dir && fs.existsSync(row.dir)) fs.rmSync(row.dir, { recursive: true, force: true });
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
}

export function backupManifest(id) {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  if (!row) throw new Error('Sauvegarde introuvable');
  const file = path.join(row.dir, 'manifest.json');
  if (!fs.existsSync(file)) return { ...row, folders: [] };
  return { ...row, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/** ---------- Création d'une sauvegarde (export complet des messages bruts) ---------- */
async function runBackup(ctx) {
  const { accountId, folderPath, label } = ctx.params;
  const acc = getAccount(accountId);
  const backupId = db.prepare('INSERT INTO backups (account_id, account_label, label, scope, dir, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(accountId, acc.email, label || `Sauvegarde ${acc.email}`, folderPath || 'compte complet', '', 'en_cours').lastInsertRowid;
  const dir = path.join(BACKUP_DIR, `backup-${backupId}`);
  fs.mkdirSync(path.join(dir, 'folders'), { recursive: true });
  db.prepare('UPDATE backups SET dir = ? WHERE id = ?').run(dir, backupId);
  updateJob(ctx.id, { params: JSON.stringify({ ...ctx.params, backupId }) });

  const manifest = { backupId, account: { id: acc.id, email: acc.email, name: acc.name }, createdAt: new Date().toISOString(), folders: [] };
  let count = 0;
  let bytes = 0;

  try {
    await withImap(acc, async (client) => {
      const boxes = (await client.list()).filter((b) => !Array.from(b.flags || []).includes('\\Noselect'));
      const targets = folderPath ? boxes.filter((b) => b.path === folderPath || b.path.startsWith(folderPath + (b.delimiter || '/'))) : boxes;
      let total = 0;
      for (const box of targets) {
        const lock = await client.getMailboxLock(box.path);
        try { total += client.mailbox.exists || 0; } finally { lock.release(); }
      }
      updateJob(ctx.id, { total });

      for (const box of targets) {
        if (ctx.cancelled()) break;
        ctx.phase(`sauvegarde · ${box.path}`);
        const entry = { path: box.path, delimiter: box.delimiter || '/', specialUse: box.specialUse || null, messages: [] };
        const folderDir = path.join(dir, 'folders', safe(box.path));
        fs.mkdirSync(folderDir, { recursive: true });
        const lock = await client.getMailboxLock(box.path);
        try {
          const uids = await client.search({ all: true }, { uid: true });
          for (let i = 0; i < uids.length; i += 40) {
            if (ctx.cancelled()) break;
            const chunk = uids.slice(i, i + 40);
            for await (const msg of client.fetch(chunk, { uid: true, source: true, flags: true, internalDate: true, envelope: true }, { uid: true })) {
              const file = path.join(folderDir, `${msg.uid}.eml`);
              fs.writeFileSync(file, msg.source);
              bytes += msg.source.length;
              count++;
              entry.messages.push({
                uid: msg.uid,
                file: path.relative(dir, file),
                messageId: msg.envelope?.messageId || null,
                subject: msg.envelope?.subject || '',
                from: msg.envelope?.from?.[0]?.address || '',
                date: (msg.internalDate || new Date()).toISOString(),
                flags: Array.from(msg.flags || []).filter((f) => !IGNORED_FLAGS.has(f)),
                size: msg.source.length
              });
              updateJob(ctx.id, { done: count });
            }
          }
        } finally {
          lock.release();
        }
        manifest.folders.push(entry);
        ctx.log(`${box.path} : ${entry.messages.length} message(s) sauvegardé(s).`);
      }
    });

    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    db.prepare("UPDATE backups SET message_count = ?, bytes = ?, status = 'complète' WHERE id = ?").run(count, bytes, backupId);
    ctx.log(`Sauvegarde #${backupId} terminée : ${count} message(s), ${(bytes / 1048576).toFixed(1)} Mo.`);
  } catch (err) {
    db.prepare("UPDATE backups SET status = 'échec', message_count = ?, bytes = ? WHERE id = ?").run(count, bytes, backupId);
    throw err;
  }
  return { phase: 'sauvegarde terminée' };
}

/** ---------- Restauration / rollback ---------- */
async function runRestore(ctx) {
  const { backupId, targetAccountId, mode, onlyFolder } = ctx.params;
  const info = backupManifest(backupId);
  if (!info.folders?.length) throw new Error('Sauvegarde vide ou manifeste manquant.');
  const acc = getAccount(targetAccountId || info.account.id);
  const prefix = mode === 'new_folder' ? `Restauration-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}` : null;

  const folders = onlyFolder ? info.folders.filter((f) => f.path === onlyFolder) : info.folders;
  const total = folders.reduce((n, f) => n + f.messages.length, 0);
  updateJob(ctx.id, { total, done: 0 });
  ctx.log(`Restauration de ${total} message(s) vers ${acc.email}${prefix ? ` (dans « ${prefix} »)` : ''}.`);

  await withImap(acc, async (client) => {
    const boxes = await client.list();
    const delimiter = boxes[0]?.delimiter || '/';
    for (const folder of folders) {
      if (ctx.cancelled()) break;
      const target = prefix ? `${prefix}${delimiter}${folder.path.split(folder.delimiter).join(delimiter)}` : folder.path.split(folder.delimiter).join(delimiter);
      ctx.phase(`restauration · ${target}`);
      await ensureMailbox(client, target, delimiter);

      // Anti-doublon : on relève les Message-ID déjà présents à destination.
      const existing = new Set();
      const lock = await client.getMailboxLock(target);
      try {
        const uids = await client.search({ all: true }, { uid: true });
        if (uids.length) {
          for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
            if (msg.envelope?.messageId) existing.add(msg.envelope.messageId);
          }
        }
      } finally {
        lock.release();
      }

      for (const message of folder.messages) {
        if (ctx.cancelled()) break;
        const itemId = addItem(ctx.id, `${target} · ${message.subject || '(sans objet)'}`, message.uid);
        try {
          if (message.messageId && existing.has(message.messageId)) {
            setItem(itemId, { status: 'ignore', detail: 'déjà présent à destination' });
          } else {
            const file = path.join(info.dir, message.file);
            if (!fs.existsSync(file)) throw new Error('fichier de sauvegarde manquant');
            const res = await client.append(target, fs.readFileSync(file), message.flags || [], new Date(message.date));
            setItem(itemId, { status: 'restaure', dst_uid: res?.uid ?? null, detail: 'restauré' });
          }
        } catch (err) {
          setItem(itemId, { status: 'echec', detail: err.message });
          db.prepare('UPDATE jobs SET failed = failed + 1 WHERE id = ?').run(ctx.id);
          ctx.log(`Échec restauration (${message.subject}) : ${err.message}`, 'error');
        }
        db.prepare('UPDATE jobs SET done = done + 1 WHERE id = ?').run(ctx.id);
        updateJob(ctx.id, {});
      }
    }
  });

  ctx.phase('mise à jour du cache local');
  await syncFolders(acc.id).catch(() => {});
  return { phase: 'restauration terminée' };
}

registerRunner('backup', runBackup);
registerRunner('restore', runRestore);
