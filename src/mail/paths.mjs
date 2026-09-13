// Emplacement des données de l'assistant. Les mêmes chemins qu'Electron
// (`app.getPath('userData')` pour un productName « Assistant Mail »), afin que
// les scripts hors Electron (tests, selftest) lisent exactement la même config.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = 'Assistant Mail'
/** L'app s'est appelée « Assistant MailZen » jusqu'à la version 3.0. */
const ANCIEN_APP_DIR = 'Assistant MailZen'

function defaultRoot() {
  if (process.env.ASSISTANT_MAIL_DATA_DIR) return path.resolve(process.env.ASSISTANT_MAIL_DATA_DIR)
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR)
  }
  return path.join(os.homedir(), '.config', APP_DIR)
}

let root = defaultRoot()

/** Electron appelle ceci au démarrage avec son propre userData. */
export function setDataRoot(dir) {
  root = dir
  recupererAnciennesDonnees()
  ensureDirs()
}

/**
 * Le dossier de données porte le nom de l'app : le renommage en « Assistant Mail »
 * a donc laissé les comptes, la clé de chiffrement, le coffre et les journaux dans
 * l'ancien dossier. On les ramène, une seule fois, et seulement si le nouveau
 * dossier n'a pas déjà de comptes — jamais au risque d'écraser quoi que ce soit.
 */
function recupererAnciennesDonnees() {
  const ancien = path.join(path.dirname(root), ANCIEN_APP_DIR)
  if (ancien === root || !fs.existsSync(ancien)) return
  if (fs.existsSync(path.join(root, 'comptes.json'))) return
  for (const nom of ['comptes.json', 'cle-secrete', 'reglages.json', 'conversation.json', 'files', 'coffre', 'Espace de travail']) {
    const de = path.join(ancien, nom)
    const vers = path.join(root, nom)
    if (!fs.existsSync(de)) continue
    try {
      if (fs.existsSync(vers)) {
        // Un dossier tout juste créé, et vide, ne doit pas bloquer la reprise.
        if (!fs.statSync(vers).isDirectory() || fs.readdirSync(vers).length) continue
        fs.rmdirSync(vers)
      }
      fs.mkdirSync(root, { recursive: true })
      fs.renameSync(de, vers)
    } catch {}
  }
}

export function dataRoot() { return root }

export const P = {
  accounts: () => path.join(root, 'comptes.json'),
  key: () => path.join(root, 'cle-secrete'),
  queues: () => path.join(root, 'files'),
  queue: (id) => path.join(root, 'files', `${id}.json`),
  /** Copies brutes .eml conservées avant toute suppression à la source. */
  vault: (id) => path.join(root, 'coffre', id),
  workspace: () => path.join(root, 'Espace de travail'),
}

export function ensureDirs() {
  for (const dir of [root, P.queues(), path.join(root, 'coffre'), P.workspace()]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

recupererAnciennesDonnees()
ensureDirs()
