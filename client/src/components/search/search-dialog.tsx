import {
  parseSearchSnippet,
  SEARCH_QUERY_MIN_LENGTH,
  type MessageSearchResult,
} from "@pqp/shared";
import { Hash as HashGlyph, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { Hash, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Dialog } from "@/components/ui/dialog";
import { searchServerMessages } from "@/lib/api";
import { messageLinkState, messageRoutePath } from "@/lib/app-route";
import { useTranslation } from "@/lib/i18n";
import { cn, formatDayLabel, formatFullTimestamp } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { appendUniqueResults, clampSelection } from "./search-results";
import { Spinner } from "@/components/ui/spinner";

/** Long enough that a typed word is one query, short enough to feel live. */
const DEBOUNCE_MS = 300;

const LISTBOX_ID = "message-search-results";

type Status = "idle" | "loading" | "ready" | "error";

interface SearchDialogProps {
  open: boolean;
  serverId: string;
  serverName?: string;
  onClose: () => void;
  /** Fired when a result is opened, so a mobile sidebar can get out of the way. */
  onNavigate?: () => void;
  /**
   * Words to search for as the dialog opens: the Ctrl/Cmd+K switcher's last
   * row hands its query over, so nobody types it twice.
   */
  initialQuery?: string;
}

export function SearchDialog({
  open,
  serverId,
  serverName,
  onClose,
  onNavigate,
  initialQuery = "",
}: SearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState(0);
  // The arrows scroll rows under a resting pointer, and the browser then sends
  // a synthetic mouse event; only a real move of the pointer may take the
  // selection back from the keyboard.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const [scrolled, setScrolled] = useState(false);

  const navigate = useNavigate();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const trimmed = query.trim();
  const searchable = trimmed.length >= SEARCH_QUERY_MIN_LENGTH;

  // Reopening starts a new search rather than resurrecting the last one: the
  // channel you were looking for is rarely the one you were looking for before.
  useEffect(() => {
    if (open && initialQuery) {
      setQuery(initialQuery);
    }
  }, [open, initialQuery]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setStatus("idle");
      setCursor(null);
      setSelected(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    if (!searchable) {
      setResults([]);
      setCursor(null);
      setStatus("idle");
      return;
    }

    const controller = new AbortController();
    setStatus("loading");

    const timer = window.setTimeout(() => {
      void searchServerMessages(serverId, { q: trimmed }, controller.signal)
        .then((page) => {
          setResults(page.results);
          setCursor(page.nextCursor);
          setSelected(0);
          setStatus("ready");
        })
        .catch(() => {
          // A superseded keystroke is not a failure worth reporting — its
          // replacement is already in flight.
          if (!controller.signal.aborted) {
            setStatus("error");
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchable, trimmed, serverId]);

  // The input keeps focus while the selection moves, so nothing scrolls on its
  // own the way it would if each row were focused in turn.
  useEffect(() => {
    const current = results[selected];
    if (current) {
      rowRefs.current.get(current.messageId)?.scrollIntoView({
        block: "nearest",
      });
    }
  }, [results, selected]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const page = await searchServerMessages(serverId, {
        q: trimmed,
        before: cursor,
      });
      setResults((current) => appendUniqueResults(current, page.results));
      setCursor(page.nextCursor);
    } catch {
      setStatus("error");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, serverId, trimmed]);

  const openResult = useCallback(
    (result: MessageSearchResult) => {
      navigate(messageRoutePath(serverId, result.channelId, result.messageId), {
        state: messageLinkState(),
      });
      onNavigate?.();
      onClose();
    },
    [navigate, onClose, onNavigate, serverId],
  );

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) =>
        clampSelection(current, event.key === "ArrowDown" ? 1 : -1, results.length),
      );
      return;
    }
    if (event.key === "Enter") {
      const target = results[selected];
      if (target) {
        event.preventDefault();
        openResult(target);
      }
    }
  }

  const activeId = results[selected]?.messageId;

  return (
    <Dialog
      open={open}
      title={t("search.title")}
      eyebrow={serverName}
      size="lg"
      onClose={onClose}
    >
      <div className="flex h-[70vh] flex-col sm:h-[26rem]">
        <div
          className={cn(
            "flex items-center gap-2 border-b border-border px-5 py-3",
            // Under the redesign: the input's round field, inset in the body.
            "redesign:mx-[var(--dialog-px)] redesign:mt-1 redesign:mb-2 redesign:h-[var(--input-h)] redesign:gap-2.5 redesign:rounded-full redesign:border redesign:border-[color:var(--input-border)] redesign:bg-[color:var(--input-bg)] redesign:px-[var(--input-px)] redesign:py-0 redesign:not-focus-within:hover:border-[color:var(--input-hover-border)] redesign:focus-within:ring-0 redesign:focus-within:ring-offset-0 redesign:focus-within:border-[color:var(--input-ring,var(--color-focus-ring))]",
          )}
        >
          <Search className="h-4 w-4 shrink-0 text-text-muted redesign:hidden" />
          <Icon
            icon={MagnifyingGlass}
            kind="symbol"
            size="sm"
            className="hidden text-[color:var(--input-placeholder)] redesign:block"
          />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("search.placeholder")}
            aria-label={t("search.title")}
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={activeId ? `search-${activeId}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none redesign:placeholder:text-[color:var(--input-placeholder)]"
          />
          {status === "loading" && (
            <Spinner className="h-4 w-4 shrink-0 animate-spin text-text-muted" />
          )}
        </div>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto",
            // A soft edge under the field once the list has scrolled.
            scrolled && "redesign:[mask-image:linear-gradient(to_bottom,transparent,black_12px)]",
          )}
          onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        >
          {status === "error" ? (
            <SearchEmpty
              icon="error"
              title={t("search.unavailable")}
              hint={t("search.unavailableHint")}
            />
          ) : !searchable ? (
            <SearchEmpty
              title={t("search.prompt")}
              hint={t("search.minChars", { count: SEARCH_QUERY_MIN_LENGTH })}
            />
          ) : status === "loading" && results.length === 0 ? (
            <SearchEmpty icon="none" title={t("search.searching")} />
          ) : results.length === 0 ? (
            <SearchEmpty
              title={t("search.noMatch", { query: trimmed })}
              hint={t("search.wholeWords")}
            />
          ) : (
            <>
              <ul
                id={LISTBOX_ID}
                role="listbox"
                aria-label={t("search.results")}
                className="p-2 redesign:space-y-0.5 redesign:px-[var(--dialog-px)]"
              >
                {results.map((result, index) => (
                  <li key={result.messageId}>
                    <button
                      id={`search-${result.messageId}`}
                      ref={(node) => {
                        if (node) {
                          rowRefs.current.set(result.messageId, node);
                        } else {
                          rowRefs.current.delete(result.messageId);
                        }
                      }}
                      type="button"
                      role="option"
                      aria-selected={index === selected}
                      tabIndex={-1}
                      onMouseMove={(event) => {
                        // A synthetic move after a scroll has no movement.
                        if (event.movementX === 0 && event.movementY === 0) return;
                        const last = lastPointer.current;
                        if (last && last.x === event.clientX && last.y === event.clientY) return;
                        lastPointer.current = { x: event.clientX, y: event.clientY };
                        if (index !== selected) setSelected(index);
                      }}
                      onClick={() => openResult(result)}
                      className={cn(
                        "w-full rounded-md border border-transparent px-3 py-2 text-left outline-none",
                        index === selected
                          ? "border-border-strong bg-surface-2"
                          : "hover:bg-surface-2/60",
                        // Under the redesign a result is a card-cornered row;
                        // the highlighted one takes the menu's highlight, so
                        // the arrows read like a menu's.
                        "redesign:rounded-[var(--radius-card)] redesign:px-[var(--input-px)] redesign:py-2.5",
                        index === selected
                          ? "redesign:border-transparent redesign:bg-[color:var(--search-row-selected)]"
                          // Hover moves the selection, so one fill serves both.
                          : "redesign:hover:bg-transparent",
                      )}
                    >
                      <div className="flex items-baseline gap-2 text-xs text-text-muted redesign:items-center">
                        <span className="flex min-w-0 items-center gap-1 font-medium text-text redesign:gap-2.5 redesign:font-semibold">
                          <Hash className="h-3 w-3 shrink-0 redesign:hidden" />
                          {/* 14px in the 16px column under the field's glass. */}
                          <span className="hidden size-4 shrink-0 place-items-center redesign:grid">
                            <Icon icon={HashGlyph} kind="symbol" size="sm" className="size-3.5 text-text-secondary" />
                          </span>
                          <span className="truncate">{result.channelName}</span>
                        </span>
                        <span className="truncate redesign:text-text-secondary">{result.authorName}</span>
                        <time
                          dateTime={result.createdAt}
                          title={formatFullTimestamp(result.createdAt)}
                          className="ml-auto shrink-0"
                        >
                          {formatDayLabel(result.createdAt)}
                        </time>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-text-muted redesign:pl-[1.625rem] redesign:text-text-secondary">
                        <Snippet snippet={result.snippet} />
                      </p>
                    </button>
                  </li>
                ))}
              </ul>

              {cursor && (
                <div className="flex justify-center px-3 pb-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore ? t("common.loading") : t("common.loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Matched terms arrive delimited rather than as markup, so the highlight is
 * built from elements here and server text is never interpreted as HTML.
 */
function Snippet({ snippet }: { snippet: string }) {
  return (
    <>
      {parseSearchSnippet(snippet).map((segment, index) =>
        segment.match ? (
          <mark
            key={index}
            className="rounded-sm bg-accent/25 px-0.5 font-medium text-text redesign:rounded-[var(--radius-tick)] redesign:bg-[color:color-mix(in_oklab,var(--color-accent)_30%,transparent)] redesign:font-semibold"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function SearchEmpty({
  title,
  hint,
  icon = "search",
}: {
  title: string;
  hint?: string;
  /** The glass for the prompt and no match, a warning for an error, none while the field spins. */
  icon?: "search" | "error" | "none";
}) {
  return (
    <EmptyState
      size="inline"
      // Under the redesign only, so it leads like every other inline state.
      icon={
        icon === "none" ? undefined : icon === "error" ? (
          <Icon icon={WarningCircle} size="sm" className="text-danger" />
        ) : (
          // Quiet, so the field's glass stays the one search mark.
          <Icon icon={MagnifyingGlass} kind="symbol" size="sm" className="text-text-tertiary" />
        )
      }
      iconClassName="hidden redesign:block"
      title={title}
      body={hint}
      className="h-full justify-center gap-1 px-8"
      titleClassName="text-sm text-text"
      bodyClassName="text-xs text-text-muted"
    />
  );
}
