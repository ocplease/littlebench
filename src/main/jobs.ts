import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { runAgent, AgentRun, ClaudeStreamEvent } from './agent-runner'
import { detectStage } from './stages'
import { jobWorkspace, CARD0_BIN, shellEnv } from './paths'
import {
  getJob, getSetting, insertJob, listJobs, updateJob, appendEvent, upsertGame,
  listEvents, JobRow
} from './db'

type Broadcast = (channel: string, payload: unknown) => void

let broadcast: Broadcast = () => {}
export function setBroadcast(fn: Broadcast): void {
  broadcast = fn
}

const running = new Map<string, AgentRun>()

function emit(channel: string, payload: unknown): void {
  broadcast(channel, payload)
}

// ---------- prompts ----------

export function buildGamePrompt(job: JobRow): string {
  const lines = [
    'You are running inside an automated workbench. Create a card0 game from this video:',
    `${job.youtube_url}  (title: "${job.title}")`,
    '',
    '- Follow the card0-game-create skill exactly, Stages 1 through 8 and Stage 10 reporting.',
    '- Build the ENGLISH version only. Do not localize.',
    '- Work inside the current directory (this is your job workspace).',
    '- CRITICAL: Do NOT run `card0 game submit`. A human reviews the cards first.',
    '- When finished, write result.json in this directory with shape:',
    '  { "gameId": string, "deckIds": { "animals": string, "oasis": string },',
    '    "gameName": string, "cardCount": number, "uploadedCount": number,',
    '    "coverPath": string, "imperfections": string[], "notes": string }',
    '  (omit deckIds keys that do not apply to this game)',
    '- Verify every generated image by reading it before uploading; regenerate individual bad images instead of whole batches.'
  ]
  return lines.join('\n')
}

export function buildLocalizePrompt(parent: JobRow, language: 'zh-Hans' | 'ja'): string {
  const langName = language === 'zh-Hans' ? 'Simplified Chinese' : 'Japanese'
  return [
    'You are running inside an automated workbench. Create a localized card0 game.',
    `Source English game job workspace: ${jobWorkspace(parent.id)}`,
    `Read its result.json and manifest.json first.`,
    '',
    `Follow the card0-game-create skill, Stage 9 "If localizing after the fact": translate the manifest`,
    `into ${langName} (language code "${language}"), create a NEW card0 game, regenerate ALL artwork`,
    `with ${langName} text rendered on the images, and upload everything.`,
    '- Work inside the current directory (this is your job workspace).',
    '- CRITICAL: Do NOT run `card0 game submit`. A human reviews the cards first.',
    '- Write result.json in this directory with the same shape as the English job.',
    `- Read every generated image to verify the ${langName} text is rendered correctly.`
  ].join('\n')
}

// ---------- job lifecycle ----------

export function createJob(input: {
  video_id?: number | null
  title: string
  youtube_url?: string | null
  language?: string
  parent_job_id?: string | null
}): string {
  const id = `job_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`
  insertJob({
    id,
    video_id: input.video_id ?? null,
    title: input.title,
    youtube_url: input.youtube_url ?? null,
    language: input.language ?? 'en',
    parent_job_id: input.parent_job_id ?? null
  })
  mkdirSync(jobWorkspace(id), { recursive: true })
  emit('jobs:changed', null)
  pumpQueue()
  return id
}

