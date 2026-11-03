import { SEARCH_QUERY_MIN_LENGTH, type MessageSearchResult } from "@pqp/shared";
import { Hash, MagnifyingGlass, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HeaderPopover } from "@/components/chat/header-popover";
import { Snippet } from "@/components/search/search-dialog";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import { memberDisplayName, searchServerMessages, type ServerMember } from "@/lib/api";
import { messageLinkState, messageRoutePath } from "@/lib/app-route";
import { useTranslation } from "@/lib/i18n";
import {
  addChip,
  chipFilters,
  matchByName,
  searchWords,
  trailingChipToken,
  type SearchChip,
  type SearchChipKind,
  type SearchChipPrefixes,
} from "@/lib/search-chips";
import { cn, formatRecency } from "@/lib/utils";

/*
 * The search in the channel header under the redesign (the text channels
 * canvas, "Painéis", 1. Buscar, com filtros; "Atalhos": Ctrl F). A field in
 * the header from 1100 px up, a magnifier below that; either opens a popover
 * under it with the words, the filters as chips, where to look and the
 * results grouped by channel. Enter goes to the message, which flashes.
 */

const DEBOUNCE_MS = 300;
const WIDTH = 480;
const LIST_ID = "header-search-results";

type Status = "idle" | "loading" | "ready" | "error";

type HasValue = "link" | "image" | "file";
const HAS_VALUES: readonly HasValue[] = ["link", "image", "file"];

export interface HeaderSearchProps {
  serverId: string;
  serverName: string;
  channel: { id: string; name: string };
  members: readonly ServerMember[];
  /** The server's channels a hit can be in, for `em:`. */
  channels: readonly { id: string; name: string }[];
  /** "Ctrl F" or "⌘F". */
  shortcut: string;
  /** The header's icon-tile look, used below 1100 px. */
  tileClassName: string;
}

export function HeaderSearch({
  serverId,
  serverName,
  channel,
  members,
  channels,
  shortcut,
  tileClassName,
}: HeaderSearchProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl F (⌘F) opens it, before the sidebar's own search can take the key.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(true);
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const label = t("search.header.trigger", { name: channel.name });
  return (
    <>
      <button
        type="button"
        data-header-search=""
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="hidden h-9 w-56 shrink-0 items-center gap-2 rounded-full border border-[color:var(--input-border)] bg-[color:var(--input-bg)] pl-3 pr-2 text-left text-[13px] text-text-tertiary hover:border-[color:var(--input-hover-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent min-[1100px]:flex"
      >
        <Icon icon={MagnifyingGlass} size="sm" kind="symbol" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <kbd className="shrink-0 rounded-[var(--radius-tick)] bg-[color:var(--color-surface-3)] px-1.5 font-sans text-[11px] font-semibold text-text-secondary">
          {shortcut}
        </kbd>
      </button>
      <Tooltip label={`${t("chrome.searchMessages")} · ${shortcut}`}>
        <button
          type="button"
          data-header-search=""
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className={cn(tileClassName, "min-[1100px]:hidden")}
        >
          <Icon icon={MagnifyingGlass} size="sm" kind="symbol" className="h-[1.125rem] w-[1.125rem]" />
        </button>
      </Tooltip>
      <HeaderPopover
        open={open}
        anchorSelector="[data-header-search]"
        width={WIDTH}
        label={t("chrome.searchMessages")}
        initialFocus={inputRef}
        onClose={() => setOpen(false)}
        data-header-search-popover=""
      >
        <SearchPanel
          inputRef={inputRef}
          serverId={serverId}
          serverName={serverName}
          channel={channel}
          members={members}
          channels={channels}
          onDone={() => setOpen(false)}
        />
      </HeaderPopover>
    </>
  );
}

