import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { YTDLP_BIN, shellEnv } from './paths'
import { upsertVideos, updateVideoStatus, listVideos, getSetting, VideoRow, VideoStatus } from './db'
import { runQuick } from './agent-runner'

const execFileP = promisify(execFile)

interface FlatEntry {
  id?: string
  title?: string
  duration?: number
  url?: string
  live_status?: string
}

/** List a channel's videos (newest first) and add unknown ones to the DB. */
export async function ingestChannel(channelUrl: string, max: number): Promise<{ added: number; total: number }> {
  const { stdout } = await execFileP(
    YTDLP_BIN,
    ['--flat-playlist', '--playlist-items', `1:${max}`, '-J', channelUrl],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: shellEnv(), timeout: 300_000 }
  )
  const data = JSON.parse(stdout) as { title?: string; entries?: FlatEntry[]; channel?: string }
  const channelName = data.channel || data.title || channelUrl
  const entries = (data.entries ?? []).filter(
    (e) => e.id && !/live|upcoming/i.test(e.live_status ?? '')
  )

  const videos = entries.map((e) => ({
    youtube_id: e.id!,
    channel: channelName,
    title: e.title ?? e.id!,
    duration_s: e.duration ?? null,
    url: e.url ?? `https://www.youtube.com/watch?v=${e.id}`
  }))
  const added = upsertVideos(videos)
  return { added, total: entries.length }
}

/** Triage verdict from a cheap claude call. */
export interface TriageVerdict {
  game: boolean
  reason: string
}

export async function triageVideo(video: VideoRow): Promise<TriageVerdict> {
  const prompt = [
    'You are filtering YouTube videos for a card-game factory. Decide whether this video is a',
    'tabletop game / card game / party game RULES TUTORIAL or playthrough that could be faithfully',
    'turned into a playable card game.',
    '',
    `Title: ${video.title}`,
    `Duration: ${video.duration_s ? `${Math.round(video.duration_s / 60)} minutes` : 'unknown'}`,
    '',
    'Answer with ONLY minified JSON, no other text:',
    '{"game": true|false, "reason": "one short sentence"}',
    '',
    'Guidelines: game rules explanation -> true. Playthrough/review of a board game -> true if rules',
    'are explained, else false. Vlogs, news, unboxings, video game content, music -> false.'
  ].join('\n')

  const model = getTriageModel()
  const raw = await runQuick(prompt, model)
  const match = raw.match(/\{[^{}]*\}/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { game?: boolean; reason?: string }
      return { game: Boolean(parsed.game), reason: parsed.reason ?? '' }
    } catch { /* fall through */ }
  }
  return { game: false, reason: 'triage parse failure' }
}

export async function triageVideos(videoIds: number[], onDone: (id: number, status: VideoStatus, reason: string) => void): Promise<void> {
  const all = listVideos()
  for (const id of videoIds) {
    const video = all.find((v) => v.id === id)
    if (!video) continue
    updateVideoStatus(id, 'triaging', null)
    try {
      const verdict = await triageVideo(video)
      const status: VideoStatus = verdict.game ? 'candidate' : 'rejected'
      updateVideoStatus(id, status, verdict.reason)
      onDone(id, status, verdict.reason)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      updateVideoStatus(id, 'new', `triage failed: ${reason}`)
      onDone(id, 'new', `triage failed: ${reason}`)
    }
  }
}

function getTriageModel(): string {
  return getSetting('triageModel', 'haiku')
}
