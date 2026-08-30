import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { YTDLP_BIN, shellEnv } from './paths'
import {
  upsertVideos, updateVideoStatus, updateVideoScout, listVideos, getSetting,
  VideoRow, VideoStatus
} from './db'
import { runQuick } from './agent-runner'

const execFileP = promisify(execFile)

interface FlatEntry {
  id?: string
  title?: string
  duration?: number
  url?: string
  live_status?: string
  thumbnails?: Array<{ url?: string; preference?: number; height?: number }>
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
    url: e.url ?? `https://www.youtube.com/watch?v=${e.id}`,
    thumbnail_url: bestThumbnail(e)
  }))
  const added = upsertVideos(videos)
  return { added, total: entries.length }
}

function bestThumbnail(e: FlatEntry): string | null {
  const thumbs = (e.thumbnails ?? []).filter((t) => t.url)
  if (!thumbs.length) return null
  // highest preference/height wins; fall back to the last entry
  return (
    thumbs.slice().sort((a, b) => (b.height ?? b.preference ?? 0) - (a.height ?? a.preference ?? 0))[0].url ??
    null
  )
}

/** Scout verdict: the Card0 Fit funnel (metadata-only cheap pass). */
export interface ScoutVerdict {
  classification: string
  fit_score: number
  fit_reasons: string[]
  rights_status: string
  reason: string
}

const CLASSIFICATIONS = ['GAME_TUTORIAL', 'PLAYTHROUGH', 'GAME_REVIEW', 'NEWS', 'ACCESSORY', 'SHORT', 'OTHER']

const SCOUT_PROMPT = (meta: string, transcript: string | null) => [
  'You are the Video Scout for a card-game factory. Score how well this YouTube video can become',
  'a playable card0 game (digital card game builder).',
  '',
  meta,
  transcript ? `\nTranscript excerpt:\n${transcript}` : '',
  '',
  'Score these dimensions 0-10 (weighted):',
  '- rules_extractable (25%): are the complete rules explainable/derivable from the video?',
  '- card_centric (20%): can all components be represented as cards?',
  '- deterministic_turns (15%): turn structure is deterministic and understandable',
  '- digital_friendly (15%): works digitally without physical dexterity',
  '- components_shown (15%): video shows/explains all required components',
  '- art_workload (10%): artwork workload is reasonable',
  '',
  'Answer with ONLY minified JSON, no other text:',
  '{"classification": "GAME_TUTORIAL|PLAYTHROUGH|GAME_REVIEW|NEWS|ACCESSORY|SHORT|OTHER",',
  ' "scores": {"rules_extractable": n, "card_centric": n, "deterministic_turns": n, "digital_friendly": n, "components_shown": n, "art_workload": n},',
  ' "fit_reasons": ["short reason", ...],',
  ' "rights_status": "original|licensed|commercial_clone",',
  ' "reason": "one short sentence"}',
  '',
  `Classifications: ${CLASSIFICATIONS.join(', ')}.`,
  'rights_status: "original" if it looks like an indie/public-domain game, "commercial_clone" if it is a',
  'published commercial game (its art/text is copyrighted - the factory can prototype but a human',
  'must gate publishing), "licensed" if the channel clearly owns the game.'
].join('\n')

function parseVerdict(raw: string): ScoutVerdict | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const p = JSON.parse(match[0]) as {
      classification?: string
      scores?: Record<string, number>
      fit_reasons?: string[]
      rights_status?: string
      reason?: string
    }
    const weights: Record<string, number> = {
      rules_extractable: 0.25,
      card_centric: 0.2,
      deterministic_turns: 0.15,
      digital_friendly: 0.15,
      components_shown: 0.15,
      art_workload: 0.1
    }
    let fit = 0
    for (const [k, w] of Object.entries(weights)) fit += (Number(p.scores?.[k]) || 0) * w
    return {
      classification: CLASSIFICATIONS.includes(p.classification ?? '') ? p.classification! : 'OTHER',
      fit_score: Math.round(fit * 10), // 0-100
      fit_reasons: Array.isArray(p.fit_reasons) ? p.fit_reasons.slice(0, 6).map(String) : [],
      rights_status: ['original', 'licensed', 'commercial_clone'].includes(p.rights_status ?? '')
        ? p.rights_status!
        : 'unknown',
      reason: p.reason ?? ''
    }
  } catch {
    return null
  }
}

