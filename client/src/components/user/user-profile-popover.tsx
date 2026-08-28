import {
  AtSign,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Phone,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  TIMEOUT_PRESET_MINUTES,
  TIMEOUT_REASON_MAX_LENGTH,
  type Depoimento,
  type DmSummary,
  type ProfileAchievement,
  type ProfileCommunityList,
  type VisibleConnection,
} from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { RankMarks } from "@/components/user/rank-marks";
import { identityMarks } from "@/lib/author-display";
import { useFriends } from "@/components/friends/use-friends";
import { DepoimentoComposer } from "@/components/depoimentos/depoimento-composer";
import {
  fetchDepoimentos,
  fetchProfileCommunities,
} from "@/components/depoimentos/depoimentos-api";
import { canWriteDepoimento } from "@/components/depoimentos/depoimentos-model";
import {
  CommunityBadges,
  DepoimentosSection,
} from "@/components/depoimentos/depoimentos-section";
import { ConnectionBadges } from "@/components/connections/connection-badges";
import { Achievements } from "@/components/profile/achievements";
import {
  ApiError,
  banMember,
  createConversation,
  fetchUserConnections,
  fetchUserAchievements,
  kickMember,
  liftTimeout,
  timeoutMember,
  updateMemberNickname,
  updateMemberRole,
} from "@/lib/api";
import { useTranslation, type MessageKey, type Translator } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  canBlock,
  canCall,
  canMessage,
  canRemoveFriend,
  canReport,
  cardRoleChips,
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
  roleChangeFor,
  profileAboutTabs,
  activeProfileAboutTab,
  type Placement,
  type ProfileAboutTab,
  type ProfileModerationAction,
  type ProfileModerationContext,
  type ProfilePrimaryAction,
  type ProfileRoleChange,
  type ProfileRoleChip,
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
  /**
   * Call: the same conversation, and then ring it.
   *
   * Handed the whole `DmSummary` rather than a channel id for the reason
   * `onOpenConversation` is: the row may be brand new, and the app has to put
   * it in the sidebar list before it navigates there.
   *
   * OPTIONAL, and the button is simply absent without it. A mount that cannot
   * place a call has no phone, which is the failure this feature wants: a
   * button that rings nobody is worse than no button.
   */
  onStartCall?: (conversation: DmSummary) => void;
  /**
   * Drop text into whatever composer the app has just navigated to.
   *
   * Exists for exactly one caller: the depoimento composer's "mandar por DM"
   * fork. An escape hatch that makes somebody retype what they wrote is one
   * nobody takes, and this is the escape hatch that has to be taken by the
   * people who need it most — see the note on `DepoimentoComposer`.
   */
  onComposeDraft?: (text: string) => void;
  /** Insert `@username` into the open composer. Same as the member-list Mention. */
  onMention?: (username: string) => void;
  /** Server roles, for the colour dots on this card. Empty outside a server. */
  roles?: readonly ProfileRoleChip[];
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
  onStartCall,
  onComposeDraft,
  onMention,
  roles,
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
          onStartCall={onStartCall}
          onComposeDraft={onComposeDraft}
          onMention={onMention}
          roles={roles}
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
 *
 * 320, not 288: the action strip below the name holds up to four equal-width
 * tiles, and the relationship pill has to fit "Adicionar amigo" without
 * truncating. 288 was the width at which the ellipsis wrapped onto its own
 * line under the Portuguese labels.
 */
const CARD_WIDTH = 320;

const ABOUT_LABEL: Record<ProfileAboutTab, MessageKey> = {
  depoimentos: "depoimentos.section",
  connections: "profile.about.accounts",
  communities: "depoimentos.communities",
};

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

/**
 * One cell in the contact-sheet strip. The grey well is icon-only and equal
 * with its siblings; the caption sits under the chrome, the way WhatsApp and
 * iOS Phone draw Call / Message. Putting the word inside the well made
 * `Mencionar` look like a wider button than `Mais` even when the cells were
 * the same width. The whole column is still the hit target.
 */
interface ActionTileProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

