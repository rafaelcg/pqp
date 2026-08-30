import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PlatformPicker } from "./platform-picker";

describe("PlatformPicker", () => {
  it("offers computer, iPhone, and Android", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PlatformPicker />
      </MemoryRouter>,
    );
    expect(html).toContain("/beta");
    expect(html).toContain("/android");
    expect(html).toContain("iPhone");
    expect(html).toContain("Android");
    expect(html).toContain("Computer");
  });
});
