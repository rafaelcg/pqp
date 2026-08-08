import { Loader2, MoreHorizontal } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  TIMEOUT_PRESET_MINUTES,
  TIMEOUT_REASON_MAX_LENGTH,
  type DmSummary,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/user/status-dot";
import { useFriends } from "@/components/friends/use-friends";
import {
  ApiError,
  banMember,
  createConversation,
  kickMember,
  liftTimeout,
  timeoutMember,
} from "@/lib/api";
import { useTranslation, type Translator } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  canBlock,
  canMessage,
  canRemoveFriend,
  canReport,
  friendsSince,
  moderationActions,
  moderationNeedsConfirmation,
  needsConfirmation,
  placeCard,
  primaryAction,
  primaryIsInert,
  offersDecline,
  resolveFriendshipState,
  resolvePresence,
  type Placement,
  type ProfileModerationAction,
  type ProfileModerationContext,
  type ProfilePrimaryAction,
  type ProfileSubject,
} from "./profile-relations";

/**
 * The profile card: who this person is, and everything you can do about them,
 * from wherever you clicked their name.
 *
 * WHY IT EXISTS. Until now the only affordance on an author was RIGHT-click,
 * and there was no "add friend" anywhere in the app except the friends view's
 * own search box — which wanted a full `name#1234` you would have to already
 * know. Left-clicking the person who just said something is the discovery path
 * that was missing, and it is where Discord puts it too.
 *
 * WHY A CONTEXT RATHER THAN A PROP. The card is opened from the message list,
 * the members panel and the DM list; threading `onOpenProfile` down through
 * every row of all three (message rows are memoized and already take
 * twenty-odd props) would be a lot of plumbing for one callback. The opener is
 * a no-op outside a provider, so a component tree under test renders without
 * one and simply has no card.
 */

// ------------------------------------------------------------------ context

interface ProfilePopoverContextValue {
  open: (subject: ProfileSubject, anchor: HTMLElement) => void;
}

const ProfilePopoverContext = createContext<ProfilePopoverContextValue | null>(
  null,
);

/**
 * Opens the card. Outside a provider this is a no-op rather than a throw: a
 * name is still a name in a unit test, and losing a popover is not worth
 * crashing a render over.
 */
export function useProfilePopover(): ProfilePopoverContextValue["open"] {
  const context = useContext(ProfilePopoverContext);
  return useMemo(
    () => context?.open ?? (() => {}),
    [context],
  );
}

interface ProfilePopoverProviderProps {
  currentUserId: string | null;
  /** The app already holds this list; the card must not fetch a second copy. */
  blockedUserIds: ReadonlySet<string>;
  /**
   * The server the card is being opened inside, when there is one, and what the
   * viewer may do to people in it. Null in a conversation — a DM has no
   * moderators, which is the same rule that keeps a server timeout out of one.
   *
   * The app holds this already: the roster it fetches for `@` autocomplete is
   * the roster these roles come from, so the card's whole moderation menu costs
   * zero extra requests.
   */
  moderation: ProfileModerationContext | null;
  /** Message: the conversation was opened or reused — the app navigates. */
  onOpenConversation: (conversation: DmSummary) => void;
  onBlockUser: (userId: string) => void;
  onUnblockUser: (userId: string) => void;
  onReportUser: (subject: ProfileSubject) => void;
  children: ReactNode;
}

interface OpenState {
  subject: ProfileSubject;
  anchor: HTMLElement;
}

