# The app object

What `connect()` resolves with. The type, in full, as the SDK ships it:

```ts
interface PqpApp {
  readonly hello: BridgeHello;
  readonly connection: BridgeConnectionStatus; // "online" | "reconnecting"
  readonly participants: {
    get(): Promise<Participant[]>;
    on(callback: (participants: Participant[]) => void): Unsubscribe;
  };
  readonly state: {
    get(): Promise<StateSnapshot>;
    patch(patch: JsonValue, options?: { baseRev?: number }): Promise<{ rev: number }>;
    on(callback: (state: StateSnapshot) => void): Unsubscribe;
  };
  readonly events: {
    send(name: string, data?: JsonValue): Promise<null>;
    on(name: string, callback: (event: AppEvent) => void): Unsubscribe;
  };
  readonly assets: {
    get(name: string): Promise<ArrayBuffer>;
  };
  readonly files: {
    pickLocal(): Promise<PickedFile | null>;
    saveLocal(bytes: ArrayBuffer | ArrayBufferView, ext: string): Promise<null>;
  };
  readonly store: {
    get(key: string): Promise<StoredValue | null>;
    put(key: string, bytes: ArrayBuffer | ArrayBufferView, meta?: JsonValue): Promise<StoreUsage>;
    delete(key: string): Promise<null>;
    list(prefix?: string): Promise<StoreEntry[]>;
    usage(): Promise<StoreUsage>;
  };
  readonly ui: {
    resize(height: number): Promise<number>;
    fullscreen(on: boolean): Promise<boolean>;
  };
  readonly share: {
    request(on: boolean): Promise<boolean>;
  };
  end(): Promise<null>;
  on<K extends keyof AppEventMap>(event: K, callback: (value: AppEventMap[K]) => void): Unsubscribe;
}
```

Every call rejects with a [`PqpAppError`](/sdk/errors). Every `on` returns an `Unsubscribe` (`() => void`).

## hello {#hello}

```ts
readonly hello: BridgeHello
```

What the page said when it handed over the port. It never changes during the session (the theme and connection are in `on("theme")` and `on("connection")`).

| Field | Type | |
|---|---|---|
| `type` | `"hello"` | |
| `platformApi` | `1` | The message API version. |
| `app` | `{ id: string; version: string }` | Your app id and the version this session pinned. |
| `locale` | `string` | The language the person picked in pqp, for example `pt-BR`. Use it over `navigator.language`. |
| `theme` | `BridgeTheme` | Up to 64 CSS custom properties. See [Theme](/sdk/theme). |
| `reducedMotion` | `boolean` | The operating system's reduce-motion setting. Honour it. |
| `self` | `{ seatId: string; role: "player" \| "spectator"; isHost: boolean }` | You. Match `seatId` against `participants` to find your own entry. |
| `connection` | `"online" \| "reconnecting"` | The state at the moment of the hello. |

## connection {#connection}

```ts
readonly connection: "online" | "reconnecting"
```

A getter that always holds the current status. `reconnecting` means the page is trying to get the session back: calls that write fail with `unavailable` until it is `online` again. Listen with `app.on("connection", ...)`.

## participants {#participants}

```ts
participants.get(): Promise<Participant[]>
participants.on(callback: (participants: Participant[]) => void): Unsubscribe
```

The people in the session, **the whole list each time**. A `Participant`:

```ts
interface Participant {
  seatId: string;          // 16 to 32 random characters, this session only
  displayName: string;     // 1 to 64 characters, cleaned
  avatar: string | null;   // a data:image/... URL, never a link
  role: "player" | "spectator";
  isHost: boolean;
  connection: "present" | "reconnecting"; // reconnecting: the seat is held for 90 s
  appUserId?: string;      // only with identity "user-id", only for people who consented
}
```

The list fires when anybody joins, leaves, drops or returns. It includes you. At most 264 people.

```ts
app.participants.on(render);
render(await app.participants.get());
```

## state {#state}

```ts
state.get(): Promise<StateSnapshot>
state.patch(patch: JsonValue, options?: { baseRev?: number }): Promise<{ rev: number }>
state.on(callback: (state: StateSnapshot) => void): Unsubscribe

interface StateSnapshot { rev: number; value: JsonValue }
```

The session's shared JSON value and its revision.

