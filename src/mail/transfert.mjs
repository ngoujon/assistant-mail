// Moteur de déplacement, message par message.
//
// Règle unique dont tout le reste découle : ON NE RETIRE JAMAIS UN MESSAGE DE LA
// SOURCE AVANT DE L'AVOIR VU ARRIVER À DESTINATION. Pour chaque message :
//
//   1. on télécharge le message brut et on le pose sur le disque (le « coffre ») ;
//   2. on le dépose à destination (APPEND entre boîtes, MOVE serveur dans la même) ;
//   3. on le relit à destination — par son UID, sinon par son Message-ID ;
//   4. seulement alors on le retire de la source, un UID à la fois ;
//   5. on écrit le journal.
//
// Un message qui échoue à l'étape 3 reste intact à la source et le traitement
// continue sur le suivant. Rien n'est jamais supprimé « en lot ».
import fs from 'node:fs'
import path from 'node:path'
import { P } from './paths.mjs'
import { withImap, withImapPair, ensureMailbox, delimiterOf } from './imap.mjs'
import { resolveAccount } from './accounts.mjs'
import { findSpecial } from './dossiers.mjs'
import { buildQuery } from './messages.mjs'
import { decodeWords } from './entetes.mjs'
import { createQueue, saveQueue, loadQueue, logQueue, countByState, totalItems, resume } from './file.mjs'
import { emitProgress } from './evenements.mjs'

export const PLAFOND_FILE = 20000

class Interrompu extends Error {}

// ------------------------------------------------------------------- plans

/** Recense les messages d'un dossier qui correspondent aux critères. */
export async function inventaire(client, dossier, criteres = {}) {
  await client.mailboxOpen(dossier, { readOnly: true })
  let uids
  if (Array.isArray(criteres?.uids) && criteres.uids.length) {
    uids = criteres.uids.map(Number).filter(Boolean)
  } else {
    uids = await client.search(buildQuery(criteres), { uid: true })
  }
  uids = (uids || []).sort((a, b) => a - b)
  const items = []
  if (uids.length) {
    for await (const msg of client.fetch(uids.join(','), { uid: true, envelope: true, size: true }, { uid: true })) {
      items.push({
        uid: msg.uid,
        message_id: msg.envelope?.messageId || null,
        sujet: msg.envelope?.subject ? decodeWords(msg.envelope.subject) : '(sans objet)',
        de: msg.envelope?.from?.[0]?.address || null,
        date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null,
        taille: msg.size || 0,
        statut: 'en_attente',
        dst_uid: null,
        detail: null,
      })
    }
  }
  return items
}

/** Les sous-dossiers d'une branche, racine comprise. */
export async function brancheDossiers(client, racine) {
  const list = await client.list()
  const box = list.find((b) => b.path === racine)
  if (!box) throw new Error(`Le dossier « ${racine} » n'existe pas.`)
  const sep = box.delimiter || '/'
  const enfants = list.filter((b) => b.path.startsWith(racine + sep) && !b.flags?.has?.('\\Noselect'))
  return { separateur: sep, dossiers: [box, ...enfants].map((b) => b.path) }
}

/**
 * Prépare une file (sans rien exécuter) et l'écrit sur disque.
 * @param {object} p
 * @param {'deplacement'|'copie'|'suppression_definitive'} p.type
 */
export async function preparerFile({ type, accSource, accCible, paires, intitule, options = {} }) {
  const total = paires.reduce((n, x) => n + x.items.length, 0)
  if (total > PLAFOND_FILE) {
    throw new Error(`${total} messages : au-delà de ${PLAFOND_FILE} par traitement, découpe (par année, par sous-dossier).`)
  }
  const q = createQueue({
    type,
    intitule,
    source: { compteId: accSource.id, compte: accSource.nom },
    cible: accCible ? { compteId: accCible.id, compte: accCible.nom } : null,
    options: { pause: 40, creerCible: true, ...options },
    paires,
  })
  logQueue(q, 'info', `${total} message(s) en file — ${intitule}`)
  return saveQueue(q)
}

