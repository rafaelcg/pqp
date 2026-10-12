import type { FriendsResponse, PublicUser } from "@pqp/shared";
import { Hand, X } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { FriendsContext } from "@/components/friends/use-friends";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user/user-avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Long enough to read and reach; it is an offer, not a notice that must be seen. */
const SHOW_MS = 12_000;
const LEAVE_MS = 200;

/**
 * Which friends are new since the last snapshot because THEY accepted a
 * request this account sent. Somebody this account accepted itself (they were
 * in `incoming`) is not news to it. The first snapshot is a baseline, never
 * news. Pure, so the rule is a test.
 */
export function newlyAcceptedFriends(
  before: FriendsResponse | null,
  after: FriendsResponse,
): PublicUser[] {
  if (!before) {
    return [];
  }
  const known = new Set(before.friends.map((friend) => friend.id));
  const iAccepted = new Set(before.incoming.map((request) => request.id));
  return after.friends.filter(
    (friend) => !known.has(friend.id) && !iAccepted.has(friend.id),
  );
}

/**
 * CONVERSAS: "Tu e Bia agora são amigos · Mandar um oi". A friendship is the
 * moment somebody is most likely to write, and before this it ended on a line
 * in the Friends view with no way into a conversation. One card, top right
 * like a DM toast, gone after twelve seconds or on X; the button opens (or
 * reuses) the conversation with the composer ready.
 */
export function FriendAcceptedToast({
  onSayHi,
}: {
  onSayHi: (person: PublicUser) => void;
}) {
  const { t } = useTranslation();
  // The context directly, not `useFriends()`: this card draws no presence, so
  // it must not keep the presence poll running.
  const store = useContext(FriendsContext);
  const data = store?.data ?? null;
  const loading = store?.loading ?? true;
  const previous = useRef<FriendsResponse | null>(null);
  const [card, setCard] = useState<{ person: PublicUser; leaving: boolean } | null>(null);

  useEffect(() => {
    if (!data || loading) {
      return;
    }
    const fresh = newlyAcceptedFriends(previous.current, data);
    previous.current = data;
    const person = fresh[fresh.length - 1];
    if (person) {
      setCard({ person, leaving: false });
    }
  }, [data, loading]);

  useEffect(() => {
    if (!card || card.leaving) {
      return;
    }
    const timer = window.setTimeout(
      () => setCard((current) => (current ? { ...current, leaving: true } : null)),
      SHOW_MS,
    );
    return () => window.clearTimeout(timer);
  }, [card]);

  useEffect(() => {
    if (!card?.leaving) {
      return;
    }
    const timer = window.setTimeout(() => setCard(null), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [card]);

  if (!card) {
    return null;
  }
  const { person } = card;
  const dismiss = () => setCard((current) => (current ? { ...current, leaving: true } : null));

  return (
    <div
      role="status"
      aria-live="polite"
      data-friend-accepted={person.id}
      className={cn(
        "elevation-3 pointer-events-auto fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-40 flex items-center gap-3 rounded-[var(--radius-card)] p-3 sm:inset-x-auto sm:bottom-auto sm:right-4 sm:top-[max(1rem,env(safe-area-inset-top))] sm:w-80",
        card.leaving ? "animate-toast-out" : "animate-toast-in",
      )}
    >
      <UserAvatar
        name={person.displayName}
        avatarUrl={person.avatarUrl}
        className="h-10 w-10 shrink-0"
        fallbackClassName="bg-accent text-sm text-on-accent"
        rounded="full"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">
          {t("conversations.friendAccepted.title", { name: person.displayName })}
        </p>
        <Button
          size="sm"
          className="mt-2"
          data-friend-accepted-say-hi=""
          onClick={() => {
            onSayHi(person);
            dismiss();
          }}
        >
          <Hand className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t("conversations.friendAccepted.cta")}
        </Button>
      </div>
      <button
        type="button"
        aria-label={t("dmToast.dismiss")}
        className="flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text"
        onClick={dismiss}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