function ActionTile({ label, className, children, ...rest }: ActionTileProps) {
  return (
    <button
      type="button"
      className={cn(
        "group flex w-full min-w-0 flex-col items-center gap-1.5 text-paper focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      <span className="flex h-10 w-full items-center justify-center rounded-xl bg-ink-3/70 text-paper transition-colors group-hover:bg-ink-3 group-focus-visible:ring-2 group-focus-visible:ring-signal/60">
        {children}
      </span>
      <span className="max-w-full text-center text-[11px] font-medium leading-tight text-paper-muted">
        {label}
      </span>
    </button>
  );
}

interface UserProfileCardProps {
  subject: ProfileSubject;
  anchor: HTMLElement;
  currentUserId: string | null;
  blockedUserIds: ReadonlySet<string>;
  moderation: ProfileModerationContext | null;
  onClose: () => void;
  onOpenConversation: (conversation: DmSummary) => void;
  onStartCall?: (conversation: DmSummary) => void;
  onComposeDraft?: (text: string) => void;
  onMention?: (username: string) => void;
  roles?: readonly ProfileRoleChip[];
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
  onStartCall,
  onComposeDraft,
  onMention,
  roles,
  onBlockUser,
  onUnblockUser,
  onReportUser,
}: UserProfileCardProps) {
  const { t } = useTranslation();
  // The friends feature's own state logic, reused whole — the same fetch, the
  // same optimistic refresh, the same generation guard. Mounting it here (and
  // only while the card is open) is what keeps its 15s poll scoped to somebody
  // actually looking, which is the argument use-friends.ts makes for pull.
  const { data, loading, send, accept, remove, removeDepoimento } = useFriends();
  const cardRef = useRef<HTMLDivElement>(null);
  const mentionUsername = subject.username?.trim() || null;
  const paintedRoles = useMemo(
    () => cardRoleChips(roles, subject.roleIds),
    [roles, subject.roleIds],
  );
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
  /**
   * The profile's own content: the depoimentos this person chose to display and
   * the communities they show. One fetch each, fired on open.
   *
   * NOT IN THE FRIENDS STORE, unlike the pending queue. These are facts about
   * SOMEBODY ELSE and they are only ever wanted while their card is open — the
   * card already remounts per subject (see the `key` on it), so holding them
   * here is what makes closing the card forget them. The queue is the opposite:
   * one list, about the account holder, needed by a badge on a door the card
   * has nothing to do with.
   */
  const [depoimentos, setDepoimentos] = useState<Depoimento[] | null>(null);
  const [achievements, setAchievements] = useState<ProfileAchievement[] | null>(
    null,
  );
  const [communities, setCommunities] = useState<ProfileCommunityList | null>(
    null,
  );
  const [connections, setConnections] = useState<VisibleConnection[] | null>(
    null,
  );
  const [aboutPick, setAboutPick] = useState<ProfileAboutTab | null>(null);
  /** Open while the composer is up. */
  const [writing, setWriting] = useState(false);
  /** The same fact, readable from listeners registered before it changes. */
  const writingRef = useRef(false);
  useEffect(() => {
    writingRef.current = writing;
  }, [writing]);

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
  // The owner-only rank change, derived apart from the ladder on purpose (see
  // `roleChangeFor`). It needs no `state === "self"` guard of its own: the
  // function already answers null for yourself.
  const roleChange = roleChangeFor(subject.id, currentUserId, moderation);
  const presence = resolvePresence(subject.id, state, data, subject.status);
  const since = friendsSince(subject.id, data);
  const aboutTabs = useMemo(
    () =>
      profileAboutTabs({
        depoimentoCount: depoimentos?.length ?? 0,
        connectionCount: connections?.length ?? 0,
        communityCount: communities?.communities.length ?? 0,
      }),
    [depoimentos, connections, communities],
  );
  const aboutActive = activeProfileAboutTab(aboutTabs, aboutPick);
  const aboutSegmented = aboutTabs.length > 1;
  const aboutChrome = aboutSegmented ? "plain" : "well";

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
    // rather than chase, which is what every anchored surface here does. Two
    // exceptions: a scroll INSIDE the card (the composer opening grows the
    // content, and that growth fires a capture-phase scroll — closing on it is
    // the card closing itself), and any scroll while a depoimento is being
    // written, for the same reason the pointer handler holds its fire.
    function onScroll(event: Event) {
      if (event.target instanceof Node && cardRef.current?.contains(event.target)) {
        return;
      }
      if (writingRef.current) {
        return;
      }
      onClose();
    }
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose, state, loading, aboutActive, aboutTabs.length]);

  /**
   * The card's own content, read once on open.
   *
   * These reads are safe against every viewer: depoimentos and achievements
   * answer an empty list rather than a 403, and the community read is already
   * filtered to listed, unsuspended, opted-in rooms. A failure just leaves
   * the sections hidden, which is what a card with nothing to show looks like.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [list, earned, badges, linked] = await Promise.all([
          fetchDepoimentos(subject.id),
          fetchUserAchievements(subject.id),
          fetchProfileCommunities(subject.id),
          fetchUserConnections(subject.id),
        ]);
        if (!alive) {
          return;
        }
        setDepoimentos(list.depoimentos);
        setAchievements(earned.achievements);
        setCommunities(badges);
        setConnections(linked.connections);
      } catch {
        // Silent. Both sections hide themselves when empty, so a failed read
        // degrades to "this person has none" — and neither is worth putting an
        // error banner on somebody's profile card for.
        if (alive) {
          setDepoimentos([]);
          setAchievements([]);
          setCommunities(null);
          setConnections([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [subject.id]);

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (cardRef.current?.contains(target) || anchor.contains(target)) {
        return;
      }
      // A depoimento mid-composition outranks the tap-away convention: the
      // click probably meant "dismiss", but the cost of being wrong is a
      // paragraph somebody typed about a friend. Cancel and Escape still work.
      if (writingRef.current) {
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
   * Ring this person.
   *
   * The SAME `createConversation` the Message button uses, on purpose: a DM
   * call is a conversation with a ring on it, there is exactly one 1:1 per
   * pair, and a second path to it would be a second set of rules about who may
   * open one. The app takes it from there — navigate to the conversation and
   * either join the call already running in it or start ringing — which is the
   * one path the DM list's phone and the conversation header already use.
   *
   * A refusal (`dm_privacy`, a block, a character account) comes back from that
   * first request as an `ApiError` and lands in the card's error line in the
   * server's own words. See `canCall` for why the button is not hidden for any
   * of those.
   */
  function handleCall() {
    void run(async () => {
      const { conversation } = await createConversation([subject.id]);
      onStartCall?.(conversation);
      onClose();
    });
  }

  /**
   * The fork out of the depoimento composer: open the DM instead, carrying what
   * they had already typed.
   *
   * This is the same `createConversation` the Message button uses, deliberately
   * — there is no second path and no special "private depoimento", because the
   * whole point is that the private thing they are trying to say has a real,
   * ordinary home. §02 is what happens when it does not.
   */
  function handleSendAsDm(body: string) {
    void run(async () => {
      const { conversation } = await createConversation([subject.id]);
      onOpenConversation(conversation);
      onComposeDraft?.(body);
      setWriting(false);
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

  /**
   * Change this person's nickname in the server the card was opened in.
   *
   * The same `window.prompt` the members panel uses, and the same gate: the
   * panel offers it to yourself or to any manager, and the card only has a
   * `moderation` context at all when the viewer manages this server — so
   * "moderation exists" IS the panel's rule, minus the plain-member-changing-
   * themselves case, which the panel's own context menu keeps.
   */
  function changeNickname() {
    if (!moderation) {
      return;
    }
    const { serverId } = moderation;
    const next = window.prompt(
      t("member.nicknamePrompt"),
      subject.nickname ?? "",
    );
    if (next === null) {
      return;
    }
    const trimmed = next.trim();
    setNotice(null);
    void run(async () => {
      await updateMemberNickname(
        serverId,
        subject.id,
        trimmed.length === 0 ? null : trimmed,
      );
      moderation.onModerated();
      setNotice(t("profile.mod.nicknamed"));
    });
  }

  /**
   * Promote or demote. Unconfirmed, the way the panel's version is: the change
   * is reversible in one tap and the `permissions-update` frame that follows
   * it refreshes the roster every surface reads from.
   */
  function runRoleChange(which: ProfileRoleChange) {
    if (!moderation) {
      return;
    }
    const { serverId } = moderation;
    setNotice(null);
    void run(async () => {
      await updateMemberRole(
        serverId,
        subject.id,
        which === "promote" ? "admin" : "member",
      );
      moderation.onModerated();
      setNotice(
        t(
          which === "promote" ? "profile.mod.promoted" : "profile.mod.demoted",
          { name: subject.displayName },
        ),
      );
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
  ];

  const manageItems: {
    id: string;
    label: string;
    danger?: boolean;
    moderation?: ProfileModerationAction;
    onSelect: () => void;
  }[] = [
    ...(moderation
      ? [
          {
            id: "nickname",
            label: t("member.nickname"),
            onSelect: () => {
              changeNickname();
            },
          },
        ]
      : []),
    ...(roleChange
      ? [
          {
            id: `role-${roleChange}`,
            label:
              roleChange === "promote"
                ? t("member.promote")
                : t("member.demote"),
            onSelect: () => {
              runRoleChange(roleChange);
            },
          },
        ]
      : []),
    ...modActions.map((which) => ({
      id: `mod-${which}`,
      label: modLabel[which],
      danger: moderationNeedsConfirmation(which),
      moderation: which,
      onSelect: () => {
        if (moderationNeedsConfirmation(which)) {
          setConfirmingModeration(which);
          return;
        }
        if (which === "timeout") {
          setTimeoutMinutes(DEFAULT_TIMEOUT_MINUTES);
          return;
        }
        runModeration(which);
      },
    })),
  ];

  /**
   * The strip of things you do WITH somebody — message, call, mention — plus
   * the ellipsis that hides block and report. Equal icon wells, captions
   * under the chrome. Nickname, rank and the ladder live in the section
   * below, not in this strip.
   */
  const tileMore = overflowItems.length > 0;
  const tileMessage = canMessage(state);
  const tileCall = canCall(state) && Boolean(onStartCall);
  const tileMention = Boolean(onMention && mentionUsername);
  const actionStrip =
    tileMessage || tileCall || tileMention || tileMore ? (
      <div className="mt-3 flex items-start gap-2">
        {tileMessage && (
          <div className="min-w-0 flex-1">
            <ActionTile
              label={t("friends.message")}
              disabled={busy}
              data-profile-message=""
              onClick={handleMessage}
            >
              <MessageCircle aria-hidden className="h-[18px] w-[18px]" />
            </ActionTile>
          </div>
        )}
        {tileCall && (
          <div className="min-w-0 flex-1">
            <ActionTile
              label={t("profile.call")}
              disabled={busy}
              data-profile-call=""
              onClick={handleCall}
            >
              <Phone aria-hidden className="h-[18px] w-[18px]" />
            </ActionTile>
          </div>
        )}
        {tileMention && (
          <div className="min-w-0 flex-1">
            <ActionTile
              label={t("member.mention")}
              disabled={busy}
              data-profile-mention=""
              onClick={() => {
                if (mentionUsername) {
                  onMention?.(mentionUsername);
                }
                onClose();
              }}
            >
              <AtSign aria-hidden className="h-[18px] w-[18px]" />
            </ActionTile>
          </div>
        )}
        {tileMore && (
          <div className="relative min-w-0 flex-1">
            <ActionTile
              label={t("profile.more")}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              disabled={busy}
              onClick={() => setOverflowOpen((was) => !was)}
            >
              <MoreHorizontal aria-hidden className="h-[18px] w-[18px]" />
            </ActionTile>
            {overflowOpen && (
              <div
                role="menu"
                aria-label={t("profile.more")}
                // Opens down, not up: the card itself scrolls, and an upward
                // menu was clipped by that overflow (Block disappeared). A cap
                // still keeps a tall owner menu inside the card.
                className="absolute top-full right-0 z-10 mt-1 max-h-[15rem] w-48 overflow-y-auto rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)]"
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
    ) : null;

  const manageSection =
    manageItems.length > 0 ? (
      <div className="mt-3 overflow-hidden rounded-xl bg-ink-3/60">
        <p className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-paper-muted">
          {t("profile.mod.section")}
        </p>
        <div className="divide-y divide-ink-4/50">
          {manageItems.map((item) => (
            <button
              key={item.id}
              type="button"
              data-profile-mod={item.moderation}
              disabled={busy}
              className={cn(
                "flex w-full items-center px-3 py-2.5 text-left text-sm transition-colors hover:bg-ink-3 focus-visible:bg-ink-3 focus-visible:outline-none disabled:opacity-40",
                item.danger ? "text-danger" : "text-paper",
              )}
              onClick={item.onSelect}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    ) : null;

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
      // The whole card scrolls. A nested pane under the medals was not
      // enough: at high zoom the identity and NESTA COMUNIDADE already fill
      // the viewport cap, the inner scroller shrinks to nothing, and the
      // bottom of the card is unreachable. overflow-y on this node is what
      // a daft zoom needs. Mais opens downward so Block is not clipped.
      className="fixed z-[110] max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain rounded-2xl border border-ink-4 bg-ink-2 shadow-[var(--shadow-popover)] animate-fade-in"
    >
      {/* No banner image exists on the server, so the band is a quiet wash of
          the accent into the surface — enough depth that the card reads as an
          object rather than a grey rectangle, without inventing an upload
          field. Tokens only, so every theme tints its own way. Rounds its own
          top corners now that the card no longer clips it. */}
      <div
        aria-hidden="true"
        className="h-20 rounded-t-2xl"
        style={{
          background:
            "linear-gradient(150deg, color-mix(in oklab, var(--color-accent) 20%, var(--color-surface-2)) 0%, var(--color-surface-2) 55%, color-mix(in oklab, var(--color-accent) 7%, var(--color-surface-1)) 100%)",
        }}
      />

      <div className="px-4 pb-4">
        {/* Identity, centred like a contact sheet: the person first, at rest,
            with everything you can do about them in the rows below. Self and
            other are the same object — the states differ only in which rows
            follow. */}
        <div className="relative mx-auto -mt-10 w-fit">
          {/* `UserAvatar`, not an `<img>`. This card used to point an `<img>`
              straight at `subject.avatarUrl`, and an UPLOADED avatar's URL is
              root-relative (`/api/avatars/<id>?v=…` — `avatarPath` in
              `@pqp/shared` is relative because the API does not know its own
              public origin). The SPA and the API are two different origins on
              every hosted deployment, so the browser resolved that path against
              Pages, which has no `/api`, and drew a broken-image glyph in the
              corner of the circle — while the same person's face in the member
              list two inches away was fine, because that one goes through here.
              `resolveAvatarUrl` is what prefixes the API base, and the
              `onError` fallback is what turns a dead URL into the monogram
              instead of a broken image. See `e2e/profile-popover-avatar.spec.ts`. */}
          <UserAvatar
            name={subject.displayName}
            avatarUrl={subject.avatarUrl}
            rounded="full"
            className="h-20 w-20 ring-4 ring-ink-2"
            fallbackClassName="bg-ink-3 text-2xl text-paper"
          />
          {presence && (
            <StatusDot
              status={presence}
              size="md"
              className="absolute bottom-0 right-0"
              ringClassName="rounded-full bg-ink-2 ring-4 ring-ink-2"
            />
          )}
        </div>

        <p className="mt-2 flex items-center justify-center gap-1.5 font-display text-xl font-bold text-paper">
          <span className="truncate" data-profile-name="">
            {subject.displayName}
          </span>
          <RankMarks
            size="card"
            marks={identityMarks({
              rank: subject.rank,
            })}
          />
        </p>
        {subject.tag && (
          <p className="truncate text-center font-mono text-xs text-paper-muted">
            {subject.tag}
          </p>
        )}
        {paintedRoles.length > 0 && (
          <ul
            className="mt-2 flex flex-wrap justify-center gap-1"
            aria-label={t("profile.roles")}
          >
            {paintedRoles.map((role) => (
              <li
                key={role.id}
                className="inline-flex items-center gap-1 rounded-md bg-ink-3 px-1.5 py-0.5 text-[11px] text-paper"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: role.color ?? "currentColor",
                  }}
                  aria-hidden
                />
                {role.name}
              </li>
            ))}
          </ul>
        )}
        {since && (
          <p className="mt-1 text-center text-[11px] text-paper-muted">
            {t("profile.friendsSince", {
              date: new Date(since).toLocaleDateString(undefined, {
                month: "long",
                year: "numeric",
              }),
            })}
          </p>
        )}

        {notice && (
          <p className="mt-2 text-center text-xs text-signal" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="mt-2 text-center text-xs text-danger" role="alert">
            {error}
          </p>
        )}

        {/* THE ROW USED TO WRAP. Five mixed controls — a flexible labelled
            primary, Decline, a labelled Message, two icon buttons — shared one
            flex-wrap row, and the Portuguese labels pushed the ellipsis onto
            its own line. The fix is structural, not a width tweak: the
            relationship gets a full-width pill (label length can never crowd
            anything), and everything else is the fixed-tile strip above, which
            cannot wrap by construction. */}
        {state === "self" ? (
          <>
            <p className="mt-3 text-center text-xs text-paper-muted">
              {t("profile.isYou")}
            </p>
            {actionStrip}
            {manageSection}
          </>
        ) : loading ? (
          <div className="mt-4 flex h-9 items-center justify-center text-paper-muted">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            <span className="sr-only">{t("profile.loading")}</span>
          </div>
        ) : (
          <>
            {/* The relationship is the one distinguished action, so it reads
                as a statement under the name — accent when there is something
                to do, quiet when it is just a fact ("Friends ✓"). An incoming
                request splits the row in two: answering should cost one tap
                either way. Community management sits in the grouped list
                below. Block and report stay behind the ellipsis. */}
            <div
              className={cn(
                "mt-4",
                offersDecline(state) && "grid grid-cols-2 gap-2",
              )}
            >
              <Button
                size="sm"
                variant={action === "alreadyFriends" ? "secondary" : "default"}
                className="h-9 w-full rounded-full"
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
                {busy && (
                  <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                )}
                {action === "alreadyFriends"
                  ? `${primaryLabel[action]} ✓`
                  : primaryLabel[action]}
              </Button>
              {offersDecline(state) && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-9 w-full rounded-full"
                  disabled={busy}
                  onClick={() => void run(() => remove(subject.id))}
                >
                  {t("friends.decline")}
                </Button>
              )}
            </div>
            {actionStrip}
            {manageSection}
          </>
        )}

        {/* "Escrever depoimento" — friends only, and its own row rather than a
            fourth button squeezed into the one above. It is the warm action on
            this card and every other control up there is either a relationship
            or a punishment; putting it in that row would make it read as one of
            them. `canWriteDepoimento` is the same gate the server enforces with
            `areFriendsSql`, so this button is never drawn where it would 403. */}
        {canWriteDepoimento(state) && !writing && (
          <Button
            size="sm"
            variant="secondary"
            className="mt-3 w-full rounded-full"
            disabled={busy}
            data-depoimento-write=""
            onClick={() => {
              setNotice(null);
              setWriting(true);
            }}
          >
            {t("depoimentos.write")}
          </Button>
        )}

        {writing && (
          <DepoimentoComposer
            subject={subject}
            onWritten={() => {
              setWriting(false);
              setNotice(
                t("depoimentos.written", { name: subject.displayName }),
              );
            }}
            onSendAsDm={handleSendAsDm}
            onCancel={() => setWriting(false)}
          />
        )}

        {/* Medals stay on the card. Depoimentos, connections and communities
            share one pane when there is more than one of them: a stack is what
            pushed Comunidades off a short window, and three accordions would
            spend that height on chevrons. One segment at a time, leftover
            height. Empty blocks stay omitted, including from the control. */}
        {((achievements ?? []).length > 0 || aboutTabs.length > 0) && (
          <div className="mt-4 border-t border-ink-4/60 pt-3">
            <Achievements
              achievements={achievements ?? []}
              variant="compact"
            />
            {aboutSegmented && aboutActive && (
              <div
                role="tablist"
                aria-label={t("profile.about.tabs")}
                className="mt-3 grid gap-0.5 rounded-lg bg-ink-3/60 p-0.5"
                style={{
                  gridTemplateColumns: `repeat(${aboutTabs.length}, minmax(0, 1fr))`,
                }}
              >
                {aboutTabs.map((tab) => {
                  const selected = tab === aboutActive;
                  return (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      data-profile-about={tab}
                      className={cn(
                        "truncate rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors",
                        selected
                          ? "bg-ink-2 text-paper"
                          : "text-paper-muted hover:text-paper",
                      )}
                      onClick={() => setAboutPick(tab)}
                    >
                      {t(ABOUT_LABEL[tab])}
                    </button>
                  );
                })}
              </div>
            )}
            {aboutTabs.length > 0 && (
              <div
                role={aboutSegmented ? "tabpanel" : undefined}
                data-profile-about-pane={aboutActive ?? undefined}
                className={aboutSegmented ? "mt-2 rounded-xl bg-ink-3/60" : undefined}
              >
                {(!aboutSegmented || aboutActive === "depoimentos") && (
                  <DepoimentosSection
                    depoimentos={depoimentos ?? []}
                    chrome={aboutChrome}
                    busy={busy}
                    onRemove={
                      state === "self"
                        ? (id) =>
                            void run(async () => {
                              await removeDepoimento(id);
                              setDepoimentos((current) =>
                                (current ?? []).filter((one) => one.id !== id),
                              );
                            })
                        : undefined
                    }
                  />
                )}
                {connections &&
                  (!aboutSegmented || aboutActive === "connections") && (
                    <ConnectionBadges
                      connections={connections}
                      variant="card"
                      chrome={aboutChrome}
                    />
                  )}
                {communities &&
                  (!aboutSegmented || aboutActive === "communities") && (
                    <CommunityBadges
                      communities={communities}
                      chrome={aboutChrome}
                    />
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
