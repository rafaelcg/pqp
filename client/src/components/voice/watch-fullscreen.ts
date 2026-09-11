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
import {
  isWatchCinemaMode,
  shouldToggleWatchChatOverlay,
  watchCinemaChatOverlay,
} from "@/lib/watch-cinema";

/**
 * Fullscreen for a watch party: native, picture-first, Twitch-like.
 *
 * A watch party is a film. People watch films fullscreen, on a laptop, for two
 * hours. The request still goes to the SPLIT PANE (`[data-call-split]`), not
 * the `<video>`: element fullscreen only paints that element's subtree, and
 * the transcript has to stay in the tree if a hover/hotkey overlay is going
 * to show it. Taking the video would be a film with no way back to chat
 * without leaving.
 *
 * THE PANE IS NOT A LAYOUT. Cinema restyles it: the film is `position:
 * absolute; inset: 0` on a black stage, the divider is gone, and chat is
 * `display: none` until the overlay toggle. That is the difference from the
 * first cut, which kept the split (chat owning a column of the screen) and
 * called it fullscreen. Fake fullscreen. This one uses
 * `Element.requestFullscreen()` and does not let chat take layout space.
 *
 * IPHONE HAS NO ELEMENT FULLSCREEN. The native player can actually show HLS
 * (the call stage refuses `webkitEnterFullscreen` on a MediaStream because
 * PR #48 showed black). Desktop and Electron still take the pane.
 */

export type WatchFullscreenMode = "off" | "element" | "expand" | "video";

export type WatchFullscreenPath = "element" | "video" | "expand";

export interface WatchFullscreen {
  mode: WatchFullscreenMode;
  active: boolean;
  toggle: () => void;
  exit: () => void;
  /** Chat as an overlay on the film. False while cinema is off. */
  chatOverlay: boolean;
  toggleChatOverlay: () => void;
}

/**
 * Which fullscreen path a watch party should take. Pure, so an iPhone and a
 * laptop can be reproduced in a Node test rather than only on the device.
 *
 * Element fullscreen wins wherever it exists (desktop, Android, iPad,
 * Electron that honours the permission): that is the pane, restyled as
 * cinema so the film fills the screen. iPhone has none, and there the
 * native player is the one path that hides Safari's chrome. Expand is the
 * floor: Electron after a silent refusal, or a browser with neither API.
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
  const [chatOverlay, setChatOverlay] = useState(false);
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
        setChatOverlay(false);
        setMode("off");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  // `c` toggles the chat overlay while cinema is on the pane, the way Twitch
  // does. Default is picture-first: the overlay starts off.
  useEffect(() => {
    if (!isWatchCinemaMode(mode)) {
      setChatOverlay(false);
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (!shouldToggleWatchChatOverlay(event)) {
        return;
      }
      event.preventDefault();
      setChatOverlay((was) => !was);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  const exit = useCallback(() => {
    setChatOverlay(false);
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

  const toggleChatOverlay = useCallback(() => {
    if (!isWatchCinemaMode(mode)) {
      return;
    }
    setChatOverlay((was) => !was);
  }, [mode]);

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
  //
  // `data-watch-cinema` is the picture-first layout (film fills, chat is not
  // a column). It is set for both element and expand. The overlay flag is a
  // second attribute so hiding chat is the default, not a class we forget.
  useEffect(() => {
    const pane = paneOf();
    if (!pane) {
      return;
    }
    const cinema = isWatchCinemaMode(mode);
    const overlay = watchCinemaChatOverlay(mode, chatOverlay);
    if (mode === "expand") {
      pane.setAttribute("data-watch-expanded", "");
    } else {
      pane.removeAttribute("data-watch-expanded");
    }
    if (cinema) {
      pane.setAttribute("data-watch-cinema", "");
    } else {
      pane.removeAttribute("data-watch-cinema");
    }
    if (overlay) {
      pane.setAttribute("data-watch-chat-overlay", "");
    } else {
      pane.removeAttribute("data-watch-chat-overlay");
    }
    return () => {
      pane.removeAttribute("data-watch-expanded");
      pane.removeAttribute("data-watch-cinema");
      pane.removeAttribute("data-watch-chat-overlay");
    };
  }, [chatOverlay, mode, paneOf]);

  return {
    mode,
    active: mode !== "off",
    toggle,
    exit,
    chatOverlay: watchCinemaChatOverlay(mode, chatOverlay),
    toggleChatOverlay,
  };
}
