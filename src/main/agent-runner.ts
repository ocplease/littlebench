import { spawn, ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { CLAUDE_BIN, shellEnv } from './paths'

/** A single line from `claude -p --output-format stream-json`. */
export interface ClaudeStreamEvent {
  type: string
  subtype?: string
  // system/init
  session_id?: string
  // assistant/user messages
  message?: { role: string; content: unknown }
  // result
  subtype_result?: string
  result?: string
  is_error?: boolean
  total_cost_usd?: number
  duration_ms?: number
  [k: string]: unknown
}

export interface AgentRunOptions {
  cwd: string
  prompt: string
  model?: string
  /** bypass all permission prompts (automation mode) */
  bypassPermissions?: boolean
  allowedTools?: string[]
  sessionId?: string
  /** Continue an existing session (steering) instead of starting fresh. */
  resumeSessionId?: string
  /** Extra env for the spawned agent (PATH additions etc.). */
  env?: Record<string, string>
  onEvent: (event: ClaudeStreamEvent) => void
  onStderr: (text: string) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}

export interface AgentRun {
  process: ChildProcess
  sessionId: string
  kill: () => void
}

export function runAgent(opts: AgentRunOptions): AgentRun {
  const sessionId = opts.sessionId ?? randomUUID()
  const args = [
    '-p', opts.prompt,
    '--output-format', 'stream-json',
    '--verbose'
  ]
  if (opts.resumeSessionId) {
    // steering: continue the existing conversation
    args.push('--resume', opts.resumeSessionId)
  } else {
    args.push('--session-id', sessionId)
  }
  if (opts.model) args.push('--model', opts.model)
  if (opts.bypassPermissions) {
    args.push('--dangerously-skip-permissions')
  } else {
    args.push('--permission-mode', 'acceptEdits')
    if (opts.allowedTools?.length) args.push('--allowedTools', ...opts.allowedTools)
  }

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...shellEnv(), ...opts.env } : shellEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const rl = readline.createInterface({ input: proc.stdout! })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      opts.onEvent(JSON.parse(trimmed) as ClaudeStreamEvent)
    } catch {
      /* partial/non-JSON line, ignore */
    }
  })

  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
    const lines = stderrBuf.split('\n')
    stderrBuf = lines.pop() ?? ''
    for (const l of lines) if (l.trim()) opts.onStderr(l)
  })

  proc.on('error', (err) => opts.onStderr(`spawn error: ${err.message}`))
  proc.on('exit', (code, signal) => opts.onExit(code, signal))

  return {
    process: proc,
    sessionId,
    kill: () => {
      try {
        proc.kill('SIGTERM')
        // escalate if it refuses to die
        setTimeout(() => {
          try {
            if (!proc.killed) proc.kill('SIGKILL')
          } catch { /* already gone */ }
        }, 5000).unref()
      } catch { /* already gone */ }
    }
  }
}

/** One-shot cheap call (triage etc.). Returns the final result text. */
export function runQuick(prompt: string, model?: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'text']
    if (model) args.push('--model', model)
    const proc = spawn(CLAUDE_BIN, args, {
      cwd: '/tmp',
      env: shellEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('quick call timed out'))
    }, timeoutMs)
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString()))
    proc.stderr?.on('data', (c: Buffer) => (err += c.toString()))
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `exit ${code}`))
    })
  })
}
