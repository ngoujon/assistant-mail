import { db } from './db.js';
import { withImap, getAccount, ensureMailbox } from './imap.js';
import { saveRaw } from './store.js';
import { registerRunner, addItem, setItem, updateJob, getJob } from './jobs.js';
import { syncFolders, syncFolderMessages } from './sync.js';

const IGNORED_FLAGS = new Set(['\\Recent']);

function cleanFlags(flags) {
  return Array.from(flags || []).filter((f) => !IGNORED_FLAGS.has(f));
}

function bump(jobId, field) {
  db.prepare(`UPDATE jobs SET ${field} = ${field} + 1 WHERE id = ?`).run(jobId);
}

/** ---------- Synchronisation d'un compte ---------- */
async function runSync(ctx) {
  const { accountId } = ctx.params;
  const acc = getAccount(accountId);
  ctx.phase('lecture des dossiers');
  await syncFolders(accountId);
  const folders = db.prepare('SELECT * FROM folders WHERE account_id = ? ORDER BY path').all(accountId);
  updateJob(ctx.id, { total: folders.length, done: 0 });
  ctx.log(`${folders.length} dossier(s) détecté(s) sur ${acc.email}.`);
  let done = 0;
  for (const folder of folders) {
    if (ctx.cancelled()) break;
    ctx.phase(`téléchargement · ${folder.path}`);
    try {
      const res = await syncFolderMessages(accountId, folder.path, {
        shouldCancel: ctx.cancelled,
        onError: (uid, err) => ctx.log(`${folder.path} #${uid} : message ignoré (${err.message}).`, 'warn')
      });
      if (res.imported || res.removed) ctx.log(`${folder.path} : ${res.imported} nouveau(x), ${res.removed} retiré(s).`);
    } catch (err) {
      bump(ctx.id, 'failed');
      ctx.log(`${folder.path} : ${err.message}`, 'error');
    }
    ctx.progress(++done);
  }
  db.prepare("UPDATE accounts SET last_sync_at = datetime('now'), status = 'connecté', last_error = NULL WHERE id = ?")
    .run(accountId);
  return { phase: 'synchronisation terminée' };
}

/** ---------- Transfert sécurisé de messages / dossiers ---------- */

function targetPathFor(srcPath, srcRoot, dstRoot, srcDelim, dstDelim) {
  const suffix = srcPath === srcRoot ? '' : srcPath.slice(srcRoot.length + srcDelim.length);
  const rel = suffix ? suffix.split(srcDelim).join(dstDelim) : '';
  return rel ? `${dstRoot}${dstDelim}${rel}` : dstRoot;
}

