// La boucle de l'assistant. Elle parle à un serveur d'IA du réseau local
// (voir llm.mjs) : le modèle répond, demande des outils, on les exécute, on lui
// rend le résultat, et ainsi de suite jusqu'à ce qu'il n'ait plus rien à faire.
//
// Trois choses tiennent cette boucle :
//   - les garde-fous (gardes.mjs) refusent un appel mal préparé avant qu'il parte ;
//   - les outils mail demandent eux-mêmes une validation quand ça la mérite ;
//   - l'historique est taillé à la taille de la fenêtre du modèle local, qui est
//     bien plus petite que celle d'un modèle distant.
import { buildSystemPrompt } from './prompt.mjs'
import { GardeMail } from './gardes.mjs'
import { resumerPermission } from './resume.mjs'
import { serveurMail } from './outils.mjs'
import { outilsSysteme, SYSTEME_A_VALIDER } from './systeme.mjs'
import { descriptionOutil, validerArguments, texteResultat } from './outillage.mjs'
import { completer, listerModeles, contexteCharge, ErreurIA, ErreurContexte } from './llm.mjs'
import { chargerConversation, enregistrerConversation, oublierConversation } from './memoire.mjs'
import { publicAccounts } from '../mail/accounts.mjs'

export const IA_DEFAUT = {
  baseUrl: 'http://localhost:1234/v1',
  model: '',
  apiKey: '',
  /** Fenêtre de contexte du modèle chargé, en jetons. */
  contexte: 32768,
}

/** Au-delà, on arrête le tour : le modèle tourne en rond. */
const MAX_ETAPES = 40
/** Un résultat d'outil rendu au modèle est coupé ici : sa fenêtre est étroite. */
const MAX_RESULTAT = 8000
/** Grossièrement, un jeton vaut trois caractères et demi de français. */
const CARACTERES_PAR_JETON = 3.5

export class AgentSession {
  constructor({ emit, askPermission, getConfig, workspace }) {
    this.emit = emit
    this.askPermission = askPermission
    this.getConfig = getConfig
    this.workspace = workspace

    this.historique = []
    this.enAttente = []
    this.sessionId = null
    this.busy = false
    this.actif = false
    this.enCours = false
    this.tourAbort = null
    this.interrompu = false
    this.garde = new GardeMail()
    this.toujoursAutorises = new Set()
    this.outils = new Map()
    /** Fenêtre de contexte annoncée par le serveur, si elle est connue. */
    this.fenetre = null
  }

  get running() { return this.actif }

  ia() {
    const cfg = this.getConfig() || {}
    return { ...IA_DEFAUT, ...(cfg.ia || {}) }
  }

  /** Seuil de messages au-delà duquel un traitement se valide. */
  seuil() {
    const v = this.getConfig()?.seuilConfirmation
    if (v === null || v === undefined) return 50
    return v < 0 ? Infinity : Number(v)
  }

  // ------------------------------------------------------------- démarrage

  chargerOutils() {
    this.outils = new Map()
    const mail = serveurMail({ confirmer: (d) => this.confirmerAction(d), seuil: () => this.seuil() })
    for (const o of [...mail.tools, ...outilsSysteme({ workspace: this.workspace })]) {
      this.outils.set(o.name, o)
    }
    this.descriptions = [...this.outils.values()].map(descriptionOutil)
  }

  start({ resume } = {}) {
    this.stop()
    this.actif = true
    this.interrompu = false
    this.garde = new GardeMail()
    this.toujoursAutorises = new Set()
    this.enAttente = []
    this.chargerOutils()

    const repris = chargerConversation(resume)
    this.historique = repris ? repris.messages : []
    this.sessionId = repris ? repris.id : `conv-${Date.now().toString(36)}`

    this.emit({ k: 'status', state: 'connecting' })
    this.verifierServeur(!!repris)
  }

  /**
   * On ne prétend pas être prêt avant d'avoir vu le serveur local répondre :
   * s'il est éteint, autant le dire tout de suite plutôt qu'au premier message.
   */
  async verifierServeur(repris) {
    const { baseUrl, apiKey } = this.ia()
    try {
      const modeles = await listerModeles({ baseUrl, apiKey })
      const modele = this.choisirModele(modeles)
      this.fenetre = await contexteCharge({ baseUrl, apiKey, model: modele })
      this.emit({ k: 'modeles', modeles, actif: modele })
      this.emit({ k: 'ready', sessionId: this.sessionId, model: modele || '(aucun modèle chargé)', mail: 'connected' })
      if (!modele) {
        this.emit({ k: 'error', message: `Aucun modèle chargé sur ${baseUrl}. Charges-en un dans ton serveur local.` })
      }
      this.prevenirSiTropPetit()
      if (repris) this.emit({ k: 'resumed' })
      this.emit({ k: 'status', state: this.busy ? 'thinking' : 'idle' })
    } catch (err) {
      this.emit({ k: 'ready', sessionId: this.sessionId, model: this.ia().model || '—', mail: 'connected' })
      this.emit({ k: 'error', message: String(err?.message || err) })
      this.emit({ k: 'status', state: 'idle' })
    }
  }

