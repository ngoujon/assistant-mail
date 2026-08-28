// Connexions IMAP/SMTP.
//
// Deux garde-fous structurels :
//  - un plafond de connexions simultanées par compte (les serveurs de prod
//    coupent au-delà, et deux opérations destructrices en parallèle sur la même
//    boîte, c'est exactement ce qu'on veut éviter) ;
//  - toute connexion est refermée proprement, y compris en cas d'erreur.
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { accountPassword } from './accounts.mjs'

const MAX_CONNEXIONS = 3
const pools = new Map() // accountId -> { actives, waiters[] }

function pool(id) {
  if (!pools.has(id)) pools.set(id, { actives: 0, waiters: [] })
  return pools.get(id)
}

async function acquire(id) {
  const p = pool(id)
  if (p.actives < MAX_CONNEXIONS) { p.actives++; return }
  await new Promise((resolve) => p.waiters.push(resolve))
  p.actives++
}

function release(id) {
  const p = pool(id)
  p.actives--
  const next = p.waiters.shift()
  if (next) next()
}

export function buildClient(acc) {
  return new ImapFlow({
    host: acc.imap.host,
    port: acc.imap.port,
    secure: acc.imap.secure !== false,
    auth: { user: acc.imap.user, pass: accountPassword(acc, 'imap') },
    logger: false,
    tls: { rejectUnauthorized: !acc.certificatNonVerifie },
    socketTimeout: 180000,
    greetingTimeout: 20000,
    emitLogs: false,
  })
}

/**
 * Ouvre une connexion IMAP, exécute `fn(client)`, referme quoi qu'il arrive.
 * @param {object} acc compte (forme interne, mot de passe chiffré)
 */
export async function withImap(acc, fn) {
  await acquire(acc.id)
  const client = buildClient(acc)
  // Sans écouteur, une erreur de socket ferait tomber le processus.
  client.on('error', () => {})
  try {
    await client.connect()
    return await fn(client)
  } finally {
    try { await client.logout() } catch { try { client.close() } catch {} }
    release(acc.id)
  }
}

/** Ouvre deux connexions (source et destination) pour un transfert. */
export async function withImapPair(accSource, accCible, fn) {
  return withImap(accSource, (source) => withImap(accCible, (cible) => fn(source, cible)))
}

export function buildTransport(acc) {
  if (!acc.smtp?.host) throw new Error(`Aucun serveur SMTP configuré pour « ${acc.nom} ».`)
  return nodemailer.createTransport({
    host: acc.smtp.host,
    port: acc.smtp.port,
    secure: !!acc.smtp.secure,
    auth: { user: acc.smtp.user || acc.imap.user, pass: accountPassword(acc, 'smtp') },
    tls: { rejectUnauthorized: !acc.certificatNonVerifie },
    connectionTimeout: 20000,
  })
}

/** Tests de connexion avec identifiants en clair (formulaire, avant enregistrement). */
export async function testImapRaw({ host, port, secure, user, pass, certificatNonVerifie = false }) {
  const client = new ImapFlow({
    host, port, secure,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: !certificatNonVerifie },
    socketTimeout: 20000,
    greetingTimeout: 12000,
  })
  client.on('error', () => {})
  await client.connect()
  const list = await client.list()
  await client.logout()
  return list.length
}

export async function testSmtpRaw({ host, port, secure, user, pass, certificatNonVerifie = false }) {
  const transport = nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: !certificatNonVerifie },
    connectionTimeout: 12000,
  })
  await transport.verify()
  return true
}

/** Crée un dossier IMAP et ses parents manquants. Retourne les chemins créés. */
export async function ensureMailbox(client, target, delimiter = '/') {
  const list = await client.list()
  const existing = new Set(list.map((m) => m.path))
  if (existing.has(target)) return []
  const sep = list[0]?.delimiter || delimiter
  const created = []
  let current = ''
  for (const part of target.split(sep)) {
    current = current ? current + sep + part : part
    if (existing.has(current)) continue
    try {
      await client.mailboxCreate(current)
      created.push(current)
    } catch (err) {
      if (!/already exists|ALREADYEXISTS/i.test(err.message)) throw err
    }
    existing.add(current)
  }
  return created
}

/** Le séparateur de hiérarchie du serveur (« / » chez la plupart, « . » chez d'autres). */
export async function delimiterOf(client) {
  const list = await client.list()
  return list[0]?.delimiter || '/'
}
