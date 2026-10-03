import { Ban } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  SettingsBuildLine,
  SettingsChoiceGrid,
  SettingsEmpty,
  SettingsGroup,
  SettingsInlineStatus,
  SettingsKeyCombo,
  SettingsLinkRow,
  SettingsNotice,
  SettingsPaneHeader,
  SettingsPreview,
  SettingsRow,
  SettingsSelect,
  SettingsSliderRow,
  SettingsSwitchRow,
  UnsavedChangesBar,
  useInlineSave,
} from "@/components/settings/kit";
import { useTranslation } from "@/lib/i18n";

/**
 * The settings kit on `/qa/ui`: every block a Settings tab is built from, on the
 * pane surface the dialog uses, so the light-theme group separation and the
 * keycap contrast can be judged before ten tabs are built on them.
 *
 * Light and dark cannot sit side by side: the role tokens live on `:root`, so a
 * subtree cannot be in the other brightness. The theme switcher at the top of
 * the page flips the whole sheet, this section included.
 */
export function SettingsKitSheet() {
  const { t } = useTranslation();
  const inputId = useId();
  const selectId = useId();
  const textareaId = useId();
  const [sounds, setSounds] = useState(true);
  const [volume, setVolume] = useState(100);
  const [brightness, setBrightness] = useState("dark");
  const [small, setSmall] = useState("light");
  const [chip, setChip] = useState("serverMembers");
  const [dm, setDm] = useState("serverMembers");
  const [look, setLook] = useState("signal");
  const save = useInlineSave();

  const themeOptions = (["light", "dark", "system"] as const).map((value) => ({
    value,
    label: t(`settings.appearance.theme.${value}`),
  }));
  const dmOptions = [
    {
      value: "everyone",
      label: t("settings.privacy.dm.everyone"),
      description: t("qaUi.kit.option.everyoneDescription"),
    },
    {
      value: "serverMembers",
      label: t("settings.privacy.dm.serverMembers"),
      description: t("qaUi.kit.option.serverMembersDescription"),
    },
    {
      value: "nobody",
      label: t("settings.privacy.dm.nobody"),
      description: t("qaUi.kit.option.nobodyDescription"),
      disabled: true,
    },
  ];
  const lookOptions = (["signal", "harmony", "hearth", "night"] as const).map(
    (value) => ({
      value,
      label: t(`settings.appearance.preset.${value}`),
      badge: value === "night" ? t("settings.appearance.preset.nightOnly") : undefined,
      preview: <Miniature />,
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="@container rounded-[var(--radius-panel)] border border-border bg-surface-1">
        <div className="mx-auto w-full max-w-[40rem] px-4 py-5 sm:px-8 sm:py-8">
          <SettingsPaneHeader
            title={t("qaUi.kit.pane.title")}
            description={t("qaUi.kit.pane.description")}
            actions={
              <Button variant="secondary" size="sm">
                {t("qaUi.kit.pane.action")}
              </Button>
            }
          />

          <div className="space-y-6">
            <SettingsGroup
              title={t("qaUi.kit.group.rows")}
              description={t("qaUi.kit.group.rowsDescription")}
            >
              <SettingsRow
                id="display-name"
                label={t("qaUi.kit.row.input")}
                htmlFor={inputId}
                stacked
                control={<Input id={inputId} defaultValue="Dev User" />}
              />
              <SettingsSwitchRow
                id="sounds"
                label={t("qaUi.kit.row.switch")}
                description={t("qaUi.kit.row.switchDescription")}
                checked={sounds}
                onCheckedChange={setSounds}
              />
              <SettingsSwitchRow
                id="sounds-disabled"
                label={t("qaUi.state.disabled")}
                description={t("qaUi.kit.row.disabledDescription")}
                checked={false}
                onCheckedChange={() => undefined}
                disabled
              />
              <SettingsSliderRow
                id="input-volume"
                label={t("qaUi.kit.row.slider")}
                value={volume}
                min={0}
                max={200}
                format={(value) => `${value}%`}
                onValueChange={setVolume}
              />
              <SettingsRow
                id="input-device"
                label={t("qaUi.kit.row.select")}
                htmlFor={selectId}
                badge={<KitBadge>{t("qaUi.kit.badge")}</KitBadge>}
                control={
                  <SettingsSelect id={selectId} defaultValue="default">
                    <option value="default">{t("qaUi.kit.row.selectDefault")}</option>
                    <option value="usb">USB Audio</option>
                  </SettingsSelect>
                }
              />
              <SettingsRow
                id="save-status"
                label={t("qaUi.kit.row.status")}
                description={t("qaUi.kit.row.statusDescription")}
                status={<SettingsInlineStatus state={save.state} />}
                control={
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        void save.run(
                          () => new Promise((resolve) => window.setTimeout(resolve, 800)),
                          t("settings.saveFailed"),
                        )
                      }
                    >
                      {t("qaUi.kit.row.statusRun")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void save.run(
                          () =>
                            new Promise((_, reject) =>
                              window.setTimeout(() => reject(new Error()), 800),
                            ),
                          t("settings.saveFailed"),
                        )
                      }
                    >
                      {t("qaUi.kit.row.statusFail")}
                    </Button>
                  </div>
                }
              />
              <SettingsRow
                id="description"
                label={t("qaUi.kit.row.textarea")}
                htmlFor={textareaId}
                stacked
                control={
                  <Textarea
                    id={textareaId}
                    placeholder={t("qaUi.kit.row.textareaPlaceholder")}
                  />
                }
              />
              <SettingsLinkRow
                id="ptt"
                label={t("qaUi.kit.row.linkInternal")}
                description={t("qaUi.kit.row.linkInternalDescription")}
                onClick={() => undefined}
              />
              <SettingsLinkRow
                id="terms"
                label={t("qaUi.kit.row.linkExternal")}
                href="/termos"
                external
              />
              <SettingsNotice tone="info" inGroup>
                {t("qaUi.kit.notice.info")}
              </SettingsNotice>
            </SettingsGroup>

            <SettingsGroup title={t("qaUi.kit.group.choices")}>
              <SettingsRow
                id="segmented"
                label={t("qaUi.kit.segmented")}
                control={
                  <RadioGroup
                    label={t("qaUi.kit.segmented")}
                    value={brightness}
                    onValueChange={setBrightness}
                    options={themeOptions}
                  />
                }
              />
              <SettingsRow
                id="segmented-small"
                label={t("qaUi.kit.segmentedSmall")}
                control={
                  <RadioGroup
                    label={t("qaUi.kit.segmentedSmall")}
                    size="sm"
                    value={small}
                    onValueChange={setSmall}
                    options={themeOptions.map((option) => ({
                      ...option,
                      disabled: option.value === "system",
                    }))}
                  />
                }
              />
              <SettingsRow
                id="chips"
                label={t("qaUi.kit.chips")}
                stacked
                control={
                  <RadioGroup
                    label={t("qaUi.kit.chips")}
                    variant="chips"
                    value={chip}
                    onValueChange={setChip}
                    options={dmOptions.map(({ value, label }) => ({ value, label }))}
                  />
                }
              />
            </SettingsGroup>

            <SettingsGroup
              title={t("qaUi.kit.list")}
              description={t("settings.privacy.dmLabel")}
            >
              <RadioGroup
                label={t("settings.privacy.dmLabel")}
                variant="list"
                value={dm}
                onValueChange={setDm}
                options={dmOptions}
              />
            </SettingsGroup>

            <SettingsGroup title={t("qaUi.kit.group.looks")} surface="plain">
              <SettingsChoiceGrid
                label={t("qaUi.kit.group.looks")}
                value={look}
                onValueChange={setLook}
                options={lookOptions}
                columns={4}
              />
            </SettingsGroup>

            <SettingsGroup title={t("qaUi.kit.group.preview")} surface="plain">
              <SettingsPreview
                summary={t("qaUi.kit.preview.summary")}
                controls={
                  <SettingsRow
                    id="preview-size"
                    label={t("qaUi.kit.segmentedSmall")}
                    control={
                      <RadioGroup
                        label={t("qaUi.kit.segmentedSmall")}
                        size="sm"
                        value={small}
                        onValueChange={setSmall}
                        options={themeOptions}
                      />
                    }
                  />
                }
              >
                <div className="flex items-start gap-3 p-4">
                  <span className="h-8 w-8 shrink-0 rounded-full bg-accent" />
                  <div className="min-w-0 space-y-2 pt-1">
                    <span className="block h-2.5 w-24 rounded-full bg-surface-3" />
                    <span className="block h-2.5 w-48 rounded-full bg-surface-3" />
                  </div>
                </div>
              </SettingsPreview>
            </SettingsGroup>

            <SettingsGroup title={t("qaUi.kit.group.keys")}>
              <SettingsRow
                id="open-search"
                label={t("qaUi.kit.row.keySearch")}
                control={<SettingsKeyCombo keys={["Ctrl", "K"]} label="Ctrl + K" />}
              />
              <SettingsRow
                id="mute"
                label={t("qaUi.kit.row.keyMute")}
                control={
                  <SettingsKeyCombo
                    keys={["Ctrl", "Shift", "M"]}
                    label="Ctrl + Shift + M"
                  />
                }
              />
            </SettingsGroup>

            <SettingsGroup title={t("qaUi.kit.group.notices")} surface="plain">
              <SettingsNotice tone="info">{t("qaUi.kit.notice.info")}</SettingsNotice>
              <SettingsNotice
                tone="warning"
                title={t("qaUi.kit.notice.warningTitle")}
                action={
                  <Button variant="secondary" size="sm">
                    {t("qaUi.kit.notice.action")}
                  </Button>
                }
              >
                {t("qaUi.kit.notice.warning")}
              </SettingsNotice>
              <SettingsNotice tone="danger">{t("qaUi.kit.notice.danger")}</SettingsNotice>
              <SettingsNotice tone="success">{t("qaUi.kit.notice.success")}</SettingsNotice>
            </SettingsGroup>

            <SettingsGroup title={t("qaUi.kit.group.empty")}>
              <SettingsEmpty
                icon={Ban}
                title={t("qaUi.kit.empty.title")}
                description={t("qaUi.kit.empty.description")}
              />
            </SettingsGroup>

            <SettingsGroup title={t("qaUi.kit.group.danger")}>
              <SettingsRow
                id="delete-account"
                label={t("qaUi.kit.row.delete")}
                description={t("qaUi.kit.row.deleteDescription")}
                control={
                  <Button variant="danger" size="sm">
                    {t("qaUi.kit.row.deleteAction")}
                  </Button>
                }
              />
            </SettingsGroup>

            <SettingsGroup title={t("qaUi.kit.group.build")} surface="plain">
              <SettingsBuildLine />
            </SettingsGroup>
          </div>
        </div>
      </div>

      <div className="grid gap-3">
        <BarSample label={t("qaUi.kit.bar.dirty")}>
          <UnsavedChangesBar visible saving={false} onDiscard={() => undefined} onSave={() => undefined} />
        </BarSample>
        <BarSample label={t("qaUi.kit.bar.saving")}>
          <UnsavedChangesBar visible saving onDiscard={() => undefined} onSave={() => undefined} />
        </BarSample>
        <BarSample label={t("qaUi.kit.bar.blocked")}>
          <UnsavedChangesBar
            visible
            saving={false}
            blocked
            onDiscard={() => undefined}
            onSave={() => undefined}
          />
        </BarSample>
        <BarSample label={t("qaUi.kit.bar.error")}>
          <UnsavedChangesBar
            visible
            saving={false}
            error={t("settings.saveFailed")}
            onDiscard={() => undefined}
            onSave={() => undefined}
          />
        </BarSample>
        <BarSample label={t("qaUi.kit.bar.saved")}>
          <UnsavedChangesBar
            visible
            saving={false}
            saved
            onDiscard={() => undefined}
            onSave={() => undefined}
          />
        </BarSample>
      </div>
    </div>
  );
}

/** A themed stand-in for a look's miniature. */
function Miniature() {
  return (
    <span className="flex h-16 overflow-hidden rounded-[var(--radius-control)] border border-border bg-surface-0">
      <span className="w-4 bg-rail" />
      <span className="flex flex-1 flex-col gap-1.5 bg-surface-1 p-2">
        <span className="h-1.5 w-10 rounded-full bg-surface-3" />
        <span className="h-1.5 w-14 rounded-full bg-surface-3" />
        <span className="mt-auto h-2 w-6 rounded-full bg-accent" />
      </span>
    </span>
  );
}

function KitBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-semibold text-on-accent-soft">
      {children}
    </span>
  );
}

function BarSample({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs text-text-tertiary">{label}</p>
      <div className="relative h-32 overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-1">
        {children}
      </div>
    </div>
  );
}

