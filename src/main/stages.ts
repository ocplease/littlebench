import type { ClaudeStreamEvent } from './agent-runner'

/** The pipeline stages surfaced in the UI - mirrors the card0-game-create skill.
 *  Detection is heuristic, driven by tool_use events in the stream. */
export const STAGES = [
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
] as const

export type StageId = (typeof STAGES)[number]['id']

export interface StageUpdate {
  stage: StageId
  detail?: string
}

interface ToolUseBlock {
  type: 'tool_use'
  name: string
  input: unknown
}

function firstToolUse(event: ClaudeStreamEvent): ToolUseBlock | null {
  const content = (event.message as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'tool_use' &&
      typeof (block as { name?: unknown }).name === 'string'
    ) {
      return block as ToolUseBlock
    }
  }
  return null
}

function inputString(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

/** Map a stream event to a pipeline stage transition, if any. */
export function detectStage(event: ClaudeStreamEvent): StageUpdate | null {
  if (event.type !== 'assistant') return null
  const tool = firstToolUse(event)
  if (!tool) return null
  const input = inputString(tool.input)

  if (tool.name === 'Bash') {
    if (/yt-dlp|youtube\.com|youtu\.be/.test(input)) return { stage: 'transcript', detail: 'Fetching video transcript' }
    if (input.includes('card0 game validate')) return { stage: 'validate', detail: 'Validating manifest' }
    if (input.includes('card0 game create')) return { stage: 'create', detail: 'Creating game on card0' }
    if (input.includes('card0 game submit')) return { stage: 'submit', detail: 'Submitting' }
    if (input.includes('image upload')) return { stage: 'upload', detail: 'Uploading images' }
    // OCR preprocessing also uses PIL, so require a compression-specific token
    if (/python3?.*(compress|thumbnail|save\(.*JPEG|convert.*quality)/i.test(input))
      return { stage: 'compress', detail: 'Compressing to JPEG' }
    return null
  }
  if (tool.name === 'WebFetch' && /youtube|youtu\.be/.test(input)) {
    return { stage: 'transcript', detail: 'Reading video page' }
  }
  if ((tool.name === 'Write' || tool.name === 'Edit') && input.includes('manifest')) {
    return { stage: 'manifest', detail: 'Writing manifest' }
  }
  if ((tool.name === 'Write' || tool.name === 'Edit') && input.includes('cards_plan')) {
    return { stage: 'plan', detail: 'Planning unique designs' }
  }
  if (tool.name === 'Skill') return { stage: 'art', detail: 'Generating art' }
  return null
}
