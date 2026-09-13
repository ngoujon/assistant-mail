// Les outils « machine » : une commande shell, la lecture et l'écriture d'un
// fichier. C'est tout ce que l'assistant a en dehors du courrier — il n'y a
// plus d'outil web, puisque l'application ne sort plus sur Internet.
import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { tool } from './outillage.mjs'

const HOME = os.homedir()
const DELAI = 120000
const MAX_SORTIE = 200000

const PATH_SUP = [
  path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin',
  '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
]

const tronquer = (s, n) => {
  const t = String(s ?? '')
  return t.length > n ? `${t.slice(0, n)}\n…(${t.length - n} caractères coupés)` : t
}

/** Un chemin relatif part de l'espace de travail, pas du dossier de l'app. */
const absolu = (p, workspace) => (path.isAbsolute(p) ? p : path.resolve(workspace, p))

export function outilsSysteme({ workspace }) {
  return [
    tool('Bash', "Exécute une commande shell sur le Mac de Nicolas. Le dossier courant est l'espace de travail.", {
      command: z.string().describe('la commande, telle quelle'),
      description: z.string().optional().describe('ce que la commande fait, en cinq mots'),
    }, async ({ command }) => new Promise((resolve) => {
      exec(command, {
        cwd: workspace,
        timeout: DELAI,
        maxBuffer: MAX_SORTIE * 2,
        env: {
          ...process.env,
          PATH: [...new Set([...PATH_SUP, ...(process.env.PATH || '').split(':')])].filter(Boolean).join(':'),
        },
      }, (err, stdout, stderr) => {
        const bouts = []
        if (stdout) bouts.push(tronquer(stdout, MAX_SORTIE))
        if (stderr) bouts.push(`[erreur standard]\n${tronquer(stderr, 20000)}`)
        if (err && err.killed) bouts.push(`[interrompue après ${DELAI / 1000} s]`)
        else if (err) bouts.push(`[code de sortie ${err.code ?? 1}]`)
        resolve({ content: [{ type: 'text', text: bouts.join('\n') || '(aucune sortie)' }], isError: !!err })
      })
    })),

    tool('Read', "Lit un fichier texte du Mac.", {
      file_path: z.string().describe('chemin du fichier'),
      limit: z.number().optional().describe('nombre de lignes (défaut 400)'),
      offset: z.number().optional().describe('première ligne, à partir de 1'),
    }, async ({ file_path, limit, offset }) => {
      const f = absolu(file_path, workspace)
      try {
        const lignes = fs.readFileSync(f, 'utf8').split('\n')
        const debut = Math.max(0, (offset || 1) - 1)
        const tranche = lignes.slice(debut, debut + (limit || 400))
        const texte = tranche.map((l, i) => `${debut + i + 1}\t${l}`).join('\n')
        const reste = lignes.length - (debut + tranche.length)
        return { content: [{ type: 'text', text: tronquer(texte, MAX_SORTIE) + (reste > 0 ? `\n…(${reste} lignes de plus)` : '') }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `ERREUR : ${err.message}` }], isError: true }
      }
    }),

    tool('Write', "Écrit un fichier (le remplace s'il existe). Pour les inventaires et comptes rendus.", {
      file_path: z.string(),
      content: z.string(),
    }, async ({ file_path, content }) => {
      const f = absolu(file_path, workspace)
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(f, content)
        return { content: [{ type: 'text', text: `Écrit : ${f} (${content.length} caractères)` }] }
      } catch (err) {
        return { content: [{ type: 'text', text: `ERREUR : ${err.message}` }], isError: true }
      }
    }),
  ]
}

/** Ceux qui demandent une validation à Nicolas avant de s'exécuter. */
export const SYSTEME_A_VALIDER = new Set(['Bash', 'Write'])
