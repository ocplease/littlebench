---
name: card0-game-create
license: MIT
description: |
  Create a playable card0 game end-to-end from a YouTube tutorial video. Turn a board-game or card-game walkthrough into a published card0 game with cover art, card artwork, and (optionally) localized versions in zh-Hans and ja.

  Trigger when the user pastes a YouTube URL of a tabletop/card game tutorial and says things like "make this a card0 game", "turn this video into a card0 game", "create a card0 game from this", or asks for a "中文版" / "日本語版" of an already-built game.

  Do NOT use for: editing text on existing card0 cards, browsing card0, or playing a game you didn't author. Use the card0 CLI directly for those.

  Expected output: a card0 game that opens in the browser, with cover image, all cards illustrated (artwork that matches the printed text in the target language), and a manifest that passes `card0 game validate`. For multi-language builds, each language gets its own published game with translated rules, card names, descriptions, AND newly-generated artwork that has the localized text rendered on the image.
metadata:
  author: open-clipper
  version: "1.0.0"
  category: game-authoring
---

# card0 Game Create — YouTube to Playable Game

This skill walks an agent through turning a YouTube game tutorial into a complete, playable card0 game, including optional Chinese (zh-Hans) and Japanese (ja) localized versions with art regenerated in the target language.

The workflow has ten stages. Do them in order. Each stage has a clear "done" criterion before you move on.

## Stage 1 — Watch the video and extract the game spec

The user gives you a YouTube URL. Use whichever transcript / video tools you have to recover the design:

- Get the spoken transcript (e.g. via a transcript service or `yt-dlp` with auto-subtitles).
- If the video shows card art on screen, capture timestamps for each card and what it depicts.
- Produce a design document covering:
  - Game name, player count, play time, win condition
  - All card types: name, value/role, quantity in deck, ability text (verbatim if possible)
  - Setup, turn structure, end-of-round and end-of-game flow
  - Theme, setting, mechanic keywords, intended vibe

A good transcript plus your own notes is the deliverable. Do not start writing the manifest until you can answer "what is every card in this game, and what does it do?"

## Stage 2 — Author the manifest JSON

Create a manifest file at `manifest.json` following the card0 schema v1. See `references/manifest-schema.md` for the full schema. Key rules learned the hard way:

- `game.language` must be exactly `en`, `ja`, `zh-Hans`, or `other` (not `zh`, not `zh-CN`).
- Each card must be a separate object with `quantity` >= 1.
- Every deck must have a `name` and a `cards` array.
- For round-based games, the deck's total card count should match the printed rules exactly. The English Desperate Oasis game uses 15 oasis cards because the rulebook has 3 rounds × 5 cards. Mirror that pattern for any round-based game.
- **Multi-language build**: if the user wants en + zh + ja at the same time, author all three manifests NOW (`manifest_en.json`, `manifest_zh.json`, `manifest_ja.json`) while the design is fresh. Translate name, description, rules, and every card's name/description; keep `value`, `quantity`, `type` identical across languages. See Stage 9 for the full parallel build flow.

Write a Python validation step *before* you call the CLI:

```python
import json
m = json.load(open('manifest.json'))
assert m['game']['language'] in {'en', 'ja', 'zh-Hans', 'other'}
for deck in m['decks']:
    assert deck['name'] and isinstance(deck['cards'], list) and deck['cards']
print("manifest locally OK")
```

## Stage 3 — Validate via the card0 CLI

```bash
card0 game validate --file manifest.json
```

If it returns a list of errors, fix them and re-validate. Common failures: wrong language code, missing required fields, empty decks.

## Stage 4 — Generate the cover

Use the Seedream skill (see `references/image-pipeline.md`) with `size: 2K` and an aspect ratio of 3:4. Make the cover a clear, evocative scene — animals, the oasis, the desert — with the **game title in the target language** rendered on the image. Same prompt patterns for all languages; swap the title text.

Cover prompt shape:

```
A vintage 3:4 cover illustration for a card game called "{TITLE}". Show {key art motifs}. Use a {warm/cool/...} color palette. The title "{TITLE}" is rendered in large bold {language} characters near the top or bottom. Cinematic, professional, no watermark.
```

Always request `response_format: png`, `watermark: false`. Save to `cover_{lang}.jpg` after a JPEG pass.

## Stage 5 — Plan unique card designs

Before calling Seedream, enumerate the **unique** cards. With quantity > 1, you reuse the same image for each copy of that card. For a 15-oasis deck with 3 rounds × 5 values, that's 8 unique designs (+1, +2, +3, -1, -2, -3, +2 Portal, +3 Portal), not 15.

