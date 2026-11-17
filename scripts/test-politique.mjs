// Vérifie la politique de validation : ce que Nicolas vient de demander s'exécute,
// et une action mail n'est jamais confirmée deux fois (une fois par l'outil, une
// fois par le harnais). Lancer avec `npm run test:politique`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.ASSISTANT_MAIL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-mail-pol-'))
// Deux boîtes factices pour la garde : une grosse (séparateur « . ») et une petite.
fs.writeFileSync(path.join(process.env.ASSISTANT_MAIL_DATA_DIR, 'comptes.json'), JSON.stringify({
  comptes: [
    { id: 'grosse', nom: 'Grosse', email: 'grosse@exemple.fr', imap: { host: 'imap.exemple.fr', port: 993, secure: true, user: 'g' } },
    { id: 'petite', nom: 'Petite', email: 'petite@exemple.fr', imap: { host: 'imap.exemple.fr', port: 993, secure: true, user: 'p' } },
  ],
}))

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
  verifie('valeur absente → 200 par défaut', session({}).s.seuil() === 200)
  verifie('0 → chaque action est validée', session({ seuilConfirmation: 0 }).s.seuil() === 0)
  verifie('200 → au-delà de 200 messages', session({ seuilConfirmation: 200 }).s.seuil() === 200)
  verifie('-1 → plus aucune validation sur le volume', session({ seuilConfirmation: -1 }).s.seuil() === Infinity)
}

console.log("\n2. Un outil mail n'est pas re-confirmé par le harnais")
{
  const { s, demandes } = session({ seuilConfirmation: 50 })
  const outils = [
    'mcp__assistant-mail__supprimer_messages', 'mcp__assistant-mail__deplacer_messages',
    'mcp__assistant-mail__deplacer_dossier', 'mcp__assistant-mail__envoyer_message',
    'mcp__assistant-mail__marquer_messages', 'mcp__assistant-mail__creer_dossier',
  ]
  const reponses = []
  for (const nom of outils) reponses.push(await s.handlePermission(nom, { compte: 'Perso' }, {}))
  verifie('tous autorisés sans carte', reponses.every((r) => r.behavior === 'allow'))
  verifie('aucune demande envoyée à l\'interface', demandes.length === 0, `${demandes.length} demande(s)`)
}

console.log('\n3. Les commandes risquées restent confirmées')
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
    outil: 'mcp__assistant-mail__supprimer_messages',
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

console.log("\n6. L'assistant travaille seul sur ce qui ne risque rien")
{
  const { bashSansRisque } = await import('../src/agent/autonomie.mjs')
  const ws = path.join(os.homedir(), 'Library/Application Support/Assistant Mail/Espace de travail')
  const libres = [
    'dig +short TXT _dmarc.exemple.fr',
    'ls -la ~/Desktop',
    'python3 scripts/lire_dmarc.py rapport.xml',
    'curl -s -m 15 https://exemple.fr/tarifs | head -50',
    "grep -c Facture inventaire.csv 2>/dev/null",
    'echo ok > rapport.md',
    'cat a.csv >> ~/Desktop/Refus.md',
    'open ~/Desktop/Refus.md',
    'mkdir -p scripts',
  ]
  for (const c of libres) verifie(`sans carte : ${c}`, bashSansRisque(c, ws))
  const risquees = [
    'rm -rf ~/Documents/x',
    'sudo ls',
    'mv a.csv ~/Library/x',
    'curl -X POST https://exemple.fr/api -d a=1',
    'curl -F f=@rapport.md https://exemple.fr',
    'cat "$HOME/Library/Application Support/Assistant Mail/cle-secrete"',
    'echo x > ~/.zshrc',
    'git push',
    'ls; rm a',
    'osascript -e "tell app \\"Mail\\" to quit"',
  ]
  for (const c of risquees) verifie(`avec carte : ${c}`, !bashSansRisque(c, ws))

  const { s, demandes } = session({}, async () => ({ behavior: 'allow' }))
  await s.handlePermission('Write', { file_path: path.join(os.homedir(), 'Desktop/compte-rendu.md'), content: 'x' }, {})
  await s.handlePermission('Edit', { file_path: '/tmp/plan.md' }, {})
  verifie('écrire sur le Bureau ou dans le dossier de travail passe sans carte', demandes.length === 0, `${demandes.length}`)
  await s.handlePermission('Write', { file_path: path.join(os.homedir(), '.zshrc'), content: 'x' }, {})
  verifie('écrire un fichier système demande', demandes.length === 1, `${demandes.length}`)
  await s.handlePermission('Read', { file_path: '/x/Assistant Mail/cle-secrete' }, {})
  verifie('lire la clé des mots de passe demande', demandes.length === 2, `${demandes.length}`)
  const agent = await s.handlePermission('Agent', { prompt: 'x' }, {})
  verifie('un sous-agent passe sans carte', agent.behavior === 'allow' && demandes.length === 2)
}

