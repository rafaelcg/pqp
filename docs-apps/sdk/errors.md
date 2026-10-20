# Errors

```ts
class PqpAppError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message?: string);
}

type BridgeErrorCode =
  | "not-allowed" | "not-host" | "too-large" | "rate-limited" | "stale-rev"
  | "cancelled" | "unavailable" | "ended" | "invalid";
```

Every call on the app object that fails rejects with a `PqpAppError`. `error.name` is `"PqpAppError"`, `error.code` is one of the nine codes, and `error.message` is `pqp app call failed: <code>` unless the SDK has something more specific to say (a timed-out call names the request).

A code the SDK does not know (a page newer than your SDK) is read as `unavailable`, so `switch (error.code)` over the nine is exhaustive.

```ts
import { PqpAppError } from "@pqp/app-sdk";

try {
  await app.state.patch({ round: 2 }, { baseRev: rev });
} catch (error) {
  if (!(error instanceof PqpAppError)) throw error; // a bug of yours, not a platform answer
  switch (error.code) {
    case "stale-rev":     /* read again and retry */ break;
    case "rate-limited":  /* back off, ignore this one */ break;
    case "ended":         /* the session is over; ended already fired */ break;
    case "unavailable":   /* reconnecting or no answer: retry later */ break;
    default:              showMessage("That did not work.");
  }
}
```

## What each code means, and which calls give it

| Code | Means | Given by |
|---|---|---|
| `not-allowed` | The manifest or the person's role does not permit it. | `state.patch` and `events.send` from a spectator; `events.send` when the manifest sets events to 0; `files.pickLocal` without the capability or with a file of another type; `share.request` without `share: "pane"`; `ui.fullscreen` when refused |
| `not-host` | Only the session host may. | `end()` from a player; `state.patch` when `state.writers` is `"host"` |
| `too-large` | Over a cap. | `state.patch` (the merged value past `state.maxBytes`); `events.send` (past `events.maxBytes`); `files.pickLocal` (past `localFiles.maxBytes`) |
| `rate-limited` | Too fast. | `state.patch`, `events.send`; `files.pickLocal` while a picker is open; any burst the page treats as a flood |
| `stale-rev` | The state moved on past your `baseRev`. | `state.patch` with `baseRev` |
| `cancelled` | The person cancelled. | `files.pickLocal` (the SDK turns it into `null`, you never see this one) |
| `unavailable` | No answer, or it did not work. | Any call, when the page does not answer in 15 s, is reconnecting, or sends a reply that does not match; `connect()`; `assets.get` when the fetch failed or the sha256 did not match |
| `ended` | The session is over. | Every call after `ended` |
| `invalid` | The request itself is not valid. | A bad event name; a value that is not JSON, or cannot be sent; a height out of range; an asset name that is not in the manifest |

Which of these are worth retrying: `stale-rev` (after reading again), `rate-limited` (after a pause) and `unavailable` (the page may recover). `not-allowed`, `not-host`, `too-large` and `invalid` will fail the same way again. `ended` is final.

## Not an error: `null`

`files.pickLocal()` resolves to `null` when the person cancels, and `events.send()` and `end()` resolve to `null` on success. They never reject with `cancelled` or return `undefined`.
