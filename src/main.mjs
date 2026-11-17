import { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setDataRoot, P } from './mail/paths.mjs'
import { AgentSession } from './agent/session.mjs'
import { PROMPT_VERSION } from './agent/prompt.mjs'
import { demandesFrequentes } from './agent/historique.mjs'
import { listerConversations, relireConversation, titreDe } from './agent/conversations.mjs'
import { publicAccounts, saveAccount, deleteAccount, listAccounts, changeAccountPassword } from './mail/accounts.mjs'
import { guessCandidates, providerNote } from './mail/autodiscover.mjs'
import { testImapRaw, testSmtpRaw, oublierCompte, fermerConnexions } from './mail/imap.mjs'
import { onProgress, onDone } from './mail/evenements.mjs'
import { listQueues } from './mail/file.mjs'
import { arreterFile } from './mail/transfert.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Le dossier de données porte le nom de l'app, et Electron le fige très tôt —
// bien avant `whenReady`. Le renommage en « Assistant Mail » (3.0) doit donc
// être décidé ici, en haut du fichier : appelé plus tard, `app.setName` ne
// déplace plus `userData`, et un bundle encore nommé « Assistant MailZen »
// (installé avant le renommage) rouvrirait l'ancien dossier, sans les comptes.
app.setName('Assistant Mail')
app.setPath('userData', path.join(app.getPath('appData'), 'Assistant Mail'))

const CONFIG_DEFAUT = {
  model: 'claude-opus-5-5',
  // Nombre de messages au-delà duquel un traitement demande validation.
  // 0 = toujours demander, -1 = ne demander que pour l'irréversible.
  // 200 depuis la 4.1 : un déplacement passe par le coffre et se vérifie à
  // destination, il n'y a pas de raison de l'arrêter à chaque dossier rangé.
  seuilConfirmation: 200,
  bounds: { width: 500, height: 800 },
  zoom: 0,
  // Les conversations ouvertes en onglets, rouvertes au lancement suivant.
  onglets: [],
  ongletActif: null,
  promptVersion: 0,
}

const ANCIENS_MODELES = {
  'claude-opus-5': 'claude-opus-5-5',
  'claude-sonnet-5': 'claude-sonnet-5-5',
  'claude-haiku-4-5': 'claude-haiku-5-5',
}

let config = { ...CONFIG_DEFAUT }
let configPath = ''
let workspace = ''
let win = null
let quitting = false

/**
 * Une session agent par onglet : chaque conversation a son propre fil, sa
 * propre mémoire, et peut travailler pendant qu'on écrit dans une autre.
 * @type {Map<string, { id: string, titre: string, sessionId: string|null, session: AgentSession }>}
 */
const onglets = new Map()
let ongletActif = null
let seqOnglet = 0
/** Le traitement de fond → l'onglet qui l'a lancé, pour y renvoyer sa progression. */
const fileOnglet = new Map()

/** @type {Map<string, { resolve: Function, tab: string|undefined }>} */
const permissionsEnAttente = new Map()
let seqPermission = 0

// ------------------------------------------------------------------ config

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'reglages.json')
  try {
    const lu = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    // Réglages laissés par la parenthèse « moteur local » (3.x) : l'adresse d'un
    // serveur du réseau local ne veut plus rien dire, le traitement revient à Claude.
    delete lu.ia
    config = { ...CONFIG_DEFAUT, ...lu }
    // Un modèle choisi dans une ancienne version passe à son successeur.
    if (ANCIENS_MODELES[config.model]) config.model = ANCIENS_MODELES[config.model]
    // Avant les onglets (4.x), une seule conversation était gardée.
    if (!Array.isArray(config.onglets)) config.onglets = []
    if (!config.onglets.length && lu.lastSessionId) config.onglets = [{ id: 'o1', sessionId: lu.lastSessionId, titre: '' }]
    delete config.lastSessionId
    // Nicolas a demandé un assistant plus autonome : l'ancien seuil par défaut
    // (50) passe une fois à 200. Un réglage choisi à la main n'est pas touché.
    if (!lu.autonomie) {
      if (config.seuilConfirmation === 50) config.seuilConfirmation = 200
      config.autonomie = 1
    }
  } catch {
    config = { ...CONFIG_DEFAUT }
  }
}

