// Les demandes que l'utilisateur fait le plus souvent, relues dans les conversations
// que Claude Code garde sur disque (~/.claude/projects/<dossier de travail>/*.jsonl).
// Elles servent de boutons de suggestion sur l'écran d'accueil.
//
// Une même demande revient rarement mot pour mot (« range les mails de ma recherche
// d'emploi… », « range les maisl concernant ma recherche d'mploie… ») : on regroupe
// les phrases proches, fautes de frappe comprises, en comparant leurs trigrammes.
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
    t.length > 400 ||
    /^(oui|non|ok|merci|vas-y|go|stop|parfait|super)\b/i.test(t) ||
    /sans rien modifier\.?$/i.test(t) // question du selftest
  )
}

function texteDe(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((x) => x?.type === 'text').map((x) => x.text).join(' ')
  return ''
}

/** Toutes les demandes écrites par l'utilisateur, avec leur date. */
function lireDemandes(cwd) {
  const dir = dossierProjet(cwd)
  let fichiers = []
  try {
    fichiers = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 200)
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
  return vues.sort((a, b) => (a.quand < b.quand ? 1 : -1))
}

/**
 * Les mots qu'on retrouve dans presque toutes les demandes (« dans ma boîte de réception »,
 * « dans le bon dossier »…). Gardés, ils feraient se ressembler des demandes sans rapport.
 */
const MOTS_VIDES = new Set(`
  stp svp sto merci est ce que tu peux pourrais peut je voudrais veux aimerais il te plait vous
  le la les l de du des d un une dans dan en a au aux et ou mon ma mes ton ta tes son sa ses
  qui que se s y trouve trouvent situant concernant concerne concernent lien avec pour sur par
  boite boites reception receptions mail mails maisl message messages
  dossier dossiers sous bon bons bonne bonnes endroit tout tous toute toutes
`.split(/\s+/).filter(Boolean))

/** Le fond de la demande : sans accents, ponctuation, politesse ni mots passe-partout. */
function normaliser(t) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((m) => m && !MOTS_VIDES.has(m))
    .join(' ')
}

function trigrammes(t) {
  const s = ` ${t} `
  const m = new Map()
  for (let i = 0; i < s.length - 2; i++) {
    const g = s.slice(i, i + 3)
    m.set(g, (m.get(g) || 0) + 1)
  }
  let n = 0
  for (const v of m.values()) n += v * v
  return { m, n: Math.sqrt(n) || 1 }
}

function similarite(a, b) {
  let p = 0
  const [petit, grand] = a.m.size < b.m.size ? [a, b] : [b, a]
  for (const [g, v] of petit.m) p += v * (grand.m.get(g) || 0)
  return p / (a.n * b.n)
}

const SEUIL = 0.5

/**
 * Les `limite` demandes les plus fréquentes : un groupe par demande semblable, du plus
 * fréquent au moins fréquent (à égalité, le plus récent d'abord). Chaque bouton reprend
 * la formulation la plus typique du groupe. Sans demande répétée, les plus récentes.
 */
export function demandesFrequentes(cwd, limite = 6) {
  const demandes = lireDemandes(cwd)
  const groupes = []
  for (const d of demandes) {
    d.v = trigrammes(normaliser(d.t))
    let meilleur = null
    let score = SEUIL
    for (const g of groupes) {
      // Moyenne sur tout le groupe : un seul voisin proche ne suffit pas à y entrer.
      const s = g.membres.reduce((acc, m) => acc + similarite(m.v, d.v), 0) / g.membres.length
      if (s >= score) { score = s; meilleur = g }
    }
    if (meilleur) meilleur.membres.push(d)
    else groupes.push({ membres: [d], recent: d.quand })
  }
  for (const g of groupes) {
    // La formulation la plus proche de toutes les autres ; à égalité, la plus récente.
    let rep = g.membres[0]
    let best = -1
    for (const m of g.membres) {
      const s = g.membres.reduce((acc, o) => acc + (o === m ? 0 : similarite(m.v, o.v)), 0)
      if (s > best + 1e-9) { best = s; rep = m }
    }
    g.texte = rep.t
  }
  groupes.sort((a, b) => b.membres.length - a.membres.length || (a.recent < b.recent ? 1 : -1))
  const repetees = groupes.filter((g) => g.membres.length > 1)
  return (repetees.length ? repetees : groupes).slice(0, limite).map((g) => ({ texte: g.texte, fois: g.membres.length }))
}
