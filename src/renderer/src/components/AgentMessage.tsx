import { useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { StreamEvent } from '../types'

export interface QuestionPrompt {
  question: string
  options: string[]
}

interface TimelineTool {
  id: string
  name: string
  input: unknown
  result?: string
  error?: boolean
}

interface TimelineActivity {
  kind: 'tool' | 'thinking' | 'diagnostic'
  tool?: TimelineTool
  text?: string
}

type TimelineEntry =
  | { type: 'message'; id: string; text: string; ts?: string }
  | { type: 'activity'; id: string; items: TimelineActivity[]; ts?: string }
  | { type: 'milestone'; id: string; phase: string; note?: string | null; ts?: string }
  | { type: 'session'; id: string; ts?: string }
  | { type: 'result'; id: string; error: boolean; duration?: number; cost?: number; ts?: string }

const QUESTION_RE = /<workbench-question>\s*([\s\S]*?)\s*<\/workbench-question>/i

export function splitQuestion(text: string): { body: string; prompt: QuestionPrompt | null } {
  const match = text.match(QUESTION_RE)
  if (!match) return { body: text, prompt: null }
  try {
    const value = JSON.parse(match[1]) as { question?: unknown; options?: unknown }
    if (typeof value.question !== 'string') return { body: text, prompt: null }
    return {
      body: text.replace(match[0], '').trim(),
      prompt: {
        question: value.question,
        options: Array.isArray(value.options)
          ? value.options.filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
          : []
      }
    }
  } catch {
    return { body: text, prompt: null }
  }
}

/** GitHub-flavoured markdown with deliberate chat typography. Agent answers
 * are documents, not pre-wrapped terminal strings: headings, lists, tables,
 * links, quotes and code each get their own visual rhythm. */
export function RichMessage({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`agent-markdown ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
          pre: ({ children }) => <pre className="agent-code-block">{children}</pre>,
          code: ({ children, className: codeClass }) => <code className={codeClass}>{children}</code>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

export function DecisionCard({
  prompt,
  onSubmit,
  disabled = false,
  compact = false
}: {
  prompt: QuestionPrompt
  onSubmit: (answer: string) => void
  disabled?: boolean
  compact?: boolean
}) {
  const [selected, setSelected] = useState('')
  const [note, setNote] = useState('')
  const hasOptions = prompt.options.length > 0
  const canSubmit = !disabled && (selected.length > 0 || note.trim().length > 0)

  const submit = () => {
    if (!canSubmit) return
    const answer = selected && note.trim() ? `${selected}\n\n${note.trim()}` : selected || note.trim()
    onSubmit(answer)
  }

  return (
    <section className={`decision-card${compact ? ' is-compact' : ''}`} aria-labelledby="decision-question">
      <div className="decision-eyebrow"><span aria-hidden="true">?</span> Decision needed</div>
      <h3 id="decision-question">{prompt.question}</h3>
      {hasOptions && (
        <div className="decision-options" role="radiogroup" aria-label={prompt.question}>
          {prompt.options.map((option, index) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected === option}
              className={selected === option ? 'is-selected' : ''}
              disabled={disabled}
              onClick={() => setSelected(option)}
            >
              <span className="decision-key">{index + 1}</span>
              <span>{option}</span>
              <span className="decision-radio" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
      <label className="decision-note">
        <span>{hasOptions ? 'Add context (optional)' : 'Your answer'}</span>
        <textarea
          rows={compact ? 1 : 2}
          value={note}
          disabled={disabled}
          placeholder={hasOptions ? 'Anything the agent should keep in mind…' : 'Type your answer…'}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
      </label>
      <div className="decision-actions">
        <span>{selected ? `Selected: ${selected}` : hasOptions ? 'Choose one option' : 'Enter a response'}</span>
        <button type="button" className="decision-submit" disabled={!canSubmit} onClick={submit}>
          Send decision <span aria-hidden="true">→</span>
        </button>
      </div>
    </section>
  )
}

export function WorkerTimeline({
  events,
  live,
  agentName = 'Builder'
}: {
  events: StreamEvent[]
  live: boolean
  agentName?: string
}) {
  const entries = useMemo(() => buildTimeline(events), [events])
  if (entries.length === 0) return <div className="timeline-empty">Work will appear here as a readable timeline.</div>

  return (
    <div className="agent-timeline">
      {entries.map((entry) => {
        if (entry.type === 'session') {
          return (
            <div className="timeline-divider" key={entry.id}>
              <span /> <small>new worker pass</small> <span />
            </div>
          )
        }
        if (entry.type === 'message') {
          return (
            <article className="timeline-message" key={entry.id}>
              <div className="timeline-avatar" aria-hidden="true">B</div>
              <div className="timeline-message-body">
                <div className="timeline-meta"><strong>{agentName}</strong><TimeLabel value={entry.ts} /></div>
                <RichMessage text={entry.text} />
              </div>
            </article>
          )
        }
        if (entry.type === 'activity') return <ActivityGroup key={entry.id} entry={entry} live={live} />
        if (entry.type === 'milestone') {
          return (
            <details className="timeline-milestone" key={entry.id}>
              <summary>
                <span className="milestone-mark" aria-hidden="true">✓</span>
                <span><strong>{phaseName(entry.phase)}</strong>{entry.note ? ` · ${entry.note}` : ''}</span>
                <TimeLabel value={entry.ts} />
              </summary>
            </details>
          )
        }
        return (
          <div className={`timeline-result${entry.error ? ' is-error' : ''}`} key={entry.id}>
            <span className="result-mark" aria-hidden="true">{entry.error ? '!' : '✓'}</span>
            <span>{entry.error ? 'Pass ended with an error' : 'Pass completed'}</span>
            {entry.duration !== undefined && <small>{formatDuration(entry.duration)}</small>}
            {entry.cost !== undefined && <small>${entry.cost.toFixed(2)}</small>}
          </div>
        )
      })}
      {live && (
        <div className="timeline-working" role="status">
          <span className="timeline-pulse" aria-hidden="true" /> {agentName} is working
        </div>
      )}
    </div>
  )
}

function ActivityGroup({ entry, live }: { entry: Extract<TimelineEntry, { type: 'activity' }>; live: boolean }) {
  const tools = entry.items.filter((item) => item.kind === 'tool' && item.tool).map((item) => item.tool!)
  const thinking = entry.items.filter((item) => item.kind === 'thinking')
  const diagnostics = entry.items.filter((item) => item.kind === 'diagnostic')
  const errors = tools.filter((tool) => tool.error).length
  const running = tools.filter((tool) => tool.result === undefined).length
  const label = activityLabel(tools, thinking.length, diagnostics.length)

  return (
    <details className={`activity-group${errors ? ' has-error' : ''}`} open={errors > 0}>
      <summary>
        <span className={`activity-status${running && live ? ' is-running' : ''}`} aria-hidden="true">
          {errors ? '!' : running && live ? '' : '✓'}
        </span>
        <span className="activity-summary">
          <strong>{label}</strong>
          <small>{activityMeta(tools, thinking.length, diagnostics.length)}</small>
        </span>
        <TimeLabel value={entry.ts} />
        <span className="activity-caret" aria-hidden="true">›</span>
      </summary>
      <div className="activity-details">
        {entry.items.map((item, index) => {
          if (item.kind === 'thinking') {
            return (
              <details className="activity-thinking" key={`thinking-${index}`}>
                <summary><span>Reasoning</span><small>{oneLine(item.text).slice(0, 90)}</small></summary>
                <RichMessage text={item.text ?? ''} />
              </details>
            )
          }
          if (item.kind === 'diagnostic') {
            return (
              <details className="activity-diagnostic" key={`diagnostic-${index}`}>
                <summary>Runtime note</summary>
                <pre>{item.text}</pre>
              </details>
            )
          }
          return item.tool ? <ToolRow key={item.tool.id || index} tool={item.tool} /> : null
        })}
      </div>
    </details>
  )
}

function ToolRow({ tool }: { tool: TimelineTool }) {
  const summary = toolSummary(tool.name, tool.input)
  const resultLine = oneLine(tool.result).slice(0, 180)
  return (
    <details className={`activity-tool${tool.error ? ' is-error' : ''}`} open={tool.error === true}>
      <summary>
        <span className="tool-icon" aria-hidden="true">{toolIcon(tool.name)}</span>
        <span className="tool-copy"><strong>{toolVerb(tool.name)}</strong><small>{summary}</small></span>
        <span className={`tool-state${tool.result === undefined ? ' is-running' : ''}`}>
          {tool.error ? 'error' : tool.result === undefined ? 'running' : 'done'}
        </span>
        <span className="activity-caret" aria-hidden="true">›</span>
      </summary>
      <div className="tool-expanded">
        <LabeledCode label="Input" value={safeJson(tool.input)} />
        {tool.result !== undefined && <LabeledCode label={tool.error ? 'Error' : 'Result'} value={tool.result || '(no output)'} />}
      </div>
      {resultLine && !tool.error && <div className="tool-inline-result">↳ {resultLine}</div>}
    </details>
  )
}

function LabeledCode({ label, value }: { label: string; value: string }) {
  return <div className="tool-code"><span>{label}</span><pre>{value}</pre></div>
}

function TimeLabel({ value }: { value?: string }) {
  if (!value) return null
  const parsed = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return <time dateTime={parsed.toISOString()}>{parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
}

function buildTimeline(events: StreamEvent[]): TimelineEntry[] {
  const toolResults = new Map<string, { text: string; error: boolean }>()
  for (const wrapper of events) {
    for (const block of contentBlocks(wrapper.event)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      toolResults.set(block.tool_use_id, { text: resultText(block.content), error: Boolean(block.is_error) })
    }
  }

  const out: TimelineEntry[] = []
  let activity: Extract<TimelineEntry, { type: 'activity' }> | null = null
  let lastPhase = ''
  const flush = () => {
    if (!activity || activity.items.length === 0) return
    out.push(activity)
    activity = null
  }
  const addActivity = (item: TimelineActivity, wrapper: StreamEvent, suffix: string) => {
    if (!activity) activity = { type: 'activity', id: `activity-${wrapper.seq ?? out.length}-${suffix}`, items: [], ts: wrapper.ts }
    activity.items.push(item)
  }

  events.forEach((wrapper, eventIndex) => {
    const event = wrapper.event
    const id = `${wrapper.seq ?? eventIndex}-${eventIndex}`
    if (event.type === 'system' && event.subtype === 'init') {
      flush()
      out.push({ type: 'session', id: `session-${id}`, ts: wrapper.ts })
      return
    }
    if (event.type === 'protocol') {
      const protocol = event as unknown as { phase?: string; note?: string | null }
      if (protocol.phase && protocol.phase !== lastPhase) {
        flush()
        out.push({ type: 'milestone', id: `phase-${id}`, phase: protocol.phase, note: protocol.note, ts: wrapper.ts })
        lastPhase = protocol.phase
      }
      return
    }
    if (event.type === 'stderr') {
      const value = typeof event.text === 'string' ? event.text : eventText(event)
      if (value) addActivity({ kind: 'diagnostic', text: value }, wrapper, id)
      return
    }
    if (event.type === 'result') {
      flush()
      out.push({
        type: 'result', id: `result-${id}`, error: Boolean(event.is_error),
        duration: typeof event.duration_ms === 'number' ? event.duration_ms : undefined,
        cost: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
        ts: wrapper.ts
      })
      return
    }

    const role = event.message && typeof event.message === 'object' ? event.message.role : undefined
    for (const [blockIndex, block] of contentBlocks(event).entries()) {
      if (role === 'user' || block.type === 'tool_result') continue
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        addActivity({ kind: 'thinking', text: block.thinking }, wrapper, `${id}-${blockIndex}`)
      } else if (block.type === 'tool_use') {
        const toolId = typeof block.id === 'string' ? block.id : `tool-${id}-${blockIndex}`
        const result = toolResults.get(toolId)
        addActivity({
          kind: 'tool',
          tool: {
            id: toolId,
            name: typeof block.name === 'string' ? block.name : 'Tool',
            input: block.input,
            result: result?.text,
            error: result?.error
          }
        }, wrapper, `${id}-${blockIndex}`)
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        flush()
        out.push({ type: 'message', id: `message-${id}-${blockIndex}`, text: block.text, ts: wrapper.ts })
      }
    }
  })
  flush()
  return out
}

function contentBlocks(event: StreamEvent['event']): Array<Record<string, unknown>> {
  const message = event.message as { content?: unknown } | undefined
  if (!Array.isArray(message?.content)) return []
  return message.content.filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
}

function eventText(event: StreamEvent['event']): string {
  const message = event.message as { content?: unknown } | undefined
  return typeof message?.content === 'string' ? message.content : ''
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : safeJson(content)
  return content.map((item) => {
    if (item && typeof item === 'object' && 'text' in item) return String((item as { text: unknown }).text)
    return ''
  }).filter(Boolean).join('\n')
}

function activityLabel(tools: TimelineTool[], thinking: number, diagnostics: number): string {
  if (tools.length === 0 && thinking > 0) return 'Worked through the next step'
  if (tools.length === 0 && diagnostics > 0) return 'Runtime notes'
  const verbs = tools.map((tool) => toolVerb(tool.name))
  const unique = [...new Set(verbs)]
  if (tools.length === 1) return `${unique[0]} ${toolSummary(tools[0].name, tools[0].input)}`.trim()
  if (unique.length === 1) return `${unique[0]} ${tools.length} items`
  return `Worked across ${tools.length} steps`
}

function activityMeta(tools: TimelineTool[], thinking: number, diagnostics: number): string {
  const parts: string[] = []
  if (tools.length) parts.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}`)
  if (thinking) parts.push('reasoning')
  if (diagnostics) parts.push(`${diagnostics} runtime note${diagnostics === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

function toolVerb(name: string): string {
  const key = name.toLowerCase()
  if (['read', 'glob', 'grep', 'webfetch', 'websearch'].includes(key)) return 'Inspected'
  if (['write', 'edit', 'notebookedit'].includes(key)) return 'Updated'
  if (key === 'bash') return 'Ran'
  if (key === 'skill') return 'Loaded'
  if (['task', 'taskcreate', 'sendmessage'].includes(key)) return 'Delegated'
  return name
}

function toolIcon(name: string): ReactNode {
  const key = name.toLowerCase()
  if (['write', 'edit', 'notebookedit'].includes(key)) return '✎'
  if (key === 'bash') return '›_'
  if (['read', 'glob', 'grep'].includes(key)) return '⌕'
  if (key.startsWith('web')) return '↗'
  if (key === 'skill') return '◇'
  return '·'
}

function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const values = input as Record<string, unknown>
  const preferred = name.toLowerCase() === 'bash'
    ? ['description', 'command']
    : ['file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'command']
  for (const key of preferred) {
    const value = values[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const clean = oneLine(value)
    if (key === 'file_path' || key === 'path') return clean.split('/').pop() ?? clean
    return clean.slice(0, 110)
  }
  return ''
}

function phaseName(phase: string): string {
  return ({
    understand: 'Understanding complete', design: 'Design ready', art_direction: 'Art direction ready',
    production: 'Production updated', integration: 'Game integration updated', qa_publish: 'Ready for review'
  } as Record<string, string>)[phase] ?? phase.replaceAll('_', ' ')
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

function oneLine(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
