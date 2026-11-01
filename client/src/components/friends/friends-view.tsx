import { Breu } from "@/components/breu/breu";
import {
  PANE_HEADER_NAV_REDESIGN,
  PANE_HEADER_RULE_REDESIGN,
  PANE_HEADER_TITLE_REDESIGN,
} from "@/components/ui/pane-header";
import { Icon } from "@/components/ui/icon";
import { SECTION_LABEL_REDESIGN } from "@/components/ui/section-header";
import {
  Check as CheckGlyph,
  List as ListBold,
  UserPlus as UserPlusGlyph,
  Users as UsersFill,
  X as XGlyph,
} from "@phosphor-icons/react";

import { cn } from "@/lib/utils";
import type {
  Depoimento,
  DmSummary,
  Friend,
  FriendRequestEntry,
  PublicUser,
  User,
} from "@pqp/shared";
import { Check, Menu, UserPlus, Users, X } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { PendingDepoimentos } from "@/components/depoimentos/pending-depoimentos";
import { FirstRunCard } from "@/components/onboarding/first-run-card";
import {
  shouldShowFirstRun,
  shouldStampFirstRunComplete,
} from "@/lib/first-run";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { UserSearch } from "@/components/user/user-search";
import { ApiError, createConversation } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import {
  onlineFriends,
  pendingActionCount,
  sortOnlineFirst,
  type FriendsTab,
} from "./friends-model";
import { useFriends } from "./use-friends";
import { useRedesign } from "@/lib/redesign";

/*
 * Friends under the redesign (f-friends): a person is the list row's `lg`
 * pill (two lines), section labels are the section label, the confirm is a
 * card, the add panel sits on the pane under the header's rule.
 */
const FRIEND_ROW_REDESIGN =
  "redesign:mb-0.5 redesign:min-h-[var(--list-row-h-lg)] redesign:gap-[var(--list-row-gap)] redesign:rounded-[var(--list-row-radius)] redesign:py-1.5 redesign:pl-2 redesign:pr-2 redesign:hover:bg-[color:var(--list-row-hover)]";
const FRIEND_NAME_REDESIGN = "redesign:font-semibold redesign:text-text";
const FRIEND_TAG_REDESIGN =
  "redesign:font-sans redesign:text-xs redesign:text-[color:var(--list-row-detail)]";
const FRIEND_SECTION_REDESIGN = cn(SECTION_LABEL_REDESIGN, "redesign:px-2");

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
  onImportDiscord?: () => void;
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
  /**
   * Conversas (`conversations_home`): drawn at the top of the panel, under the
   * first-run card, while the account has no conversation at all. Handed the
   * view's own "add a friend" so its button opens the same field the header's
   * does.
   */
  hero?: (actions: { openAdd: () => void }) => ReactNode;
  /** Absent for an account past its first run, which is nearly all of them. */
  firstRun?: FriendsFirstRun;
}

