import { Hash, Volume2 } from "lucide-react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  AutocompleteMenu,
  type AutocompleteOption,
} from "@/components/chat/autocomplete-menu";
import {
  applyChannel,
  filterChannels,
  findChannelQuery,
  parseChannelParts,
  type ChannelLike,
  type ChannelQuery,
} from "@/lib/community-home/channel-refs";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * `#channel` in a Baú post: the reader side (links) and the composer side
 * (the `#` picker). The grammar and the privacy rule live in
 * `lib/community-home/channel-refs.ts`; this file only draws them.
 */

interface ChannelRefsContextValue {
  serverId: string;
  channels: readonly ChannelLike[];
  /** Same path as the channel list. Absent: the link is a plain address. */
  onOpenChannel?: (channelId: string) => void;
}

const ChannelRefsContext = createContext<ChannelRefsContextValue>({
  serverId: "",
  channels: [],
});

/**
 * Provided once by the feed. `channels` is the list this viewer's sidebar
 * shows, which is exactly what they may be told the name of.
 */
export function ChannelRefsProvider({
  serverId,
  channels,
  onOpenChannel,
  children,
}: ChannelRefsContextValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({ serverId, channels, onOpenChannel }),
    [serverId, channels, onOpenChannel],
  );
  return (
    <ChannelRefsContext.Provider value={value}>
      {children}
    </ChannelRefsContext.Provider>
  );
}

/** Text with its `#channel` references drawn as links. */
export function ChannelText({ text }: { text: string }) {
  const { t } = useTranslation();
  const { serverId, channels, onOpenChannel } = useContext(ChannelRefsContext);
  const parts = useMemo(
    () => parseChannelParts(text, channels),
    [text, channels],
  );

  return (
    <>
      {parts.map((part, index) => {
        if (part.type === "text") {
          return <span key={index}>{part.value}</span>;
        }
        if (part.type === "unavailable") {
          // The body held an id; this reader cannot resolve it, so it gets no
          // name and no link, only the fact that a channel was meant.
          return (
            <span
              key={index}
              className="rounded bg-ink-4/60 px-1 text-paper-muted"
              title={t("communityHome.channelRef.unavailableTitle")}
              data-home-channel-ref="unavailable"
            >
              #{t("communityHome.channelRef.unavailable")}
            </span>
          );
        }
        return (
          <a
            key={index}
            href={`/app/server/${serverId}/channel/${part.id}`}
            className="rounded bg-signal/10 px-1 font-medium text-signal hover:bg-signal/20 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
            title={t("communityHome.channelRef.open", { name: part.name })}
            data-home-channel-ref="link"
            data-channel-id={part.id}
            onClick={(event) => {
              if (
                !onOpenChannel ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.button !== 0
              ) {
                return;
              }
              event.preventDefault();
              onOpenChannel(part.id);
            }}
          >
            #{part.name}
          </a>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------- picker

export interface ChannelPicker {
  /** The dropdown, or null when the caret is not inside a `#token`. */
  menu: ReactNode;
  /** Call from the textarea's `onKeyDown`; true when the key was consumed. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Call whenever the caret may have moved (change, click, keyup, select). */
  syncCaret: (field: HTMLTextAreaElement) => void;
}

/**
 * The `#` dropdown for a textarea: filter as you type, arrows and
 * Enter/Tab to pick, Escape to dismiss, mouse to click. It reuses the chat
 * composer's `AutocompleteMenu`; the keyboard stays here because this owns the
 * caret.
 */
export function useChannelPicker({
  value,
  channels,
  onInsert,
}: {
  value: string;
  channels: readonly ChannelLike[];
  /** Receives the new text and where the caret belongs afterwards. */
  onInsert: (next: string, caret: number) => void;
}): ChannelPicker {
  const { t } = useTranslation();
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  // Escape closes the menu for this token only; typing on reopens it.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const active: ChannelQuery | null = useMemo(() => {
    const found = findChannelQuery(value, caret);
    return found && found.start !== dismissedAt ? found : null;
  }, [value, caret, dismissedAt]);

  const matches = useMemo(
    () => (active ? filterChannels(channels, active.query) : []),
    [active, channels],
  );
  const open = active !== null && matches.length > 0;
  const index = Math.min(selected, Math.max(0, matches.length - 1));

  function pick(at: number) {
    const channel = matches[at];
    if (!active || !channel) {
      return;
    }
    const next = applyChannel(value, active, channel, channels);
    setSelected(0);
    setCaret(next.caret);
    onInsert(next.value, next.caret);
  }

  const options: AutocompleteOption[] = matches.map((channel) => ({
    id: channel.id,
    primary: `#${channel.name}`,
    secondary: channel.topic || undefined,
    leading:
      channel.type === "voice" ? (
        <Volume2 className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
      ) : (
        <Hash className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
      ),
  }));

  return {
    menu: open ? (
      <AutocompleteMenu
        label={t("communityHome.compose.channelPickerLabel")}
        heading={t("communityHome.compose.channelPickerHeading")}
        emptyLabel={t("communityHome.compose.channelPickerEmpty")}
        options={options}
        selectedIndex={index}
        placement="below"
        onSelect={pick}
        onHover={setSelected}
      />
    ) : null,
    handleKeyDown(event) {
      if (!open) {
        return false;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSelected((index + step + matches.length) % matches.length);
        return true;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        pick(index);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(active?.start ?? null);
        return true;
      }
      return false;
    },
    syncCaret(field) {
      const next = field.selectionStart ?? field.value.length;
      if (next !== caret) {
        setSelected(0);
      }
      setCaret(next);
      if (dismissedAt !== null && findChannelQuery(field.value, next)?.start !== dismissedAt) {
        setDismissedAt(null);
      }
    },
  };
}

/** The muted one-liner under the composer that says the picker exists. */
export function ChannelPickerHint({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={cn("text-[11px] text-paper-muted", className)}>
      {t("communityHome.compose.channelHint")}
    </span>
  );
}
