import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  findSettingsRow,
  listSettingsRows,
  registerSettingsRow,
  resetSettingsRowsForTest,
} from "@/components/settings/kit/registry";
import { SettingsLinkRow } from "@/components/settings/kit/link-row";
import { SettingsRow } from "@/components/settings/kit/row";
import { SettingsSectionContext } from "@/components/settings/kit/sections";
import { SettingsSliderRow } from "@/components/settings/kit/slider-row";
import { SettingsSwitchRow } from "@/components/settings/kit/switch-row";

afterEach(() => {
  resetSettingsRowsForTest();
});

describe("settings row registry", () => {
  it("records a row under the section the shell rendered it in", () => {
    const html = renderToStaticMarkup(
      <SettingsSectionContext.Provider value="voice">
        <SettingsRow id="input-device" label="Microfone" control={<span />} />
        <SettingsSwitchRow
          id="compact-peers"
          label="Lista compacta"
          checked={false}
          onCheckedChange={() => undefined}
        />
        <SettingsSliderRow
          id="input-volume"
          label="Volume de entrada"
          value={100}
          min={0}
          max={200}
          format={(value) => `${value}%`}
          onValueChange={() => undefined}
        />
        <SettingsLinkRow id="ptt" label="Push-to-talk" onClick={() => undefined} />
      </SettingsSectionContext.Provider>,
    );

    expect(html).toContain('data-settings-row="input-device"');
    expect(html).toContain('data-settings-row="ptt"');
    expect(listSettingsRows("voice").map((row) => row.id)).toEqual([
      "input-device",
      "compact-peers",
      "input-volume",
      "ptt",
    ]);
    expect(findSettingsRow("voice", "ptt")).toEqual({
      id: "ptt",
      section: "voice",
      label: "Push-to-talk",
    });
  });

  it("keeps the same id apart in two sections", () => {
    registerSettingsRow({ id: "reset", section: "keyboard", label: "Restaurar" });
    registerSettingsRow({ id: "reset", section: "appearance", label: "Voltar" });
    expect(findSettingsRow("keyboard", "reset")?.label).toBe("Restaurar");
    expect(findSettingsRow("appearance", "reset")?.label).toBe("Voltar");
    expect(listSettingsRows()).toHaveLength(2);
  });

  it("is idempotent, and the latest label wins", () => {
    registerSettingsRow({ id: "ptt", section: "voice", label: "Push to talk" });
    registerSettingsRow({ id: "ptt", section: "voice", label: "Push to talk" });
    registerSettingsRow({ id: "ptt", section: "voice", label: "Push-to-talk" });
    expect(listSettingsRows("voice")).toEqual([
      { id: "ptt", section: "voice", label: "Push-to-talk" },
    ]);
  });

  it("registers nothing outside the dialog", () => {
    renderToStaticMarkup(<SettingsRow id="loose" label="Solto" />);
    expect(listSettingsRows()).toEqual([]);
  });

  it("answers null for a row that never rendered", () => {
    expect(findSettingsRow("voice", "missing")).toBeNull();
  });

  it("leaves out a row that opts out, and still renders it", () => {
    const html = renderToStaticMarkup(
      <SettingsSectionContext.Provider value="privacy">
        <SettingsRow id="dm-privacy" label="Quem pode te mandar DM" />
        <SettingsRow
          id="blocked-0b8c"
          label="Fulano"
          searchable={false}
          data-blocked-user="0b8c"
        />
        <SettingsSliderRow
          id="dynamic-slider"
          label="Volume de Fulano"
          searchable={false}
          value={1}
          min={0}
          max={2}
          format={String}
          onValueChange={() => undefined}
        />
      </SettingsSectionContext.Provider>,
    );
    expect(html).toContain('data-settings-row="blocked-0b8c"');
    expect(html).toContain('data-blocked-user="0b8c"');
    expect(html).toContain("Fulano");
    expect(listSettingsRows("privacy").map((row) => row.id)).toEqual([
      "dm-privacy",
    ]);
  });
});
