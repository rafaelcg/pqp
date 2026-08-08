import type {
  DmSummary,
  Friend,
  FriendRequestEntry,
  PublicUser,
  User,
} from "@pqp/shared";
import { Check, Menu, UserPlus, Users, X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { FirstRunCard } from "@/components/onboarding/first-run-card";
import {
  shouldShowFirstRun,
  shouldStampFirstRunComplete,
} from "@/lib/first-run";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/user/status-dot";
import { UserSearch } from "@/components/user/user-search";
import { ApiError, createConversation } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  onlineFriends,
  pendingActionCount,
  sortOnlineFirst,
  type FriendsTab,
} from "./friends-model";
import { useFriends } from "./use-friends";

/**
 * The Friends view: what the app shows when you are "home" — no server, no
 * conversation. Online first, because "who can I talk to right now" is the
 * question a chat app's front door should answer; All and Pending behind tabs.
 *
 * Adding a friend reuses `UserSearch`, which means friends adds NO new
 * discovery surface: the same exact-handle lookup and budgeted prefix search
 * the DM picker uses, nothing wider. Pending rows deliberately show no status
 * dot — until you accept, the other person is a stranger, and the server does
 * not even send a status for them.
 */

/**
 * Everything the first-run checklist needs that this view does not already own.
 *
 * It lives here rather than in `App` because two of the three things it offers
 * are already this component's business — the friend count it ticks off is the
 * list this view is holding, and "add a friend" is this view's own search panel.
 * `App` would have to duplicate the fetch to know the first and lift state to
 * reach the second.
 */
export interface FriendsFirstRun {
  user: User;
  serverCount: number;
  onCreateServer: () => void;
  onJoinServer: () => void;
  onPickAvatar: () => void;
  /**
   * The checklist is answered — put away by hand, or finished. One preference
   * write, and it never comes back on any device.
   */
  onSettled: () => void;
}

interface FriendsViewProps {
  /** Kept out of add-friend results — you cannot befriend yourself. */
  currentUserId: string | null;
  /** "Message" opened (or reused) a conversation; the app takes it from here. */
  onOpenConversation: (conversation: DmSummary) => void;
  /** Mobile-only hamburger, same affordance the empty state had. */
  onOpenNav?: () => void;
  /** Extra content for the quiet state — the SSO server suggestions ride here. */
  extras?: ReactNode;
  /** Absent for an account past its first run, which is nearly all of them. */
  firstRun?: FriendsFirstRun;
}

