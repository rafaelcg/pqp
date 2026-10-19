import {
  APP_EVENT_MAX_BYTES,
  APP_EVENT_MAX_PER_SECOND,
  APP_PARTICIPANTS_AVATAR_BUDGET_CHARS,
  APP_PLATFORM_API,
  APP_STATE_MAX_BYTES,
  APP_STATE_MAX_WRITES_PER_SECOND,
  APP_DISPLAY_NAME_MAX_CHARS,
  bridgeAppMessageSchema,
  bridgeHelloPushSchema,
  bridgeParticipantSchema,
  bridgePushSchema,
  bridgeRequestIdSchema,
  bridgeResponseOkSchema,
  jsonByteLength,
  type AppEndReason,
  type BridgeAppMessage,
  type BridgeConnectionStatus,
  type BridgeErrorCode,
  type BridgeParticipant,
  type BridgeRequestType,
  type BridgeTheme,
  type JsonValue,
} from "@pqp/shared";
import { AvatarCache } from "./avatar";
import { fetchAsset, type AssetRef } from "./asset-fetch";
import { pickLocalFile, type PickOptions, type PickResult } from "./file-pick";
import { TokenBucket } from "./limiter";
import { stateBytesAfter } from "./merge-patch";
import { domThemeSource, sameTheme, type ThemeSource } from "./theme-tokens";
import {
  AppTransportError,
  type AppErrorCode,
  type AppRuntimeConfig,
  type AppSessionTransport,
  type AppUserDirectory,
  type SessionSnapshot,
} from "./types";

/**
 * The bridge host: the pqp page's half of the sandbox message API
 * (`packages/shared/src/apps/bridge.ts`), one per app frame.
 *
 * The app is untrusted. So:
 *
 * - every message from it is parsed with `bridgeAppMessageSchema`, which is
 *   strict (an unknown key is a rejection); a message that fails is answered
 *   `invalid`, or dropped when it carries no usable request id;
 * - the manifest's caps and capabilities are enforced here AGAIN (the server
 *   enforces them for real): events per second and bytes, state bytes after the
 *   patch, who may write, `share` only for a `pane` app on a server where
 *   sharing is allowed, `files.pickLocal` only when the manifest allows files;
 * - what goes back is built from scratch (no user id, ever: a participant is a
 *   seat id, a name, an avatar data URL) and passed through the response and
 *   push schemas before it is posted;
 * - a flood of messages is answered `rate-limited` without parsing, and a
 *   sustained one is reported through `onViolation`.
 *
 * It talks to the session through an injected `AppSessionTransport`, so it is
 * built and tested before the `/ws` frames are wired in.
 */

export type BridgeViolation = "flood";

export interface BridgeHostUi {
  /** Make the frame `height` CSS pixels tall. */
  resize(height: number): void;
  /** Fullscreen the frame element; resolves to whether it is fullscreen now. */
  fullscreen(on: boolean): Promise<boolean>;
  /** Share (or stop sharing) the app pane through pqp's screen share; resolves to whether it is shared now. */
  share(on: boolean): Promise<boolean>;
}

export interface BridgeHostOptions {
  app: AppRuntimeConfig;
  transport: AppSessionTransport;
  users: AppUserDirectory;
  /** BCP 47 tag of the language pqp is showing. */
  locale: () => string;
  theme?: ThemeSource;
  ui?: Partial<BridgeHostUi>;
  /** Defaults to the page's own picker. Tests stand in. */
  pickFile?: (options: PickOptions) => Promise<PickResult>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called with a reason when the app behaves in a way that should end the frame. */
  onViolation?: (reason: BridgeViolation) => void;
  /** Called when the session is over (`app-ended`). */
  onEnded?: (reason: AppEndReason) => void;
  log?: (message: string, detail?: unknown) => void;
}

/** What a request may fail with, in the order the checks run. */
type Failure = { error: BridgeErrorCode };

const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const FLOOD_RATE_PER_SECOND = 100;
const FLOOD_BURST = 200;
const FLOOD_STRIKES_BEFORE_VIOLATION = 500;
// control characters and the bidirectional overrides and isolates
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A name an app may draw: no control or bidi characters, trimmed, at most 64 UTF-16 units, never empty. */
export function cleanDisplayName(name: string | undefined): string {
  const cleaned = (name ?? "").replace(UNSAFE_NAME_CHARS, "").trim();
  let out = "";
  for (const char of cleaned) {
    if (out.length + char.length > APP_DISPLAY_NAME_MAX_CHARS) break;
    out += char;
  }
  return out === "" ? "?" : out;
}

