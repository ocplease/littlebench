import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { runAgent, AgentRun, ClaudeStreamEvent } from './agent-runner'
import { detectStage } from './stages'
import { jobWorkspace, CARD0_BIN, shellEnv } from './paths'
import { parseProtocol, applyProtocol, PROTOCOL_CONTRACT } from './protocol'
import { insertMessage } from './db'
import {
  getJob, getSetting, insertJob, listJobs, updateJob, appendEvent, upsertGame,
  listEvents, JobRow
} from './db'

type Broadcast = (channel: string, payload: unknown) => void

let broadcast: Broadcast = () => {}
export function setBroadcast(fn: Broadcast): void {
  broadcast = fn
}

/** Set during app shutdown: job exit handlers mark agents interrupted
 *  instead of failed, and pumpQueue stops spawning replacements that would
 *  instantly become orphans of the dying process. */
let shuttingDown = false
export function setShuttingDown(): void {
  shuttingDown = true
}

const running = new Map<string, AgentRun>()

function emit(channel: string, payload: unknown): void {
  broadcast(channel, payload)
}

// ---------- cross-process run guard ----------
// The GUI app and the CLI driver can be alive at the same time and share the
// SQLite DB. A job writes its agent PID into the workspace so any process can
// tell "running in another process" from "leftover from a crash".

function lockPath(jobId: string): string {
  return path.join(jobWorkspace(jobId), '.agent.pid')
}

function writeLock(jobId: string, pid: number): void {
  try {
    writeFileSync(lockPath(jobId), String(pid))
  } catch { /* workspace might have been removed */ }
}

function clearLock(jobId: string): void {
  try {
    unlinkSync(lockPath(jobId))
  } catch { /* already gone */ }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means the process exists but is owned by someone else
    return e instanceof Error && (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A job in 'running' state whose agent process is still alive (in this or another process). */
export function jobIsLive(job: JobRow): boolean {
  if (running.has(job.id)) return true
  try {
    const raw = readFileSync(lockPath(job.id), 'utf8').trim()
    const pid = Number(raw)
    return Number.isFinite(pid) && pid > 0 && pidIsAlive(pid)
  } catch {
    return false
  }
}

function anyLiveRun(exceptJobId?: string): boolean {
  return listJobs().some((j) => j.status === 'running' && j.id !== exceptJobId && jobIsLive(j))
}

/** How many agents are actually running (this process + lockfiles elsewhere). */
function liveRunCount(exceptJobId?: string): number {
  return listJobs().filter((j) => j.status === 'running' && j.id !== exceptJobId && jobIsLive(j)).length
}

/** Max concurrent builder sessions (design: 3 workers). */
function maxWorkers(): number {
  const n = Number(getSetting('maxWorkers', '3'))
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3
}

// ---------- prompts ----------

/** Backend constraint shared by all prompts: this model endpoint rejects image input. */
const NO_IMAGE_INPUT = [
  '- RUNTIME CONSTRAINT (critical): this backend REJECTS image input. NEVER use the Read tool on',
  '  image files (.png/.jpg/.jpeg/.webp) or PDF files - the request fails with',
  '  "400 Model only support text input" and the session dies. If a WebFetch result is a PDF,',
  '  do not Read it - find a text source instead.',
  '- Verify generated art via metadata ONLY: file counts, sizes (ls -la), dimensions via',
  '  python3 PIL. A human reviews all art visually in the workbench gallery before submit.'
].join('\n')

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
    '- Use the byted-ark-seedream-skill for all image generation; save generated art under',
    '  this workspace (cards_raw/ for PNGs, compressed/ for JPEGs).',
    NO_IMAGE_INPUT,
    PROTOCOL_CONTRACT
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
    NO_IMAGE_INPUT,
    PROTOCOL_CONTRACT
  ].join('\n')
}

// ---------- job lifecycle ----------

