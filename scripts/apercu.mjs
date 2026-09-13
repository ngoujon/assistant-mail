// Prévisualisation de l'interface, sans agent : rejoue une conversation type,
// vérifie les raccourcis clavier, puis écrit une capture PNG. Usage :
//   npx electron scripts/apercu.mjs [sortie.png]
import { app, BrowserWindow, nativeTheme } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] || path.join(root, 'apercu.png')

const SCENARIO = [
  { evt: { k: 'ready', sessionId: 'x', model: 'qwen/qwen3.8-27b', mail: 'connected' } },
  { user: 'Déplace le dossier Dupond de Perso vers Pro dans Archives' },
  { evt: { k: 'tool-use', id: 't0', name: 'lister_dossiers', input: { compte: 'Perso' } } },
  { evt: { k: 'tool-result', id: 't0', name: 'lister_dossiers', ok: true, preview: '42 dossiers' } },
  { evt: { k: 'tool-use', id: 't1', name: 'apercu_dossier', input: { compte: 'Perso', dossier: 'Dupond' } } },
  { evt: { k: 'tool-result', id: 't1', name: 'apercu_dossier', ok: true, preview: '4 dossiers, 342 messages' } },
  { evt: { k: 'text-start' } },
  { evt: { k: 'text-delta', text: 'La branche **Dupond** de *Perso* contient **342 messages** répartis sur 4 dossiers :\n\n- `Dupond` — 12\n- `Dupond/2019` — 128\n- `Dupond/2020` — 154\n- `Dupond/Contrats` — 48\n\nJe recrée la même arborescence dans **Pro** sous `Archives/Dupond`. Chaque message est copié sur disque, déposé, **relu à destination**, puis retiré de Perso. Compte ~6 min.' } },
  { evt: { k: 'result', isError: false } },
  {
    evt: {
      k: 'permission',
      id: 'p1',
      toolName: 'deplacer_dossier',
      allowAlways: false,
      title: 'Déplacer toute une branche ?',
      summary: {
        lines: [
          'Perso · Dupond (et ses sous-dossiers)\n→ Pro · Archives/Dupond',
          "L'arborescence est recréée à destination, puis les messages passent un par un.",
          'La branche d\'origine sera vidée, message par message, après vérification.',
        ],
      },
      input: { compte_source: 'Perso', dossier: 'Dupond', compte_cible: 'Pro', dossier_cible: 'Archives/Dupond' },
    },
  },
]

