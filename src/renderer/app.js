import { renderMarkdown } from './markdown.js'

const api = window.assistantMail
const scroll = document.getElementById('scroll')
const input = document.getElementById('input')
const sendBtn = document.getElementById('btn-send')
const statusLine = document.getElementById('status-line')
const settingsPanel = document.getElementById('settings')
const modelSelect = document.getElementById('model')
const seuilSelect = document.getElementById('seuil')
const listeComptes = document.getElementById('comptes')
const formCompte = document.getElementById('form-compte')
const etatForm = document.getElementById('c-etat')
const barreOnglets = document.getElementById('onglets')
const panneauHistorique = document.getElementById('historique')
const listeHistorique = document.getElementById('h-liste')
const filtreHistorique = document.getElementById('h-filtre')

let comptes = []
/** Les demandes que Nicolas fait le plus souvent : [{ texte, fois }]. */
let frequentes = []

/**
 * Une conversation ouverte. Chacune a son fil, son état et sa session agent
 * côté processus principal : elles avancent en parallèle.
 * @typedef {object} Onglet
 * @property {string} id
 * @property {string} titre
 * @property {string|null} sessionId
 * @property {HTMLElement} thread
 * @property {HTMLElement} tab
 * @property {boolean} busy
 * @property {{ el: HTMLElement, raw: string }|null} currentText
 * @property {{ el: HTMLElement, raw: string }|null} currentThinking
 * @property {Map<string, HTMLElement>} toolEls
 * @property {Map<string, object>} fileEls
 * @property {object[]} perms demandes de validation en attente
 * @property {HTMLElement[]} enFile messages écrits pendant qu'il travaillait
 * @property {object[]|null} tampon événements reçus pendant le chargement du fil
 */
/** @type {Map<string, Onglet>} */
const onglets = new Map()
/** @type {Onglet|null} */
let actif = null
/** Événements arrivés pour un onglet que l'interface ne connaît pas encore. */
const orphelins = new Map()

// ------------------------------------------------------------------ outils

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const titreDe = (t, n = 70) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90
scroll.addEventListener('scroll', () => { if (actif) actif.stick = nearBottom() })

function scrollDown(t, force) {
  if (t !== actif) return
  if (force) t.stick = true
  if (t.stick) scroll.scrollTop = scroll.scrollHeight
}

function add(t, node) {
  t.thread.appendChild(node)
  scrollDown(t)
  return node
}

// ------------------------------------------------------------------ accueil

const SUGGESTIONS_AVEC_COMPTE = [
  'Combien j\'ai d\'abonnements newsletters ?',
  'Qui m\'écrit le plus dans ma boîte de réception ?',
  'Supprime les alertes Indeed de ma boîte de réception',
  'Montre-moi mes dossiers et leur volume',
]
const SUGGESTIONS_SANS_COMPTE = ['Comment ajouter une boîte mail ?']

function showWelcome(t) {
  const box = el('div', 'welcome')
  const h = new Date().getHours()
  const salut = h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir'
  box.appendChild(el('h1', null, `${salut} Nicolas 👋`))
  box.appendChild(el('p', null, comptes.length
    ? `Je suis branché sur ${comptes.length === 1 ? 'ta boîte' : `tes ${comptes.length} boîtes`} : ${comptes.map((c) => c.nom).join(', ')}. Dis-moi ce qu'il y a à trier.`
    : 'Aucune boîte mail configurée pour l\'instant. Ouvre les réglages ⚙ en haut à droite pour en ajouter une.'))
  if (comptes.length && frequentes.length) {
    box.appendChild(el('div', 'titre-chips', 'Tes demandes fréquentes'))
    const r = el('div', 'chips')
    for (const { texte: s, fois } of frequentes) {
      const c = el('button', 'chip recente')
      c.appendChild(el('span', 'txt', s))
      c.title = fois > 1 ? `${s}\n\nDemandé ${fois} fois` : s
      if (fois > 1) c.appendChild(el('span', 'fois', `×${fois}`))
      c.addEventListener('click', () => submit(s))
      r.appendChild(c)
    }
    box.appendChild(r)
    box.appendChild(el('div', 'titre-chips', 'Idées'))
  }
  const chips = el('div', 'chips')
  for (const s of comptes.length ? SUGGESTIONS_AVEC_COMPTE : SUGGESTIONS_SANS_COMPTE) {
    const c = el('button', 'chip', s)
    c.addEventListener('click', () => submit(s))
    chips.appendChild(c)
  }
  box.appendChild(chips)
  t.thread.appendChild(box)
}
function dropWelcome(t) {
  t.thread.querySelector('.welcome')?.remove()
}

// ---------------------------------------------------------- noms des outils

