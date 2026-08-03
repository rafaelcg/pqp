import type { Gif } from "@pqp/shared";
import { Loader2, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { fetchTrendingGifs, searchGifs } from "@/lib/api";
import { cn } from "@/lib/utils";

interface GifPickerPanelProps {
  onSelect: (gif: Gif) => void;
  onClose: () => void;
  className?: string;
  /** Prefilled search, so `/gif <query>` opens straight onto results. */
  initialQuery?: string;
}

/** Long enough that a typed word is one request, short enough to feel live. */
const DEBOUNCE_MS = 300;

/** The grid is two-up, so vertical arrows move by two. */
const COLUMNS = 2;

const LISTBOX_ID = "gif-picker-results";

type Status = "loading" | "ready" | "error";

export function GifPickerPanel({
  onSelect,
  onClose,
  className,
  initialQuery = "",
}: GifPickerPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  // Seeded so `/gif cat` opens on results rather than on trending, which is
  // the difference between the command doing the search and merely opening the
  // thing you would then have to search in.
  const [query, setQuery] = useState(initialQuery);
  const [gifs, setGifs] = useState<Gif[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!panelRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // One effect for both modes: an empty box means trending, which is also the
  // state the panel opens in.
  useEffect(() => {
    const trimmed = query.trim();
    const controller = new AbortController();
    setStatus("loading");

    const timer = window.setTimeout(
      () => {
        const request = trimmed
          ? searchGifs(trimmed, controller.signal)
          : fetchTrendingGifs(controller.signal);

        void request
          .then((result) => {
            setGifs(result.gifs);
            setSelectedIndex(0);
            setStatus("ready");
          })
          .catch(() => {
            // A superseded keystroke is not a failure the user should be told
            // about — its replacement is already in flight.
            if (!controller.signal.aborted) {
              setStatus("error");
            }
          });
      },
      trimmed ? DEBOUNCE_MS : 0,
    );

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Keyboard navigation moves a selection the input never loses focus for, so
  // the browser will not scroll to it on its own.
  useEffect(() => {
    const selected = gifs[selectedIndex];
    if (selected) {
      tileRefs.current.get(selected.id)?.scrollIntoView({ block: "nearest" });
    }
  }, [gifs, selectedIndex]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (gifs.length === 0) {
      return;
    }
    const step =
      event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowLeft"
          ? -1
          : event.key === "ArrowDown"
            ? COLUMNS
            : event.key === "ArrowUp"
              ? -COLUMNS
              : 0;

    if (step !== 0) {
      event.preventDefault();
      setSelectedIndex((index) =>
        Math.min(Math.max(index + step, 0), gifs.length - 1),
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const gif = gifs[selectedIndex];
      if (gif) {
        onSelect(gif);
      }
    }
  }

  const activeId = gifs[selectedIndex]?.id;

  return (
    <div
      ref={panelRef}
      className={cn(
        "animate-rise z-50 flex h-[22rem] w-[21rem] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-[var(--shadow-popover)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
        <Search className="h-4 w-4 shrink-0 text-text-muted" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search GIFs"
          aria-label="Search GIFs"
          role="combobox"
          aria-expanded
          aria-controls={LISTBOX_ID}
          aria-autocomplete="list"
          aria-activedescendant={activeId ? `gif-${activeId}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
        />
        {status === "loading" && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-muted" />
        )}
      </div>

      {status === "error" ? (
        <p className="flex flex-1 items-center justify-center px-6 text-center text-sm text-text-muted">
          GIF search is unavailable right now.
        </p>
      ) : gifs.length === 0 && status === "ready" ? (
        <p className="flex flex-1 items-center justify-center px-6 text-center text-sm text-text-muted">
          Nothing matched that.
        </p>
      ) : (
        <div
          id={LISTBOX_ID}
          role="listbox"
          aria-label="GIF results"
          // Explicit row height, and it is load-bearing. A tile's width comes
          // from the column and its height would come from that width, so
          // automatic track sizing is circular: the browser gives up and sizes
          // the row to the button's ~17px line-height, then `overflow-hidden`
          // clips every preview to a sliver. `aspect-ratio` on the tile does
          // not rescue it either — it paints the right box but contributes
          // nothing to track sizing, so the tiles just overlap the rows below.
          // A fixed row makes the height definite, which is the one thing the
          // circularity needs broken.
          className="grid flex-1 auto-rows-[7rem] grid-cols-2 content-start gap-1.5 overflow-y-auto p-1.5"
        >
          {gifs.map((gif, index) => (
            <button
              key={gif.id}
              id={`gif-${gif.id}`}
              ref={(node) => {
                if (node) {
                  tileRefs.current.set(gif.id, node);
                } else {
                  tileRefs.current.delete(gif.id);
                }
              }}
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => onSelect(gif)}
              className={cn(
                "h-full overflow-hidden rounded-md border bg-surface-2 outline-none",
                index === selectedIndex
                  ? "border-accent"
                  : "border-transparent hover:border-border-strong",
              )}
            >
              <img
                // Twenty animations at once is the case reduced motion exists
                // for; the stills are the same grid without the movement.
                src={
                  (prefersReducedMotion ? gif.previewStillUrl : null) ??
                  gif.previewUrl
                }
                alt={gif.title || "GIF"}
                width={gif.width}
                height={gif.height}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                // Fills the fixed-height tile and crops rather than distorts.
                // The `width`/`height` attributes stay because they still give
                // the decoder the intrinsic ratio to crop from.
                className="block h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      <p className="border-t border-border px-2.5 py-1.5 text-[11px] text-text-muted">
        Powered by GIPHY
      </p>
    </div>
  );
}
