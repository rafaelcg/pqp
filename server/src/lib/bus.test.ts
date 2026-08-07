import { afterEach, describe, expect, it } from "vitest";
import {
  closeBus,
  createMemoryHub,
  createMemoryTransport,
  INSTANCE_ID,
  isBusEnabled,
  publishToCluster,
  resetBusSubscriptions,
  setBusTransport,
  subscribeToCluster,
  type BusFrame,
  type BusTransport,
} from "./bus.js";

/**
 * The facade's two jobs: be completely absent when no transport is installed,
 * and never hand an instance back its own frames. The second is not a nicety —
 * Postgres delivers a NOTIFY to the session that sent it, so without it every
 * broadcast would be redelivered locally and any handler that republished would
 * spin forever.
 */

afterEach(async () => {
  await closeBus();
  resetBusSubscriptions();
});

describe("cluster bus", () => {
  it("is off until a transport is installed", () => {
    const received: unknown[] = [];
    subscribeToCluster("t", (data) => received.push(data));

    expect(isBusEnabled()).toBe(false);
    publishToCluster("t", { hello: true });

    expect(received).toEqual([]);
  });

  it("drops a frame it published itself", () => {
    const hub = createMemoryHub();
    const received: unknown[] = [];
    subscribeToCluster("t", (data) => received.push(data));
    setBusTransport(createMemoryTransport(hub));

    publishToCluster("t", { hello: true });

    // The memory transport echoed it back, exactly as Postgres would.
    expect(received).toEqual([]);
  });

  it("delivers a frame from another instance, with its origin", () => {
    const hub = createMemoryHub();
    const received: Array<[unknown, string]> = [];
    subscribeToCluster("t", (data, origin) => received.push([data, origin]));
    setBusTransport(createMemoryTransport(hub));

    // A second transport on the same hub stands in for another process.
    const other = createMemoryTransport(hub);
    other.publish({ origin: "instance-b", topic: "t", data: { hello: true } });

    expect(received).toEqual([[{ hello: true }, "instance-b"]]);
    expect(INSTANCE_ID).not.toBe("instance-b");
  });

  it("routes only to the subscribers of the frame's topic", () => {
    const hub = createMemoryHub();
    const wrong: unknown[] = [];
    subscribeToCluster("other", (data) => wrong.push(data));
    setBusTransport(createMemoryTransport(hub));

    createMemoryTransport(hub).publish({
      origin: "instance-b",
      topic: "t",
      data: 1,
    });

    expect(wrong).toEqual([]);
  });

  it("keeps running the other handlers when one throws", () => {
    const hub = createMemoryHub();
    const received: unknown[] = [];
    subscribeToCluster("t", () => {
      throw new Error("handler blew up");
    });
    subscribeToCluster("t", (data) => received.push(data));
    setBusTransport(createMemoryTransport(hub));

    createMemoryTransport(hub).publish({
      origin: "instance-b",
      topic: "t",
      data: 1,
    });

    expect(received).toEqual([1]);
  });

  it("swallows a transport that throws on publish", () => {
    // A bus failure must never reach the caller: by the time anything is
    // published, the local sockets have already been served.
    const broken: BusTransport = {
      name: "broken",
      publish() {
        throw new Error("bus is down");
      },
      onFrame() {},
      async close() {},
    };
    setBusTransport(broken);

    expect(() => publishToCluster("t", { hello: true })).not.toThrow();
  });

  it("stops publishing once closed", async () => {
    const hub = createMemoryHub();
    const seen: BusFrame[] = [];
    hub.listeners.add((frame) => seen.push(frame));
    setBusTransport(createMemoryTransport(hub));

    await closeBus();
    publishToCluster("t", { hello: true });

    expect(isBusEnabled()).toBe(false);
    expect(seen).toEqual([]);
  });
});
