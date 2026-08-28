// Les outils que l'assistant a sous la main : un serveur MCP interne au processus.
// Rien n'y est exposé qui ne passe par la couche src/mail — en particulier, aucun
// outil ne rend un mot de passe, et aucune suppression n'existe hors du moteur de file.
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { publicAccounts, resolveAccount } from '../mail/accounts.mjs'
import { listFolders, createFolder, renameFolder, deleteFolder } from '../mail/dossiers.mjs'
import { searchMessages, readMessage, senders, newsletters } from '../mail/messages.mjs'
import { markMessages, unsubscribeInfo, unsubscribe, sendMessage } from '../mail/actions.mjs'
import { withImap } from '../mail/imap.mjs'
import {
  fileDeplacementMessages, fileSuppressionMessages, fileDeplacementDossier,
  executerFile, reprendreFile, brancheDossiers,
} from '../mail/transfert.mjs'
import { loadQueue, listQueues, resume } from '../mail/file.mjs'
import { P } from '../mail/paths.mjs'

const texte = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const erreur = (m) => ({ content: [{ type: 'text', text: `ERREUR : ${m}` }], isError: true })

/** Enveloppe commune : une erreur IMAP revient au modèle en clair, jamais en exception. */
const sur = (fn) => async (args, extra) => {
  try {
    return texte(await fn(args, extra))
  } catch (err) {
    return erreur(err?.message || String(err))
  }
}

const CRITERES = z.object({
  de: z.string().optional().describe("expéditeur ou fragment d'adresse (ex : « indeed.com »)"),
  a: z.string().optional().describe('destinataire'),
  sujet: z.string().optional().describe('fragment recherché dans le sujet'),
  texte: z.string().optional().describe('fragment recherché dans le corps (lent sur un gros dossier)'),
  depuis: z.string().optional().describe('date ISO : ne garder que les messages postérieurs'),
  avant: z.string().optional().describe('date ISO : ne garder que les messages antérieurs'),
  non_lus: z.boolean().optional(),
  lus: z.boolean().optional(),
  suivis: z.boolean().optional(),
  taille_min: z.number().optional().describe('taille minimale en octets'),
  uids: z.array(z.number()).optional().describe('UIDs précis — prioritaire sur tout le reste'),
}).describe('Critères IMAP. Vide = tous les messages du dossier.')

function rapportFile(id) {
  const q = loadQueue(id)
  const echecs = []
  for (const p of q.paires) {
    for (const it of p.items) {
      if (it.statut === 'echec') echecs.push({ dossier: p.de, uid: it.uid, sujet: it.sujet, raison: it.detail })
    }
  }
  return {
    ...resume(q),
    echecs: echecs.slice(0, 30),
    echecs_total: echecs.length,
    coffre: q.type === 'copie' ? null : P.vault(q.id),
    note: echecs.length
      ? "Les messages en échec sont restés intacts à la source. Copie brute conservée dans le coffre."
      : 'Chaque message a été vu à destination avant d\'être retiré de la source.',
  }
}

// ------------------------------------------------------------------ lecture

