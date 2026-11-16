import { SettingsGroup, SettingsSwitchRow } from "@/components/settings/kit";
import { useTranslation } from "@/lib/i18n";
import { setRedesignChoice, useRedesign } from "@/lib/redesign";

/**
 * Configurações, Beta: switches for things still being tested, each one this
 * person's own choice on this device.
 *
 * Novo visual is the redesign toggle (`lib/redesign.ts`). It applies at once,
 * with no save step, like the theme does.
 */
export function BetaSection() {
  const { t } = useTranslation();
  const redesign = useRedesign();
  return (
    <div className="flex flex-col gap-6" data-testid="beta-settings">
      <SettingsGroup id="beta-switches">
        <SettingsSwitchRow
          id="beta-redesign"
          label={t("settings.beta.redesign.label")}
          description={t("settings.beta.redesign.description")}
          checked={redesign}
          onCheckedChange={setRedesignChoice}
        />
      </SettingsGroup>
    </div>
  );
}
