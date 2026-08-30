import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Absolute paths to external binaries. GUI apps don't inherit shell PATH,
 *  so we resolve against well-known locations + whatever we can source. */

function fromShellPath(bin: string): string | null {
  try {
    const which = execSync(`/bin/zsh -ilc 'which ${bin}' 2>/dev/null`, { encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop()
    if (which && existsSync(which)) return which
  } catch {
    /* not in shell PATH either */
  }
  return null
}

function resolveBin(bin: string, candidates: string[]): string {
  for (const c of candidates) if (existsSync(c)) return c
  const shell = fromShellPath(bin)
  if (shell) return shell
  return bin // last resort: rely on PATH anyway
}

export const CLAUDE_BIN = resolveBin('claude', [
  path.join(homedir(), '.local/bin/claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude'
])

export const YTDLP_BIN = resolveBin('yt-dlp', [
  '/usr/local/bin/yt-dlp',
  '/opt/homebrew/bin/yt-dlp',
  path.join(homedir(), 'miniforge3/bin/yt-dlp'),
  path.join(homedir(), '.local/bin/yt-dlp')
])

export const CARD0_BIN = resolveBin('card0', ['/usr/local/bin/card0', '/opt/homebrew/bin/card0'])

/** Workbench root: all job workspaces + the database live here.
 *  Override with CARD0_WORKBENCH_ROOT (handy for tests/relocation). */
export function workbenchRoot(): string {
  return process.env.CARD0_WORKBENCH_ROOT || path.join(homedir(), 'Projects/card0/card0-workbench')
}

export function jobsRoot(): string {
  return path.join(workbenchRoot(), 'jobs')
}

export function jobWorkspace(jobId: string): string {
  return path.join(jobsRoot(), jobId)
}

export function dbPath(): string {
  return path.join(workbenchRoot(), 'workbench.db')
}

/** Env for spawned agent processes. GUI apps launch without shell env,
 *  so merge the login shell's exported vars (PATH etc.) on top of ours.
 *  Cached: zsh -i is slow, and it only needs to run once per process. */
let cachedShellEnv: Record<string, string> | null = null

export function shellEnv(): Record<string, string> {
  if (cachedShellEnv) return cachedShellEnv
  const env = { ...process.env } as Record<string, string>
  try {
    const out = execSync(`/bin/zsh -ilc 'env' 2>/dev/null`, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    for (const line of out.split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq)
      // PATH we merge; everything else (API keys etc.) we take if we don't have it
      if (k === 'PATH') {
        env.PATH = `${env.PATH || ''}:${line.slice(eq + 1)}`.replace(/^:/, '')
      } else if (!env[k]) {
        env[k] = line.slice(eq + 1)
      }
    }
  } catch {
    /* dev runs from a terminal already have env */
  }
  cachedShellEnv = env
  return env
}

export function ensureDirs(): void {
  for (const dir of [workbenchRoot(), jobsRoot()]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
}

export { readFileSync }
