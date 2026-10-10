// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsChoiceGrid } from "@/components/settings/kit/choice-grid";

describe("SettingsChoiceGrid", () => {
  it("draws a description under the name and points the radio at it", () => {
    const html = renderToStaticMarkup(
      <SettingsChoiceGrid
        label="Modo de entrada"
        value="vad"
        onValueChange={() => undefined}
        columns={2}
        options={[
          { value: "vad", label: "Por voz", description: "Abre quando você fala.", preview: <i /> },
          { value: "ptt", label: "Push-to-talk", description: "Só com a tecla.", preview: <i /> },
        ]}
      />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const radio = doc.querySelector('[role="radio"]')!;
    const describedBy = radio.getAttribute("aria-describedby")!;
    expect(doc.getElementById(describedBy)?.textContent).toBe("Abre quando você fala.");
    expect(doc.getElementById(radio.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Por voz",
    );
  });

  it("leaves the naming alone when there is no description", () => {
    const html = renderToStaticMarkup(
      <SettingsChoiceGrid
        label="Visual"
        value="signal"
        onValueChange={() => undefined}
        options={[{ value: "signal", label: "Sinal", preview: <i /> }]}
      />,
    );
    expect(html).not.toContain("aria-labelledby");
    expect(html).not.toContain("aria-describedby");
  });
});
