import { useEffect, useRef, useState, useCallback } from 'react'
import type { ForemanMessage } from '../types'

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

/** Talk to the foreman: the Claude agent that runs the factory.
 *  Paste a channel URL, ask for status, tell it what to build. */
export default function Chat() {
  const [messages, setMessages] = useState<ForemanMessage[]>([])
  const [live, setLive] = useState<Live | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [process, setProcess] = useState<ProcessItem[]>([])
  const [doneTurn, setDoneTurn] = useState<DoneTurn | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(0)
  const processRef = useRef<ProcessItem[]>([])
  const startRef = useRef(0)

  const load = useCallback(() => {
    window.api.foremanMessages().then((m) => setMessages(m as ForemanMessage[]))
  }, [])

  const pushProcess = (item: Omit<ProcessItem, 'id'>) => {
    const full = { ...item, id: ++idRef.current }
    processRef.current = [...processRef.current, full]
    setProcess(processRef.current)
  }

  const clearProcess = () => {
    processRef.current = []
    setProcess([])
    setDoneTurn(null)
  }

  /** End of a turn: collapse the process feed into an expandable summary. */
  const finalizeTurn = () => {
    const items = processRef.current
    const tools = items.filter((i) => i.kind === 'tool').length
    const seconds = startRef.current ? Math.max(1, Math.round((Date.now() - startRef.current) / 1000)) : 0
    if (items.length > 0) setDoneTurn({ items, tools, seconds })
    processRef.current = []
    setProcess([])
  }

  useEffect(() => {
    load()
    window.api.foremanBusy().then((b) => setBusy(Boolean(b)))
    const offs = [
      window.api.on('foreman:event', (payload) => {
        const p = payload as { type: string; text?: string; label?: string; detail?: string; error?: boolean | string | null }
        if (p.type === 'user') {
          clearProcess()
          setLive(null)
          startRef.current = Date.now()
          setMessages((prev) => [
            ...prev,
            { id: -Date.now(), role: 'user', content: p.text ?? '', created_at: '' }
          ])
        } else if (p.type === 'delta') {
          setBusy(true)
          setLive((prev) => ({ role: 'assistant', text: (prev?.text ?? '') + (p.text ?? '') }))
        } else if (p.type === 'thinking') {
          setBusy(true)
          pushProcess({ kind: 'thinking', text: p.text ?? '' })
        } else if (p.type === 'tool') {
          setBusy(true)
          pushProcess({ kind: 'tool', text: p.label ?? '', detail: p.detail })
        } else if (p.type === 'tool_result') {
          pushProcess({ kind: 'tool_result', text: '', detail: p.detail, error: Boolean(p.error) })
        } else if (p.type === 'done') {
          finalizeTurn()
          if (p.error) {
            setLive(null)
            setBusy(false)
            load()
          }
        } else if (p.type === 'saved' || p.type === 'reset') {
          finalizeTurn()
          setLive(null)
          setBusy(false)
          load()
        }
      }),
      window.api.on('foreman:changed', () => load())
    ]
    const timer = setInterval(() => window.api.foremanBusy().then((b) => setBusy(Boolean(b))), 3000)
    return () => {
      offs.forEach((off) => off())
      clearInterval(timer)
    }
  }, [load])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, live, process])

  const send = async () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    setBusy(true)
    const res = await window.api.foremanSend(text)
    if (!res.ok) {
      setMessages((prev) => [
        ...prev,
        { id: -Date.now(), role: 'system', content: res.error ?? 'failed to send', created_at: '' }
      ])
      setBusy(false)
    }
  }

  return (
    <div className="chat">
      <div className="chat-header">
        <div>
          <h1>Foreman</h1>
          <div className="muted small">
            Talk to the agent that runs the factory - paste a YouTube channel URL, ask what to build,
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
        {messages.length === 0 && !live && (
          <div className="chat-welcome">
            <div className="chat-welcome-title">🧢 The foreman is ready.</div>
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
          <div key={m.id} className={`chat-msg ${m.role}`}>
            <div className="chat-role">{m.role === 'user' ? 'you' : m.role === 'assistant' ? 'foreman' : 'system'}</div>
            <div className="chat-bubble">{m.content}</div>
          </div>
        ))}
        {process.length > 0 && (
          <div className="chat-process">
            <div className="chat-process-head">
              <span className="spinner" /> working…
            </div>
            {process.map((item) => (
              <ProcessRow key={item.id} item={item} />
            ))}
          </div>
        )}
        {live && (
          <div className="chat-msg assistant">
            <div className="chat-role">foreman</div>
            <div className="chat-bubble">
              {live.text}
              <span className="chat-cursor" />
            </div>
          </div>
        )}
        {doneTurn && (
          <details className="chat-process-done">
            <summary>
              ⚙ ran {doneTurn.tools} tool{doneTurn.tools === 1 ? '' : 's'} in {doneTurn.seconds}s
            </summary>
            {doneTurn.items.map((item) => (
              <ProcessRow key={`d-${item.id}`} item={item} />
            ))}
          </details>
        )}
        {busy && !live && process.length === 0 && (
          <div className="chat-msg assistant">
            <div className="chat-role">foreman</div>
            <div className="chat-bubble muted">
              <span className="spinner" /> working…
            </div>
          </div>
        )}
      </div>

      <div className="chat-input">
        <textarea
          value={draft}
          rows={Math.min(5, Math.max(1, draft.split('\n').length))}
          placeholder={busy ? 'The foreman is working…' : 'Message the foreman… (Enter to send)'}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="primary" disabled={busy || !draft.trim()} onClick={send}>
          Send
        </button>
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