function videoMeta(video: VideoRow): string {
  return [
    `Title: ${video.title}`,
    `Channel: ${video.channel}`,
    `Duration: ${video.duration_s ? `${Math.round(video.duration_s / 60)} minutes` : 'unknown'}`,
    `URL: ${video.url}`
  ].join('\n')
}

/** Cheap pass: metadata-only classification + fit score. */
export async function scoutVideo(video: VideoRow): Promise<ScoutVerdict> {
  const raw = await runQuick(SCOUT_PROMPT(videoMeta(video), null), getTriageModel())
  return (
    parseVerdict(raw) ?? {
      classification: 'OTHER',
      fit_score: 0,
      fit_reasons: ['scout parse failure'],
      rights_status: 'unknown',
      reason: 'scout parse failure'
    }
  )
}

export async function scoutVideos(
  videoIds: number[],
  onDone: (id: number, status: VideoStatus, verdict: ScoutVerdict) => void
): Promise<void> {
  const all = listVideos()
  for (const id of videoIds) {
    const video = all.find((v) => v.id === id)
    if (!video) continue
    updateVideoStatus(id, 'triaging', null)
    try {
      const verdict = await scoutVideo(video)
      const status: VideoStatus =
        verdict.classification === 'GAME_TUTORIAL' || verdict.classification === 'PLAYTHROUGH'
          ? 'candidate'
          : 'rejected'
      updateVideoScout(id, {
        classification: verdict.classification,
        fit_score: verdict.fit_score,
        fit_reasons: JSON.stringify(verdict.fit_reasons),
        rights_status: verdict.rights_status
      })
      updateVideoStatus(id, status, verdict.reason)
      onDone(id, status, verdict)
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      updateVideoStatus(id, 'new', `scout failed: ${reason}`)
      onDone(id, 'new', {
        classification: 'OTHER', fit_score: 0, fit_reasons: [reason], rights_status: 'unknown', reason
      })
    }
  }
}

/** Expensive pass: fetch the transcript and refine the fit score. */
export async function deepScoutVideo(video: VideoRow): Promise<ScoutVerdict> {
  const transcript = await fetchTranscript(video.url)
  const raw = await runQuick(SCOUT_PROMPT(videoMeta(video), transcript), getTriageModel(), 240_000)
  return (
    parseVerdict(raw) ?? {
      classification: 'OTHER',
      fit_score: 0,
      fit_reasons: ['deep scout parse failure'],
      rights_status: 'unknown',
      reason: 'deep scout parse failure'
    }
  )
}

/** Pull English subtitles as plain text (auto-subs fallback), best effort. */
async function fetchTranscript(url: string): Promise<string | null> {
  const dir = mkdtempSync(path.join(tmpdir(), 'lb-scout-'))
  try {
    await execFileP(
      YTDLP_BIN,
      ['--skip-download', '--write-auto-subs', '--write-subs', '--sub-langs', 'en.*', '--convert-subs', 'vtt', '-o', path.join(dir, 't'), url],
      { encoding: 'utf8', env: shellEnv(), timeout: 180_000 }
    )
    const files = (await execFileP('ls', [dir])).stdout.split('\n').filter((f) => f.endsWith('.vtt'))
    if (!files.length) return null
    const vtt = readFileSync(path.join(dir, files[0]), 'utf8')
    return vttToText(vtt).slice(0, 12_000)
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function vttToText(vtt: string): string {
  return vtt
    .split('\n')
    .filter((l) => l && !l.includes('-->') && !l.startsWith('WEBVTT') && !l.startsWith('Kind:') && !l.startsWith('Language:'))
    .map((l) => l.replace(/<[^>]+>/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
}

function getTriageModel(): string {
  return getSetting('triageModel', 'haiku')
}
