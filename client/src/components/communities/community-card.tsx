import type { CommunitySummary } from "@pqp/shared";
import { Check, Flag, Users } from "lucide-react";
import type { CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  CATEGORY_EMOJI,
  cardAction,
  communityHue,
  formatMemberCount,
  memberCountKey,
  monogram,
} from "./communities-model";

/**
 * One community, as a card in the directory grid.
 *
 * ITS OWN FILE, AND DELIBERATELY COMPOSABLE. Servers are growing real icon and
 * banner images in a change landing beside this one, and a card is exactly the
 * surface those want to appear on. So the two image slots already exist as
 * props: pass a URL and the card draws it, pass nothing (which is every
 * community today) and it falls back to the generated tint and the monogram.
 * Nothing above has to change shape when the fields arrive — `CommunitySummary`
 * grows two optional members and they get forwarded.
 *
 * The tint is not decoration for its own sake. A grid of nine cards that differ
 * only in a line of text is a wall, and a person scanning it has nothing to aim
 * at; a stable per-community hue gives every card a shape you can come back to.
 * It is mixed INTO the surface token rather than painted over it, so light and
 * dark each get a tint that belongs to their own palette.
 */

interface CommunityCardProps {
  community: CommunitySummary;
  /** True while this card's own join request is in flight. */
  joining: boolean;
  onEnter: () => void;
  onReport: () => void;
  /**
   * The community's banner image, when servers have one. Absent today; drawn
   * across the card's header the moment it is passed.
   */
  bannerUrl?: string | null;
  /** The community's icon, drawn in place of the monogram when present. */
  iconUrl?: string | null;
}

/**
 * The header wash, and the avatar behind a missing icon.
 *
 * `color-mix` against the surface tokens is what keeps this theme-correct: the
 * base is whatever the active theme says a raised surface is, and the hue is
 * mixed in on top. A hard-coded pair of colours would look right in exactly one
 * of the two themes.
 */
function tintStyle(hue: number, strength: number): CSSProperties {
  // The colour literals live in the token layer (--community-tint-near/far in
  // index.css); this only supplies the per-community numbers they read. That
  // split is what keeps the bench's leak gate honest about where colour lives.
  return {
    "--community-hue": String(hue),
    "--community-hue-far": String((hue + 48) % 360),
    "--community-tint-strength": `${strength}%`,
    "--community-tint-strength-far": `${Math.round(strength * 0.6)}%`,
    backgroundImage:
      "linear-gradient(135deg, var(--community-tint-near), var(--community-tint-far))",
  } as CSSProperties;
}

export function CommunityCard({
  community,
  joining,
  onEnter,
  onReport,
  bannerUrl = null,
  iconUrl = null,
}: CommunityCardProps) {
  const { t, locale } = useTranslation();
  const action = cardAction(community);
  const hue = communityHue(community.id);

  return (
    <li
      className="group relative flex flex-col overflow-hidden rounded-2xl border border-ink-4 bg-ink-2 transition duration-200 hover:-translate-y-0.5 hover:border-signal/45 hover:shadow-[0_14px_36px_var(--glow-accent)] focus-within:border-signal/45"
      data-community={community.id}
    >
      {/* The header. Short enough that it never pushes the name below the fold
          on a 390px screen, tall enough to carry a real banner when one turns
          up — the same box serves both. */}
      <div
        className="relative h-20 shrink-0 overflow-hidden"
        style={bannerUrl ? undefined : tintStyle(hue, 30)}
      >
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        )}
        {/* Fades the header into the card body so the avatar below has
            something to sit against rather than a hard seam. */}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-ink-2 to-transparent"
        />
        <span
          aria-hidden="true"
          className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-ink/55 px-2.5 py-1 text-[11px] font-semibold text-paper backdrop-blur-sm"
        >
          <span>{CATEGORY_EMOJI[community.category]}</span>
          {t(`communities.category.${community.category}` as never)}
        </span>
        {/* Quiet until you reach for it — but reachable by keyboard always,
            and drawn permanently on anything without a pointer. A moderation
            affordance that only exists for people with a mouse is not a
            moderation affordance, and "hover" on a phone is a state that never
            arrives. */}
        <button
          type="button"
          title={t("communities.report")}
          aria-label={`${t("communities.report")}: ${community.name}`}
          className="absolute right-2 top-2 rounded-lg bg-ink/50 p-1.5 text-paper-muted opacity-0 backdrop-blur-sm transition hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={onReport}
        >
          <Flag aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col px-4 pb-4">
        {/* `relative` is load-bearing, not decoration: the header above is
            positioned, and a positioned box paints over a static sibling no
            matter what the source order says — without this the avatar is
            sliced in half by the banner it is supposed to overlap. */}
        <span
          aria-hidden="true"
          className="relative -mt-7 flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl font-display text-base font-bold text-paper ring-4 ring-ink-2"
          style={iconUrl ? undefined : tintStyle(hue, 55)}
        >
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            monogram(community.name)
          )}
        </span>

        <h3 className="mt-3 truncate font-display text-base font-bold text-paper">
          {community.name}
        </h3>

        <p className="mt-1 flex items-center gap-1.5 text-xs text-paper-muted">
          <Users aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          {/* Tabular figures so a column of counts lines up rather than
              shimmering as the digits change width. */}
          <span className="tabular-nums">
            {t(memberCountKey(community.memberCount), {
              count: formatMemberCount(community.memberCount, locale),
            })}
          </span>
        </p>

        {/* Clamped to two lines rather than truncated to one: a tagline is the
            joke, and half a joke is worse than none. */}
        {community.tagline && (
          <p className="mt-2 line-clamp-2 text-sm leading-snug text-paper-muted">
            {community.tagline}
          </p>
        )}

        <div className="mt-auto flex items-center gap-2 pt-4">
          <Button
            size="sm"
            className="min-w-[5.5rem]"
            variant={action === "open" ? "secondary" : "default"}
            disabled={joining}
            onClick={onEnter}
          >
            {joining
              ? t("communities.joining")
              : t(action === "open" ? "communities.open" : "communities.join")}
          </Button>
          {/* Stated as well as implied. The button already reads "Open" for a
              community you are in, but that is a difference of one word between
              two cards side by side; the pill is the one that survives a
              glance. */}
          {community.joined && (
            <span className="flex items-center gap-1 text-xs font-medium text-success">
              <Check aria-hidden="true" className="h-3.5 w-3.5" />
              {t("communities.joinedBadge")}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * A card-shaped hole, for the moment before the first page lands.
 *
 * Matches the real card's geometry (header, overlapping avatar, three lines,
 * a button) rather than being a plain rectangle, so the grid does not jump when
 * the data arrives — which is the only thing a skeleton is for.
 */
export function CommunityCardSkeleton({ className }: { className?: string }) {
  return (
    <li
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border border-ink-4 bg-ink-2",
        className,
      )}
      aria-hidden="true"
    >
      <Skeleton className="h-20 w-full rounded-none" />
      <div className="px-4 pb-4">
        <Skeleton className="-mt-7 h-14 w-14 rounded-2xl ring-4 ring-ink-2" />
        <Skeleton className="mt-3 h-4 w-2/3" />
        <Skeleton className="mt-2 h-3 w-24" />
        <Skeleton className="mt-3 h-3 w-full" />
        <Skeleton className="mt-1.5 h-3 w-4/5" />
        <Skeleton className="mt-4 h-8 w-24 rounded-md" />
      </div>
    </li>
  );
}
