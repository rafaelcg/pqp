import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteVideoDelivery,
  HIDDEN_GRACE_MS,
  OFFSCREEN_GRACE_MS,
  type DeliveryPublication,
} from "./remote-video-delivery";

/**
 * The rule that pauses video nobody is drawing, pinned on a fake publication
 * so every `setEnabled` it sends is visible. What is asserted is the
 * sequence of calls, because a wrong sequence here is a picture that never
 * comes back (paused and forgotten) or bytes that never stop (never paused),
 * and both look, from the UI, like "it works".
 */

function publication() {
  const calls: boolean[] = [];
  const pub: DeliveryPublication & { calls: boolean[] } = {
    calls,
    setEnabled(enabled: boolean) {
      calls.push(enabled);
    },
  };
  return pub;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("off-screen tiles", () => {
  it("pauses a track nothing ever binds, after the grace", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    expect(pub.calls).toEqual([]);

    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS - 1);
    expect(pub.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(pub.calls).toEqual([false]);
    expect(delivery.isPaused(pub)).toBe(true);
  });

  it("never pauses a track a tile binds within the grace", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    delivery.attached(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS * 3);
    expect(pub.calls).toEqual([]);
  });

  it("pauses a parked tile and resumes it at once when it comes back", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    delivery.attached(pub);
    // The rail scrolls the tile away: the tile unmounts its <video>.
    delivery.detached(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS);
    expect(pub.calls).toEqual([false]);

    // It scrolls back. No grace on the way up: a resume is what the person
    // is waiting for.
    delivery.attached(pub);
    expect(pub.calls).toEqual([false, true]);
    expect(delivery.isPaused(pub)).toBe(false);
  });

  it("does not blink across a rebind inside the grace", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    delivery.attached(pub);
    delivery.detached(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS / 2);
    delivery.attached(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS * 2);
    expect(pub.calls).toEqual([]);
  });

  it("keeps a track delivered while any one of its elements remains", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    // The stage and a rail thumbnail both draw the same share.
    delivery.attached(pub);
    delivery.attached(pub);
    delivery.detached(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS * 2);
    expect(pub.calls).toEqual([]);
    delivery.detached(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS);
    expect(pub.calls).toEqual([false]);
  });

  it("uses the supplied release to lift a pause", () => {
    const released: DeliveryPublication[] = [];
    const delivery = createRemoteVideoDelivery({
      release: (pub) => released.push(pub),
    });
    const pub = publication();
    delivery.register(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS);
    delivery.attached(pub);
    expect(pub.calls).toEqual([false]);
    expect(released).toEqual([pub]);
  });

  it("forgets an unsubscribed track without sending anything", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    delivery.unregister(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS * 2);
    delivery.attached(pub);
    expect(pub.calls).toEqual([]);
  });

  it("survives a publication that refuses", () => {
    const delivery = createRemoteVideoDelivery();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pub: DeliveryPublication = {
      setEnabled() {
        throw new Error("not subscribed");
      },
    };
    delivery.register(pub);
    expect(() => vi.advanceTimersByTime(OFFSCREEN_GRACE_MS)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("a hidden tab", () => {
  it("pauses every video after the hidden grace and resumes on return", () => {
    const delivery = createRemoteVideoDelivery();
    const share = publication();
    const camera = publication();
    delivery.register(share);
    delivery.register(camera);
    delivery.attached(share);
    delivery.attached(camera);

    delivery.setTabHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS - 1);
    expect(share.calls).toEqual([]);
    expect(camera.calls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(share.calls).toEqual([false]);
    expect(camera.calls).toEqual([false]);

    delivery.setTabHidden(false);
    expect(share.calls).toEqual([false, true]);
    expect(camera.calls).toEqual([false, true]);
  });

  it("ignores a glance at another window", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    delivery.attached(pub);
    delivery.setTabHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS / 2);
    delivery.setTabHidden(false);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS * 2);
    expect(pub.calls).toEqual([]);
  });

  it("pauses a track that arrives while the tab is already paused, without a second grace", () => {
    const delivery = createRemoteVideoDelivery();
    delivery.setTabHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    const pub = publication();
    delivery.register(pub);
    expect(pub.calls).toEqual([false]);
    delivery.attached(pub);
    // Bound, but the tab is still hidden: it stays paused until the tab returns.
    expect(pub.calls).toEqual([false]);
    delivery.setTabHidden(false);
    expect(pub.calls).toEqual([false, true]);
  });

  it("leaves a tile that was already parked paused when the tab returns", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS);
    delivery.setTabHidden(true);
    vi.advanceTimersByTime(HIDDEN_GRACE_MS);
    delivery.setTabHidden(false);
    expect(pub.calls).toEqual([false]);
  });

  it("drops its timers on dispose and resumes nothing", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    delivery.register(pub);
    delivery.setTabHidden(true);
    delivery.dispose();
    vi.advanceTimersByTime(HIDDEN_GRACE_MS * 2);
    expect(pub.calls).toEqual([]);
  });
});

/**
 * THE BOUNDED GRID'S HALF OF THE BARGAIN (2026-09-08).
 *
 * `stage-layout.ts` draws at most twelve tiles on a laptop and six on a phone,
 * and hands the rest to the strip as chips. That is only a bandwidth saving
 * because of this module: a tile the grid does not draw mounts no `<video>`,
 * so nothing binds, so the server is told to stop forwarding it. If this rule
 * were removed the grid would still look right and the phone would still be
 * receiving twenty streams, which is the exact shape of bug this codebase
 * keeps producing.
 */
describe("a camera the bounded grid could not draw", () => {
  it("stops arriving, and comes straight back if it earns a tile", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    // On the stage: a tile mounted a video element for it.
    delivery.register(pub);
    delivery.attached(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS * 3);
    expect(pub.calls).toEqual([]);

    // The room grew past the bound and this camera became a chip, so its tile
    // unmounted and `bindRemoteVideo`'s cleanup detached the element.
    delivery.detached(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS);
    expect(pub.calls).toEqual([false]);
    expect(delivery.isPaused(pub)).toBe(true);

    // They spoke, so the grid promoted them out of the overflow.
    delivery.attached(pub);
    expect(pub.calls).toEqual([false, true]);
    expect(delivery.isPaused(pub)).toBe(false);
  });

  it("never starts arriving for a camera the grid never drew", () => {
    const delivery = createRemoteVideoDelivery();
    const pub = publication();
    // Somebody in the overflow from the moment they turned their camera on:
    // the publication exists and no tile ever binds to it.
    delivery.register(pub);
    vi.advanceTimersByTime(OFFSCREEN_GRACE_MS * 10);
    expect(pub.calls).toEqual([false]);
  });
});
