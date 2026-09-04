import { afterEach, describe, expect, it } from "vitest";
import {
  applyDesktopAuthStart,
  desktopAuthEndedHandoff,
  desktopSignedOutPath,
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
  it("treats a ticket with no session as a failed redeem", () => {
    // Clerk returns this for needs_second_factor; the ticket is already spent.
    expect(ticketSignInSucceeded({ createdSessionId: null })).toBe(false);
    expect(ticketSignInSucceeded({ createdSessionId: "sess_1" })).toBe(true);
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
