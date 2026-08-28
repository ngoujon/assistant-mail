// Test d'intégration hors Electron : démarre une vraie session agent, vérifie que
// le serveur d'outils mail est branché, et qu'une question simple obtient une réponse.
// Aucune écriture sur les boîtes : toute demande de validation est refusée.
import { AgentSession } from '../src/agent/session.mjs'
import { P } from '../src/mail/paths.mjs'

const vu = { ready: null, texte: '', outils: [], perms: [], fini: false }

const session = new AgentSession({
  emit: (e) => {
    if (e.k === 'ready') { vu.ready = e; console.log('PRÊT   outils mail =', e.mail, '| modèle =', e.model) }
    if (e.k === 'text-delta') vu.texte += e.text
    if (e.k === 'tool-use') { vu.outils.push(e.name); console.log('OUTIL  ', e.name) }
    if (e.k === 'tool-result') console.log('RÉSULT ', e.name, e.ok ? 'ok' : 'ERREUR')
    if (e.k === 'error') console.log('ERREUR ', e.message)
    if (e.k === 'result') vu.fini = true
  },
  askPermission: async (req) => {
    vu.perms.push(req.toolName)
    console.log('VALID. demandée pour', req.toolName, '->', req.title || '')
    return { behavior: 'deny', message: 'test automatique' }
  },
  getConfig: () => ({ model: 'claude-sonnet-5', autoDoux: false }),
  workspace: P.workspace(),
})

session.start({})
session.send('Quelles boîtes mail sont configurées ? Réponds en une phrase, sans rien modifier.')

const debut = Date.now()
while (!vu.fini && Date.now() - debut < 150000) await new Promise((r) => setTimeout(r, 300))
session.stop()

console.log('\n--- réponse ---\n' + vu.texte.trim().slice(0, 500))
console.log('\noutils appelés :', vu.outils.join(', ') || 'aucun')
const ok = vu.ready?.mail === 'connected' && vu.texte.trim().length > 0
console.log(ok ? '\nSELFTEST OK' : '\nSELFTEST ÉCHEC')
process.exit(ok ? 0 : 1)
