import React, { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Job, Video, Game } from '../types'
import { STAGE_LIST, phaseLabel, STATUS_LABEL } from '../types'
import { formatRelative, formatElapsed, channelPalette } from '../format'

interface Props {
  jobs: Job[]
  videos: Video[]
  games: Game[]
  maxWorkers: number
  quotaUntil: string
  keyPool: { total: number; cooling: number; nextAvailable?: string }
  autoQueue: boolean
  onOpenJob: (jobId: string) => void
  onChanged: () => void
  onGoSources: () => void
}

/** Board column: scrollable list with a uniform-height card. No per-column
 *  `+5 more` collapse - the unified card skeleton means all rows are the same
 *  height, so scrolling inside the column is enough. */
function Column<T>({ title, className, items, empty, render, selection }: {
  title: string
  className?: string
  items: T[]
  empty: ReactNode
  render: (item: T, index: number) => ReactNode
  selection?: { ids: string[]; selected: Set<string>; toggleAll: (ids: string[]) => void }
}) {
  const allSelected = !!selection && selection.ids.length > 0 && selection.ids.every((id) => selection.selected.has(id))
  return (
    <section className={`board-col ${className ?? ''}`}>
      <header>
        {selection && (
          <input
            type="checkbox"
            className="col-select"
            title="Select all in this column"
            checked={allSelected}
            onChange={() => selection.toggleAll(selection.ids)}
          />
        )}
        {title} <span className="col-count">{items.length}</span>
      </header>
      <div className="board-scroll">
        {items.length === 0 ? <div className="board-empty">{empty}</div> : items.map(render)}
      </div>
    </section>
  )
}

/** Linear-style board: the agent company at a glance. */
export default function Factory({ jobs, videos, games, maxWorkers, quotaUntil, keyPool, autoQueue, onOpenJob, onChanged, onGoSources }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const active = jobs.filter((j) => j.status === 'running')
  const building = jobs.filter((j) => j.status === 'running' || j.status === 'paused')
  const queued = jobs.filter((j) => j.status === 'queued')
  const review = jobs.filter((j) => j.status === 'awaiting_review' || j.status === 'needs_input' || j.status === 'interrupted' || j.status === 'failed')
  const candidates = videos.filter((v) => v.status === 'candidate')
  const published = games.filter((g) => g.status === 'submitted' || g.status === 'published')
  const quotaPaused = quotaUntil && new Date(quotaUntil) > new Date()

  const videoById = new Map(videos.map((v) => [v.id, v]))

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleColumn = (ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }

  const deleteSelected = async () => {
    const n = selected.size
    if (!n) return
    if (!window.confirm(`Delete ${n} job${n === 1 ? '' : 's'}? This removes the jobs from the board together with their workspaces and artifacts - unrecoverable.`)) return
    for (const id of selected) await window.api.deleteJob(id)
    setSelected(new Set())
  }

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
          <span className={`worker-pulse ${active.length > 0 ? 'on' : ''}`} />
          {active.length} / {maxWorkers} active
        </div>
        {(building.length > 0 || !autoQueue) && (
          <button className={`small-btn pause-toggle ${autoQueue ? '' : 'paused'}`} onClick={togglePause}>
            {autoQueue ? '⏸ Pause' : '▶ Resume queue'}
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="selection-bar factory-selection">
          {selected.size} selected
          <button className="danger" onClick={deleteSelected}>Delete selected</button>
          <button className="link" onClick={() => setSelected(new Set())}>clear</button>
        </div>
      )}

      {!autoQueue && !quotaPaused && (
        <div className="quota-note">Queue is paused - no new builds start until you resume.</div>
      )}

      {quotaPaused && (
        <div className="quota-note">
          {keyPool.total > 0 && keyPool.cooling >= keyPool.total ? (
            <>
              All {keyPool.total} API keys hit their quota - rotated through every one. If they
              belong to the same account they share its quota window; keys from different accounts
              would keep the factory running. Builds resume automatically after{' '}
              {new Date(quotaUntil).toLocaleTimeString()}.
            </>
          ) : (
            <>
              Backend quota exhausted - queued builds resume automatically after{' '}
              {new Date(quotaUntil).toLocaleTimeString()}.
            </>
          )}
        </div>
      )}

      <div className="board">
        <Column
          title="Candidates"
          items={candidates}
          empty={<div className="board-empty">No candidates. <button className="link" onClick={onGoSources}>Add a YouTube channel</button> and run the scout.</div>}
          render={(v) => <TaskCard key={v.id} kind="candidate" video={v} onChanged={onChanged} />}
        />

        <Column
          title="Queued"
          items={queued}
          empty="Queue is empty."
          selection={{ ids: queued.map((j) => j.id), selected, toggleAll: toggleColumn }}
          render={(j, i) => (
            <TaskCard
              key={j.id}
              kind="job"
              job={j}
              video={j.video_id ? videoById.get(j.video_id) : undefined}
              queuedPosition={active.length + i + 1}
              onOpen={onOpenJob}
              onChanged={onChanged}
              selected={selected.has(j.id)}
              onToggleSelect={toggleSelect}
            />
          )}
        />

        <Column
          title="Building"
          className="col-building"
          items={building}
          empty="No active builders."
          selection={{ ids: building.map((j) => j.id), selected, toggleAll: toggleColumn }}
          render={(j) => (
            <TaskCard
              key={j.id}
              kind="job"
              job={j}
              video={j.video_id ? videoById.get(j.video_id) : undefined}
              onOpen={onOpenJob}
              onChanged={onChanged}
              selected={selected.has(j.id)}
              onToggleSelect={toggleSelect}
            />
          )}
        />

        <Column
          title="Review"
          className="col-review"
          items={review}
          empty="Nothing to review."
          selection={{ ids: review.map((j) => j.id), selected, toggleAll: toggleColumn }}
          render={(j) => (
            <TaskCard
              key={j.id}
              kind="job"
              job={j}
              video={j.video_id ? videoById.get(j.video_id) : undefined}
              onOpen={onOpenJob}
              onChanged={onChanged}
              selected={selected.has(j.id)}
              onToggleSelect={toggleSelect}
            />
          )}
        />

        <Column
          title="Published"
          className="col-published"
          items={published}
          empty="No published games yet."
          render={(g) => <TaskCard key={`${g.job_id}-${g.language}`} kind="published" game={g} />}
        />
      </div>
    </div>
  )
}

