import {
  hasPermission,
  parsePermissions,
  Permission,
  type DmSummary,
  type Server,
} from "@pqp/shared";
import {
  Forward,
  Hash,
  Loader2,
  Lock,
  MessageSquareText,
  Search,
  Users,
  Volume2,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CheckRow } from "@/components/ui/check-row";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ServerIcon } from "@/components/layout/server-identity";
import { UserAvatar } from "@/components/user/user-avatar";
import {
  ApiError,
  createForward,
  fetchChannels,
  fetchForwardDestinations,
  fetchMemberPermissions,
} from "@/lib/api";
import { conversationTitle } from "@/lib/conversations";
import {
  MAX_FORWARD_TARGETS,
  plainPreviewText,
  readRecentForwardTargets,
  rememberForwardTargets,
  targetAllowedFor,
  targetMatches,
  type ForwardSourceRequest,
  type PickerTarget,
} from "@/lib/forward";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { SectionLabel } from "@/components/ui/section-header";

/**
 * "Encaminhar": pick up to five places (channels you can speak in, and your
 * conversations), add a comment if you want one, send. Recent places first,
 * search across every server you are in.
 *
 * The server decides for real (`POST /api/forwards`: access, SEND_MESSAGES,
 * slow mode, AutoMod, a members-only post staying in its server). This only
 * keeps the list honest, and shows each refusal on the row it belongs to, so a
 * forward to five places where one is slow-moded is four sent and one
 * explained, never a vague failure.
 */

const COMMENT_MAX = 1500;
/** Rows drawn at first and per "Mostrar mais": the search still covers every target. */
const RENDER_STEP = 80;
/** A send that has not answered by now can be dismissed; its late answer only reports what went out. */
const STUCK_SEND_MS = 20_000;
const FETCH_CONCURRENCY = 4;

function newNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const REASON_KEY: Record<string, MessageKey> = {
  no_access: "forward.error.noAccess",
  cannot_send: "forward.error.cannotSend",
  bad_target: "forward.error.badTarget",
  stays_in_server: "forward.error.staysInServer",
  unreachable: "forward.error.unreachable",
  slow_mode: "forward.error.slowMode",
  rate_limited: "forward.error.rateLimited",
  automod: "forward.error.automod",
  unavailable: "forward.error.generic",
};

export function forwardRequestErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return "forward.error.sourceGone";
    }
    if (error.status === 422) {
      return "forward.error.notForwardable";
    }
    if (error.status === 429) {
      return "forward.error.rateLimited";
    }
  }
  return "forward.error.generic";
}

/** What the toast needs once something went out. */
export interface ForwardedSummary {
  count: number;
  /** The first place it went, for "Ver". */
  first: PickerTarget;
}

/**
 * What a server's list costs: one request (`forward-destinations`; two against
 * an API that predates it). Kept for a minute, so opening the picker twice (or
 * forwarding twice in a row) does not repeat the fan-out over every server. A
 * failed load is never cached, and the retry button asks again past the cache.
 */
const TARGET_CACHE_MS = 60_000;
const targetCache = new Map<string, { at: number; targets: PickerTarget[] }>();
/**
 * Whose results the cache holds. A list is filtered by what THIS account may
 * see and speak in, so it is never served to another account in the same page:
 * a different (or no) user empties it.
 */
let targetCacheOwner: string | null = null;

function scopeTargetCache(userId: string | null): void {
  if (targetCacheOwner !== userId) {
    targetCache.clear();
    targetCacheOwner = userId;
  }
}

/** Test seam. */
export function resetForwardTargetCacheForTests(): void {
  targetCache.clear();
  targetCacheOwner = null;
}

async function loadServerTargets(server: Server, force = false): Promise<PickerTarget[]> {
  const cached = targetCache.get(server.id);
  if (!force && cached && Date.now() - cached.at < TARGET_CACHE_MS) {
    return cached.targets;
  }
  // A load started for one account must not write into the cache after another
  // account took it over: the owner is read before and checked after.
  const owner = targetCacheOwner;
  const targets = await fetchServerTargets(server);
  if (targetCacheOwner === owner) {
    targetCache.set(server.id, { at: Date.now(), targets });
  }
  return targets;
}

/** Channel types a message can go to: text, and the chat beside a voice room. */
const SENDABLE_TYPES = new Set(["text", "voice", "watch_party"]);

