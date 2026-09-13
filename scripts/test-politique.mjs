// Vérifie la politique de validation : ce que Nicolas vient de demander s'exécute,
// et une action mail n'est jamais confirmée deux fois (une fois par l'outil, une
// fois par le harnais). Lancer avec `npm run test:politique`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ASSISTANT_MAIL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-mail-pol-'))

const { AgentSession } = await import('../src/agent/session.mjs')
const { SYSTEME_A_VALIDER } = await import('../src/agent/systeme.mjs')

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
  s.chargerOutils()
  const outils = [
    'supprimer_messages', 'deplacer_messages', 'deplacer_dossier',
    'envoyer_message', 'marquer_messages', 'creer_dossier',
  ]
  verifie('tous connus du modèle', outils.every((n) => s.outils.has(n)))
  verifie('aucun ne passe par le harnais', outils.every((n) => !SYSTEME_A_VALIDER.has(n)))

  // Un outil mail bidon : on vérifie qu'il s'exécute sans carte de validation.
  s.outils.set('marquer_messages', {
    name: 'marquer_messages',
    schema: (await import('zod')).z.object({}),
    handler: async () => ({ content: [{ type: 'text', text: 'fait' }] }),
  })
  const sortie = await s.executerOutil({ id: 't1', nom: 'marquer_messages', arguments: '{}' })
  verifie("l'outil s'exécute", sortie === 'fait', sortie)
  verifie("aucune demande envoyée à l'interface", demandes.length === 0, `${demandes.length} demande(s)`)
}

console.log('\n3. Les outils système restent confirmés')
{
  const { s, demandes } = session({}, async () => ({ behavior: 'deny', message: 'non' }))
  s.chargerOutils()
  const bash = await s.executerOutil({ id: 't1', nom: 'Bash', arguments: JSON.stringify({ command: 'rm -rf /tmp/x' }) })
  verifie('Bash demande une validation', demandes.length === 1, `${demandes.length}`)
  verifie('le refus est transmis au modèle', bash === 'non')
  verifie('la commande est affichée en clair', demandes[0]?.summary?.lines?.[0] === 'rm -rf /tmp/x')
  verifie('une commande destructrice est signalée', demandes[0]?.summary?.danger === true)

  await s.executerOutil({ id: 't2', nom: 'Read', arguments: JSON.stringify({ file_path: '/tmp/a' }) })
  verifie('la lecture de fichier passe sans carte', demandes.length === 1, `${demandes.length}`)
}

console.log("\n4. La validation demandée par un outil remonte bien à l'interface")
{
  const { s, demandes } = session({}, async () => ({ behavior: 'allow' }))
  const ok = await s.confirmerAction({
    outil: 'supprimer_messages',
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
  // On simule un tour en cours sans lancer de vraie requête au serveur d'IA.
  s.actif = true
  s.enCours = true
  s.send('premier')
  s.send('second pendant le tour')
  s.notifier('[Traitement terminé] …')

  verifie('les trois messages attendent leur tour', s.enAttente.length === 3, String(s.enAttente.length))
  verifie('le premier ouvre un tour', evenements[0] === 'turn-start', evenements.join(','))
  verifie('le second est marqué « en file »', evenements.includes('queued'))
  verifie('un seul turn-start', evenements.filter((k) => k === 'turn-start').length === 1)

  // Et une fois versés dans l'historique, ils forment trois messages de Nicolas.
  s.avaler()
  verifie('ils arrivent dans la conversation', s.historique.filter((m) => m.role === 'user').length === 3)
}

console.log(`\n${reussis} vérification(s) réussie(s), ${echoues} échec(s).`)
fs.rmSync(process.env.ASSISTANT_MAIL_DATA_DIR, { recursive: true, force: true })
process.exit(echoues ? 1 : 0)
