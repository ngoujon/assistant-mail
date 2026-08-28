// Serveur IMAP simulé : le strict sous-ensemble utilisé par le moteur de transfert.
// Il sert à éprouver les garanties du moteur (vérification avant suppression,
// reprise, refus) sans toucher à une vraie boîte.

let compteurUid = 1000

export class FauxServeur {
  constructor(dossiers = {}) {
    /** chemin -> Map(uid -> message) */
    this.boites = new Map()
    this.separateur = '/'
    for (const [chemin, messages] of Object.entries(dossiers)) {
      const m = new Map()
      for (const msg of messages) m.set(msg.uid, msg)
      this.boites.set(chemin, m)
    }
    /** Simulations de panne : chemin -> fonction appelée à l'APPEND. */
    this.appendPiege = null
    this.uidplus = true
  }

  boite(chemin) {
    if (!this.boites.has(chemin)) throw new Error(`Dossier inconnu : ${chemin}`)
    return this.boites.get(chemin)
  }

  client() { return new FauxClient(this) }
}

export function message(sujet, { flags = [], deleted = false } = {}) {
  const uid = ++compteurUid
  const messageId = `<${uid}.${sujet.replace(/\W+/g, '')}@test>`
  return {
    uid,
    messageId,
    source: Buffer.from(`Message-ID: ${messageId}\r\nSubject: ${sujet}\r\n\r\nCorps de ${sujet}\r\n`),
    flags: new Set(deleted ? [...flags, '\\Deleted'] : flags),
    internalDate: new Date('2024-03-01T10:00:00Z'),
    envelope: { messageId, subject: sujet, date: new Date('2024-03-01T10:00:00Z') },
    size: 120,
  }
}

class FauxClient {
  constructor(serveur) {
    this.s = serveur
    this.courant = null
    this.capabilities = new Map()
    if (serveur.uidplus) this.capabilities.set('UIDPLUS', true)
  }

  async connect() {}
  async logout() {}
  close() {}

  async list() {
    return [...this.s.boites.keys()].map((chemin) => ({
      path: chemin,
      name: chemin.split(this.s.separateur).pop(),
      delimiter: this.s.separateur,
      flags: new Set(),
    }))
  }

  async mailboxCreate(chemin) {
    if (this.s.boites.has(chemin)) throw new Error('already exists')
    this.s.boites.set(chemin, new Map())
  }

  async mailboxOpen(chemin) {
    this.s.boite(chemin)
    this.courant = chemin
    return { path: chemin, exists: this.s.boite(chemin).size }
  }

  async status(chemin) {
    return { messages: this.s.boite(chemin).size, unseen: 0 }
  }

  async search(requete) {
    const boite = this.s.boite(this.courant)
    const tous = [...boite.values()]
    if (requete?.deleted) return tous.filter((m) => m.flags.has('\\Deleted')).map((m) => m.uid)
    const id = requete?.header?.['message-id']
    if (id) return tous.filter((m) => m.messageId === id).map((m) => m.uid)
    return tous.map((m) => m.uid)
  }

  async *fetch(plage) {
    const boite = this.s.boite(this.courant)
    for (const uid of String(plage).split(',').map(Number)) {
      const m = boite.get(uid)
      if (m) yield m
    }
  }

  async fetchOne(uid) {
    return this.s.boite(this.courant).get(Number(uid)) || null
  }

  async append(chemin, contenu, flags, date) {
    if (this.s.appendPiege) {
      const verdict = this.s.appendPiege(chemin, contenu)
      // « posé » sans être réellement stocké : le cas qui doit interdire la suppression.
      if (verdict === 'perdu') return { path: chemin, uid: ++compteurUid }
      if (verdict === 'erreur') throw new Error('APPEND refusé par le serveur')
    }
    const boite = this.s.boite(chemin)
    const texte = contenu.toString()
    const messageId = texte.match(/Message-ID:\s*(\S+)/i)?.[1] || null
    const uid = ++compteurUid
    boite.set(uid, {
      uid,
      messageId,
      source: contenu,
      flags: new Set(flags || []),
      internalDate: date,
      envelope: { messageId, subject: texte.match(/Subject:\s*(.*)/i)?.[1] || '', date },
      size: contenu.length,
    })
    return { path: chemin, uid }
  }

  async messageMove(plage, destination) {
    const boite = this.s.boite(this.courant)
    const cible = this.s.boite(destination)
    const uidMap = new Map()
    for (const uid of String(plage).split(',').map(Number)) {
      const m = boite.get(uid)
      if (!m) continue
      const neuf = ++compteurUid
      cible.set(neuf, { ...m, uid: neuf })
      boite.delete(uid)
      uidMap.set(uid, neuf)
    }
    return { destination, uidMap }
  }

  async messageDelete(plage) {
    const boite = this.s.boite(this.courant)
    for (const uid of String(plage).split(',').map(Number)) boite.delete(uid)
    return true
  }
}