export function ProfilePopoverProvider({
  currentUserId,
  blockedUserIds,
  moderation,
  onOpenConversation,
  onBlockUser,
  onUnblockUser,
  onReportUser,
  children,
}: ProfilePopoverProviderProps) {
  const [state, setState] = useState<OpenState | null>(null);

  const open = useCallback((subject: ProfileSubject, anchor: HTMLElement) => {
    // Clicking the same name again closes, the way every popover in this app
    // behaves — the trigger is a toggle, not a re-opener.
    setState((current) =>
      current && current.subject.id === subject.id && current.anchor === anchor
        ? null
        : { subject, anchor },
    );
  }, []);

  const value = useMemo(() => ({ open }), [open]);

  return (
    <ProfilePopoverContext.Provider value={value}>
      {children}
      {state && (
        <UserProfileCard
          // Remounting per subject is deliberate: the card owns a friends
          // snapshot and a busy flag, and carrying either across two different
          // people is how a card ends up showing the last person's state.
          key={state.subject.id}
          subject={state.subject}
          anchor={state.anchor}
          currentUserId={currentUserId}
          blockedUserIds={blockedUserIds}
          moderation={moderation}
          onClose={() => setState(null)}
          onOpenConversation={onOpenConversation}
          onBlockUser={onBlockUser}
          onUnblockUser={onUnblockUser}
          onReportUser={onReportUser}
        />
      )}
    </ProfilePopoverContext.Provider>
  );
}

// ---------------------------------------------------------------- placement

/**
 * Fixed coordinates, because the trigger usually sits inside a scroller (the
 * message list) whose `overflow` would clip an absolutely positioned child.
 * The arithmetic itself lives in `profile-relations.ts` so it can be tested.
 */
const CARD_WIDTH = 288;

/**
 * The preset the composer opens on — one hour, the second rung of
 * `TIMEOUT_PRESET_MINUTES`. Long enough to interrupt whatever is happening,
 * short enough that being wrong costs the person an hour.
 */
const DEFAULT_TIMEOUT_MINUTES = TIMEOUT_PRESET_MINUTES[1]!;

/**
 * A preset's label. Translated per unit rather than formatted from a number,
 * because "1 day" and "7 days" pluralise differently in the languages this
 * catalogue already carries, and the presets are a fixed list of four.
 */
function describeTimeoutMinutes(minutes: number, t: Translator["t"]): string {
  if (minutes < 60) {
    return t("profile.mod.duration.minutes", { count: minutes });
  }
  if (minutes < 60 * 24) {
    return t("profile.mod.duration.hours", { count: minutes / 60 });
  }
  return t("profile.mod.duration.days", { count: minutes / (60 * 24) });
}

// --------------------------------------------------------------------- card

interface UserProfileCardProps {
  subject: ProfileSubject;
  anchor: HTMLElement;
  currentUserId: string | null;
  blockedUserIds: ReadonlySet<string>;
  moderation: ProfileModerationContext | null;
  onClose: () => void;
  onOpenConversation: (conversation: DmSummary) => void;
  onBlockUser: (userId: string) => void;
  onUnblockUser: (userId: string) => void;
  onReportUser: (subject: ProfileSubject) => void;
}

