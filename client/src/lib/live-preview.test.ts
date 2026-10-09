import { describe, expect, it, vi } from "vitest";
import { LIVE_PREVIEW_MEDIUM } from "@pqp/shared";
import { peekAcquisition, stashAcquisition } from "./acquisition";
import { classifyLivePreviewStart } from "./api";
import {
  HANDLE_INTENT_TTL_MS,
  peekLiveChannelIntent,
  stashLiveChannelIntent,
  takeLiveChannelIntent,
} from "./handle-intent";
import { pickArrivalPartyChannel } from "./live-party-landing";
import {
  devSignedOutPreview,
  formatPreviewCountdown,
  judgePreviewAge,
  phaseAfterStart,
  phaseOnWatch,
  PREVIEW_AGE_DECLINED_TTL_MS,
  previewIsUrgent,
  previewOffersSignUp,
  previewRemainingFraction,
  previewSecondsLeft,
  previewShowsPage,
  previewViewerCount,
  previewWindowMinutes,
  publicPreviewSwitchSeconds,
  readPreviewAgeMemory,
  readPreviewTicket,
  rememberPreviewAge,
  shareLink,
  stashLivePreviewAcquisition,
  writePreviewTicket,
  type LivePreviewPhase,
} from "./live-preview";

/**
 * The signed-out live preview's gating, without a DOM: who is asked the age
 * question, what a minor sees (nothing), what the device remembers, how a
 * start answer becomes a phase, and that the sign-up carries the channel and
 * the attribution through.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
}

const CHANNEL = "3c71043f-cd6c-4ad8-997b-f7875290d50d";
const NOW = Date.UTC(2026, 9, 9, 15, 0, 0);

describe("judgePreviewAge", () => {
  const today = new Date(NOW);

  it("uses the account gate's threshold, to the day", () => {
    expect(judgePreviewAge("2008-10-09", today)).toBe("adult");
    expect(judgePreviewAge("1990-01-01", today)).toBe("adult");
    // Eighteen tomorrow everywhere on Earth: still a minor today.
    expect(judgePreviewAge("2008-10-11", today)).toBe("minor");
    expect(judgePreviewAge("2015-05-05", today)).toBe("minor");
  });

  it("refuses a date that is not one, without a verdict", () => {
    expect(judgePreviewAge(null, today)).toBe("invalid");
    expect(judgePreviewAge("2007-02-30", today)).toBe("invalid");
    expect(judgePreviewAge("1850-01-01", today)).toBe("invalid");
    expect(judgePreviewAge("2030-01-01", today)).toBe("invalid");
  });
});

describe("what the device remembers about the age answer", () => {
  it("asks first, plays for an adult in the same tab, and shows nothing to a minor", () => {
    const session = memoryStorage();
    const local = memoryStorage();
    expect(readPreviewAgeMemory(session, local, NOW)).toBeNull();
    expect(phaseOnWatch(null)).toEqual({ kind: "age" });

    rememberPreviewAge("adult", session, local, NOW);
    expect(readPreviewAgeMemory(session, local, NOW)).toBe("passed");
    expect(phaseOnWatch("passed")).toEqual({ kind: "starting" });

    const minorSession = memoryStorage();
    const minorLocal = memoryStorage();
    rememberPreviewAge("minor", minorSession, minorLocal, NOW);
    expect(readPreviewAgeMemory(minorSession, minorLocal, NOW)).toBe("declined");
    expect(phaseOnWatch("declined")).toEqual({ kind: "declined" });
  });

  it("stores no date, only the verdict", () => {
    const session = memoryStorage();
    const local = memoryStorage();
    rememberPreviewAge("adult", session, local, NOW);
    rememberPreviewAge("minor", session, local, NOW);
    const everything = [session, local]
      .flatMap((store) =>
        Array.from({ length: store.length }, (_, i) => store.getItem(store.key(i)!)),
      )
      .join(" ");
    expect(everything).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("a declined answer holds for a day, and a declined device is never 'passed'", () => {
    const session = memoryStorage();
    const local = memoryStorage();
    rememberPreviewAge("adult", session, local, NOW);
    rememberPreviewAge("minor", session, local, NOW);
    expect(readPreviewAgeMemory(session, local, NOW + 1_000)).toBe("declined");
    expect(
      readPreviewAgeMemory(session, local, NOW + PREVIEW_AGE_DECLINED_TTL_MS + 1),
    ).toBe("passed");
  });

  it("asks again when storage is denied", () => {
    const denied = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readPreviewAgeMemory(denied, denied, NOW)).toBeNull();
  });
});

describe("the window ticket", () => {
  it("is kept per channel and handed back, past the window too", () => {
    const local = memoryStorage();
    expect(readPreviewTicket(local, CHANNEL, NOW)).toBeNull();
    writePreviewTicket(local, CHANNEL, "ticket-1", NOW);
    expect(readPreviewTicket(local, CHANNEL, NOW + 10 * 60_000)).toBe("ticket-1");
    expect(readPreviewTicket(local, "other", NOW)).toBeNull();
    // Rewriting the same ticket keeps the first time, so it is still forgotten
    // a day and an hour after it was first handed out.
    writePreviewTicket(local, CHANNEL, "ticket-1", NOW + 24 * 60 * 60_000);
    expect(readPreviewTicket(local, CHANNEL, NOW + 25 * 60 * 60_000 + 1)).toBeNull();
  });

  it("reads garbage as no ticket", () => {
    const local = memoryStorage();
    local.setItem(`pqp:live-preview-ticket:${CHANNEL}`, "{nope");
    expect(readPreviewTicket(local, CHANNEL, NOW)).toBeNull();
  });
});

describe("a start answer becomes a phase", () => {
  const body = {
    stream: { hlsUrl: "/api/voice/hls-playlist/c/1?t=x", startedAt: 1 },
    channel: { id: CHANNEL, name: "cinema" },
    ticket: "ticket",
    expiresAt: NOW + 300_000,
    remainingMs: 300_000,
  };

  it("classifies the server's answers", () => {
    expect(classifyLivePreviewStart(200, body)).toEqual({ kind: "ok", body });
    expect(classifyLivePreviewStart(403, { error: "preview_ended" })).toEqual({ kind: "ended" });
    expect(classifyLivePreviewStart(403, { error: "Forbidden" })).toEqual({ kind: "retry" });
    expect(classifyLivePreviewStart(404, { error: "Not found" })).toEqual({ kind: "gone" });
    expect(classifyLivePreviewStart(401, null)).toEqual({ kind: "gone" });
    expect(classifyLivePreviewStart(429, null)).toEqual({ kind: "retry" });
    expect(classifyLivePreviewStart(200, { stream: {} })).toEqual({ kind: "retry" });
  });

  it("plays only a window that is still open", () => {
    expect(phaseAfterStart({ kind: "ok", body }, NOW)).toEqual({
      kind: "watching",
      hlsUrl: body.stream.hlsUrl,
      mode: "conventional",
      expiresAt: body.expiresAt,
    });
    expect(phaseAfterStart({ kind: "ok", body }, body.expiresAt)).toEqual({ kind: "ended" });
    expect(phaseAfterStart({ kind: "ended" }, NOW)).toEqual({ kind: "ended" });
    expect(phaseAfterStart({ kind: "gone" }, NOW)).toEqual({ kind: "gone" });
    expect(phaseAfterStart({ kind: "retry" }, NOW)).toEqual({ kind: "error" });
  });

  it("counts down in whole seconds", () => {
    expect(previewSecondsLeft(NOW + 245_500, NOW)).toBe(246);
    expect(previewSecondsLeft(NOW - 1, NOW)).toBe(0);
    expect(formatPreviewCountdown(245)).toBe("4:05");
    expect(formatPreviewCountdown(0)).toBe("0:00");
  });
});

describe("the sign-up hand-off", () => {
  it("carries the channel through sign-up, spent only when used", () => {
    const local = memoryStorage();
    stashLiveChannelIntent(local, CHANNEL, NOW);
    expect(peekLiveChannelIntent(local, NOW)).toBe(CHANNEL);
    expect(peekLiveChannelIntent(local, NOW)).toBe(CHANNEL);
    expect(takeLiveChannelIntent(local, NOW)).toBe(CHANNEL);
    expect(peekLiveChannelIntent(local, NOW)).toBeNull();
    stashLiveChannelIntent(local, CHANNEL, NOW);
    expect(peekLiveChannelIntent(local, NOW + HANDLE_INTENT_TTL_MS + 1)).toBeNull();
    const fresh = memoryStorage();
    stashLiveChannelIntent(fresh, "not-a-channel", NOW);
    expect(peekLiveChannelIntent(fresh, NOW)).toBeNull();
  });

  it("lands on the watched channel when it is in the list, else on the live party", () => {
    const channels = [{ id: "general" }, { id: CHANNEL }, { id: "party-b" }];
    const parties = [
      { channelId: "party-b", state: "live" as const, wentLiveAt: "2026-10-09T15:00:00Z" },
    ];
    expect(pickArrivalPartyChannel(parties, channels, CHANNEL)).toBe(CHANNEL);
    expect(pickArrivalPartyChannel(parties, channels, null)).toBe("party-b");
    expect(pickArrivalPartyChannel(parties, channels, "elsewhere")).toBe("party-b");
    expect(pickArrivalPartyChannel([], [{ id: "general" }], CHANNEL)).toBeNull();
  });

  it("tags the account as live_preview, keeping the referring site, never over a campaign", () => {
    const plain = memoryStorage();
    stashAcquisition(plain, { source: "instagram.com", landing: "/c/sala" }, NOW, true);
    stashLivePreviewAcquisition(plain, "/c/sala", NOW);
    expect(peekAcquisition(plain, NOW)).toEqual({
      source: "instagram.com",
      medium: LIVE_PREVIEW_MEDIUM,
      landing: "/c/sala",
    });

    const campaign = memoryStorage();
    stashAcquisition(campaign, { source: "twitch", medium: "bio", landing: "/c/sala" }, NOW);
    stashLivePreviewAcquisition(campaign, "/c/sala", NOW);
    expect(peekAcquisition(campaign, NOW)?.medium).toBe("bio");

    const none = memoryStorage();
    stashLivePreviewAcquisition(none, "/app", NOW);
    expect(peekAcquisition(none, NOW)).toEqual({ medium: LIVE_PREVIEW_MEDIUM, landing: "/app" });
  });
});

describe("the dev-only signed-out switch", () => {
  it("is off without the dev auth bypass, whatever storage says", () => {
    const local = memoryStorage();
    local.setItem("pqp:dev-signed-out", "1");
    expect(devSignedOutPreview(local)).toBe(false);
  });
});

describe("the live page around the player", () => {
  const phases: LivePreviewPhase[] = [
    { kind: "idle" },
    { kind: "age" },
    { kind: "declined" },
    { kind: "starting" },
    { kind: "watching", hlsUrl: "/x", mode: "conventional", expiresAt: 1 },
    { kind: "ended" },
    { kind: "gone" },
    { kind: "error" },
  ];

  it("draws only the entry card while idle, and the full page for every other phase", () => {
    expect(phases.filter(previewShowsPage).map((phase) => phase.kind)).toEqual([
      "age",
      "declined",
      "starting",
      "watching",
      "ended",
      "gone",
      "error",
    ]);
  });

  it("offers an account in every phase except to somebody under the threshold", () => {
    // The declined page carries no sign-up anywhere: header, sticky bar,
    // chat card, "Me avisa" and "Entrar na comunidade" all read this.
    expect(phases.filter((phase) => !previewOffersSignUp(phase)).map((phase) => phase.kind)).toEqual([
      "declined",
    ]);
  });

  it("turns the countdown to the warning colour in the last 30 seconds", () => {
    expect(previewIsUrgent(31)).toBe(false);
    expect(previewIsUrgent(30)).toBe(true);
    expect(previewIsUrgent(0)).toBe(true);
  });

  it("sizes the countdown bar against the whole window, clamped", () => {
    const now = 1_000_000;
    expect(previewRemainingFraction(now + 300_000, 300, now)).toBe(1);
    expect(previewRemainingFraction(now + 150_000, 300, now)).toBe(0.5);
    // A resumed window is already shorter.
    expect(previewRemainingFraction(now + 30_000, 300, now)).toBeCloseTo(0.1);
    expect(previewRemainingFraction(now - 1, 300, now)).toBe(0);
    expect(previewRemainingFraction(now + 999_999, 300, now)).toBe(1);
    expect(previewRemainingFraction(now + 1_000, 0, now)).toBe(0);
  });

  it("says the window in whole minutes, never zero", () => {
    expect(previewWindowMinutes(300)).toBe(5);
    expect(previewWindowMinutes(120)).toBe(2);
    expect(previewWindowMinutes(30)).toBe(1);
  });

  it("draws a viewer count only above zero, and only a number", () => {
    expect(previewViewerCount({ viewers: 38 })).toBe(38);
    expect(previewViewerCount({ viewers: 0 })).toBeNull();
    expect(previewViewerCount({})).toBeNull();
    expect(previewViewerCount(null)).toBeNull();
    expect(previewViewerCount({ viewers: Number.NaN })).toBeNull();
  });
});

describe("the Share button", () => {
  const url = "https://pqp.gg/c/sandbox";

  it("uses the system share sheet where there is one", async () => {
    const share = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    expect(await shareLink(url, "Sandbox", { share, clipboard: { writeText } })).toBe("shared");
    expect(share).toHaveBeenCalledWith({ url, title: "Sandbox" });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not copy behind the back of somebody who closed the sheet", async () => {
    const abort = Object.assign(new Error("closed"), { name: "AbortError" });
    const writeText = vi.fn(async () => {});
    const outcome = await shareLink(url, "Sandbox", {
      share: async () => {
        throw abort;
      },
      clipboard: { writeText },
    });
    expect(outcome).toBe("cancelled");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the link without a share sheet, or when the sheet refuses", async () => {
    const writeText = vi.fn(async () => {});
    expect(await shareLink(url, "Sandbox", { clipboard: { writeText } })).toBe("copied");
    expect(
      await shareLink(url, "Sandbox", {
        share: async () => {
          throw new Error("NotAllowedError");
        },
        clipboard: { writeText },
      }),
    ).toBe("copied");
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(await shareLink(url, "Sandbox", {})).toBe("failed");
    expect(await shareLink(url, "Sandbox", null)).toBe("failed");
  });
});

describe("when the host's Prévia pública switch is drawn", () => {
  const flagOn = { livePreview: { seconds: 300 } };

  it("needs the flag on for the server AND a channel the preview could show", () => {
    expect(publicPreviewSwitchSeconds(flagOn, { available: true, seconds: 300 })).toBe(300);
    // The flag off: the config never carries `livePreview`, and nothing is asked.
    expect(publicPreviewSwitchSeconds({}, { available: true, seconds: 300 })).toBeNull();
    expect(publicPreviewSwitchSeconds(null, { available: true, seconds: 300 })).toBeNull();
    // Not a community, a private channel, @everyone cannot view: the server says no.
    expect(publicPreviewSwitchSeconds(flagOn, { available: false, seconds: 300 })).toBeNull();
    // Not answered yet: hidden rather than a switch that may do nothing.
    expect(publicPreviewSwitchSeconds(flagOn, null)).toBeNull();
  });

  it("uses the channel answer's window, falling back to the server's", () => {
    expect(publicPreviewSwitchSeconds(flagOn, { available: true, seconds: 120 })).toBe(120);
    expect(publicPreviewSwitchSeconds(flagOn, { available: true, seconds: 0 })).toBe(300);
  });
});
