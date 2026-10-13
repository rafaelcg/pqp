import { AtSign, Headphones, ImagePlus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { authorInRoom } from "@/lib/stories/call-room";
import { filterPeople, type MentionPerson } from "@/lib/stories/mention-people";
import { cn } from "@/lib/utils";
import type { ComposerVoiceRoom } from "./story-composer";

/**
 * The stickers tray and the two pickers behind it. All three rise as a sheet
 * inside the composer's column, over the bottom of the canvas, the way the
 * audience sheet does.
 */

export function ComposerSheet({
  title,
  hint,
  onClose,
  children,
  testId,
  focusClose = true,
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
  /** Focus lands on the close button; a sheet with a field of its own sets this false. */
  focusClose?: boolean;
}) {
  const { t } = useTranslation();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusClose) {
      close.current?.focus({ preventScroll: true });
    }
  }, [focusClose]);
  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("stories.compose.close")}
        className="story-dim absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="group"
        aria-label={title}
        data-story-sheet-id={testId}
        className="story-cmp-sheet relative flex max-h-[78%] flex-col rounded-t-[22px] border-t backdrop-blur-xl"
        style={{ background: "var(--story-tray)", borderColor: "var(--story-hairline)", color: "var(--story-on-media)" }}
      >
        <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
          <div className="min-w-0">
            <h2 className="font-display text-base font-extrabold leading-tight">{title}</h2>
            {hint && (
              <p className="mt-0.5 text-xs leading-snug" style={{ color: "var(--story-on-media-2)" }}>
                {hint}
              </p>
            )}
          </div>
          <button ref={close} type="button" className="story-cbtn" aria-label={t("stories.compose.close")} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2">{children}</div>
      </div>
    </div>
  );
}

export function StickerTray({
  onClose,
  onCall,
  onMention,
  onPhoto,
  photoAvailable,
  callAvailable,
  callPlaced,
  mentionFull,
}: {
  onClose: () => void;
  onCall: () => void;
  onMention: () => void;
  onPhoto: () => void;
  /** Photos go up as files: with no object storage there is no photo tile. */
  photoAvailable: boolean;
  /** Only inside a server: the call is a room of the server the composer was opened from. */
  callAvailable: boolean;
  callPlaced: boolean;
  mentionFull: boolean;
}) {
  const { t } = useTranslation();
  const allTiles = [
    {
      key: "call",
      icon: <Headphones className="h-6 w-6" aria-hidden />,
      label: t("stories.editor.sticker.call"),
      sub: callPlaced ? t("stories.editor.sticker.callPlaced") : t("stories.editor.sticker.callHint"),
      disabled: !callAvailable || callPlaced,
      onClick: onCall,
    },
    {
      key: "mention",
      icon: <AtSign className="h-6 w-6" aria-hidden />,
      label: t("stories.editor.sticker.mention"),
      sub: mentionFull ? t("stories.editor.limit.mention") : t("stories.editor.sticker.mentionHint"),
      disabled: mentionFull,
      onClick: onMention,
    },
    {
      key: "photo",
      icon: <ImagePlus className="h-6 w-6" aria-hidden />,
      label: t("stories.editor.sticker.photo"),
      sub: t("stories.editor.sticker.photoHint"),
      disabled: false,
      onClick: onPhoto,
    },
  ];
  const tiles = allTiles.filter((tile) => tile.key !== "photo" || photoAvailable);
  return (
    <ComposerSheet title={t("stories.editor.stickers")} onClose={onClose} testId="stickers">
      <div className="grid grid-cols-2 gap-2.5">
        {tiles.map((tile) => (
          <button
            key={tile.key}
            type="button"
            disabled={tile.disabled}
            data-story-sticker={tile.key}
            onClick={tile.onClick}
            className="flex flex-col items-start gap-2 rounded-[16px] p-3.5 text-left transition-[background,transform] duration-[var(--duration-fast)] hover:bg-[var(--story-field-fill)] active:scale-[0.98] disabled:opacity-45 motion-reduce:transition-none motion-reduce:active:scale-100"
            style={{ boxShadow: "inset 0 0 0 1px var(--story-hairline)" }}
          >
            <span
              className="flex h-10 w-10 items-center justify-center rounded-full"
              style={{ background: "var(--story-field-fill)", color: "var(--story-accent)" }}
            >
              {tile.icon}
            </span>
            <span>
              <span className="block text-sm font-bold">{tile.label}</span>
              <span className="block text-xs leading-snug" style={{ color: "var(--story-on-media-2)" }}>
                {tile.sub}
              </span>
            </span>
          </button>
        ))}
      </div>
    </ComposerSheet>
  );
}

