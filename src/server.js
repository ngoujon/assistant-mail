import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, APP_PASSWORD } from './config.js';
import { db } from './db.js';
import { encrypt, randomToken, timingSafeEqual } from './crypto.js';
import { getAccount, testImap, testSmtp, testImapRaw, testSmtpRaw, withImap, buildTransport, ensureMailbox } from './imap.js';
import { guessCandidates } from './autodiscover.js';
import { syncFolders, setFlags } from './sync.js';
import { bus, createJob, listJobs, getJob, jobItems, jobLogs, requestCancel, recoverJobs } from './jobs.js';
import { listBackups, deleteBackup, backupManifest } from './backup.js';
import { ollamaStatus, askAgent, previewPlan } from './agent.js';
import './transfer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));

/* ---------------- Authentification optionnelle ---------------- */
const sessions = new Set();

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('=');
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }).filter(([k]) => k));
}

app.get('/api/session', (req, res) => {
  const token = parseCookies(req).mailzen;
  res.json({ required: !!APP_PASSWORD, authenticated: !APP_PASSWORD || sessions.has(token) });
});

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  if (!timingSafeEqual(req.body?.password || '', APP_PASSWORD)) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }
  const token = randomToken();
  sessions.add(token);
  res.setHeader('Set-Cookie', `mailzen=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD || req.path === '/login' || req.path === '/session') return next();
  if (sessions.has(parseCookies(req).mailzen)) return next();
  res.status(401).json({ error: 'Authentification requise' });
});

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  res.status(400).json({ error: err.message });
});

/* ---------------- Comptes ---------------- */
const PUBLIC_ACCOUNT = `id, name, email, color, imap_host, imap_port, imap_secure, imap_user,
  smtp_host, smtp_port, smtp_secure, smtp_user, allow_invalid_cert, status, last_error, last_sync_at`;

app.get('/api/accounts', (req, res) => {
  const accounts = db.prepare(`SELECT ${PUBLIC_ACCOUNT} FROM accounts ORDER BY id`).all();
  for (const acc of accounts) {
    const stats = db.prepare('SELECT COUNT(*) folders, COALESCE(SUM(total),0) total, COALESCE(SUM(unseen),0) unseen FROM folders WHERE account_id = ?').get(acc.id);
    Object.assign(acc, stats);
  }
  res.json(accounts);
});

function accountPayload(body, existing = null) {
  const need = (v, label) => { if (!v) throw new Error(`Champ obligatoire manquant : ${label}`); return v; };
  return {
    name: need(body.name, 'nom'),
    email: need(body.email, 'adresse e-mail'),
    color: body.color || '#6c8cff',
    imap_host: need(body.imap_host, 'serveur IMAP'),
    imap_port: Number(body.imap_port || 993),
    imap_secure: body.imap_secure ? 1 : 0,
    imap_user: need(body.imap_user || body.email, 'identifiant IMAP'),
    imap_pass: body.imap_pass ? encrypt(body.imap_pass) : existing?.imap_pass || '',
    smtp_host: body.smtp_host || '',
    smtp_port: Number(body.smtp_port || 587),
    smtp_secure: body.smtp_secure ? 1 : 0,
    smtp_user: body.smtp_user || body.imap_user || body.email,
    smtp_pass: body.smtp_pass ? encrypt(body.smtp_pass) : existing?.smtp_pass || '',
    allow_invalid_cert: body.allow_invalid_cert ? 1 : 0
  };
}

app.post('/api/accounts/detect', wrap(async (req, res) => {
  const { email, imap_pass, smtp_pass, imap_user, smtp_user } = req.body;
  if (!email) throw new Error('Adresse e-mail requise.');
  if (!imap_pass) throw new Error('Mot de passe requis pour vérifier la connexion.');
  const user = imap_user || email;
  const isGmail = email.endsWith('@gmail.com') || email.endsWith('@googlemail.com');
  const candidates = await guessCandidates(email);
  const attempts = [];
  for (const cand of candidates) {
    if (!cand.imap) continue;
    try {
      await testImapRaw({ host: cand.imap.host, port: cand.imap.port, secure: cand.imap.secure, user, pass: imap_pass });
      const result = {
        found: true,
        imap_host: cand.imap.host, imap_port: cand.imap.port, imap_secure: cand.imap.secure,
        smtp_host: cand.smtp?.host || '', smtp_port: cand.smtp?.port || 587, smtp_secure: !!cand.smtp?.secure
      };
      if (cand.smtp) {
        try {
          await testSmtpRaw({ host: cand.smtp.host, port: cand.smtp.port, secure: cand.smtp.secure, user: smtp_user || user, pass: smtp_pass || imap_pass });
          result.smtp_ok = true;
        } catch (err) {
          result.smtp_ok = false;
          result.smtp_error = err.message;
        }
      }
      return res.json(result);
    } catch (err) {
      attempts.push({ host: cand.imap.host, error: err.message });
    }
  }
  let errorMsg = 'Détection automatique impossible pour ce fournisseur.';
  if (isGmail) {
    errorMsg = `Gmail refuse les mots de passe ordinaires. Créez un mot de passe d'application :
1. Allez sur myaccount.google.com/security
2. Activez l'authentification à deux facteurs si ce n'est pas fait
3. Cherchez « Mots de passe des applications »
4. Générez un mot de passe pour « Mail » et « Windows Computer »
5. Utilisez ce mot de passe ici au lieu de votre mot de passe Gmail`;
  }
  res.json({ found: false, attempts, error: errorMsg });
}));

app.post('/api/accounts', wrap(async (req, res) => {
  const data = accountPayload(req.body);
  if (!data.imap_pass) throw new Error('Le mot de passe IMAP est obligatoire.');
  const isGmail = req.body.email.endsWith('@gmail.com') || req.body.email.endsWith('@googlemail.com');
  const keys = Object.keys(data);
  const info = db.prepare(`INSERT INTO accounts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => data[k]));
  const id = info.lastInsertRowid;
  try {
    await testImap(getAccount(id));
    db.prepare("UPDATE accounts SET status = 'connecté', last_error = NULL WHERE id = ?").run(id);
    createJob('sync', `Synchronisation ${data.email}`, { accountId: id });
  } catch (err) {
    let errorMsg = err.message;
    if (isGmail && err.message.includes('auth')) {
      errorMsg = `Gmail refuse les mots de passe ordinaires. Créez un mot de passe d'application sur myaccount.google.com/security et réessayez.`;
    }
    db.prepare("UPDATE accounts SET status = 'erreur', last_error = ? WHERE id = ?").run(errorMsg, id);
    return res.status(200).json({ id, warning: `Compte enregistré mais la connexion IMAP a échoué : ${errorMsg}` });
  }
  res.json({ id });
}));

