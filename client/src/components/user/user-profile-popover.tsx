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
import type { DmSummary } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/user/status-dot";
import { useFriends } from "@/components/friends/use-friends";
import { ApiError, createConversation } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  canBlock,
  canMessage,
  canRemoveFriend,
  canReport,
  friendsSince,
  needsConfirmation,
  placeCard,
  primaryAction,
  primaryIsInert,
  offersDecline,
  resolveFriendshipState,
  resolvePresence,
  type Placement,
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

// --------------------------------------------------------------------- card

interface UserProfileCardProps {
  subject: ProfileSubject;
  anchor: HTMLElement;
  currentUserId: string | null;
  blockedUserIds: ReadonlySet<string>;
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

  const state = resolveFriendshipState(
    subject.id,
    currentUserId,
    data,
    blockedUserIds,
  );
  const action = primaryAction(state);
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
      className="fixed z-[110] overflow-hidden rounded-xl border border-ink-4 bg-ink-2 shadow-[var(--shadow-popover)] animate-fade-in"
    >
      {/* No banner image exists on the server, so the band is a flat tint of
          the same surface — enough to separate the identity block from the
          actions without inventing a field to store one. */}
      <div aria-hidden="true" className="h-14 bg-ink-3" />

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
                    className="absolute bottom-full right-0 z-10 mb-1 w-44 rounded-lg border border-ink-4 bg-ink-2 p-1 shadow-[var(--shadow-popover)]"
                  >
                    {overflowItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="menuitem"
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