export function CallPickerSheet({
  serverName,
  rooms,
  meId,
  onPick,
  onClose,
}: {
  serverName: string;
  rooms: ComposerVoiceRoom[];
  meId: string;
  onPick: (room: ComposerVoiceRoom) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | null>(null);
  const room = rooms.find((entry) => entry.id === chosen) ?? null;
  return (
    <ComposerSheet title={t("stories.callPicker.title")} hint={t("stories.callPicker.body")} onClose={onClose} testId="call">
      {rooms.length === 0 ? (
        <p className="px-2 py-3 text-sm" style={{ color: "var(--story-on-media-2)" }}>
          {t("stories.callPicker.empty")}
        </p>
      ) : (
        <div role="radiogroup" aria-label={t("stories.callPicker.rooms", { server: serverName })} className="space-y-1.5">
          {rooms.map((entry) => {
            const selected = entry.id === chosen;
            const mine = authorInRoom(entry, meId);
            return (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-story-room={entry.id}
                onClick={() => setChosen(entry.id)}
                className="flex w-full items-center gap-3 rounded-[14px] px-3.5 py-3 text-left transition-colors duration-[var(--duration-fast)] motion-reduce:transition-none"
                style={{
                  background: selected ? "var(--story-field-fill)" : "transparent",
                  boxShadow: selected ? "inset 0 0 0 1.5px var(--story-accent)" : "inset 0 0 0 1px var(--story-hairline)",
                }}
              >
                <Headphones className="h-[18px] w-[18px] shrink-0" aria-hidden style={{ color: "var(--story-accent)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{entry.name}</span>
                  <span className="block truncate text-xs" style={{ color: "var(--story-on-media-2)" }}>
                    {entry.occupants.length === 0
                      ? t("stories.callPicker.emptyRoom")
                      : t("stories.callPicker.inRoom", { count: entry.occupants.length })}
                    {mine ? ` · ${t("stories.callPicker.youAreHere")}` : ""}
                  </span>
                </span>
                {entry.occupants.length > 0 && (
                  <span className="flex shrink-0">
                    {entry.occupants.slice(0, 3).map((person, index) => (
                      <span key={person.id} className={cn("rounded-full", index > 0 && "-ml-2")} style={{ boxShadow: "0 0 0 2px var(--story-tray)" }}>
                        <UserAvatar
                          name={person.displayName}
                          avatarUrl={null}
                          rounded="full"
                          className="h-6 w-6"
                          fallbackClassName="bg-surface-3 text-[10px] text-text"
                        />
                      </span>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {room && !authorInRoom(room, meId) && (
        <p data-story-call-hint="" className="px-2 pt-3 text-xs leading-snug" style={{ color: "var(--story-accent-soft)" }}>
          {t("stories.callPicker.notInRoom", { room: room.name })}
        </p>
      )}
      <div className="flex justify-end px-1 pt-3">
        <button
          type="button"
          disabled={!room}
          data-story-room-add=""
          onClick={() => room && onPick(room)}
          className="h-11 rounded-full px-5 text-sm font-bold disabled:opacity-40"
          style={{ background: "var(--story-accent)", color: "var(--story-on-accent)" }}
        >
          {t("stories.editor.addToStory")}
        </button>
      </div>
    </ComposerSheet>
  );
}

export function MentionSheet({
  people,
  loading,
  taken,
  onPick,
  onClose,
}: {
  people: MentionPerson[] | null;
  loading: boolean;
  /** Already placed: shown, not offered. */
  taken: ReadonlySet<string>;
  onPick: (person: MentionPerson) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterPeople(people ?? [], query).filter((person) => !taken.has(person.id)), [people, query, taken]);
  return (
    <ComposerSheet title={t("stories.editor.sticker.mention")} hint={t("stories.editor.mentionHint")} onClose={onClose} testId="mention" focusClose={false}>
      <label className="relative mb-2 block">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden style={{ color: "var(--story-on-media-2)" }} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("stories.editor.mentionSearch")}
          aria-label={t("stories.editor.mentionSearch")}
          data-story-mention-search=""
          autoFocus
          className="story-field h-11 w-full rounded-full border pl-10 pr-4 text-[16px] font-medium outline-none"
          style={{ background: "var(--story-field-fill)", borderColor: "var(--story-field-edge)", color: "var(--story-on-media)" }}
        />
      </label>
      {loading && (
        <p role="status" className="px-2 py-3 text-sm" style={{ color: "var(--story-on-media-2)" }}>
          {t("stories.editor.mentionLoading")}
        </p>
      )}
      {!loading && shown.length === 0 && (
        <p className="px-2 py-3 text-sm" style={{ color: "var(--story-on-media-2)" }}>
          {t("stories.editor.mentionEmpty")}
        </p>
      )}
      <ul className="space-y-0.5">
        {shown.slice(0, 60).map((person) => (
          <li key={person.id}>
            <button
              type="button"
              data-story-person={person.id}
              onClick={() => onPick(person)}
              className="flex w-full items-center gap-3 rounded-[12px] px-2.5 py-2 text-left transition-colors hover:bg-[var(--story-field-fill)]"
            >
              <UserAvatar
                name={person.displayName}
                avatarUrl={person.avatarUrl}
                rounded="full"
                className="h-8 w-8"
                fallbackClassName="bg-surface-3 text-xs text-text"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{person.displayName}</span>
            </button>
          </li>
        ))}
      </ul>
    </ComposerSheet>
  );
}
