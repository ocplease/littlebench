import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { ensureDirs, jobWorkspace, workbenchRoot } from './paths'
import { installSkills } from './skills'
import { getDb, getSetting, setSetting, listVideos, listJobs, getJob, listGames, listArtifactsByJob, listMessages, listForemanMessages } from './db'
import { setBroadcast, setShuttingDown, createJob, startJob, stopJob, pauseJob, resumeJob, approveJob, syncJobStatus, discardJob, deleteJob, restartJob, steerJob, jobEventsFromDb, listArtifacts, recoverInterrupted, pumpQueue, openGame, jobIsLive } from './jobs'
import { ingestChannel, scoutVideos, deepScoutVideo } from './ingest'
import { updateVideoStatus, updateVideoScout, deleteVideo } from './db'
import { setForemanBroadcast, sendForeman, foremanBusy, resetForeman } from './foreman'
import { keyPoolStatus } from './keys'
import { card0AccountInfo, card0LoginWeb, card0LoginEmail, card0Logout, setCard0Broadcast } from './card0-auth'

let mainWindow: BrowserWindow | null = null

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'littlebench',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ---------- IPC handlers ----------

function handle(channel: string, fn: (...args: any[]) => any): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...args))
}

function registerIpc(): void {
  handle('settings:get', () => ({
    model: getSetting('model', 'minimax-m3'),
    triageModel: getSetting('triageModel', 'haiku'),
    autoQueue: getSetting('autoQueue', 'true'),
    bypassPermissions: getSetting('bypassPermissions', 'true'),
    maxVideos: getSetting('maxVideos', '50'),
    maxWorkers: getSetting('maxWorkers', '3'),
    quotaUntil: getSetting('quota_until', ''),
    autoLocalize: getSetting('autoLocalize', 'true'),
    claudeApiKeys: getSetting('claude_api_keys', ''),
    imageApiKeys: getSetting('image_api_keys', ''),
    keyPool: keyPoolStatus(),
    autoImageGen: getSetting('autoImageGen', 'true') as 'true' | 'false'
  }))
  handle('settings:set', (s: Record<string, string>) => {
    // The renderer speaks camelCase; these DB rows are snake_case. Translate,
    // or the keys get saved under a name nothing ever reads back.
    const keyMap: Record<string, string> = {
      claudeApiKeys: 'claude_api_keys',
      imageApiKeys: 'image_api_keys'
    }
    for (const [k, v] of Object.entries(s)) {
      if (k === 'quotaUntil') continue // runtime quota state, not a setting
      if (k === 'keyPool') continue // snapshot, not a setting
      if (typeof v !== 'string') continue
      let value = v
      if (k === 'autoImageGen' && value !== 'true' && value !== 'false') value = 'true'
      setSetting(keyMap[k] ?? k, value)
    }
    broadcast('settings:changed', null)
    return true
  })

  handle('videos:list', () => listVideos())
  handle('videos:setStatus', (id: number, status: string, reason: string | null) =>
    updateVideoStatus(id, status as never, reason)
  )
  handle('videos:delete', (id: number) => {
    deleteVideo(id)
    broadcast('videos:changed', { id })
  })
  handle('ingest:channel', async (url: string, max?: number) => {
    const m = max ?? Number(getSetting('maxVideos', '50'))
    const res = await ingestChannel(url, m)
    // auto-scout: paste a channel, see candidates - never a silent empty board
    const fresh = listVideos().filter((v) => v.status === 'new').map((v) => v.id)
    if (fresh.length) {
      void scoutVideos(fresh, (id) => broadcast('videos:changed', { id }))
    }
    return res
  })
  handle('triage:run', async (videoIds: number[]) => {
    void scoutVideos(videoIds, (id, status, verdict) => {
      broadcast('videos:changed', { id, status, verdict })
    })
    return true // runs async; UI gets updates via videos:changed
  })
  handle('scout:deep', async (videoId: number) => {
    const video = listVideos().find((v) => v.id === videoId)
    if (!video) return { ok: false, error: 'video not found' }
    try {
      const verdict = await deepScoutVideo(video)
      updateVideoScout(videoId, {
        classification: verdict.classification,
        fit_score: verdict.fit_score,
        fit_reasons: JSON.stringify(verdict.fit_reasons),
        rights_status: verdict.rights_status
      })
      updateVideoStatus(
        videoId,
        verdict.classification === 'GAME_TUTORIAL' || verdict.classification === 'PLAYTHROUGH' ? 'candidate' : 'rejected',
        verdict.reason
      )
      broadcast('videos:changed', { id: videoId })
      return { ok: true, verdict }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  handle('jobs:list', () => listJobs())
  handle('jobs:get', (id: string) => getJob(id))
  handle('jobs:create', (input: { video_id?: number; title: string; youtube_url?: string }) =>
    createJob(input)
  )
  handle('jobs:queueSelected', (videos: Array<{ id: number; title: string; url: string }>) => {
    const ids: string[] = []
    for (const v of videos) {
      ids.push(createJob({ video_id: v.id, title: v.title, youtube_url: v.url }))
    }
    return ids
  })
  handle('jobs:start', (id: string) => {
    startJob(id)
    return true
  })
  handle('jobs:stop', (id: string) => {
    stopJob(id)
    return true
  })
  handle('jobs:pause', (id: string) => {
    pauseJob(id)
    return true
  })
  handle('jobs:resume', (id: string) => {
    resumeJob(id)
    return true
  })
  handle('jobs:approve', (id: string) => approveJob(id))
  handle('jobs:syncStatus', (id: string) => syncJobStatus(id))
  handle('jobs:discard', (id: string) => {
    discardJob(id)
    return true
  })
  handle('jobs:delete', (id: string) => {
    deleteJob(id)
    return true
  })
  handle('jobs:restart', (id: string) => {
    restartJob(id)
    return true
  })
  handle('jobs:events', (id: string) => jobEventsFromDb(id))
  handle('jobs:steer', (id: string, message: string, artifactPath?: string) => steerJob(id, message, artifactPath ?? null))
  handle('jobs:isLive', (id: string) => {
    const job = getJob(id)
    return job ? jobIsLive(job) : false
  })
  handle('jobs:messages', (id: string) => listMessages(id))
  handle('jobs:localize', (jobId: string, language: string) => {
    const parent = getJob(jobId)
    if (!parent) return null
    // Never duplicate a localization - the EN build's auto-queue may have
    // already created it. Reuse the existing child (discarded ones don't count).
    const existing = listJobs().find(
      (j) => j.parent_job_id === parent.id && j.language === language && j.status !== 'discarded'
    )
    if (existing) return existing.id
    return createJob({
      title: `${parent.title} (${language})`,
      youtube_url: parent.youtube_url,
      language,
      parent_job_id: parent.id
    })
  })

  handle('games:list', () => listGames())
  handle('games:open', (gameId: string) => openGame(gameId))

  handle('artifacts:list', (jobId: string) => listArtifacts(jobId))
  handle('artifacts:protocol', (jobId: string) => listArtifactsByJob(jobId))
  handle('artifacts:read', (jobId: string, rel: string) => {
    // only serve files inside the job workspace
    const root = jobWorkspace(jobId)
    const full = path.resolve(root, rel)
    if (!full.startsWith(root) || !existsSync(full)) return null
    const ext = path.extname(full).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    const data = readFileSync(full)
    return `data:${mime};base64,${data.toString('base64')}`
  })
  handle('artifacts:readText', (jobId: string, rel: string) => {
    // text artifacts (manifest.json, cards_plan.json...) for the artifact panel
    const root = jobWorkspace(jobId)
    const full = path.resolve(root, rel)
    if (!full.startsWith(root) || !existsSync(full)) return null
    const stat = readFileSync(full)
    if (stat.length > 512 * 1024) return null
    return stat.toString('utf8')
  })

  handle('workbench:bootstrap', () => {
    recoverInterrupted()
    pumpQueue()
    return true
  })

  // ---------- foreman chat ----------

  handle('foreman:send', (message: string) => sendForeman(message))
  handle('foreman:messages', () => listForemanMessages())
  handle('foreman:busy', () => foremanBusy())
  handle('foreman:reset', () => resetForeman())

  // ---------- card0 account / auth ----------

  handle('card0:accountInfo', () => card0AccountInfo())
  handle('card0:loginWeb', (opts?: { provider?: 'google' }) => card0LoginWeb(opts ?? {}))
  handle('card0:loginEmail', (email: string, password: string) => card0LoginEmail(email, password))
  handle('card0:logout', () => card0Logout())
}

// ---------- lifecycle ----------

app.whenReady().then(() => {
  ensureDirs()
  installSkills(workbenchRoot()) // skills for sessions spawned at the workbench root (foreman)
  getDb()
  setBroadcast(broadcast)
  setForemanBroadcast(broadcast)
  setCard0Broadcast(broadcast)
  registerIpc()
  createWindow()

  // Pick up jobs queued by other processes (foreman / CLI) even though they
  // never emit into this process's event bus.
  setInterval(() => pumpQueue(), 15_000).unref()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Stop the job machinery before the process goes away: agents get marked
// interrupted instead of failed, and nothing new is spawned into the void.
app.on('before-quit', () => setShuttingDown())
process.on('SIGTERM', () => {
  setShuttingDown()
  app.quit()
})
