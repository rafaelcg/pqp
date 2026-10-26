import {
  ArrowUpRight,
  AtSign,
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
  USER_BANNER_HEIGHT,
  USER_BANNER_WIDTH,
  type Depoimento,
  type DmSummary,
  type ProfileAchievement,
  type ProfileCommunityList,
  type VisibleConnection,
  type WatchParty,
  parseBotFaceAvatar,
} from "@pqp/shared";
import { ServerBotTags } from "@/components/bots/server-bot-tags";
import {
  cohostActionFor,
  type ProfileCohostAction,
} from "@/lib/profile-cohost";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { RankMarks } from "@/components/user/rank-marks";
import { identityMarks, rankBadges } from "@/lib/author-display";
import { CheckRow } from "@/components/ui/check-row";
import { Tabs } from "@/components/ui/tabs";
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
  assignMemberRole,
  createConversation,
  fetchUserBannerUrl,
  fetchUserConnections,
  fetchUserAchievements,
  unassignMemberRole,
  updateMemberNickname,
} from "@/lib/api";
import {
  applyMemberModeration,
  describeTimeoutMinutes,
  DEFAULT_TIMEOUT_MINUTES,
} from "@/lib/member-moderation";
import { displayRoleName } from "@/lib/role-labels";
import {
  assignableRoleIds,
  canActOnMemberClient,
} from "@/lib/role-hierarchy";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { ProfileStatusLine } from "@/components/apps/app-presence-line";
import { cn, formatRecency } from "@/lib/utils";
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
  placeMenu,
  primaryAction,
  primaryIsInert,
  offersDecline,
  publicProfileHref,
  resolveFriendshipState,
  resolvePresence,
  profileAboutTabs,
  activeProfileAboutTab,
  type MenuPlacement,
  type Placement,
  type ProfileAboutTab,
  type ProfileModerationAction,
  type ProfileModerationContext,
  type ProfilePrimaryAction,
  type ProfileRoleChip,
  type ProfileSubject,
} from "./profile-relations";
import { Spinner } from "@/components/ui/spinner";

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

/**
 * The watch party on the open channel, when there is one, so the card can
 * offer "Promover a co-host" on the person being looked at. The card decides
 * whether to draw it (`cohostActionFor`); the app only says which party.
 */
export interface ProfileWatchPartyContext {
  party: WatchParty;
  onPromote: (userId: string) => Promise<void>;
  onDemote: (userId: string) => Promise<void>;
}

interface ProfilePopoverProviderProps {
  currentUserId: string | null;
  /** See `ProfileWatchPartyContext`. Null outside a party channel. */
  watchParty?: ProfileWatchPartyContext | null;
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
  /**
   * Conversas (`conversations_home`): when the last line was exchanged with
   * this person in a 1:1, read from the list the app already holds, so the
   * card can say "Última conversa · 20:41". Absent with the flag off.
   */
  lastConversationAt?: (userId: string) => string | null;
  children: ReactNode;
}

interface OpenState {
  subject: ProfileSubject;
  anchor: HTMLElement;
}

