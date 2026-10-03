import { isEnabled } from "../lib/flags.js";
import { logEvent } from "../lib/log.js";

/**
 * The API's control-plane calls to each SFU box (`listRooms`,
 * `listParticipants` and the writes that follow a listing), measured, bounded
 * and fenced per region.
 *
 * WHY THIS EXISTS. With `LIVEKIT_REGIONS` set, moderation used to ask EVERY box
 * for every room and wait for the slowest. Production, 2026-09-24..10-03:
 * 872 `voice.sfuRegionCallFailed` lines, all timeouts but one, against the two
 * non-home boxes (468 London, 403 Miami, 1 home), and none of them load (the
 * API ran at ~2.5% CPU, the boxes held 14 of 754 rooms). Nearly every one of
 * those calls was for a room that lives in Sao Paulo: a re-sweep runs every
 * ~5 s for 15 minutes after each eviction (`RESWEEP_CLAIM_MS`), and each pass
 * asked London and Miami as well. The failures were independent per call (in
 * about half the sweeps only one of the two remote regions failed), clustered
 * in a handful of windows (764 of 872 on one afternoon) and never touched the
 * home box, which is the shape of a long-haul path with a heavy tail, not of a dead box. The
 * defect was that a heavy tail on a path a room never needed was allowed to
 * decide how long moderation took.
 *
 * WHAT IT DOES, per region and per process:
 *
 * 1. MEASURES every call (count, failures by class, a window of successful
 *    durations for p50/p95/p99), so the next incident has numbers.
 * 2. BOUNDS speculative reads. When a room's region is unknown and a remote
 *    box is asked "just in case" by a re-sweep, it gets a budget of a few
 *    times its own measured p99 (never more than the SDK's 5 s), not the SDK's
 *    full window. A call nothing will repeat (a moderator's mute, the first
 *    pass of an eviction) is `oneshot` and keeps the full window.
 * 3. FENCES a sick region with a small circuit: after
 *    `CIRCUIT_FAILURES` consecutive failures a SPECULATIVE read of it is
 *    skipped for `CIRCUIT_COOLDOWN_MS`, then one probe is let through. A call
 *    for a room KNOWN to live there is never skipped: that box is the only
 *    place the participant can be, so refusing to ask it would turn a slow ban
 *    into no ban. Writes, one-shots and the home box are never skipped
 *    either.
 * 4. SAYS WHY. `voice.sfuRegionCallFailed` carries the call, the caller, the
 *    duration against the budget, the error class and the idle time since the
 *    region's last call (a cold connection is visible as a large `idleMs`),
 *    rate limited per region so a bad minute is one line per ten seconds with
 *    a count of what it swallowed. The counters are not rate limited.
 *
 * PER PROCESS, ON PURPOSE. The thing measured is THIS process's path to a box.
 * The other API instance has its own connections and may see a healthy route;
 * the circuit never writes shared state and only ever hides a region from the
 * process that observed it failing, for thirty seconds. Skipping is safe
 * because every sweep is repeated every few seconds and rows are claimed by
 * whichever instance ticks, so coverage of a skipped region falls to the next
 * pass or to the sibling.
 *
 * Runtime flag `sfu_region_scoped_calls` turns the routing, the budget and
 * the circuit off together (the pre-fix behaviour); measurement and logging
 * stay on either way.
 */

/** The SDK's own per-call bound (`REQUEST_TIMEOUT_SECONDS` in admin.ts). */
export const SFU_CALL_TIMEOUT_MS = 5_000;

/** Consecutive failures that open a region's circuit. */
export const CIRCUIT_FAILURES = 3;
/** How long a speculative call skips an open region before one probe goes out. */
export const CIRCUIT_COOLDOWN_MS = 30_000;

/**
 * A speculative call's budget is `BUDGET_P99_MULTIPLE` times the region's
 * measured p99 once `BUDGET_MIN_SAMPLES` successes are in the window, clamped
 * to [`BUDGET_FLOOR_MS`, the SDK timeout]. Before that it is
 * `BUDGET_PRIOR_MS`, a prior and no more: a cold request to the farthest
 * box (Sao Paulo to London is ~190 ms RTT) is a DNS answer plus TCP plus TLS
 * 1.3 plus the request, about four round trips, so ~0.8 s; 3 s is four times
 * that. The window replaces it as soon as it has evidence.
 */
