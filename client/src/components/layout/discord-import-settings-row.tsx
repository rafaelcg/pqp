import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchDiscordImportConfig } from "@/lib/api";
import { openDiscordImport } from "@/lib/discord-import-launcher";
import { useTranslation } from "@/lib/i18n";

/**
 * "Importar do Discord" in Server settings, for whoever manages the server.
 * Drawn only when the runtime flag `discord_import_existing` is on for THIS
 * server and the API says the viewer may use it (`GET
 * /api/servers/:id/discord-import/config`); anything else, including a failed
 * read, draws nothing, so the row never offers a door that would answer 404.
 *
 * It does not own a dialog: it calls `openDiscordImport({ serverId })`, the
 * same door a notice card uses, and `onBeforeOpen` lets settings step aside.
 */
export function DiscordImportSettingsRow({
  serverId,
  onBeforeOpen,
}: {
  serverId: string;
  onBeforeOpen?: () => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEnabled(false);
    void fetchDiscordImportConfig(serverId)
      .then((config) => {
        if (!cancelled) {
          setEnabled(config.enabled === true);
        }
      })
      .catch(() => {
        // Off is the safe reading: no row.
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  if (!enabled) {
    return null;
  }
  return (
    <section className="space-y-2" data-testid="discord-import-settings-row">
      <h4 className="font-display text-sm font-bold uppercase tracking-wider text-paper-muted">
        {t("importDiscordMerge.settings.title")}
      </h4>
      <p className="text-sm text-paper-muted">{t("importDiscordMerge.settings.body")}</p>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          onBeforeOpen?.();
          openDiscordImport({ serverId });
        }}
      >
        {t("importDiscordMerge.settings.button")}
      </Button>
    </section>
  );
}
