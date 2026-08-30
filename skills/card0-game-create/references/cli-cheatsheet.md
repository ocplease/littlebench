# card0 CLI Cheatsheet

The commands actually used by this skill, with the gotchas called out. Verified against card0 CLI v0.2.2.

## Auth

```bash
card0 login                  # opens browser for OAuth, stores token
card0 whoami                 # confirms logged in
```

## Game lifecycle

```bash
# Create
card0 game create "Game Name" --file manifest.json \
  --description "..." --language en \
  --rules "..." \
  --min-players 2 --max-players 2 \
  --theme "..." --setting "..." --mechanic "..." --vibe "..."
# returns: "Game created with id: <gameId>"

# Validate BEFORE create (dry run)
card0 game validate --file manifest.json

# Switch active game (positional, NOT --id)
card0 game use <gameId>

# Submit / publish
card0 game submit --yes

# Open in browser
card0 game open <gameId>
```

> Gotcha: `card0 game use --id <id>` fails with "unknown option '--id'". The correct form is the positional `card0 game use <id>`.

## Game cover image

```bash
card0 game image upload <gameId> cover.jpg
```

## Deck operations

```bash
# List decks (use --game to avoid browser.js SyntaxError)
card0 deck list --game <gameId>

# Switch active deck
card0 deck use <deckId>
```

> Gotcha: `card0 deck list` with no args can throw `SyntaxError: Unexpected reserved word` in browser.js. Pass `--game <gameId>` explicitly.

## Card operations

```bash
# List cards in active deck
card0 card list

# Upload face image
card0 card image upload --face front --mode full_face <cardId> card.jpg
# --face: front|back
# --mode: full_face (your design fills the whole card)
#         artwork    (isolated illustration; card0 composes a frame)
```

## Full upload script template

```bash
#!/bin/bash
set -e
cd /path/to/workdir

# Re-pin the active game and deck in every shell
card0 game use <gameId> > /dev/null
card0 deck use <deckId>  > /dev/null

# R1: +1, +2, -1, -2, +3P   (replace with real cardId / filename)
for tuple in \
  "11111111-1111-1111-1111-111111111111 oasis_1.jpg" \
  "22222222-2222-2222-2222-222222222222 oasis_2.jpg" \
; do
  cid=$(echo $tuple | cut -d' ' -f1)
  file=$(echo $tuple | cut -d' ' -f2)
  card0 card image upload --face front --mode full_face "$cid" "compressed/$file"
  sleep 1   # be polite to the API
done

echo "done"
```

## Output / inspection

```bash
card0 game show <gameId>     # full metadata, deck/card IDs
card0 deck show <deckId>     # cards in a deck
card0 card show <cardId>     # single card details
```

## Error → fix

| Error | Cause | Fix |
|---|---|---|
| `IMAGE_TOO_LARGE` | PNG > 5 MB | JPEG-compress to < 5 MB, <= 1500 px long side |
| `language must be one of en|ja|zh-Hans|other` | used `zh` or `chinese` | set `language: "zh-Hans"` |
| `DECK_REQUIRED` | ran card command without `card0 deck use` | run `card0 deck use <deckId>` first |
| `unknown option --id` | used `--id` with `card0 game use` | use positional: `card0 game use <id>` |
| `SyntaxError: Unexpected reserved word` (browser.js) | bare `card0 deck list` | pass `--game <gameId>` |
