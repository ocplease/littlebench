import { useEffect, useRef, useState, useCallback } from 'react'
import type { ForemanMessage } from '../types'
import { ModelPicker } from '../models'

interface Live {
  role: 'assistant'
  text: string
}

/** One step of the foreman's live process feed: a thinking block, a tool
 *  call, or a tool result - rendered like Codex's inline activity. */
interface ProcessItem {
  id: number
  kind: 'thinking' | 'tool' | 'tool_result'
  text: string
  detail?: string
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
  doneTurn: null as DoneTurn | null
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

/** End of a turn: collapse the process feed into an expandable summary. */
function finalizeTurn(): void {
  if (store.process.length === 0) return
  const tools = store.process.filter((i) => i.kind === 'tool').length
  const seconds = startAt ? Math.max(1, Math.round((Date.now() - startAt) / 1000)) : 0
  updateStore({ doneTurn: { items: store.process, tools, seconds }, process: [] })
}

// Registered once at module load - survives view switches.
window.api.on('foreman:event', (payload) => {
  const p = payload as { type: string; text?: string; label?: string; detail?: string; error?: boolean | string | null }
  if (p.type === 'user') {
    startAt = Date.now()
    updateStore({ live: null, process: [], doneTurn: null, busy: true })
  } else if (p.type === 'delta') {
    updateStore({ busy: true, live: { role: 'assistant', text: (store.live?.text ?? '') + (p.text ?? '') } })
  } else if (p.type === 'thinking') {
    updateStore({ busy: true })
    pushProcess({ kind: 'thinking', text: p.text ?? '' })
  } else if (p.type === 'tool') {
    updateStore({ busy: true })
    pushProcess({ kind: 'tool', text: p.label ?? '', detail: p.detail })
  } else if (p.type === 'tool_result') {
    pushProcess({ kind: 'tool_result', text: '', detail: p.detail, error: Boolean(p.error) })
  } else if (p.type === 'done') {
    finalizeTurn()
    if (p.error) updateStore({ live: null, busy: false })
  } else if (p.type === 'saved' || p.type === 'reset') {
    finalizeTurn()
    updateStore({ live: null, busy: false })
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

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, store.live, store.process])

  const send = async () => {
    const text = draft.trim()
    if (!text || store.busy) return
    setDraft('')
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

      <div className="chat-list" ref={listRef}>
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
          <div className="chat-process">
            <div className="chat-process-head">
              <span className="spinner" /> working…
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
              {store.live.text}
              <span className="chat-cursor" />
            </div>
          </div>
        )}
        {store.doneTurn && (
          <details className="chat-process-done">
            <summary>
              ⚙ ran {store.doneTurn.tools} tool{store.doneTurn.tools === 1 ? '' : 's'} in {store.doneTurn.seconds}s
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
              <span className="chat-working" title={`${FOREMAN_NAME} is running`}>
                <span className="status-dot" /> Working…
              </span>
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
        <div className="chat-bubble-new">{content}</div>
      </div>
    </div>
  )
}

/** One collapsible step in the process feed - thinking, a tool call, or its result. */
function ProcessRow({ item }: { item: ProcessItem }) {
  if (item.kind === 'thinking') {
    return (
      <details className="cp-row cp-thinking">
        <summary>
          <span className="cp-badge">thinking</span>
          <span className="cp-line">{item.text.replace(/\s+/g, ' ').slice(0, 90)}</span>
        </summary>
        <pre>{item.text}</pre>
      </details>
    )
  }
  if (item.kind === 'tool') {
    return (
      <details className="cp-row cp-tool">
        <summary>
          <span className="cp-badge">run</span>
          <span className="cp-line">{item.text.replace(/\s+/g, ' ').slice(0, 110)}</span>
        </summary>
        {item.detail ? <pre>{item.detail}</pre> : null}
      </details>
    )
  }
  return (
    <details className={`cp-row cp-result ${item.error ? 'error' : ''}`}>
      <summary>
        <span className="cp-badge">{item.error ? '✗ error' : '↳ result'}</span>
        <span className="cp-line">{(item.detail ?? '').replace(/\s+/g, ' ').slice(0, 90)}</span>
      </summary>
      <pre>{item.detail}</pre>
    </details>
  )
}
