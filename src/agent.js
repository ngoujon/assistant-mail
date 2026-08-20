import { OLLAMA_URL, OLLAMA_API_KEY, OLLAMA_MODEL } from './config.js';
import { db } from './db.js';
import { withImap, getAccount, ensureMailbox } from './imap.js';
import { registerRunner, addItem, setItem, updateJob } from './jobs.js';
import { syncFolders, syncFolderMessages } from './sync.js';

function ollamaHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (OLLAMA_API_KEY) {
    headers['Authorization'] = `Bearer ${OLLAMA_API_KEY}`;
  }
  return headers;
}

export async function ollamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { headers: ollamaHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return { online: true, url: OLLAMA_URL, model: OLLAMA_MODEL, models, modelInstalled: models.some((m) => m === OLLAMA_MODEL || m.startsWith(`${OLLAMA_MODEL}:`)) };
  } catch (err) {
    return { online: false, url: OLLAMA_URL, model: OLLAMA_MODEL, models: [], error: err.message };
  }
}

async function ollamaChat(messages, { json = false, model } = {}) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: ollamaHeaders(),
    body: JSON.stringify({
      model: model || OLLAMA_MODEL,
      messages,
      stream: false,
      ...(json ? { format: 'json' } : {}),
      options: { temperature: 0.2 }
    }),
    signal: AbortSignal.timeout(300000)
  });
  if (!res.ok) throw new Error(`Ollama a répondu ${res.status} : ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.message?.content || '';
}

/** Résumé du contenu d'un dossier, transmis au modèle pour qu'il propose un rangement. */
export function folderContext(accountId, folderPath, sampleSize = 60) {
  const folder = db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(accountId, folderPath);
  if (!folder) return null;
  const senders = db.prepare(`
    SELECT from_addr, COUNT(*) n FROM messages WHERE folder_id = ? AND from_addr <> ''
    GROUP BY from_addr ORDER BY n DESC LIMIT 25`).all(folder.id);
  const samples = db.prepare('SELECT subject, from_addr, date FROM messages WHERE folder_id = ? ORDER BY date DESC LIMIT ?')
    .all(folder.id, sampleSize);
  const siblings = db.prepare('SELECT path, total FROM folders WHERE account_id = ? ORDER BY path').all(accountId);
  return { folder: folder.path, count: db.prepare('SELECT COUNT(*) c FROM messages WHERE folder_id = ?').get(folder.id).c, senders, samples, existingFolders: siblings.map((s) => s.path) };
}

const SYSTEM_PROMPT = `Tu es MailZen, un assistant de rangement de boîtes mail. Tu réponds toujours en français.
Tu reçois la description d'un dossier IMAP (expéditeurs fréquents, exemples de sujets, dossiers existants).
Tu proposes un plan de rangement concret et prudent.
Réponds UNIQUEMENT avec un objet JSON valide de la forme :
{
  "reponse": "explication courte en français de ta proposition",
  "plan": {
    "titre": "titre court du plan",
    "actions": [
      {"type": "create_folder", "path": "Nom/Sous-dossier", "raison": "..."},
      {"type": "move_messages", "from": "INBOX", "to": "Nom/Sous-dossier",
       "match": {"fromContains": ["exemple.com"], "subjectContains": ["facture"], "olderThanDays": 90, "seen": true},
       "raison": "..."}
    ]
  }
}
Règles : ne supprime jamais de message (utilise un déplacement vers la corbeille si nécessaire),
regroupe par expéditeur ou thème, maximum 12 actions, les chemins utilisent "/" comme séparateur.
Si l'utilisateur pose une simple question, renvoie {"reponse": "...", "plan": null}.`;

export async function askAgent({ message, accountId, folderPath, history = [] }) {
  const context = accountId && folderPath ? folderContext(accountId, folderPath) : null;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-6).map((m) => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: context
        ? `${message}\n\nContexte du dossier @${folderPath} :\n${JSON.stringify(context).slice(0, 12000)}`
        : message
    }
  ];
  const raw = await ollamaChat(messages, { json: true });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { reponse: raw, plan: null };
  }
  const plan = parsed.plan && Array.isArray(parsed.plan.actions) && parsed.plan.actions.length ? parsed.plan : null;
  if (plan) plan.accountId = accountId;
  return { reponse: parsed.reponse || '(pas de réponse)', plan };
}

