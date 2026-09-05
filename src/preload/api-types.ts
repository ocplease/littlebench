/** Shared API surface between preload and renderer.
 *  Deliberately free of electron imports so both tsconfig programs can use it. */

export interface Video {
  id: number
  youtube_id: string
  channel: string
  title: string
  duration_s: number | null
  url: string
  status: 'new' | 'triaging' | 'candidate' | 'rejected' | 'queued'
  triage_reason: string | null
  added_at: string
  /** scout funnel */
  classification: string | null
  fit_score: number | null
  fit_reasons: string | null
  rights_status: string | null
  thumbnail_url: string | null
}

export interface Job {
  id: string
  video_id: number | null
  title: string
  youtube_url: string | null
  status: 'queued' | 'running' | 'paused' | 'awaiting_review' | 'needs_input' | 'submitted' | 'failed' | 'interrupted' | 'discarded'
  language: string
  parent_job_id: string | null
  session_id: string | null
  stage: string | null
  stage_detail: string | null
  error: string | null
  card0_game_id: string | null
  result_json: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  /** workbench protocol */
  phase: string | null
  needs_input: string | null
  /** which Claude model the agent was launched with; null for legacy rows */
  model: string | null
  origin: string
  external_request_id: string | null
}

export interface Game {
  id: number
  job_id: string
  language: string
  card0_game_id: string | null
  url: string | null
  name: string | null
  cover_path: string | null
  card_count: number | null
  status: string
  submitted_at: string | null
}

export interface Artifact {
  rel: string
  dir: string
  file: string
}

/** Protocol-declared artifact (from .workbench/tasks.json). */
export interface ProtocolArtifactRow {
  id: number
  job_id: string
  type: string
  path: string
  label: string | null
  created_at: string
}

export interface Message {
  id: number
  job_id: string
  role: string
  content: string
  artifact_path: string | null
  created_at: string
}

export interface Settings {
  model: string
  triageModel: string
  autoQueue: string
  bypassPermissions: string
  maxVideos: string
  maxWorkers: string
  quotaUntil: string
  autoLocalize: string
  claudeApiKeys: string
  imageApiKeys: string
  keyPool: { total: number; cooling: number; nextAvailable?: string }
  autoImageGen: 'true' | 'false'
}

export interface IngestResult {
  added: number
  total: number
}

/** A file the user attached in a chat / job composer. Carries a path so
 *  agents with filesystem access can read it, and an inline `content` for
 *  small text files so agents that can't (e.g. the foreman, restricted to
 *  the lb CLI) can still act on the contents. */
export interface Attachment {
  name: string
  path: string
  size: number
  type: string
  content?: string
}

export interface ApproveResult {
  ok: boolean
  error?: string
}

export interface Card0Account {
  id?: string
  email?: string
  name?: string
  avatar_url?: string
  [key: string]: unknown
}

export type Card0AccountInfo =
  | { ok: true; account: Card0Account }
  | { ok: false; reason: 'auth_required' | 'unknown'; message: string }

export type Card0AuthResult =
  | { ok: true; url?: string }
  | { ok: false; error: string }

/** One part of a saved foreman turn - the same items the live process feed
 *  showed, replayed under the message after a restart. */
export interface ForemanPartItem {
  kind: 'thinking' | 'tool' | 'text'
  text: string
  preview?: string
  detail?: string
  result?: string
  error?: boolean
}

export interface ForemanTurnParts {
  tools: number
  seconds: number
  items: ForemanPartItem[]
}

export interface ForemanMessage {
  id: number
  role: string
  content: string
  created_at: string
  parts?: ForemanTurnParts | null
}

export interface WorkbenchApi {
  getSettings(): Promise<Settings>
  setSettings(s: Record<string, string>): Promise<boolean>

  listVideos(): Promise<Video[]>
  setVideoStatus(id: number, status: string, reason: string | null): Promise<void>
  deleteVideo(id: number): Promise<void>
  ingestChannel(url: string, max?: number): Promise<IngestResult>
  runTriage(videoIds: number[]): Promise<boolean>
  deepScout(videoId: number): Promise<{ ok: boolean; error?: string }>

  listJobs(): Promise<Job[]>
  getJob(id: string): Promise<Job | null>
  queueVideos(videos: Array<{ id: number; title: string; url: string }>): Promise<string[]>
  startJob(id: string): Promise<boolean>
  stopJob(id: string): Promise<boolean>
  pauseJob(id: string): Promise<boolean>
  syncJobStatus(id: string): Promise<{ ok: boolean; status?: string; error?: string }>
  resumeJob(id: string): Promise<boolean>
  approveJob(id: string): Promise<ApproveResult>
  discardJob(id: string): Promise<boolean>
  deleteJob(id: string): Promise<boolean>
  restartJob(id: string): Promise<boolean>
  jobEvents(id: string): Promise<unknown[]>
  localizeJob(jobId: string, language: string): Promise<string | null>
  steerJob(id: string, message: string, attachments?: Attachment[]): Promise<ApproveResult>
  pickAttachments(target: 'foreman' | string): Promise<Attachment[]>
  jobIsLive(id: string): Promise<boolean>
  jobMessages(id: string): Promise<Message[]>

  listGames(): Promise<Game[]>
  openGame(gameId: string): Promise<ApproveResult>
  listArtifacts(jobId: string): Promise<Artifact[]>
  listProtocolArtifacts(jobId: string): Promise<ProtocolArtifactRow[]>
  readArtifact(jobId: string, rel: string): Promise<string | null>
  readTextArtifact(jobId: string, rel: string): Promise<string | null>

  bootstrap(): Promise<boolean>

  // foreman chat
  foremanSend(message: string): Promise<ApproveResult>
  foremanMessages(): Promise<ForemanMessage[]>
  foremanBusy(): Promise<boolean>
  foremanStop(): Promise<void>
  foremanReset(): Promise<void>

  // card0 account / auth
  card0AccountInfo(): Promise<Card0AccountInfo>
  card0LoginWeb(opts?: { provider?: 'google' }): Promise<Card0AuthResult>
  card0Logout(): Promise<Card0AuthResult>

  on(channel: string, cb: (payload: unknown) => void): () => void
}
