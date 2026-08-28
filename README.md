# Assistant MailZen

Une petite app macOS qui ouvre un assistant conversationnel — un agent Claude Code
déguisé en fenêtre — branché en **IMAP et SMTP** sur tes vraies boîtes mail.

C'est « Claude Code lancé dans un dossier », mais le dossier c'est ton courrier :
mêmes capacités (Bash, fichiers, web), plus une vingtaine d'outils qui parlent aux
serveurs de messagerie. Tu dialogues, il exécute.

> Range le dossier Dupond par année · Combien j'ai d'abonnements newsletters ? ·
> Supprime les alertes Indeed de ma boîte de réception · Déplace tout l'historique
> de Perso vers Pro dans Archives/Dupond

## Installation

```bash
npm install
npm run install-app      # construit l'app, l'installe dans /Applications, l'épingle au Dock
```

Un clic l'ouvre, la croix la masque (elle reste dans le Dock), `⌘Q` la quitte.

| Raccourci | Effet |
|---|---|
| `↩` | envoyer |
| `⇧↩` | nouvelle ligne |
| `esc` | refuser la carte en attente, sinon interrompre l'agent |
| `⌘.` | interrompre l'agent |
| `⌘N` | nouvelle conversation |

À l'ouverture, l'assistant **reprend la conversation précédente**. Le bouton `+` repart de zéro.

## Ajouter une boîte

Réglages ⚙ → adresse + mot de passe → **Détecter et connecter**. L'app cherche les
serveurs (fournisseurs connus, base Thunderbird, suppositions), **teste réellement la
connexion**, puis enregistre. Les réglages manuels restent accessibles si la détection échoue.

- Gmail, Yahoo et iCloud exigent un **mot de passe d'application**, pas le mot de passe du compte.
- Les mots de passe sont chiffrés en AES-256-GCM dans le dossier de données, avec une clé
  en `0600`. **Ils ne transitent jamais par la conversation** : l'assistant ne voit que des
  noms de boîtes. S'il en manque une, il te le dit et s'arrête — il ne demande pas de mot de passe.
- Retirer une boîte de l'app ne touche pas au serveur : aucun message n'est supprimé.

## Les garanties sur tes boîtes de prod

Tout déplacement passe par une **file d'attente journalisée**, traitée **message par message** —
jamais en lot. Pour chaque message :

1. le message brut est écrit sur ton disque (le **coffre**) ;
2. il est déposé à destination — `APPEND` entre deux boîtes, `MOVE` serveur dans la même ;
3. il est **relu à destination**, par son UID puis par son `Message-ID` ;
4. **seulement alors** il quitte la source, un UID à la fois ;
5. le journal est réécrit sur disque.

Ce qui en découle, et qui est vérifié par `npm test` (35 assertions contre un serveur IMAP simulé) :

- un message qui n'arrive pas à destination **reste intact à la source**, et le traitement
  continue sur le suivant ;
- une coupure au message 412 sur 900 se **reprend** là où elle s'est arrêtée, sans doublon ;
- « supprimer » veut dire **mettre à la corbeille**. L'effacement définitif exige un mot
  explicite *et* une liste d'UID que l'assistant t'a montrée ;
- sur un serveur sans `UID EXPUNGE`, si le dossier contient déjà des messages marqués
  « supprimé », le traitement est **refusé** plutôt que de risquer de les purger ;
- un dossier qui contient encore des messages ne se supprime pas sans que tu l'aies dit.

Journaux et copies brutes : menu **Conversation → Ouvrir le coffre et les journaux**.

## Parler pendant qu'il travaille

Le champ de saisie n'est **jamais bloqué**. Un message écrit pendant qu'il travaille rejoint
sa file d'entrée : le SDK le lui remet à la respiration suivante et il **refait son plan
avec** — comme dans Claude Code. Le message s'affiche estompé, marqué *pris en compte à la
prochaine étape*, jusqu'à ce qu'il reprenne la parole.

Tu peux donc lui demander deux choses coup sur coup, ou changer d'avis en cours de route.
Le bouton reste un bouton d'envoi tant qu'il y a du texte ; il n'arrête l'agent que sur un
champ vide (ou `esc`).

