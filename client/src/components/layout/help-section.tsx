import { ExternalLink, Mail } from "lucide-react";
import { useMemo } from "react";
import { SignOutButton } from "@/components/layout/sign-out-button";
import {
  formatBuildLine,
  SettingsBuildLine,
  SettingsCopyButton,
  SettingsGroup,
  SettingsLinkRow,
  SettingsNotice,
  SettingsRow,
  useSettingsShell,
} from "@/components/settings/kit";
import { Button } from "@/components/ui/button";
import {
  buildContactMailto,
  collectHelpDiagnostics,
  CONTACT_EMAIL,
  GITHUB_ISSUES_URL,
} from "@/lib/help-contact";
import { useTranslation, type MessageKey } from "@/lib/i18n";

const LEGAL_LINKS: { id: string; href: string; label: MessageKey }[] = [
  { id: "privacy", href: "/privacy", label: "settings.data.privacy" },
  { id: "terms", href: "/terms", label: "settings.data.terms" },
  { id: "cookies", href: "/cookies", label: "settings.data.cookies" },
];

/**
 * Gmail's compose window with the same subject and body as the `mailto:`, for
 * people who read mail on the web and have no mail app registered, where the
 * `mailto:` link does nothing. Built from the `mailto:` itself so the two can
 * never say different things.
 */
export function gmailComposeUrl(mailto: string): string {
  const query = new URLSearchParams(mailto.slice(mailto.indexOf("?") + 1));
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    to: CONTACT_EMAIL,
    su: query.get("subject") ?? "",
    body: query.get("body") ?? "",
  });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

/**
 * "Ajuda e contato": the way to reach the two of us from inside the app.
 * Email only, opened in the person's own mail client (or Gmail on the web):
 * there is no form and no endpoint behind it. The mail arrives with a few
 * non-sensitive facts they can read and delete first (`lib/help-contact.ts`).
 * Abuse reports are a different door and are not here, and the notice right
 * under the address says so.
 */
export function HelpSection({ onOpenFeedback }: { onOpenFeedback?: () => void }) {
  const { t } = useTranslation();
  const { openSection } = useSettingsShell();

  const mailto = useMemo(
    () =>
      buildContactMailto(
        // The mail names the build exactly as the "Versão do app" row prints
        // it, so a pasted row and the mail's diagnostics are the same string.
        { ...collectHelpDiagnostics(), appVersion: formatBuildLine() },
        {
          subject: t("help.mail.subject"),
          intro: t("help.mail.intro"),
          diagnosticsHeading: t("help.mail.diagnostics"),
          labels: {
            app: t("help.mail.app"),
            platform: t("help.mail.platform"),
            browser: t("help.mail.browser"),
            language: t("help.mail.language"),
          },
        },
      ),
    [t],
  );
  const gmail = useMemo(() => gmailComposeUrl(mailto), [mailto]);

  return (
    <div className="space-y-6" data-help-section>
      <SettingsGroup title={t("help.contact.title")} description={t("help.response")}>
        <SettingsRow
          id="email"
          label={CONTACT_EMAIL}
          badge={
            <SettingsCopyButton
              showLabel
              text={CONTACT_EMAIL}
              label={t("help.email.copy")}
              copiedLabel={t("help.email.copied")}
              className="h-10"
            />
          }
          description={t("help.email.attached")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm">
              <a href={mailto}>
                <Mail aria-hidden className="h-3.5 w-3.5" />
                {t("help.email.write")}
              </a>
            </Button>
            <Button asChild size="sm" variant="secondary">
              <a href={gmail} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden className="h-3.5 w-3.5" />
                {t("help.email.gmail")}
              </a>
            </Button>
          </div>
          <p className="mt-3 text-xs text-pretty text-text-tertiary">
            {t("help.email.fallback")}
          </p>
        </SettingsRow>
        <SettingsNotice tone="info" role="note" inGroup>
          {t("help.reports")}
        </SettingsNotice>
        <SettingsRow
          id="version"
          label={t("help.version.label")}
          description={t("help.version.hint")}
          control={
            <SettingsBuildLine
              variant="row"
              className="min-h-9 border border-border bg-surface-2 px-3 py-1"
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("help.bug.title")}>
        <SettingsLinkRow
          id="feedback"
          label={t("help.bug.feedback")}
          description={t("help.bug.feedbackHint")}
          onClick={onOpenFeedback ?? (() => openSection("feedback"))}
        />
        <SettingsLinkRow
          id="github"
          label={t("help.bug.github")}
          description={t("help.bug.githubHint")}
          href={GITHUB_ISSUES_URL}
          external
        />
        <SettingsLinkRow
          id="status"
          label={t("help.status")}
          description={t("help.statusHint")}
          href="/status"
          external
        />
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

      {/* On a phone the rail, and the account card with its sign out, is out of
          sight; the end of Ajuda is where the way out lives. */}
      <div className="sm:hidden" data-help-sign-out>
        <SignOutButton className="w-full" />
      </div>
    </div>
  );
}