export function FriendsView({
  currentUserId,
  onOpenConversation,
  onOpenNav,
  extras,
  firstRun,
}: FriendsViewProps) {
  const { t } = useTranslation();
  const { data, loading, error, send, accept, remove, nudge, clearNudge } =
    useFriends();
  const [tab, setTab] = useState<FriendsTab>("online");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * An unfriend held until it is confirmed.
   *
   * WHY THIS WAS THE BUG WORTH FIXING HERE. The row's remove control is an
   * unlabelled ✕ at the end of a hover-highlighted line, and it used to fire
   * straight through. Unfriending is silent — the other person is never told —
   * so a mis-click is invisible to them *and* uncorrectable by them: they simply
   * stop being in your list, and neither of you knows why. The profile card and
   * iOS both already confirmed it; this surface, the one with the smallest and
   * least-labelled trigger, was the one that did not.
   *
   * Declining a request stays unconfirmed on purpose. It is also silent, but
   * nothing is lost — they can ask again — and the whole argument for silent
   * declines is that declining must stay cheap.
   */
  const [confirmingRemoval, setConfirmingRemoval] = useState<Friend | null>(
    null,
  );
  const panelId = useId();

  // What the live nudge says, shown once. This is the visible half of the
  // `friend-activity` frame for somebody who already has this view open: the
  // list re-reads itself either way, but a row quietly appearing is easy to
  // miss, and "someone sent you a friend request" is not.
  useEffect(() => {
    if (!nudge) {
      return;
    }
    setNotice(
      t(
        nudge.kind === "accepted"
          ? "friends.nudge.accepted"
          : "friends.nudge.request",
      ),
    );
    clearNudge();
  }, [nudge, clearNudge, t]);

  const online = onlineFriends(data.friends);
  const pending = pendingActionCount(data);

  /**
   * The checklist's inputs, and the two questions asked of them.
   *
   * Gated on `!loading` because the friend list starts empty: asking before the
   * first snapshot lands would draw "find your people" un-ticked at somebody who
   * has friends, and then tick it a moment later under their eyes.
   */
  const firstRunInputs = firstRun
    ? {
        user: firstRun.user,
        serverCount: firstRun.serverCount,
        friendCount: data.friends.length,
      }
    : null;
  const showFirstRun =
    firstRunInputs !== null && !loading && shouldShowFirstRun(firstRunInputs);
  const stampFirstRun =
    firstRunInputs !== null &&
    !loading &&
    shouldStampFirstRunComplete(firstRunInputs);

  // Close the derived-state loop: once all three read as done, record it so that
  // undoing one of them a year from now cannot bring the card back. The effect
  // rather than the render because it writes, and `onSettled` is idempotent on
  // the App side — `shouldStampFirstRunComplete` goes false as soon as the
  // preference lands, so this cannot loop.
  useEffect(() => {
    if (stampFirstRun) {
      firstRun?.onSettled();
    }
  }, [stampFirstRun, firstRun]);

  async function run(userId: string, action: () => Promise<void>) {
    setBusyId(userId);
    setActionError(null);
    // Whatever the last line said is about to be out of date. It matters most
    // for the live nudge: "someone sent you a friend request" left standing
    // after you accepted it is a sentence about a request that no longer exists.
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : t("friends.requestFailed"),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleAdd(person: PublicUser) {
    setNotice(null);
    setActionError(null);
    try {
      const state = await send(person);
      setNotice(
        t(
          state === "accepted"
            ? "friends.requestAccepted"
            : "friends.requestSent",
          { name: person.displayName },
        ),
      );
    } catch (err) {
      // The server's refusal is deliberately vague (never "they blocked you");
      // relay it when it is an API answer, fall back to ours when it is not.
      setActionError(
        err instanceof ApiError ? err.message : t("friends.requestFailed"),
      );
    }
  }

  async function handleMessage(friendId: string) {
    await run(friendId, async () => {
      const { conversation } = await createConversation([friendId]);
      onOpenConversation(conversation);
    });
  }

  const tabs: { id: FriendsTab; label: string; badge?: number }[] = [
    { id: "online", label: t("friends.tab.online") },
    { id: "all", label: t("friends.tab.all") },
    { id: "pending", label: t("friends.tab.pending"), badge: pending },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-4/60 px-4">
        {onOpenNav && (
          <button
            type="button"
            className="rounded-md p-1.5 hover:bg-ink-3 md:hidden"
            aria-label={t("empty.openNav")}
            onClick={onOpenNav}
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <Users aria-hidden="true" className="h-5 w-5 shrink-0 text-paper-muted" />
        <h1 className="font-display text-base font-bold">
          {t("friends.title")}
        </h1>

        <div
          role="tablist"
          aria-label={t("friends.title")}
          className="ml-2 flex items-center gap-1"
        >
          {tabs.map((one) => (
            <button
              key={one.id}
              type="button"
              role="tab"
              aria-selected={tab === one.id}
              aria-controls={panelId}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm",
                tab === one.id
                  ? "bg-ink-3 text-paper"
                  : "text-paper-muted hover:bg-ink-3/70 hover:text-paper",
              )}
              onClick={() => setTab(one.id)}
            >
              {one.label}
              {(one.badge ?? 0) > 0 && (
                <span
                  className="min-w-4 rounded-full bg-danger px-1 py-0.5 text-center text-[10px] font-bold leading-none text-paper"
                  aria-label={t("friends.pendingBadge", { count: one.badge! })}
                >
                  {one.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        <Button
          size="sm"
          className="ml-auto"
          aria-expanded={adding}
          onClick={() => {
            setAdding((open) => !open);
            setNotice(null);
            setActionError(null);
          }}
        >
          <UserPlus aria-hidden="true" className="h-4 w-4" />
          {t("friends.addFriend")}
        </Button>
      </header>

      {adding && (
        <div className="border-b border-ink-4/60 bg-ink-2/50 px-4 py-3">
          <div className="max-w-md">
            <UserSearch
              label={t("friends.addFriend.label")}
              autoFocus
              excludeIds={[
                ...(currentUserId ? [currentUserId] : []),
                // People you already relate to are not candidates — offering
                // an existing friend re-adds nothing and reads as a bug.
                ...data.friends.map((one) => one.id),
                ...data.outgoing.map((one) => one.id),
              ]}
              onSelect={(person) => void handleAdd(person)}
            />
            <p className="mt-1.5 text-xs text-paper-muted">
              {t("friends.addFriend.hint")}
            </p>
          </div>
        </div>
      )}

      {(notice || actionError || error) && (
        <div className="px-4 pt-3">
          {notice && <p className="text-sm text-success">{notice}</p>}
          {(actionError ?? error) && (
            <p role="alert" className="text-sm text-danger">
              {actionError ?? error}
            </p>
          )}
        </div>
      )}

      <div
        id={panelId}
        role="tabpanel"
        className="flex-1 overflow-y-auto p-4"
      >
        {/* Above the tab content, because it is the reason this screen is not
            empty. It stays put while they switch tabs — the three errands do not
            belong to Online or to Pending. */}
        {showFirstRun && firstRun && (
          <FirstRunCard
            user={firstRun.user}
            serverCount={firstRun.serverCount}
            friendCount={data.friends.length}
            onCreateServer={firstRun.onCreateServer}
            onJoinServer={firstRun.onJoinServer}
            onAddFriend={() => setAdding(true)}
            onPickAvatar={firstRun.onPickAvatar}
            onDismiss={firstRun.onSettled}
          />
        )}

        {loading ? (
          <FriendsSkeleton />
        ) : tab === "pending" ? (
          <PendingLists
            incoming={data.incoming}
            outgoing={data.outgoing}
            busyId={busyId}
            onAccept={(id) => void run(id, () => accept(id))}
            onRemove={(id) => void run(id, () => remove(id))}
          />
        ) : (
          <>
            {tab === "online" && online.length > 0 && (
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted">
                {t("friends.onlineCount", { count: online.length })}
              </h2>
            )}
            {confirmingRemoval && (
              <div
                role="alertdialog"
                aria-label={t("friends.remove.confirm.title", {
                  name: confirmingRemoval.displayName,
                })}
                data-remove-confirm=""
                className="mb-3 max-w-2xl rounded-md border border-ink-4 bg-ink-3/60 p-3"
              >
                <p className="text-sm font-semibold text-paper">
                  {t("friends.remove.confirm.title", {
                    name: confirmingRemoval.displayName,
                  })}
                </p>
                {/* States the surprising part rather than asking "are you
                    sure?": what makes this worth confirming is that it is
                    silent and that it is undoable only by asking again. */}
                <p className="mt-1 text-xs text-paper-muted">
                  {t("friends.remove.confirm.body")}
                </p>
                <div className="mt-2.5 flex gap-1.5">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      const person = confirmingRemoval;
                      setConfirmingRemoval(null);
                      void run(person.id, () => remove(person.id));
                    }}
                  >
                    {t("friends.remove")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmingRemoval(null)}
                  >
                    {t("friends.remove.keep")}
                  </Button>
                </div>
              </div>
            )}
            <FriendRows
              friends={tab === "online" ? online : sortOnlineFirst(data.friends)}
              emptyState={
                tab === "online" ? (
                  data.friends.length === 0 ? (
                    <NoFriendsYet onAdd={() => setAdding(true)} />
                  ) : (
                    <p className="text-sm text-paper-muted">
                      {t("friends.empty.online")}
                    </p>
                  )
                ) : (
                  <NoFriendsYet onAdd={() => setAdding(true)} />
                )
              }
              busyId={busyId}
              onMessage={(id) => void handleMessage(id)}
              onRemove={setConfirmingRemoval}
            />
          </>
        )}

        {extras && <div className="mt-6 max-w-md">{extras}</div>}
      </div>
    </div>
  );

  function NoFriendsYet({ onAdd }: { onAdd: () => void }) {
    // The checklist above is already asking for exactly this, with its own
    // button. Two "Add friend" buttons a screen apart is not twice the
    // encouragement, it is a layout that looks unfinished — so while the card is
    // up this shrinks to the one line the card does not say.
    if (showFirstRun) {
      return (
        <p className="text-sm text-paper-muted">{t("friends.empty.all.body")}</p>
      );
    }
    return (
      <div className="max-w-sm">
        <p className="font-display text-xl font-bold">
          {t("friends.empty.all.title")}
        </p>
        <p className="mt-2 text-sm text-paper-muted">
          {t("friends.empty.all.body")}
        </p>
        <Button size="sm" className="mt-4" onClick={onAdd}>
          <UserPlus aria-hidden="true" className="h-4 w-4" />
          {t("friends.addFriend")}
        </Button>
      </div>
    );
  }
}

function FriendRows({
  friends,
  emptyState,
  busyId,
  onMessage,
  onRemove,
}: {
  friends: Friend[];
  emptyState: ReactNode;
  busyId: string | null;
  onMessage: (userId: string) => void;
  /** The whole person, not an id: the confirmation has to name them. */
  onRemove: (friend: Friend) => void;
}) {
  const { t } = useTranslation();
  if (friends.length === 0) {
    return <>{emptyState}</>;
  }
  return (
    <ul className="max-w-2xl">
      {friends.map((friend) => (
        <li
          key={friend.id}
          className="group mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3"
        >
          <FriendFace person={friend} status={friend.status} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {friend.displayName}
            </p>
            {friend.tag && (
              <p className="truncate font-mono text-[11px] text-paper-muted">
                {friend.tag}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="secondary"
              disabled={busyId === friend.id}
              onClick={() => onMessage(friend.id)}
            >
              {t("friends.message")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busyId === friend.id}
              aria-label={`${t("friends.remove")} — ${friend.displayName}`}
              title={t("friends.remove")}
              data-remove-friend={friend.id}
              onClick={() => onRemove(friend)}
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function PendingLists({
  incoming,
  outgoing,
  busyId,
  onAccept,
  onRemove,
}: {
  incoming: FriendRequestEntry[];
  outgoing: FriendRequestEntry[];
  busyId: string | null;
  onAccept: (userId: string) => void;
  onRemove: (userId: string) => void;
}) {
  const { t } = useTranslation();
  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <p className="text-sm text-paper-muted">{t("friends.empty.pending")}</p>
    );
  }
  return (
    <div className="max-w-2xl space-y-6">
      {incoming.length > 0 && (
        <section aria-label={t("friends.incoming")}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted">
            {t("friends.incoming")}
          </h2>
          <ul>
            {incoming.map((person) => (
              <RequestRow key={person.id} person={person} busy={busyId === person.id}>
                <Button
                  size="sm"
                  disabled={busyId === person.id}
                  onClick={() => onAccept(person.id)}
                >
                  <Check aria-hidden="true" className="h-4 w-4" />
                  {t("friends.accept")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === person.id}
                  onClick={() => onRemove(person.id)}
                >
                  {t("friends.decline")}
                </Button>
              </RequestRow>
            ))}
          </ul>
        </section>
      )}
      {outgoing.length > 0 && (
        <section aria-label={t("friends.outgoing")}>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted">
            {t("friends.outgoing")}
          </h2>
          <ul>
            {outgoing.map((person) => (
              <RequestRow key={person.id} person={person} busy={busyId === person.id}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === person.id}
                  onClick={() => onRemove(person.id)}
                >
                  {t("friends.cancelRequest")}
                </Button>
              </RequestRow>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function RequestRow({
  person,
  busy,
  children,
}: {
  person: FriendRequestEntry;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3",
        busy && "opacity-60",
      )}
    >
      {/* No status pip on purpose: a request is from/to a stranger, and the
          server does not send one — see friendRequestEntrySchema. */}
      <FriendFace person={person} status={null} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{person.displayName}</p>
        {person.tag && (
          <p className="truncate font-mono text-[11px] text-paper-muted">
            {person.tag}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </li>
  );
}

/** Avatar with the pip on its corner — the members panel's arrangement. */
function FriendFace({
  person,
  status,
}: {
  person: PublicUser;
  status: Friend["status"] | null;
}) {
  return (
    <div className="relative shrink-0">
      <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-md bg-ink-3 text-sm font-semibold">
        {person.avatarUrl ? (
          <img
            src={person.avatarUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          person.displayName.slice(0, 1).toUpperCase()
        )}
      </div>
      {status && (
        <StatusDot
          status={status}
          className="absolute -bottom-0.5 -right-0.5"
          ringClassName="rounded-full bg-ink ring-2 ring-ink"
        />
      )}
    </div>
  );
}

function FriendsSkeleton() {
  return (
    <div className="max-w-2xl" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="mb-1 flex items-center gap-3 px-2 py-2">
          <div className="h-9 w-9 animate-pulse rounded-md bg-ink-3/70" />
          <div className="flex-1">
            <div className="h-3.5 w-32 animate-pulse rounded bg-ink-3/70" />
            <div className="mt-1.5 h-2.5 w-20 animate-pulse rounded bg-ink-3/50" />
          </div>
        </div>
      ))}
    </div>
  );
}