app.put('/api/accounts/:id', wrap(async (req, res) => {
  const existing = getAccount(req.params.id);
  const data = accountPayload(req.body, existing);
  db.prepare(`UPDATE accounts SET ${Object.keys(data).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...Object.values(data), existing.id);
  res.json({ ok: true });
}));

app.delete('/api/accounts/:id', wrap((req, res) => {
  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/accounts/:id/test', wrap(async (req, res) => {
  const acc = getAccount(req.params.id);
  const isGmail = acc.email.endsWith('@gmail.com') || acc.email.endsWith('@googlemail.com');
  const result = { imap: null, smtp: null };
  try { result.imap = `OK · ${await testImap(acc)} dossier(s)`; } catch (err) {
    let msg = err.message;
    if (isGmail && msg.includes('auth')) {
      msg = `Erreur d'authentification. Gmail nécessite un mot de passe d'application, pas votre mot de passe ordinaire. Générateur : myaccount.google.com/security`;
    }
    result.imap = `Erreur : ${msg}`;
  }
  if (acc.smtp_host) {
    try { await testSmtp(acc); result.smtp = 'OK'; } catch (err) {
      let msg = err.message;
      if (isGmail && msg.includes('auth')) {
        msg = `Erreur d'authentification. Gmail nécessite un mot de passe d'application, pas votre mot de passe ordinaire. Générateur : myaccount.google.com/security`;
      }
      result.smtp = `Erreur : ${msg}`;
    }
  } else result.smtp = 'non configuré';
  res.json(result);
}));

app.post('/api/accounts/:id/sync', wrap((req, res) => {
  const acc = getAccount(req.params.id);
  res.json(createJob('sync', `Synchronisation ${acc.email}`, { accountId: acc.id }));
}));

app.post('/api/accounts/sync-all', wrap((req, res) => {
  const accounts = db.prepare('SELECT id, email FROM accounts ORDER BY id').all();
  const jobs = accounts.map((acc) => createJob('sync', `Synchronisation ${acc.email}`, { accountId: acc.id }));
  res.json({ ok: true, jobs });
}));

/* ---------------- Dossiers ---------------- */
app.get('/api/folders', wrap((req, res) => {
  const where = req.query.accountId ? 'WHERE account_id = ?' : '';
  const args = req.query.accountId ? [req.query.accountId] : [];
  res.json(db.prepare(`SELECT * FROM folders ${where} ORDER BY account_id, path`).all(...args));
}));

app.post('/api/folders', wrap(async (req, res) => {
  const { accountId, path: folderPath } = req.body;
  if (!folderPath) throw new Error('Chemin de dossier manquant.');
  await withImap(accountId, async (client) => {
    const boxes = await client.list();
    await ensureMailbox(client, folderPath, boxes[0]?.delimiter || '/');
  });
  await syncFolders(accountId);
  res.json({ ok: true });
}));

app.patch('/api/folders', wrap(async (req, res) => {
  const { accountId, path: from, newPath } = req.body;
  await withImap(accountId, (client) => client.mailboxRename(from, newPath));
  await syncFolders(accountId);
  res.json({ ok: true });
}));

app.delete('/api/folders', wrap(async (req, res) => {
  const { accountId, path: folderPath, force } = req.body;
  await withImap(accountId, async (client) => {
    const lock = await client.getMailboxLock(folderPath);
    let count = 0;
    try { count = client.mailbox.exists || 0; } finally { lock.release(); }
    if (count > 0 && !force) {
      throw new Error(`Le dossier contient ${count} message(s). Déplacez-les d'abord ou confirmez la suppression forcée.`);
    }
    await client.mailboxDelete(folderPath);
  });
  await syncFolders(accountId);
  res.json({ ok: true });
}));

