# Types and low-level exports

Everything here is exported from `@pqp/app-sdk`. The types are written out in the SDK itself (`src/types.ts`) so the published `.d.ts` needs no other package, and a test fails if they drift from the protocol's own schemas.

## Wire types

```ts
/** A value that survives JSON.stringify and JSON.parse unchanged. */
type JsonValue =
  | null | boolean | number | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type BridgeErrorCode =
  | "not-allowed" | "not-host" | "too-large" | "rate-limited" | "stale-rev"
  | "cancelled" | "unavailable" | "ended" | "invalid";

type BridgeConnectionStatus = "online" | "reconnecting";

/** CSS custom property names (`--color-text`) to their values, at most 64. */
type BridgeTheme = Record<string, string>;

type AppRole = "player" | "spectator";
type AppParticipantConnection = "present" | "reconnecting";

type AppEndReason =
  | "host" | "moderator" | "operator" | "idle" | "host-gone"
  | "app-disabled" | "empty" | "max-duration" | "channel-gone" | "flag-off";

interface BridgeParticipant {
  seatId: string;
  displayName: string;
  avatar: string | null;
  role: AppRole;
  isHost: boolean;
  connection: AppParticipantConnection;
  appUserId?: string;
}

interface BridgeHello {
  type: "hello";
  platformApi: 1;
  app: { id: string; version: string };
  locale: string;
  theme: BridgeTheme;
  reducedMotion: boolean;
  self: { seatId: string; role: AppRole; isHost: boolean };
  connection: BridgeConnectionStatus;
}
```

## App types

```ts
/** One person in the session. Never a pqp user id. */
type Participant = BridgeParticipant;

interface StateSnapshot {
  rev: number;
  value: JsonValue;
}

interface AppEvent {
  fromSeatId: string;
  name: string;
  data: JsonValue;
}

interface PickedFile {
  bytes: ArrayBuffer;
  /** Lower-cased, with its dot (`.gba`), from the manifest's accept list. */
  ext: string;
}

/** What `app.on(...)` can listen for. */
interface AppEventMap {
  connection: BridgeConnectionStatus;
  theme: BridgeTheme;
  ended: AppEndReason;
}

type Unsubscribe = () => void;

interface ConnectOptions {
  timeoutMs?: number;
  window?: HandshakeWindow;
}
```

`PqpApp` is on [its own page](/sdk/app), `HandshakeWindow` is under [`connect()`](/sdk/connect) and `ThemeRoot` under [Theme](/sdk/theme).

## Low-level exports

You do not need these to write an app. They exist for tests and for building your own transport.

### `REQUEST_TIMEOUT_MS`

```ts
const REQUEST_TIMEOUT_MS = 15_000;
```

How long a request may wait for the page before it rejects with `unavailable`, and the default of `connect()`'s `timeoutMs`.

### `PortClient`

```ts
class PortClient {
  constructor(port: MessagePort, timeoutMs?: number);
  readonly ended: boolean;
  markEnded(): void;
  request<T>(type: string, params?: Record<string, unknown>): Promise<T>;
  on(type: string, listener: (push: Record<string, unknown>) => void): Unsubscribe;
}
```

The request and push plumbing over the port the page handed over. `request` posts `{ ...params, id, type }`, times out with `unavailable`, and checks that a success echoes the request type. `on` registers a listener for a push `type` (`"hello"`, `"state"`, `"event"`, ...). It ignores anything it does not recognise instead of throwing inside a message handler. `markEnded()` makes every later `request` reject with `ended`.

### `createApp`

```ts
function createApp(client: PortClient, hello: BridgeHello): PqpApp;
```

Builds the app object over a `PortClient` whose `hello` push has already arrived. `connect()` is the handshake plus this. Use it to drive an app from a test with a `MessageChannel` you hold both ends of, without a window.
