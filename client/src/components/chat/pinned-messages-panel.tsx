import { buildReplyExcerpt, type Message } from "@pqp/shared";
import { DotsThree, X } from "@phosphor-icons/react";
import { Pin } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Menu } from "@/components/ui/menu";
import { POPOVER_SURFACE } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { UserAvatar } from "@/components/user/user-avatar";
import { fetchPinnedMessages, unpinMessage } from "@/lib/api";
import { BELOW_SM_QUERY } from "@/lib/breakpoints";
import { useTranslation, type Translator } from "@/lib/i18n";
import { useRedesign } from "@/lib/redesign";
import { cn, formatFullTimestamp, formatRecency } from "@/lib/utils";

interface PinnedMessagesPanelProps {
  open: boolean;
  channelId: string | null;
  channelName: string | null;
  /** Same gate the row's own context menu uses: a server channel needs
   * manage permission, a conversation lets any participant unpin. */
  canUnpin: boolean;
  onClose: () => void;
  onJumpToMessage: (messageId: string) => void;
}

/** What to show when a pin has no text of its own — an image-only or
 * GIF-only message — rather than rendering an empty line. */
function describeBody(message: Message, t: Translator["t"]): string {
  if (message.body.trim()) {
    return buildReplyExcerpt(message.body);
  }
  if (message.attachments.length > 0) {
    const first = message.attachments[0]!;
    return message.attachments.length > 1
      ? t("pins.moreAttachments", {
          filename: first.filename,
          count: message.attachments.length - 1,
        })
      : first.filename;
  }
  return t("pins.emptyMessage");
}

