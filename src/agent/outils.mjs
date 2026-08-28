// Les outils que l'assistant a sous la main : un serveur MCP interne au processus.
//
// C'est ici que se décide ce qui demande une validation. Le principe : ce que
// Nicolas vient de demander s'exécute. On ne l'interrompt que pour ce qui est
// irréversible, ce qui sort de la machine, ou ce qui dépasse le volume qu'il a
// fixé dans les réglages. Et comme la décision est prise APRÈS la préparation de
// la file, la carte annonce un chiffre exact — pas une estimation sur critères.
import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { publicAccounts, resolveAccount } from '../mail/accounts.mjs'
import { listFolders, createFolder, renameFolder, deleteFolder } from '../mail/dossiers.mjs'
import { searchMessages, readMessage, senders, newsletters } from '../mail/messages.mjs'
import { markMessages, unsubscribeInfo, unsubscribe, sendMessage } from '../mail/actions.mjs'
import { withImap } from '../mail/imap.mjs'
import {
  fileDeplacementMessages, fileSuppressionMessages, fileDeplacementDossier,
  lancerFile, arreterFile, filesEnCours, annulerFile, reprendreFile, brancheDossiers,
} from '../mail/transfert.mjs'
import { loadQueue, listQueues, resume, totalItems } from '../mail/file.mjs'
import { decrireCriteres } from './resume.mjs'
import { emitDone } from '../mail/evenements.mjs'
import { P } from '../mail/paths.mjs'

/** Au-delà, l'outil rend la main et le traitement continue en arrière-plan. */
const DELAI_AVANT_DETACHEMENT = 15000

const texte = (data) => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] })
const erreur = (m) => ({ content: [{ type: 'text', text: `ERREUR : ${m}` }], isError: true })

class Refus extends Error {}

/** Enveloppe commune : une erreur IMAP revient au modèle en clair, jamais en exception. */
const sur = (fn) => async (args, extra) => {
  try {
    return texte(await fn(args, extra))
  } catch (err) {
    if (err instanceof Refus) {
      return texte({ execute: false, refuse: true, message: err.message })
    }
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

const pluriel = (n, un, plusieurs) => (n > 1 ? `${n} ${plusieurs}` : `${n} ${un}`)

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
      ? 'Les messages en échec sont restés intacts à la source. Copie brute conservée dans le coffre.'
      : "Chaque message a été vu à destination avant d'être retiré de la source.",
  }
}

