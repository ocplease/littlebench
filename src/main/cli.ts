/**
 * Headless driver for the workbench - operate the factory without the GUI.
 * Shares the SQLite DB and job workspaces with the Electron app.
 * This is also the agent-facing control surface: the foreman (chat agent)
 * runs these commands via Bash.
 *
 * Usage (or use the bin/lb wrapper):
 *   lb ingest <channelUrl> [max]        # list a channel's videos into the factory
 *   lb scout --new | lb scout <id>...   # classify + Card0-fit-score videos
 *   lb videos [status]                  # list videos with fit/classification
 *   lb queue <videoId>...               # queue videos as game-builder jobs
 *   lb queue --candidates [--min-fit N] # queue everything above a fit bar
 *   lb queue-url <videoUrl> ["<title>"] # queue a single video URL (title auto-fetched)
 *   lb queue-design "<title>"           # queue a build from a design brief (brief on stdin)
 *   lb create-job "<title>"             # external-agent API; brief on stdin, JSON result
 *   lb create-job --json                 # JSON stdin: {title, brief, requestId?}
 *   lb status                           # jobs + games overview
 *   lb run <jobId>                      # run a job in the foreground
 *   lb events <jobId>                   # dump persisted events
 *   lb list
 */
import { ensureDirs } from './paths'
import { getDb, getJob, listJobs, listVideos, updateVideoStatus, VideoRow } from './db'
import {
  createJob, createDesignJob, startJob, executeJobWithPrompt, jobEventsFromDb,
  recoverInterrupted, jobIsLive
} from './jobs'
import { ingestChannel, scoutVideos, fetchVideoTitle, looksLikeVideoUrl } from './ingest'

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

