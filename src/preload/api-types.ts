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
}

export interface Job {
  id: string
  video_id: number | null
  title: string
  youtube_url: string | null
  status: 'queued' | 'running' | 'awaiting_review' | 'submitted' | 'failed' | 'interrupted' | 'discarded'
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

export interface Settings {
  model: string
  triageModel: string
  autoQueue: string
  bypassPermissions: string
  maxVideos: string
}

export interface IngestResult {
  added: number
  total: number
}

export interface ApproveResult {
  ok: boolean
  error?: string
}

export interface WorkbenchApi {
  getSettings(): Promise<Settings>
  setSettings(s: Record<string, string>): Promise<boolean>

  listVideos(): Promise<Video[]>
  setVideoStatus(id: number, status: string, reason: string | null): Promise<void>
  ingestChannel(url: string, max?: number): Promise<IngestResult>
  runTriage(videoIds: number[]): Promise<boolean>

  listJobs(): Promise<Job[]>
  getJob(id: string): Promise<Job | null>
  queueVideos(videos: Array<{ id: number; title: string; url: string }>): Promise<string[]>
  startJob(id: string): Promise<boolean>
  stopJob(id: string): Promise<boolean>
  approveJob(id: string): Promise<ApproveResult>
  discardJob(id: string): Promise<boolean>
  restartJob(id: string): Promise<boolean>
  jobEvents(id: string): Promise<unknown[]>
  localizeJob(jobId: string, language: string): Promise<string | null>

  listGames(): Promise<Game[]>
  openGame(gameId: string): Promise<ApproveResult>
  listArtifacts(jobId: string): Promise<Artifact[]>
  readArtifact(jobId: string, rel: string): Promise<string | null>

  bootstrap(): Promise<boolean>
  on(channel: string, cb: (payload: unknown) => void): () => void
}
