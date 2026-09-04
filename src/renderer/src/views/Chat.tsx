import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import type { ForemanMessage } from '../types'
import { ModelPicker } from '../models'

interface Live {
  role: 'assistant'
  text: string
}

/** One step of the foreman's live process feed: a thinking block or a tool
 *  call. A tool's result arrives later and is attached to its row, mirroring
 *  how Claude Code nests `⎿ output` under `⏺ Tool(arg)`. */
interface ProcessItem {
  id: number
  kind: 'thinking' | 'tool'
  /** thinking: the thought text · tool: the tool NAME (Bash, Read…) */
  text: string
  /** tool: the identifying argument - a command, path, pattern */
  preview?: string
  /** tool: full input JSON, shown when the row is expanded */
  detail?: string
  /** tool: result output; undefined while the call is still running */
  result?: string
  error?: boolean
}

interface DoneTurn {
  items: ProcessItem[]
  tools: number
  seconds: number
}

/** The foreman's live turn, kept at module level so switching views does
 *  not throw the process feed away: the listener runs even while the Chat
 *  view is unmounted, and a remounted Chat renders whatever accumulated. */
let store = {
  busy: false,
  live: null as Live | null,
  process: [] as ProcessItem[],
  doneTurn: null as DoneTurn | null,
  /** last run was stopped by the user - show an "interrupted" divider */
  interrupted: false,
  /** the user text of the last sent message, for Retry */
  lastUser: ''
}
const storeListeners = new Set<() => void>()

function updateStore(patch: Partial<typeof store>): void {
  store = { ...store, ...patch }
  storeListeners.forEach((fn) => fn())
}

let idSeq = 0
let startAt = 0

function pushProcess(item: Omit<ProcessItem, 'id'>): void {
  updateStore({ process: [...store.process, { ...item, id: ++idSeq }] })
}

/** Attach a tool result to the most recent tool row that is still waiting
 *  for one (stream-json emits tool_use before its tool_result). */
function attachResult(detail: string | undefined, error: boolean): void {
  const items = store.process.slice()
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'tool' && items[i].result === undefined) {
      items[i] = { ...items[i], result: detail ?? '', error }
      updateStore({ process: items })
      return
    }
  }
  // orphan result with no matching tool row - nothing to attach to
}

/** End of a turn: collapse the process feed into an expandable summary. */
function finalizeTurn(): void {
  if (store.process.length === 0) return
  const tools = store.process.filter((i) => i.kind === 'tool').length
  const seconds = startAt ? Math.max(1, Math.round((Date.now() - startAt) / 1000)) : 0
  updateStore({ doneTurn: { items: store.process, tools, seconds }, process: [] })
}

// Registered once at module load - survives view switches.
window.api.on('foreman:event', (payload) => {
  const p = payload as {
    type: string
    text?: string
    name?: string
    preview?: string
    detail?: string
    error?: boolean | string | null
  }
  if (p.type === 'user') {
    startAt = Date.now()
    updateStore({ live: null, process: [], doneTurn: null, busy: true, interrupted: false, lastUser: p.text ?? '' })
  } else if (p.type === 'delta') {
    updateStore({ busy: true, live: { role: 'assistant', text: (store.live?.text ?? '') + (p.text ?? '') } })
  } else if (p.type === 'thinking') {
    updateStore({ busy: true })
    pushProcess({ kind: 'thinking', text: p.text ?? '' })
  } else if (p.type === 'tool') {
    updateStore({ busy: true })
    pushProcess({ kind: 'tool', text: p.name ?? 'tool', preview: p.preview, detail: p.detail })
  } else if (p.type === 'tool_result') {
    attachResult(p.detail, Boolean(p.error))
  } else if (p.type === 'done') {
    finalizeTurn()
    if (p.error) updateStore({ live: null, busy: false })
  } else if (p.type === 'interrupted') {
    finalizeTurn()
    updateStore({ live: null, busy: false, interrupted: true })
  } else if (p.type === 'saved' || p.type === 'reset') {
    finalizeTurn()
    updateStore({ live: null, busy: false, interrupted: false })
  }
})

/** The foreman's human-facing name. He runs the factory's jobs — hence Jobs. */
const FOREMAN_NAME = 'Steven'

/** Talk to the foreman: the Claude agent that runs the factory.
 *  Paste a channel URL, ask for status, tell it what to build. */
