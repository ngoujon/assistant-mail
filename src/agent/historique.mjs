// Les dernières demandes de l'utilisateur, relues dans les conversations que
// Claude Code garde sur disque (~/.claude/projects/<dossier de travail>/*.jsonl).
// Elles servent de boutons de suggestion sur l'écran d'accueil.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Claude Code nomme le dossier d'un projet d'après son chemin, chaque caractère spécial devenant « - ». */
function dossierProjet(cwd) {
  const racine = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(racine, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'))
}

/** Messages qui ne viennent pas de l'utilisateur, ou qui ne valent pas d'être reproposés. */
function aIgnorer(t) {
  return (
    t.startsWith('<') ||
    t.startsWith('[') || // messages automatiques de l'application
    t.length < 8 ||
    /^(oui|non|ok|merci|vas-y|go|stop)\b/i.test(t) ||
    /sans rien modifier\.?$/i.test(t) // question du selftest
  )
}

function texteDe(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((x) => x?.type === 'text').map((x) => x.text).join(' ')
  return ''
}

const cle = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** Les `limite` demandes les plus récentes, sans doublon, de la plus récente à la plus ancienne. */
export function demandesRecentes(cwd, limite = 6) {
  const dir = dossierProjet(cwd)
  let fichiers = []
  try {
    fichiers = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 30)
  } catch {
    return []
  }
  const vues = []
  for (const { f } of fichiers) {
    let lignes
    try { lignes = fs.readFileSync(f, 'utf8').split('\n') } catch { continue }
    for (const l of lignes) {
      if (!l.includes('"type":"user"')) continue
      let j
      try { j = JSON.parse(l) } catch { continue }
      if (j.type !== 'user' || j.isMeta || j.isSidechain) continue
      const t = texteDe(j.message?.content).replace(/\s+/g, ' ').trim()
      if (t && !aIgnorer(t)) vues.push({ t, quand: j.timestamp || '' })
    }
  }
  vues.sort((a, b) => (a.quand < b.quand ? 1 : -1))
  const dejaVu = new Set()
  const out = []
  for (const v of vues) {
    const k = cle(v.t)
    if (dejaVu.has(k)) continue
    dejaVu.add(k)
    out.push(v.t)
    if (out.length >= limite) break
  }
  return out
}