export function mapTransportError(code: AppErrorCode, forEnd = false): BridgeErrorCode {
  switch (code) {
    case "not-allowed":
      return forEnd ? "not-host" : "not-allowed";
    case "ended":
      return "ended";
    case "rate-limited":
      return "rate-limited";
    case "too-large":
      return "too-large";
    case "stale-rev":
      return "stale-rev";
    default:
      // `full` and `unavailable`: nothing an app can act on except trying again
      return "unavailable";
  }
}

/**
 * A roster's avatars add up to at most `APP_PARTICIPANTS_AVATAR_BUDGET_CHARS`
 * characters (the bridge schema refuses a longer list). Past that, the largest
 * avatars are left out (the app draws its own fallback) until the rest fit.
 */
export function fitAvatarBudget(list: BridgeParticipant[]): BridgeParticipant[] {
  let total = list.reduce((sum, person) => sum + (person.avatar?.length ?? 0), 0);
  if (total <= APP_PARTICIPANTS_AVATAR_BUDGET_CHARS) return list;
  const bySize = list
    .map((person, index) => ({ index, size: person.avatar?.length ?? 0 }))
    .filter((entry) => entry.size > 0)
    .sort((a, b) => b.size - a.size || a.index - b.index);
  const dropped = new Set<number>();
  for (const entry of bySize) {
    if (total <= APP_PARTICIPANTS_AVATAR_BUDGET_CHARS) break;
    dropped.add(entry.index);
    total -= entry.size;
  }
  return list.map((person, index) => (dropped.has(index) ? { ...person, avatar: null } : person));
}

function sameParticipants(a: BridgeParticipant[], b: BridgeParticipant[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i]!;
    return (
      p.seatId === q.seatId &&
      p.displayName === q.displayName &&
      p.avatar === q.avatar &&
      p.role === q.role &&
      p.isHost === q.isHost &&
      p.connection === q.connection &&
      p.appUserId === q.appUserId
    );
  });
}

export class BridgeHost {
  private readonly app: AppRuntimeConfig;
  private readonly transport: AppSessionTransport;
  private readonly themeSource: ThemeSource;
  private readonly avatars: AvatarCache;
  private readonly now: () => number;
  private readonly log: (message: string, detail?: unknown) => void;

  private readonly stateCap: { maxBytes: number; writers: "host" | "participants" };
  private readonly eventCap: { maxPerSecond: number; maxBytes: number };
  private readonly eventBucket: TokenBucket;
  private readonly stateBucket: TokenBucket;
  private readonly floodBucket: TokenBucket;
  private floodStrikes = 0;
  private violated = false;

  private port: MessagePort | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeTheme: (() => void) | null = null;
  private snapshot: SessionSnapshot | null = null;
  private state: { rev: number; value: JsonValue } = { rev: 0, value: null };
  private stateKnown = false;
  private roster: BridgeParticipant[] = [];
  private rosterSeq = 0;
  private rosterReady: Promise<void> = Promise.resolve();
  private connection: BridgeConnectionStatus = "online";
  private endedReason: AppEndReason | null = null;
  private theme: BridgeTheme = {};
  private picking = false;
  private detached = false;
  private readonly assetCache = new Map<string, ArrayBuffer>();
  private readonly assetFailed = new Set<string>();

