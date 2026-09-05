# card0 Workbench agent entry point

When the user asks you to create or queue a card game in the workbench from a natural-language requirement, use the repository's agent-facing CLI instead of building the game in this source tree.

1. Preserve the user's full requirement as the design brief. Do not silently invent scoring, player counts, or other material rules; include clearly labeled assumptions only when needed.
2. Choose a short human-readable title.
3. Run `./bin/lb create-job --json` with a JSON object on stdin containing `title`, `brief`, and, when available, a stable `requestId` for the user request.
4. Parse the JSON response and report the job ID, title, and status. If `created` is false, say that the existing idempotent job was reused.
5. Do not run `lb run`, approve, publish, or directly edit the workbench database unless the user explicitly asks for that additional action.

The job may be created while the Electron app is closed. It remains queued and the app's queue pump starts it after the app opens and a worker is available.

Example request shape:

```json
{
  "title": "Signal Lost",
  "brief": "Create a cooperative deduction card game for 4-8 players...",
  "requestId": "codex:<stable-conversation-or-request-id>"
}
```
