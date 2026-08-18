import { EventEmitter } from 'node:events';
import { db } from './db.js';

export const bus = new EventEmitter();
bus.setMaxListeners(50);

const runners = new Map();
let running = false;

export function registerRunner(type, fn) {
  runners.set(type, fn);
}

export function createJob(type, label, params = {}, total = 0) {
  const info = db.prepare('INSERT INTO jobs (type, label, params, total) VALUES (?, ?, ?, ?)')
    .run(type, label, JSON.stringify(params), total);
  const job = getJob(info.lastInsertRowid);
  bus.emit('job', job);
  setImmediate(pump);
  return job;
}

export function getJob(id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function listJobs(limit = 50) {
  return db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit);
}

export function log(jobId, message, level = 'info') {
  db.prepare('INSERT INTO job_logs (job_id, level, message) VALUES (?, ?, ?)').run(jobId, level, String(message));
  bus.emit('log', { job_id: jobId, level, message: String(message) });
}

export function updateJob(id, patch) {
  const fields = Object.keys(patch);
  if (!fields.length) return;
  db.prepare(`UPDATE jobs SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...fields.map((f) => patch[f]), id);
  bus.emit('job', getJob(id));
}

export function isCancelled(id) {
  return !!db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(id)?.cancel_requested;
}

export function requestCancel(id) {
  db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(id);
  const job = getJob(id);
  if (job && job.status === 'en_attente') {
    updateJob(id, { status: 'annule', finished_at: new Date().toISOString() });
  }
  bus.emit('job', getJob(id));
}

export function addItem(jobId, ref, srcUid = null) {
  return db.prepare('INSERT INTO job_items (job_id, ref, src_uid) VALUES (?, ?, ?)')
    .run(jobId, ref, srcUid).lastInsertRowid;
}

export function setItem(itemId, patch) {
  const fields = Object.keys(patch);
  db.prepare(`UPDATE job_items SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...fields.map((f) => patch[f]), itemId);
}

export function jobItems(jobId, limit = 500) {
  return db.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY id LIMIT ?').all(jobId, limit);
}

export function jobLogs(jobId, limit = 300) {
  return db.prepare('SELECT * FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(jobId, limit).reverse();
}

/** Contexte fourni à chaque runner de traitement. */
function ctx(jobId) {
  return {
    id: jobId,
    log: (m, level) => log(jobId, m, level),
    progress: (done, total, phase) => {
      const patch = { done };
      if (total != null) patch.total = total;
      if (phase) patch.phase = phase;
      updateJob(jobId, patch);
    },
    phase: (p) => updateJob(jobId, { phase: p }),
    cancelled: () => isCancelled(jobId),
    params: JSON.parse(getJob(jobId).params || '{}')
  };
}

async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = db.prepare("SELECT * FROM jobs WHERE status = 'en_attente' ORDER BY id LIMIT 1").get();
      if (!job) break;
      const runner = runners.get(job.type);
      updateJob(job.id, { status: 'en_cours', started_at: new Date().toISOString() });
      if (!runner) {
        updateJob(job.id, { status: 'echec', error: `Type de traitement inconnu : ${job.type}`, finished_at: new Date().toISOString() });
        continue;
      }
      try {
        const result = await runner(ctx(job.id));
        const fresh = getJob(job.id);
        const status = isCancelled(job.id) ? 'annule' : (fresh.failed > 0 ? 'termine_avec_erreurs' : 'termine');
        updateJob(job.id, { status, finished_at: new Date().toISOString(), phase: result?.phase || 'terminé' });
      } catch (err) {
        log(job.id, `Échec : ${err.message}`, 'error');
        updateJob(job.id, { status: 'echec', error: err.message, finished_at: new Date().toISOString() });
      }
    }
  } finally {
    running = false;
  }
}

/** Au démarrage : les traitements interrompus par un arrêt du serveur sont remis en file. */
export function recoverJobs() {
  const stale = db.prepare("SELECT id, type FROM jobs WHERE status = 'en_cours'").all();
  for (const job of stale) {
    log(job.id, "Traitement interrompu par un redémarrage du serveur : reprise en file d'attente.", 'warn');
    db.prepare("UPDATE jobs SET status = 'en_attente', phase = 'reprise après redémarrage' WHERE id = ?").run(job.id);
  }
  setImmediate(pump);
}

export { pump };
