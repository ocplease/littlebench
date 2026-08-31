import { useEffect, useState, useRef, useCallback } from 'react'
import type { Job, StreamEvent, Artifact, ProtocolArtifactRow, Message } from '../types'
import { STAGE_LIST, PHASE_LIST, STATUS_LABEL } from '../types'

interface Props {
  job: Job
  onBack: () => void
  onChanged: () => void
}

interface GalleryImage extends Artifact {
  dataUrl: string
}

/** Game Workspace: tasks | activity | artifacts, with steering input. */
export default function Workspace({ job, onBack, onChanged }: Props) {
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [gallery, setGallery] = useState<GalleryImage[]>([])
  const [protoArts, setProtoArts] = useState<ProtocolArtifactRow[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<string | null>(null)
  const [modal, setModal] = useState<{ img: GalleryImage | null; text: { path: string; content: string } | null } | null>(null)
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null)
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

  const loadSide = useCallback(() => {
    window.api.listProtocolArtifacts(job.id).then((a) => setProtoArts(a as ProtocolArtifactRow[]))
    window.api.jobMessages(job.id).then((m) => setMessages(m as Message[]))
    window.api.jobIsLive(job.id).then((l) => setLive(Boolean(l)))
  }, [job.id])

  useEffect(() => {
    loadEvents()
    loadGallery()
    loadSide()
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
      }),
      window.api.on('jobs:changed', () => loadSide())
    ]
    const timer = setInterval(loadGallery, 4000)
    const liveTimer = setInterval(() => window.api.jobIsLive(job.id).then((l) => setLive(Boolean(l))), 3000)
    return () => {
      offs.forEach((off) => off())
      clearInterval(timer)
      clearInterval(liveTimer)
    }
  }, [job.id, loadEvents, loadGallery, loadSide, onChanged])

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

  const send = () => {
    const message = draft.trim()
    if (!message) return
    act(() => window.api.steerJob(job.id, message, attached ?? undefined), 'Steer')
    setDraft('')
    setAttached(null)
  }

  // latest protocol snapshot wins for task statuses
  const protocol = latestProtocol(events)
  const stageIndex = job.stage ? STAGE_LIST.findIndex((s) => s.id === job.stage) : -1
  const stageStatus = (id: string): string => {
    const fromProtocol = protocol?.stages.find((s) => s.id === id)?.status
    if (fromProtocol) return fromProtocol
    const i = STAGE_LIST.findIndex((s) => s.id === id)
    if (i < 0 || stageIndex < 0) return 'pending'
    if (job.status === 'submitted') return 'completed'
    return i < stageIndex ? 'completed' : i === stageIndex ? (job.status === 'running' ? 'running' : 'completed') : 'pending'
  }

  const isReview = job.status === 'awaiting_review'
  const needsInput = job.status === 'needs_input'
  const steerable = !live && job.session_id && ['awaiting_review', 'needs_input', 'interrupted', 'submitted', 'failed', 'paused'].includes(job.status)

  const result = (() => {
    try {
      return JSON.parse(job.result_json ?? 'null') as { imperfections?: string[]; notes?: string }
    } catch {
      return null
    }
  })()

  const openText = async (path: string) => {
    const content = await window.api.readTextArtifact(job.id, path)
    if (content) setModal({ img: null, text: { path, content } })
  }

  return (
    <div className="workspace">
      <div className="ws-header">
        <button className="link" onClick={onBack}>← Factory</button>
        <div className="ws-title">
          <h2>{job.title}</h2>
          <div className="muted small">
            {STATUS_LABEL[job.status] ?? job.status}
            {job.status === 'running' && ` · ${phaseLabelOf(job, protocol)}`}
            {job.youtube_url && (
              <>
                {' · '}
                <a href={job.youtube_url} target="_blank" rel="noreferrer">video</a>
              </>
            )}
            {job.card0_game_id && <> · game {job.card0_game_id.slice(0, 8)}</>}
          </div>
        </div>
        <div className="job-actions">
          {job.status === 'queued' && (
            <button disabled={busy} onClick={() => act(() => window.api.startJob(job.id), 'Start')}>Start now</button>
          )}
          {live && (
            <button className="danger" disabled={busy} onClick={() => act(() => window.api.stopJob(job.id), 'Stop')}>Stop</button>
          )}
          {(isReview || needsInput) && (
            <>
              <button className="primary" disabled={busy || needsInput} title={needsInput ? 'Answer the question first' : ''} onClick={() => act(() => window.api.approveJob(job.id), 'Submit')}>
                Approve & publish
              </button>
              <button disabled={busy} onClick={() => act(() => window.api.discardJob(job.id), 'Discard')}>Discard</button>
            </>
          )}
          {job.status === 'paused' && (
            <button className="primary" disabled={busy} onClick={() => act(() => window.api.resumeJob(job.id), 'Resume')}>
              Resume
            </button>
          )}
          {(job.status === 'failed' || job.status === 'interrupted' || job.status === 'discarded') && (
            <button disabled={busy} onClick={() => act(() => window.api.restartJob(job.id), 'Restart')}>Restart</button>
          )}
          {job.status === 'submitted' && job.card0_game_id && (
            <button disabled={busy} onClick={() => act(() => window.api.openGame(job.card0_game_id!), 'Open')}>Open in card0 ↗</button>
          )}
        </div>
      </div>

      {notice && <div className="notice error">{notice}</div>}
      {job.error && <div className="notice error">{job.error}</div>}
      {needsInput && job.needs_input && (
        <div className="notice warn">
          <strong>The builder needs your decision:</strong>{' '}
          {safeQuestion(job.needs_input)} — answer in the box below and send.
        </div>
      )}
      {isReview && result?.imperfections && result.imperfections.length > 0 && (
        <div className="notice info">
          <strong>Builder flagged {result.imperfections.length} things to check:</strong>
          <ul className="imperfections">
            {result.imperfections.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="ws-body">
        <div className="ws-tasks">
          <h3>Tasks</h3>
          {PHASE_LIST.map((p) => {
            const stageStates = p.stages.map((s) => stageStatus(s))
            const done = stageStates.every((s) => s === 'completed')
            const running = stageStates.includes('running')
            const open = expandedPhase === p.id
            return (
              <div key={p.id} className={`phase ${done ? 'done' : ''} ${running ? 'running' : ''}`}>
                <button className="phase-head" onClick={() => setExpandedPhase(open ? null : p.id)}>
                  <span className="phase-mark">{done ? '✓' : running ? '●' : '○'}</span>
                  <span className="phase-name">{p.label}</span>
                  <span className="muted small">{p.detail}</span>
                  <span className="phase-caret">{open ? '▾' : '▸'}</span>
                </button>
                {open && (
                  <div className="phase-stages">
                    {p.stages.map((s) => {
                      const st = STAGE_LIST.find((x) => x.id === s)
                      const status = stageStatus(s)
                      return (
                        <div key={s} className={`stage-row status-${status}`}>
                          <span className="stage-mark">{status === 'completed' ? '✓' : status === 'running' ? '●' : '○'}</span>
                          {st?.label ?? s}
                          {protocol?.stages.find((x) => x.id === s)?.detail && (
                            <span className="muted small"> {protocol.stages.find((x) => x.id === s)!.detail}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
          {protocol?.note && <div className="protocol-note muted small">“{protocol.note}”</div>}
        </div>

        <div className="ws-activity">
          <h3>Activity</h3>
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
        </div>

        <div className="ws-artifacts">
          <h3>Artifacts</h3>
          {protoArts.length > 0 && (
            <div className="artifact-chips">
              {protoArts
                .filter((a) => !/\.(png|jpe?g|webp)$/i.test(a.path))
                .map((a) => (
                  <button key={a.id} className="artifact-chip" onClick={() => openText(a.path)} title={a.path}>
                    {a.label ?? a.type}: {a.path.split('/').pop()}
                  </button>
                ))}
            </div>
          )}
          {gallery.length === 0 ? (
            <div className="empty">No images yet - they appear as the builder generates them.</div>
          ) : (
            <div className="artifact-grid">
              {gallery.map((g) => (
                <figure
                  key={g.rel}
                  className="artifact-item"
                  onClick={() => setModal({ img: g, text: null })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setModal({ img: g, text: null })}
                >
                  <img src={g.dataUrl} alt={g.file} loading="lazy" />
                  <figcaption className="muted small ellipsis">{g.rel}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="ws-input">
        {messages.length > 0 && (
          <div className="msg-history">
            {messages.slice(-3).map((m) => (
              <div key={m.id} className="msg-bubble">
                <span className="msg-role">you</span> {m.content.slice(0, 120)}
                {m.artifact_path && <span className="muted small"> ↳ {m.artifact_path.split('/').pop()}</span>}
              </div>
            ))}
          </div>
        )}
        {attached && (
          <div className="attachment">
            attached: {attached.split('/').pop()} <button className="link" onClick={() => setAttached(null)}>remove</button>
          </div>
        )}
        <div className="input-row">
          <input
            value={draft}
            placeholder={
              live
                ? 'Builder is working - steering unlocks when this pass finishes…'
                : steerable
                  ? 'Ask or redirect the builder… ("make this card less dark", "fix the rule for X")'
                  : 'Queue the job first to start a session…'
            }
            disabled={live || !steerable}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button className="primary" disabled={live || !steerable || !draft.trim()} onClick={send}>
            Send
          </button>
        </div>
      </div>

      {modal?.img && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <img src={modal.img.dataUrl} alt={modal.img.file} />
            <div className="modal-meta">
              <div className="ellipsis">{modal.img.rel}</div>
              <div className="modal-actions">
                <button
                  onClick={() => {
                    setAttached(modal.img!.rel)
                    setDraft('Regenerate this card with a different take: ')
                    setModal(null)
                  }}
                >
                  Regenerate
                </button>
                <button
                  onClick={() => {
                    setAttached(modal.img!.rel)
                    setDraft('About this card: ')
                    setModal(null)
                  }}
                >
                  Give feedback
                </button>
                <button onClick={() => setModal(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modal?.text && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal modal-text" onClick={(e) => e.stopPropagation()}>
            <div className="modal-meta">
              <strong>{modal.text.path}</strong>
              <button className="link" onClick={() => setModal(null)}>close</button>
            </div>
            <pre>{modal.text.content.slice(0, 20000)}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

function phaseLabelOf(job: Job, protocol: { phase: string } | null): string {
  const phase = protocol?.phase ?? job.phase
  return PHASE_LIST.find((p) => p.id === phase)?.label ?? 'Working'
}

function latestProtocol(events: StreamEvent[]): { phase: string; note: string | null; stages: Array<{ id: string; status: string; detail?: string }>; needs_input: { question: string } | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i].event
    if (ev.type === 'protocol') {
      const p = ev as unknown as { phase: string; note?: string | null; stages?: Array<{ id: string; status: string; detail?: string }>; needs_input?: { question: string } | null }
      return { phase: p.phase, note: p.note ?? null, stages: p.stages ?? [], needs_input: p.needs_input ?? null }
    }
  }
  return null
}

function safeQuestion(json: string): string {
  try {
    const p = JSON.parse(json) as { question?: string }
    return p.question ?? json
  } catch {
    return json
  }
}

function TranscriptLine({ evt }: { evt: StreamEvent }) {
  const ev = evt.event
  if (ev.type === 'system') {
    if (ev.subtype === 'init') return <div className="tl system">▸ session started</div>
    return null
  }
  if (ev.type === 'protocol') {
    const p = ev as unknown as { phase?: string; note?: string | null }
    return (
      <div className="tl protocol">
        ▣ phase → {p.phase}
        {p.note ? <span className="muted small"> · {p.note}</span> : null}
      </div>
    )
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