export function startJob(jobId: string): void {
  const job = getJob(jobId)
  if (!job || job.status === 'running' || running.has(jobId)) return
  if (running.size > 0) return // v1: single agent at a time

  const workspace = jobWorkspace(jobId)
  mkdirSync(workspace, { recursive: true })

  const prompt =
    job.language === 'en'
      ? buildGamePrompt(job)
      : buildLocalizePrompt(getJob(job.parent_job_id!) ?? job, job.language as 'zh-Hans' | 'ja')

  const model = getSetting('model', '')
  const bypass = getSetting('bypassPermissions', 'true') === 'true'

  updateJob(jobId, { status: 'running', started_at: new Date().toISOString(), error: null })

  let seq = 0
  const run = runAgent({
    cwd: workspace,
    prompt,
    model: model || undefined,
    bypassPermissions: bypass,
    sessionId: job.session_id ?? undefined,
    onEvent: (event) => {
      // hook_started/hook_response system events are startup noise - skip entirely
      if (event.type === 'system' && typeof event.subtype === 'string' && event.subtype.startsWith('hook_')) {
        return
      }
      seq++
      appendEvent(jobId, seq, event.type, event)
      emit('job:event', { jobId, event })
      const stage = detectStage(event)
      if (stage) {
        updateJob(jobId, { stage: stage.stage, stage_detail: stage.detail ?? null })
        emit('job:stage', { jobId, ...stage })
      }
      if (event.type === 'system' && event.session_id) {
        updateJob(jobId, { session_id: String(event.session_id) })
      }
      if (event.type === 'result') {
        const isError = Boolean(event.is_error)
        if (!isError) {
          finalizeJob(jobId, event)
        } else {
          updateJob(jobId, {
            status: 'failed',
            error: String(event.result ?? 'agent reported an error'),
            finished_at: new Date().toISOString()
          })
          emit('jobs:changed', null)
        }
      }
    },
    onStderr: (text) => {
      appendEvent(jobId, ++seq, 'stderr', { text })
      emit('job:event', { jobId, event: { type: 'stderr', message: { role: 'stderr', content: text } } })
    },
    onExit: (code) => {
      running.delete(jobId)
      const current = getJob(jobId)
      if (current && current.status === 'running') {
        // exited without a result event
        updateJob(jobId, {
          status: code === 0 ? 'awaiting_review' : 'failed',
          error: code === 0 ? null : `agent exited with code ${code}`,
          finished_at: new Date().toISOString()
        })
        if (code === 0) finalizeFromDisk(jobId)
      }
      emit('jobs:changed', null)
      pumpQueue()
    }
  })

  running.set(jobId, run)
  emit('jobs:changed', null)
}

function finalizeJob(jobId: string, result: ClaudeStreamEvent): void {
  const game = parseResultJson(jobId)
  updateJob(jobId, {
    status: 'awaiting_review',
    card0_game_id: game?.gameId ?? null,
    result_json: game ? JSON.stringify(game) : null,
    finished_at: new Date().toISOString()
  })
  if (game?.gameId) {
    upsertGame({
      job_id: jobId,
      language: getJob(jobId)?.language ?? 'en',
      card0_game_id: game.gameId,
      name: game.gameName ?? null,
      cover_path: game.coverPath ? path.join(jobWorkspace(jobId), game.coverPath) : null,
      card_count: game.cardCount ?? null,
      status: 'awaiting_review'
    })
  }
  emit('jobs:changed', null)
}

/** Agent exited cleanly but we never saw a result event - try result.json anyway. */
function finalizeFromDisk(jobId: string): void {
  const game = parseResultJson(jobId)
  updateJob(jobId, { status: 'awaiting_review', finished_at: new Date().toISOString() })
  if (game?.gameId) {
    upsertGame({
      job_id: jobId,
      language: getJob(jobId)?.language ?? 'en',
      card0_game_id: game.gameId,
      name: game.gameName ?? null,
      cover_path: game.coverPath ? path.join(jobWorkspace(jobId), game.coverPath) : null,
      card_count: game.cardCount ?? null,
      status: 'awaiting_review'
    })
  }
  emit('jobs:changed', null)
}

interface JobResult {
  gameId?: string
  gameName?: string
  deckIds?: Record<string, string>
  cardCount?: number
  uploadedCount?: number
  coverPath?: string
  imperfections?: string[]
  notes?: string
}

