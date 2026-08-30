# littlebench

A Mac desktop app (Electron + React) that runs an autonomous card-game factory: point it at a YouTube channel, a scout agent scores which videos can become games, and up to three concurrent Claude Code builder sessions turn them into card0 games using the `card0-game-create` skill - with a Linear-style board to watch it all happen and human gates before anything is published.

The workbench owns orchestration and state; Claude owns execution. See `PLAN.md` for the architecture.

## Run it

```bash
npm install
npm run dev        # opens the app with hot reload
npm run build      # production build to out/
npm run typecheck
```

## How to use

0. **Chat** - talk to the foreman. This is the main entrance: paste a YouTube channel URL ("here's a card game channel: ..."), ask what the factory is doing, tell it to queue the best candidates. The foreman runs a Claude session restricted to the `lb` CLI (see below) - it can ingest, scout, queue jobs and report status, but never publishes on its own. It keeps one conversation, so follow-ups ("queue the top 3", "what about that failed job?") work naturally.
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

## What lives where

- `~/Projects/card0/card0-workbench/` - workbench root (override with `CARD0_WORKBENCH_ROOT`)
  - `workbench.db` - SQLite (videos, jobs, events, artifacts, messages, games, settings)
  - `jobs/<jobId>/` - per-job agent workspace (manifest, cards_raw/, compressed/, result.json, `.workbench/tasks.json` progress protocol)

## Requirements

- `claude` CLI logged in (`claude login`) - the agent runs on your Claude subscription
- `yt-dlp` on PATH (channel ingest + transcripts)
- `card0` CLI logged in (`card0 login`) - game creation/upload/submit
- The skills from `skills/` installed into `~/.claude/skills/` (agents load user-level skills):

  ```bash
  cp -R skills/card0-game-create skills/byted-ark-seedream-skill ~/.claude/skills/
  ```

- The Seedream skill + Ark API key in your shell env (card art generation)

## Notes

- Jobs run with permissions bypassed by default (unattended automation needs full tool access). Toggle in Settings.
- The foreman is deliberately narrower: its Bash is limited to `lb *` and it runs without bypass. `bin/lb` wraps the workbench CLI (`ingest`, `scout`, `videos`, `queue`, `status`, `events`), so the chat can drive the factory without touching anything else on your machine.
- Progress tracking uses a structured protocol: builders maintain `.workbench/tasks.json` in their workspace and the workbench mirrors it into the DB (phase, stages, artifacts, open questions). Stdout stage detection remains as a fallback.
- Steering uses session resume (`claude --resume`): it applies between passes, not mid-run. Mid-run injection is future work.
- A job that's `running` when the app quits becomes `interrupted`; Restart re-runs it in the same workspace (artifacts on disk are reused).
