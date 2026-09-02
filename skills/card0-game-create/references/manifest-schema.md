# card0 Manifest Schema v1

The `manifest.json` file is the source of truth for a card0 game. `card0 game validate` reads it before the game is created. Get this right or the CLI will reject the game.

## Top-level shape

```json
{
  "game": { ... },
  "decks": [ { ... }, { ... } ]
}
```

## `game` object

| field | type | required | notes |
|---|---|---|---|
| `name` | string | yes | Display name, e.g. `"Desperate Oasis"`. Localized versions use the translated name. |
| `language` | string | yes | One of: `"en"`, `"ja"`, `"zh-Hans"`, `"other"`. **No `"zh"`, no `"zh-CN"`.** |
| `description` | string | recommended | One-sentence pitch. Shown in the card0 library. |
| `rules` | string | recommended | Multi-paragraph rules text. Plain text or simple markdown. |
| `minPlayers` | int | recommended | Minimum players (e.g. 2). |
| `maxPlayers` | int | recommended | Maximum players (e.g. 2). |
| `theme` | string | recommended | One or two words (e.g. `"animals"`, `"desert"`). |
| `setting` | string | recommended | One or two words (e.g. `"desert"`, `"oasis"`). |
| `mechanic` | string[] | recommended | Free-form tags (e.g. `["drafting", "set collection"]`). |
| `vibe` | string | recommended | One word tone (e.g. `"tense"`, `"cozy"`). |
| `categoryTags` | string[] | **submission** | 1-3 canonical categories: Party, Family, Strategy, Educational, Puzzle, Social Deduction, Role-playing, Trivia, Kids, Casual. |
| `mechanicTags` | string[] | **submission** | 1-3 canonical mechanics: Drafting, Bluffing, Set Collection, Memory, Storytelling, Push-your-luck, Cooperative, Dexterity, Matching, Resource Management. |
| `estimatedMinutes` | int | **submission** | Estimated play time, 1-480. |

## `decks` array

Each deck is an object with:

| field | type | required | notes |
|---|---|---|---|
| `name` | string | yes | Deck name shown in the game UI. |
| `description` | string | recommended | One-line description. |
| `cards` | array | yes | Non-empty array of card objects. |

## `cards` array entries

Each card is an object with:

| field | type | required | notes |
|---|---|---|---|
| `name` | string | yes | Card name. Localized per language. |
| `description` | string | recommended | Card ability / effect text. |
| `quantity` | int | yes | How many copies in the deck. Must be >= 1. |
| `value` | int\|string | recommended | The card's "value" if any (e.g. a point card's `+2`, a rank's `K`). For creatures this is the power. |
| `type` | string | recommended | Free-form category: `"animal"`, `"oasis"`, `"portal"`, etc. |

## Worked example (Desperate Oasis, English)

```json
{
  "game": {
    "name": "Desperate Oasis",
    "language": "en",
    "description": "A 2-player drafting game in a thirsty desert. Tame animals, then race to the oasis before your rival.",
    "rules": "Setup: shuffle the animal deck. Deal 5 oasis cards face-down to a 3x5 grid. Setup phase: take turns drafting animals. After each draft round, take turns revealing and resolving one oasis card per round...",
    "minPlayers": 2,
    "maxPlayers": 2,
    "theme": "animals",
    "setting": "desert",
    "mechanic": ["drafting", "set collection", "hand management"],
    "vibe": "tense",
    "categoryTags": ["Family", "Strategy"],
    "mechanicTags": ["Drafting", "Set Collection"],
    "estimatedMinutes": 20
  },
  "decks": [
    {
      "name": "Animals",
      "description": "Creatures you can tame to score points and abilities.",
      "cards": [
        { "name": "Desert Elephant",     "value": 7, "type": "animal", "quantity": 1, "description": "..." },
        { "name": "Egyptian Jerboa",     "value": 2, "type": "animal", "quantity": 2, "description": "..." },
        { "name": "Golden Jackal",       "value": 4, "type": "animal", "quantity": 2, "description": "..." },
        { "name": "Arabian Camel",       "value": 5, "type": "animal", "quantity": 2, "description": "..." },
        { "name": "Nubian Oryx",         "value": 3, "type": "animal", "quantity": 3, "description": "..." },
        { "name": "Deathstalker Scorpion","value": 1, "type": "animal", "quantity": 2, "description": "..." },
        { "name": "Veiled Chameleon",    "value": 2, "type": "animal", "quantity": 2, "description": "..." }
      ]
    },
    {
      "name": "Oasis",
      "description": "3 rounds of 5 hidden cards revealed one at a time.",
      "cards": [
        { "name": "+1",  "value": 1,  "type": "oasis", "quantity": 3, "description": "Gain 1 point." },
        { "name": "+2",  "value": 2,  "type": "oasis", "quantity": 1, "description": "Gain 2 points." },
        { "name": "+3",  "value": 3,  "type": "oasis", "quantity": 2, "description": "Gain 3 points." },
        { "name": "-1",  "value": -1, "type": "oasis", "quantity": 3, "description": "Lose 1 point." },
        { "name": "-2",  "value": -2, "type": "oasis", "quantity": 2, "description": "Lose 2 points." },
        { "name": "-3",  "value": -3, "type": "oasis", "quantity": 2, "description": "Lose 3 points." },
        { "name": "+2 Portal", "value": 2, "type": "portal", "quantity": 1, "description": "+2 and your rival loses 1 next round." },
        { "name": "+3 Portal", "value": 3, "type": "portal", "quantity": 1, "description": "+3 and your rival loses 1 next round." }
      ]
    }
  ]
}
```

Total oasis cards: 3+1+2+3+2+2+1+1 = 15, matching the printed 3 rounds × 5 cards. **Verify the deck's printed count against your manifest's quantity totals.**

## Validation before submitting

Run the local pre-check (Python) and then `card0 game validate --file manifest.json`. Both must pass.

## Common validation errors

- `language must be one of en|ja|zh-Hans|other` — you used `zh` or `chinese`.
- `deck "X" must have at least one card` — empty cards array.
- `card "Y" is missing field "quantity"` — every card needs quantity.
- `card quantity must be positive` — quantity 0 is rejected.
