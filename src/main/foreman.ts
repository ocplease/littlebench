import { runAgent, AgentRun, ClaudeStreamEvent } from './agent-runner'
import { getSetting, setSetting, insertForemanMessage } from './db'
import { workbenchRoot, repoRoot, shellEnv } from './paths'
import { agentEnv } from './keys'

/** The foreman: the chat agent the user talks to. It operates the factory
 *  through the `lb` CLI (bin/lb) - ingest channels, scout videos, queue jobs,
 *  check on builders - so the user never has to touch buttons if they don't
 *  want to. Conversation state persists via claude session resume. */

type Broadcast = (channel: string, payload: unknown) => void

let broadcast: Broadcast = () => {}
export function setForemanBroadcast(fn: Broadcast): void {
  broadcast = fn
}

let activeRun: AgentRun | null = null
// Set when the user stops the run; onExit turns it into an "interrupted"
// broadcast instead of a half-finished answer.
let interrupted = false

export function foremanBusy(): boolean {
  return activeRun !== null
}

/** User pressed Stop: kill the agent run. The child's exit handler still
 *  fires and finalizes the turn, so the UI and DB stay consistent. */
export function stopForeman(): void {
  if (!activeRun) return
  interrupted = true
  activeRun.kill()
}

const FOREMAN_PREAMBLE = [
  'You are Steven Jobs, the foreman of littlebench, an autonomous card-game factory running',
  'on this Mac. The user knows you as Steven; every job in the factory is yours to dispatch.',
  'The user talks to you in plain language; you operate the factory ONLY through the `lb` CLI',
  '(already on your PATH - run it with the Bash tool):',
  '',
  '  lb ingest <channelUrl> [max]     list a YouTube channel\'s videos into the factory',
  '  lb scout --new                   classify + Card0-fit-score new videos (0-100)',
  '  lb scout <videoId> ...           scout specific videos',
  '  lb videos [status]               list videos: id, fit, classification, rights, status',
  '  lb queue <videoId> ...           queue videos as game-builder jobs',
  '  lb queue --candidates --min-fit N  queue every candidate above a fit bar',
  '  lb queue-url <videoUrl> [title]  queue a single video URL as a build job',
  '  lb queue-design "<title>"        queue a build from a design brief (brief on stdin)',
  '  lb status                        jobs/videos/games overview',
  '  lb list / lb events <jobId>      builder jobs and their recent activity',
  '',
  'How to behave:',
  '- When the user gives a YouTube channel URL: run lb ingest, then lb scout --new, then report',
  '  the candidates (title + fit score + rights) and ask whether to queue them - or queue them',
  '  straight away if the user already said to build.',
  '- When the user gives a single video URL and wants it built: run lb queue-url <url>',
  '  (the title is fetched automatically) - no ingest or scout needed.',
  '- When the user DESCRIBES a game to build (no video URL) or pastes a design: pass their',
  '  full text on stdin to lb queue-design "<short title>". You do NOT build games yourself -',
  '  never run card0, yt-dlp, or file tools directly; the factory builders do that work.',
  '- Builders pick up queued jobs automatically while the littlebench app is running; lb queue',
  '  does not need to start anything.',
  '- Publishing stays a human action in the app - never claim to publish games.',
  '- Answers stay short and concrete: what you did, what came out, what you suggest next.',
  '- Use only the lb CLI unless the user explicitly asks for something else.',
  '- Image-generation gate: if the user has DISABLED auto image generation for card art in',
  '  Settings, builders will pause and ask the user before any card art call. When you',
  '  describe a queued build to the user, mention that image generation requires their approval.'
].join('\n')

/** One recorded part of a foreman turn - the same shape the renderer's
 *  process feed consumes, so a saved turn replays exactly as it streamed. */
interface RunPart {
  kind: 'thinking' | 'tool' | 'text'
  text: string
  preview?: string
  detail?: string
  result?: string
  error?: boolean
}

let runParts: RunPart[] = []

/** Attach a tool result to the most recent tool part still waiting for one
 *  (stream-json emits tool_use before its tool_result). */
function attachRunResult(detail: string, error: boolean): void {
  for (let i = runParts.length - 1; i >= 0; i--) {
    if (runParts[i].kind === 'tool' && runParts[i].result === undefined) {
      runParts[i].result = detail
      runParts[i].error = error
      return
    }
  }
}