let saveTimer = null
function saveConfig() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    } catch {}
  }, 300)
}

function ensureWorkspace() {
  workspace = P.workspace()
  fs.mkdirSync(workspace, { recursive: true })
  const lisezMoi = path.join(workspace, 'LISEZ-MOI.md')
  if (!fs.existsSync(lisezMoi)) {
    fs.writeFileSync(lisezMoi, [
      "# Espace de travail de l'Assistant Mail",
      '',
      "C'est ici que l'assistant range les inventaires, plans de rangement et comptes rendus",
      "qu'il produit. Tu peux y déposer tes propres fichiers : il sait les lire.",
      '',
      'Les copies brutes des messages déplacés vivent à côté, dans `coffre/`,',
      'et le journal de chaque traitement dans `files/`.',
      '',
    ].join('\n'))
  }
}

// ----------------------------------------------------------------- fenêtre

function createWindow() {
  const { width, height, x, y } = config.bounds || CONFIG_DEFAUT.bounds
  win = new BrowserWindow({
    width, height, x, y,
    minWidth: 400,
    minHeight: 500,
    show: false,
    title: 'Assistant Mail',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.webContents.on('did-start-loading', () => { rendererPret = false })
  // Un changement de page remet le zoom à zéro : on le repose à chaque chargement.
  win.webContents.on('did-finish-load', () => win.webContents.setZoomLevel(config.zoom || 0))
  win.webContents.on('before-input-event', (e, input) => {
    const crans = zoomDeTouche(input)
    if (crans === null) return
    e.preventDefault()
    if (crans === 0) appliquerZoom(0)
    else zoomer(crans)
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())

  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide() }
  })
  const memoriser = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
    config.bounds = win.getBounds()
    saveConfig()
  }
  win.on('resize', memoriser)
  win.on('move', memoriser)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ------------------------------------------------------------------- zoom

// Le zoom d'Electron est logarithmique : un cran vaut 20 % de plus. On borne
// pour que l'interface reste utilisable, et on garde le réglage d'une fois sur l'autre.
const ZOOM_MIN = -4
const ZOOM_MAX = 6

function appliquerZoom(crans) {
  const n = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(crans)))
  config.zoom = n
  if (win && !win.isDestroyed()) win.webContents.setZoomLevel(n)
  saveConfig()
}

function zoomer(delta) {
  appliquerZoom((config.zoom || 0) + delta)
}

/**
 * Les touches de zoom, lues avant la page : ⌘= comme ⌘+ (le « + » d'un clavier
 * français demande Maj), ⌘−, ⌘0 et le pavé numérique. Un menu ne porte qu'un
 * raccourci, d'où ce rattrapage. Renvoie +1, -1, 0 (taille réelle) ou null.
 */
function zoomDeTouche(input) {
  if (input.type !== 'keyDown' || !(input.meta || input.control) || input.alt) return null
  const { key, code } = input
  if (key === '+' || key === '=' || code === 'NumpadAdd') return +1
  if (key === '-' || key === '_' || code === 'NumpadSubtract') return -1
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 0
  return null
}

// Le renderer n'écoute qu'après son chargement : on met les événements de
// démarrage en attente pour ne pas perdre l'état de connexion.
let rendererPret = false
const enAttente = []

function emit(evt) {
  if (!rendererPret) {
    enAttente.push(evt)
    if (enAttente.length > 200) enAttente.shift()
    return
  }
  if (win && !win.isDestroyed()) win.webContents.send('agent', evt)
}

