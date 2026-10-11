import { useContext, useEffect, useState } from "react";
import { VoiceNoteNamesContext } from "@/components/chat/voice-note-card";
import type { StoryCard } from "@pqp/shared";
import { useTranslation } from "@/lib/i18n";
import { fetchStoryCard } from "@/lib/stories/api";
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

const cards = new Map<string, Promise<StoryCard | null>>();

function loadCard(storyId: string): Promise<StoryCard | null> {
  let pending = cards.get(storyId);
  if (!pending) {
    pending = fetchStoryCard(storyId).catch(() => {
      cards.delete(storyId);
      return null;
    });
    cards.set(storyId, pending);
  }
  return pending;
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
  }, [storyId]);

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
