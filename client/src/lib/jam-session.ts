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
      books.delete(engine);
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

/**
 * What one engine knows about its stems. `desired` is the latest sync's answer
 * to "which stems, in which state", and is what every load is judged against
 * when it finishes: a load that was asked for before a later sync moved or
 * removed its track must not leave a stale stem behind.
 */
interface Book {
  desired: Map<string, string>;
  installed: Map<string, { key: string; url: string }>;
  loading: Map<string, { key: string; done: Promise<boolean> }>;
}

const books = new WeakMap<object, Book>();

function bookOf(engine: JamEngine): Book {
  let book = books.get(engine);
  if (!book) {
    book = { desired: new Map(), installed: new Map(), loading: new Map() };
    books.set(engine, book);
  }
  return book;
}

export type StemStatus = "loading" | "ready" | "error";

/** The stem id the studio gives the take being recorded or reviewed. */
export const TAKE_STEM_ID = "take";

/**
 * Make the engine's stems exactly the in-mix tracks: load the ones it lacks,
 * move the ones whose numbers changed, drop the rest. A stem the listener has
 * muted or turned down keeps its mute and gain across a refresh (only timing is
 * rewritten). Resolves when every wanted stem is decoded or has failed.
 *
 * Safe to call again before the last call has finished: the newest call's tracks
 * are the truth, an in-flight load for something else is waited out and then
 * reconciled, never installed over it.
 */
export async function syncJamStems(
  engine: JamEngine,
  tracks: readonly JamTrack[],
  onStatus?: (trackId: string, status: StemStatus) => void,
): Promise<void> {
  const book = bookOf(engine);
  const wanted = tracks.filter((track) => track.inMix);
  book.desired = new Map(wanted.map((track) => [track.id, stemKey(track)]));

  for (const stem of engine.player.stems()) {
    if (!book.desired.has(stem.id) && stem.id !== TAKE_STEM_ID) {
      engine.player.removeStem(stem.id);
      book.installed.delete(stem.id);
    }
  }

  async function settle(track: JamTrack): Promise<void> {
    const key = stemKey(track);
    const url = track.audioUrl.split("?")[0] ?? track.audioUrl;
    for (let pass = 0; pass < 6; pass++) {
      if (book.desired.get(track.id) !== key) {
        return; // a newer sync owns this track now
      }
      const installed = book.installed.get(track.id);
      if (installed && installed.key === key && engine.player.stem(track.id)) {
        onStatus?.(track.id, "ready");
        return;
      }
      const running = book.loading.get(track.id);
      if (running) {
        await running.done;
        continue; // look again: what it installed may not be what is wanted
      }
      if (installed && installed.url === url && engine.player.stem(track.id)) {
        // Same audio, moved: rewrite the timing, nothing is decoded again.
        engine.player.updateStem(track.id, {
          offsetMs: track.offsetMs,
          trimStartMs: track.trimStartMs,
          trimEndMs: track.trimEndMs,
        });
        book.installed.set(track.id, { key, url });
        onStatus?.(track.id, "ready");
        return;
      }
      onStatus?.(track.id, "loading");
      const done = engine.player
        .loadStem(track.id, track.audioUrl, {
          offsetMs: track.offsetMs,
          trimStartMs: track.trimStartMs,
          trimEndMs: track.trimEndMs,
          gain: track.gain,
        })
        .then(() => {
          book.installed.set(track.id, { key, url });
          return true;
        })
        .catch(() => false)
        .finally(() => {
          book.loading.delete(track.id);
        });
      book.loading.set(track.id, { key, done });
      const ok = await done;
      if (!ok) {
        onStatus?.(track.id, "error");
        return;
      }
      if (!book.desired.has(track.id)) {
        // Removed while it loaded: take what it just installed out again.
        engine.player.removeStem(track.id);
        book.installed.delete(track.id);
        return;
      }
    }
  }

  await Promise.all(wanted.map(settle));
}

/** Take every stem out (leaving a song). The take, if any, goes too. */
export function clearJamStems(engine: JamEngine): void {
  const book = bookOf(engine);
  book.desired = new Map();
  for (const stem of engine.player.stems()) {
    engine.player.removeStem(stem.id);
  }
  book.installed.clear();
}
