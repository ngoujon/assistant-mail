// Lecture des messages : recherche, consultation, agrégats par expéditeur,
// inventaire des abonnements. Tout ici ouvre les dossiers en LECTURE SEULE :
// consulter un message ne doit jamais le marquer comme lu.
import { simpleParser } from 'mailparser'
import { withImap } from './imap.mjs'
import { parseHeaders, header, decodeWords } from './entetes.mjs'

/** Plafond de sécurité : au-delà on tronque et on le dit, plutôt que d'exploser. */
export const PLAFOND_ANALYSE = 5000

export function buildQuery(criteres = {}) {
  const q = {}
  if (criteres.de) q.from = criteres.de
  if (criteres.a) q.to = criteres.a
  if (criteres.sujet) q.subject = criteres.sujet
  if (criteres.texte) q.body = criteres.texte
  if (criteres.depuis) q.since = new Date(criteres.depuis)
  if (criteres.avant) q.before = new Date(criteres.avant)
  if (criteres.non_lus === true) q.seen = false
  if (criteres.lus === true) q.seen = true
  if (criteres.suivis === true) q.flagged = true
  if (criteres.taille_min) q.larger = Number(criteres.taille_min)
  if (!Object.keys(q).length) q.all = true
  return q
}

function adresse(env) {
  const a = env?.from?.[0]
  if (!a) return { nom: null, adresse: null }
  return { nom: a.name ? decodeWords(a.name) : null, adresse: (a.address || '').toLowerCase() }
}

function resumeMessage(msg) {
  const env = msg.envelope || {}
  const exp = adresse(env)
  return {
    uid: msg.uid,
    date: env.date ? new Date(env.date).toISOString() : null,
    de: exp.adresse,
    de_nom: exp.nom,
    sujet: env.subject ? decodeWords(env.subject) : '(sans objet)',
    taille: msg.size ?? null,
    lu: msg.flags?.has?.('\\Seen') ?? null,
    suivi: msg.flags?.has?.('\\Flagged') ?? null,
    message_id: env.messageId || null,
  }
}

/** UIDs correspondant aux critères, du plus récent au plus ancien. */
async function chercherUids(client, dossier, criteres) {
  await client.mailboxOpen(dossier, { readOnly: true })
  if (Array.isArray(criteres?.uids) && criteres.uids.length) {
    return criteres.uids.map(Number).filter(Boolean).sort((a, b) => b - a)
  }
  const uids = await client.search(buildQuery(criteres), { uid: true })
  return (uids || []).sort((a, b) => b - a)
}

export async function searchMessages(acc, dossier, criteres = {}, { limite = 50 } = {}) {
  return withImap(acc, async (client) => {
    const uids = await chercherUids(client, dossier, criteres)
    const total = uids.length
    const retenus = uids.slice(0, Math.max(1, Math.min(limite, 500)))
    const messages = []
    if (retenus.length) {
      for await (const msg of client.fetch(retenus.join(','), { uid: true, envelope: true, size: true, flags: true }, { uid: true })) {
        messages.push(resumeMessage(msg))
      }
    }
    messages.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    return { dossier, total, affiches: messages.length, messages }
  })
}

export async function readMessage(acc, dossier, uid, { html = false, maxTexte = 6000 } = {}) {
  return withImap(acc, async (client) => {
    await client.mailboxOpen(dossier, { readOnly: true })
    const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true })
    if (!msg?.source) throw new Error(`Message ${uid} introuvable dans « ${dossier} ».`)
    const mail = await simpleParser(msg.source)
    let texte = (mail.text || '').trim()
    let tronque = false
    if (texte.length > maxTexte) { texte = texte.slice(0, maxTexte); tronque = true }
    return {
      uid: Number(uid),
      dossier,
      de: mail.from?.text || null,
      a: mail.to?.text || null,
      copie: mail.cc?.text || null,
      date: mail.date ? mail.date.toISOString() : null,
      sujet: mail.subject || '(sans objet)',
      message_id: mail.messageId || null,
      lu: msg.flags?.has?.('\\Seen') ?? null,
      pieces_jointes: (mail.attachments || []).map((p) => ({ nom: p.filename, type: p.contentType, taille: p.size })),
      liste: mail.headers?.get?.('list-id') ? String(mail.headers.get('list-id')) : null,
      desabonnement: mail.headers?.get?.('list-unsubscribe') ? String(mail.headers.get('list-unsubscribe')) : null,
      texte,
      texte_tronque: tronque,
      html: html ? (mail.html || null) : undefined,
    }
  })
}

