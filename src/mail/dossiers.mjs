// Lecture et remaniement de l'arborescence des dossiers.
import { withImap, ensureMailbox, delimiterOf } from './imap.mjs'

const USAGE_FR = {
  '\\Inbox': 'réception', '\\Sent': 'envoyés', '\\Drafts': 'brouillons',
  '\\Trash': 'corbeille', '\\Junk': 'indésirables', '\\Archive': 'archives', '\\All': 'tous',
}

/** Liste les dossiers d'un compte, avec le nombre de messages si demandé. */
export async function listFolders(acc, { compter = true } = {}) {
  return withImap(acc, async (client) => {
    const list = await client.list()
    const out = []
    for (const box of list) {
      if (box.flags?.has?.('\\Noselect')) {
        out.push({ chemin: box.path, nom: box.name, usage: null, selectionnable: false })
        continue
      }
      const item = {
        chemin: box.path,
        nom: box.name,
        separateur: box.delimiter,
        usage: USAGE_FR[box.specialUse] || null,
        selectionnable: true,
      }
      if (compter) {
        try {
          const st = await client.status(box.path, { messages: true, unseen: true })
          item.messages = st.messages ?? 0
          item.non_lus = st.unseen ?? 0
        } catch (err) {
          item.messages = null
          item.erreur = err.message
        }
      }
      out.push(item)
    }
    return out
  })
}

/** Chemin du dossier ayant un usage spécial donné (corbeille, archives…). */
export async function findSpecial(client, usage) {
  const list = await client.list()
  const hit = list.find((b) => b.specialUse === usage)
  if (hit) return hit.path
  const noms = { '\\Trash': /^(trash|corbeille|deleted( items)?|éléments supprimés)$/i, '\\Junk': /^(junk|spam|ind[eé]sirables?)$/i, '\\Archive': /^(archive|archives)$/i }
  const motif = noms[usage]
  return motif ? list.find((b) => motif.test(b.name))?.path || null : null
}

export async function createFolder(acc, chemin) {
  return withImap(acc, async (client) => {
    const crees = await ensureMailbox(client, chemin, await delimiterOf(client))
    return { crees, deja: crees.length === 0 }
  })
}

export async function renameFolder(acc, avant, apres) {
  return withImap(acc, async (client) => {
    const list = await client.list()
    if (!list.some((b) => b.path === avant)) throw new Error(`Le dossier « ${avant} » n'existe pas.`)
    if (list.some((b) => b.path === apres)) throw new Error(`« ${apres} » existe déjà : renomme-le d'abord ou choisis un autre nom.`)
    await client.mailboxRename(avant, apres)
    // IMAP renomme aussi les sous-dossiers : on rend compte de ce qui a bougé.
    const sep = list.find((b) => b.path === avant)?.delimiter || '/'
    const enfants = list.filter((b) => b.path.startsWith(avant + sep)).map((b) => b.path)
    return { avant, apres, enfants }
  })
}

/**
 * Supprime un dossier. Refus par défaut s'il contient des messages ou des
 * sous-dossiers : une suppression de dossier IMAP est irréversible côté serveur.
 */
export async function deleteFolder(acc, chemin, { vraimentVider = false } = {}) {
  return withImap(acc, async (client) => {
    const list = await client.list()
    const box = list.find((b) => b.path === chemin)
    if (!box) throw new Error(`Le dossier « ${chemin} » n'existe pas.`)
    const sep = box.delimiter || '/'
    const enfants = list.filter((b) => b.path.startsWith(chemin + sep))
    if (enfants.length) {
      throw new Error(`« ${chemin} » contient ${enfants.length} sous-dossier(s) : ${enfants.map((b) => b.path).join(', ')}. Traite-les d'abord.`)
    }
    const st = await client.status(chemin, { messages: true })
    if (st.messages > 0 && !vraimentVider) {
      throw new Error(`« ${chemin} » contient encore ${st.messages} message(s). Déplace-les d'abord, ou redemande la suppression en assumant la perte.`)
    }
    await client.mailboxDelete(chemin)
    return { supprime: chemin, messagesPerdus: st.messages || 0 }
  })
}
