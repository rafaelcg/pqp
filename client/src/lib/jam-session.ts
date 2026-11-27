import type { JamTrack } from "@pqp/shared";
import { JamEngine } from "@/lib/jam";
import { forgetJamPlayer, followJamPlayer } from "@/lib/jam-now-playing";
import { inPool } from "@/lib/jam-pool";
import {
  noteListenCopyFailure,
  planListenSources,
  type ListenTrack,
  type Rendition,
} from "@/lib/jam-listen-copy";

/** Stems downloaded and decoded at once: a song of many takes loads in waves, not in a burst. */
const STEM_LOADS_AT_ONCE = 4;

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
/** The engine of `current` once it exists, so a gesture can reach its context without waiting a tick. */
let ready: JamEngine | null = null;

export function getJamEngine(): Promise<JamEngine> {
  if (!current) {
    const created: Promise<JamEngine> = JamEngine.create()
      .then((engine) => {
        // The sidebar row follows the transport (`jam-now-playing.ts`), but only for
        // the engine that is still THE engine: one that was released while it was
        // being created (or replaced by a newer one) must not take the row over.
        if (current === created) {
          ready = engine;
          followJamPlayer(engine.player);
        }
        return engine;
      })
      .catch((error: unknown) => {
        if (current === created) {
          current = null;
        }
        throw error;
      });
    current = created;
  }
  return current;
}

/** The engine, if there is one right now (and it is the current one). Never creates one. */
export function peekJamEngine(): JamEngine | null {
  return ready;
}

/**
 * Called from inside a click or a keypress that is about to start a song: makes
 * the engine's AudioContext (if it was not yet) and asks it to run, in the very
 * task of the gesture. A browser that holds back audio until a person did
 * something (Safari most of all) counts this as the something; started later,
 * from an effect after the panel mounted, the same resume can be refused and the
 * song opens silent.
 */
export function unlockJamAudio(): void {
  // Engine already there (the usual case: a second song, a key press): resume in the gesture itself.
  if (ready) {
    if (ready.context.state !== "running") {
      void ready.context.resume().catch(() => undefined);
    }
    return;
  }
  // First time: the engine is made in this very task (`JamEngine.create` has no await before the
  // AudioContext exists), and the resume follows it as a microtask of the same gesture. A resume
  // that is refused anyway leaves the song paused with its play button: one more press is a gesture.
  void getJamEngine()
    .then((engine) => (engine.context.state === "running" ? undefined : engine.context.resume()))
    .catch(() => undefined);
}