export function ProfilePopoverProvider({
  currentUserId,
  watchParty,
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
  lastConversationAt,
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
          watchParty={watchParty ?? null}
          onClose={() => setState(null)}
          onOpenConversation={onOpenConversation}
          onStartCall={onStartCall}
          onComposeDraft={onComposeDraft}
          onMention={onMention}
          roles={roles}
          onBlockUser={onBlockUser}
          onUnblockUser={onUnblockUser}
          onReportUser={onReportUser}
          lastConversationAt={lastConversationAt?.(state.subject.id) ?? null}
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

/** 15rem. A tall owner menu scrolls past this rather than grow further. */
const MORE_MENU_MAX_HEIGHT = 240;

const ABOUT_LABEL: Record<ProfileAboutTab, MessageKey> = {
  depoimentos: "depoimentos.section",
  connections: "profile.about.accounts",
  communities: "depoimentos.communities",
};

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

/**
 * The band across the top of the card: the person's banner when they uploaded
 * one, the accent wash when they did not.
 *
 * ONE HEIGHT FOR BOTH. The band is the banner's own 3:1 (the rectangle
 * `uploadUserBanner` crops to), so a banner is drawn whole rather than sliced,
 * and the empty state is the same box. The card is measured once when it
 * opens and is not measured again when the banner arrives, so a band that grew
 * on load could push the bottom of the card off the screen.
 *
 * The wash is always painted and the picture sits on top of it. Loading, a
 * failed load and "no banner" therefore all look like the card always looked,
 * with no state for any of them beyond "did the image fail". Tokens only, so
 * every theme tints its own way.
 */
function ProfileCardBanner({ bannerUrl, tint }: { bannerUrl: string | null; tint?: string }) {
  // Root-relative from the API (`userBannerPath`), so it must be resolved
  // against the API's origin, not the SPA's. Same lesson as the avatar below.
  const src = resolveUploadedImageUrl(bannerUrl);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const showImage = src !== null && src !== failedSrc;
  return (
    <div
      aria-hidden="true"
      data-profile-banner={showImage ? "image" : "generated"}
      className="relative overflow-hidden rounded-t-2xl"
      style={{
        aspectRatio: `${USER_BANNER_WIDTH} / ${USER_BANNER_HEIGHT}`,
        background:
          tint ??
          "linear-gradient(150deg, color-mix(in oklab, var(--color-accent) 20%, var(--color-surface-2)) 0%, var(--color-surface-2) 55%, color-mix(in oklab, var(--color-accent) 7%, var(--color-surface-1)) 100%)",
      }}
    >
      {showImage && (
        <img
          src={src}
          alt=""
          decoding="async"
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-[var(--duration-base)] ease-[var(--ease-standard)] motion-reduce:transition-none",
            loadedSrc === src ? "opacity-100" : "opacity-0",
          )}
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
      )}
    </div>
  );
}

interface UserProfileCardProps {
  subject: ProfileSubject;
  anchor: HTMLElement;
  currentUserId: string | null;
  blockedUserIds: ReadonlySet<string>;
  moderation: ProfileModerationContext | null;
  watchParty: ProfileWatchPartyContext | null;
  onClose: () => void;
  onOpenConversation: (conversation: DmSummary) => void;
  onStartCall?: (conversation: DmSummary) => void;
  onComposeDraft?: (text: string) => void;
  onMention?: (username: string) => void;
  roles?: readonly ProfileRoleChip[];
  onBlockUser: (userId: string) => void;
  onUnblockUser: (userId: string) => void;
  onReportUser: (subject: ProfileSubject) => void;
  lastConversationAt?: string | null;
}