function UserProfileCard({
  subject,
  anchor,
  currentUserId,
  blockedUserIds,
  moderation,
  onClose,
  onOpenConversation,
  onBlockUser,
  onUnblockUser,
  onReportUser,
}: UserProfileCardProps) {
  const { t } = useTranslation();
  // The friends feature's own state logic, reused whole — the same fetch, the
  // same optimistic refresh, the same generation guard. Mounting it here (and
  // only while the card is open) is what keeps its 15s poll scoped to somebody
  // actually looking, which is the argument use-friends.ts makes for pull.
  const { data, loading, send, accept, remove } = useFriends();
  const cardRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirming, setConfirming] = useState<ProfilePrimaryAction | null>(
    null,
  );
  /** A kick or a ban held until confirmed; a ban collects its reason here. */
  const [confirmingModeration, setConfirmingModeration] =
    useState<ProfileModerationAction | null>(null);
  const [banReason, setBanReason] = useState("");
  /** The timeout composer's duration, once it is open. */
  const [timeoutMinutes, setTimeoutMinutes] = useState<number | null>(null);
  const [timeoutReason, setTimeoutReason] = useState("");

  const state = resolveFriendshipState(
    subject.id,
    currentUserId,
    data,
    blockedUserIds,
  );
  const action = primaryAction(state);
  // Never against yourself, whatever the roster says — `canModerateMember`
  // refuses it too, but "self" short-circuits before any of this is asked.
  const modActions =
    state === "self"
      ? []
      : moderationActions(subject.id, currentUserId, moderation);
  const presence = resolvePresence(subject.id, state, data, subject.status);
  const since = friendsSince(subject.id, data);

  // Measured after mount: the card's height depends on which state it is in,
  // so guessing it would put a friends card in the wrong place.
  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) {
      return;
    }
    function reposition() {
      const box = anchor.getBoundingClientRect();
      const own = node!.getBoundingClientRect();
      setPlacement(
        placeCard(
          box,
          { width: own.width || CARD_WIDTH, height: own.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    }
    reposition();
    window.addEventListener("resize", reposition);
    // A card left hanging over a scrolled-away message reads as a bug; close
    // rather than chase, which is what every anchored surface here does.
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchor, onClose, state, loading]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (cardRef.current?.contains(target) || anchor.contains(target)) {
        return;
      }
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor, onClose]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      // The server's refusal is deliberately vague (never "they blocked you");
      // relay it when it is an API answer, fall back to ours when it is not.
      setError(
        err instanceof ApiError ? err.message : t("friends.requestFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  function runPrimary(which: ProfilePrimaryAction) {
    setNotice(null);
    switch (which) {
      case "addFriend":
        void run(async () => {
          const result = await send({
            id: subject.id,
            displayName: subject.displayName,
            username: null,
            tag: subject.tag,
            avatarUrl: subject.avatarUrl,
          });
          setNotice(
            t(
              result === "accepted"
                ? "friends.requestAccepted"
                : "friends.requestSent",
              { name: subject.displayName },
            ),
          );
        });
        return;
      case "acceptRequest":
        void run(() => accept(subject.id));
        return;
      case "cancelRequest":
        void run(() => remove(subject.id));
        return;
      case "unblock":
        onUnblockUser(subject.id);
        onClose();
        return;
      case "alreadyFriends":
      case "none":
        return;
    }
  }

  function handleMessage() {
    void run(async () => {
      const { conversation } = await createConversation([subject.id]);
      onOpenConversation(conversation);
      onClose();
    });
  }

  /**
   * Run a rung of the ladder.
   *
   * `moderation` is re-checked here rather than trusted from the closure: the
   * menu that opened this is derived from it, but a card that outlives a server
   * switch would otherwise aim an action at the wrong server. The server would
   * refuse it — this just means it is never sent.
   */
  function runModeration(which: ProfileModerationAction) {
    if (!moderation) {
      return;
    }
    const { serverId } = moderation;
    setNotice(null);
    void run(async () => {
      switch (which) {
        case "timeout": {
          const minutes = timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
          const { message } = await timeoutMember(
            serverId,
            subject.id,
            minutes,
            timeoutReason.trim() || null,
          );
          setTimeoutMinutes(null);
          setTimeoutReason("");
          moderation.onModerated();
          // The server writes the whole sentence — when it ends, what it takes
          // away — and it is the same one the sanctioned person reads. Showing
          // it verbatim is how the two sides cannot disagree about the sentence.
          setNotice(message);
          return;
        }
        case "endTimeout":
          await liftTimeout(serverId, subject.id);
          moderation.onModerated();
          setNotice(t("profile.mod.timeoutEnded", { name: subject.displayName }));
          return;
        case "kick":
          await kickMember(serverId, subject.id);
          moderation.onModerated();
          setNotice(t("profile.mod.kicked", { name: subject.displayName }));
          return;
        case "ban":
          // The reason the members panel drops on the floor. It is the only
          // thing the ban list can show later about *why*, and a ban with no
          // reason is a decision nobody — including the person who made it —
          // can reconstruct in six months.
          await banMember(serverId, subject.id, banReason.trim() || null);
          setBanReason("");
          moderation.onModerated();
          setNotice(t("profile.mod.banned", { name: subject.displayName }));
          return;
      }
    });
  }

  const modLabel: Record<ProfileModerationAction, string> = {
    timeout: t("profile.mod.timeout"),
    endTimeout: t("profile.mod.endTimeout"),
    kick: t("profile.mod.kick"),
    ban: t("profile.mod.ban"),
  };

  const primaryLabel: Record<ProfilePrimaryAction, string> = {
    addFriend: t("profile.addFriend"),
    acceptRequest: t("profile.acceptRequest"),
    cancelRequest: t("profile.cancelRequest"),
    alreadyFriends: t("profile.friends"),
    unblock: t("profile.unblock"),
    none: "",
  };

  const overflowItems: {
    id: string;
    label: string;
    danger?: boolean;
    /** Set on the moderation rungs, so a test can assert on the rung itself. */
    moderation?: ProfileModerationAction;
    onSelect: () => void;
  }[] = [
    ...(canRemoveFriend(state)
      ? [
          {
            id: "remove",
            label: t("profile.removeFriend"),
            danger: true,
            onSelect: () => {
              setOverflowOpen(false);
              if (window.confirm(t("profile.removeFriend.confirm", {
                name: subject.displayName,
              }))) {
                void run(() => remove(subject.id));
              }
            },
          },
        ]
      : []),
    ...(canBlock(state)
      ? [
          {
            id: "block",
            label: t("profile.block"),
            danger: true,
            onSelect: () => {
              setOverflowOpen(false);
              if (
                window.confirm(
                  t("profile.block.confirm", { name: subject.displayName }),
                )
              ) {
                onBlockUser(subject.id);
                onClose();
              }
            },
          },
        ]
      : []),
    ...(canReport(state)
      ? [
          {
            id: "report",
            label: t("profile.report"),
            danger: true,
            onSelect: () => {
              setOverflowOpen(false);
              onReportUser(subject);
              onClose();
            },
          },
        ]
      : []),
    // The ladder, last and in order: reversible first, then the two that end a
    // membership. `moderationActions` returns [] for a conversation, for a
    // non-manager and for anybody the rank rule protects — so a plain member
    // reading this menu sees exactly what they saw before.
    ...modActions.map((which) => ({
      id: `mod-${which}`,
      label: modLabel[which],
      // Red is exactly the set that needs confirming — the two that end a
      // membership. A timeout is the REVERSIBLE rung: it expires on its own and
      // is lifted from this same menu, so painting it the same colour as "Ban
      // from server" would teach a moderator the opposite of the ladder the
      // order is trying to express. The members panel makes this argument at
      // length on its own copy of these rows; sharing the predicate with
      // `moderationNeedsConfirmation` is what keeps the two in step.
      danger: moderationNeedsConfirmation(which),
      moderation: which,
      onSelect: () => {
        setOverflowOpen(false);
        if (moderationNeedsConfirmation(which)) {
          setConfirmingModeration(which);
          return;
        }
        if (which === "timeout") {
          // A duration has to be chosen, so the composer IS the confirmation.
          setTimeoutMinutes(DEFAULT_TIMEOUT_MINUTES);
          return;
        }
        runModeration(which);
      },
    })),
  ];

  return createPortal(
    <div
      ref={cardRef}
      role="dialog"
      aria-label={t("profile.cardLabel", { name: subject.displayName })}
      data-profile-card=""
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        width: CARD_WIDTH,
        // Invisible until measured, so it never flashes at the top-left corner.
        visibility: placement ? "visible" : "hidden",
      }}
      // NOT `overflow-hidden`, which it used to be. The overflow menu opens
      // upward from a button near the bottom of the card, and once the ladder
      // joined it the menu grew taller than the space above that button — so
      // clipping the card silently ate the top item (Block). The banner does its
      // own corner rounding below, which is the only thing the clip was for.
      className="fixed z-[110] rounded-xl border border-ink-4 bg-ink-2 shadow-[var(--shadow-popover)] animate-fade-in"
    >
      {/* No banner image exists on the server, so the band is a flat tint of
          the same surface — enough to separate the identity block from the
          actions without inventing a field to store one. Rounds its own top
          corners now that the card no longer clips it. */}
      <div aria-hidden="true" className="h-14 rounded-t-xl bg-ink-3" />

      <div className="px-4 pb-4">
        <div className="relative -mt-8 mb-2 w-fit">
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-ink-3 text-xl font-semibold ring-4 ring-ink-2">
            {subject.avatarUrl ? (
              <img
                src={subject.avatarUrl}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            ) : (
              subject.displayName.slice(0, 1).toUpperCase()
            )}
          </div>
          {presence && (
            <StatusDot
              status={presence}
              size="md"
              className="absolute bottom-0 right-0"
              ringClassName="rounded-full bg-ink-2 ring-4 ring-ink-2"
            />
          )}
        </div>

        <p
          className="truncate font-display text-lg font-bold text-paper"
          data-profile-name=""
        >
          {subject.displayName}
        </p>
        {subject.tag && (
          <p className="truncate font-mono text-xs text-paper-muted">
            {subject.tag}
          </p>
        )}
        {since && (
          <p className="mt-1 text-[11px] text-paper-muted">
            {t("profile.friendsSince", {
              date: new Date(since).toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              }),
            })}
          </p>
        )}

        {notice && (
          <p className="mt-2 text-xs text-signal" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-danger" role="alert">
            {error}
          </p>
        )}

        {state === "self" ? (
          <p className="mt-3 text-xs text-paper-muted">{t("profile.isYou")}</p>
        ) : loading ? (
          <div className="mt-3 flex h-8 items-center text-paper-muted">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            <span className="sr-only">{t("profile.loading")}</span>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-1.5">
            {/* The relationship is the wide primary; the thing you might do
                *with* somebody sits beside it; everything punitive is behind
                the ellipsis, because a Block button the same size as Add
                friend makes a profile card read as a moderation console. */}
            <Button
              size="sm"
              variant={action === "alreadyFriends" ? "secondary" : "default"}
              className="flex-1"
              disabled={busy || primaryIsInert(action)}
              data-profile-primary={action}
              onClick={() => {
                if (needsConfirmation(action)) {
                  setConfirming(action);
                  return;
                }
                runPrimary(action);
              }}
            >
              {busy && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
              {action === "alreadyFriends"
                ? `${primaryLabel[action]} ✓`
                : primaryLabel[action]}
            </Button>

            {offersDecline(state) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => remove(subject.id))}
              >
                {t("friends.decline")}
              </Button>
            )}

            {canMessage(state) && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                data-profile-message=""
                onClick={handleMessage}
              >
                {t("friends.message")}
              </Button>
            )}

            {overflowItems.length > 0 && (
              <div className="relative">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-haspopup="menu"
                  aria-expanded={overflowOpen}
                  aria-label={t("profile.more")}
                  className="px-2"
                  onClick={() => setOverflowOpen((was) => !was)}
                >
                  <MoreHorizontal aria-hidden className="h-4 w-4" />
                </Button>
                {overflowOpen && (
                  <div
                    role="menu"
                    aria-label={t("profile.more")}
                    // Capped and scrollable: the menu is as tall as the viewer's
                    // authority makes it (two entries for a member, five for an
                    // owner), and a cap is what keeps the tallest version from
                    // reaching past the top of the window on a short screen.
                    className="absolute bottom-full right-0 z-10 mb-1 max-h-[15rem] w-48 overflow-y-auto rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)]"
                  >
                    {overflowItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        data-profile-mod={item.moderation}
                        className={cn(
                          "flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm outline-none hover:bg-ink-3 focus-visible:bg-ink-3",
                          item.danger ? "text-danger" : "text-paper",
                        )}
                        onClick={item.onSelect}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* The timeout composer. Inline rather than a modal for the reason the
            card exists: a moderator is looking at the message that prompted
            this, and a dialog over the top of it takes the evidence away. */}
        {timeoutMinutes !== null && (
          <div
            data-profile-timeout-composer=""
            className="mt-3 rounded-md border border-ink-4 bg-ink-3/60 p-2"
          >
            <p className="text-xs font-semibold text-paper">
              {t("profile.mod.timeout.title", { name: subject.displayName })}
            </p>
            <div
              role="radiogroup"
              aria-label={t("profile.mod.timeout.duration")}
              className="mt-2 grid grid-cols-2 gap-1"
            >
              {TIMEOUT_PRESET_MINUTES.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  role="radio"
                  aria-checked={timeoutMinutes === minutes}
                  data-timeout-minutes={minutes}
                  className={cn(
                    "rounded-md px-2 py-1 text-xs",
                    timeoutMinutes === minutes
                      ? "bg-signal font-semibold text-ink"
                      : "bg-ink-4/60 text-paper hover:bg-ink-4",
                  )}
                  onClick={() => setTimeoutMinutes(minutes)}
                >
                  {describeTimeoutMinutes(minutes, t)}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={timeoutReason}
              maxLength={TIMEOUT_REASON_MAX_LENGTH}
              placeholder={t("profile.mod.reason.placeholder")}
              aria-label={t("profile.mod.reason")}
              className="mt-2 w-full rounded-md border border-ink-4 bg-ink px-2 py-1 text-xs text-paper placeholder:text-paper-muted"
              onChange={(event) => setTimeoutReason(event.target.value)}
            />
            <p className="mt-1.5 text-[11px] text-paper-muted">
              {t("profile.mod.timeout.body")}
            </p>
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                data-profile-timeout-apply=""
                onClick={() => runModeration("timeout")}
              >
                {t("profile.mod.timeout.apply")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setTimeoutMinutes(null);
                  setTimeoutReason("");
                }}
              >
                {t("profile.mod.cancel")}
              </Button>
            </div>
          </div>
        )}

        {/* Kick and ban: both end a membership, so both are confirmed. The ban's
            reason is collected here and nowhere else on the web client today. */}
        {confirmingModeration && (
          <div
            role="alertdialog"
            aria-label={t(
              confirmingModeration === "ban"
                ? "profile.mod.ban.title"
                : "profile.mod.kick.title",
              { name: subject.displayName },
            )}
            data-profile-mod-confirm={confirmingModeration}
            className="mt-3 rounded-md border border-ink-4 bg-ink-3/60 p-2"
          >
            <p className="text-xs font-semibold text-paper">
              {t(
                confirmingModeration === "ban"
                  ? "profile.mod.ban.title"
                  : "profile.mod.kick.title",
                { name: subject.displayName },
              )}
            </p>
            <p className="mt-1 text-[11px] text-paper-muted">
              {t(
                confirmingModeration === "ban"
                  ? "profile.mod.ban.body"
                  : "profile.mod.kick.body",
              )}
            </p>
            {confirmingModeration === "ban" && (
              <input
                type="text"
                value={banReason}
                maxLength={TIMEOUT_REASON_MAX_LENGTH}
                placeholder={t("profile.mod.reason.placeholder")}
                aria-label={t("profile.mod.reason")}
                className="mt-2 w-full rounded-md border border-ink-4 bg-ink px-2 py-1 text-xs text-paper placeholder:text-paper-muted"
                onChange={(event) => setBanReason(event.target.value)}
              />
            )}
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => {
                  const which = confirmingModeration;
                  setConfirmingModeration(null);
                  runModeration(which);
                }}
              >
                {modLabel[confirmingModeration]}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setConfirmingModeration(null);
                  setBanReason("");
                }}
              >
                {t("profile.mod.cancel")}
              </Button>
            </div>
          </div>
        )}

        {confirming && (
          <div className="mt-3 rounded-md border border-ink-4 bg-ink-3/60 p-2">
            <p className="text-xs text-paper">
              {t("profile.cancelRequest.confirm", {
                name: subject.displayName,
              })}
            </p>
            <div className="mt-2 flex gap-1.5">
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => {
                  const pending = confirming;
                  setConfirming(null);
                  runPrimary(pending);
                }}
              >
                {t("profile.cancelRequest")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(null)}
              >
                {t("profile.keep")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
