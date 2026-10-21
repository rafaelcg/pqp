import {
  ChevronDown,
  LoaderCircle,
  LogOut,
  MessageSquare,
  MonitorUp,
  PhoneCall,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Square,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AppIconTile } from "@/components/apps/app-icon";
import "@/components/apps/apps-strip.css";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Menu } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { Tooltip } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import { unreadBadgeText, type ChatUnread } from "@/lib/apps/app-chat-visibility";
import { formatCountdown, formatSessionDuration } from "@/lib/apps/card-model";
import {
  announceHandoffAt,
  type EndedStripModel,
  type LiveStripModel,
  type StripCount,
  type StripModel,
  type StripRoleLine,
} from "@/lib/apps/strip-model";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The strip above an app (mock 03): who is running it, how many are in, and the
 * few controls that belong to the session and not to the app. Pure over its
 * model and callbacks; `AppSessionLayout` is the part that reads the stores.
 *
 * ONE ROW OF CONTROLS IN A FIXED ORDER, because a person who has used it once
 * finds it with their hand: the share switch, a separator, Sair, Encerrar, the
 * menu. A control the person cannot use is absent, never disabled with an
 * apology (the app that cannot share has no switch, like the camera button of
 * an audio-only call). The one exception is the share switch while the person
 * is not in the call, which is shown and says why.
 *
 * The strip is a region landmark and comes BEFORE the app in the reading order,
 * with a "Pular o app" control first, because an app may trap the keyboard
 * inside its frame and the strip is what a person tabs back to.
 */

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export interface StripShareState {
  /** The host may share, this app is a pane app and the server allows it. */
  visible: boolean;
  on: boolean;
  /** The picker is open or the publish is starting. */
  pending: boolean;
  /** Not in this channel's call: the switch is shown and says so. */
  needsCall: boolean;
  /**
   * The person is already sharing something else in this call (another screen, not this pane): the switch is shown and
   * says so, because starting a second share would take that one away.
   */
  otherShare?: boolean;
  /** How many other people are in the call to see it. */
  viewers: number;
  /** This browser shares the whole tab (no Region Capture). */
  wholeTab: boolean;
}

export interface AppSessionStripProps {
  model: StripModel;
  /** Phone layout: the collapsed bar and a sheet. */
  compact?: boolean;
  share?: StripShareState;
  /** A join or a take-over is in flight. */
  busy?: { join?: boolean; takeHost?: boolean };
  /** The ended strip is collapsing: height 52 to 0. */
  collapsing?: boolean;
  /** Play the arrival animation. */
  entering?: boolean;
  /** A control failed (end, take over): said once, as an alert. */
  error?: string | null;
  onShareChange?: (on: boolean) => void;
  onLeave?: () => void;
  onEnd?: () => void;
  onJoin?: (options: { asSpectator: boolean }) => void;
  onTakeHost?: () => void;
  onClose?: () => void;
  onSkipToApp?: () => void;
  /** The chat beside the app, put away or shown (`app_pane_layout_v2`). */
  chat?: StripChatToggle;
  /**
   * This channel has a call the person is not in: one click joins it, with the
   * app left open. The strip is the one place to join while an app is on
   * screen (the page header's own button stands down), for everybody seated,
   * not only a host who could share.
   */
  joinCall?: StripJoinCall;
}

export interface StripJoinCall {
  onJoin: () => void;
  /** The join is on its way. */
  joining: boolean;
}

function JoinCallButton({
  join,
  forShare,
  compact = false,
}: {
  join: StripJoinCall;
  forShare: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip label={forShare ? t("apps.strip.joinCallToShare") : t("apps.strip.joinCallHint")}>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={compact ? "h-11 shrink-0 px-3" : undefined}
        data-testid="app-strip-join-call"
        aria-disabled={join.joining || undefined}
        aria-busy={join.joining || undefined}
        onClick={() => {
          if (!join.joining) join.onJoin();
        }}
      >
        {join.joining ? <Spinner /> : <PhoneCall aria-hidden className="h-3.5 w-3.5" />}
        {t("apps.strip.joinCall")}
      </Button>
    </Tooltip>
  );
}