Un traitement long ne monopolise plus la conversation : au bout de **15 secondes**, l'outil
rend la main et le déplacement **continue en arrière-plan**. Une carte affiche sa
progression, avec un bouton *Arrêter* (le travail déjà fait est conservé, la file reste
reprenable). Quand il a fini, l'assistant l'annonce de lui-même.

## Ce qui demande une validation, et ce qui n'en demande pas

Ce que tu demandes s'exécute. On ne t'interrompt que pour ce qui le mérite, et la décision
est prise **après** la préparation de la file — la carte annonce donc un chiffre exact, pas
une estimation sur critères.

| Action | Validation |
|---|---|
| Lire, chercher, inventorier | jamais |
| Créer / renommer un dossier, marquer des messages | jamais |
| Déplacer, mettre à la corbeille | au-delà du seuil réglé (défaut : 50 messages) |
| Effacer définitivement | **toujours** |
| Supprimer un dossier avec son contenu | **toujours** |
| Envoyer un e-mail, se désabonner par `mailto` | **toujours** (ça sort de la machine) |

Le seuil se règle dans ⚙ : *chaque action*, 10, 50, 200, ou *jamais*. Même sur *jamais*,
les trois lignes en gras restent validées.

Les cartes disent en clair ce qui va se passer — boîte, dossier, sélection, destination —
et non le JSON de l'outil ; le détail technique reste à un clic. Elles **n'ont pas de bouton
« Toujours »**. Au clavier : `↩` autorise, `esc` refuse — `↩` ne valide que si le champ de
saisie est vide, sinon la phrase en cours part comme message.

L'assistant, lui, a pour consigne de ne **jamais** redemander dans la conversation une
confirmation que tu viens de donner. Il ne s'arrête que s'il voit un vrai problème : un
critère qui ramène cent fois plus que prévu, une ambiguïté sur le dossier visé.

## Les garde-fous côté agent

Le prompt (`src/agent/prompt.mjs`) dit à l'assistant de regarder avant d'agir. Les hooks
`PreToolUse` (`src/agent/gardes.mjs`) le lui **imposent**, parce que le prompt seul ne suffit pas :

- un chemin de dossier qui n'a pas été vu dans `lister_dossiers` est **refusé** (fini les
  dossiers fantômes créés sur une faute de casse) ;
- déplacer une branche entière exige d'avoir appelé `apercu_dossier` d'abord — donc d'avoir
  annoncé combien de dossiers et de messages vont bouger ;
- une suppression sans aucun critère est refusée ; une suppression définitive sur critères
  larges aussi ;
- une destination à l'intérieur de la branche déplacée est refusée.

## Architecture

```
src/main.mjs            processus Electron : fenêtre, IPC, comptes, permissions
src/preload.cjs         pont contextIsolation (aucun accès Node côté page)
src/agent/session.mjs   session Claude Agent SDK : options, routage, permissions
src/agent/prompt.mjs    personnalité et règles (PROMPT_VERSION à incrémenter si elles changent)
src/agent/gardes.mjs    hooks PreToolUse : ce que le prompt ne peut pas garantir
src/agent/outils.mjs    serveur MCP interne : les outils mail et leur politique de validation
src/agent/resume.mjs    description des critères, cartes des outils système
src/mail/transfert.mjs  le moteur : file, vérification, coffre, reprise
src/mail/file.mjs       le journal d'un traitement, réécrit après chaque message
src/mail/imap.mjs       connexions IMAP/SMTP, plafond par compte
src/mail/messages.mjs   recherche, lecture, expéditeurs, abonnements (lecture seule)
src/mail/dossiers.mjs   arborescence : lister, créer, renommer, supprimer
src/mail/actions.mjs    drapeaux, désabonnement, envoi
src/mail/accounts.mjs   les comptes, mots de passe chiffrés
src/renderer/           l'interface (chat, cartes, réglages, progression)
scripts/test-transfert.mjs  le contrat du moteur, contre un serveur simulé
scripts/test-politique.mjs  le contrat des validations : pas de double confirmation
```

Données : `~/Library/Application Support/Assistant MailZen/`
(`comptes.json`, `cle-secrete`, `files/`, `coffre/`, `Espace de travail/`).

## Développement

```bash
npm start        # lance l'app sans l'installer
npm test         # moteur de transfert (serveur simulé) + politique de validation
npm run selftest # démarre une vraie session agent, sans rien modifier
npm run build    # construit le .app dans build/
```