const lecture = [
  tool('lister_comptes', 'Les boîtes mail configurées (nom, adresse, serveurs). Aucun mot de passe.', {}, sur(async () => ({
    comptes: publicAccounts(),
  }))),

  tool('lister_dossiers', "L'arborescence des dossiers d'une boîte, avec le nombre de messages et de non-lus.", {
    compte: z.string().describe('nom, adresse ou identifiant de la boîte'),
    compter: z.boolean().optional().describe('false pour aller plus vite sur une boîte à 300 dossiers'),
  }, sur(async ({ compte, compter }) => {
    const acc = resolveAccount(compte)
    return { compte: acc.nom, dossiers: await listFolders(acc, { compter: compter !== false }) }
  })),

  tool('chercher_messages', 'Cherche des messages dans un dossier et renvoie leurs UID, expéditeur, sujet, date et taille.', {
    compte: z.string(),
    dossier: z.string().describe('chemin IMAP exact, ex : « INBOX » ou « Dupond/2019 »'),
    criteres: CRITERES.optional(),
    limite: z.number().optional().describe('nombre de messages détaillés (défaut 50, max 500) — le total, lui, est toujours exact'),
  }, sur(async ({ compte, dossier, criteres, limite }) =>
    searchMessages(resolveAccount(compte), dossier, criteres || {}, { limite: limite || 50 }))),

  tool('lire_message', "Le contenu d'un message : en-têtes, texte, pièces jointes. N'altère pas son état « lu ».", {
    compte: z.string(),
    dossier: z.string(),
    uid: z.number(),
    html: z.boolean().optional(),
  }, sur(async ({ compte, dossier, uid, html }) =>
    readMessage(resolveAccount(compte), dossier, uid, { html: !!html }))),

  tool('expediteurs', 'Qui écrit le plus dans ce dossier : classement par expéditeur, avec volume et date du dernier message.', {
    compte: z.string(),
    dossier: z.string(),
    criteres: CRITERES.optional(),
    limite: z.number().optional(),
  }, sur(async ({ compte, dossier, criteres, limite }) =>
    senders(resolveAccount(compte), dossier, criteres || {}, { limite: limite || 40 }))),

  tool('abonnements', "L'inventaire des newsletters d'un dossier : une ligne par liste, le nombre de messages reçus et la façon de s'en désabonner.", {
    compte: z.string(),
    dossier: z.string().optional().describe('défaut : INBOX'),
    criteres: CRITERES.optional(),
    limite: z.number().optional(),
  }, sur(async ({ compte, dossier, criteres, limite }) =>
    newsletters(resolveAccount(compte), dossier || 'INBOX', criteres || {}, { limite: limite || 100 }))),

  tool('apercu_dossier', "Ce que contient une branche avant de la déplacer : le dossier, ses sous-dossiers, et le nombre de messages de chacun.", {
    compte: z.string(),
    dossier: z.string(),
  }, sur(async ({ compte, dossier }) => {
    const acc = resolveAccount(compte)
    return withImap(acc, async (client) => {
      const { dossiers, separateur } = await brancheDossiers(client, dossier)
      const detail = []
      let total = 0
      for (const d of dossiers) {
        const st = await client.status(d, { messages: true, unseen: true })
        total += st.messages || 0
        detail.push({ chemin: d, messages: st.messages || 0, non_lus: st.unseen || 0 })
      }
      return { compte: acc.nom, racine: dossier, separateur, dossiers: detail, messages_total: total }
    })
  })),

  tool('etat_traitements', "L'état des files de déplacement : en cours, terminées, interrompues, avec leurs échecs.", {
    id: z.string().optional().describe('identifiant d\'une file précise ; sinon les 20 dernières'),
  }, sur(async ({ id }) => (id ? rapportFile(id) : { traitements: listQueues({ limite: 20 }) }))),
]

// ------------------------------------------------------- écriture / dossiers

const dossiers = [
  tool('creer_dossier', 'Crée un dossier IMAP (et ses parents manquants).', {
    compte: z.string(),
    chemin: z.string().describe('chemin complet, ex : « Archives/Dupond/2019 »'),
  }, sur(async ({ compte, chemin }) => {
    const acc = resolveAccount(compte)
    return { compte: acc.nom, ...(await createFolder(acc, chemin)) }
  })),

  tool('renommer_dossier', 'Renomme ou déplace un dossier à l\'intérieur de la même boîte. Les sous-dossiers suivent.', {
    compte: z.string(),
    avant: z.string(),
    apres: z.string(),
  }, sur(async ({ compte, avant, apres }) => {
    const acc = resolveAccount(compte)
    return { compte: acc.nom, ...(await renameFolder(acc, avant, apres)) }
  })),

  tool('supprimer_dossier', "Supprime un dossier vide. Refuse s'il contient des messages ou des sous-dossiers.", {
    compte: z.string(),
    chemin: z.string(),
    vraiment_vider: z.boolean().optional().describe('assume la perte des messages restants — à ne poser que si l\'utilisateur l\'a dit explicitement'),
  }, sur(async ({ compte, chemin, vraiment_vider }) => {
    const acc = resolveAccount(compte)
    return { compte: acc.nom, ...(await deleteFolder(acc, chemin, { vraimentVider: !!vraiment_vider })) }
  })),
]

// ------------------------------------------------------- écriture / messages

