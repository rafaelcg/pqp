import { Headphones, Plus, RotateCw, X } from "lucide-react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { ContextMenu, type ContextMenuItemDef } from "@/components/ui/context-menu";
import { Menu } from "@/components/ui/menu";
import { UserAvatar } from "@/components/user/user-avatar";
import { cn } from "@/lib/utils";

/**
 * One ring: a face with the story gradient around it.
 *
 * - `unseen`: the accent-to-warning gradient, the wider ring.
 * - `seen`: `border-strong`, thinner, the label quieter. The change is a
 *   crossfade of two stacked layers and a scale on the gap circle, never an
 *   animated gradient or an animated width (design §4).
 * - `none`: no ring at all: the viewer's own face before they have posted.
 *
 * A call story wears a headphones badge; the viewer's own ring wears a plus.
 * While a post is going up, an arc of real upload progress is drawn over the
 * ring, and a failed post turns it red: with a retry when posting again can
 * work, with an X when a tap only puts it away.
 */

export type RingState = "unseen" | "seen" | "none";

export interface RingUpload {
  status: "uploading" | "processing" | "failed" | "done";
  progress: number | null;
  /** Only with "failed": whether a tap posts again (else it dismisses). */
  retryable?: boolean;
}

interface StoryRingProps {
  name: string;
  avatarUrl: string | null;
  label: string;
  ariaLabel: string;
  state: RingState;
  size?: 48 | 64;
  hasCall?: boolean;
  plus?: boolean;
  upload?: RingUpload | null;
  /** Play the arrival (scale in and one sweep of the gradient). */
  arrive?: boolean;
  ringId?: string;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * A failed post that can be tried again: a tap opens these (Tentar de novo,
   * Descartar) instead of calling `onOpen`, so the draft is never thrown away
   * or re-sent by an accidental tap.
   */
  failedActions?: ContextMenuItemDef[];
  /** Right-click or long-press on the ring: "Novo story" on the viewer's own ring. */
  contextItems?: ContextMenuItemDef[];
  /** Only with `plus`: the badge itself is a second button that composes. */
  onPlus?: () => void;
  plusLabel?: string;
}

/** Ring and gap widths (px) per size: 64 pt on phones, 48 px in the sidebar. */
const GEOMETRY = {
  48: { unseen: 2, seen: 1.5, gap: 2 },
  64: { unseen: 2.5, seen: 1.5, gap: 2.5 },
} as const;

