import type {
  AppEndReason,
  BridgeConnectionStatus,
  BridgeHello,
  BridgeParticipant,
  BridgeTheme,
  JsonValue,
} from "@pqp/shared";
import { PortClient, type Unsubscribe } from "./client.js";
import { PqpAppError } from "./errors.js";

/** One person in the session. Never a pqp user id: a seat id, a name and an avatar data URL. */
export type Participant = BridgeParticipant;

export interface StateSnapshot {
  rev: number;
  value: JsonValue;
}

export interface AppEvent {
  fromSeatId: string;
  name: string;
  data: JsonValue;
}

export interface PickedFile {
  bytes: ArrayBuffer;
  /** Lower-cased, with its dot (`.gba`), from the manifest's accept list. The file name never reaches the app. */
  ext: string;
}

/** What `app.on(...)` can listen for, with the argument each callback receives. */
export interface AppEventMap {
  connection: BridgeConnectionStatus;
  theme: BridgeTheme;
  ended: AppEndReason;
}

export interface PqpApp {
  /** What the host said when it handed the port over: platform version, app id and version, locale, theme, `self`. */
  readonly hello: BridgeHello;
  /** `online`, or `reconnecting` while the host is trying to get the session back. */
  readonly connection: BridgeConnectionStatus;
  readonly participants: {
    get(): Promise<Participant[]>;
    on(callback: (participants: Participant[]) => void): Unsubscribe;
  };
  readonly state: {
    get(): Promise<StateSnapshot>;
    /**
     * A JSON Merge Patch (RFC 7396): an object merges key by key, `null` deletes a key.
     * With `baseRev` the write fails with `stale-rev` when the state has moved on.
     */
    patch(patch: JsonValue, options?: { baseRev?: number }): Promise<{ rev: number }>;
    on(callback: (state: StateSnapshot) => void): Unsubscribe;
  };
  readonly events: {
    /** An ephemeral message for the others in the session. Resolves to `null` once the host accepted it. */
    send(name: string, data?: JsonValue): Promise<null>;
    on(name: string, callback: (event: AppEvent) => void): Unsubscribe;
  };
  readonly assets: {
    /** The bytes of one of the manifest's `assets[]`, already checked against their hash. */
    get(name: string): Promise<ArrayBuffer>;
  };
  readonly files: {
    /** Opens pqp's own file picker. Resolves to `null` when the person cancels. */
    pickLocal(): Promise<PickedFile | null>;
  };
  readonly ui: {
    /** Asks for the frame to be `height` CSS pixels tall (120 to 2000). Resolves to the height applied. */
    resize(height: number): Promise<number>;
    /** Resolves to whether the frame is fullscreen now. */
    fullscreen(on: boolean): Promise<boolean>;
  };
  readonly share: {
    /** Asks pqp to share (or stop sharing) the app pane. Resolves to whether it is shared now. */
    request(on: boolean): Promise<boolean>;
  };
  /** Ends the session for everybody. Only the host may; resolves to `null`. */
  end(): Promise<null>;
  on<K extends keyof AppEventMap>(event: K, callback: (value: AppEventMap[K]) => void): Unsubscribe;
}

function field<T>(result: unknown, key: string): T {
  if (typeof result === "object" && result !== null && key in result) {
    return (result as Record<string, T>)[key] as T;
  }
  throw new PqpAppError("unavailable", `pqp host answered without ${key}`);
}

/** Builds the app object over a port whose `hello` push has already arrived. */
export function createApp(client: PortClient, hello: BridgeHello): PqpApp {
  let connection: BridgeConnectionStatus = hello.connection;

  client.on("connection", (push) => {
    if (push.status === "online" || push.status === "reconnecting") connection = push.status;
  });
  client.on("session.ended", () => {
    // the host's own listeners run first (registered below by `app.on("ended")`
    // after this one), so by then every later call already fails with `ended`
    client.markEnded();
  });

  return {
    hello,
    get connection() {
      return connection;
    },
    participants: {
      async get() {
        return field<Participant[]>(await client.request("participants.get"), "participants");
      },
      on(callback) {
        return client.on("participants", (push) => callback(push.participants as Participant[]));
      },
    },
    state: {
      async get() {
        const result = await client.request<StateSnapshot>("state.get");
        return { rev: field<number>(result, "rev"), value: field<JsonValue>(result, "value") };
      },
      async patch(patch, options) {
        const params: Record<string, unknown> = { patch };
        if (options?.baseRev !== undefined) params.baseRev = options.baseRev;
        return { rev: field<number>(await client.request("state.patch", params), "rev") };
      },
      on(callback) {
        return client.on("state", (push) =>
          callback({ rev: push.rev as number, value: push.value as JsonValue }),
        );
      },
    },
    events: {
      async send(name, data = null) {
        await client.request("events.send", { name, data });
        return null;
      },
      on(name, callback) {
        return client.on("event", (push) => {
          if (push.name !== name) return;
          callback({
            fromSeatId: push.fromSeatId as string,
            name: push.name,
            data: push.data as JsonValue,
          });
        });
      },
    },
    assets: {
      async get(name) {
        return field<ArrayBuffer>(await client.request("assets.get", { name }), "bytes");
      },
    },
    files: {
      async pickLocal() {
        try {
          const result = await client.request("files.pickLocal");
          return { bytes: field<ArrayBuffer>(result, "bytes"), ext: field<string>(result, "ext") };
        } catch (error) {
          if (error instanceof PqpAppError && error.code === "cancelled") return null;
          throw error;
        }
      },
    },
    ui: {
      async resize(height) {
        return field<number>(await client.request("ui.resize", { height }), "height");
      },
      async fullscreen(on) {
        return field<boolean>(await client.request("ui.fullscreen", { on }), "on");
      },
    },
    share: {
      async request(on) {
        return field<boolean>(await client.request("share.request", { on }), "on");
      },
    },
    async end() {
      await client.request("session.end");
      return null;
    },
    on(event, callback) {
      switch (event) {
        case "connection":
          return client.on("connection", (push) => callback(push.status as never));
        case "theme":
          return client.on("theme", (push) => callback(push.theme as never));
        case "ended":
          return client.on("session.ended", (push) => callback(push.reason as never));
        default:
          return () => {};
      }
    },
  };
}
