import { renderMarkdown } from './markdown.js'

const api = window.mailzen
const thread = document.getElementById('thread')
const scroll = document.getElementById('scroll')
const input = document.getElementById('input')
const sendBtn = document.getElementById('btn-send')
const statusLine = document.getElementById('status-line')
const settingsPanel = document.getElementById('settings')
const modelSelect = document.getElementById('model')
const autoDoux = document.getElementById('auto-doux')
const listeComptes = document.getElementById('comptes')
const formCompte = document.getElementById('form-compte')
const etatForm = document.getElementById('c-etat')

let busy = false
let currentText = null
let currentThinking = null
let toolEls = new Map()
let fileEls = new Map()
let comptes = []
const permsEnAttente = []

// ------------------------------------------------------------------ outils

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

const nearBottom = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90
let stick = true
scroll.addEventListener('scroll', () => { stick = nearBottom() })

function scrollDown(force) {
  if (force) stick = true
  if (stick) scroll.scrollTop = scroll.scrollHeight
}

function add(node) {
  thread.appendChild(node)
  scrollDown()
  return node
}

function clearThread() {
  permsEnAttente.length = 0
  thread.replaceChildren()
  currentText = null
  currentThinking = null
  toolEls = new Map()
  fileEls = new Map()
  showWelcome()
}

// ------------------------------------------------------------------ accueil

const SUGGESTIONS_AVEC_COMPTE = [
  'Combien j\'ai d\'abonnements newsletters ?',
  'Qui m\'écrit le plus dans ma boîte de réception ?',
  'Supprime les alertes Indeed de ma boîte de réception',
  'Montre-moi mes dossiers et leur volume',
]
const SUGGESTIONS_SANS_COMPTE = ['Comment ajouter une boîte mail ?']

function showWelcome() {
  const box = el('div', 'welcome')
  const h = new Date().getHours()
  const salut = h < 5 ? 'Bonne nuit' : h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir'
  box.appendChild(el('h1', null, `${salut} Nicolas 👋`))
  box.appendChild(el('p', null, comptes.length
    ? `Je suis branché sur ${comptes.length === 1 ? 'ta boîte' : `tes ${comptes.length} boîtes`} : ${comptes.map((c) => c.nom).join(', ')}. Dis-moi ce qu'il y a à trier.`
    : 'Aucune boîte mail configurée pour l\'instant. Ouvre les réglages ⚙ en haut à droite pour en ajouter une.'))
  const chips = el('div', 'chips')
  for (const s of comptes.length ? SUGGESTIONS_AVEC_COMPTE : SUGGESTIONS_SANS_COMPTE) {
    const c = el('button', 'chip', s)
    c.addEventListener('click', () => submit(s))
    chips.appendChild(c)
  }
  box.appendChild(chips)
  thread.appendChild(box)
}

function dropWelcome() {
  thread.querySelector('.welcome')?.remove()
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
  if (name.startsWith('mcp__mailzen__')) {
    const court = name.slice('mcp__mailzen__'.length)
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

function pushUserMessage(text) {
  dropWelcome()
  add(el('div', 'msg user', text))
  scrollDown(true)
}

function startTextBlock() {
  dropWelcome()
  finishThinking()
  const node = el('div', 'msg assistant md')
  currentText = { el: node, raw: '' }
  add(node)
}

let renderQueued = false
function appendText(chunk) {
  if (!currentText) startTextBlock()
  currentText.raw += chunk
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    if (!currentText) return
    currentText.el.innerHTML = renderMarkdown(currentText.raw)
    scrollDown()
  })
}

function finishText() {
  if (currentText) {
    currentText.el.innerHTML = renderMarkdown(currentText.raw)
    if (!currentText.raw.trim()) currentText.el.remove()
  }
  currentText = null
}

function startThinking() {
  finishText()
  if (currentThinking) return
  const node = el('div', 'msg thinking')
  currentThinking = { el: node, raw: '' }
  add(node)
}

function appendThinking(chunk) {
  if (!currentThinking) startThinking()
  currentThinking.raw += chunk
  currentThinking.el.textContent = currentThinking.raw
  currentThinking.el.scrollTop = currentThinking.el.scrollHeight
  scrollDown()
}

function finishThinking() {
  if (currentThinking) currentThinking.el.classList.add('done')
  currentThinking = null
}

function addTool(evt) {
  finishText()
  finishThinking()
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
  toolEls.set(evt.id, node)
  add(node)
}

function endTool(evt) {
  const node = toolEls.get(evt.id)
  if (!node) return
  node.classList.remove('running')
  node.classList.add(evt.ok ? 'ok' : 'err')
  const body = node.querySelector('.body')
  if (evt.preview) body.textContent = `${body.textContent}\n\n— — —\n${evt.preview}`
  if (!evt.ok) node.classList.add('open')
}

