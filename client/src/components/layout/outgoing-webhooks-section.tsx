import type { Channel, OutgoingWebhook } from "@pqp/shared";
import { Check, ChevronDown, Copy, Hash, Plus, Webhook } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { UserAvatar } from "@/components/user/user-avatar";
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatRelative(iso: string, locale: string): string {
  const deltaSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale === "pt-BR" ? "pt-BR" : "en", {
    numeric: "auto",
  });
  const abs = Math.abs(deltaSec);
  if (abs < 45) {
    return rtf.format(-Math.round(deltaSec), "second");
  }
  if (abs < 3600) {
    return rtf.format(-Math.round(deltaSec / 60), "minute");
  }
  if (abs < 86400) {
    return rtf.format(-Math.round(deltaSec / 3600), "hour");
  }
  return rtf.format(-Math.round(deltaSec / 86400), "day");
}

type Draft = {
  name: string;
  url: string;
  channelIds: string[];
  skipUserIds: string[];
  authName: string;
  authValue: string;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  url: "",
  channelIds: [],
  skipUserIds: [],
  authName: "",
  authValue: "",
};

function draftFromHook(hook: OutgoingWebhook): Draft {
  return {
    name: hook.name,
    url: hook.url,
    channelIds: [...hook.channelIds],
    skipUserIds: [...hook.skipUserIds],
    authName: hook.authHeaderName ?? "",
    authValue: "",
  };
}