// --------------------------------------------------------------- execution

function cheminCoffre(q, uid, dossier) {
  const sain = dossier.replace(/[^\w.-]+/g, '_').slice(0, 60)
  return path.join(P.vault(q.id), `${sain}-${uid}.eml`)
}

async function verifierADestination(cible, dossierCible, { dstUid, messageId }) {
  if (dstUid) {
    try {
      const trouve = await cible.fetchOne(String(dstUid), { uid: true, envelope: true }, { uid: true })
      if (trouve && (!messageId || !trouve.envelope?.messageId || trouve.envelope.messageId === messageId)) {
        return trouve.uid
      }
    } catch {}
  }
  if (messageId) {
    try {
      const uids = await cible.search({ header: { 'message-id': messageId } }, { uid: true })
      if (uids?.length) return uids[uids.length - 1]
    } catch {}
  }
  return null
}

/**
 * Exécute une file déjà préparée sur des connexions ouvertes.
 * Séparé de `executerFile` pour être testable avec un serveur simulé.
 */
export async function runTransfer(q, { source, cible, signal, pause = 40 } = {}) {
  const memeCompte = !q.cible || q.cible.compteId === q.source.compteId
  const supprimeSource = q.type === 'deplacement' || q.type === 'suppression_definitive'
  fs.mkdirSync(P.vault(q.id), { recursive: true })

  q.statut = 'en_cours'
  q.demarreLe = q.demarreLe || new Date().toISOString()
  saveQueue(q)

  const avancer = (message) => {
    const c = countByState(q)
    emitProgress({ k: 'file', id: q.id, intitule: q.intitule, total: totalItems(q), faits: c.termine, echecs: c.echec, message })
  }

  try {
    for (const paire of q.paires) {
      if (paire.items.every((it) => it.statut === 'termine' || it.statut === 'ignore')) continue
      await preparerPaire(q, paire, { source, cible, memeCompte, supprimeSource })

      for (const item of paire.items) {
        if (signal?.aborted) throw new Interrompu()
        if (item.statut === 'termine' || item.statut === 'ignore') continue
        try {
          await traiterMessage(q, paire, item, { source, cible, memeCompte, supprimeSource })
        } catch (err) {
          if (err instanceof Interrompu) throw err
          item.statut = 'echec'
          item.detail = String(err?.message || err)
          logQueue(q, 'erreur', `UID ${item.uid} « ${item.sujet} » : ${item.detail}`)
        }
        saveQueue(q)
        avancer(`${item.sujet}`)
        if (pause) await new Promise((r) => setTimeout(r, pause))
      }
    }

    const c = countByState(q)
    q.statut = c.echec ? 'termine_avec_echecs' : 'termine'
    q.termineLe = new Date().toISOString()
    logQueue(q, 'info', `Terminé : ${c.termine} traité(s), ${c.echec} échec(s).`)
  } catch (err) {
    if (err instanceof Interrompu) {
      q.statut = 'interrompu'
      logQueue(q, 'info', 'Interrompu — le traitement peut être repris.')
    } else {
      q.statut = 'echec'
      q.erreur = String(err?.message || err)
      logQueue(q, 'erreur', q.erreur)
    }
  }
  saveQueue(q)
  avancer(q.statut)
  return resume(q)
}

