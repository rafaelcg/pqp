# What an app can keep

Short version: **nothing outlives the session**, and an app has no storage of its own at all. This surprises people who come from the web, so this page is the full list.

## What you have

| Where | Lives | Size | For |
|---|---|---|---|
| **Your page's memory** | until the frame closes | the browser's | everything about the current screen |
| **Shared state** (`app.state`) | until the session ends | up to 16 KB, set in the manifest | what everybody in the session must agree on |
| **Events** (`app.events`) | not at all, delivered once | up to 1 KB each | what matters only right now |
| **Assets** (`app.assets.get`) | forever, they are part of the version | up to 32 MiB each, up to 64 | big files you ship: a WebAssembly core, a sprite sheet, a sound |
| **The person's own file** (`app.files.pickLocal`) | in your frame's memory only | up to the manifest's `maxBytes` | a file they choose, such as a save or a game |

The app cannot use the browser's storage. Because the frame has an opaque origin, `localStorage`, `sessionStorage`, IndexedDB and cookies all throw a `SecurityError`, and the content security policy blocks every network request, so there is nowhere to send data either. This is the sandbox doing its job, not a missing feature that will be turned on for you. See [the sandbox](/concepts/sandbox).

## The one thing you can leave behind

When a session ends, its state is set back to `{}`. But an app that has something worth showing can write a small object to `state.result` **before** it ends, and pqp copies it into the session's summary, which is what the "ended" card on the timeline shows.

```ts
await app.state.patch({
  result: { text: "Winner: Pizza, 5 votes" },
});
```

- `state.result` must be a JSON object of at most **512 bytes** of compact JSON. Anything else (a string, a number, an array, something bigger) is dropped, and the card shows what it always shows.
- `text` is the one field the card draws: a plain string, one line, at most **200 characters**, in the language you choose. Every other field is yours to keep but is not drawn.
- Write it at the moment the outcome is known (Enquete writes it when the vote closes), not when you end the session, so that however the session ends afterwards (the session host, a moderator, the idle sweep) it is already there.

This is a one-way note to the conversation. You cannot read it back in a later session.

## What happens to a person's data

- The shared state is cleared at the end, and ended sessions are deleted after 30 days.
- Events are relayed and forgotten: never stored, never logged.
- A file a person picks goes from their disk to your frame's memory. It is not uploaded and its name never crosses.
- Avatars are fetched by the page (only from pqp's own origins), turned into data URLs and handed to you for the length of the roster push.

## "But I need to remember something between sessions"

Today you cannot, and there is no persistent store in the SDK to point you to. The two honest options are:

1. **Ask the people.** Put the thing in the state and let the session host keep it, or have players re-enter it. For a save file, use `files.pickLocal()` so the person keeps it on their own disk.
2. **Leave a result** on the card, as above, so the conversation remembers.

If your app really cannot work without a place to persist data, that is useful to know. Say so in an issue on the repository; it is the kind of feedback that decides what the platform gets next.
