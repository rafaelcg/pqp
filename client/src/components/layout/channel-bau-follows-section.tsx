import type { BauFollow } from "@pqp/shared";
import { useState, type Dispatch, type SetStateAction } from "react";
import { ServerIcon } from "@/components/layout/server-identity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteBauFollow, updateBauFollow } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";

/**
 * "Seguindo" in a text channel's settings: the Baús this channel follows (see
 * `components/community-home/bau-follow.tsx` for where a follow is made), each
 * with Deixar de seguir, and Retomar when the follow paused itself after its
 * author lost the right to manage this channel. Drawn only when the channel
 * follows something, so a deployment where Seguir is off never shows it.
 */
export function ChannelBauFollowsSection({
  follows,
  onChange,
}: {
  follows: BauFollow[];
  onChange: Dispatch<SetStateAction<BauFollow[]>>;
}) {
  const { t } = useTranslation();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function unfollow(follow: BauFollow) {
    setBusyId(follow.id);
    setError(null);
    try {
      await deleteBauFollow(follow.id);
      onChange((current) => current.filter((one) => one.id !== follow.id));
    } catch {
      setError(t("bauFollow.error.action"));
    } finally {
      setBusyId(null);
    }
  }

  async function resume(follow: BauFollow) {
    setBusyId(follow.id);
    setError(null);
    try {
      const res = await updateBauFollow(follow.id, { resume: true });
      onChange((current) =>
        current.map((one) => (one.id === follow.id ? res.follow : one)),
      );
    } catch {
      setError(t("bauFollow.error.action"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4" data-channel-bau-follows>
      <p className="text-sm text-paper-muted">
        {t("bauFollow.channel.description")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {follows.map((follow) => (
          <li
            key={follow.id}
            className="flex items-center gap-3 rounded-md border border-ink-4 bg-ink-3/40 p-3"
            data-channel-bau-follow
          >
            <span className="h-9 w-9 shrink-0 overflow-hidden rounded-lg">
              <ServerIcon
                name={follow.sourceServerName}
                iconUrl={follow.sourceServerIconUrl}
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-paper">
                {t("bauFollow.channel.from", { server: follow.sourceServerName })}
              </p>
              {follow.rolePingName && (
                <p className="truncate text-xs text-paper-muted">
                  {t("bauFollow.pings", { role: follow.rolePingName })}
                </p>
              )}
              {follow.status === "paused" && (
                <p className="mt-0.5 text-xs text-warning">
                  {t("bauFollow.pausedHint")}
                </p>
              )}
            </div>
            {follow.status === "paused" && (
              <>
                <Badge variant="warning">{t("bauFollow.paused")}</Badge>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busyId !== null}
                  onClick={() => void resume(follow)}
                  data-channel-bau-follow-resume
                >
                  {t("bauFollow.resume")}
                </Button>
              </>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-danger"
              disabled={busyId !== null}
              onClick={() => void unfollow(follow)}
              data-channel-bau-follow-unfollow
            >
              {t("bauFollow.unfollow")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