export function FriendsView({
  currentUserId,
  onOpenConversation,
  onOpenNav,
  extras,
  hero,
  firstRun,
}: FriendsViewProps) {
  const { t } = useTranslation();
  const redesign = useRedesign();
  const {
    data,
    pendingDepoimentos,
    loading,
    error,
    send,
    accept,
    remove,
    approveDepoimento,
    removeDepoimento,
    nudge,
    clearNudge,
  } = useFriends();
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
          : nudge.kind === "depoimento"
            ? // Deliberately vague about direction. The frame is content-free
              // and fires for both halves — somebody wrote you one, or somebody
              // published yours — and the two lists it refreshed already say
              // which. Naming a direction here would make the frame carry a
              // fact it does not have.
              "depoimentos.nudge"
            : "friends.nudge.request",
      ),
    );
    clearNudge();
  }, [nudge, clearNudge, t]);

  const online = onlineFriends(data.friends);
  const pending = pendingActionCount(data, pendingDepoimentos);

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

  const tabs: { id: FriendsTab; label: string }[] = [
    { id: "online", label: t("friends.tab.online") },
    { id: "all", label: t("friends.tab.all") },
    {
      id: "pending",
      // A plain-text count, not a red pill: you are already looking at this
      // tab, so a danger-coloured alarm about something already on screen is
      // exactly what principle 3 forbids.
      label:
        pending > 0
          ? t("friends.tab.pendingCount", { count: pending })
          : t("friends.tab.pending"),
    },
  ];

  // One remove confirm, drawn in one of two places: above the section label
  // under the redesign, after it with the toggle off, where it always was.
  const removeConfirm = confirmingRemoval ? (
    <div
      role="alertdialog"
      aria-label={t("friends.remove.confirm.title", {
        name: confirmingRemoval.displayName,
      })}
      data-remove-confirm=""
      className="mb-3 max-w-2xl redesign:max-w-none rounded-md border border-ink-4 bg-ink-3/60 p-3 redesign:rounded-[var(--radius-card)] redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] redesign:mb-4 redesign:p-4"
    >
      <p className="text-sm font-semibold text-paper redesign:text-text">
        {t("friends.remove.confirm.title", {
          name: confirmingRemoval.displayName,
        })}
      </p>
      {/* States the surprising part rather than asking "are you
          sure?": what makes this worth confirming is that it is
          silent and that it is undoable only by asking again. */}
      <p className="mt-1 text-xs text-paper-muted redesign:text-[0.8125rem] redesign:text-text-secondary">
        {t("friends.remove.confirm.body")}
      </p>
      <div className="mt-2.5 flex gap-1.5 redesign:mt-3 redesign:gap-2">
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
  ) : null;

  return (
    // `@container`: the header breaks on its OWN width, not the window's. One
    // row needs about 580px; at 390px the column is 318px, and at 768px the
    // sidebar leaves it 440px even though the viewport is `md`. Below `@2xl`
    // the tabs drop to a second row that scrolls sideways instead of clipping,
    // so "Pendentes (3)" and "Adicionar amigo" stay on the screen.
    <div className="@container flex min-h-0 flex-1 flex-col">
      <header className={cn("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-4/60 px-4 py-2 @2xl:h-14 @2xl:flex-nowrap @2xl:py-0", PANE_HEADER_RULE_REDESIGN)}>
        {onOpenNav && (
          <button
            type="button"
            className={cn("rounded-md p-1.5 hover:bg-ink-3 md:hidden", PANE_HEADER_NAV_REDESIGN, "redesign:md:hidden")}
            aria-label={t("empty.openNav")}
            onClick={onOpenNav}
          >
            <Menu className="h-5 w-5 redesign:hidden" />
            <Icon icon={ListBold} kind="symbol" size="sm" className="hidden redesign:block" />
          </button>
        )}
        <Users
          aria-hidden="true"
          className="hidden h-5 w-5 shrink-0 text-paper-muted @sm:block redesign:!hidden"
        />
        <Icon icon={UsersFill} size="md" className="hidden shrink-0 text-text-tertiary redesign:@sm:block" />
        <h1 className={cn("min-w-0 truncate font-display text-base font-bold", PANE_HEADER_TITLE_REDESIGN)}>
          {t("friends.title")}
        </h1>

        <Tabs
          label={t("friends.title")}
          variant="pill"
          value={tab}
          onValueChange={setTab}
          items={tabs}
          panelId={panelId}
          className="order-last -mx-1 w-full overflow-x-auto px-1 py-0.5 [scrollbar-width:thin] @2xl:order-none @2xl:mx-0 @2xl:ml-2 @2xl:w-auto @2xl:overflow-visible @2xl:p-0"
          tabClassName="@2xl:py-1"
        />

        <Button
          size="sm"
          className={cn(
            "ml-auto shrink-0",
            // Open, the button steps down to secondary under the redesign so
            // it is not a second lime shape beside the field's lime ring.
            adding &&
              "redesign:bg-[color:var(--button-secondary-bg)] redesign:text-text redesign:hover:bg-[color:var(--button-secondary-hover)]",
          )}
          aria-expanded={adding}
          onClick={() => {
            setAdding((open) => !open);
            setNotice(null);
            setActionError(null);
          }}
        >
          <UserPlus aria-hidden="true" className="h-4 w-4 redesign:hidden" />
          <Icon icon={UserPlusGlyph} size="sm" className="hidden redesign:block" />
          {t("friends.addFriend")}
        </Button>
      </header>

      {adding && (
        <div className="border-b border-ink-4/60 bg-ink-2/50 px-4 py-3 redesign:border-[color:var(--pane-header-rule)] redesign:bg-transparent redesign:px-4 redesign:py-4">
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
            <p className="mt-1.5 text-xs text-paper-muted redesign:mt-2 redesign:px-3.5 redesign:text-[0.8125rem] redesign:text-text-secondary">
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
        className="flex-1 overflow-y-auto p-4 redesign:px-2"
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
            onImportDiscord={firstRun.onImportDiscord}
            onAddFriend={() => setAdding(true)}
            onPickAvatar={firstRun.onPickAvatar}
            onDismiss={firstRun.onSettled}
          />
        )}

        {hero?.({ openAdd: () => setAdding(true) })}

        {loading ? (
          <FriendsSkeleton />
        ) : tab === "pending" ? (
          <PendingLists
            incoming={data.incoming}
            outgoing={data.outgoing}
            depoimentos={pendingDepoimentos}
            busyId={busyId}
            onAccept={(id) => void run(id, () => accept(id))}
            onRemove={(id) => void run(id, () => remove(id))}
            onApproveDepoimento={(id) =>
              void run(id, async () => {
                await approveDepoimento(id);
                setNotice(t("depoimentos.published"));
              })
            }
            onRejectDepoimento={(id) => void run(id, () => removeDepoimento(id))}
          />
        ) : (
          <>
            {/* Under the redesign the confirm sits above the section's label,
                so it never splits the label from its rows. With the toggle off it
                stays after the label, where it always was. */}
            {redesign && removeConfirm}
            {tab === "online" && online.length > 0 && (
              <h2 className={cn("mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted", FRIEND_SECTION_REDESIGN)}>
                {redesign
                  ? t("memberList.sectionHeading", { label: t("friends.onlineLabel"), count: online.length })
                  : t("friends.onlineCount", { count: online.length })}
              </h2>
            )}
            {!redesign && removeConfirm}
            <FriendRows
              friends={tab === "online" ? online : sortOnlineFirst(data.friends)}
              emptyState={
                tab === "online" ? (
                  data.friends.length === 0 ? (
                    <NoFriendsYet onAdd={() => setAdding(true)} />
                  ) : (
                    <p className="text-sm text-paper-muted redesign:px-2 redesign:text-text-secondary">
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

        {extras && <div className="mt-6 max-w-md redesign:px-2">{extras}</div>}
      </div>
    </div>
  );

  function NoFriendsYet({ onAdd }: { onAdd: () => void }) {
    // The checklist above is already asking for exactly this, with its own
    // button. Two "Add friend" buttons a screen apart is not twice the
    // encouragement, it is a layout that looks unfinished. And the one line
    // that was left said the card's own sentence again in different words ("@"
    // there, "identificador" here), so while the card is up this says nothing.
    // The Conversas hero above already offers Adicionar amigo, for the same
    // reason.
    if (showFirstRun || hero) {
      return null;
    }
    return (
      <div className="max-w-sm redesign:px-2">
        <Breu mood="hello" size="sm" className="mb-3" />
        <p className="font-display text-xl font-bold redesign:text-text">
          {t("friends.empty.all.title")}
        </p>
        <p className="mt-2 text-sm text-paper-muted redesign:text-text-secondary">
          {t("friends.empty.all.body")}
        </p>
        <Button size="sm" className="mt-4" onClick={onAdd}>
          <UserPlus aria-hidden="true" className="h-4 w-4 redesign:hidden" />
          <Icon icon={UserPlusGlyph} size="sm" className="hidden redesign:block" />
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
    <ul className="max-w-2xl redesign:max-w-none">
      {friends.map((friend) => (
        <li
          key={friend.id}
          className={cn("group mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3", FRIEND_ROW_REDESIGN)}
        >
          <FriendFace person={friend} status={friend.status} />
          <div className="min-w-0 flex-1">
            <p className={cn("truncate text-sm font-semibold", FRIEND_NAME_REDESIGN)}>
              {friend.displayName}
            </p>
            {friend.tag && (
              <p className={cn("truncate font-mono text-[11px] text-paper-muted", FRIEND_TAG_REDESIGN)}>
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
              className="redesign:w-[var(--control-sm)] redesign:px-0"
            >
              <X aria-hidden="true" className="h-4 w-4 redesign:hidden" />
              <Icon icon={XGlyph} kind="symbol" size="sm" className="hidden redesign:block" />
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
  depoimentos,
  busyId,
  onAccept,
  onRemove,
  onApproveDepoimento,
  onRejectDepoimento,
}: {
  incoming: FriendRequestEntry[];
  outgoing: FriendRequestEntry[];
  depoimentos: Depoimento[];
  busyId: string | null;
  onAccept: (userId: string) => void;
  onRemove: (userId: string) => void;
  onApproveDepoimento: (id: string) => void;
  onRejectDepoimento: (id: string) => void;
}) {
  const redesign = useRedesign();
  const { t } = useTranslation();
  if (
    incoming.length === 0 &&
    outgoing.length === 0 &&
    depoimentos.length === 0
  ) {
    return (
      <p className="text-sm text-paper-muted redesign:px-2 redesign:text-text-secondary">{t("friends.empty.pending")}</p>
    );
  }
  return (
    <div className="max-w-2xl space-y-6 redesign:max-w-none">
      {/* First, and above the friend requests, because it is the one errand
          here with a warm payload — somebody wrote something about you and is
          waiting to see whether you will show it. */}
      <PendingDepoimentos
        depoimentos={depoimentos}
        busyId={busyId}
        onApprove={onApproveDepoimento}
        onReject={onRejectDepoimento}
      />
      {incoming.length > 0 && (
        <section aria-label={t("friends.incoming")}>
          <h2 className={cn("mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted", FRIEND_SECTION_REDESIGN)}>
            {redesign
              ? t("memberList.sectionHeading", { label: t("friends.incomingLabel"), count: incoming.length })
              : t("friends.incoming")}
          </h2>
          <ul>
            {incoming.map((person) => (
              <RequestRow key={person.id} person={person} busy={busyId === person.id}>
                <Button
                  size="sm"
                  disabled={busyId === person.id}
                  onClick={() => onAccept(person.id)}
                >
                  <Check aria-hidden="true" className="h-4 w-4 redesign:hidden" />
                  <Icon icon={CheckGlyph} kind="symbol" size="sm" className="hidden redesign:block" />
                  {t("friends.accept")}
                </Button>
                <Button
                  size="sm"
                  variant={redesign ? "secondary" : "ghost"}
                  disabled={busyId === person.id}
                  onClick={() => onRemove(person.id)}
                >
                  <Icon icon={XGlyph} kind="symbol" size="sm" className="hidden redesign:block" />
                  {t("friends.decline")}
                </Button>
              </RequestRow>
            ))}
          </ul>
        </section>
      )}
      {outgoing.length > 0 && (
        <section aria-label={t("friends.outgoing")}>
          <h2 className={cn("mb-2 text-xs font-semibold uppercase tracking-wider text-paper-muted", FRIEND_SECTION_REDESIGN)}>
            {redesign
              ? t("memberList.sectionHeading", { label: t("friends.outgoingLabel"), count: outgoing.length })
              : t("friends.outgoing")}
          </h2>
          <ul>
            {outgoing.map((person) => (
              <RequestRow key={person.id} person={person} busy={busyId === person.id}>
                <Button
                  size="sm"
                  variant={redesign ? "secondary" : "ghost"}
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
        FRIEND_ROW_REDESIGN,
        // On a phone the actions take their own line, so the name stays readable.
        "redesign:max-sm:flex-wrap",
      )}
    >
      {/* No status pip on purpose: a request is from/to a stranger, and the
          server does not send one — see friendRequestEntrySchema. */}
      <FriendFace person={person} status={null} />
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-sm font-semibold", FRIEND_NAME_REDESIGN)}>{person.displayName}</p>
        {person.tag && (
          <p className={cn("truncate font-mono text-[11px] text-paper-muted", FRIEND_TAG_REDESIGN)}>
            {person.tag}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 redesign:max-sm:basis-full redesign:max-sm:pl-[3.25rem]">{children}</div>
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
      {/* `UserAvatar`, for the reason the profile card now uses it: an
          uploaded avatar's URL is root-relative and only `resolveAvatarUrl`
          turns it into one the SPA's origin can fetch. */}
      <UserAvatar
        name={person.displayName}
        avatarUrl={person.avatarUrl}
        rounded="md"
        className="h-9 w-9 redesign:h-10 redesign:w-10"
        fallbackClassName="bg-ink-3 text-sm text-paper"
      />
      {status && (
        <StatusDot
          status={status}
          className="absolute -bottom-0.5 -right-0.5 redesign:bottom-0 redesign:right-0"
          ringClassName="rounded-full bg-ink ring-2 ring-ink redesign:bg-[color:var(--avatar-dot-ring)] redesign:ring-[color:var(--avatar-dot-ring)]"
        />
      )}
    </div>
  );
}

function FriendsSkeleton() {
  return (
    <div className="max-w-2xl redesign:max-w-none" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="mb-1 flex items-center gap-3 px-2 py-2 redesign:min-h-[var(--list-row-h-lg)] redesign:gap-[var(--list-row-gap)]">
          <div className="h-9 w-9 animate-pulse rounded-md bg-ink-3/70 redesign:h-10 redesign:w-10 redesign:rounded-full redesign:bg-[color:var(--skeleton-bg)]" />
          <div className="flex-1">
            <div className="h-3.5 w-32 animate-pulse rounded bg-ink-3/70 redesign:rounded-full redesign:bg-[color:var(--skeleton-bg)]" />
            <div className="mt-1.5 h-2.5 w-20 animate-pulse rounded bg-ink-3/50 redesign:rounded-full redesign:bg-[color:var(--skeleton-bg)]" />
          </div>
        </div>
      ))}
    </div>
  );
}
