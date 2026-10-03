import { useEffect, useState } from "react";
import type { Server } from "@pqp/shared";
import { updateServerCommunityHomeConfig } from "@/lib/api";
import {
  isCommunityHomeSettingsNew,
  markCommunityHomeRowNew,
  markCommunityHomeSettingsSeen,
  shouldShowCommunityHomeSettingsNew,
} from "@/lib/community-home";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function CommunityHomeSettingsSection({
  serverId,
  enabled,
  onUpdated,
}: {
  serverId: string;
  enabled: boolean;
  onUpdated: (server: Server) => void;
}) {
  const { t } = useTranslation();
  const [checked, setChecked] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsNew, setSettingsNew] = useState(() =>
    isCommunityHomeSettingsNew(),
  );

  useEffect(() => {
    setChecked(enabled);
    setSettingsNew(isCommunityHomeSettingsNew());
  }, [enabled, serverId]);

  const showNew = shouldShowCommunityHomeSettingsNew({
    enabled: checked,
    settingsNew,
  });

  async function update(next: boolean) {
    setSaving(true);
    setError(null);
    // Acting on the control clears discovery; opening the panel alone must not.
    setSettingsNew(false);
    markCommunityHomeSettingsSeen();
    try {
      const result = await updateServerCommunityHomeConfig(serverId, {
        enabled: next,
      });
      setChecked(result.enabled);
      if (result.enabled) {
        markCommunityHomeRowNew(serverId);
      }
      onUpdated(result.server);
    } catch {
      setError(t("communityHome.settings.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2" data-community-home-settings>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={saving}
        onClick={() => void update(!checked)}
        className="flex w-full items-start justify-between gap-4 rounded-md px-2 py-2 text-left hover:bg-ink-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-sm text-paper">
            {t("communityHome.settings.title")}
            {showNew && (
              <span
                data-community-home-settings-new
                className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent"
              >
                {t("communityHome.badge.new")}
              </span>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-paper-muted">
            {t("communityHome.settings.helper")}
          </span>
        </span>
        <span
          aria-hidden
          className={cn(
            "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors duration-150",
            checked
              ? "bg-signal"
              : "bg-ink-3 ring-1 ring-inset ring-ink-4",
          )}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform duration-150",
              checked ? "translate-x-4 bg-ink" : "bg-paper-muted",
            )}
          />
        </span>
      </button>
      <p
        role="status"
        aria-live="polite"
        className="min-h-4 px-2 text-xs text-paper-muted"
      >
        {saving ? t("communityHome.settings.saving") : ""}
      </p>
      {error && (
        <p role="alert" className="px-2 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
