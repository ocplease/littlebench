import { useEffect, useState, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import type { Job, StreamEvent, Artifact, ProtocolArtifactRow, Message, Settings, Attachment } from '../types'
import { STAGE_LIST, PHASE_LIST, STATUS_LABEL } from '../types'
import { ModelPicker } from '../models'
import { formatRelative, formatElapsed } from '../format'

interface Props {
  job: Job
  onBack: () => void
  onChanged: () => void
}

interface GalleryImage extends Artifact {
  dataUrl: string
}

type ArtifactTab = 'images' | 'files'

/** Game Workspace: top header (status + next action) over a 3-column body
 *  (phases | activity + composer | artifacts) with notices between. The new
 *  layout pushes the most important info (status, next action) to the top and
 *  demotes reference content (phases, artifact gallery) to dimmer side rails. */
export default function Workspace({ job, onBack, onChanged }: Props) {
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [gallery, setGallery] = useState<GalleryImage[]>([])
  const [protoArts, setProtoArts] = useState<ProtocolArtifactRow[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [live, setLive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [attached, setAttached] = useState<Attachment[]>([])
  const [artifactTab, setArtifactTab] = useState<ArtifactTab>('images')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [modal, setModal] = useState<{ img: GalleryImage | null; text: { path: string; content: string } | null } | null>(null)
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
    window.api.getSettings().then((s) => setSettings(s as Settings))
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
      window.api.on('jobs:changed', () => loadSide()),
      window.api.on('settings:changed', () => {
        window.api.getSettings().then((s) => setSettings(s as Settings))
      })
    ]
    const timer = setInterval(loadGallery, 4000)
    const liveTimer = setInterval(() => window.api.jobIsLive(job.id).then((l) => setLive(Boolean(l))), 3000)
    const tickTimer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      offs.forEach((off) => off())
      clearInterval(timer)
      clearInterval(liveTimer)
      clearInterval(tickTimer)
    }
  }, [job.id, loadEvents, loadGallery, loadSide, onChanged])

  // The human may have published this game directly on the card0 site -
  // on open, pull the real status before offering Approve & publish again.
  useEffect(() => {
    if (job.status !== 'awaiting_review' && job.status !== 'needs_input') return
    if (!job.card0_game_id) return
    window.api.syncJobStatus(job.id).then(() => onChanged())
  }, [job.id, job.status, job.card0_game_id, onChanged])

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
    act(() => window.api.steerJob(job.id, message, attached.length > 0 ? attached : undefined), 'Steer')
    setDraft('')
    setAttached([])
  }

  /** Add a workspace-internal artifact (e.g. an image from the modal) to the
   *  pending attachments. Size and type are best-effort. */
  const attachArtifact = (rel: string, file: string) => {
    const name = file.split('/').pop() ?? rel
    setAttached((cur) => [
      ...cur,
      { name, path: rel, size: 0, type: file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg' }
    ])
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

  const nextAction = nextActionFor(job.status, !!live, job.card0_game_id ?? null, job.id)
  const imageGateOn = settings?.autoImageGen === 'false'

  // Phase progress counts
  const phaseProgress = PHASE_LIST.map((p) => {
    const states = p.stages.map((s) => stageStatus(s))
    const done = states.every((s) => s === 'completed')
    const running = states.includes('running')
    return { phase: p, done, running, doneCount: states.filter((s) => s === 'completed').length, total: states.length }
  })

  // ---- file vs image split for artifacts rail
  const fileArtifacts = protoArts.filter((a) => !/\.(png|jpe?g|webp)$/i.test(a.path))
  const imageCount = gallery.length
  const fileCount = fileArtifacts.length

  return (
    <div className="workspace workspace-new">
      <div className="ws-header-new">
        <div className="ws-header-new-left">
          <button className="link" onClick={onBack}>← Factory</button>
          <div className="ws-title-block">
            <h2 className="ws-title-text">{job.title}</h2>
            <div className="ws-title-sub muted small">
              <span className={`status-pill status-pill-${job.status}`}>
                {STATUS_LABEL[job.status] ?? job.status}
              </span>
              {job.status === 'running' && (
                <>
                  <span className="ws-dot">·</span>
                  <span>{phaseLabelOf(job, protocol)}</span>
                  <span className="ws-dot">·</span>
                  <span>{formatElapsed(job.started_at, now)} elapsed</span>
                </>
              )}
              {job.created_at && (
                <>
                  <span className="ws-dot">·</span>
                  <span title={job.created_at}>started {formatRelative(job.created_at, now)}</span>
                </>
              )}
              {job.model && (
                <>
                  <span className="ws-dot">·</span>
                  <span className="ws-model-chip">{job.model}</span>
                </>
              )}
              {job.youtube_url && (
                <>
                  <span className="ws-dot">·</span>
                  <a href={job.youtube_url} target="_blank" rel="noreferrer">video ↗</a>
                </>
              )}
              {job.card0_game_id && (
                <>
                  <span className="ws-dot">·</span>
                  <span>game {job.card0_game_id.slice(0, 8)}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="ws-header-new-right">
          {nextAction && (
            <button
              className={`ws-next-action ${nextAction.variant === 'primary' ? 'primary' : nextAction.variant === 'danger' ? 'danger' : 'ghost'}`}
              disabled={busy}
              onClick={() => act(nextAction.run, nextAction.label)}
            >
              {nextAction.label}
              {nextAction.variant === 'ghost' ? <span className="ws-next-arrow">↗</span> : <span className="ws-next-arrow">→</span>}
            </button>
          )}
        </div>
      </div>

      {(notice || (job.error && job.status !== 'needs_input')) && (
        <div className="ws-notice ws-notice-error">
          {notice ?? job.error}
        </div>
      )}
      {needsInput && job.needs_input && (
        <div className="ws-notice ws-notice-warn">
          <strong>The builder needs your decision.</strong>{' '}
          {safeQuestion(job.needs_input)} — answer in the composer below.
        </div>
      )}
      {isReview && result?.imperfections && result.imperfections.length > 0 && (
        <div className="ws-notice ws-notice-info">
          <strong>Builder flagged {result.imperfections.length} things to check:</strong>
          <ul className="imperfections">
            {result.imperfections.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="ws-body-3col">
        <aside className="ws-rail ws-rail-left">
          <div className="ws-rail-head">
            <span className="ws-rail-title">Phases</span>
            {protocol?.note && <span className="muted small" title={protocol.note}>“{protocol.note.slice(0, 28)}{protocol.note.length > 28 ? '…' : ''}”</span>}
          </div>
          <div className="ws-rail-body">
            {phaseProgress.map(({ phase: p, done, running, doneCount, total }) => {
              const open = expandedPhase === p.id
              return (
                <div key={p.id} className={`phase-step ${done ? 'is-done' : ''} ${running ? 'is-running' : ''} ${open ? 'is-open' : ''}`}>
                  <button className="phase-step-head" onClick={() => setExpandedPhase(open ? null : p.id)}>
                    <span className="phase-step-mark">{done ? '✓' : running ? '●' : '○'}</span>
                    <span className="phase-step-name">{p.label}</span>
                    <span className="phase-step-count muted small">{doneCount}/{total}</span>
                    <span className="phase-step-caret">{open ? '▾' : '▸'}</span>
                  </button>
                  {open && (
                    <div className="phase-step-stages">
                      {p.stages.map((s) => {
                        const st = STAGE_LIST.find((x) => x.id === s)
                        const status = stageStatus(s)
                        return (
                          <div key={s} className={`phase-stage-row status-${status}`}>
                            <span className="phase-stage-mark">{status === 'completed' ? '✓' : status === 'running' ? '●' : '○'}</span>
                            <span className="phase-stage-label">{st?.label ?? s}</span>
                            {protocol?.stages.find((x) => x.id === s)?.detail && (
                              <span className="muted small">{protocol.stages.find((x) => x.id === s)!.detail}</span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </aside>

        <section className="ws-center">
          <div className="ws-center-head">
            <span className="ws-rail-title">Activity</span>
            <span className="muted small">{events.length} events</span>
          </div>
          <div
            className="activity-stream"
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
          <div className="ws-composer">
            {messages.length > 0 && (
              <div className="msg-history">
                {messages.slice(-2).map((m) => (
                  <div key={m.id} className="msg-bubble">
                    <span className="msg-role">you</span> {m.content.slice(0, 120)}
                    {m.artifact_path && <span className="muted small"> ↳ {m.artifact_path.split('/').pop()}</span>}
                  </div>
                ))}
              </div>
            )}
            {attached.length > 0 && (
              <div className="ws-attach-row">
                {attached.map((a, i) => (
                  <span key={i} className="ws-attach-chip" title={a.path}>
                    📎 {a.name}
                    <button onClick={() => setAttached((cur) => cur.filter((_, j) => j !== i))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              className="ws-composer-input"
              rows={2}
              value={draft}
              placeholder={
                needsInput
                  ? 'Reply to the builder\'s question…'
                  : live
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
            <div className="ws-composer-foot">
              <div className="ws-composer-foot-left">
                {imageGateOn && (
                  <span className="ws-composer-note muted small" title="Cover and game rules still auto-generate">
                    ⓘ Card images require your approval
                  </span>
                )}
              </div>
              <div className="ws-composer-foot-right">
                <button
                  className="small-btn ws-attach-btn"
                  title="Attach files to this message"
                  onClick={async () => {
                    const picked = await window.api.pickAttachments(job.id)
                    if (picked.length > 0) setAttached((cur) => [...cur, ...picked])
                  }}
                  disabled={live || !steerable}
                >
                  📎
                </button>
                <ModelPicker />
                <button
                  className="primary ws-send"
                  disabled={live || !steerable || (!draft.trim() && attached.length === 0)}
                  onClick={send}
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside className="ws-rail ws-rail-right">
          <div className="ws-rail-head">
            <span className="ws-rail-title">Artifacts</span>
            <div className="ws-rail-tabs" role="tablist">
              <button
                role="tab"
                aria-selected={artifactTab === 'images'}
                className={artifactTab === 'images' ? 'is-active' : ''}
                onClick={() => setArtifactTab('images')}
              >
                Images {imageCount > 0 ? `· ${imageCount}` : ''}
              </button>
              <button
                role="tab"
                aria-selected={artifactTab === 'files'}
                className={artifactTab === 'files' ? 'is-active' : ''}
                onClick={() => setArtifactTab('files')}
              >
                Files {fileCount > 0 ? `· ${fileCount}` : ''}
              </button>
            </div>
          </div>
          <div className="ws-rail-body">
            {artifactTab === 'images' ? (
              gallery.length === 0 ? (
                <div className="empty">No images yet — they appear as the builder generates them.</div>
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
                    </figure>
                  ))}
                </div>
              )
            ) : fileArtifacts.length === 0 ? (
              <div className="empty">No file artifacts yet.</div>
            ) : (
              <div className="artifact-chips">
                {fileArtifacts.map((a) => (
                  <button key={a.id} className="artifact-chip" onClick={() => openText(a.path)} title={a.path}>
                    {a.label ?? a.type}: {a.path.split('/').pop()}
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>
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
                    attachArtifact(modal.img!.rel, modal.img!.file)
                    setDraft('Regenerate this card with a different take: ')
                    setModal(null)
                  }}
                >
                  Regenerate
                </button>
                <button
                  onClick={() => {
                    attachArtifact(modal.img!.rel, modal.img!.file)
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

type ActionVariant = 'primary' | 'danger' | 'ghost'

function nextActionFor(
  status: string,
  live: boolean,
  gameId: string | null,
  jobId: string
): { label: string; variant: ActionVariant; run: () => Promise<unknown> } | null {
  if (status === 'needs_input') return null // user must reply in composer
  if (status === 'queued') {
    return { label: 'Start now', variant: 'primary', run: () => window.api.startJob(jobId) }
  }
  if (status === 'running' || live) {
    return { label: 'Stop', variant: 'danger', run: () => window.api.stopJob(jobId) }
  }
  if (status === 'paused') {
    return { label: 'Resume', variant: 'primary', run: () => window.api.resumeJob(jobId) }
  }
  if (status === 'awaiting_review') {
    return { label: 'Approve & publish', variant: 'primary', run: () => window.api.approveJob(jobId) }
  }
  if (status === 'failed' || status === 'interrupted' || status === 'discarded') {
    return { label: 'Restart', variant: 'primary', run: () => window.api.restartJob(jobId) }
  }
  if (status === 'submitted' && gameId) {
    return { label: 'Open in card0', variant: 'ghost', run: () => window.api.openGame(gameId) }
  }
  return null
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
  const blocks = message.content
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b) => b as { type?: string; name?: string; text?: string; input?: unknown; content?: unknown; is_error?: boolean })

  // Codex-style: a single assistant turn can fire many tool calls. Group
  // consecutive tool_use blocks (and their results) into one summary row so
  // the activity feed reads as a sequence of "what the agent just did"
  // rather than a wall of one-line tool entries.
  const rows: Array<{ key: string; node: ReactNode }> = []
  let i = 0
  let groupIdx = 0
  while (i < blocks.length) {
    const b = blocks[i]
    if (b.type === 'text' && b.text) {
      rows.push({
        key: `t${i}`,
        node: (
          <div className={`tl-bubble tl-text tl-${message.role ?? 'unknown'}`}>
            {b.text}
          </div>
        )
      })
      i++
      continue
    }
    if (b.type === 'tool_use') {
      // Consume a run of tool_use + tool_result pairs.
      const start = i
      const tools: Array<{ name: string; input: unknown; resultError?: boolean; resultText?: string }> = []
      while (i < blocks.length && blocks[i].type === 'tool_use') {
        const tool = blocks[i]
        // Look ahead for the matching tool_result (Claude pairs them).
        const next = blocks[i + 1]
        const result = next && next.type === 'tool_result' ? next : null
        const resultText = result ? resultSummary(result.content) : ''
        tools.push({
          name: String(tool.name ?? 'tool'),
          input: tool.input,
          resultError: Boolean(result?.is_error),
          resultText
        })
        i += result ? 2 : 1
      }
      const summary = toolGroupSummary(tools)
      rows.push({
        key: `g${groupIdx++}`,
        node: (
          <details className="tl-bubble tl-tool-group">
            <summary>
              <span className="tool-badge">⚙</span>
              <span>{summary}</span>
            </summary>
            <div className="tl-tool-list">
              {tools.map((t, k) => (
                <div key={k} className={`tl-tool-row ${t.resultError ? 'is-error' : ''}`}>
                  <span className="tl-tool-name">{t.name}</span>
                  <span className="muted small tl-tool-input">{inputSummary(t.input)}</span>
                  {t.resultText && (
                    <span className={`tl-tool-result-text ${t.resultError ? 'error' : ''} muted small`}>
                      → {t.resultError ? 'error: ' : ''}{t.resultText.replace(/\s+/g, ' ').slice(0, 140)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </details>
        )
      })
      // (start kept for future debugging hooks)
      void start
      continue
    }
    // tool_result with no preceding tool_use (rare); render collapsed.
    if (b.type === 'tool_result') {
      rows.push({
        key: `r${i}`,
        node: (
          <div className={`tl-bubble tl-tool-orphan muted small ${b.is_error ? 'error' : ''}`}>
            ↳ {resultSummary(b.content).slice(0, 200)}
          </div>
        )
      })
      i++
      continue
    }
    i++
  }
  return <>{rows.map((r) => <div key={r.key}>{r.node}</div>)}</>
}

/** Build a Codex-style one-liner: "Used Bash, Read, Edit" or "Ran 5 tools". */
function toolGroupSummary(tools: Array<{ name: string }>): string {
  if (tools.length === 0) return 'tool use'
  if (tools.length === 1) return `Ran ${tools[0].name}`
  const names = tools.map((t) => t.name)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const n of names) {
    if (!seen.has(n)) {
      seen.add(n)
      ordered.push(n)
    }
  }
  if (ordered.length <= 3) return `Used ${ordered.join(', ')}`
  return `Ran ${tools.length} tools (${ordered.slice(0, 3).join(', ')}, …)`
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
