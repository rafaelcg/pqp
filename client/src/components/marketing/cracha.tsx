import { Suspense, lazy, useEffect, useState } from "react";

/**
 * The gate in front of the 3D crachá.
 *
 * THREE THINGS HAVE TO BE TRUE before three.js is downloaded at all: the
 * browser can make a WebGL context, the visitor has not asked for reduced
 * motion, and the device is not obviously a low-end phone. Any one of them
 * false and the import never happens, so the bytes are never fetched.
 *
 * THE FALLBACK IS NOT AN APOLOGY. It is the same badge, drawn in CSS, static.
 * Somebody on reduced motion is not told they are missing something; they get
 * a badge with their name on it that does not move, which is what they asked
 * for. That matters more than it sounds: the badge is the argument for
 * claiming a handle, and a page that hides its argument from the people most
 * likely to need a calm one is a page that fails them.
 */

const CrachaCanvas = lazy(() => import("./cracha-canvas"));

/**
 * Can this browser draw it, and does the visitor want it drawn?
 *
 * The WebGL probe creates a context and throws it away. That costs a few
 * milliseconds once, which is cheaper than downloading three.js to discover
 * the same thing.
 */
function canRender3d(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return false;
  }
  // `deviceMemory` is Chromium-only and absent elsewhere, which reads as
  // "unknown" and is treated as capable. Under 4GB is where a phone starts
  // dropping frames on a continuous WebGL loop.
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  if (typeof memory === "number" && memory < 4) {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!gl) {
      return false;
    }
    (gl as WebGLRenderingContext)
      .getExtension("WEBGL_lose_context")
      ?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export function Cracha({
  handle,
  edition,
}: {
  handle: string;
  edition: string;
}) {
  // Starts false so the first paint is always the flat badge. Deciding during
  // render would make this the one component that behaves differently on a
  // rerender than on mount.
  const [enabled, setEnabled] = useState(false);
  useEffect(() => setEnabled(canRender3d()), []);

  const shown = handle.trim() || "seunome";

  return (
    <div className="relative mx-auto aspect-[3/4] w-full max-w-[340px]">
      {enabled ? (
        <Suspense fallback={<FlatCracha handle={shown} edition={edition} />}>
          <CrachaCanvas handle={shown} edition={edition} />
        </Suspense>
      ) : (
        <FlatCracha handle={shown} edition={edition} />
      )}
    </div>
  );
}

/**
 * The same object, in CSS, holding still.
 *
 * Also the Suspense fallback, so the badge is on screen from the first frame
 * and the 3D one replaces it rather than popping in after a blank gap.
 */
function FlatCracha({
  handle,
  edition,
}: {
  handle: string;
  edition: string;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-end">
      <div
        className="w-3 flex-1 rounded-sm bg-signal"
        style={{ maxHeight: "34%" }}
        aria-hidden
      />
      <div className="relative w-full max-w-[232px] rounded-xl border border-ink-4 bg-gradient-to-br from-ink-3 to-ink p-4 shadow-2xl">
        <span
          className="absolute left-1/2 top-2.5 h-1.5 w-12 -translate-x-1/2 rounded-full border border-ink-4 bg-ink"
          aria-hidden
        />
        <div className="mt-4 flex justify-between font-mono text-[9px] uppercase tracking-[0.14em] text-paper-muted">
          <span>pqp</span>
          <span>beta aberto</span>
        </div>
        <p className="font-handle mt-10 break-all text-center text-3xl leading-none text-paper">
          <span className="text-paper-muted">@</span>
          <span className="text-signal">{handle}</span>
        </p>
        <div className="mt-10 flex justify-between font-mono text-[9px] uppercase tracking-[0.12em] text-paper-muted">
          <span>perfil público</span>
          <span>{edition}</span>
        </div>
      </div>
    </div>
  );
}
