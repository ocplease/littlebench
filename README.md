# card0 workbench

A Mac desktop app (Electron + React) that turns a YouTube channel into a stream of published card0 games. It runs real Claude Code sessions headlessly using the `card0-game-create` skill, shows the agent working live, and tracks every game from video to submission.

See `PLAN.md` for the full product/implementation plan.

## Run it

```bash
npm install
npm run dev        # opens the app with hot reload
npm run build      # production build to out/
npm run typecheck
```

## How to use

1. **Channels** - paste a YouTube channel URL (e.g. `https://www.youtube.com/@somechannel/videos`), hit **Ingest**, then **Triage new**. A cheap model filters game-tutorial videos from everything else.
2. Select candidates (or **Queue all candidates**) - each becomes a **job**.
3. **Jobs** - the queue auto-advances (one agent at a time). Click a running job to watch:
   - the 10-stage pipeline stepper (transcript → manifest → … → submit)
   - the live agent transcript
   - the card-art gallery, images appearing as they're generated
4. When the agent finishes, the job pauses as **Awaiting review** - inspect the gallery, then **Approve & submit** (publishes to card0) or Discard.
5. **History** - submitted games, with **Localize 中文 / 日本語** buttons that spawn localization jobs.

## What lives where

- `~/card0-workbench/` - workbench root
  - `workbench.db` - SQLite (videos, jobs, events, games, settings)
  - `jobs/<jobId>/` - per-job agent workspace (manifest, cards_raw/, compressed/, result.json)

## Requirements

- `claude` CLI logged in (`claude login`) - the agent runs on your Claude subscription
- `yt-dlp` on PATH (channel ingest)
- `card0` CLI logged in (`card0 login`) - game creation/upload/submit
- The `card0-game-create` skill in `~/.claude/skills/` (agent uses it via Stage instructions)
- The Seedream skill + Ark API key in your shell env (card art generation)

## Notes

- Jobs run with permissions bypassed by default (unattended automation needs full tool access). Toggle in Settings.
- One job at a time in v1 - card0 uploads aren't parallel-safe.
- A job that's `running` when the app quits becomes `interrupted`; Restart re-runs it in the same workspace (artifacts on disk are reused).