function viderAttente() {
  rendererPret = true
  for (const evt of enAttente.splice(0, enAttente.length)) {
    if (win && !win.isDestroyed()) win.webContents.send('agent', evt)
  }
}

// --------------------------------------------------------------- permission

function askPermission(req) {
  return new Promise((resolve) => {
    const id = `perm-${++seqPermission}`
    permissionsEnAttente.set(id, { resolve, tab: req.tab })
    const onAbort = () => {
      if (permissionsEnAttente.delete(id)) resolve({ behavior: 'deny', message: 'Annulé.' })
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    emit({
      k: 'permission',
      tab: req.tab,
      id,
      toolName: req.toolName,
      title: req.title,
      displayName: req.displayName,
      subtitle: req.subtitle,
      reason: req.reason,
      summary: req.summary,
      hint: req.hint,
      allowAlways: req.allowAlways !== false,
      input: req.input,
    })
    if (win && !win.isVisible()) win.show()
  })
}

function resolvePermission(id, reponse) {
  const attente = permissionsEnAttente.get(id)
  if (!attente) return
  permissionsEnAttente.delete(id)
  attente.resolve(reponse)
}

/** Refuse les demandes en attente — toutes, ou celles d'un seul onglet. */
function refuserToutes(message, tab) {
  for (const [id, attente] of permissionsEnAttente) {
    if (tab && attente.tab !== tab) continue
    permissionsEnAttente.delete(id)
    attente.resolve({ behavior: 'deny', message })
  }
}

// ------------------------------------------------------------------ onglets

function memoriserOnglets() {
  config.onglets = [...onglets.values()].map(({ id, sessionId, titre }) => ({ id, sessionId, titre }))
  config.ongletActif = ongletActif
  saveConfig()
}

function creerOnglet({ id, sessionId = null, titre = '' } = {}) {
  const tab = id || `o${Date.now().toString(36)}${(++seqOnglet).toString(36)}`
  const o = { id: tab, titre, sessionId }
  o.session = new AgentSession({
    emit: (evt) => {
      // On ne retient que les conversations qui existent sur disque, donc reprenables.
      // (Une reprise ratée remet la session à zéro : l'onglet oublie l'ancienne.)
      const sid = o.session.aReprendre || null
      if (sid !== o.sessionId) {
        o.sessionId = sid
        memoriserOnglets()
      }
      emit({ ...evt, tab })
    },
    askPermission: (req) => askPermission({ ...req, tab }),
    getConfig: () => config,
    workspace,
    resume: sessionId || undefined,
    onFile: (fileId) => fileOnglet.set(fileId, tab),
  })
  onglets.set(tab, o)
  memoriserOnglets()
  return o
}

function decrireOnglet(o) {
  return { id: o.id, titre: o.titre, sessionId: o.sessionId }
}

function activerOnglet(id) {
  const o = onglets.get(id)
  if (!o) return
  ongletActif = id
  o.session.ensure()
  memoriserOnglets()
}

function fermerOnglet(id) {
  const o = onglets.get(id)
  if (!o) return
  refuserToutes('Conversation fermée.', id)
  o.session.stop()
  onglets.delete(id)
  if (ongletActif === id) ongletActif = [...onglets.keys()].at(-1) || null
  memoriserOnglets()
}

/** Les onglets ouverts au dernier lancement, ou un onglet vierge. */
function restaurerOnglets({ repartirAZero }) {
  const gardes = repartirAZero ? [] : config.onglets.filter((o) => o?.id)
  const actif = config.ongletActif
  for (const o of gardes) creerOnglet(o)
  if (!onglets.size) creerOnglet()
  ongletActif = onglets.has(actif) ? actif : [...onglets.keys()].at(-1)
  activerOnglet(ongletActif)
}

// ------------------------------------------------------------------ comptes

/** Trouve des réglages qui marchent vraiment, en les essayant. */
async function detecterCompte({ email, motDePasse, user }) {
  const identifiant = user || email
  const note = providerNote(email)
  const essais = []
  for (const cand of await guessCandidates(email)) {
    try {
      await testImapRaw({ ...cand.imap, user: identifiant, pass: motDePasse })
    } catch (err) {
      essais.push(`${cand.imap.host}:${cand.imap.port} — ${err.message}`)
      continue
    }
    let smtp = null
    for (const variante of [cand.smtp, cand.smtp && { host: cand.smtp.host, port: 465, secure: true }].filter(Boolean)) {
      try {
        await testSmtpRaw({ ...variante, user: identifiant, pass: motDePasse })
        smtp = variante
        break
      } catch {}
    }
    return { ok: true, imap: cand.imap, smtp, note, avertissement: smtp ? null : "IMAP fonctionne, mais aucun serveur SMTP n'a répondu : l'envoi et les désabonnements par e-mail seront indisponibles." }
  }
  return { ok: false, note, erreur: 'Aucune configuration testée ne fonctionne.', essais }
}

async function testerCompte(cfg) {
  const resultat = { imap: null, smtp: null }
  try {
    const dossiers = await testImapRaw({ ...cfg.imap, certificatNonVerifie: cfg.certificatNonVerifie })
    resultat.imap = { ok: true, dossiers }
  } catch (err) {
    resultat.imap = { ok: false, erreur: err.message }
  }
  if (cfg.smtp?.host) {
    try {
      await testSmtpRaw({ ...cfg.smtp, certificatNonVerifie: cfg.certificatNonVerifie })
      resultat.smtp = { ok: true }
    } catch (err) {
      resultat.smtp = { ok: false, erreur: err.message }
    }
  }
  return resultat
}

// ---------------------------------------------------------------------- IPC

function wireIpc() {
  ipcMain.handle('app:init', () => {
    setImmediate(viderAttente)
    return {
      config: { model: config.model, seuilConfirmation: config.seuilConfirmation },
      workspace,
      comptes: publicAccounts(),
      frequentes: demandesFrequentes(workspace),
      version: app.getVersion(),
      onglets: [...onglets.values()].map(decrireOnglet),
      actif: ongletActif,
    }
  })

  ipcMain.on('chat:send', (_e, { tab, text } = {}) => {
    const o = onglets.get(tab)
    if (!o || !text?.trim()) return
    if (!o.titre) {
      o.titre = titreDe(text)
      memoriserOnglets()
    }
    o.session.send(text)
  })
  ipcMain.on('chat:interrupt', (_e, tab) => onglets.get(tab)?.session.interrupt())
  ipcMain.on('chat:config', (_e, patch) => {
    Object.assign(config, patch)
    saveConfig()
    if (patch.model) for (const o of onglets.values()) o.session.setModel(patch.model)
  })

  ipcMain.handle('onglets:nouveau', () => {
    const o = creerOnglet()
    activerOnglet(o.id)
    return decrireOnglet(o)
  })
  ipcMain.on('onglets:activer', (_e, id) => activerOnglet(id))
  ipcMain.on('onglets:fermer', (_e, id) => fermerOnglet(id))
  ipcMain.handle('onglets:fil', async (_e, id) => {
    const o = onglets.get(id)
    if (!o?.sessionId) return { evenements: [], tronque: false }
    return relireConversation(o.sessionId, workspace)
  })

  ipcMain.handle('conversations:liste', async () => {
    const ouvertes = new Map([...onglets.values()].filter((o) => o.sessionId).map((o) => [o.sessionId, o.id]))
    return (await listerConversations(workspace)).map((c) => ({ ...c, onglet: ouvertes.get(c.sessionId) || null }))
  })
  // Rouvre une conversation passée dans un nouvel onglet — ou montre celui qui l'affiche déjà.
  ipcMain.handle('conversations:ouvrir', (_e, { sessionId, titre } = {}) => {
    if (!sessionId) return null
    const deja = [...onglets.values()].find((o) => o.sessionId === sessionId)
    const o = deja || creerOnglet({ sessionId, titre: titre || '' })
    activerOnglet(o.id)
    return { ...decrireOnglet(o), deja: !!deja }
  })
  ipcMain.on('perm:reply', (_e, { id, answer }) => resolvePermission(id, answer))

  ipcMain.handle('comptes:list', () => publicAccounts())
  ipcMain.handle('comptes:detect', (_e, args) => detecterCompte(args))
  ipcMain.handle('comptes:test', (_e, cfg) => testerCompte(cfg))
  ipcMain.handle('comptes:save', async (_e, entree) => {
    const test = await testerCompte(entree)
    if (!test.imap.ok) return { ok: false, test }
    const acc = saveAccount({ ...entree, etat: 'ok', derniereErreur: null })
    oublierCompte(acc.id)
    // Les règles du prompt citent les boîtes : la session repart pour en tenir compte.
    redemarrerSession()
    return { ok: true, test, compte: publicAccounts().find((c) => c.id === acc.id) }
  })
  ipcMain.handle('comptes:password', async (_e, { id, pass }) => {
    const acc = listAccounts().find((a) => a.id === id)
    if (!acc) return { ok: false, erreur: 'Boîte mail introuvable.' }
    if (!pass) return { ok: false, erreur: 'Il faut un mot de passe.' }
    // On vérifie le nouveau mot de passe avant de remplacer l'ancien.
    const test = await testerCompte({
      imap: { ...acc.imap, pass },
      smtp: acc.smtp?.host ? { ...acc.smtp, pass } : null,
      certificatNonVerifie: acc.certificatNonVerifie,
    })
    if (!test.imap.ok) return { ok: false, erreur: `Connexion IMAP refusée : ${test.imap.erreur}` }
    changeAccountPassword(id, pass)
    oublierCompte(id)
    redemarrerSession()
    return { ok: true, test, comptes: publicAccounts() }
  })
  ipcMain.handle('comptes:delete', (_e, id) => {
    deleteAccount(id)
    oublierCompte(id)
    redemarrerSession()
    return publicAccounts()
  })

  ipcMain.handle('traitements:list', () => listQueues({ limite: 20 }))
  ipcMain.handle('traitements:arreter', (_e, id) => {
    try { return arreterFile(id) } catch (err) { return { id, arrete: false, erreur: err.message } }
  })

  ipcMain.on('app:open-workspace', () => shell.openPath(workspace))
  ipcMain.on('app:open-data', () => shell.openPath(path.dirname(P.queues())))
  ipcMain.on('app:open-external', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
  })
}

