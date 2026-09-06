import { afterEach, describe, expect, it } from "vitest";
import {
  applyDesktopAuthStart,
  classifyTicketSignIn,
  completeDesktopSecondFactor,
  desktopAuthEndedHandoff,
  desktopSignedOutPath,
  pickPreferredSecondFactor,
  redeemDesktopTicket,
  secondFactorNeedsPrepare,
  shouldRedeemDesktopTicket,
  ticketSignInSucceeded,
} from "./desktop-auth-flow";

type Shell = { isElectron: true };

function setShell(shell: Shell | undefined): void {
  if (shell) {
    (globalThis as { window?: unknown }).window = { pqpDesktop: shell };
  } else {
    (globalThis as { window?: unknown }).window = {};
  }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("shouldRedeemDesktopTicket", () => {
  it("refuses a second redeem of the same one-shot ticket", () => {
    expect(shouldRedeemDesktopTicket("st_1", "st_1")).toBe(false);
    expect(shouldRedeemDesktopTicket("st_1", "st_2")).toBe(true);
    expect(shouldRedeemDesktopTicket(null, "st_1")).toBe(true);
  });
});

describe("desktopAuthEndedHandoff", () => {
  it("drops the waiting screen and marks a silent listener timeout as expired", () => {
    expect(desktopAuthEndedHandoff("expired")).toEqual({
      waiting: false,
      expired: true,
    });
    expect(desktopAuthEndedHandoff("cancelled")).toEqual({
      waiting: false,
      expired: false,
    });
  });
});

describe("desktopSignedOutPath", () => {
  it("keeps Sair on /app in Electron so Clerk does not open Chrome", () => {
    setShell({ isElectron: true });
    expect(desktopSignedOutPath()).toBe("/app");
  });

  it("uses the homepage on the web", () => {
    setShell(undefined);
    expect(desktopSignedOutPath()).toBe("/");
  });
});

describe("ticketSignInSucceeded", () => {
  it("requires a session id", () => {
    expect(ticketSignInSucceeded({ createdSessionId: null })).toBe(false);
    expect(ticketSignInSucceeded({ createdSessionId: "sess_1" })).toBe(true);
  });
});

describe("classifyTicketSignIn", () => {
  it("keeps needs_second_factor as MFA instead of a spent failure", () => {
    expect(
      classifyTicketSignIn({
        status: "needs_second_factor",
        createdSessionId: null,
        supportedSecondFactors: [{ strategy: "totp" }],
      }),
    ).toEqual({ kind: "second_factor", strategies: ["totp"] });
  });

  it("defaults to totp and backup codes when Clerk omits the factor list", () => {
    expect(
      classifyTicketSignIn({
        status: "needs_second_factor",
        createdSessionId: null,
      }),
    ).toEqual({
      kind: "second_factor",
      strategies: ["totp", "backup_code"],
    });
  });

  it("separates client trust from a hard failure so the shell can fall back in-app", () => {
    expect(
      classifyTicketSignIn({
        status: "needs_client_trust",
        createdSessionId: null,
      }),
    ).toEqual({ kind: "client_trust" });
  });

  it("completes when Clerk already minted a session", () => {
    expect(
      classifyTicketSignIn({
        status: "complete",
        createdSessionId: "sess_1",
      }),
    ).toEqual({ kind: "complete", sessionId: "sess_1" });
  });
});

describe("redeemDesktopTicket", () => {
  it("does not treat a mocked needs_second_factor ticket as failure", async () => {
    const signIn = {
      create: async () => ({
        status: "needs_second_factor" as const,
        createdSessionId: null,
        supportedSecondFactors: [{ strategy: "totp" as const }],
      }),
    };
    await expect(redeemDesktopTicket(signIn, "st_mfa")).resolves.toEqual({
      kind: "second_factor",
      strategies: ["totp"],
    });
  });
});

describe("completeDesktopSecondFactor", () => {
  it("activates the session after a TOTP attempt", async () => {
    const signIn = {
      attemptSecondFactor: async (params: {
        strategy: string;
        code: string;
      }) => {
        expect(params).toEqual({ strategy: "totp", code: "123456" });
        return { status: "complete" as const, createdSessionId: "sess_1" };
      },
    };
    await expect(
      completeDesktopSecondFactor(signIn, { strategy: "totp", code: "123456" }),
    ).resolves.toEqual({ kind: "complete", sessionId: "sess_1" });
  });
});

describe("pickPreferredSecondFactor", () => {
  it("prefers totp, then backup codes, then SMS", () => {
    expect(pickPreferredSecondFactor(["phone_code", "totp"])).toBe("totp");
    expect(pickPreferredSecondFactor(["backup_code", "phone_code"])).toBe(
      "backup_code",
    );
    expect(secondFactorNeedsPrepare("totp")).toBe(false);
    expect(secondFactorNeedsPrepare("phone_code")).toBe(true);
  });
});

describe("applyDesktopAuthStart", () => {
  it("drops waiting when start fails with no url", () => {
    expect(applyDesktopAuthStart({ ok: false, url: "" })).toEqual({
      waiting: false,
      url: "",
      failed: true,
    });
  });

  it("keeps waiting when openExternal failed but the url is still there", () => {
    expect(
      applyDesktopAuthStart({
        ok: false,
        url: "https://pqp.gg/desktop-login",
      }),
    ).toEqual({
      waiting: true,
      url: "https://pqp.gg/desktop-login",
      failed: false,
    });
  });
});
