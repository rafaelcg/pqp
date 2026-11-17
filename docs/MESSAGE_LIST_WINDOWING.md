# The windowed transcript

`client/src/components/chat/message-list.tsx`, flag `message_list_windowing`
(`docs/FEATURE_FLAGS.md`), arithmetic in `client/src/lib/message-window.ts`.

## Why

Every loaded message used to stay mounted. A row is about 50 DOM nodes and
175 KB of heap, so a channel scrolled back to 2,000 messages held 100,743 nodes
and 1.2 GB in the desktop app (the 2026-11-05 Rust spike), and leaving it took
238 ms to unmount. `content-visibility: auto` skipped layout and paint for rows
off screen but never freed them. Every row also built its hover toolbar up
front: six tooltips, a popper anchor each, a presence, and a Radix dialog for
the delete confirmation, which is most of the heap (React fibers 41 MB,
`TooltipTrigger` 26 MB, `composeEventHandlers` 19 MB at 2,000 rows).

## What it does

Windowed (the default), the list mounts:

- the rows within about 1,400 px of the viewport on each side (at least 12 rows,
  at most 220), and the whole list when it has 80 rows or fewer;
- the few rows that must stay wherever they are: the one the keyboard is on (the
  log's single tab stop), the one being edited, one with an emoji picker open,
  and the rows from one end of a text selection to the other (up to 300 rows);
- one spacer `<div aria-hidden>` for each run of rows that is not mounted, at
  the height the rows would have, so every mounted row sits where it would with
  the whole list mounted and the scrollbar is the real length.

Each row is wrapped in one `flow-root` `<div data-row-id>` (its day line, the NEW
rule and the article together), which is what gets measured. `flow-root` keeps a
row's top margin inside the wrapper, so wrappers add up to the list's height and
nothing collapses through them. Mounted rows are laid out in full: no
`content-visibility`, because a row the browser skips reports its 64 px
placeholder and the spacers are built from measured heights.

The hover toolbar, its tooltips, and the delete confirmation are built on the
first pointer or focus on the row (the CSS still shows and hides the toolbar), or
when the row's "more" menu is open.

Off, the list is exactly what it was: a fragment per row, `content-visibility`,
a toolbar on every row.

## Heights

A row's height is what the `ResizeObserver` on its wrapper last said. A row never
mounted is the mean of the measured ones (56 px before any is). That guess is
wrong for some rows, so the layout has to survive being corrected.

## Scroll anchoring

`overflow-anchor` is off on the log and the list does its own. At every scroll
event it takes an **anchor**: the first row whose bottom is below the top of the
viewport, and where its top sits. After any commit and any measured change in a
row's height it puts that row back (`applyViewAnchor`), subtracting the scrolling
the reader did since the anchor was taken (`anchorShift`). That one mechanism
covers a guess corrected as rows mount above the reader, an image loading above
them, and older history being prepended (which also keeps its original 1.5 s hold
and the old restore). It does nothing while following the tail (the list follows
the bottom there), while a jump is travelling, or in a forum post's hold at the
top. Anything that scrolls on purpose clears the anchor first; the next scroll
event takes a new one.

## Where the window is

The window is a function of a scroll position: the end of the list while the
reader is following the tail, otherwise the position the last scroll planned
around (`viewTop`, held against the first row at the time, so history prepended
above moves the window with the rows). The scroll handler re-plans it when the
overscan on a side runs under 40 % (rendered lazily) or the viewport has left the
mounted rows (rendered at once with `flushSync`, so blank space is never painted).

## Jumps

A permalink, search result or reply quote to a message that is loaded but not
mounted (`revealRow`): the window is rendered around it at once, the viewport is
set on it, and the usual smooth scroll and re-centring passes run from there. They
only have the estimate's error to correct. A message that is not loaded is
fetched around, as before. The NEW rule is landed on the same way when it is
outside the window. Home and End from a far row ask for the row through
`pendingFocusRef`: it is kept mounted by the render the state change causes and
focused in the layout effect after it.

## Accessibility

- The container stays `role="log"` with its name and `aria-live="off"`, and the
  single sr-only status region is unchanged.
- DOM order is reading order. Each mounted article has `aria-posinset` (its place
  among the loaded messages) and `aria-setsize="-1"`: the total is not known,
  older history is paged in as people scroll. The size is not the loaded count
  because that changes on every arrival and would re-render every row.
- Focus is not lost when the focused row scrolls out: it is kept mounted. The log
  keeps exactly one `tabindex="0"` row.

## What is not covered

- **The browser's find-in-page** (Ctrl/Cmd+F) only finds mounted rows. The app's
  own message search (which jumps to a result) is the way to find older text.
- **Select all** in the log selects the mounted rows. A selection made by
  dragging keeps its rows mounted, so Copy gets everything it spans (up to 300
  rows), but a longer one is not kept.
- A screen reader's virtual cursor parked on a row far outside the viewport can
  lose its place when the row is replaced by a spacer.
- Scrollbar length is an estimate until the rows have been seen: it settles as
  they are measured, without moving the text.

## Measuring

`e2e/message-window.spec.ts` seeds a 2,000 message channel with one INSERT and
asserts the DOM bound, the sweep, jumps, the NEW rule, anchoring on prepend and on
a row growing, the live end, the keyboard, a selection, and the semantics.
`src/lib/message-window.test.ts` is the math. Numbers on a production build of
the client, 2,000 loaded messages, headless Chromium on an M-series Mac:

| | every row mounted (flag off) | windowed (default) |
|---|---|---|
| DOM nodes | 94,193 | 1,313 |
| JS heap | 377 MB | 26 MB |
| renderer RSS | 765 MB | 277 MB |
| leave the channel | 118 ms | 26 ms |
| worst scroll frame in a 4 s sweep | 16.7 ms | 9.4 ms |

## Turning it off

Dashboard, controles, interruptores, `message_list_windowing`: off. A tab already
open switches back to mounting every row on its next config refresh (focus, or up
to 10 minutes). Or `MESSAGE_LIST_WINDOWING=off` on the API as the default.