function SearchPanel({
  inputRef,
  serverId,
  serverName,
  channel,
  members,
  channels,
  onDone,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  serverId: string;
  serverName: string;
  channel: { id: string; name: string };
  members: readonly ServerMember[];
  channels: readonly { id: string; name: string }[];
  onDone: () => void;
}) {
  const { t, locale } = useTranslation();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [chips, setChips] = useState<SearchChip[]>([]);
  const [scope, setScope] = useState<"channel" | "server">("channel");
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [active, setActive] = useState(0);
  const dateId = useId();

  const prefixes: SearchChipPrefixes = useMemo(
    () => ({
      de: t("search.chip.de"),
      em: t("search.chip.em"),
      tem: t("search.chip.tem"),
      antes: t("search.chip.antes"),
      depois: t("search.chip.depois"),
      menciona: t("search.chip.menciona"),
    }),
    [t],
  );
  const prefix = (kind: SearchChipKind) => prefixes[kind] ?? kind;
  const hasLabel = (value: HasValue) => t(`search.has.${value}`);

  const token = trailingChipToken(text, prefixes);
  const words = searchWords(text, prefixes);
  const channelChip = chips.some((chip) => chip.kind === "em");
  const filters = useMemo(
    () => chipFilters(chips, scope === "channel" ? channel.id : null),
    [chips, scope, channel.id],
  );
  const filterKey = JSON.stringify(filters);
  const searchable = words.length >= SEARCH_QUERY_MIN_LENGTH;

  useEffect(() => {
    if (!searchable) {
      setResults([]);
      setHasMore(false);
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    setStatus("loading");
    const timer = window.setTimeout(() => {
      void searchServerMessages(
        serverId,
        { q: words, filters: JSON.parse(filterKey) as typeof filters },
        controller.signal,
      )
        .then((page) => {
          setResults(page.results);
          setHasMore(page.hasMore);
          setActive(0);
          setStatus("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setStatus("error");
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchable, words, filterKey, serverId]);

  // The rows in the order they are drawn: grouped by channel, first hit first.
  const groups = useMemo(() => {
    const byChannel = new Map<string, { name: string; rows: MessageSearchResult[] }>();
    for (const result of results) {
      const group = byChannel.get(result.channelId) ?? { name: result.channelName, rows: [] };
      group.rows.push(result);
      byChannel.set(result.channelId, group);
    }
    return [...byChannel.entries()];
  }, [results]);
  const ordered = useMemo(() => groups.flatMap(([, group]) => group.rows), [groups]);

  const openResult = useCallback(
    (result: MessageSearchResult) => {
      navigate(messageRoutePath(serverId, result.channelId, result.messageId), {
        state: messageLinkState(),
      });
      onDone();
    },
    [navigate, onDone, serverId],
  );

  const placeChip = (chip: SearchChip) => {
    setChips((prev) => addChip(prev, chip));
    setText((prev) => {
      const current = trailingChipToken(prev, prefixes);
      return current ? prev.slice(0, current.start) : prev;
    });
    inputRef.current?.focus();
  };

  const insertPrefix = (kind: SearchChipKind) => {
    setText((prev) => `${prev.trimEnd()}${prev.trim() ? " " : ""}${prefix(kind)}:`);
    inputRef.current?.focus();
  };

  // What the half-typed filter can become.
  const suggestions: { key: string; label: string; detail?: string; chip: SearchChip; avatar?: ServerMember }[] =
    useMemo(() => {
      if (!token) {
        return [];
      }
      if (token.kind === "de" || token.kind === "menciona") {
        return matchByName(members, token.partial, (m) => [memberDisplayName(m), m.displayName, m.username]).map(
          (m) => ({
            key: m.id,
            label: memberDisplayName(m),
            detail: m.tag ?? undefined,
            avatar: m,
            chip: { kind: token.kind as "de" | "menciona", id: m.id, label: memberDisplayName(m) },
          }),
        );
      }
      if (token.kind === "em") {
        return matchByName(channels, token.partial, (c) => [c.name]).map((c) => ({
          key: c.id,
          label: `#${c.name}`,
          chip: { kind: "em", id: c.id, label: `#${c.name}` },
        }));
      }
      if (token.kind === "tem") {
        return HAS_VALUES.filter((value) => hasLabel(value).startsWith(token.partial.toLowerCase())).map(
          (value) => ({ key: value, label: hasLabel(value), chip: { kind: "tem", value, label: hasLabel(value) } }),
        );
      }
      return [];
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token?.kind, token?.partial, members, channels, t]);
  const dateToken = token && (token.kind === "antes" || token.kind === "depois") ? token.kind : null;

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && text === "" && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1));
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => Math.max(0, Math.min(ordered.length - 1, current + step)));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (suggestions[0]) {
        placeChip(suggestions[0].chip);
        return;
      }
      const target = ordered[active];
      if (target) {
        openResult(target);
      }
    }
  }

  const chipClass =
    "inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-[color:var(--color-accent-soft)] pl-2 pr-1 text-xs font-semibold text-[color:var(--color-on-accent-soft)]";
  const optionClass =
    "inline-flex h-7 items-center rounded-full border border-[color:var(--input-border)] px-2.5 text-xs font-medium text-text-secondary hover:border-[color:var(--input-hover-border)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

  const activeId = ordered[active] ? `header-search-${ordered[active]!.messageId}` : undefined;

  return (
    <>
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-1.5 border-b border-[color:var(--pane-header-rule)] px-3.5 py-2">
        <Icon icon={MagnifyingGlass} size="sm" kind="symbol" className="text-text-tertiary" />
        {chips.map((chip) => (
          <span key={chip.kind} className={chipClass} data-search-chip={chip.kind}>
            {prefix(chip.kind)}: {chip.label}
            <button
              type="button"
              aria-label={t("search.removeChip", { label: `${prefix(chip.kind)}: ${chip.label}` })}
              onClick={() => setChips((prev) => prev.filter((c) => c.kind !== chip.kind))}
              className="grid h-4 w-4 place-items-center rounded-full hover:bg-[color:color-mix(in_oklab,currentColor_15%,transparent)]"
            >
              <Icon icon={X} size="sm" kind="symbol" className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={chips.length ? undefined : t("chrome.searchMessages")}
          aria-label={t("chrome.searchMessages")}
          role="combobox"
          aria-expanded={ordered.length > 0}
          aria-controls={LIST_ID}
          aria-activedescendant={activeId}
          className="min-w-[8rem] flex-1 bg-transparent text-sm text-text placeholder:text-text-tertiary focus-visible:outline-none"
        />
      </div>

      {token && (suggestions.length > 0 || dateToken) ? (
        <div className="shrink-0 border-b border-[color:var(--pane-header-rule)] py-1" data-search-suggestions="">
          {dateToken ? (
            <label htmlFor={dateId} className="flex items-center gap-2 px-3.5 py-1.5 text-xs text-text-secondary">
              {prefix(dateToken)}:
              <input
                id={dateId}
                type="date"
                autoFocus
                onChange={(event) => {
                  const day = event.target.value;
                  if (day) {
                    const shown = new Date(`${day}T12:00:00`).toLocaleDateString(locale, {
                      day: "numeric",
                      month: "short",
                    });
                    placeChip({ kind: dateToken, day, label: shown });
                  }
                }}
                className="rounded-md border border-[color:var(--input-border)] bg-[color:var(--input-bg)] px-2 py-1 text-text [color-scheme:dark] light:[color-scheme:light]"
              />
            </label>
          ) : (
            suggestions.map((item, index) => (
              <button
                key={item.key}
                type="button"
                onClick={() => placeChip(item.chip)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left text-sm hover:bg-[color:var(--list-row-hover)]",
                  index === 0 && "bg-[color:var(--list-row-hover)]",
                )}
              >
                {item.avatar ? (
                  <UserAvatar
                    name={item.label}
                    avatarUrl={item.avatar.avatarUrl}
                    rounded="full"
                    className="h-6 w-6"
                  />
                ) : token.kind === "em" ? (
                  <Icon icon={Hash} size="sm" kind="symbol" className="text-text-tertiary" />
                ) : null}
                <span className="truncate text-text">{item.label}</span>
                {item.detail && <span className="truncate text-xs text-text-tertiary">{item.detail}</span>}
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-[color:var(--pane-header-rule)] px-3.5 py-2">
          <button type="button" className={optionClass} onClick={() => insertPrefix("de")}>
            {prefix("de")}:
          </button>
          <button type="button" className={optionClass} onClick={() => insertPrefix("em")}>
            {prefix("em")}:
          </button>
          <button
            type="button"
            className={optionClass}
            onClick={() => placeChip({ kind: "tem", value: "image", label: hasLabel("image") })}
          >
            {prefix("tem")}: {hasLabel("image")}
          </button>
          <button
            type="button"
            className={optionClass}
            onClick={() => placeChip({ kind: "tem", value: "file", label: hasLabel("file") })}
          >
            {prefix("tem")}: {hasLabel("file")}
          </button>
          <button type="button" className={optionClass} onClick={() => insertPrefix("antes")}>
            {prefix("antes")}:
          </button>
          <button type="button" className={optionClass} onClick={() => insertPrefix("menciona")}>
            {prefix("menciona")}:
          </button>
        </div>
      )}

      {!channelChip && (
        <div className="flex shrink-0 items-center gap-1 px-3.5 pt-2.5 pb-1.5">
          <div role="radiogroup" aria-label={t("search.scopeLabel")} className="flex gap-1">
            {(["channel", "server"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                onClick={() => setScope(value)}
                className={cn(
                  "h-7 rounded-full px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  scope === value
                    ? "bg-[color:var(--color-surface-3)] text-text"
                    : "text-text-tertiary hover:text-text",
                )}
              >
                {value === "channel" ? t("search.scopeChannel") : t("search.scopeServer", { name: serverName })}
              </button>
            ))}
          </div>
          {status === "ready" && results.length > 0 && (
            <span className="ml-auto text-xs text-text-tertiary tabular-nums">
              {hasMore
                ? t("search.countMore", { count: results.length })
                : t("search.count", { count: results.length })}
            </span>
          )}
        </div>
      )}

      <div id={LIST_ID} role="listbox" className="min-h-0 flex-1 overflow-y-auto pb-1">
        {status === "loading" && (
          <p role="status" className="flex items-center gap-2 px-3.5 py-5 text-sm text-text-tertiary">
            <Spinner className="h-4 w-4" />
            {t("search.searching")}
          </p>
        )}
        {status === "idle" && (
          <p className="px-3.5 py-5 text-center text-[13px] text-text-tertiary">{t("search.typeMore")}</p>
        )}
        {status === "error" && (
          <p role="alert" className="px-3.5 py-5 text-center text-[13px] text-danger">
            {t("search.failed")}
          </p>
        )}
        {status === "ready" && results.length === 0 && (
          <p className="px-3.5 py-5 text-center text-[13px] text-text-tertiary">{t("search.nothing")}</p>
        )}
        {status === "ready" &&
          groups.map(([channelId, group]) => (
            <div key={channelId} role="group" aria-label={`#${group.name}`}>
              <p className="px-3.5 pb-1 pt-2.5 text-xs font-semibold text-text-tertiary">
                {group.name} · {group.rows.length}
              </p>
              {group.rows.map((result) => {
                const index = ordered.indexOf(result);
                return (
                  <button
                    key={result.messageId}
                    id={`header-search-${result.messageId}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    onMouseMove={() => setActive(index)}
                    onClick={() => openResult(result)}
                    className={cn(
                      "grid w-full grid-cols-[32px_minmax(0,1fr)] gap-2.5 px-3.5 py-2 text-left",
                      index === active && "bg-[color:var(--list-row-hover)]",
                    )}
                  >
                    <UserAvatar
                      name={result.authorName}
                      avatarUrl={result.authorAvatarUrl}
                      rounded="full"
                      className="h-8 w-8"
                    />
                    <span className="min-w-0">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-semibold text-text">{result.authorName}</span>
                        <span className="shrink-0 text-xs text-text-tertiary">
                          {formatRecency(result.createdAt, locale)}
                        </span>
                      </span>
                      <span className="mt-0.5 line-clamp-2 break-words text-sm leading-5 text-text-secondary">
                        <Snippet snippet={result.snippet} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
      </div>

      <p className="shrink-0 border-t border-[color:var(--pane-header-rule)] px-3.5 py-2 text-xs text-text-tertiary">
        {t("search.footer")}
      </p>
    </>
  );
}
