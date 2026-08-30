export type { Video, Job, Game, Artifact, ProtocolArtifactRow, Message, Settings, ForemanMessage } from '../../preload/api-types'
export type { StreamEvent } from './stream-event'

export const STAGE_LIST = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'manifest', label: 'Manifest' },
  { id: 'validate', label: 'Validate' },
  { id: 'plan', label: 'Design plan' },
  { id: 'art', label: 'Card art' },
  { id: 'compress', label: 'Compress' },
  { id: 'create', label: 'Create game' },
  { id: 'upload', label: 'Upload' },
  { id: 'review', label: 'Review' },
  { id: 'submit', label: 'Submit' }
]

/** Six UX phases; each expands into its skill stages in the Workspace. */
export const PHASE_LIST = [
  { id: 'understand', label: 'Understand', detail: 'video -> game spec', stages: ['transcript'] },
  { id: 'design', label: 'Design', detail: 'manifest + validation', stages: ['manifest', 'validate'] },
  { id: 'art_direction', label: 'Art Direction', detail: 'cover + card plan', stages: ['plan'] },
  { id: 'production', label: 'Production', detail: 'artwork + compression', stages: ['art', 'compress'] },
  { id: 'integration', label: 'Integration', detail: 'card0 create + upload', stages: ['create', 'upload'] },
  { id: 'qa_publish', label: 'QA & Publish', detail: 'review + submit', stages: ['review', 'submit'] }
]

export function phaseLabel(phase: string | null | undefined): string {
  return PHASE_LIST.find((p) => p.id === phase)?.label ?? 'Starting'
}

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Building',
  awaiting_review: 'Awaiting review',
  needs_input: 'Needs your input',
  submitted: 'Published',
  failed: 'Failed',
  interrupted: 'Interrupted',
  discarded: 'Discarded'
}

export const CLASSIFICATION_LABEL: Record<string, string> = {
  GAME_TUTORIAL: 'Tutorial',
  PLAYTHROUGH: 'Playthrough',
  GAME_REVIEW: 'Review',
  NEWS: 'News',
  ACCESSORY: 'Accessory',
  SHORT: 'Short',
  OTHER: 'Other'
}

export const RIGHTS_LABEL: Record<string, string> = {
  original: 'Original',
  licensed: 'Licensed',
  commercial_clone: 'Commercial ⚠',
  unknown: 'Rights unknown'
}

/** Which stage statuses does the latest protocol event report? */
export interface ProtocolSnapshot {
  phase: string
  note: string | null
  stages: Array<{ id: string; status: string; detail?: string }>
  needs_input: { question: string; options?: string[] } | null
}
