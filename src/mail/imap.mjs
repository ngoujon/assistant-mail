// Connexions IMAP/SMTP.
//
// Garde-fous structurels :
//  - un plafond de connexions simultanées par compte (les serveurs de prod
//    coupent au-delà, et deux opérations destructrices en parallèle sur la même
//    boîte, c'est exactement ce qu'on veut éviter) ;
//  - toute connexion est refermée proprement, y compris en cas d'erreur.
//
// Économie d'appels (Gmail limite les connexions, les connexions par minute et
// le volume de commandes) :
//  - les connexions authentifiées sont gardées quelques minutes et réutilisées :
//    une question de l'assistant ne coûte plus un LOGIN par outil appelé ;
//  - la liste des dossiers est mise en cache par compte (invalidée dès qu'on
//    crée, renomme ou supprime un dossier) ;
//  - un dossier déjà sélectionné n'est pas re-sélectionné (SELECT coûte cher
//    sur une grosse boîte Gmail) : un NOOP suffit à rafraîchir son état ;
//  - si le serveur signale une limitation, on patiente et on réessaie au lieu
//    de l'assaillir, et un mot de passe refusé n'est pas réessayé en boucle
//    (Gmail bloque le compte après des échecs de connexion répétés).
import crypto from 'node:crypto'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { accountPassword } from './accounts.mjs'

const MAX_CONNEXIONS = 3
const DUREE_REPOS = 3 * 60 * 1000 // connexion inutilisée gardée 3 min
const DUREE_CACHE_LISTE = 2 * 60 * 1000
const DUREE_ECHEC_AUTH = 60 * 1000
const ATTENTES_LIMITATION = [5000, 20000, 60000]

const pools = new Map() // clé -> pool

export function estGmail(acc) {
  return /(^|\.)(gmail|googlemail)\.com$/i.test(acc?.imap?.host || '')
}

/** Le serveur nous demande de ralentir (Gmail : THROTTLED, trop de connexions, quota de commandes…). */
export function estLimitation(err) {
  const t = `${err?.serverResponseCode || ''} ${err?.responseText || ''} ${err?.message || ''}`
  return /THROTTLED|too many (simultaneous )?connections|exceeded (command|bandwidth)|bandwidth limits|Temporary System Problem|\[UNAVAILABLE\]|try again later|rate limit/i.test(t)
}

function estEchecAuth(err) {
  const t = `${err?.serverResponseCode || ''} ${err?.responseText || ''} ${err?.message || ''}`
  return err?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed|\[AUTH\]|WEBALERT/i.test(t)
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms))

function clePool(acc) {
  // Le mot de passe fait partie de la clé : après un changement, on repart sur
  // des connexions neuves et l'éventuel échec d'authentification est oublié.
  const empreinte = crypto.createHash('sha1').update(String(accountPassword(acc, 'imap') || '')).digest('hex').slice(0, 12)
  return `${acc.id}|${acc.imap.host}|${acc.imap.port}|${acc.imap.user}|${empreinte}`
}

function pool(acc) {
  const cle = clePool(acc)
  if (!pools.has(cle)) {
    pools.set(cle, {
      cle,
      compteId: acc.id,
      max: MAX_CONNEXIONS,
      actives: 0,
      waiters: [],
      repos: [], // { client, minuteur }
      liste: null, // { quand, valeur }
      echecAuth: null, // { quand, err }
      pauseJusqua: 0,
    })
  }
  return pools.get(cle)
}

async function acquire(p) {
  if (p.actives < p.max) { p.actives++; return }
  await new Promise((resolve) => p.waiters.push(resolve))
  p.actives++
}

function release(p) {
  p.actives--
  if (p.actives < p.max) {
    const next = p.waiters.shift()
    if (next) next()
  }
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
    // Pas d'IDLE automatique : une connexion au repos ne doit rien coûter, et
    // on rafraîchit l'état du dossier au moment de la réutiliser.
    disableAutoIdle: true,
  })
}

function fermer(client) {
  try { client.close() } catch {}
}

function retirerDuRepos(p, client) {
  const i = p.repos.findIndex((r) => r.client === client)
  if (i >= 0) {
    clearTimeout(p.repos[i].minuteur)
    p.repos.splice(i, 1)
  }
}

/** Branche le cache de liste et l'économie de SELECT sur un client du pool. */
function equiper(p, client) {
  const list = client.list.bind(client)
  const mailboxOpen = client.mailboxOpen.bind(client)
  const invalider = (nom) => {
    const orig = client[nom].bind(client)
    client[nom] = async (...args) => {
      p.liste = null
      try { return await orig(...args) } finally { p.liste = null }
    }
  }

  // `list({ frais: true })` contourne le cache : pour les vérifications qui
  // précèdent une opération destructrice (renommer, supprimer un dossier).
  client.list = async (options) => {
    const { frais, ...reste } = options || {}
    if (frais || Object.keys(reste).length) {
      const valeur = await list(Object.keys(reste).length ? reste : undefined)
      if (!Object.keys(reste).length) p.liste = { quand: Date.now(), valeur }
      return valeur
    }
    if (p.liste && Date.now() - p.liste.quand < DUREE_CACHE_LISTE) return p.liste.valeur
    const valeur = await list()
    p.liste = { quand: Date.now(), valeur }
    return valeur
  }

  client.mailboxOpen = async (chemin, options = {}) => {
    const actuel = client.mailbox
    const lectureSeule = !!options.readOnly
    const meme = actuel && typeof chemin === 'string' &&
      (actuel.path === chemin || (chemin.toUpperCase() === 'INBOX' && actuel.path?.toUpperCase() === 'INBOX'))
    if (meme && client._lectureSeule === lectureSeule) {
      // Déjà sélectionné : dans le même emprunt rien à faire ; sinon un NOOP
      // récupère les arrivées et suppressions survenues entre-temps.
      if (!client._selectionFraiche) {
        await client.noop()
        client._selectionFraiche = true
      }
      return client.mailbox
    }
    client._lectureSeule = null
    const res = await mailboxOpen(chemin, options)
    client._lectureSeule = lectureSeule
    client._selectionFraiche = true
    return res
  }

  for (const nom of ['mailboxCreate', 'mailboxRename', 'mailboxDelete']) invalider(nom)
  client.on('close', () => retirerDuRepos(p, client))
}