export async function releaseJamEngine(): Promise<void> {
  const held = current;
  current = null;
  ready = null;
  forgetJamPlayer();
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

/**
 * What the engine needs of a track to place it. A `JamTrack` is one; so is the
 * public site's `PublicJamTrack` with `inMix: true` (every public track is in
 * the mix), which is how the website plays through this same engine.
 */
export type StemTrack = Pick<
  JamTrack,
  "id" | "inMix" | "audioUrl" | "offsetMs" | "trimStartMs" | "trimEndMs" | "gain"
> &
  Pick<ListenTrack, "audioSources">;

/** The numbers a stem was loaded with, to tell "same stem" from "moved". */
function stemKey(track: StemTrack): string {
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
  /** `rendition` is which file the decoded buffer came from: the Opus listening copy or the original. */
  installed: Map<string, { key: string; url: string; rendition: Rendition }>;
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

export interface SyncOptions {
  /**
   * LISTENING, not recording: a track that offers a smaller Opus listening copy
   * (`audioSources`, `lib/jam-listen-copy.ts`) is loaded from it, falling back to
   * the original per stem when the copy is missing or will not decode. Off by
   * default, so the studio, which records against the original and exports from
   * it, and every caller that does not ask, load the original exactly as before.
   * A stem the engine already holds from the copy is replaced by the original
   * when a later sync does NOT ask (the studio opening over a song being heard).
   */
  listen?: boolean;
  /**
   * Tracks that are always loaded from the original even when listening: the
   * viewer's own parts, which the song panel lets them adjust (gain, offset,
   * trim) and audition against the band, and which is what the person is
   * working on. A stem the engine already holds from the copy is replaced by
   * the original on the next sync that names it here. Ignored without `listen`.
   */
  originals?: ReadonlySet<string>;
}

/** The copy is as good as the original for ears; for everything else a stem wants the original. */
function acceptable(rendition: Rendition, listen: boolean): boolean {
  return listen || rendition === "original";
}

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
  tracks: readonly StemTrack[],
  onStatus?: (trackId: string, status: StemStatus) => void,
  /**
   * Opt-in download progress, per stem: bytes so far and the size the response
   * announced (null when it did not). Only the loads THIS call starts report;
   * with no listener the loads read their body whole, as the studio's do.
   */
  onProgress?: (trackId: string, loaded: number, total: number | null) => void,
  options: SyncOptions = {},
): Promise<void> {
  const book = bookOf(engine);
  const listen = options.listen === true;
  /** Whether THIS track may be heard from its copy: listening, and not one the caller wants whole. */
  const listenFor = (trackId: string): boolean => listen && !options.originals?.has(trackId);
  const wanted = tracks.filter((track) => track.inMix);
  book.desired = new Map(wanted.map((track) => [track.id, stemKey(track)]));

  for (const stem of engine.player.stems()) {
    if (!book.desired.has(stem.id) && stem.id !== TAKE_STEM_ID) {
      engine.player.removeStem(stem.id);
      book.installed.delete(stem.id);
    }
  }

  /**
   * One stem, from the first file of its plan that loads: the copy when asked
   * and offered, then the original. A copy that fails never fails the stem; the
   * original's failure does, as it always did.
   */
  async function loadOne(track: StemTrack): Promise<Rendition> {
    const plan = planListenSources(track, { listen: listenFor(track.id) });
    for (const [index, source] of plan.entries()) {
      try {
        await engine.player.loadStem(
          track.id,
          source.url,
          {
            offsetMs: track.offsetMs,
            trimStartMs: track.trimStartMs,
            trimEndMs: track.trimEndMs,
            gain: track.gain,
          },
          onProgress ? { onProgress: (loaded, total) => onProgress(track.id, loaded, total) } : undefined,
        );
        return source.rendition;
      } catch (error) {
        if (source.rendition === "copy" && index < plan.length - 1) {
          noteListenCopyFailure(error);
          continue;
        }
        throw error;
      }
    }
    throw new Error("jam: no source to load");
  }

  async function settle(track: StemTrack): Promise<void> {
    const key = stemKey(track);
    const url = track.audioUrl.split("?")[0] ?? track.audioUrl;
    for (let pass = 0; pass < 6; pass++) {
      if (book.desired.get(track.id) !== key) {
        return; // a newer sync owns this track now
      }
      const installed = book.installed.get(track.id);
      if (
        installed &&
        installed.key === key &&
        acceptable(installed.rendition, listenFor(track.id)) &&
        engine.player.stem(track.id)
      ) {
        onStatus?.(track.id, "ready");
        return;
      }
      const running = book.loading.get(track.id);
      if (running) {
        await running.done;
        continue; // look again: what it installed may not be what is wanted
      }
      if (
        installed &&
        installed.url === url &&
        acceptable(installed.rendition, listenFor(track.id)) &&
        engine.player.stem(track.id)
      ) {
        // Same audio, moved: rewrite the timing, nothing is decoded again.
        engine.player.updateStem(track.id, {
          offsetMs: track.offsetMs,
          trimStartMs: track.trimStartMs,
          trimEndMs: track.trimEndMs,
        });
        book.installed.set(track.id, { key, url, rendition: installed.rendition });
        onStatus?.(track.id, "ready");
        return;
      }
      onStatus?.(track.id, "loading");
      const done = loadOne(track)
        .then((rendition) => {
          book.installed.set(track.id, { key, url, rendition });
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

  await inPool(wanted, STEM_LOADS_AT_ONCE, settle);
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