/** Combien de messages par expéditeur — la question « qui m'écrit le plus ». */
export async function senders(acc, dossier, criteres = {}, { limite = 40 } = {}) {
  return withImap(acc, async (client) => {
    const uids = await chercherUids(client, dossier, criteres)
    const analyses = uids.slice(0, PLAFOND_ANALYSE)
    const par = new Map()
    if (analyses.length) {
      for await (const msg of client.fetch(analyses.join(','), { uid: true, envelope: true, size: true }, { uid: true })) {
        const exp = adresse(msg.envelope)
        if (!exp.adresse) continue
        const cle = exp.adresse
        const e = par.get(cle) || { adresse: cle, nom: exp.nom, messages: 0, octets: 0, dernier: null, exemple_uid: msg.uid }
        e.messages++
        e.octets += msg.size || 0
        const d = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null
        if (d && (!e.dernier || d > e.dernier)) e.dernier = d
        par.set(cle, e)
      }
    }
    const liste = [...par.values()].sort((a, b) => b.messages - a.messages).slice(0, limite)
    return { dossier, messages_analyses: analyses.length, total: uids.length, tronque: uids.length > analyses.length, expediteurs: liste }
  })
}

const RE_MAILTO = /<(mailto:[^>]+)>/gi
const RE_HTTP = /<(https?:\/\/[^>]+)>/gi

function methodesDesabonnement(valeur, oneClick) {
  if (!valeur) return []
  const out = []
  for (const m of valeur.matchAll(RE_MAILTO)) out.push({ type: 'mailto', cible: m[1] })
  for (const m of valeur.matchAll(RE_HTTP)) out.push({ type: oneClick ? 'http_un_clic' : 'http', cible: m[1] })
  return out
}

/**
 * Inventaire des abonnements d'un dossier : tout ce qui porte un List-Id ou un
 * List-Unsubscribe est regroupé, compté, et accompagné de la façon de s'en défaire.
 */
export async function newsletters(acc, dossier, criteres = {}, { limite = 100 } = {}) {
  return withImap(acc, async (client) => {
    const uids = await chercherUids(client, dossier, criteres)
    const analyses = uids.slice(0, PLAFOND_ANALYSE)
    const par = new Map()
    if (analyses.length) {
      const requete = { uid: true, envelope: true, size: true, headers: ['list-id', 'list-unsubscribe', 'list-unsubscribe-post', 'precedence'] }
      for await (const msg of client.fetch(analyses.join(','), requete, { uid: true })) {
        const h = parseHeaders(msg.headers)
        const listId = header(h, 'list-id')
        const unsub = header(h, 'list-unsubscribe')
        if (!listId && !unsub) continue
        const exp = adresse(msg.envelope)
        const cle = (listId || exp.adresse || 'inconnu').replace(/^.*<|>.*$/g, '').toLowerCase()
        const oneClick = /one-?click/i.test(header(h, 'list-unsubscribe-post') || '')
        const e = par.get(cle) || {
          liste: cle,
          nom: exp.nom || exp.adresse,
          expediteur: exp.adresse,
          messages: 0,
          octets: 0,
          premier: null,
          dernier: null,
          exemple_uid: msg.uid,
          desabonnement: methodesDesabonnement(unsub, oneClick),
        }
        e.messages++
        e.octets += msg.size || 0
        const d = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null
        if (d) {
          if (!e.dernier || d > e.dernier) { e.dernier = d; e.exemple_uid = msg.uid }
          if (!e.premier || d < e.premier) e.premier = d
        }
        if (!e.desabonnement.length) e.desabonnement = methodesDesabonnement(unsub, oneClick)
        par.set(cle, e)
      }
    }
    const liste = [...par.values()].sort((a, b) => b.messages - a.messages).slice(0, limite)
    return {
      dossier,
      messages_analyses: analyses.length,
      total: uids.length,
      tronque: uids.length > analyses.length,
      abonnements: liste.length,
      newsletters: liste,
    }
  })
}
