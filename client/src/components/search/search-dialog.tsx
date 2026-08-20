import {
  parseSearchSnippet,
  SEARCH_QUERY_MIN_LENGTH,
  type MessageSearchResult,
} from "@pqp/shared";
import { Hash, Loader2, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { searchServerMessages } from "@/lib/api";
import { messageRoutePath } from "@/lib/app-route";
import { useTranslation } from "@/lib/i18n";
import { cn, formatDayLabel, formatFullTimestamp } from "@/lib/utils";
import { appendUniqueResults, clampSelection } from "./search-results";

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
}

export function SearchDialog({
  open,
  serverId,
  serverName,
  onClose,
  onNavigate,
}: SearchDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState(0);

  const navigate = useNavigate();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const trimmed = query.trim();
  const searchable = trimmed.length >= SEARCH_QUERY_MIN_LENGTH;

  // Reopening starts a new search rather than resurrecting the last one: the
  // channel you were looking for is rarely the one you were looking for before.
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
      navigate(messageRoutePath(serverId, result.channelId, result.messageId));
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
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
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
            className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
          />
          {status === "loading" && (
            <Loader2
              aria-hidden="true"
              className="h-4 w-4 shrink-0 animate-spin text-text-muted"
            />
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {status === "error" ? (
            <EmptyState
              title={t("search.unavailable")}
              hint={t("search.unavailableHint")}
            />
          ) : !searchable ? (
            <EmptyState
              title={t("search.prompt")}
              hint={t("search.minChars", { count: SEARCH_QUERY_MIN_LENGTH })}
            />
          ) : status === "loading" && results.length === 0 ? (
            <EmptyState title={t("search.searching")} />
          ) : results.length === 0 ? (
            <EmptyState
              title={t("search.noMatch", { query: trimmed })}
              hint={t("search.wholeWords")}
            />
          ) : (
            <>
              <ul
                id={LISTBOX_ID}
                role="listbox"
                aria-label={t("search.results")}
                className="p-2"
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
                      onMouseEnter={() => setSelected(index)}
                      onClick={() => openResult(result)}
                      className={cn(
                        "w-full rounded-md border border-transparent px-3 py-2 text-left outline-none",
                        index === selected
                          ? "border-border-strong bg-surface-2"
                          : "hover:bg-surface-2/60",
                      )}
                    >
                      <div className="flex items-baseline gap-2 text-xs text-text-muted">
                        <span className="flex min-w-0 items-center gap-1 font-medium text-text">
                          <Hash className="h-3 w-3 shrink-0" />
                          <span className="truncate">{result.channelName}</span>
                        </span>
                        <span className="truncate">{result.authorName}</span>
                        <time
                          dateTime={result.createdAt}
                          title={formatFullTimestamp(result.createdAt)}
                          className="ml-auto shrink-0"
                        >
                          {formatDayLabel(result.createdAt)}
                        </time>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-text-muted">
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
            className="rounded-sm bg-accent/25 px-0.5 font-medium text-text"
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

function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center">
      <p className="text-sm text-text">{title}</p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