const OUTILS_MAIL = {
  lister_comptes: ['📬', 'Lire les boîtes configurées'],
  lister_dossiers: ['🗂', 'Lire l\'arborescence'],
  chercher_messages: ['🔎', 'Chercher des messages'],
  lire_message: ['✉️', 'Lire un message'],
  expediteurs: ['📊', 'Classer les expéditeurs'],
  abonnements: ['📰', 'Inventorier les abonnements'],
  apercu_dossier: ['🧭', 'Inspecter une branche'],
  etat_traitements: ['📋', 'État des traitements'],
  methodes_desabonnement: ['🔗', 'Voir le désabonnement'],
  creer_dossier: ['➕', 'Créer un dossier'],
  renommer_dossier: ['✏️', 'Renommer un dossier'],
  supprimer_dossier: ['🗑', 'Supprimer un dossier'],
  deplacer_messages: ['📦', 'Déplacer des messages'],
  deplacer_dossier: ['🚚', 'Déplacer une branche'],
  supprimer_messages: ['🗑', 'Supprimer des messages'],
  reprendre_traitement: ['▶️', 'Reprendre un traitement'],
  marquer_messages: ['🏷', 'Marquer des messages'],
  desabonner: ['🚫', 'Se désabonner'],
  envoyer_message: ['📤', 'Envoyer un e-mail'],
}

const BUILTIN = {
  Bash: ['⌘', 'Terminal'],
  Read: ['📄', 'Lire un fichier'],
  Write: ['✏️', 'Écrire un fichier'],
  Edit: ['✏️', 'Modifier un fichier'],
  Glob: ['🔎', 'Chercher des fichiers'],
  Grep: ['🔎', 'Chercher dans les fichiers'],
  WebSearch: ['🌐', 'Recherche web'],
  WebFetch: ['🌐', 'Lire une page web'],
  TodoWrite: ['📋', 'Plan de travail'],
  Task: ['🤖', 'Sous-agent'],
}

function describeTool(name) {
  if (name.startsWith('mcp__assistant-mail__')) {
    const court = name.slice('mcp__assistant-mail__'.length)
    return OUTILS_MAIL[court] || ['📬', court.replace(/_/g, ' ')]
  }
  if (BUILTIN[name]) return BUILTIN[name]
  if (name.startsWith('mcp__')) return ['🔌', name.split('__').slice(1).join(' · ')]
  return ['•', name]
}

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  if (name === 'Bash') return String(input.command || '')
  if (input.file_path) return String(input.file_path).split('/').pop()
  if (input.dossier_source && input.dossier_cible) return `${input.dossier_source} → ${input.dossier_cible}`
  for (const k of ['dossier', 'chemin', 'racine', 'avant', 'compte', 'a', 'query', 'url', 'prompt', 'description']) {
    if (typeof input[k] === 'string' && input[k]) return input[k]
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v)
  return first ? String(first) : ''
}

const MONO_TOOLS = new Set(['Bash', 'Write', 'Edit'])

const ETIQUETTES = {
  compte: 'boîte', compte_source: 'boîte source', compte_cible: 'boîte cible',
  dossier: 'dossier', dossier_source: 'dossier source', dossier_cible: 'dossier cible',
  chemin: 'chemin', avant: 'avant', apres: 'après', criteres: 'critères',
  de: 'expéditeur', a: 'destinataire', sujet: 'sujet', texte: 'texte',
  depuis: 'depuis', uids: 'UID', definitif: 'définitif', copier: 'copie seule',
  command: 'commande', file_path: 'fichier', cible: 'cible', type: 'méthode',
}

function humanizeInput(value, depth = 0, lines = []) {
  if (lines.length > 18) return lines
  if (Array.isArray(value)) {
    value.slice(0, 6).forEach((item, i) => {
      if (item && typeof item === 'object') {
        lines.push(`${'  '.repeat(depth)}${i + 1}.`)
        humanizeInput(item, depth + 1, lines)
      } else {
        lines.push(`${'  '.repeat(depth)}• ${item}`)
      }
    })
    if (value.length > 6) lines.push(`${'  '.repeat(depth)}… +${value.length - 6}`)
    return lines
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v == null || v === '') continue
      const label = ETIQUETTES[k] || k
      if (typeof v === 'object') {
        lines.push(`${'  '.repeat(depth)}${label} :`)
        humanizeInput(v, depth + 1, lines)
      } else {
        lines.push(`${'  '.repeat(depth)}${label} : ${v}`)
      }
    }
    return lines
  }
  lines.push(`${'  '.repeat(depth)}${value}`)
  return lines
}

// -------------------------------------------------------------------- rendu

function pushUserMessage(t, text, enAttente) {
  dropWelcome(t)
  const node = el('div', `msg user${enAttente ? ' enfile' : ''}`, text)
  if (enAttente) {
    node.appendChild(el('span', 'attente', 'pris en compte à la prochaine étape'))
    t.enFile.push(node)
  }
  add(t, node)
  scrollDown(t, true)
}

/**
 * L'agent vient de reprendre la parole ou d'appeler un outil : le SDK lui a donc
 * remis les messages en attente à cette respiration-là. On retire le marqueur.
 */
function videEnFile(t) {
  for (const n of t.enFile.splice(0, t.enFile.length)) {
    n.classList.remove('enfile')
    n.querySelector('.attente')?.remove()
  }
}

function startTextBlock(t) {
  dropWelcome(t)
  videEnFile(t)
  finishThinking(t)
  const node = el('div', 'msg assistant md')
  t.currentText = { el: node, raw: '' }
  add(t, node)
}

function appendText(t, chunk) {
  if (!t.currentText) startTextBlock(t)
  t.currentText.raw += chunk
  if (t.renderQueued) return
  t.renderQueued = true
  requestAnimationFrame(() => {
    t.renderQueued = false
    if (!t.currentText) return
    t.currentText.el.innerHTML = renderMarkdown(t.currentText.raw)
    scrollDown(t)
  })
}