export function serveurMail(contexte = {}) {
  const confirmer = contexte.confirmer || (async () => true)
  const seuil = contexte.seuil || (() => 50)

  /** Demande une validation à Nicolas. Lève si elle est refusée. */
  async function valider(demande) {
    const ok = await confirmer(demande)
    if (!ok) throw new Refus(demande.refus || 'Refusé par Nicolas — rien n\'a été fait.')
  }

  /**
   * Lance la file. Si elle est courte, on rend le compte rendu complet ;
   * sinon on rend la main pour que la conversation reste vivante.
   */
  async function lancer(q) {
    const course = lancerFile(q)
    const attente = new Promise((r) => setTimeout(() => r('encours'), DELAI_AVANT_DETACHEMENT))
    const issue = await Promise.race([course.then(() => 'fini'), attente])
    if (issue === 'fini') return rapportFile(q.id)
    // Détaché : c'est nous, et nous seuls, qui annoncerons la fin.
    course.then(() => emitDone(rapportFile(q.id))).catch(() => {})
    return {
      ...resume(loadQueue(q.id)),
      en_arriere_plan: true,
      note: 'Le traitement continue en arrière-plan. Ne le surveille pas en boucle : tu seras prévenu à la fin. ' +
        'Dis-le à Nicolas et reste disponible — il peut te demander autre chose entre-temps.',
    }
  }

  // ---------------------------------------------------------------- lecture

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

    tool('apercu_dossier', 'Ce que contient une branche avant de la déplacer : le dossier, ses sous-dossiers, et le nombre de messages de chacun.', {
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
      id: z.string().optional().describe("identifiant d'une file précise ; sinon les 20 dernières"),
    }, sur(async ({ id }) => (id
      ? rapportFile(id)
      : { en_cours: filesEnCours(), historique: listQueues({ limite: 20 }) }))),

    tool('methodes_desabonnement', "Ce qu'un message précis propose pour se désabonner (lecture seule).", {
      compte: z.string(),
      dossier: z.string(),
      uid: z.number(),
    }, sur(async ({ compte, dossier, uid }) => unsubscribeInfo(resolveAccount(compte), dossier, uid))),
  ]

  // ------------------------------------------------------ écriture / dossiers

  const dossiers = [
    tool('creer_dossier', 'Crée un dossier IMAP (et ses parents manquants).', {
      compte: z.string(),
      chemin: z.string().describe('chemin complet, ex : « Archives/Dupond/2019 »'),
    }, sur(async ({ compte, chemin }) => {
      const acc = resolveAccount(compte)
      return { compte: acc.nom, ...(await createFolder(acc, chemin)) }
    })),

    tool('renommer_dossier', "Renomme ou déplace un dossier à l'intérieur de la même boîte. Les sous-dossiers suivent.", {
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
      vraiment_vider: z.boolean().optional().describe("assume la perte des messages restants — à ne poser que si Nicolas l'a dit explicitement"),
    }, sur(async ({ compte, chemin, vraiment_vider }) => {
      const acc = resolveAccount(compte)
      if (vraiment_vider) {
        const st = await withImap(acc, (client) => client.status(chemin, { messages: true }))
        await valider({
          outil: 'supprimer_dossier',
          entree: { compte, chemin, vraiment_vider },
          titre: `Supprimer « ${chemin} » AVEC son contenu ?`,
          lignes: [
            `${acc.nom} · ${chemin}`,
            `${pluriel(st.messages || 0, 'message perdu', 'messages perdus')}, sans copie de sauvegarde.`,
            'Irréversible côté serveur.',
          ],
          danger: true,
        })
      }
      return { compte: acc.nom, ...(await deleteFolder(acc, chemin, { vraimentVider: !!vraiment_vider })) }
    })),
  ]

  // ------------------------------------------------------ écriture / messages

  const traitements = [
    tool('deplacer_messages',
      "Déplace (ou copie) des messages d'un dossier vers un autre, y compris entre deux boîtes différentes. " +
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
      const nombre = totalItems(q)
      if (nombre > seuil()) {
        try {
          await valider({
            outil: 'deplacer_messages',
            entree: { compte_source, dossier_source, compte_cible, dossier_cible, criteres, copier },
            titre: `${copier ? 'Copier' : 'Déplacer'} ${pluriel(nombre, 'message', 'messages')} ?`,
            lignes: [
              `${accSource.nom} · ${dossier_source}\n→ ${accCible.nom} · ${dossier_cible}`,
              `Sélection : ${decrireCriteres(criteres)}`,
              copier ? 'Copie seule : rien ne quitte la source.'
                : "Chaque message est relu à destination avant d'être retiré de la source.",
            ],
          })
        } catch (err) {
          annulerFile(q, 'Validation refusée.')
          throw err
        }
      }
      return lancer(q)
    })),

    tool('deplacer_dossier',
      'Déplace (ou copie) une branche entière — un dossier et tous ses sous-dossiers — vers une autre boîte. ' +
      "L'arborescence est recréée à destination, puis les messages passent un par un avec vérification.", {
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
      const nombre = totalItems(q)
      if (nombre > seuil()) {
        try {
          await valider({
            outil: 'deplacer_dossier',
            entree: { compte_source, dossier, compte_cible, dossier_cible, copier },
            titre: `${copier ? 'Copier' : 'Déplacer'} une branche de ${pluriel(nombre, 'message', 'messages')} ?`,
            lignes: [
              `${accSource.nom} · ${dossier}\n→ ${accCible.nom} · ${dossier_cible}`,
              `${pluriel(q.paires.length, 'dossier recréé', 'dossiers recréés')} à destination : ${q.paires.map((p) => p.vers).slice(0, 6).join(', ')}${q.paires.length > 6 ? '…' : ''}`,
              copier ? "Copie seule : la branche d'origine reste en place."
                : "La branche d'origine sera vidée, message par message, après vérification.",
            ],
          })
        } catch (err) {
          annulerFile(q, 'Validation refusée.')
          throw err
        }
      }
      return lancer(q)
    })),

    tool('supprimer_messages',
      'Envoie des messages à la corbeille (défaut) ou les efface définitivement. ' +
      'Dans les deux cas une copie brute est écrite sur le disque avant tout retrait.', {
      compte: z.string(),
      dossier: z.string(),
      criteres: CRITERES.optional(),
      definitif: z.boolean().optional().describe('true = effacement irréversible ; ne le poser que si Nicolas a dit « définitivement »'),
    }, sur(async ({ compte, dossier, criteres, definitif }) => {
      const acc = resolveAccount(compte)
      const q = await fileSuppressionMessages({ acc, dossier, criteres: criteres || {}, definitif: !!definitif })
      const nombre = totalItems(q)
      // L'effacement définitif se valide toujours : c'est la seule action sans retour.
      if (definitif || nombre > seuil()) {
        try {
          await valider({
            outil: 'supprimer_messages',
            entree: { compte, dossier, criteres, definitif },
            titre: definitif
              ? `Effacer définitivement ${pluriel(nombre, 'message', 'messages')} ?`
              : `Mettre ${pluriel(nombre, 'message', 'messages')} à la corbeille ?`,
            lignes: [
              `${acc.nom} · ${dossier}`,
              `Sélection : ${decrireCriteres(criteres)}`,
              definitif
                ? 'IRRÉVERSIBLE côté serveur. Une copie brute reste sur le disque, dans le coffre.'
                : "Récupérables tant que la corbeille n'est pas vidée.",
            ],
            danger: !!definitif,
          })
        } catch (err) {
          annulerFile(q, 'Validation refusée.')
          throw err
        }
      }
      return lancer(q)
    })),

    tool('reprendre_traitement', "Reprend une file interrompue là où elle s'était arrêtée.", {
      id: z.string(),
    }, sur(async ({ id }) => {
      const promesse = reprendreFile(id)
      const issue = await Promise.race([
        promesse.then(() => 'fini'),
        new Promise((r) => setTimeout(() => r('encours'), DELAI_AVANT_DETACHEMENT)),
      ])
      if (issue === 'fini') return rapportFile(id)
      promesse.then(() => emitDone(rapportFile(id))).catch(() => {})
      return { ...resume(loadQueue(id)), en_arriere_plan: true }
    })),

    tool('arreter_traitement', "Arrête proprement un traitement en cours. Le travail déjà fait est conservé et la file reste reprenable.", {
      id: z.string(),
    }, sur(async ({ id }) => arreterFile(id))),

    tool('marquer_messages', 'Marque des messages comme lus / non lus / suivis.', {
      compte: z.string(),
      dossier: z.string(),
      uids: z.array(z.number()),
      lu: z.boolean().optional(),
      suivi: z.boolean().optional(),
    }, sur(async ({ compte, dossier, uids, lu, suivi }) =>
      markMessages(resolveAccount(compte), dossier, uids, { lu, suivi }))),
  ]

  // ----------------------------------------------------- abonnements / envoi

  const communication = [
    tool('desabonner',
      "Exécute un désabonnement : POST « un clic » (RFC 8058) ou e-mail depuis la boîte concernée. " +
      "Un lien http simple n'est jamais ouvert automatiquement : l'outil le renvoie pour ouverture manuelle.", {
      compte: z.string(),
      type: z.enum(['http_un_clic', 'mailto', 'http']),
      cible: z.string().describe("l'URL ou le mailto: renvoyé par methodes_desabonnement / abonnements"),
      liste: z.string().optional().describe('nom de la liste, pour le compte rendu'),
    }, sur(async ({ compte, type, cible, liste }) => {
      const acc = resolveAccount(compte)
      // Un mailto part réellement de la boîte de Nicolas, en son nom : il le valide.
      if (type === 'mailto') {
        await valider({
          outil: 'desabonner',
          entree: { compte, type, cible, liste },
          titre: `Envoyer un e-mail de désabonnement à « ${liste || cible} » ?`,
          lignes: [`Depuis ${acc.nom} (${acc.email})`, String(cible)],
        })
      }
      return { liste: liste || null, compte: acc.nom, ...(await unsubscribe(acc, { type, cible })) }
    })),

    tool('envoyer_message', 'Envoie un e-mail en SMTP depuis une des boîtes configurées.', {
      compte: z.string(),
      a: z.string(),
      copie: z.string().optional(),
      sujet: z.string(),
      texte: z.string(),
      repondre_a: z.string().optional().describe('Message-ID auquel ce message répond'),
    }, sur(async ({ compte, a, copie, sujet, texte: corps, repondre_a }) => {
      const acc = resolveAccount(compte)
      // Un e-mail part vers quelqu'un d'autre et ne se rattrape pas : toujours validé.
      await valider({
        outil: 'envoyer_message',
        entree: { compte, a, copie, sujet, texte: corps },
        titre: 'Envoyer cet e-mail ?',
        lignes: [`De : ${acc.nom} (${acc.email})\nÀ : ${a}${copie ? `\nCopie : ${copie}` : ''}`, `Objet : ${sujet}`, String(corps || '').slice(0, 500)],
      })
      return sendMessage(acc, { a, copie, sujet, texte: corps, repondreA: repondre_a })
    })),
  ]

  return createSdkMcpServer({
    name: 'mailzen',
    version: '2.1.0',
    instructions:
      'Outils IMAP/SMTP des boîtes mail de Nicolas. Les chemins de dossiers sont ceux du serveur, ' +
      'obtenus par lister_dossiers — ne les invente jamais. Tout déplacement passe par une file vérifiée ' +
      "message par message. Les outils demandent eux-mêmes une validation à Nicolas quand c'est nécessaire : " +
      "ne la demande pas en plus dans la conversation, et si un outil répond « refuse », dis-le simplement.",
    tools: [...lecture, ...dossiers, ...traitements, ...communication],
  })
}
