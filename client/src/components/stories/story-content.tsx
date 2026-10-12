import { Headphones } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type Ref } from "react";
import type { StoryBackground, StoryCallLive, StoryKind } from "@pqp/shared";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * What a story looks like, without any of the viewer around it: the picture,
 * the clip or the text card, the caption, and the call sticker. The viewer,
 * the deck's outgoing card and the composer's preview all draw through this,
 * so a story looks the same before and after it is posted.
 *
 * The card is a size container, so a text card's type scales with the card
 * rather than with the window.
 */

export interface StoryDisplay {
  id: string;
  kind: StoryKind;
  text: string | null;
  background: StoryBackground | null;
  caption: string | null;
  mediaUrl: string | null;
  posterUrl: string | null;
  call: StoryCallLive | null;
  /** Composer preview only: the room picked, before there is a live roster. */
  callPreview?: { channelName: string; names: string[] } | null;
}

interface StoryContentProps {
  story: StoryDisplay;
  /** Mount the video element. False during the open zoom (design §4). */
  playVideo?: boolean;
  muted?: boolean;
  paused?: boolean;
  onJoinCall?: (call: StoryCallLive) => void;
  /** Video: its own length and position drive the bar. */
  onVideoDuration?: (ms: number) => void;
  onVideoTime?: (ms: number) => void;
  onVideoEnded?: () => void;
  className?: string;
  /** Freeze: an outgoing deck card or a thumbnail. No controls, no playback. */
  still?: boolean;
}

export function textCardSizeClass(text: string): string {
  const length = [...text].length;
  if (length <= 40) {
    return "text-[10.5cqw] leading-[1.02]";
  }
  if (length <= 110) {
    return "text-[8cqw] leading-[1.06]";
  }
  return "text-[6cqw] leading-[1.15]";
}

export const StoryContent = forwardRef(function StoryContent(
  {
    story,
    playVideo = true,
    muted = true,
    paused = false,
    onJoinCall,
    onVideoDuration,
    onVideoTime,
    onVideoEnded,
    className,
    still = false,
  }: StoryContentProps,
  ref: Ref<HTMLDivElement>,
) {
  const isMedia = story.kind !== "text";
  return (
    <div
      ref={ref}
      className={cn("absolute inset-0 overflow-hidden [container-type:size]", className)}
      style={{ background: "var(--story-card)" }}
    >
      {story.kind === "image" && story.mediaUrl && (
        <img
          src={story.mediaUrl}
          alt=""
          draggable={false}
          decoding="async"
          className="absolute inset-0 h-full w-full select-none object-cover"
        />
      )}
      {story.kind === "video" &&
        (playVideo && !still && story.mediaUrl ? (
          <StoryVideo
            src={story.mediaUrl}
            poster={story.posterUrl}
            muted={muted}
            paused={paused}
            onDuration={onVideoDuration}
            onTime={onVideoTime}
            onEnded={onVideoEnded}
          />
        ) : story.posterUrl ? (
          <img
            src={story.posterUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full select-none object-cover"
          />
        ) : null)}
      {story.kind === "text" && (
        <div
          className="story-text-card absolute inset-0"
          data-bg={story.background ?? "night"}
        >
          <p
            className={cn(
              "absolute left-[7.5%] right-[7.5%] top-[17%] whitespace-pre-wrap break-words font-display font-black tracking-[-0.01em]",
              textCardSizeClass(story.text ?? ""),
            )}
            style={{ color: "var(--story-on-media)" }}
          >
            {story.text}
          </p>
        </div>
      )}
      {isMedia && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: "var(--story-scrim)" }}
        />
      )}
      {(story.call || story.callPreview) && (
        <CallSticker
          call={story.call}
          preview={story.callPreview ?? null}
          onJoin={still ? undefined : onJoinCall}
          className={story.kind === "text" ? "top-[52%]" : "bottom-[22%]"}
        />
      )}
      {isMedia && story.caption && (
        <p
          className="absolute bottom-[6%] left-[5%] right-[5%] whitespace-pre-wrap break-words text-[4.4cqw] font-semibold leading-snug [text-shadow:0_1px_8px_var(--story-dim)]"
          style={{ color: "var(--story-on-media)" }}
        >
          {story.caption}
        </p>
      )}
    </div>
  );
});

