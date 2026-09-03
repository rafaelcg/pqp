# Agent notes

Open-source Discord-like voice + text chat (pqp.gg). See [`CLAUDE.md`](./CLAUDE.md) for the stack and how to run.

## i18n

Read [`docs/I18N.md`](./docs/I18N.md) before adding copy.

1. Import only `@/lib/i18n`. Never import `i18next` or `react-i18next` outside `client/src/lib/i18n/` and `electron/`.
2. Add both `en` and `pt-BR` JSON keys. Interpolation is `{name}`, not `{{name}}`.
3. Plurals: `_one` / `_other` / `_zero`. Pass a numeric `count`. Use `_zero` when 0 must not be Portuguese singular.
4. Desktop permission copy: pass `{ context: "desktop" }` at the call site. Do not inject it in the wrapper.
5. Electron menus live in `electron/locales/`. Do not put them in the client JSON.
6. Leave Worker/OG meta, slash command **names**, `error-boundary.tsx`, and legal route files alone unless the task is those files.

## Game connections

Read [`docs/CONNECTIONS.md`](./docs/CONNECTIONS.md) before adding a provider. Steam is OpenID 2.0. Battle.net and Twitch are OAuth. None of those is a Clerk login.

## Release notes (What's New / `/blog`)

The sparkle in the app and `/blog` are the same notes. Markdown in the repo, written in the PR that ships the thing, then never edited. Mechanics: the header of `client/src/lib/blog/posts.ts`.

A person in the QG should be able to find out what changed without being told. That is the bar. Not every PR.

**Write a note (or a section on an unpublished one) when** people can see or use it on pqp.gg, TestFlight, the Android APK, or the desktop app: a new control, a new page, a behavior they will notice, a bug they were living with that is now gone.

**Do not write a note for** CI, tests, refactors, types, docs, the operator dashboard, staging-only work, a flag that is off in production, or a native gap that is not in the build people actually install. Provider swaps and secret wiring are ops, not a note, unless the button itself appears or disappears.

**Do not claim it until it reached people.** Date is that day, not the merge day. If the key is not on Fly, the APK was not rebuilt, or the flag is off, leave it out or put it under "Ainda não" / "Not yet" only if this ship makes people look for it.

**Batch.** Not one post per PR. Prefer adding a section to a note that is still only on this branch. Never edit a post already on `main`. A two-sentence ship can wait for the next pile. Say that in the PR instead of opening a four-line post.

**Copy.** Both `pt-BR` and `en`. PT-BR like the QG. No em dashes. Only write what that client actually has (web is not iPhone is not Android).

**Screenshots.** Nice to have, not required. If you can capture the new UI, put webp/png/gif in `client/public/blog/<slug>/` and reference `/blog/<slug>/file.webp`. Do not skip the note because a shot was awkward (needs two people, a native device, a production key). Write the note anyway.

## How we ship

New work goes on a new branch off latest `main`. One feature per branch.

1. After a UI change, run `pnpm dev` and say what to click. Do not only describe the diff.
2. Check web and Electron when both are in scope.
3. A visual pass must keep existing actions (promote, demote, kick, settings sections).
4. Member cards and composer: equal-width actions, no mid-label ellipsis, aligned send/emoji controls, overflow-y when the card is taller than the viewport.
5. PR title and body in English, short, readable by a human who is not the author.
6. Leave the PR merge-ready: CI green, conflicts gone, Farol 5/5 if it ran. Do not merge unless asked. Do not stash finished work off the PR.
7. Say whether the PR deploys `pqp-api`. A server or schema change on `main` restarts Fly and drops live voice. Client-only Pages deploys do not.
8. Provider keys (Steam, Twitch, Battle.net) live on Fly, not in git. Merging the feature without those secrets must not break production.
9. QG and in-app PT-BR replies must sound like the channel, not a model. If the person's question is unclear, ask Andre before drafting.
