// Vérifie la politique de validation : ce que Nicolas vient de demander s'exécute,
// et une action mail n'est jamais confirmée deux fois (une fois par l'outil, une
// fois par le harnais). Lancer avec `npm run test:politique`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.MAILZEN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mailzen-pol-'))

const { AgentSession } = await import('../src/agent/session.mjs')

let reussis = 0
let echoues = 0
const verifie = (intitule, ok, detail) => {
  if (ok) { reussis++; console.log(`  ok   ${intitule}`) }
  else { echoues++; console.log(`  ÉCHEC ${intitule}${detail ? ` — ${detail}` : ''}`) }
}

function session(config, repondre = async () => ({ behavior: 'allow' })) {
  const demandes = []
  const s = new AgentSession({
    emit: () => {},
    askPermission: async (req) => { demandes.push(req); return repondre(req) },
    getConfig: () => config,
    workspace: '/tmp',
  })
  return { s, demandes }
}

console.log('\n1. Le seuil de confirmation')
{
  verifie('valeur absente → 50 par défaut', session({}).s.seuil() === 50)
  verifie('0 → chaque action est validée', session({ seuilConfirmation: 0 }).s.seuil() === 0)
  verifie('200 → au-delà de 200 messages', session({ seuilConfirmation: 200 }).s.seuil() === 200)
  verifie('-1 → plus aucune validation sur le volume', session({ seuilConfirmation: -1 }).s.seuil() === Infinity)
}

console.log("\n2. Un outil mail n'est pas re-confirmé par le harnais")
{
  const { s, demandes } = session({ seuilConfirmation: 50 })
  const outils = [
    'mcp__mailzen__supprimer_messages', 'mcp__mailzen__deplacer_messages',
    'mcp__mailzen__deplacer_dossier', 'mcp__mailzen__envoyer_message',
    'mcp__mailzen__marquer_messages', 'mcp__mailzen__creer_dossier',
  ]
  const reponses = []
  for (const nom of outils) reponses.push(await s.handlePermission(nom, { compte: 'Perso' }, {}))
  verifie('tous autorisés sans carte', reponses.every((r) => r.behavior === 'allow'))
  verifie('aucune demande envoyée à l\'interface', demandes.length === 0, `${demandes.length} demande(s)`)
}

console.log('\n3. Les outils système restent confirmés')
{
  const { s, demandes } = session({}, async () => ({ behavior: 'deny', message: 'non' }))
  const bash = await s.handlePermission('Bash', { command: 'rm -rf /tmp/x' }, {})
  verifie('Bash demande une validation', demandes.length === 1, `${demandes.length}`)
  verifie('le refus est transmis', bash.behavior === 'deny')
  verifie('la commande est affichée en clair', demandes[0]?.summary?.lines?.[0] === 'rm -rf /tmp/x')
  verifie('une commande destructrice est signalée', demandes[0]?.summary?.danger === true)

  const lecture = await s.handlePermission('Read', { file_path: '/tmp/a' }, {})
  verifie('la lecture de fichier passe sans carte', lecture.behavior === 'allow' && demandes.length === 1)
}

console.log("\n4. La validation demandée par un outil remonte bien à l'interface")
{
  const { s, demandes } = session({}, async () => ({ behavior: 'allow' }))
  const ok = await s.confirmerAction({
    outil: 'mcp__mailzen__supprimer_messages',
    entree: { compte: 'Perso', dossier: 'INBOX' },
    titre: 'Effacer définitivement 2 messages ?',
    lignes: ['Perso · INBOX', 'IRRÉVERSIBLE'],
    danger: true,
  })
  verifie('accord transmis à l\'outil', ok === true)
  verifie('la carte porte le titre de l\'outil', demandes[0]?.title === 'Effacer définitivement 2 messages ?')
  verifie('pas de bouton « Toujours » sur ces cartes', demandes[0]?.allowAlways === false)
  verifie('le danger est propagé', demandes[0]?.summary?.danger === true)

  const { s: s2 } = session({}, async () => ({ behavior: 'deny' }))
  verifie('un refus est transmis à l\'outil', (await s2.confirmerAction({ titre: 'x', lignes: [] })) === false)
}

console.log("\n5. Un message envoyé pendant un tour ne redémarre pas la session")
{
  const evenements = []
  const s = new AgentSession({
    emit: (e) => evenements.push(e.k),
    askPermission: async () => ({ behavior: 'allow' }),
    getConfig: () => ({}),
    workspace: '/tmp',
  })
  // On simule un tour en cours sans lancer de vraie requête.
  const pousses = []
  s.q = {}
  s.queue = { push: (m) => pousses.push(m) }
  s.busy = false
  s.send('premier')
  s.send('second pendant le tour')
  s.notifier('[Traitement terminé] …')

  verifie('les deux messages partent dans la file', pousses.length === 3, String(pousses.length))
  verifie('le premier ouvre un tour', evenements[0] === 'turn-start', evenements.join(','))
  verifie('le second est marqué « en file »', evenements.includes('queued'))
  verifie('un seul turn-start', evenements.filter((k) => k === 'turn-start').length === 1)
}

console.log(`\n${reussis} vérification(s) réussie(s), ${echoues} échec(s).`)
fs.rmSync(process.env.MAILZEN_DATA_DIR, { recursive: true, force: true })
process.exit(echoues ? 1 : 0)
