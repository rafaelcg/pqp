import { describe, expect, it } from "vitest";
import { formatSessionRelativeTime } from "./channel-session-schedule";

describe("formatSessionRelativeTime", () => {
  const now = new Date("2026-09-08T18:00:00");

  it("says live now for a past or current instant", () => {
    expect(formatSessionRelativeTime("2026-09-08T17:59:00", now)).toBe(
      "ao vivo agora",
    );
    expect(formatSessionRelativeTime(now, now)).toBe("ao vivo agora");
  });

  it("counts minutes under an hour", () => {
    expect(formatSessionRelativeTime("2026-09-08T18:12:00", now)).toBe(
      "em 12 min",
    );
    expect(formatSessionRelativeTime("2026-09-08T18:00:20", now)).toBe(
      "em menos de 1 min",
    );
  });

  it("shows a time for later today", () => {
    expect(formatSessionRelativeTime("2026-09-08T21:00:00", now)).toBe(
      "hoje às 21h00",
    );
  });

  it("says tomorrow across midnight", () => {
    expect(formatSessionRelativeTime("2026-09-09T09:30:00", now)).toBe(
      "amanhã às 09h30",
    );
  });

  it("names the weekday within the next six days", () => {
    // 2026-09-08 is a Tuesday; +3 days lands on Friday.
    expect(formatSessionRelativeTime("2026-09-11T21:00:00", now)).toBe(
      "sexta às 21h00",
    );
  });

  it("falls back to a day count past a week out", () => {
    expect(formatSessionRelativeTime("2026-09-20T21:00:00", now)).toBe(
      "em 12 dias",
    );
  });

  it("renders English when asked", () => {
    expect(
      formatSessionRelativeTime("2026-09-08T18:12:00", now, "en"),
    ).toBe("in 12 min");
    expect(
      formatSessionRelativeTime("2026-09-11T21:00:00", now, "en"),
    ).toBe("Friday at 21:00");
  });
});
