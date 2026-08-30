import { useEffect, useState, useCallback } from 'react'
import Factory from './views/Factory'
import Workspace from './views/Workspace'
import Sources from './views/Sources'
import Library from './views/Library'
import SettingsView from './views/Settings'
import type { Job, Video, Game } from './types'

type View = 'factory' | 'sources' | 'library' | 'settings'

export default function App() {
  const [view, setView] = useState<View>('factory')
  const [jobs, setJobs] = useState<Job[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [videos, setVideos] = useState<Video[]>([])
  const [games, setGames] = useState<Game[]>([])
  const [maxWorkers, setMaxWorkers] = useState(3)

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
    window.api.getSettings().then((s) => setMaxWorkers(Number(s.maxWorkers) || 3))
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

  const building = jobs.filter((j) => j.status === 'running')
  const queued = jobs.filter((j) => j.status === 'queued').length
  const review = jobs.filter((j) => j.status === 'awaiting_review' || j.status === 'needs_input').length
  const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null

  // drill into a game workspace straight from the board
  if (selectedJob) {
    return (
      <Workspace
        job={selectedJob}
        onBack={() => setSelectedJobId(null)}
        onChanged={refreshJobs}
      />
    )
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" /> littlebench
        </div>
        <nav>
          <button className={view === 'factory' ? 'active' : ''} onClick={() => setView('factory')}>
            Factory
            <span className="count">
              {building.length > 0 && (
                <span className="chip chip-running">
                  {building.length}/{maxWorkers} active
                </span>
              )}
              {queued > 0 ? <span className="chip">{queued} queued</span> : null}
              {review > 0 ? <span className="chip chip-review">{review} review</span> : null}
            </span>
          </button>
          <button className={view === 'sources' ? 'active' : ''} onClick={() => setView('sources')}>
            Sources
          </button>
          <button className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>
            Library
          </button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}>
            Settings
          </button>
        </nav>
        <div className="sidebar-footer">
          {building.length > 0 ? (
            <div className="workers">
              {building.map((j, i) => (
                <div key={j.id} className="running-note">
                  <span className="spinner" /> #{i + 1} {j.title.slice(0, 32)}
                </div>
              ))}
            </div>
          ) : (
            <div className="running-note idle">workers idle</div>
          )}
        </div>
      </aside>

      <main className="main">
        {view === 'factory' && (
          <Factory
            jobs={jobs}
            videos={videos}
            games={games}
            maxWorkers={maxWorkers}
            onOpenJob={setSelectedJobId}
            onChanged={refreshJobs}
            onGoSources={() => setView('sources')}
          />
        )}
        {view === 'sources' && <Sources videos={videos} onChanged={refreshVideos} onChangedJobs={refreshJobs} />}
        {view === 'library' && <Library jobs={jobs} games={games} onChanged={refreshJobs} />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