async function preparerPaire(q, paire, { source, cible, memeCompte, supprimeSource }) {
  await source.mailboxOpen(paire.de, { readOnly: false })

  // Filet anti-EXPUNGE : sans UIDPLUS, retirer un message peut purger tous les
  // messages déjà marqués « supprimé » du dossier. On refuse plutôt que de risquer
  // d'emporter des messages qui ne nous appartiennent pas.
  if (supprimeSource && !source.capabilities?.has?.('UIDPLUS')) {
    const dejaMarques = await source.search({ deleted: true }, { uid: true })
    if (dejaMarques?.length) {
      throw new Error(
        `« ${paire.de} » contient ${dejaMarques.length} message(s) déjà marqués « supprimé » et le serveur ne gère pas UID EXPUNGE. ` +
        'Vide la corbeille de ce dossier depuis ton client mail habituel, puis relance : sinon ils seraient purgés avec les nôtres.',
      )
    }
  }

  if (paire.vers) {
    if (q.options.creerCible !== false) {
      const crees = await ensureMailbox(cible, paire.vers, await delimiterOf(cible))
      if (crees.length) logQueue(q, 'info', `Dossier créé à destination : ${crees.join(', ')}`)
    }
    await cible.mailboxOpen(paire.vers, { readOnly: false })
  }
  logQueue(q, 'info', `${paire.de}${paire.vers ? ` → ${paire.vers}` : ''} : ${paire.items.length} message(s)`)
}

async function traiterMessage(q, paire, item, { source, cible, memeCompte, supprimeSource }) {
  // Reprise : un message déjà posé et vérifié n'a plus qu'à quitter la source.
  const brut = await source.fetchOne(String(item.uid), { uid: true, source: true, flags: true, internalDate: true, envelope: true }, { uid: true })

  if (!brut?.source) {
    if (item.statut === 'verifie' || item.statut === 'copie') {
      item.statut = 'termine'
      item.detail = 'déjà retiré de la source lors d\'un passage précédent'
      return
    }
    item.statut = 'echec'
    item.detail = 'introuvable à la source (déplacé ou supprimé entre-temps)'
    return
  }

  const messageId = brut.envelope?.messageId || item.message_id || null
  item.message_id = messageId

  // 1. Copie brute sur disque : le filet de sécurité ultime.
  if (supprimeSource) {
    const eml = cheminCoffre(q, item.uid, paire.de)
    if (!fs.existsSync(eml)) fs.writeFileSync(eml, brut.source)
    item.coffre = path.relative(P.vault(q.id), eml)
  }

  // 2 & 3. Dépose à destination, puis relecture.
  if (paire.vers) {
    if (item.statut === 'en_attente') {
      const drapeaux = [...(brut.flags || [])].filter((f) => f !== '\\Recent')
      if (memeCompte && q.type === 'deplacement') {
        const res = await source.messageMove(String(item.uid), paire.vers, { uid: true })
        item.dst_uid = res?.uidMap?.get?.(item.uid) ?? null
        item.statut = 'copie'
        item.detail = 'MOVE serveur'
      } else {
        const res = await cible.append(paire.vers, brut.source, drapeaux, brut.internalDate)
        item.dst_uid = res?.uid ?? null
        item.statut = 'copie'
        item.detail = 'APPEND'
      }
    }

    const uidCible = await verifierADestination(cible, paire.vers, { dstUid: item.dst_uid, messageId })
    if (!uidCible) {
      item.statut = 'echec'
      item.detail = 'introuvable à destination après dépôt — rien n\'a été retiré de la source'
      return
    }
    item.dst_uid = uidCible
    item.statut = 'verifie'

    // Le MOVE serveur a déjà retiré le message de la source.
    if (memeCompte && q.type === 'deplacement') {
      item.statut = 'termine'
      return
    }
  }

  // 4. Retrait de la source, cet UID et lui seul.
  if (!supprimeSource) {
    item.statut = 'termine'
    return
  }
  await source.messageDelete(String(item.uid), { uid: true })
  const reste = await source.fetchOne(String(item.uid), { uid: true }, { uid: true }).catch(() => null)
  if (reste) {
    item.statut = 'echec'
    item.detail = 'le serveur n\'a pas retiré le message de la source (il est en double : à destination ET à la source)'
    return
  }
  item.statut = 'termine'
}

