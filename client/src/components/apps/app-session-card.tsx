import { LoaderCircle, TriangleAlert, Eye, RefreshCw, Gamepad2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { AppIconTile } from "@/components/apps/app-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import {
  formatCountdown,
  formatSessionDuration,
  type CardCount,
  type CardModel,
  type CardPerson,
  type CardSubtitle,
  type EndedCardModel,
  type LiveCardModel,
} from "@/lib/apps/card-model";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn, formatTime } from "@/lib/utils";

/**
 * The card an app leaves in the conversation (mock 02): a live card while the
 * session runs, a quiet dashed record once it is over. Pure over its model and
 * callbacks; `AppSessionTimelineRow` is the part that reads the stores.
 *
 * Only the buttons are focus targets, in visual order (Sair before Voltar pro
 * app). One button element changes its label through Entrar, Entrando and
 * Tentar de novo, and is `aria-disabled` rather than `disabled` while busy: a
 * disabled button drops focus, and a failed join has to leave focus where it
 * was (mock 02, estado 5).
 */

/** How long a person who left stays drawn so the avatar can fade. */
const AVATAR_EXIT_MS = 120;
/** Joins inside this window are announced together ("3 pessoas entraram"). */
const JOIN_ANNOUNCE_WINDOW_MS = 2_000;

/** A button that is waiting reads as waiting, and still holds focus (aria-disabled, not disabled). */
const BUSY_LOOK = "aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

export interface AppSessionCardProps {
  model: CardModel;
  /** The session's start, drawn on a quiet card ("Começou a bia, às 19:40"). */
  fresh?: boolean;
  onJoin?: (options: { asSpectator: boolean }) => void;
  onLeave?: () => void;
  onFocusApp?: () => void;
}

export const AppSessionCard = memo(function AppSessionCard({
  model,
  fresh = false,
  onJoin,
  onLeave,
  onFocusApp,
}: AppSessionCardProps) {
  const { t } = useTranslation();
  const mounted = useRef(false);
  const [settling, setSettling] = useState(false);
  const previousKind = useRef(model.kind);

  // Live to quiet: a short crossfade of the contents.
  useEffect(() => {
    if (mounted.current && previousKind.current === "live" && model.kind === "ended") {
      setSettling(true);
      const timer = window.setTimeout(() => setSettling(false), 320);
      previousKind.current = model.kind;
      return () => window.clearTimeout(timer);
    }
    previousKind.current = model.kind;
    mounted.current = true;
    return undefined;
  }, [model.kind]);

  const ended = model.kind === "ended";
  const inside =
    model.kind === "live" && (model.phase === "inside" || model.phase === "reconnecting");

  return (
    <section
      role="group"
      aria-label={cardTitle(model, t)}
      data-testid="app-session-card"
      data-state={model.kind === "live" ? model.phase : model.disabled ? "disabled" : "ended"}
      className={cn(
        "flex w-full max-w-[440px] flex-col gap-3 rounded-[var(--radius-card)] border p-3",
        ended
          ? "border-dashed border-border bg-transparent"
          : inside
            ? "border-accent bg-surface-1"
            : "border-border bg-surface-1",
        fresh && "app-card-in",
        settling && "app-card-settle",
      )}
    >
      <CardHead model={model} />
      {model.kind === "live" ? (
        <LiveBody
          model={model}
          onJoin={onJoin}
          onLeave={onLeave}
          onFocusApp={onFocusApp}
        />
      ) : (
        <EndedBody model={model} />
      )}
      <Announcer model={model} />
    </section>
  );
});

// ---------------------------------------------------------------------------