  /** Ce que coûtent, en jetons, les consignes et la description des outils. */
  empreinte() {
    const fixe = this.systeme().length + JSON.stringify(this.descriptions || []).length
    return Math.round(fixe / CARACTERES_PAR_JETON)
  }

  /**
   * Un modèle chargé avec une fenêtre étroite ne peut rien faire de cette app :
   * autant le dire avant le premier message plutôt que de laisser Nicolas
   * chercher pourquoi ça tombe en panne.
   */
  prevenirSiTropPetit() {
    const fenetre = this.fenetre || Number(this.ia().contexte) || 0
    const besoin = this.empreinte() + 2000
    if (!fenetre || fenetre >= besoin) return
    this.emit({
      k: 'error',
      message: `Le modèle est chargé avec ${fenetre.toLocaleString('fr-FR')} jetons de contexte ; il en faut au moins ` +
        `${besoin.toLocaleString('fr-FR')} pour les consignes et les ${this.outils.size} outils. ` +
        'Recharge-le avec une fenêtre plus grande (32 000 jetons est confortable).',
    })
  }

  /** Le modèle réglé s'il est bien chargé, sinon le premier qui sait discuter. */
  choisirModele(modeles) {
    const voulu = this.ia().model
    if (voulu && (!modeles?.length || modeles.includes(voulu))) return voulu
    const utile = (modeles || []).filter((m) => !/embed|rerank|whisper|tts/i.test(m))
    return utile[0] || modeles?.[0] || voulu || ''
  }

  stop() {
    this.actif = false
    this.busy = false
    this.enCours = false
    try { this.tourAbort?.abort() } catch {}
    this.tourAbort = null
  }

  // ------------------------------------------------------------- messages

  /**
   * Envoie un message. Si un tour est déjà en cours, il rejoint la file :
   * le modèle le lira dès qu'il aura fini d'exécuter ses outils, et refera son
   * plan avec. On ne bloque donc jamais la saisie.
   */
  send(text) {
    if (!this.actif) this.start({})
    const enCours = this.busy
    this.enAttente.push(text)
    this.busy = true
    this.emit({ k: enCours ? 'queued' : 'turn-start' })
    this.emit({ k: 'status', state: 'thinking' })
    this.tourner()
  }

  /**
   * Glisse une information dans la conversation sans que Nicolas ait tapé quoi
   * que ce soit — la fin d'un traitement parti en arrière-plan, par exemple.
   */
  notifier(texte) {
    if (!this.actif) return false
    this.enAttente.push(texte)
    this.busy = true
    this.emit({ k: 'status', state: 'thinking' })
    this.tourner()
    return true
  }

  async interrupt() {
    if (!this.busy) return
    this.interrompu = true
    this.enAttente = []
    try { this.tourAbort?.abort() } catch {}
  }

  async setModel(model) {
    // Le modèle est relu à chaque appel : il n'y a rien à prévenir.
    this.emit({ k: 'modele', model })
  }

  // ---------------------------------------------------------------- boucle