function channelTarget(
  server: Server,
  channel: { id: string; name: string; type: string },
): PickerTarget {
  return {
    id: channel.id,
    kind: "channel" as const,
    serverId: server.id,
    serverName: server.name,
    label: channel.name,
    ...(channel.type === "text" ? {} : { voice: true }),
  };
}

async function fetchServerTargets(server: Server): Promise<PickerTarget[]> {
  try {
    // One request: the server lists the channels this account can speak in.
    const { channels, threads } = await fetchForwardDestinations(server.id);
    return [
      ...channels.map((channel) => channelTarget(server, channel)),
      // The threads you are in, most recent first, after the channels.
      ...(threads ?? []).map((thread) => ({
        id: thread.id,
        kind: "channel" as const,
        serverId: server.id,
        serverName: server.name,
        label: thread.name,
        threadOf: thread.parentName,
      })),
    ];
  } catch (error) {
    // An API that predates the route: the same answer from the two older reads.
    if (!(error instanceof ApiError) || error.status !== 404) {
      throw error;
    }
  }
  return fetchServerTargetsLegacy(server);
}

async function fetchServerTargetsLegacy(server: Server): Promise<PickerTarget[]> {
  const [{ channels }, snapshot] = await Promise.all([
    fetchChannels(server.id),
    fetchMemberPermissions(server.id),
  ]);
  const serverBits = parsePermissions(snapshot.server);
  return channels
    .filter((channel) => {
      if (channel.kind !== "server" || !SENDABLE_TYPES.has(channel.type)) {
        return false;
      }
      const raw = snapshot.channels[channel.id];
      const mask = raw !== undefined ? parsePermissions(raw) : serverBits;
      return hasPermission(mask, Permission.SEND_MESSAGES);
    })
    .sort((a, b) => a.position - b.position)
    .map((channel) => channelTarget(server, channel));
}

