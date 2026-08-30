import { useState } from 'react'
import type { Video } from '../types'

interface Props {
  videos: Video[]
  onChanged: () => void
}

export default function Channels({ videos, onChanged }: Props) {
  const [url, setUrl] = useState('')
  const [ingesting, setIngesting] = useState(false)
  const [triaging, setTriaging] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [msg, setMsg] = useState<string | null>(null)

  const ingest = async () => {
    if (!url.trim()) return
    setIngesting(true)
    setMsg(null)
    try {
      const res = await window.api.ingestChannel(url.trim())
      setMsg(`Added ${res.added} new videos (${res.total} on channel). Run triage to filter game tutorials.`)
      onChanged()
    } catch (e) {
      setMsg(`Ingest failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setIngesting(false)
    }
  }

  const triage = async () => {
    const untriaged = videos.filter((v) => v.status === 'new').map((v) => v.id)
    if (!untriaged.length) {
      setMsg('No new videos to triage.')
      return
    }
    setTriaging(true)
    setMsg(`Triaging ${untriaged.length} videos (streamed)…`)
    await window.api.runTriage(untriaged)
    setTriaging(false)
    setMsg('Triage finished.')
  }

  const queue = async () => {
    const chosen = videos.filter((v) => selected.has(v.id))
    if (!chosen.length) {
      setMsg('Select videos to queue first.')
      return
    }
    await window.api.queueVideos(chosen.map((v) => ({ id: v.id, title: v.title, url: v.url })))
    setMsg(`Queued ${chosen.length} jobs. See the Jobs tab.`)
    setSelected(new Set())
    onChanged()
  }

  const queueAllCandidates = async () => {
    const candidates = videos.filter((v) => v.status === 'candidate')
    if (!candidates.length) {
      setMsg('No candidates - run triage first.')
      return
    }
    await window.api.queueVideos(candidates.map((v) => ({ id: v.id, title: v.title, url: v.url })))
    setMsg(`Queued ${candidates.length} jobs.`)
    onChanged()
  }

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const fmtDur = (s: number | null) => (s ? `${Math.round(s / 60)}m` : '?')

  return (
    <div className="channels">
      <h2>Channels</h2>
      <div className="ingest-row">
        <input
          placeholder="https://www.youtube.com/@channel/videos"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ingest()}
        />
        <button className="primary" onClick={ingest} disabled={ingesting}>
          {ingesting ? 'Ingesting…' : 'Ingest'}
        </button>
        <button onClick={triage} disabled={triaging}>
          {triaging ? 'Triaging…' : 'Triage new'}
        </button>
        <button onClick={queueAllCandidates}>Queue all candidates</button>
      </div>
      {msg && <div className="notice">{msg}</div>}

      <div className="video-table">
        <div className="video-row video-row-header">
          <span />
          <span>Title</span>
          <span>Duration</span>
          <span>Status</span>
          <span>Reason</span>
        </div>
        {videos.length === 0 && <div className="empty">No videos ingested yet.</div>}
        {videos.map((v) => (
          <div key={v.id} className={`video-row ${selected.has(v.id) ? 'selected' : ''}`}>
            <label className="check">
              <input
                type="checkbox"
                checked={selected.has(v.id)}
                onChange={() => toggle(v.id)}
                disabled={v.status === 'rejected'}
              />
            </label>
            <a href={v.url} target="_blank" rel="noreferrer" className="video-title" title={v.title}>
              {v.title}
            </a>
            <span className="muted">{fmtDur(v.duration_s)}</span>
            <span>
              <span className={`chip triage-${v.status}`}>{v.status}</span>
            </span>
            <span className="muted small reason">{v.triage_reason ?? ''}</span>
          </div>
        ))}
      </div>
      {selected.size > 0 && (
        <div className="queue-bar">
          <span>{selected.size} selected</span>
          <button className="primary" onClick={queue}>
            Queue selected
          </button>
        </div>
      )}
    </div>
  )
}
