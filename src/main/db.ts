import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { dbPath, workbenchRoot } from './paths'

export type VideoStatus = 'new' | 'triaging' | 'candidate' | 'rejected' | 'queued'
export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_review'
  | 'needs_input'
  | 'submitted'
  | 'failed'
  | 'interrupted'
  | 'discarded'

export interface VideoRow {
  id: number
  youtube_id: string
  channel: string
  title: string
  duration_s: number | null
  url: string
  status: VideoStatus
  triage_reason: string | null
  added_at: string
  /** scout funnel (cheap pass) */
  classification: string | null
  fit_score: number | null
  fit_reasons: string | null
  rights_status: string | null
  thumbnail_url: string | null
}

export interface JobRow {
  id: string
  video_id: number | null
  title: string
  youtube_url: string | null
  status: JobStatus
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
  /** workbench protocol (tasks.json) fields */
  phase: string | null
  needs_input: string | null
  /** which Claude model the agent was launched with; null for legacy rows */
  model: string | null
}

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  mkdirSync(path.dirname(dbPath()), { recursive: true })
  mkdirSync(path.join(workbenchRoot(), 'jobs'), { recursive: true })
  db = new DatabaseSync(dbPath())
  // WAL: concurrent readers (GUI) never block on the writer (CLI job / agent events)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  migrate(db)
  return db
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_id TEXT UNIQUE NOT NULL,
      channel TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      duration_s INTEGER,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      triage_reason TEXT,
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      video_id INTEGER,
      title TEXT NOT NULL DEFAULT '',
      youtube_url TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      language TEXT NOT NULL DEFAULT 'en',
      parent_job_id TEXT,
      session_id TEXT,
      stage TEXT,
      stage_detail TEXT,
      error TEXT,
      card0_game_id TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      model TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_job ON events(job_id, seq);

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      card0_game_id TEXT,
      url TEXT,
      name TEXT,
      cover_path TEXT,
      card_count INTEGER,
      status TEXT NOT NULL DEFAULT 'draft',
      submitted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      artifact_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_job ON messages(job_id);

    CREATE TABLE IF NOT EXISTS foreman_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Additive column migrations for DBs created before the factory redesign.
  const addColumns: Array<[string, string, string]> = [
    ['videos', 'classification', 'TEXT'],
    ['videos', 'fit_score', 'REAL'],
    ['videos', 'fit_reasons', 'TEXT'],
    ['videos', 'rights_status', 'TEXT'],
    ['videos', 'thumbnail_url', 'TEXT'],
    ['jobs', 'phase', 'TEXT'],
    ['jobs', 'needs_input', 'TEXT'],
    ['jobs', 'model', 'TEXT']
  ]
  for (const [table, col, type] of addColumns) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
    if (!cols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
    }
  }
}

// ---------- settings ----------

export function getSetting(key: string, fallback: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as unknown as
    | { value: string }
    | undefined
  return row ? row.value : fallback
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

// ---------- videos ----------

export function upsertVideos(
  videos: Array<
    Omit<VideoRow, 'id' | 'status' | 'triage_reason' | 'added_at' | 'classification' | 'fit_score' | 'fit_reasons' | 'rights_status'> & { thumbnail_url?: string | null }
  >
): number {
  const stmt = getDb().prepare(`
    INSERT INTO videos (youtube_id, channel, title, duration_s, url, thumbnail_url, status)
    VALUES (?, ?, ?, ?, ?, ?, 'new')
    ON CONFLICT(youtube_id) DO UPDATE SET title = excluded.title, duration_s = excluded.duration_s,
      thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url)
  `)
  let added = 0
  for (const v of videos) {
    const res = stmt.run(v.youtube_id, v.channel, v.title, v.duration_s, v.url, v.thumbnail_url ?? null)
    if (Number(res.changes) > 0) added++
  }
  return added
}

export function listVideos(): VideoRow[] {
  return getDb()
    .prepare('SELECT * FROM videos ORDER BY id DESC')
    .all() as unknown as VideoRow[]
}

/** Remove a source video. Jobs keep their own title/url copy, so just
 *  detach them - only the scout row itself is deleted. */
export function deleteVideo(id: number): void {
  getDb().prepare('UPDATE jobs SET video_id = NULL WHERE video_id = ?').run(id)
  getDb().prepare('DELETE FROM videos WHERE id = ?').run(id)
}

/** Hard-delete a job: the row itself plus everything referencing it. */
export function deleteJobRows(jobId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM events WHERE job_id = ?').run(jobId)
  db.prepare('DELETE FROM artifacts WHERE job_id = ?').run(jobId)
  db.prepare('DELETE FROM messages WHERE job_id = ?').run(jobId)
  db.prepare('DELETE FROM games WHERE job_id = ?').run(jobId)
  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
}

export function updateVideoStatus(id: number, status: VideoStatus, reason: string | null): void {
  getDb().prepare('UPDATE videos SET status = ?, triage_reason = ? WHERE id = ?').run(status, reason, id)
}

/** Scout verdict: classification, weighted fit score, reasons, rights status. */
export function updateVideoScout(
  id: number,
  scout: {
    classification: string | null
    fit_score: number | null
    fit_reasons: string | null
    rights_status: string | null
  }
): void {
  getDb()
    .prepare('UPDATE videos SET classification = ?, fit_score = ?, fit_reasons = ?, rights_status = ? WHERE id = ?')
    .run(scout.classification, scout.fit_score, scout.fit_reasons, scout.rights_status, id)
}

// ---------- jobs ----------

export function insertJob(job: {
  id: string
  video_id: number | null
  title: string
  youtube_url: string | null
  language?: string
  parent_job_id?: string | null
  model?: string | null
}): void {
  getDb()
    .prepare(
      `INSERT INTO jobs (id, video_id, title, youtube_url, language, parent_job_id, model, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`
    )
    .run(
      job.id,
      job.video_id,
      job.title,
      job.youtube_url,
      job.language ?? 'en',
      job.parent_job_id ?? null,
      job.model ?? null
    )
}

export function listJobs(): JobRow[] {
  return getDb()
    .prepare('SELECT * FROM jobs ORDER BY created_at DESC')
    .all() as unknown as JobRow[]
}

export function getJob(id: string): JobRow | undefined {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined
}

export function updateJob(id: string, fields: Partial<JobRow>): void {
  const allowed: Array<keyof JobRow> = [
    'status', 'stage', 'stage_detail', 'error', 'card0_game_id',
    'result_json', 'session_id', 'started_at', 'finished_at', 'phase', 'needs_input',
    'model'
  ]
  const sets: string[] = []
  const vals: unknown[] = []
  for (const key of allowed) {
    if (key in fields && fields[key] !== undefined) {
      sets.push(`${key} = ?`)
      vals.push(fields[key] as never)
    }
  }
  if (!sets.length) return
  vals.push(id)
  getDb().prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as []))
}

