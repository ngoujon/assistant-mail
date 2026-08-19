import { simpleParser } from 'mailparser';
import { db } from './db.js';
import { withImap } from './imap.js';
import { saveRaw } from './store.js';
import { MAX_MESSAGES_PER_FOLDER } from './config.js';

const SKIP_FLAGS = ['\\Noselect', '\\NonExistent'];

function addrText(list) {
  if (!list) return '';
  const items = Array.isArray(list) ? list : list.value || [];
  return items.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).filter(Boolean).join(', ');
}

/** Met à jour la liste des dossiers d'un compte à partir du serveur IMAP. */
export async function syncFolders(accountId) {
  const boxes = await withImap(accountId, async (client) => client.list());
  const keep = [];
  const upsert = db.prepare(`
    INSERT INTO folders (account_id, path, name, delimiter, special_use)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, path) DO UPDATE SET name = excluded.name,
      delimiter = excluded.delimiter, special_use = excluded.special_use`);
  for (const box of boxes) {
    const flags = Array.from(box.flags || []);
    if (flags.some((f) => SKIP_FLAGS.includes(f))) continue;
    upsert.run(accountId, box.path, box.name, box.delimiter || '/', box.specialUse || null);
    keep.push(box.path);
  }
  // Supprime de la base locale les dossiers qui n'existent plus côté serveur
  const local = db.prepare('SELECT id, path FROM folders WHERE account_id = ?').all(accountId);
  const del = db.prepare('DELETE FROM folders WHERE id = ?');
  for (const f of local) if (!keep.includes(f.path)) del.run(f.id);
  return keep.length;
}

function folderRow(accountId, path) {
  return db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(accountId, path);
}

/**
 * Télécharge les nouveaux messages d'un dossier et les stocke localement
 * (métadonnées en base + source brute sur disque).
 */