/**
 * Les règles du prompt citent les boîtes : chaque conversation repart pour en
 * tenir compte, en gardant son fil.
 */
function redemarrerSession() {
  refuserToutes('Les boîtes mail ont changé.')
  for (const o of onglets.values()) o.session.restart()
  emit({ k: 'comptes', comptes: publicAccounts() })
}

/** Les commandes du menu agissent sur l'onglet affiché : c'est l'interface qui sait lequel. */
function commande(action) {
  emit({ k: 'menu', action })
  if (win && !win.isVisible()) win.show()
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about', label: "À propos de l'Assistant Mail" },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' },
      ],
    },
    {
      label: 'Conversation',
      submenu: [
        { label: 'Nouvelle conversation', accelerator: 'CmdOrCtrl+N', click: () => commande('nouvel-onglet') },
        { label: 'Fermer la conversation', accelerator: 'CmdOrCtrl+W', click: () => commande('fermer-onglet') },
        { label: 'Conversations précédentes…', accelerator: 'CmdOrCtrl+Y', click: () => commande('historique') },
        { type: 'separator' },
        { label: 'Conversation suivante', accelerator: 'Ctrl+Tab', click: () => commande('onglet-suivant') },
        { label: 'Conversation précédente', accelerator: 'Ctrl+Shift+Tab', click: () => commande('onglet-precedent') },
        { type: 'separator' },
        // Pas d'accélérateur « Esc » : la touche est traitée dans l'interface, où
        // elle refuse d'abord une demande de validation en attente.
        { label: 'Interrompre', accelerator: 'CmdOrCtrl+.', click: () => commande('interrompre') },
        { type: 'separator' },
        { label: "Ouvrir l'espace de travail", click: () => shell.openPath(workspace) },
        { label: 'Ouvrir le coffre et les journaux', click: () => shell.openPath(path.dirname(P.queues())) },
      ],
    },
    { role: 'editMenu', label: 'Édition' },
    {
      label: 'Affichage',
      submenu: [
        // Les touches sont lues avant la page (voir zoomDeTouche) : ces raccourcis
        // ne servent qu'à les afficher dans le menu.
        { label: 'Agrandir', accelerator: 'CmdOrCtrl+Plus', click: () => zoomer(+1) },
        { label: 'Réduire', accelerator: 'CmdOrCtrl+-', click: () => zoomer(-1) },
        { label: 'Taille réelle', accelerator: 'CmdOrCtrl+0', click: () => appliquerZoom(0) },
      ],
    },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        // ⌘W ferme la conversation, comme un onglet de navigateur ; la fenêtre passe à ⇧⌘W.
        { role: 'close', label: 'Fermer la fenêtre', accelerator: 'CmdOrCtrl+Shift+W' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Outils de développement' },
      ],
    },
  ]))
}

