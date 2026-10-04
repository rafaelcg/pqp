// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsActionRow } from "@/components/settings/kit/action-row";
import { SettingsBadge } from "@/components/settings/kit/badge";
import { SettingsResult } from "@/components/settings/kit/result";
import { SettingsSkeletonRows } from "@/components/settings/kit/skeleton-row";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("settings kit blocks", () => {
  it("announces skeleton rows once and hides each row", () => {
    const doc = parse(
      renderToStaticMarkup(
        <SettingsSkeletonRows label="Carregando conexões" count={3} leading="tile" />,
      ),
    );
    const status = doc.querySelector('[role="status"]')!;
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(status.textContent).toBe("Carregando conexões");
    expect(status.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(3);
  });

  it("draws a badge as a chip beside a label", () => {
    expect(renderToStaticMarkup(<SettingsBadge>Novo</SettingsBadge>)).toContain(
      "bg-accent-soft",
    );
  });

  it("draws a result with its tone icon, a focusable title and an action", () => {
    const doc = parse(
      renderToStaticMarkup(
        <SettingsResult
          tone="success"
          title="Recebido. Obrigado!"
          action={<button type="button">Enviar outro</button>}
        />,
      ),
    );
    expect(doc.querySelector(".lucide-circle-check")).not.toBeNull();
    const title = doc.querySelector("[data-settings-result-title]")!;
    expect(title.getAttribute("tabindex")).toBe("-1");
    expect(title.textContent).toBe("Recebido. Obrigado!");
    expect(doc.querySelector("button")?.textContent).toBe("Enviar outro");
  });

  it("draws an action row with a note and no label", () => {
    const doc = parse(
      renderToStaticMarkup(
        <SettingsActionRow id="send" note="Vai junto: a versão do app." noteId="n1">
          <button type="button" aria-describedby="n1">
            Enviar
          </button>
        </SettingsActionRow>,
      ),
    );
    expect(doc.querySelector('[data-settings-row="send"]')).not.toBeNull();
    expect(doc.getElementById("n1")?.textContent).toBe("Vai junto: a versão do app.");
    expect(doc.querySelector("label")).toBeNull();
  });
});
