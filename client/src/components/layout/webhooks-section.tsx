import type { Webhook } from "@pqp/shared";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createWebhook, deleteWebhook, fetchWebhooks } from "@/lib/api";
import { getApiBaseUrl } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function WebhooksSection({
  open,
  channelId,
}: {
  open: boolean;
  channelId: string;
}) {
  const { t } = useTranslation();
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    setError(null);
    setWebhooks([]);
    setName("");
    setLoading(true);
    fetchWebhooks(channelId)
      .then((res) => {
        if (!cancelled) {
          setWebhooks(res.webhooks);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(messageOf(err, t("webhooks.loadFailed")));
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
  }, [open, channelId, t]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await createWebhook(channelId, { name: trimmed });
      setWebhooks((prev) => [...prev, res.webhook]);
      setName("");
    } catch (err) {
      setError(messageOf(err, t("webhooks.createFailed")));
    } finally {
      setCreating(false);
    }
  }

  async function remove(webhookId: string) {
    setBusyId(webhookId);
    setError(null);
    try {
      await deleteWebhook(webhookId);
      setWebhooks((prev) => prev.filter((w) => w.id !== webhookId));
    } catch (err) {
      setError(messageOf(err, t("webhooks.deleteFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function copyUrl(webhook: Webhook) {
    const fullUrl = `${getApiBaseUrl()}${webhook.url}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopiedId(webhook.id);
      window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError(t("webhooks.copyBlocked"));
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-paper-muted">{t("webhooks.description")}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Input
          value={name}
          placeholder={t("webhooks.namePlaceholder")}
          maxLength={80}
          aria-label={t("webhooks.nameAria")}
          disabled={creating}
          onChange={(event) => setName(event.target.value)}
        />
        <Button disabled={creating || !name.trim()} onClick={() => void create()}>
          {creating ? t("webhooks.creating") : t("webhooks.create")}
        </Button>
      </div>
      {loading && (
        <p role="status" aria-live="polite" className="text-sm text-paper-muted">
          {t("common.loading")}
        </p>
      )}
      {!loading && webhooks.length === 0 && !error && (
        <p className="text-sm text-paper-muted">{t("webhooks.empty")}</p>
      )}
      <ul className="space-y-2">
        {webhooks.map((webhook) => (
          <li
            key={webhook.id}
            className="rounded-md border border-ink-4 bg-ink-3/40 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium text-paper">
                {webhook.name}
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="w-[6.25rem] shrink-0 text-danger"
                disabled={busyId === webhook.id}
                onClick={() => void remove(webhook.id)}
              >
                {t("webhooks.delete")}
              </Button>
            </div>
            <div className="mt-2 flex gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-ink px-2 py-1 text-xs text-paper-muted">
                {getApiBaseUrl()}
                {webhook.url}
              </code>
              <Button
                size="sm"
                variant="secondary"
                className="w-[6.25rem] shrink-0"
                onClick={() => void copyUrl(webhook)}
              >
                {copiedId === webhook.id ? t("common.copied") : t("common.copy")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