// -------------------------------------------------------------- cycle de vie

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus() } })

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'system'
    setDataRoot(app.getPath('userData'))
    loadConfig()
    ensureWorkspace()
    createWindow()
    buildMenu()
    wireIpc()

    // La progression d'un déplacement remonte en direct dans la conversation qui l'a lancé.
    onProgress((evt) => emit({ ...evt, tab: onglets.has(fileOnglet.get(evt.id)) ? fileOnglet.get(evt.id) : ongletActif }))

    // Un traitement parti en arrière-plan revient dans sa conversation quand il a
    // fini : l'assistant l'annonce lui-même, comme si Nicolas venait de lui demander.
    // Onglet refermé entre-temps : c'est la conversation affichée qui prévient.
    onDone((rapport) => {
      const echecs = rapport.echecs_total || rapport.echecs || 0
      const cible = onglets.get(fileOnglet.get(rapport.id)) || onglets.get(ongletActif)
      if (!cible) return
      cible.session.ensure()
      cible.session.notifier(
        `[Traitement terminé, message automatique de l'application — Nicolas ne l'a pas écrit]\n` +
        `« ${rapport.intitule} » : ${rapport.faits} message(s) traité(s), ${echecs} échec(s).\n` +
        (echecs
          ? `Annonce-le à Nicolas en deux lignes, dis quels messages ont échoué et pourquoi (appelle etat_traitements avec l'id ${rapport.id}), et propose la suite.`
          : "Annonce-le à Nicolas en une ligne. N'appelle pas d'outil si tu n'en as pas besoin."),
      )
    })

    process.on('unhandledRejection', (err) => {
      emit({ k: 'error', tab: ongletActif, message: `Agent indisponible : ${String(err?.message || err)}` })
      emit({ k: 'status', tab: ongletActif, state: 'idle' })
    })

    // Règles changées : on repart d'un onglet vierge. Les anciennes conversations
    // restent dans l'historique, d'où on peut les rouvrir.
    const reglesChangees = config.promptVersion !== PROMPT_VERSION
    if (reglesChangees) config.promptVersion = PROMPT_VERSION
    restaurerOnglets({ repartirAZero: reglesChangees })

    app.on('activate', () => {
      if (win) { win.show(); win.focus() } else createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    refuserToutes("Fermeture de l'application.")
    for (const o of onglets.values()) o.session.stop()
    fermerConnexions().catch(() => {})
  })

  app.on('window-all-closed', () => { /* l'app reste dans le Dock */ })
}
