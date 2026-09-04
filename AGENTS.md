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

## How we ship

New work goes on a new branch off latest `main`. One feature per branch.

1. After a UI change, run `pnpm dev` and say what to click. Do not only describe the diff.
2. Check web and Electron when both are in scope.
3. A visual pass must keep existing actions (promote, demote, kick, settings sections).
4. Member cards and composer: equal-width actions, no mid-label ellipsis, aligned send/emoji controls, overflow-y when the card is taller than the viewport.
5. PR title and body in English, short, readable by a human who is not the author.
6. Leave the PR merge-ready: CI green, conflicts gone, Farol 5/5 if it ran. Do not merge unless asked. Do not stash finished work off the PR.
7. Say whether the PR deploys `pqp-api`. A server or schema change on `main` restarts Fly and drops live voice. Client-only Pages deploys do not. If it restarts the API, apply the `drops-voice` label. CI stamps `size/XS`–`size/XL` from the diff; leave those alone.
8. Provider keys (Steam, Twitch, Battle.net) live on Fly, not in git. Merging the feature without those secrets must not break production.
9. QG and in-app PT-BR replies must sound like the channel, not a model. If the person's question is unclear, ask Andre before drafting.