  constructor(private readonly options: BridgeHostOptions) {
    this.app = options.app;
    this.transport = options.transport;
    this.themeSource = options.theme ?? domThemeSource();
    this.avatars = new AvatarCache(options.fetchImpl);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((message, detail) => console.warn(`[apps] ${message}`, detail ?? ""));

    const state = this.app.state;
    this.stateCap = {
      maxBytes: Math.min(state?.maxBytes ?? APP_STATE_MAX_BYTES, APP_STATE_MAX_BYTES),
      writers: state?.writers ?? "participants",
    };
    const events = this.app.events;
    this.eventCap = {
      maxPerSecond: Math.min(events?.maxPerSecond ?? APP_EVENT_MAX_PER_SECOND, APP_EVENT_MAX_PER_SECOND),
      maxBytes: Math.min(events?.maxBytes ?? APP_EVENT_MAX_BYTES, APP_EVENT_MAX_BYTES),
    };
    const writes = Math.min(
      state?.maxWritesPerSecond ?? APP_STATE_MAX_WRITES_PER_SECOND,
      APP_STATE_MAX_WRITES_PER_SECOND,
    );
    this.eventBucket = new TokenBucket(
      this.eventCap.maxPerSecond,
      Math.max(1, this.eventCap.maxPerSecond),
      this.now,
    );
    this.stateBucket = new TokenBucket(writes, Math.max(1, writes), this.now);
    this.floodBucket = new TokenBucket(FLOOD_RATE_PER_SECOND, FLOOD_BURST, this.now);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** Subscribes to the session and takes a seat. Rejects with an `AppTransportError`. */
  async start(join: { asSpectator?: boolean } = {}): Promise<void> {
    this.unsubscribe = this.transport.subscribe({
      onSession: (snapshot) => this.applySnapshot(snapshot),
      onState: (rev, value) => this.applyState(rev, value),
      onEvent: (event) => this.pushToApp({ type: "event", ...event }),
      onConnection: (status) => this.setConnection(status),
      onEnded: (reason) => this.setEnded(reason),
    });
    try {
      this.applySnapshot(await this.transport.join(join));
    } catch (error) {
      this.unsubscribe();
      this.unsubscribe = null;
      throw error;
    }
  }

  /** Whether the session is over. */
  get ended(): AppEndReason | null {
    return this.endedReason;
  }

  /**
   * Takes over the port the frame was handed and sends `hello`. Call it after
   * `start()` resolved: the `hello` carries the seat the session gave.
   */
  attach(port: MessagePort): void {
    if (this.detached || !this.snapshot) return;
    this.port = port;
    port.onmessage = (event) => {
      void this.onPortMessage(event.data);
    };
    this.theme = this.themeSource.read();
    this.unsubscribeTheme = this.themeSource.subscribe(() => this.refreshTheme());

    const hello = bridgeHelloPushSchema.safeParse({
      type: "hello",
      platformApi: APP_PLATFORM_API,
      app: { id: this.app.id, version: this.app.version },
      locale: this.safeLocale(),
      theme: this.theme,
      reducedMotion: this.themeSource.reducedMotion(),
      self: {
        seatId: this.snapshot.seatId,
        role: this.snapshot.role,
        isHost: this.snapshot.isHost,
      },
      connection: this.connection,
    });
    if (!hello.success) {
      this.log("hello did not pass its own schema", hello.error.issues[0]);
      return;
    }
    port.postMessage(hello.data);
  }

  /** Stops listening. The seat is not released: `leave()` does that. */
  detach(): void {
    this.detached = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeTheme?.();
    this.unsubscribeTheme = null;
    if (this.port) {
      this.port.onmessage = null;
      this.port.close();
      this.port = null;
    }
  }

  /** Releases the seat (not held for the resume window). A session that already ended has nothing to leave. */
  leave(): void {
    if (this.snapshot && !this.endedReason) this.transport.leave();
  }

  // ---------------------------------------------------------------------------
  // What the session tells us

  private applySnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    this.applyState(snapshot.state.rev, snapshot.state.value);
    this.rosterReady = this.refreshRoster(snapshot);
  }

  private applyState(rev: number, value: JsonValue): void {
    // a revision never goes backwards, and the same revision is a duplicate (a resume re-sends it)
    if (this.stateKnown && rev <= this.state.rev) return;
    this.stateKnown = true;
    this.state = { rev, value };
    this.pushToApp({ type: "state", rev, value });
  }

  private async refreshRoster(snapshot: SessionSnapshot): Promise<void> {
    const seq = (this.rosterSeq += 1);
    const mapped = await Promise.all(
      snapshot.participants.map(async (participant): Promise<BridgeParticipant | null> => {
        const info = this.options.users.resolve(participant.userId);
        const avatar = await this.avatars.get(info?.avatarUrl ?? null);
        // built from scratch: the pqp user id is read above and goes no further
        const entry = bridgeParticipantSchema.safeParse({
          seatId: participant.seatId,
          displayName: cleanDisplayName(info?.displayName),
          avatar,
          role: participant.role,
          isHost: participant.isHost,
          connection: participant.connection,
          ...(participant.appUserId ? { appUserId: participant.appUserId } : {}),
        });
        return entry.success ? entry.data : null;
      }),
    );
    if (seq !== this.rosterSeq || this.detached) return; // a newer snapshot superseded this one
    const next = fitAvatarBudget(mapped.filter((entry): entry is BridgeParticipant => entry !== null));
    if (sameParticipants(this.roster, next)) return;
    this.roster = next;
    this.pushToApp({ type: "participants", participants: next });
  }

