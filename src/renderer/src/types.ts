export type { Video, Job, Game, Artifact, Settings } from '../../preload/api-types'
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

export const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  awaiting_review: 'Awaiting review',
  submitted: 'Submitted',
  failed: 'Failed',
  interrupted: 'Interrupted',
  discarded: 'Discarded'
}
