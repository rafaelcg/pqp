// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountAppFrame, type AppFrameController } from "./frame-controller";
import { FakeTheme, FakeTransport, baseApp, users } from "./bridge-host.fixture";
import { ShareAudioRelay, ShareAudioSink, type SinkContext } from "./share-audio";

/*
 * The app's sound for a share, through a real frame controller: the relay's want reaches the app as a push, the
 * app's blocks reach the relay's sink, and a frame that is gone stops listening.
 */

const APPS = "http://localhost:5175";
let container: HTMLElement;
const mounted: AppFrameController[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  for (const controller of mounted.splice(0)) controller.destroy();
  container.remove();
  document.head.querySelectorAll("meta").forEach((meta) => meta.remove());
});

function fakeSink() {
  const scheduled: number[] = [];
  const context: SinkContext = {
    currentTime: 0,
    state: "running",
    createBuffer: (channels, frames, rate) => ({ duration: frames / rate, copyToChannel() {}, channels }) as never,
    createBufferSource: () => ({
      buffer: null,
      connect() {},
      onended: null,
      start: (when: number) => void scheduled.push(when),
    }),
    createMediaStreamDestination: () => ({
      stream: { getAudioTracks: () => [{ stop() {} }] } as unknown as MediaStream,
    }),
    resume: async () => {},
    close: async () => {},
  };
  return { scheduled, relay: new ShareAudioRelay(() => new ShareAudioSink({ createContext: () => context })) };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** Mounts a pane app, completes the handshake and hands back the app's end of the port. */
async function mountWithPort(relay: ShareAudioRelay) {
  const app = baseApp({
    capabilities: { identity: "display", share: "pane", localFiles: { allowed: false }, peer: "none" },
    shareAllowed: true,
  } as never);
  const controller = mountAppFrame({
    container,
    app,
    appsOrigin: APPS,
    title: "Locadora",
    transport: new FakeTransport(),
    users,
    locale: () => "pt-BR",
    host: { theme: new FakeTheme(), fetchImpl: (async () => new Response("no", { status: 404 })) as typeof fetch },
    shareAudio: relay,
  });
  mounted.push(controller);
  const frame = container.querySelector("iframe")!;
  let port: MessagePort | null = null;
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(((_message: unknown, _origin: string, transfer: MessagePort[]) => {
    port = transfer[0] ?? null;
  }) as never);
  window.dispatchEvent(
    new MessageEvent("message", { data: { pqp: "app-hello", platformApi: 1 }, source: frame.contentWindow }),
  );
  await flush();
  const received: Array<Record<string, unknown>> = [];
  port!.onmessage = (event) => received.push(event.data as Record<string, unknown>);
  await flush();
  return { controller, port: port!, received };
}

describe("the frame and the app's sound for a share", () => {
  it("tells the app to send while the share runs, takes its blocks into the share, and tells it to stop", async () => {
    const { relay, scheduled } = fakeSink();
    const { port, received } = await mountWithPort(relay);
    received.length = 0;

    await relay.begin();
    await flush();
    expect(received).toContainEqual({ type: "share.audio", on: true });

    const samples = new Float32Array(2048 * 2).fill(0.25).buffer;
    port.postMessage({ id: "a1", type: "share.audio", rate: 48000, channels: 2, samples }, [samples]);
    await flush();
    expect(received).toContainEqual({ id: "a1", ok: true, type: "share.audio", result: null });
    expect(scheduled).toHaveLength(1);

    relay.end();
    await flush();
    expect(received).toContainEqual({ type: "share.audio", on: false });
  });

  it("a frame that mounts after the share started is told at once, so a reload mid-share keeps its sound", async () => {
    const { relay } = fakeSink();
    await relay.begin();
    const { received } = await mountWithPort(relay);
    await flush();
    expect(received).toContainEqual({ type: "share.audio", on: true });
  });

  it("a destroyed frame stops listening to the relay", async () => {
    const { relay } = fakeSink();
    const { controller, received } = await mountWithPort(relay);
    controller.destroy();
    received.length = 0;
    await expect(relay.begin()).resolves.toBeTruthy();
    await flush();
    // the port is closed with the frame: nothing more reaches it
    expect(received).toEqual([]);
    relay.end();
  });
});