export const BUDGET_P99_MULTIPLE = 4;
export const BUDGET_MIN_SAMPLES = 30;
export const BUDGET_FLOOR_MS = 1_500;
export const BUDGET_PRIOR_MS = 3_000;

/** Successful durations kept per region. */
const WINDOW = 200;

/** One `voice.sfuRegionCallFailed` line per region per this long. */
const LOG_INTERVAL_MS = 10_000;

export type RegionCallMode =
  /** The room is known to live on this region (pin, hint), or it is the single box. */
  | "pinned"
  /**
   * The room's region is unknown, so this box is asked in case, by a caller
   * that asks again within seconds (a re-sweep). The only mode that is
   * budgeted and skippable by the circuit.
   */
  | "speculative"
  /**
   * The room's region is unknown and nothing will ask again: a moderator's
   * mute or grant, the first pass of an eviction. Every box is asked, with the
   * SDK's full timeout and never skipped, because a skip here would be a
   * change that is simply not applied.
   */
  | "oneshot";

export type SfuErrorClass =
  | "timeout"
  | "budget"
  | "circuit-open"
  | "dns"
  | "connect-timeout"
  | "refused"
  | "reset"
  | "http-4xx"
  | "http-5xx"
  | "not-found"
  | "other";

interface RegionHealth {
  calls: number;
  ok: number;
  failures: number;
  notFound: number;
  skippedByCircuit: number;
  byClass: Partial<Record<SfuErrorClass, number>>;
  window: number[];
  windowIndex: number;
  consecutiveFailures: number;
  openUntil: number;
  probing: boolean;
  lastCallEndedAt: number;
  lastOkAt: number;
  lastFailureClass: SfuErrorClass | null;
  logAt: number;
  suppressed: number;
}

const regions = new Map<string, RegionHealth>();
const partialLog = new Map<string, { at: number; suppressed: number }>();

function health(region: string): RegionHealth {
  let entry = regions.get(region);
  if (!entry) {
    entry = {
      calls: 0,
      ok: 0,
      failures: 0,
      notFound: 0,
      skippedByCircuit: 0,
      byClass: {},
      window: [],
      windowIndex: 0,
      consecutiveFailures: 0,
      openUntil: 0,
      probing: false,
      lastCallEndedAt: 0,
      lastOkAt: 0,
      lastFailureClass: null,
      logAt: 0,
      suppressed: 0,
    };
    regions.set(region, entry);
  }
  return entry;
}

/** The pre-fix behaviour on one switch: no routing, no budget, no circuit. */
export function regionScopingEnabled(): boolean {
  return isEnabled("sfu_region_scoped_calls");
}

/**
 * LiveKit's answer for a room this box does not hold. The box answered, so
 * for health purposes this is a success.
 */
export function isNotFound(error: unknown): boolean {
  const shaped = error as { status?: unknown; code?: unknown } | null;
  return shaped?.status === 404 || shaped?.code === "not_found";
}

/** What kind of failure this was, from the error `fetch` and the SDK throw. */
export function classifyError(error: unknown): SfuErrorClass {
  if (error instanceof BudgetExceeded) {
    return "budget";
  }
  if (error instanceof CircuitOpen) {
    return "circuit-open";
  }
  if (isNotFound(error)) {
    return "not-found";
  }
  const shaped = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    cause?: { code?: unknown } | null;
    code?: unknown;
  } | null;
  const code = String(shaped?.cause?.code ?? shaped?.code ?? "");
  const message = String(shaped?.message ?? "");
  if (shaped?.name === "TimeoutError" || /aborted due to timeout/i.test(message)) {
    return "timeout";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "dns";
  }
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return "connect-timeout";
  }
  if (code === "ECONNREFUSED") {
    return "refused";
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE") {
    return "reset";
  }
  if (typeof shaped?.status === "number") {
    return shaped.status >= 500 ? "http-5xx" : "http-4xx";
  }
  return "other";
}

export class BudgetExceeded extends Error {
  constructor(
    readonly region: string,
    readonly budgetMs: number,
  ) {
    super(`region ${region} did not answer within its ${budgetMs} ms budget`);
    this.name = "BudgetExceeded";
  }
}