// ---------- events ----------

export interface EventRow {
  id: number
  job_id: string
  seq: number
  ts: string
  type: string
  payload: string
}

export function appendEvent(jobId: string, seq: number, type: string, payload: unknown): void {
  getDb()
    .prepare('INSERT INTO events (job_id, seq, type, payload) VALUES (?, ?, ?, ?)')
    .run(jobId, seq, type, JSON.stringify(payload))
}

export function listEvents(jobId: string): EventRow[] {
  // insertion order = chronological (protocol events share seq 0 with each other)
  return getDb()
    .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id ASC')
    .all(jobId) as unknown as EventRow[]
}

// ---------- games ----------

export interface GameRow {
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

export function upsertGame(game: {
  job_id: string
  language: string
  card0_game_id?: string | null
  url?: string | null
  name?: string | null
  cover_path?: string | null
  card_count?: number | null
  status?: string
  submitted_at?: string
}): void {
  const existing = getDb()
    .prepare('SELECT id FROM games WHERE job_id = ? AND language = ?')
    .get(game.job_id, game.language) as unknown as { id: number } | undefined
  if (existing) {
    getDb()
      .prepare(
        `UPDATE games SET card0_game_id = COALESCE(?, card0_game_id), url = COALESCE(?, url),
         name = COALESCE(?, name), cover_path = COALESCE(?, cover_path),
         card_count = COALESCE(?, card_count), status = COALESCE(?, status),
         submitted_at = COALESCE(?, submitted_at)
         WHERE id = ?`
      )
      .run(
        game.card0_game_id ?? null, game.url ?? null, game.name ?? null, game.cover_path ?? null,
        game.card_count ?? null, game.status ?? null, game.submitted_at ?? null, existing.id
      )
  } else {
    getDb()
      .prepare(
        `INSERT INTO games (job_id, language, card0_game_id, url, name, cover_path, card_count, status, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        game.job_id, game.language, game.card0_game_id ?? null, game.url ?? null, game.name ?? null,
        game.cover_path ?? null, game.card_count ?? null, game.status ?? 'draft', game.submitted_at ?? null
      )
  }
}

export function listGames(): GameRow[] {
  return getDb().prepare('SELECT * FROM games ORDER BY id DESC').all() as unknown as GameRow[]
}

// ---------- artifacts (protocol-declared, distinct from the file gallery) ----------

export interface ArtifactRow {
  id: number
  job_id: string
  type: string
  path: string
  label: string | null
  created_at: string
}

export function upsertArtifact(jobId: string, a: { type: string; path: string; label?: string | null }): void {
  const existing = getDb()
    .prepare('SELECT id FROM artifacts WHERE job_id = ? AND path = ?')
    .get(jobId, a.path) as unknown as { id: number } | undefined
  if (existing) {
    getDb().prepare('UPDATE artifacts SET type = ?, label = ? WHERE id = ?').run(a.type, a.label ?? null, existing.id)
  } else {
    getDb()
      .prepare('INSERT INTO artifacts (job_id, type, path, label) VALUES (?, ?, ?, ?)')
      .run(jobId, a.type, a.path, a.label ?? null)
  }
}

export function listArtifactsByJob(jobId: string): ArtifactRow[] {
  return getDb()
    .prepare('SELECT * FROM artifacts WHERE job_id = ? ORDER BY id ASC')
    .all(jobId) as unknown as ArtifactRow[]
}

// ---------- messages (steering discussion) ----------

export interface MessageRow {
  id: number
  job_id: string
  role: string
  content: string
  artifact_path: string | null
  created_at: string
}

export function insertMessage(jobId: string, role: string, content: string, artifactPath?: string | null): void {
  getDb()
    .prepare('INSERT INTO messages (job_id, role, content, artifact_path) VALUES (?, ?, ?, ?)')
    .run(jobId, role, content, artifactPath ?? null)
}

export function listMessages(jobId: string): MessageRow[] {
  return getDb()
    .prepare('SELECT * FROM messages WHERE job_id = ? ORDER BY id ASC')
    .all(jobId) as unknown as MessageRow[]
}

// ---------- foreman chat ----------

export interface ForemanMessageRow {
  id: number
  role: string
  content: string
  created_at: string
}

export function insertForemanMessage(role: string, content: string): void {
  getDb().prepare('INSERT INTO foreman_messages (role, content) VALUES (?, ?)').run(role, content)
}

export function listForemanMessages(): ForemanMessageRow[] {
  return getDb()
    .prepare('SELECT * FROM foreman_messages ORDER BY id ASC')
    .all() as unknown as ForemanMessageRow[]
}
