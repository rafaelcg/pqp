import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useTranslation } from "@/lib/i18n";
import {
  addChannelMember,
  fetchChannelMembers,
  fetchMembers,
  removeChannelMember,
} from "@/lib/api";

interface Person {
  id: string;
  displayName: string;
  tag: string | null;
}

interface ChannelMembersPanelProps {
  open: boolean;
  channelId: string | null;
  channelName: string | null;
  serverId: string | null;
  onClose: () => void;
}

export function ChannelMembersPanel({
  open,
  channelId,
  channelName,
  serverId,
  onClose,
}: ChannelMembersPanelProps) {
  const { t } = useTranslation();
  const [channelMembers, setChannelMembers] = useState<Person[]>([]);
  const [serverMembers, setServerMembers] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !channelId || !serverId) {
      return;
    }
    let cancelled = false;
    setError(null);
    // Cleared up front: the component stays mounted between openings, so
    // without this the previous channel's access list shows while loading.
    setChannelMembers([]);
    setServerMembers([]);
    setLoading(true);

    async function load(channel: string, server: string) {
      try {
        const [channelRes, serverRes] = await Promise.all([
          fetchChannelMembers(channel),
          fetchMembers(server),
        ]);
        if (cancelled) {
          return;
        }
        setChannelMembers(
          channelRes.members.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            tag: m.tag,
          })),
        );
        setServerMembers(
          serverRes.members.map((m) => ({
            id: m.id,
            displayName: m.displayName,
            tag: m.tag,
          })),
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t("channelMembers.loadFailed"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load(channelId, serverId);
    return () => {
      cancelled = true;
    };
  }, [open, channelId, serverId]);

  const memberIds = useMemo(
    () => new Set(channelMembers.map((m) => m.id)),
    [channelMembers],
  );

  const candidates = serverMembers.filter((m) => !memberIds.has(m.id));

  async function addMember(userId: string) {
    if (!channelId) {
      return;
    }
    setBusyId(userId);
    setError(null);
    try {
      await addChannelMember(channelId, userId);
      const person = serverMembers.find((m) => m.id === userId);
      if (person) {
        setChannelMembers((prev) => [...prev, person]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelMembers.addFailed"));
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(userId: string) {
    if (!channelId) {
      return;
    }
    setBusyId(userId);
    setError(null);
    try {
      await removeChannelMember(channelId, userId);
      setChannelMembers((prev) => prev.filter((m) => m.id !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelMembers.removeFailed"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow={t("channelMembers.eyebrow")}
      title={`#${channelName ?? t("channelMembers.fallbackName")}`}
      description={t("channelMembers.description")}
      onClose={onClose}
    >
      <div className="space-y-5 p-4">
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        {loading && (
          <p className="text-sm text-paper-muted" role="status">
            {t("channelMembers.loading")}
          </p>
        )}

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
            {t("channelMembers.access", { count: channelMembers.length })}
          </h3>
          {channelMembers.length === 0 ? (
            <p className="text-sm text-paper-muted">
              {loading ? t("common.loading") : t("channelMembers.empty")}
            </p>
          ) : (
            channelMembers.map((member) => (
              <div
                key={member.id}
                className="mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink-3 text-xs font-semibold">
                  {member.displayName.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.displayName}
                  </p>
                  {member.tag && (
                    <p className="truncate font-mono text-[11px] text-paper-muted">
                      {member.tag}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("channelMembers.removeAria", {
                    name: member.displayName,
                  })}
                  disabled={busyId === member.id}
                  onClick={() => void removeMember(member.id)}
                >
                  {t("channelMembers.remove")}
                </Button>
              </div>
            ))
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
            {t("channelMembers.addFromServer")}
          </h3>
          {candidates.length === 0 ? (
            <p className="text-sm text-paper-muted">
              {t("channelMembers.everyoneHasAccess")}
            </p>
          ) : (
            candidates.map((member) => (
              <div
                key={member.id}
                className="mb-1 flex items-center gap-3 rounded-md px-2 py-2 hover:bg-ink-3"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-ink-3 text-xs font-semibold">
                  {member.displayName.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.displayName}
                  </p>
                  {member.tag && (
                    <p className="truncate font-mono text-[11px] text-paper-muted">
                      {member.tag}
                    </p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={t("channelMembers.addAria", {
                    name: member.displayName,
                  })}
                  disabled={busyId === member.id}
                  onClick={() => void addMember(member.id)}
                >
                  {t("channelMembers.add")}
                </Button>
              </div>
            ))
          )}
        </section>
      </div>
    </Dialog>
  );
}