- **`get()`** resolves with the current `{ rev, value }`. A new session's value is `{}`.
- **`patch(patch)`** applies a [JSON Merge Patch (RFC 7396)](https://www.rfc-editor.org/rfc/rfc7396) and resolves with the new `rev`. An object merges key by key, `null` deletes a key, anything else replaces the value. The patch must be plain JSON (see [limits](/concepts/bridge#limits)).
- **`patch(patch, { baseRev })`** is a compare-and-set: it fails with `stale-rev` when the state has moved on past `baseRev`, and writes nothing. Written alone and at once, never coalesced.
- **`on(callback)`** fires with the whole `{ rev, value }` after every change, **including your own writes**. It can fire before the promise of your own `patch` resolves. Ignore a snapshot older than the one you hold (`if (next.rev < rev) return`).

Rejects with `not-host` (manifest `writers: "host"` and you are not), `not-allowed` (spectator), `too-large`, `rate-limited`, `stale-rev`, `unavailable` (reconnecting), `ended`, or `invalid`.

```ts
// read-modify-write, safe against two people at once
const { rev, value } = await app.state.get();
try {
  await app.state.patch({ count: readCount(value) + 1 }, { baseRev: rev });
} catch (error) {
  if (!(error instanceof PqpAppError) || error.code !== "stale-rev") throw error;
  // somebody was faster: read again and retry
}

// your own key: no baseRev needed
await app.state.patch({ votes: { [app.hello.self.seatId]: 2 } });
```

See [Sessions](/concepts/sessions#shared-state) for the design advice.

## events {#events}

```ts
events.send(name: string, data?: JsonValue): Promise<null>
events.on(name: string, callback: (event: AppEvent) => void): Unsubscribe

interface AppEvent { fromSeatId: string; name: string; data: JsonValue }
```

Ephemeral messages for the **other** people in the session. Not stored, not replayed to somebody who joins later.

- `name` matches `/^[a-z][a-z0-9.-]{0,31}$/`. `data` is any JSON up to the manifest's `events.maxBytes`, and defaults to `null`.
- `send` resolves to `null` once the page accepted the event. Show its effect locally at that moment: do not rely on receiving your own event back.
- `on(name, cb)` fires only for events with that name. Register one per name.
- Rejects with `not-allowed` (manifest events are 0, or you are a spectator), `too-large`, `rate-limited`, `unavailable`, `ended`, `invalid`.

```ts
app.events.on("ping", ({ fromSeatId }) => showPing(fromSeatId));
await app.events.send("ping", {});
```

## assets {#assets}

```ts
assets.get(name: string): Promise<ArrayBuffer>
```

The bytes of one of the manifest's `assets[]`, by its `name`. The page fetches it from the apps origin, checks its length and its sha256 against the manifest, and **transfers** the buffer to you. Use it for what the content security policy keeps you from fetching: a WebAssembly core, a big sprite sheet, a sound.

Rejects with `invalid` (no asset of that name in your manifest), `unavailable` (the fetch failed or the hash did not match), `ended`.

## files {#files}

```ts
files.pickLocal(): Promise<PickedFile | null>

interface PickedFile { bytes: ArrayBuffer; ext: string }
```

Opens pqp's own file picker. Resolves to `null` if the person cancels, otherwise `{ bytes, ext }`: the file's contents, and its extension lower-cased with its dot (`.gba`), taken from your manifest's `accept` list. **The file name never reaches the app** and nothing is uploaded.

Needs `capabilities.localFiles` in the manifest, with `accept` and `maxBytes`. Rejects with `not-allowed` (not declared, or a file of another type), `too-large`, `rate-limited` (a picker is already open), `ended`.

```ts
files.saveLocal(bytes: ArrayBuffer | ArrayBufferView, ext: string): Promise<null>
```

Hands the person a file to keep: pqp triggers the download and names it. `ext` has its dot and must be one the platform allows for saving (today `.locadora`) and one of your manifest's `localFiles.accept`. Rejects with `not-allowed` otherwise, `too-large` past the manifest's cap.

## store {#store}

```ts
store.get(key: string): Promise<StoredValue | null>
store.put(key: string, bytes: ArrayBuffer | ArrayBufferView, meta?: JsonValue): Promise<StoreUsage>
store.delete(key: string): Promise<null>
store.list(prefix?: string): Promise<StoreEntry[]>
store.usage(): Promise<StoreUsage>

interface StoredValue { bytes: ArrayBuffer; meta: JsonValue }
interface StoreEntry { key: string; size: number; meta: JsonValue; updatedAt: number }
interface StoreUsage { used: number; cap: number; persisted: boolean }
```

Named blobs kept on the person's own device, per app id: no other app sees them and pqp never reads or sends them. Keys use `a-z 0-9 : . _ -`, 1 to 128 characters. `put` copies your bytes and accepts up to 2048 bytes of JSON `meta`; `list` returns at most 500 entries, with no bytes.

Needs `capabilities.deviceStore` in the manifest. Every call rejects with `not-allowed` when it is not declared and with `invalid` on a page that predates it, so keep the data in memory and carry on. `put` rejects with `too-large` past the manifest's cap.

## ui {#ui}

```ts
ui.resize(height: number): Promise<number>
ui.fullscreen(on: boolean): Promise<boolean>
```

- **`resize(height)`** asks for the frame to be `height` CSS pixels tall, an integer from 120 to 2000, and resolves to the height pqp accepted. Out of range or non-integer rejects with `invalid`.
- **`fullscreen(on)`** asks the page to take the frame fullscreen (or leave it) and resolves to whether it is fullscreen now. Rejects with `not-allowed` if the page cannot or will not.

## share {#share}

```ts
share.request(on: boolean): Promise<boolean>
```

Asks pqp to share the app's pane through its own screen-share flow (or to stop), and resolves to whether it is shared now. Needs `capabilities.share: "pane"` in the manifest, a voice channel, and that the platform allows sharing for this app. Rejects with `not-allowed` or `unavailable`.

## end() {#end}

```ts
end(): Promise<null>
```

Ends the session for everybody. Only the session host may: anyone else gets `not-host`. Resolves to `null`, and `ended` fires.

## on(event, callback) {#on}

```ts
on<K extends keyof AppEventMap>(event: K, callback: (value: AppEventMap[K]) => void): Unsubscribe

interface AppEventMap {
  connection: "online" | "reconnecting";
  theme: BridgeTheme;
  ended: AppEndReason;
}
```

| Event | Fires | Argument |
|---|---|---|
| `"connection"` | The page lost or regained the session. | `"online"` or `"reconnecting"`. |
| `"theme"` | The person changed brightness, skin, contrast or accent. | The new tokens, to pass to [`applyTheme`](/sdk/theme). |
| `"ended"` | The session is over. | The reason: `host`, `moderator`, `operator`, `idle`, `host-gone`, `app-disabled`, `empty`, `max-duration`, `channel-gone` or `flag-off`. |

After `"ended"` every call rejects with `ended`. An event name that is not one of these returns a no-op unsubscribe and never fires.

```ts
app.on("ended", () => {
  showMessage("The session ended.");
  disableButtons();
});
```