// ---------- card primitives ----------

function CardThumb({ src, seed, label }: { src?: string | null; seed: string; label: string }) {
  const [err, setErr] = useState(false)
  if (src && !err) {
    return <img src={src} alt="" className="task-thumb-img" onError={() => setErr(true)} />
  }
  const palette = channelPalette(seed || label)
  return (
    <div
      className="task-thumb-fallback"
      style={{ background: `linear-gradient(135deg, ${palette.from}, ${palette.to})` }}
    >
      <span>{label.slice(0, 1).toUpperCase()}</span>
    </div>
  )
}

function StatusChip({ status, extras }: { status: string; extras?: ReactNode }) {
  // Single source of truth for the colored status pill.
  const map: Record<string, { label: string; cls: string }> = {
    queued: { label: 'Waiting', cls: 'chip-muted' },
    candidate: { label: 'Candidate', cls: 'chip-muted' },
    running: { label: 'Running', cls: 'chip-accent' },
    paused: { label: '⏸ Paused', cls: 'chip-paused' },
    awaiting_review: { label: 'Ready for review', cls: 'chip-ok' },
    needs_input: { label: '⚠ Needs your input', cls: 'chip-warn' },
    failed: { label: 'Failed', cls: 'chip-fail' },
    interrupted: { label: 'Interrupted', cls: 'chip-muted' },
    submitted: { label: '✓ Published', cls: 'chip-ok' }
  }
  const chip = map[status] ?? { label: status, cls: 'chip-muted' }
  return (
    <span className={`chip ${chip.cls}`}>
      {chip.label}
      {extras && <span className="chip-extras">{extras}</span>}
    </span>
  )
}

function StageProgress({ job }: { job: Job }) {
  if (job.status !== 'running' && job.status !== 'paused') return null
  const i = job.stage ? STAGE_LIST.findIndex((s) => s.id === job.stage) : -1
  const total = STAGE_LIST.length
  const done = i < 0 ? 0 : i + (job.status === 'paused' ? 1 : 0)
  const current = job.status === 'running' && i >= 0 ? i : -1
  const stageLabel = i >= 0 ? STAGE_LIST[i].label : phaseLabel(job.phase)
  return (
    <div className={`task-progress ${job.status === 'paused' ? 'is-paused' : ''}`}>
      <div className="task-progress-segments">
        {Array.from({ length: total }, (_, k) => (
          <span
            key={k}
            className={`task-seg ${k < done ? 'done' : ''} ${k === current ? 'current' : ''}`}
          />
        ))}
      </div>
      <div className="task-progress-label">
        <span>{stageLabel}</span>
        <span className="muted">{Math.min(done + 1, total)} / {total}</span>
      </div>
    </div>
  )
}

/** Triggers a re-render once a second so the elapsed clock ticks.
 *  Only mounted for running jobs. The clock itself reads Date.now() on each
 *  render via formatElapsed; this hook just nudges the render. */