export interface StripChatToggle {
  hidden: boolean;
  /** What arrived while it was away: a dot, or a count when somebody named you. */
  unread: ChatUnread;
  /** "Ctrl + Shift + .", for the tooltip. */
  shortcut: string | null;
  /** The id of the column it shows and hides (`aria-controls`). */
  controls: string;
  onToggle: () => void;
}

export function lineText(line: StripRoleLine, t: T): string {
  switch (line.kind) {
    case "host":
      return t("apps.strip.host");
    case "hostIs":
      return t("apps.strip.hostIs", { name: line.name });
    case "watching":
      return t("apps.strip.watching", { name: line.name });
    case "handoffYou":
      return t("apps.strip.handoffYou", {
        host: line.host,
        time: formatCountdown(line.seconds),
      });
    case "handoffOther":
      return t("apps.strip.handoffOther", {
        host: line.host,
        next: line.next,
        time: formatCountdown(line.seconds),
      });
    case "handoffNone":
      return t("apps.strip.handoffNone", {
        host: line.host,
        time: formatCountdown(line.seconds),
      });
    case "reconnecting":
      return t("apps.strip.reconnecting");
    case "lost":
      return t("apps.strip.lost");
  }
}

export function countText(count: StripCount, t: T): string {
  switch (count.kind) {
    case "none":
      return t("apps.strip.countNone");
    case "of":
      return count.watching > 0
        ? t("apps.strip.countOfWatching", {
            players: count.players,
            max: count.max,
            count: count.watching,
          })
        : t("apps.strip.countOf", { players: count.players, max: count.max });
    case "open":
      return count.watching > 0
        ? t("apps.strip.countOpenWatching", {
            players: count.players,
            count: count.watching,
          })
        : t("apps.strip.countOpen", { count: count.players });
  }
}

export function endedLineText(model: EndedStripModel, t: T): string {
  if (model.disabled) {
    return t("apps.strip.endedDisabled");
  }
  const cause = model.cause;
  let first: string;
  switch (cause.kind) {
    case "host":
      first = cause.self
        ? t("apps.strip.endedBySelf")
        : t("apps.strip.endedByHost", { name: cause.name });
      break;
    case "moderator":
      first = t("apps.strip.endedByModerator");
      break;
    case "idle":
      first = t("apps.strip.endedIdle");
      break;
    case "host-gone":
      first = t("apps.strip.endedHostGone");
      break;
    case "empty":
      first = t("apps.strip.endedEmpty");
      break;
    case "max-duration":
      first = t("apps.strip.endedMaxDuration");
      break;
    case "channel-gone":
      first = t("apps.strip.endedChannelGone");
      break;
    default:
      first = t("apps.strip.endedPlain");
  }
  if (!model.summary) {
    return first;
  }
  const summary = t("apps.strip.endedSummary", {
    count: model.summary.participants,
    duration: formatSessionDuration(model.summary.durationSeconds),
  });
  return `${first} ${summary}`;
}

function Dot({ tone }: { tone: "live" | "off" | "gone" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        tone === "live" && "app-live-dot bg-success",
        tone === "off" && "bg-warning",
        tone === "gone" && "bg-text-tertiary",
      )}
    />
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden
      className={cn("h-3.5 w-3.5 animate-spin motion-reduce:animate-none", className)}
    />
  );
}

