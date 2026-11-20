// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LatencyChip } from "@/components/jam/jam-studio-parts";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { JamStudio } from "@/hooks/use-jam-studio";
import { I18nProvider } from "@/lib/i18n";
import { latencyChipTitleKey, latencyIsMeasured } from "./jam-latency-trust";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * "Fone ajustado · 33 ms" with a green "no tempo" appeared on the browser's own
 * guess (low confidence), which the review screen itself called an estimate. A
 * guess is shown as a guess; the check and the dot are for a measurement.
 */

describe("latencyIsMeasured", () => {
  it("is false for the browser's estimate, whatever its confidence", () => {
    expect(latencyIsMeasured({ method: "estimate", confidence: "low" })).toBe(false);
    expect(latencyIsMeasured({ method: "estimate", confidence: "high" })).toBe(false);
  });

  it("is true for a loopback or tap-along measurement that came back sure", () => {
    expect(latencyIsMeasured({ method: "loopback", confidence: "high" })).toBe(true);
    expect(latencyIsMeasured({ method: "loopback", confidence: "medium" })).toBe(true);
    expect(latencyIsMeasured({ method: "tap-along", confidence: "high" })).toBe(true);
  });

  it("is false for a measurement that failed or came back unsure", () => {
    expect(latencyIsMeasured({ method: "loopback", confidence: "low" })).toBe(false);
    expect(latencyIsMeasured({ method: "loopback", confidence: "failed" })).toBe(false);
  });

  it("is true for a number the person typed on purpose", () => {
    expect(latencyIsMeasured({ method: "manual", confidence: "high" })).toBe(true);
  });
});

describe("the chip's tooltip follows what the number is", () => {
  it("a guess says it is a guess, a measurement says it is subtracted, an unsure one says unsure", () => {
    expect(latencyChipTitleKey({ method: "estimate", confidence: "low" })).toBe("jam.latency.chipTitleEstimate");
    expect(latencyChipTitleKey({ method: "loopback", confidence: "high" })).toBe("jam.latency.chipTitle");
    expect(latencyChipTitleKey({ method: "tap-along", confidence: "low" })).toBe("jam.latency.chipTitleUnsure");
  });

  it("every one of them exists in English, Portuguese and Spanish", async () => {
    const en = (await import("@/locales/en/translation.json")).default as Record<string, string>;
    const pt = (await import("@/locales/pt-BR/translation.json")).default as Record<string, string>;
    const es = (await import("@/locales/es/translation.json")).default as Record<string, string>;
    for (const key of ["jam.latency.chipTitleEstimate", "jam.latency.chipTitle", "jam.latency.chipTitleUnsure"]) {
      for (const catalogue of [en, pt, es]) {
        expect(catalogue[key], key).toContain("{ms}");
      }
    }
  });
});

describe("the header chip", () => {
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    host?.remove();
    host = null;
  });

  function chip(method: "estimate" | "loopback", confidence: "low" | "high") {
    host = document.createElement("div");
    document.body.appendChild(host);
    const studio = {
      latency: { current: { method, confidence, roundTripMs: 33.2 } },
    } as unknown as JamStudio;
    act(() => {
      createRoot(host!).render(
        <I18nProvider>
          <TooltipProvider>
            <LatencyChip studio={studio} />
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    return host.querySelector<HTMLElement>("[data-jam-latency-chip]")!;
  }

  it("calls a guess a guess, with no 'set' wording and no dot", () => {
    const el = chip("estimate", "low");
    expect(el.textContent).toBe("Headphones · about 33 ms (estimated)");
    expect(el.textContent).not.toMatch(/set/i);
    expect(el.querySelector(".bg-accent")).toBeNull();
  });

  it("says 'set' and shows the dot only for a measurement", () => {
    const el = chip("loopback", "high");
    expect(el.textContent).toBe("Headphones set · 33 ms");
    expect(el.querySelector(".bg-accent")).not.toBeNull();
  });
});
