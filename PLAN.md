# card0 Workbench — Product & Implementation Plan

A Mac desktop app that turns a YouTube channel into a stream of published card0 games. It runs real Claude Code sessions headlessly (using the `card0-game-create` skill we built), shows the agent working live, and tracks every game from video to submission.

**Decisions made:**
- **Stack:** Electron + React + TypeScript
- **Publish gate:** agent stops before submit; human reviews the art, then Approve publishes
- **Languages:** English first; zh-Hans / ja are on-demand "Localize" jobs
- **Agent runtime:** spawn the `claude` CLI directly (headless stream-json) — uses your existing Claude subscription, no API key. (The Agent SDK requires `ANTHROPIC_API_KEY` and prohibits subscription auth in third-party apps; driving the CLI you're logged into is the supported path for personal tooling.)
- **Home:** `~/Projects/card0/agent-works/` (directory already created, empty)

---

## 1. Product overview

### What it does
1. You paste a YouTube **channel URL**. The workbench lists all videos and runs a cheap triage pass ("is this a tabletop/card game tutorial?") over each.
2. Candidates get **queued**. The queue auto-advances: one job runs at a time, "keep creating" until the queue is empty.
3. Each **job** spawns a Claude Code session in a dedicated workspace, driven by the `card0-game-create` skill (Stages 1–8). You watch it work: live transcript, stage stepper, and the card art appearing in a gallery as Seedream generates it.
4. When images are uploaded, the job pauses as **Awaiting Review**. You inspect the gallery and click **Approve** → the app runs `card0 game submit`. Or **Regenerate** / **Discard**.
5. **History** shows every game with its card0 link, plus **Localize [zh-Hans] [ja]** buttons that spawn localization jobs against the finished English game.

### Out of scope for v1
- Parallel agents (v1 is strictly 1 at a time — card0 uploads aren't parallel-safe)
- Interactive steering mid-job (pause/message the agent) — the streaming input format supports it later
- Windows/Linux

---

## 2. Architecture

```
Electron app
├── Renderer (React + TS, electron-vite)
│   ├── Channels view      ingest + triage results
│   ├── Queue view         job list w/ status chips
│   ├── Job detail view    live transcript, stage stepper, art gallery, review actions
│   ├── History view       submitted games, localize buttons, card0 links
│   └── Settings           workspace path, auto-queue, model
│
└── Main process (Node)
    ├── AgentRunner        spawns `claude -p --output-format stream-json`, parses NDJSON events
    ├── Ingestor           `yt-dlp --flat-playlist -J <channel>` → video list
    ├── Triage             tiny `claude -p --model haiku` call per video → {game, reason}
    ├── Pipeline tracker   maps tool_use events → the skill's 10 stages
    ├── Watcher            chokidar on job workspace → feeds gallery new images
    ├── DB                 SQLite (better-sqlite3)
    └── Submit             runs `card0 game submit --yes` after approval (no agent needed)
```

### Job workspaces
Every job gets `~/card0-workbench/jobs/<jobId>/` as the agent's cwd:
```
manifest.json        cards_plan.json    cards_raw/    compressed/
cover.jpg            card_ids.json      result.json   events.jsonl (mirror)
```
All artifacts land in a known place — that's what the gallery watcher and review view read.

### External binaries (use absolute paths; GUI apps don't inherit shell PATH)
- `claude` → `/Users/shuulin/.local/bin/claude` (v2.1.239 ✓)
- `yt-dlp` → `/Users/shuulin/miniforge3/bin/yt-dlp` (✓) — also fetches transcripts
- `card0` → `/usr/local/bin/card0` (v0.2.2 ✓)
- Seedream skill lives in `~/.claude/skills/` — available to headless sessions automatically. **The Ark API key must be present in the spawned env** (read from `~/.zshrc`/`.zshenv` at app start, or store in settings).

---

## 3. The agent contract

### Spawning a job

```bash
claude -p "<driving prompt>" \
  --output-format stream-json --verbose \
  --session-id <uuid>            # enables later --resume
  --cwd ~/card0-workbench/jobs/<jobId>
  --permission-mode acceptEdits  # + explicit allowlist, see below
  --model <from settings>
```

### Driving prompt (the workbench composes this)

```
You are running inside an automated workbench. Create a card0 game from this video:
{url}  (title: "{title}", duration: {duration})

- Follow the card0-game-create skill exactly, Stages 1 through 8 and Stage 10's reporting.
- Build the ENGLISH version only. Do not localize.
- Work inside the current directory (this is your job workspace).
- CRITICAL: Do NOT run `card0 game submit`. A human reviews the cards first.
- When finished, write result.json in this directory:
  { gameId, deckIds: {animals, oasis}, cardCount, uploadedCount,
    coverPath, imperfections: [...], notes }
```

`result.json` is the machine-readable contract: the review view, history, and localization jobs all read it.

### Permissions
v1 starts with `--permission-mode acceptEdits` plus `--allowedTools` for the known surface: `Bash(yt-dlp:*)`, `Bash(card0:*)`, `Bash(python3:*)`, `Read, Write, Edit, Glob, Grep, WebFetch, Skill`. If the allowlist proves too narrow mid-pipeline, the pragmatic fallback is `--permission-mode bypassPermissions` scoped to the job cwd — a local personal tool running a known pipeline, but we'll note the tradeoff in Settings and keep it off by default.

### Event stream → UI
`--output-format stream-json` emits NDJSON: `system` (init), `assistant` (text + tool_use blocks), `user` (tool_results), `result` (final). The AgentRunner:
1. Parses each line, appends to the `events` table (transcript survives restarts)
2. Forwards to the renderer over IPC (`webContents.send('job-event', …)`) for the live feed
3. Feeds the pipeline tracker for stage detection

---

## 4. Pipeline stage detection

Map tool_use events onto the skill's stages (no special instrumentation of the agent needed):

| Stage | Trigger | Progress signal |
|---|---|---|
| 1 Transcript | Bash `yt-dlp`/WebFetch on the video URL | done when tool_result returns |
| 2 Manifest | Write/Edit `manifest*.json` | file written |
| 3 Validate | Bash `card0 game validate` | exit code 0 |
| 5 Plan | Write `cards_plan.json` | parse unique design count |
| 6 Art | Seedream skill calls / new files in `cards_raw/` | files found / planned count |
| 7 Compress | new files in `compressed/` | same |
| 8 Create+Upload | Bash `card0 game create` → parse `gameId`; each `card image upload` | uploads n / total |
| — Review | `result` event + `result.json` exists | job → awaiting_review |
| 10 Submit | (after Approve) main process runs `card0 game submit --yes` directly | job → submitted |

The stage stepper in the UI is this table rendered. Failed stage → red chip + error text from the transcript tail.

---

## 5. Data model (SQLite: `~/card0-workbench/workbench.db`)

```sql
videos(id, youtube_id, channel, title, duration_s, url,
       status TEXT,            -- new | candidate | rejected | queued
       triage_reason TEXT, added_at)

jobs(id, video_id, status TEXT, -- queued | running | awaiting_review |
                                  -- submitted | failed | interrupted
     session_id, error, language DEFAULT 'en',
     parent_job_id,             -- set for localization jobs
     created_at, started_at, finished_at)

events(id, job_id, seq, ts, type, payload_json)   -- replayable transcript

games(id, job_id, language, card0_game_id, url,
      cover_path, card_count, status, submitted_at)
```

Localization jobs reuse `jobs` with `language='zh-Hans'|'ja'` + `parent_job_id` pointing at the English job; their driving prompt references the parent's `result.json` and the skill's Stage 9 "localize after the fact" flow.

---

## 6. UI spec

**Channels** — URL input → "Ingest" → video table (title, duration, triage badge ✓/✗ + reason). Select rows → "Queue selected" / "Queue all candidates". Re-ingest skips known youtube_ids.

**Queue** — sidebar of jobs with status chips; auto-advances when head is free. Running job shows live; a "Stop" button kills the subprocess and marks `interrupted`.

**Job detail** — the centerpiece:
- Stage stepper (Stages 1–10) with progress bars on art/upload
- Live transcript: assistant text rendered as markdown, tool calls as collapsible cards (name + args summary + result), auto-scroll with pause-on-hover
- Artifact gallery: thumbnails of everything the watcher finds (`cards_raw/`, `compressed/`, cover) — the "see the running agent" money shot, card art popping in as it's generated
- Awaiting Review state: gallery switches to large-grid review mode + **Approve → submit** / **Regenerate (re-run with notes)** / **Discard**

**History** — completed games grouped by source video: en game card (cover, name, card0 link, submitted date) with **Localize zh-Hans / ja** buttons; localization jobs appear underneath when run.

**Settings** — model, auto-queue on/off, workspace root, triage model, env key overrides (Ark key source).

---

## 7. Robustness

- **Crash-safe transcript:** events are persisted as they stream; reopening a job replays them.
- **Interrupted jobs:** on app launch, `running` → `interrupted`. v1 offers Restart (fresh session, same workspace — files on disk make this cheap). v1.1: Resume via `claude -p --resume <session-id> "continue"`.
- **Auto-advance:** when head job reaches `awaiting_review | submitted | failed | interrupted`, next `queued` job starts (if auto-queue on).
- **Cost sanity:** one English game ≈ one long session (~30–60 min) + 3–4 Seedream batches (Ark-billed). Triage is seconds/video on haiku.

---

## 8. Build milestones

| # | Milestone | Deliverable |
|---|---|---|
| M1 | Skeleton | electron-vite + React + TS app; SQLite; nav shell; settings |
| M2 | AgentRunner | spawn claude stream-json; events → DB + live transcript view; stop button |
| M3 | Ingest + triage | yt-dlp channel listing; haiku triage; channels view; queueing |
| M4 | Pipeline + review | stage detection; gallery watcher; review gate; approve→submit |
| M5 | History + localization | history view; localize jobs (Stage 9 after-the-fact flow) |
| M6 | Hardening | interrupted-job restart, auto-advance, error surfaces, env/PATH handling |

**Suggested order:** M1 → M2 first (the risky/hard part is the agent plumbing; validate one real end-to-end game through the raw stream before building UI around it), then M3–M6.

---

## 9. Key risks

- **Headless env:** GUI-launched processes lack shell PATH/env (claude, yt-dlp, Ark key). Mitigated with absolute paths + env sourcing at app start — but test a real Seedream call through the spawned session early (M2, not M6).
- **Claude subscription rate limits** on long sessions — one job at a time keeps this sane; surface `result` usage/cost fields per job when available.
- **Skill drift:** the workbench prompt references the skill; if the skill changes stage numbering, stage detection heuristics need updating. Keep the mapping table (§4) in one config file.
- **Garbled CJK art on localization jobs** — that's what the review gate is for; Regenerate with notes flows the imperfection list back into the prompt.
