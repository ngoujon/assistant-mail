// Traduit une demande d'autorisation en français lisible : on doit comprendre ce
// qu'on valide sans lire du JSON ni des UID.

const octets = (n) => {
  if (!n) return null
  const u = ['o', 'ko', 'Mo', 'Go']
  let i = 0
  let v = Number(n)
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

const guillemets = (s) => `« ${String(s).trim()} »`

/** Décrit des critères de recherche en une ligne de français. */
export function decrireCriteres(c) {
  if (!c || typeof c !== 'object') return 'tous les messages du dossier'
  const bouts = []
  if (Array.isArray(c.uids) && c.uids.length) return `${c.uids.length} message(s) précis`
  if (c.de) bouts.push(`de ${c.de}`)
  if (c.a) bouts.push(`à ${c.a}`)
  if (c.sujet) bouts.push(`sujet contenant ${guillemets(c.sujet)}`)
  if (c.texte) bouts.push(`texte contenant ${guillemets(c.texte)}`)
  if (c.depuis) bouts.push(`après le ${dateFr(c.depuis)}`)
  if (c.avant) bouts.push(`avant le ${dateFr(c.avant)}`)
  if (c.non_lus) bouts.push('non lus')
  if (c.lus) bouts.push('déjà lus')
  if (c.suivis) bouts.push('suivis')
  if (c.taille_min) bouts.push(`plus lourds que ${octets(c.taille_min)}`)
  return bouts.length ? bouts.join(', ') : 'tous les messages du dossier'
}

function dateFr(v) {
  const d = new Date(v)
  return Number.isNaN(+d) ? String(v) : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * Résumé d'une demande d'autorisation portant sur un outil système (Bash, fichiers).
 * Les outils mail, eux, composent leur propre carte : ils connaissent le nombre
 * exact de messages concernés, ce qu'une lecture des critères ne donnerait pas.
 * @returns {{title: string, lines: string[], danger?: boolean} | null}
 */
export function resumerPermission(toolName, input) {
  return resumerSysteme(toolName, input || {})
}

function resumerSysteme(toolName, i) {
  switch (toolName) {
    case 'Bash': {
      const cmd = String(i.command || '')
      if (!cmd) return null
      return {
        title: 'Exécuter une commande sur ton Mac ?',
        lines: [cmd],
        danger: /\brm\b|\bsudo\b|\bkillall\b|\bdd\b/.test(cmd),
      }
    }
    case 'Write':
    case 'Edit': {
      const f = String(i.file_path || '')
      if (!f) return null
      return {
        title: toolName === 'Write' ? `Écrire le fichier ${f.split('/').pop()} ?` : `Modifier le fichier ${f.split('/').pop()} ?`,
        lines: [f],
      }
    }
    default:
      return null
  }
}
