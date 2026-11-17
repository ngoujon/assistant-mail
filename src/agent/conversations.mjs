// Les conversations passées, telles que Claude Code les garde sur disque
// (~/.claude/projects/<dossier de travail>/*.jsonl) : de quoi les lister dans
// l'historique et en réafficher le fil quand on en rouvre une.
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { textOf, tronquer } from './session.mjs'

/** Les conversations lancées par les tests automatiques ne valent pas d'être proposées. */
const DE_TEST = /sans rien modifier\.?$/i

/** Un titre lisible : la première demande, sur une ligne. */
export function titreDe(texte, n = 70) {
  const t = String(texte || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * Les conversations passées, de la plus récente à la plus ancienne.
 * @returns {Promise<{ sessionId: string, titre: string, date: number }[]>}
 */
export async function listerConversations(workspace, limite = 80) {
  let sessions = []
  try {
    sessions = await listSessions({ dir: workspace, limit: limite + 20, includeWorktrees: false })
  } catch {
    return []
  }
  return sessions
    .filter((s) => s.firstPrompt && !DE_TEST.test(s.firstPrompt.trim()))
    .slice(0, limite)
    .map((s) => ({
      sessionId: s.sessionId,
      // Toutes les sessions portent le titre « Assistant Mail » : la première
      // demande dit bien mieux de quoi il s'agissait.
      titre: titreDe(s.customTitle && s.customTitle !== 'Assistant Mail' ? s.customTitle : s.firstPrompt),
      date: s.lastModified,
    }))
}

/** Le texte écrit par Nicolas, sans les rappels système glissés par Claude Code. */
function texteUtilisateur(contenu) {
  if (typeof contenu === 'string') return contenu
  if (!Array.isArray(contenu)) return ''
  return contenu
    .filter((b) => b?.type === 'text' && !String(b.text).trimStart().startsWith('<'))
    .map((b) => b.text)
    .join('\n')
}

/**
 * Le fil d'une conversation, prêt à réafficher : mêmes événements que pendant
 * le direct (messages, outils, résultats), la réflexion en moins.
 * Seuls les `max` derniers sont gardés, pour qu'une très longue conversation
 * s'ouvre vite.
 */
export async function relireConversation(sessionId, workspace, max = 600) {
  let messages = []
  try {
    messages = await getSessionMessages(sessionId, { dir: workspace })
  } catch {
    return { evenements: [], tronque: false }
  }
  const evts = []
  for (const m of messages) {
    if (m.parent_tool_use_id) continue // travail interne d'un sous-agent
    const contenu = m.message?.content
    if (m.type === 'user') {
      if (Array.isArray(contenu)) {
        for (const b of contenu) {
          if (b?.type !== 'tool_result') continue
          evts.push({ k: 'tool-result', id: b.tool_use_id, ok: !b.is_error, preview: tronquer(textOf(b.content)) })
        }
      }
      const t = texteUtilisateur(contenu).trim()
      if (!t || t.startsWith('<')) continue
      if (t.startsWith('[Traitement terminé')) evts.push({ k: 'note', text: 'Traitement terminé (message automatique).' })
      else if (t.startsWith('[Request interrupted')) evts.push({ k: 'note', text: 'Interrompu.' })
      else if (!t.startsWith('[')) evts.push({ k: 'user', text: t })
    } else if (m.type === 'assistant' && Array.isArray(contenu)) {
      for (const b of contenu) {
        if (b?.type === 'text' && b.text?.trim()) evts.push({ k: 'text', text: b.text })
        else if (b?.type === 'tool_use') evts.push({ k: 'tool-use', id: b.id, name: b.name, input: b.input })
      }
    }
  }
  const tronque = evts.length > max
  return { evenements: tronque ? evts.slice(-max) : evts, tronque }
}