function ChannelChips({
  channels,
  selected,
  disabled,
  empty,
  onToggle,
}: {
  channels: Channel[];
  selected: string[];
  disabled?: boolean;
  empty: string;
  onToggle: (id: string) => void;
}) {
  if (channels.length === 0) {
    return <p className="text-sm text-paper-muted">{empty}</p>;
  }
  return (
    <ul className="flex flex-wrap gap-2">
      {channels.map((channel) => {
        const on = selected.includes(channel.id);
        return (
          <li key={channel.id}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => onToggle(channel.id)}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60",
                on
                  ? "border-signal/45 bg-signal/12 text-paper"
                  : "border-ink-4 bg-ink text-paper-muted hover:bg-ink-3 hover:text-paper",
                disabled && "opacity-50",
              )}
            >
              <Hash className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{channel.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SkipPicker({
  members,
  selected,
  query,
  disabled,
  searchLabel,
  onQuery,
  onToggle,
}: {
  members: ServerMember[];
  selected: string[];
  query: string;
  disabled?: boolean;
  searchLabel: string;
  onQuery: (value: string) => void;
  onToggle: (id: string) => void;
}) {
  const visible = members.filter(
    (member) =>
      !query.trim() ||
      memberMatchesQuery(member, query) ||
      selected.includes(member.id),
  );
  return (
    <div className="space-y-2">
      <Input
        value={query}
        placeholder={searchLabel}
        aria-label={searchLabel}
        disabled={disabled}
        className="h-9 rounded-xl border-0 bg-ink-2"
        onChange={(e) => onQuery(e.target.value)}
      />
      <ul className="max-h-48 overflow-y-auto rounded-2xl bg-ink-2">
        {visible.map((member) => {
          const shown = memberDisplayName(member);
          return (
            <li key={member.id}>
              <div className="flex items-center gap-2 px-1">
                <UserAvatar
                  name={shown}
                  avatarUrl={member.avatarUrl}
                  className="h-7 w-7 shrink-0"
                  fallbackClassName="bg-ink-3 text-[10px]"
                  rounded="full"
                />
                <Switch
                  className="min-w-0 flex-1"
                  checked={selected.includes(member.id)}
                  disabled={disabled}
                  label={
                    member.tag ? `${shown} (${member.tag})` : shown
                  }
                  onCheckedChange={() => onToggle(member.id)}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HookForm({
  draft,
  textChannels,
  members,
  memberQuery,
  disabled,
  submitLabel,
  busyLabel,
  busy,
  showAuthValueRequired,
  authHint,
  onChange,
  onMemberQuery,
  onSubmit,
  onCancel,
}: {
  draft: Draft;
  textChannels: Channel[];
  members: ServerMember[];
  memberQuery: string;
  disabled?: boolean;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  showAuthValueRequired: boolean;
  authHint?: string | null;
  onChange: (next: Draft) => void;
  onMemberQuery: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [showSkip, setShowSkip] = useState(draft.skipUserIds.length > 0);
  const [showAuth, setShowAuth] = useState(
    Boolean(draft.authName || authHint),
  );
  const canSubmit =
    draft.name.trim().length > 0 &&
    draft.url.trim().length > 0 &&
    draft.channelIds.length > 0 &&
    (!draft.authName || draft.authValue.trim().length > 0 || !showAuthValueRequired);

  function toggleChannel(id: string) {
    onChange({
      ...draft,
      channelIds: draft.channelIds.includes(id)
        ? draft.channelIds.filter((one) => one !== id)
        : [...draft.channelIds, id],
    });
  }

  function toggleSkip(id: string) {
    onChange({
      ...draft,
      skipUserIds: draft.skipUserIds.includes(id)
        ? draft.skipUserIds.filter((one) => one !== id)
        : [...draft.skipUserIds, id],
    });
  }

  return (
    <div className="space-y-5">
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-paper-muted">
          {t("integrations.nameLabel")}
        </span>
        <Input
          value={draft.name}
          maxLength={80}
          placeholder={t("integrations.namePlaceholder")}
          aria-label={t("integrations.nameLabel")}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-paper-muted">
          {t("integrations.urlLabel")}
        </span>
        <Input
          value={draft.url}
          placeholder={t("integrations.urlPlaceholder")}
          aria-label={t("integrations.urlLabel")}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, url: e.target.value })}
        />
        <span className="block text-xs text-paper-muted">
          {t("integrations.urlHint")}
        </span>
      </label>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-paper-muted">
          {t("integrations.channelsLabel")}
        </legend>
        <ChannelChips
          channels={textChannels}
          selected={draft.channelIds}
          disabled={disabled}
          empty={t("integrations.channelsEmpty")}
          onToggle={toggleChannel}
        />
      </fieldset>

      <div className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md py-1 text-left text-sm text-paper hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          aria-expanded={showSkip}
          onClick={() => setShowSkip((open) => !open)}
        >
          <span>{t("integrations.skipLabel")}</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-paper-muted transition-transform",
              showSkip && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        {showSkip && (
          <div className="space-y-2">
            <p className="text-xs text-paper-muted">{t("integrations.skipHint")}</p>
            <SkipPicker
              members={members}
              selected={draft.skipUserIds}
              query={memberQuery}
              disabled={disabled}
              searchLabel={t("integrations.skipSearch")}
              onQuery={onMemberQuery}
              onToggle={toggleSkip}
            />
          </div>
        )}
      </div>

      <div className="space-y-2">
        <button
          type="button"
          className="flex w-full items-center justify-between rounded-md py-1 text-left text-sm text-paper hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          aria-expanded={showAuth}
          onClick={() => setShowAuth((open) => !open)}
        >
          <span>{t("integrations.authNameLabel")}</span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-paper-muted transition-transform",
              showAuth && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        {showAuth && (
          <div className="space-y-2">
            {authHint && !draft.authValue && (
              <p className="text-xs text-paper-muted">
                {t("integrations.authKept", { hint: authHint })}
              </p>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm text-paper">
                <span className="text-xs font-medium text-paper-muted">
                  {t("integrations.authNameLabel")}
                </span>
                <select
                  value={draft.authName}
                  aria-label={t("integrations.authNameLabel")}
                  disabled={disabled}
                  className="h-10 w-full rounded-md border border-ink-4 bg-ink px-3 text-sm text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/50 disabled:opacity-50"
                  onChange={(e) =>
                    onChange({
                      ...draft,
                      authName: e.target.value,
                      authValue: e.target.value ? draft.authValue : "",
                    })
                  }
                >
                  {AUTH_HEADER_OPTIONS.map((option) => (
                    <option key={option || "none"} value={option}>
                      {option || t("integrations.authNone")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5 text-sm text-paper">
                <span className="text-xs font-medium text-paper-muted">
                  {t("integrations.authValueLabel")}
                </span>
                <Input
                  value={draft.authValue}
                  type="password"
                  autoComplete="off"
                  disabled={disabled || !draft.authName}
                  aria-label={t("integrations.authValueLabel")}
                  placeholder={
                    draft.authName === "Authorization"
                      ? t("integrations.authValuePlaceholder")
                      : undefined
                  }
                  onChange={(e) =>
                    onChange({ ...draft, authValue: e.target.value })
                  }
                />
              </label>
            </div>
            <p className="text-xs text-paper-muted">{t("integrations.authHint")}</p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          className="min-w-0 whitespace-nowrap"
          disabled={busy || !canSubmit}
          onClick={onSubmit}
        >
          {busy ? busyLabel : submitLabel}
        </Button>
        <Button
          variant="ghost"
          className="min-w-0 whitespace-nowrap"
          disabled={busy}
          onClick={onCancel}
        >
          {t("integrations.cancel")}
        </Button>
      </div>
    </div>
  );
}

export function OutgoingWebhooksSection({ serverId }: { serverId: string }) {
  const { t, locale } = useTranslation();
  const [hooks, setHooks] = useState<OutgoingWebhook[]>([]);
  const [textChannels, setTextChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{
    id: string;
    secret: string;
  } | null>(null);
  const [copied, setCopied] = useState<"secret" | "url" | null>(null);
  const [copiedUrlId, setCopiedUrlId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY_DRAFT);
  const [memberQuery, setMemberQuery] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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

  const channelName = useMemo(() => {
    const map = new Map(textChannels.map((channel) => [channel.id, channel.name]));
    return (id: string) => map.get(id);
  }, [textChannels]);

  async function copyText(value: string, kind: "secret" | "url", hookId?: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      if (kind === "url" && hookId) {
        setCopiedUrlId(hookId);
        window.setTimeout(() => {
          setCopiedUrlId((current) => (current === hookId ? null : current));
        }, 1600);
      }
    } catch {
      setError(t("integrations.copyBlocked"));
    }
  }

  function closeComposer() {
    setComposing(false);
    setDraft(EMPTY_DRAFT);
    setMemberQuery("");
  }

  async function create() {
    const trimmedName = draft.name.trim();
    const trimmedUrl = draft.url.trim();
    if (!trimmedName || !trimmedUrl || draft.channelIds.length === 0) {
      return;
    }
    setCreating(true);
    setError(null);
    setCopied(null);
    try {
      const res = await createOutgoingWebhook(serverId, {
        name: trimmedName,
        url: trimmedUrl,
        channelIds: draft.channelIds,
        skipUserIds: draft.skipUserIds,
        authHeaderName: draft.authName || null,
        authHeaderValue: draft.authValue.trim() || null,
      });
      setHooks((prev) => [...prev, res.webhook]);
      closeComposer();
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

  function startEdit(hook: OutgoingWebhook) {
    setEditingId(hook.id);
    setEditDraft(draftFromHook(hook));
    setConfirmDeleteId(null);
    setMemberQuery("");
  }

  async function saveEdit(hook: OutgoingWebhook) {
    const trimmedName = editDraft.name.trim();
    const trimmedUrl = editDraft.url.trim();
    if (!trimmedName || !trimmedUrl || editDraft.channelIds.length === 0) {
      return;
    }
    setBusyId(hook.id);
    setError(null);
    try {
      const authChanged =
        editDraft.authName !== (hook.authHeaderName ?? "") ||
        editDraft.authValue.trim().length > 0;
      const res = await updateOutgoingWebhook(hook.id, {
        name: trimmedName,
        url: trimmedUrl,
        channelIds: editDraft.channelIds,
        skipUserIds: editDraft.skipUserIds,
        ...(authChanged
          ? editDraft.authName
            ? {
                authHeaderName: editDraft.authName,
                authHeaderValue: editDraft.authValue.trim(),
              }
            : { authHeaderName: null, authHeaderValue: null }
          : {}),
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
    setCopied(null);
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
    if (confirmDeleteId !== hook.id) {
      setConfirmDeleteId(hook.id);
      return;
    }
    setBusyId(hook.id);
    setError(null);
    try {
      await deleteOutgoingWebhook(hook.id);
      setHooks((prev) => prev.filter((one) => one.id !== hook.id));
      setConfirmDeleteId(null);
      if (revealedSecret?.id === hook.id) {
        setRevealedSecret(null);
      }
      if (editingId === hook.id) {
        setEditingId(null);
      }
    } catch (err) {
      setError(messageOf(err, t("integrations.deleteFailed")));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-paper-muted">{t("integrations.incomingHint")}</p>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {revealedSecret && (
        <section className="space-y-3 rounded-2xl border border-signal/35 bg-signal/10 p-4">
          <div>
            <h4 className="text-sm font-semibold text-paper">
              {t("integrations.secretTitle")}
            </h4>
            <p className="mt-1 text-sm text-paper-muted">
              {t("integrations.secretOnce")}
            </p>
          </div>
          <code className="block break-all rounded-xl bg-ink px-3 py-2.5 font-mono text-xs text-paper">
            {revealedSecret.secret}
          </code>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              className="min-w-0 whitespace-nowrap"
              onClick={() => void copyText(revealedSecret.secret, "secret")}
            >
              {copied === "secret"
                ? t("integrations.secretCopied")
                : t("integrations.copySecret")}
            </Button>
            <Button
              variant="ghost"
              className="min-w-0 whitespace-nowrap"
              onClick={() => {
                setRevealedSecret(null);
                setCopied(null);
              }}
            >
              {t("integrations.secretDismiss")}
            </Button>
          </div>
        </section>
      )}

      <div className="flex items-center justify-between gap-3">
        <h4 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
          {t("integrations.listTitle")}
        </h4>
        {!composing && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() => {
              setComposing(true);
              setEditingId(null);
              setDraft(EMPTY_DRAFT);
              setMemberQuery("");
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t("integrations.add")}
          </Button>
        )}
      </div>

      {composing && (
        <section className="rounded-2xl border border-ink-4 bg-ink-2/60 p-4">
          <h5 className="mb-4 text-sm font-semibold text-paper">
            {t("integrations.createTitle")}
          </h5>
          <HookForm
            draft={draft}
            textChannels={textChannels}
            members={members}
            memberQuery={memberQuery}
            disabled={creating}
            submitLabel={t("integrations.create")}
            busyLabel={t("integrations.creating")}
            busy={creating}
            showAuthValueRequired
            onChange={setDraft}
            onMemberQuery={setMemberQuery}
            onSubmit={() => void create()}
            onCancel={closeComposer}
          />
        </section>
      )}

      {loading && (
        <p className="text-sm text-paper-muted">{t("integrations.loading")}</p>
      )}

      {!loading && hooks.length === 0 && !composing && (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-ink-4 bg-ink-2/40 px-6 py-10 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-ink-3 text-paper-muted">
            <Webhook className="h-5 w-5" aria-hidden />
          </span>
          <p className="mt-3 text-sm font-medium text-paper">
            {t("integrations.empty")}
          </p>
          <p className="mt-1 max-w-sm text-xs text-paper-muted">
            {t("integrations.emptyHint")}
          </p>
          <Button
            className="mt-4"
            onClick={() => {
              setComposing(true);
              setDraft(EMPTY_DRAFT);
            }}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {t("integrations.add")}
          </Button>
        </div>
      )}

      <ul className="space-y-3">
        {hooks.map((hook) => {
          const editing = editingId === hook.id;
          const channelNames = hook.channelIds
            .map((id) => channelName(id))
            .filter((name): name is string => Boolean(name));
          return (
            <li
              key={hook.id}
              className="space-y-3 rounded-2xl border border-ink-4 bg-ink-2/40 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h5 className="truncate text-sm font-semibold text-paper">
                    {hook.name}
                  </h5>
                  <button
                    type="button"
                    className="mt-0.5 flex max-w-full items-center gap-1.5 text-xs text-paper-muted hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
                    title={hook.url}
                    onClick={() => void copyText(hook.url, "url", hook.id)}
                  >
                    <span className="truncate">{hostOf(hook.url)}</span>
                    {copiedUrlId === hook.id ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-signal" aria-hidden />
                    ) : (
                      <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="sr-only">{t("integrations.copyUrl")}</span>
                  </button>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide",
                    hook.status === "active" && "bg-signal/15 text-signal",
                    hook.status === "failing" && "bg-danger/15 text-danger",
                    hook.status === "disabled" && "bg-ink-3 text-paper-muted",
                  )}
                >
                  {t(STATUS_KEYS[hook.status])}
                </span>
              </div>

              {editing ? (
                <HookForm
                  draft={editDraft}
                  textChannels={textChannels}
                  members={members}
                  memberQuery={memberQuery}
                  disabled={busyId === hook.id}
                  submitLabel={t("integrations.save")}
                  busyLabel={t("integrations.save")}
                  busy={busyId === hook.id}
                  showAuthValueRequired={
                    Boolean(editDraft.authName) &&
                    editDraft.authName !== (hook.authHeaderName ?? "")
                  }
                  authHint={hook.authHeaderHint}
                  onChange={setEditDraft}
                  onMemberQuery={setMemberQuery}
                  onSubmit={() => void saveEdit(hook)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {channelNames.length > 0
                      ? channelNames.map((name) => (
                          <span
                            key={name}
                            className="inline-flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-xs text-paper-muted"
                          >
                            <Hash className="h-3 w-3" aria-hidden />
                            {name}
                          </span>
                        ))
                      : (
                          <span className="text-xs text-paper-muted">
                            {t("integrations.channelsUnknown")}
                          </span>
                        )}
                    {hook.skipUsers.map((user) => (
                      <span
                        key={user.id}
                        className="inline-flex items-center rounded-full bg-ink px-2 py-0.5 text-xs text-paper-muted"
                      >
                        {t("integrations.skipChip", {
                          name: user.tag || user.displayName,
                        })}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-paper-muted">
                    {hook.lastDeliveredAt
                      ? t("integrations.delivered", {
                          when: formatRelative(hook.lastDeliveredAt, locale),
                        })
                      : t("integrations.neverDelivered")}
                  </p>
                  {hook.lastError && (
                    <p className="rounded-xl bg-danger/10 px-3 py-2 text-xs text-danger">
                      {hook.lastError}
                    </p>
                  )}
                </>
              )}

              {!editing && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-w-0 whitespace-nowrap"
                  disabled={busyId === hook.id}
                  onClick={() => startEdit(hook)}
                >
                  {t("integrations.edit")}
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
                  {confirmDeleteId === hook.id
                    ? t("integrations.deleteConfirm")
                    : t("integrations.delete")}
                </Button>
              </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