function finishText(t) {
  if (t.currentText) {
    t.currentText.el.innerHTML = renderMarkdown(t.currentText.raw)
    if (!t.currentText.raw.trim()) t.currentText.el.remove()
  }
  t.currentText = null
}

function startThinking(t) {
  finishText(t)
  if (t.currentThinking) return
  const node = el('div', 'msg thinking')
  t.currentThinking = { el: node, raw: '' }
  add(t, node)
}

function appendThinking(t, chunk) {
  if (!t.currentThinking) startThinking(t)
  t.currentThinking.raw += chunk
  t.currentThinking.el.textContent = t.currentThinking.raw
  t.currentThinking.el.scrollTop = t.currentThinking.el.scrollHeight
  scrollDown(t)
}

function finishThinking(t) {
  if (t.currentThinking) t.currentThinking.el.classList.add('done')
  t.currentThinking = null
}

function addTool(t, evt) {
  videEnFile(t)
  finishText(t)
  finishThinking(t)
  const [glyph, label] = describeTool(evt.name)
  const node = el('div', 'msg tool running')
  const head = el('div', 'head')
  head.appendChild(el('span', 'glyph', glyph))
  head.appendChild(el('span', 'label', label))
  const arg = summarizeInput(evt.name, evt.input)
  if (arg) head.appendChild(el('span', 'arg', arg))
  head.appendChild(el('span', 'state'))
  node.appendChild(head)
  const body = el('div', 'body')
  body.textContent = formatJson(evt.input)
  node.appendChild(body)
  head.addEventListener('click', () => node.classList.toggle('open'))
  t.toolEls.set(evt.id, node)
  add(t, node)
}

function endTool(t, evt, { deplier = true } = {}) {
  const node = t.toolEls.get(evt.id)
  if (!node) return
  node.classList.remove('running')
  node.classList.add(evt.ok ? 'ok' : 'err')
  const body = node.querySelector('.body')
  if (evt.preview) body.textContent = `${body.textContent}\n\n— — —\n${evt.preview}`
  if (!evt.ok && deplier) node.classList.add('open')
}

