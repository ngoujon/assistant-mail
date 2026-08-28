// Actions ponctuelles : drapeaux, désabonnement, envoi SMTP.
import { withImap, buildTransport } from './imap.mjs'
import { parseHeaders, header } from './entetes.mjs'

/** Marque des messages comme lus/non lus, suivis/non suivis. */
export async function markMessages(acc, dossier, uids, { lu, suivi }) {
  const liste = uids.map(Number).filter(Boolean)
  if (!liste.length) throw new Error('Aucun UID fourni.')
  return withImap(acc, async (client) => {
    await client.mailboxOpen(dossier, { readOnly: false })
    const fait = []
    if (lu === true) { await client.messageFlagsAdd(liste.join(','), ['\\Seen'], { uid: true }); fait.push('marqués lus') }
    if (lu === false) { await client.messageFlagsRemove(liste.join(','), ['\\Seen'], { uid: true }); fait.push('marqués non lus') }
    if (suivi === true) { await client.messageFlagsAdd(liste.join(','), ['\\Flagged'], { uid: true }); fait.push('suivis') }
    if (suivi === false) { await client.messageFlagsRemove(liste.join(','), ['\\Flagged'], { uid: true }); fait.push('non suivis') }
    if (!fait.length) throw new Error('Précise ce qu\'il faut changer : lu ou suivi.')
    return { dossier, messages: liste.length, fait }
  })
}

/** Les méthodes de désabonnement portées par un message précis. */
export async function unsubscribeInfo(acc, dossier, uid) {
  return withImap(acc, async (client) => {
    await client.mailboxOpen(dossier, { readOnly: true })
    const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, headers: ['list-unsubscribe', 'list-unsubscribe-post', 'list-id'] }, { uid: true })
    if (!msg) throw new Error(`Message ${uid} introuvable dans « ${dossier} ».`)
    const h = parseHeaders(msg.headers)
    const brut = header(h, 'list-unsubscribe')
    const unClic = /one-?click/i.test(header(h, 'list-unsubscribe-post') || '')
    const methodes = []
    for (const m of (brut || '').matchAll(/<(mailto:[^>]+)>/gi)) methodes.push({ type: 'mailto', cible: m[1] })
    for (const m of (brut || '').matchAll(/<(https?:\/\/[^>]+)>/gi)) methodes.push({ type: unClic ? 'http_un_clic' : 'http', cible: m[1] })
    return {
      uid: Number(uid),
      sujet: msg.envelope?.subject || null,
      expediteur: msg.envelope?.from?.[0]?.address || null,
      liste: header(h, 'list-id'),
      methodes,
    }
  })
}

function parseMailto(url) {
  const sans = url.replace(/^mailto:/i, '')
  const [dest, requete = ''] = sans.split('?')
  const params = new URLSearchParams(requete)
  return {
    to: decodeURIComponent(dest),
    subject: params.get('subject') || 'unsubscribe',
    text: params.get('body') || 'unsubscribe',
  }
}

/**
 * Exécute un désabonnement.
 * - `http_un_clic` : POST RFC 8058, silencieux et fiable.
 * - `mailto` : e-mail envoyé depuis le compte concerné (SMTP requis).
 * - `http` simple : rien n'est envoyé, on rend le lien à ouvrir soi-même —
 *   un GET automatique sur ces URL confirme parfois l'inverse de ce qu'on veut.
 */
export async function unsubscribe(acc, methode) {
  if (methode.type === 'http_un_clic') {
    const res = await fetch(methode.cible, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal: AbortSignal.timeout(20000),
    })
    return { methode: 'http_un_clic', url: methode.cible, statut: res.status, reussi: res.ok }
  }
  if (methode.type === 'mailto') {
    const mail = parseMailto(methode.cible)
    const transport = buildTransport(acc)
    const info = await transport.sendMail({ from: acc.email, ...mail })
    transport.close()
    return { methode: 'mailto', destinataire: mail.to, sujet: mail.subject, id: info.messageId, reussi: true }
  }
  return {
    methode: 'lien',
    url: methode.cible,
    reussi: false,
    note: 'Lien de désabonnement à ouvrir manuellement : ces pages demandent souvent une confirmation.',
  }
}

export async function sendMessage(acc, { a, copie, sujet, texte, repondreA }) {
  const transport = buildTransport(acc)
  try {
    const info = await transport.sendMail({
      from: { name: acc.nom, address: acc.email },
      to: a,
      cc: copie || undefined,
      subject: sujet,
      text: texte,
      inReplyTo: repondreA || undefined,
      references: repondreA || undefined,
    })
    return { envoye: true, id: info.messageId, destinataires: info.accepted, refuses: info.rejected }
  } finally {
    transport.close()
  }
}
