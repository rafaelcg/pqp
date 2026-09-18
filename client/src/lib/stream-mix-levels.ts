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

/**
 * THE BUS LIMITER, and the makeup gain that was missing from it.
 *
 * Both mixes a presenter's browser builds — `screen-mix.ts`'s film bus and
 * `stage-mix.ts`'s voice bus — sum their branches into a
 * `DynamicsCompressorNode` at this threshold with a 12:1 ratio, so a boosted
 * mic (or five guests at once) cannot clip the destination.
 *
 * `DynamicsCompressorNode` applies NO makeup gain of its own. From #513
 * (2026-09-12), which introduced the limiter, nothing a watch party published
 * could reach within 6 dB of full scale again: before it, the display
 * capture's own audio went to the destination untouched, at unity. The
 * audience's report on 2026-09-18 was "the sound from the shared tab AND the
 * mic are very low", which is the shape of a ceiling on the whole bus rather
 * than one branch set wrong — the display branch's own -3 dB default and the
 * further -6 dB while ducked sit on top of it.
 *
 * `MIX_MAKEUP_GAIN` is exactly what the ceiling takes back: +6 dB. It is
 * applied AFTER the limiter, which is what makes it safe — the loudest thing
 * that can reach it is the ceiling itself, so the result lands at roughly
 * full scale rather than over it, and a quiet passage that never reached the
 * knee simply comes back up by the same 6 dB. Applied BEFORE the limiter it
 * would only drive the limiter harder and change nothing at all.
 */
export const LIMITER_THRESHOLD_DBFS = -6;
export const MIX_MAKEUP_GAIN = 10 ** (-LIMITER_THRESHOLD_DBFS / 20);

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

/** Both branches back to their defaults, persisted and returned for the caller to apply live. */
export function resetStreamMixLevels(): StreamMixLevels {
  const levels: StreamMixLevels = {
    micGain: DEFAULT_MIC_GAIN,
    displayGain: DEFAULT_DISPLAY_GAIN,
  };
  writeStreamMixLevels(levels);
  return levels;
}

/**
 * A linear `GainNode` value as the dB the mixer sliders show. `GainNode.gain`
 * takes a linear factor, but nobody reasons about a mic in "x2.0" — the
 * sliders' own numbers are in `stream-mix-levels.ts` doc comment above for
 * that reason, and this is the same conversion for display: `20 * log10(v)`,
 * one decimal, signed so +6.0 dB and -3.1 dB read as boosted/cut at a glance.
 * `-0` rounds to a plain "0.0 dB" (`toFixed` already drops the sign on zero).
 */
export function formatGainDb(gain: number): string {
  const db = Math.round(20 * Math.log10(gain) * 10) / 10;
  const sign = db > 0 ? "+" : "";
  return `${sign}${db.toFixed(1)} dB`;
}