function formatJson(value) {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function addNote(t, text, kind) {
  finishText(t)
  add(t, el('div', `note${kind ? ` ${kind}` : ''}`, text))
}

// -------------------------------------------------- progression des files

function majFile(t, evt) {
  let carte = t.fileEls.get(evt.id)
  if (!carte) {
    finishText(t)
    const node = el('div', 'file')
    const tete = el('div', 'tete')
    const titre = el('div', 't', evt.intitule || 'Traitement en cours')
    const stop = el('button', 'stop', 'Arrêter')
    stop.addEventListener('click', async () => {
      stop.disabled = true
      stop.textContent = 'Arrêt…'
      await api.arreterTraitement(evt.id)
    })
    tete.append(titre, stop)
    const d = el('div', 'd', '')
    const barre = el('div', 'barre')
    const jauge = el('i')
    barre.appendChild(jauge)
    const chiffres = el('div', 'chiffres')
    const faits = el('span', null, '')
    const echecs = el('span', 'echecs', '')
    chiffres.append(faits, echecs)
    node.append(tete, d, barre, chiffres)
    carte = { node, d, jauge, faits, echecs, stop }
    t.fileEls.set(evt.id, carte)
    add(t, node)
  }
  const pct = evt.total ? Math.round(((evt.faits + evt.echecs) / evt.total) * 100) : 0
  carte.jauge.style.width = `${pct}%`
  carte.d.textContent = evt.message || ''
  carte.faits.textContent = `${evt.faits} / ${evt.total} traités`
  carte.echecs.textContent = evt.echecs ? `${evt.echecs} échec(s)` : ''
  if (evt.fini) {
    carte.node.classList.add('fini')
    carte.stop.remove()
    carte.d.textContent = STATUTS[evt.statut] || evt.statut || 'Terminé'
  }
  scrollDown(t)
}

const STATUTS = {
  termine: 'Terminé.',
  termine_avec_echecs: 'Terminé, avec des échecs.',
  interrompu: 'Interrompu — reprenable.',
  echec: 'Échec.',
  annule: 'Annulé.',
}

// --------------------------------------------------------------- permissions

function addPermission(t, evt) {
  finishText(t)
  finishThinking(t)
  const [glyph, label] = describeTool(evt.toolName)
  const card = el('div', `msg perm${evt.summary?.danger ? ' danger' : ''}`)
  card.appendChild(el('div', 't', evt.title || `${glyph} ${label} ?`))
  const sub = evt.subtitle || evt.reason
  if (sub) card.appendChild(el('div', 's', sub))
  if (evt.hint) card.appendChild(el('div', 's warn', evt.hint))

  const lignes = evt.summary?.lines || []
  if (lignes.length) {
    const mono = MONO_TOOLS.has(evt.toolName)
    const box = el('div', 'summary')
    for (const ligne of lignes) {
      const [tete, ...reste] = String(ligne).split('\n')
      const item = el('div', mono ? 'sline mono' : 'sline')
      item.appendChild(el('span', 'head', tete))
      if (reste.length) item.appendChild(el('span', 'meta', reste.join(' ')))
      box.appendChild(item)
    }
    card.appendChild(box)
    const brut = humanizeInput(evt.input).join('\n')
    if (brut) {
      const pre = el('pre', 'hidden', brut)
      const toggle = el('button', 'detail-toggle', 'Voir le détail technique')
      toggle.addEventListener('click', () => {
        const cache = pre.classList.toggle('hidden')
        toggle.textContent = cache ? 'Voir le détail technique' : 'Masquer le détail'
      })
      card.append(toggle, pre)
    }
  } else {
    const detail = evt.toolName === 'Bash' ? String(evt.input?.command || '') : humanizeInput(evt.input).join('\n')
    if (detail) card.appendChild(el('pre', null, detail))
  }

  const btns = el('div', 'btns')
  const entree = { id: evt.id }
  const repondre = (a) => {
    if (!t.perms.includes(entree)) return
    t.perms.splice(t.perms.indexOf(entree), 1)
    api.replyPermission(evt.id, a)
    card.classList.add('answered')
    card.classList.remove('active')
    card.appendChild(el('div', 's', a.behavior === 'allow' ? (a.always ? '✓ Toujours autorisé' : '✓ Autorisé') : '✕ Refusé'))
    refreshActivePerm(t)
    majOnglet(t)
    if (t === actif) input.focus()
  }
  entree.allow = () => repondre({ behavior: 'allow' })
  entree.deny = () => repondre({ behavior: 'deny', message: 'Refusé par Nicolas.' })
  entree.card = card
  t.perms.push(entree)

  const oui = el('button', 'primary')
  oui.append(document.createTextNode('Autoriser'), el('kbd', null, '↩'))
  oui.addEventListener('click', () => entree.allow())
  const non = el('button', null)
  non.append(document.createTextNode('Refuser'), el('kbd', null, 'esc'))
  non.addEventListener('click', () => entree.deny())

  // « Toujours » est absent des actions qui touchent au contenu des boîtes :
  // chaque déplacement, chaque suppression se valide une par une.
  if (evt.allowAlways) {
    const toujours = el('button', null, 'Toujours')
    toujours.addEventListener('click', () => repondre({ behavior: 'allow', always: true }))
    btns.append(oui, toujours, non)
  } else {
    btns.append(oui, non)
  }
  card.appendChild(btns)
  card.appendChild(el('div', 'kb-hint', 'Champ vide : ↩ autorise, esc refuse.'))
  add(t, card)
  refreshActivePerm(t)
  majOnglet(t)
  scrollDown(t, true)
}

function refreshActivePerm(t) {
  for (const p of t.perms) p.card.classList.remove('active')
  t.perms[0]?.card.classList.add('active')
}

// --------------------------------------------------------------------- état

function setBusy(t, v) {
  t.busy = v
  if (!v) t.confirmerFermeture = false
  majOnglet(t)
  if (t !== actif) return
  document.body.classList.toggle('busy', v)
  sendBtn.disabled = !v && !input.value.trim()
}

function setStatus(text, kind) {
  statusLine.replaceChildren(el('span', `dot ${kind || ''}`), document.createTextNode(text))
}

function statusComptes() {
  if (!comptes.length) return setStatus('Aucune boîte configurée', 'err')
  setStatus(`${comptes.length} boîte${comptes.length > 1 ? 's' : ''} connectée${comptes.length > 1 ? 's' : ''}`, 'ok')
}

/** La ligne d'état suit la conversation affichée. */
function majStatut(t) {
  if (t.connexion === 'connecting') setStatus('Connexion…', 'pending')
  else if (t.connexion && t.connexion !== 'ok') setStatus(`Outils mail : ${t.connexion}`, 'err')
  else statusComptes()
}

// ------------------------------------------------------------------ onglets

function creerOnglet({ id, titre = '', sessionId = null }) {
  const thread = el('div', 'thread')
  scroll.appendChild(thread)
  const tab = el('div', 'onglet')
  tab.setAttribute('role', 'tab')
  const pastille = el('span', 'pastille')
  const libelle = el('span', 'titre')
  const fermer = el('button', 'fermer', '×')
  fermer.title = 'Fermer la conversation (⌘W)'
  tab.append(pastille, libelle, fermer)
  barreOnglets.appendChild(tab)

  /** @type {Onglet} */
  const t = {
    id, titre, sessionId, thread, tab,
    busy: false, stick: true, scrollTop: 0, brouillon: '',
    currentText: null, currentThinking: null, renderQueued: false,
    toolEls: new Map(), fileEls: new Map(), perms: [], enFile: [],
    tampon: null, charge: false, utilise: !!sessionId, nonLu: false, confirmerFermeture: false,
  }
  tab.addEventListener('click', () => activer(t))
  tab.addEventListener('auxclick', (e) => { if (e.button === 1) fermerOnglet(t) })
  fermer.addEventListener('click', (e) => { e.stopPropagation(); fermerOnglet(t) })
  onglets.set(id, t)
  majOnglet(t)

  // Événements arrivés avant que l'onglet n'existe ici (démarrage de sa session).
  const enAttente = orphelins.get(id)
  if (enAttente) {
    orphelins.delete(id)
    t.tampon = [...enAttente, ...(t.tampon || [])]
  }
  return t
}

function majOnglet(t) {
  t.tab.querySelector('.titre').textContent = t.titre || 'Nouvelle conversation'
  t.tab.title = t.titre || 'Nouvelle conversation'
  t.tab.classList.toggle('actif', t === actif)
  t.tab.classList.toggle('busy', t.busy)
  t.tab.classList.toggle('attente', t.perms.length > 0)
  t.tab.classList.toggle('nonlu', t.nonLu && t !== actif)
  t.tab.classList.toggle('confirmer', t.confirmerFermeture)
  t.tab.querySelector('.fermer').title = t.confirmerFermeture
    ? 'Il travaille encore : clique à nouveau pour fermer'
    : 'Fermer la conversation (⌘W)'
  barreOnglets.classList.toggle('seul', onglets.size < 2)
}

function majOnglets() {
  for (const t of onglets.values()) majOnglet(t)
}

function activer(t) {
  if (!t) return
  if (actif && actif !== t) {
    actif.scrollTop = scroll.scrollTop
    actif.brouillon = input.value
    actif.thread.classList.remove('active')
  }
  const changement = actif !== t
  actif = t
  t.nonLu = false
  t.thread.classList.add('active')
  if (changement) {
    input.value = t.brouillon
    autoGrow()
    majBouton()
  }
  document.body.classList.toggle('busy', t.busy)
  sendBtn.disabled = !t.busy && !input.value.trim()
  scroll.scrollTop = t.stick ? scroll.scrollHeight : t.scrollTop
  majOnglets()
  majStatut(t)
  t.tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  api.onglets.activer(t.id)
  chargerFil(t)
  input.focus()
}

/** Réaffiche le fil d'une conversation reprise — au premier affichage seulement. */
async function chargerFil(t) {
  if (t.charge) return
  t.charge = true
  if (!t.sessionId) {
    showWelcome(t)
    vider(t)
    return
  }
  t.tampon = t.tampon || []
  const attente = el('div', 'note', 'Chargement de la conversation…')
  t.thread.appendChild(attente)
  let fil = { evenements: [], tronque: false }
  try { fil = await api.onglets.fil(t.id) } catch {}
  attente.remove()
  if (fil.tronque) addNote(t, 'Le début de cette longue conversation est masqué.')
  rejouer(t, fil.evenements)
  if (!t.thread.querySelector('.msg')) showWelcome(t)
  if (!t.titre) {
    const premier = fil.evenements.find((e) => e.k === 'user')
    if (premier) { t.titre = titreDe(premier.text); majOnglet(t) }
  }
  vider(t)
  scrollDown(t, true)
}

function vider(t) {
  const evts = t.tampon || []
  t.tampon = null
  for (const evt of evts) traiter(t, evt)
}

/** Le fil enregistré, rendu comme pendant le direct. */
function rejouer(t, evenements) {
  for (const e of evenements) {
    if (e.k === 'user') pushUserMessage(t, e.text, false)
    else if (e.k === 'text') {
      startTextBlock(t)
      t.currentText.raw = e.text
      finishText(t)
    } else if (e.k === 'tool-use') addTool(t, e)
    else if (e.k === 'tool-result') endTool(t, e, { deplier: false })
    else if (e.k === 'note') addNote(t, e.text)
  }
  // Un outil resté sans résultat (conversation coupée) ne tourne plus.
  for (const n of t.thread.querySelectorAll('.tool.running')) n.classList.remove('running')
}

/** Un onglet vierge et déjà ouvert sert de « nouvelle conversation ». */
async function nouvelOnglet() {
  const vierge = [...onglets.values()].find((t) => !t.utilise && !t.busy)
  if (vierge) {
    activer(vierge)
    return vierge
  }
  const d = await api.onglets.nouveau()
  const t = onglets.get(d.id) || creerOnglet(d)
  activer(t)
  return t
}

async function fermerOnglet(t) {
  if (!t || !onglets.has(t.id)) return
  // Fermer une conversation qui travaille l'interrompt : on demande un second clic.
  if (t.busy && !t.confirmerFermeture) {
    t.confirmerFermeture = true
    majOnglet(t)
    if (t === actif) addNote(t, 'Il travaille encore : ⌘W ou × une seconde fois pour fermer quand même.')
    setTimeout(() => { t.confirmerFermeture = false; if (onglets.has(t.id)) majOnglet(t) }, 4000)
    return
  }
  if (onglets.size === 1) {
    if (!t.utilise) return
    const d = await api.onglets.nouveau()
    creerOnglet(d)
  }
  const liste = [...onglets.values()]
  const i = liste.indexOf(t)
  onglets.delete(t.id)
  t.thread.remove()
  t.tab.remove()
  api.onglets.fermer(t.id)
  if (actif === t) {
    actif = null
    const reste = [...onglets.values()]
    activer(reste[Math.min(i, reste.length - 1)])
  }
  majOnglets()
}

function ongletVoisin(sens) {
  const liste = [...onglets.values()]
  if (liste.length < 2) return
  const i = liste.indexOf(actif)
  activer(liste[(i + sens + liste.length) % liste.length])
}

// --------------------------------------------------------------- historique

const fmtHeure = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })
const fmtJour = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })
const fmtAnnee = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })

