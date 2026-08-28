import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSystemPrompt } from './prompt.mjs'
import { GardeMail } from './gardes.mjs'
import { resumerPermission } from './resume.mjs'
import { serveurMail } from './outils.mjs'
import { publicAccounts } from '../mail/accounts.mjs'

const HOME = os.homedir()
const require = createRequire(import.meta.url)

/** Une app lancée depuis le Dock n'hérite pas du PATH du shell. */
const PATH_SUP = [
  path.join(HOME, '.local/bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin',
  '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
]

// Le SDK embarque son binaire Claude Code et le résout par chemin de module.
// Ce repli ne sert que si le paquet natif manque (installation partielle).
function claudeExecutable() {
  try {
    require.resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json')
    return undefined
  } catch {}
  for (const c of [path.join(HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    try { fs.accessSync(c, fs.constants.X_OK); return c } catch {}
  }
  return undefined
}

const PREFIXE = 'mcp__mailzen__'

/** Outils qui ne font que lire : jamais de confirmation. */
const LECTURE = new Set([
  'lister_comptes', 'lister_dossiers', 'chercher_messages', 'lire_message',
  'expediteurs', 'abonnements', 'apercu_dossier', 'etat_traitements', 'methodes_desabonnement',
])

/** Actions réversibles d'un clic : confirmées, sauf si « actions douces » est actif. */
const DOUCES = new Set(['creer_dossier', 'marquer_messages'])

/**
 * Actions qui touchent au contenu des boîtes ou sortent de la machine.
 * Règle n°2 : validation obligatoire, sans bouton « Toujours ».
 */
const TOUJOURS_DEMANDER = new Set([
  'deplacer_messages', 'deplacer_dossier', 'supprimer_messages', 'supprimer_dossier',
  'renommer_dossier', 'desabonner', 'envoyer_message', 'reprendre_traitement',
])

const BUILTIN_SUR = new Set([
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task',
  'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
  'Skill', 'AskUserQuestion', 'TaskOutput',
])

function fileEntree() {
  const attente = []
  let dormeur = null
  let ferme = false
  return {
    push(msg) {
      if (dormeur) { const d = dormeur; dormeur = null; d({ value: msg, done: false }) }
      else attente.push(msg)
    },
    close() {
      ferme = true
      if (dormeur) { const d = dormeur; dormeur = null; d({ done: true }) }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (attente.length) { yield attente.shift(); continue }
        if (ferme) return
        const r = await new Promise((res) => { dormeur = res })
        if (r.done) return
        yield r.value
      }
    },
  }
}

export class AgentSession {
  constructor({ emit, askPermission, getConfig, workspace }) {
    this.emit = emit
    this.askPermission = askPermission
    this.getConfig = getConfig
    this.workspace = workspace
    this.q = null
    this.queue = null
    this.abort = null
    this.sessionId = null
    this.busy = false
    this.streamed = new Set()
    this.toolNames = new Map()
    this.garde = new GardeMail()
  }

  get running() { return this.q !== null }

  buildOptions(resume) {
    const cfg = this.getConfig()
    const bin = claudeExecutable()
    return {
      cwd: this.workspace,
      additionalDirectories: [HOME],
      model: cfg.model,
      effort: 'high',
      thinking: { type: 'adaptive', display: 'summarized' },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: buildSystemPrompt({
          workspace: this.workspace,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          comptes: publicAccounts(),
        }),
      },
      tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task'],
      strictMcpConfig: true,
      mcpServers: { mailzen: serveurMail() },
      // Aucune source de réglages externe : les règles d'autorisation de cette app
      // ne doivent pas pouvoir être élargies par un settings.json global.
      settingSources: [],
      permissionMode: 'default',
      hooks: this.garde.hooks(),
      includePartialMessages: true,
      abortController: this.abort,
      resume: resume || undefined,
      title: 'Assistant MailZen',
      env: {
        ...process.env,
        PATH: [...new Set([...PATH_SUP, ...(process.env.PATH || '').split(':')])].filter(Boolean).join(':'),
        CLAUDE_AGENT_SDK_CLIENT_APP: 'assistant-mailzen/2.0.0',
      },
      ...(bin ? { pathToClaudeCodeExecutable: bin } : {}),
      stderr: (d) => { if (process.env.MAILZEN_DEBUG) process.stderr.write(`[claude] ${d}`) },
      canUseTool: (toolName, input, opts) => this.handlePermission(toolName, input, opts),
    }
  }

  start({ resume } = {}) {
    this.stop()
    this.abort = new AbortController()
    this.queue = fileEntree()
    this.sessionId = null
    this.resumeId = resume || null
    this.streamed = new Set()
    this.garde = new GardeMail()
    this.q = query({ prompt: this.queue, options: this.buildOptions(resume) })
    this.emit({ k: 'status', state: 'connecting' })
    this.pump()
  }

  async pump() {
    const courant = this.q
    try {
      for await (const msg of courant) {
        if (this.q !== courant) break
        this.route(msg)
      }
    } catch (err) {
      if (this.q !== courant) return
      if (this.abort?.signal.aborted) return
      this.busy = false
      if (this.resumeId) {
        this.resumeId = null
        this.emit({ k: 'note', text: 'Conversation précédente introuvable, on repart à zéro.' })
        this.start({})
        return
      }
      this.emit({ k: 'error', message: String(err?.message || err) })
      this.emit({ k: 'status', state: 'idle' })
    }
  }

  stop() {
    try { this.queue?.close() } catch {}
    try { this.abort?.abort() } catch {}
    this.q = null
    this.queue = null
    this.busy = false
  }

  send(text) {
    if (!this.q) this.start({})
    this.busy = true
    this.emit({ k: 'turn-start' })
    this.emit({ k: 'status', state: 'thinking' })
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.sessionId || '',
    })
  }

  async interrupt() {
    if (!this.q || !this.busy) return
    try { await this.q.interrupt() } catch {}
    this.busy = false
    this.emit({ k: 'interrupted' })
    this.emit({ k: 'status', state: 'idle' })
  }

  async setModel(model) {
    if (this.q) { try { await this.q.setModel(model) } catch {} }
  }

  // ---------------------------------------------------------------- routage

  route(msg) {
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.sessionId = msg.session_id
          const mail = (msg.mcp_servers || []).find((s) => s.name === 'mailzen')
          this.emit({ k: 'ready', sessionId: msg.session_id, model: msg.model, mail: mail?.status || 'absent' })
          if (this.resumeId) this.emit({ k: 'resumed' })
          this.emit({ k: 'status', state: this.busy ? 'thinking' : 'idle' })
        } else if (msg.subtype === 'compact_boundary') {
          this.emit({ k: 'note', text: 'Conversation résumée pour libérer de la mémoire.' })
        }
        break

      case 'stream_event': {
        const ev = msg.event
        if (ev.type === 'message_start' && ev.message?.id) this.streamed.add(ev.message.id)
        if (ev.type === 'content_block_start') {
          if (ev.content_block?.type === 'text') this.emit({ k: 'text-start' })
          if (ev.content_block?.type === 'thinking') this.emit({ k: 'thinking-start' })
        }
        if (ev.type === 'content_block_delta') {
          const d = ev.delta
          if (d.type === 'text_delta' && d.text) this.emit({ k: 'text-delta', text: d.text })
          if (d.type === 'thinking_delta' && d.thinking) this.emit({ k: 'thinking-delta', text: d.thinking })
        }
        break
      }

      case 'assistant': {
        const id = msg.message?.id
        const dejaVu = id && this.streamed.has(id)
        for (const bloc of msg.message?.content || []) {
          if (bloc.type === 'tool_use') {
            this.toolNames.set(bloc.id, bloc.name)
            this.emit({ k: 'tool-use', id: bloc.id, name: bloc.name, input: bloc.input })
          } else if (bloc.type === 'text' && !dejaVu && bloc.text?.trim()) {
            this.emit({ k: 'text-start' })
            this.emit({ k: 'text-delta', text: bloc.text })
          }
        }
        break
      }

      case 'user': {
        const contenu = msg.message?.content
        if (!Array.isArray(contenu)) break
        for (const bloc of contenu) {
          if (bloc.type !== 'tool_result') continue
          const nom = this.toolNames.get(bloc.tool_use_id) || ''
          const brut = textOf(bloc.content)
          this.garde.noteToolResult(nom, brut)
          this.emit({ k: 'tool-result', id: bloc.tool_use_id, name: nom, ok: !bloc.is_error, preview: tronquer(brut) })
        }
        break
      }

      case 'result':
        this.busy = false
        this.emit({
          k: 'result',
          isError: msg.subtype !== 'success',
          text: msg.subtype !== 'success' ? (msg.result || msg.subtype) : '',
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
        })
        this.emit({ k: 'status', state: 'idle' })
        break
    }
  }

  // ------------------------------------------------------------ permissions

  async handlePermission(toolName, input, opts) {
    const cfg = this.getConfig()
    const court = toolName.startsWith(PREFIXE) ? toolName.slice(PREFIXE.length) : null
    const critique = court ? TOUJOURS_DEMANDER.has(court) : false

    if (!critique) {
      if (court && LECTURE.has(court)) return { behavior: 'allow', updatedInput: input }
      if (court && DOUCES.has(court) && cfg.autoDoux) return { behavior: 'allow', updatedInput: input }
      if (!court && BUILTIN_SUR.has(toolName)) return { behavior: 'allow', updatedInput: input }
    }

    const summary = resumerPermission(toolName, input)
    const reponse = await this.askPermission({
      toolName,
      input,
      summary,
      title: summary?.title || opts?.title,
      displayName: opts?.displayName,
      subtitle: opts?.subtitle,
      reason: opts?.decisionReason,
      hint: critique ? 'Cette action touche au contenu de tes boîtes mail.' : undefined,
      allowAlways: !critique,
      signal: opts?.signal,
    })

    if (reponse?.behavior === 'allow') {
      const res = { behavior: 'allow', updatedInput: input }
      if (reponse.always && opts?.suggestions?.length) res.updatedPermissions = opts.suggestions
      return res
    }
    return { behavior: 'deny', message: reponse?.message || 'Refusé par Nicolas.' }
  }
}

function textOf(contenu) {
  if (typeof contenu === 'string') return contenu
  if (Array.isArray(contenu)) return contenu.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  return ''
}

function tronquer(s, n = 700) {
  if (!s) return ''
  const t = String(s).trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
