import { contextBridge, ipcRenderer } from 'electron'
import type { WorkbenchApi } from './api-types'

const api: WorkbenchApi = {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),

  // videos / channel ingest / scout funnel
  listVideos: () => ipcRenderer.invoke('videos:list'),
  setVideoStatus: (id, status, reason) => ipcRenderer.invoke('videos:setStatus', id, status, reason),
  ingestChannel: (url, max) => ipcRenderer.invoke('ingest:channel', url, max),
  runTriage: (videoIds) => ipcRenderer.invoke('triage:run', videoIds),
  deepScout: (videoId) => ipcRenderer.invoke('scout:deep', videoId),

  // jobs
  listJobs: () => ipcRenderer.invoke('jobs:list'),
  getJob: (id) => ipcRenderer.invoke('jobs:get', id),
  queueVideos: (videos) => ipcRenderer.invoke('jobs:queueSelected', videos),
  startJob: (id) => ipcRenderer.invoke('jobs:start', id),
  stopJob: (id) => ipcRenderer.invoke('jobs:stop', id),
  pauseJob: (id) => ipcRenderer.invoke('jobs:pause', id),
  syncJobStatus: (id) => ipcRenderer.invoke('jobs:syncStatus', id),
  resumeJob: (id) => ipcRenderer.invoke('jobs:resume', id),
  approveJob: (id) => ipcRenderer.invoke('jobs:approve', id),
  discardJob: (id) => ipcRenderer.invoke('jobs:discard', id),
  restartJob: (id) => ipcRenderer.invoke('jobs:restart', id),
  jobEvents: (id) => ipcRenderer.invoke('jobs:events', id),
  localizeJob: (jobId, language) => ipcRenderer.invoke('jobs:localize', jobId, language),
  steerJob: (id, message, artifactPath) => ipcRenderer.invoke('jobs:steer', id, message, artifactPath),
  jobIsLive: (id) => ipcRenderer.invoke('jobs:isLive', id),
  jobMessages: (id) => ipcRenderer.invoke('jobs:messages', id),

  // games + artifacts
  listGames: () => ipcRenderer.invoke('games:list'),
  openGame: (gameId) => ipcRenderer.invoke('games:open', gameId),
  listArtifacts: (jobId) => ipcRenderer.invoke('artifacts:list', jobId),
  listProtocolArtifacts: (jobId) => ipcRenderer.invoke('artifacts:protocol', jobId),
  readArtifact: (jobId, rel) => ipcRenderer.invoke('artifacts:read', jobId, rel),
  readTextArtifact: (jobId, rel) => ipcRenderer.invoke('artifacts:readText', jobId, rel),

  bootstrap: () => ipcRenderer.invoke('workbench:bootstrap'),

  // foreman chat
  foremanSend: (message) => ipcRenderer.invoke('foreman:send', message),
  foremanMessages: () => ipcRenderer.invoke('foreman:messages'),
  foremanBusy: () => ipcRenderer.invoke('foreman:busy'),
  foremanReset: () => ipcRenderer.invoke('foreman:reset'),

  // live updates from main
  on: (channel, cb) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
