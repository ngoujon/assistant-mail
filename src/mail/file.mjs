// La file d'attente d'un traitement, écrite sur disque après CHAQUE message.
// C'est le journal qui rend un déplacement reprenable : si l'app tombe au
// message 412 sur 900, on sait exactement lesquels sont posés à destination,
// lesquels sont vérifiés, et lesquels ont été retirés de la source.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { P } from './paths.mjs'

export const ETATS = ['en_attente', 'copie', 'verifie', 'termine', 'echec', 'ignore']

export function newQueueId() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  // Le suffixe aléatoire n'est pas cosmétique : deux traitements lancés dans la
  // même seconde partageraient sinon leur journal ET leur coffre.
  const sel = randomBytes(2).toString('hex')
  return `f${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${sel}`
}

export function createQueue(data) {
  const q = {
    id: newQueueId(),
    creeLe: new Date().toISOString(),
    statut: 'en_attente',
    ...data,
    journal: [],
  }
  saveQueue(q)
  return q
}

export function saveQueue(q) {
  const file = P.queue(q.id)
  const tmp = `${file}.tmp`
  // Écriture atomique : un plantage en plein enregistrement ne doit pas
  // laisser un journal tronqué, sinon la reprise part sur de fausses bases.
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2))
  fs.renameSync(tmp, file)
  return q
}

export function loadQueue(id) {
  try {
    return JSON.parse(fs.readFileSync(P.queue(id), 'utf8'))
  } catch {
    throw new Error(`Traitement « ${id} » introuvable.`)
  }
}

export function listQueues({ limite = 20 } = {}) {
  let noms = []
  try { noms = fs.readdirSync(P.queues()).filter((f) => f.endsWith('.json')) } catch { return [] }
  return noms
    .sort()
    .reverse()
    .slice(0, limite)
    .map((f) => {
      try {
        const q = JSON.parse(fs.readFileSync(path.join(P.queues(), f), 'utf8'))
        return resume(q)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

export function logQueue(q, niveau, message) {
  q.journal.push({ t: new Date().toISOString(), niveau, message })
  if (q.journal.length > 2000) q.journal.splice(0, q.journal.length - 2000)
}

export function countByState(q) {
  const c = Object.fromEntries(ETATS.map((e) => [e, 0]))
  for (const paire of q.paires) for (const it of paire.items) c[it.statut] = (c[it.statut] || 0) + 1
  return c
}

export function totalItems(q) {
  return q.paires.reduce((n, p) => n + p.items.length, 0)
}

/** Vue compacte, destinée à l'assistant et à l'interface. */
export function resume(q) {
  const c = countByState(q)
  return {
    id: q.id,
    type: q.type,
    intitule: q.intitule,
    statut: q.statut,
    creeLe: q.creeLe,
    termineLe: q.termineLe || null,
    source: q.source,
    cible: q.cible,
    total: totalItems(q),
    faits: c.termine,
    echecs: c.echec,
    restants: c.en_attente + c.copie + c.verifie,
    ignores: c.ignore,
    erreur: q.erreur || null,
  }
}
