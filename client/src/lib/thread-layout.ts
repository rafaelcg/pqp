import { useSyncExternalStore } from "react";
import { MD_UP_QUERY, XL_UP_QUERY } from "@/lib/breakpoints";

/**
 * Where an open thread sits under the redesign.
 *
 * From `xl` (1280px) up it is a column beside the conversation, as it always
 * was. Between `md` and `xl` that split left the conversation about 250px at
 * 1024: no title in the header, a clipped hover bar, a one-letter composer
 * placeholder. So there the thread TAKES OVER the conversation's place: the
 * chat `<main>` is hidden (never unmounted, so a draft, the scroll and a call
 * survive) and the thread shows the phone's back bar to return to it.
 *
 * A plain breakpoint, on purpose. The channel column is resizable, but its
 * width lives inside `ChannelList`; with the default column, `xl` leaves the
 * conversation about 500px beside a 416px thread, which is the floor the rule
 * is after. Below `md` the phone layout already covers the screen with the
 * thread, so the takeover is a desktop-shell concern only.
 *
 * A voice room keeps the split: its call view lives inside `<main>`, and
 * hiding a running call behind a thread is a bigger surprise than a narrow
 * chat.
 */
export function threadTakesOver({
  redesign,
  mdUp,
  xlUp,
  voiceRoom,
}: {
  redesign: boolean;
  /** The desktop shell (Tailwind `md` and up). */
  mdUp: boolean;
  /** Tailwind `xl` and up: room for the split. */
  xlUp: boolean;
  /** The selected channel is a voice room (its call view is in `<main>`). */
  voiceRoom: boolean;
}): boolean {
  return redesign && mdUp && !xlUp && !voiceRoom;
}

function mediaQuery(query: string): MediaQueryList | null {
  try {
    return window.matchMedia(query);
  } catch {
    // Older WebViews and non-browser renderers have no matchMedia at all.
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  const lists = [mediaQuery(MD_UP_QUERY), mediaQuery(XL_UP_QUERY)].filter(
    (list): list is MediaQueryList => list !== null,
  );
  for (const list of lists) {
    list.addEventListener("change", onChange);
  }
  return () => {
    for (const list of lists) {
      list.removeEventListener("change", onChange);
    }
  };
}

/**
 * One string so `useSyncExternalStore` compares a primitive: "md|xl" flags.
 * Without matchMedia it reads as the phone (neither), which never takes over.
 */
function getSnapshot(): string {
  const md = mediaQuery(MD_UP_QUERY)?.matches ?? false;
  const xl = mediaQuery(XL_UP_QUERY)?.matches ?? false;
  return `${md ? 1 : 0}${xl ? 1 : 0}`;
}

/** `threadTakesOver` with the two widths read live from the window. */
export function useThreadTakesOver({
  redesign,
  voiceRoom,
}: {
  redesign: boolean;
  voiceRoom: boolean;
}): boolean {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => "00");
  return threadTakesOver({
    redesign,
    mdUp: snapshot[0] === "1",
    xlUp: snapshot[1] === "1",
    voiceRoom,
  });
}
