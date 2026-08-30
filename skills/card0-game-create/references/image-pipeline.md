# Image Generation, Compression, and Upload Pipeline

Three steps to turn a card0 manifest into a fully illustrated game.

## 1. Generate art with Seedream (byted-ark-seedream-skill)

Settings that have worked for card art:

```python
result = call_seedream(
    prompt=<see templates below>,
    size="2K",                      # 2K, not 4K — 4K blows past the 5MB limit
    response_format="png",
    watermark=False,
    sequential=True,                # required for batches
    count=N,                        # up to 15 in sequential mode
    optimize=True,                  # let Seedream expand your prompt
)
```

### Cover prompt (3:4)

```
A vintage 3:4 cover illustration for a card game called "{TITLE}". 
Show {main motifs — e.g. desert animals racing toward an oasis}. 
Use a warm sandy color palette with deep red sunsets. 
The title "{TITLE}" is rendered in large bold {language} characters 
near the top or bottom of the image. Cinematic, professional, no watermark.
```

### Animal card prompt (square, batched)

```
Generate a coherent set of {N} retro/vintage style animal card illustrations 
in a consistent art style (same series). Each card is square.

Same composition for every card:
- top-left: small white circular medallion with the card value in bold serif
- center: animal illustration
- bottom: the {language} animal name in large bold characters
- below name: the {language} ability text in smaller font

All {language} text must be perfectly clear and correctly rendered. No typos.

1. {Species}: value '{X}', {illustration cue}, name '{name_xx}', ability '{ability_xx}'.
2. {Species}: ...
```

### Oasis (score) card prompt (landscape 16:9, batched)

```
Generate a coherent set of {N} retro/vintage style oasis score cards in a 
consistent art style (16:9 landscape). Same composition for every card:
- top center: '{TITLE_LANG}' (the game title in {language})
- center: large oval medallion with big Arabic numeral
- bottom: '{value}{点|分|pt}' in {language} characters

Color palette:
- positive cards: green/teal desert oasis tones
- negative cards: dark charcoal/scorched
- portal variants: orange with a glowing '{PORTAL_LANG}' in the corner

1. value {N}: {short illustration cue}.
2. ...
```

### Constraints and gotchas

- Minimum 3,686,400 pixels per image. `1536x2048` (3,145,728 px) is rejected. `1920x2560` (4,915,200 px) works. `2048x2048` works.
- `sequential: true, count: 15` is the max batch. More than 15 unique designs → split into multiple batches.
- Set `watermark: false` and `response_format: "png"` always.
- Seedream **reorders**. After each batch, open every image and verify it matches the design in `cards_plan.json` by visual content (animal species, value number, color), not by filename index.
- Garbled / wrong-character text happens, especially for rare CJK characters and diacritics. Single-image regeneration rarely fixes the same character; accept the imperfection or rephrase to avoid the character.
- If a batch returns only 1 image, the prompt didn't say "X cards in a coherent set". Rewrite and retry.

## 2. Compress to JPEG

card0 rejects uploads > 5 MB. Seedream PNGs are 3-7 MB. Always run this pass:

```python
# compress.py
from PIL import Image
import os, sys

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)

for f in sorted(os.listdir(src)):
    if not f.lower().endswith('.png'):
        continue
    img = Image.open(os.path.join(src, f)).convert('RGB')
    img.thumbnail((1500, 1500), Image.LANCZOS)   # longest side <= 1500 px
    out = os.path.join(dst, f.rsplit('.', 1)[0] + '.jpg')
    img.save(out, 'JPEG', quality=85, optimize=True)
    print(out)
```

Run:

```bash
python3 compress.py cards_raw cover cards_lang
# or per-language directory
python3 compress.py cards_raw_en compressed_en
```

For round-based decks where the same value repeats (e.g. three +1 oasis cards), copy the compressed file to suffixes:

```bash
cp compressed/oasis_1.jpg compressed/oasis_1b.jpg
cp compressed/oasis_1.jpg compressed/oasis_1c.jpg
```

card0 dedupes by URL, so re-using the same file is fine — separate files just make the upload script easier to read.

## 3. Upload

See `cli-cheatsheet.md` for the per-card command. The full pattern is:

1. `card0 game use <gameId>`
2. `card0 deck use <deckId>`
3. For each (cardId, file) tuple: `card0 card image upload --face front --mode full_face <cardId> <file>`
4. For the cover: `card0 game image upload <gameId> cover.jpg`

Capture every cardId and deckId with `card0 game show <gameId>` and `card0 deck list --game <gameId>`. Store them in `card_ids.json` so the upload script can be regenerated without re-querying.

## Storage layout that worked

```
/tmp/desperate-oasis/
  manifest.json
  cards_plan.json
  cards_raw_en/             # PNGs out of Seedream
    animal_1.png ... animal_7.png
    oasis_1.png ... oasis_8.png
  cover_en.jpg
  compressed_en/            # JPEGs uploaded to card0
    animal_1.jpg ... animal_7.jpg
    oasis_1.jpg ... oasis_8b.jpg
  upload_animals.sh         # bash script with all card IDs hard-coded
  upload_oasis.sh
  card_ids.json             # dump of every gameId/deckId/cardId
```
