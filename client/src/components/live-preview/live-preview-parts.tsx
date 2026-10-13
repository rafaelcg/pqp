import type { LivePreviewUpcoming } from "@pqp/shared";
import { Bell, Clock, Lock, MessageSquare, Users } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { HeroMosaic } from "@/components/communities/hero-mosaic";
import { Button } from "@/components/ui/button";
import { heroTintStyle, initialsFor } from "@/lib/hero-tint";
import { useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import type { LivePreviewAuth } from "./live-preview-auth";

/**
 * The pieces the live preview's entry card and page are drawn from. Every
 * colour is a role token (`docs/DESIGN.md`); the design's hexes are the dark
 * theme, and the light theme follows the same names.
 */

/** What the panel knows about the community, from the page that hosts it. */
export interface LivePreviewCommunity {
  name: string;
  /** The public address, when the surface knows it (an invite does not). */
  slug: string | null;
  tagline: string | null;
  /** A `communities.category.*` id, when known. */
  category: string | null;
  memberCount: number | null;
  /** Already resolved to a loadable URL. */
  iconUrl: string | null;
  bannerUrl: string | null;
  /** Seeds the generated art when there is no banner or icon. */
  hue: number;
}

/**
 * The picture behind the entry card and behind the player before any media:
 * the community's banner, or its generated mosaic. NEVER the stream: nothing
 * of the film loads before the age answer.
 */
export function PreviewArt({ community }: { community: LivePreviewCommunity }) {
  return community.bannerUrl ? (
    <img
      src={community.bannerUrl}
      alt=""
      className="absolute inset-0 h-full w-full object-cover"
      decoding="async"
    />
  ) : (
    <span aria-hidden className="absolute inset-0">
      <HeroMosaic hue={community.hue} />
    </span>
  );
}

export function LiveBadge({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-danger font-bold uppercase tracking-[0.06em] text-text",
        small ? "px-2 py-1 text-[11px]" : "px-2.5 py-1 text-xs",
      )}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-text" />
      {children}
    </span>
  );
}

/** "38 assistindo". Accounts only; drawn only when the count is above zero. */
export function ViewerChip({ count, small = false }: { count: number; small?: boolean }) {
  const { t, locale } = useTranslation();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-surface-0/80 font-semibold text-text",
        small ? "px-2 py-1 text-xs" : "px-2.5 py-1 text-[13px]",
      )}
    >
      <Users aria-hidden className={small ? "h-3.5 w-3.5" : "h-4 w-4"} />
      {t("livePreview.viewers", {
        count,
        countLabel: count.toLocaleString(intlLocale(locale)),
      })}
    </span>
  );
}

export function CommunityAvatar({
  community,
  size,
  live = false,
}: {
  community: LivePreviewCommunity;
  size: "sm" | "md" | "lg";
  live?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-card)] font-display font-extrabold text-text",
        size === "sm" && "h-9 w-9 text-sm",
        size === "md" && "h-12 w-12 text-lg",
        size === "lg" && "h-[52px] w-[52px] text-xl",
        live && "ring-2 ring-danger ring-offset-2 ring-offset-surface-0",
      )}
      style={community.iconUrl ? undefined : heroTintStyle(community.hue, 60)}
    >
      {community.iconUrl ? (
        <img src={community.iconUrl} alt="" className="h-full w-full object-cover" decoding="async" />
      ) : (
        initialsFor(community.name)
      )}
    </span>
  );
}

/** "1.240 membros · Séries e filmes". */
export function useCommunityMeta(community: LivePreviewCommunity): string | null {
  const { t, locale } = useTranslation();
  const parts: string[] = [];
  if (typeof community.memberCount === "number") {
    parts.push(
      t("publicCommunity.members", {
        count: community.memberCount,
        countLabel: community.memberCount.toLocaleString(intlLocale(locale)),
      }),
    );
  }
  if (community.category) {
    parts.push(t(`communities.category.${community.category}` as never));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A session's day tile and time, in the reader's own locale and zone. */
export function sessionWhen(startsAt: number, locale: string) {
  const date = new Date(startsAt);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" })
    .format(date)
    .replace(/\.$/, "");
  const day = new Intl.DateTimeFormat(locale, { day: "numeric" }).format(date);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
  return { weekday, day, time };
}

export function DateTile({ startsAt, small = false }: { startsAt: number; small?: boolean }) {
  const { locale } = useTranslation();
  const when = sessionWhen(startsAt, intlLocale(locale));
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 flex-col items-center justify-center rounded-[var(--radius-card)] border border-border bg-surface-2 uppercase leading-tight text-text-tertiary",
        small ? "h-11 w-10 text-[10px]" : "h-12 w-11 text-[11px]",
      )}
    >
      {when.weekday}
      <b className={cn("font-display text-text", small ? "text-base" : "text-lg")}>{when.day}</b>
    </span>
  );
}

