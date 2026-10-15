import type {
  BauFollow,
  BauFollowDestination,
  BauFollowState,
  BauFollowers,
} from "@pqp/shared";
import { BellPlus, BellRing } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ServerIcon } from "@/components/layout/server-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  ApiError,
  createBauFollow,
  deleteBauFollow,
  fetchBauFollowDestinations,
  fetchBauFollowState,
  fetchBauFollowers,
  removeBauFollower,
  unblockBauFollower,
  updateBauFollow,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * Seguir, the web surface on the SOURCE's Baú: the button on its header, the
 * dialog that sets a follow up, and (for the source's staff) the follower list.
 * The destination channel's own list lives in
 * `components/layout/channel-bau-follows-section.tsx`.
 *
 * Everything is behind the per-source runtime flag `bau_follow`: the state read
 * answers `enabled: false` and the button is simply not drawn.
 */

/** Follower rows drawn at a time. */
const FOLLOWERS_PAGE = 50;

const SELECT_CLASS =
  "h-[var(--control-md)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring disabled:opacity-40";

export function bauFollowErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return "bauFollow.error.slow";
    }
    if (error.status === 403) {
      // Two refusals share the status: not allowed in that channel, and a
      // source that does not take that server. The text says which.
      return /accept/i.test(error.message)
        ? "bauFollow.error.blocked"
        : "bauFollow.error.forbidden";
    }
    if (error.status === 409) {
      return /most|at most/i.test(error.message)
        ? "bauFollow.error.limit"
        : "bauFollow.error.exists";
    }
    if (error.status === 400) {
      return "bauFollow.error.invalid";
    }
  }
  return "bauFollow.error.generic";
}

/**
 * What the Baú header needs to know: is this Baú followable (the flag for this
 * source), and what does the viewer already follow of it. Re-read on demand
 * with `refresh` after a change. A failed read is "not followable": a button
 * that cannot be trusted is better absent.
 */
export function useBauFollowState(serverId: string, active: boolean) {
  const [state, setState] = useState<BauFollowState | null>(null);
  // A read answers only if no newer read started after it: a slow early answer
  // must not overwrite a later one (two quick actions refresh twice).
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    if (!active) {
      setState(null);
      return;
    }
    try {
      const next = await fetchBauFollowState(serverId);
      if (generation.current === mine) {
        setState(next);
      }
    } catch {
      if (generation.current === mine) {
        setState(null);
      }
    }
  }, [serverId, active]);
  useEffect(() => {
    setState(null);
    void refresh();
    return () => {
      // Whatever is still in flight belongs to the server or switch we left.
      generation.current += 1;
    };
  }, [refresh]);
  return { state, refresh };
}

/** "Seguir" on the Baú header, or "Seguindo" once the viewer follows it somewhere. */
export function BauFollowButton({
  state,
  onOpen,
}: {
  state: BauFollowState | null;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  if (!state?.enabled) {
    return null;
  }
  const following = state.mine.length > 0;
  const Icon = following ? BellRing : BellPlus;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      className="rounded-full"
      onClick={onOpen}
      aria-label={t("bauFollow.buttonAria")}
      data-bau-follow-button
      data-following={following ? "1" : "0"}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {following ? t("bauFollow.buttonActive") : t("bauFollow.button")}
    </Button>
  );
}

