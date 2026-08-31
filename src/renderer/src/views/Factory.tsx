import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Job, Video, Game } from '../types'
import { STAGE_LIST, phaseLabel, STATUS_LABEL } from '../types'

interface Props {
  jobs: Job[]
  videos: Video[]
  games: Game[]
  maxWorkers: number
  quotaUntil: string
  autoQueue: boolean
  onOpenJob: (jobId: string) => void
  onChanged: () => void
  onGoSources: () => void
}

/** Board column: shows the first `initial` items, then expands in +5 steps. */
function Column<T>({ title, className, items, empty, render }: {
  title: string
  className?: string
  items: T[]
  empty: ReactNode
  render: (item: T, index: number) => ReactNode
}) {
  const [limit, setLimit] = useState(10)
  const visible = items.slice(0, limit)
  const hidden = items.length - visible.length
  return (
    <section className={`board-col ${className ?? ''}`}>
      <header>{title} <span className="col-count">{items.length}</span></header>
      {items.length === 0 && <div className="board-empty">{empty}</div>}
      {visible.map(render)}
      {hidden > 0 && (
        <button className="link col-more" onClick={() => setLimit((n) => n + 5)}>
          +5 more · {hidden} hidden
        </button>
      )}
    </section>
  )
}

/** Linear-style board: the agent company at a glance. */
export default function Factory({ jobs, videos, games, maxWorkers, quotaUntil, autoQueue, onOpenJob, onChanged, onGoSources }: Props) {
  const active = jobs.filter((j) => j.status === 'running')
  const building = jobs.filter((j) => j.status === 'running' || j.status === 'paused')
  const queued = jobs.filter((j) => j.status === 'queued')
  const review = jobs.filter((j) => j.status === 'awaiting_review' || j.status === 'needs_input' || j.status === 'interrupted' || j.status === 'failed')
  const candidates = videos.filter((v) => v.status === 'candidate')
  const published = games.filter((g) => g.status === 'submitted' || g.status === 'published')
  const quotaPaused = quotaUntil && new Date(quotaUntil) > new Date()

  const videoById = new Map(videos.map((v) => [v.id, v]))

  /** Pause = stop every running builder and hold the queue (jobs stay parked,
   *  restartable from their cards). Resume lets pumpQueue fill the slots again. */
  const togglePause = async () => {
    if (autoQueue) {
      await window.api.setSettings({ autoQueue: 'false' })
      for (const j of active) await window.api.pauseJob(j.id)
    } else {
      await window.api.setSettings({ autoQueue: 'true' })
    }
  }

  return (
    <div className="factory">
      <div className="factory-header">
        <h1>Factory</h1>
        <div className="workers-badge">
          Workers
          <span className="worker-dots">
            {Array.from({ length: maxWorkers }, (_, i) => (
              <span key={i} className={`worker-dot ${i < active.length ? 'on' : ''}`} />
            ))}
          </span>
          {active.length} / {maxWorkers} active
        </div>
        {(building.length > 0 || !autoQueue) && (
          <button className={`small-btn pause-toggle ${autoQueue ? '' : 'paused'}`} onClick={togglePause}>
            {autoQueue ? '⏸ Pause' : '▶ Resume queue'}
          </button>
        )}
      </div>

      {!autoQueue && !quotaPaused && (
        <div className="quota-note">Queue is paused - no new builds start until you resume.</div>
      )}

      {quotaPaused && (
        <div className="quota-note">
          Backend quota exhausted - queued builds resume automatically after{' '}
          {new Date(quotaUntil).toLocaleTimeString()}.
        </div>
      )}

      <div className="board">
        <Column
          title="Candidates"
          items={candidates}
          empty={<div className="board-empty">No candidates. <button className="link" onClick={onGoSources}>Add a YouTube channel</button> and run the scout.</div>}
          render={(v) => <CandidateCard key={v.id} video={v} onChanged={onChanged} onChangedJobs={onChanged} />}
        />

        <Column
          title="Queued"
          items={queued}
          empty="Queue is empty."
          render={(j, i) => (
            <JobCard key={j.id} job={j} video={j.video_id ? videoById.get(j.video_id) : undefined} workerHint={active.length + i + 1} onOpen={onOpenJob} />
          )}
        />

        <Column
          title="Building"
          className="col-building"
          items={building}
          empty="No active builders."
          render={(j) => (
            <JobCard key={j.id} job={j} video={j.video_id ? videoById.get(j.video_id) : undefined} onOpen={onOpenJob} />
          )}
        />

        <Column
          title="Review"
          className="col-review"
          items={review}
          empty="Nothing to review."
          render={(j) => <JobCard key={j.id} job={j} video={j.video_id ? videoById.get(j.video_id) : undefined} onOpen={onOpenJob} />}
        />

        <Column
          title="Published"
          className="col-published"
          items={published}
          empty="No published games yet."
          render={(g) => <PublishedCard key={`${g.job_id}-${g.language}`} game={g} />}
        />
      </div>
    </div>
  )
}

