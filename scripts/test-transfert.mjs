// Éprouve les garanties du moteur de transfert contre un serveur simulé.
// Ce fichier est le contrat : si l'un de ces tests tombe, un message peut
// disparaître d'une vraie boîte. Lancer avec `npm test`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'mailzen-test-'))
process.env.MAILZEN_DATA_DIR = bac

const { FauxServeur, message } = await import('./faux-imap.mjs')
const { runTransfer } = await import('../src/mail/transfert.mjs')
const { createQueue, loadQueue, countByState } = await import('../src/mail/file.mjs')
const { P } = await import('../src/mail/paths.mjs')

let reussis = 0
let echoues = 0

function verifie(intitule, condition, detail) {
  if (condition) { reussis++; console.log(`  ok   ${intitule}`) }
  else { echoues++; console.log(`  ÉCHEC ${intitule}${detail ? ` — ${detail}` : ''}`) }
}

function titre(t) { console.log(`\n${t}`) }

function items(serveur, dossier) {
  return [...serveur.boite(dossier).values()].map((m) => ({
    uid: m.uid, message_id: m.messageId, sujet: m.envelope.subject,
    date: null, taille: m.size, statut: 'en_attente', dst_uid: null, detail: null,
  }))
}

function file({ type = 'deplacement', de, vers, source, cible, items: liste }) {
  return createQueue({
    type,
    intitule: `test ${type}`,
    source: { compteId: source, compte: source },
    cible: cible ? { compteId: cible, compte: cible } : null,
    options: { pause: 0, creerCible: true },
    paires: [{ de, vers, items: liste }],
  })
}

// ---------------------------------------------------------------------------
titre('1. Déplacement entre deux boîtes : tout arrive, la source est vidée')
{
  const src = new FauxServeur({ 'Dupond': [message('facture 2019'), message('contrat'), message('devis')] })
  const dst = new FauxServeur({ 'Archives': [] })
  const q = file({ de: 'Dupond', vers: 'Archives/Dupond', source: 'perso', cible: 'pro', items: items(src, 'Dupond') })

  const r = await runTransfer(q, { source: src.client(), cible: dst.client(), pause: 0 })

  verifie('statut terminé', r.statut === 'termine', r.statut)
  verifie('3 messages traités', r.faits === 3, String(r.faits))
  verifie('3 messages à destination', dst.boite('Archives/Dupond').size === 3)
  verifie('source vidée', src.boite('Dupond').size === 0)
  verifie('dossier de destination créé', dst.boites.has('Archives/Dupond'))
  const coffre = fs.readdirSync(P.vault(q.id))
  verifie('3 copies brutes dans le coffre', coffre.length === 3, coffre.join(','))
}

// ---------------------------------------------------------------------------
titre('2. Message qui n\'arrive pas à destination : il RESTE à la source')
{
  const src = new FauxServeur({ 'Boite': [message('ok-1'), message('perdu'), message('ok-2')] })
  const dst = new FauxServeur({ 'Cible': [] })
  // Le serveur de destination accuse réception mais ne stocke rien.
  dst.appendPiege = (_chemin, contenu) => (contenu.toString().includes('perdu') ? 'perdu' : null)
  const q = file({ de: 'Boite', vers: 'Cible', source: 'perso', cible: 'pro', items: items(src, 'Boite') })

  const r = await runTransfer(q, { source: src.client(), cible: dst.client(), pause: 0 })

  verifie('statut « terminé avec échecs »', r.statut === 'termine_avec_echecs', r.statut)
  verifie('2 réussis, 1 échec', r.faits === 2 && r.echecs === 1, `${r.faits}/${r.echecs}`)
  verifie('le message perdu est toujours à la source', src.boite('Boite').size === 1)
  verifie('c\'est bien le bon message qui reste', [...src.boite('Boite').values()][0].envelope.subject === 'perdu')
  verifie('les deux autres sont partis', dst.boite('Cible').size === 2)
  const echec = loadQueue(q.id).paires[0].items.find((i) => i.statut === 'echec')
  verifie('l\'échec est journalisé avec sa raison', /destination/.test(echec.detail || ''), echec?.detail)
}

// ---------------------------------------------------------------------------
titre('3. APPEND refusé : aucune suppression, la file peut être reprise')
{
  const src = new FauxServeur({ 'Boite': [message('a'), message('b')] })
  const dst = new FauxServeur({ 'Cible': [] })
  dst.appendPiege = () => 'erreur'
  const q = file({ de: 'Boite', vers: 'Cible', source: 'perso', cible: 'pro', items: items(src, 'Boite') })

  const r = await runTransfer(q, { source: src.client(), cible: dst.client(), pause: 0 })
  verifie('les 2 messages sont en échec', r.echecs === 2, String(r.echecs))
  verifie('la source est intacte', src.boite('Boite').size === 2)

  // Le serveur se remet : la reprise finit le travail.
  dst.appendPiege = null
  const q2 = loadQueue(q.id)
  for (const it of q2.paires[0].items) if (it.statut === 'echec') it.statut = 'en_attente'
  const r2 = await runTransfer(q2, { source: src.client(), cible: dst.client(), pause: 0 })
  verifie('la reprise termine les 2 messages', r2.faits === 2, String(r2.faits))
  verifie('source vidée après reprise', src.boite('Boite').size === 0)
  verifie('destination complète', dst.boite('Cible').size === 2)
}

