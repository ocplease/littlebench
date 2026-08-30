import { useEffect, useState, useRef, useCallback } from 'react'
import type { Job, StreamEvent, Artifact } from '../types'
import { STAGE_LIST, STATUS_LABEL } from '../types'

interface Props {
  job: Job
  onChanged: () => void
}

interface GalleryImage extends Artifact {
  dataUrl: string
}

export default function JobDetail({ job, onChanged }: Props) {
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [gallery, setGallery] = useState<GalleryImage[]>([])
  const [tab, setTab] = useState<'transcript' | 'gallery'>('transcript')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)

  const loadEvents = useCallback(() => {
    window.api.jobEvents(job.id).then((evts) => setEvents(evts as StreamEvent[]))
  }, [job.id])

  const loadGallery = useCallback(async () => {
    const arts = (await window.api.listArtifacts(job.id)) as Artifact[]
    const withData: GalleryImage[] = []
    for (const a of arts.slice(0, 60)) {
      const dataUrl = await window.api.readArtifact(job.id, a.rel)
      if (dataUrl) withData.push({ ...a, dataUrl })
    }
    setGallery(withData)
  }, [job.id])

  useEffect(() => {
    loadEvents()
    loadGallery()
    const offs = [
      window.api.on('job:event', (payload) => {
        const p = payload as StreamEvent
        if (p.jobId === job.id) {
          setEvents((prev) => [...prev, p])
          if (autoScrollRef.current) {
            requestAnimationFrame(() => {
              transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
            })
          }
        }
      }),
      window.api.on('job:stage', (payload) => {
        const p = payload as { jobId: string }
        if (p.jobId === job.id) onChanged()
      })
    ]
    const timer = setInterval(loadGallery, 4000)
    return () => {
      offs.forEach((off) => off())
      clearInterval(timer)
    }
  }, [job.id, loadEvents, loadGallery, onChanged])

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true)
    setNotice(null)
    try {
      const res = (await fn()) as { ok?: boolean; error?: string } | unknown
      if (res && typeof res === 'object' && 'ok' in res && res.ok === false) {
        setNotice(`${label} failed: ${(res as { error?: string }).error ?? 'unknown error'}`)
      }
      onChanged()
    } catch (e) {
      setNotice(`${label} failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const stageIndex = job.stage ? STAGE_LIST.findIndex((s) => s.id === job.stage) : -1
  const isReview = job.status === 'awaiting_review'

  return (
    <div className="job-detail">
      <div className="job-header">
        <div>
          <h2>{job.title || job.id}</h2>
          <div className="muted small">
            {job.id} · {job.language}
            {job.youtube_url && (
              <>
                {' · '}
                <a href={job.youtube_url} target="_blank" rel="noreferrer">
                  video
                </a>
              </>
            )}
            {job.card0_game_id && <> · game {job.card0_game_id.slice(0, 8)}</>}
          </div>
        </div>
        <div className="job-actions">
          {job.status === 'queued' && (
            <button disabled={busy} onClick={() => act(() => window.api.startJob(job.id), 'Start')}>
              Start now
            </button>
          )}
          {job.status === 'running' && (
            <button className="danger" disabled={busy} onClick={() => act(() => window.api.stopJob(job.id), 'Stop')}>
              Stop
            </button>
          )}
          {isReview && (
            <>
              <button
                className="primary"
                disabled={busy}
                onClick={() => act(() => window.api.approveJob(job.id), 'Submit')}
              >
                Approve & submit
              </button>
              <button disabled={busy} onClick={() => act(() => window.api.discardJob(job.id), 'Discard')}>
                Discard
              </button>
            </>
          )}
          {(job.status === 'failed' || job.status === 'interrupted' || job.status === 'discarded') && (
            <button disabled={busy} onClick={() => act(() => window.api.restartJob(job.id), 'Restart')}>
              Restart
            </button>
          )}
          {job.status === 'submitted' && job.card0_game_id && (
            <button disabled={busy} onClick={() => act(() => window.api.openGame(job.card0_game_id!), 'Open')}>
              Open in card0
            </button>
          )}
        </div>
      </div>

      {notice && <div className="notice error">{notice}</div>}
      {job.error && <div className="notice error">{job.error}</div>}

      <div className="stage-stepper">
        {STAGE_LIST.map((s, i) => {
          const done = stageIndex > i || ['submitted'].includes(job.status)
          const current = stageIndex === i
          return (
            <div key={s.id} className={`stage ${done ? 'done' : ''} ${current ? 'current' : ''}`}>
              <span className="stage-num">{done ? '✓' : i + 1}</span>
              <span className="stage-label">{s.label}</span>
            </div>
          )
        })}
      </div>
      {job.stage_detail && <div className="stage-detail muted small">{job.stage_detail}</div>}

      {isReview && (
        <div className="review-banner">
          Agent finished. Review the card art in the Gallery tab, then Approve &amp; submit to publish on card0.
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>
          Transcript ({events.length})
        </button>
        <button className={tab === 'gallery' ? 'active' : ''} onClick={() => setTab('gallery')}>
          Gallery ({gallery.length})
        </button>
      </div>

      {tab === 'transcript' ? (
        <div
          className="transcript"
          ref={transcriptRef}
          onWheel={() => {
            const el = transcriptRef.current
            if (el) autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {events.length === 0 && <div className="empty">No events yet.</div>}
          {events.map((e, i) => (
            <TranscriptLine key={i} evt={e} />
          ))}
        </div>
      ) : (
        <div className="gallery">
          {gallery.length === 0 && <div className="empty">No images yet - they appear here as the agent generates them.</div>}
          {gallery.map((g) => (
            <figure key={g.rel} className="gallery-item">
              <img src={g.dataUrl} alt={g.file} />
              <figcaption className="muted small">{g.rel}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  )
}

function TranscriptLine({ evt }: { evt: StreamEvent }) {
  const ev = evt.event
  if (ev.type === 'system') {
    // only surface session init; hook_started/hook_response events are noise
    if (ev.subtype === 'init') return <div className="tl system">▸ session started</div>
    return null
  }
  if (ev.type === 'stderr') {
    return <div className="tl stderr">✗ {text(ev)}</div>
  }
  if (ev.type === 'result') {
    const cost = ev.total_cost_usd ? ` · $${ev.total_cost_usd.toFixed(2)}` : ''
    const dur = ev.duration_ms ? ` · ${(ev.duration_ms / 1000).toFixed(0)}s` : ''
    return (
      <div className={`tl result ${ev.is_error ? 'error' : ''}`}>
        ■ result{cost}{dur}
        {ev.result ? <pre>{String(ev.result).slice(0, 2000)}</pre> : null}
      </div>
    )
  }
  const message = ev.message as { role?: string; content?: unknown } | undefined
  if (!message || !Array.isArray(message.content)) return null
  return (
    <>
      {message.content.map((block, i) => {
        if (!block || typeof block !== 'object') return null
        const b = block as { type?: string; name?: string; text?: string; input?: unknown; content?: unknown; is_error?: boolean }
        if (b.type === 'text' && b.text) {
          return (
            <div key={i} className={`tl text ${message.role === 'assistant' ? 'assistant' : 'user'}`}>
              {message.role === 'assistant' ? '◆ ' : '◇ '}
              {b.text}
            </div>
          )
        }
        if (b.type === 'tool_use') {
          return (
            <details key={i} className="tl tool">
              <summary>
                <span className="tool-badge">tool</span> {b.name}
                <span className="muted small"> {inputSummary(b.input)}</span>
              </summary>
              <pre>{safeJson(b.input)}</pre>
            </details>
          )
        }
        if (b.type === 'tool_result') {
          return (
            <details key={i} className={`tl tool-result ${b.is_error ? 'error' : ''}`}>
              <summary>
                <span className="tool-badge result-badge">result</span>
              </summary>
              <pre>{resultSummary(b.content)}</pre>
            </details>
          )
        }
        return null
      })}
    </>
  )
}

function text(ev: Record<string, unknown>): string {
  const message = ev.message as { content?: unknown } | undefined
  if (typeof message?.content === 'string') return message.content
  return JSON.stringify(ev).slice(0, 300)
}

function inputSummary(input: unknown): string {
  const s = typeof input === 'string' ? input : safeJson(input)
  return s.replace(/\s+/g, ' ').slice(0, 100)
}

function resultSummary(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 4000)
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: string }).text) : ''))
      .join('\n')
      .slice(0, 4000)
  }
  return safeJson(content).slice(0, 4000)
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? ''
  } catch {
    return String(v)
  }
}