function quand(ms) {
  const d = new Date(ms)
  const auj = new Date()
  const jours = Math.round((new Date(auj.toDateString()) - new Date(d.toDateString())) / 86400000)
  if (jours === 0) return `aujourd'hui ${fmtHeure.format(d)}`
  if (jours === 1) return `hier ${fmtHeure.format(d)}`
  if (d.getFullYear() === auj.getFullYear()) return fmtJour.format(d)
  return fmtAnnee.format(d)
}

const sansAccents = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

let conversations = []

async function ouvrirHistorique() {
  settingsPanel.classList.add('hidden')
  panneauHistorique.classList.remove('hidden')
  filtreHistorique.value = ''
  listeHistorique.replaceChildren(el('div', 'vide', 'Chargement…'))
  filtreHistorique.focus()
  try { conversations = await api.conversations.liste() } catch { conversations = [] }
  afficherHistorique()
}

function fermerHistorique() {
  panneauHistorique.classList.add('hidden')
  input.focus()
}

function basculerHistorique() {
  if (panneauHistorique.classList.contains('hidden')) ouvrirHistorique()
  else fermerHistorique()
}

function afficherHistorique() {
  const f = sansAccents(filtreHistorique.value.trim())
  const liste = f ? conversations.filter((c) => sansAccents(c.titre).includes(f)) : conversations
  listeHistorique.replaceChildren()
  if (!liste.length) {
    listeHistorique.appendChild(el('div', 'vide', f ? 'Aucune conversation ne correspond.' : 'Aucune conversation enregistrée pour l\'instant.'))
    return
  }
  for (const c of liste) {
    const ligne = el('button', 'h-item')
    ligne.appendChild(el('span', 'h-titre', c.titre))
    const meta = el('span', 'h-meta', quand(c.date))
    if (c.onglet) meta.appendChild(el('span', 'h-ouverte', 'ouverte'))
    ligne.appendChild(meta)
    ligne.title = c.titre
    ligne.addEventListener('click', () => ouvrirConversation(c))
    listeHistorique.appendChild(ligne)
  }
}

