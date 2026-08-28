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

const PREFIXE = 'mcp__mailzen__'

/**
 * @returns {{title: string, lines: string[], danger?: boolean} | null}
 */
export function resumerPermission(toolName, input) {
  const i = input || {}
  if (!toolName.startsWith(PREFIXE)) return resumerSysteme(toolName, i)
  const nom = toolName.slice(PREFIXE.length)

  switch (nom) {
    case 'deplacer_messages': {
      const source = `${i.compte_source} · ${i.dossier_source}`
      const cible = `${i.compte_cible || i.compte_source} · ${i.dossier_cible}`
      return {
        title: i.copier ? 'Copier des messages ?' : 'Déplacer des messages ?',
        lines: [
          `${source}\n→ ${cible}`,
          `Sélection : ${decrireCriteres(i.criteres)}`,
          i.copier
            ? 'Copie seule : rien ne quitte la source.'
            : 'Chaque message est relu à destination avant d\'être retiré de la source.',
        ],
      }
    }

    case 'deplacer_dossier':
      return {
        title: i.copier ? 'Copier toute une branche ?' : 'Déplacer toute une branche ?',
        lines: [
          `${i.compte_source} · ${i.dossier} (et ses sous-dossiers)\n→ ${i.compte_cible} · ${i.dossier_cible}`,
          'L\'arborescence est recréée à destination, puis les messages passent un par un.',
          i.copier ? 'Copie seule : la branche d\'origine reste en place.' : 'La branche d\'origine sera vidée, message par message, après vérification.',
        ],
      }

    case 'supprimer_messages':
      return {
        title: i.definitif ? 'Effacer définitivement des messages ?' : 'Mettre des messages à la corbeille ?',
        lines: [
          `${i.compte} · ${i.dossier}`,
          `Sélection : ${decrireCriteres(i.criteres)}`,
          i.definitif
            ? 'IRRÉVERSIBLE côté serveur. Une copie brute reste sur le disque, dans le coffre.'
            : 'Les messages partent à la corbeille : récupérables tant qu\'elle n\'est pas vidée.',
        ],
        danger: !!i.definitif,
      }

    case 'supprimer_dossier':
      return {
        title: `Supprimer le dossier ${guillemets(i.chemin || '')} ?`,
        lines: [
          `${i.compte} · ${i.chemin}`,
          i.vraiment_vider
            ? 'AVEC son contenu : les messages restants sont perdus, sans copie.'
            : 'Refusé automatiquement si le dossier n\'est pas vide.',
        ],
        danger: !!i.vraiment_vider,
      }

    case 'renommer_dossier':
      return {
        title: 'Renommer un dossier ?',
        lines: [`${i.compte}\n${i.avant}\n→ ${i.apres}`, 'Les sous-dossiers suivent le nouveau chemin.'],
      }

    case 'creer_dossier':
      return { title: 'Créer un dossier ?', lines: [`${i.compte} · ${i.chemin}`] }

    case 'marquer_messages': {
      const quoi = []
      if (i.lu === true) quoi.push('lus')
      if (i.lu === false) quoi.push('non lus')
      if (i.suivi === true) quoi.push('suivis')
      if (i.suivi === false) quoi.push('non suivis')
      return {
        title: `Marquer ${i.uids?.length || 0} message(s) ?`,
        lines: [`${i.compte} · ${i.dossier}`, `Nouvel état : ${quoi.join(', ') || 'inchangé'}`],
      }
    }

    case 'desabonner':
      return {
        title: `Se désabonner de ${guillemets(i.liste || i.cible || '')} ?`,
        lines: [
          i.type === 'http_un_clic' ? 'Requête « un clic » envoyée au serveur de la liste.'
            : i.type === 'mailto' ? `E-mail de désabonnement envoyé depuis ${i.compte}.`
            : 'Aucune requête : le lien te sera simplement rendu.',
          String(i.cible || ''),
        ],
      }

    case 'envoyer_message':
      return {
        title: 'Envoyer cet e-mail ?',
        lines: [`De : ${i.compte}\nÀ : ${i.a}${i.copie ? `\nCopie : ${i.copie}` : ''}`, `Objet : ${i.sujet}`, String(i.texte || '').slice(0, 400)],
      }

    case 'reprendre_traitement':
      return { title: 'Reprendre le traitement interrompu ?', lines: [String(i.id || '')] }

    default:
      return null
  }
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
