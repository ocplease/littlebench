import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { runAgent, AgentRun, ClaudeStreamEvent } from './agent-runner'
import { detectStage } from './stages'
import { jobWorkspace, backLibraryDir, CARD0_BIN, shellEnv } from './paths'
import { installSkills } from './skills'
import { parseProtocol, applyProtocol, PROTOCOL_CONTRACT } from './protocol'
import { agentEnv, coolKey, claudeKeysAvailable, parseQuotaReset } from './keys'
import { insertMessage } from './db'
import { isAuthRequiredError } from './card0-auth'
import type { Attachment } from './attachments'
import {
  getJob, getSetting, setSetting, insertJob, listJobs, updateJob, appendEvent, upsertGame,
  listEvents, deleteJobRows, JobRow
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
/** Which rotated claude key each live job is spending (for 429 cooldown). */
const jobClaudeKeys = new Map<string, string>()

/** Backend quota / rate-limit errors: the job is fine, the plan isn't. */
function quotaError(text: string): boolean {
  return /\b429\b|exceeded.*(quota|limit)|quota.*exceeded|rate.?limit/i.test(text)
}

/** True while the backend quota pause is active; pumpQueue holds off. */
function quotaPaused(): boolean {
  const until = getSetting('quota_until', '')
  if (!until) return false
  return new Date(until) > new Date()
}

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

/** Runtime notes shared by every agent prompt. The backend used to reject
 *  image input, but the current sonnet/minimax-m3 endpoint takes images
 *  fine - agents can Read PNG/JPG/WebP/PDF when they actually need to see
 *  the contents (e.g. an attached reference, a generated card). */
const RUNTIME_NOTES = [
  '- This backend accepts image input, so the Read tool works on image files',
  '  (.png/.jpg/.jpeg/.webp/.gif) and PDFs. Use it when the contents matter.',
  '- For bulk verification of generated card art, prefer cheap metadata first:',
  '  file counts, ls -la, python3 PIL for dimensions - only Read the image when',
  '  you need to actually inspect it. A human still reviews all art visually',
  '  in the workbench gallery before publish.'
].join('\n')

/** When the user disables auto image generation, every prompt gets a rule telling
 *  the agent to PAUSE and ask the user before any card art call (cover and rules
 *  are still auto). The agent writes a needs_input entry to tasks.json and stops;
 *  the user answers in the workspace composer via steerJob, and the agent resumes. */
function imageGenGate(): string {
  if (getSetting('autoImageGen', 'true') !== 'false') return ''
  return [
    '- IMAGE-GENERATION GATE: the user has DISABLED auto image generation for card art.',
    '  The cover image and game-rule visuals still generate automatically, but BEFORE calling',
    '  the byted-ark-seedream-skill for any other card art (animal cards, score cards, token cards,',
    '  or any custom card image), you MUST get explicit user confirmation. Either:',
    '    (a) write a needs_input entry to .workbench/tasks.json with a question listing the',
    '        specific cards you want to generate, then STOP and wait; OR',
    '    (b) finish your turn with a clear question to the user and wait for their reply in',
    '        the workbench chat.',
    '  Do not call byted-ark-seedream-skill for card art until the user confirms. The user\'s',
    '  reply arrives via the same session and you should continue from there.'
  ].join('\n')
}

export function buildGamePrompt(job: JobRow): string {
  // Design-brief job (no video): the human already specified the game in
  // design_brief.md in the workspace - build straight from that.
  if (!job.youtube_url) {
    return [
      'You are running inside an automated workbench. Build a card0 game from the design brief',
      'in design_brief.md in the current directory (your job workspace). Read it FIRST and follow',
      'it exactly - the human designed this game themselves; do not redesign it.',
      '',
      '- Follow the card0-game skill (it dispatches to card0-game-create for the build): run its',
      '  Stages 1 through 8 and Stage 10 reporting, skipping the video-transcript stage.',
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
      '- Card backs: every card needs one (card0 --face back). REUSE FIRST: pick a textless back',
      `  from the shared library at ${backLibraryDir()} and copy it to card_back.jpg in this`,
      '  workspace. Only generate a new back if none fits the theme - and then also cp the new',
      '  back into that library (descriptive theme name) so future games reuse it.',
      RUNTIME_NOTES,
      PROTOCOL_CONTRACT,
      imageGenGate()
    ].filter(Boolean).join('\n')
  }
  const lines = [
    'You are running inside an automated workbench. Create a card0 game from this video:',
    `${job.youtube_url}  (title: "${job.title}")`,
    '',
    '- Follow the card0-game skill (it dispatches to card0-game-create for the build): run its',
    '  Stages 1 through 8 and Stage 10 reporting.',
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
    '- Card backs: every card needs one (card0 --face back). REUSE FIRST: pick a textless back',
    `  from the shared library at ${backLibraryDir()} and copy it to card_back.jpg in this`,
    '  workspace. Only generate a new back if none fits the theme - and then also cp the new',
    '  back into that library (descriptive theme name) so future games reuse it.',
    RUNTIME_NOTES,
    imageGenGate(),
    PROTOCOL_CONTRACT
  ]
  return lines.filter(Boolean).join('\n')
}

export function buildLocalizePrompt(parent: JobRow, language: 'zh-Hans' | 'ja'): string {
  const langName = language === 'zh-Hans' ? 'Simplified Chinese' : 'Japanese'
  return [
    'You are running inside an automated workbench. Create a localized card0 game.',
    `Source English game job workspace: ${jobWorkspace(parent.id)}`,
    `Read its result.json and manifest.json first.`,
    `- Card back: copy the parent workspace's card_back.jpg into this workspace and reuse it`,
    `  as-is (backs are language-neutral). If the parent has none, take a textless back from the`,
    `  shared library at ${backLibraryDir()}; only if that is empty too, generate one textless`,
    `  back and cp it into the library so other games reuse it.`,
    '',
    `Follow the card0-game skill's localization flow (card0-game-create Stage 9 "If localizing`,
    `after the fact"): translate the manifest`,
    `into ${langName} (language code "${language}"), create a NEW card0 game, regenerate ALL artwork`,
    `with ${langName} text rendered on the images, and upload everything.`,
    '- Work inside the current directory (this is your job workspace).',
    '- CRITICAL: Do NOT run `card0 game submit`. A human reviews the cards first.',
    '- Write result.json in this directory with the same shape as the English job.',
    RUNTIME_NOTES,
    PROTOCOL_CONTRACT,
    imageGenGate()
  ].filter(Boolean).join('\n')
}

// ---------- job lifecycle ----------

/** Defensive title cleanup. Callers (the foreman agent, a stale script, a CLI
 *  paste) sometimes hand us the literal stdout of a help command - "Usage:
 *  yt-dlp [OPTIONS] URL [URL...]" is a real example. That text then shows up
 *  on the Factory card and as the workspace title, which is unreadable. We
 *  detect CLI usage / error / stack-trace text and substitute a meaningful
 *  fallback derived from the youtube URL when we have one. */
export function sanitizeTitle(raw: string | null | undefined, opts: { youtubeUrl?: string | null } = {}): string {
  const t = (raw ?? '').trim()
  // A real title is short, has no newlines, and is not a help/error header.
  if (t && isHumanTitle(t)) return t.slice(0, 240)
  // Fall back to a derived name so the card shows something useful.
  if (opts.youtubeUrl) {
    const id = extractYouTubeId(opts.youtubeUrl)
    if (id) return `YouTube ${id}`
  }
  return t ? t.slice(0, 120) : 'Untitled video'
}

function isHumanTitle(t: string): boolean {
  if (!t) return false
  if (t.length > 240) return false
  if (t.includes('\n')) return false
  const lower = t.toLowerCase()
  // Common CLI help / error patterns. Match the start of the string.
  if (/^(usage|error|traceback|exception|fatal|panic)[:\s]/i.test(t)) return false
  if (/\[options\]/i.test(t)) return false // yt-dlp, ffmpeg, curl
  if (/^ytdlp|^yt-dlp\b/i.test(t)) return false
  if (/^\s*at\s+\S+\s+\(.+\.js:\d+:\d+\)\s*$/m.test(t)) return false // node stack frame on its own
  return true
}

/** Pull a YouTube video id (11-char) from any common URL shape. */
function extractYouTubeId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.hostname === 'youtu.be') return u.pathname.replace(/^\//, '').slice(0, 11) || null
    if (u.hostname.endsWith('youtube.com')) {
      const v = u.searchParams.get('v')
      if (v) return v.slice(0, 11)
      const m = u.pathname.match(/\/(shorts|embed|v)\/([^/?#]+)/)
      if (m) return m[2].slice(0, 11)
    }
  } catch { /* not a URL */ }
  return null
}

/** The game name is the human-meaningful identity of a job, so adopt it as
 *  the title as soon as the agent settles on one. Queue-time titles are just
 *  the video title (or a sanitized fallback when even that was CLI garbage).
 *  Localization jobs keep their language suffix; dry-run jobs keep their
 *  marker so queueLocalizations can still skip them. */
function adoptGameTitle(jobId: string, gameName?: string | null): boolean {
  const name = (gameName ?? '').trim()
  if (!name) return false
  const job = getJob(jobId)
  if (!job) return false
  if (job.title.includes('(DRY RUN)')) return false
  const next = job.language !== 'en' ? `${name} (${job.language})` : name
  if (job.title === next) return true
  updateJob(jobId, { title: next.slice(0, 240) })
  emit('jobs:changed', null)
  return true
}

/** Read the game name out of a protocol-declared manifest artifact. Returns
 *  true when a name was found (callers stop scanning after that). */
function adoptTitleFromManifest(jobId: string, artifacts: unknown): boolean {
  if (!Array.isArray(artifacts)) return false
  for (const a of artifacts) {
    if (!a || typeof a !== 'object') continue
    const art = a as { type?: unknown; path?: unknown }
    if (art.type !== 'manifest' || typeof art.path !== 'string' || !art.path) continue
    const file = path.join(jobWorkspace(jobId), art.path)
    if (!existsSync(file)) continue
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { game?: { name?: unknown }; name?: unknown }
      const name = typeof manifest.game?.name === 'string' ? manifest.game.name
        : typeof manifest.name === 'string' ? manifest.name
        : null
      if (adoptGameTitle(jobId, name)) return true
    } catch { /* mid-write or not JSON yet - next poll retries */ }
  }
  return false
}

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
  // Capture the active model at queue time so the Factory card can show what ran
  // this build, even after the user changes the setting later. Empty -> null so
  // the renderer renders "—" instead of a stray empty chip.
  const model = getSetting('model', 'sonnet').trim() || null
  const title = sanitizeTitle(input.title, { youtubeUrl: input.youtube_url ?? null })
  insertJob({
    id,
    video_id: input.video_id ?? null,
    title,
    youtube_url: input.youtube_url ?? null,
    language: input.language ?? 'en',
    parent_job_id: input.parent_job_id ?? null,
    model
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

  // Any job that already has a session resumes it: the agent picks up where it
  // stopped instead of redoing completed stages. Covers both an explicit pause
  // and a build parked back in the queue mid-run.
  if (job.session_id) {
    executeJobWithPrompt(jobId, buildResumePrompt(), { resumeSessionId: job.session_id })
    return
  }

  const prompt =
    job.language === 'en'
      ? buildGamePrompt(job)
      : buildLocalizePrompt(getJob(job.parent_job_id!) ?? job, job.language as 'zh-Hans' | 'ja')

  executeJobWithPrompt(jobId, prompt)
}

/** Message sent into a resumed (paused-mid-build) session. */
function buildResumePrompt(): string {
  return [
    'Your build was paused by the human and is now resumed.',
    'Continue from where you left off in this same workspace - do NOT redo completed stages;',
    'reuse the files already on disk. Finish the pipeline per the original instructions,',
    'maintain .workbench/tasks.json, and write result.json when done.',
    RUNTIME_NOTES,
    PROTOCOL_CONTRACT
  ].join('\n')
}

/** Pause a running build: stop the agent, keep the job in the Building column
 *  with its phase/progress frozen. Resume continues the same session. */
export function pauseJob(jobId: string): void {
  const run = running.get(jobId)
  if (run) run.kill()
  clearLock(jobId)
  updateJob(jobId, { status: 'paused' }) // session_id, phase, stage stay
  emit('jobs:changed', null)
}

/** Resume a paused build now - explicit action, works even while the queue is held. */
export function resumeJob(jobId: string): void {
  const job = getJob(jobId)
  if (!job || job.status !== 'paused') return
  updateJob(jobId, { error: null })
  startJob(jobId) // resumes the session (startJob branches on session_id)
  // All worker slots busy? Park it in the queue; pumpQueue resumes it later.
  const after = getJob(jobId)
  if (after && after.status === 'paused') updateJob(jobId, { status: 'queued' })
  emit('jobs:changed', null)
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
  installSkills(workspace) // project-level skills for the headless session

  const model = getSetting('model', 'sonnet')
  const bypass = getSetting('bypassPermissions', 'true') === 'true'

  updateJob(jobId, { status: 'running', started_at: new Date().toISOString(), error: null })

  let seq = 0

  // workbench protocol: poll the agent-maintained tasks.json and mirror it
  let prevProtocolJson: string | null = null
  let titleFromManifest = false
  const pollProtocol = () => {
    const parsed = parseProtocol(jobId)
    if (!parsed) return
    if (applyProtocol(jobId, parsed, prevProtocolJson)) prevProtocolJson = JSON.stringify(parsed)
    // As soon as the design phase lands the manifest, retitle the job with
    // the game's name (once; result.json re-checks at the end).
    if (!titleFromManifest) titleFromManifest = adoptTitleFromManifest(jobId, parsed.artifacts)
  }

  const keyEnv = agentEnv()
  if (keyEnv.ANTHROPIC_AUTH_TOKEN) jobClaudeKeys.set(jobId, keyEnv.ANTHROPIC_AUTH_TOKEN)

  const run = runAgent({
    cwd: workspace,
    prompt,
    model: model || undefined,
    env: Object.keys(keyEnv).length ? keyEnv : undefined,
    bypassPermissions: bypass,
    // A job that already has a session always resumes it (--resume) - passing
    // its id via --session-id would collide ("Session ID already in use").
    resumeSessionId: opts.resumeSessionId ?? (job.session_id ?? undefined),
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
        } else if (quotaError(String(event.result ?? ''))) {
          // Backend quota exhausted: transient, not the job's fault. Cool the
          // key this job was spending and park the job back in the queue. If
          // other keys remain, the next run rotates to one of them; only pause
          // the whole queue when the pool is dry (or no pool is configured).
          const errText = String(event.result ?? '')
          const fallback = new Date(Date.now() + 30 * 60 * 1000).toISOString()
          const spent = jobClaudeKeys.get(jobId)
          if (spent) {
            const until = parseQuotaReset(errText) ?? fallback
            coolKey(spent, until)
            if (!claudeKeysAvailable()) setSetting('quota_until', until)
          } else {
            setSetting('quota_until', fallback)
          }
          updateJob(jobId, {
            status: 'queued',
            error: errText,
            finished_at: null,
            session_id: null // fresh run; workspace artifacts are reused
          })
          emit('jobs:changed', null)
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
      jobClaudeKeys.delete(jobId)
      clearInterval(protocolTimer)
      clearLock(jobId)
      pollProtocol() // catch a final write the stream events didn't cover
      const current = getJob(jobId)
      // 143 = SIGTERM, 130 = SIGINT: the workbench (or the OS) stopped the
      // agent, it didn't fail on its own. stopJob already set its own status,
      // so reaching here with one of those codes means an external kill -
      // put the job back in the queue so the next launch auto-resumes it.
      // (Deliberate stops and crash leftovers stay 'interrupted' for manual
      // restart: stopJob sets that status before the kill takes effect.)
      const killed = shuttingDown || code === 143 || code === 130
      if (current && current.status === 'running') {
        // exited without a result event
        updateJob(jobId, {
          status: code === 0 ? 'awaiting_review' : killed ? 'queued' : 'failed',
          error: code === 0 || killed ? null : `agent exited with code ${code}`,
          finished_at: code === 0 || !killed ? new Date().toISOString() : null,
          session_id: killed ? null : current.session_id
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
  adoptGameTitle(jobId, game?.gameName)
  updateJob(jobId, {
    status: finalStatus(jobId),
    card0_game_id: game?.gameId ?? null,
    result_json: game ? JSON.stringify(game) : null,
    finished_at: new Date().toISOString()
  })
  recordGame(jobId, game)
  const finished = getJob(jobId)
  if (finished) queueLocalizations(finished)
  emit('jobs:changed', null)
}

/** Every game ships in three languages: when the English build lands in review,
 *  queue zh-Hans and ja localization jobs (unless they already exist). */
function queueLocalizations(parent: JobRow): void {
  if (getSetting('autoLocalize', 'true') !== 'true') return
  if (parent.language !== 'en') return
  if (parent.title.endsWith('(DRY RUN)')) return // test builds never localize
  const existing = listJobs().filter((j) => j.parent_job_id === parent.id)
  let added = false
  for (const lang of ['zh-Hans', 'ja'] as const) {
    if (existing.some((c) => c.language === lang)) continue
    createJob({
      title: `${parent.title} (${lang})`,
      youtube_url: parent.youtube_url,
      language: lang,
      parent_job_id: parent.id,
      autostart: false
    })
    added = true
  }
  if (added) pumpQueue()
}

/** Agent finished its pass: awaiting review, or blocked on a human question. */
function finalStatus(jobId: string): 'awaiting_review' | 'needs_input' {
  const protocol = parseProtocol(jobId)
  return protocol?.needs_input ? 'needs_input' : 'awaiting_review'
}

/** Agent exited cleanly but we never saw a result event - try result.json anyway. */
function finalizeFromDisk(jobId: string): void {
  const game = parseResultJson(jobId)
  adoptGameTitle(jobId, game?.gameName)
  updateJob(jobId, { status: finalStatus(jobId), finished_at: new Date().toISOString() })
  recordGame(jobId, game)
  const finished = getJob(jobId)
  if (finished) queueLocalizations(finished)
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

/** Ask card0 for the game's real status. The human may have published it
 *  directly on the card0 site - mirror that here instead of offering
 *  "Approve & publish" again for an already-live game. */
export function syncJobStatus(jobId: string): { ok: boolean; status?: string; error?: string } {
  const job = getJob(jobId)
  if (!job) return { ok: false, error: 'job not found' }
  if (!job.card0_game_id) return { ok: false, error: 'no card0 game yet' }
  if (!['awaiting_review', 'needs_input', 'interrupted', 'failed'].includes(job.status)) {
    return { ok: true, status: job.status }
  }
  try {
    const out = execSync(`${CARD0_BIN} game show ${job.card0_game_id}`, {
      encoding: 'utf8',
      env: shellEnv(),
      timeout: 30_000
    })
    const remote = JSON.parse(out) as { status?: string }
    if (remote.status === 'published' || remote.status === 'submitted') {
      updateJob(jobId, { status: 'submitted', finished_at: new Date().toISOString() })
      upsertGame({
        job_id: jobId,
        language: job.language,
        card0_game_id: job.card0_game_id,
        status: 'published',
        submitted_at: new Date().toISOString()
      })
      emit('jobs:changed', null)
      return { ok: true, status: 'published' }
    }
    return { ok: true, status: remote.status ?? 'draft' }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e)
    return { ok: false, error: rewriteCard0Error(raw) }
  }
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
    const raw = e instanceof Error ? e.message : String(e)
    return { ok: false, error: rewriteCard0Error(raw) }
  }
}

export function discardJob(jobId: string): void {
  const run = running.get(jobId)
  if (run) run.kill()
  clearLock(jobId)
  updateJob(jobId, { status: 'discarded', finished_at: new Date().toISOString() })
  // A rejected game must not get localized: drop queued/interrupted children.
  for (const child of listJobs().filter((j) => j.parent_job_id === jobId)) {
    if (child.status === 'queued' || child.status === 'interrupted') {
      clearLock(child.id)
      updateJob(child.id, { status: 'discarded', finished_at: new Date().toISOString() })
    }
  }
  emit('jobs:changed', null)
  pumpQueue()
}

/** Hard-delete a job: DB rows (events, artifacts, messages, games) AND its
 *  workspace on disk. Children (localization jobs) go with it. Unlike
 *  discard, this is unrecoverable - the board just forgets the job. */
export function deleteJob(jobId: string): void {
  const run = running.get(jobId)
  if (run) run.kill()
  clearLock(jobId)
  for (const child of listJobs().filter((j) => j.parent_job_id === jobId)) {
    deleteJob(child.id)
  }
  deleteJobRows(jobId)
  rmSync(jobWorkspace(jobId), { recursive: true, force: true })
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
export function steerJob(jobId: string, message: string, attachments?: Attachment[]): { ok: boolean; error?: string } {
  const job = getJob(jobId)
  if (!job) return { ok: false, error: 'job not found' }
  if (job.status === 'running' || running.has(jobId) || jobIsLive(job)) {
    return { ok: false, error: 'worker is actively running this job - steer after it finishes this pass' }
  }
  if (liveRunCount(jobId) >= maxWorkers()) {
    return { ok: false, error: `all ${maxWorkers()} worker slots busy` }
  }
  if (!job.session_id) return { ok: false, error: 'no session to resume - use Restart instead' }

  // Persist the first attachment as the message's artifact_path for the
  // history view; the full list lives in the message content.
  const first = attachments?.[0]
  insertMessage(jobId, 'user', message, first?.path ?? null)

  const ctx = buildAttachmentContext(attachments)
  const prompt = [
    'The human reviewing this game sent you a message. Apply it now:',
    '',
    `"${message}"`,
    ctx,
    '',
    'Continue in this same workspace. Update .workbench/tasks.json as you work.',
    'If you change the card0 game, update result.json afterwards.',
    'Do NOT run `card0 game submit` - the human still reviews before publishing.',
    RUNTIME_NOTES
  ].join('\n')

  executeJobWithPrompt(jobId, prompt, { resumeSessionId: job.session_id })
  return { ok: true }
}

function buildAttachmentContext(attachments: Attachment[] | undefined): string {
  if (!attachments || attachments.length === 0) return ''
  const lines: string[] = ['\n\nThe user attached these files (all paths are in the current workspace):']
  for (const a of attachments) {
    lines.push(`- ${a.name}  (${a.type}, ${(a.size / 1024).toFixed(1)} KB)  -> ${a.path}`)
    if (a.content !== undefined) {
      lines.push('  Content:')
      lines.push('  ```')
      lines.push(a.content.replace(/\n/g, '\n  '))
      lines.push('  ```')
    }
  }
  return lines.join('\n')
}

/** Auto-advance: keep up to maxWorkers agents running. */
export function pumpQueue(): void {
  if (shuttingDown) return // never spawn agents from a dying process
  if (getSetting('autoQueue', 'true') !== 'true') return
  if (quotaPaused()) return // quota window exhausted; retry when it lapses
  const slots = maxWorkers() - liveRunCount()
  if (slots <= 0) return
  // Paused builds rejoin automatically once the queue is resumed.
  const queued = listJobs().filter((j) => j.status === 'queued' || j.status === 'paused')
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
    const raw = e instanceof Error ? e.message : String(e)
    return { ok: false, error: rewriteCard0Error(raw) }
  }
}

/** Friendly rewrite for the common "session expired" failure from the card0
 *  CLI. Anything else is returned as-is. */
function rewriteCard0Error(raw: string): string {
  if (isAuthRequiredError(raw)) {
    return 'card0 session expired — open Settings to sign in.'
  }
  return raw
}
