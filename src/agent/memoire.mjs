// La conversation sur le disque. Le SDK gardait l'historique pour nous et le
// reprenait par identifiant ; maintenant c'est un simple fichier JSON à côté
// des comptes et des files.
import fs from 'node:fs'
import path from 'node:path'
import { dataRoot } from '../mail/paths.mjs'

const fichier = () => path.join(dataRoot(), 'conversation.json')

export function chargerConversation(id) {
  if (!id) return null
  try {
    const c = JSON.parse(fs.readFileSync(fichier(), 'utf8'))
    if (c?.id !== id || !Array.isArray(c.messages) || !c.messages.length) return null
    return c
  } catch {
    return null
  }
}

export function enregistrerConversation({ id, messages }) {
  try {
    fs.mkdirSync(path.dirname(fichier()), { recursive: true })
    fs.writeFileSync(fichier(), JSON.stringify({ id, messages, date: new Date().toISOString() }))
  } catch {}
}

export function oublierConversation() {
  try { fs.rmSync(fichier(), { force: true }) } catch {}
}
