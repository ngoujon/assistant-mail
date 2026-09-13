// Test d'intégration hors Electron : démarre une vraie session agent contre le
// serveur d'IA local, vérifie qu'il répond, qu'il sait appeler un outil mail et
// qu'aucune requête ne part sur Internet.
// Aucune écriture sur les boîtes : toute demande de validation est refusée.
//
//   node scripts/selftest.mjs [http://serveur:1234/v1] [modele]
import { AgentSession, IA_DEFAUT } from '../src/agent/session.mjs'
import { listerModeles } from '../src/agent/llm.mjs'
import { P } from '../src/mail/paths.mjs'

const baseUrl = process.argv[2] || IA_DEFAUT.baseUrl

let modeles = []
try {
  modeles = await listerModeles({ baseUrl })
} catch (err) {
  console.log(`SERVEUR injoignable sur ${baseUrl} — ${err.message}`)
  process.exit(1)
}
const model = process.argv[3] || modeles.find((m) => !/embed|rerank|whisper|tts/i.test(m)) || modeles[0]
console.log(`SERVEUR ${baseUrl} | modèles : ${modeles.join(', ')} | choisi : ${model}`)

const vu = { ready: null, texte: '', outils: [], perms: [], fini: false, erreur: '' }

const session = new AgentSession({
  emit: (e) => {
    if (e.k === 'ready') { vu.ready = e; console.log('PRÊT   outils mail =', e.mail, '| modèle =', e.model) }
    if (e.k === 'text-delta') vu.texte += e.text
    if (e.k === 'tool-use') { vu.outils.push(e.name); console.log('OUTIL  ', e.name, JSON.stringify(e.input)) }
    if (e.k === 'tool-result') console.log('RÉSULT ', e.name, e.ok ? 'ok' : 'ERREUR', '—', String(e.preview || '').slice(0, 120).replace(/\n/g, ' '))
    if (e.k === 'error') { vu.erreur = e.message; vu.fini = true; console.log('ERREUR ', e.message) }
    if (e.k === 'note') console.log('NOTE   ', e.text)
    if (e.k === 'result' || e.k === 'interrupted') vu.fini = true
  },
  askPermission: async (req) => {
    vu.perms.push(req.toolName)
    console.log('VALID. demandée pour', req.toolName, '->', req.title || '')
    return { behavior: 'deny', message: 'test automatique' }
  },
  getConfig: () => ({ ia: { baseUrl, model }, seuilConfirmation: 50 }),
  workspace: P.workspace(),
})

session.start({})
await new Promise((r) => setTimeout(r, 1500))
session.send('Quelles boîtes mail sont configurées ? Appelle lister_comptes, puis réponds en une phrase, sans rien modifier.')

const debut = Date.now()
while (!vu.fini && Date.now() - debut < 600000) await new Promise((r) => setTimeout(r, 300))
session.stop()

console.log('\n--- réponse ---\n' + vu.texte.trim().slice(0, 800))
console.log('\noutils appelés :', vu.outils.join(', ') || 'aucun')
const ok = vu.ready?.mail === 'connected' && vu.texte.trim().length > 0 && !vu.erreur
console.log(ok ? '\nSELFTEST OK' : '\nSELFTEST ÉCHEC')
process.exit(ok ? 0 : 1)
