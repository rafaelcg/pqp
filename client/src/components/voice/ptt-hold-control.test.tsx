import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PttHoldControl } from "./ptt-hold-control";

describe("PttHoldControl", () => {
  it("stays 36px on the docked bar, same as the tiles", () => {
    const html = renderToStaticMarkup(
      <PttHoldControl
        blocked={false}
        listenOnly={false}
        isTransmitting={false}
        keyLabel=" "
        windowFocused
        inBar
      />,
    );
    expect(html).toContain("h-9");
    expect(html).toContain("max-h-9");
    expect(html).toContain("leading-none");
    expect(html).not.toContain("leading-4");
  });

  it("matches the 40px overlay tiles when it is not in the bar", () => {
    const html = renderToStaticMarkup(
      <PttHoldControl
        blocked={false}
        listenOnly={false}
        isTransmitting={false}
        keyLabel={null}
        windowFocused
      />,
    );
    expect(html).toContain("h-10");
    expect(html).toContain("max-h-10");
    expect(html).not.toContain("max-h-9");
  });
});