/** Read piped/heredoc stdin to end ('' when interactive). */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => resolve(data))
  })
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
    case 'ingest': {
      const [url, maxArg] = rest
      if (!url) throw new Error('usage: ingest <channelUrl> [max]')
      const max = Math.max(1, Number(maxArg) || 50)
      const res = await ingestChannel(url, max)
      console.log(`channel listed ${res.total} videos, ${res.added} new`)
      for (const v of listVideos().slice(0, res.added)) {
        console.log(`  ${v.id}  ${v.title}`)
      }
      return
    }
    case 'scout': {
      const ids = rest[0] === '--new'
        ? listVideos().filter((v) => v.status === 'new').map((v) => v.id)
        : rest.map(Number).filter(Number.isFinite)
      if (!ids.length) throw new Error('usage: scout --new | scout <videoId>...')
      await scoutVideos(ids, () => {})
      for (const id of ids) {
        const v = listVideos().find((x) => x.id === id)
        if (v) printVideo(v)
      }
      return
    }
    case 'videos': {
      const [status] = rest
      for (const v of listVideos()) {
        if (status && v.status !== status) continue
        printVideo(v)
      }
      return
    }
    case 'queue': {
      if (rest[0] === '--candidates') {
        const minFit = rest.includes('--min-fit') ? Number(rest[rest.indexOf('--min-fit') + 1]) || 0 : 0
        const picks = listVideos().filter(
          (v) => v.status === 'candidate' && (v.fit_score ?? 0) >= minFit
        )
        for (const v of picks) {
          createJob({ video_id: v.id, title: v.title, youtube_url: v.url, autostart: false })
          updateVideoStatus(v.id, 'queued', null)
          console.log(`queued ${v.id}  ${v.title}`)
        }
        if (!picks.length) console.log('no candidates above the bar')
        return
      }
      const ids = rest.map(Number).filter(Number.isFinite)
      if (!ids.length) throw new Error('usage: queue <videoId>... | queue --candidates [--min-fit N]')
      for (const id of ids) {
        const v = listVideos().find((x) => x.id === id)
        if (!v) {
          console.log(`unknown video ${id}`)
          continue
        }
        createJob({ video_id: v.id, title: v.title, youtube_url: v.url, autostart: false })
        updateVideoStatus(v.id, 'queued', null)
        console.log(`queued ${v.id}  ${v.title}`)
      }
      return
    }
    case 'status': {
      const jobs = listJobs()
      const byStatus = new Map<string, number>()
      for (const j of jobs) byStatus.set(j.status, (byStatus.get(j.status) ?? 0) + 1)
      const videoStatus: Record<string, number> = {}
      for (const v of listVideos()) videoStatus[v.status] = (videoStatus[v.status] ?? 0) + 1
      console.log('videos:', JSON.stringify(videoStatus))
      console.log('jobs:', JSON.stringify(Object.fromEntries(byStatus)))
      for (const j of jobs.slice(0, 12)) {
        console.log(`  ${j.id}  ${j.status.padEnd(16)} ${j.title.slice(0, 60)}`)
      }
      return
    }
    case 'queue-url': {
      const [url, ...titleParts] = rest
      if (!url || !looksLikeVideoUrl(url)) throw new Error('usage: queue-url <youtube-url> ["<title>"] - url must be a YouTube video link')
      // No title given: look it up so the board shows the real video name.
      const title = titleParts.join(' ') || (await fetchVideoTitle(url)) || url
      const id = createJob({ title, youtube_url: url, autostart: false })
      console.log(`queued ${id}  ${title}`)
      return
    }
    case 'queue-design': {
      const [title] = rest
      if (!title) throw new Error('usage: queue-design "<title>" (full design brief on stdin)')
      const brief = await readStdin()
      const { id } = createDesignJob({ title, brief, origin: 'foreman', autostart: false })
      console.log(`queued ${id}  ${title} (design-brief build)`)
      return
    }
    case 'create-job': {
      const stdin = await readStdin()
      let title = rest.join(' ').trim()
      let brief = stdin
      let requestId: string | null = null

      if (rest[0] === '--json') {
        if (!stdin.trim()) throw new Error('JSON request is required on stdin')
        let request: unknown
        try {
          request = JSON.parse(stdin)
        } catch {
          throw new Error('stdin must be valid JSON')
        }
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
          throw new Error('JSON request must be an object')
        }
        const value = request as Record<string, unknown>
        title = typeof value.title === 'string' ? value.title : ''
        brief = typeof value.brief === 'string' ? value.brief : ''
        if (value.requestId != null && typeof value.requestId !== 'string') {
          throw new Error('requestId must be a string')
        }
        requestId = typeof value.requestId === 'string' ? value.requestId : null
      }

      if (!title) {
        throw new Error('usage: create-job "<title>" (brief on stdin) | create-job --json')
      }
      const result = createDesignJob({
        title,
        brief,
        origin: 'external_agent',
        external_request_id: requestId,
        autostart: false
      })
      const job = getJob(result.id)
      console.log(JSON.stringify({
        ok: true,
        created: result.created,
        job: job && {
          id: job.id,
          title: job.title,
          status: job.status,
          origin: job.origin,
          requestId: job.external_request_id
        }
      }))
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
        '   card0-game skill, Stage 2 of card0-game-create (schema v1, language "en").',
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
      console.log(
        'commands: ingest | scout | videos | queue | queue-url | queue-design | create-job | status | run | dry-run | events | list'
      )
  }
}

function printVideo(v: VideoRow): void {
  const fit = v.fit_score != null ? String(v.fit_score).padStart(3) : '  -'
  const cls = (v.classification ?? '-').padEnd(14)
  const rights = (v.rights_status ?? '-').padEnd(16)
  console.log(
    `${String(v.id).padStart(4)}  fit ${fit}  ${cls} ${rights} ${v.status.padEnd(10)} ${v.title.slice(0, 64)}`
  )
}

main().catch((e) => {
  const message = e instanceof Error ? e.message : String(e)
  if (process.argv[2] === 'create-job') {
    console.error(JSON.stringify({ ok: false, error: message }))
  } else {
    console.error(message)
  }
  process.exit(1)
})
