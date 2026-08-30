import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchApi } from './api-types'

const api: WorkbenchApi = {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),

  // videos / channel ingest
  listVideos: () => ipcRenderer.invoke('videos:list'),
  setVideoStatus: (id, status, reason) => ipcRenderer.invoke('videos:setStatus', id, status, reason),
  ingestChannel: (url, max) => ipcRenderer.invoke('ingest:channel', url, max),
  runTriage: (videoIds) => ipcRenderer.invoke('triage:run', videoIds),

  // jobs
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  getJob: (id) => ipcRenderer.invoke('jobs:get', id),
  queueVideos: (videos) => ipcRenderer.invoke('jobs:queueSelected', videos),
  startJob: (id) => ipcRenderer.invoke('jobs:start', id),
  stopJob: (id) => ipcRenderer.invoke('jobs:stop', id),
  approveJob: (id) => ipcRenderer.invoke('jobs:approve', id),
  discardJob: (id) => ipcRenderer.invoke('jobs:discard', id),
  restartJob: (id) => ipcRenderer.invoke('jobs:restart', id),
  jobEvents: (id) => ipcRenderer.invoke('jobs:events', id),
  localizeJob: (jobId, language) => ipcRenderer.invoke('jobs:localize', jobId, language),

  // games + artifacts
  listGames: () => ipcRenderer.invoke('games:list'),
  openGame: (gameId) => ipcRenderer.invoke('games:open', gameId),
  listArtifacts: (jobId) => ipcRenderer.invoke('artifacts:list', jobId),
  readArtifact: (jobId, rel) => ipcRenderer.invoke('artifacts:read', jobId, rel),

  bootstrap: () => ipcRenderer.invoke('workbench:bootstrap'),

  // live updates from main
  on: (channel, cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