async function ouvrirConversation(c) {
  fermerHistorique()
  const d = await api.conversations.ouvrir({ sessionId: c.sessionId, titre: c.titre })
  if (!d) return
  const t = onglets.get(d.id) || creerOnglet(d)
  activer(t)
}

filtreHistorique.addEventListener('input', afficherHistorique)
filtreHistorique.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); fermerHistorique() }
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    listeHistorique.querySelector('.h-item')?.click()
  }
})

// -------------------------------------------------------------------- envoi

/**
 * Envoie, même si l'agent travaille encore : le message rejoint sa file d'entrée
 * et il refait son plan avec. C'est le comportement de Claude Code, et c'est ce
 * qui permet de lui demander deux choses coup sur coup.
 */
function submit(forced) {
  const t = actif
  const text = (forced ?? input.value).trim()
  if (!t || !text) return
  t.utilise = true
  if (!t.titre) t.titre = titreDe(text)
  pushUserMessage(t, text, t.busy)
  api.send(t.id, text)
  input.value = ''
  t.brouillon = ''
  autoGrow()
  setBusy(t, true)
  majBouton()
}

/** Le bouton envoie tant qu'il y a du texte ; il n'arrête l'agent que sur un champ vide. */
function majBouton() {
  document.body.classList.toggle('peut-envoyer', !!input.value.trim())
}

