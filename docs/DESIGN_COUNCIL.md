# Design council

A design council is a group of AI models that score pqp's UI from screenshots.
Each model also scores a reference app with the same rules. An agent applies
the fixes the council asks for, captures new screenshots, and asks again. The
loop stops when the scores stop rising.

This is a hill climb: one fixed measurement, one change at a time, and only
changes that raise the score stay. The method follows Theo's T3 Code redesign
(pingdotgg/t3code#24865, October 2026).

The council adds a subjective layer on top of the deterministic one.
`bench:tokens` and `docs/DESIGN.md` still decide what is allowed. The council
decides what looks best inside those rules.

## The parts

| Part | Where |
|---|---|
| Screenshot capture | `client/e2e/design-council-shots.spec.ts` (skipped in the suite) |
| Capture wrapper | `tools/design-council/capture.sh` |
| Reviewer brief | `tools/design-council/BRIEF.md` |
| Reference screenshots | Taken by hand, see "Reference screenshots" |

## The scene

The capture builds the same scene from an empty database every time:

- Eight people, four online, half with a preset avatar.
- Three servers. "Turma do Fliperama" has text and voice channels, one with
  unread messages.
- 14 messages in `#papo` with reactions, and a five-message DM.
- A voice call with four people, then the same call with a camera on.

Everything is pt-BR. The desktop viewport is 1440×900. The phone is 390×844
at 2x.

If the scene changes, every earlier score stops being comparable. Change it
only between campaigns, never inside one.

## Run a capture

You need the local Postgres on `localhost:5432` (user `pqp`) and ffmpeg.

1. From the repository root, run:

   ```bash
   tools/design-council/capture.sh /tmp/pqp-council/current
   ```

2. Wait about one minute. The script prints the 13 file names.

The script drops and recreates the database `pqp_council`. It touches no
other database. It uses ports 3141 and 5341 and refuses to start if either is
busy. Set `COUNCIL_PG`, `COUNCIL_SERVER_PORT` or `COUNCIL_CLIENT_PORT` to
change them.

## Reference screenshots

The reference app is Discord. A person captures it by hand, once per
campaign, because the capture must not log in to anybody's account.

1. Use a throwaway account and a throwaway server. The screenshots go to
   several model providers, so they must not show real people's messages.
2. Rebuild the pqp scene in that server: the same channel names, about the
   same number of people and messages.
3. Set Discord to Portuguese (Brasil).
4. Size the window to 1440×900 (a 2x Retina capture of that size is fine).
5. Capture the same screens as the pqp capture, dark and light, with the same
   file names (`01-chat-dark.png` and so on). Skip a screen if Discord has no
   equivalent.
6. Put them in `/tmp/pqp-council/reference/discord/`.

## Run a round

The directory for a campaign looks like this:

```
/tmp/pqp-council/
  BRIEF.md            copy of tools/design-council/BRIEF.md
  main/               pqp on main, captured once at the start
  current/            pqp with this round's changes
  reference/discord/  the reference screenshots
  rounds/r1/          one answer file per reviewer
```

1. Capture `main/` once, on `main`.
2. Capture `current/` on the working branch.
3. Send each reviewer the same prompt, on a different provider each:

   > Act as a reviewer on the design council. Read the brief at
   > `/tmp/pqp-council/BRIEF.md` and follow it exactly. This is round N.
   > Open every screenshot it lists. Work read-only. Reply in the output
   > format the brief asks for.

4. Save each answer in `rounds/rN/<reviewer>.md`.
5. Merge the fix lists. Apply what two or more reviewers ask for first.
   When reviewers disagree, decide, and write the reason down.
6. Run `pnpm --filter @pqp/client bench:tokens`. It must pass.
7. Capture `current/` again and start the next round.

Stop when the overall score has not risen for two rounds, or when the
reviewers only ask for things outside the round's scope.

## Rules

- Score the reference app in every round. Scores drift, and the reference
  shows how much.
- Keep the scope to polish: tokens, weights, spacing, icons, copy. A layout
  rewrite is a separate plan, not a council fix.
- Visible changes ship behind a toggle, off by default, until people have
  used them. A council score is a model's opinion of a still picture, not
  user data.
- Screenshots miss hover, focus, motion and broken behaviour. Every change
  still gets the normal tests and a human look.
- Record the score table and the before and after screenshots in the PR.
