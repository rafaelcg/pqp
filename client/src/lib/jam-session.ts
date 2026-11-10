import type { JamTrack } from "@pqp/shared";
import { JamEngine } from "@/lib/jam";

/**
 * The one audio engine the jam screens share. A song panel plays through it,
 * and the studio records through the SAME context, because a take is placed
 * against the backing by frame numbers that only mean something on one clock
 * (`docs/JAM_ENGINE.md`, "The latency model").
 *
 * It is created the first time something needs sound and closed when the person
 * leaves the jam, so no AudioContext idles behind a chat.
 */

let current: Promise<JamEngine> | null = null;

export function getJamEngine(): Promise<JamEngine> {
  if (!current) {
    current = JamEngine.create().catch((error: unknown) => {
      current = null;
      throw error;
    });
  }
  return current;
}

export async function releaseJamEngine(): Promise<void> {
  const held = current;
  current = null;
  if (held) {
    try {
      const engine = await held;
      stemKeys.delete(engine);
      stemLoads.delete(engine);
      await engine.destroy();
    } catch {
      // Already closed, or never opened.
    }
  }
}

/** The numbers a stem was loaded with, to tell "same stem" from "moved". */
function stemKey(track: JamTrack): string {
  return [track.audioUrl.split("?")[0], track.offsetMs, track.trimStartMs, track.trimEndMs].join("|");
}

const stemKeys = new WeakMap<object, Map<string, string>>();
const stemLoads = new WeakMap<object, Map<string, Promise<void>>>();

export type StemStatus = "loading" | "ready" | "error";

/**
 * Make the engine's stems exactly the in-mix tracks: load the ones it lacks,
 * move the ones whose numbers changed, drop the rest. A stem the listener has
 * muted or turned down keeps its mute and gain across a refresh (only timing is
 * rewritten). Resolves when every wanted stem is decoded or has failed.
 */
export async function syncJamStems(
  engine: JamEngine,
  tracks: readonly JamTrack[],
  onStatus?: (trackId: string, status: StemStatus) => void,
): Promise<void> {
  const keys = stemKeys.get(engine) ?? new Map<string, string>();
  stemKeys.set(engine, keys);
  const loads = stemLoads.get(engine) ?? new Map<string, Promise<void>>();
  stemLoads.set(engine, loads);

  const wanted = tracks.filter((track) => track.inMix);
  const wantedIds = new Set(wanted.map((track) => track.id));
  for (const stem of engine.player.stems()) {
    if (!wantedIds.has(stem.id) && stem.id !== TAKE_STEM_ID) {
      engine.player.removeStem(stem.id);
      keys.delete(stem.id);
    }
  }

  await Promise.all(
    wanted.map((track) => {
      const key = stemKey(track);
      const have = engine.player.stem(track.id);
      if (have && keys.get(track.id) === key) {
        onStatus?.(track.id, "ready");
        return Promise.resolve();
      }
      if (have) {
        engine.player.updateStem(track.id, {
          offsetMs: track.offsetMs,
          trimStartMs: track.trimStartMs,
          trimEndMs: track.trimEndMs,
        });
        keys.set(track.id, key);
        onStatus?.(track.id, "ready");
        return Promise.resolve();
      }
      const running = loads.get(track.id);
      if (running) {
        return running;
      }
      onStatus?.(track.id, "loading");
      const load = engine.player
        .loadStem(track.id, track.audioUrl, {
          offsetMs: track.offsetMs,
          trimStartMs: track.trimStartMs,
          trimEndMs: track.trimEndMs,
          gain: track.gain,
        })
        .then(() => {
          keys.set(track.id, key);
          onStatus?.(track.id, "ready");
        })
        .catch(() => {
          onStatus?.(track.id, "error");
        })
        .finally(() => {
          loads.delete(track.id);
        });
      loads.set(track.id, load);
      return load;
    }),
  );
}

/** The stem id the studio gives the take being recorded or reviewed. */
export const TAKE_STEM_ID = "take";

/** Take every stem out (leaving a song). The take, if any, goes too. */
export function clearJamStems(engine: JamEngine): void {
  for (const stem of engine.player.stems()) {
    engine.player.removeStem(stem.id);
  }
  stemKeys.get(engine)?.clear();
}
