/**
 * Headless driver for the workbench - create and run jobs without the GUI.
 * Shares the SQLite DB and job workspaces with the Electron app.
 *
 * Usage:
 *   npx tsx src/main/cli.ts queue <youtube-url> "<title>"
 *   npx tsx src/main/cli.ts run <jobId>          # runs in foreground, tails events
 *   npx tsx src/main/cli.ts dry-run <youtube-url> "<title>"   # cheap plumbing test
 *   npx tsx src/main/cli.ts events <jobId>       # dump persisted events
 *   npx tsx src/main/cli.ts list
 */
import { ensureDirs } from './paths'
import { getDb, getJob, listJobs } from './db'
import {
  createJob, startJob, executeJobWithPrompt, jobEventsFromDb, recoverInterrupted, jobIsLive
} from './jobs'

const TERMINAL = new Set(['awaiting_review', 'submitted', 'failed', 'interrupted', 'discarded'])

function tailEvents(jobId: string, fromSeq: number): number {
  const events = jobEventsFromDb(jobId) as Array<{ seq?: number; event: { type: string; subtype?: string; message?: { content?: unknown }; result?: string } }>
  let last = fromSeq
  for (const e of events) {
    if ((e.seq ?? 0) <= fromSeq) continue
    last = e.seq ?? last
    const ev = e.event
    if (ev.type === 'assistant') {
      const content = (ev.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; name?: string; text?: string }>) {
          if (b.type === 'text' && b.text) console.log(`  ◆ ${b.text.slice(0, 160).replace(/\n/g, ' ')}`)
          if (b.type === 'tool_use') console.log(`  ▸ tool ${b.name}`)
        }
      }
    } else if (ev.type === 'result') {
      console.log(`  ■ result (error=${Boolean((ev as { is_error?: boolean }).is_error)})`)
    } else if (ev.type === 'stderr') {
      console.log(`  ✗ stderr`)
    }
  }
  return last
}

async function waitForJob(jobId: string): Promise<void> {
  let last = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000))
    last = tailEvents(jobId, last)
    const job = getJob(jobId)
    if (!job) throw new Error(`job ${jobId} disappeared`)
    if (TERMINAL.has(job.status)) {
      console.log(`\nfinal status: ${job.status}${job.error ? ` (${job.error})` : ''}`)
      if (job.stage) console.log(`last stage: ${job.stage}`)
      return
    }
  }
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv
  ensureDirs()
  getDb()
  recoverInterrupted()

  switch (cmd) {
    case 'queue': {
      const [url, ...titleParts] = rest
      if (!url) throw new Error('usage: queue <youtube-url> "<title>"')
      const title = titleParts.join(' ') || url
      const id = createJob({ title, youtube_url: url, autostart: false })
      console.log(id)
      return
    }
    case 'run': {
      const [jobId] = rest
      if (!jobId) throw new Error('usage: run <jobId>')
      startJob(jobId)
      const job = getJob(jobId)
      if (!job || job.status !== 'running') {
        // startJob refuses silently when another live run exists
        const live = listJobs().filter((j) => jobIsLive(j))
        throw new Error(`job did not start${live.length ? ` - another job is running (${live[0].id})` : ''}`)
      }
      console.log(`running ${jobId}...`)
      await waitForJob(jobId)
      return
    }
    case 'dry-run': {
      const [url, ...titleParts] = rest
      if (!url) throw new Error('usage: dry-run <youtube-url> "<title>"')
      const title = (titleParts.join(' ') || 'dry run') + ' (DRY RUN)'
      const id = createJob({ title, youtube_url: url, autostart: false })
      console.log(`dry-run job: ${id}`)
      const prompt = [
        `You are testing a workbench pipeline. Video: ${url}`,
        '',
        'Do ONLY these steps, quickly (no image generation, no card0 calls):',
        '1. Fetch the video transcript (yt-dlp auto-subs or similar).',
        '2. Write a minimal manifest.json for a small 2-deck game following the',
        '   card0-game-create skill Stage 2 (schema v1, language "en").',
        '3. Verify the manifest JSON parses with python3. Do NOT run card0 game validate.',
        '4. Write result.json in this directory exactly:',
        '   {"gameId":"dryrun-test","gameName":"Dry Run Game","cardCount":4,',
        '    "uploadedCount":0,"coverPath":"","imperfections":[],"notes":"dry run"}',
        '',
        'CONSTRAINT: NEVER use the Read tool on image or PDF files - this backend rejects',
        'image input and the session will die with a 400 error.',
        '',
        'Keep the whole task under 3 minutes.'
      ].join('\n')
      executeJobWithPrompt(id, prompt)
      console.log('running...')
      await waitForJob(id)
      return
    }
    case 'events': {
      const [jobId] = rest
      if (!jobId) throw new Error('usage: events <jobId>')
      tailEvents(jobId, 0)
      return
    }
    case 'list': {
      for (const j of listJobs()) {
        console.log(`${j.id}  ${j.status.padEnd(16)} ${j.language.padEnd(7)} ${j.title}`)
      }
      return
    }
    default:
      console.log('commands: queue | run | dry-run | events | list')
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