export function PinnedMessagesPanel({
  open,
  channelId,
  channelName,
  canUnpin,
  onClose,
  onJumpToMessage,
}: PinnedMessagesPanelProps) {
  const { t } = useTranslation();
  const redesign = useRedesign();
  const phone = useMediaQuery(BELOW_SM_QUERY);
  const [pins, setPins] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !channelId) {
      return;
    }
    let cancelled = false;
    setError(null);
    setPins([]);
    setLoading(true);
    fetchPinnedMessages(channelId)
      .then((res) => {
        if (!cancelled) {
          setPins(res.messages);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("pins.loadFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, channelId]);

  async function unpin(messageId: string) {
    setBusyId(messageId);
    setError(null);
    try {
      await unpinMessage(messageId);
      // No broadcast reconciliation to wait for here — the panel is its own
      // read, not the message list, so it drops the row itself.
      setPins((prev) => prev.filter((message) => message.id !== messageId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pins.unpinFailed"));
    } finally {
      setBusyId(null);
    }
  }

  if (redesign) {
    const jump = (messageId: string) => {
      onJumpToMessage(messageId);
      onClose();
    };
    const list = (
      <PinsList
        pins={pins}
        loading={loading}
        error={error}
        canUnpin={canUnpin}
        busyId={busyId}
        onJump={jump}
        onUnpin={(id) => void unpin(id)}
      />
    );
    const title = pins.length > 0 ? t("pins.titleCount", { count: pins.length }) : t("pins.title");
    return phone ? (
      <Dialog open={open} title={title} onClose={onClose}>
        {list}
      </Dialog>
    ) : (
      <PinsPopover open={open} title={title} onClose={onClose}>
        {list}
      </PinsPopover>
    );
  }

  return (
    <Dialog
      open={open}
      eyebrow={t("pins.eyebrow")}
      title={`#${channelName ?? t("pins.untitled")}`}
      description={t("pins.description")}
      onClose={onClose}
    >
      <div className="space-y-3 p-4">
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        {loading && (
          <p className="text-sm text-paper-muted" role="status">
            {t("pins.loading")}
          </p>
        )}
        {!loading && pins.length === 0 && !error && (
          <p className="text-sm text-paper-muted">
            {t("pins.empty")}
          </p>
        )}
        <ul className="space-y-2">
          {pins.map((message) => (
            <li
              key={message.id}
              className="rounded-md border border-ink-4 bg-ink-3/40 p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    onJumpToMessage(message.id);
                    onClose();
                  }}
                >
                  <p className="flex items-center gap-1.5 text-xs text-paper-muted">
                    <span className="font-semibold text-paper">
                      {message.authorName}
                    </span>
                    <span>·</span>
                    <span>{formatFullTimestamp(message.createdAt)}</span>
                  </p>
                  <p className="mt-0.5 truncate text-sm text-paper">
                    {describeBody(message, t)}
                  </p>
                  {message.pinnedBy && (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-paper-muted">
                      <Pin className="h-3 w-3 text-signal" aria-hidden />
                      {t("chat.pinnedBy", {
                        name: message.pinnedBy.displayName,
                      })}
                    </p>
                  )}
                </button>
                {canUnpin && (
                  <button
                    type="button"
                    disabled={busyId === message.id}
                    onClick={() => void unpin(message.id)}
                    className="shrink-0 rounded px-2 py-1 text-xs text-paper-muted hover:bg-ink-4 hover:text-paper disabled:opacity-50"
                  >
                    {t("pins.unpin")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

/*
 * Under the redesign (the text channels canvas, "Painéis", 3. Fixadas): a
 * popover held under the header's Fixadas button on a computer, a sheet on a
 * phone. Rows are the message itself, avatar, name, when and up to three
 * lines; a press jumps there, and unpinning lives in the row's ⋯.
 */

const POPOVER_WIDTH = 380;
const EDGE = 12;
const GAP = 8;

/** The header button that opened the pins: the focused one, else the visible one. */
function pinsAnchor(): HTMLElement | null {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused.closest("[data-channel-header-pins]")) {
    return focused.closest<HTMLElement>("[data-channel-header-pins]");
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-channel-header-pins]")) {
    if (el.getBoundingClientRect().width > 0) {
      return el;
    }
  }
  return null;
}

/** Right edge under the button, clamped inside the window. Pure, so it is tested. */
export function placePinsPopover(
  anchor: { right: number; bottom: number } | null,
  width: number,
  viewport: { width: number; height: number },
): { left: number; top: number; maxHeight: number } {
  const right = anchor ? anchor.right : viewport.width - EDGE;
  const top = anchor ? anchor.bottom + GAP : 64;
  const left = Math.max(EDGE, Math.min(right - width, viewport.width - width - EDGE));
  return { left, top, maxHeight: Math.max(160, viewport.height - top - EDGE) };
}

function PinsPopover({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current?.isConnected ? anchorRef.current : pinsAnchor();
    anchorRef.current = anchor;
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - EDGE * 2);
    setBox(
      placePinsPopover(anchor?.getBoundingClientRect() ?? null, width, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    anchorRef.current = pinsAnchor();
    place();
    panelRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      // Back to the button that opened it, as a dialog would.
      anchorRef.current?.focus({ preventScroll: true });
    };
  }, [open, place]);

  // Escape and a press outside close it; a row's own ⋯ menu is not outside,
  // and its Escape closes only the menu.
  useEffect(() => {
    if (!open) {
      return;
    }
    const insideMenu = (target: EventTarget | null) =>
      target instanceof Element && target.closest("[role='menu']") !== null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || insideMenu(event.target)) {
        return;
      }
      event.stopPropagation();
      onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        !target ||
        panelRef.current?.contains(target) ||
        anchorRef.current?.contains(target) ||
        insideMenu(event.target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-pins-popover=""
      style={{
        width: `min(${POPOVER_WIDTH}px, calc(100vw - ${EDGE * 2}px))`,
        left: box?.left ?? 0,
        top: box?.top ?? 0,
        maxHeight: box?.maxHeight,
        visibility: box ? "visible" : "hidden",
      }}
      className={cn(
        POPOVER_SURFACE,
        "fixed z-[90] flex flex-col overflow-hidden text-text animate-pop-in focus-visible:outline-none",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[color:var(--pane-header-rule)] pl-3.5 pr-2">
        <h2 id={titleId} className="flex-1 text-sm font-semibold">
          {title}
        </h2>
        <IconButton label={t("common.close")} size="sm" touch={false} onClick={onClose}>
          <Icon icon={X} size="sm" kind="symbol" />
        </IconButton>
      </div>
      <div className="min-h-0 overflow-y-auto">{children}</div>
    </div>,
    document.body,
  );
}

function PinsList({
  pins,
  loading,
  error,
  canUnpin,
  busyId,
  onJump,
  onUnpin,
}: {
  pins: Message[];
  loading: boolean;
  error: string | null;
  canUnpin: boolean;
  busyId: string | null;
  onJump: (messageId: string) => void;
  onUnpin: (messageId: string) => void;
}) {
  const { t, locale } = useTranslation();
  return (
    <div data-pins-list="" className="text-sm">
      {error && (
        <p className="px-3.5 py-2.5 text-danger" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="flex items-center gap-2 px-3.5 py-5 text-text-tertiary" role="status">
          <Spinner className="h-4 w-4" />
          {t("pins.loading")}
        </p>
      )}
      {!loading && pins.length === 0 && !error && (
        <p className="px-3.5 py-5 text-center text-[13px] text-text-tertiary">
          {canUnpin ? t("pins.emptyCanPin") : t("pins.emptyStaff")}
        </p>
      )}
      {pins.length > 0 && (
        <>
          <ul>
            {pins.map((message) => (
              <li
                key={message.id}
                className="group relative border-b border-[color:var(--pane-header-rule)]"
              >
                <button
                  type="button"
                  onClick={() => onJump(message.id)}
                  title={
                    message.pinnedBy
                      ? t("chat.pinnedBy", { name: message.pinnedBy.displayName })
                      : undefined
                  }
                  className="grid w-full grid-cols-[32px_minmax(0,1fr)] gap-2.5 px-3.5 py-2.5 text-left hover:bg-[color:var(--list-row-hover)] focus-visible:bg-[color:var(--list-row-hover)] focus-visible:outline-none"
                >
                  <UserAvatar
                    name={message.authorName}
                    avatarUrl={message.authorAvatarUrl}
                    rounded="full"
                    className="h-8 w-8"
                  />
                  <span className={cn("min-w-0", canUnpin && "pr-7")}>
                    <span className="flex items-baseline gap-2">
                      <span className="truncate font-semibold text-text">{message.authorName}</span>
                      <time
                        dateTime={message.createdAt}
                        title={formatFullTimestamp(message.createdAt, locale)}
                        className="shrink-0 text-xs text-text-tertiary"
                      >
                        {formatRecency(message.createdAt, locale)}
                      </time>
                    </span>
                    <span className="mt-0.5 line-clamp-3 break-words leading-5 text-text-secondary">
                      {describeBody(message, t)}
                    </span>
                  </span>
                </button>
                {canUnpin && (
                  <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                    <Menu
                      align="end"
                      items={[
                        {
                          id: "pins-unpin",
                          label: t("pins.unpin"),
                          disabled: busyId === message.id,
                          onSelect: () => onUnpin(message.id),
                        },
                      ]}
                    >
                      <button
                        type="button"
                        aria-label={t("pins.rowActions")}
                        title={t("pins.rowActions")}
                        className="grid h-7 w-7 place-items-center rounded-full text-text-tertiary hover:bg-[color:var(--color-surface-3)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        <Icon icon={DotsThree} size="sm" kind="symbol" />
                      </button>
                    </Menu>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="px-3.5 py-2.5 text-xs text-text-tertiary">
            {canUnpin ? t("pins.hintCanUnpin") : t("pins.hint")}
          </p>
        </>
      )}
    </div>
  );
}
