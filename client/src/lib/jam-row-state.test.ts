import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetJamPlayer, followJamPlayer, isJamPlaying } from "./jam-now-playing";
import { jamRowMayAnimate, jamRowMood, type JamRowSignals } from "./jam-row-state";

const BASE: JamRowSignals = { selected: false, playing: false, news: false, loaded: true, songCount: 2 };

describe("jamRowMood", () => {
  it("is quiet for a Jam with songs and nothing going on", () => {
    expect(jamRowMood(BASE)).toBe("quiet");
  });

  it("is quiet while the count has not loaded, even with no songs read yet", () => {
    expect(jamRowMood({ ...BASE, loaded: false, songCount: 0 })).toBe("quiet");
  });

  it("is empty only once loaded with no songs", () => {
    expect(jamRowMood({ ...BASE, songCount: 0 })).toBe("empty");
  });

  it("shows news on a row that is not the open page", () => {
    expect(jamRowMood({ ...BASE, news: true })).toBe("news");
  });

  it("drops the news once the Jam is open: opening it spends the dot", () => {
    expect(jamRowMood({ ...BASE, news: true, selected: true })).toBe("quiet");
  });

  it("is playing when a song plays in the open Jam", () => {
    expect(jamRowMood({ ...BASE, selected: true, playing: true })).toBe("playing");
  });

  it("playing beats news and empty", () => {
    expect(jamRowMood({ ...BASE, selected: true, playing: true, news: true, songCount: 0 })).toBe("playing");
  });

  it("is playing on a row that is not the open page too: a song's card in a conversation plays on the same engine", () => {
    expect(jamRowMood({ ...BASE, playing: true })).toBe("playing");
    expect(jamRowMood({ ...BASE, playing: true, news: true })).toBe("playing");
  });

  it("an open, empty Jam is empty, not news", () => {
    expect(jamRowMood({ ...BASE, selected: true, news: true, songCount: 0 })).toBe("empty");
  });
});

describe("jamRowMayAnimate", () => {
  it("needs the row on screen and the tab visible", () => {
    expect(jamRowMayAnimate(true, true)).toBe(true);
    expect(jamRowMayAnimate(false, true)).toBe(false);
    expect(jamRowMayAnimate(true, false)).toBe(false);
    expect(jamRowMayAnimate(false, false)).toBe(false);
  });
});

describe("followJamPlayer", () => {
  afterEach(() => forgetJamPlayer());

  it("follows the transport of the shared engine's player and lets go of it", () => {
    let emit: (tick: { state: string }) => void = () => undefined;
    const unsubscribe = vi.fn();
    followJamPlayer({
      subscribe(listener) {
        emit = listener;
        listener({ state: "stopped" });
        return unsubscribe;
      },
    });
    expect(isJamPlaying()).toBe(false);
    emit({ state: "playing" });
    expect(isJamPlaying()).toBe(true);
    emit({ state: "playing" });
    expect(isJamPlaying()).toBe(true);
    emit({ state: "paused" });
    expect(isJamPlaying()).toBe(false);
    emit({ state: "playing" });
    forgetJamPlayer();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(isJamPlaying()).toBe(false);
  });

  it("switches to a new engine's player without leaving the old one running", () => {
    const first = vi.fn();
    let emitFirst: (tick: { state: string }) => void = () => undefined;
    followJamPlayer({
      subscribe(listener) {
        emitFirst = listener;
        return first;
      },
    });
    emitFirst({ state: "playing" });
    followJamPlayer({ subscribe: () => () => undefined });
    expect(first).toHaveBeenCalledTimes(1);
  });
});