function FollowRow({
  follow,
  busy,
  onUnfollow,
  onResume,
}: {
  follow: BauFollow;
  busy: boolean;
  onUnfollow: () => void;
  onResume?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li
      className="flex items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface-1 px-3 py-2"
      data-bau-follow-row
    >
      <span className="h-8 w-8 shrink-0 overflow-hidden rounded-lg">
        <ServerIcon name={follow.targetServerName} iconUrl={null} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text">
          {follow.targetServerName}
        </p>
        <p className="truncate text-xs text-text-tertiary">
          # {follow.targetChannelName}
        </p>
        {follow.rolePingName && (
          <p className="truncate text-xs text-text-tertiary">
            {t("bauFollow.pings", { role: follow.rolePingName })}
          </p>
        )}
        {follow.status === "paused" && (
          <p className="mt-0.5 text-xs text-warning">{t("bauFollow.pausedHint")}</p>
        )}
      </div>
      {follow.status === "paused" && (
        <Badge variant="warning" data-bau-follow-paused>
          {t("bauFollow.paused")}
        </Badge>
      )}
      {follow.status === "paused" && onResume && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={onResume}
          data-bau-follow-resume
        >
          {t("bauFollow.resume")}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-danger"
        disabled={busy}
        onClick={onUnfollow}
        data-bau-follow-unfollow
      >
        {t("bauFollow.unfollow")}
      </Button>
    </li>
  );
}

/**
 * Pick a server of yours, a channel there, optionally a role to mention, and
 * follow. The server list is the viewer's own servers where they may manage
 * webhooks or channels (the API answers it; the channel is checked again on
 * create).
 */
export function BauFollowDialog({
  open,
  serverId,
  serverName,
  state,
  onClose,
  onChanged,
}: {
  open: boolean;
  serverId: string;
  serverName: string;
  state: BauFollowState | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const serverSelectId = useId();
  const channelSelectId = useId();
  const roleSelectId = useId();
  const [destinations, setDestinations] = useState<BauFollowDestination[] | null>(
    null,
  );
  const [maxPerServer, setMaxPerServer] = useState(20);
  const [loadError, setLoadError] = useState(false);
  const [destinationId, setDestinationId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadGeneration = useRef(0);
  const load = useCallback(() => {
    loadGeneration.current += 1;
    const mine = loadGeneration.current;
    setLoadError(false);
    return fetchBauFollowDestinations(serverId)
      .then((res) => {
        if (loadGeneration.current !== mine) {
          return null;
        }
        setDestinations(res.servers);
        setMaxPerServer(res.maxPerServer);
        return res.servers;
      })
      .catch(() => {
        if (loadGeneration.current === mine) {
          setLoadError(true);
        }
        return null;
      });
  }, [serverId]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setError(null);
    setNotice(null);
    setDestinations(null);
    void load().then((servers) => {
      if (servers && servers[0]) {
        setDestinationId(servers[0].serverId);
      }
    });
  }, [open, load]);

  const destination = useMemo(
    () => destinations?.find((one) => one.serverId === destinationId) ?? null,
    [destinations, destinationId],
  );
  const freeChannels = useMemo(
    () => destination?.channels.filter((channel) => !channel.following) ?? [],
    [destination],
  );
  const full = destination !== null && destination.followCount >= maxPerServer;

  // Keep the channel and role picks valid for the server on show.
  useEffect(() => {
    setChannelId((current) =>
      freeChannels.some((channel) => channel.id === current)
        ? current
        : (freeChannels[0]?.id ?? ""),
    );
    setRoleId((current) =>
      destination?.roles.some((role) => role.id === current) ? current : "",
    );
  }, [freeChannels, destination]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!destination || !channelId || busy || full) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createBauFollow(serverId, {
        channelId,
        rolePingId: roleId || null,
      });
      setNotice(
        t("bauFollow.followed", {
          channel: res.follow.targetChannelName,
          server: res.follow.targetServerName,
        }),
      );
      onChanged();
      await load();
    } catch (err) {
      setError(t(bauFollowErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  async function unfollow(follow: BauFollow) {
    setRowBusy(follow.id);
    setError(null);
    try {
      await deleteBauFollow(follow.id);
      onChanged();
      await load();
    } catch {
      setError(t("bauFollow.error.action"));
    } finally {
      setRowBusy(null);
    }
  }

  async function resume(follow: BauFollow) {
    setRowBusy(follow.id);
    setError(null);
    try {
      await updateBauFollow(follow.id, { resume: true });
      onChanged();
    } catch {
      setError(t("bauFollow.error.action"));
    } finally {
      setRowBusy(null);
    }
  }

  const mine = state?.mine ?? [];

  return (
    <Dialog
      open={open}
      eyebrow={serverName}
      title={t("bauFollow.title")}
      description={t("bauFollow.hint")}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("bauFollow.done")}
          </Button>
          {destinations !== null && destinations.length > 0 && (
            <Button
              type="submit"
              form={formId}
              disabled={busy || !channelId || full}
              data-bau-follow-submit
            >
              {busy ? t("bauFollow.submitting") : t("bauFollow.submit")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5 px-5 py-4" data-bau-follow-dialog>
        {mine.length > 0 && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
              {t("bauFollow.yours")}
            </h3>
            <ul className="space-y-2">
              {mine.map((follow) => (
                <FollowRow
                  key={follow.id}
                  follow={follow}
                  busy={rowBusy !== null}
                  onUnfollow={() => void unfollow(follow)}
                  onResume={() => void resume(follow)}
                />
              ))}
            </ul>
          </section>
        )}

        {loadError && (
          <p className="text-sm text-danger" role="alert">
            {t("bauFollow.loadFailed")}
          </p>
        )}
        {destinations !== null && destinations.length === 0 && (
          <p className="text-sm text-text-secondary" data-bau-follow-empty>
            {t("bauFollow.noDestinations")}
          </p>
        )}
        {destinations !== null && destinations.length > 0 && (
          <form
            id={formId}
            onSubmit={(event) => void submit(event)}
            className="space-y-3"
          >
            <label htmlFor={serverSelectId} className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-tertiary">
                {t("bauFollow.server")}
              </span>
              <select
                id={serverSelectId}
                value={destinationId}
                onChange={(event) => {
                  setDestinationId(event.target.value);
                  setError(null);
                  setNotice(null);
                }}
                disabled={busy}
                className={SELECT_CLASS}
                data-bau-follow-server
              >
                {destinations.map((one) => (
                  <option key={one.serverId} value={one.serverId}>
                    {one.serverName}
                  </option>
                ))}
              </select>
            </label>
            {full && (
              <p className="text-sm text-warning" role="status">
                {t("bauFollow.destinationFull", {
                  server: destination!.serverName,
                  count: maxPerServer,
                })}
              </p>
            )}
            {!full && freeChannels.length === 0 && (
              <p className="text-sm text-text-secondary" role="status">
                {t("bauFollow.allFollowed")}
              </p>
            )}
            {!full && freeChannels.length > 0 && (
              <>
                <label htmlFor={channelSelectId} className="block">
                  <span className="mb-1 block text-xs uppercase tracking-wide text-text-tertiary">
                    {t("bauFollow.channel")}
                  </span>
                  <select
                    id={channelSelectId}
                    value={channelId}
                    onChange={(event) => {
                      setChannelId(event.target.value);
                      setError(null);
                      setNotice(null);
                    }}
                    disabled={busy}
                    className={SELECT_CLASS}
                    data-bau-follow-channel
                  >
                    {freeChannels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        # {channel.name}
                      </option>
                    ))}
                  </select>
                </label>
                {destination && destination.roles.length > 0 && (
                  <label htmlFor={roleSelectId} className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wide text-text-tertiary">
                      {t("bauFollow.role")}
                    </span>
                    <select
                      id={roleSelectId}
                      value={roleId}
                      onChange={(event) => setRoleId(event.target.value)}
                      disabled={busy}
                      className={SELECT_CLASS}
                      data-bau-follow-role
                    >
                      <option value="">{t("bauFollow.noRole")}</option>
                      {destination.roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          @{role.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            )}
          </form>
        )}
        {notice && (
          <p
            className="animate-rise rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success"
            role="status"
            data-bau-follow-notice
          >
            {notice}
          </p>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert" data-bau-follow-error>
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The source's staff: which servers follow this Baú (names, never people),
 * remove one, or remove and block its server, and unblock.
 */
export function BauFollowersDialog({
  open,
  serverId,
  onClose,
  onChanged,
}: {
  open: boolean;
  serverId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<BauFollowers | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The list can hold hundreds of rows: draw a page at a time.
  const [shown, setShown] = useState(FOLLOWERS_PAGE);

  const loadGeneration = useRef(0);
  const load = useCallback(() => {
    loadGeneration.current += 1;
    const mine = loadGeneration.current;
    setLoadError(false);
    return fetchBauFollowers(serverId)
      .then((next) => {
        if (loadGeneration.current === mine) {
          setData(next);
        }
      })
      .catch(() => {
        if (loadGeneration.current === mine) {
          setLoadError(true);
        }
      });
  }, [serverId]);

  useEffect(() => {
    if (open) {
      setData(null);
      setError(null);
      setShown(FOLLOWERS_PAGE);
      void load();
    }
  }, [open, load]);

  /**
   * Run a change, then reflect it on screen at once (`apply`) so a refresh that
   * fails afterwards cannot leave a removed server on show; the read that
   * follows only reconciles.
   */
  async function act(
    key: string,
    run: () => Promise<unknown>,
    apply: (current: BauFollowers) => BauFollowers,
  ) {
    setBusyId(key);
    setError(null);
    try {
      await run();
      setData((current) => (current ? apply(current) : current));
      onChanged?.();
      await load();
    } catch {
      setError(t("bauFollow.error.action"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow={t("bauFollow.eyebrow")}
      title={t("bauFollow.followers.title")}
      description={t("bauFollow.followers.hint")}
      size="md"
      onClose={onClose}
      footer={
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("bauFollow.done")}
        </Button>
      }
    >
      <div className="space-y-5 px-5 py-4" data-bau-followers-dialog>
        {loadError && (
          <p className="text-sm text-danger" role="alert">
            {t("bauFollow.followers.loadFailed")}
          </p>
        )}
        {data && (
          <>
            <p className="text-sm font-medium text-text" data-bau-followers-count>
              {t("bauFollow.followers.count", { count: data.count })}
            </p>
            {data.followers.length === 0 ? (
              <p className="text-sm text-text-secondary">
                {t("bauFollow.followers.empty")}
              </p>
            ) : (
              <ul className="space-y-2">
                {data.followers.slice(0, shown).map((follower) => (
                  <li
                    key={follower.id}
                    className="flex items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface-1 px-3 py-2"
                    data-bau-follower-row
                  >
                    <span className="h-8 w-8 shrink-0 overflow-hidden rounded-lg">
                      <ServerIcon
                        name={follower.targetServerName}
                        iconUrl={follower.targetServerIconUrl}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-text">
                        {follower.targetServerName}
                      </p>
                      <p className="truncate text-xs text-text-tertiary">
                        # {follower.targetChannelName}
                      </p>
                    </div>
                    {follower.status === "paused" && (
                      <Badge variant="warning">{t("bauFollow.paused")}</Badge>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() =>
                        void act(
                          follower.id,
                          () => removeBauFollower(serverId, follower.id, false),
                          (current) => ({
                            ...current,
                            count: Math.max(0, current.count - 1),
                            followers: current.followers.filter(
                              (one) => one.id !== follower.id,
                            ),
                          }),
                        )
                      }
                      data-bau-follower-remove
                    >
                      {t("bauFollow.followers.remove")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-danger"
                      disabled={busyId !== null}
                      onClick={() =>
                        void act(
                          follower.id,
                          () => removeBauFollower(serverId, follower.id, true),
                          (current) => {
                            // Blocking removes every follow of that server.
                            const gone = current.followers.filter(
                              (one) => one.targetServerId === follower.targetServerId,
                            ).length;
                            return {
                              ...current,
                              count: Math.max(0, current.count - Math.max(1, gone)),
                              followers: current.followers.filter(
                                (one) => one.targetServerId !== follower.targetServerId,
                              ),
                              blocked: [
                                {
                                  serverId: follower.targetServerId,
                                  serverName: follower.targetServerName,
                                  createdAt: new Date().toISOString(),
                                },
                                ...current.blocked,
                              ],
                            };
                          },
                        )
                      }
                      data-bau-follower-block
                    >
                      {t("bauFollow.followers.block")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {data.followers.length > shown && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShown((n) => n + FOLLOWERS_PAGE)}
                data-bau-followers-more
              >
                {t("bauFollow.followers.more")}
              </Button>
            )}
            {data.blocked.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">
                  {t("bauFollow.followers.blocked")}
                </h3>
                <ul className="space-y-2">
                  {data.blocked.map((blocked) => (
                    <li
                      key={blocked.serverId}
                      className="flex items-center gap-3 rounded-[var(--radius-control)] border border-border bg-surface-1 px-3 py-2"
                      data-bau-follow-blocked-row
                    >
                      <p className="min-w-0 flex-1 truncate text-sm text-text">
                        {blocked.serverName}
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() =>
                          void act(
                            blocked.serverId,
                            () => unblockBauFollower(serverId, blocked.serverId),
                            (current) => ({
                              ...current,
                              blocked: current.blocked.filter(
                                (one) => one.serverId !== blocked.serverId,
                              ),
                            }),
                          )
                        }
                        data-bau-follow-unblock
                      >
                        {t("bauFollow.followers.unblock")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