export function createJob(input: {
  video_id?: number | null
  title: string
  youtube_url?: string | null
  language?: string
  parent_job_id?: string | null
  /** Start the agent immediately (GUI default). CLI `queue` passes false - a short-lived
   *  process must not spawn an agent whose event handlers die with it. */
  autostart?: boolean
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
  if (input.autostart !== false) pumpQueue()
  return id
}

export function startJob(jobId: string): void {
  const job = getJob(jobId)
  if (!job || job.status === 'running' || running.has(jobId)) return
  if (liveRunCount(jobId) >= maxWorkers()) return // all worker slots busy

  const prompt =
    job.language === 'en'
      ? buildGamePrompt(job)
      : buildLocalizePrompt(getJob(job.parent_job_id!) ?? job, job.language as 'zh-Hans' | 'ja')

  executeJobWithPrompt(jobId, prompt)
}

/** Run a job with an explicit prompt (used by startJob, steering and the CLI driver). */
export function executeJobWithPrompt(
  jobId: string,
  prompt: string,
  opts: { resumeSessionId?: string } = {}
): void {
  const job = getJob(jobId)
  if (!job || job.status === 'running' || running.has(jobId)) return
  if (!opts.resumeSessionId && liveRunCount(jobId) >= maxWorkers()) return

  const workspace = jobWorkspace(jobId)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(path.join(workspace, '.workbench'), { recursive: true })

  const model = getSetting('model', '')
  const bypass = getSetting('bypassPermissions', 'true') === 'true'

  updateJob(jobId, { status: 'running', started_at: new Date().toISOString(), error: null })

  let seq = 0

  // workbench protocol: poll the agent-maintained tasks.json and mirror it
  let prevProtocolJson: string | null = null
  const pollProtocol = () => {
    const parsed = parseProtocol(jobId)
    if (parsed) prevProtocolJson = applyProtocol(jobId, parsed, prevProtocolJson) ? JSON.stringify(parsed) : prevProtocolJson
  }

  const run = runAgent({
    cwd: workspace,
    prompt,
    model: model || undefined,
    bypassPermissions: bypass,
    sessionId: opts.resumeSessionId ? undefined : (job.session_id ?? undefined),
    resumeSessionId: opts.resumeSessionId,
    onEvent: (event) => {
      // Noise filter: thinking-token streams (thousands per job), hook chatter and
      // tool progress are not worth persisting or shipping over IPC.
      if (event.type === 'tool_progress') return
      if (event.type === 'system' && event.subtype !== 'init') return
      seq++
      appendEvent(jobId, seq, event.type, event)
      emit('job:event', { jobId, event })
      const stage = detectStage(event)
      if (stage) {
        updateJob(jobId, { stage: stage.stage, stage_detail: stage.detail ?? null })
        emit('job:stage', { jobId, ...stage })
      }
      pollProtocol() // cheap: no-op unless the file changed
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
      clearInterval(protocolTimer)
      clearLock(jobId)
      pollProtocol() // catch a final write the stream events didn't cover
      const current = getJob(jobId)
      // 143 = SIGTERM, 130 = SIGINT: the workbench (or the OS) stopped the
      // agent, it didn't fail on its own. stopJob already set its own status,
      // so reaching here with one of those codes means an external kill.
      const interrupted = shuttingDown || code === 143 || code === 130
      if (current && current.status === 'running') {
        // exited without a result event
        updateJob(jobId, {
          status: code === 0 ? 'awaiting_review' : interrupted ? 'interrupted' : 'failed',
          error: code === 0 || interrupted ? null : `agent exited with code ${code}`,
          finished_at: new Date().toISOString()
        })
        if (code === 0) finalizeFromDisk(jobId)
      }
      emit('jobs:changed', null)
      if (!shuttingDown) pumpQueue()
    }
  })

  const protocolTimer = setInterval(pollProtocol, 2000)
  protocolTimer.unref()

  running.set(jobId, run)
  writeLock(jobId, run.process.pid ?? -1)
  emit('jobs:changed', null)
}

function finalizeJob(jobId: string, result: ClaudeStreamEvent): void {
  const game = parseResultJson(jobId)
  updateJob(jobId, {
    status: finalStatus(jobId),
    card0_game_id: game?.gameId ?? null,
    result_json: game ? JSON.stringify(game) : null,
    finished_at: new Date().toISOString()
  })
  recordGame(jobId, game)
  emit('jobs:changed', null)
}

/** Agent finished its pass: awaiting review, or blocked on a human question. */
function finalStatus(jobId: string): 'awaiting_review' | 'needs_input' {
  const protocol = parseProtocol(jobId)
  return protocol?.needs_input ? 'needs_input' : 'awaiting_review'
}

/** Agent exited cleanly but we never saw a result event - try result.json anyway. */
function finalizeFromDisk(jobId: string): void {
  const game = parseResultJson(jobId)
  updateJob(jobId, { status: finalStatus(jobId), finished_at: new Date().toISOString() })
  recordGame(jobId, game)
  emit('jobs:changed', null)
}

function recordGame(jobId: string, game: JobResult | null): void {
  if (!game?.gameId) return
  upsertGame({
    job_id: jobId,
    language: getJob(jobId)?.language ?? 'en',
    card0_game_id: game.gameId,
    name: game.gameName ?? null,
    cover_path: resolveWorkspacePath(jobId, game.coverPath),
    card_count: game.cardCount ?? null,
    status: 'awaiting_review'
  })
}

/** Agents may write coverPath as relative (compressed/cover.jpg) or absolute
 *  (possibly against a relocated workbench root). Normalize to a real path
 *  inside this workspace, falling back to a compressed/ basename match. */
function resolveWorkspacePath(jobId: string, p?: string): string | null {
  if (!p) return null
  const ws = jobWorkspace(jobId)
  const candidates = path.isAbsolute(p) ? [p, path.join(ws, path.basename(p))] : [path.join(ws, p)]
  for (const c of candidates) {
    if (existsSync(c) && c.startsWith(ws + path.sep)) return c
  }
  return null
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
  clearLock(jobId)
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
    const out = execSync(`${CARD0_BIN} game submit --yes ${gameId}`, {
      encoding: 'utf8',
      env: shellEnv(),
      timeout: 60_000
    })
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
  clearLock(jobId)
  updateJob(jobId, { status: 'discarded', finished_at: new Date().toISOString() })
  emit('jobs:changed', null)
  pumpQueue()
}

export function restartJob(jobId: string): void {
  updateJob(jobId, {
    status: 'queued', error: null, stage: null, stage_detail: null, finished_at: null,
    session_id: null, // fresh session; workspace artifacts on disk are reused
    phase: null, needs_input: null
  })
  emit('jobs:changed', null)
  pumpQueue()
}

/** Steering: send the human's instruction into the job's session.
 *  Works when no worker is actively running the job - we resume the existing
 *  claude session with the message (plus artifact context if attached), run it
 *  through the same event pipeline, and land back in review/needs_input.
 *  Mid-run injection (streaming stdin) is future work. */
export function steerJob(jobId: string, message: string, artifactPath?: string | null): { ok: boolean; error?: string } {
  const job = getJob(jobId)
  if (!job) return { ok: false, error: 'job not found' }
  if (job.status === 'running' || running.has(jobId) || jobIsLive(job)) {
    return { ok: false, error: 'worker is actively running this job - steer after it finishes this pass' }
  }
  if (liveRunCount(jobId) >= maxWorkers()) {
    return { ok: false, error: `all ${maxWorkers()} worker slots busy` }
  }
  if (!job.session_id) return { ok: false, error: 'no session to resume - use Restart instead' }

  insertMessage(jobId, 'user', message, artifactPath ?? null)

  const context = artifactPath
    ? `\n\nThe user is referring to this artifact: ${artifactPath} (in the current workspace).`
    : ''
  const prompt = [
    'The human reviewing this game sent you a message. Apply it now:',
    '',
    `"${message}"`,
    context,
    '',
    'Continue in this same workspace. Update .workbench/tasks.json as you work.',
    'If you change the card0 game, update result.json afterwards.',
    'Do NOT run `card0 game submit` - the human still reviews before publishing.',
    NO_IMAGE_INPUT
  ].join('\n')

  executeJobWithPrompt(jobId, prompt, { resumeSessionId: job.session_id })
  return { ok: true }
}

/** Auto-advance: keep up to maxWorkers agents running. */
export function pumpQueue(): void {
  if (shuttingDown) return // never spawn agents from a dying process
  if (getSetting('autoQueue', 'true') !== 'true') return
  const slots = maxWorkers() - liveRunCount()
  if (slots <= 0) return
  const queued = listJobs().filter((j) => j.status === 'queued')
  for (const job of queued.slice(0, slots)) {
    startJob(job.id)
  }
}

/** On app launch: a 'running' job with a dead agent PID is a crash leftover. */
export function recoverInterrupted(): void {
  for (const job of listJobs()) {
    if (job.status === 'running' && !jobIsLive(job)) {
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
    return statSync(p).isDirectory()
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
    execSync(`${CARD0_BIN} game open ${gameId}`, {
      env: shellEnv(),
      timeout: 30_000,
      stdio: 'ignore'
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
