---
layout: home
title: Write a call app in an afternoon
titleTemplate: pqp apps
hero:
  name: pqp apps
  text: Write a call app in an afternoon.
  tagline: A poll, a game, a shared counter, a jukebox. An app is one small web page that pqp opens inside a text or voice channel. The SDK is 6 KB and has no dependencies.
  image:
    src: /hero-pixel.svg
    alt: A pqp chat bubble connected to a small app window
  actions:
    - theme: brand
      text: Build one in 20 minutes
      link: /guide/getting-started
    - theme: alt
      text: How it works
      link: /concepts/how-it-works
    - theme: alt
      text: SDK reference
      link: /sdk/
features:
  - title: One page, one import
    details: Your app is a normal web page. Import @pqp/app-sdk, call connect(), and you are in a session with whoever is in the channel.
  - title: Shared state, no server
    details: Everybody in the session sees one JSON value. You write it with a merge patch, pqp keeps it, orders the writes and pushes it to everyone. You never run a backend.
  - title: Sandboxed from the start
    details: No network, no storage, no cookies, no access to the page around you. You cannot break pqp, and people can try your app without trusting you.
  - title: Looks like pqp
    details: pqp sends its design tokens, light or dark, as CSS custom properties. Use them and your app matches the theme the person picked, with no work.
  - title: People, not accounts
    details: You see a display name, an avatar and a random seat id. Never a user id, an email, a server or a channel. The privacy rules are in the protocol, not in a promise.
  - title: Open source
    details: The SDK, the sandbox, the packager and the apps pqp ships are all in one repository. Read how it works before you write a line.
---

## What a pqp app is

Somebody in a text or voice channel opens the apps launcher next to the message box and starts an app. A card lands in the conversation, others tap **Join**, and the app runs in a small frame inside pqp. When it ends, the card turns into a quiet record of what happened.

The platform owns everything around the app: the launcher, the card, the "Raf is in Eco" line under a name, who may start it, moderation. **You write the inside of the frame.**

Here is a complete shared counter, and this is the whole idea:

```ts
import { applyTheme, connect, PqpAppError } from "@pqp/app-sdk";

const app = await connect(); // the handshake with the pqp page
applyTheme(app.hello.theme); // pqp's colors as CSS custom properties

const label = document.querySelector("#count")!;
const show = ({ value }: { value: unknown }) => {
  label.textContent = String((value as { count?: number } | null)?.count ?? 0);
};
app.state.on(show); // listeners first...
show(await app.state.get()); // ...then the value from before them

document.querySelector("#plus")!.addEventListener("click", async () => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { rev, value } = await app.state.get();
    const count = (value as { count?: number } | null)?.count ?? 0;
    try {
      await app.state.patch({ count: count + 1 }, { baseRev: rev }); // a merge patch, written against the revision we read
      return;
    } catch (error) {
      if (!(error instanceof PqpAppError) || error.code !== "stale-rev") throw error; // somebody was faster: read again
    }
  }
  console.warn("too many writes at once, that click was not applied"); // all four attempts lost a race: say so, never drop it silently
});
```

Start it in a channel with two people in it and the number moves for both. That is the same machinery a poll, a drawing board or a card game uses.

## What you get

- **A typed SDK.** `connect()`, a `PqpApp` object with `participants`, `state`, `events`, `assets`, `files`, `ui`, `share`, and `PqpAppError` with a code you can switch on. [Reference](/sdk/).
- **A manifest instead of a settings page.** One JSON file says how many people, which channel types, how big the shared state may be and what the app asks of the platform. pqp shows it to people and enforces it again on its side. [The manifest](/concepts/manifest).
- **A packager and a dev server.** `pnpm apps:build` gives you a bundle with integrity hashes and the exact security headers it will be served with. `pnpm apps:dev` serves it locally and rebuilds when you save. [Publishing](/publishing/).

## Where this stands

::: info Honest status
The platform is real and runs behind a flag, server by server. The apps that exist today are written by the pqp team, and they live in the pqp repository: Eco (the test app this site builds step by step), Enquete (a live poll) and Locadora (a retro emulator, in review). **Third-party submission and the appstore are planned, not built.** Today the way to build and run your own app is to work in a clone of the repository, which [Getting started](/guide/getting-started) walks through. The npm package `@pqp/app-sdk` is prepared but not published yet.
:::

The [appstore page](/publishing/appstore) says what is decided and what is not.