Group card faces by:
- Animal/character cards: one unique design per species.
- Score/location cards: one unique design per (value × variant) tuple. In the Desperate Oasis oasis deck, the round is just text on the card — visually identical +1 cards across rounds are the same image.

List the unique designs in `cards_plan.json` with: `id`, `value`, `name_en`, `name_zh`, `name_ja`, `ability_xx`, `color_theme`. This is your source of truth for prompts.

## Stage 6 — Generate card art in batches

Use Seedream with `sequential: true, count: N` for batches of up to 15 cards. One prompt must describe every card in the batch — Seedream's "coherent set" mode only works if you say "X cards in a coherent set" and describe each.

Animal prompt template:

```
Generate a coherent set of {N} retro/vintage style animal card illustrations in a consistent art style (same series). Each card is a square. Same composition: top-left small white circular medallion with the card value (number or letter) in bold serif, center animal illustration, bottom the {language} animal name in large bold characters, and below that the {language} ability text. All {language} text must be perfectly clear and correctly rendered. 1. {Species}: value '{X}', {illustration cue}, bottom '{name}', below '{ability}'. 2. ...
```

Oasis (score) prompt template:

```
Generate a coherent set of {N} retro/vintage style oasis score cards in a consistent art style (16:9 landscape). Same composition: top center '{TITLE_LANG}', center large oval medallion with big Arabic numeral, bottom '{X}{点/分}'. Positive cards green palette, negative darker charcoal, portals orange with glowing '{PORTAL_LANG}' in the corner. 1. ...
```

Seedream constraints:
- `size: 2K` produces ~2048x2048 square (or 2048x1152-ish landscape depending on the model). Minimum 3,686,400 pixels — 1536x2048 fails, 1920x2560 works.
- `sequential` mode caps at 15 images per batch. For >15 unique designs, run multiple batches.
- `optimize: true` (default) augments your prompt; you can keep it on.
- Always pass `watermark: false` and `response_format: png`.

After each batch, verify the images. The AI can garble text (especially rare characters or diacritics), produce the wrong number, or swap designs, so verification matters - but check your runtime first:

- If image reads work in your runtime: read each image and check the rendered text, then regenerate individual bad images in single-image prompts - do not re-run the whole batch.
- If your backend rejects image input (the request fails with `400 Model only support text input`): do NOT read image or PDF files - one such read kills the session. Verify via metadata only: expected file count present, non-trivial sizes (`ls -la`), correct dimensions via `python3 PIL`. Note in the final report that visual QA was skipped, so the human reviewer checks the art in the gallery before submit.

## Stage 7 — Compress to JPEG

card0's image upload has a 5 MB limit. PNGs from Seedream are 3-7 MB. Always compress:

```python
from PIL import Image
import os
os.makedirs('compressed', exist_ok=True)
for f in os.listdir('cards_raw'):
    if f.endswith('.png'):
        img = Image.open(f'cards_raw/{f}').convert('RGB')
        img.thumbnail((1500, 1500), Image.LANCZOS)
        img.save(f'compressed/{f[:-4]}.jpg', 'JPEG', quality=85, optimize=True)
```

For round-based cards with duplicates (e.g. three +1 oasis cards across rounds), `cp` the compressed file to `xxx_1b.jpg`, `xxx_1c.jpg` so each card slot has a unique upload path. card0 hashes by URL, so re-uploading the same file path is fine — but a separate file is clearer in the upload script.

## Stage 8 — Create the game and upload

Create the game:

```bash
card0 game create "Game Name" --file manifest.json \
  --description "..." --language en --rules "..." \
  --min-players 2 --max-players 2 \
  --theme "..." --setting "..." --mechanic "..." --vibe "..."
```

The command prints the new `gameId` and a default `deckId`. Switch to the game and verify:

```bash
card0 game use <gameId>
card0 deck list --game <gameId>     # gives you animalDeckId, oasisDeckId
```

For the cover:

```bash
card0 game image upload <gameId> cover_en.jpg
```

For each card, you need its `cardId` from `card0 card list` (run after `card0 deck use <deckId>`). Then upload:

```bash
card0 card image upload --face front --mode full_face <cardId> compressed/<file>.jpg
```

`--mode full_face` is the right default for full-card designs. Use `--mode artwork` only if you're sending an isolated illustration that card0 should compose with its built-in frame.

Run uploads in batches per deck (typically 5-15 uploads each) and capture timing. card0's image upload takes ~2-5s per card; budget at least 60s per 15-card deck.

