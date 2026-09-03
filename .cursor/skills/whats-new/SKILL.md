---
name: whats-new
description: >-
  Writes a weekly pqp What's New /blog catch-up post from what people can
  already use. Use only when Andre asks to catch up What's New, write a
  release note, or ship the weekly blog post. Do not run from a feature PR.
disable-model-invocation: true
---

# What's New catch-up

One post for the pile since the last note. Not one post per PR. Only when Andre asks.

## Do not write

CI, tests, refactors, types, docs, operator dashboard, staging-only work, a flag still off in production, a native gap that is not in the build people install, provider swaps, secret wiring. Fundraising and `/apoie` are not a section (the footer already has the link).

If the week is two sentences of polish, say so and stop. Do not invent a post.

## Research (do this first)

1. Last published date: newest entry in `client/src/lib/blog/posts.ts` that is on `origin/main`.
2. What merged since then: `git log origin/main --since=<that-date> --oneline`.
3. What people can actually use today: pqp.gg, TestFlight, the Android APK, desktop. Date is that day, not the merge day.
4. Per client. Web is not iPhone is not Android. Only claim what that client has.
5. If a Fly key is missing or a flag is off, omit it, or put it under **Ainda não** / **Not yet** only if this post will make people look for it.
6. If an unpublished note already exists on this branch, extend that one. Never edit a post already on `main`.

## Shape

Product What's New, not Keep a Changelog. No Added / Changed / Fixed labels.

1. One headline feature: what it is, how to use it, a screenshot if you have one.
2. Other real features as their own headings (a new control people will hunt for is not a bullet in O resto).
3. **O resto** / **The rest** for the small pile.
4. **Ainda não** / **Not yet** only if this ship makes people look for something that is not live.

Voice: PT-BR like the QG. English matches. No em dashes. Both locales.

Voice example: `client/src/content/blog/dados-discord-e-cargos.pt-BR.md`.

## Files

Slug: lowercase Portuguese, hyphenated, never reused.

1. `client/src/content/blog/<slug>.pt-BR.md` and `.en.md`
2. Entry at the **top** of `POSTS` in `client/src/lib/blog/posts.ts` (title + one or two sentence summary)
3. Both importers in `BODIES` in `client/src/lib/blog/bodies.ts`
4. URL + `lastmod` at the top of the blog urls in `client/public/sitemap.xml`
5. Optional shots in `client/public/blog/<slug>/`, referenced as `/blog/<slug>/file.webp`

Do not import markdown from `posts.ts`. The Pages middleware cannot load `.md`. See the header of `posts.ts`.

## Screenshots

Nice to have. Capture if the UI is in front of you. Do not skip the post because a shot is awkward.

## After writing

Show Andre the headline, what went in, and what you left out (and why). Do not commit unless asked.
