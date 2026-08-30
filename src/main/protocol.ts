import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { appendEvent, updateJob, upsertArtifact } from './db'
import { jobWorkspace } from './paths'

/** The workbench protocol: the agent's structured progress file.
 *
 *  Instead of the UI regex-parsing Claude's stdout, every job prompt tells the
 *  agent to maintain `.workbench/tasks.json` in its workspace via the Write
 *  tool (agents are reliable at Write; append-JSONL via bash is not). The
 *  runner polls it while the job runs and mirrors it into the DB.
 */
export interface ProtocolStage {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  detail?: string
}

export interface ProtocolArtifact {
  type: string // cover | card | manifest | cards_plan | game_spec | other
  path: string // relative to the job workspace
  label?: string
}

export interface ProtocolState {
  phase: string
  note?: string
  stages: ProtocolStage[]
  artifacts: ProtocolArtifact[]
  needs_input?: { question: string; options?: string[] } | null
}

export function protocolPath(jobId: string): string {
  return path.join(jobWorkspace(jobId), '.workbench', 'tasks.json')
}

export function parseProtocol(jobId: string): ProtocolState | null {
  const p = protocolPath(jobId)
  if (!existsSync(p)) return null
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as ProtocolState
    if (!parsed || typeof parsed.phase !== 'string' || !Array.isArray(parsed.stages)) return null
    return {
      phase: parsed.phase,
      note: parsed.note,
      stages: parsed.stages,
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      needs_input: parsed.needs_input ?? null
    }
  } catch {
    return null // mid-write partial file; next poll will get the whole thing
  }
}

/** Mirror a protocol state into the DB: job phase/needs_input, a protocol
 *  event, and artifact rows. Returns true when the state changed. */
export function applyProtocol(jobId: string, parsed: ProtocolState, prevJson: string | null): boolean {
  const json = JSON.stringify(parsed)
  if (json === prevJson) return false

  updateJob(jobId, {
    phase: parsed.phase,
    needs_input: parsed.needs_input ? JSON.stringify(parsed.needs_input) : null
  })
  appendEvent(jobId, 0, 'protocol', {
    type: 'protocol',
    phase: parsed.phase,
    note: parsed.note ?? null,
    stages: parsed.stages,
    needs_input: parsed.needs_input ?? null
  })
  for (const a of parsed.artifacts) {
    if (a && typeof a.path === 'string' && a.path) {
      upsertArtifact(jobId, { type: a.type || 'other', path: a.path, label: a.label ?? null })
    }
  }
  return true
}

/** The agent-facing contract, embedded in every job prompt. */
export const PROTOCOL_CONTRACT = [
  '- WORKBENCH PROTOCOL (critical for progress tracking): maintain the file `.workbench/tasks.json`',
  '  in this workspace using the Write tool. Update it at every meaningful step (start/end of each',
  '  skill stage, when an artifact is produced, when you need human input). Shape:',
  '  { "phase": "understand|design|art_direction|production|integration|qa_publish",',
  '    "note": "one-line status for the human",',
  '    "stages": [{"id": "transcript|manifest|validate|plan|art|compress|create|upload|review|submit",',
  '                "status": "pending|running|completed|failed", "detail": "optional"}],',
  '    "artifacts": [{"type": "cover|card|manifest|cards_plan|game_spec|other", "path": "relative/path", "label": "Human label"}],',
  '    "needs_input": null }',
  '  Set needs_input to {"question": "...", "options": ["...", "..."]} when the video is ambiguous',
  '  about something a human must decide; finish your pass and the human will answer, then you',
  '  continue. Keep artifacts as a complete list (rewrite the whole file each time).',
  '  Phase mapping: understand=Stage 1, design=Stages 2-3, art_direction=Stage 4-5,',
  '  production=Stages 6-7, integration=Stages 8-9, qa_publish=Stage 10.'
].join('\n')
