import { MESH_VOICE_LIMIT } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../lib/rate-limit.js";
import {
  GENERAL_BUDGET,
  RELAY_BUDGET,
  createFrameBudget,
} from "./frame-budget.js";

/**
 * What one browser sends joining a full mesh room, in the order it sends it.
 *
 * `candidatesPerPeer` is the number that decides everything. 4 is what a
 * Chromium on one interface with STUN only trickled in a local 8-browser run;
 * 30 is the production shape (TURN with several URLs, a relay per local
 * address per URL, IPv4 and IPv6) and the one sized for here.
 */
function meshJoinFrames(candidatesPerPeer: number): string[] {
  const frames = [
    "auth",
    "join-channel",
    "join-voice-room",
    "set-voice-state",
    // The reconnect flush's first burst (`FLUSH_FIRST_BURST` in the client's
    // realtime.ts) lands in the same second as the join after a drop.
    ...Array.from({ length: 30 }, () => "typing"),
  ];
  for (let peer = 0; peer < MESH_VOICE_LIMIT - 1; peer += 1) {
    frames.push("offer");
    for (let c = 0; c < candidatesPerPeer; c += 1) {
      frames.push("ice-candidate");
    }
    // End of candidates: `onicecandidate` with a null candidate is a frame too.
    frames.push("ice-candidate");
  }
  return frames;
}

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const KNOWN = new Set(["auth", "typing", "join-channel", "join-voice-room", "set-voice-state", "offer", "answer", "ice-candidate"]);

describe("per-connection frame budget", () => {
  it("the old single bucket hangs up a mesh join, which is the bug", () => {
    const time = clock();
    const single = createRateLimiter({ ...GENERAL_BUDGET, now: time.now });
    const refused = meshJoinFrames(30).filter(() => !single.take("self"));
    expect(refused.length).toBeGreaterThan(0);
  });

  it("admits a full mesh room's join with production-sized trickle ICE in one instant", () => {
    const time = clock();
    const budget = createFrameBudget(KNOWN, time.now);
    for (const type of meshJoinFrames(30)) {
      expect(budget.take(type)).toBeNull();
    }
  });

  it("admits an ICE restart across the whole room ten seconds after the join", () => {
    const time = clock();
    const budget = createFrameBudget(KNOWN, time.now);
    for (const type of meshJoinFrames(30)) {
      budget.take(type);
    }
    time.advance(10_000);
    for (let peer = 0; peer < MESH_VOICE_LIMIT - 1; peer += 1) {
      expect(budget.take("offer")).toBeNull();
      for (let c = 0; c < 31; c += 1) {
        expect(budget.take("ice-candidate")).toBeNull();
      }
    }
  });

  it("still cuts off a relay flood, at the relay bucket's burst", () => {
    const time = clock();
    const budget = createFrameBudget(KNOWN, time.now);
    let admitted = 0;
    let verdict: string | null = null;
    for (let i = 0; i < 10_000 && verdict === null; i += 1) {
      verdict = budget.take("ice-candidate");
      if (verdict === null) {
        admitted += 1;
      }
    }
    expect(verdict).toBe("relay");
    expect(admitted).toBe(RELAY_BUDGET.capacity);
  });

  it("still cuts off a sustained relay stream above the refill rate", () => {
    const time = clock();
    const budget = createFrameBudget(KNOWN, time.now);
    let verdict: string | null = null;
    // Twice the refill, every second, for a minute.
    for (let second = 0; second < 60 && verdict === null; second += 1) {
      for (let i = 0; i < RELAY_BUDGET.refillPerSecond * 2 && verdict === null; i += 1) {
        verdict = budget.take("offer");
      }
      time.advance(1_000);
    }
    expect(verdict).toBe("relay");
  });

  it("keeps chat, typing and presence on the budget they always had", () => {
    const time = clock();
    const budget = createFrameBudget(KNOWN, time.now);
    // Spending relay budget must not buy anything for chat.
    for (let i = 0; i < 100; i += 1) {
      budget.take("ice-candidate");
    }
    let admitted = 0;
    let verdict: string | null = null;
    while (verdict === null) {
      verdict = budget.take("typing");
      if (verdict === null) {
        admitted += 1;
      }
    }
    expect(verdict).toBe("general");
    expect(admitted).toBe(GENERAL_BUDGET.capacity);
  });

  it("charges unparsed and unknown frames to the general bucket", () => {
    const time = clock();
    const budget = createFrameBudget(KNOWN, time.now);
    for (let i = 0; i < GENERAL_BUDGET.capacity; i += 1) {
      expect(budget.take(i % 2 === 0 ? undefined : "not-a-frame")).toBeNull();
    }
    expect(budget.take(undefined)).toBe("general");
  });

  it("says what the socket was sending, with client-invented names folded", () => {
    const time = clock();
    const budget = createFrameBudget(KNOWN, time.now);
    for (let i = 0; i < 10; i += 1) {
      budget.take("ice-candidate");
    }
    budget.take("offer");
    budget.take("x".repeat(5_000));
    budget.take(undefined);
    expect(budget.recentSummary()).toBe("ice-candidate:10,offer:1,other:1,unparsed:1");
  });
});
