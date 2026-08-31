import { useEffect, useRef, useState } from 'react'
import type { Video } from '../types'
import { CLASSIFICATION_LABEL, RIGHTS_LABEL } from '../types'

interface Props {
  videos: Video[]
  onChanged: () => void
  onChangedJobs: () => void
}

/** YouTube channels + the scout funnel: cheap metadata pass, deep transcript pass. */
export default function Sources({ videos, onChanged, onChangedJobs }: Props) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const noticesRef = useRef<HTMLDivElement>(null)

  const channels = Array.from(new Set(videos.map((v) => v.channel))).sort()

  const ingest = async () => {
    if (!url.trim()) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await window.api.ingestChannel(url.trim())
      setNotice(`Added ${res.added} new videos (playlist had ${res.total}).`)
      setUrl('')
      onChanged()
    } catch (e) {
      setNotice(`Ingest failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const scoutNew = async () => {
    const ids = videos.filter((v) => v.status === 'new').map((v) => v.id)
    if (!ids.length) {
      setNotice('No new videos to scout.')
      return
    }
    await window.api.runTriage(ids)
    setNotice(`Scouting ${ids.length} videos (cheap pass)…`)
  }

  const deepScout = async (id: number) => {
    setNotice('Deep scouting (fetching transcript)…')
    const res = await window.api.deepScout(id)
    setNotice(res.ok ? 'Deep scout done.' : `Deep scout failed: ${res.error ?? 'unknown'}`)
    onChanged()
  }

  const deepScoutSelected = async () => {
    for (const id of selected) await deepScout(id)
    setSelected(new Set())
  }

  const queueSelected = async () => {
    const picks = videos.filter((v) => selected.has(v.id))
    if (!picks.length) return
    await window.api.queueVideos(picks.map((v) => ({ id: v.id, title: v.title, url: v.url })))
    for (const v of picks) await window.api.setVideoStatus(v.id, 'queued', null)
    setSelected(new Set())
    onChanged()
    onChangedJobs()
  }

  const remove = async (id: number) => {
    await window.api.deleteVideo(id)
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    onChanged()
  }

  const removeSelected = async () => {
    for (const id of selected) await window.api.deleteVideo(id)
    setSelected(new Set())
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

  useEffect(() => {
    noticesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [notice])

  return (
    <div className="sources">
      <h1>Sources</h1>

      <div className="ingest-row">
        <input
          placeholder="https://www.youtube.com/@BoardGameChannel"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ingest()}
        />
        <button className="primary" disabled={busy || !url.trim()} onClick={ingest}>
          {busy ? 'Ingesting…' : 'Add channel'}
        </button>
        <button onClick={scoutNew}>Scout new videos</button>
      </div>
      {notice && <div className="notice info" ref={noticesRef}>{notice}</div>}

      {channels.length > 0 && (
        <div className="channel-row muted small">Channels: {channels.join(' · ')}</div>
      )}

      {selected.size > 0 && (
        <div className="selection-bar">
          {selected.size} selected
          <button onClick={deepScoutSelected}>Deep scout (transcripts)</button>
          <button className="primary" onClick={queueSelected}>Queue for build</button>
          <button className="danger" onClick={removeSelected}>Delete</button>
          <button className="link" onClick={() => setSelected(new Set())}>clear</button>
        </div>
      )}

      <table className="video-table">
        <thead>
          <tr>
            <th />
            <th>Video</th>
            <th>Classification</th>
            <th>Card0 fit</th>
            <th>Rights</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {videos.length === 0 && (
            <tr>
              <td colSpan={7} className="empty">
                No videos yet - add a YouTube channel above.
              </td>
            </tr>
          )}
          {videos.map((v) => (
            <tr key={v.id} className={v.status}>
              <td>
                <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} />
              </td>
              <td className="video-cell">
                {v.thumbnail_url ? (
                  <img src={v.thumbnail_url} alt="" className="row-thumb" loading="lazy" />
                ) : (
                  <div className="row-thumb row-thumb-fallback">{v.title.slice(0, 1).toUpperCase()}</div>
                )}
                <div>
                  <a href={v.url} target="_blank" rel="noreferrer" className="video-title">{v.title}</a>
                  <div className="muted small">
                    {v.channel}
                    {v.duration_s ? ` · ${Math.round(v.duration_s / 60)} min` : ''}
                  </div>
                </div>
              </td>
              <td>
                {v.classification ? (
                  <span className={`cls-chip cls-${v.classification}`}>
                    {CLASSIFICATION_LABEL[v.classification] ?? v.classification}
                  </span>
                ) : (
                  <span className="muted small">-</span>
                )}
              </td>
              <td>
                {v.fit_score != null ? (
                  <div className="fit-cell">
                    <div className="progress-bar slim">
                      <div
                        className={`progress-fill ${v.fit_score >= 75 ? 'fit-high-fill' : v.fit_score >= 50 ? 'fit-mid-fill' : 'fit-low-fill'}`}
                        style={{ width: `${Math.min(100, v.fit_score)}%` }}
                      />
                    </div>
                    <span className="small">{v.fit_score}</span>
                  </div>
                ) : (
                  <span className="muted small">-</span>
                )}
              </td>
              <td>
                {v.rights_status ? (
                  <span className={`rights-chip rights-${v.rights_status}`} title={v.rights_status}>
                    {RIGHTS_LABEL[v.rights_status] ?? v.rights_status}
                  </span>
                ) : (
                  <span className="muted small">-</span>
                )}
              </td>
              <td>
                <span className={`status-chip st-${v.status}`}>{v.status}</span>
                {v.triage_reason && <div className="muted small ellipsis" style={{ maxWidth: 220 }}>{v.triage_reason}</div>}
              </td>
              <td>
                <div className="row-actions">
                  {v.status !== 'queued' && v.status !== 'triaging' && (
                    <button
                      className="small-btn"
                      onClick={async () => {
                        await window.api.queueVideos([{ id: v.id, title: v.title, url: v.url }])
                        await window.api.setVideoStatus(v.id, 'queued', null)
                        onChanged()
                        onChangedJobs()
                      }}
                    >
                      Build
                    </button>
                  )}
                  <button className="small-btn" disabled={v.status === 'triaging'} onClick={() => deepScout(v.id)}>
                    Deep scout
                  </button>
                  <button className="small-btn row-del" title="Remove from sources" onClick={() => remove(v.id)}>
                    ✕
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