function subtitleText(
  subtitle: CardSubtitle,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  switch (subtitle.kind) {
    case "started":
      if (subtitle.minutes < 1) {
        return t("apps.card.startedNow", { name: subtitle.name });
      }
      if (subtitle.minutes < 60) {
        return t("apps.card.startedMinutes", {
          name: subtitle.name,
          count: subtitle.minutes,
        });
      }
      return t("apps.card.startedHours", {
        name: subtitle.name,
        count: Math.floor(subtitle.minutes / 60),
      });
    case "inside":
      return t(subtitle.spectating ? "apps.card.insideWatching" : "apps.card.insideYou");
    case "reconnecting":
      return t("apps.card.reconnectingLine");
    case "handoff": {
      const time = formatCountdown(subtitle.seconds);
      if (subtitle.to.kind === "you") {
        return t("apps.card.handoffYou", { host: subtitle.host, time });
      }
      if (subtitle.to.kind === "none") {
        return t("apps.card.handoffNone", { host: subtitle.host, time });
      }
      return t("apps.card.handoff", {
        host: subtitle.host,
        next: subtitle.to.name,
        time,
      });
    }
  }
}

function endedLine(
  model: EndedCardModel,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (model.disabled) {
    return t("apps.card.disabled");
  }
  if (!model.summary || model.summary.participants === 0) {
    return t("apps.card.endedPlain");
  }
  const game = model.app.category !== "tool";
  const count = model.summary.participants;
  const duration = formatSessionDuration(model.summary.durationSeconds);
  return t(game ? "apps.card.endedGame" : "apps.card.endedOther", { count, duration });
}

function countText(
  count: CardCount,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  switch (count.kind) {
    case "none":
      return t("apps.card.countNone");
    case "of":
      return t("apps.card.countOf", {
        players: count.players,
        max: count.max,
        count: count.max,
      });
    case "open":
      return t("apps.card.countOpen", { count: count.players });
    case "inside-full":
      return t("apps.card.countInsideFull", { count: count.players });
    case "full":
      return count.watching > 0
        ? t("apps.card.countFullWatching", {
            players: count.players,
            max: count.max,
            count: count.watching,
          })
        : t("apps.card.countFull", { players: count.players, max: count.max });
  }
}

function cardTitle(
  model: CardModel,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  return model.kind === "ended" && model.gone ? t("apps.card.goneTitle") : model.app.name;
}

