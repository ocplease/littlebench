import { getSetting, setSetting } from './db'

/** API key pool with rotation. The backend enforces a 5-hour token quota per
 *  key; spreading builders across several keys keeps the factory running.
 *  Keys live ONLY in the local workbench DB - never in the repo, never logged. */

function parseList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function claudeKeys(): string[] {
  return parseList(getSetting('claude_api_keys', ''))
}

export function imageKeys(): string[] {
  return parseList(getSetting('image_api_keys', ''))
}

/** Short fingerprint for the cooldown map - full keys never hit the DB twice. */
function fp(key: string): string {
  return `…${key.slice(-6)}`
}

function cooldowns(): Record<string, string> {
  try {
    return JSON.parse(getSetting('key_cooldowns', '{}')) as Record<string, string>
  } catch {
    return {}
  }
}

/** Park a key until an ISO timestamp (a 429 told us its quota window is spent). */
export function coolKey(key: string, untilISO: string): void {
  const map = cooldowns()
  map[fp(key)] = untilISO
  const now = Date.now()
  for (const [f, until] of Object.entries(map)) {
    if (new Date(until).getTime() < now) delete map[f]
  }
  setSetting('key_cooldowns', JSON.stringify(map))
}

function usable(keys: string[]): string[] {
  const map = cooldowns()
  const now = Date.now()
  return keys.filter((k) => {
    const until = map[fp(k)]
    return !until || new Date(until).getTime() <= now
  })
}

/** Snapshot for the UI: how many keys exist, how many are cooling, and
 *  when the earliest one comes back. */
export function keyPoolStatus(): { total: number; cooling: number; nextAvailable?: string } {
  const keys = claudeKeys()
  const map = cooldowns()
  const now = Date.now()
  let cooling = 0
  let next: number | undefined
  for (const k of keys) {
    const t = map[fp(k)] ? new Date(map[fp(k)]).getTime() : 0
    if (t > now) {
      cooling++
      if (next === undefined || t < next) next = t
    }
  }
  return {
    total: keys.length,
    cooling,
    nextAvailable: next !== undefined ? new Date(next).toISOString() : undefined
  }
}

/** Any configured claude key still inside its quota window? */
export function claudeKeysAvailable(): boolean {
  return usable(claudeKeys()).length > 0
}

function pick(keys: string[], counterSetting: string): string | null {
  const pool = usable(keys)
  if (pool.length === 0) return null
  const i = Number(getSetting(counterSetting, '0')) || 0
  setSetting(counterSetting, String(i + 1))
  return pool[i % pool.length]
}

/** Env overrides for one spawned agent: the next key from each pool. Empty
 *  object when no keys are configured - the agent inherits the default login. */
export function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const ck = pick(claudeKeys(), 'claude_key_rr')
  if (ck) env.ANTHROPIC_AUTH_TOKEN = ck
  const ik = pick(imageKeys(), 'image_key_rr')
  if (ik) env.SEEDREAM_API_KEY = ik
  return env
}

/** Parse "It will reset at 2026-08-31 04:00:21 +0800" out of a quota error. */
export function parseQuotaReset(text: string): string | null {
  const m = text.match(/reset at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::(\d{2}))? ([+-]\d{4})/)
  if (!m) return null
  const tz = `${m[4].slice(0, 3)}:${m[4].slice(3)}`
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3] ?? '00'}${tz}`)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
