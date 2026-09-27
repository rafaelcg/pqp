import type { CSSProperties } from "react";
import { Eye, Mic } from "lucide-react";
import { UserAvatar } from "@/components/user/user-avatar";
import { LivePill } from "@/components/watch-party/live-pill";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * What a watch party looks like, drawn from the product's own parts.
 *
 * NOT A SCREENSHOT AND NOT A STOCK PHOTO. The picture on the stage is the
 * landing page's own hero painting (a rooftop full of people at dusk, which is
 * also the whole idea), cut down to a 96 KB webp in
 * `public/images/watch-party/stage-film.webp`. Everything drawn over it is the
 * real thing: `LivePill` is the badge a live party wears in the sidebar,
 * `UserAvatar` is the avatar every chat line uses, and the reactions float on
 * the same keyframe as the real ones (`live-reaction-float`). So the teaser
 * can never promise a look the feature does not have, and a theme change
 * restyles it like any other surface.
 *
 * Decorative for assistive tech as a whole (`role="img"` with one label that
 * says what it shows), because read line by line it is a fake chat.
 *
 * `compact` drops the chat column, for a phone-width dialog where a 34% column
 * would leave neither half readable.
 */
const CHAT = [
  { name: "Nina", key: "watchParty.waitlist.art.chat1" },
  { name: "Caio", key: "watchParty.waitlist.art.chat2" },
  { name: "Duda", key: "watchParty.waitlist.art.chat3" },
  { name: "Léo", key: "watchParty.waitlist.art.chat4" },
] as const;

const REACTIONS = [
  { emoji: "🍿", delay: 0, left: "52%" },
  { emoji: "😂", delay: 1200, left: "60%" },
  { emoji: "🔥", delay: 2400, left: "45%" },
] as const;

export function WatchPartyStageArt({
  className,
  chat = true,
}: {
  className?: string;
  /** Show the chat column beside the stage (from `sm` up). */
  chat?: boolean;
}) {
  const { t, locale } = useTranslation();
  const viewers = new Intl.NumberFormat(locale).format(312);
  return (
    <figure
      role="img"
      aria-label={t("watchParty.waitlist.art.label")}
      data-watch-party-stage-art=""
      className={cn(
        "relative flex overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-0 shadow-[var(--shadow-2)]",
        className,
      )}
    >
      <div className="relative aspect-video min-w-0 flex-1" aria-hidden="true">
        <img
          src="/images/watch-party/stage-film.webp"
          alt=""
          width={1152}
          height={768}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Legibility for the chips, top and bottom; the middle stays the film. */}
        <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-surface-0/70 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-surface-0/80 to-transparent" />

        <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5 sm:left-3 sm:top-3">
          <LivePill className="bg-surface-0/80 backdrop-blur-sm" />
          <span className="hidden truncate rounded-full bg-surface-0/70 px-2 py-0.5 text-[10px] font-semibold text-text backdrop-blur-sm min-[420px]:inline">
            {t("watchParty.waitlist.art.title")}
          </span>
        </div>
        <span className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-full bg-surface-0/70 px-2 py-0.5 text-[10px] font-medium tabular-nums text-text backdrop-blur-sm sm:right-3 sm:top-3">
          <Eye className="h-3 w-3" />
          {t("watchParty.waitlist.art.watching", { viewers })}
        </span>

        {REACTIONS.map((reaction) => (
          <span
            key={reaction.emoji}
            className="wp-art-reaction absolute bottom-[34%] text-lg sm:text-xl"
            style={
              {
                left: reaction.left,
                "--wp-delay": `${reaction.delay}ms`,
              } as CSSProperties
            }
          >
            {reaction.emoji}
          </span>
        ))}

        {/* The presenter's camera, floating over the film in the corner
            layout, the way `watch-party-stage.tsx` draws it. */}
        <div className="absolute bottom-2.5 right-2.5 w-[24%] min-w-16 overflow-hidden rounded-[var(--radius-control)] border-2 border-accent bg-surface-2 shadow-[var(--shadow-2)] sm:bottom-3 sm:right-3">
          <div className="relative flex aspect-[4/3] items-center justify-center bg-gradient-to-br from-accent/25 via-surface-2 to-surface-3">
            <UserAvatar
              name="Nina"
              avatarUrl={null}
              rounded="full"
              className="h-[46%] w-auto aspect-square text-sm"
            />
            <span className="absolute bottom-1 left-1 flex items-center gap-0.5 rounded bg-surface-0/75 px-1 py-px text-[9px] font-semibold text-text">
              <Mic className="h-2.5 w-2.5 text-accent" />
              Nina
            </span>
          </div>
        </div>

        {/* A scrub line under the picture: it is a stream, not a still. */}
        <div className="absolute inset-x-2.5 bottom-1 h-0.5 overflow-hidden rounded-full bg-text/20 sm:inset-x-3">
          <div className="h-full w-[62%] rounded-full bg-danger" />
        </div>
      </div>

      {chat && (
        <div
          aria-hidden="true"
          className="hidden w-[34%] min-w-0 flex-col border-l border-border bg-surface-1 sm:flex"
        >
          <div className="border-b border-border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
            # watch-party
          </div>
          <ul className="flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden px-2.5 py-2">
            {CHAT.map((line) => (
              <li key={line.key} className="flex min-w-0 items-start gap-1.5">
                <UserAvatar
                  name={line.name}
                  avatarUrl={null}
                  rounded="full"
                  className="h-5 w-5 shrink-0 text-[9px]"
                />
                <span className="min-w-0 text-[11px] leading-snug">
                  <span className="block truncate font-semibold text-text">
                    {line.name}
                  </span>
                  <span className="block truncate text-text-secondary">
                    {t(line.key)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div className="m-2 truncate rounded-[var(--radius-control)] border border-border bg-surface-0 px-2 py-1 text-[10px] text-text-tertiary">
            {t("watchParty.waitlist.art.composer")}
          </div>
        </div>
      )}
    </figure>
  );
}