function Thumb({ video, fallback }: { video?: Video; fallback: string }) {
  const [err, setErr] = useState(false)
  if (video?.thumbnail_url && !err) {
    return <img src={video.thumbnail_url} alt="" className="card-thumb" onError={() => setErr(true)} />
  }
  return <div className="card-thumb card-thumb-fallback">{fallback.slice(0, 1).toUpperCase()}</div>
}

function FitBadge({ score }: { score: number | null }) {
  if (score == null) return null
  const cls = score >= 75 ? 'fit-high' : score >= 50 ? 'fit-mid' : 'fit-low'
  return <span className={`fit ${cls}`}>{score} fit</span>
}

function stageProgress(job: Job): number {
  if (job.status === 'submitted') return STAGE_LIST.length
  const i = job.stage ? STAGE_LIST.findIndex((s) => s.id === job.stage) : -1
  return i < 0 ? 0 : i + (job.status === 'running' || job.status === 'paused' ? 0 : 1)
}

function JobCard({ job, video, workerHint, onOpen }: { job: Job; video?: Video; workerHint?: number; onOpen: (id: string) => void }) {
  const progress = stageProgress(job)
  const [pausing, setPausing] = useState(false)
  const imperfections = (() => {
    try {
      const r = JSON.parse(job.result_json ?? 'null')
      return Array.isArray(r?.imperfections) ? r.imperfections.length : 0
    } catch {
      return 0
    }
  })()

  /** Stop this build and hold the queue so nothing else fires up in its place. */
  const pauseBuild = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setPausing(true)
    try {
      await window.api.setSettings({ autoQueue: 'false' })
      await window.api.stopJob(job.id)
    } finally {
      setPausing(false)
    }
  }

  return (
    <article
      className={`issue-card status-${job.status}`}
      onClick={() => onOpen(job.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(job.id)}
    >
      <div className="issue-top">
        <Thumb video={video} fallback={job.title} />
        <div className="issue-meta">
          <div className="issue-title">{job.title}</div>
          <div className="issue-sub">
            {video ? <span className="muted">{video.channel}</span> : <span className="muted">{job.id.slice(0, 12)}</span>}
            {job.language !== 'en' && <span className="lang-chip">{job.language}</span>}
          </div>
        </div>
        {(job.status === 'running' || job.status === 'paused') && (
          <button
            className={`icon-btn pause-btn ${job.status === 'paused' ? 'resumable' : ''}`}
            title={job.status === 'running' ? 'Pause this build (agent stops, progress stays on the board)' : 'Resume this build'}
            disabled={pausing}
            onClick={job.status === 'running' ? pauseBuild : (e) => { e.stopPropagation(); window.api.resumeJob(job.id) }}
          >
            {pausing ? '…' : job.status === 'running' ? '⏸' : '▶'}
          </button>
        )}
      </div>

      {(job.status === 'running' || job.status === 'paused') && (
        <div className={`issue-progress ${job.status === 'paused' ? 'is-paused' : ''}`}>
          <div className="progress-label">
            {workerHint && job.status === 'running' ? <span className="worker-tag">Builder #{workerHint}</span> : null}
            <span>{phaseLabel(job.phase)}</span>
            {job.status === 'paused' && <span className="chip chip-paused">⏸ Paused</span>}
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${(progress / STAGE_LIST.length) * 100}%` }} />
          </div>
          {job.stage_detail && <div className="muted small ellipsis">{job.stage_detail}</div>}
        </div>
      )}

      {job.status === 'queued' && <div className="issue-line muted small">{phaseLabel(job.phase)} · waiting for a worker</div>}
      {job.status === 'awaiting_review' && (
        <div className="issue-line">
          <span className="chip chip-review">Ready for review</span>
          {imperfections > 0 && <span className="chip chip-warn">{imperfections} notes</span>}
        </div>
      )}
      {job.status === 'needs_input' && (
        <div className="issue-line">
          <span className="chip chip-warn">⚠ Needs your input</span>
        </div>
      )}
      {job.status === 'failed' && <div className="issue-line"><span className="chip chip-fail">Failed</span></div>}
      {job.status === 'interrupted' && (
        <div className="issue-line">
          <span className="chip">Interrupted</span>
          <button
            className="small-btn"
            title="Run this build again (reuses the artifacts already in its workspace)"
            onClick={(e) => {
              e.stopPropagation()
              window.api.restartJob(job.id)
            }}
          >
            Restart
          </button>
        </div>
      )}
      {job.status === 'submitted' && <div className="issue-line"><span className="chip chip-ok">✓ Published</span></div>}
    </article>
  )
}

function CandidateCard({ video, onChanged, onChangedJobs }: { video: Video; onChanged: () => void; onChangedJobs: () => void }) {
  const [busy, setBusy] = useState(false)
  const reasons = (() => {
    try {
      const r = JSON.parse(video.fit_reasons ?? 'null')
      return Array.isArray(r) ? (r as string[]) : []
    } catch {
      return []
    }
  })()

  const queue = async () => {
    setBusy(true)
    try {
      await window.api.queueVideos([{ id: video.id, title: video.title, url: video.url }])
      await window.api.setVideoStatus(video.id, 'queued', null)
      onChanged()
      onChangedJobs()
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="issue-card candidate">
      <div className="issue-top">
        <Thumb video={video} fallback={video.title} />
        <div className="issue-meta">
          <div className="issue-title">{video.title}</div>
          <div className="issue-sub muted">{video.channel}</div>
        </div>
      </div>
      <div className="issue-line">
        <FitBadge score={video.fit_score} />
        {video.classification && <span className="cls-chip">{video.classification.replaceAll('_', ' ').toLowerCase()}</span>}
        {video.rights_status && video.rights_status !== 'original' && (
          <span className="chip chip-warn" title="Copyrighted source - human gates publishing">{video.rights_status === 'commercial_clone' ? 'commercial ⚠' : video.rights_status}</span>
        )}
      </div>
      {reasons.length > 0 && <div className="fit-reasons muted small">{reasons.slice(0, 2).join(' · ')}</div>}
      <button className="primary small-btn" disabled={busy} onClick={queue}>
        {busy ? 'Queueing…' : 'Build game'}
      </button>
    </article>
  )
}

function PublishedCard({ game }: { game: Game }) {
  const [cover, setCover] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (game.cover_path) {
      window.api.readArtifact(game.job_id, game.cover_path).then((d) => {
        if (alive) setCover(d)
      })
    }
    return () => {
      alive = false
    }
  }, [game.job_id, game.cover_path])

  return (
    <article className="issue-card published">
      {cover ? (
        <img src={cover} alt="" className="card-thumb" />
      ) : (
        <div className="card-thumb card-thumb-fallback">{(game.name ?? '?').slice(0, 1).toUpperCase()}</div>
      )}
      <div className="issue-title">{game.name ?? game.card0_game_id ?? 'Untitled'}</div>
      <div className="issue-line">
        <span className="chip chip-ok">✓ on card0</span>
        {game.language !== 'en' && <span className="lang-chip">{game.language}</span>}
        {game.card_count ? <span className="muted small">{game.card_count} cards</span> : null}
      </div>
      {game.card0_game_id && (
        <button
          className="small-btn"
          onClick={(e) => {
            e.stopPropagation()
            window.api.openGame(game.card0_game_id!)
          }}
        >
          Open in card0 ↗
        </button>
      )}
    </article>
  )
}

export { STATUS_LABEL }