export function parseResultJson(jobId: string): JobResult | null {
  const p = path.join(jobWorkspace(jobId), 'result.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as JobResult
  } catch {
    return null
  }
}

export function stopJob(jobId: string): void {
  const run = running.get(jobId)
  if (run) run.kill()
  updateJob(jobId, { status: 'interrupted', finished_at: new Date().toISOString() })
  emit('jobs:changed', null)
  pumpQueue()
}

export function approveJob(jobId: string): { ok: boolean; error?: string } {
  const job = getJob(jobId)
  if (!job) return { ok: false, error: 'job not found' }
  const result = parseResultJson(jobId)
  const gameId = result?.gameId ?? job.card0_game_id
  if (!gameId) return { ok: false, error: 'no gameId found in result.json' }
  try {
    const out = require('node:child_process').execSync(
      `${CARD0_BIN} game submit --yes ${gameId}`,
      { encoding: 'utf8', env: shellEnv(), timeout: 60_000 }
    )
    updateJob(jobId, { status: 'submitted', finished_at: new Date().toISOString() })
    upsertGame({ job_id: jobId, language: job.language, card0_game_id: gameId, status: 'submitted', submitted_at: new Date().toISOString() })
    emit('jobs:changed', null)
    pumpQueue()
    return { ok: true, error: out.slice(0, 500) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function discardJob(jobId: string): void {
  const run = running.get(jobId)
  if (run) run.kill()
  updateJob(jobId, { status: 'discarded', finished_at: new Date().toISOString() })
  emit('jobs:changed', null)
  pumpQueue()
}

export function restartJob(jobId: string): void {
  updateJob(jobId, { status: 'queued', error: null, stage: null, stage_detail: null, finished_at: null })
  emit('jobs:changed', null)
  pumpQueue()
}

/** Auto-advance: start the next queued job whenever nothing is running. */
export function pumpQueue(): void {
  if (running.size > 0) return
  if (getSetting('autoQueue', 'true') !== 'true') return
  const next = listJobs().find((j) => j.status === 'queued')
  if (next) startJob(next.id)
}

/** On app launch: any job left 'running' from a previous session is interrupted. */
export function recoverInterrupted(): void {
  for (const job of listJobs()) {
    if (job.status === 'running') {
      updateJob(job.id, { status: 'interrupted', finished_at: new Date().toISOString() })
    }
  }
}

export function jobEventsFromDb(jobId: string): unknown[] {
  return listEvents(jobId).map((e) => {
    try {
      return { jobId, seq: e.seq, ts: e.ts, event: JSON.parse(e.payload) }
    } catch {
      return { jobId, seq: e.seq, ts: e.ts, event: { type: e.type } }
    }
  })
}

/** Artifact files for the gallery/review view - images inside the job workspace. */
export function listArtifacts(jobId: string): Array<{ rel: string; dir: string; file: string }> {
  const root = jobWorkspace(jobId)
  const out: Array<{ rel: string; dir: string; file: string }> = []
  for (const dir of ['covers', 'cards_raw', 'compressed', '.']) {
    const dirPath = path.join(root, dir)
    if (!statIsDir(dirPath)) continue
    for (const f of readdirSync(dirPath)) {
      if (/\.(png|jpe?g|webp)$/i.test(f)) {
        const rel = dir === '.' ? f : `${dir}/${f}`
        out.push({ rel, dir: dir === '.' ? '' : dir, file: f })
      }
    }
  }
  return out
}

function statIsDir(p: string): boolean {
  try {
    return require('node:fs').statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function isRunning(jobId: string): boolean {
  return running.has(jobId)
}

/** Open a game in card0 (uses the card0 CLI). */
export function openGame(gameId: string): { ok: boolean; error?: string } {
  try {
    require('node:child_process').execSync(`${CARD0_BIN} game open ${gameId}`, {
      env: shellEnv(),
      timeout: 30_000,
      stdio: 'ignore'
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
