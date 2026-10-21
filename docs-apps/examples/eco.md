# Eco, step by step

Eco (`apps/eco/`, id `pqp-eco`) is the internal test app of the platform: a participant list with avatars, a counter in the shared state, and a ping event. It is small enough to read in one sitting and complete enough to show every habit a real app needs. [Getting started](/guide/getting-started) builds a stripped-down copy; this page is the tour of the real one.

Open the source next to this page: [`apps/eco/src/main.ts`](https://github.com/rafaelcg/pqp/blob/main/apps/eco/src/main.ts).

## The files

```text
apps/eco/
  manifest.source.json   what Eco is and asks for
  index.html             the page: headings, two buttons, a list, no script of its own
  package.json           depends on @pqp/app-sdk
  src/
    main.ts              connect, listeners, render, the two buttons
    model.ts             the counter's shape: read it, build the patch
    session.ts           the screen's state once connected (online, reconnecting, ended)
    i18n.ts              Eco's own words in pt-BR, en and es
    style.css            built on pqp's theme tokens
    *.test.ts            plain vitest, no browser, no pqp
```

The split is the lesson. **The parts that decide things are plain functions in `model.ts` and `session.ts`, with tests; `main.ts` only wires them to the page and to the SDK.** You can test the counter and the "an ended session stays ended" rule without a browser.

## model.ts: the state is a small contract

<<< ../../apps/eco/src/model.ts

The shared state is `{ count: n }`. The reading side is **defensive**: `readCount` accepts `unknown`-shaped JSON and returns `0` for anything that is not a non-negative safe integer. The state is shared and anyone with a seat can write to it, so an app never trusts its shape, even though it wrote the shape. `incrementPatch` builds the merge patch (`{ count: current + 1 }`), which sets one key and leaves any other alone.

## session.ts: "ended" is terminal

<<< ../../apps/eco/src/session.ts

Two rules live here, both found the hard way.

- **An ended session stays ended.** After `ended`, a late `connection` event (a reconnect that lands after the session is over) must never turn the buttons back on, so the flag lives in this object and not in the DOM.
- **Initial reads are independent.** `loadInitial` runs the roster read and the state read separately: if one fails, the other still happens, and nothing is reported once the session is over, because a read refused with `ended` is not a failure.

## main.ts, in the order it runs

1. **Pick a language twice.** First from the browser (`navigator.language`) so the first paint is not English by default, then from `app.hello.locale`, which is the language the person chose **in pqp** and wins. `pickLocale` goes exact match, then base language, then English.
2. **Connect, with retries.** If the page is not inside a frame at all, that is final ("Open Eco inside pqp"). If it is, `connect()` is tried up to four times with a growing pause, because a slow or briefly unreachable host is common right after a join.
3. **Theme and motion.** `applyTheme(app.hello.theme)` and `app.on("theme", ...)`. If `hello.reducedMotion` is set, the page marks itself so the CSS can skip the ping animation.
4. **Listeners first.** `participants.on`, `state.on` and `events.on("ping")` are registered before anything is read. `app.on("ended")` is registered **before** `app.on("connection")`, so a connection event that arrives right after the end finds the session already marked over.
5. **Then the initial reads**, through `loadInitial`.
6. **The "+1" button writes against a revision.** It reads `rev` and `count`, sends the patch with `baseRev`, and on `stale-rev` reads again and retries up to three times. It also handles the case where the host pushed the new state before the `patch` call resolved: it only moves its own copy forward if it is still behind, so the number never runs one ahead.
7. **The ping button** sends `app.events.send("ping", {})`, and shows the flash **after** the host accepted it, so a refused ping is never shown as sent. Events are not echoed to the sender, and a 250 ms cooldown stops a held button from flooding the rate limit.

Every error is handled by code: `rate-limited` and `ended` are silent (the first because it is normal, the second because the ended banner already owns the screen), anything else shows "that did not work".

## i18n.ts and the manifest: two kinds of words

The platform-facing words (the name in the launcher, the one-line description, the presence line "{name} tá no Eco") live in the **manifest**, in all three languages, because pqp draws them outside your frame. The in-app words (button labels, "Who is here") live in **`i18n.ts`**, because only your frame draws them. There is a test that every key exists in all three languages and that no string has an em dash, or says `voce` in pt-BR, or loses the single `{name}` of the ping line. `formatPing` splices the name in with plain string splitting, not `replace`, so a person named `$&` or `{name}` cannot change the sentence.

## style.css: tokens with fallbacks

Every colour, radius and font is a custom property pqp sends (`--color-surface-0`, `--color-text`, `--color-accent`, `--radius-card`), each with a fallback that shows before the first push. The theme is never "the design" in the app: it is the person's.

## What Eco deliberately does not do

It asks for nothing: `identity: "display"`, `share: "none"`, no files, no peer, no assets, and `content` is all false. That is why it is the easiest manifest to review, and the best template to copy for a first app.

## Run the real one

`apps/eco` is on the Sandbox server of a dev checkout with no setup beyond the [dev bypass](/guide/getting-started#_5-run-it-in-pqp-locally). Run `pnpm apps:dev` and `pnpm dev`, open the Sandbox server and start **Eco** from the apps button.