function UserProfileCard({
  subject,
  anchor,
  currentUserId,
  blockedUserIds,
  moderation,
  watchParty,
  onClose,
  onOpenConversation,
  onStartCall,
  onComposeDraft,
  onMention,
  roles,
  onBlockUser,
  onUnblockUser,
  onReportUser,
  lastConversationAt = null,
}: UserProfileCardProps) {
  const serverBot = parseBotFaceAvatar(subject.avatarUrl);
  const { t } = useTranslation();
  // The friends feature's own state logic, reused whole — the same fetch, the
  // same optimistic refresh, the same generation guard. Mounting it here (and
  // only while the card is open) is what keeps its 15s poll scoped to somebody
  // actually looking, which is the argument use-friends.ts makes for pull.
  const { data, loading, send, accept, remove, removeDepoimento } = useFriends();
  const cardRef = useRef<HTMLDivElement>(null);
  const mentionUsername = subject.username?.trim() || null;
  const [heldIds, setHeldIds] = useState<string[]>(() => subject.roleIds ?? []);
  const roleIdsKey = (subject.roleIds ?? []).join(",");
  useEffect(() => {
    setHeldIds(subject.roleIds ?? []);
  }, [subject.id, roleIdsKey, subject.roleIds]);
  const paintedRoles = useMemo(
    () => cardRoleChips(roles, heldIds),
    [roles, heldIds],
  );
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<"remove" | "block" | null>(
    null,
  );
  /** The same fact, readable from the tap-away listener. */
  const pendingConfirmRef = useRef(false);
  useEffect(() => {
    pendingConfirmRef.current = pendingConfirm !== null;
  }, [pendingConfirm]);
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
  /**
   * Their banner, once read, with whose it is. The card can be handed another
   * person while open, and their read can fail: keyed, the last person's
   * banner is never drawn on the next one.
   */
  const [banner, setBanner] = useState<{ userId: string; url: string | null } | null>(
    null,
  );
  const bannerUrl = banner?.userId === subject.id ? banner.url : null;
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
  // A server bot cannot be befriended, messaged or called: you call it by
  // name in a channel, so its card leads with that instead.
  const action = serverBot ? "none" : primaryAction(state);
  // Never against yourself, whatever the roster says — `canModerateMember`
  // refuses it too, but "self" short-circuits before any of this is asked.
  const modActions =
    state === "self"
      ? []
      : moderationActions(subject.id, currentUserId, moderation);
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
   * Where the Mais menu sits. Fixed to the window, measured from the tile, so
   * the card's own scroller cannot clip it (see `placeMenu`). It stays a DOM
   * child of the card, which keeps the tap-away and scroll handlers above
   * treating a press on Bloquear as a press inside the card.
   */
  const moreTileRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<MenuPlacement | null>(null);
  useLayoutEffect(() => {
    const tile = moreTileRef.current;
    const menu = moreMenuRef.current;
    const card = cardRef.current;
    if (!overflowOpen || !tile || !menu || !card) {
      setMenuAt(null);
      return;
    }
    function place() {
      const own = menu!.getBoundingClientRect();
      setMenuAt(
        placeMenu(
          tile!.getBoundingClientRect(),
          // The natural height up to the cap, not what the last placement
          // squeezed it to.
          {
            width: own.width,
            height: Math.min(menu!.scrollHeight, MORE_MENU_MAX_HEIGHT),
          },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    }
    place();
    // A fixed menu does not travel with the card's content, so scrolling the
    // card closes it rather than leaving it over the wrong row. Not capture:
    // a scroll inside the menu's own list does not bubble here.
    function onCardScroll() {
      setOverflowOpen(false);
    }
    window.addEventListener("resize", place);
    card.addEventListener("scroll", onCardScroll);
    return () => {
      window.removeEventListener("resize", place);
      card.removeEventListener("scroll", onCardScroll);
    };
  }, [overflowOpen, placement]);

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

  /**
   * The banner, in its own read rather than in the four above.
   *
   * On its own because those four fail together: a rejected banner read inside
   * that `Promise.all` would empty the depoimentos, medals, communities and
   * accounts too. The web client also ships before the API it talks to, so for
   * a few minutes after a deploy this route can 404 on the old API, and that
   * must cost the card nothing but the picture. Any failure is "no banner",
   * recorded for this person, so a picture read on an earlier visit is not
   * drawn after the read that should have replaced it failed.
   */
  useEffect(() => {
    let alive = true;
    const userId = subject.id;
    fetchUserBannerUrl(userId)
      .then((result) => {
        if (alive) {
          setBanner({ userId, url: result.bannerUrl ?? null });
        }
      })
      .catch(() => {
        if (alive) {
          setBanner({ userId, url: null });
        }
      });
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
      // The remove and block confirms are portalled to the body, so every
      // press on them lands "outside" the card. Closing here unmounted the
      // confirm between mousedown and click, and a mouse or a tap on
      // "Bloquear" did nothing. While a confirm is up it owns the pointer:
      // its own buttons, X and Escape decide.
      if (pendingConfirmRef.current) {
        return;
      }
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      // Escape with a confirm up backs out of the confirm only; the next one
      // closes the card. Dialog already stops Escape in its capture listener,
      // but the card must not rely on that: a confirm that is not dismissible
      // (mid-request) swallows Escape, and the card under it stays too.
      if (pendingConfirmRef.current) {
        return;
      }
      onClose();
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
            // The card already knows it, and the friends list draws the same
            // shape, so passing it through is what stops a person appearing
            // there without the line they appear with everywhere else.
            customStatus: subject.customStatus ?? null,
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
      // One implementation of every rung, shared with the member list's own
      // menu. See `lib/member-moderation.ts`. What stays here is the wording
      // this surface shows afterwards.
      const message = await applyMemberModeration({
        action: which,
        serverId,
        userId: subject.id,
        minutes: timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
        reason: which === "ban" ? banReason : timeoutReason,
      });
      if (which === "timeout") {
        setTimeoutMinutes(null);
        setTimeoutReason("");
      }
      if (which === "ban") {
        setBanReason("");
      }
      moderation.onModerated();
      switch (which) {
        case "timeout":
          // The server writes the whole sentence — when it ends, what it takes
          // away — and it is the same one the sanctioned person reads. Showing
          // it verbatim is how the two sides cannot disagree about it.
          setNotice(message);
          return;
        case "endTimeout":
          setNotice(
            t("profile.mod.timeoutEnded", { name: subject.displayName }),
          );
          return;
        case "kick":
          setNotice(t("profile.mod.kicked", { name: subject.displayName }));
          return;
        case "ban":
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

  function toggleCargo(roleId: string, next: boolean) {
    if (!moderation) {
      return;
    }
    const { serverId } = moderation;
    const previous = heldIds;
    setHeldIds(
      next
        ? previous.includes(roleId)
          ? previous
          : [...previous, roleId]
        : previous.filter((id) => id !== roleId),
    );
    setNotice(null);
    void run(async () => {
      try {
        if (next) {
          await assignMemberRole(serverId, subject.id, roleId);
        } else {
          await unassignMemberRole(serverId, subject.id, roleId);
        }
        moderation.onRolesChanged?.();
      } catch (err) {
        setHeldIds(previous);
        throw err;
      }
    });
  }

  const assignableCargos = useMemo(() => {
    if (!moderation?.bits?.manageRoles || !roles?.length) {
      return [];
    }
    const targetRole = moderation.memberRoles.get(subject.id);
    if (!targetRole) {
      return [];
    }
    const hierarchy = roles.map((role) => ({
      id: role.id,
      position: role.position,
      permissions: role.permissions ?? "0",
      systemKey: role.systemKey,
      isEveryone: role.isEveryone,
    }));
    if (
      !canActOnMemberClient(
        {
          role: moderation.actorRole,
          roleIds: moderation.actorRoleIds,
        },
        { role: targetRole, roleIds: heldIds },
        hierarchy,
        currentUserId,
        subject.id,
      )
    ) {
      return [];
    }
    const allowed = new Set(
      assignableRoleIds(
        {
          role: moderation.actorRole,
          roleIds: moderation.actorRoleIds,
        },
        hierarchy,
      ),
    );
    return [...roles]
      .filter((role) => allowed.has(role.id))
      .sort((a, b) => b.position - a.position);
  }, [moderation, roles, heldIds, currentUserId, subject.id]);

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
              setPendingConfirm("remove");
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
              setPendingConfirm("block");
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

  const cohostAction = cohostActionFor({
    party: watchParty?.party,
    subjectId: subject.id,
    currentUserId,
  });
  const manageItems: {
    id: string;
    label: string;
    danger?: boolean;
    moderation?: ProfileModerationAction;
    /** Set on the watch party rung, so a test can find it. */
    cohost?: ProfileCohostAction;
    onSelect: () => void;
  }[] = [
    // THE WATCH PARTY, FIRST. While a party is on, the thing a host most
    // wants to do to a person is hand them the backup badge, and every
    // product we looked at does it from the person rather than from a list.
    ...(cohostAction && watchParty
      ? [
          {
            id: `cohost-${cohostAction}`,
            label:
              cohostAction === "promote"
                ? t("profile.cohost.promote", { name: watchParty.party.name })
                : t("profile.cohost.demote"),
            cohost: cohostAction,
            onSelect: () => {
              setBusy(true);
              const run =
                cohostAction === "promote"
                  ? watchParty.onPromote(subject.id)
                  : watchParty.onDemote(subject.id);
              void run
                .catch(() => setNotice(t("profile.cohost.failed")))
                .finally(() => setBusy(false));
            },
          },
        ]
      : []),
    ...(moderation &&
    (moderation.bits ? moderation.bits.nicknames : true)
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
   * the public page when they claimed a handle, plus the ellipsis that hides
   * block and report. Equal icon wells, captions under the chrome. Nickname,
   * rank and the ladder live in the section below, not in this strip.
   */
  const publicHref = publicProfileHref(subject.handle);
  const tilePublic = Boolean(publicHref);
  const tileMore = overflowItems.length > 0;
  const tileMessage = canMessage(state) && !serverBot;
  const tileCall = canCall(state) && Boolean(onStartCall) && !serverBot;
  const tileMention = Boolean(onMention && mentionUsername);
  const lastConversationLine =
    lastConversationAt && tileMessage ? (
      <p
        data-profile-last-conversation=""
        className="mt-2 text-[11px] text-text-tertiary"
      >
        {t("conversations.profileLast", { time: formatRecency(lastConversationAt) })}
      </p>
    ) : null;
  const actionStrip =
    tileMessage || tileCall || tileMention || tilePublic || tileMore ? (
      <div className="mt-3 flex items-start gap-2">
        {tilePublic && publicHref && (
          <div className="min-w-0 flex-1">
            <ActionTile
              label={t("profile.viewPublic")}
              data-profile-public=""
              onClick={() => {
                window.open(publicHref, "_blank", "noopener,noreferrer");
              }}
            >
              <ArrowUpRight aria-hidden className="h-[18px] w-[18px]" />
            </ActionTile>
          </div>
        )}
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
          <div ref={moreTileRef} className="min-w-0 flex-1">
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
                ref={moreMenuRef}
                role="menu"
                aria-label={t("profile.more")}
                // Fixed, not absolute: the card scrolls, and an absolute menu
                // was clipped by it either way it opened (Block went upward,
                // Report went downward). Hidden until measured, like the card.
                style={{
                  left: menuAt?.left ?? 0,
                  top: menuAt?.top ?? 0,
                  maxHeight: Math.min(
                    MORE_MENU_MAX_HEIGHT,
                    menuAt?.maxHeight ?? MORE_MENU_MAX_HEIGHT,
                  ),
                  visibility: menuAt ? "visible" : "hidden",
                }}
                className="fixed z-10 w-48 overflow-y-auto rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)]"
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
              data-profile-cohost={item.cohost}
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

  const cargosSection =
    assignableCargos.length > 0 ? (
      <div className="mt-3 overflow-hidden rounded-xl bg-ink-3/60">
        <p className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-paper-muted">
          {t("profile.cargos")}
        </p>
        <div className="px-1 pb-1">
          {assignableCargos.map((role) => (
            <div key={role.id} data-profile-cargo={role.id}>
              <CheckRow
                checked={heldIds.includes(role.id)}
                disabled={busy}
                label={displayRoleName(role, t, roles ?? [])}
                swatch={role.color}
                onCheckedChange={(checked) => toggleCargo(role.id, checked)}
              />
            </div>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <>
      {createPortal(
        <div
          ref={cardRef}
          role="dialog"
          aria-label={t("profile.cardLabel", { name: subject.displayName })}
          aria-hidden={pendingConfirm ? true : undefined}
          inert={pendingConfirm ? true : undefined}
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
          // a daft zoom needs. The Mais menu is fixed so this cannot clip it.
          // Drop under the confirm Dialog (z-60) so the in-app confirm is on top.
          className={cn(
            "fixed max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain rounded-2xl border border-ink-4 bg-ink-2 shadow-[var(--shadow-popover)] animate-fade-in",
            pendingConfirm ? "z-[50]" : "z-[110]",
          )}
        >
      {/* Rounds its own top corners and clips the picture to them, because
          the card no longer clips its children. A server bot's band is its
          own colour, the way its face is. */}
      <ProfileCardBanner
        bannerUrl={serverBot ? null : bannerUrl}
        tint={serverBot ? `var(--color-bot-${serverBot.color})` : undefined}
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
          {serverBot ? (
            <span className="grid h-20 w-20 place-items-center rounded-full bg-surface-1 ring-4 ring-ink-2">
              <UserAvatar name={subject.displayName} avatarUrl={subject.avatarUrl} className="h-14 w-14" />
            </span>
          ) : (
            <UserAvatar
              name={subject.displayName}
              avatarUrl={subject.avatarUrl}
              rounded="full"
              className="h-20 w-20 ring-4 ring-ink-2"
              fallbackClassName="bg-ink-3 text-2xl text-paper"
            />
          )}
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
              isCharacter: serverBot ? false : subject.isCharacter,
              ...rankBadges(heldIds, roles ?? []),
            })}
          />
          {serverBot && <ServerBotTags />}
        </p>
        {subject.tag && (
          <p className="truncate text-center font-mono text-xs text-paper-muted">
            {subject.tag}
          </p>
        )}
        {/* O recado, under the tag and above the public URL.

            THE ONE SURFACE THAT SHOWS THE WHOLE THING. The sidebar row truncates
            at roughly 35 characters and the DM row at fewer, so a recado longer
            than a few words is only ever readable here. `line-clamp-2` rather
            than `truncate` for that reason: eighty characters is two lines at
            this width, and clamping at two is what lets the card hold all of it
            without letting a pasted line push the buttons off the bottom.

            Not `font-mono` like the tag above it. A tag is an identifier and a
            recado is somebody talking. */}
        <ProfileStatusLine
          userId={subject.id}
          displayName={subject.displayName}
          customStatus={subject.customStatus}
        />
        {serverBot && (
          <div className="mt-3 space-y-2 text-left">
            <p className="text-xs text-warning">{t("bots.profile.beta")}</p>
            <div className="rounded-[var(--radius-card)] border border-border bg-surface-card p-2.5">
              <p className="text-xs font-semibold text-text">
                {t("bots.profile.seesTitle", { name: subject.displayName })}
              </p>
              <p className="mt-0.5 text-xs text-text-secondary">{t("bots.profile.seesBody")}</p>
            </div>
            {subject.username && (
              <p className="text-xs text-text-tertiary">
                {t("bots.profile.callWith", { handle: `@${subject.username}` })}
              </p>
            )}
          </div>
        )}
        {publicHref && subject.handle && (
          <a
            href={publicHref}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 block truncate text-center font-mono text-xs text-signal hover:underline"
            data-profile-public-url=""
          >
            {t("profile.publicUrl", { handle: subject.handle })}
          </a>
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
                {displayRoleName(role, t, roles ?? [])}
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
            {lastConversationLine}
            {cargosSection}
            {manageSection}
          </>
        ) : loading ? (
          <div className="mt-4 flex h-9 items-center justify-center text-paper-muted">
            <Spinner className="h-4 w-4 animate-spin" />
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
            {serverBot ? (
              <div className="mt-4">
                <Button
                  size="sm"
                  className="h-9 w-full rounded-full"
                  disabled={!onMention || !mentionUsername}
                  data-profile-call-bot=""
                  onClick={() => {
                    if (mentionUsername) onMention?.(mentionUsername);
                    onClose();
                  }}
                >
                  {t("bots.profile.call", { name: subject.displayName })}
                </Button>
              </div>
            ) : (
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
                  <Spinner className="h-3.5 w-3.5 animate-spin" />
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
            )}
            {actionStrip}
            {lastConversationLine}
            {cargosSection}
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
              <Tabs
                label={t("profile.about.tabs")}
                variant="segmented"
                size="xs"
                className="mt-3"
                value={aboutActive}
                onValueChange={setAboutPick}
                items={aboutTabs.map((tab) => ({
                  id: tab,
                  label: t(ABOUT_LABEL[tab]),
                  data: { "data-profile-about": tab },
                }))}
              />
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
      )}
      <ConfirmDialog
        open={pendingConfirm === "remove"}
        title={t("profile.removeFriend")}
        description={t("profile.removeFriend.confirm", {
          name: subject.displayName,
        })}
        confirmLabel={t("profile.removeFriend")}
        onConfirm={() => {
          void run(() => remove(subject.id));
        }}
        onClose={() => setPendingConfirm(null)}
      />
      <ConfirmDialog
        open={pendingConfirm === "block"}
        title={t("profile.block")}
        description={t("profile.block.confirm", { name: subject.displayName })}
        confirmLabel={t("profile.block")}
        onConfirm={() => {
          onBlockUser(subject.id);
          // ConfirmDialog still calls onClose (pendingConfirm). Close the card
          // after that so we do not setState on an unmounted tree.
          queueMicrotask(onClose);
        }}
        onClose={() => setPendingConfirm(null)}
      />
    </>
  );
}