  private setConnection(status: BridgeConnectionStatus): void {
    if (this.connection === status) return;
    this.connection = status;
    this.pushToApp({ type: "connection", status });
  }

  private setEnded(reason: AppEndReason): void {
    if (this.endedReason) return;
    this.endedReason = reason;
    this.pushToApp({ type: "session.ended", reason });
    this.options.onEnded?.(reason);
  }

  private refreshTheme(): void {
    const next = this.themeSource.read();
    if (sameTheme(this.theme, next)) return;
    this.theme = next;
    this.pushToApp({ type: "theme", theme: next });
  }

  private safeLocale(): string {
    const locale = this.options.locale();
    return LOCALE_PATTERN.test(locale) ? locale : "en";
  }

  // ---------------------------------------------------------------------------
  // Sending to the app

  private pushToApp(push: Record<string, unknown>): void {
    if (!this.port) return;
    const parsed = bridgePushSchema.safeParse(push);
    if (!parsed.success) {
      this.log(`dropped a ${String(push.type)} push that failed its schema`, parsed.error.issues[0]);
      return;
    }
    this.port.postMessage(parsed.data);
  }

  private fail(id: string, error: BridgeErrorCode): void {
    this.port?.postMessage({ id, ok: false, error });
  }

  private succeed<T extends BridgeRequestType>(
    id: string,
    type: T,
    result: unknown,
    transfer: Transferable[] = [],
  ): void {
    // the whole response goes through its schema: a successful one echoes the request type
    const parsed = bridgeResponseOkSchema.safeParse({ id, ok: true, type, result });
    if (!parsed.success) {
      this.log(`the ${type} answer failed its schema`, parsed.error.issues[0]);
      this.fail(id, "unavailable");
      return;
    }
    this.port?.postMessage(parsed.data, transfer);
  }

  // ---------------------------------------------------------------------------
  // Receiving from the app

  /** The id of a message that failed its schema, if it carries one a reply can use. */
  private static idOf(raw: unknown): string | null {
    if (typeof raw !== "object" || raw === null) return null;
    const id = (raw as { id?: unknown }).id;
    const parsed = bridgeRequestIdSchema.safeParse(id);
    return parsed.success ? parsed.data : null;
  }

