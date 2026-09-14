# Assistant Mail

Une petite app macOS qui ouvre un assistant conversationnel branché en **IMAP et SMTP**
sur tes vraies boîtes mail, et mû par un **modèle qui tourne chez toi**.

Rien ne sort de la maison : ni le contenu de tes messages, ni ce que tu écris dans la
conversation. L'app parle à un serveur **OpenAI-compatible** de ton réseau local
(LM Studio, llama.cpp, Ollama…) et n'appelle aucune API distante.

Une vingtaine d'outils parlent aux serveurs de messagerie, plus `Bash`, `Read` et `Write`
sur ta machine. Tu dialogues, il exécute.

> Range le dossier Dupond par année · Combien j'ai d'abonnements newsletters ? ·
> Supprime les alertes Indeed de ma boîte de réception · Déplace tout l'historique
> de Perso vers Pro dans Archives/Dupond

## Le moteur : ton serveur d'IA local

L'app attend un serveur OpenAI-compatible à une adresse que tu règles dans ⚙ (défaut :
`http://localhost:1234/v1`). Elle interroge `/v1/models` pour remplir la liste des
modèles, et n'utilise que ceux que ce serveur a réellement chargés. Si le serveur ne
répond pas, elle le dit puis **retente toute seule toutes les 15 secondes** : allumer le
serveur suffit à repartir, sans relancer l'app.

> **macOS : l'autorisation « Réseau local ».** Quand le serveur tourne sur une autre
> machine, macOS bloque la connexion tant que l'app n'est pas autorisée — et, vu de
> l'app, ça ressemble trait pour trait à un serveur éteint. Réglages Système →
> Confidentialité et sécurité → **Réseau local** → activer « Assistant Mail ». La
> signature étant ad hoc, l'autorisation est à redonner **après chaque réinstallation**.
> Un serveur en `127.0.0.1` n'est pas concerné.

Deux exigences sur le modèle :

- **il doit savoir appeler des outils** (`tool_use`). Sans ça, l'assistant peut discuter
  mais ne touchera pas à une seule boîte ;
- **sa fenêtre de contexte doit être large** : les consignes et les schémas des 23 outils
  pèsent **~5 000 jetons** avant le premier mot de la conversation. Charge le modèle avec
  **32 000 jetons** (16 000 est le minimum vivable). En dessous, ça peut passer sur une
  question isolée et casser à la deuxième : le serveur répond « context size has been
  exceeded », l'app le dit en clair, retente une fois en ne rappelant que la fin de la
  conversation, puis renonce.

> Attention aux réglages qui rognent la fenêtre sans le dire. Sur la machine de test, LM
> Studio annonçait 16 384 jetons chargés alors que le serveur refusait tout au-delà de
> ~4 500 — la **génération spéculative** était active, et c'est le contexte du *modèle
> brouillon* qui faisait plafond. L'app n'envoie d'ailleurs jamais de `max_tokens` : un
> serveur local réserve la place demandée dans la fenêtre, et une valeur généreuse la
> remplit à elle seule.

Un tour de modèle local prend des dizaines de secondes : c'est normal, et la conversation
reste utilisable pendant ce temps.

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
sa file d'entrée : il lui est remis dès que ses outils en cours ont rendu leur résultat, et
il **refait son plan avec**. Le message s'affiche estompé, marqué *pris en compte à la
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

Le prompt (`src/agent/prompt.mjs`) dit à l'assistant de regarder avant d'agir. Les garde-fous
(`src/agent/gardes.mjs`), vérifiés avant chaque appel d'outil, le lui **imposent** — un petit
modèle local suit moins bien les consignes qu'un gros modèle distant, et le prompt seul ne
suffit de toute façon jamais :

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
src/agent/session.mjs   la boucle : modèle → outils → résultat, permissions, compaction
src/agent/llm.mjs       le client du serveur local (flux SSE, appels d'outils, raisonnement)
src/agent/outillage.mjs déclarer un outil, le décrire en JSON Schema, réparer ses arguments
src/agent/systeme.mjs   les outils machine : Bash, Read, Write
src/agent/memoire.mjs   la conversation sur le disque, reprise au démarrage
src/agent/prompt.mjs    personnalité et règles (PROMPT_VERSION à incrémenter si elles changent)
src/agent/gardes.mjs    vérifications avant appel : ce que le prompt ne peut pas garantir
src/agent/outils.mjs    les outils mail et leur politique de validation
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

Données : `~/Library/Application Support/Assistant Mail/`
(`comptes.json`, `cle-secrete`, `conversation.json`, `files/`, `coffre/`, `Espace de travail/`).

L'app s'appelait « Assistant MailZen » jusqu'à la 3.0, et le dossier de données porte son nom :
au premier démarrage, comptes, clé de chiffrement, journaux, coffre et espace de travail sont
**repris automatiquement** depuis l'ancien dossier, une seule fois, sans jamais écraser.

## Développement

```bash
npm start        # lance l'app sans l'installer
npm test         # moteur de transfert (serveur simulé) + politique de validation
npm run selftest # démarre une vraie session contre ton serveur local, sans rien modifier
                 # (accepte une autre adresse : node scripts/selftest.mjs http://hote:1234/v1)
npm run build    # construit le .app dans build/
```
