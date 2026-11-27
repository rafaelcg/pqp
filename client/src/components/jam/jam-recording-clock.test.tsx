import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { RecordingClock, formatRecordingTime } from "./jam-studio-parts";

describe("the clock while recording (round 3, n13)", () => {
  it("counts whole seconds", () => {
    expect(formatRecordingTime(0)).toBe("0:00");
    expect(formatRecordingTime(999)).toBe("0:00");
    expect(formatRecordingTime(61_500)).toBe("1:01");
  });

  it("at 0:00 it still says the take is live: a dot beside the clock, and a spoken timer", () => {
    const out = renderToStaticMarkup(
      <I18nProvider>
        <RecordingClock elapsedMs={0} />
      </I18nProvider>,
    );
    expect(out).toContain("data-jam-rec-dot");
    expect(out).toContain("role=\"timer\"");
    expect(out).toContain("0:00");
    // Breathes only where motion is welcome.
    expect(out).toContain("motion-safe:animate-pulse");
  });
});