function AvatarStack({ model }: { model: LiveStripModel }) {
  if (model.people.length === 0 || model.phase === "reconnecting" || model.phase === "lost") {
    return null;
  }
  return (
    <span className="flex shrink-0 items-center max-[959px]:hidden" aria-hidden>
      {model.people.map((person, index) => (
        <UserAvatar
          key={person.userId}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          rounded="full"
          className={cn(
            "h-6 w-6 ring-2 ring-surface-1",
            index > 0 && "-ml-1.5",
          )}
          fallbackClassName="bg-surface-3 text-[10px] text-text-secondary"
        />
      ))}
      {model.more > 0 ? (
        <span className="-ml-1.5 grid h-6 min-w-6 place-items-center rounded-full bg-surface-3 px-1 text-[10px] text-text-secondary ring-2 ring-surface-1">
          +{model.more}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A line that is spoken once per change, not once per second: the host's
 * countdown ticks on screen every second and is announced at 60, 30 and 10.
 */
function Announcer({ model }: { model: StripModel }) {
  const { t } = useTranslation();
  const [said, setSaid] = useState("");
  const last = useRef<{ phase: string; host: boolean; second: number | null }>({
    phase: "",
    host: false,
    second: null,
  });

  useEffect(() => {
    if (model.kind !== "live") {
      return;
    }
    const previous = last.current;
    const seconds =
      model.line.kind === "handoffYou" ||
      model.line.kind === "handoffOther" ||
      model.line.kind === "handoffNone"
        ? model.line.seconds
        : null;
    let next: string | null = null;
    if (model.phase !== previous.phase) {
      if (model.phase === "reconnecting") next = t("apps.strip.srReconnecting");
      else if (previous.phase === "reconnecting") next = t("apps.strip.srBack");
      else if (model.phase === "handoff-you" || model.phase === "handoff-other") {
        next = lineText(model.line, t);
      }
    }
    if (model.isHost && !previous.host && previous.phase.startsWith("handoff")) {
      next = t("apps.strip.srHostNow");
    }
    if (
      next === null &&
      seconds !== null &&
      seconds !== previous.second &&
      announceHandoffAt(seconds)
    ) {
      next = lineText(model.line, t);
    }
    last.current = { phase: model.phase, host: model.isHost, second: seconds };
    if (next !== null) {
      setSaid(next);
    }
  }, [model, t]);

  return (
    <span role="status" aria-live="polite" className="sr-only">
      {said}
    </span>
  );
}

function PeopleDialog({
  open,
  model,
  onClose,
}: {
  open: boolean;
  model: LiveStripModel;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      title={t("apps.strip.peopleTitle", { app: model.app.name })}
      size="sm"
      onClose={onClose}
    >
      <DialogBody>
      <ul className="flex flex-col gap-1">
        {model.roster.map((person) => (
          <li key={person.userId} className="flex items-center gap-3 py-1.5">
            <UserAvatar
              name={person.name}
              avatarUrl={person.avatarUrl}
              rounded="full"
              className="h-8 w-8"
              fallbackClassName="bg-surface-3 text-xs text-text-secondary"
            />
            <span className="min-w-0 flex-1 truncate text-sm text-text">{person.name}</span>
            <span className="shrink-0 text-xs text-text-tertiary">
              {[
                person.host ? t("apps.strip.peopleHost") : null,
                person.spectator ? t("apps.strip.peopleWatching") : null,
                person.reconnecting ? t("apps.strip.peopleReconnecting") : null,
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
          </li>
        ))}
      </ul>
      </DialogBody>
    </Dialog>
  );
}

/** Everything a person can do from the strip, drawn once for the bar and the sheet. */
function useStripActions() {
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [people, setPeople] = useState(false);
  return { confirmEnd, setConfirmEnd, people, setPeople };
}

export function AppSessionStrip(props: AppSessionStripProps) {
  const { model } = props;
  if (model.kind === "ended") {
    return <EndedStrip {...props} model={model} />;
  }
  return props.compact ? (
    <CompactStrip {...props} model={model} />
  ) : (
    <LiveStrip {...props} model={model} />
  );
}

function stripShell(model: LiveStripModel): string {
  return model.tone === "warn"
    ? "bg-warning-soft text-on-warning-soft border-transparent"
    : "bg-surface-1 border-border text-text";
}

// ---------------------------------------------------------------------------
// Desktop

function LiveStrip(props: AppSessionStripProps & { model: LiveStripModel }) {
  const { model, share, busy, entering, onShareChange, onLeave, onJoin, onTakeHost, onSkipToApp } =
    props;
  const { t } = useTranslation();
  const actions = useStripActions();
  const warn = model.tone === "warn";
  const reconnecting = model.phase === "reconnecting";
  const line = lineText(model.line, t);
  // ONE PRIMARY BUTTON. Whoever may end the session sees Encerrar and finds
  // Sair in the menu (leaving is the rarer act for a host, and two buttons side
  // by side that both make the app go away read as a choice to be puzzled
  // over). Somebody who can only leave keeps Sair on the strip.
  const leaveInMenu =
    Boolean(model.actions.leave && model.actions.end && model.seated) && !reconnecting;

  const moreItems = [
    {
      id: "people",
      label: t("apps.strip.seePeople"),
      icon: Users,
      onSelect: () => actions.setPeople(true),
    },
    ...(leaveInMenu
      ? [
          {
            id: "leave",
            label: t("apps.strip.leave"),
            icon: LogOut,
            onSelect: () => onLeave?.(),
          },
        ]
      : []),
  ];

  return (
    <section
      role="region"
      aria-label={t("apps.strip.region", { app: model.app.name })}
      data-testid="app-session-strip"
      data-state={model.phase}
      className={cn(
        "@container/strip flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b py-1.5 pl-4 pr-3",
        // Under 760 px of strip the share switch keeps its name for assistive
        // tech and drops the printed label, so the row does not wrap. It used
        // to be 1100, which is most laptop windows with the channel list open,
        // and left a bare switch nobody could name (Locadora feedback,
        // 2026-10-21); the count and the faces go first now, at 960.
        "@max-[759px]/strip:[&_[role=switch]>span:first-child]:sr-only",
        stripShell(model),
        entering && "app-strip-in",
      )}
    >
      <button
        type="button"
        className="sr-only focus-visible:not-sr-only focus-visible:rounded-[var(--radius-control)] focus-visible:bg-surface-2 focus-visible:px-2 focus-visible:py-1 focus-visible:text-xs"
        onClick={onSkipToApp}
      >
        {t("apps.strip.skip")}
      </button>
      <AppIconTile icon={model.app.icon} className="h-8 w-8 sm:h-8 sm:w-8" />
      <div className="flex min-w-0 flex-col" style={{ flex: "0 1 auto" }}>
        <span className="truncate font-display text-sm font-bold leading-[18px]">
          {model.app.name}
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs leading-4",
            warn ? "text-on-warning-soft" : "text-text-tertiary",
          )}
        >
          {reconnecting ? <Dot tone="off" /> : null}
          <span className="min-w-0 [overflow-wrap:anywhere] md:truncate" title={line}>
            {line}
          </span>
        </span>
      </div>
      <AvatarStack model={model} />
      {model.phase !== "reconnecting" && model.phase !== "lost" ? (
        <span className="shrink-0 whitespace-nowrap text-xs text-text-secondary max-[959px]:hidden">
          {countText(model.count, t)}
        </span>
      ) : null}

      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
        {props.joinCall && model.seated ? (
          <JoinCallButton join={props.joinCall} forShare={Boolean(share?.visible)} />
        ) : null}
        {share?.visible && !(share.needsCall && props.joinCall && model.seated) ? (
          <ShareControl share={share} onChange={onShareChange} />
        ) : null}
        {share?.visible || (props.joinCall && model.seated) ? (
          <span aria-hidden className="h-5 w-px bg-border" />
        ) : null}
        {model.actions.enter ? (
          <Button
            type="button"
            size="sm"
            variant={model.actions.enter === "join" ? "default" : "secondary"}
            aria-disabled={busy?.join || undefined}
            aria-busy={busy?.join || undefined}
            onClick={() => {
              if (!busy?.join) onJoin?.({ asSpectator: model.actions.enter === "watch" });
            }}
          >
            {busy?.join ? <Spinner /> : null}
            {t(model.actions.enter === "join" ? "apps.strip.join" : "apps.strip.watch")}
          </Button>
        ) : null}
        {model.actions.takeHost ? (
          <Button
            type="button"
            size="sm"
            aria-disabled={busy?.takeHost || undefined}
            aria-busy={busy?.takeHost || undefined}
            onClick={() => {
              if (!busy?.takeHost) onTakeHost?.();
            }}
          >
            {busy?.takeHost ? <Spinner /> : null}
            {t("apps.strip.takeNow")}
          </Button>
        ) : null}
        {reconnecting ? (
          <Button type="button" size="sm" variant="secondary" aria-disabled="true">
            <Spinner />
            {t("apps.strip.reconnectingBtn")}
          </Button>
        ) : null}
        {model.actions.leave && !reconnecting && !leaveInMenu ? (
          <Button type="button" size="sm" variant="ghost" onClick={onLeave}>
            {t("apps.strip.leave")}
          </Button>
        ) : null}
        {model.actions.end ? (
          <Button
            type="button"
            size="sm"
            variant="danger"
            onClick={() => actions.setConfirmEnd(true)}
          >
            <Square aria-hidden className="h-3 w-3 fill-current" />
            {t("apps.strip.end")}
          </Button>
        ) : null}
        {model.seated ? (
          <Menu items={moreItems} align="end">
            <button
              type="button"
              aria-label={t("apps.strip.more")}
              className="grid h-8 w-8 place-items-center rounded-[var(--radius-control)] text-text-secondary transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <MoreHorizontal aria-hidden className="h-4 w-4" />
            </button>
          </Menu>
        ) : null}
        {props.chat ? (
          <>
            <span aria-hidden className="h-5 w-px bg-border" />
            <ChatToggle chat={props.chat} />
          </>
        ) : null}
      </div>
      {props.error ? (
        <p role="alert" className="w-full text-xs text-on-danger-soft">
          {props.error}
        </p>
      ) : null}
      <Announcer model={model} />
      <PeopleDialog open={actions.people} model={model} onClose={() => actions.setPeople(false)} />
      <EndConfirm
        open={actions.confirmEnd}
        app={model.app.name}
        onClose={() => actions.setConfirmEnd(false)}
        onConfirm={() => props.onEnd?.()}
      />
    </section>
  );
}

function ShareControl({
  share,
  onChange,
}: {
  share: StripShareState;
  onChange?: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = t("apps.strip.share");
  // NOT IN THE CALL with a way to join: the strip draws "Entrar na call" in this
  // place instead (`JoinCallButton`). It used to be a dimmed switch and "Entra
  // na call pra compartilhar o app.", which left the person to find the channel
  // and double click it (Locadora feedback, round 2).
  // WHY it cannot be used is said in words beside the switch, never only in a hover: a switch that is dimmed and says
  // nothing is a button that does nothing
  const blockedReason = share.needsCall
    ? t("apps.strip.shareNeedsCall")
    : share.otherShare
      ? t("apps.strip.shareOtherShare")
      : undefined;
  const reason = blockedReason ?? (share.wholeTab ? t("apps.strip.shareWholeTab") : undefined);
  return (
    <>
      {blockedReason ? (
        <span
          role="status"
          data-testid="app-strip-share-reason"
          // Wide: beside the switch. Under 760 px it is a line of its own above the controls, so the group wraps instead of
          // running past the strip's edge and under the Chat toggle.
          className="max-w-[22ch] text-xs leading-4 text-text-secondary @min-[1100px]/strip:max-w-[40ch] @max-[759px]/strip:order-first @max-[759px]/strip:max-w-none @max-[759px]/strip:basis-full @max-[759px]/strip:text-right"
        >
          {blockedReason}
        </span>
      ) : null}
      {share.on ? (
        <span
          role="status"
          data-testid="app-strip-sharing"
          className="app-badge-in inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-on-success-soft"
        >
          <Dot tone="live" />
          {/* Nobody watching yet is "Compartilhando", never "pra 0". */}
          {/* Under 760 px of strip the dot stays and the words go to assistive
              tech only, so the controls hold one row. */}
          <span className="@max-[759px]/strip:sr-only">
            {share.viewers > 0
              ? t("apps.strip.sharingTo", { count: share.viewers })
              : t("apps.strip.sharingAlone")}
          </span>
        </span>
      ) : null}
      {/* Where the printed label steps aside (a narrow strip), the screen icon
          keeps the switch nameable at a glance; its name stays on the switch. */}
      <MonitorUp
        aria-hidden
        className="hidden h-4 w-4 shrink-0 text-text-secondary @max-[759px]/strip:block"
      />
      <Switch
        checked={share.on}
        onCheckedChange={(next) => onChange?.(next)}
        label={label}
        title={reason}
        busy={share.pending}
        unavailable={Boolean(blockedReason)}
        className="w-auto gap-2 px-1"
      />
    </>
  );
}

/**
 * "Chat": shows and hides the chat beside the app. The last control on the
 * strip, because it is about the layout and not about the session. While the
 * chat is away it carries what arrived meanwhile: a dot for messages, a count
 * on the danger fill when one of them names this person.
 */
function ChatToggle({ chat, compact = false }: { chat: StripChatToggle; compact?: boolean }) {
  const { t } = useTranslation();
  const label = chat.hidden ? t("apps.chat.show") : t("apps.chat.hide");
  const { count, mention } = chat.unread;
  const pending = chat.hidden && count > 0;
  const spoken = pending
    ? mention
      ? t("apps.chat.unreadMention", { count })
      : t("apps.chat.unread", { count })
    : null;
  const Icon = compact ? MessageSquare : chat.hidden ? PanelRightOpen : PanelRightClose;
  return (
    <Tooltip
      label={label}
      name={spoken ? `${label}. ${spoken}` : label}
      detail={chat.shortcut ?? undefined}
      side="bottom"
    >
      <button
        type="button"
        data-app-chat-toggle=""
        data-chat-hidden={chat.hidden ? "true" : "false"}
        aria-expanded={!chat.hidden}
        aria-controls={chat.controls}
        aria-keyshortcuts={chat.shortcut ? ariaShortcut(chat.shortcut) : undefined}
        onClick={chat.onToggle}
        className={cn(
          "relative inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] text-sm text-text-secondary transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
          compact ? "h-11 w-11 justify-center" : "h-8 px-2 pointer-coarse:h-11",
          !chat.hidden && !compact && "text-text",
        )}
      >
        <Icon aria-hidden className={compact ? "h-5 w-5" : "h-4 w-4"} />
        {compact ? null : (
          <span aria-hidden className="@max-[759px]/strip:hidden">
            {t("apps.chat.label")}
          </span>
        )}
        {pending ? (
          mention ? (
            <span
              aria-hidden
              data-app-chat-unread="mention"
              className="app-badge-in absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold leading-none text-on-danger ring-2 ring-surface-1"
            >
              {unreadBadgeText(count)}
            </span>
          ) : (
            <span
              aria-hidden
              data-app-chat-unread="dot"
              className="app-badge-in absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-surface-1"
            />
          )
        ) : null}
      </button>
    </Tooltip>
  );
}

/** "Ctrl + Shift + ." as `aria-keyshortcuts` wants it: "Control+Shift+.". */
function ariaShortcut(printed: string): string {
  return printed
    .split("+")
    .map((part) => part.trim())
    .map((part) => (part === "Ctrl" ? "Control" : part === "Cmd" || part === "⌘" ? "Meta" : part))
    .join("+");
}

function EndConfirm({
  open,
  app,
  onClose,
  onConfirm,
}: {
  open: boolean;
  app: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={open}
      title={t("apps.strip.endConfirmTitle", { app })}
      description={t("apps.strip.endConfirmBody")}
      confirmLabel={t("apps.strip.end")}
      cancelLabel={t("apps.strip.endKeep")}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}

// ---------------------------------------------------------------------------
// Ended

function EndedStrip(props: AppSessionStripProps & { model: EndedStripModel }) {
  const { model, collapsing, entering, onClose } = props;
  const { t } = useTranslation();
  const compact = props.compact === true;
  return (
    <section
      role="region"
      aria-label={t("apps.strip.endedTitle", { app: model.app.name })}
      data-testid="app-session-strip"
      data-state="ended"
      className={cn(
        "flex shrink-0 items-center gap-3 border-b border-border bg-surface-1 py-1.5 pl-4 pr-3",
        compact ? "min-h-14" : "min-h-[52px]",
        entering && "app-strip-in",
        collapsing && "app-strip-out",
      )}
    >
      <AppIconTile
        icon={model.app.icon}
        dimmed
        className={compact ? undefined : "h-8 w-8 sm:h-8 sm:w-8"}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-display text-sm font-bold leading-[18px] text-text-secondary">
          {t("apps.strip.endedTitle", { app: model.app.name })}
        </span>
        <span className="flex items-start gap-1.5 text-xs leading-4 text-text-tertiary">
          <Dot tone="gone" />
          <span role="status" className="min-w-0 [overflow-wrap:anywhere]">
            {endedLineText(model, t)}
          </span>
        </span>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={compact ? "h-11 px-4" : undefined}
        onClick={onClose}
      >
        {t("apps.strip.close")}
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phone: the collapsed bar and the sheet

function CompactStrip(props: AppSessionStripProps & { model: LiveStripModel }) {
  const { model, busy, entering, onLeave, onJoin, onTakeHost, onSkipToApp } = props;
  const { t } = useTranslation();
  const actions = useStripActions();
  const [sheet, setSheet] = useState(false);
  const warn = model.tone === "warn";
  const reconnecting = model.phase === "reconnecting";
  const opener = useRef<HTMLButtonElement>(null);

  const summary =
    model.seated &&
    (model.line.kind === "hostIs" || model.line.kind === "host" || model.line.kind === "watching")
      ? `${lineText(model.line, t)}, ${countText(model.count, t)}`
      : reconnecting
        ? t("apps.strip.reconnectingShort")
        : lineText(model.line, t);

  return (
    <section
      role="region"
      aria-label={t("apps.strip.region", { app: model.app.name })}
      data-testid="app-session-strip"
      data-state={model.phase}
      className={cn(
        "flex min-h-14 shrink-0 items-center gap-2 border-b py-1.5 pl-3 pr-2",
        stripShell(model),
        entering && "app-strip-in",
      )}
    >
      <button
        type="button"
        className="sr-only focus-visible:not-sr-only focus-visible:rounded-[var(--radius-control)] focus-visible:bg-surface-2 focus-visible:px-2 focus-visible:py-1 focus-visible:text-xs"
        onClick={onSkipToApp}
      >
        {t("apps.strip.skip")}
      </button>
      <AppIconTile icon={model.app.icon} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-display text-sm font-bold leading-[18px]">
          {model.app.name}
        </span>
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs leading-4",
            warn ? "text-on-warning-soft" : "text-text-tertiary",
          )}
        >
          {reconnecting ? <Dot tone="off" /> : null}
          <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]" title={summary}>
            {summary}
          </span>
        </span>
      </div>
      {model.actions.enter && !model.seated ? (
        <Button
          type="button"
          size="sm"
          className="h-11 px-4"
          variant={model.actions.enter === "join" ? "default" : "secondary"}
          aria-disabled={busy?.join || undefined}
          aria-busy={busy?.join || undefined}
          onClick={() => {
            if (!busy?.join) onJoin?.({ asSpectator: model.actions.enter === "watch" });
          }}
        >
          {busy?.join ? <Spinner /> : null}
          {t(model.actions.enter === "join" ? "apps.strip.join" : "apps.strip.watch")}
        </Button>
      ) : null}
      {props.joinCall && model.seated && !reconnecting ? (
        <JoinCallButton join={props.joinCall} forShare={false} compact />
      ) : null}
      {props.chat && !reconnecting ? <ChatToggle chat={props.chat} compact /> : null}
      {reconnecting ? (
        <span className="pr-3">
          <Spinner className="h-4 w-4" />
        </span>
      ) : model.seated || model.actions.end || model.actions.leave ? (
        <button
          ref={opener}
          type="button"
          aria-label={t("apps.strip.openControls")}
          aria-expanded={sheet}
          aria-haspopup="dialog"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-secondary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          onClick={() => setSheet(true)}
        >
          <ChevronDown aria-hidden className="h-5 w-5" />
        </button>
      ) : null}
      {props.error ? (
        <p role="alert" className="w-full text-xs text-on-danger-soft">
          {props.error}
        </p>
      ) : null}
      <Announcer model={model} />
      <Dialog
        open={sheet}
        title={model.app.name}
        size="sm"
        onClose={() => {
          setSheet(false);
          requestAnimationFrame(() => opener.current?.focus());
        }}
        footer={
          <div className="flex w-full flex-col gap-2">
            {model.actions.takeHost ? (
              <Button
                type="button"
                className="h-12 w-full text-[15px]"
                aria-disabled={busy?.takeHost || undefined}
                onClick={() => {
                  if (!busy?.takeHost) onTakeHost?.();
                  setSheet(false);
                }}
              >
                {t("apps.strip.takeNow")}
              </Button>
            ) : null}
            {model.actions.end ? (
              <Button
                type="button"
                variant="danger"
                className="h-12 w-full text-[15px]"
                onClick={() => {
                  setSheet(false);
                  actions.setConfirmEnd(true);
                }}
              >
                <Square aria-hidden className="h-3.5 w-3.5 fill-current" />
                {t("apps.strip.endForAll")}
              </Button>
            ) : null}
            {model.actions.leave ? (
              <Button
                type="button"
                variant="secondary"
                className="h-12 w-full text-[15px]"
                onClick={() => {
                  setSheet(false);
                  onLeave?.();
                }}
              >
                {t("apps.strip.leave")}
              </Button>
            ) : null}
          </div>
        }
      >
        <DialogBody className="flex flex-col gap-3">
          <p className="text-[13px] text-text-tertiary">{lineText(model.line, t)}</p>
          <p className="text-[15px] text-text">{countText(model.count, t)}</p>
          <ul className="flex flex-col">
            {model.roster.map((person) => (
              <li key={person.userId} className="flex min-h-11 items-center gap-3">
                <UserAvatar
                  name={person.name}
                  avatarUrl={person.avatarUrl}
                  rounded="full"
                  className="h-8 w-8"
                  fallbackClassName="bg-surface-3 text-xs text-text-secondary"
                />
                <span className="min-w-0 flex-1 truncate text-[15px] text-text">{person.name}</span>
                <span className="shrink-0 text-xs text-text-tertiary">
                  {[
                    person.host ? t("apps.strip.peopleHost") : null,
                    person.spectator ? t("apps.strip.peopleWatching") : null,
                    person.reconnecting ? t("apps.strip.peopleReconnecting") : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </DialogBody>
      </Dialog>
      <EndConfirm
        open={actions.confirmEnd}
        app={model.app.name}
        onClose={() => actions.setConfirmEnd(false)}
        onConfirm={() => props.onEnd?.()}
      />
    </section>
  );
}