export async function syncFolderMessages(accountId, folderPath, { onProgress, shouldCancel } = {}) {
  const folder = folderRow(accountId, folderPath);
  if (!folder) throw new Error(`Dossier inconnu : ${folderPath}`);

  return withImap(accountId, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    let imported = 0;
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      if (folder.uid_validity && folder.uid_validity !== uidValidity) {
        // Le serveur a réinitialisé les UID : on repart d'un cache propre.
        db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folder.id);
      }
      db.prepare('UPDATE folders SET uid_validity = ?, total = ? WHERE id = ?')
        .run(uidValidity, client.mailbox.exists || 0, folder.id);

      const knownRows = db.prepare('SELECT uid FROM messages WHERE folder_id = ?').all(folder.id);
      const known = new Set(knownRows.map((r) => r.uid));

      if (client.mailbox.exists === 0) {
        db.prepare("UPDATE folders SET synced_at = datetime('now'), unseen = 0 WHERE id = ?").run(folder.id);
        return { imported: 0, removed: knownRows.length };
      }

      const serverUids = await client.search({ all: true }, { uid: true });
      const present = new Set(serverUids);
      // Messages disparus côté serveur -> retirés du cache local
      const removedUids = knownRows.map((r) => r.uid).filter((u) => !present.has(u));
      if (removedUids.length) {
        const delStmt = db.prepare('DELETE FROM messages WHERE folder_id = ? AND uid = ?');
        db.transaction(() => removedUids.forEach((u) => delStmt.run(folder.id, u)))();
      }

      let toFetch = serverUids.filter((u) => !known.has(u)).sort((a, b) => b - a);
      if (MAX_MESSAGES_PER_FOLDER > 0) toFetch = toFetch.slice(0, MAX_MESSAGES_PER_FOLDER);

      const insert = db.prepare(`
        INSERT INTO messages (account_id, folder_id, uid, message_id, subject, from_name, from_addr,
          to_addr, cc_addr, date, size, flags, seen, flagged, answered, has_attachments, snippet,
          body_text, body_html, raw_path)
        VALUES (@account_id, @folder_id, @uid, @message_id, @subject, @from_name, @from_addr,
          @to_addr, @cc_addr, @date, @size, @flags, @seen, @flagged, @answered, @has_attachments,
          @snippet, @body_text, @body_html, @raw_path)
        ON CONFLICT(account_id, folder_id, uid) DO NOTHING`);

      const batchSize = 40;
      for (let i = 0; i < toFetch.length; i += batchSize) {
        if (shouldCancel?.()) break;
        const batch = toFetch.slice(i, i + batchSize);
        for await (const msg of client.fetch(batch, { uid: true, source: true, flags: true, size: true, internalDate: true }, { uid: true })) {
          const source = msg.source;
          const parsed = await simpleParser(source, { skipImageLinks: true });
          const flags = Array.from(msg.flags || []);
          const rawPath = saveRaw(accountId, folder.id, msg.uid, source);
          const text = (parsed.text || '').replace(/\s+/g, ' ').trim();
          insert.run({
            account_id: accountId,
            folder_id: folder.id,
            uid: msg.uid,
            message_id: parsed.messageId || null,
            subject: parsed.subject || '(sans objet)',
            from_name: parsed.from?.value?.[0]?.name || '',
            from_addr: parsed.from?.value?.[0]?.address || '',
            to_addr: addrText(parsed.to),
            cc_addr: addrText(parsed.cc),
            date: (parsed.date || msg.internalDate || new Date()).toISOString(),
            size: msg.size || source.length,
            flags: flags.join(' '),
            seen: flags.includes('\\Seen') ? 1 : 0,
            flagged: flags.includes('\\Flagged') ? 1 : 0,
            answered: flags.includes('\\Answered') ? 1 : 0,
            has_attachments: parsed.attachments?.length ? 1 : 0,
            snippet: text.slice(0, 240),
            body_text: parsed.text || '',
            body_html: parsed.html || '',
            raw_path: rawPath
          });
          imported++;
        }
        onProgress?.(Math.min(i + batchSize, toFetch.length), toFetch.length);
      }

      const unseen = db.prepare('SELECT COUNT(*) c FROM messages WHERE folder_id = ? AND seen = 0').get(folder.id).c;
      db.prepare("UPDATE folders SET synced_at = datetime('now'), unseen = ?, total = ? WHERE id = ?")
        .run(unseen, serverUids.length, folder.id);
      return { imported, removed: removedUids.length };
    } finally {
      lock.release();
    }
  });
}

/** Met à jour les drapeaux (lu/non lu, suivi) d'un message côté serveur puis en base. */
export async function setFlags(accountId, folderPath, uid, { add = [], remove = [] }) {
  await withImap(accountId, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    try {
      if (add.length) await client.messageFlagsAdd([uid], add, { uid: true });
      if (remove.length) await client.messageFlagsRemove([uid], remove, { uid: true });
    } finally {
      lock.release();
    }
  });
  const folder = folderRow(accountId, folderPath);
  const row = db.prepare('SELECT flags FROM messages WHERE folder_id = ? AND uid = ?').get(folder.id, uid);
  const flags = new Set((row?.flags || '').split(' ').filter(Boolean));
  add.forEach((f) => flags.add(f));
  remove.forEach((f) => flags.delete(f));
  const list = Array.from(flags);
  db.prepare('UPDATE messages SET flags = ?, seen = ?, flagged = ?, answered = ? WHERE folder_id = ? AND uid = ?')
    .run(list.join(' '), list.includes('\\Seen') ? 1 : 0, list.includes('\\Flagged') ? 1 : 0,
      list.includes('\\Answered') ? 1 : 0, folder.id, uid);
  const unseen = db.prepare('SELECT COUNT(*) c FROM messages WHERE folder_id = ? AND seen = 0').get(folder.id).c;
  db.prepare('UPDATE folders SET unseen = ? WHERE id = ?').run(unseen, folder.id);
}
