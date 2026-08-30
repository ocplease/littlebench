import { useEffect, useState, useCallback } from 'react'
import Channels from './views/Channels'
import Jobs from './views/Jobs'
import History from './views/History'
import SettingsView from './views/Settings'
import type { Job, Video, Game } from './types'

type View = 'jobs' | 'channels' | 'history' | 'settings'

export default function App() {
  const [view, setView] = useState<View>('jobs')
  const [jobs, setJobs] = useState<Job[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [videos, setVideos] = useState<Video[]>([])
  const [games, setGames] = useState<Game[]>([])

  const refreshJobs = useCallback(() => {
    window.api.listJobs().then((j) => setJobs(j as Job[]))
  }, [])
  const refreshVideos = useCallback(() => {
    window.api.listVideos().then((v) => setVideos(v as Video[]))
  }, [])
  const refreshGames = useCallback(() => {
    window.api.listGames().then((g) => setGames(g as Game[]))
  }, [])

  useEffect(() => {
    window.api.bootstrap()
    refreshJobs()
    refreshVideos()
    refreshGames()
    const offs = [
      window.api.on('jobs:changed', () => {
        refreshJobs()
        refreshGames()
      }),
      window.api.on('videos:changed', () => refreshVideos())
    ]
    const timer = setInterval(refreshJobs, 10_000)
    return () => {
      offs.forEach((off) => off())
      clearInterval(timer)
    }
  }, [refreshJobs, refreshVideos, refreshGames])

  const running = jobs.find((j) => j.status === 'running')
  const queued = jobs.filter((j) => j.status === 'queued').length
  const review = jobs.filter((j) => j.status === 'awaiting_review').length

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" /> card0 workbench
        </div>
        <nav>
          <button className={view === 'jobs' ? 'active' : ''} onClick={() => setView('jobs')}>
            Jobs
            <span className="count">
              {running ? <span className="chip chip-running">1 running</span> : null}
              {queued > 0 ? <span className="chip">{queued} queued</span> : null}
              {review > 0 ? <span className="chip chip-review">{review} to review</span> : null}
            </span>
          </button>
          <button className={view === 'channels' ? 'active' : ''} onClick={() => setView('channels')}>
            Channels
          </button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
            History
          </button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            Settings
          </button>
        </nav>
        <div className="sidebar-footer">
          {running ? (
            <div className="running-note">
              <span className="spinner" /> {running.title.slice(0, 40)}
            </div>
          ) : (
            <div className="running-note idle">idle</div>
          )}
        </div>
      </aside>

      <main className="main">
        {view === 'jobs' && (
          <Jobs
            jobs={jobs}
            selectedJobId={selectedJobId}
            onSelect={setSelectedJobId}
            onChanged={refreshJobs}
          />
        )}
        {view === 'channels' && <Channels videos={videos} onChanged={refreshVideos} />}
        {view === 'history' && <History jobs={jobs} games={games} onChanged={refreshJobs} />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
