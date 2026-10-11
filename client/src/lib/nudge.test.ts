import { NUDGE_COOLDOWN_MS, NUDGE_FRESH_MS } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sounds = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock("@/lib/sounds", () => ({
  playCue: (cue: string) => sounds.played.push(cue),
}));
vi.mock("@/lib/preferences", () => ({
  queuePreferenceSync: vi.fn(),
}));

const {
  adoptAllowNudges,
  applyNudgeArrival,
  getNudgeChannelState,
  getNudgeTarget,
  handleNudgeRefused,
  loadFunConfig,
  isNudgeEnabled,
  nudgeEffects,
  nudgeFromConfig,
  resetNudgeStateForTests,
  sendNudge,
  setAllowNudges,
  setNudgeEnabledForTests,
  setNudgeTarget,
  NUDGE_PENDING_TIMEOUT_MS,
} = await import("./nudge");
const { queuePreferenceSync } = await import("@/lib/preferences");

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const LU = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-11T12:00:10.000Z");

function nudgeFrom(authorId: string, createdAt = "2026-10-11T12:00:05.000Z") {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    channelId: CHANNEL,
    authorId,
    authorName: authorId === ME ? "Eu" : "Lu",
    createdAt,
    systemKind: "nudge" as const,
  };
}

beforeEach(() => {
  resetNudgeStateForTests();
  sounds.played.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the flag", () => {
  it("is on only for an explicit true", () => {
    expect(nudgeFromConfig({ nudge: true })).toBe(true);
    expect(nudgeFromConfig({ nudge: "true" })).toBe(false);
    expect(nudgeFromConfig({})).toBe(false);
  });

  it("keeps the last answer when the API cannot be reached", async () => {
    await loadFunConfig(async () => ({ nudge: true }));
    expect(isNudgeEnabled()).toBe(true);
    await loadFunConfig(async () => {
      throw new Error("404");
    });
    expect(isNudgeEnabled()).toBe(true);
  });
});