/** Sélection locale des messages correspondant à une règle du plan. */
export function matchMessages(accountId, fromPath, match = {}) {
  const folder = db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(accountId, fromPath);
  if (!folder) return [];
  let rows = db.prepare('SELECT uid, subject, from_addr, date, seen FROM messages WHERE folder_id = ?').all(folder.id);
  const lower = (s) => String(s || '').toLowerCase();
  if (match.fromContains?.length) {
    const needles = match.fromContains.map(lower);
    rows = rows.filter((r) => needles.some((n) => lower(r.from_addr).includes(n)));
  }
  if (match.subjectContains?.length) {
    const needles = match.subjectContains.map(lower);
    rows = rows.filter((r) => needles.some((n) => lower(r.subject).includes(n)));
  }
  if (match.olderThanDays) {
    const limit = Date.now() - match.olderThanDays * 86400000;
    rows = rows.filter((r) => new Date(r.date).getTime() < limit);
  }
  if (match.seen === true) rows = rows.filter((r) => r.seen === 1);
  if (match.seen === false) rows = rows.filter((r) => r.seen === 0);
  return rows;
}

/** Prévisualisation d'un plan avant acceptation par l'utilisateur. */
export function previewPlan(plan) {
  const accountId = plan.accountId;
  return (plan.actions || []).map((action) => {
    if (action.type === 'create_folder') return { ...action, count: null };
    const rows = matchMessages(accountId, action.from, action.match || {});
    return { ...action, count: rows.length, examples: rows.slice(0, 3).map((r) => r.subject) };
  });
}

/** ---------- Exécution d'un plan validé ---------- */
async function runOrganize(ctx) {
  const { plan } = ctx.params;
  const accountId = plan.accountId;
  const acc = getAccount(accountId);
  const actions = plan.actions || [];
  updateJob(ctx.id, { total: actions.length, done: 0 });
  ctx.log(`Exécution du plan « ${plan.titre || 'rangement'} » sur ${acc.email} (${actions.length} action(s)).`);

  await withImap(acc, async (client) => {
    const boxes = await client.list();
    const delimiter = boxes[0]?.delimiter || '/';
    let index = 0;
    for (const action of actions) {
      if (ctx.cancelled()) break;
      const itemId = addItem(ctx.id, `${action.type} · ${action.to || action.path || ''}`);
      try {
        if (action.type === 'create_folder') {
          const target = action.path.split('/').join(delimiter);
          const created = await ensureMailbox(client, target, delimiter);
          setItem(itemId, { status: 'termine', detail: created ? 'dossier créé' : 'dossier déjà existant' });
          ctx.log(`Dossier ${target} : ${created ? 'créé' : 'déjà présent'}.`);
        } else if (action.type === 'move_messages') {
          const target = action.to.split('/').join(delimiter);
          await ensureMailbox(client, target, delimiter);
          const rows = matchMessages(accountId, action.from, action.match || {});
          const uids = rows.map((r) => r.uid);
          if (!uids.length) {
            setItem(itemId, { status: 'ignore', detail: 'aucun message correspondant' });
          } else {
            const lock = await client.getMailboxLock(action.from);
            let moved = 0;
            try {
              for (let i = 0; i < uids.length; i += 100) {
                // Déplacement serveur : atomique, aucun risque de perte.
                await client.messageMove(uids.slice(i, i + 100), target, { uid: true });
                moved += uids.slice(i, i + 100).length;
              }
            } finally {
              lock.release();
            }
            setItem(itemId, { status: 'termine', detail: `${moved} message(s) déplacé(s) vers ${target}` });
            ctx.log(`${moved} message(s) déplacé(s) de ${action.from} vers ${target}.`);
          }
        } else {
          setItem(itemId, { status: 'ignore', detail: `action inconnue : ${action.type}` });
        }
      } catch (err) {
        setItem(itemId, { status: 'echec', detail: err.message });
        db.prepare('UPDATE jobs SET failed = failed + 1 WHERE id = ?').run(ctx.id);
        ctx.log(`Action en échec (${action.type}) : ${err.message}`, 'error');
      }
      ctx.progress(++index);
    }
  });

  ctx.phase('mise à jour du cache local');
  await syncFolders(accountId).catch(() => {});
  const touched = new Set(actions.flatMap((a) => [a.from, a.to].filter(Boolean)));
  for (const p of touched) await syncFolderMessages(accountId, p).catch(() => {});
  return { phase: 'rangement terminé' };
}

registerRunner('organize', runOrganize);
