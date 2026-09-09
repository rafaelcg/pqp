import { useCallback, useEffect, useRef, useState } from "react";
import { detectFullscreenMode } from "@/components/voice/capabilities";
import { attemptElementFullscreen } from "@/components/voice/element-fullscreen";
import {
  currentFullscreenElement,
  exitDocumentFullscreen,
  fullscreenDocument,
  requestElementFullscreen,
  type WebkitFullscreenElement,
} from "@/components/voice/document-fullscreen";
import {
  enterNativeVideoFullscreen,
  exitNativeVideoFullscreen,
  videoSupportsNativeFullscreen,
} from "@/lib/fullscreen";

/**
 * Fullscreen for a watch party, and the reason it is the PANE rather than the
 * video on desktop.
 *
 * A watch party is a film. People watch films fullscreen, on a laptop, for two
 * hours, and until now there was no way to: the HLS player carried a fit
 * toggle, a quality menu, a volume slider and Picture-in-Picture, and no
 * fullscreen control at all. A viewer's only option was a pane between a
 * sidebar and a chat column. Rafael, watching one: "i dont think i can make it
 * full screen as a viewer".
 *
 * THE OBVIOUS FIX IS THE WRONG ONE ON DESKTOP. `video.requestFullscreen()`
 * takes the screen and leaves everything else behind, and in a watch party
 * what is left behind is the room talking about the film. Element fullscreen
 * renders only the fullscreen element's subtree, so a fullscreen `<video>` is
 * a film with no chat, no reactions and no way to reach either without
 * leaving.
 *
 * So the target is the SPLIT PANE (`[data-call-split]`), which already holds
 * the stage, the divider and the transcript in the arrangement this person
 * chose. Fullscreen then means "the film and my chat take the screen": the
 * divider still drags, the side-by-side toggle still applies, and somebody who
 * wants nothing but the film puts the chat away and gets exactly that. Nothing
 * new to learn, and one less layout to maintain.
 *
 * IPHONE HAS NO ELEMENT FULLSCREEN. The in-page `expand` fallback is what the
 * call stage uses because `webkitEnterFullscreen` on a MediaStream showed
 * black. A watch party is HLS, not a MediaStream: the native player can
 * actually show this picture, and a working film-only fullscreen beats a
 * broken expand that never covers the Safari viewport. Desktop and Electron
 * still take the pane.
 */

export type WatchFullscreenMode = "off" | "element" | "expand" | "video";

export type WatchFullscreenPath = "element" | "video" | "expand";

export interface WatchFullscreen {
  mode: WatchFullscreenMode;
  active: boolean;
  toggle: () => void;
  exit: () => void;
}

/**
 * Which fullscreen path a watch party should take. Pure, so an iPhone and a
 * laptop can be reproduced in a Node test rather than only on the device.
 *
 * Element fullscreen wins wherever it exists (desktop, Android, iPad,
 * Electron that honours the permission): that is the pane, with the chat.
 * iPhone has none, and there the native player is the one path that hides
 * Safari's chrome. Expand is the floor: Electron after a silent refusal,
 * or a browser with neither API.
 */
export function chooseWatchFullscreenPath(probe: {
  elementFullscreen: boolean;
  videoNativeFullscreen: boolean;
  elementPreviouslyRefused?: boolean;
}): WatchFullscreenPath {
  if (probe.elementPreviouslyRefused) {
    return probe.videoNativeFullscreen ? "video" : "expand";
  }
  if (probe.elementFullscreen) {
    return "element";
  }
  if (probe.videoNativeFullscreen) {
    return "video";
  }
  return "expand";
}

/**
 * @param targetRef an element INSIDE the pane. The pane itself is found from
 * it, so no ref has to be threaded through `App.tsx` and two stage components
 * to reach a component several hundred lines away. `[data-call-split]` is the
 * pane's own marker and is already what `call-split-layout.spec.ts` measures.
 */
