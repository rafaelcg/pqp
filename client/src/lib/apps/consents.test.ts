import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => api);

import {
  acceptApp,
  consentName,
  consentNotice,
  ensureAppConsents,
  getAppConsentsState,
  hasValidConsent,
  loadAppConsents,
  resetAppConsentsForTests,
  revokeApp,
  type AppConsent,
} from "./consents";

function consent(over: Partial<AppConsent> = {}): AppConsent {
  return {
    appId: "pqp-eco",
    acceptedVersion: "1.0.0",
    identityGranted: false,
    consentedAt: "2026-10-19T19:50:00Z",
    identity: "display",
    names: { "pt-BR": "Eco", en: "Echo" },
    notices: { en: "Stays on your computer." },
    stale: false,
    ...over,
  };
}

beforeEach(() => {
  resetAppConsentsForTests();
  api.apiFetch.mockReset();
});

afterEach(() => {
  resetAppConsentsForTests();
});

describe("the consents list", () => {
  it("is unknown until a read lands, and unknown means not accepted", () => {
    expect(getAppConsentsState().consents).toBeNull();
    expect(hasValidConsent(null, "pqp-eco")).toBe(false);
  });

  it("reads once at a time and keeps what parses", async () => {
    api.apiFetch.mockResolvedValue({ consents: [consent(), { nonsense: true }] });
    await Promise.all([loadAppConsents(), loadAppConsents()]);
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
    expect(getAppConsentsState().consents).toHaveLength(1);
  });

  it("a failed read keeps what was there and says it is done loading", async () => {
    api.apiFetch.mockResolvedValueOnce({ consents: [consent()] });
    await loadAppConsents();
    api.apiFetch.mockRejectedValueOnce(new Error("offline"));
    await loadAppConsents();
    expect(getAppConsentsState().consents).toHaveLength(1);
    expect(getAppConsentsState().loading).toBe(false);
  });

  it("ensure reads the list the first time only", async () => {
    api.apiFetch.mockResolvedValue({ consents: [consent()] });
    expect(await ensureAppConsents()).toHaveLength(1);
    await ensureAppConsents();
    expect(api.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("a stale consent does not count: the sheet shows again", () => {
    expect(hasValidConsent([consent()], "pqp-eco")).toBe(true);
    expect(hasValidConsent([consent({ stale: true })], "pqp-eco")).toBe(false);
    expect(hasValidConsent([consent()], "pqp-other")).toBe(false);
  });
});

describe("accepting and taking back", () => {
  it("accept posts the box as ticked and reads the list again", async () => {
    api.apiFetch
      .mockResolvedValueOnce({ appId: "pqp-eco", identityGranted: true })
      .mockResolvedValueOnce({ consents: [consent({ identityGranted: true })] });
    await acceptApp("pqp-eco", true);
    expect(api.apiFetch.mock.calls[0]).toEqual([
      "/api/apps/pqp-eco/consent",
      { method: "POST", body: JSON.stringify({ identityGranted: true }) },
    ]);
    expect(getAppConsentsState().consents?.[0]?.identityGranted).toBe(true);
  });

  it("accept rejects when the server did not take it", async () => {
    api.apiFetch.mockRejectedValueOnce(new Error("500"));
    await expect(acceptApp("pqp-eco", false)).rejects.toThrow();
  });

  it("revoke removes it from the list at once and asks the server", async () => {
    api.apiFetch.mockResolvedValueOnce({ consents: [consent()] });
    await loadAppConsents();
    api.apiFetch.mockResolvedValueOnce({ revoked: true }).mockResolvedValueOnce({ consents: [] });
    await revokeApp("pqp-eco");
    expect(api.apiFetch.mock.calls[1]).toEqual(["/api/apps/pqp-eco/consent", { method: "DELETE" }]);
    expect(getAppConsentsState().consents).toEqual([]);
  });
});

describe("what the list says in a language", () => {
  it("the person's language, then English, then the id", () => {
    expect(consentName(consent(), "pt-BR")).toBe("Eco");
    expect(consentName(consent(), "es-MX")).toBe("Echo");
    expect(consentName(consent({ names: {} }), "pt-BR")).toBe("pqp-eco");
    expect(consentNotice(consent(), "pt-BR")).toBe("Stays on your computer.");
    expect(consentNotice(consent({ notices: {} }), "en")).toBeNull();
  });
});