  private async onPortMessage(raw: unknown): Promise<void> {
    if (this.detached) return;
    if (!this.floodBucket.take()) {
      this.floodStrikes += 1;
      const id = BridgeHost.idOf(raw);
      if (id) this.fail(id, "rate-limited");
      if (this.floodStrikes >= FLOOD_STRIKES_BEFORE_VIOLATION && !this.violated) {
        this.violated = true;
        this.options.onViolation?.("flood");
      }
      return;
    }
    const parsed = bridgeAppMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const id = BridgeHost.idOf(raw);
      if (id) this.fail(id, "invalid");
      return;
    }
    const message = parsed.data;
    try {
      await this.handle(message);
    } catch (error) {
      this.log(`handling ${message.type} threw`, error);
      this.fail(message.id, "unavailable");
    }
  }

  private async handle(message: BridgeAppMessage): Promise<void> {
    const { id } = message;
    if (this.endedReason) return this.fail(id, "ended");
    const snapshot = this.snapshot;
    if (!snapshot) return this.fail(id, "unavailable");

    switch (message.type) {
      case "participants.get": {
        await this.rosterReady;
        return this.succeed(id, message.type, { participants: this.roster });
      }
      case "state.get":
        return this.succeed(id, message.type, this.state);

      case "state.patch": {
        const refusal = this.checkStateWrite(message.patch);
        if (refusal) return this.fail(id, refusal.error);
        try {
          const { rev } = await this.transport.patchState(message.patch, message.baseRev);
          return this.succeed(id, message.type, { rev });
        } catch (error) {
          return this.fail(id, this.transportFailure(error));
        }
      }

      case "events.send": {
        const refusal = this.checkEventSend(message.data);
        if (refusal) return this.fail(id, refusal.error);
        this.transport.sendEvent(message.name, message.data);
        return this.succeed(id, message.type, null);
      }

      case "assets.get":
        return this.getAsset(id, message.name);

      case "files.pickLocal":
        return this.pickLocal(id);

      case "ui.resize": {
        this.options.ui?.resize?.(message.height);
        return this.succeed(id, message.type, { height: message.height });
      }

      case "ui.fullscreen": {
        const fullscreen = this.options.ui?.fullscreen;
        if (!fullscreen) return this.fail(id, "not-allowed");
        try {
          return this.succeed(id, message.type, { on: await fullscreen(message.on) });
        } catch {
          return this.fail(id, "not-allowed");
        }
      }

      case "share.request": {
        const caps = this.app.capabilities;
        if (caps.share !== "pane" || this.app.shareAllowed !== true) return this.fail(id, "not-allowed");
        const share = this.options.ui?.share;
        if (!share) return this.fail(id, "unavailable");
        if (this.connection !== "online") return this.fail(id, "unavailable");
        try {
          return this.succeed(id, message.type, { on: await share(message.on) });
        } catch {
          return this.fail(id, "unavailable");
        }
      }

      case "session.end": {
        if (!snapshot.isHost) return this.fail(id, "not-host");
        try {
          await this.transport.end();
          return this.succeed(id, message.type, null);
        } catch (error) {
          return this.fail(id, this.transportFailure(error, true));
        }
      }
    }
  }

  private transportFailure(error: unknown, forEnd = false): BridgeErrorCode {
    if (error instanceof AppTransportError) return mapTransportError(error.code, forEnd);
    return "unavailable";
  }

  private checkStateWrite(patch: JsonValue): Failure | null {
    if (this.connection !== "online") return { error: "unavailable" };
    if (this.stateCap.writers === "host" && !this.snapshot?.isHost) return { error: "not-host" };
    if (!this.stateBucket.take()) return { error: "rate-limited" };
    if (stateBytesAfter(this.state.value, patch) > this.stateCap.maxBytes) return { error: "too-large" };
    return null;
  }

  private checkEventSend(data: JsonValue): Failure | null {
    if (this.connection !== "online") return { error: "unavailable" };
    if (this.eventCap.maxPerSecond === 0 || this.eventCap.maxBytes === 0) return { error: "not-allowed" };
    if (jsonByteLength(data) > this.eventCap.maxBytes) return { error: "too-large" };
    if (!this.eventBucket.take()) return { error: "rate-limited" };
    return null;
  }

  private async getAsset(id: string, name: string): Promise<void> {
    const asset: AssetRef | undefined = this.app.assets?.find((candidate) => candidate.name === name);
    if (!asset) return this.fail(id, "invalid");
    let bytes = this.assetCache.get(name);
    if (!bytes) {
      const result = await fetchAsset(asset, this.options.fetchImpl);
      if (!result.ok) {
        if (!this.assetFailed.has(name)) {
          this.assetFailed.add(name);
          this.log(`asset ${name} of ${this.app.id}@${this.app.version} refused: ${result.reason}`);
        }
        return this.fail(id, "unavailable");
      }
      bytes = result.bytes;
      this.assetCache.set(name, bytes);
    }
    // a copy per transfer: a transferred buffer is detached on this side
    const copy = bytes.slice(0);
    this.succeed(id, "assets.get", { name, bytes: copy }, [copy]);
  }

  private async pickLocal(id: string): Promise<void> {
    const files = this.app.capabilities.localFiles;
    if (!files.allowed || !files.accept || files.maxBytes === undefined) return this.fail(id, "not-allowed");
    if (this.picking) return this.fail(id, "rate-limited");
    this.picking = true;
    try {
      const pick = this.options.pickFile ?? pickLocalFile;
      const result = await pick({
        accept: files.accept,
        maxBytes: files.maxBytes,
        aborted: () => this.detached || this.endedReason !== null,
      });
      switch (result.kind) {
        case "cancelled":
          return this.fail(id, "cancelled");
        case "too-large":
          return this.fail(id, "too-large");
        case "wrong-type":
          return this.fail(id, "not-allowed");
        case "picked":
          return this.succeed(id, "files.pickLocal", { bytes: result.bytes, ext: result.ext }, [result.bytes]);
      }
    } finally {
      this.picking = false;
    }
  }
}