/** Ouvre les connexions et exécute la file. */
export async function executerFile(q, { signal } = {}) {
  const accSource = resolveAccount(q.source.compteId)
  const accCible = q.cible ? resolveAccount(q.cible.compteId) : accSource
  return withImapPair(accSource, accCible, (source, cible) =>
    runTransfer(q, { source, cible, signal, pause: q.options?.pause ?? 40 }),
  )
}

export function reprendreFile(id, opts) {
  const q = loadQueue(id)
  if (q.statut === 'termine') throw new Error(`Le traitement « ${id} » est déjà terminé.`)
  return executerFile(q, opts)
}

// ------------------------------------------------------- fabriques de files

export async function fileDeplacementMessages({ accSource, dossierSource, accCible, dossierCible, criteres, type = 'deplacement', options }) {
  const items = await withImap(accSource, (client) => inventaire(client, dossierSource, criteres))
  if (!items.length) throw new Error(`Aucun message ne correspond dans « ${dossierSource} ».`)
  const verbe = type === 'copie' ? 'Copie' : 'Déplacement'
  return preparerFile({
    type,
    accSource,
    accCible,
    intitule: `${verbe} de ${items.length} message(s) — ${accSource.nom}/${dossierSource} → ${accCible.nom}/${dossierCible}`,
    paires: [{ de: dossierSource, vers: dossierCible, items }],
    options,
  })
}

export async function fileSuppressionMessages({ acc, dossier, criteres, definitif = false, options }) {
  if (definitif) {
    const items = await withImap(acc, (client) => inventaire(client, dossier, criteres))
    if (!items.length) throw new Error(`Aucun message ne correspond dans « ${dossier} ».`)
    return preparerFile({
      type: 'suppression_definitive',
      accSource: acc,
      accCible: null,
      intitule: `Suppression définitive de ${items.length} message(s) — ${acc.nom}/${dossier}`,
      paires: [{ de: dossier, vers: null, items }],
      options,
    })
  }
  const { corbeille, items } = await withImap(acc, async (client) => {
    const corbeille = await findSpecial(client, '\\Trash')
    if (!corbeille) throw new Error(`Aucune corbeille détectée sur « ${acc.nom} ». Précise le dossier de destination.`)
    return { corbeille, items: await inventaire(client, dossier, criteres) }
  })
  if (!items.length) throw new Error(`Aucun message ne correspond dans « ${dossier} ».`)
  if (dossier === corbeille) throw new Error('Ces messages sont déjà dans la corbeille : pour les effacer, demande une suppression définitive.')
  return preparerFile({
    type: 'deplacement',
    accSource: acc,
    accCible: acc,
    intitule: `Mise à la corbeille de ${items.length} message(s) — ${acc.nom}/${dossier} → ${corbeille}`,
    paires: [{ de: dossier, vers: corbeille, items }],
    options,
  })
}

/** Déplace une branche entière (dossier + sous-dossiers) vers une autre boîte. */
export async function fileDeplacementDossier({ accSource, racine, accCible, cible, type = 'deplacement', options }) {
  const { separateur, dossiers } = await withImap(accSource, (client) => brancheDossiers(client, racine))
  const sepCible = await withImap(accCible, (client) => delimiterOf(client))
  const paires = []
  let total = 0
  await withImap(accSource, async (client) => {
    for (const d of dossiers) {
      const relatif = d === racine ? '' : d.slice(racine.length + separateur.length)
      const vers = relatif ? `${cible}${sepCible}${relatif.split(separateur).join(sepCible)}` : cible
      const items = await inventaire(client, d, {})
      total += items.length
      paires.push({ de: d, vers, items })
    }
  })
  const verbe = type === 'copie' ? 'Copie' : 'Déplacement'
  return preparerFile({
    type,
    accSource,
    accCible,
    intitule: `${verbe} de la branche « ${racine} » (${dossiers.length} dossier(s), ${total} message(s)) — ${accSource.nom} → ${accCible.nom}/${cible}`,
    paires,
    options,
  })
}
