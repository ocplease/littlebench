import { useEffect, useState } from 'react'
import type { Job, Game } from '../types'

interface Props {
  jobs: Job[]
  games: Game[]
  onChanged: () => void
}

/** Published card0 games + on-demand localization. */
export default function Library({ jobs, games, onChanged }: Props) {
  const [covers, setCovers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const next: Record<string, string> = {}
      for (const g of games) {
        if (g.cover_path) {
          const key = `${g.job_id}:${g.language}`
          const d = await window.api.readArtifact(g.job_id, g.cover_path)
          if (d) next[key] = d
        }
      }
      if (alive) setCovers(next)
    }
    load()
    return () => {
      alive = false
    }
  }, [games])

  const localize = async (game: Game, language: 'zh-Hans' | 'ja') => {
    setBusy(true)
    try {
      await window.api.localizeJob(game.job_id, language)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="library">
      <h1>Library</h1>
      {games.length === 0 && <div className="empty">No games yet - publish one from Review.</div>}
      <div className="library-grid">
        {games.map((g) => {
          const key = `${g.job_id}:${g.language}`
          const job = jobs.find((j) => j.id === g.job_id)
          return (
            <article key={key} className="game-card">
              {covers[key] ? (
                <img src={covers[key]} alt="" className="game-cover" />
              ) : (
                <div className="game-cover game-cover-fallback">{(g.name ?? '?').slice(0, 1).toUpperCase()}</div>
              )}
              <div className="game-info">
                <div className="issue-title">{g.name ?? 'Untitled'}</div>
                <div className="muted small">
                  {g.language}
                  {g.card_count ? ` · ${g.card_count} cards` : ''}
                  {g.submitted_at ? ` · published ${g.submitted_at.slice(0, 10)}` : ' · draft'}
                </div>
                <div className="game-actions">
                  {g.card0_game_id && (
                    <button className="small-btn" onClick={() => window.api.openGame(g.card0_game_id!)}>
                      Open in card0 ↗
                    </button>
                  )}
                  {g.language === 'en' && job?.status === 'submitted' &&
                    (['zh-Hans', 'ja'] as const).map((lang) => {
                      // hide once that language exists (or is queued/running)
                      const localized = jobs.some(
                        (j) => j.parent_job_id === g.job_id && j.language === lang && j.status !== 'discarded'
                      )
                      if (localized) return null
                      return (
                        <button
                          key={lang}
                          className="small-btn"
                          disabled={busy}
                          onClick={() => localize(g, lang)}
                        >
                          {lang === 'zh-Hans' ? 'Localize 中文' : 'Localize 日本語'}
                        </button>
                      )
                    })}
                </div>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
