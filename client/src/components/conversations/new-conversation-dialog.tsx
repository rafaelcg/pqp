import {
  DM_MAX_RECIPIENTS,
  type DmSummary,
  type PublicUser,
  type UserStatus,
} from "@pqp/shared";
import { X } from "lucide-react";
import { X as XBold } from "@phosphor-icons/react";
import { IconSwap } from "@/components/ui/icon";
import { SECTION_LABEL_REDESIGN } from "@/components/ui/section-header";
import { DIALOG_CUT_REDESIGN, PICKED_CHIP_REDESIGN } from "@/components/conversations/picker-redesign";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FriendsContext } from "@/components/friends/use-friends";
import { Button } from "@/components/ui/button";
import { TickBox } from "@/components/ui/check-row";
import { Dialog } from "@/components/ui/dialog";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { UserSearch } from "@/components/user/user-search";
import { readUserQuery } from "@/lib/user-search";
import { ApiError, createConversation } from "@/lib/api";
import { foldForSearch } from "@/lib/conversation-list";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const NO_FRIENDS: readonly (PublicUser & { status: UserStatus })[] = [];
const NO_SECTIONS = { online: [], friends: [], recent: [] } as const satisfies Record<
  "online" | "friends" | "recent",
  readonly PickerPerson[]
>;

/** How many people from recent 1:1s, beyond friends, are offered without typing. */
const RECENT_PEOPLE = 5;

export interface PickerPerson extends PublicUser {
  status?: UserStatus | null;
}

/**
 * Who Nova conversa lists before anybody types: friends who are around
 * (Online agora), the other friends (Amigos), then people from recent 1:1s
 * who are not friends (Recentes). Pure, so the order is a test.
 */
export function pickerSections(
  friends: readonly (PublicUser & { status: UserStatus })[],
  conversations: readonly DmSummary[],
  options: { query: string; excludeIds: ReadonlySet<string> },
): { online: PickerPerson[]; friends: PickerPerson[]; recent: PickerPerson[] } {
  const needle = foldForSearch(options.query);
  const matches = (person: PublicUser) =>
    !needle ||
    foldForSearch(person.displayName).includes(needle) ||
    (person.tag ? foldForSearch(person.tag).includes(needle) : false);
  const byName = (a: PublicUser, b: PublicUser) =>
    a.displayName.localeCompare(b.displayName);
  const usable = friends.filter(
    (friend) => !options.excludeIds.has(friend.id) && matches(friend),
  );
  const friendIds = new Set(friends.map((friend) => friend.id));
  const online = usable.filter((friend) => friend.status !== "offline").sort(byName);
  const offline = usable.filter((friend) => friend.status === "offline").sort(byName);
  const recent: PickerPerson[] = [];
  const seen = new Set<string>();
  for (const conversation of conversations) {
    if (conversation.participants.length !== 1) {
      continue;
    }
    const person = conversation.participants[0]!;
    if (
      friendIds.has(person.id) ||
      seen.has(person.id) ||
      options.excludeIds.has(person.id) ||
      !matches(person)
    ) {
      continue;
    }
    seen.add(person.id);
    recent.push(person);
    if (recent.length >= RECENT_PEOPLE) {
      break;
    }
  }
  return { online, friends: offline, recent };
}

interface NewConversationDialogProps {
  open: boolean;
  currentUserId: string | null;
  /** Recency order, for the Recentes section. */
  conversations: readonly DmSummary[];
  onClose: () => void;
  onCreated: (conversation: DmSummary) => void;
  /**
   * The conversation exists, but the dialog was dismissed while it was being
   * made: keep it in the list, do not navigate.
   */
  onCreatedInBackground?: (conversation: DmSummary) => void;
}

/**
 * CONVERSAS: Nova conversa with the people already listed, so starting a
 * conversation with a friend is a click and no typing. Clicking a name with
 * nothing ticked opens that conversation; ticking builds a group (up to
 * `DM_MAX_RECIPIENTS`). The search still finds anybody by name or name#0000,
 * and narrows the lists as it goes.
 */
