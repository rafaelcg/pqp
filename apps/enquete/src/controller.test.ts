import { describe, expect, it } from "vitest";
import type { JsonValue } from "@pqp/shared";
import { PqpAppError, type Participant, type StateSnapshot } from "@pqp/app-sdk";
import { PollController, type PollHost, type View } from "./controller";
import { bit, type Poll } from "./model";

type Obj = Record<string, JsonValue>;

/** RFC 7396, the same merge the platform applies to a session's state. */
function merge(target: JsonValue, patch: JsonValue): JsonValue {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return patch;
  const base: Obj = typeof target === "object" && target !== null && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = merge(base[key] ?? null, value);
  }
  return base;
}

function person(seatId: string, extra: Partial<Participant> = {}): Participant {
  return {
    seatId,
    displayName: seatId,
    avatar: null,
    role: "player",
    isHost: false,
    connection: "present",
    ...extra,
  } as Participant;
}

/** A session's state with revisions, a merge patch, `baseRev`, and failures on demand. */
class FakeSession {
  rev = 0;
  value: JsonValue = {};
  failNext: Array<PqpAppError> = [];
  patches: Array<{ patch: JsonValue; baseRev?: number }> = [];
  private stateListeners = new Set<(s: StateSnapshot) => void>();
  private rosterListeners = new Set<(p: Participant[]) => void>();
  roster: Participant[] = [];
  ended = false;

  host(selfSeat: string): PollHost {
    return {
      state: {
        get: async () => ({ rev: this.rev, value: this.value }),
        patch: async (patch, options) => {
          this.patches.push({ patch, baseRev: options?.baseRev });
          const failure = this.failNext.shift();
          if (failure) throw failure;
          if (options?.baseRev !== undefined && options.baseRev !== this.rev) throw new PqpAppError("stale-rev");
          this.write(patch);
          return { rev: this.rev };
        },
        on: (cb) => {
          this.stateListeners.add(cb);
          return () => this.stateListeners.delete(cb);
        },
      },
      participants: {
        get: async () => this.roster,
        on: (cb) => {
          this.rosterListeners.add(cb);
          return () => this.rosterListeners.delete(cb);
        },
      },
      end: async () => {
        this.ended = true;
        void selfSeat;
        return null;
      },
    };
  }

  /** Another seat's write, or this seat's own once it is accepted. */
  write(patch: JsonValue) {
    this.rev += 1;
    this.value = merge(this.value, patch);
    for (const cb of this.stateListeners) cb({ rev: this.rev, value: this.value });
  }

  setRoster(next: Participant[]) {
    this.roster = next;
    for (const cb of this.rosterListeners) cb(next);
  }
}

const instant = () => Promise.resolve();
const poll: Poll = { question: "Pizza ou sushi?", options: ["Pizza", "Sushi", "Tacos"], multi: false };

async function open(selfSeat: string, session: FakeSession, isHost = false) {
  const views: View[] = [];
  const base = [person(selfSeat, { isHost })];
  if (session.roster.length === 0) session.roster = base;
  const controller = new PollController(session.host(selfSeat), selfSeat, (view) => views.push(view), {
    sleep: instant,
    random: () => 0,
  });
  await controller.init({ connection: "online" });
  return { controller, views };
}

