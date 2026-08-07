import type {
  DmSummary,
  Friend,
  FriendRequestEntry,
  PublicUser,
} from "@pqp/shared";
import { Check, Menu, UserPlus, Users, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
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

interface FriendsViewProps {
  /** Kept out of add-friend results — you cannot befriend yourself. */
  currentUserId: string | null;
  /** "Message" opened (or reused) a conversation; the app takes it from here. */
  onOpenConversation: (conversation: DmSummary) => void;
  /** Mobile-only hamburger, same affordance the empty state had. */
  onOpenNav?: () => void;
  /** Extra content for the quiet state — the SSO server suggestions ride here. */
  extras?: ReactNode;
}

export function FriendsView({
  currentUserId,
  onOpenConversation,
  onOpenNav,
  extras,
}: FriendsViewProps) {
  const { t } = useTranslation();
  const { data, loading, error, send, accept, remove } = useFriends();
  const [tab, setTab] = useState<FriendsTab>("online");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const panelId = useId();

  const online = onlineFriends(data.friends);
  const pending = pendingActionCount(data);

  async function run(userId: string, action: () => Promise<void>) {
    setBusyId(userId);
    setActionError(null);
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
              onRemove={(id) => void run(id, () => remove(id))}
            />
          </>
        )}

        {extras && <div className="mt-6 max-w-md">{extras}</div>}
      </div>
    </div>
  );

  function NoFriendsYet({ onAdd }: { onAdd: () => void }) {
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
  onRemove: (userId: string) => void;
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
              onClick={() => onRemove(friend.id)}
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