async function copyBatch({ ctx, srcClient, dstClient, srcPath, dstPath, uids, sameAccount, srcAccountId, srcFolderId }) {
  const copied = [];
  const pending = [];
  const lock = await srcClient.getMailboxLock(srcPath);
  try {
    for (const uid of uids) {
      if (ctx.cancelled()) break;
      const itemId = addItem(ctx.id, `${srcPath} #${uid}`, uid);
      try {
        if (sameAccount) {
          // Même compte : la copie serveur est atomique, aucun transit par le client.
          const res = await srcClient.messageCopy([uid], dstPath, { uid: true });
          const dstUid = res?.uidMap?.get?.(uid) ?? null;
          setItem(itemId, { status: 'copie', dst_uid: dstUid, detail: 'copie serveur' });
          copied.push({ uid, itemId, dstUid, verified: true });
        } else {
          let source = null;
          let flags = [];
          let internalDate = new Date();
          let messageId = null;
          for await (const msg of srcClient.fetch([uid], { uid: true, source: true, flags: true, internalDate: true, envelope: true }, { uid: true })) {
            source = msg.source;
            flags = cleanFlags(msg.flags);
            internalDate = msg.internalDate || internalDate;
            messageId = msg.envelope?.messageId || null;
          }
          if (!source) {
            // Le message a disparu entre le listage et la récupération (supprimé/déplacé
            // ailleurs en parallèle) : ce n'est pas un échec, juste plus rien à copier.
            setItem(itemId, { status: 'ignore', detail: 'message disparu côté source avant récupération' });
            bump(ctx.id, 'done');
            updateJob(ctx.id, {});
            continue;
          }
          // Filet de sécurité : copie locale du message brut avant toute écriture distante.
          if (srcFolderId) saveRaw(srcAccountId, srcFolderId, uid, source);

          let res;
          try {
            res = await dstClient.append(dstPath, source, flags, internalDate);
          } catch (err) {
            // Certains serveurs refusent les drapeaux personnalisés : nouvel essai sans drapeaux.
            res = await dstClient.append(dstPath, source, [], internalDate);
            ctx.log(`#${uid} : drapeaux non conservés (${err.message}).`, 'warn');
          }
          const dstUid = res?.uid ?? null;
          setItem(itemId, { status: 'copie', dst_uid: dstUid, detail: dstUid ? 'copié (UID confirmé)' : 'copié (à vérifier)' });
          const entry = { uid, itemId, dstUid, verified: !!dstUid, messageId };
          copied.push(entry);
          if (!dstUid) pending.push(entry);
        }
      } catch (err) {
        setItem(itemId, { status: 'echec', detail: err.message });
        bump(ctx.id, 'failed');
        ctx.log(`Échec copie ${srcPath} #${uid} : ${err.message}`, 'error');
      }
      bump(ctx.id, 'done');
      updateJob(ctx.id, {});
    }
  } finally {
    lock.release();
  }

  // Vérification des messages dont le serveur n'a pas renvoyé d'UID de destination.
  if (pending.length) {
    ctx.phase(`vérification · ${dstPath}`);
    const lockDst = await dstClient.getMailboxLock(dstPath);
    try {
      for (const entry of pending) {
        if (!entry.messageId) { entry.verified = false; setItem(entry.itemId, { detail: 'non vérifiable (pas de Message-ID)' }); continue; }
        const found = await dstClient.search({ header: { 'message-id': entry.messageId } }, { uid: true });
        entry.verified = Array.isArray(found) && found.length > 0;
        entry.dstUid = entry.verified ? found[found.length - 1] : null;
        setItem(entry.itemId, {
          status: entry.verified ? 'copie' : 'echec',
          dst_uid: entry.dstUid,
          detail: entry.verified ? 'présence confirmée à destination' : 'introuvable à destination'
        });
        if (!entry.verified) { bump(ctx.id, 'failed'); ctx.log(`#${entry.uid} : copie non confirmée, la source est conservée.`, 'error'); }
      }
    } finally {
      lockDst.release();
    }
  }

  return copied;
}