export class CircuitOpen extends Error {
  constructor(readonly region: string) {
    super(`region ${region} skipped: circuit open after repeated failures`);
    this.name = "CircuitOpen";
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** The budget a speculative call to `region` gets right now. */
export function budgetMsFor(region: string): number {
  const entry = health(region);
  if (entry.window.length < BUDGET_MIN_SAMPLES) {
    return BUDGET_PRIOR_MS;
  }
  const sorted = [...entry.window].sort((a, b) => a - b);
  const measured = Math.ceil(percentile(sorted, 0.99) * BUDGET_P99_MULTIPLE);
  return Math.min(SFU_CALL_TIMEOUT_MS, Math.max(BUDGET_FLOOR_MS, measured));
}

export interface RegionCall<T> {
  region: string;
  /** Home is never skipped and never budgeted: it is where nearly every room is. */
  home: boolean;
  call: string;
  caller: string;
  room?: string;
  mode: RegionCallMode;
  run: () => Promise<T>;
}

/**
 * Run one control-plane call against one region, with the bookkeeping above.
 * Rejects with the original error (or `BudgetExceeded` / `CircuitOpen`), so
 * callers keep their own not-found and failure handling.
 */
export async function runRegionCall<T>(request: RegionCall<T>): Promise<T> {
  const entry = health(request.region);
  const scoped = regionScopingEnabled();
  // Only READS are fenced. A write (remove, mute, update) follows a listing
  // that just proved this box holds the participant, so refusing it because
  // some other call tripped the circuit would turn a slow ban into no ban.
  const fenced =
    scoped && request.mode === "speculative" && !request.home && isRead(request.call);
  const now = Date.now();

  if (fenced && now < entry.openUntil) {
    entry.skippedByCircuit += 1;
    throw new CircuitOpen(request.region);
  }
  let isProbe = false;
  if (fenced && entry.openUntil > 0 && now >= entry.openUntil) {
    // Half open: exactly one probe goes out, everyone else keeps skipping.
    if (entry.probing) {
      entry.skippedByCircuit += 1;
      throw new CircuitOpen(request.region);
    }
    entry.probing = true;
    isProbe = true;
  }

  const budgetMs = fenced ? budgetMsFor(request.region) : null;
  const idleMs = entry.lastCallEndedAt === 0 ? null : now - entry.lastCallEndedAt;
  entry.calls += 1;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = request.run();
    const result =
      budgetMs === null
        ? await work
        : await Promise.race([
            work,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new BudgetExceeded(request.region, budgetMs)),
                budgetMs,
              );
              timer.unref?.();
            }),
          ]);
    // The race may leave `work` running to the SDK's own timeout; a late
    // rejection must not become an unhandled one.
    void work.catch(() => undefined);
    recordSuccess(request.region, Date.now() - startedAt, false);
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (isNotFound(error)) {
      recordSuccess(request.region, durationMs, true);
    } else {
      recordFailure(request, error, durationMs, budgetMs, idleMs);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (isProbe) {
      entry.probing = false;
    }
    entry.lastCallEndedAt = Date.now();
  }
}

function isRead(call: string): boolean {
  return call === "listRooms" || call === "listParticipants";
}

function recordSuccess(region: string, durationMs: number, notFound: boolean): void {
  const entry = health(region);
  if (notFound) {
    entry.notFound += 1;
  } else {
    entry.ok += 1;
  }
  // A not-found is a box that answered, so it counts toward health and
  // latency like any other answer.
  if (entry.window.length < WINDOW) {
    entry.window.push(durationMs);
  } else {
    entry.window[entry.windowIndex] = durationMs;
    entry.windowIndex = (entry.windowIndex + 1) % WINDOW;
  }
  entry.lastOkAt = Date.now();
  const wasOpen = entry.openUntil > 0;
  entry.consecutiveFailures = 0;
  entry.openUntil = 0;
  if (wasOpen) {
    logEvent("voice.sfuRegionCircuit", { region, state: "closed" });
  }
}