function StoryVideo({
  src,
  poster,
  muted,
  paused,
  onDuration,
  onTime,
  onEnded,
}: {
  src: string;
  poster: string | null;
  muted: boolean;
  paused: boolean;
  onDuration?: (ms: number) => void;
  onTime?: (ms: number) => void;
  onEnded?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onDuration, onTime, onEnded });
  callbacks.current = { onDuration, onTime, onEnded };

  useEffect(() => {
    const element = video.current;
    if (!element) {
      return;
    }
    if (paused) {
      element.pause();
    } else {
      void element.play().catch(() => undefined);
    }
  }, [paused, src]);

  // The bar is the video's own clock, read off `currentTime` so it never runs
  // ahead of a stalled download. Ten reads a second, the same step as the
  // viewer's clock, so playback does not re-render the viewer every frame.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const element = video.current;
      if (element && !element.paused) {
        callbacks.current.onTime?.(element.currentTime * 1000);
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <video
      ref={video}
      src={src}
      poster={poster ?? undefined}
      muted={muted}
      playsInline
      preload="auto"
      className="absolute inset-0 h-full w-full object-cover"
      onLoadedMetadata={(event) => {
        const seconds = event.currentTarget.duration;
        if (Number.isFinite(seconds) && seconds > 0) {
          callbacks.current.onDuration?.(seconds * 1000);
        }
      }}
      onEnded={() => callbacks.current.onEnded?.()}
    />
  );
}

/**
 * "Chama pra call": live, read off the roster when the story was served. It
 * says the room has ended or filled up instead of offering a dead button.
 */
function CallSticker({
  call,
  preview,
  onJoin,
  className,
}: {
  call: StoryCallLive | null;
  preview: { channelName: string; names: string[] } | null;
  onJoin?: (call: StoryCallLive) => void;
  className?: string;
}) {
  const { t, locale } = useTranslation();
  const people = call?.participants ?? [];
  const names = call
    ? people.map((person) => person.displayName.split(/\s+/)[0] ?? person.displayName)
    : (preview?.names ?? []);
  const list = names.length > 0 ? formatList(names.slice(0, 3), locale) : "";
  const extra = call ? Math.max(0, call.count - Math.min(names.length, 3)) : 0;
  const state = call?.state ?? "live";
  const seenFaces = useRef(new Set(people.map((person) => person.id)));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const arrived = people.filter((person) => !seenFaces.current.has(person.id));
    for (const person of arrived) {
      seenFaces.current.add(person.id);
    }
    if (arrived.length > 0) {
      setFresh(new Set(arrived.map((person) => person.id)));
    }
    // Faces are keyed by id; the array identity changes on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people.map((person) => person.id).join(",")]);

  return (
    <div
      data-story-call=""
      className={cn(
        "absolute left-[9%] right-[9%] rounded-[18px] border p-[14px] shadow-[var(--story-shadow)]",
        className,
      )}
      style={{ background: "var(--story-sticker)", borderColor: "var(--story-sticker-edge)" }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <p
        className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.08em]"
        style={{ color: "var(--story-accent-soft)" }}
      >
        <Headphones className="h-3.5 w-3.5" style={{ color: "var(--story-accent)" }} aria-hidden />
        {state === "ended"
          ? t("stories.call.ended")
          : state === "full"
            ? t("stories.call.full")
            : t("stories.call.live")}
      </p>
      <p
        className="mt-2 truncate font-display text-[20px] font-extrabold leading-tight"
        style={{ color: "var(--story-on-media)" }}
      >
        {call?.channelName ?? preview?.channelName}
      </p>
      {state !== "ended" && list && (
        <div className="mt-2 flex items-center gap-2 text-[13px]" style={{ color: "var(--story-on-media-2)" }}>
          {people.length > 0 && (
            <span className="flex">
              {people.slice(0, 3).map((person, index) => (
                <span
                  key={person.id}
                  className={cn(
                    "rounded-full shadow-[0_0_0_2px_var(--story-card)]",
                    index > 0 && "-ml-1.5",
                    fresh.has(person.id) && "animate-badge-pop",
                  )}
                >
                  <UserAvatar
                    name={person.displayName}
                    avatarUrl={person.avatarUrl}
                    rounded="full"
                    className="h-5 w-5"
                    fallbackClassName="bg-surface-3 text-[9px] text-text"
                  />
                </span>
              ))}
            </span>
          )}
          <span className="min-w-0 truncate" style={{ color: "var(--story-on-media-2)" }}>
            {extra > 0 ? t("stories.call.people", { count: extra, names: list }) : list}
          </span>
        </div>
      )}
      {call && call.joinable && onJoin && (
        <button
          type="button"
          data-story-join=""
          onClick={() => onJoin(call)}
          className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-full text-sm font-bold transition-[transform,filter] hover:brightness-105 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          style={{ background: "var(--story-accent)", color: "var(--story-on-accent)" }}
        >
          <Headphones className="h-4 w-4" aria-hidden />
          {t("stories.call.join")}
        </button>
      )}
      {!call && preview && (
        <span
          aria-hidden
          className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-full text-sm font-bold"
          style={{ background: "var(--story-accent)", color: "var(--story-on-accent)" }}
        >
          <Headphones className="h-4 w-4" />
          {t("stories.call.join")}
        </span>
      )}
    </div>
  );
}

function formatList(names: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}