function formatJson(value) {
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

function addNote(text, kind) {
  finishText()
  add(el('div', `note${kind ? ` ${kind}` : ''}`, text))
}

// -------------------------------------------------- progression des files

function majFile(evt) {
  let carte = fileEls.get(evt.id)
  if (!carte) {
    finishText()
    const node = el('div', 'file')
    const t = el('div', 't', evt.intitule || 'Traitement en cours')
    const d = el('div', 'd', '')
    const barre = el('div', 'barre')
    const jauge = el('i')
    barre.appendChild(jauge)
    const chiffres = el('div', 'chiffres')
    const faits = el('span', null, '')
    const echecs = el('span', 'echecs', '')
    chiffres.append(faits, echecs)
    node.append(t, d, barre, chiffres)
    carte = { node, d, jauge, faits, echecs }
    fileEls.set(evt.id, carte)
    add(node)
  }
  const pct = evt.total ? Math.round(((evt.faits + evt.echecs) / evt.total) * 100) : 0
  carte.jauge.style.width = `${pct}%`
  carte.d.textContent = evt.message || ''
  carte.faits.textContent = `${evt.faits} / ${evt.total} traités`
  carte.echecs.textContent = evt.echecs ? `${evt.echecs} échec(s)` : ''
  scrollDown()
}

// --------------------------------------------------------------- permissions

function addPermission(evt) {
  finishText()
  finishThinking()
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
    if (!permsEnAttente.includes(entree)) return
    permsEnAttente.splice(permsEnAttente.indexOf(entree), 1)
    api.replyPermission(evt.id, a)
    card.classList.add('answered')
    card.classList.remove('active')
    card.appendChild(el('div', 's', a.behavior === 'allow' ? (a.always ? '✓ Toujours autorisé' : '✓ Autorisé') : '✕ Refusé'))
    refreshActivePerm()
    input.focus()
  }
  entree.allow = () => repondre({ behavior: 'allow' })
  entree.deny = () => repondre({ behavior: 'deny', message: 'Refusé par Nicolas.' })
  entree.card = card
  permsEnAttente.push(entree)

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
  add(card)
  refreshActivePerm()
  scrollDown(true)
}

function refreshActivePerm() {
  for (const p of permsEnAttente) p.card.classList.remove('active')
  permsEnAttente[0]?.card.classList.add('active')
}

// --------------------------------------------------------------------- état

function setBusy(v) {
  busy = v
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

// -------------------------------------------------------------------- envoi

function submit(forced) {
  const text = (forced ?? input.value).trim()
  if (!text || busy) return
  pushUserMessage(text)
  api.send(text)
  input.value = ''
  autoGrow()
  setBusy(true)
}

function autoGrow() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`
}

input.addEventListener('input', () => {
  autoGrow()
  sendBtn.disabled = busy ? false : !input.value.trim()
})

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit() }
})

document.addEventListener('keydown', (e) => {
  if (document.activeElement?.closest('#form-compte')) return
  const pending = permsEnAttente[0]
  if (pending) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !input.value.trim()) {
      e.preventDefault(); e.stopPropagation(); pending.allow(); return
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); pending.deny(); return }
    return
  }
  if (e.key === 'Escape' && busy) { e.preventDefault(); api.interrupt() }
}, true)

sendBtn.addEventListener('click', () => { if (busy) api.interrupt(); else submit() })

document.getElementById('btn-new').addEventListener('click', () => {
  api.newChat()
  clearThread()
  setBusy(false)
  input.focus()
})

document.getElementById('btn-settings').addEventListener('click', () => settingsPanel.classList.toggle('hidden'))
document.getElementById('btn-workspace').addEventListener('click', () => api.openWorkspace())
document.getElementById('btn-data').addEventListener('click', () => api.openData())

modelSelect.addEventListener('change', () => api.setConfig({ model: modelSelect.value }))
autoDoux.addEventListener('change', () => api.setConfig({ autoDoux: autoDoux.checked }))

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
  }
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

api.onEvent((evt) => {
  switch (evt.k) {
    case 'ready':
      if (evt.mail === 'connected') statusComptes()
      else setStatus(`Outils mail : ${evt.mail}`, 'err')
      break
    case 'comptes':
      comptes = evt.comptes
      renderComptes()
      statusComptes()
      break
    case 'status':
      if (evt.state === 'connecting') setStatus('Connexion…', 'pending')
      else setBusy(evt.state === 'thinking')
      break
    case 'turn-start': setBusy(true); break
    case 'text-start': startTextBlock(); break
    case 'text-delta': appendText(evt.text); break
    case 'thinking-start': startThinking(); break
    case 'thinking-delta': appendThinking(evt.text); break
    case 'tool-use': addTool(evt); break
    case 'tool-result': endTool(evt); break
    case 'file': majFile(evt); break
    case 'permission': addPermission(evt); break
    case 'result':
      finishText(); finishThinking()
      if (evt.isError && evt.text) addNote(evt.text, 'err')
      setBusy(false)
      break
    case 'interrupted':
      finishText(); finishThinking()
      addNote('Interrompu. Un traitement en cours peut être repris : demande-moi « reprends le traitement ».')
      setBusy(false)
      break
    case 'note': addNote(evt.text); break
    case 'resumed': addNote('Reprise de la conversation précédente.'); break
    case 'cleared': clearThread(); setBusy(false); break
    case 'error':
      finishText(); finishThinking()
      addNote(evt.message, 'err')
      setBusy(false)
      break
  }
})

// ---------------------------------------------------------------- démarrage

const state = await api.init()
modelSelect.value = state.config.model
autoDoux.checked = Boolean(state.config.autoDoux)
comptes = state.comptes || []
renderComptes()
statusComptes()
if (!comptes.length) settingsPanel.classList.remove('hidden')
showWelcome()
setBusy(false)
input.focus()