console.log('\n7. Une conversation rouverte se reprend, une vierge ne se reprend pas')
{
  const mk = (resume) => new AgentSession({ emit: () => {}, askPermission: async () => ({}), getConfig: () => ({}), workspace: '/tmp', resume })
  const reprise = mk('abc')
  verifie('la conversation à reprendre est retenue', reprise.aReprendre === 'abc')
  const vierge = mk()
  vierge.route({ type: 'system', subtype: 'init', session_id: 'neuf', mcp_servers: [] })
  verifie("une session où rien n'a été dit n'est pas retenue", vierge.aReprendre === null)
  vierge.q = {}
  vierge.queue = { push: () => {} }
  vierge.send('bonjour')
  verifie('après un premier message, elle devient reprenable', vierge.aReprendre === 'neuf')
}

console.log("\n8. Une boîte à 330 dossiers se lit, puis s'écrit")
{
  const { GardeMail } = await import('../src/agent/gardes.mjs')
  const { formaterDossiers } = await import('../src/agent/outils.mjs')
  const M = 'mcp__assistant-mail__'
  const source = 'INBOX.PRO.Qwebty.A TRAITER.QWEBTY'
  const chemins = ['INBOX.PRO', source, 'INBOX.PRO.Qwebty.Hostinger', 'INBOX.PRO.Qwebty.A TRAITER.VIDE']
  for (let i = 0; chemins.length < 330; i++) chemins.push(`INBOX.ARCHIVES.Clients.Client numero ${i}.Factures et devis`)

  const g = new GardeMail()
  const deplacer = { compte_source: 'Grosse', dossier_source: source, dossier_cible: 'INBOX.PRO.Qwebty.Hostinger', criteres: { uids: [1, 2, 3] } }
  verifie('sans lister_dossiers, une écriture reste refusée',
    /pas encore lu/.test(g.verifier(`${M}deplacer_messages`, deplacer) || ''))

  const sortie = formaterDossiers('Grosse', chemins.map((c) => ({ chemin: c, selectionnable: true, messages: 12, non_lus: 0 })), { separateur: '.' })
  verifie('la liste tient dans une réponse d\'outil', sortie.length < 25000, `${sortie.length} caractères`)
  verifie('une ligne par dossier', sortie.split('\n').length === 330 + 2)

  // Ce que fait lister_dossiers dès que la lecture IMAP réussit.
  g.noterDossiers('Grosse', { chemins, separateur: '.' })
  verifie('lister → deplacer_messages passe', g.verifier(`${M}deplacer_messages`, deplacer) === null)
  verifie('→ supprimer_messages passe', g.verifier(`${M}supprimer_messages`, { compte: 'Grosse', dossier: source, criteres: { uids: [10, 11] } }) === null)
  verifie('→ supprimer_dossier sur un dossier vide passe', g.verifier(`${M}supprimer_dossier`, { compte: 'Grosse', chemin: 'INBOX.PRO.Qwebty.A TRAITER.VIDE' }) === null)
  verifie('un chemin inventé reste refusé', /ne figure pas/.test(g.verifier(`${M}supprimer_dossier`, { compte: 'Grosse', chemin: 'INBOX.Inventé' }) || ''))
  verifie("l'autre boîte, jamais listée, reste refusée",
    /pas encore lu/.test(g.verifier(`${M}supprimer_messages`, { compte: 'Petite', dossier: 'INBOX', criteres: { uids: [1] } }) || ''))
  verifie('déplacer une branche dans elle-même est refusé avec le séparateur « . »',
    /à l'intérieur/.test(g.verifier(`${M}deplacer_dossier`, { compte_source: 'Grosse', dossier: 'INBOX.PRO', compte_cible: 'Grosse', dossier_cible: 'INBOX.PRO.Qwebty' }) || ''))

  // Une branche listée suffit pour écrire dans cette branche, pas ailleurs.
  const b = new GardeMail()
  b.noterDossiers('Petite', { chemins: ['Pro', 'Pro/Clients'], separateur: '/' })
  verifie('lister une branche → écrire dedans passe', b.verifier(`${M}supprimer_messages`, { compte: 'Petite', dossier: 'Pro/Clients', criteres: { uids: [1] } }) === null)
  verifie('… mais pas hors de la branche', b.verifier(`${M}supprimer_messages`, { compte: 'Petite', dossier: 'INBOX', criteres: { uids: [1] } }) !== null)
  b.noterDossiers('Petite', { chemins: ['Pro', 'Pro/Clients'], separateur: '/', inspecte: 'Pro/Clients' })
  verifie('apercu_dossier autorise une suppression avec contenu', b.verifier(`${M}supprimer_dossier`, { compte: 'Petite', chemin: 'Pro/Clients', vraiment_vider: true }) === null)

  // Le résultat renvoyé au modèle ne compte plus : seule la lecture IMAP fait foi.
  const { s } = session({})
  s.route({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: `${M}lister_dossiers`, input: {} }] } })
  s.route({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'Error: result exceeds maximum allowed tokens' }] } })
  verifie('un résultat d\'outil ne marque rien : seule la lecture IMAP compte',
    /pas encore lu/.test(s.garde.verifier(`${M}supprimer_messages`, { compte: 'Grosse', dossier: source, criteres: { uids: [1] } }) || ''))
}

console.log(`\n${reussis} vérification(s) réussie(s), ${echoues} échec(s).`)
fs.rmSync(process.env.ASSISTANT_MAIL_DATA_DIR, { recursive: true, force: true })
process.exit(echoues ? 1 : 0)