## Stage 9 - Build additional languages (or all three at once)

A Chinese (zh-Hans) or Japanese (ja) version is a full re-pipeline, not just a metadata swap. Each language is its **own card0 game** (own `gameId`, own manifest, own artwork with the localized text rendered on the image - English text on a "Chinese" card looks wrong).

### Decide the track up front

- **Single-language build**: the user asked for one language. Build it, ship it, stop.
- **Multi-language build**: the user asked for "all languages", "en + zh + ja", or follows up with "make a Chinese/Japanese version". Do the shared design work ONCE, then fan out per language.

### How to build all three languages at the same time

The key is that the expensive thinking is shared - only the text and artwork differ per language. After Stage 5, your `cards_plan.json` already holds `name_en`/`name_zh`/`name_ja` and `ability_xx` for every unique design. From there each language is an independent pipeline with no cross-dependencies:

1. **Author all three manifests together** (Stage 2): `manifest_en.json`, `manifest_zh.json`, `manifest_ja.json`. Translate name, description, rules, card names, and ability text once, while the design is fresh in your head. Keep `value`, `quantity`, `type` identical across languages. Validate all three with `card0 game validate`.
2. **Create all three games up front** (Stage 8): run `card0 game create` three times, once per manifest. Record the three `gameId`s in `card_ids.json` before generating any art, so a mid-run failure never loses track of which game is which.
3. **Generate art per language in parallel**: each language gets its own Seedream batch(es) using the Stage 6 templates with that language's text. The batches are independent - run them back-to-back or hand them to parallel subagents if available. Art generation is the slow stage (each language needs its own cover + animal set + oasis set).
4. **Compress per language**: `cards_raw_zh/` -> `compressed_zh/`, etc. (Stage 7).
5. **Upload sequentially per language**: card0 image upload is not parallel-safe at high concurrency - one upload at a time with `sleep 1` between calls. Upload language A fully, then language B, then C. Re-pin `card0 game use <gameId>` / `card0 deck use <deckId>` before each language's batch (CLI state is per-shell).
6. **Submit each language** with `card0 game submit --yes` once the user has reviewed (or immediately if they asked for it).

### If localizing after the fact

If the English game already exists and the user asks for another language later, you re-enter this stage: translate the manifest, create a new game, re-generate art, re-upload. See `references/localization.md` for terminology and CJK prompting guidance.

### Time budget

Roughly linear in languages: one language is about 3-4 Seedream batches plus 1 upload pass. Three languages is about 9-12 batches plus 3 upload passes. If the user is impatient, ship en first and localize in the background while they review.

## Stage 10 — Submit and open in the browser

```bash
card0 game submit --yes
card0 game open <gameId>    # opens the web URL
```

Done. Report the game IDs, the cover URL, and a summary of what was generated and uploaded. Mention any images that came out imperfect (typos in the rendered text, illustration quirks) so the user can decide whether to regenerate.

## Things that go wrong (read this before you start)

- Backend rejects image input (`400 Model only support text input`) - never Read image or PDF files in such runtimes; verify art via metadata and leave visual QA to the human review gate.

- Language code `zh` is rejected — use `zh-Hans`.
- Image upload fails with `IMAGE_TOO_LARGE` — you forgot the JPEG compression step. Re-run Stage 7.
- `DECK_REQUIRED` after a `cd` — card0's CLI state is per-shell; always re-run `card0 game use` and `card0 deck use` after a directory change or new shell.
- Seedream returns only 1 image for a batch — your prompt didn't say "X cards in a coherent set". Rewrite the prompt.
- Seedream swaps the order of cards — the model often reorders. Verify each generated image against `cards_plan.json` before assuming the index matches the prompt.
- Card text on the image has typos — accept it for the in-game metadata is in the description, but mention the imperfection in the final report. Regenerating rarely fixes the same character.
- `card0 game use --id` fails with "unknown option" — use positional `card0 game use <gameId>`, not the `--id` flag.
- `card0 deck list` throws a SyntaxError in browser.js — pass `--game <gameId>` instead of relying on the active game context.

## Reference files

- `references/manifest-schema.md` — full card0 manifest schema with example.
- `references/cli-cheatsheet.md` — every card0 command used in this workflow.
- `references/localization.md` — terminology guide for zh-Hans and ja translations of common game terms.
- `references/image-pipeline.md` — Seedream settings, compression script, upload script templates.
- `evals/evals.json` — test prompts that exercise this skill end-to-end.
