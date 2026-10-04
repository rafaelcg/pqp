import { Bug } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsNotice } from "@/components/settings/kit/notice";

describe("SettingsNotice", () => {
  it("sets no border width of its own inside a group", () => {
    // Any border-width utility here would cancel the group's divide-y line.
    for (const tone of ["info", "warning", "danger", "success"] as const) {
      const html = renderToStaticMarkup(
        <SettingsNotice tone={tone} inGroup>
          x
        </SettingsNotice>,
      );
      expect(html).not.toMatch(/class="[^"]*\bborder(-0)?\b(?!-)/);
    }
  });

  it("outlines an info notice standing on its own", () => {
    const html = renderToStaticMarkup(<SettingsNotice tone="info">x</SettingsNotice>);
    expect(html).toContain("border border-border");
  });

  it("takes an icon and a role override", () => {
    const html = renderToStaticMarkup(
      <SettingsNotice tone="info" icon={Bug} role="note">
        x
      </SettingsNotice>,
    );
    expect(html).toContain("lucide-bug");
    expect(html).toContain('role="note"');
    expect(
      renderToStaticMarkup(
        <SettingsNotice tone="warning" role="alert">
          x
        </SettingsNotice>,
      ),
    ).toContain('role="alert"');
  });
});