async function settle() {
  // a macrotask: every promise chain (retries included, the sleep is instant) has run by then
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("PollController: the host starts the poll", () => {
  it("writes the poll once, and the others see it", async () => {
    const session = new FakeSession();
    const host = await open("host-seat-aaaaaaaa", session, true);
    expect(host.controller.view.amHost).toBe(true);
    expect(host.controller.view.state.poll).toBeNull();

    expect(await host.controller.start(poll)).toBe(true);
    expect(host.controller.view.state.poll).toEqual(poll);
    expect(session.patches.at(-1)?.baseRev).toBe(0);

    const guest = await open("guest-seat-bbbbbbbb", session);
    expect(guest.controller.view.state.poll).toEqual(poll);
    expect(guest.controller.view.amHost).toBe(false);
  });

  it("does not start a second poll over one that is already there", async () => {
    const session = new FakeSession();
    const host = await open("host-seat-aaaaaaaa", session, true);
    session.write({ poll: { question: "Outra?", options: ["a", "b"], multi: false } });
    expect(await host.controller.start(poll)).toBe(false);
    expect(host.controller.view.state.poll?.question).toBe("Outra?");
  });

  it("retries a stale start against the new revision", async () => {
    const session = new FakeSession();
    const host = await open("host-seat-aaaaaaaa", session, true);
    // somebody else wrote something unrelated in between
    session.rev = 3;
    expect(await host.controller.start(poll)).toBe(true);
    expect(host.controller.view.state.poll).toEqual(poll);
  });
});

describe("PollController: voting", () => {
  async function started() {
    const session = new FakeSession();
    session.roster = [
      person("host-seat-aaaaaaaa", { isHost: true }),
      person("guest-seat-bbbbbbbb"),
      person("watch-seat-cccccccc", { role: "spectator" }),
    ];
    const host = await open("host-seat-aaaaaaaa", session, true);
    await host.controller.start(poll);
    return { session, host };
  }

  it("shows a click at once and writes only this seat's key", async () => {
    const { session } = await started();
    const guest = await open("guest-seat-bbbbbbbb", session);
    guest.controller.vote(bit(1));
    // optimistic, before the write has been answered
    expect(guest.controller.view.myMask).toBe(bit(1));
    await settle();
    expect(session.patches.at(-1)).toEqual({ patch: { votes: { "guest-seat-bbbbbbbb": 2 } }, baseRev: undefined });
    expect((session.value as Obj).votes).toEqual({ "guest-seat-bbbbbbbb": 2 });
    expect(guest.controller.view.myMask).toBe(bit(1));
  });

  it("two seats voting at once both land, with no baseRev to fight over", async () => {
    const { session, host } = await started();
    const guest = await open("guest-seat-bbbbbbbb", session);
    host.controller.vote(bit(0));
    guest.controller.vote(bit(2));
    await settle();
    expect((session.value as Obj).votes).toEqual({ "host-seat-aaaaaaaa": 1, "guest-seat-bbbbbbbb": 4 });
    expect(guest.controller.view.state.votes).toEqual({ "host-seat-aaaaaaaa": 1, "guest-seat-bbbbbbbb": 4 });
  });

  it("takes a vote back with a null", async () => {
    const { session } = await started();
    const guest = await open("guest-seat-bbbbbbbb", session);
    guest.controller.vote(bit(0));
    await settle();
    guest.controller.vote(0);
    await settle();
    expect((session.value as Obj).votes).toEqual({});
    expect(guest.controller.view.myMask).toBe(0);
  });

  it("a double click sends the latest choice and never reorders", async () => {
    const { session } = await started();
    const guest = await open("guest-seat-bbbbbbbb", session);
    guest.controller.vote(bit(0));
    guest.controller.vote(bit(2));
    await settle();
    expect((session.value as Obj).votes).toEqual({ "guest-seat-bbbbbbbb": 4 });
    expect(guest.controller.view.myMask).toBe(bit(2));
  });

  it("keeps a single choice to one option", async () => {
    const { session } = await started();
    const guest = await open("guest-seat-bbbbbbbb", session);
    guest.controller.vote(bit(0) + bit(1));
    await settle();
    expect(guest.controller.view.myMask).toBe(bit(0));
  });

  it("retries when the platform says rate-limited", async () => {
    const { session } = await started();
    const guest = await open("guest-seat-bbbbbbbb", session);
    session.failNext = [new PqpAppError("rate-limited"), new PqpAppError("rate-limited")];
    guest.controller.vote(bit(1));
    await settle();
    expect((session.value as Obj).votes).toEqual({ "guest-seat-bbbbbbbb": 2 });
    expect(guest.controller.view.notice).toBeNull();
  });

  it("gives up after the retries, goes back to what the state says and says so", async () => {
    const { session } = await started();
    const guest = await open("guest-seat-bbbbbbbb", session);
    session.failNext = Array.from({ length: 20 }, () => new PqpAppError("rate-limited"));
    guest.controller.vote(bit(1));
    await settle();
    expect(guest.controller.view.myMask).toBe(0);
    expect(guest.controller.view.notice).toBe("failed");
  });

  it("tells a watcher who cannot write that they cannot vote", async () => {
    const { session } = await started();
    const watcher = await open("watch-seat-cccccccc", session);
    expect(watcher.controller.view.amSpectator).toBe(true);
    session.failNext = [new PqpAppError("not-allowed")];
    watcher.controller.vote(bit(0));
    await settle();
    expect(watcher.controller.view.notice).toBe("cannot-vote");
    expect(watcher.controller.view.myMask).toBe(0);
    watcher.controller.clearNotice();
    expect(watcher.controller.view.notice).toBeNull();
  });

  it("ignores a vote on a poll that is not there, is closed, or is over", async () => {
    const session = new FakeSession();
    const early = await open("guest-seat-bbbbbbbb", session);
    early.controller.vote(bit(0));
    await settle();
    expect(session.patches).toHaveLength(0);

    const { session: s2, host } = await started();
    const guest = await open("guest-seat-bbbbbbbb", s2);
    await host.controller.close();
    const before = s2.patches.length;
    guest.controller.vote(bit(0));
    await settle();
    expect(s2.patches).toHaveLength(before);

    guest.controller.setEnded();
    guest.controller.vote(bit(1));
    expect(s2.patches).toHaveLength(before);
  });

  it("a vote written by somebody else shows up live", async () => {
    const { session } = await started();
    const guest = await open("guest-seat-bbbbbbbb", session);
    session.write({ votes: { other: 1 } });
    expect(guest.controller.view.state.votes).toEqual({ other: 1 });
  });
});

describe("PollController: closing the vote", () => {
  it("freezes the counts and the line for the card, and what lands later does not move them", async () => {
    const session = new FakeSession();
    session.roster = [person("host-seat-aaaaaaaa", { isHost: true }), person("guest-seat-bbbbbbbb")];
    const host = await open("host-seat-aaaaaaaa", session, true);
    await host.controller.start(poll);
    const guest = await open("guest-seat-bbbbbbbb", session);
    host.controller.vote(bit(0));
    guest.controller.vote(bit(0));
    await settle();

    expect(await host.controller.close()).toBe(true);
    const state = session.value as Obj;
    expect(state.closed).toEqual({ counts: [2, 0, 0], voters: 2 });
    expect(state.result).toMatchObject({ question: "Pizza ou sushi?", winners: ["Pizza"], votes: 2, voters: 2 });

    // a straggler's write after the close is in `votes` and nowhere on screen
    session.write({ votes: { late: 4 } });
    expect(guest.controller.view.state.closed).toEqual({ counts: [2, 0, 0], voters: 2 });
  });

  it("is counted on the revision the votes were read from: a vote in between makes the first try stale", async () => {
    const session = new FakeSession();
    session.roster = [person("host-seat-aaaaaaaa", { isHost: true })];
    const host = await open("host-seat-aaaaaaaa", session, true);
    await host.controller.start(poll);
    session.write({ votes: { a: 1 } });
    // the host has seen rev 2; a third write lands without the host's listener (a slow push)
    session.rev += 1;
    session.value = merge(session.value, { votes: { b: 1 } });

    expect(await host.controller.close()).toBe(true);
    expect((session.value as Obj).closed).toEqual({ counts: [2, 0, 0], voters: 2 });
    const closes = session.patches.filter((p) => (p.patch as Obj).closed !== undefined);
    expect(closes).toHaveLength(2);
    expect(closes[0]?.baseRev).not.toBe(closes[1]?.baseRev);
  });

  it("waits for the host's own pending vote before counting", async () => {
    const session = new FakeSession();
    session.roster = [person("host-seat-aaaaaaaa", { isHost: true })];
    const host = await open("host-seat-aaaaaaaa", session, true);
    await host.controller.start(poll);
    host.controller.vote(bit(1));
    expect(await host.controller.close()).toBe(true);
    expect((session.value as Obj).closed).toEqual({ counts: [0, 1, 0], voters: 1 });
  });

  it("closes a poll nobody voted in with no winner", async () => {
    const session = new FakeSession();
    session.roster = [person("host-seat-aaaaaaaa", { isHost: true })];
    const host = await open("host-seat-aaaaaaaa", session, true);
    await host.controller.start(poll);
    await host.controller.close();
    expect((session.value as Obj).result).toMatchObject({ winners: [], votes: 0, voters: 0 });
  });

  it("reports a failure it cannot recover from", async () => {
    const session = new FakeSession();
    session.roster = [person("host-seat-aaaaaaaa", { isHost: true })];
    const host = await open("host-seat-aaaaaaaa", session, true);
    await host.controller.start(poll);
    session.failNext = [new PqpAppError("unavailable")];
    expect(await host.controller.close()).toBe(false);
    expect(host.controller.view.notice).toBe("failed");
    expect(host.controller.view.state.closed).toBeNull();
  });

  it("a host handoff passes the controls on: the new host is the one the roster says", async () => {
    const session = new FakeSession();
    session.roster = [person("host-seat-aaaaaaaa", { isHost: true }), person("guest-seat-bbbbbbbb")];
    const guest = await open("guest-seat-bbbbbbbb", session);
    expect(guest.controller.view.amHost).toBe(false);
    session.setRoster([person("guest-seat-bbbbbbbb", { isHost: true })]);
    expect(guest.controller.view.amHost).toBe(true);
  });
});

describe("PollController: the session around it", () => {
  it("passes the connection status and the end to the view", async () => {
    const session = new FakeSession();
    const { controller } = await open("guest-seat-bbbbbbbb", session);
    controller.setConnection("reconnecting");
    expect(controller.view.connection).toBe("reconnecting");
    controller.setEnded();
    expect(controller.view.ended).toBe(true);
  });

  it("asks the platform to end the session, and swallows an already ended one", async () => {
    const session = new FakeSession();
    const { controller } = await open("host-seat-aaaaaaaa", session, true);
    await controller.end();
    expect(session.ended).toBe(true);
  });

  it("ignores a state older than the one it holds", async () => {
    const session = new FakeSession();
    const { controller } = await open("guest-seat-bbbbbbbb", session);
    session.write({ poll: { question: "q", options: ["a", "b"], multi: false } });
    const stale = { rev: 0, value: {} as JsonValue };
    // a push that arrives out of order
    for (const cb of (session as unknown as { stateListeners: Set<(s: StateSnapshot) => void> }).stateListeners) cb(stale);
    expect(controller.view.state.poll?.question).toBe("q");
  });
});
