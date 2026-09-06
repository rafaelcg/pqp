import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHub, type BusFrame, type BusTransport } from "../lib/bus.js";

/**
 * `voice.hello`: the boot-time self-echo check and the config-drift log.
 *
 * Fresh module graph per test so the import-time subscription and the
 * instance id are the test's own; the memory transport delivers a frame back
 * to its publisher exactly as Postgres does, which is what the echo relies on.
 */

type BusModule = typeof import("../lib/bus.js");
type HelloModule = typeof import("./voice-hello.js");

let hub = createMemoryHub();
let onTheWire: BusFrame[] = [];

async function boot(transport?: BusTransport | "memory"): Promise<{
  bus: BusModule;
  hello: HelloModule;
}> {
  vi.resetModules();
  const bus = (await import("../lib/bus.js")) as BusModule;
  const hello = (await import("./voice-hello.js")) as HelloModule;
  if (transport === "memory") {
    bus.setBusTransport(bus.createMemoryTransport(hub));
  } else if (transport) {
    bus.setBusTransport(transport);
  }
  return { bus, hello };
}

function logged(event: string): string[] {
  return (console.log as ReturnType<typeof vi.fn>).mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes(event));
}

beforeEach(() => {
  vi.useFakeTimers();
  hub = createMemoryHub();
  onTheWire = [];
  hub.listeners.add((frame) => onTheWire.push(frame));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("voice.hello", () => {
  it("does nothing at all with the bus off", async () => {
    const { hello } = await boot();
    const stop = hello.startVoiceHello(Promise.resolve());
    await vi.runAllTimersAsync();

    expect(onTheWire).toHaveLength(0);
    expect(logged("bus.selfEcho")).toHaveLength(0);
    stop();
  });

  it("publishes once connected and is satisfied by its own echo", async () => {
    const { bus, hello } = await boot("memory");
    let connect!: () => void;
    const ready = new Promise<void>((resolve) => {
      connect = resolve;
    });
    const stop = hello.startVoiceHello(ready);

    // Nothing before the transport says it is up.
    await vi.advanceTimersByTimeAsync(10);
    expect(onTheWire).toHaveLength(0);

    connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(onTheWire).toHaveLength(1);
    expect(onTheWire[0]).toMatchObject({
      origin: bus.INSTANCE_ID,
      topic: hello.VOICE_HELLO_TOPIC,
      data: { instance: bus.INSTANCE_ID, configHash: "mesh" },
    });
    expect(logged("bus.selfEcho ")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(hello.SELF_ECHO_TIMEOUT_MS + 100);
    expect(logged("bus.selfEchoMissing")).toHaveLength(0);
    stop();
  });

  it("logs loudly when the echo never arrives", async () => {
    // A transport that accepts frames and delivers none: the transaction-mode
    // pooler shape.
    const silent: BusTransport = {
      name: "silent",
      publish: () => {},
      onFrame: () => {},
      close: async () => {},
    };
    const { hello } = await boot(silent);
    const stop = hello.startVoiceHello(Promise.resolve());

    await vi.advanceTimersByTimeAsync(hello.SELF_ECHO_TIMEOUT_MS - 100);
    expect(logged("bus.selfEchoMissing")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    expect(logged("bus.selfEchoMissing")).toHaveLength(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    stop();
  });

  it("logs configDrift for a foreign hello with another hash, and answers it once", async () => {
    const { bus, hello } = await boot("memory");
    hub.listeners.forEach((listener) =>
      listener({
        origin: "other-instance",
        topic: hello.VOICE_HELLO_TOPIC,
        data: { instance: "other-instance", configHash: "deadbeef" },
      }),
    );

    const drift = logged("voice.configDrift");
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("ours=mesh");
    expect(drift[0]).toContain("theirs=deadbeef");

    // Exactly one answer, carrying our hash, marked as a reply.
    const replies = onTheWire.filter((frame) => frame.origin === bus.INSTANCE_ID);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.data).toMatchObject({ configHash: "mesh", reply: true });

    // A reply is never answered, so two instances cannot ping-pong.
    hub.listeners.forEach((listener) =>
      listener({
        origin: "other-instance",
        topic: hello.VOICE_HELLO_TOPIC,
        data: { instance: "other-instance", configHash: "deadbeef", reply: true },
      }),
    );
    expect(
      onTheWire.filter((frame) => frame.origin === bus.INSTANCE_ID),
    ).toHaveLength(1);
    expect(logged("voice.configDrift")).toHaveLength(2);
  });

  it("stays quiet for a foreign hello with the same hash", async () => {
    const { hello } = await boot("memory");
    hub.listeners.forEach((listener) =>
      listener({
        origin: "other-instance",
        topic: hello.VOICE_HELLO_TOPIC,
        data: { instance: "other-instance", configHash: "mesh" },
      }),
    );
    expect(logged("voice.configDrift")).toHaveLength(0);
  });
});
