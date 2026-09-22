import { Check, Copy, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Invite } from "@pqp/shared";
import { Button } from "@/components/ui/button";
import { InvitePaste } from "@/components/layout/invite-paste";
import { useTranslation } from "@/lib/i18n";
import { shareInviteUrl, type InviteRef } from "@/lib/share-invite";
import { cn } from "@/lib/utils";

/**
 * The invite, in hand, the moment a room exists.
 *
 * ONE PANEL, TWO DOORS INTO IT. The first-run wizard's last step ("Sala
 * pronta") and the create dialog's done screen (from scratch or from a Discord
 * import) render this, so an organizer sees the same thing whichever way they
 * made the room. Before it existed the wizard's own "Criar" ended in an empty
 * #general with the invite two hidden clicks away behind the server menu,
 * while the import path had all of this. The campaign line is "Manda o
 * convite. Pronto." and the product's own wizard never handed over the convite.
 *
 * WHAT IS THE HERO. The link row. It is the one artefact that moves a group,
 * so it is the biggest thing on the step, it copies with one tap, and a copy
 * answers three ways at once: the icon turns into a check, a ring of the
 * accent swells off the box, and a line underneath says what to do next. The
 * pastes ("Traz a galera") sit under it for the people who want the sentence
 * as well as the link.
 *
 * THE LINK DISPLAYED IS NOT QUITE THE LINK COPIED. The box shows
 * `pqp.gg/app/invite/<code>`, which fits a phone; the clipboard gets the full
 * `https://…?ref=<tag>` so the join it brings is counted
 * (`server_members.join_ref`).
 */

const COPY_MS = 1600;

export interface ServerReadyPanelProps {
  /** Null when minting the invite failed; the panel offers a retry. */
  invite: Invite | null;
  /** The `?ref=` the link carries: `onboarding`, `discord` or `convite`. */
  inviteRef: InviteRef;
  retrying?: boolean;
  onRetry: () => void;
  /** Something landed on the clipboard (or in a share sheet). */
  onCopied?: (kind: "link" | "short" | "long" | "share") => void;
  onCopyFailed?: () => void;
  /** Show the "good for 7 days" line. The wizard does; a custom invite would not. */
  showNote?: boolean;
}

/** `https://pqp.gg/app/invite/abc?ref=x` → `pqp.gg/app/invite/abc`. */
function displayLink(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "");
}

export function ServerReadyPanel({
  invite,
  inviteRef,
  retrying = false,
  onRetry,
  onCopied,
  onCopyFailed,
  showNote = true,
}: ServerReadyPanelProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  /** Bumped per copy so the flash replays on a second tap. */
  const [flash, setFlash] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
      }
    },
    [],
  );

  if (!invite) {
    return (
      <div className="space-y-3 rounded-[var(--radius-card)] border border-border bg-surface-1 p-4">
        <p className="text-sm text-text-secondary">
          {t("invite.done.inviteFailed")}
        </p>
        <Button
          type="button"
          variant="secondary"
          disabled={retrying}
          onClick={onRetry}
        >
          {t("invite.done.retryInvite")}
        </Button>
      </div>
    );
  }

  const url = shareInviteUrl(window.location.origin, invite.code, inviteRef);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      onCopyFailed?.();
      return;
    }
    setCopied(true);
    setFlash((n) => n + 1);
    onCopied?.("link");
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
    }
    timer.current = window.setTimeout(() => setCopied(false), COPY_MS);
  }

  return (
    <div className="space-y-4" data-server-ready="">
      <div className="animate-pop-in">
        <p className="mb-1.5 text-xs font-medium text-text-secondary">
          {t("onboarding.ready.link")}
        </p>
        <div className="relative">
          {/* The flash: a sibling layer, so the row itself never moves under
              the pointer that just pressed it. Keyed on the copy count so a
              second tap replays it. Invisible at rest and under reduced
              motion (where the animation is off and opacity stays 0). */}
          {flash > 0 && (
            <span
              key={flash}
              aria-hidden="true"
              className="animate-copy-flash pointer-events-none absolute inset-0 rounded-[var(--radius-card)] border-2 border-accent opacity-0"
            />
          )}
          <div
            className={cn(
              "flex items-center gap-2 rounded-[var(--radius-card)] border bg-surface-0 p-1.5 pl-3 transition-colors duration-[var(--duration-base)]",
              copied ? "border-accent" : "border-border",
            )}
          >
            <Link2
              aria-hidden="true"
              className="h-4 w-4 shrink-0 text-text-tertiary"
            />
            <span
              data-invite-link=""
              title={url}
              className="min-w-0 flex-1 select-all truncate font-mono text-sm text-accent"
            >
              {displayLink(url)}
            </span>
            <Button
              type="button"
              data-copy-invite-link=""
              variant={copied ? "secondary" : "default"}
              className="min-w-[7.5rem] shrink-0"
              onClick={() => void copyLink()}
            >
              <span className="relative flex h-4 w-4 items-center justify-center">
                {copied ? (
                  <Check
                    key="check"
                    aria-hidden="true"
                    className="animate-icon-swap h-4 w-4 text-success"
                  />
                ) : (
                  <Copy key="copy" aria-hidden="true" className="h-4 w-4" />
                )}
              </span>
              {copied ? t("onboarding.ready.copied") : t("onboarding.ready.copyLink")}
            </Button>
          </div>
        </div>
        {/* What to do with it, said the moment it is on the clipboard. Kept
            in the flow at a fixed height so the pastes below never jump. */}
        <p
          aria-live="polite"
          className="mt-2 flex min-h-5 items-center gap-1.5 text-xs text-text-tertiary"
        >
          {copied ? (
            <span className="animate-door-reveal font-medium text-success">
              {t("onboarding.ready.copiedToast")}
            </span>
          ) : showNote ? (
            <span>{t("onboarding.ready.note")}</span>
          ) : null}
        </p>
      </div>

      <InvitePaste
        code={invite.code}
        inviteRef={inviteRef}
        className="animate-pop-in [animation-delay:80ms]"
        onCopied={(kind) => onCopied?.(kind)}
        onCopyFailed={onCopyFailed}
      />
    </div>
  );
}
