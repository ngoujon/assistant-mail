// Emplacement des données de l'assistant. Les mêmes chemins qu'Electron
// (`app.getPath('userData')` pour un productName « Assistant MailZen »), afin que
// les scripts hors Electron (tests, selftest) lisent exactement la même config.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const APP_DIR = 'Assistant MailZen'

function defaultRoot() {
  if (process.env.MAILZEN_DATA_DIR) return path.resolve(process.env.MAILZEN_DATA_DIR)
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR)
  }
  return path.join(os.homedir(), '.config', APP_DIR)
}

let root = defaultRoot()

/** Electron appelle ceci au démarrage avec son propre userData. */
export function setDataRoot(dir) {
  root = dir
  ensureDirs()
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

ensureDirs()