async function connecter(acc, p) {
  if (p.echecAuth && Date.now() - p.echecAuth.quand < DUREE_ECHEC_AUTH) throw p.echecAuth.err
  for (let essai = 0; ; essai++) {
    const attente = p.pauseJusqua - Date.now()
    if (attente > 0) await dormir(attente)
    const client = buildClient(acc)
    // Sans écouteur, une erreur de socket ferait tomber le processus.
    client.on('error', () => {})
    try {
      await client.connect()
      p.echecAuth = null
      equiper(p, client)
      return client
    } catch (err) {
      fermer(client)
      if (estEchecAuth(err) && !estLimitation(err)) {
        p.echecAuth = { quand: Date.now(), err }
        throw err
      }
      if (!estLimitation(err) || essai >= ATTENTES_LIMITATION.length) throw err
      // Trop de connexions : on réduit notre propre plafond pour ce compte.
      if (/too many/i.test(err?.responseText || err?.message || '')) p.max = Math.max(1, Math.min(p.max, p.actives))
      p.pauseJusqua = Date.now() + ATTENTES_LIMITATION[essai]
    }
  }
}

async function emprunter(acc, p) {
  while (p.repos.length) {
    const { client, minuteur } = p.repos.pop()
    clearTimeout(minuteur)
    if (client.usable) {
      client._selectionFraiche = false
      return client
    }
    fermer(client)
  }
  return connecter(acc, p)
}

function rendre(p, client) {
  if (!client.usable || !pools.has(p.cle)) {
    try { client.logout().catch(() => fermer(client)) } catch { fermer(client) }
    return
  }
  const minuteur = setTimeout(() => {
    retirerDuRepos(p, client)
    client.logout().catch(() => fermer(client))
  }, DUREE_REPOS)
  minuteur.unref?.()
  p.repos.push({ client, minuteur })
}

/**
 * Emprunte une connexion IMAP (réutilisée si possible), exécute `fn(client)`,
 * la rend au pool quoi qu'il arrive.
 * @param {object} acc compte (forme interne, mot de passe chiffré)
 */
export async function withImap(acc, fn) {
  const p = pool(acc)
  await acquire(p)
  let client = null
  try {
    client = await emprunter(acc, p)
    return await fn(client)
  } catch (err) {
    if (estLimitation(err)) p.pauseJusqua = Math.max(p.pauseJusqua, Date.now() + ATTENTES_LIMITATION[0])
    throw err
  } finally {
    if (client) rendre(p, client)
    release(p)
  }
}

/** Ouvre deux connexions (source et destination) pour un transfert. */
export async function withImapPair(accSource, accCible, fn) {
  return withImap(accSource, (source) => withImap(accCible, (cible) => fn(source, cible)))
}

/** Oublie les connexions et le cache d'un compte (compte supprimé ou modifié). */
export function oublierCompte(compteId) {
  for (const [cle, p] of pools) {
    if (p.compteId !== compteId) continue
    pools.delete(cle)
    for (const { client, minuteur } of p.repos.splice(0)) {
      clearTimeout(minuteur)
      client.logout().catch(() => fermer(client))
    }
  }
}

/** Ferme proprement toutes les connexions au repos (fermeture de l'app). */
export async function fermerConnexions() {
  const attentes = []
  for (const p of pools.values()) {
    for (const { client, minuteur } of p.repos.splice(0)) {
      clearTimeout(minuteur)
      attentes.push(client.logout().catch(() => fermer(client)))
    }
  }
  await Promise.race([Promise.allSettled(attentes), dormir(1500)])
}

/** UIDs triés en plages compactes (« 1:500,502 ») : commandes plus courtes. */
export function plage(uids) {
  const tri = [...new Set(uids.map(Number).filter(Boolean))].sort((a, b) => a - b)
  const morceaux = []
  for (let i = 0; i < tri.length; i++) {
    const debut = tri[i]
    while (i + 1 < tri.length && tri[i + 1] === tri[i] + 1) i++
    morceaux.push(debut === tri[i] ? String(debut) : `${debut}:${tri[i]}`)
  }
  return morceaux.join(',')
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
  try {
    await client.connect()
    const list = await client.list()
    return list.length
  } finally {
    try { await client.logout() } catch { fermer(client) }
  }
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