/* ---------------- Messages ---------------- */
app.get('/api/messages', wrap((req, res) => {
  const { accountId, folder, q, limit = 100, offset = 0 } = req.query;
  const folderRow = db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(accountId, folder);
  if (!folderRow) return res.json({ messages: [], total: 0 });
  const filters = ['folder_id = ?'];
  const args = [folderRow.id];
  if (q) {
    filters.push('(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR snippet LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = filters.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) c FROM messages WHERE ${where}`).get(...args).c;
  const messages = db.prepare(`SELECT id, uid, subject, from_name, from_addr, to_addr, date, size, seen, flagged,
    answered, has_attachments, snippet FROM messages WHERE ${where} ORDER BY date DESC LIMIT ? OFFSET ?`)
    .all(...args, Number(limit), Number(offset));
  res.json({ messages, total });
}));

app.get('/api/messages/:id', wrap((req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) throw new Error('Message introuvable');
  res.json(msg);
}));

app.post('/api/messages/:id/flags', wrap(async (req, res) => {
  const msg = db.prepare('SELECT m.*, f.path FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?').get(req.params.id);
  if (!msg) throw new Error('Message introuvable');
  await setFlags(msg.account_id, msg.path, msg.uid, { add: req.body.add || [], remove: req.body.remove || [] });
  res.json({ ok: true });
}));

/* ---------------- Transferts (messages et dossiers) ---------------- */
app.post('/api/transfer', wrap((req, res) => {
  const { srcAccountId, srcPath, dstAccountId, dstPath, mode = 'move', uids = null,
    includeChildren = false, deleteSourceFolder = false } = req.body;
  const src = getAccount(srcAccountId);
  const dst = getAccount(dstAccountId);
  if (!srcPath || !dstPath) throw new Error('Dossier source et destination obligatoires.');
  if (src.id === dst.id && srcPath === dstPath) throw new Error('La source et la destination sont identiques.');
  const scope = uids?.length ? `${uids.length} message(s)` : `dossier ${srcPath}${includeChildren ? ' (+ sous-dossiers)' : ''}`;
  const label = `${mode === 'move' ? 'Déplacement' : 'Copie'} · ${scope} · ${src.email} → ${dst.email}/${dstPath}`;
  res.json(createJob('transfer', label, { srcAccountId: src.id, srcPath, dstAccountId: dst.id, dstPath, mode, uids, includeChildren, deleteSourceFolder }));
}));

/* ---------------- Envoi SMTP ---------------- */
app.post('/api/send', wrap(async (req, res) => {
  const { accountId, to, cc, subject, text, inReplyTo } = req.body;
  const acc = getAccount(accountId);
  const transport = buildTransport(acc);
  const info = await transport.sendMail({
    from: `${acc.name} <${acc.email}>`, to, cc: cc || undefined, subject, text,
    inReplyTo: inReplyTo || undefined, references: inReplyTo || undefined
  });
  res.json({ ok: true, messageId: info.messageId });
}));

/* ---------------- Traitements ---------------- */
app.get('/api/jobs', wrap((req, res) => res.json(listJobs(Number(req.query.limit || 50)))));
app.get('/api/jobs/:id', wrap((req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new Error('Traitement introuvable');
  res.json({ ...job, items: jobItems(job.id), logs: jobLogs(job.id) });
}));
app.post('/api/jobs/:id/cancel', wrap((req, res) => { requestCancel(Number(req.params.id)); res.json({ ok: true }); }));

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const onJob = (job) => res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
  const onLog = (entry) => res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  bus.on('job', onJob);
  bus.on('log', onLog);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bus.off('job', onJob); bus.off('log', onLog); });
});

