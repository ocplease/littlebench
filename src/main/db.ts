import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { dbPath, workbenchRoot } from './paths'

export type VideoStatus = 'new' | 'triaging' | 'candidate' | 'rejected' | 'queued'
export type JobStatus =
  | 'queued'
  | 'running'
  | 'awaiting_review'
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
}

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  mkdirSync(path.dirname(dbPath()), { recursive: true })
  mkdirSync(path.join(workbenchRoot(), 'jobs'), { recursive: true })
  db = new DatabaseSync(dbPath())
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
      finished_at TEXT
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
  `)
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

export function upsertVideos(videos: Array<Omit<VideoRow, 'id' | 'status' | 'triage_reason' | 'added_at'>>): number {
  const stmt = getDb().prepare(`
    INSERT INTO videos (youtube_id, channel, title, duration_s, url, status)
    VALUES (?, ?, ?, ?, ?, 'new')
    ON CONFLICT(youtube_id) DO UPDATE SET title = excluded.title, duration_s = excluded.duration_s
  `)
  let added = 0
  for (const v of videos) {
    const res = stmt.run(v.youtube_id, v.channel, v.title, v.duration_s, v.url)
    if (Number(res.changes) > 0) added++
  }
  return added
}

export function listVideos(): VideoRow[] {
  return getDb()
    .prepare('SELECT * FROM videos ORDER BY id DESC')
    .all() as unknown as VideoRow[]
}

export function updateVideoStatus(id: number, status: VideoStatus, reason: string | null): void {
  getDb().prepare('UPDATE videos SET status = ?, triage_reason = ? WHERE id = ?').run(status, reason, id)
}

// ---------- jobs ----------

export function insertJob(job: {
  id: string
  video_id: number | null
  title: string
  youtube_url: string | null
  language?: string
  parent_job_id?: string | null
}): void {
  getDb()
    .prepare(
      `INSERT INTO jobs (id, video_id, title, youtube_url, language, parent_job_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'queued')`
    )
    .run(job.id, job.video_id, job.title, job.youtube_url, job.language ?? 'en', job.parent_job_id ?? null)
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
    'result_json', 'session_id', 'started_at', 'finished_at'
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
  return getDb()
    .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq ASC')
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
