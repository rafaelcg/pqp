import { describe, expect, it } from "vitest";
import {
  browserFamily,
  buildContactMailto,
  collectHelpDiagnostics,
  osFamily,
  CONTACT_EMAIL,
} from "./help-contact";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const copy = {
  subject: "Ajuda com o pqp",
  intro: "Conte o que aconteceu:",
  diagnosticsHeading: "Diagnóstico",
  labels: { app: "App", platform: "Plataforma", browser: "Navegador", language: "Idioma" },
};

describe("help contact", () => {
  it("reads families, never versions", () => {
    expect(browserFamily(CHROME_MAC)).toBe("Chrome");
    expect(browserFamily(SAFARI_IOS)).toBe("Safari");
    expect(browserFamily("Mozilla/5.0 Firefox/120.0")).toBe("Firefox");
    expect(browserFamily("Mozilla/5.0 Chrome/120 Edg/120")).toBe("Edge");
    expect(osFamily(CHROME_MAC)).toBe("macOS");
    expect(osFamily(SAFARI_IOS)).toBe("iOS");
    expect(osFamily("Mozilla/5.0 (Linux; Android 14)")).toBe("Android");
  });

  it("builds a mailto to the public address with subject and body", () => {
    const url = buildContactMailto(
      collectHelpDiagnostics({
        userAgent: CHROME_MAC,
        locale: "pt-BR",
        appVersion: "4718c63deadbeef",
        desktop: false,
      }),
      copy,
    );
    expect(url.startsWith(`mailto:${CONTACT_EMAIL}?`)).toBe(true);
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("subject")).toBe("Ajuda com o pqp");
    const body = params.get("body")!;
    expect(body).toContain("App: 4718c63deadb");
    expect(body).toContain("Plataforma: web, macOS");
    expect(body).toContain("Navegador: Chrome");
    expect(body).toContain("Idioma: pt-BR");
  });

  it("leaks no personal data, browser versions or addresses", () => {
    const url = buildContactMailto(
      collectHelpDiagnostics({ userAgent: CHROME_MAC, locale: "en", desktop: false }),
      copy,
    );
    const body = new URLSearchParams(url.split("?")[1]).get("body")!;
    expect(body).not.toMatch(/126\.0|10_15/);
    expect(body).not.toMatch(/Bearer|token|user_|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|https?:/i);
    expect(body.split("\n").length).toBeLessThan(12);
  });
});
