import type { Channel } from "@pqp/shared";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, shareCommunityHomePost } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * "Share to a channel" on a Baú post. Posts a normal chat message carrying the
 * post's permalink, so the card appears wherever the link does. The chat's own
 * send path decides whether the caller may speak there; a refusal is shown in
 * the dialog, under the field, with what was typed still in it.
 */

function newNonce(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function shareErrorKey(error: unknown): MessageKey {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return "communityHome.share.error.cannotSend";
    }
    if (error.status === 429) {
      return "communityHome.share.error.slowMode";
    }
  }
  return "communityHome.share.error.generic";
}

export function CommunityHomeShareDialog({
  open,
  serverId,
  postId,
  channels,
  defaultChannelId,
  onClose,
  onShared,
}: {
  open: boolean;
  serverId: string;
  postId: string;
  /** Text channels the caller may speak in. */
  channels: readonly Channel[];
  defaultChannelId: string | null;
  onClose: () => void;
  onShared: (channel: Channel) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const selectId = useId();
  const [channelId, setChannelId] = useState(defaultChannelId ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per opening of the dialog. Chat de-duplicates on it, so a retry
  // after a lost response gets the message that already went out back instead
  // of a second card.
  const nonceRef = useRef("");
  // The channel list can change under an open dialog (a rename, a new
  // channel): initialise on open only, so a pending send stays pending and
  // what was typed stays typed.
  const initialRef = useRef({ channels, defaultChannelId });
  initialRef.current = { channels, defaultChannelId };

  useEffect(() => {
    if (open) {
      const initial = initialRef.current;
      setChannelId(initial.defaultChannelId ?? initial.channels[0]?.id ?? "");
      setMessage("");
      setBusy(false);
      setError(null);
      nonceRef.current = newNonce();
    }
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const target = channels.find((one) => one.id === channelId);
    if (!target || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await shareCommunityHomePost(serverId, postId, {
        channelId: target.id,
        message: message.trim() || null,
        nonce: nonceRef.current,
      });
      if (!result.ok) {
        setError(t("communityHome.share.error.generic"));
        return;
      }
      onShared(target);
    } catch (err) {
      setError(t(shareErrorKey(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      eyebrow={t("communityHome.title")}
      title={t("communityHome.share.title")}
      description={t("communityHome.share.hint")}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={busy || !channelId}
            data-home-share-send
          >
            {busy
              ? t("communityHome.share.sending")
              : t("communityHome.share.send")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => void submit(event)}
        className="space-y-3 px-5 py-4"
        data-home-share-dialog
      >
        {channels.length === 0 ? (
          <p className="text-sm text-text-secondary">
            {t("communityHome.share.noChannels")}
          </p>
        ) : (
          <>
            <label htmlFor={selectId} className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-tertiary">
                {t("communityHome.share.channel")}
              </span>
              <select
                id={selectId}
                value={channelId}
                onChange={(event) => {
                  setChannelId(event.target.value);
                  setError(null);
                }}
                disabled={busy}
                className="h-[var(--control-md)] w-full rounded-[var(--radius-control)] border border-border bg-surface-0 px-3 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset focus-visible:ring-focus-ring"
                data-home-share-channel
              >
                {channels.map((one) => (
                  <option key={one.id} value={one.id}>
                    # {one.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs uppercase tracking-wide text-text-tertiary">
                {t("communityHome.share.message")}
              </span>
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value.slice(0, 1500))}
                placeholder={t("communityHome.share.placeholder")}
                className="min-h-20"
                disabled={busy}
                data-home-share-message
              />
            </label>
          </>
        )}
        {error && (
          <p className="text-sm text-danger" role="alert" data-home-share-error>
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