function CardHead({ model }: { model: CardModel }) {
  const { t } = useTranslation();
  const ended = model.kind === "ended";
  const subtitle =
    model.kind === "live" ? subtitleText(model.subtitle, t) : endedLine(model, t);
  return (
    <div className="flex items-center gap-3">
      <AppIconTile icon={model.app.icon} dimmed={ended} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="min-w-0 truncate font-display text-sm font-bold leading-5 text-text">
            {cardTitle(model, t)}
          </p>
          {ended && model.disabled ? (
            <Badge variant="neutral">{t("apps.card.disabledBadge")}</Badge>
          ) : null}
        </div>
        <p
          className={cn(
            "text-xs leading-4 text-text-tertiary",
            ended ? "line-clamp-2" : "truncate",
          )}
          data-testid="app-card-subtitle"
        >
          {subtitle}
        </p>
        {ended && !model.disabled && model.resultText ? (
          <p
            className="truncate text-xs leading-4 text-text-secondary"
            title={model.resultText}
            data-testid="app-card-result"
          >
            {model.resultText}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Avatars({
  people,
  more,
  ended,
}: {
  people: readonly CardPerson[];
  more: number;
  ended: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const seen = useRef<Set<string> | null>(null);
  const [leaving, setLeaving] = useState<CardPerson[]>([]);
  const previous = useRef<readonly CardPerson[]>(people);

  // Somebody who just left stays for a beat so the avatar can fade out.
  useEffect(() => {
    const gone = previous.current.filter(
      (one) => !people.some((now) => now.userId === one.userId),
    );
    previous.current = people;
    if (gone.length === 0 || reduced) {
      return;
    }
    setLeaving((current) => [...current, ...gone]);
    const timer = window.setTimeout(
      () => setLeaving((current) => current.filter((one) => !gone.includes(one))),
      AVATAR_EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [people, reduced]);

  const known = seen.current;
  seen.current = new Set(people.map((one) => one.userId));

  if (people.length === 0 && leaving.length === 0) {
    return null;
  }
  return (
    <div aria-hidden className="flex items-center -space-x-[6px]">
      {people.map((person) => (
        <UserAvatar
          key={person.userId}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          rounded="full"
          className={cn(
            "h-6 w-6 ring-2",
            ended ? "ring-surface-0" : "ring-surface-1",
            known && !known.has(person.userId) && "app-avatar-in",
          )}
          fallbackClassName="bg-surface-3 text-[10px] font-semibold text-text"
        />
      ))}
      {leaving.map((person) => (
        <UserAvatar
          key={`left:${person.userId}`}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          rounded="full"
          className="app-avatar-out h-6 w-6 ring-2 ring-surface-1"
          fallbackClassName="bg-surface-3 text-[10px] font-semibold text-text"
        />
      ))}
      {more > 0 ? (
        <span
          className={cn(
            "z-[1] flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[10px] font-semibold text-text-secondary ring-2",
            ended ? "bg-surface-2 ring-surface-0" : "bg-surface-2 ring-surface-1",
          )}
        >
          +{more}
        </span>
      ) : null}
    </div>
  );
}

function Spinner() {
  return (
    <>
      <LoaderCircle aria-hidden className="h-4 w-4 animate-spin motion-reduce:hidden" />
      <span
        aria-hidden
        className="hidden h-3.5 w-3.5 rounded-full border-2 border-dashed border-current motion-reduce:inline-block"
      />
    </>
  );
}

function LiveBody({
  model,
  onJoin,
  onLeave,
  onFocusApp,
}: {
  model: LiveCardModel;
  onJoin?: AppSessionCardProps["onJoin"];
  onLeave?: AppSessionCardProps["onLeave"];
  onFocusApp?: AppSessionCardProps["onFocusApp"];
}) {
  const { t } = useTranslation();
  const joining = model.join.status === "joining";
  const failed = model.join.status === "failed" ? model.join.code : null;
  const count = countText(model.count, t);
  const showCountBadge = model.phase === "reconnecting";

  const countRef = useRef(count);
  const [swapKey, setSwapKey] = useState(0);
  useEffect(() => {
    if (countRef.current !== count) {
      countRef.current = count;
      setSwapKey((key) => key + 1);
    }
  }, [count]);

  const inside = model.phase === "inside" || model.phase === "reconnecting";

  return (
    <>
      {failed ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius-control)] bg-danger-soft px-2.5 py-2 text-xs leading-4 text-on-danger-soft"
        >
          <TriangleAlert aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{t(failureKey(failed))}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          {showCountBadge ? (
            <Badge variant="warning">
              <Spinner />
              {t("apps.card.reconnecting")}
            </Badge>
          ) : (
            <>
              <Avatars people={model.people} more={model.more} ended={false} />
              <span
                key={swapKey}
                data-testid="app-card-count"
                className={cn(
                  "text-xs leading-4 text-text-secondary",
                  swapKey > 0 && "app-count-swap",
                )}
              >
                {count}
              </span>
            </>
          )}
        </div>
        {inside ? (
          <div className="flex w-full gap-2 sm:w-auto">
            {model.phase === "reconnecting" ? null : (
              <Button
                variant="ghost"
                className="h-11 min-w-[120px] flex-1 sm:h-9 sm:min-w-0 sm:flex-none sm:px-3"
                onClick={() => onLeave?.()}
              >
                {t("apps.leave")}
              </Button>
            )}
            <Button
              variant="secondary"
              className={cn(
                "h-11 min-w-[120px] flex-1 sm:h-9 sm:min-w-0 sm:flex-none sm:px-3",
                BUSY_LOOK,
              )}
              aria-disabled={model.phase === "reconnecting" || undefined}
              onClick={() => {
                if (model.phase !== "reconnecting") {
                  onFocusApp?.();
                }
              }}
            >
              {t("apps.card.backToApp")}
            </Button>
          </div>
        ) : model.full && !model.canWatch ? null : (
          <Button
            variant={model.full || failed ? "secondary" : "default"}
            className={cn("h-11 w-full sm:h-9 sm:w-auto", BUSY_LOOK)}
            aria-busy={joining || undefined}
            aria-disabled={joining || undefined}
            onClick={() => {
              if (!joining) {
                onJoin?.({ asSpectator: model.full });
              }
            }}
          >
            {joining ? (
              <>
                <Spinner />
                {t("apps.card.joining")}
              </>
            ) : failed ? (
              <>
                <RefreshCw aria-hidden className="h-4 w-4" />
                {t("apps.card.retry")}
              </>
            ) : model.full ? (
              <>
                <Eye aria-hidden className="h-4 w-4" />
                {t("apps.watch")}
              </>
            ) : (
              t("apps.join")
            )}
          </Button>
        )}
      </div>
    </>
  );
}

function failureKey(code: "connection" | "not-allowed" | "rate-limited" | "unavailable"): MessageKey {
  switch (code) {
    case "not-allowed":
      return "apps.card.joinNotAllowed";
    case "rate-limited":
      return "apps.card.joinRateLimited";
    case "unavailable":
      return "apps.card.joinUnavailable";
    default:
      return "apps.card.joinFailed";
  }
}

function EndedBody({ model }: { model: EndedCardModel }) {
  const { t } = useTranslation();
  if (model.disabled) {
    return null;
  }
  return (
    <div className="flex items-center gap-2">
      <Avatars people={model.people} more={model.more} ended />
      <span className="text-xs leading-4 text-text-tertiary">
        {t("apps.card.startedBy", {
          name: model.starterName,
          time: formatTime(model.startedAt),
        })}
      </span>
    </div>
  );
}

/**
 * The card's screen reader voice (mock 02): one polite region, joins grouped
 * ("3 pessoas entraram" when three arrive within two seconds), leaves never
 * announced, the end said once without moving focus.
 */
function Announcer({ model }: { model: CardModel }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const known = useRef<string[] | null>(null);
  const pending = useRef<string[]>([]);
  const timer = useRef<number | null>(null);
  const wasLive = useRef(model.kind === "live");

  const ids = model.kind === "live" ? model.people.map((one) => one.userId).join("|") : "";
  const appName = cardTitle(model, t);

  useEffect(() => {
    if (model.kind !== "live") {
      return;
    }
    const current = model.people.map((one) => one.userId);
    if (known.current !== null) {
      const added = model.people.filter((one) => !known.current!.includes(one.userId));
      if (added.length > 0) {
        pending.current.push(...added.map((one) => one.displayName));
        if (timer.current === null) {
          timer.current = window.setTimeout(() => {
            timer.current = null;
            const joined = pending.current;
            pending.current = [];
            setText(
              joined.length === 1
                ? t("apps.card.srJoined", { name: joined[0]!, app: appName })
                : t("apps.card.srJoinedMany", { count: joined.length, app: appName }),
            );
          }, JOIN_ANNOUNCE_WINDOW_MS);
        }
      }
    }
    known.current = current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  useEffect(() => {
    if (model.kind === "ended" && wasLive.current) {
      wasLive.current = false;
      setText(t("apps.card.srEnded", { app: appName }));
    }
  }, [model.kind, appName, t]);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  return (
    <span className="sr-only" aria-live="polite" role="status" data-testid="app-card-live">
      {text}
    </span>
  );
}

/** The line above a card, in the log's own voice: "bia começou um app". */
export function AppSessionSystemLine({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <p className="flex items-center gap-1.5 text-[13px] leading-5 text-text-tertiary">
      <Gamepad2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t("apps.card.systemLine", { name })}</span>
    </p>
  );
}