export function NewConversationDialog({
  open,
  currentUserId,
  conversations,
  onClose,
  onCreated,
  onCreatedInBackground,
}: NewConversationDialogProps) {
  const { t } = useTranslation();
  // The store directly, retaining the presence poll only while the dialog is
  // open: this dialog is always mounted, and `useFriends()` would keep the
  // 15 s poll running for the whole session behind a closed dialog.
  const store = useContext(FriendsContext);
  const retainLive = store?.retainLive;
  useEffect(() => (open && retainLive ? retainLive() : undefined), [open, retainLive]);
  const friendList = store?.data?.friends ?? NO_FRIENDS;
  /**
   * Bumped on every close: a create still in flight when the dialog was
   * dismissed (or dismissed and opened again) must not navigate, close the
   * reopened dialog, or clear its busy state.
   */
  const session = useRef(0);
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      session.current += 1;
      setPicked([]);
      setQuery("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const excludeIds = useMemo(
    () => new Set(currentUserId ? [currentUserId] : []),
    [currentUserId],
  );
  // Nothing to work out while the dialog is shut (it is always mounted).
  const sections = open
    ? pickerSections(friendList, conversations, { query, excludeIds })
    : NO_SECTIONS;
  const pickedIds = new Set(picked.map((person) => person.id));
  const full = picked.length >= DM_MAX_RECIPIENTS;
  const nobody =
    sections.online.length + sections.friends.length + sections.recent.length === 0;

  /** Dismissed: anything still in flight belongs to a session that is over. */
  function close() {
    session.current += 1;
    onClose();
  }

  async function openWith(people: readonly PublicUser[]) {
    if (people.length === 0 || busy) {
      return;
    }
    const mine = session.current;
    setBusy(true);
    setError(null);
    try {
      const { conversation } = await createConversation(people.map((person) => person.id));
      if (session.current !== mine) {
        onCreatedInBackground?.(conversation);
        return;
      }
      onCreated(conversation);
      onClose();
    } catch (err) {
      if (session.current !== mine) {
        return;
      }
      setError(
        err instanceof ApiError || err instanceof Error ? err.message : t("dm.dialog.failed"),
      );
    } finally {
      if (session.current === mine) {
        setBusy(false);
      }
    }
  }

  function toggle(person: PublicUser) {
    setPicked((current) =>
      current.some((one) => one.id === person.id)
        ? current.filter((one) => one.id !== person.id)
        : current.length >= DM_MAX_RECIPIENTS
          ? current
          : [...current, person],
    );
  }

  const row = (person: PickerPerson) => (
    <PersonRow
      key={person.id}
      person={person}
      checked={pickedIds.has(person.id)}
      tickDisabled={full && !pickedIds.has(person.id)}
      onOpen={() => {
        // With nothing ticked a name is a door; once a group is being built
        // a name is one more tick, so a stray click never opens the wrong room.
        if (picked.length === 0) {
          void openWith([person]);
        } else {
          toggle(person);
        }
      }}
      onToggle={() => toggle(person)}
    />
  );

  return (
    <Dialog
      open={open}
      eyebrow={t("conversations.new.eyebrow")}
      title={t("conversations.new")}
      description={t("conversations.new.description", { max: DM_MAX_RECIPIENTS })}
      size="sm"
      onClose={close}
      footer={
        <div className="flex w-full items-center gap-3">
          <p className="mr-auto hidden text-xs text-text-tertiary sm:block redesign:sm:hidden">
            {t("conversations.new.hint")}
          </p>
          {/* Ghost under the redesign, as the classic dialog's: the open
              button stays the strongest thing even while it waits. */}
          <Button
            variant="secondary"
            onClick={close}
            disabled={busy}
            className="redesign:border-transparent redesign:bg-transparent redesign:text-[color:var(--button-ghost-text,var(--color-text-tertiary))] redesign:hover:bg-[var(--button-ghost-hover,var(--color-surface-2))] redesign:hover:text-text"
          >
            {t("common.cancel")}
          </Button>
          <Button
            data-new-conversation-open=""
            onClick={() => void openWith(picked)}
            disabled={busy || picked.length === 0}
          >
            {busy
              ? t("dm.dialog.opening")
              : picked.length > 1
                ? t("conversations.new.openGroup")
                : t("conversations.new.open")}
          </Button>
        </div>
      }
    >
      <div data-new-conversation="" className="space-y-3 px-5 py-4">
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label={t("conversations.new.picked")}>
            {picked.map((person) => (
              <li key={person.id} className="animate-pop-in">
                <button
                  type="button"
                  onClick={() => toggle(person)}
                  className={cn("flex items-center gap-1.5 rounded-full border border-accent bg-accent-soft py-0.5 pl-0.5 pr-2 text-xs font-medium text-on-accent-soft", PICKED_CHIP_REDESIGN)}
                  aria-label={t("dm.dialog.removeAria", { name: person.displayName })}
                >
                  <UserAvatar
                    name={person.displayName}
                    avatarUrl={person.avatarUrl}
                    className="h-5 w-5"
                    fallbackClassName="bg-surface-3 text-[9px] text-text"
                    rounded="full"
                  />
                  {person.displayName}
                  <IconSwap off={X} on={XBold} kind="symbol" offClassName="h-3 w-3" className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {full ? (
          <p className="text-xs text-text-tertiary redesign:text-[13px] redesign:text-text-secondary">{t("dm.dialog.full")}</p>
        ) : (
          <UserSearch
            label={t("dm.dialog.findPeople")}
            placeholder={t("conversations.new.search")}
            autoFocus
            excludeIds={[...excludeIds, ...pickedIds]}
            onQueryChange={setQuery}
            onSelect={(person) => toggle(person)}
          />
        )}

        {/* Under the redesign the hint sits over the list it explains, on one
            line, instead of wrapping beside the footer's buttons. */}
        <p className="hidden px-2.5 text-xs text-text-secondary sm:redesign:block">
          {t("conversations.new.hint")}
        </p>
        {/* On the dialog the row hover is the menu's tint: the sidebar's
            opaque one is mixed for the pane and vanishes here in dark. */}
        <div className="-mx-2 max-h-[min(50vh,22rem)] overflow-y-auto redesign:mx-0 redesign:[--list-row-hover:var(--menu-row-hover)]">
          {nobody ? (
            <p
              className={cn(
                "px-2 py-3 text-sm text-text-tertiary redesign:px-3 redesign:text-text-secondary",
                // Once the search above runs it answers for all of pqp; the
                // local line would say "nobody" a second time. Below its
                // minimum length it stays idle, and this line speaks.
                readUserQuery(query).kind !== "idle" && "redesign:hidden",
              )}
            >
              {query.trim() ? t("conversations.new.noLocalMatch") : t("conversations.new.noFriends")}
            </p>
          ) : (
            <>
              <Section label={t("conversations.new.online")}>{sections.online.map(row)}</Section>
              <Section label={t("conversations.new.friends")}>{sections.friends.map(row)}</Section>
              <Section label={t("conversations.new.recent")}>{sections.recent.map(row)}</Section>
            </>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function Section({ label, children }: { label: string; children: ReactNode[] }) {
  if (children.length === 0) {
    return null;
  }
  return (
    <section data-new-conversation-section="">
      <h3 className={cn("px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary", SECTION_LABEL_REDESIGN, "redesign:px-2.5 redesign:pt-3")}>
        {label}
      </h3>
      {children}
    </section>
  );
}

function PersonRow({
  person,
  checked,
  tickDisabled,
  onOpen,
  onToggle,
}: {
  person: PickerPerson;
  checked: boolean;
  tickDisabled: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-new-conversation-person={person.id}
      className={cn(
        "group flex items-center gap-1 rounded-[var(--radius-control)] pr-2",
        checked ? "bg-surface-3" : "hover:bg-surface-3/50",
        // A two-line list row: the pill, its hover, the tall selected fill.
        "redesign:mb-1.5 redesign:rounded-[var(--list-row-radius)] redesign:pr-1.5",
        // Keyboard focus rings the whole pill, the tick included.
        "redesign:has-[>button:first-child:focus-visible]:ring-2 redesign:has-[>button:first-child:focus-visible]:ring-inset redesign:has-[>button:first-child:focus-visible]:ring-[color:var(--list-row-ring)]",
        checked
          ? "redesign:bg-[color:var(--list-row-selected-tall)] redesign:hover:bg-[color:var(--list-row-selected-tall)]"
          : "redesign:hover:bg-[color:var(--list-row-hover)]",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring redesign:rounded-[var(--list-row-radius)] redesign:pl-2.5 redesign:focus-visible:ring-0"
      >
        <span className="relative shrink-0">
          <UserAvatar
            name={person.displayName}
            avatarUrl={person.avatarUrl}
            className="h-8 w-8"
            fallbackClassName="bg-surface-1 text-xs font-semibold text-text"
            rounded="full"
          />
          {person.status && (
            <StatusDot
              status={person.status}
              className={cn("absolute -bottom-0.5 -right-0.5 redesign:bottom-0 redesign:right-0 bg-surface-2", DIALOG_CUT_REDESIGN)}
              ringClassName={cn("rounded-full ring-2 ring-surface-2", DIALOG_CUT_REDESIGN)}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text">
            {person.displayName}
          </span>
          {person.tag && (
            <span className="block truncate text-[11px] text-text-tertiary redesign:text-xs">{person.tag}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={t("conversations.new.tick", { name: person.displayName })}
        disabled={tickDisabled}
        onClick={onToggle}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40 redesign:rounded-full redesign:focus-visible:ring-[color:var(--list-row-ring)]"
      >
        <TickBox checked={checked} size="md" />
      </button>
    </div>
  );
}
