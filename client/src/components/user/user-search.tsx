import type { PublicUser } from "@pqp/shared";
import { Loader2, Search } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { AutocompleteMenu } from "@/components/chat/autocomplete-menu";
import { clampSelection } from "@/components/search/search-results";
import { ApiError, lookupUserByTag, searchUsers } from "@/lib/api";
import { excludeUsers, readUserQuery } from "@/lib/user-search";
import { cn } from "@/lib/utils";

/** Same as message search: one typed word is one request, and it still feels live. */
const DEBOUNCE_MS = 300;

interface UserSearchProps {
  /** Accessible name for the field — this is a bare input, not a labelled row. */
  label: string;
  placeholder?: string;
  /**
   * People who must not be offered: the caller themselves, and anybody already
   * picked. Passed in rather than filtered by the server, which cannot know
   * what a half-assembled group already contains.
   */
  excludeIds?: readonly string[];
  autoFocus?: boolean;
  onSelect: (user: PublicUser) => void;
}

/**
 * The one people-picker: type a handle or the start of one, get users back.
 *
 * Shared with any later member picker rather than owned by the new-DM dialog,
 * because searching for a person is one behaviour with one set of rules — the
 * minimum length, the exact-handle branch, and above all which fields of a user
 * a stranger is allowed to see. A second copy of this is a second chance to
 * render a field that should never have left the server.
 */
export function UserSearch({
  label,
  placeholder = "Search by name or name#0000",
  excludeIds = [],
  autoFocus = false,
  onSelect,
}: UserSearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const listboxId = useId();

  const request = readUserQuery(query);
  const searching = request.kind !== "idle";
  // Split into two primitives so the effect below re-runs on what was asked
  // rather than on the identity of a fresh object every keystroke.
  const mode = request.kind;
  const value = request.kind === "tag" ? request.tag : request.kind === "prefix" ? request.query : "";

  useEffect(() => {
    if (mode === "idle") {
      setResults([]);
      setLoading(false);
      setFailed(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setFailed(false);

    const timer = window.setTimeout(() => {
      const pending: Promise<PublicUser[]> =
        mode === "tag"
          ? lookupUserByTag(value, controller.signal)
              .then((response) => [response.user])
              // A handle nobody holds is an answer, not a failure. Reporting it
              // as one would tell the user the search is broken when what they
              // actually did was mistype a number.
              .catch((error: unknown) => {
                if (error instanceof ApiError && error.status === 404) {
                  return [];
                }
                throw error;
              })
          : searchUsers(value, controller.signal).then(
              (response) => response.users,
            );
      void pending
        .then((users) => {
          setResults(users);
          setSelected(0);
          setLoading(false);
        })
        .catch(() => {
          // A superseded keystroke is not a failure — its replacement is
          // already in flight, and reporting it would blink an error on every
          // character typed.
          if (controller.signal.aborted) {
            return;
          }
          setResults([]);
          setFailed(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [mode, value]);

  const visible = excludeUsers(results, excludeIds);

  function choose(index: number) {
    const user = visible[index];
    if (!user) {
      return;
    }
    onSelect(user);
    // A picked name is an answered question: leaving the text behind would
    // re-run the same search and re-offer somebody already added.
    setQuery("");
    setResults([]);
    setSelected(0);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((current) =>
        clampSelection(current, event.key === "ArrowDown" ? 1 : -1, visible.length),
      );
      return;
    }
    if (event.key === "Enter" && visible.length > 0) {
      event.preventDefault();
      choose(selected);
    }
  }

  return (
    <div className="relative">
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border border-border bg-surface-0/60 px-2.5 py-2",
          "focus-within:border-border-strong",
        )}
      >
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        <input
          value={query}
          autoFocus={autoFocus}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={label}
          role="combobox"
          aria-expanded={searching}
          aria-controls={listboxId}
          aria-autocomplete="list"
          className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
        />
        {loading && (
          <Loader2
            aria-hidden="true"
            className="h-4 w-4 shrink-0 animate-spin text-text-muted"
          />
        )}
      </div>

      {searching && (
        <AutocompleteMenu
          id={listboxId}
          label={label}
          heading="People"
          placement="below"
          emptyLabel={
            failed
              ? "Search is unavailable right now."
              : loading
                ? "Searching…"
                : "Nobody matched. Handles are exact — try name#0000."
          }
          options={visible.map((user) => ({
            id: user.id,
            primary: user.displayName,
            secondary: user.tag ?? undefined,
            leading: <Avatar user={user} />,
          }))}
          selectedIndex={selected}
          onSelect={choose}
          onHover={setSelected}
        />
      )}
    </div>
  );
}

function Avatar({ user }: { user: PublicUser }) {
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        loading="lazy"
        // The avatar is a URL the account owner typed. Telling whatever host it
        // points at which deployment is reading it is not part of the deal.
        referrerPolicy="no-referrer"
        className="h-6 w-6 shrink-0 rounded-md object-cover"
      />
    );
  }
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[11px] font-semibold text-text">
      {user.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}