async function runTransfer(ctx) {
  const p = ctx.params;
  const src = getAccount(p.srcAccountId);
  const dst = getAccount(p.dstAccountId);
  const sameAccount = src.id === dst.id;
  const mode = p.mode === 'copy' ? 'copy' : 'move';

  const work = async (srcClient, dstClient) => {
    const srcBoxes = await srcClient.list();
    const dstBoxes = await dstClient.list();
    const srcDelim = srcBoxes.find((b) => b.path === p.srcPath)?.delimiter || '/';
    const dstDelim = dstBoxes[0]?.delimiter || '/';

    let pairs;
    if (Array.isArray(p.uids) && p.uids.length) {
      pairs = [{ srcPath: p.srcPath, dstPath: p.dstPath, uids: p.uids }];
    } else {
      const sources = srcBoxes
        .filter((b) => b.path === p.srcPath || (p.includeChildren && b.path.startsWith(p.srcPath + srcDelim)))
        .filter((b) => !Array.from(b.flags || []).includes('\\Noselect'))
        .map((b) => b.path)
        .sort();
      pairs = sources.map((sp) => ({ srcPath: sp, dstPath: targetPathFor(sp, p.srcPath, p.dstPath, srcDelim, dstDelim), uids: null }));
    }

    const allCopied = [];
    let grandTotal = 0;

    for (const pair of pairs) {
      if (ctx.cancelled()) break;
      ctx.phase(`préparation · ${pair.srcPath}`);
      await ensureMailbox(dstClient, pair.dstPath, dstDelim);

      let uids = pair.uids;
      if (!uids) {
        const lock = await srcClient.getMailboxLock(pair.srcPath);
        try {
          uids = await srcClient.search({ all: true }, { uid: true });
        } finally {
          lock.release();
        }
      }
      uids = (uids || []).map(Number).filter((n) => Number.isFinite(n));
      grandTotal += uids.length;
      updateJob(ctx.id, { total: grandTotal });
      ctx.log(`${pair.srcPath} → ${dst.email} / ${pair.dstPath} : ${uids.length} message(s).`);
      if (!uids.length) continue;

      const srcFolder = db.prepare('SELECT id FROM folders WHERE account_id = ? AND path = ?').get(src.id, pair.srcPath);
      ctx.phase(`copie · ${pair.srcPath}`);
      const copied = await copyBatch({
        ctx, srcClient, dstClient, srcPath: pair.srcPath, dstPath: pair.dstPath, uids, sameAccount,
        srcAccountId: src.id, srcFolderId: srcFolder?.id
      });
      allCopied.push({ pair, copied });
    }

    // ----- Phase de suppression : uniquement après confirmation de la copie -----
    if (mode === 'move' && !ctx.cancelled()) {
      for (const { pair, copied } of allCopied) {
        const safe = copied.filter((c) => c.verified);
        const unsafe = copied.length - safe.length;
        if (unsafe > 0) ctx.log(`${pair.srcPath} : ${unsafe} message(s) non confirmé(s), conservés à la source.`, 'warn');
        if (!safe.length) continue;
        ctx.phase(`suppression source · ${pair.srcPath}`);
        const lock = await srcClient.getMailboxLock(pair.srcPath);
        try {
          const uids = safe.map((c) => c.uid);
          for (let i = 0; i < uids.length; i += 100) {
            const chunk = uids.slice(i, i + 100);
            await srcClient.messageDelete(chunk, { uid: true });
          }
          safe.forEach((c) => setItem(c.itemId, { status: 'deplace', detail: 'copié puis supprimé de la source' }));
          ctx.log(`${pair.srcPath} : ${safe.length} message(s) supprimé(s) après vérification.`);
        } finally {
          lock.release();
        }
      }

      if (p.deleteSourceFolder) {
        const job = getJob(ctx.id);
        if (job.failed === 0) {
          for (const { pair } of [...allCopied].reverse()) {
            try {
              const lock = await srcClient.getMailboxLock(pair.srcPath);
              let remaining = 0;
              try { remaining = (await srcClient.search({ all: true }, { uid: true })).length; } finally { lock.release(); }
              if (remaining === 0) {
                await srcClient.mailboxDelete(pair.srcPath);
                ctx.log(`Dossier source supprimé : ${pair.srcPath}`);
              } else {
                ctx.log(`Dossier source conservé (${remaining} message(s) restant(s)) : ${pair.srcPath}`, 'warn');
              }
            } catch (err) {
              ctx.log(`Suppression du dossier ${pair.srcPath} impossible : ${err.message}`, 'warn');
            }
          }
        } else {
          ctx.log('Des erreurs sont survenues : le dossier source est conservé par sécurité.', 'warn');
        }
      }
    }
  };

  if (sameAccount) {
    await withImap(src, async (client) => work(client, client));
  } else {
    await withImap(src, async (srcClient) => withImap(dst, async (dstClient) => work(srcClient, dstClient)));
  }

  // Rafraîchit le cache local des deux comptes concernés
  ctx.phase('mise à jour du cache local');
  try {
    await syncFolders(src.id);
    await syncFolders(dst.id);
    if (p.srcPath) await syncFolderMessages(src.id, p.srcPath).catch(() => {});
    if (p.dstPath) await syncFolderMessages(dst.id, p.dstPath).catch(() => {});
  } catch { /* le cache sera régénéré à la prochaine synchro */ }

  return { phase: mode === 'move' ? 'déplacement terminé' : 'copie terminée' };
}

registerRunner('sync', runSync);
registerRunner('transfer', runTransfer);
