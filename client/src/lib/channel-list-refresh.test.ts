import { describe, expect, it } from "vitest";
import type { Channel } from "@pqp/shared";
import { COMMUNITY_HOME_CHANNEL_ID } from "@/lib/community-home/id";
import {
  channelListRetryDelayMs,
  createChannelListTickets,
  vanishedChannelFallback,
} from "./channel-list-refresh";

function channel(id: string, type: Channel["type"]): Channel {
  return { id, type, name: id } as Channel;
}

const list = [
  channel("cat", "category"),
  channel("lobby", "voice"),
  channel("geral", "text"),
];

describe("vanishedChannelFallback", () => {
  it("stays put while the open channel is still in the list", () => {
    expect(vanishedChannelFallback(list, "lobby")).toEqual({ vanished: false });
  });

  it("stays put with nothing open", () => {
    expect(vanishedChannelFallback(list, null)).toEqual({ vanished: false });
  });

  it("never treats Baú as deleted, since it is never in the list", () => {
    expect(vanishedChannelFallback(list, COMMUNITY_HOME_CHANNEL_ID)).toEqual({
      vanished: false,
    });
  });

  it("moves to the first text channel when the open one is gone", () => {
    expect(vanishedChannelFallback(list, "avisos")).toEqual({
      vanished: true,
      nextId: "geral",
    });
  });

  it("falls back to anything that is not a category", () => {
    const noText = [channel("cat", "category"), channel("lobby", "voice")];
    expect(vanishedChannelFallback(noText, "avisos")).toEqual({
      vanished: true,
      nextId: "lobby",
    });
  });

  it("has nowhere to go when only categories are left", () => {
    expect(
      vanishedChannelFallback([channel("cat", "category")], "avisos"),
    ).toEqual({ vanished: true, nextId: null });
  });
});

describe("channelListRetryDelayMs", () => {
  it("backs off after each failed try, then gives up", () => {
    expect(channelListRetryDelayMs(1)).toBe(1_000);
    expect(channelListRetryDelayMs(2)).toBe(4_000);
    expect(channelListRetryDelayMs(3)).toBe(10_000);
    expect(channelListRetryDelayMs(4)).toBe(30_000);
    expect(channelListRetryDelayMs(5)).toBeNull();
  });
});

describe("createChannelListTickets", () => {
  it("lets only the newest of two quick nudge refetches write the list", () => {
    const tickets = createChannelListTickets();
    const create = tickets.take();
    const rename = tickets.take();
    // The rename's refetch answers first, then the create's: only the
    // rename's may land.
    expect(tickets.isLatest(rename)).toBe(true);
    expect(tickets.isLatest(create)).toBe(false);
  });

  it("drops a refetch from an earlier visit once the person has left and come back", () => {
    const tickets = createChannelListTickets();
    // On server A, a nudge refetch starts and hangs.
    const nudgeOnA = tickets.take();
    // The person opens B, then A again: each open is a load with its own
    // ticket.
    tickets.take();
    const reopenA = tickets.take();
    // The reopen's list is current; the hung refetch from the first visit,
    // answering last, is not.
    expect(tickets.isLatest(reopenA)).toBe(true);
    expect(tickets.isLatest(nudgeOnA)).toBe(false);
  });

  it("tells a navigation load that a nudge started while it was in flight", () => {
    const tickets = createChannelListTickets();
    const load = tickets.take();
    const nudge = tickets.take();
    // The load writes its list anyway (it is the open server's only one yet)
    // and, seeing it is not the latest, asks for one more refetch.
    expect(tickets.isLatest(load)).toBe(false);
    expect(tickets.isLatest(nudge)).toBe(true);
  });

  it("owes the nudge's refetch when a load that overtook it fails", () => {
    const tickets = createChannelListTickets();
    // A nudge refetch starts (or failed and waits on its backoff); a load of
    // the same server takes a newer ticket, so the nudge's answer, or its
    // retry, will find itself stale.
    const nudge = tickets.take();
    tickets.updateStarted("a", nudge);
    const load = tickets.take();
    expect(tickets.isLatest(nudge)).toBe(false);
    // The load fails. Nothing has written the change: refetch.
    expect(tickets.owesUpdate("a", load)).toBe(true);
  });

  it("owes nothing once a load that overtook the nudge wrote the list", () => {
    const tickets = createChannelListTickets();
    const nudge = tickets.take();
    tickets.updateStarted("a", nudge);
    const load = tickets.take();
    tickets.wrote(load);
    // A later load failing has nothing to bring back: the list it would have
    // replaced already holds the change.
    const next = tickets.take();
    expect(tickets.owesUpdate("a", next)).toBe(false);
  });

  it("leaves a failed load alone when something newer is in charge", () => {
    const tickets = createChannelListTickets();
    const nudge = tickets.take();
    tickets.updateStarted("a", nudge);
    const load = tickets.take();
    // A second nudge started after the load: its own retries own the change.
    const again = tickets.take();
    tickets.updateStarted("a", again);
    expect(tickets.owesUpdate("a", load)).toBe(false);
  });

  it("does not refetch another server for a nudge it never got", () => {
    const tickets = createChannelListTickets();
    const nudge = tickets.take();
    tickets.updateStarted("a", nudge);
    // The person opened B and its load failed: A's change is fetched fresh
    // when they go back to A.
    const loadB = tickets.take();
    expect(tickets.owesUpdate("b", loadB)).toBe(false);
  });

  it("does not let an older write clear a newer nudge", () => {
    const tickets = createChannelListTickets();
    const load = tickets.take();
    const nudge = tickets.take();
    tickets.updateStarted("a", nudge);
    // The load answers first and writes its (older) list.
    tickets.wrote(load);
    const next = tickets.take();
    expect(tickets.owesUpdate("a", next)).toBe(true);
  });
});
