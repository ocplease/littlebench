/** Time/date formatting helpers shared by views.
 *  Pure functions - no React, no DOM. Safe to import anywhere in the renderer. */

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

/** "just now" / "3m ago" / "2h ago" / "yesterday" / "Mar 4".
 *  Returns "" for null/undefined so callers can render `&nbsp;` if they prefer. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const diffMs = t - now
  const diffSec = Math.round(diffMs / 1000)
  const absSec = Math.abs(diffSec)
  if (absSec < 45) return RELATIVE.format(diffSec, 'second')
  const diffMin = Math.round(diffSec / 60)
  if (Math.abs(diffMin) < 45) return RELATIVE.format(diffMin, 'minute')
  const diffHour = Math.round(diffMin / 60)
  if (Math.abs(diffHour) < 22) return RELATIVE.format(diffHour, 'hour')
  const diffDay = Math.round(diffHour / 24)
  if (Math.abs(diffDay) < 7) return RELATIVE.format(diffDay, 'day')
  // Older than a week: show a short date. Stable regardless of locale clock skew.
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(t)
}

/** `mm:ss` for under an hour, `h:mm:ss` over. `until` defaults to now.
 *  Returns "" for a missing `since` so a ticking card can render `formatElapsed(started_at)`. */
export function formatElapsed(since: string | null | undefined, until: number = Date.now()): string {
  if (!since) return ''
  const t = Date.parse(since)
  if (Number.isNaN(t)) return ''
  const total = Math.max(0, Math.floor((until - t) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Stable two-color gradient seed from a string. Used to give jobs without a
 *  YouTube thumbnail a recognizable, non-flat fallback that matches their
 *  source (channel or title) so cards don't all look the same. */
export function channelPalette(seed: string): { from: string; to: string } {
  let h = 5381
  for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0
  const hue1 = Math.abs(h) % 360
  const hue2 = (hue1 + 35) % 360
  return {
    from: `hsl(${hue1} 35% 22%)`,
    to: `hsl(${hue2} 45% 12%)`
  }
}