export function sendForeman(message: string): { ok: boolean; error?: string } {
  if (activeRun) return { ok: false, error: 'foreman is already working on your previous message' }

  const sessionId = getSetting('foreman_session_id', '')
  const model = getSetting('model', 'sonnet')
  insertForemanMessage('user', message)
  broadcast('foreman:event', { type: 'user', text: message })

  let answer = ''
  runParts = []
  const startedAt = Date.now()
  // The chat UI shows a Claude Code-style process feed: thinking, tool calls,
  // and interleaved text stream in as they happen instead of a bare "working…".
  const captureText = (event: ClaudeStreamEvent) => {
    if (event.type !== 'assistant' && event.type !== 'user') return
    const content = (event.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'text' && typeof b.text === 'string') {
        if (event.type !== 'assistant') continue
        if (!b.text) continue
        answer += (answer ? '\n\n' : '') + b.text
        broadcast('foreman:event', { type: 'delta', text: b.text })
        runParts.push({ kind: 'text', text: b.text })
      } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
        const text = b.thinking.slice(0, 2000)
        broadcast('foreman:event', { type: 'thinking', text })
        runParts.push({ kind: 'thinking', text })
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        const input = b.input as Record<string, unknown> | undefined
        broadcast('foreman:event', {
          type: 'tool',
          name: b.name,
          preview: toolPreview(input),
          detail: summarizeJson(b.input, 4000)
        })
        runParts.push({
          kind: 'tool',
          text: b.name,
          preview: toolPreview(input),
          detail: summarizeJson(b.input, 4000)
        })
      } else if (b.type === 'tool_result') {
        const detail = summarizeResult(b.content)
        broadcast('foreman:event', {
          type: 'tool_result',
          error: Boolean(b.is_error),
          detail
        })
        attachRunResult(detail, Boolean(b.is_error))
      }
    }
  }

  const run = runAgent({
    cwd: workbenchRoot(),
    prompt: sessionId ? message : `${FOREMAN_PREAMBLE}\n\n---\n\n${message}`,
    model: model || undefined,
    // No bypass: the foreman may only run the lb CLI.
    bypassPermissions: false,
    allowedTools: ['Bash(lb:*)'],
    resumeSessionId: sessionId || undefined,
    env: lbEnv(),
    onEvent: (event) => {
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        setSetting('foreman_session_id', String(event.session_id))
        broadcast('foreman:event', { type: 'session', sessionId: event.session_id })
        return
      }
      if (event.type === 'result') {
        const isError = Boolean(event.is_error)
        if (!isError && event.result) answer = String(event.result)
        broadcast('foreman:event', { type: 'done', error: isError ? String(event.result ?? '') : null })
        return
      }
      captureText(event)
    },
    onStderr: (text) => {
      broadcast('foreman:event', { type: 'stderr', text })
    },
    onExit: (code) => {
      activeRun = null
      const wasInterrupted = interrupted
      interrupted = false
      const finalAnswer = wasInterrupted
        ? '(interrupted)'
        : answer.trim() || (code === 0 ? '(no reply)' : `foreman exited with code ${code}`)
      // Persist the turn's process feed so it replays after a restart.
      const partsJson =
        runParts.length > 0
          ? JSON.stringify({
              tools: runParts.filter((p) => p.kind === 'tool').length,
              seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
              items: runParts
            })
          : undefined
      insertForemanMessage('assistant', finalAnswer, partsJson)
      runParts = []
      broadcast('foreman:event', { type: wasInterrupted ? 'interrupted' : 'saved', text: finalAnswer })
      broadcast('foreman:changed', null)
    }
  })

  activeRun = run
  return { ok: true }
}

/** PATH with the repo's bin/ prepended so `lb` resolves inside the agent,
 *  plus the next key from the rotation pools. */
function lbEnv(): Record<string, string> {
  const env = shellEnv()
  const bin = `${repoRoot()}/bin`
  return {
    PATH: `${bin}:${env.PATH ?? process.env.PATH ?? ''}`,
    ...agentEnv()
  }
}

export function resetForeman(): void {
  setSetting('foreman_session_id', '')
  broadcast('foreman:event', { type: 'reset' })
}

function summarizeJson(value: unknown, max: number): string {
  try {
    return (JSON.stringify(value, null, 2) ?? '').slice(0, max)
  } catch {
    return String(value).slice(0, max)
  }
}

/** The one-line argument preview Claude Code shows next to a tool name -
 *  Bash's command, Read's file path, Grep's pattern: the identifying
 *  argument, so `⏺ Bash(lb scout --new)` reads at a glance. */
function toolPreview(input: Record<string, unknown> | undefined): string {
  if (!input) return ''
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = input[k]
      if (typeof v === 'string' && v.trim()) return v.trim().replace(/\s+/g, ' ')
    }
    return ''
  }
  const preview =
    pick('command') ||
    pick('file_path', 'path', 'notebook_path') ||
    pick('pattern') ||
    pick('url') ||
    pick('query', 'question') ||
    pick('description', 'prompt') ||
    pick('skill', 'skill')
  return preview.slice(0, 90)
}

/** Tool results are a string or an array of content blocks; flatten to text. */
function summarizeResult(content: unknown): string {
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('\n')
  }
  return text.slice(0, 4000)
}
