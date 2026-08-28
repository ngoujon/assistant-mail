import { app, BrowserWindow, ipcMain, shell, Menu, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { setDataRoot, P } from './mail/paths.mjs'
import { AgentSession } from './agent/session.mjs'
import { PROMPT_VERSION } from './agent/prompt.mjs'
import { publicAccounts, saveAccount, deleteAccount } from './mail/accounts.mjs'
import { guessCandidates, providerNote } from './mail/autodiscover.mjs'
import { testImapRaw, testSmtpRaw } from './mail/imap.mjs'
import { onProgress, onDone } from './mail/evenements.mjs'
import { listQueues } from './mail/file.mjs'
import { arreterFile } from './mail/transfert.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CONFIG_DEFAUT = {
  model: 'claude-opus-5',
  // Nombre de messages au-delà duquel un traitement demande validation.
  // 0 = toujours demander, -1 = ne demander que pour l'irréversible.
  seuilConfirmation: 50,
  bounds: { width: 500, height: 800 },
  lastSessionId: null,
  promptVersion: 0,
}

let config = { ...CONFIG_DEFAUT }
let configPath = ''
let workspace = ''
let win = null
let session = null
let quitting = false

const permissionsEnAttente = new Map()
let seqPermission = 0

// ------------------------------------------------------------------ config

function loadConfig() {
  configPath = path.join(app.getPath('userData'), 'reglages.json')
  try {
    config = { ...CONFIG_DEFAUT, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
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
      "# Espace de travail de l'Assistant MailZen",
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
    title: 'Assistant MailZen',
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
    permissionsEnAttente.set(id, resolve)
    const onAbort = () => {
      if (permissionsEnAttente.delete(id)) resolve({ behavior: 'deny', message: 'Annulé.' })
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    emit({
      k: 'permission',
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
  const resolve = permissionsEnAttente.get(id)
  if (!resolve) return
  permissionsEnAttente.delete(id)
  resolve(reponse)
}

function refuserToutes(message) {
  for (const [id, resolve] of permissionsEnAttente) {
    permissionsEnAttente.delete(id)
    resolve({ behavior: 'deny', message })
  }
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
      version: app.getVersion(),
    }
  })

  ipcMain.on('chat:send', (_e, text) => { if (text?.trim()) session.send(text) })
  ipcMain.on('chat:interrupt', () => session.interrupt())
  ipcMain.on('chat:new', () => {
    refuserToutes('Nouvelle conversation.')
    config.lastSessionId = null
    saveConfig()
    session.start({})
  })
  ipcMain.on('chat:config', (_e, patch) => {
    Object.assign(config, patch)
    saveConfig()
    if (patch.model) session.setModel(patch.model)
  })
  ipcMain.on('perm:reply', (_e, { id, answer }) => resolvePermission(id, answer))

  ipcMain.handle('comptes:list', () => publicAccounts())
  ipcMain.handle('comptes:detect', (_e, args) => detecterCompte(args))
  ipcMain.handle('comptes:test', (_e, cfg) => testerCompte(cfg))
  ipcMain.handle('comptes:save', async (_e, entree) => {
    const test = await testerCompte(entree)
    if (!test.imap.ok) return { ok: false, test }
    const acc = saveAccount({ ...entree, etat: 'ok', derniereErreur: null })
    // Les règles du prompt citent les boîtes : la session repart pour en tenir compte.
    redemarrerSession()
    return { ok: true, test, compte: publicAccounts().find((c) => c.id === acc.id) }
  })
  ipcMain.handle('comptes:delete', (_e, id) => {
    deleteAccount(id)
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

function redemarrerSession() {
  refuserToutes('Les boîtes mail ont changé.')
  config.lastSessionId = null
  saveConfig()
  session?.start({})
  emit({ k: 'comptes', comptes: publicAccounts() })
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about', label: "À propos de l'Assistant MailZen" },
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
        {
          label: 'Nouvelle conversation',
          accelerator: 'CmdOrCtrl+N',
          click: () => { refuserToutes('Nouvelle conversation.'); session.start({}); emit({ k: 'cleared' }) },
        },
        // Pas d'accélérateur « Esc » : la touche est traitée dans l'interface, où
        // elle refuse d'abord une demande de validation en attente.
        { label: 'Interrompre', accelerator: 'CmdOrCtrl+.', click: () => session.interrupt() },
        { type: 'separator' },
        { label: "Ouvrir l'espace de travail", click: () => shell.openPath(workspace) },
        { label: 'Ouvrir le coffre et les journaux', click: () => shell.openPath(path.dirname(P.queues())) },
      ],
    },
    { role: 'editMenu', label: 'Édition' },
    {
      label: 'Fenêtre',
      submenu: [
        { role: 'minimize', label: 'Réduire' },
        { role: 'close', label: 'Fermer' },
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
    app.setName('Assistant MailZen')
    nativeTheme.themeSource = 'system'
    setDataRoot(app.getPath('userData'))
    loadConfig()
    ensureWorkspace()
    createWindow()
    buildMenu()
    wireIpc()

    // La progression d'un déplacement remonte en direct dans la conversation.
    onProgress((evt) => emit(evt))

    // Un traitement parti en arrière-plan revient dans la conversation quand il a
    // fini : l'assistant l'annonce lui-même, comme si Nicolas venait de lui demander.
    onDone((rapport) => {
      const echecs = rapport.echecs_total || rapport.echecs || 0
      session?.notifier(
        `[Traitement terminé, message automatique de l'application — Nicolas ne l'a pas écrit]\n` +
        `« ${rapport.intitule} » : ${rapport.faits} message(s) traité(s), ${echecs} échec(s).\n` +
        (echecs
          ? `Annonce-le à Nicolas en deux lignes, dis quels messages ont échoué et pourquoi (appelle etat_traitements avec l'id ${rapport.id}), et propose la suite.`
          : "Annonce-le à Nicolas en une ligne. N'appelle pas d'outil si tu n'en as pas besoin."),
      )
    })

    session = new AgentSession({
      emit: (evt) => {
        if (evt.k === 'ready' && evt.sessionId) {
          config.lastSessionId = evt.sessionId
          saveConfig()
        }
        emit(evt)
      },
      askPermission,
      getConfig: () => config,
      workspace,
    })

    process.on('unhandledRejection', (err) => {
      emit({ k: 'error', message: `Agent indisponible : ${String(err?.message || err)}` })
      emit({ k: 'status', state: 'idle' })
    })

    const reglesChangees = config.promptVersion !== PROMPT_VERSION
    if (reglesChangees) {
      config.promptVersion = PROMPT_VERSION
      config.lastSessionId = null
      saveConfig()
    }
    session.start({ resume: reglesChangees ? undefined : config.lastSessionId || undefined })

    app.on('activate', () => {
      if (win) { win.show(); win.focus() } else createWindow()
    })
  })

  app.on('before-quit', () => {
    quitting = true
    refuserToutes("Fermeture de l'application.")
    session?.stop()
  })

  app.on('window-all-closed', () => { /* l'app reste dans le Dock */ })
}
