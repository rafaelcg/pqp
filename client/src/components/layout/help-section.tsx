import { Check, Copy, ExternalLink, Mail } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  buildContactMailto,
  collectHelpDiagnostics,
  CONTACT_EMAIL,
  GITHUB_ISSUES_URL,
} from "@/lib/help-contact";
import { useTranslation, type MessageKey } from "@/lib/i18n";

const LINK_CLASS =
  "inline-flex items-center gap-1 text-signal underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 rounded-sm";

const LEGAL_LINKS: { href: string; label: MessageKey }[] = [
  { href: "/terms", label: "settings.data.terms" },
  { href: "/privacy", label: "settings.data.privacy" },
  { href: "/cookies", label: "settings.data.cookies" },
];

/**
 * "Ajuda e contato": the way to reach the two of us from inside the app.
 * Email only, opened in the person's own mail client: there is no form and no
 * endpoint behind it. The mail arrives with a few non-sensitive facts they can
 * read and delete first (`lib/help-contact.ts`). Abuse reports are a different
 * door and are not here.
 */
export function HelpSection({ onOpenFeedback }: { onOpenFeedback?: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const mailto = useMemo(
    () =>
      buildContactMailto(collectHelpDiagnostics(), {
        subject: t("help.mail.subject"),
        intro: t("help.mail.intro"),
        diagnosticsHeading: t("help.mail.diagnostics"),
        labels: {
          app: t("help.mail.app"),
          platform: t("help.mail.platform"),
          browser: t("help.mail.browser"),
          language: t("help.mail.language"),
        },
      }),
    [t],
  );

  const copy = () => {
    void navigator.clipboard
      ?.writeText(CONTACT_EMAIL)
      .then(() => {
        setCopied(true);
        if (timer.current) {
          clearTimeout(timer.current);
        }
        timer.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="space-y-6" data-help-section>
      <p className="text-sm text-paper-muted">{t("help.intro")}</p>

      <div className="space-y-3 rounded-md border border-ink-4 p-4">
        <p className="text-xs uppercase tracking-wide text-paper-muted">{t("help.email.label")}</p>
        <p className="break-all text-base font-medium text-paper">{CONTACT_EMAIL}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href={mailto}>
              <Mail className="h-3.5 w-3.5" aria-hidden />
              {t("help.email.write")}
            </a>
          </Button>
          <Button variant="secondary" size="sm" onClick={copy}>
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
            {copied ? t("help.email.copied") : t("help.email.copy")}
          </Button>
          <span role="status" className="sr-only">
            {copied ? t("help.email.copied") : ""}
          </span>
        </div>
        <p className="text-xs text-paper-muted">{t("help.email.attached")}</p>
      </div>

      <p className="text-sm text-paper-muted">{t("help.response")}</p>

      <div className="space-y-2">
        <p className="text-sm font-medium text-paper">{t("help.bug.title")}</p>
        <ul className="flex flex-col gap-1.5 text-sm">
          {onOpenFeedback && (
            <li>
              <button type="button" className={LINK_CLASS} onClick={onOpenFeedback}>
                {t("help.bug.feedback")}
              </button>
            </li>
          )}
          <li>
            <a href={GITHUB_ISSUES_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {t("help.bug.github")}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </li>
          <li>
            <a href="/status" target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {t("help.status")}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          </li>
        </ul>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-paper">{t("help.legal.title")}</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
          {LEGAL_LINKS.map((link) => (
            <li key={link.href}>
              <a href={link.href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                {t(link.label)}
              </a>
            </li>
          ))}
        </ul>
      </div>

      <p className="text-xs text-paper-muted">{t("help.reports")}</p>
    </div>
  );
}