/** Runs `worker` over `items`, `limit` at a time, calling `onEach` as each lands. */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  onEach: (result: R | null, item: T) => void,
  alive: () => boolean,
): Promise<void> {
  let next = 0;
  async function lane() {
    while (alive() && next < items.length) {
      const item = items[next++]!;
      try {
        onEach(await worker(item), item);
      } catch {
        onEach(null, item);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export function ForwardPicker({
  open,
  source,
  servers,
  conversations,
  currentServerId,
  userId,
  onClose,
  onForwarded,
}: {
  open: boolean;
  source: ForwardSourceRequest | null;
  servers: readonly Server[];
  conversations: readonly DmSummary[];
  currentServerId: string | null;
  /** The signed-in account: what the cached destinations belong to. */
  userId: string | null;
  onClose: () => void;
  onForwarded: (summary: ForwardedSummary) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [serverTargets, setServerTargets] = useState<Record<string, PickerTarget[]>>({});
  const [pending, setPending] = useState(0);
  // Servers whose list could not be loaded: shown with a retry, never as "empty".
  const [failedServers, setFailedServers] = useState<Server[]>([]);
  const [shown, setShown] = useState(RENDER_STEP);
  const [stuck, setStuck] = useState(false);
  // One per opening. A completion that finds a different one is from a picker
  // that is gone and must not touch the one on screen.
  const sessionRef = useRef(0);
  const nonceRef = useRef("");
  const recentsRef = useRef<string[]>([]);
  const serversRef = useRef(servers);
  serversRef.current = servers;

  // Order: the server you are in, then the rail's order. A members-only post
  // only ever offers its own server.
  const eligibleServers = useMemo(() => {
    const list = servers.filter(
      (server) => !source?.restricted || server.id === source.serverId,
    );
    return [...list].sort(
      (a, b) =>
        Number(b.id === currentServerId) - Number(a.id === currentServerId),
    );
  }, [servers, source, currentServerId]);

  /** Load these servers' targets as they land; the ones that fail are kept for a retry. */
  function loadServers(list: readonly Server[], force: boolean) {
    const session = sessionRef.current;
    const alive = () => sessionRef.current === session;
    setPending((count) => count + list.length);
    void pool(
      list,
      FETCH_CONCURRENCY,
      (server) => loadServerTargets(server, force),
      (result, server) => {
        if (!alive()) {
          return;
        }
        if (result) {
          setServerTargets((prev) => ({ ...prev, [server.id]: result }));
        } else {
          setFailedServers((prev) => [...prev.filter((one) => one.id !== server.id), server]);
        }
        setPending((count) => Math.max(0, count - 1));
      },
      alive,
    );
  }

  // A request that never answers must not trap the person in the dialog.
  useEffect(() => {
    if (!busy) {
      setStuck(false);
      return;
    }
    const timer = window.setTimeout(() => setStuck(true), STUCK_SEND_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  useEffect(() => {
    if (!open || !source) {
      return;
    }
    setPending(0);
    setQuery("");
    setSelected([]);
    setComment("");
    setBusy(false);
    setError(null);
    setRowErrors({});
    setServerTargets({});
    setFailedServers([]);
    setShown(RENDER_STEP);
    sessionRef.current += 1;
    scopeTargetCache(userId);
    nonceRef.current = newNonce();
    recentsRef.current = readRecentForwardTargets();
    loadServers(eligibleServers, false);
    return () => {
      sessionRef.current += 1;
    };
    // Opening is the trigger; the server list can move under an open dialog
    // without restarting what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source?.id]);

  const conversationTargets = useMemo((): PickerTarget[] => {
    if (!source || source.restricted) {
      return [];
    }
    return conversations.map((conversation) => ({
      id: conversation.channelId,
      kind: "conversation" as const,
      serverId: null,
      serverName: null,
      label: conversationTitle(conversation.participants),
      ...(conversation.kind === "dm" && conversation.participants[0]
        ? {
            avatarName: conversation.participants[0].displayName,
            avatarUrl: conversation.participants[0].avatarUrl,
          }
        : {}),
    }));
  }, [conversations, source]);

  const allTargets = useMemo(() => {
    const flat: PickerTarget[] = [];
    for (const server of eligibleServers) {
      flat.push(...(serverTargets[server.id] ?? []));
    }
    flat.push(...conversationTargets);
    return flat.filter((target) => (source ? targetAllowedFor(source, target) : true));
  }, [eligibleServers, serverTargets, conversationTargets, source]);

  const byId = useMemo(
    () => new Map(allTargets.map((target) => [target.id, target])),
    [allTargets],
  );

  const searching = query.trim().length > 0;
  const recents = useMemo(
    () =>
      recentsRef.current
        .map((id) => byId.get(id))
        .filter((target): target is PickerTarget => Boolean(target)),
    // `byId` changes as servers load; recents resolve as soon as theirs does.
    [byId],
  );

  const atLimit = selected.length >= MAX_FORWARD_TARGETS;

  function toggle(target: PickerTarget, on: boolean) {
    setError(null);
    setRowErrors((prev) => {
      if (!(target.id in prev)) {
        return prev;
      }
      const { [target.id]: _dropped, ...rest } = prev;
      return rest;
    });
    setSelected((prev) => {
      if (on) {
        return prev.includes(target.id) || prev.length >= MAX_FORWARD_TARGETS
          ? prev
          : [...prev, target.id];
      }
      return prev.filter((id) => id !== target.id);
    });
  }

  function rowFor(target: PickerTarget, withServer: boolean) {
    const checked = selected.includes(target.id);
    const rowError = rowErrors[target.id];
    return (
      <li key={`${withServer ? "r" : "s"}-${target.id}`} data-forward-target={target.id}>
        <CheckRow
          checked={checked}
          disabled={busy || (!checked && atLimit)}
          onCheckedChange={(on) => toggle(target, on)}
          label={target.label}
          description={
            rowError ??
            (target.threadOf
              ? withServer && target.serverName
                ? `#${target.threadOf} \u00b7 ${target.serverName}`
                : `#${target.threadOf}`
              : withServer && target.serverName
                ? target.serverName
                : undefined)
          }
          icon={
            target.kind === "channel" ? (
              target.threadOf !== undefined ? (
                <MessageSquareText className="h-4 w-4" aria-hidden />
              ) : target.voice ? (
                <Volume2 className="h-4 w-4" aria-hidden />
              ) : (
                <Hash className="h-4 w-4" aria-hidden />
              )
            ) : target.avatarName ? (
              <UserAvatar
                name={target.avatarName}
                avatarUrl={target.avatarUrl ?? null}
                className="h-5 w-5"
                rounded="full"
                fallbackClassName="bg-surface-3 text-[9px] text-text"
              />
            ) : (
              <Users className="h-4 w-4" aria-hidden />
            )
          }
          className={rowError ? "ring-1 ring-danger/60" : undefined}
        />
      </li>
    );
  }

  const visibleRecents = searching
    ? []
    : recents.filter((target) => targetMatches(target, query));
  const recentIds = new Set(visibleRecents.map((target) => target.id));

  async function submit() {
    if (!source || busy || selected.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);
    setRowErrors({});
    const session = sessionRef.current;
    try {
      const response = await createForward({
        source:
          source.kind === "bau_post"
            ? { kind: "bau_post", id: source.id, serverId: source.serverId }
            : { kind: "message", id: source.id },
        targets: selected.map((channelId) => ({ channelId })),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        nonce: nonceRef.current,
      });
      const sent: PickerTarget[] = [];
      const failed: Record<string, string> = {};
      const stillSelected: string[] = [];
      for (const result of response.results) {
        const id = "channelId" in result.target ? result.target.channelId : null;
        if (!id) {
          continue;
        }
        if (result.ok) {
          const target = byId.get(id);
          if (target) {
            sent.push(target);
          }
        } else {
          failed[id] = t(REASON_KEY[result.reason] ?? "forward.error.generic");
          stillSelected.push(id);
        }
      }
      if (sent.length > 0) {
        rememberForwardTargets(sent.map((target) => target.id));
        onForwarded({ count: sent.length, first: sent[0]! });
      }
      // The picker this belongs to is gone: what went out is told, nothing else.
      if (session !== sessionRef.current) {
        return;
      }
      if (stillSelected.length === 0) {
        onClose();
        return;
      }
      // Some went out: what is left is what to fix or retry, each with its
      // reason. The answer was a valid one, so the retry is a NEW attempt with
      // its own nonce (the same nonce would read as a replay of this request).
      nonceRef.current = newNonce();
      setSelected(stillSelected);
      setRowErrors(failed);
    } catch (err) {
      // Ambiguous (a lost connection): the nonce stays, so a retry of the same
      // request returns what already went out instead of sending it twice.
      if (session === sessionRef.current) {
        setError(t(forwardRequestErrorKey(err)));
      }
    } finally {
      if (session === sessionRef.current) {
        setBusy(false);
      }
    }
  }

  const groups = eligibleServers
    .map((server) => ({
      server,
      targets: (serverTargets[server.id] ?? []).filter(
        (target) =>
          (source ? targetAllowedFor(source, target) : true) &&
          targetMatches(target, query) &&
          !recentIds.has(target.id),
      ),
    }))
    .filter((group) => group.targets.length > 0);
  const visibleConversations = conversationTargets.filter(
    (target) => targetMatches(target, query) && !recentIds.has(target.id),
  );
  const nothing =
    pending === 0 &&
    failedServers.length === 0 &&
    visibleRecents.length === 0 &&
    groups.length === 0 &&
    visibleConversations.length === 0;

  // Only the first rows are drawn (a long list is thousands of DOM rows on an
  // account in many servers); search still looks at every target, and "Mostrar
  // mais" draws the next step.
  let left = shown;
  const take = <T,>(list: readonly T[]): T[] => {
    const out = list.slice(0, Math.max(0, left));
    left -= out.length;
    return out;
  };
  const shownRecents = take(visibleRecents);
  const shownConversations = take(visibleConversations);
  const shownGroups = groups
    .map((group) => ({ ...group, targets: take(group.targets) }))
    .filter((group) => group.targets.length > 0);
  const matching =
    visibleRecents.length +
    visibleConversations.length +
    groups.reduce((sum, group) => sum + group.targets.length, 0);
  const hasMore = matching > shown;

  return (
    <Dialog
      open={open && source !== null}
      title={t("forward.title")}
      size="md"
      // Whatever dismisses it (Escape, the backdrop, the X), a send in flight
      // is not abandoned: its answer belongs to this picker.
      onClose={() => {
        if (!busy || stuck) {
          onClose();
        }
      }}
      dismissible={!busy || stuck}
      footer={
        <>
          <span
            className="mr-auto text-xs tabular-nums text-text-tertiary"
            aria-live="polite"
            data-forward-count
          >
            {t("forward.selectedCount", {
              selected: selected.length,
              max: MAX_FORWARD_TARGETS,
            })}
          </span>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy && !stuck}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={busy || selected.length === 0}
            data-forward-send
          >
            {busy ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                {t("forward.sending")}
              </>
            ) : (
              <>
                <Forward className="mr-1.5 h-4 w-4" aria-hidden />
                {t("forward.send")}
              </>
            )}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="space-y-3 px-5 py-4"
        data-forward-picker
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {source && (
          <p
            className="flex items-center gap-2 rounded-[var(--radius-control)] bg-surface-1 px-3 py-2 text-sm text-text-secondary"
            data-forward-source
          >
            {source.restricted ? (
              <Lock className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
            ) : (
              <Forward className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
            )}
            <span className="min-w-0 truncate">
              {plainPreviewText(source.title) ||
                (source.kind === "bau_post"
                  ? t("forward.postFallback")
                  : t("forward.messageFallback"))}
            </span>
          </p>
        )}
        {source?.restricted && (
          <p className="text-xs text-text-tertiary" data-forward-restricted>
            {t("forward.restrictedHint")}
          </p>
        )}

        <label className="relative block">
          <span className="sr-only">{t("forward.search")}</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShown(RENDER_STEP);
            }}
            placeholder={t("forward.search")}
            className="pl-9"
            autoComplete="off"
            data-forward-search
          />
        </label>

        <div
          className="max-h-[min(22rem,42vh)] space-y-3 overflow-y-auto pr-1"
          data-forward-list
        >
          {shownRecents.length > 0 && (
            <section aria-label={t("forward.recent")}>
              <SectionLabel className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                {t("forward.recent")}
              </SectionLabel>
              <ul>{shownRecents.map((target) => rowFor(target, true))}</ul>
            </section>
          )}
          {shownConversations.length > 0 && (
            <section aria-label={t("forward.conversations")}>
              <SectionLabel className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                {t("forward.conversations")}
              </SectionLabel>
              <ul>{shownConversations.map((target) => rowFor(target, false))}</ul>
            </section>
          )}
          {shownGroups.map(({ server, targets }) => (
            <section key={server.id} aria-label={server.name} data-forward-server={server.id}>
              <SectionLabel className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                <span className="flex h-4 w-4 items-center justify-center overflow-hidden rounded bg-surface-3 text-[8px] text-text">
                  <ServerIcon name={server.name} iconUrl={server.iconUrl} />
                </span>
                <span className="truncate">{server.name}</span>
              </SectionLabel>
              <ul>{targets.map((target) => rowFor(target, false))}</ul>
            </section>
          ))}
          {hasMore && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => setShown((count) => count + RENDER_STEP)}
              data-forward-show-more
            >
              {t("forward.showMore")}
            </Button>
          )}
          {failedServers.length > 0 && pending === 0 && (
            <div
              className="flex items-center gap-2 rounded-[var(--radius-control)] bg-surface-1 px-3 py-2 text-xs text-text-secondary"
              role="alert"
              data-forward-load-failed
            >
              <span className="min-w-0 flex-1">{t("forward.loadFailed")}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  const again = failedServers;
                  setFailedServers([]);
                  loadServers(again, true);
                }}
                data-forward-retry-load
              >
                {t("forward.retry")}
              </Button>
            </div>
          )}
          {pending > 0 && (
            <p
              className="flex items-center gap-2 px-2 py-1 text-xs text-text-tertiary"
              role="status"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {t("forward.loading")}
            </p>
          )}
          {nothing && (
            <p className="px-2 py-3 text-sm text-text-secondary" data-forward-empty>
              {searching ? t("forward.noMatch") : t("forward.empty")}
            </p>
          )}
        </div>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-wide text-text-tertiary">
            {t("forward.comment")}
          </span>
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value.slice(0, COMMENT_MAX))}
            placeholder={t("forward.commentPlaceholder")}
            className="min-h-16"
            disabled={busy}
            data-forward-comment
          />
        </label>

        {error && (
          <p className="text-sm text-danger" role="alert" data-forward-error>
            {error}
          </p>
        )}
        {atLimit && (
          <p className="text-xs text-text-tertiary">
            {t("forward.limit", { max: MAX_FORWARD_TARGETS })}
          </p>
        )}
      </form>
    </Dialog>
  );
}
