import {
  lazy,
  Suspense,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { ContainedChunkBoundary } from "@/components/error-boundary";

/**
 * Panels and dialogs that are not on the first screen, loaded when they are
 * first drawn instead of with the shell.
 *
 * `App.tsx` used to import every dialog, settings section, forum pane and
 * watch party panel statically, so a person opening their last channel
 * downloaded, parsed and ran about 2.4 MB of script (500 KB compressed) for
 * screens they might never open. Each export in `deferred-panels.tsx` is one of
 * those, wrapped here, with the same name and the same props as the component
 * it stands for, so the call sites did not change.
 *
 * TWO SHAPES
 *  - `deferredPanel`: rendered only while something is on screen
 *    (`{open && <X/>}`), so the chunk is fetched the first time it is drawn.
 *  - `deferredDialog`: an always-mounted dialog driven by an `open` prop (or any
 *    predicate). It draws nothing, and fetches nothing, until the first time it
 *    is asked to open; from then on it stays mounted exactly like the static
 *    one, so a close animation, a draft in a field and a Radix portal behave as
 *    they did.
 *
 * WHAT A FAILED CHUNK COSTS. Every deploy deletes the old hashed assets, so a
 * page that has been open since before it 404s on the first chunk it never
 * fetched. Each wrapper carries `ContainedChunkBoundary`, so that costs this one
 * panel ("not available right now") and not the app, and
 * `recoverFromChunkLoadError` still decides whether the page may reload
 * (never in a call). See `docs/PWA.md` §"De 10 em 10 segundos".
 */

// `any` on purpose: the wrapper has to accept every component shape and hand
// back the same props, and `ComponentProps<C>` does that part exactly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

type Loader<C extends AnyComponent> = () => Promise<{ default: C }>;

/** Every loader registered here, for `preloadDeferredPanels`. */
const registry: Array<() => Promise<unknown>> = [];

function DeferredFrame({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  return (
    <ContainedChunkBoundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ContainedChunkBoundary>
  );
}

/** A panel drawn only while it is wanted. */
export function deferredPanel<C extends AnyComponent>(
  load: Loader<C>,
  fallback: ReactNode = null,
): ComponentType<ComponentProps<C>> {
  registry.push(load);
  const Lazy = lazy(load) as unknown as ComponentType<Record<string, unknown>>;
  return function DeferredPanel(props: ComponentProps<C>) {
    return (
      <DeferredFrame fallback={fallback}>
        <Lazy {...(props as Record<string, unknown>)} />
      </DeferredFrame>
    );
  };
}

/**
 * A dialog that stays mounted but is not fetched until it is first asked to
 * open. `wanted` says when that is; it defaults to the `open` prop.
 */
export function deferredDialog<C extends AnyComponent>(
  load: Loader<C>,
  wanted: (props: ComponentProps<C>) => boolean = (props) =>
    Boolean((props as { open?: boolean }).open),
): ComponentType<ComponentProps<C>> {
  registry.push(load);
  const Lazy = lazy(load) as unknown as ComponentType<Record<string, unknown>>;
  return function DeferredDialog(props: ComponentProps<C>) {
    const [wasWanted, setWasWanted] = useState(false);
    const now = wanted(props);
    if (now && !wasWanted) {
      // Derived during render (not an effect) so the first open mounts the
      // lazy component in the same pass instead of one frame later.
      setWasWanted(true);
    }
    if (!wasWanted && !now) {
      return null;
    }
    return (
      <DeferredFrame fallback={null}>
        <Lazy {...(props as Record<string, unknown>)} />
      </DeferredFrame>
    );
  };
}

/** Longest the preload waits on one chunk before it starts the next. */
const PRELOAD_STALL_MS = 10_000;

/** How many registered loaders a preload has already started, across runs. */
let preloaded = 0;
let preloadRunning = false;

/**
 * Fetch every deferred chunk once the app is up and the browser is idle, one
 * per idle slice, so a person who opens settings a minute later finds it
 * already here. Never before `startAfterMs`, and never more than one import in
 * flight, so it cannot sit in front of the first message or the API calls that
 * follow it. Safe to call more than once (a second call while one runs does
 * nothing; after a cancel, the next call carries on where the last stopped).
 * Returns a cancel function.
 */
export function preloadDeferredPanels(
  startAfterMs = 4000,
  env: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    idle: (cb: () => void, timeoutMs: number) => void;
  } = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    idle: (cb, timeoutMs) => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => cb(), { timeout: timeoutMs });
      } else {
        globalThis.setTimeout(cb, 50);
      }
    },
  },
): () => void {
  if (preloadRunning) {
    return () => {};
  }
  preloadRunning = true;
  let cancelled = false;
  const next = () => {
    if (cancelled) {
      return;
    }
    const load = registry[preloaded];
    if (!load) {
      preloadRunning = false;
      return;
    }
    preloaded += 1;
    // A failure here is not the person's problem; the real open retries the
    // import and the boundary handles it then. An import that never settles
    // (a stalled connection) must not hold up the ones behind it.
    let moved = false;
    const move = () => {
      if (!moved) {
        moved = true;
        env.idle(next, 2000);
      }
    };
    env.setTimeout(move, PRELOAD_STALL_MS);
    void load()
      .catch(() => {})
      .finally(move);
  };
  const timer = env.setTimeout(() => env.idle(next, 2000), startAfterMs);
  return () => {
    cancelled = true;
    preloadRunning = false;
    env.clearTimeout(timer);
  };
}

/** Test seam: forget what a preload already did. */
export function resetDeferredPreloadForTests(): void {
  registry.length = 0;
  preloaded = 0;
  preloadRunning = false;
}
