# connect()

```ts
function connect(options?: ConnectOptions): Promise<PqpApp>;

interface ConnectOptions {
  /** Time allowed for the handshake and for each later request. Default 15 000 ms. */
  timeoutMs?: number;
  /** Defaults to `window`. */
  window?: HandshakeWindow;
}

interface HandshakeWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}
```

Connects the app to the pqp page that is hosting it, and resolves with the [app object](/sdk/app) once the page has sent its `hello`.

## What it does

1. Posts `{ pqp: "app-hello", platformApi: 1 }` to `window.parent` with target `"*"`. The frame's origin is opaque, so the parent cannot be addressed by origin. It posts again every second until the page answers.
2. Accepts exactly **one** `app-port` message, and only when `event.source` is `window.parent`. A message from a sibling frame or an extension is ignored.
3. Waits for the page's `hello` push on the port, checks that every field an app reads is present and of the right kind, and resolves.

## Rules

- **Call it once, early.** A second call from the same window returns the first call's promise.
- **Register listeners straight after it resolves.** Pushes are not replayed.
- **It rejects with `PqpAppError("unavailable")`** when the page does not answer within `timeoutMs` (default 15 seconds), when the page sends a `hello` that is not usable, and **immediately** when the document is not inside a frame at all (`window.parent === window`), which is what you see opening the app's `index.html` in a normal tab.
- A failed attempt is forgotten, so calling `connect()` again tries again.
- `timeoutMs` also becomes the timeout of every later request on this app.

## Patterns

**Tell "outside pqp" from "pqp is slow".** Both reject with `unavailable`, so check where you are first, the way Eco does:

```ts
let app: PqpApp | null = null;
if (window.parent !== window) {
  for (let attempt = 0; attempt < 4 && !app; attempt += 1) {
    try {
      app = await connect();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}
if (!app) {
  showMessage(window.parent === window ? "Open this inside pqp." : "Could not connect. Close and reopen the app.");
  return;
}
```

**Test your app without pqp.** Pass a `window` that stands in for the page, and answer the handshake yourself. The SDK's own tests do this with a fake host on a real `MessageChannel`, which is the shape to copy: `packages/app-sdk/src/fake-host.fixture.ts` in the repository.

## Related

- [`PqpApp`](/sdk/app), what it resolves with.
- [Errors](/sdk/errors).
- [The bridge](/concepts/bridge#the-handshake), what happens on the wire.