describe("sendNudge", () => {
  it("puts one frame with a nonce on the socket and waits for the answer", () => {
    const send = vi.fn();
    expect(sendNudge(CHANNEL, { send, connected: true, now: NOW })).toBe("sent");
    expect(send).toHaveBeenCalledWith({
      type: "nudge",
      channelId: CHANNEL,
      nonce: expect.any(String),
    });
    expect(getNudgeChannelState(CHANNEL).pending).toBe(true);
    // A second click while in flight sends nothing.
    expect(sendNudge(CHANNEL, { send, connected: true, now: NOW })).toBe("pending");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("lets the button go when nothing ever answers", () => {
    vi.useFakeTimers();
    sendNudge(CHANNEL, { send: vi.fn(), connected: true });
    vi.advanceTimersByTime(NUDGE_PENDING_TIMEOUT_MS);
    expect(getNudgeChannelState(CHANNEL).pending).toBe(false);
  });

  it("a send that throws lets the button go at once", () => {
    const send = vi.fn(() => {
      throw new Error("closed");
    });
    expect(sendNudge(CHANNEL, { send, connected: true, now: NOW })).toBe("offline");
    expect(getNudgeChannelState(CHANNEL)).toMatchObject({
      pending: false,
      notice: { reason: "unavailable" },
    });
  });

  it("never queues a nudge on a dead socket: it would land stale", () => {
    const send = vi.fn();
    expect(sendNudge(CHANNEL, { send, connected: false, now: NOW })).toBe("offline");
    expect(send).not.toHaveBeenCalled();
    expect(getNudgeChannelState(CHANNEL).notice?.reason).toBe("unavailable");
  });

  it("answers my own switch being off locally, with the self-off line", () => {
    setAllowNudges(false);
    const send = vi.fn();
    expect(sendNudge(CHANNEL, { send, connected: true, now: NOW })).toBe("self-off");
    expect(send).not.toHaveBeenCalled();
    expect(getNudgeChannelState(CHANNEL).notice?.reason).toBe("self-off");
  });

  it("inside a cooldown the server announced, answers locally and sends nothing", () => {
    handleNudgeRefused({ channelId: CHANNEL, reason: "cooldown", retryAfterMs: 6_000 }, NOW);
    const send = vi.fn();
    expect(sendNudge(CHANNEL, { send, connected: true, now: NOW + 5_000 })).toBe("cooldown");
    expect(send).not.toHaveBeenCalled();
    expect(sendNudge(CHANNEL, { send, connected: true, now: NOW + 6_001 })).toBe("sent");
  });
});

describe("handleNudgeRefused", () => {
  it("clears the pending state, keeps the reason and sets the wait for a cooldown", () => {
    sendNudge(CHANNEL, { send: vi.fn(), connected: true, now: NOW });
    handleNudgeRefused({ channelId: CHANNEL, reason: "cooldown", retryAfterMs: 4_000 }, NOW);
    expect(getNudgeChannelState(CHANNEL)).toMatchObject({
      pending: false,
      cooldownUntil: NOW + 4_000,
      notice: { reason: "cooldown" },
    });
  });

  it("a refusal that is not a cooldown sets no wait", () => {
    handleNudgeRefused({ channelId: CHANNEL, reason: "busy" }, NOW);
    expect(getNudgeChannelState(CHANNEL)).toMatchObject({
      cooldownUntil: 0,
      notice: { reason: "busy" },
    });
  });

  it("an answer to an older request never settles the one in flight", () => {
    const sent: Array<{ nonce: string }> = [];
    sendNudge(CHANNEL, { send: (frame) => sent.push(frame), connected: true, now: NOW });
    handleNudgeRefused(
      { channelId: CHANNEL, reason: "busy", nonce: "an-old-request" },
      NOW,
    );
    expect(getNudgeChannelState(CHANNEL)).toMatchObject({ pending: true, notice: null });
    handleNudgeRefused({ channelId: CHANNEL, reason: "busy", nonce: sent[0]!.nonce }, NOW);
    expect(getNudgeChannelState(CHANNEL)).toMatchObject({
      pending: false,
      notice: { reason: "busy" },
    });
  });

  it("a cooldown with no wait in it falls back to the rule's ten seconds", () => {
    handleNudgeRefused({ channelId: CHANNEL, reason: "cooldown" }, NOW);
    expect(getNudgeChannelState(CHANNEL).cooldownUntil).toBe(NOW + NUDGE_COOLDOWN_MS);
  });
});

describe("nudgeEffects", () => {
  const open = { viewerId: ME, openChannelId: CHANNEL, visible: true, muted: false, now: NOW };

  it("a fresh nudge in the conversation on screen shakes and plays", () => {
    expect(nudgeEffects(nudgeFrom(LU), open)).toEqual({ landed: false, shake: true, sound: true });
  });

  it("a conversation not open is left to the activity path: no second cue here", () => {
    expect(nudgeEffects(nudgeFrom(LU), { ...open, openChannelId: null })).toEqual({
      landed: false,
      shake: false,
      sound: false,
    });
  });

  it("the open one in a hidden tab plays (the server sends it no activity) but does not shake", () => {
    expect(nudgeEffects(nudgeFrom(LU), { ...open, visible: false })).toEqual({
      landed: false,
      shake: false,
      sound: true,
    });
  });

  it("history never shakes or plays", () => {
    const old = new Date(NOW - NUDGE_FRESH_MS - 1).toISOString();
    expect(nudgeEffects(nudgeFrom(LU, old), open)).toEqual({
      landed: false,
      shake: false,
      sound: false,
    });
  });

  it("a muted conversation is the line only", () => {
    expect(nudgeEffects(nudgeFrom(LU), { ...open, muted: true })).toEqual({
      landed: false,
      shake: false,
      sound: false,
    });
  });

  it("mine starts the cooldown and does nothing loud", () => {
    expect(nudgeEffects(nudgeFrom(ME), open)).toEqual({ landed: true, shake: false, sound: false });
  });

  it("an ordinary message is nothing at all", () => {
    expect(nudgeEffects({ ...nudgeFrom(LU), systemKind: null }, open)).toEqual({
      landed: false,
      shake: false,
      sound: false,
    });
  });
});

describe("applyNudgeArrival", () => {
  it("a conversation set to mentions only gets the line and nothing loud", async () => {
    const { setChannelNotificationLevel } = await import("@/lib/notifications");
    setChannelNotificationLevel(CHANNEL, "mentions");
    const effects = applyNudgeArrival(nudgeFrom(LU), {
      viewerId: ME,
      openChannelId: CHANNEL,
      visible: true,
      now: NOW,
    });
    expect(effects).toEqual({ landed: false, shake: false, sound: false });
    expect(sounds.played).toEqual([]);
    setChannelNotificationLevel(CHANNEL, null);
  });

  it("plays the cue and asks the pane to shake", () => {
    applyNudgeArrival(nudgeFrom(LU), { viewerId: ME, openChannelId: CHANNEL, visible: true, now: NOW });
    expect(sounds.played).toEqual(["nudge"]);
  });

  it("my landed nudge starts the cooldown on the button", () => {
    sendNudge(CHANNEL, { send: vi.fn(), connected: true, now: NOW });
    applyNudgeArrival(nudgeFrom(ME), { viewerId: ME, openChannelId: CHANNEL, visible: true, now: NOW });
    expect(getNudgeChannelState(CHANNEL)).toMatchObject({
      pending: false,
      cooldownUntil: NOW + NUDGE_COOLDOWN_MS,
      landed: 1,
    });
    expect(sounds.played).toEqual([]);
  });
});

describe("the opt-out", () => {
  it("syncs a change and adopts the account copy without writing it back", () => {
    setAllowNudges(false);
    expect(queuePreferenceSync).toHaveBeenCalledWith({ allowNudges: false }, { immediate: true });
    vi.mocked(queuePreferenceSync).mockClear();
    adoptAllowNudges({ allowNudges: true });
    expect(queuePreferenceSync).not.toHaveBeenCalled();
    const send = vi.fn();
    expect(sendNudge(CHANNEL, { send, connected: true, now: NOW })).toBe("sent");
  });
});

describe("the /nudge target", () => {
  it("exists only while the flag is on and a button registered one", () => {
    const trigger = vi.fn(() => "sent" as const);
    setNudgeTarget({ channelId: CHANNEL, trigger });
    expect(getNudgeTarget()).toBeNull();
    setNudgeEnabledForTests(true);
    expect(getNudgeTarget()?.channelId).toBe(CHANNEL);
    setNudgeTarget(null);
    expect(getNudgeTarget()).toBeNull();
  });
});
