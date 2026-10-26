import { useEffect, useState } from "react";
import type { Server } from "@pqp/shared";
import {
  fetchBauFollowers,
  updateBauFollowConfig,
  updateServerCommunityHomeConfig,
} from "@/lib/api";
import {
  isCommunityHomeSettingsNew,
  markCommunityHomeRowNew,
  markCommunityHomeSettingsSeen,
  shouldShowCommunityHomeSettingsNew,
} from "@/lib/community-home";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "@/lib/i18n";
import { notifyBauFollowConfigChanged } from "./bau-follow";

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

  // Seguir: the owner's own switch, shown only where the feature is switched on
  // for this server (the read says `flagOn`) and the Baú itself is on.
  const [followFlagOn, setFollowFlagOn] = useState(false);
  const [followAllowed, setFollowAllowed] = useState(false);
  const [followSaving, setFollowSaving] = useState(false);
  const [followError, setFollowError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFollowFlagOn(false);
    if (!enabled) {
      return;
    }
    fetchBauFollowers(serverId)
      .then((res) => {
        if (!cancelled) {
          setFollowFlagOn(res.flagOn);
          setFollowAllowed(res.allowed);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverId, enabled]);

  async function updateFollow(next: boolean) {
    setFollowSaving(true);
    setFollowError(false);
    try {
      const res = await updateBauFollowConfig(serverId, next);
      setFollowAllowed(res.allowed);
      notifyBauFollowConfigChanged(serverId);
    } catch {
      setFollowError(true);
    } finally {
      setFollowSaving(false);
    }
  }

  const showNew = shouldShowCommunityHomeSettingsNew({
    enabled: checked,
    settingsNew,
  });

  async function update(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const result = await updateServerCommunityHomeConfig(serverId, {
        enabled: next,
      });
      // A successful flip clears discovery; opening the panel alone, or a
      // failed request, must not.
      setSettingsNew(false);
      markCommunityHomeSettingsSeen();
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
      <Switch
        checked={checked}
        onCheckedChange={(next) => void update(next)}
        busy={saving}
        dimRowWhenDisabled
        label={t("communityHome.settings.title")}
        labelAdornment={
          showNew ? (
            <span
              data-community-home-settings-new
              className="shrink-0 rounded bg-accent/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-accent"
            >
              {t("communityHome.badge.new")}
            </span>
          ) : null
        }
        description={t("communityHome.settings.helper")}
      />
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
      {enabled && followFlagOn && (
        <>
          <Switch
            data-bau-follow-allow=""
            checked={followAllowed}
            onCheckedChange={(next) => void updateFollow(next)}
            busy={followSaving}
            dimRowWhenDisabled
            label={t("bauFollow.settings.title")}
            description={t("bauFollow.settings.helper")}
          />
          {followError && (
            <p role="alert" className="px-2 text-sm text-danger">
              {t("communityHome.settings.failed")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