export function StoryRing({
  name,
  avatarUrl,
  label,
  ariaLabel,
  state,
  size = 48,
  hasCall = false,
  plus = false,
  upload = null,
  arrive = false,
  ringId,
  onOpen,
  failedActions,
  contextItems,
  onPlus,
  plusLabel,
}: StoryRingProps) {
  const geometry = GEOMETRY[size];
  const inset = geometry.unseen + geometry.gap;
  const style = {
    width: size,
    height: size,
    "--story-gap-unseen": String((size - 2 * geometry.unseen) / size),
    "--story-gap-seen": String((size - 2 * geometry.seen) / size),
  } as CSSProperties;
  // 24 px at the least (the web strip's ring is 48): a plus smaller than that is not a button anyone can hit.
  const badgeSize = size === 64 ? 26 : 24;
  const failed = upload?.status === "failed";
  const ringButton = (
    <button
      type="button"
      data-story-ring={ringId}
      aria-label={ariaLabel}
      // A failed ring with actions lets the menu take the tap.
      onClick={failed && failedActions ? undefined : onOpen}
      className="rounded-full [-webkit-tap-highlight-color:transparent] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset"
    >
      <span
        className={cn("story-ring", arrive && "story-ring-in")}
        data-ring={failed ? "seen" : state}
        style={style}
      >
        <span data-ring-layer="grad" />
        <span data-ring-layer="seen" />
        <span data-ring-layer="gap" />
        <span
          className="absolute overflow-hidden rounded-full"
          style={state === "none" ? { inset: 0 } : { inset }}
        >
          <UserAvatar
            name={name}
            avatarUrl={avatarUrl}
            rounded="full"
            className="h-full w-full"
            fallbackClassName={cn(
              "bg-surface-3 text-text",
              size === 64 ? "text-xl" : "text-base",
            )}
          />
        </span>
        {upload && upload.status !== "done" && <UploadArc size={size} upload={upload} />}
      </span>
    </button>
  );

  let badge: ReactNode = null;
  if (plus) {
    badge = onPlus ? (
      <button
        type="button"
        aria-label={plusLabel}
        data-story-plus=""
        onClick={(event) => {
          event.stopPropagation();
          onPlus();
        }}
        // The dot is 24 px but the thing to hit is bigger: the before: pseudo-element is part of the button, so a
        // click anywhere on it is the badge's, and it sits over the ring (the badge comes later in the box), so it
        // wins over the ring's own click. 32 px square with a mouse (4 px out on every side), 44 px on a touch screen.
        className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-accent text-on-accent shadow-[0_0_0_2.5px_var(--story-ring-bg,var(--color-surface-1))] transition-transform duration-[var(--duration-fast)] before:absolute before:-inset-1 before:content-[''] hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [@media(pointer:coarse)]:before:-inset-[10px]"
        style={{ width: badgeSize, height: badgeSize }}
      >
        <Plus className="h-3 w-3" strokeWidth={3.5} aria-hidden />
      </button>
    ) : (
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-accent text-on-accent shadow-[0_0_0_2.5px_var(--story-ring-bg,var(--color-surface-1))]"
        style={{ width: badgeSize, height: badgeSize }}
      >
        <Plus className="h-2.5 w-2.5" strokeWidth={3.5} />
      </span>
    );
  } else if (hasCall) {
    badge = (
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-surface-2 text-accent shadow-[0_0_0_2.5px_var(--story-ring-bg,var(--color-surface-1))]"
        style={{ width: badgeSize, height: badgeSize }}
      >
        <Headphones className="h-2.5 w-2.5" strokeWidth={2.75} />
      </span>
    );
  }

  return (
    <div
      className="flex w-12 shrink-0 flex-col items-center gap-1"
      style={size === 64 ? { width: 68 } : undefined}
    >
      <div className="relative" style={{ width: size, height: size }}>
        {failed && failedActions ? (
          <Menu items={failedActions} align="start" side="bottom">
            {ringButton}
          </Menu>
        ) : contextItems && contextItems.length > 0 && !failed ? (
          <ContextMenu items={contextItems}>{ringButton}</ContextMenu>
        ) : (
          ringButton
        )}
        {failed ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-danger text-on-accent shadow-[0_0_0_2.5px_var(--story-ring-bg,var(--color-surface-1))]"
            style={{ width: badgeSize, height: badgeSize }}
          >
            {upload?.retryable === false ? (
              <X className="h-2.5 w-2.5" strokeWidth={3} />
            ) : (
              <RotateCw className="h-2.5 w-2.5" strokeWidth={3} />
            )}
          </span>
        ) : (
          badge
        )}
      </div>
      <span
        className={cn(
          "story-ring-label w-full truncate text-center text-[11px] leading-tight",
          state === "unseen" || state === "none"
            ? "font-semibold text-text"
            : "font-medium text-text-tertiary",
          failed && "text-danger",
        )}
      >
        {label}
      </span>
    </div>
  );
}

/** Bytes sent over bytes total, as an arc over the ring. Never a timer. */
function UploadArc({ size, upload }: { size: number; upload: RingUpload }) {
  const stroke = size === 64 ? 3 : 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction =
    upload.status === "failed"
      ? 1
      : upload.status === "processing" || upload.progress === null
        ? 0.3
        : Math.max(0.04, Math.min(1, upload.progress));
  return (
    <svg
      aria-hidden
      className={cn(
        "absolute inset-0",
        upload.status === "processing" && "story-upload-processing",
      )}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ transform: upload.status === "processing" ? undefined : "rotate(-90deg)" }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--color-surface-3)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={upload.status === "failed" ? "var(--color-danger)" : "var(--color-accent)"}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        className="story-upload-arc"
      />
    </svg>
  );
}