function recordFailure<T>(
  request: RegionCall<T>,
  error: unknown,
  durationMs: number,
  budgetMs: number | null,
  idleMs: number | null,
): void {
  const entry = health(request.region);
  const errorClass = classifyError(error);
  entry.failures += 1;
  entry.byClass[errorClass] = (entry.byClass[errorClass] ?? 0) + 1;
  entry.lastFailureClass = errorClass;
  entry.consecutiveFailures += 1;

  const fenced = regionScopingEnabled() && !request.home;
  if (fenced && entry.consecutiveFailures >= CIRCUIT_FAILURES) {
    const wasClosed = entry.openUntil === 0;
    entry.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    if (wasClosed) {
      logEvent("voice.sfuRegionCircuit", {
        region: request.region,
        state: "open",
        consecutiveFailures: entry.consecutiveFailures,
        cooldownMs: CIRCUIT_COOLDOWN_MS,
        lastClass: errorClass,
      });
    }
  }

  const now = Date.now();
  if (now - entry.logAt < LOG_INTERVAL_MS && entry.logAt !== 0) {
    entry.suppressed += 1;
    return;
  }
  logEvent("voice.sfuRegionCallFailed", {
    region: request.region,
    stage: request.call,
    caller: request.caller,
    room: request.room,
    mode: request.mode,
    errorClass,
    error: error instanceof Error ? error.message : String(error),
    durationMs,
    budgetMs: budgetMs ?? undefined,
    idleMs: idleMs ?? undefined,
    consecutiveFailures: entry.consecutiveFailures,
    suppressed: entry.suppressed > 0 ? entry.suppressed : undefined,
  });
  entry.logAt = now;
  entry.suppressed = 0;
}

/**
 * Note a region that was left out of a call on purpose (the circuit): a
 * result built from fewer regions than were configured says so, once, so a
 * sweep that quietly covered two boxes out of three is never mistaken for one
 * that covered all of them.
 */
export function logPartialCoverage(fields: {
  caller: string;
  call: string;
  room?: string;
  answered: readonly string[];
  skipped: readonly string[];
  failed: readonly string[];
}): void {
  if (fields.skipped.length === 0 && fields.failed.length === 0) {
    return;
  }
  const key = `${fields.caller}:${fields.call}`;
  const entry = partialLog.get(key) ?? { at: 0, suppressed: 0 };
  partialLog.set(key, entry);
  const now = Date.now();
  if (entry.at !== 0 && now - entry.at < LOG_INTERVAL_MS) {
    entry.suppressed += 1;
    return;
  }
  logEvent("voice.sfuRegionPartial", {
    caller: fields.caller,
    call: fields.call,
    room: fields.room,
    answered: fields.answered.join(","),
    skipped: fields.skipped.join(",") || undefined,
    failed: fields.failed.join(",") || undefined,
    suppressed: entry.suppressed > 0 ? entry.suppressed : undefined,
  });
  entry.at = now;
  entry.suppressed = 0;
}

export interface SfuRegionCallStats {
  /** Calls started against this region from this process since boot. */
  calls: number;
  /** Calls that failed (timeouts, transport, 5xx). A not-found is an answer, not a failure. */
  failures: number;
  /** Speculative calls that were not made because the circuit was open. */
  skippedByCircuit: number;
  failuresByClass: Partial<Record<SfuErrorClass, number>>;
  circuitOpen: boolean;
  consecutiveFailures: number;
  /** Over the last <=200 answers. Null with none yet. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** What a speculative read to this region is allowed to take right now. */
  budgetMs: number;
  lastFailureClass: SfuErrorClass | null;
  /** Milliseconds since the last answer, or null if there has been none. */
  sinceLastOkMs: number | null;
}

/** This process's control-plane health per region, for `GET /api/admin/metrics`. */
export function sfuControlPlaneReport(
  configured: readonly string[],
): Record<string, SfuRegionCallStats> {
  const now = Date.now();
  const report: Record<string, SfuRegionCallStats> = {};
  for (const id of configured) {
    const entry = health(id);
    const sorted = [...entry.window].sort((a, b) => a - b);
    report[id] = {
      calls: entry.calls,
      failures: entry.failures,
      skippedByCircuit: entry.skippedByCircuit,
      failuresByClass: { ...entry.byClass },
      circuitOpen: entry.openUntil > now,
      consecutiveFailures: entry.consecutiveFailures,
      p50Ms: sorted.length ? percentile(sorted, 0.5) : null,
      p95Ms: sorted.length ? percentile(sorted, 0.95) : null,
      p99Ms: sorted.length ? percentile(sorted, 0.99) : null,
      budgetMs: budgetMsFor(id),
      lastFailureClass: entry.lastFailureClass,
      sinceLastOkMs: entry.lastOkAt === 0 ? null : now - entry.lastOkAt,
    };
  }
  return report;
}

/** Test hook. */
export function resetSfuControlPlane(): void {
  regions.clear();
  partialLog.clear();
}
