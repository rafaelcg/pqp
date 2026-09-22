import { Check, Copy, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { browserShareCapabilities } from "@/lib/share-handle";
import {
  shareInvite,
  shareInviteText,
  shareInviteUrl,
  type InvitePasteKind,
  type InviteRef,
} from "@/lib/share-invite";
import { cn } from "@/lib/utils";

const COPY_MS = 1600;

/**
 * Two ready pastes for an invite: a short Discord line and a longer
 * WhatsApp sentence. One copy button each. On phones, a native share
 * sheet as well.
 */
export function InvitePaste({
  code,
  inviteRef = "convite",
  className,
  onCopyFailed,
}: {
  code: string;
  /** The `?ref=` tag on the link; `discord` right after an import. */
  inviteRef?: InviteRef;
  className?: string;
  onCopyFailed?: () => void;
}) {
  const { t, locale } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  const origin =
    typeof window === "undefined" ? "https://pqp.gg" : window.location.origin;
  const url = shareInviteUrl(origin, code, inviteRef);
  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );

  function markCopied(key: string) {
    setCopied(key);
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
    }
    copyTimer.current = window.setTimeout(() => setCopied(null), COPY_MS);
  }

  async function copyKind(kind: InvitePasteKind) {
    try {
      await navigator.clipboard.writeText(shareInviteText(kind, locale, url));
      markCopied(kind);
    } catch {
      onCopyFailed?.();
    }
  }

  async function handleShare() {
    const outcome = await shareInvite(
      "long",
      locale,
      url,
      browserShareCapabilities(),
    );
    if (outcome === "copied") {
      markCopied("share");
    } else if (outcome === "failed") {
      onCopyFailed?.();
    }
  }

  return (
    <div
      data-invite-paste=""
      className={cn(
        "space-y-3 rounded-lg border border-border bg-surface-2/40 p-3",
        className,
      )}
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
        {t("invite.paste.title")}
      </h3>
      <PasteRow
        label={t("invite.paste.short")}
        text={shareInviteText("short", locale, url)}
        copied={copied === "short"}
        copyLabel={t("invite.paste.copy")}
        copiedLabel={t("invite.paste.copied")}
        onCopy={() => void copyKind("short")}
      />
      <PasteRow
        label={t("invite.paste.long")}
        text={shareInviteText("long", locale, url)}
        copied={copied === "long"}
        copyLabel={t("invite.paste.copy")}
        copiedLabel={t("invite.paste.copied")}
        onCopy={() => void copyKind("long")}
      />
      {canShare && (
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={() => void handleShare()}
        >
          {copied === "share" ? (
            <Check className="h-4 w-4 text-success" />
          ) : (
            <Share2 className="h-4 w-4" />
          )}
          {copied === "share"
            ? t("invite.paste.copied")
            : t("invite.paste.share")}
        </Button>
      )}
      <p className="text-xs leading-snug text-text-tertiary">
        {t("invite.paste.phones")}
      </p>
    </div>
  );
}

function PasteRow({
  label,
  text,
  copied,
  copyLabel,
  copiedLabel,
  onCopy,
}: {
  label: string;
  text: string;
  copied: boolean;
  copyLabel: string;
  copiedLabel: string;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <p className="min-w-0 flex-1 rounded-md border border-border bg-surface-1 px-3 py-2 text-sm leading-snug text-text">
          {text}
        </p>
        <Button
          type="button"
          variant="secondary"
          className="h-auto min-h-[var(--control-md)] min-w-[6.5rem] shrink-0"
          onClick={onCopy}
        >
          {copied ? (
            <Check className="h-4 w-4 text-success" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
          {copied ? copiedLabel : copyLabel}
        </Button>
      </div>
    </div>
  );
}
