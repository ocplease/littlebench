/** Thin wrapper around the `card0` CLI for auth flows.
 *
 *  The workbench does NOT own the card0 session — the `card0` binary
 *  stores its own credentials (keychain on macOS) and the user re-authenticates
 *  from the Settings panel whenever the token expires. Every card0 call
 *  elsewhere in the app should treat AUTH_REQUIRED as "go sign in" and
 *  surface that to the UI rather than failing silently.
 *
 *  Everything here is async: `card0 login web` blocks on a local callback
 *  server for as long as the user sits in the browser, so it must run as a
 *  detached child process — a synchronous exec would freeze the whole
 *  main process for the duration of the OAuth flow.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import { CARD0_BIN, shellEnv } from './paths'

/** Shape of `card0 account info`. The CLI returns JSON in both success and
 *  failure cases; we normalize to a discriminated union so callers don't have
 *  to reach into `details` to find out what happened. */
export type Card0AccountInfo =
  | { ok: true; account: Card0Account }
  | { ok: false; reason: 'auth_required' | 'unknown'; message: string }

export interface Card0Account {
  /** Whatever the CLI hands back as the user id; commonly email or sub. */
  id?: string
  email?: string
  name?: string
  /** Google account photo, read from the CLI's stored session. */
  avatar_url?: string
  /** Free-form extras - the CLI may add fields over time. */
  [key: string]: unknown
}

export type Card0AuthResult =
  | { ok: true; url?: string }
  | { ok: false; error: string }

type Broadcast = (channel: string, payload: unknown) => void

let broadcast: Broadcast = () => {}
export function setCard0Broadcast(fn: Broadcast): void {
  broadcast = fn
}

/** Login child currently parked on its local callback server, if any. */
let loginChild: ChildProcess | null = null

/** Run `card0 account info` and parse the result. Never throws - returns a
 *  structured Card0AccountInfo so the UI can render the right state.
 *
 *  Response shapes (from the CLI source):
 *   - logged in:  {id, email, providers}          (bare, no ok wrapper)
 *   - logged out: {ok: false, error: {code: AUTH_REQUIRED, ...}}  (exit 1)
 *   - future:      {ok: true, account: {...}}
 */
export async function card0AccountInfo(): Promise<Card0AccountInfo> {
  try {
    const { stdout, stderr } = await runCard0(['account', 'info'], 15_000)
    const parsed = parseCard0Json(`${stdout}\n${stderr}`)
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>

      if (obj.ok === true) {
        const account = (obj.account ?? obj.user ?? obj) as Card0Account
        return { ok: true, account: withExtras(account) }
      }
      if ('error' in obj) {
        const err = obj.error as { code?: string; message?: string } | undefined
        if (!err || err.code === 'AUTH_REQUIRED') {
          return { ok: false, reason: 'auth_required', message: err?.message ?? 'Not logged in' }
        }
        return { ok: false, reason: 'unknown', message: err.message ?? 'account info unavailable' }
      }
      // bare logged-in shape: {id, email, providers} or {user: {...}}
      if (obj.email || obj.id || obj.user) {
        return { ok: true, account: withExtras((obj.user ?? obj) as Card0Account) }
      }
      if (obj.authenticated === false) {
        return { ok: false, reason: 'auth_required', message: 'Not logged in' }
      }
    }
    const raw = `${stdout}\n${stderr}`.trim().slice(0, 200)
    return { ok: false, reason: 'unknown', message: raw ? `unexpected response from card0: ${raw}` : 'unexpected response from card0' }
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e)
    if (isAuthRequiredError(text)) {
      return { ok: false, reason: 'auth_required', message: 'Not logged in' }
    }
    return { ok: false, reason: 'unknown', message: text.slice(0, 500) }
  }
}

/** Start the web OAuth flow. `card0 login web` prints an authorization URL
 *  and then blocks on a local callback server until the user finishes in the
 *  browser — so we spawn it in the background, open the URL in the default
 *  browser ourselves the moment it appears, and let the child finish at its
 *  own pace. When the child exits we broadcast `card0:authChanged` so the
 *  Settings panel re-checks the session immediately. */