export default function Chat() {
  const [messages, setMessages] = useState<ForemanMessage[]>([])
  const [draft, setDraft] = useState('')
  const [, setTick] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    window.api.foremanMessages().then((m) => setMessages(m as ForemanMessage[]))
  }, [])

  useEffect(() => {
    load()
    window.api.foremanBusy().then((b) => {
      if (Boolean(b) !== store.busy) updateStore({ busy: Boolean(b) })
    })
    // Re-render when the module-level store changes.
    const rerender = () => setTick((t) => t + 1)
    storeListeners.add(rerender)
    const off = window.api.on('foreman:changed', load)
    const timer = setInterval(() => {
      window.api.foremanBusy().then((b) => {
        if (Boolean(b) !== store.busy) updateStore({ busy: Boolean(b) })
      })
    }, 3000)
    return () => {
      storeListeners.delete(rerender)
      off()
      clearInterval(timer)
    }
  }, [load])

  // Stick-to-bottom: keep scrolling to new content while the user is at the
  // bottom, but stop yanking them down the moment they scroll up to read.
  // Sending a message snaps back to the bottom.
  const atBottomRef = useRef(true)
  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  useEffect(() => {
    if (atBottomRef.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, store.live, store.process])

  const sendText = async (text: string) => {
    if (!text || store.busy) return
    atBottomRef.current = true
    updateStore({ busy: true })
    const res = await window.api.foremanSend(text)
    if (!res.ok) {
      setMessages((prev) => [
        ...prev,
        { id: -Date.now(), role: 'system', content: res.error ?? 'failed to send', created_at: '' }
      ])
      updateStore({ busy: false })
    } else {
      // The 'user' broadcast landed while the store listener was unpaused;
      // reload so the message list shows it immediately.
      load()
    }
  }

  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void sendText(text)
  }

  return (
    <div className="chat">
      <div className="chat-header">
        <div>
          <h1>Steven Jobs</h1>
          <div className="muted small">
            The factory foreman - paste a YouTube channel URL, ask what to build,
            check on the builders.
          </div>
        </div>
        {messages.length > 0 && (
          <button
            className="small-btn"
            title="Start a fresh conversation (keeps history in the DB)"
            onClick={() => window.api.foremanReset()}
          >
            New conversation
          </button>
        )}
      </div>

      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 && !store.live && (
          <div className="chat-welcome">
            <div className="chat-welcome-title">🧢 {FOREMAN_NAME} is ready.</div>
            <div className="muted">Try:</div>
            <button
              className="chat-suggestion"
              onClick={() => setDraft('Here is a card game channel: https://www.youtube.com/@BeforeYouPlay - find the videos that can become games and queue the best ones.')}
            >
              Here is a card game channel: youtube.com/@BeforeYouPlay - find videos that can become
              games and queue the best ones
            </button>
            <button className="chat-suggestion" onClick={() => setDraft('What is the factory working on right now?')}>
              What is the factory working on right now?
            </button>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} role={m.role} content={m.content} ts={m.created_at} />
        ))}
        {store.process.length > 0 && (
          <div className="cc-feed">
            <div className="cc-status">
              <span className="cc-star" />
              {FOREMAN_NAME} is working…
            </div>
            {store.process.map((item) => (
              <ProcessRow key={item.id} item={item} />
            ))}
          </div>
        )}
        {store.live && (
          <div className="chat-msg assistant">
            <div className="chat-role">{FOREMAN_NAME}</div>
            <div className="chat-bubble">
              <Md text={store.live.text} />
              <span className="chat-cursor" />
            </div>
          </div>
        )}
        {store.interrupted && !store.busy && (
          <div className="cc-interrupt">
            <span className="cc-interrupt-rule" />
            <span className="cc-interrupt-label">interrupted</span>
            {store.lastUser && (
              <button className="small-btn" onClick={() => void sendText(store.lastUser)}>
                Retry
              </button>
            )}
            <span className="cc-interrupt-rule" />
          </div>
        )}
        {store.doneTurn && (
          <details className="cc-done">
            <summary>
              <span className="cc-star done" />
              ran {store.doneTurn.tools} tool{store.doneTurn.tools === 1 ? '' : 's'} in {store.doneTurn.seconds}s
            </summary>
            {store.doneTurn.items.map((item) => (
              <ProcessRow key={`d-${item.id}`} item={item} />
            ))}
          </details>
        )}
        {store.busy && !store.live && store.process.length === 0 && (
          <div className="chat-msg assistant">
            <div className="chat-role">{FOREMAN_NAME}</div>
            <div className="chat-bubble muted">
              <span className="spinner" /> working…
            </div>
          </div>
        )}
      </div>

      <div className="chat-composer">
        <textarea
          className="chat-composer-input"
          value={draft}
          rows={Math.min(5, Math.max(1, draft.split('\n').length))}
          placeholder={store.busy ? `${FOREMAN_NAME} is working…` : `Message ${FOREMAN_NAME}… (Enter to send, Shift+Enter for newline)`}
          disabled={store.busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="chat-composer-foot">
          <div className="chat-composer-foot-left">
            {store.busy && (
              <>
                <span className="chat-working" title={`${FOREMAN_NAME} is running`}>
                  <span className="status-dot" /> Working…
                </span>
                <button
                  className="small-btn chat-stop"
                  title="Stop Steven's current run"
                  onClick={() => window.api.foremanStop()}
                >
                  Stop
                </button>
              </>
            )}
          </div>
          <div className="chat-composer-foot-right">
            <ModelPicker />
            <button
              className="primary chat-send"
              disabled={store.busy || !draft.trim()}
              onClick={send}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Minimal markdown for chat bubbles: fenced code blocks, inline code,
 *  bold, and bare links. Enough for the foreman's replies without pulling
 *  a markdown dependency into the bundle. */
function Md({ text }: { text: string }) {
  // Odd chunks live between ``` fences and render as code blocks.
  const chunks = text.split('```')
  return (
    <div className="md">
      {chunks.map((chunk, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="md-code">
            <code>{chunk.replace(/^[a-zA-Z0-9_+-]*\n/, '').replace(/\n$/, '')}</code>
          </pre>
        ) : chunk.trim() ? (
          <p key={i}>{renderInline(chunk)}</p>
        ) : null
      )}
    </div>
  )
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s<>"')]+)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    if (m[1] !== undefined) out.push(<code key={key++}>{m[1]}</code>)
    else if (m[2] !== undefined) out.push(<strong key={key++}>{m[2]}</strong>)
    else if (m[3] !== undefined)
      out.push(
        <a key={key++} href={m[3]} target="_blank" rel="noreferrer">
          {m[3]}
        </a>
      )
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** A single message in the chat log: role avatar, name, bubble. The avatar
 *  is a small colored circle with a one-letter initial — tighter than a full
 *  icon, reads at a glance, matches Codex. */
function MessageBubble({ role, content, ts }: { role: string; content: string; ts?: string }) {
  const display = role === 'user' ? 'you' : role === 'assistant' ? FOREMAN_NAME : 'system'
  const initial = display[0]?.toUpperCase() ?? '·'
  return (
    <div className={`chat-msg chat-msg-new ${role}`}>
      <div className={`chat-avatar chat-avatar-${role}`}>{initial}</div>
      <div className="chat-body">
        <div className="chat-meta">
          <span className="chat-name">{display}</span>
          {ts && <span className="chat-time muted small">{ts.slice(11, 16)}</span>}
        </div>
        <div className="chat-bubble-new">
          <Md text={content} />
        </div>      </div>
    </div>
  )
}

/** One row of the process feed, laid out like Claude Code's terminal:
 *
 *   ⏵⏵ Think                          <- collapsed thinking, dim + italic
 *   ⏺ Bash(lb scout --new)            <- tool dot + bold name + arg preview
 *     ⎿ Scouted 12 videos, 4 fit…     <- branch char + first line, expandable
 *
 * The ⎿ line is always visible (that's the at-a-glance output); expanding
 * shows the full output. A tool still awaiting its result shows a spinner
 * on the branch line instead. */
function ProcessRow({ item }: { item: ProcessItem }) {
  if (item.kind === 'thinking') {
    return (
      <details className="cc-row cc-think">
        <summary>
          <span className="cc-caret">⏵</span>
          <span className="cc-think-label">Think</span>
          <span className="cc-hint">{item.text.replace(/\s+/g, ' ').slice(0, 60)}</span>
        </summary>
        <pre className="cc-body">{item.text}</pre>
      </details>
    )
  }

  const lines = (item.result ?? '').split('\n').filter((l) => l.trim())
  const firstLine = lines[0] ?? ''
  const truncated = lines.length > 1 || (item.result ?? '').length > firstLine.length + 40
  // A failed tool call opens itself: errors are the one output you always
  // want to see in full (matches Claude Code's red expanded rows).
  const expandable = truncated || item.error === true

  return (
    <div className={`cc-row cc-tool${item.error ? ' cc-err' : ''}`}>
      <div className="cc-head" title={item.detail}>
        <span className="cc-dot" />
        <span className="cc-name">{item.text}</span>
        {item.preview && <span className="cc-arg">({item.preview})</span>}
      </div>
      {item.result === undefined ? (
        <div className="cc-out">
          <span className="cc-branch" />
          <span className="spinner cc-mini" />
        </div>
      ) : expandable ? (
        <details className="cc-out" open={item.error === true}>
          <summary>
            <span className="cc-branch" />
            <span className="cc-line">{(firstLine || (item.error ? 'error' : 'done')).slice(0, 130)} …</span>
          </summary>
          <pre className="cc-body">{item.result}</pre>
        </details>
      ) : (
        <div className="cc-out">
          <span className="cc-branch" />
          <span className="cc-line">{firstLine.slice(0, 130)}</span>
        </div>
      )}
    </div>
  )
}