function useSecondTick(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

function CardMeta({ job }: { job: Job }) {
  useSecondTick(job.status === 'running' && !!job.started_at)
  const started = job.started_at || job.created_at
  const rel = formatRelative(started)
  const elapsed = job.status === 'running' && job.started_at ? formatElapsed(job.started_at) : ''
  return (
    <div className="task-meta">
      {rel && (
        <span className="task-meta-time" title={started ? new Date(started).toLocaleString() : ''}>
          {job.status === 'running' ? 'Started' : 'Queued'} {rel}
        </span>
      )}
      {elapsed && <span className="task-meta-elapsed">{elapsed}</span>}
      {job.model && <span className="task-meta-model" title="Agent model">⚙ {job.model}</span>}
    </div>
  )
}

// ---------- the unified card ----------

/** Single skeleton used by every card on the board. The `kind` prop picks what
 *  fills the body / footer. Jobs and candidates are clickable; published cards
 *  are inert (the action button opens the game in card0). */
function TaskCard({ kind, job, video, game, queuedPosition, onOpen, onChanged, selected, onToggleSelect }: {
  kind: 'job' | 'candidate' | 'published'
  job?: Job
  video?: Video
  game?: Game
  queuedPosition?: number
  onOpen?: (id: string) => void
  onChanged?: () => void
  selected?: boolean
  onToggleSelect?: (id: string) => void
}) {
  // ---- shared display data ----
  const title = kind === 'job'
    ? (job!.title || 'Untitled')
    : kind === 'candidate'
      ? video!.title
      : (game?.name ?? game?.card0_game_id ?? 'Untitled')
  const sub = kind === 'job'
    ? (video?.channel ?? (job!.origin === 'external_agent' ? 'Agent request' : 'Design brief'))
    : kind === 'candidate'
      ? video!.channel
      : (game?.submitted_at ? formatRelative(game.submitted_at) : 'card0')
  const thumbSrc = kind === 'job'
    ? video?.thumbnail_url ?? null
    : kind === 'candidate'
      ? video!.thumbnail_url ?? null
      : null // published uses cover via a dedicated effect below
  const thumbSeed = (kind === 'job' ? video?.channel : kind === 'candidate' ? video!.channel : game?.name) || title
  const cardClass = `task-card kind-${kind} ${kind === 'job' ? `status-${job!.status}` : ''} ${selected ? 'is-selected' : ''}`

  // ---- click + actions ----
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  const onCardClick = () => {
    if (kind === 'job' && onOpen) onOpen(job!.id)
  }
  const onCardKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onCardClick()
    }
  }
  const pauseBuild = async () => {
    if (!job) return
    // Hold the queue so nothing else fills the slot the moment this one frees.
    await window.api.setSettings({ autoQueue: 'false' })
    await window.api.pauseJob(job.id)
  }
  const del = async () => {
    if (!job) return
    if (!window.confirm(`Delete "${job.title}"? Its workspace and artifacts are removed - unrecoverable.`)) return
    await window.api.deleteJob(job.id)
    onChanged?.()
  }
  const queueCandidate = async () => {
    if (!video) return
    await window.api.queueVideos([{ id: video.id, title: video.title, url: video.url }])
    await window.api.setVideoStatus(video.id, 'queued', null)
    onChanged?.()
  }

  // ---- primary footer action ----
  type Action = { label: string; onClick: (e: React.MouseEvent) => void; variant?: 'primary' | 'danger' | 'ghost' }
  const primary: Action | null = (() => {
    if (kind === 'candidate') {
      return { label: 'Build game', onClick: stop(queueCandidate), variant: 'primary' }
    }
    if (kind === 'published') {
      return game?.card0_game_id
        ? { label: 'Open ↗', onClick: stop(() => window.api.openGame(game.card0_game_id!)), variant: 'ghost' }
        : null
    }
    const j = job!
    switch (j.status) {
      case 'running': return { label: 'Pause', onClick: stop(pauseBuild), variant: 'ghost' }
      case 'paused': return { label: 'Resume', onClick: stop(() => window.api.resumeJob(j.id)), variant: 'primary' }
      case 'interrupted': return { label: 'Restart', onClick: stop(() => window.api.restartJob(j.id)), variant: 'primary' }
      case 'awaiting_review': return onOpen ? { label: 'Review →', onClick: stop(() => onOpen(j.id)), variant: 'primary' } : null
      case 'needs_input':
      case 'failed':
        return onOpen ? { label: 'Open', onClick: stop(() => onOpen(j.id)), variant: 'primary' } : null
      case 'submitted':
        return onOpen ? { label: 'Open', onClick: stop(() => onOpen(j.id)), variant: 'ghost' } : null
      default: return null // queued has no button
    }
  })()

  // ---- chip extras ----
  const imperfections = (() => {
    if (kind !== 'job') return 0
    try {
      const r = JSON.parse(job!.result_json ?? 'null')
      return Array.isArray(r?.imperfections) ? r.imperfections.length : 0
    } catch { return 0 }
  })()
  const chipExtras: ReactNode = (() => {
    if (kind === 'job') {
      if (job!.status === 'awaiting_review' && imperfections > 0) {
        return <span className="chip-extras">· {imperfections} notes</span>
      }
      if (job!.status === 'queued' && queuedPosition) {
        return <span className="chip-extras">· #{queuedPosition}</span>
      }
    }
    if (kind === 'candidate') {
      const reasons = (() => { try { return JSON.parse(video!.fit_reasons ?? 'null') } catch { return null } })()
      if (Array.isArray(reasons) && reasons.length > 0) {
        return <span className="chip-extras">{reasons[0]}</span>
      }
    }
    if (kind === 'published') {
      return game?.card_count ? <span className="chip-extras">· {game.card_count} cards</span> : null
    }
    return null
  })()

  // ---- one-line teaser for the body ----
  const teaser: string | null = (() => {
    if (kind !== 'job' || !job) return null
    if (job.status === 'needs_input') {
      try {
        const parsed = JSON.parse(job.needs_input ?? 'null') as { question?: string } | null
        if (parsed?.question) return parsed.question
      } catch { /* fall through */ }
    }
    if (job.status === 'failed' && job.error) {
      return job.error.split('\n')[0].slice(0, 120)
    }
    if (job.status === 'interrupted' && job.error) {
      return job.error.split('\n')[0].slice(0, 120)
    }
    return null
  })()

  // ---- publish cover (published cards load cover from the workspace) ----
  const [coverData, setCoverData] = useState<string | null>(null)
  useEffect(() => {
    if (kind !== 'published' || !game?.cover_path) return
    let alive = true
    window.api.readArtifact(game.job_id, game.cover_path).then((d) => {
      if (alive) setCoverData(d)
    })
    return () => { alive = false }
  }, [kind, game?.job_id, game?.cover_path])

  const lang = kind === 'job' ? job!.language : kind === 'published' ? game?.language : null
  const clickable = kind === 'job'

  return (
    <article
      className={cardClass}
      onClick={clickable ? onCardClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? onCardKey : undefined}
    >
      <div className="task-thumb">
        {kind === 'published' && coverData
          ? <img src={coverData} alt="" className="task-thumb-img" />
          : <CardThumb src={thumbSrc} seed={thumbSeed} label={title} />}
        {kind === 'job' && onToggleSelect && (
          <button
            className="circle-select"
            title="Select for bulk actions"
            onClick={stop(() => onToggleSelect(job!.id))}
            aria-label="Select"
          >{selected ? '✓' : ''}</button>
        )}
        {lang && lang !== 'en' && <span className="task-lang-pill">{lang}</span>}
        {kind === 'job' && (
          <button
            className="task-delete"
            title="Delete this job (removes its workspace - unrecoverable)"
            onClick={stop(del)}
            aria-label="Delete"
          >✕</button>
        )}
        {kind === 'candidate' && video!.fit_score != null && (
          <span className={`task-fit-pill fit-${video!.fit_score >= 75 ? 'high' : video!.fit_score >= 50 ? 'mid' : 'low'}`}>
            {video!.fit_score}
          </span>
        )}
      </div>

      <div className="task-body">
        <div className="task-title">{title}</div>
        <div className="task-sub">{sub}</div>
        <div className="task-divider" />
        {kind === 'job' && <CardMeta job={job!} />}
        {kind === 'candidate' && (
          <div className="task-meta">
            {video!.classification && (
              <span className="cls-chip">{video!.classification.replaceAll('_', ' ').toLowerCase()}</span>
            )}
            {video!.rights_status && video!.rights_status !== 'original' && (
              <span className="chip chip-warn" title="Copyrighted source - human gates publishing">
                {video!.rights_status === 'commercial_clone' ? 'commercial ⚠' : video!.rights_status}
              </span>
            )}
            {video!.duration_s != null && (
              <span className="task-meta-time muted">
                {Math.round(video!.duration_s / 60)} min
              </span>
            )}
          </div>
        )}
        {kind === 'job' && <StageProgress job={job!} />}
        {teaser && <div className="task-teaser">{teaser}</div>}
      </div>

      <div className="task-footer">
        <StatusChip
          status={kind === 'job' ? job!.status : kind === 'candidate' ? 'candidate' : 'submitted'}
          extras={chipExtras}
        />
        {primary && (
          <button
            className={`task-action small-btn ${primary.variant ?? ''}`}
            onClick={primary.onClick}
          >{primary.label}</button>
        )}
      </div>
    </article>
  )
}

export { STATUS_LABEL }
