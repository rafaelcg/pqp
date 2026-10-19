import { APP_STATE_MAX_BYTES, type AppManifest, type AppRole, type JsonValue } from "@pqp/shared";
import { getPool } from "../db.js";

/**
 * A SESSION'S SHARED STATE: a small revisioned JSON document in the session row
 * (`app_sessions.state`, `state_rev`), changed by JSON Merge Patch (RFC 7396).
 *
 * The row is the truth and every write is a read-modify-write under the row's
 * lock, so two machines patching at once serialize in Postgres and the
 * revision is a single increasing number. Nothing about the document is held in
 * memory between writes.
 *
 * THE CAP counts the compact `JSON.stringify` bytes of the PARSED merged value,
 * never the text a client sent (the DB's own 1 MiB CHECK is only a backstop:
 * jsonb prints numbers in full, `1e-300` is 300 digits). The limit is the
 * manifest's `state.maxBytes`, itself at most 16 KB.
 *
 * COALESCING. A session takes at most `state.maxWritesPerSecond` writes a second
 * from one instance. A patch that arrives inside the window waits, with the
 * others that arrive while it waits, and the whole batch is applied one after
 * the other in ONE write and one revision bump: the last value wins because the
 * patches are applied in arrival order, which is exact (merge patches do not
 * compose into one patch without changing what they mean). A patch with a
 * `baseRev` is a compare-and-set and cannot ride in a batch: it is written alone
 * and at once, or refused as `rate-limited` when the window is not open.
 */

// ------------------------------------------------------------------ the merge

function isPlainObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own data properties only: a key named `__proto__` is data here, never a setter. */
function setOwn(target: { [key: string]: JsonValue }, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * RFC 7396 `MergePatch`: a patch that is not an object replaces the target; an
 * object patch merges into the target (an object, or `{}` when it is not one),
 * with `null` deleting a key. Pure: neither argument is changed.
 */
export function applyMergePatch(target: JsonValue, patch: JsonValue): JsonValue {
  if (!isPlainObject(patch)) {
    return patch;
  }
  const result: { [key: string]: JsonValue } = {};
  if (isPlainObject(target)) {
    for (const key of Object.keys(target)) {
      setOwn(result, key, target[key]!);
    }
  }
  for (const key of Object.keys(patch)) {
    const value = patch[key]!;
    if (value === null) {
      delete result[key];
    } else {
      setOwn(
        result,
        key,
        applyMergePatch(Object.prototype.hasOwnProperty.call(result, key) ? result[key]! : null, value),
      );
    }
  }
  return result;
}

/** Postgres jsonb cannot hold U+0000 in a string or a key: refuse it before the write. */
export function containsNul(value: JsonValue): boolean {
  if (typeof value === "string") {
    return value.includes("\u0000");
  }
  if (Array.isArray(value)) {
    return value.some(containsNul);
  }
  if (isPlainObject(value)) {
    return Object.keys(value).some((key) => key.includes("\u0000") || containsNul(value[key]!));
  }
  return false;
}

/** The compact serialized size the cap is measured in. */
export function compactBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** The cap for one manifest. */
export function stateCap(manifest: Pick<AppManifest, "state">): number {
  return Math.min(manifest.state.maxBytes, APP_STATE_MAX_BYTES);
}

// ------------------------------------------------------------------ the writer

export type StateErrorCode = "not-allowed" | "ended" | "rate-limited" | "too-large" | "stale-rev" | "unavailable";

export interface StatePatchItem {
  userId: string;
  role: AppRole;
  baseRev: number | undefined;
  patch: JsonValue;
  /** Who to tell when this patch is refused. */
  socket: unknown;
}

export interface StateWriterDeps {
  manifest: Pick<AppManifest, "state">;
  sessionId: string;
  now: () => number;
  schedule: (run: () => void, delayMs: number) => unknown;
  cancel: (handle: unknown) => void;
  /** A write committed: the new revision and the whole value. */
  committed: (sessionId: string, rev: number, value: JsonValue) => void;
  /** A patch was refused. */
  refused: (item: StatePatchItem, code: StateErrorCode) => void;
  /** Counters. */
  onWrite?: () => void;
  onCoalesced?: (patches: number) => void;
}

/** Patches waiting for a window, at most. More are refused as `rate-limited`. */
export const MAX_PENDING_PATCHES = 100;

export interface StateWriter {
  submit(item: StatePatchItem): void;
  /** Resolves once the write in flight (if any) is done. Tests and shutdown. */
  idle(): Promise<void>;
  /** The session is over: drop what waits and stop the timer. */
  dispose(): void;
  readonly lastWriteAt: number;
}

export function createStateWriter(deps: StateWriterDeps): StateWriter {
  const intervalMs = Math.ceil(1000 / deps.manifest.state.maxWritesPerSecond);
  const cap = stateCap(deps.manifest);
  const writersMode = deps.manifest.state.writers;
  let pending: StatePatchItem[] = [];
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;
  let lastWrite = Number.NEGATIVE_INFINITY;

  function allowed(item: StatePatchItem, hostUserId: string | null): boolean {
    if (cap === 0) {
      return false;
    }
    if (writersMode === "host") {
      return hostUserId !== null && item.userId === hostUserId;
    }
    return item.role === "player" || item.userId === hostUserId;
  }

  async function write(items: StatePatchItem[]): Promise<void> {
    lastWrite = deps.now();
    const refusals: Array<[StatePatchItem, StateErrorCode]> = [];
    let committed: { rev: number; value: JsonValue } | null = null;
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const row = await client.query<{
        state: JsonValue;
        state_rev: string;
        status: string;
        host_user_id: string | null;
      }>(
        `SELECT state, state_rev, status, host_user_id FROM app_sessions
          WHERE id = $1 FOR UPDATE`,
        [deps.sessionId],
      );
      const session = row.rows[0];
      if (!session || session.status !== "live") {
        await client.query("ROLLBACK");
        for (const item of items) {
          refusals.push([item, "ended"]);
        }
      } else {
        let value = session.state;
        let changed = false;
        const rev = Number(session.state_rev);
        for (const item of items) {
          if (!allowed(item, session.host_user_id)) {
            refusals.push([item, "not-allowed"]);
            continue;
          }
          if (item.baseRev !== undefined && item.baseRev !== rev) {
            refusals.push([item, "stale-rev"]);
            continue;
          }
          const next = applyMergePatch(value, item.patch);
          if (containsNul(next)) {
            refusals.push([item, "not-allowed"]);
            continue;
          }
          if (compactBytes(next) > cap) {
            refusals.push([item, "too-large"]);
            continue;
          }
          if (JSON.stringify(next) !== JSON.stringify(value)) {
            value = next;
            changed = true;
          }
        }
        if (changed) {
          const updated = await client.query<{ state_rev: string }>(
            `UPDATE app_sessions SET state = $2::jsonb, state_rev = state_rev + 1
              WHERE id = $1 RETURNING state_rev`,
            [deps.sessionId, JSON.stringify(value)],
          );
          committed = { rev: Number(updated.rows[0]!.state_rev), value };
        }
        await client.query("COMMIT");
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      for (const item of items) {
        deps.refused(item, "unavailable");
      }
      throw error;
    } finally {
      client.release();
    }
    if (committed) {
      deps.onWrite?.();
      if (items.length > 1) {
        deps.onCoalesced?.(items.length - 1);
      }
      deps.committed(deps.sessionId, committed.rev, committed.value);
    }
    for (const [item, code] of refusals) {
      deps.refused(item, code);
    }
  }

  function run(items: StatePatchItem[]): void {
    const previous = inFlight ?? Promise.resolve();
    const next = previous
      .then(() => write(items))
      .catch(() => {
        // Already told every sender `unavailable`; the next window starts clean.
      })
      .finally(() => {
        if (inFlight === next) {
          inFlight = null;
        }
        if (pending.length > 0 && timer === null) {
          arm();
        }
      });
    inFlight = next;
  }

  function arm(): void {
    const delay = Math.max(0, lastWrite + intervalMs - deps.now());
    timer = deps.schedule(() => {
      timer = null;
      const batch = pending;
      pending = [];
      if (batch.length > 0) {
        run(batch);
      }
    }, delay);
  }

  return {
    submit(item) {
      if (item.baseRev !== undefined) {
        // A compare-and-set is written alone and now, or not at all.
        if (pending.length > 0 || inFlight || deps.now() - lastWrite < intervalMs) {
          deps.refused(item, "rate-limited");
          return;
        }
        run([item]);
        return;
      }
      if (pending.length >= MAX_PENDING_PATCHES) {
        deps.refused(item, "rate-limited");
        return;
      }
      pending.push(item);
      if (timer === null && !inFlight) {
        arm();
      }
    },
    async idle() {
      while (inFlight) {
        await inFlight;
      }
    },
    dispose() {
      if (timer !== null) {
        deps.cancel(timer);
        timer = null;
      }
      pending = [];
    },
    get lastWriteAt() {
      return lastWrite;
    },
  };
}

