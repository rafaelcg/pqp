// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsGroup } from "@/components/settings/kit/group";
import { SettingsRow } from "@/components/settings/kit/row";

function rowElement(html: string): Element {
  const host = new DOMParser().parseFromString(html, "text/html").body;
  return host.querySelector("[data-settings-row]")!;
}

describe("SettingsRow layout options", () => {
  it("draws the leading slot before the label, inside the row", () => {
    const row = rowElement(
      renderToStaticMarkup(
        <SettingsRow
          id="blocked-1"
          label="Fulano"
          leading={<img alt="" data-avatar="" />}
          control={<button type="button">Desbloquear</button>}
        />,
      ),
    );
    const avatar = row.querySelector("[data-avatar]")!;
    const label = [...row.querySelectorAll("span")].find(
      (span) => span.textContent === "Fulano",
    )!;
    expect(avatar).not.toBeNull();
    expect(
      avatar.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("stacks below @lg by default and keeps a small control inline when asked", () => {
    const plain = rowElement(
      renderToStaticMarkup(<SettingsRow id="a" label="A" control={<span />} />),
    );
    expect(plain.className).toContain("@lg:flex-row");
    expect(plain.className).not.toMatch(/(^| )flex-row/);

    const inline = rowElement(
      renderToStaticMarkup(
        <SettingsRow id="b" label="B" keepInline control={<span />} />,
      ),
    );
    expect(inline.className).toMatch(/(^| )flex-row/);

    const stackedWins = rowElement(
      renderToStaticMarkup(
        <SettingsRow id="c" label="C" keepInline stacked control={<span />} />,
      ),
    );
    expect(stackedWins.className).not.toMatch(/flex-row/);
  });

  it("lets a wide control past the 55% cap", () => {
    const row = rowElement(
      renderToStaticMarkup(
        <SettingsRow id="d" label="D" wideControl control={<span data-c="" />} />,
      ),
    );
    const control = row.querySelector("[data-c]")!.parentElement!;
    expect(control.className).toContain("@lg:max-w-full");
    expect(control.className).not.toContain("55%");
  });

  it("gives a group a row id openSection can land on", () => {
    const html = renderToStaticMarkup(
      <SettingsGroup id="ptt" title="Modo de entrada">
        <span />
      </SettingsGroup>,
    );
    expect(html).toContain('<section data-settings-row="ptt"');
  });
});
