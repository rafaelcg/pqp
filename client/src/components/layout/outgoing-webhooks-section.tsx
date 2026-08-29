import type { Channel, OutgoingWebhook } from "@pqp/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  createOutgoingWebhook,
  deleteOutgoingWebhook,
  fetchChannels,
  fetchMembers,
  fetchOutgoingWebhooks,
  memberDisplayName,
  memberMatchesQuery,
  rotateOutgoingWebhookSecret,
  updateOutgoingWebhook,
  type ServerMember,
} from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const STATUS_KEYS: Record<OutgoingWebhook["status"], MessageKey> = {
  active: "integrations.status.active",
  disabled: "integrations.status.disabled",
  failing: "integrations.status.failing",
};

const AUTH_HEADER_OPTIONS = [
  "",
  "Authorization",
  "X-Webhook-Secret",
  "X-Api-Key",
] as const;

function messageOf(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

function formatWhen(iso: string | null, empty: string): string {
  if (!iso) {
    return empty;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return empty;
  }
  return date.toLocaleString();
}

export function OutgoingWebhooksSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [hooks, setHooks] = useState<OutgoingWebhook[]>([]);
  const [textChannels, setTextChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [channelIds, setChannelIds] = useState<string[]>([]);
  const [skipUserIds, setSkipUserIds] = useState<string[]>([]);
  const [authName, setAuthName] = useState("");
  const [authValue, setAuthValue] = useState("");
  const [creating, setCreating] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{
    id: string;
    secret: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editChannelIds, setEditChannelIds] = useState<string[]>([]);
  const [editSkipUserIds, setEditSkipUserIds] = useState<string[]>([]);
  const [memberQuery, setMemberQuery] = useState("");

  async function reload() {
    const [hookRes, channelRes, memberRes] = await Promise.all([
      fetchOutgoingWebhooks(serverId),
      fetchChannels(serverId),
      fetchMembers(serverId),
    ]);
    setHooks(hookRes.webhooks);
    setTextChannels(channelRes.channels.filter((channel) => channel.type === "text"));
    setMembers(memberRes.members);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void reload()
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(messageOf(err, t("integrations.loadFailed")));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on server change only
  }, [serverId]);

  function toggleChannel(id: string) {
    setChannelIds((prev) =>
      prev.includes(id) ? prev.filter((one) => one !== id) : [...prev, id],
    );
  }

  function toggleSkip(id: string) {
    setSkipUserIds((prev) =>
      prev.includes(id) ? prev.filter((one) => one !== id) : [...prev, id],
    );
  }

  function toggleEditChannel(id: string) {
    setEditChannelIds((prev) =>
      prev.includes(id) ? prev.filter((one) => one !== id) : [...prev, id],
    );
  }

  function toggleEditSkip(id: string) {
    setEditSkipUserIds((prev) =>
      prev.includes(id) ? prev.filter((one) => one !== id) : [...prev, id],
    );
  }

  function startEdit(hook: OutgoingWebhook) {
    setEditingId(hook.id);
    setEditName(hook.name);
    setEditUrl(hook.url);
    setEditChannelIds([...hook.channelIds]);
    setEditSkipUserIds([...hook.skipUserIds]);
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setError(t("integrations.copyBlocked"));
    }
  }

  async function create() {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName || !trimmedUrl || channelIds.length === 0) {
      return;
    }
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await createOutgoingWebhook(serverId, {
        name: trimmedName,
        url: trimmedUrl,
        channelIds,
        skipUserIds,
        authHeaderName: authName || null,
        authHeaderValue: authValue.trim() || null,
      });
      setHooks((prev) => [...prev, res.webhook]);
      setName("");
      setUrl("");
      setChannelIds([]);
      setSkipUserIds([]);
      setAuthName("");
      setAuthValue("");
      if (res.webhook.signingSecret) {
        setRevealedSecret({
          id: res.webhook.id,
          secret: res.webhook.signingSecret,
        });
      }
    } catch (err) {
      setError(messageOf(err, t("integrations.createFailed")));
    } finally {
      setCreating(false);
    }
  }

  async function saveEdit(hook: OutgoingWebhook) {
    const trimmedName = editName.trim();
    const trimmedUrl = editUrl.trim();
    if (!trimmedName || !trimmedUrl || editChannelIds.length === 0) {
      return;
    }
    setBusyId(hook.id);
    setError(null);
    try {
      const res = await updateOutgoingWebhook(hook.id, {
        name: trimmedName,
        url: trimmedUrl,
        channelIds: editChannelIds,
        skipUserIds: editSkipUserIds,
      });
      setHooks((prev) => prev.map((one) => (one.id === hook.id ? res.webhook : one)));
      setEditingId(null);
    } catch (err) {
      setError(messageOf(err, t("integrations.updateFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function setStatus(hook: OutgoingWebhook, status: "active" | "disabled") {
    setBusyId(hook.id);
    setError(null);
    try {
      const res = await updateOutgoingWebhook(hook.id, { status });
      setHooks((prev) => prev.map((one) => (one.id === hook.id ? res.webhook : one)));
    } catch (err) {
      setError(messageOf(err, t("integrations.updateFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function rotate(hook: OutgoingWebhook) {
    setBusyId(hook.id);
    setError(null);
    setCopied(false);
    try {
      const res = await rotateOutgoingWebhookSecret(hook.id);
      setHooks((prev) => prev.map((one) => (one.id === hook.id ? res.webhook : one)));
      if (res.webhook.signingSecret) {
        setRevealedSecret({
          id: res.webhook.id,
          secret: res.webhook.signingSecret,
        });
      }
    } catch (err) {
      setError(messageOf(err, t("integrations.rotateFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(hook: OutgoingWebhook) {
    setBusyId(hook.id);
    setError(null);
    try {
      await deleteOutgoingWebhook(hook.id);
      setHooks((prev) => prev.filter((one) => one.id !== hook.id));
      if (revealedSecret?.id === hook.id) {
        setRevealedSecret(null);
      }
    } catch (err) {
      setError(messageOf(err, t("integrations.deleteFailed")));
    } finally {
      setBusyId(null);
    }
  }

  const canCreate =
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    channelIds.length > 0 &&
    (!authName || authValue.trim().length > 0);

  return (
    <div className="space-y-6">
      <p className="text-sm text-paper-muted">{t("integrations.lead")}</p>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <section className="space-y-3">
        <h4 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
          {t("integrations.createTitle")}
        </h4>
        <Input
          value={name}
          maxLength={80}
          placeholder={t("integrations.namePlaceholder")}
          aria-label={t("integrations.nameLabel")}
          disabled={creating}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          value={url}
          placeholder={t("integrations.urlPlaceholder")}
          aria-label={t("integrations.urlLabel")}
          disabled={creating}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p className="text-xs text-paper-muted">{t("integrations.urlHint")}</p>

        <fieldset className="space-y-2">
          <legend className="text-sm text-paper">{t("integrations.channelsLabel")}</legend>
          {textChannels.length === 0 && !loading && (
            <p className="text-sm text-paper-muted">
              {t("integrations.channelsEmpty")}
            </p>
          )}
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {textChannels.map((channel) => (
              <li key={channel.id}>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-paper">
                  <input
                    type="checkbox"
                    checked={channelIds.includes(channel.id)}
                    onChange={() => toggleChannel(channel.id)}
                  />
                  <span className="min-w-0">{channel.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm text-paper">{t("integrations.skipLabel")}</legend>
          <p className="text-xs text-paper-muted">{t("integrations.skipHint")}</p>
          <Input
            value={memberQuery}
            placeholder={t("integrations.skipSearch")}
            aria-label={t("integrations.skipSearch")}
            disabled={creating}
            onChange={(e) => setMemberQuery(e.target.value)}
          />
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {members
              .filter(
                (member) =>
                  !memberQuery.trim() ||
                  memberMatchesQuery(member, memberQuery) ||
                  skipUserIds.includes(member.id),
              )
              .map((member) => (
                <li key={member.id}>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-paper">
                    <input
                      type="checkbox"
                      checked={skipUserIds.includes(member.id)}
                      onChange={() => toggleSkip(member.id)}
                    />
                    <span className="min-w-0 truncate">
                      {memberDisplayName(member)}
                      {member.tag ? ` (${member.tag})` : ""}
                    </span>
                  </label>
                </li>
              ))}
          </ul>
        </fieldset>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-sm text-paper">
            <span>{t("integrations.authNameLabel")}</span>
            <select
              value={authName}
              aria-label={t("integrations.authNameLabel")}
              disabled={creating}
              className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
              onChange={(e) => {
                setAuthName(e.target.value);
                if (!e.target.value) {
                  setAuthValue("");
                }
              }}
            >
              {AUTH_HEADER_OPTIONS.map((option) => (
                <option key={option || "none"} value={option}>
                  {option || t("integrations.authNone")}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm text-paper">
            <span>{t("integrations.authValueLabel")}</span>
            <Input
              value={authValue}
              type="password"
              autoComplete="off"
              disabled={creating || !authName}
              aria-label={t("integrations.authValueLabel")}
              placeholder={
                authName === "Authorization"
                  ? t("integrations.authValuePlaceholder")
                  : undefined
              }
              onChange={(e) => setAuthValue(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-paper-muted">{t("integrations.authHint")}</p>

        <Button
          disabled={creating || !canCreate}
          className="w-full sm:w-auto"
          onClick={() => void create()}
        >
          {creating ? t("integrations.creating") : t("integrations.create")}
        </Button>
      </section>

      {revealedSecret && (
        <section className="space-y-2 rounded-lg border border-signal/40 bg-signal/10 p-4">
          <h4 className="font-display text-sm font-bold uppercase tracking-wider text-paper">
            {t("integrations.secretTitle")}
          </h4>
          <p className="text-sm text-paper-muted">{t("integrations.secretOnce")}</p>
          <code className="block break-all rounded-md bg-ink px-3 py-2 text-xs text-paper">
            {revealedSecret.secret}
          </code>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              className="min-w-0 whitespace-nowrap"
              onClick={() => void copySecret(revealedSecret.secret)}
            >
              {copied ? t("integrations.secretCopied") : t("integrations.copySecret")}
            </Button>
            <Button
              variant="ghost"
              className="min-w-0 whitespace-nowrap"
              onClick={() => {
                setRevealedSecret(null);
                setCopied(false);
              }}
            >
              {t("integrations.secretDismiss")}
            </Button>
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h4 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
          {t("integrations.listTitle")}
        </h4>
        {loading && (
          <p className="text-sm text-paper-muted">{t("integrations.loading")}</p>
        )}
        {!loading && hooks.length === 0 && (
          <p className="text-sm text-paper-muted">{t("integrations.empty")}</p>
        )}
        <ul className="space-y-4">
          {hooks.map((hook) => (
            <li
              key={hook.id}
              className="space-y-3 rounded-lg border border-ink-4 p-4"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h5 className="min-w-0 text-sm font-semibold text-paper">
                  {hook.name}
                </h5>
                <span
                  className={cn(
                    "text-xs uppercase tracking-wider",
                    hook.status === "active" && "text-signal",
                    hook.status === "failing" && "text-danger",
                    hook.status === "disabled" && "text-paper-muted",
                  )}
                >
                  {t(STATUS_KEYS[hook.status])}
                </span>
              </div>
              <p className="break-all text-xs text-paper-muted">{hook.url}</p>
              {editingId === hook.id ? (
                <div className="space-y-3">
                  <Input
                    value={editName}
                    maxLength={80}
                    aria-label={t("integrations.nameLabel")}
                    disabled={busyId === hook.id}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                  <Input
                    value={editUrl}
                    aria-label={t("integrations.urlLabel")}
                    disabled={busyId === hook.id}
                    onChange={(e) => setEditUrl(e.target.value)}
                  />
                  <fieldset className="space-y-2">
                    <legend className="text-sm text-paper">
                      {t("integrations.channelsLabel")}
                    </legend>
                    <ul className="max-h-40 space-y-1 overflow-y-auto">
                      {textChannels.map((channel) => (
                        <li key={channel.id}>
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-paper">
                            <input
                              type="checkbox"
                              checked={editChannelIds.includes(channel.id)}
                              onChange={() => toggleEditChannel(channel.id)}
                            />
                            <span className="min-w-0">{channel.name}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                  <fieldset className="space-y-2">
                    <legend className="text-sm text-paper">
                      {t("integrations.skipLabel")}
                    </legend>
                    <ul className="max-h-40 space-y-1 overflow-y-auto">
                      {members.map((member) => (
                        <li key={member.id}>
                          <label className="flex cursor-pointer items-center gap-2 text-sm text-paper">
                            <input
                              type="checkbox"
                              checked={editSkipUserIds.includes(member.id)}
                              onChange={() => toggleEditSkip(member.id)}
                            />
                            <span className="min-w-0 truncate">
                              {memberDisplayName(member)}
                              {member.tag ? ` (${member.tag})` : ""}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      className="min-w-0 whitespace-nowrap"
                      disabled={
                        busyId === hook.id ||
                        !editName.trim() ||
                        !editUrl.trim() ||
                        editChannelIds.length === 0
                      }
                      onClick={() => void saveEdit(hook)}
                    >
                      {t("integrations.save")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="min-w-0 whitespace-nowrap"
                      disabled={busyId === hook.id}
                      onClick={() => setEditingId(null)}
                    >
                      {t("integrations.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="text-xs text-paper-muted">
                    {t("integrations.channelsSummary", {
                      names:
                        textChannels
                          .filter((channel) => hook.channelIds.includes(channel.id))
                          .map((channel) => channel.name)
                          .join(", ") || t("integrations.channelsUnknown"),
                    })}
                  </p>
                  {hook.skipUsers.length > 0 && (
                    <p className="text-xs text-paper-muted">
                      {t("integrations.skipSummary", {
                        names: hook.skipUsers
                          .map((user) => user.tag || user.displayName)
                          .join(", "),
                      })}
                    </p>
                  )}
                </>
              )}
              <p className="text-xs text-paper-muted">
                {t("integrations.secretHint", { hint: hook.secretHint })}
              </p>
              <p className="text-xs text-paper-muted">
                {t("integrations.lastDelivery")}:{" "}
                {formatWhen(hook.lastDeliveredAt, t("integrations.neverDelivered"))}
              </p>
              {hook.lastError && (
                <p className="text-xs text-danger">
                  {t("integrations.lastError")}: {hook.lastError}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-w-0 whitespace-nowrap"
                  disabled={busyId === hook.id}
                  onClick={() =>
                    editingId === hook.id ? setEditingId(null) : startEdit(hook)
                  }
                >
                  {editingId === hook.id
                    ? t("integrations.cancel")
                    : t("integrations.edit")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-w-0 whitespace-nowrap"
                  disabled={busyId === hook.id}
                  onClick={() => void rotate(hook)}
                >
                  {t("integrations.rotate")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-w-0 whitespace-nowrap"
                  disabled={busyId === hook.id}
                  onClick={() =>
                    void setStatus(
                      hook,
                      hook.status === "disabled" ? "active" : "disabled",
                    )
                  }
                >
                  {hook.status === "disabled"
                    ? t("integrations.enable")
                    : t("integrations.disable")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  className="min-w-0 whitespace-nowrap"
                  disabled={busyId === hook.id}
                  onClick={() => void remove(hook)}
                >
                  {t("integrations.delete")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
