import { Mail } from "lucide-react";
import { useMemo } from "react";
import {
  SettingsBuildLine,
  SettingsCopyButton,
  SettingsGroup,
  SettingsLinkRow,
  SettingsNotice,
  SettingsRow,
  useSettingsShell,
} from "@/components/settings/kit";
import { Button } from "@/components/ui/button";
import { BUILD_ID, DEV_BUILD_ID } from "@/lib/build-info";
import {
  buildContactMailto,
  collectHelpDiagnostics,
  CONTACT_EMAIL,
  GITHUB_ISSUES_URL,
} from "@/lib/help-contact";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * The commit the mail names: the same seven characters the "Versão do app"
 * row shows, so a pasted row and the mail's diagnostics agree.
 */
const MAIL_APP_VERSION = BUILD_ID === DEV_BUILD_ID ? DEV_BUILD_ID : BUILD_ID.slice(0, 7);

const LEGAL_LINKS: { id: string; href: string; label: MessageKey }[] = [
  { id: "privacy", href: "/privacy", label: "settings.data.privacy" },
  { id: "terms", href: "/terms", label: "settings.data.terms" },
  { id: "cookies", href: "/cookies", label: "settings.data.cookies" },
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
  const { openSection } = useSettingsShell();

  const mailto = useMemo(
    () =>
      buildContactMailto(collectHelpDiagnostics({ appVersion: MAIL_APP_VERSION }), {
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
              <SettingsCopyButton
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
          control={<SettingsBuildLine variant="row" />}
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
        <SettingsNotice tone="info" role="note">{t("help.reports")}</SettingsNotice>
      </SettingsGroup>
    </div>
  );
}