// ---------------------------------------------------------------------------
titre('4. Interruption en cours de route, puis reprise sans doublon')
{
  const src = new FauxServeur({ 'Boite': [message('m1'), message('m2'), message('m3'), message('m4')] })
  const dst = new FauxServeur({ 'Cible': [] })
  const q = file({ de: 'Boite', vers: 'Cible', source: 'perso', cible: 'pro', items: items(src, 'Boite') })

  const ctrl = new AbortController()
  let vus = 0
  const clientSource = src.client()
  const fetchOrigine = clientSource.fetchOne.bind(clientSource)
  clientSource.fetchOne = async (...args) => {
    if (++vus === 5) ctrl.abort() // après 2 messages complets (fetch + contrôle de retrait)
    return fetchOrigine(...args)
  }

  const r = await runTransfer(q, { source: clientSource, cible: dst.client(), signal: ctrl.signal, pause: 0 })
  verifie('statut interrompu', r.statut === 'interrompu', r.statut)
  verifie('travail partiel cohérent', src.boite('Boite').size + dst.boite('Cible').size === 4,
    `${src.boite('Boite').size} + ${dst.boite('Cible').size}`)

  const r2 = await runTransfer(loadQueue(q.id), { source: src.client(), cible: dst.client(), pause: 0 })
  verifie('reprise terminée', r2.statut === 'termine', r2.statut)
  verifie('4 messages à destination, sans doublon', dst.boite('Cible').size === 4, String(dst.boite('Cible').size))
  verifie('source vidée', src.boite('Boite').size === 0)
}

// ---------------------------------------------------------------------------
titre('5. Même boîte : MOVE serveur, vérifié à destination')
{
  const s = new FauxServeur({ 'INBOX': [message('alerte 1'), message('alerte 2')], 'Corbeille': [] })
  const q = file({ de: 'INBOX', vers: 'Corbeille', source: 'perso', cible: 'perso', items: items(s, 'INBOX') })

  const r = await runTransfer(q, { source: s.client(), cible: s.client(), pause: 0 })
  verifie('2 messages traités', r.faits === 2, String(r.faits))
  verifie('INBOX vidée', s.boite('INBOX').size === 0)
  verifie('corbeille remplie', s.boite('Corbeille').size === 2)
  const detail = loadQueue(q.id).paires[0].items[0].detail
  verifie('le MOVE serveur a bien été utilisé', detail === 'MOVE serveur', detail)
}

// ---------------------------------------------------------------------------
titre('6. Copie : la source ne bouge pas')
{
  const src = new FauxServeur({ 'Boite': [message('x'), message('y')] })
  const dst = new FauxServeur({ 'Cible': [] })
  const q = file({ type: 'copie', de: 'Boite', vers: 'Cible', source: 'perso', cible: 'pro', items: items(src, 'Boite') })

  const r = await runTransfer(q, { source: src.client(), cible: dst.client(), pause: 0 })
  verifie('2 copies faites', r.faits === 2, String(r.faits))
  verifie('source intacte', src.boite('Boite').size === 2)
  verifie('destination remplie', dst.boite('Cible').size === 2)
}

// ---------------------------------------------------------------------------
titre('7. Serveur sans UID EXPUNGE et messages déjà marqués supprimés : refus net')
{
  const src = new FauxServeur({ 'Boite': [message('à déplacer'), message('déjà supprimé', { deleted: true })] })
  const dst = new FauxServeur({ 'Cible': [] })
  src.uidplus = false
  const aDeplacer = items(src, 'Boite').filter((i) => i.sujet === 'à déplacer')
  const q = file({ de: 'Boite', vers: 'Cible', source: 'perso', cible: 'pro', items: aDeplacer })

  const r = await runTransfer(q, { source: src.client(), cible: dst.client(), pause: 0 })
  verifie('le traitement est refusé', r.statut === 'echec', r.statut)
  verifie('le refus explique pourquoi', /UID EXPUNGE/.test(r.erreur || ''), r.erreur)
  verifie('rien n\'a bougé', src.boite('Boite').size === 2 && dst.boite('Cible').size === 0)
}

// ---------------------------------------------------------------------------
titre('8. Suppression définitive : copie brute conservée avant retrait')
{
  const src = new FauxServeur({ 'Spam': [message('pub 1'), message('pub 2')] })
  const q = file({ type: 'suppression_definitive', de: 'Spam', vers: null, source: 'perso', cible: null, items: items(src, 'Spam') })

  const r = await runTransfer(q, { source: src.client(), cible: src.client(), pause: 0 })
  verifie('2 messages effacés', r.faits === 2, String(r.faits))
  verifie('dossier vidé', src.boite('Spam').size === 0)
  verifie('2 copies brutes conservées', fs.readdirSync(P.vault(q.id)).length === 2)
}

console.log(`\n${reussis} vérification(s) réussie(s), ${echoues} échec(s).`)
fs.rmSync(bac, { recursive: true, force: true })
process.exit(echoues ? 1 : 0)
