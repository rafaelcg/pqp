import type { Server, UserStatus } from "@pqp/shared";
import { Check, Hand, Link2, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/user/status-dot";
import { UserAvatar } from "@/components/user/user-avatar";
import { fetchMembers, memberDisplayName, type ServerMember } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

/** How many people from the person's own rooms are offered. */
const SUGGESTIONS = 3;
/** How many rooms are asked for their roster: a room is one request. */
const ROOMS_ASKED = 2;

export interface Suggestion {
  member: ServerMember;
  serverName: string;
}

const STATUS_ORDER: Record<UserStatus, number> = { online: 0, idle: 1, dnd: 2, offline: 3 };

/**
 * People worth saying hi to: from the rooms you are in, around first, never
 * yourself, never the house cast, each person once. Pure, so the order is a
 * test.
 */
export function rankSuggestions(
  rosters: readonly { serverName: string; members: readonly ServerMember[] }[],
  viewerId: string | null,
): Suggestion[] {
  const seen = new Set<string>();
  const all: Suggestion[] = [];
  for (const roster of rosters) {
    for (const member of roster.members) {
      if (member.id === viewerId || member.isCharacter || seen.has(member.id)) {
        continue;
      }
      seen.add(member.id);
      all.push({ member, serverName: roster.serverName });
    }
  }
  return all
    .sort(
      (a, b) =>
        STATUS_ORDER[a.member.status ?? "offline"] - STATUS_ORDER[b.member.status ?? "offline"] ||
        memberDisplayName(a.member).localeCompare(memberDisplayName(b.member)),
    )
    .slice(0, SUGGESTIONS);
}

/**
 * Rooms to ask: your own small rooms, never a listed community (a 6,000
 * person roster to pick three names from is the wrong trade).
 */
export function roomsToAsk(servers: readonly Server[]): Server[] {
  return servers.filter((server) => !server.isCommunity).slice(0, ROOMS_ASKED);
}

/**
 * CONVERSAS: what an empty conversation list leads to. An empty list is the
 * biggest drop-off for DMs, and the people are already in the person's
 * servers, so this names three of them with "Dizer oi", next to adding a
 * friend and sending somebody the way in. Drawn above the Friends view while
 * the account has no conversation at all (`conversations_home`).
 */
export function ConversationsEmpty({
  viewerId,
  servers,
  inviteHref,
  onAddFriend,
  onSayHi,
}: {
  viewerId: string | null;
  servers: readonly Server[];
  /** What "Chamar alguém pro pqp" copies. */
  inviteHref: string;
  onAddFriend: () => void;
  onSayHi: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [copied, setCopied] = useState(false);
  const rooms = roomsToAsk(servers);
  const roomsKey = rooms.map((room) => room.id).join(",");

  useEffect(() => {
    let alive = true;
    if (rooms.length === 0) {
      setSuggestions([]);
      return;
    }
    void Promise.all(
      rooms.map((room) =>
        fetchMembers(room.id)
          .then((answer) => ({ serverName: room.name, members: answer.members }))
          .catch(() => ({ serverName: room.name, members: [] as ServerMember[] })),
      ),
    ).then((rosters) => {
      if (alive) {
        setSuggestions(rankSuggestions(rosters, viewerId));
      }
    });
    return () => {
      alive = false;
    };
    // The rooms by id, not by array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsKey, viewerId]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const faces = suggestions.slice(0, 2);

  return (
    <section
      data-conversations-empty-hero=""
      aria-labelledby="conversations-empty-title"
      className="mx-auto mb-8 flex max-w-lg animate-pop-in flex-col items-center px-2 pt-6 text-center"
    >
      <div className="flex items-center" aria-hidden="true">
        {faces[0] && (
          <UserAvatar
            name={memberDisplayName(faces[0].member)}
            avatarUrl={faces[0].member.avatarUrl}
            className="h-12 w-12 ring-4 ring-surface-0"
            fallbackClassName="bg-surface-3 text-sm font-semibold text-text"
            rounded="full"
          />
        )}
        <span className="z-10 -mx-2 flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-on-accent-soft ring-4 ring-surface-0">
          <Hand className="h-6 w-6" />
        </span>
        {faces[1] && (
          <UserAvatar
            name={memberDisplayName(faces[1].member)}
            avatarUrl={faces[1].member.avatarUrl}
            className="h-12 w-12 ring-4 ring-surface-0"
            fallbackClassName="bg-surface-3 text-sm font-semibold text-text"
            rounded="full"
          />
        )}
      </div>
      <h2 id="conversations-empty-title" className="mt-4 font-display text-2xl font-bold text-text">
        {t("conversations.emptyHero.title")}
      </h2>
      <p className="mt-2 max-w-sm text-sm text-text-secondary">
        {t("conversations.emptyHero.body")}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={onAddFriend}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          {t("friends.addFriend")}
        </Button>
        <Button
          variant="secondary"
          data-conversations-invite=""
          onClick={() => {
            void navigator.clipboard?.writeText(inviteHref).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? (
            <Check className="h-4 w-4 animate-icon-swap" aria-hidden="true" />
          ) : (
            <Link2 className="h-4 w-4" aria-hidden="true" />
          )}
          {copied ? t("conversations.emptyHero.copied") : t("conversations.emptyHero.invite")}
        </Button>
      </div>
      {suggestions.length > 0 && (
        <div className="mt-6 w-full rounded-[var(--radius-card)] border border-border bg-surface-card p-3 text-left">
          <h3 className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            {t("conversations.emptyHero.suggestions")}
          </h3>
          <ul>
            {suggestions.map(({ member, serverName }) => (
              <li
                key={member.id}
                data-conversations-suggestion={member.id}
                className="flex items-center gap-3 rounded-[var(--radius-control)] px-1 py-1.5"
              >
                <span className="relative shrink-0">
                  <UserAvatar
                    name={memberDisplayName(member)}
                    avatarUrl={member.avatarUrl}
                    className="h-9 w-9"
                    fallbackClassName="bg-surface-3 text-xs font-semibold text-text"
                    rounded="full"
                  />
                  {member.status && (
                    <StatusDot
                      status={member.status}
                      className="absolute -bottom-0.5 -right-0.5 bg-surface-card"
                      ringClassName="rounded-full ring-2 ring-surface-card"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">
                    {memberDisplayName(member)}
                  </span>
                  <span className="block truncate text-xs text-text-tertiary">{serverName}</span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => onSayHi(member.id)}>
                  <Hand className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("conversations.emptyHero.sayHi")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