export function card0LoginWeb(opts: { provider?: 'google' } = {}): Promise<Card0AuthResult> {
  // cancel any attempt still parked on its callback server
  if (loginChild && !loginChild.killed) loginChild.kill()

  return new Promise((resolve) => {
    const args = ['login', 'web']
    if (opts.provider) args.push('--provider', opts.provider)
    const child = spawn(CARD0_BIN, args, { env: shellEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    loginChild = child

    let settled = false
    let buf = ''
    const onChunk = (d: Buffer): void => {
      if (settled) return
      buf += d.toString('utf8')
      const m = buf.match(/https?:\/\/\S+/)
      if (m) {
        settled = true
        const url = m[0]
        // directly pull up the card0 web login in the default browser
        shell.openExternal(url).catch(() => {})
        resolve({ ok: true, url })
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    child.on('error', (err) => {
      if (settled) return
      settled = true
      loginChild = null
      resolve({ ok: false, error: `failed to start card0 login: ${err.message}` })
    })

    child.on('exit', () => {
      loginChild = null
      // CLI finished (user completed the flow, failed, or we killed it) -
      // tell the UI to re-check the session.
      broadcast('card0:authChanged', null)
      if (!settled) {
        settled = true
        resolve({ ok: false, error: buf.slice(0, 300) || 'login process exited before producing a URL' })
      }
    })

    // if the CLI never prints a URL, give up rather than hang forever
    const t = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ ok: false, error: 'card0 login did not produce an auth URL (timed out)' })
    }, 20_000)
    t.unref()
  })
}

/** Drop the current session. */
export async function card0Logout(): Promise<Card0AuthResult> {
  try {
    await runCard0(['logout'], 15_000)
    broadcast('card0:authChanged', null)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** Detect the AUTH_REQUIRED pattern in any error string. Other call sites
 *  (syncJobStatus, approveJob, openGame) can use this to rewrite a raw
 *  error into a friendlier "card0 session expired - open Settings to sign in". */
export function isAuthRequiredError(text: string): boolean {
  return /AUTH_REQUIRED|Not logged in/i.test(text)
}

// ---------- helpers ----------

/** `card0 account info` only prints {id, email, providers} - the avatar and
 *  display name live in the session the CLI persists on disk. Read them from
 *  there (same path the CLI uses) without touching any token fields. */
function withExtras(account: Card0Account): Card0Account {
  try {
    const dir = process.env.CARD0_CONFIG_DIR || path.join(homedir(), '.card0')
    const raw = readFileSync(path.join(dir, 'credentials.json'), 'utf8')
    const session = (JSON.parse(raw) as Record<string, unknown>)['card0-cli-auth'] as
      | { user?: { user_metadata?: Record<string, unknown> } }
      | undefined
    const meta = session?.user?.user_metadata
    if (!meta) return account
    return {
      ...account,
      name: account.name ?? (typeof meta.full_name === 'string' ? meta.full_name : undefined) ?? (typeof meta.name === 'string' ? meta.name : undefined),
      avatar_url:
        typeof meta.avatar_url === 'string' ? meta.avatar_url
        : typeof meta.picture === 'string' ? meta.picture
        : undefined
    }
  } catch {
    return account
  }
}

function errMsg(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.slice(0, 500)
}

/** Async execFile - never blocks the main process event loop. */
function runCard0(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      CARD0_BIN,
      args,
      { env: shellEnv(), encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed
          if (killed) return reject(new Error(`card0 ${args.join(' ')} timed out`))
          return reject(new Error(`${stdout ?? ''}\n${stderr ?? ''}\n${err.message}`.trim()))
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

/** Best-effort JSON parse for the card0 CLI. The CLI sometimes prints
 *  status lines around the JSON; we look for the first `{` and parse to
 *  the matching `}`. */
function parseCard0Json(text: string): unknown {
  if (!text) return null
  const i = text.indexOf('{')
  if (i < 0) return null
  const candidate = text.slice(i)
  try {
    return JSON.parse(candidate)
  } catch {
    // last-resort: take everything up to the last `}`
    const last = candidate.lastIndexOf('}')
    if (last > 0) {
      try { return JSON.parse(candidate.slice(0, last + 1)) } catch { return null }
    }
    return null
  }
}
