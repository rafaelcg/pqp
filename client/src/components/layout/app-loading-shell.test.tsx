import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppLoadingShell } from "./app-loading-shell";

describe("AppLoadingShell", () => {
  it("shows Breu at work, with a reduced-motion variant", () => {
    const html = renderToStaticMarkup(<AppLoadingShell label="Carregando" />);
    expect(html).toContain('data-breu-motion="working"');
    expect(html).toContain('data-face="focado"');
    expect(html).toContain("motion-reduce:animate-none");
  });
});