  async tourner() {
    if (this.enCours) return
    this.enCours = true
    this.interrompu = false
    let erreur = null

    try {
      for (let etape = 0; etape < MAX_ETAPES; etape++) {
        this.avaler()
        if (this.interrompu) break
        if (!this.historique.length) break

        const reponse = await this.unTour()
        if (this.interrompu) break

        if (!reponse.appels.length) {
          // Rien à faire de plus : sauf si Nicolas a parlé entre-temps.
          if (!this.enAttente.length) break
          continue
        }

        for (const appel of reponse.appels) {
          if (this.interrompu) break
          const texte = await this.executerOutil(appel)
          this.historique.push({ role: 'tool', tool_call_id: appel.id, name: appel.nom, content: texte })
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') erreur = err
    } finally {
      this.enCours = false
      this.busy = false
      this.reparerHistorique('Interrompu par Nicolas.')
      this.sauver()

      if (this.interrompu) {
        this.emit({ k: 'interrupted' })
      } else if (erreur) {
        this.emit({ k: 'error', message: message(erreur) })
      } else {
        this.emit({ k: 'result', isError: false, text: '' })
      }
      this.emit({ k: 'status', state: 'idle' })

      // Un message arrivé pendant qu'on refermait le tour ne doit pas dormir.
      if (!this.interrompu && this.enAttente.length && this.actif) {
        this.busy = true
        this.emit({ k: 'status', state: 'thinking' })
        setImmediate(() => this.tourner())
      }
      this.interrompu = false
    }
  }

  /**
   * Un aller-retour avec le modèle. Si sa fenêtre déborde, on retente une fois
   * avec le strict nécessaire : c'est presque toujours l'historique qui pèse,
   * et mieux vaut perdre le début de la conversation que le tour en cours.
   */
  async unTour() {
    try {
      return await this.appel(this.compacter())
    } catch (err) {
      if (!(err instanceof ErreurContexte) || this.historique.length <= 2) throw err
      const reduit = this.reduireAuMinimum()
      this.emit({ k: 'note', text: "Le modèle manquait de place : seule la fin de la conversation lui a été rappelée." })
      return await this.appel(reduit)
    }
  }

  /** Ne garde que la dernière demande de Nicolas et ce qui l'a suivie. */
  reduireAuMinimum() {
    for (let i = this.historique.length - 1; i >= 0; i--) {
      if (this.historique[i].role === 'user') {
        this.historique = this.historique.slice(i)
        break
      }
    }
    return this.historique
  }

  async appel(historique) {
    const { baseUrl, apiKey } = this.ia()
    this.tourAbort = new AbortController()
    const messages = [{ role: 'system', content: this.systeme() }, ...historique]

    let ouvertTexte = false
    let ouvertePensee = false
    const reponse = await completer({
      baseUrl,
      apiKey,
      model: this.modeleCourant(),
      messages,
      tools: this.descriptions,
      signal: this.tourAbort.signal,
      onTexte: (d) => {
        if (!ouvertTexte) { ouvertTexte = true; this.emit({ k: 'text-start' }) }
        this.emit({ k: 'text-delta', text: d })
      },
      onPensee: (d) => {
        if (!ouvertePensee) { ouvertePensee = true; this.emit({ k: 'thinking-start' }) }
        this.emit({ k: 'thinking-delta', text: d })
      },
    })

    const assistant = { role: 'assistant', content: reponse.contenu || '' }
    if (reponse.appels.length) {
      assistant.tool_calls = reponse.appels.map((a) => ({
        id: a.id, type: 'function', function: { name: a.nom, arguments: a.arguments || '{}' },
      }))
    }
    this.historique.push(assistant)
    this.sauver()
    return reponse
  }

  modeleCourant() {
    return this.ia().model || this.dernierModeleVu || ''
  }

  systeme() {
    return buildSystemPrompt({
      workspace: this.workspace,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      comptes: publicAccounts(),
    })
  }

  /** Verse dans l'historique les messages tapés pendant le tour précédent. */
  avaler() {
    if (!this.enAttente.length) return
    this.reparerHistorique('Outil non exécuté : la conversation a repris ailleurs.')
    for (const texte of this.enAttente.splice(0, this.enAttente.length)) {
      this.historique.push({ role: 'user', content: texte })
    }
  }

  /**
   * Un tour coupé au milieu laisse un appel d'outil sans réponse — ce qu'aucune
   * API de discussion n'accepte. On bouche le trou avant de repartir.
   */
  reparerHistorique(raison) {
    for (let i = this.historique.length - 1; i >= 0; i--) {
      const m = this.historique[i]
      if (m.role === 'tool') continue
      if (m.role !== 'assistant' || !m.tool_calls?.length) return
      const repondus = new Set(
        this.historique.slice(i + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id),
      )
      for (const appel of m.tool_calls) {
        if (!repondus.has(appel.id)) {
          this.historique.push({ role: 'tool', tool_call_id: appel.id, name: appel.function?.name, content: raison })
        }
      }
      return
    }
  }

  /**
   * Taille l'historique à la fenêtre du modèle. On coupe par le début, et
   * jamais au milieu d'un échange : un résultat d'outil dont l'appel a disparu
   * ferait planter la requête.
   */
  compacter() {
    const jetons = this.fenetre || Number(this.ia().contexte) || IA_DEFAUT.contexte
    // On garde de la place pour les consignes, la description des outils et la réponse.
    const reserve = this.empreinte() + 1500
    const budget = Math.max(2000, (jetons - reserve) * CARACTERES_PAR_JETON)
    const poids = (m) => JSON.stringify(m).length

    let total = this.historique.reduce((n, m) => n + poids(m), 0)
    if (total <= budget) return this.historique

    let debut = 0
    while (debut < this.historique.length - 1 && total > budget) {
      total -= poids(this.historique[debut])
      debut++
    }
    // On repart d'un message de Nicolas : l'échange reste cohérent.
    while (debut < this.historique.length && this.historique[debut].role !== 'user') debut++
    if (debut >= this.historique.length) debut = Math.max(0, this.historique.length - 2)
    if (!debut) return this.historique

    this.historique = this.historique.slice(debut)
    this.emit({ k: 'note', text: 'Le début de la conversation a été oublié pour tenir dans la mémoire du modèle.' })
    return this.historique
  }

  sauver() {
    if (this.sessionId) enregistrerConversation({ id: this.sessionId, messages: this.historique })
  }

  effacer() {
    oublierConversation()
  }

  // --------------------------------------------------------------- outils

  async executerOutil(appel) {
    const outil = this.outils.get(appel.nom)
    let entree = {}
    try {
      entree = appel.arguments ? JSON.parse(appel.arguments) : {}
    } catch {
      this.emit({ k: 'tool-use', id: appel.id, name: appel.nom, input: { brut: appel.arguments } })
      const m = 'ERREUR : les arguments ne sont pas du JSON valide. Rappelle l\'outil avec un objet JSON correct.'
      this.emit({ k: 'tool-result', id: appel.id, name: appel.nom, ok: false, preview: m })
      return m
    }

    this.emit({ k: 'tool-use', id: appel.id, name: appel.nom, input: entree })

    if (!outil) {
      const m = `ERREUR : l'outil « ${appel.nom} » n'existe pas. Outils disponibles : ${[...this.outils.keys()].join(', ')}.`
      this.emit({ k: 'tool-result', id: appel.id, name: appel.nom, ok: false, preview: m })
      return m
    }

    const args = validerArguments(outil, entree)
    if (!args.ok) {
      const m = `ERREUR : arguments invalides — ${args.message}.`
      this.emit({ k: 'tool-result', id: appel.id, name: appel.nom, ok: false, preview: m })
      return m
    }

    // Garde-fou : un chemin jamais vu, un critère vide sur une suppression…
    const raison = this.garde.verifier(appel.nom, args.valeur)
    if (raison) {
      const m = `REFUSÉ : ${raison}`
      this.emit({ k: 'tool-result', id: appel.id, name: appel.nom, ok: false, preview: m })
      return m
    }

    if (SYSTEME_A_VALIDER.has(appel.nom) && !this.toujoursAutorises.has(appel.nom)) {
      const accord = await this.demanderSysteme(appel.nom, args.valeur)
      if (!accord.ok) {
        const m = accord.message || 'Refusé par Nicolas.'
        this.emit({ k: 'tool-result', id: appel.id, name: appel.nom, ok: false, preview: m })
        return m
      }
    }

    try {
      const sortie = await outil.handler(args.valeur, {})
      const brut = texteResultat(sortie)
      this.garde.noteToolResult(appel.nom, brut)
      this.emit({ k: 'tool-result', id: appel.id, name: appel.nom, ok: !sortie?.isError, preview: tronquer(brut, 700) })
      return tronquer(brut, MAX_RESULTAT)
    } catch (err) {
      const m = `ERREUR : ${err?.message || err}`
      this.emit({ k: 'tool-result', id: appel.id, name: appel.nom, ok: false, preview: m })
      return m
    }
  }

  async demanderSysteme(nom, entree) {
    const summary = resumerPermission(nom, entree)
    const reponse = await this.askPermission({
      toolName: nom,
      input: entree,
      summary,
      title: summary?.title,
      allowAlways: true,
      signal: this.tourAbort?.signal,
    })
    if (reponse?.behavior === 'allow') {
      if (reponse.always) this.toujoursAutorises.add(nom)
      return { ok: true }
    }
    return { ok: false, message: reponse?.message || 'Refusé par Nicolas — rien n\'a été fait.' }
  }

  /**
   * Validation demandée par un outil mail, une fois qu'il connaît l'ampleur
   * exacte de ce qu'il s'apprête à faire.
   * @returns {Promise<boolean>}
   */
  async confirmerAction(demande) {
    const reponse = await this.askPermission({
      toolName: demande.outil,
      input: demande.entree,
      summary: { title: demande.titre, lines: demande.lignes, danger: demande.danger },
      title: demande.titre,
      hint: demande.indice,
      allowAlways: false,
      signal: this.tourAbort?.signal,
    })
    return reponse?.behavior === 'allow'
  }
}

function tronquer(s, n) {
  if (!s) return ''
  const t = String(s).trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function message(err) {
  if (err instanceof ErreurIA) return err.message
  return `Assistant indisponible : ${String(err?.message || err)}`
}
