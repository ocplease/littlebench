import { useEffect, useState } from 'react'
import type { Job, Video, Game } from '../types'
import { STAGE_LIST, phaseLabel, STATUS_LABEL } from '../types'

interface Props {
  jobs: Job[]
  videos: Video[]
  games: Game[]
  maxWorkers: number
  quotaUntil: string
  onOpenJob: (jobId: string) => void
  onChanged: () => void
  onGoSources: () => void
}

/** Linear-style board: the agent company at a glance. */
export default function Factory({ jobs, videos, games, maxWorkers, quotaUntil, onOpenJob, onChanged, onGoSources }: Props) {
  const building = jobs.filter((j) => j.status === 'running')
  const queued = jobs.filter((j) => j.status === 'queued')
  const review = jobs.filter((j) => j.status === 'awaiting_review' || j.status === 'needs_input' || j.status === 'interrupted' || j.status === 'failed')
  const candidates = videos.filter((v) => v.status === 'candidate')
  const published = games.filter((g) => g.status === 'submitted' || g.status === 'published')
  const quotaPaused = quotaUntil && new Date(quotaUntil) > new Date()

  const videoById = new Map(videos.map((v) => [v.id, v]))

  return (
    <div className="factory">
      <div className="factory-header">
        <h1>Factory</h1>
        <div className="workers-badge">
          Workers
          <span className="worker-dots">
            {Array.from({ length: maxWorkers }, (_, i) => (
              <span key={i} className={`worker-dot ${i < building.length ? 'on' : ''}`} />
            ))}
          </span>
          {building.length} / {maxWorkers} active
        </div>
      </div>

      {quotaPaused && (
        <div className="quota-note">
          Backend quota exhausted - queued builds resume automatically after{' '}
          {new Date(quotaUntil).toLocaleTimeString()}.
        </div>
      )}

      <div className="board">
        <section className="board-col">
          <header>Candidates <span className="col-count">{candidates.length}</span></header>
          {candidates.length === 0 && (
            <div className="board-empty">
              No candidates. <button className="link" onClick={onGoSources}>Add a YouTube channel</button> and run the scout.
            </div>
          )}
          {candidates.map((v) => (
            <CandidateCard key={v.id} video={v} onChanged={onChanged} onChangedJobs={onChanged} />
          ))}
        </section>

        <section className="board-col">
          <header>Queued <span className="col-count">{queued.length}</span></header>
          {queued.length === 0 && <div className="board-empty">Queue is empty.</div>}
          {queued.map((j, i) => (
            <JobCard key={j.id} job={j} video={j.video_id ? videoById.get(j.video_id) : undefined} workerHint={building.length + i + 1} onOpen={onOpenJob} />
          ))}
        </section>

        <section className="board-col col-building">
          <header>Building <span className="col-count">{building.length}</span></header>
          {building.length === 0 && <div className="board-empty">No active builders.</div>}
          {building.map((j, i) => (
            <JobCard key={j.id} job={j} video={j.video_id ? videoById.get(j.video_id) : undefined} workerHint={i + 1} onOpen={onOpenJob} />
          ))}
        </section>

        <section className="board-col col-review">
          <header>Review <span className="col-count">{review.length}</span></header>
          {review.length === 0 && <div className="board-empty">Nothing to review.</div>}
          {review.map((j) => (
            <JobCard key={j.id} job={j} video={j.video_id ? videoById.get(j.video_id) : undefined} onOpen={onOpenJob} />
          ))}
        </section>

        <section className="board-col col-published">
          <header>Published <span className="col-count">{published.length}</span></header>
          {published.length === 0 && <div className="board-empty">No published games yet.</div>}
          {published.map((g) => (
            <PublishedCard key={`${g.job_id}-${g.language}`} game={g} />
          ))}
        </section>
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
  return i < 0 ? 0 : i + (job.status === 'running' ? 0 : 1)
}

function JobCard({ job, video, workerHint, onOpen }: { job: Job; video?: Video; workerHint?: number; onOpen: (id: string) => void }) {
  const progress = stageProgress(job)
  const imperfections = (() => {
    try {
      const r = JSON.parse(job.result_json ?? 'null')
      return Array.isArray(r?.imperfections) ? r.imperfections.length : 0
    } catch {
      return 0
    }
  })()

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
      </div>

      {job.status === 'running' && (
        <div className="issue-progress">
          <div className="progress-label">
            {workerHint ? <span className="worker-tag">Builder #{workerHint}</span> : null}
            <span>{phaseLabel(job.phase)}</span>
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
      {job.status === 'interrupted' && <div className="issue-line"><span className="chip">Interrupted</span></div>}
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
