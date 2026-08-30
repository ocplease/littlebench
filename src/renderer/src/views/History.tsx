import { useState } from 'react'
import type { Job, Game } from '../types'

interface Props {
  jobs: Job[]
  games: Game[]
  onChanged: () => void
}

export default function History({ jobs, games, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const localize = async (jobId: string, language: 'zh-Hans' | 'ja') => {
    setBusy(`${jobId}:${language}`)
    setMsg(null)
    try {
      const id = await window.api.localizeJob(jobId, language)
      setMsg(id ? `Localization job queued (${language}): ${id}` : 'Localization failed - parent job not found.')
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  // Group: English jobs (language=en) with their localized children
  const enJobs = jobs.filter((j) => j.language === 'en' && j.status !== 'discarded')
  const childrenOf = (jobId: string) => jobs.filter((j) => j.parent_job_id === jobId)
  const gameFor = (jobId: string) => games.find((g) => g.job_id === jobId)

  return (
    <div className="history">
      <h2>History</h2>
      {msg && <div className="notice">{msg}</div>}
      {enJobs.length === 0 && <div className="empty">No games yet.</div>}
      {enJobs.map((job) => {
        const game = gameFor(job.id)
        const children = childrenOf(job.id)
        return (
          <div key={job.id} className="history-card">
            <div className="history-main">
              <div className="history-title">
                {game?.name ?? job.title}
                <span className={`chip status-chip-${job.status}`}>{job.status}</span>
              </div>
              <div className="muted small">
                {job.card0_game_id && <>game {job.card0_game_id.slice(0, 8)} · </>}
                {game?.card_count ? `${game.card_count} cards · ` : ''}
                {job.finished_at ? new Date(job.finished_at).toLocaleString() : ''}
              </div>
              {game?.card0_game_id && (
                <button onClick={() => window.api.openGame(game.card0_game_id!)}>Open in card0</button>
              )}
              <div className="history-actions">
                <button
                  disabled={busy !== null}
                  onClick={() => localize(job.id, 'zh-Hans')}
                >
                  {busy === `${job.id}:zh-Hans` ? '…' : 'Localize 中文'}
                </button>
                <button disabled={busy !== null} onClick={() => localize(job.id, 'ja')}>
                  {busy === `${job.id}:ja` ? '…' : 'Localize 日本語'}
                </button>
              </div>
            </div>
            {children.length > 0 && (
              <div className="history-children">
                {children.map((c) => (
                  <div key={c.id} className="history-child">
                    <span className="chip">{c.language}</span>
                    <span className={`chip status-chip-${c.status}`}>{c.status}</span>
                    <span className="muted small">{c.id}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