function autoGrow() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`
}

input.addEventListener('input', () => {
  autoGrow()
  majBouton()
  sendBtn.disabled = actif?.busy ? false : !input.value.trim()
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
})

document.addEventListener('keydown', (e) => {
  // ⌘1 … ⌘9 : aller à la conversation n (⌘9 = la dernière), comme dans un navigateur.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    const liste = [...onglets.values()]
    const n = Number(e.key)
    const cible = n === 9 ? liste.at(-1) : liste[n - 1]
    if (cible) { e.preventDefault(); activer(cible) }
    return
  }
  if (document.activeElement?.closest('#form-compte, .mdp, #historique')) return
  const pending = actif?.perms[0]
  if (pending) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !input.value.trim()) {
      e.preventDefault(); e.stopPropagation(); pending.allow(); return
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pending.deny(); return }
    return
  }
  if (e.key === 'Escape' && !panneauHistorique.classList.contains('hidden')) { e.preventDefault(); fermerHistorique(); return }
  if (e.key === 'Escape' && actif?.busy) { e.preventDefault(); api.interrupt(actif.id) }
}, true)

sendBtn.addEventListener('click', () => {
  if (input.value.trim()) submit()
  else if (actif?.busy) api.interrupt(actif.id)
})

document.getElementById('btn-new').addEventListener('click', () => nouvelOnglet())
document.getElementById('btn-historique').addEventListener('click', () => basculerHistorique())

document.getElementById('btn-settings').addEventListener('click', () => {
  panneauHistorique.classList.add('hidden')
  settingsPanel.classList.toggle('hidden')
})
document.getElementById('btn-workspace').addEventListener('click', () => api.openWorkspace())
document.getElementById('btn-data').addEventListener('click', () => api.openData())

modelSelect.addEventListener('change', () => api.setConfig({ model: modelSelect.value }))
seuilSelect.addEventListener('change', () => api.setConfig({ seuilConfirmation: Number(seuilSelect.value) }))

document.addEventListener('click', (e) => {
  const lien = e.target.closest('a[data-ext]')
  if (!lien) return
  e.preventDefault()
  api.openExternal(lien.getAttribute('href'))
})

// ------------------------------------------------------------------ comptes

const champ = (id) => document.getElementById(id)

function renderComptes() {
  listeComptes.replaceChildren()
  if (!comptes.length) {
    listeComptes.appendChild(el('div', 'vide', 'Aucune boîte. Renseigne une adresse et son mot de passe ci-dessous.'))
    return
  }
  for (const c of comptes) {
    const ligne = el('div', 'compte')
    ligne.appendChild(el('span', `pastille${c.etat === 'ok' ? '' : ' err'}`))
    const infos = el('div', 'infos')
    infos.appendChild(el('div', 'n', c.nom))
    infos.appendChild(el('div', 'a', c.email))
    infos.appendChild(el('div', 'srv', `${c.imap.host}${c.smtp ? ` · ${c.smtp.host}` : ' · sans SMTP'}`))
    ligne.appendChild(infos)
    const cle = el('button', 'sup cle', '🔑')
    cle.title = `Changer le mot de passe de ${c.nom}`
    ligne.appendChild(cle)
    const sup = el('button', 'sup', '×')
    sup.title = `Retirer ${c.nom}`
    sup.addEventListener('click', async () => {
      // Retirer une boîte de l'app ne touche pas au serveur : rien n'est supprimé côté courrier.
      comptes = await api.comptes.remove(c.id)
      renderComptes()
      statusComptes()
    })
    ligne.appendChild(sup)
    listeComptes.appendChild(ligne)
    const mdp = formulaireMotDePasse(c)
    cle.addEventListener('click', () => {
      mdp.classList.toggle('hidden')
      if (!mdp.classList.contains('hidden')) mdp.querySelector('input').focus()
    })
    listeComptes.appendChild(mdp)
  }
}

/** Petit formulaire replié sous une boîte : nouveau mot de passe, testé avant d'être gardé. */
function formulaireMotDePasse(c) {
  const bloc = el('div', 'mdp hidden')
  const champMdp = document.createElement('input')
  champMdp.type = 'password'
  champMdp.placeholder = 'nouveau mot de passe'
  champMdp.autocomplete = 'off'
  const ok = el('button', 'primary', 'Enregistrer')
  const etat = el('div', 'etat')
  const valider = async () => {
    if (!champMdp.value) { etat.className = 'etat err'; etat.textContent = 'Il faut un mot de passe.'; return }
    ok.disabled = true
    etat.className = 'etat'
    etat.textContent = 'Vérification de la connexion…'
    try {
      const res = await api.comptes.changePassword(c.id, champMdp.value)
      if (!res.ok) { etat.className = 'etat err'; etat.textContent = res.erreur; return }
      comptes = res.comptes
      renderComptes()
      statusComptes()
      dire(res.test.smtp?.ok === false
        ? `Mot de passe de « ${c.nom} » changé. SMTP en échec (${res.test.smtp.erreur}).`
        : `Mot de passe de « ${c.nom} » changé.`, res.test.smtp?.ok === false ? 'warn' : 'ok')
    } catch (err) {
      etat.className = 'etat err'
      etat.textContent = String(err?.message || err)
    } finally {
      ok.disabled = false
    }
  }
  ok.addEventListener('click', valider)
  champMdp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); valider() }
    if (e.key === 'Escape') { e.preventDefault(); bloc.classList.add('hidden') }
  })
  const ligne = el('div', 'duo')
  ligne.appendChild(champMdp)
  ligne.appendChild(ok)
  bloc.appendChild(ligne)
  bloc.appendChild(etat)
  return bloc
}

function lireFormulaire() {
  const email = champ('c-email').value.trim()
  return {
    nom: champ('c-nom').value.trim() || email.split('@')[0],
    email,
    imap: {
      host: champ('c-imap-host').value.trim(),
      port: Number(champ('c-imap-port').value) || 993,
      secure: champ('c-imap-secure').checked,
      user: champ('c-user').value.trim() || email,
      pass: champ('c-pass').value,
    },
    smtp: champ('c-smtp-host').value.trim()
      ? {
          host: champ('c-smtp-host').value.trim(),
          port: Number(champ('c-smtp-port').value) || 587,
          secure: champ('c-smtp-secure').checked,
          user: champ('c-user').value.trim() || email,
          pass: champ('c-pass').value,
        }
      : null,
    certificatNonVerifie: champ('c-cert').checked,
  }
}

function dire(texte, kind) {
  etatForm.className = `etat${kind ? ` ${kind}` : ''}`
  etatForm.textContent = texte
}

async function enregistrer(cfg) {
  dire('Vérification de la connexion…')
  const res = await api.comptes.save(cfg)
  if (!res.ok) {
    dire(`Connexion IMAP refusée : ${res.test.imap.erreur}`, 'err')
    formCompte.classList.add('ouvert')
    return false
  }
  comptes = await api.comptes.list()
  renderComptes()
  statusComptes()
  for (const id of ['c-email', 'c-pass', 'c-nom', 'c-imap-host', 'c-imap-port', 'c-smtp-host', 'c-smtp-port', 'c-user']) champ(id).value = ''
  formCompte.classList.remove('ouvert')
  dire(res.test.smtp?.ok === false
    ? `« ${cfg.nom} » ajoutée. SMTP en échec (${res.test.smtp.erreur}) : envoi et désabonnement par e-mail indisponibles.`
    : `« ${cfg.nom} » ajoutée.`, res.test.smtp?.ok === false ? 'warn' : 'ok')
  return true
}

document.getElementById('btn-avance').addEventListener('click', (e) => {
  e.preventDefault()
  formCompte.classList.toggle('ouvert')
})

document.getElementById('btn-detect').addEventListener('click', async () => {
  const bouton = document.getElementById('btn-detect')
  const email = champ('c-email').value.trim()
  const motDePasse = champ('c-pass').value
  if (!email || !motDePasse) return dire('Il faut une adresse et un mot de passe.', 'err')

  bouton.disabled = true
  try {
    // Formulaire complété à la main : on ne redétecte pas, on teste et on enregistre.
    if (champ('c-imap-host').value.trim()) {
      await enregistrer(lireFormulaire())
      return
    }
    dire('Recherche des serveurs de ce fournisseur…')
    const trouve = await api.comptes.detect({ email, motDePasse, user: champ('c-user').value.trim() || undefined })
    if (!trouve.ok) {
      formCompte.classList.add('ouvert')
      dire(`${trouve.erreur}${trouve.note ? `\n${trouve.note}` : ''}\nRenseigne les serveurs à la main.`, 'err')
      return
    }
    champ('c-imap-host').value = trouve.imap.host
    champ('c-imap-port').value = trouve.imap.port
    champ('c-imap-secure').checked = trouve.imap.secure
    if (trouve.smtp) {
      champ('c-smtp-host').value = trouve.smtp.host
      champ('c-smtp-port').value = trouve.smtp.port
      champ('c-smtp-secure').checked = trouve.smtp.secure
    }
    await enregistrer(lireFormulaire())
  } catch (err) {
    dire(String(err?.message || err), 'err')
  } finally {
    bouton.disabled = false
  }
})

// -------------------------------------------------------------- événements

function menu(action) {
  if (action === 'nouvel-onglet') nouvelOnglet()
  else if (action === 'fermer-onglet') fermerOnglet(actif)
  else if (action === 'historique') basculerHistorique()
  else if (action === 'onglet-suivant') ongletVoisin(+1)
  else if (action === 'onglet-precedent') ongletVoisin(-1)
  else if (action === 'interrompre' && actif) api.interrupt(actif.id)
}

api.onEvent((evt) => {
  if (evt.k === 'menu') return menu(evt.action)
  if (evt.k === 'comptes') {
    comptes = evt.comptes
    renderComptes()
    statusComptes()
    return
  }
  // Sans onglet précisé (aperçu scripté), l'événement va à la conversation affichée.
  const t = evt.tab ? onglets.get(evt.tab) : actif
  if (!t) {
    if (evt.tab) {
      const l = orphelins.get(evt.tab) || []
      if (l.length < 200) l.push(evt)
      orphelins.set(evt.tab, l)
    }
    return
  }
  if (t.tampon) { t.tampon.push(evt); return }
  traiter(t, evt)
})

function traiter(t, evt) {
  switch (evt.k) {
    case 'ready':
      if (evt.sessionId) t.sessionId = evt.sessionId
      t.connexion = evt.mail === 'connected' ? 'ok' : evt.mail
      if (t === actif) majStatut(t)
      break
    case 'status':
      if (evt.state === 'connecting') {
        t.connexion = 'connecting'
        if (t === actif) majStatut(t)
      } else setBusy(t, evt.state === 'thinking')
      break
    case 'turn-start': setBusy(t, true); break
    case 'queued': setBusy(t, true); break
    case 'text-start': startTextBlock(t); break
    case 'text-delta': appendText(t, evt.text); break
    case 'thinking-start': startThinking(t); break
    case 'thinking-delta': appendThinking(t, evt.text); break
    case 'tool-use': addTool(t, evt); break
    case 'tool-result': endTool(t, evt); break
    case 'file': majFile(t, evt); break
    case 'permission': addPermission(t, evt); break
    case 'result':
      finishText(t); finishThinking(t)
      if (evt.isError && evt.text) addNote(t, evt.text, 'err')
      if (t !== actif) t.nonLu = true
      setBusy(t, false)
      break
    case 'interrupted':
      finishText(t); finishThinking(t)
      addNote(t, 'Interrompu. Un traitement en cours peut être repris : demande-moi « reprends le traitement ».')
      setBusy(t, false)
      break
    case 'note': addNote(t, evt.text); break
    // Le fil réaffiché suffit : la note ne sert que si rien n'a pu être relu.
    case 'resumed': if (!t.thread.querySelector('.msg')) addNote(t, 'Reprise de la conversation précédente.'); break
    case 'error':
      finishText(t); finishThinking(t)
      addNote(t, evt.message, 'err')
      setBusy(t, false)
      break
  }
}

// ---------------------------------------------------------------- démarrage

const state = await api.init()
modelSelect.value = state.config.model
seuilSelect.value = String(state.config.seuilConfirmation ?? 200)
comptes = state.comptes || []
frequentes = state.frequentes || []
renderComptes()
statusComptes()
if (!comptes.length) settingsPanel.classList.remove('hidden')
const ouverts = state.onglets?.length ? state.onglets : [{ id: 'o1', titre: '', sessionId: null }]
for (const o of ouverts) creerOnglet(o)
activer(onglets.get(state.actif) || [...onglets.values()].at(-1))