const traitements = [
  tool('deplacer_messages',
    'Déplace (ou copie) des messages d\'un dossier vers un autre, y compris entre deux boîtes différentes. ' +
    'Chaque message est copié sur le disque, déposé à destination, relu à destination, et seulement ensuite retiré de la source.', {
    compte_source: z.string(),
    dossier_source: z.string(),
    compte_cible: z.string().optional().describe('défaut : la même boîte que la source'),
    dossier_cible: z.string(),
    criteres: CRITERES.optional(),
    copier: z.boolean().optional().describe('true = copier sans rien retirer de la source'),
  }, sur(async ({ compte_source, dossier_source, compte_cible, dossier_cible, criteres, copier }) => {
    const accSource = resolveAccount(compte_source)
    const accCible = compte_cible ? resolveAccount(compte_cible) : accSource
    const q = await fileDeplacementMessages({
      accSource, dossierSource: dossier_source, accCible, dossierCible: dossier_cible,
      criteres: criteres || {}, type: copier ? 'copie' : 'deplacement',
    })
    await executerFile(q)
    return rapportFile(q.id)
  })),

  tool('deplacer_dossier',
    'Déplace (ou copie) une branche entière — un dossier et tous ses sous-dossiers — vers une autre boîte. ' +
    'L\'arborescence est recréée à destination, puis les messages passent un par un avec vérification.', {
    compte_source: z.string(),
    dossier: z.string().describe('racine de la branche à déplacer'),
    compte_cible: z.string(),
    dossier_cible: z.string().describe('chemin de la branche à destination'),
    copier: z.boolean().optional(),
  }, sur(async ({ compte_source, dossier, compte_cible, dossier_cible, copier }) => {
    const accSource = resolveAccount(compte_source)
    const accCible = resolveAccount(compte_cible)
    const q = await fileDeplacementDossier({
      accSource, racine: dossier, accCible, cible: dossier_cible, type: copier ? 'copie' : 'deplacement',
    })
    await executerFile(q)
    return rapportFile(q.id)
  })),

  tool('supprimer_messages',
    'Envoie des messages à la corbeille (défaut) ou les efface définitivement. ' +
    'Dans les deux cas une copie brute est écrite sur le disque avant tout retrait.', {
    compte: z.string(),
    dossier: z.string(),
    criteres: CRITERES.optional(),
    definitif: z.boolean().optional().describe('true = effacement irréversible ; ne le poser que si l\'utilisateur a dit « définitivement »'),
  }, sur(async ({ compte, dossier, criteres, definitif }) => {
    const acc = resolveAccount(compte)
    const q = await fileSuppressionMessages({ acc, dossier, criteres: criteres || {}, definitif: !!definitif })
    await executerFile(q)
    return rapportFile(q.id)
  })),

  tool('reprendre_traitement', 'Reprend une file interrompue là où elle s\'était arrêtée.', {
    id: z.string(),
  }, sur(async ({ id }) => {
    await reprendreFile(id)
    return rapportFile(id)
  })),

  tool('marquer_messages', 'Marque des messages comme lus / non lus / suivis.', {
    compte: z.string(),
    dossier: z.string(),
    uids: z.array(z.number()),
    lu: z.boolean().optional(),
    suivi: z.boolean().optional(),
  }, sur(async ({ compte, dossier, uids, lu, suivi }) =>
    markMessages(resolveAccount(compte), dossier, uids, { lu, suivi }))),
]

// ------------------------------------------------------ abonnements / envoi

const communication = [
  tool('methodes_desabonnement', "Ce qu'un message précis propose pour se désabonner (lecture seule).", {
    compte: z.string(),
    dossier: z.string(),
    uid: z.number(),
  }, sur(async ({ compte, dossier, uid }) => unsubscribeInfo(resolveAccount(compte), dossier, uid))),

  tool('desabonner',
    "Exécute un désabonnement : POST « un clic » (RFC 8058) ou e-mail depuis la boîte concernée. " +
    "Un lien http simple n'est jamais ouvert automatiquement : l'outil le renvoie pour ouverture manuelle.", {
    compte: z.string(),
    type: z.enum(['http_un_clic', 'mailto', 'http']),
    cible: z.string().describe("l'URL ou le mailto: renvoyé par methodes_desabonnement / abonnements"),
    liste: z.string().optional().describe('nom de la liste, pour le compte rendu'),
  }, sur(async ({ compte, type, cible, liste }) => {
    const acc = resolveAccount(compte)
    return { liste: liste || null, compte: acc.nom, ...(await unsubscribe(acc, { type, cible })) }
  })),

  tool('envoyer_message', 'Envoie un e-mail en SMTP depuis une des boîtes configurées.', {
    compte: z.string(),
    a: z.string(),
    copie: z.string().optional(),
    sujet: z.string(),
    texte: z.string(),
    repondre_a: z.string().optional().describe('Message-ID auquel ce message répond'),
  }, sur(async ({ compte, a, copie, sujet, texte, repondre_a }) =>
    sendMessage(resolveAccount(compte), { a, copie, sujet, texte, repondreA: repondre_a }))),
]

export function serveurMail() {
  return createSdkMcpServer({
    name: 'mailzen',
    version: '2.0.0',
    instructions:
      'Outils IMAP/SMTP des boîtes mail de Nicolas. Les chemins de dossiers sont ceux du serveur, ' +
      'obtenus par lister_dossiers — ne les invente jamais. Tout déplacement passe par une file vérifiée message par message.',
    tools: [...lecture, ...dossiers, ...traitements, ...communication],
  })
}
