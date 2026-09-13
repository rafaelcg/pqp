import { describe, expect, it } from "vitest";
import { watchPartyHistoryCandidates } from "./watch-party-history-access";

const cinema = { id: "chan-cinema", name: "cinema", type: "watch_party" };
const premiere = { id: "chan-premiere", name: "premiere", type: "watch_party" };
const lobby = { id: "chan-lobby", name: "lobby", type: "voice" };
const geral = { id: "chan-geral", name: "geral", type: "text" };

describe("watchPartyHistoryCandidates", () => {
  it("is empty when there are no watch_party channels at all", () => {
    expect(
      watchPartyHistoryCandidates([lobby, geral], () => true),
    ).toEqual([]);
  });

  it("drops a watch_party channel this viewer may not see the history of", () => {
    expect(
      watchPartyHistoryCandidates([cinema, lobby], () => false),
    ).toEqual([]);
  });

  it("keeps a watch_party channel this viewer may manage, and only that one", () => {
    expect(
      watchPartyHistoryCandidates(
        [cinema, lobby, geral],
        (channelId) => channelId === cinema.id,
      ),
    ).toEqual([{ id: cinema.id, name: cinema.name }]);
  });

  it("checks permission per channel, not per server", () => {
    // START_WATCH_PARTY / MANAGE_CHANNELS carry per-channel overwrites, so a
    // moderator can be denied on one watch_party channel and allowed on
    // another in the same server.
    const result = watchPartyHistoryCandidates(
      [cinema, premiere, lobby],
      (channelId) => channelId === premiere.id,
    );
    expect(result).toEqual([{ id: premiere.id, name: premiere.name }]);
  });

  it("never returns a non-watch_party channel even with blanket permission", () => {
    const result = watchPartyHistoryCandidates(
      [cinema, lobby, geral],
      () => true,
    );
    expect(result.map((c) => c.id)).toEqual([cinema.id]);
  });

  it("can return more than one candidate", () => {
    const result = watchPartyHistoryCandidates(
      [cinema, premiere, lobby],
      () => true,
    );
    expect(result.map((c) => c.id).sort()).toEqual(
      [cinema.id, premiere.id].sort(),
    );
  });
});