export function useWatchFullscreen(
  targetRef: React.RefObject<HTMLElement | null>,
): WatchFullscreen {
  const [mode, setMode] = useState<WatchFullscreenMode>("off");
  /**
   * A platform that refused once will refuse again, and asking again would
   * cost the grace period every press. More importantly, leaving the mode on
   * `element` after a refusal strands the person: the exit press calls
   * `exitFullscreen` on a document that is not fullscreen, nothing changes,
   * and the state never clears. Same reasoning as `call-stage.tsx`.
   */
  const refusedRef = useRef(false);
  const nativeFilmUnbindRef = useRef<(() => void) | null>(null);

  const paneOf = useCallback((): HTMLElement | null => {
    const anchor = targetRef.current;
    if (!anchor) {
      return null;
    }
    return anchor.closest<HTMLElement>("[data-call-split]") ?? anchor;
  }, [targetRef]);

  const filmOf = useCallback((): HTMLVideoElement | null => {
    const root = targetRef.current ?? paneOf();
    return root?.querySelector("video") ?? null;
  }, [paneOf, targetRef]);

  const listenToNativeFilm = useCallback((film: HTMLVideoElement) => {
    nativeFilmUnbindRef.current?.();
    const onBegin = () => setMode("video");
    const onEnd = () => {
      setMode((was) => (was === "video" ? "off" : was));
    };
    film.addEventListener("webkitbeginfullscreen", onBegin);
    film.addEventListener("webkitendfullscreen", onEnd);
    nativeFilmUnbindRef.current = () => {
      film.removeEventListener("webkitbeginfullscreen", onBegin);
      film.removeEventListener("webkitendfullscreen", onEnd);
    };
  }, []);

  useEffect(() => {
    return () => nativeFilmUnbindRef.current?.();
  }, []);

  // The browser is the authority on element fullscreen: Escape, the window
  // chrome and the platform's own gestures all exit without asking us.
  useEffect(() => {
    const sync = () => {
      const pane = paneOf();
      if (pane && currentFullscreenElement() === pane) {
        return;
      }
      setMode((was) => (was === "element" ? "off" : was));
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, [paneOf]);

  // ESCAPE HAS TO WORK IN `expand` TOO. In `element` the browser handles it
  // and never tells the page; in `expand` nothing does, and a full-window
  // layout whose only way out is a button somebody has to find is the state
  // this hook exists to avoid being stuck in.
  useEffect(() => {
    if (mode !== "expand") {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMode("off");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const exit = useCallback(() => {
    if (mode === "element") {
      void exitDocumentFullscreen().catch((error: unknown) => {
        console.warn("[watch] fullscreen exit refused", error);
        // The browser kept it. Say so rather than drawing an exit control
        // over a screen that is still fullscreen.
      });
      return;
    }
    if (mode === "video") {
      const film = filmOf();
      if (film) {
        exitNativeVideoFullscreen(film);
      }
      setMode("off");
      return;
    }
    setMode("off");
  }, [filmOf, mode]);

  const toggle = useCallback(() => {
    if (mode !== "off") {
      exit();
      return;
    }
    const pane = paneOf();
    if (!pane) {
      return;
    }
    const film = filmOf();
    const doc = fullscreenDocument();
    const path = chooseWatchFullscreenPath({
      elementFullscreen:
        detectFullscreenMode({
          documentFullscreenEnabled:
            doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled,
          requestFullscreen: pane.requestFullscreen,
          webkitRequestFullscreen: (pane as WebkitFullscreenElement)
            .webkitRequestFullscreen,
        }) === "element",
      videoNativeFullscreen: videoSupportsNativeFullscreen(film),
      elementPreviouslyRefused: refusedRef.current,
    });

    if (path === "video") {
      if (!film) {
        setMode("expand");
        return;
      }
      // MUST stay synchronous: iOS consumes the user gesture across an
      // await, and `webkitEnterFullscreen` after the element-fullscreen
      // grace period is a dead button.
      try {
        listenToNativeFilm(film);
        enterNativeVideoFullscreen(film);
        setMode("video");
      } catch (error) {
        console.warn("[watch] native video fullscreen refused", error);
        setMode("expand");
      }
      return;
    }

    if (path === "expand") {
      setMode("expand");
      return;
    }

    void attemptElementFullscreen({
      request: () => requestElementFullscreen(pane),
      isActive: () => currentFullscreenElement() === pane,
      onRefusal: (error) => console.warn("[watch] fullscreen refused", error),
    })
      .then((entered) => {
        if (entered) {
          setMode("element");
          return;
        }
        console.warn("[watch] element fullscreen unavailable; expanding in page");
        refusedRef.current = true;
        setMode("expand");
      })
      .catch((error: unknown) => {
        console.warn("[watch] fullscreen refused", error);
        refusedRef.current = true;
        setMode("expand");
      });
  }, [exit, filmOf, listenToNativeFilm, mode, paneOf]);

  // THE IN-PAGE FALLBACK IS A CLASS ON THE PANE, SET FROM HERE.
  //
  // `expand` has to cover the window, and the element it has to cover is
  // `CallSplit`'s pane, which is somebody else's component several hundred
  // lines away. Threading a "you are expanded" prop from here up through two
  // stages and `App.tsx` and back down would put a layout flag in four files
  // to say one thing.
  //
  // So the attribute is written on the DOM node and one rule in `index.css`
  // reads it. That is the same shape as the `element` path, where the browser
  // is also styling a node React does not know it is styling; the difference
  // is only which of the two is doing it. The cleanup runs on every exit and
  // on unmount, so a pane can never be left pinned to the window by a
  // component that has gone.
  useEffect(() => {
    const pane = paneOf();
    if (!pane) {
      return;
    }
    if (mode === "expand") {
      pane.setAttribute("data-watch-expanded", "");
      return () => pane.removeAttribute("data-watch-expanded");
    }
    pane.removeAttribute("data-watch-expanded");
    return undefined;
  }, [mode, paneOf]);

  return { mode, active: mode !== "off", toggle, exit };
}
