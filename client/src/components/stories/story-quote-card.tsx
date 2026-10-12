import { useContext, useEffect, useState } from "react";
import { VoiceNoteNamesContext } from "@/components/chat/voice-note-card";
import type { StoryCard } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { fetchStoryCard } from "@/lib/stories/api";
import { onStoriesSignal } from "@/lib/stories/events";
import { formatStoryLeft } from "@/lib/stories/format";
import { cn } from "@/lib/utils";

/**
 * The quote above a message that replied to a story (design B4).
 *
 * The thumbnail and the caption show only while the story lives; after that
 * the card is a hatched "Story expirou" plate with no picture and no text,
 * which is how the 24 h promise holds inside a DM too. The server enforces
 * it (`GET /api/stories/:id/card` stops carrying both); this only draws what
 * it is given.
 */

/**
 * One card per story, shared by every message quoting it, and kept only
 * briefly: a removal or deletion arrives as a `stories-update` naming the
 * story (dropped here at once), and anything else that ends a story (expiry,
 * a removal from a server this reader is not in) is caught by the short
 * lifetime. A conversation full of replies to different stories asks for at
 * most `MAX_IN_FLIGHT` cards at a time.
 */
const CARD_TTL_MS = 60_000;
const MAX_IN_FLIGHT = 4;

const cards = new Map<string, { at: number; card: Promise<StoryCard | null> }>();
const waiting: (() => void)[] = [];
let inFlight = 0;
const invalidated = new Set<(storyIds: readonly string[]) => void>();

onStoriesSignal((signal) => {
  const ids = signal.kind === "update" ? (signal.frame.removedStoryIds ?? []) : [];
  if (ids.length === 0) {
    return;
  }
  for (const id of ids) {
    cards.delete(id);
  }
  for (const listener of [...invalidated]) {
    listener(ids);
  }
});

async function limited<T>(run: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  inFlight += 1;
  try {
    return await run();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

function loadCard(storyId: string): Promise<StoryCard | null> {
  const cached = cards.get(storyId);
  if (cached && Date.now() - cached.at < CARD_TTL_MS) {
    return cached.card;
  }
  const card = limited(() => fetchStoryCard(storyId)).catch(() => {
    cards.delete(storyId);
    return null;
  });
  cards.set(storyId, { at: Date.now(), card });
  return card;
}

interface StoryQuoteCardProps {
  storyId: string;
  currentUserId: string | null;
}

export function StoryQuoteCard({ storyId, currentUserId }: StoryQuoteCardProps) {
  const { t } = useTranslation();
  // The conversation's names, the same lookup a voice note's "ouviu" uses.
  const nameFor = useContext(VoiceNoteNamesContext);
  const [card, setCard] = useState<StoryCard | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Bumped when this story is named in a removal frame, to read it again.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = (ids: readonly string[]) => {
      if (ids.includes(storyId)) {
        setVersion((value) => value + 1);
      }
    };
    invalidated.add(listener);
    return () => {
      invalidated.delete(listener);
    };
  }, [storyId]);

  useEffect(() => {
    let alive = true;
    void loadCard(storyId).then((value) => {
      if (alive) {
        setCard(value);
      }
    });
    return () => {
      alive = false;
    };
  }, [storyId, version]);

  // A live quote turns into the plate on its own once the story expires.
  useEffect(() => {
    if (!card || card.state !== "live" || !card.expiresAt) {
      return;
    }
    const left = Date.parse(card.expiresAt) - Date.now();
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1_000, Math.min(left + 500, 60_000)));
    return () => window.clearTimeout(timer);
  }, [card, now]);

  if (!card) {
    return null;
  }
  const expired =
    card.state !== "live" || (card.expiresAt !== null && Date.parse(card.expiresAt) <= now);
  const mine = card.authorId === currentUserId;
  const heading = mine
    ? t("stories.quote.replied")
    : t("stories.quote.repliedTo", { name: nameFor(card.authorId) ?? "" });
  const title = expired
    ? card.state === "removed"
      ? t("stories.quote.removed")
      : t("stories.quote.expired")
    : card.kind === "text"
      ? card.text
      : card.caption || (card.kind === "video" ? t("stories.quote.video") : t("stories.quote.photo"));

  return (
    <div
      data-story-quote={expired ? "expired" : "live"}
      className="mb-1 mt-1 flex max-w-[280px] items-stretch gap-2.5 rounded-[12px] border border-border bg-surface-1 p-2"
    >
      <div
        aria-hidden
        className={cn(
          "relative h-[72px] w-[44px] shrink-0 overflow-hidden rounded-[7px]",
          !expired && card.kind === "text" && "story-text-card",
        )}
        data-bg={card.background ?? "night"}
        style={expired ? { background: "var(--story-hatch)" } : undefined}
      >
        {!expired && card.posterUrl && (
          <img src={card.posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-1">
        <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-text-tertiary">
          {heading}
        </span>
        <span className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-text">{title}</span>
        {expired ? (
          card.state === "expired" && (
            <span className="text-xs text-text-tertiary">{t("stories.quote.expiredHint")}</span>
          )
        ) : (
          <span className="text-xs text-text-tertiary">
            {t("stories.quote.left", { left: formatStoryLeft(card.expiresAt, now) })}
          </span>
        )}
      </div>
    </div>
  );
}
