/** One forwarded claude stream-json event, as sent over IPC. */
export interface StreamEvent {
  jobId?: string
  seq?: number
  ts?: string
  event: {
    type: string
    subtype?: string
    session_id?: string
    message?: { role: string; content: unknown }
    result?: string
    is_error?: boolean
    total_cost_usd?: number
    duration_ms?: number
    [k: string]: unknown
  }
}
