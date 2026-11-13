import { estimateSfuLoadMbps, roomsOnBox, type PriceOptions, type SfuRoomLoad } from "./promotion.js";

/**
 * WHAT THE VIDEO ADMISSION ESTIMATOR BELIEVES, AS A GAUGE.
 *
 * WHY THIS EXISTS. On 2026-10-20 the API refused 56 cameras and screens
 * between 23:00Z and 01:00Z with `loadMbps` 524 to 605 against a 600 budget,
 * while the SFU box itself sat at 1.27 cores (32 percent) and 246 Mbit/s of
 * traffic. The SFU was not full; the estimate was. Nothing recorded that
 * belief anywhere but a log line, so the incident could only be seen by
 * reading logs after the fact (capacity review 2026-10-22, section G, item 4).
 *
 * This is the estimator's view of the room set, per SFU box: the total it
 * prices (`loadMbps`, the same `estimateSfuLoadMbps` the admission and
 * promotion guards call, with the same price flags), the budget it is held to,
 * and how many times it said no recently. Grafana divides `loadMbps` by the
 * measured transmit rate of the same box (`node_network_transmit_bytes_total`
 * on that host); a ratio that climbs while the box's CPU stays low is an
 * estimate that has drifted from the hardware, which is what to recalibrate
 * (`sfu_video_price_calibrated`, `VOICE_PROMOTION_MAX_SFU_MBPS`).
 *
 * PURE, ADDITIVE, READ-ONLY. Nothing here is consulted by an admission
 * decision; the guards price rooms exactly as before and merely tell this
 * module how they answered. The module owns no timers and no I/O: the caller
 * hands it the rooms.
 */

/** A bucket per minute, kept long enough for the 5 minute window. */
const BUCKET_MS = 60_000;
const WINDOW_BUCKETS = 5;

interface Bucket {
  minute: number;
  checks: number;
  refusals: number;
}

interface BoxLedger {
  buckets: Bucket[];
  checksTotal: number;
  refusalsTotal: number;
}

export interface AdmissionCounts {
  checks5m: number;
  refusals5m: number;
  /** Cumulative since this process booted. Resets on deploy, like every counter here. */
  checksTotal: number;
  refusalsTotal: number;
}

/**
 * How often the budget was asked, and how often it refused, per box.
 *
 * "Asked" is a decision against the budget: a camera or share on a room
 * already on the SFU, and a mesh room's promotion. A promotion that fails for
 * another reason (LiveKit unconfigured, SFU unreachable) is not a budget
 * decision and is not counted. Process-local, so the exporter sums replicas.
 */
export class AdmissionLedger {
  private boxes = new Map<string, BoxLedger>();

  note(box: string, refused: boolean, now = Date.now()): void {
    let ledger = this.boxes.get(box);
    if (!ledger) {
      ledger = { buckets: [], checksTotal: 0, refusalsTotal: 0 };
      this.boxes.set(box, ledger);
    }
    const minute = Math.floor(now / BUCKET_MS);
    let bucket = ledger.buckets[ledger.buckets.length - 1];
    if (!bucket || bucket.minute !== minute) {
      bucket = { minute, checks: 0, refusals: 0 };
      ledger.buckets.push(bucket);
      // Bounded: never more than the window plus the one being filled.
      while (ledger.buckets.length > WINDOW_BUCKETS + 1) {
        ledger.buckets.shift();
      }
    }
    bucket.checks += 1;
    ledger.checksTotal += 1;
    if (refused) {
      bucket.refusals += 1;
      ledger.refusalsTotal += 1;
    }
  }

  /** Counts per box seen so far, the window ending at `now`. */
  counts(now = Date.now()): Map<string, AdmissionCounts> {
    const minute = Math.floor(now / BUCKET_MS);
    const out = new Map<string, AdmissionCounts>();
    for (const [box, ledger] of this.boxes) {
      let checks5m = 0;
      let refusals5m = 0;
      for (const bucket of ledger.buckets) {
        if (bucket.minute > minute - WINDOW_BUCKETS) {
          checks5m += bucket.checks;
          refusals5m += bucket.refusals;
        }
      }
      out.set(box, {
        checks5m,
        refusals5m,
        checksTotal: ledger.checksTotal,
        refusalsTotal: ledger.refusalsTotal,
      });
    }
    return out;
  }

  reset(): void {
    this.boxes.clear();
  }
}

/** The process-wide ledger the guards in `ws/voice.ts` write to. */
export const admissionLedger = new AdmissionLedger();

