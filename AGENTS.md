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
