// Garde-fous déterministes, vérifiés avant chaque appel d'outil. Le prompt dit à
// l'assistant de regarder avant d'agir ; ceux-ci le lui imposent. Ils refusent
// l'appel et expliquent quoi faire — le modèle corrige sa manœuvre au lieu de la
// tenter à l'aveugle.
import { resolveAccount } from '../mail/accounts.mjs'

export class GardeMail {
  constructor() {
    /** compte -> Set de chemins de dossiers réellement vus sur le serveur. */
    this.dossiersVus = new Map()
    /** compte -> Set de dossiers dont le contenu a été inventorié (apercu_dossier). */
    this.dossiersInspectes = new Map()
  }

  #nom(ref) {
    try { return resolveAccount(ref).nom } catch { return null }
  }

  #vus(compte) {
    if (!this.dossiersVus.has(compte)) this.dossiersVus.set(compte, new Set())
    return this.dossiersVus.get(compte)
  }

  /** Mémorise l'arborescence dès que l'assistant la lit. */
  noteToolResult(toolName, brut) {
    if (!brut || !toolName) return
    if (toolName !== 'lister_dossiers' && toolName !== 'apercu_dossier') return
    let data
    try { data = JSON.parse(brut) } catch { return }
    const compte = data?.compte
    if (!compte) return
    const set = this.#vus(compte)
    for (const d of data.dossiers || []) {
      const chemin = typeof d === 'string' ? d : d.chemin
      if (chemin) set.add(chemin)
    }
    if (toolName === 'apercu_dossier' && data.racine) {
      if (!this.dossiersInspectes.has(compte)) this.dossiersInspectes.set(compte, new Set())
      this.dossiersInspectes.get(compte).add(data.racine)
    }
  }

  /** Le dossier existe-t-il, à la connaissance de l'assistant ? */
  #connu(compteRef, chemin) {
    const nom = this.#nom(compteRef)
    if (!nom) return { ok: false, raison: `La boîte « ${compteRef} » est introuvable. Appelle d'abord \`lister_comptes\`.` }
    const set = this.dossiersVus.get(nom)
    if (!set || !set.size) {
      return { ok: false, raison: `Tu n'as pas encore lu l'arborescence de « ${nom} ». Appelle \`lister_dossiers\` avant de toucher à ses dossiers.` }
    }
    if (!set.has(chemin)) {
      return {
        ok: false,
        raison: `« ${chemin} » ne figure pas dans les dossiers de « ${nom} ». Les chemins IMAP sont sensibles à la casse et au séparateur : ` +
          'relis `lister_dossiers` et reprends le chemin exact.',
      }
    }
    return { ok: true }
  }

  verifier(toolName, input) {
    if (!toolName) return null
    const i = input || {}

    switch (toolName) {
      case 'deplacer_messages': {
        const source = this.#connu(i.compte_source, i.dossier_source)
        if (!source.ok) return source.raison
        // Le dossier de destination, lui, a le droit de ne pas exister : il sera créé.
        if (i.compte_source === i.compte_cible && i.dossier_source === i.dossier_cible) {
          return 'La source et la destination sont le même dossier.'
        }
        return null
      }

      case 'deplacer_dossier': {
        const source = this.#connu(i.compte_source, i.dossier)
        if (!source.ok) return source.raison
        const memeCompte = this.#nom(i.compte_source) === this.#nom(i.compte_cible)
        if (memeCompte && (i.dossier_cible === i.dossier || String(i.dossier_cible || '').startsWith(`${i.dossier}/`))) {
          return `Destination interdite : « ${i.dossier_cible} » est à l'intérieur de « ${i.dossier} ». Choisis une branche extérieure.`
        }
        if (!this.dossiersInspectes.get(this.#nom(i.compte_source))?.has(i.dossier)) {
          return `Avant de déplacer toute une branche, appelle \`apercu_dossier\` sur « ${i.dossier} » et annonce à Nicolas ce qui va bouger : ` +
            'combien de sous-dossiers, combien de messages.'
        }
        return null
      }

      case 'supprimer_messages': {
        const source = this.#connu(i.compte, i.dossier)
        if (!source.ok) return source.raison
        const criteres = i.criteres || {}
        const vide = !Object.values(criteres).some((v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
        if (vide) {
          return `Suppression refusée : aucun critère. Vider « ${i.dossier} » en entier ne se fait pas par cet outil — ` +
            'précise l\'expéditeur, le sujet ou la période, ou fournis la liste des UID.'
        }
        if (i.definitif && !(Array.isArray(criteres.uids) && criteres.uids.length)) {
          return 'Suppression définitive refusée sur des critères larges. Une suppression irréversible se fait sur une liste d\'UID ' +
            'explicite : appelle `chercher_messages`, montre la liste à Nicolas, puis rappelle cet outil avec `criteres.uids`.'
        }
        return null
      }

      case 'supprimer_dossier': {
        const source = this.#connu(i.compte, i.chemin)
        if (!source.ok) return source.raison
        if (i.vraiment_vider && !this.dossiersInspectes.get(this.#nom(i.compte))?.has(i.chemin)) {
          return `Tu t'apprêtes à supprimer « ${i.chemin} » avec son contenu. Appelle d'abord \`apercu_dossier\` et dis à Nicolas ` +
            'combien de messages seraient perdus.'
        }
        return null
      }

      case 'renommer_dossier': {
        const source = this.#connu(i.compte, i.avant)
        return source.ok ? null : source.raison
      }

      case 'chercher_messages':
      case 'expediteurs':
      case 'abonnements':
      case 'marquer_messages':
      case 'lire_message': {
        const source = this.#connu(i.compte, i.dossier)
        // En lecture, on guide sans bloquer si l'arborescence n'a jamais été lue.
        return source.ok || !this.dossiersVus.get(this.#nom(i.compte))?.size ? null : source.raison
      }

      default:
        return null
    }
  }
}
