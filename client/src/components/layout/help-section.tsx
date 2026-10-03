import { Check, Copy, Mail } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  SettingsGroup,
  SettingsLinkRow,
  SettingsNotice,
  SettingsRow,
  formatBuildLine,
  useSettingsShell,
} from "@/components/settings/kit";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  buildContactMailto,
  collectHelpDiagnostics,
  CONTACT_EMAIL,
  GITHUB_ISSUES_URL,
} from "@/lib/help-contact";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/** How long the check mark replaces the copy icon. */
const COPIED_MS = 2000;

const LEGAL_LINKS: { id: string; href: string; label: MessageKey }[] = [
  { id: "privacy", href: "/privacy", label: "settings.data.privacy" },
  { id: "terms", href: "/terms", label: "settings.data.terms" },
  { id: "cookies", href: "/cookies", label: "settings.data.cookies" },
];

/**
 * An icon-only ghost button that copies `text`. The icon turns into a check
 * for two seconds and a live region says so. With no clipboard (plain http, an
 * old webview) the click does nothing and the text beside it stays selectable.
 */
function CopyButton({
  text,
  label,
  copiedLabel,
}: {
  text: string;
  label: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <Tooltip label={label}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-[var(--control-sm)] shrink-0 px-0"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(text)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          {copied ? (
            <Check aria-hidden className="h-3.5 w-3.5 animate-icon-swap text-success" />
          ) : (
            <Copy aria-hidden className="h-3.5 w-3.5" />
          )}
        </Button>
      </Tooltip>
      {/* Always mounted, so the change is announced. */}
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}

/**
 * "Ajuda e contato": the way to reach the two of us from inside the app.
 * Email only, opened in the person's own mail client: there is no form and no
 * endpoint behind it. The mail arrives with a few non-sensitive facts they can
 * read and delete first (`lib/help-contact.ts`). Abuse reports are a different
 * door and are not here.
 */
export function HelpSection({ onOpenFeedback }: { onOpenFeedback?: () => void }) {
  const { t } = useTranslation();
  const { openSection } = useSettingsShell();
  const buildLine = formatBuildLine();

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

  return (
    <div className="space-y-6" data-help-section>
      <SettingsGroup title={t("help.contact.title")} description={t("help.response")}>
        <SettingsRow
          id="email"
          label={CONTACT_EMAIL}
          description={t("help.email.attached")}
          control={
            <div className="flex items-center gap-2">
              <CopyButton
                text={CONTACT_EMAIL}
                label={t("help.email.copy")}
                copiedLabel={t("help.email.copied")}
              />
              <Button asChild size="sm">
                <a href={mailto}>
                  <Mail aria-hidden className="h-3.5 w-3.5" />
                  {t("help.email.write")}
                </a>
              </Button>
            </div>
          }
        />
        <SettingsRow
          id="version"
          label={t("help.version.label")}
          description={t("help.version.hint")}
          control={
            <div className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 break-all font-mono text-xs text-text-secondary">
                {buildLine}
              </span>
              <CopyButton
                text={buildLine}
                label={t("help.version.copy")}
                copiedLabel={t("help.version.copied")}
              />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("help.bug.title")}>
        <SettingsLinkRow
          id="feedback"
          label={t("help.bug.feedback")}
          onClick={onOpenFeedback ?? (() => openSection("feedback"))}
        />
        <SettingsLinkRow id="github" label={t("help.bug.github")} href={GITHUB_ISSUES_URL} external />
        <SettingsLinkRow id="status" label={t("help.status")} href="/status" external />
      </SettingsGroup>

      <SettingsGroup title={t("help.legal.title")}>
        {LEGAL_LINKS.map((link) => (
          <SettingsLinkRow
            key={link.id}
            id={link.id}
            label={t(link.label)}
            href={link.href}
            external
          />
        ))}
      </SettingsGroup>

      <SettingsGroup surface="plain">
        <SettingsNotice tone="info">{t("help.reports")}</SettingsNotice>
      </SettingsGroup>
    </div>
  );
}
