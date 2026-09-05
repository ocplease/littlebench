# littlebench

A Mac desktop app (Electron + React) that runs an autonomous card-game factory: point it at a YouTube channel or send it a natural-language game brief, and up to three concurrent Claude Code builder sessions turn the source into card0 games using the `card0-game` skill family - with a Linear-style board to watch it all happen and human gates before anything is published.

The workbench owns orchestration and state; Claude owns execution. See `PLAN.md` for the architecture.

## Run it

```bash
npm install
npm run dev        # opens the app with hot reload
npm run build      # production build to out/
npm run typecheck
```

## How to use

0. **Chat** - talk to the foreman. This is the main entrance: describe a game idea, paste a YouTube URL, ask what the factory is doing, or tell it to queue the best candidates. Factory operations go through the `lb` CLI (see below), and the foreman never publishes on its own. It keeps one conversation, so follow-ups ("queue the top 3", "what about that failed job?") work naturally.
1. **Sources** - paste a YouTube channel URL and hit **Add channel** (ingest auto-scouts new videos). **Deep scout** fetches transcripts for shortlisted videos and refines the score.
2. Select candidates (or hit **Build game** on a card) - each becomes a job on the **Factory** board.
3. **Factory** - the board: Candidates / Queued / Building / Review / Published. Up to 3 builder workers run concurrently (worker dots in the header). Click any card to open its workspace.
4. **Game Workspace** - three columns:
   - **Tasks**: the six phases (Understand / Design / Art Direction / Production / Integration / QA & Publish), expandable into the skill's ten stages
   - **Activity**: the live agent transcript
   - **Artifacts**: manifests, covers and card art as they're produced - click a card to regenerate it or give feedback
5. **Steering** - type instructions into the box at the bottom ("make this card less dark", "the oasis distribution is wrong, use X"). The workbench resumes the job's Claude session with your message. When a builder is unsure, it asks - the job lands in **Needs your input** and your answer continues it.
6. Jobs pause as **Awaiting review** before publishing. Inspect the gallery, then **Approve & publish** (submits to card0) or Discard.
7. **Library** - published games with **Open in Card0** and on-demand **Localize 中文 / 日本語** jobs.
8. **Three languages per game** - when an English build lands in review, the workbench automatically queues zh-Hans and ja localization jobs (full re-builds with localized art, per the skill's Stage 9). Discarding the English game cancels its queued localizations. Toggle in Settings.
9. **Card backs** - every card gets a back (`card0 --face back`). Backs are textless and language-neutral, so they are REUSED from a shared library (`<workbench-root>/assets/card-backs/`) before any new one is generated - a new back is only made when nothing fits the theme, and it is saved back into the library for future games.
10. **API key rotation** - Settings holds two key pools: Claude API keys and image-generation keys (one per line). Builders and the foreman take the next key from each pool in turn, so one key's 5-hour quota window doesn't stall the factory. When a key returns 429, it is skipped until its quota window resets (parsed from the error when possible); the queue pauses only when every key is spent. Keys live only in the local workbench DB - never in this repo.

## Create jobs from Codex or another agent

`bin/lb create-job` is the stable external-agent entry point. It accepts a complete game requirement, creates the workspace and `design_brief.md`, and returns a machine-readable job record. The desktop app notices the queued job and starts it when a worker is available; the app does not need to be open at creation time.

For structured agent calls, send one JSON object on stdin:

```bash
./bin/lb create-job --json <<'JSON'
{
  "title": "Pocket Alchemists",
  "brief": "Create a 3-6 player card game about combining two hidden elements...",
  "requestId": "my-agent:conversation-42:turn-7"
}
JSON
```

The result is a single JSON line:

```json
{"ok":true,"created":true,"job":{"id":"job_...","title":"Pocket Alchemists","status":"queued","origin":"external_agent","requestId":"my-agent:conversation-42:turn-7"}}
```

`requestId` is optional but recommended. Repeating the same request returns the existing job with `"created": false`, so an agent can safely retry after an uncertain tool result. A simpler text form is also available:

```bash
printf '%s\n' 'Create a cooperative deduction game for 4-8 players.' \
  | ./bin/lb create-job "Signal Lost"
```

Creation only queues the build. Review and publishing remain human actions in the workbench.

## What lives where

- `~/Projects/card0/card0-workbench/` - workbench root (override with `CARD0_WORKBENCH_ROOT`)
  - `workbench.db` - SQLite (videos, jobs, events, artifacts, messages, games, settings, API key pools)
  - `jobs/<jobId>/` - per-job agent workspace (manifest, cards_raw/, compressed/, result.json, `.workbench/tasks.json` progress protocol)
  - `assets/card-backs/` - shared textless card-back library (reused across games and languages)

## Requirements

- `claude` CLI logged in (`claude login`) - the agent runs on your Claude subscription
- `yt-dlp` on PATH (channel ingest + transcripts)
- `card0` CLI logged in (`card0 login`) - game creation/upload/submit
- The skills live in the card0 repo (`~/Projects/card0/card0/skills/`: `card0-game` umbrella + `card0-game-create`, `card0-cli`, `byted-ark-seedream-skill`; override with `CARD0_SKILLS_DIR`). The workbench symlinks every skill it finds there into each job workspace (`.claude/skills/`) and the workbench root automatically - no install step. For interactive sessions, symlink them once:

  ```bash
  ln -s ~/Projects/card0/card0/skills/{card0-game,card0-game-create,byted-ark-seedream-skill} ~/.claude/skills/
  ```

- The Seedream skill + Ark API key in your shell env (card art generation)

## Notes

- Jobs run with permissions bypassed by default (unattended automation needs full tool access). Toggle in Settings.
- The foreman is deliberately narrower: its Bash is limited to `lb *` and it runs without bypass. `bin/lb` wraps the workbench CLI (`ingest`, `scout`, `videos`, `queue`, `status`, `events`), so the chat can drive the factory without touching anything else on your machine.
- Progress tracking uses a structured protocol: builders maintain `.workbench/tasks.json` in their workspace and the workbench mirrors it into the DB (phase, stages, artifacts, open questions). Stdout stage detection remains as a fallback.
- Steering uses session resume (`claude --resume`): it applies between passes, not mid-run. Mid-run injection is future work.
- A job that's `running` when the app quits becomes `interrupted`; Restart re-runs it in the same workspace (artifacts on disk are reused).
