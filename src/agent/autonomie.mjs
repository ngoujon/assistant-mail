// Ce que l'assistant fait sans demander. Nicolas veut qu'il travaille seul : on
// ne l'arrête que pour ce qui détruit, sort de la machine, touche au système ou
// aux secrets de l'app. Le reste — lire, chercher, écrire un compte rendu, lancer
// un `dig` ou un script dans son dossier de travail — passe directement.
//
// Ce n'est pas un bac à sable : Bash reste Bash. C'est un tri des commandes
// ordinaires, pour que les cartes de validation redeviennent rares et donc lues.
import os from 'node:os'
import path from 'node:path'

const HOME = os.homedir()

/** Le dossier où Claude Code garde les conversations et la mémoire de ce dossier de travail. */
function dossierProjet(workspace) {
  const racine = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')
  return path.join(racine, 'projects', path.resolve(workspace).replace(/[^a-zA-Z0-9]/g, '-'))
}

/** Là où il peut écrire librement : son dossier de travail, sa mémoire, et les dossiers de Nicolas. */
export function racinesLibres(workspace) {
  return [
    workspace,
    dossierProjet(workspace),
    path.join(HOME, 'Desktop'),
    path.join(HOME, 'Documents'),
    path.join(HOME, 'Downloads'),
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
  ].filter(Boolean).map((r) => path.resolve(r))
}

function chemin(p) {
  const s = String(p || '').trim().replace(/^["']|["']$/g, '')
  if (!s) return ''
  if (s === '~' || s.startsWith('~/')) return path.resolve(HOME, s.slice(2))
  return path.resolve(s)
}

function sous(p, racines) {
  const c = chemin(p)
  return !!c && racines.some((r) => c === r || c.startsWith(`${r}${path.sep}`))
}

/** Les secrets de l'app (mots de passe chiffrés et leur clé) et ceux du Mac. */
const SECRETS = /cle-secrete|comptes\.json|\.ssh\b|\.gnupg|keychain|Login Data|Cookies|\.aws\b|\.netrc|\bsecurity\s+find-/i

/** Commandes qui détruisent, installent, touchent au système ou parlent à une autre machine. */
const RISQUE = new RegExp('(^|[\\s;&|(`$])(' + [
  'sudo', 'su', 'doas', 'rm', 'rmdir', 'shred', 'srm', 'unlink', 'mv', 'dd', 'mkfs\\S*', 'diskutil', 'fdisk',
  'chmod', 'chown', 'chflags', 'xattr', 'kill', 'killall', 'pkill', 'launchctl', 'crontab',
  'shutdown', 'reboot', 'halt', 'osascript', 'security', 'ssh', 'scp', 'sftp', 'rsync', 'ftp',
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'pipx', 'brew', 'gem', 'cargo',
  'defaults', 'tccutil', 'csrutil', 'spctl', 'networksetup', 'systemsetup', 'scutil', 'pmset', 'nvram',
  'sendmail', 'mailx', 'docker', 'eval', 'exec', 'tee', 'truncate', 'ln',
].join('|') + ')(?=$|[\\s;&|)`])')

/** Envoi de données vers le web (formulaire, upload, POST…) : la lecture d'une page reste libre. */
const ENVOI_WEB = /\b(curl|wget|http|https)\b[^|;&]*\s(-d\b|--data\S*|-F\b|--form\b|-T\b|--upload-file|--post-\S+|-X\s*['"]?(POST|PUT|PATCH|DELETE)|--request\s+['"]?(POST|PUT|PATCH|DELETE)|--method)/i

/** Les fichiers vers lesquels une commande redirige sa sortie (`> f`, `>> f`). */
function ciblesRedirection(cmd) {
  const cibles = []
  const re = /(^|[^0-9&<>])>>?\s*(?!&)(("[^"]*"|'[^']*'|[^\s;&|()]+))/g
  let m
  while ((m = re.exec(cmd))) cibles.push(m[2])
  return cibles
}

/**
 * La commande Bash peut-elle passer sans carte de validation ?
 * @returns {boolean}
 */
export function bashSansRisque(commande, workspace) {
  const cmd = String(commande || '')
  if (!cmd.trim()) return false
  if (SECRETS.test(cmd)) return false
  if (RISQUE.test(cmd)) return false
  if (ENVOI_WEB.test(cmd)) return false
  const racines = racinesLibres(workspace)
  for (const c of ciblesRedirection(cmd)) {
    if (c === '/dev/null' || c === '/dev/stderr' || c === '/dev/stdout') continue
    // Chemin relatif : il tombe dans le dossier courant, c'est-à-dire le dossier de travail.
    const abs = c.startsWith('/') || c.startsWith('~') ? c : path.join(workspace, c.replace(/^["']|["']$/g, ''))
    if (!sous(abs, racines)) return false
  }
  return true
}

/** Le chemin désigne-t-il un secret (mots de passe de l'app, clés, trousseau) ? */
export function estSecret(p) {
  return SECRETS.test(String(p || ''))
}

/**
 * L'outil peut-il s'exécuter sans demander ? Les outils mail ne passent pas par
 * ici : ils décident eux-mêmes, en connaissant le volume réel.
 */
export function sansRisque(toolName, input, workspace) {
  const i = input || {}
  switch (toolName) {
    case 'Bash':
      return bashSansRisque(i.command, workspace)
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const p = i.file_path || i.notebook_path
      if (!p || SECRETS.test(String(p))) return false
      return sous(p, racinesLibres(workspace))
    }
    default:
      return false
  }
}
