# Design council brief: pqp

You are one reviewer on a design council. Other models review the same
screenshots on their own. You do not see their answers. Work read-only: do not
edit, create or delete any file.

## What pqp is

pqp (pqp.gg) is an open-source voice and text chat app, in the same category
as Discord. Most of its people are in Brazil, so the product copy is pt-BR and
casual. People use it with friends for games, calls, watch parties and chat.

pqp has a design system. Read `docs/DESIGN.md` in this repository before you
score. Its rules are not up for review in this round:

- Colors, radii, spacing, shadows and durations come from role tokens
  (`surface-0` to `surface-3`, `text`, `text-secondary`, `text-tertiary`,
  `accent`, `border`, `border-strong`, and the others listed there).
- Components compose the primitives in `client/src/components/ui/`.
- Contrast floors are measured by a bench in CI.

Write every fix in those terms. Name the token, the primitive, or the token
value you would change. If a fix needs a new token, say so plainly.

## The screenshots

All screenshots are in the directory that holds this brief:

| Folder | What it is |
|---|---|
| `main/` | pqp as it is on `main`. The baseline. |
| `current/` | pqp with this round's changes. In round 1 it equals `main/`. |
| `reference/<app>/` | The same screens in a reference app (for example `reference/discord/`). |

Each folder uses the same file names, so the same file name is the same screen:

| File | Screen |
|---|---|
| `01-chat-dark.png`, `01-chat-light.png` | A server text channel with the member list open |
| `02-dm-dark.png`, `02-dm-light.png` | A direct message conversation |
| `03-home-dark.png`, `03-home-light.png` | The friends and conversations home |
| `04-settings-dark.png`, `04-settings-light.png` | User settings, first section |
| `05-server-settings-dark.png`, `05-server-settings-light.png` | Server settings, first section |
| `06-call-audio-dark.png` | A voice call with four people, audio only |
| `07-call-camera-dark.png` | The same call with one camera on |
| `08-phone-chat-dark.png` | The text channel on a phone |

A reference folder can miss some screens. Score only what you can see. Open
every screenshot as an image before you score.

### Ignore these, they are artifacts of the capture

- The people, names, messages and timestamps are a fixed scene.
- The camera in `07` shows a generated gradient, not a person.
- The `#1234` numbers after usernames change between captures.
- A small "dev" label in a settings footer.
- Features one app has and the other lacks. This is a design review, not a
  feature comparison.

## How to score

Score each category from 0 to 10, with one decimal. Use these anchors:

| Score | Meaning |
|---|---|
| 10 | Best in class. Nothing to fix. |
| 8 | Polished, professional, shippable. Small issues. |
| 6 | Usable, but visibly unfinished in places. |
| 4 | Confusing or inconsistent enough to slow people down. |

Categories:

1. Typography: type scale, weights, line height, legibility.
2. Hierarchy: the most important thing on each screen reads first.
3. Spacing and density: rhythm, alignment, use of space.
4. Color and contrast: legible text, calm surfaces, purposeful accent and status color.
5. Iconography: consistent size, stroke and meaning.
6. Consistency and polish: the same thing looks the same everywhere, in dark and light.
7. Clarity: a new person understands what each control does and what state things are in.
8. Character: the app has its own identity and does not look like a generic template.
   Do not trade pqp's identity for neutrality to raise other scores.

The overall score is your judgment of the whole, not an average.

## Output format

Reply with exactly these four sections.

### 1. Scores

One table. Rows are the eight categories plus Overall. Columns are
`pqp main`, `pqp current`, and one column per reference app.

### 2. What pqp does better

Two to five sentences. Name the screens.

### 3. Prioritized fixes

A list. Each item has:

- A priority: MUST, SHOULD or COULD.
- One sentence that states the fix.
- The screens it affects, by file name.
- Exact values: tokens, sizes, weights, opacity. For example: "thread titles
  at 14px/20px, weight 500, `text`; metadata at 12px, `text-tertiary`".
- The source file and line, if you can find it with a read-only search of
  `client/src/`.

At most five MUST items. Order the list by impact.

### 4. Keep

One to three things pqp must not lose while it changes.