export function AboutCard({ community }: { community: LivePreviewCommunity }) {
  const { t, locale } = useTranslation();
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-[18px]">
      <div className="flex flex-wrap gap-1.5">
        <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-text-secondary">
          {t("livePreview.about.watchParty")}
        </span>
        {community.category && (
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-text-secondary">
            {t(`communities.category.${community.category}` as never)}
          </span>
        )}
      </div>
      <h2 className="font-display text-[17px] font-bold">{t("livePreview.about.title")}</h2>
      {community.tagline && (
        <p className="text-sm text-text-secondary [overflow-wrap:anywhere]">{community.tagline}</p>
      )}
      {typeof community.memberCount === "number" && (
        <p className="text-[13px] text-text-tertiary">
          {t("publicCommunity.members", {
            count: community.memberCount,
            countLabel: community.memberCount.toLocaleString(intlLocale(locale)),
          })}
        </p>
      )}
    </div>
  );
}

export function UpcomingCard({
  upcoming,
  onNotify,
}: {
  upcoming: readonly LivePreviewUpcoming[];
  /** Absent: no "Me avisa" (nobody is offered an account). */
  onNotify?: () => void;
}) {
  const { t, locale } = useTranslation();
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-[18px]">
      <h2 className="font-display text-[17px] font-bold">{t("livePreview.upcoming.title")}</h2>
      {upcoming.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t("livePreview.upcoming.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {upcoming.map((row) => {
            const when = sessionWhen(row.startsAt, intlLocale(locale));
            return (
              <li key={`${row.channelName}:${row.startsAt}`} className="flex items-center gap-3">
                <DateTile startsAt={row.startsAt} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold">{row.title}</span>
                  <span className="truncate text-[13px] text-text-tertiary">
                    {when.time} · #{row.channelName}
                  </span>
                </div>
                {onNotify && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-11 shrink-0 px-3 text-[13px]"
                    onClick={onNotify}
                  >
                    <Bell aria-hidden className="h-4 w-4" />
                    {t("livePreview.upcoming.notify")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The way to an account inside the end sheet and the chat card: Clerk's own
 * sign-up form drawn inline (its provider buttons and logos, pqp's wording),
 * then "Já tem conta? Entrar", which opens Clerk's sign-in modal.
 *
 * The person types into Clerk's form, not a button of ours, so the stashes
 * (the join intent, the channel, the attribution) run on their FIRST touch of
 * it, captured on the wrapper, before any provider can take the page away.
 * Without Clerk (the dev bypass) it is one "Criar conta" button instead.
 */
export function SignUpBlock({
  auth,
  onFirstTouch,
  onSignUp,
  onSignIn,
  large = false,
}: {
  auth: LivePreviewAuth;
  onFirstTouch: () => void;
  onSignUp: () => void;
  onSignIn: () => void;
  large?: boolean;
}) {
  const { t } = useTranslation();
  const touched = useRef(false);
  const touch = () => {
    if (!touched.current) {
      touched.current = true;
      onFirstTouch();
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {auth.renderInlineSignUp ? (
        <div
          data-live-preview-signup=""
          onPointerDownCapture={touch}
          onFocusCapture={touch}
          onKeyDownCapture={touch}
        >
          {auth.renderInlineSignUp()}
        </div>
      ) : (
        <Button
          type="button"
          className={cn(
            "w-full rounded-[var(--radius-card)] font-bold",
            large ? "h-12 text-base" : "h-11",
          )}
          onClick={onSignUp}
        >
          {t("livePreview.cta.signUp")}
        </Button>
      )}
      <p className="text-center text-sm text-text-tertiary">
        {t("livePreview.signIn.haveAccount")}{" "}
        <button
          type="button"
          className="inline-flex min-h-11 items-center font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          onClick={onSignIn}
        >
          {t("livePreview.signIn.link")}
        </button>
      </p>
    </div>
  );
}

/**
 * Message-shaped grey bars behind the locked chat. Decoration only: fixed
 * widths, no names, no text, no count, nothing read from the server.
 */
const CHAT_SKELETON = [
  ["34%", "78%"],
  ["22%", "54%"],
  ["40%", "88%"],
  ["28%", "62%"],
  ["18%", "70%"],
  ["36%", "46%"],
  ["26%", "82%"],
  ["30%", "58%"],
  ["24%", "66%"],
] as const;

export function ChatSkeleton({ rows = CHAT_SKELETON.length }: { rows?: number }) {
  return (
    <div aria-hidden className="flex flex-col gap-3.5 p-4 opacity-40">
      {CHAT_SKELETON.slice(0, rows).map(([name, line], index) => (
        <div key={index} className="flex items-start gap-2.5">
          <span className="h-7 w-7 shrink-0 rounded-full bg-surface-3" />
          <div className="flex flex-1 flex-col gap-1.5 pt-1">
            <span className="h-2 rounded-[var(--radius-control)] bg-surface-3" style={{ width: name }} />
            <span className="h-2 rounded-[var(--radius-control)] bg-surface-2" style={{ width: line }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function LockedChatIcon({ small = false }: { small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-accent-soft text-on-accent-soft",
        small ? "h-9 w-9" : "h-10 w-10",
      )}
    >
      <Lock className="h-5 w-5" />
    </span>
  );
}

/** The desktop column: a chat you can see the shape of and cannot read. */
export function LockedChatPanel({
  channelName,
  signUp,
}: {
  channelName: string;
  /** Absent: the card says the chat needs an account and offers none. */
  signUp?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
        <span className="inline-flex items-center gap-2 font-display text-[15px] font-bold">
          <MessageSquare aria-hidden className="h-4 w-4" />
          {t("livePreview.chat.title")}
        </span>
        <span className="truncate text-xs text-text-tertiary">#{channelName}</span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ChatSkeleton />
        {/* The card floats over the skeleton, centred, and scrolls itself
            when Clerk's form is taller than the column. */}
        <div className="absolute inset-4 flex items-center">
          <div className="elevation-3 flex max-h-full w-full flex-col gap-3.5 overflow-y-auto overscroll-contain rounded-[var(--radius-panel)] px-5 py-[22px]">
            <LockedChatIcon />
            <div className="flex flex-col gap-1.5">
              <h2 className="font-display text-[19px] font-bold leading-tight">
                {t("livePreview.chat.lockedTitle")}
              </h2>
              <p className="text-sm text-text-secondary">{t("livePreview.chat.lockedBody")}</p>
            </div>
            {signUp}
          </div>
        </div>
      </div>
      <div className="border-t border-border px-4 py-3">
        <label className="sr-only" htmlFor="live-preview-chat-locked">
          {t("livePreview.chat.inputLabel")}
        </label>
        <input
          id="live-preview-chat-locked"
          type="text"
          disabled
          placeholder={t("livePreview.chat.placeholder")}
          className="h-11 w-full cursor-not-allowed rounded-[var(--radius-card)] border border-border bg-surface-0 px-3.5 text-sm text-text-tertiary placeholder:text-text-tertiary"
        />
      </div>
    </>
  );
}

/** The phone's Chat tab: the same locked chat, the card on top. */
export function LockedChatCompact() {
  const { t } = useTranslation();
  return (
    <div className="relative min-h-[260px] overflow-hidden">
      <ChatSkeleton rows={6} />
      <div className="elevation-3 absolute inset-x-4 top-[22px] flex items-start gap-3 rounded-[var(--radius-panel)] p-4">
        <LockedChatIcon small />
        <div className="flex flex-col gap-1">
          <span className="font-display text-base font-bold leading-tight">
            {t("livePreview.chat.lockedTitle")}
          </span>
          <span className="text-[13px] text-text-secondary">{t("livePreview.chat.lockedBody")}</span>
        </div>
      </div>
    </div>
  );
}

/** The countdown pill's clock, in the warning colour once time is short. */
export function CountdownClock({ urgent }: { urgent: boolean }) {
  return (
    <Clock aria-hidden className={cn("h-4 w-4", urgent ? "text-warning" : "text-accent")} />
  );
}
