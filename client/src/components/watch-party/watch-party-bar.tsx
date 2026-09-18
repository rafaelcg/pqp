import { cn } from "@/lib/utils";

/**
 * THE ONE BAR (2026-09-18, `docs/plans/WATCH_PARTY_UI.md` pass 2).
 *
 * Every action that changes what the audience gets, or what this person is
 * doing in the party, sits in one row at the bottom of the picture. It used
 * to be a dock above the split (mic, share, mixer), an overlay at the top
 * right of the stage (the guests button, the request button, the on-air
 * strip) and a button on the player's own top bar (Parar de assistir):
 * three places for one kind of thing.
 *
 * WHY A SLOT AND NOT A COMPONENT WITH PROPS. The controls belong to two
 * components that already own their state and their handlers:
 * `WatchPartyPanel` (mic, seat, share, mixer, the legacy raise) and
 * `WatchPartyGuestsOverlay` (guests). Lifting all of that into one new
 * component would mean re-threading forty props through `App.tsx` for a
 * layout change. So the bar is an ELEMENT, and each owner portals its group
 * into it (`createPortal`), the same way the mini-player is a DOM move
 * rather than a remount (`docs/WATCH_PARTY.md`, "The mini-player, and why it
 * is a DOM move"). `order-*` on each group fixes the reading order whatever
 * the mount order was.
 *
 * TWO PLACEMENTS, ONE ELEMENT AT A TIME. `stage` is the bar drawn by `App`
 * over the bottom edge of the stage pane: the host and every seated person
 * get this one. `player` is a span inside `HlsWatchPlayer`'s own bottom bar,
 * for the seatless viewer, whose picture already has a bar that fades with
 * the pointer: a second bar under it would be exactly the stacking this pass
 * exists to remove. `App` hands whichever exists to both owners
 * (`playerBarEl ?? stageBarEl`), so the player's bar wins while a viewer has
 * a picture, and the stage bar takes over the moment they do not.
 *
 * The on-air tint is a `:has()` on the container rather than a prop, because
 * the strip is a portalled child and the container has no other way to know
 * it is there.
 */
export function WatchPartyBarSlot({
  placement,
  onElement,
  className,
}: {
  placement: "stage" | "player" | "status";
  /** Called with the element on mount and `null` on unmount. */
  onElement: (element: HTMLDivElement | null) => void;
  className?: string;
}) {
  return (
    <div
      ref={onElement}
      data-watch-party-bar-slot={placement}
      className={cn(
        placement === "stage"
          ? // OVER THE BOTTOM EDGE OF THE PICTURE, z-30 above the stage's own
            // chrome and below menus. `App` mounts this only while the pane
            // holds a stage (`stageShape` expanded or fullscreen): on an empty
            // pane an absolute row anchored to its bottom edge climbed up over
            // the header and sat on Encerrar, which the e2e spec caught; with
            // no slot the panel draws the same row inline above the split.
            // `empty:hidden` so a slot with nothing portalled into it (a
            // viewer whose bar is on the player) draws no gradient.
            "pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-wrap items-center gap-1.5 bg-gradient-to-t from-ink/95 via-ink/70 to-transparent px-3 pb-2 pt-6 empty:hidden [&>*]:pointer-events-auto"
          : placement === "status"
            ? // THE STATUS LINE OVER THE TOP EDGE OF THE PICTURE (pass 3): the
              // host's transmission readout, a dot and one sentence, where a
              // strip above the split used to be.
              "pointer-events-none absolute inset-x-0 top-0 z-30 flex items-start px-3 pt-2 empty:hidden [&>*]:pointer-events-auto"
            : "flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden",
        "has-[[data-watch-party-on-air-strip]]:bg-danger-soft/90 has-[[data-watch-party-on-air-strip]]:bg-none",
        className,
      )}
    />
  );
}
