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

export function foremanBusy(): boolean {
  return activeRun !== null
}

const FOREMAN_PREAMBLE = [
  'You are the foreman of littlebench, an autonomous card-game factory running on this Mac.',
  'The user talks to you in plain language; you operate the factory ONLY through the `lb` CLI',
  '(already on your PATH - run it with the Bash tool):',
  '',
  '  lb ingest <channelUrl> [max]     list a YouTube channel\'s videos into the factory',
  '  lb scout --new                   classify + Card0-fit-score new videos (0-100)',
  '  lb scout <videoId> ...           scout specific videos',
  '  lb videos [status]               list videos: id, fit, classification, rights, status',
  '  lb queue <videoId> ...           queue videos as game-builder jobs',
  '  lb queue --candidates --min-fit N  queue every candidate above a fit bar',
  '  lb status                        jobs/videos/games overview',
  '  lb list / lb events <jobId>      builder jobs and their recent activity',
  '',
  'How to behave:',
  '- When the user gives a YouTube channel URL: run lb ingest, then lb scout --new, then report',
  '  the candidates (title + fit score + rights) and ask whether to queue them - or queue them',
  '  straight away if the user already said to build.',
  '- Builders pick up queued jobs automatically while the littlebench app is running; lb queue',
  '  does not need to start anything.',
  '- Publishing stays a human action in the app - never claim to publish games.',
  '- Answers stay short and concrete: what you did, what came out, what you suggest next.',
  '- Use only the lb CLI unless the user explicitly asks for something else.'
].join('\n')

export function sendForeman(message: string): { ok: boolean; error?: string } {
  if (activeRun) return { ok: false, error: 'foreman is already working on your previous message' }

  const sessionId = getSetting('foreman_session_id', '')
  const model = getSetting('model', '')
  insertForemanMessage('user', message)
  broadcast('foreman:event', { type: 'user', text: message })

  let answer = ''
  const captureText = (event: ClaudeStreamEvent) => {
    if (event.type !== 'assistant') return
    const content = (event.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return
    for (const b of content as Array<{ type?: string; text?: string }>) {
      if (b.type === 'text' && b.text) {
        answer += (answer ? '\n\n' : '') + b.text
        broadcast('foreman:event', { type: 'delta', text: b.text })
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
      const finalAnswer = answer.trim() || (code === 0 ? '(no reply)' : `foreman exited with code ${code}`)
      insertForemanMessage('assistant', finalAnswer)
      broadcast('foreman:event', { type: 'saved', text: finalAnswer })
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
