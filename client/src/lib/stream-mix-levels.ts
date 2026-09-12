/**
 * How loud the host's mixed-in microphone and the display's own audio are in
 * the published watch-party stream, remembered per browser.
 *
 * WHY IT EXISTS (2026-09-12). `screen-mix.ts` sums the display capture and
 * the host's processed microphone at unity, and a film playing in a tab sits
 * near full scale next to a processed mic that does not: the first live test
 * of PR 504's mixing came back "mic works. might need audio settings cause
 * mic was low compared to video being streamed." The fix is a gain per
 * branch feeding a limiter, and the two gains are host preferences the same
 * way `watch-party-stream-quality.ts` treats the publish ceiling: read once
 * at mix creation, adjustable live from the host's own panel, per browser.
 *
 * RANGES. `micGain` 0.5–4 (unity to +12 dB, default 2.0 / +6 dB — see
 * `screen-mix.ts` for why unity under-served a processed mic). `displayGain`
 * 0.25–1 (-12 dB to unity, default 0.7 / -3 dB, giving the limiter headroom
 * for the boosted mic without pulling the film down audibly). Both are
 * linear gain factors, not dB, because that is what `GainNode.gain.value`
 * takes directly.
 *
 * Same shape as `watch-party-stream-quality.ts`: pure parse/read/write, a
 * `localStorage` key, silent fallback to the default when storage throws.
 */

export interface StreamMixLevels {
  micGain: number;
  displayGain: number;
}

export const MIC_GAIN_RANGE = { min: 0.5, max: 4 } as const;
export const DISPLAY_GAIN_RANGE = { min: 0.25, max: 1 } as const;

export const DEFAULT_MIC_GAIN = 2.0;
export const DEFAULT_DISPLAY_GAIN = 0.7;

const MIC_GAIN_KEY = "pqp:stream-mix-mic-gain";
const DISPLAY_GAIN_KEY = "pqp:stream-mix-display-gain";

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, value));
}

/** Storage hands back `unknown` (or junk); this is the only door in. */
function parseGain(
  raw: unknown,
  range: { min: number; max: number },
  fallback: number,
): number {
  const num = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(num) ? clamp(num, range) : fallback;
}

export function readStreamMixLevels(): StreamMixLevels {
  try {
    return {
      micGain: parseGain(
        window.localStorage.getItem(MIC_GAIN_KEY),
        MIC_GAIN_RANGE,
        DEFAULT_MIC_GAIN,
      ),
      displayGain: parseGain(
        window.localStorage.getItem(DISPLAY_GAIN_KEY),
        DISPLAY_GAIN_RANGE,
        DEFAULT_DISPLAY_GAIN,
      ),
    };
  } catch {
    // Private mode, or storage disabled. The defaults are a safe mix.
    return { micGain: DEFAULT_MIC_GAIN, displayGain: DEFAULT_DISPLAY_GAIN };
  }
}

export function writeStreamMixLevels(levels: Partial<StreamMixLevels>): void {
  try {
    if (levels.micGain !== undefined) {
      window.localStorage.setItem(
        MIC_GAIN_KEY,
        String(clamp(levels.micGain, MIC_GAIN_RANGE)),
      );
    }
    if (levels.displayGain !== undefined) {
      window.localStorage.setItem(
        DISPLAY_GAIN_KEY,
        String(clamp(levels.displayGain, DISPLAY_GAIN_RANGE)),
      );
    }
  } catch {
    // Nothing to do: the control still works for this session.
  }
}
