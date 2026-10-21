# SDK reference

`@pqp/app-sdk` is what an app imports to talk to the pqp page. It does the [handshake](/concepts/bridge#the-handshake), numbers and matches requests, checks every answer, and gives you one typed object.

- **No dependencies**, runtime or type. About 6 KB minified, 2.3 KB gzipped.
- **ES2022 modules**, for a browser (`MessagePort`, `MessageEvent`). Your `tsconfig` needs `"lib": ["ES2022", "DOM"]`.
- **`sideEffects: false`.** Importing it does nothing until you call `connect()`; a bundler drops what you do not use.
- **Speaks platform API 1.** The `platformApi` in your manifest must be `1`.

::: info Install
`@pqp/app-sdk` is **prepared for npm but not published yet**. Today an app lives in the pqp repository and depends on it from the workspace, which is what [Getting started](/guide/getting-started) does:

```json
{ "dependencies": { "@pqp/app-sdk": "workspace:*" } }
```

Once it is published the install is `npm install @pqp/app-sdk`. The steps, and the two decisions it waits for (the license and the npm scope), are in [`packages/app-sdk/PUBLISHING.md`](https://github.com/rafaelcg/pqp/blob/main/packages/app-sdk/PUBLISHING.md).
:::

## Everything it exports

```ts
import {
  connect,            // the handshake: Promise<PqpApp>
  applyTheme,         // pqp's design tokens onto your page
  PqpAppError,        // what every rejected call throws
  connectWithSync,    // connect() plus the account-saves calls (Locadora only)
  createApp,          // lower level: build the app over a port (tests, advanced)
  createSyncApi,      // lower level: the account-saves calls over a port
  PortClient,         // lower level: the request and push plumbing
  REQUEST_TIMEOUT_MS, // 15_000
} from "@pqp/app-sdk";
```

| Export | Kind | Page |
|---|---|---|
| `connect(options?)` | function | [connect()](/sdk/connect) |
| `PqpApp` and its members: `hello`, `connection`, `participants`, `state`, `events`, `assets`, `files`, `store`, `ui`, `share`, `end()`, `on()` | type | [The app object](/sdk/app) |
| `PqpAppError` | class | [Errors](/sdk/errors) |
| `applyTheme(theme, root?)`, `ThemeRoot` | function, type | [Theme](/sdk/theme) |
| `Participant`, `StateSnapshot`, `AppEvent`, `PickedFile`, `AppEventMap`, `Unsubscribe`, `ConnectOptions`, `HandshakeWindow`, `JsonValue`, `BridgeHello`, `BridgeParticipant`, `BridgeTheme`, `BridgeErrorCode`, `BridgeConnectionStatus`, `AppEndReason`, `AppRole`, `AppParticipantConnection` | types | [Types](/sdk/types) |
| `createApp`, `PortClient`, `REQUEST_TIMEOUT_MS`, `connectWithSync`, `createSyncApi` | lower level | [Types and low level](/sdk/types#low-level-exports) |

The runtime exports are exactly the eight names in the first block. Everything else is a type and disappears at build time.

## A minimal app

```ts
import { connect } from "@pqp/app-sdk";

const app = await connect();
console.log("I am seat", app.hello.self.seatId, "in", app.hello.app.id);
const people = await app.participants.get();
console.log(people.map((person) => person.displayName));
```

## Conventions that hold across the API

- **Every call returns a promise** and rejects with a [`PqpAppError`](/sdk/errors).
- **Every listener returns an unsubscribe function.** Register listeners right after `connect()` and read the value from before with a `get` call: a push that arrives before its listener exists is not replayed.
- **A listener that throws** does not stop the others or the port: the error is logged with `console.error`.
- **Nothing is cached for you.** `state.get()` and `participants.get()` ask the page each time. Keep your own copy and keep it current from the pushes.
- **After the session ends**, `ended` fires once and every later call rejects with `ended` immediately.
- **Timeouts.** A call the page does not answer within 15 seconds (`REQUEST_TIMEOUT_MS`, or the `timeoutMs` you gave `connect`) rejects with `unavailable`.

## Versioning

The SDK follows SemVer and tracks the platform API: platform API 2 would be SDK 2.x. Before 1.0 a minor release may change a signature, so pin the exact version. The full policy is in the package's [CHANGELOG](https://github.com/rafaelcg/pqp/blob/main/packages/app-sdk/CHANGELOG.md).