export interface SfuAdmissionBox extends AdmissionCounts {
  /**
   * The box's region id, or `all` when `sfu_video_budget_per_box` is off and
   * the estimator sums every room in the cluster against one number.
   */
  box: string;
  /** What the estimator prices for the SFU rooms on this box, in Mbit/s. */
  loadMbps: number;
  /** The ceiling an admission is held to on this box. */
  budgetMbps: number;
  /** `loadMbps / budgetMbps`, or null when the budget is zero (box closed). */
  utilisation: number | null;
  /** Rooms on the SFU (a mesh room costs the box nothing) and the people in them. */
  rooms: number;
  participants: number;
  cameraPublishers: number;
  screenPublishers: number;
}

export interface SfuAdmissionSnapshot {
  /**
   * `cluster` is every instance's rooms (registry on). `local` is this
   * process's own rooms only: the registry is off, or its read failed, so the
   * loads are a floor, not a total.
   */
  source: "cluster" | "local";
  /** `sfu_video_budget_per_box` at read time. */
  perBox: boolean;
  /** `sfu_video_price_calibrated` at read time. */
  calibrated: boolean;
  boxes: SfuAdmissionBox[];
}

export interface SfuAdmissionInput {
  rooms: readonly SfuRoomLoad[];
  source: "cluster" | "local";
  perBox: boolean;
  price: PriceOptions;
  /** The box a room with no region lives on. */
  homeBox: string;
  /** Every configured box, so a quiet one still reports a zero. */
  boxIds: readonly string[];
  budgetFor: (box: string) => number;
  /** The one budget used when `perBox` is off. */
  clusterBudgetMbps: number;
  counts: ReadonlyMap<string, AdmissionCounts>;
}

const ZERO_COUNTS: AdmissionCounts = {
  checks5m: 0,
  refusals5m: 0,
  checksTotal: 0,
  refusalsTotal: 0,
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function boxRow(
  box: string,
  rooms: readonly SfuRoomLoad[],
  budgetMbps: number,
  price: PriceOptions,
  counts: AdmissionCounts,
): SfuAdmissionBox {
  const onSfu = rooms.filter((room) => room.transport === "livekit");
  const loadMbps = estimateSfuLoadMbps(onSfu, price);
  return {
    box,
    loadMbps: round1(loadMbps),
    budgetMbps,
    utilisation: budgetMbps > 0 ? Math.round((loadMbps / budgetMbps) * 1000) / 1000 : null,
    rooms: onSfu.length,
    participants: onSfu.reduce((sum, room) => sum + Math.max(0, room.participants), 0),
    cameraPublishers: onSfu.reduce((sum, room) => sum + Math.max(0, room.cameraPublishers), 0),
    screenPublishers: onSfu.reduce((sum, room) => sum + Math.max(0, room.screenPublishers), 0),
    ...counts,
  };
}

/**
 * The estimator's total per box for this room set. Uses the same
 * `estimateSfuLoadMbps` and `roomsOnBox` the guards use, so the number a
 * graph shows is the number an admission compared against the budget (minus
 * the asking room, which is only known at the moment of asking).
 */
export function buildSfuAdmissionSnapshot(input: SfuAdmissionInput): SfuAdmissionSnapshot {
  const base = { source: input.source, perBox: input.perBox, calibrated: !!input.price.calibrated };
  if (!input.perBox) {
    const total: AdmissionCounts = { ...ZERO_COUNTS };
    for (const counts of input.counts.values()) {
      total.checks5m += counts.checks5m;
      total.refusals5m += counts.refusals5m;
      total.checksTotal += counts.checksTotal;
      total.refusalsTotal += counts.refusalsTotal;
    }
    return {
      ...base,
      boxes: [boxRow("all", input.rooms, input.clusterBudgetMbps, input.price, total)],
    };
  }
  const ids = new Set<string>([input.homeBox, ...input.boxIds, ...input.counts.keys()]);
  for (const room of input.rooms) {
    ids.add(room.region || input.homeBox);
  }
  const boxes = [...ids].sort((a, b) =>
    a === input.homeBox ? -1 : b === input.homeBox ? 1 : a.localeCompare(b),
  );
  return {
    ...base,
    boxes: boxes.map((box) =>
      boxRow(
        box,
        roomsOnBox(input.rooms, { region: box, home: input.homeBox }),
        input.budgetFor(box),
        input.price,
        input.counts.get(box) ?? ZERO_COUNTS,
      ),
    ),
  };
}
