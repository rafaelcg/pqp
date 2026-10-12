import type { UserStatus } from "@pqp/shared";
import { Hash, Search, Volume2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBadgeCount } from "@/components/layout/channel-list";
import { ServerIcon } from "@/components/layout/server-identity";
import { Dialog } from "@/components/ui/dialog";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import {
  quickSwitcherItems,
  type SwitcherItem,
  type SwitcherSources,
} from "@/lib/quick-switcher";
import { cn } from "@/lib/utils";

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent);

/** The chord as the keyboard prints it: "⌘K" on Apple, "Ctrl K" elsewhere. */
export function modChord(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl ${key}`;
}

type Row =
  | { type: "item"; item: SwitcherItem }
  | { type: "search"; id: "search" };

interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
  sources: SwitcherSources;
  /** Message search lives with a server; null in Conversas. */
  searchServerName: string | null;
  onOpenConversation: (channelId: string) => void;
  onMessagePerson: (userId: string) => void;
  onSelectServer: (serverId: string) => void;
  onSelectChannel: (channelId: string) => void;
  onSearchMessages: (query: string) => void;
}

/**
 * CONVERSAS: Ctrl/Cmd+K, "pra onde tu quer ir?". People, conversations,
 * servers and the open server's channels, all from what the app already holds
 * (no request per keystroke). The last row hands the words to message search,
 * which moved to Ctrl/Cmd+F, so nothing the old K did is lost.
 */
export function QuickSwitcher({
  open,
  onClose,
  sources,
  searchServerName,
  onOpenConversation,
  onMessagePerson,
  onSelectServer,
  onSelectChannel,
  onSearchMessages,
}: QuickSwitcherProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listboxId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const items = useMemo(() => quickSwitcherItems(query, sources), [query, sources]);
  const rows: Row[] = useMemo(() => {
    const list: Row[] = items.map((item) => ({ type: "item", item }));
    if (searchServerName && query.trim()) {
      list.push({ type: "search", id: "search" });
    }
    return list;
  }, [items, searchServerName, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-switcher-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(row: Row | undefined) {
    if (!row) {
      return;
    }
    onClose();
    if (row.type === "search") {
      onSearchMessages(query.trim());
      return;
    }
    const item = row.item;
    switch (item.kind) {
      case "person":
        if (item.channelId) {
          onOpenConversation(item.channelId);
        } else {
          onMessagePerson(item.person.id);
        }
        return;
      case "conversation":
        onOpenConversation(item.conversation.channelId);
        return;
      case "server":
        onSelectServer(item.id.slice("server:".length));
        return;
      case "channel":
        onSelectChannel(item.id.slice("channel:".length));
        return;
    }
  }

  const sectionOf = (row: Row): string =>
    row.type === "search" ? "search" : row.item.kind;
  const sectionLabel: Record<string, string> = {
    person: t("switcher.section.people"),
    conversation: t("switcher.section.conversations"),
    server: t("switcher.section.servers"),
    channel: t("switcher.section.channels"),
  };

  return (
    <Dialog
      open={open}
      title={t("switcher.title")}
      size="md"
      onClose={onClose}
      headerClassName="sr-only"
    >
      <div data-quick-switcher="" className="flex flex-col">
        <div className="border-b border-border p-3">
          <label className="flex h-11 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 transition-colors duration-[var(--duration-fast)] focus-within:border-accent">
            <Search className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listboxId}
              aria-activedescendant={rows[active] ? `${listboxId}-${active}` : undefined}
              aria-label={t("switcher.title")}
              data-quick-switcher-input=""
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => Math.min(rows.length - 1, index + 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => Math.max(0, index - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  choose(rows[active]);
                }
              }}
              placeholder={t("switcher.placeholder")}
              className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-tertiary/70 focus-visible:outline-none"
              spellCheck={false}
              autoComplete="off"
            />
            <span className="hidden shrink-0 text-[11px] text-text-tertiary sm:inline">
              {t("switcher.scope")}
            </span>
          </label>
        </div>

        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={t("switcher.title")}
          className="max-h-[min(55vh,26rem)] overflow-y-auto p-2"
        >
          {rows.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-text-tertiary">
              {query.trim() ? t("switcher.empty") : t("switcher.emptyStart")}
            </p>
          ) : (
            rows.map((row, index) => {
              const section = sectionOf(row);
              const showLabel =
                section !== "search" && (index === 0 || sectionOf(rows[index - 1]!) !== section);
              return (
                <div key={row.type === "search" ? "search" : row.item.id}>
                  {showLabel && (
                    <p className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                      {sectionLabel[section]}
                    </p>
                  )}
                  <SwitcherRow
                    id={`${listboxId}-${index}`}
                    index={index}
                    active={index === active}
                    onHover={() => setActive(index)}
                    onChoose={() => choose(row)}
                  >
                    {row.type === "search" ? (
                      <>
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center text-text-tertiary">
                          <Search className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
                          {t("switcher.searchMessages", {
                            query: query.trim(),
                            server: searchServerName ?? "",
                          })}
                        </span>
                        <Kbd>{modChord("F")}</Kbd>
                      </>
                    ) : (
                      <ItemBody item={row.item} active={index === active} />
                    )}
                  </SwitcherRow>
                </div>
              );
            })
          )}
        </div>

        <div className="hidden items-center gap-3 border-t border-border px-4 py-2.5 text-[11px] text-text-tertiary sm:flex">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("switcher.hint.move")}
          </span>
          <span className="flex items-center gap-1">
            <Kbd>Enter</Kbd>
            {t("switcher.hint.open")}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>Esc</Kbd>
            {t("switcher.hint.close")}
          </span>
        </div>
      </div>
    </Dialog>
  );
}

function SwitcherRow({
  id,
  index,
  active,
  onHover,
  onChoose,
  children,
}: {
  id: string;
  index: number;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-switcher-index={index}
      data-switcher-active={active ? "" : undefined}
      onMouseMove={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5",
        active ? "bg-surface-3" : "hover:bg-surface-3/50",
      )}
    >
      {children}
    </div>
  );
}

function ItemBody({ item, active }: { item: SwitcherItem; active: boolean }) {
  const { t } = useTranslation();
  switch (item.kind) {
    case "person":
      return (
        <>
          <Face name={item.person.displayName} avatarUrl={item.person.avatarUrl} status={item.status} />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-text">{item.person.displayName}</span>
            <span className="truncate text-xs text-text-tertiary">
              {item.friend ? t("switcher.friend") : (item.person.tag ?? "")}
            </span>
          </span>
          <Trailing unread={item.unread} active={active} label={item.channelId ? t("switcher.open") : t("friends.message")} />
        </>
      );
    case "conversation":
      return (
        <>
          <span className="relative h-8 w-8 shrink-0" aria-hidden="true">
            {item.conversation.participants.slice(0, 2).map((person, i) => (
              <UserAvatar
                key={person.id}
                name={person.displayName}
                avatarUrl={person.avatarUrl}
                className={cn("absolute h-6 w-6", i === 0 ? "left-0 top-0" : "bottom-0 right-0 ring-2 ring-surface-2")}
                fallbackClassName="bg-surface-1 text-[9px] text-text"
                rounded="full"
              />
            ))}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
            {item.title}
            <span className="ml-1.5 text-[11px] text-text-tertiary">
              {item.conversation.participants.length + 1}
            </span>
          </span>
          <Trailing unread={item.unread} active={active} label={t("switcher.open")} />
        </>
      );
    case "server":
      return (
        <>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-control)] bg-surface-1 text-[11px] font-bold text-text">
            <ServerIcon name={item.name} iconUrl={item.iconUrl} />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{item.name}</span>
          <Trailing unread={0} active={active} label={t("switcher.open")} />
        </>
      );
    case "channel":
      return (
        <>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center text-text-tertiary">
            {item.type === "voice" ? (
              <Volume2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Hash className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{item.name}</span>
          <span className="shrink-0 truncate text-xs text-text-tertiary">{item.serverName}</span>
        </>
      );
  }
}

function Face({
  name,
  avatarUrl,
  status,
}: {
  name: string;
  avatarUrl?: string | null;
  status: UserStatus | null;
}) {
  return (
    <span className="relative shrink-0">
      <UserAvatar
        name={name}
        avatarUrl={avatarUrl ?? null}
        className="h-8 w-8"
        fallbackClassName="bg-surface-1 text-xs font-semibold text-text"
        rounded="full"
      />
      {status && (
        <StatusDot
          status={status}
          className="absolute -bottom-0.5 -right-0.5 bg-surface-2"
          ringClassName="rounded-full ring-2 ring-surface-2"
        />
      )}
    </span>
  );
}

function Trailing({ unread, active, label }: { unread: number; active: boolean; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-2">
      {unread > 0 && (
        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none tabular-nums text-on-danger">
          {formatBadgeCount(unread)}
        </span>
      )}
      {active && (
        <>
          <span className="hidden text-xs text-text-tertiary sm:inline">{label}</span>
          <Kbd>Enter</Kbd>
        </>
      )}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[var(--radius-tick)] border border-border-strong px-1 font-sans text-[10px] font-semibold text-text-secondary">
      {children}
    </kbd>
  );
}