app.whenReady().then(async () => {
  if (process.env.THEME) nativeTheme.themeSource = process.env.THEME
  const win = new BrowserWindow({
    width: 500, height: 800, show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: process.env.THEME === 'dark' ? '#16181e' : '#f8fafd',
    webPreferences: { preload: path.join(root, 'scripts', 'apercu-preload.cjs'), contextIsolation: true },
  })

  const erreurs = []
  win.webContents.on('console-message', (d) => {
    if (d.level === 'error' || d.level === 3) erreurs.push(d.message)
  })
  win.webContents.on('render-process-gone', (_e, d) => erreurs.push(`renderer perdu : ${d.reason}`))
  await win.loadFile(path.join(root, 'src', 'renderer', 'index.html'))

  for (const etape of SCENARIO) {
    if (etape.user) {
      await win.webContents.executeJavaScript(
        `(() => {
           const box = document.getElementById('input')
           box.value = ${JSON.stringify(etape.user)}
           box.dispatchEvent(new Event('input'))
           document.getElementById('btn-send').click()
         })()`,
      )
    } else {
      await win.webContents.executeJavaScript(`window.assistantMail._fire(${JSON.stringify(etape.evt)})`)
    }
    await new Promise((r) => setTimeout(r, 60))
  }

  // Une file en cours : la barre de progression doit apparaître et avancer.
  for (const [faits, message] of [[0, 'démarrage'], [128, 'Facture 2019-04'], [341, 'Contrat cadre']]) {
    await win.webContents.executeJavaScript(
      `window.assistantMail._fire(${JSON.stringify({ k: 'file', id: 'f1', intitule: 'Déplacement de 342 messages — Perso → Pro', total: 342, faits, echecs: 0, message })})`,
    )
    await new Promise((r) => setTimeout(r, 80))
  }

  // Le point du jour : écrire pendant que ça travaille doit être possible.
  await win.webContents.executeJavaScript(`window.assistantMail._fire(${JSON.stringify({ k: 'status', state: 'thinking' })})`)
  await win.webContents.executeJavaScript(
    `(() => {
       const box = document.getElementById('input')
       box.value = 'et pendant ce temps, sors-moi la liste des abonnements'
       box.dispatchEvent(new Event('input'))
       document.getElementById('btn-send').click()
     })()`,
  )
  await new Promise((r) => setTimeout(r, 120))
  const envoyePendant = await win.webContents.executeJavaScript(
    "!!document.querySelector('.msg.user.enfile') && document.querySelectorAll('.msg.user').length",
  )
  const boutonArret = await win.webContents.executeJavaScript("!!document.querySelector('.file .stop')")
  // L'agent reprend la parole : le marqueur « en attente » doit disparaître.
  await win.webContents.executeJavaScript(`window.assistantMail._fire(${JSON.stringify({ k: 'text-start' })})`)
  await win.webContents.executeJavaScript(`window.assistantMail._fire(${JSON.stringify({ k: 'text-delta', text: 'Je lance les deux : le déplacement tourne en fond, je te sors les abonnements.' })})`)
  await new Promise((r) => setTimeout(r, 120))
  const marqueurRetire = await win.webContents.executeJavaScript("document.querySelectorAll('.msg.user.enfile').length === 0")
  await win.webContents.executeJavaScript(
    `window.assistantMail._fire(${JSON.stringify({ k: 'file', id: 'f1', intitule: 'Déplacement de 342 messages — Perso → Pro', total: 342, faits: 342, echecs: 0, message: 'termine', fini: true, statut: 'termine' })})`,
  )
  await new Promise((r) => setTimeout(r, 120))
  const arretRetire = await win.webContents.executeJavaScript("!document.querySelector('.file .stop') && !!document.querySelector('.file.fini')")

  await new Promise((r) => setTimeout(r, 500))
  const rendus = await win.webContents.executeJavaScript("document.querySelectorAll('#thread > *').length")
  const comptes = await win.webContents.executeJavaScript("document.querySelectorAll('#comptes .compte').length")
  const largeurJauge = await win.webContents.executeJavaScript("document.querySelector('.file .barre i')?.style.width || ''")

  const image = await win.webContents.capturePage()
  fs.writeFileSync(out, image.toPNG())

  // Les réglages du moteur : l'adresse du serveur local et les modèles qu'il sert.
  await win.webContents.executeJavaScript("document.getElementById('btn-settings').click()")
  await new Promise((r) => setTimeout(r, 250))
  const serveur = await win.webContents.executeJavaScript("document.getElementById('serveur').value")
  const modeles = await win.webContents.executeJavaScript("document.getElementById('model').options.length")
  const outReglages = out.replace(/\.png$/, '-reglages.png')
  fs.writeFileSync(outReglages, (await win.webContents.capturePage()).toPNG())
  await win.webContents.executeJavaScript("document.getElementById('btn-settings').click()")
  await new Promise((r) => setTimeout(r, 150))

  // Raccourci clavier : « esc » doit refuser la carte en attente.
  const avant = await win.webContents.executeJavaScript("document.querySelectorAll('.perm.answered').length")
  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
  await new Promise((r) => setTimeout(r, 200))
  const apres = await win.webContents.executeJavaScript("document.querySelectorAll('.perm.answered').length")

  console.log('envoi pendant travail :', envoyePendant ? `ok, ${envoyePendant} messages` : 'BLOQUÉ')
  console.log('marqueur « en attente » retiré :', marqueurRetire)
  console.log('bouton d\'arrêt de la file     :', boutonArret, '→ retiré à la fin :', arretRetire)
  console.log('blocs rendus      :', rendus)
  console.log('comptes affichés  :', comptes)
  console.log('jauge de la file  :', largeurJauge)
  console.log('esc sur la carte  :', `${avant} -> ${apres} répondue(s)`)
  console.log('erreurs console   :', erreurs.length ? erreurs.join(' | ') : 'aucune')
  console.log('serveur d\'IA      :', serveur || 'VIDE', '| modèles listés :', modeles)
  console.log('capture           :', out, 'et', outReglages)

  const ok = rendus > 5 && comptes === 2 && largeurJauge === '100%' && apres === 1 && !erreurs.length
    && envoyePendant === 2 && marqueurRetire && boutonArret && arretRetire
    && /^https?:\/\//.test(serveur) && modeles >= 1
  console.log(ok ? 'APERÇU OK' : 'APERÇU ÉCHEC')
  app.exit(ok ? 0 : 1)
})