/* ---------------- Sauvegardes ---------------- */
app.get('/api/backups', wrap((req, res) => res.json(listBackups())));
app.get('/api/backups/:id', wrap((req, res) => res.json(backupManifest(Number(req.params.id)))));
app.delete('/api/backups/:id', wrap((req, res) => { deleteBackup(Number(req.params.id)); res.json({ ok: true }); }));
app.post('/api/backups', wrap((req, res) => {
  const { accountId, folderPath, label } = req.body;
  const acc = getAccount(accountId);
  res.json(createJob('backup', `Sauvegarde · ${acc.email}${folderPath ? ` / ${folderPath}` : ''}`, { accountId: acc.id, folderPath: folderPath || null, label }));
}));
app.post('/api/backups/:id/restore', wrap((req, res) => {
  const backup = backupManifest(Number(req.params.id));
  const target = getAccount(req.body.targetAccountId || backup.account_id);
  res.json(createJob('restore', `Restauration · sauvegarde #${backup.id} → ${target.email}`, {
    backupId: backup.id, targetAccountId: target.id, mode: req.body.mode || 'original', onlyFolder: req.body.onlyFolder || null
  }));
}));

/* ---------------- Agent Ollama ---------------- */
app.get('/api/ollama', wrap(async (req, res) => res.json(await ollamaStatus())));
app.get('/api/chat/history', wrap((req, res) =>
  res.json(db.prepare('SELECT * FROM chat_messages ORDER BY id DESC LIMIT 40').all().reverse())));
app.delete('/api/chat/history', wrap((req, res) => { db.prepare('DELETE FROM chat_messages').run(); res.json({ ok: true }); }));

app.post('/api/chat', wrap(async (req, res) => {
  const { message, accountId, folderPath } = req.body;
  if (!message) throw new Error('Message vide.');
  db.prepare('INSERT INTO chat_messages (role, content) VALUES (?, ?)').run('user', message);
  const history = db.prepare('SELECT role, content FROM chat_messages ORDER BY id DESC LIMIT 8').all().reverse();
  const result = await askAgent({ message, accountId, folderPath, history });
  if (result.plan) result.preview = previewPlan(result.plan);
  db.prepare('INSERT INTO chat_messages (role, content, plan) VALUES (?, ?, ?)')
    .run('assistant', result.reponse, result.plan ? JSON.stringify(result.plan) : null);
  res.json(result);
}));

app.post('/api/chat/plan/execute', wrap((req, res) => {
  const { plan } = req.body;
  if (!plan?.actions?.length) throw new Error('Plan vide.');
  const acc = getAccount(plan.accountId);
  res.json(createJob('organize', `Rangement · ${plan.titre || 'plan'} · ${acc.email}`, { plan }));
}));

/* ---------------- Interface ---------------- */
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

/* ---------------- Synchronisation automatique périodique ---------------- */
const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000;
function autoSyncAll() {
  const accounts = db.prepare('SELECT id, email FROM accounts ORDER BY id').all();
  for (const acc of accounts) createJob('sync', `Synchronisation automatique ${acc.email}`, { accountId: acc.id });
}
setInterval(autoSyncAll, AUTO_SYNC_INTERVAL_MS);

recoverJobs();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MailZen démarré sur http://localhost:${PORT}`);
});
