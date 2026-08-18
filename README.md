# 📬 MailZen

Client web multi-comptes IMAP/SMTP avec assistant local Ollama, déplacements de dossiers sécurisés
entre boîtes mail, suivi des traitements et sauvegarde/restauration.

## Démarrage

```bash
cp .env.example .env      # renseignez APP_SECRET (et APP_PASSWORD si vous voulez protéger l'accès)
docker compose up -d --build
```

Interface : http://localhost:3016

Les données (base SQLite, messages bruts `.eml`, sauvegardes) vivent dans le volume `mailzen-data`.

## Fonctions

- **Comptes** : connexion IMAP + SMTP, test de connexion, mots de passe chiffrés AES-256-GCM.
- **Messages** : client mail classique (dossiers, liste, lecture HTML, lu/non lu, suivi, réponse SMTP).
- **Dossiers** : création, renommage, suppression (refusée si le dossier n'est pas vide, sauf confirmation).
- **Transferts sécurisés** : déplacement dossier→dossier, y compris entre deux boîtes différentes.
  Chaque message est copié, **vérifié à destination** (UID renvoyé par le serveur ou recherche par
  `Message-ID`), une copie brute locale est conservée, et la suppression à la source n'intervient
  qu'après confirmation. Un message non confirmé n'est jamais supprimé.
- **Traitements** : page temps réel (SSE) avec avancement, journal, éléments un par un, arrêt propre.
  Les traitements interrompus par un redémarrage sont repris automatiquement.
- **Assistant** : chatbot branché sur Ollama en local. `@` ouvre la sélection de dossier (Entrée valide
  la première suggestion). L'agent analyse le dossier et propose un plan de rangement ; rien n'est
  appliqué avant votre acceptation explicite. L'exécution utilise `MOVE` IMAP (atomique, sans perte).
- **Sauvegardes** : export complet des messages bruts + manifeste, restauration/rollback dans les
  dossiers d'origine ou dans un dossier isolé, sans créer de doublon.

## Ollama

Par défaut l'application interroge `http://host.docker.internal:11434` avec le modèle `llama3.1`.
Adaptez `OLLAMA_URL` / `OLLAMA_MODEL` dans `.env`, puis installez le modèle : `ollama pull llama3.1`.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `APP_SECRET` | clé de chiffrement des mots de passe (à ne pas perdre) |
| `APP_PASSWORD` | mot de passe d'accès à l'interface (vide = pas d'authentification) |
| `OLLAMA_URL` / `OLLAMA_MODEL` | serveur et modèle Ollama |
| `MAX_MESSAGES_PER_FOLDER` | limite de messages téléchargés par dossier (0 = illimité) |
| `DATA_DIR` | répertoire de stockage |
