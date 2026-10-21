/**
 * What the sandboxed frame needs before EmulatorJS runs (S0 spike, "EmulatorJS
 * configuration and patches"). Import this first.
 *
 * The frame is an opaque origin: `window.localStorage` THROWS a SecurityError
 * there, and EmulatorJS reads it before it checks its own
 * `disableLocalStorage` flag. A getter that answers `null` is what it handles
 * ("no storage"), and it worked in Chromium, WebKit and Firefox.
 *
 * The frame's permissions policy is `allow=""`, so the core's request for a
 * screen wake lock is refused with a promise nobody handles, and the browser
 * reports it as an uncaught error (Firefox as a page error, Chromium as a
 * policy violation line). Nothing keeps the screen on in a frame that cannot
 * ask, so `navigator.wakeLock` answers with a lock that holds nothing, and a
 * rejection that still arrives is swallowed.
 */

export function installLocalStorageShim(target: object = window): void {
  try {
    Object.defineProperty(target, "localStorage", {
      configurable: true,
      get: () => null,
    });
  } catch {
    // already locked down by the browser: EmulatorJS then sees what the browser gives it
  }
}

/** A sentinel shaped like the browser's, holding nothing. */
export function inertWakeLock(): EventTarget & { released: boolean; type: "screen"; release(): Promise<void> } {
  const target = new EventTarget() as EventTarget & { released: boolean; type: "screen"; release(): Promise<void> };
  target.released = false;
  target.type = "screen";
  target.release = async () => {
    target.released = true;
  };
  return target;
}

export function installWakeLockStub(target: object = navigator): void {
  try {
    Object.defineProperty(target, "wakeLock", {
      configurable: true,
      get: () => ({ request: () => Promise.resolve(inertWakeLock()) }),
    });
  } catch {
    // the swallow below still covers a rejection
  }
}

/** True for the rejection a refused wake lock request produces (the exact text differs per browser). */
export function isWakeLockRejection(reason: unknown): boolean {
  const text = reason instanceof Error ? `${reason.name} ${reason.message}` : String(reason ?? "");
  return /wake[ -]?lock/i.test(text);
}

export function installWakeLockSwallow(target: Pick<Window, "addEventListener"> = window): void {
  target.addEventListener("unhandledrejection", (event) => {
    if (isWakeLockRejection((event as PromiseRejectionEvent).reason)) event.preventDefault();
  });
}

if (typeof window !== "undefined") {
  installLocalStorageShim();
  installWakeLockStub();
  installWakeLockSwallow();
}
