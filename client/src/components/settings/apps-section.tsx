import { PuzzlePiece } from "@phosphor-icons/react";
import { Puzzle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  SettingsEmpty,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsRow,
  useSettingsAnnounce,
} from "@/components/settings/kit";
import {
  consentName,
  consentNotice,
  loadAppConsents,
  revokeApp,
  useAppConsents,
  type AppConsent,
} from "@/lib/apps/consents";
import { useTranslation } from "@/lib/i18n";

/**
 * Configurações, Apps: every app this person accepted, what it sees, and a way
 * to take it back (mock 04: "a escolha fica guardada na conta, e dá pra rever
 * em Configurações, Apps").
 *
 * Revoking is quiet and immediate: no confirmation, because nothing is lost.
 * The next Entrar into that app shows the join sheet again, and an app that was
 * let see its id stops getting it from the next roster on.
 */

export function AppsSection() {
  const { t, locale } = useTranslation();
  const { consents, loading } = useAppConsents();
  const announce = useSettingsAnnounce();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  // A fresh read on opening: the list may have changed on another device.
  useEffect(() => {
    void loadAppConsents();
  }, []);

  async function revoke(consent: AppConsent) {
    setBusy(consent.appId);
    setFailed(null);
    try {
      await revokeApp(consent.appId);
      announce?.(t("apps.settings.revoked", { app: consentName(consent, locale) }));
    } catch {
      setFailed(consent.appId);
    } finally {
      setBusy(null);
    }
  }

  const list = consents ?? [];

  return (
    <div className="flex flex-col gap-6" data-testid="apps-settings">
      <SettingsGroup
        id="apps-accepted"
        title={t("apps.settings.title")}
        description={t("apps.settings.intro")}
      >
        {list.length === 0 ? (
          <SettingsEmpty
            icon={Puzzle}
            glyph={PuzzlePiece}
            title={loading && consents === null ? t("apps.settings.loading") : t("apps.settings.empty")}
            description={loading && consents === null ? undefined : t("apps.settings.emptyHint")}
          />
        ) : (
          list.map((consent) => {
            const name = consentName(consent, locale);
            const notice = consentNotice(consent, locale);
            return (
              <SettingsRow
                key={consent.appId}
                id={`apps-${consent.appId}`}
                label={name}
                searchable={false}
                keepInline
                leading={
                  <span
                    aria-hidden
                    className="grid h-9 w-9 place-items-center rounded-[var(--radius-control)] bg-accent-soft text-on-accent-soft"
                  >
                    <Puzzle className="h-4 w-4" />
                  </span>
                }
                description={
                  <>
                    <span className="block">{t("apps.settings.sees")}</span>
                    <span className="block">
                      {consent.identityGranted
                        ? t("apps.settings.seesId")
                        : t("apps.settings.notId")}
                    </span>
                    {notice ? <span className="block">{notice}</span> : null}
                    {consent.stale ? (
                      <span className="block text-warning">{t("apps.settings.stale")}</span>
                    ) : null}
                  </>
                }
                status={
                  failed === consent.appId ? (
                    <SettingsInlineStatus state={{ kind: "error", message: t("apps.settings.revokeFailed") }} />
                  ) : undefined
                }
                control={
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    aria-disabled={busy === consent.appId || undefined}
                    aria-label={t("apps.settings.revokeLabel", { app: name })}
                    onClick={() => {
                      if (busy === null) void revoke(consent);
                    }}
                  >
                    {t("apps.settings.revoke")}
                  </Button>
                }
              />
            );
          })
        )}
      </SettingsGroup>
    </div>
  );
}
