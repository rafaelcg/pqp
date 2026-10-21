import { isEnabled } from "../lib/flags.js";
import {
  promotionBudgetMbps,
  promotionBudgetMbpsFor,
  type BoxScope,
  type PriceOptions,
} from "./promotion.js";
import { homeRegionId, resolveSfuRegion } from "./regions.js";

/**
 * WHICH BOX A VIDEO BUDGET IS ABOUT, AND HOW A CAMERA IS PRICED.
 *
 * `promotion.ts` is arithmetic and knows nothing about flags or regions. This
 * is the seam that reads the two runtime flags and turns them into the scope
 * and the price options its functions take, so `ws/voice.ts` (admission and
 * promotion) and `hls-egress.ts` (the ladder's view of the WebRTC load) ask the
 * same question the same way.
 *
 * - `sfu_video_budget_per_box` (default on): the budget is the measured
 *   ceiling of ONE media server, so only the rooms pinned to the asking room's
 *   box are summed against it, and each box has its own ceiling
 *   (`VOICE_PROMOTION_MAX_SFU_MBPS_<REGION>`, falling back to
 *   `VOICE_PROMOTION_MAX_SFU_MBPS`). Off is the cluster-wide sum against one
 *   number, exactly what shipped before.
 * - `sfu_video_price_calibrated` (default on): cameras in ordinary rooms are
 *   priced by the layer a tile asks for. Off is the flat 1.5 Mbit/s each.
 *
 * With one box (`LIVEKIT_REGIONS` unset) every room is on the home box, so the
 * first flag changes nothing there; the second still does.
 */

export function perBoxBudgetOn(): boolean {
  return isEnabled("sfu_video_budget_per_box");
}

export function priceOptions(): PriceOptions {
  return { calibrated: isEnabled("sfu_video_price_calibrated") };
}

/**
 * The box a stored or pinned region names. Null, unknown and removed regions
 * are the home box, as `resolveSfuRegion` already says for every other caller.
 */
export function boxOfRegion(region: string | null | undefined): string {
  return resolveSfuRegion(region)?.id ?? homeRegionId();
}

export function homeBoxId(): string {
  return boxOfRegion(null);
}

/** The scope to price a room on `region` in, or undefined when the flag is off. */
export function boxScopeFor(
  region: string | null | undefined,
): BoxScope | undefined {
  if (!perBoxBudgetOn()) {
    return undefined;
  }
  return { region: boxOfRegion(region), home: boxOfRegion(null) };
}

/** The budget to hold a room on `region` to. */
export function boxBudgetMbps(region: string | null | undefined): number {
  return perBoxBudgetOn()
    ? promotionBudgetMbpsFor(boxOfRegion(region))
    : promotionBudgetMbps();
}

/**
 * The home box's budget: what the watch party ladder and camera egress are
 * held to, because egress and remux only ever run on the home box.
 */
export function homeBoxBudgetMbps(): number {
  return boxBudgetMbps(null);
}
