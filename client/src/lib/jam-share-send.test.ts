import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerShareSender, sendShareMessage, settleShareFrame } from "@/lib/jam-share-send";

type Frame = { type: "message-create"; channelId: string; body: string; nonce: string };

describe("sendShareMessage", () => {
  const sent: Frame[] = [];
  let online = true;
  let throws = false;
  let off: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    sent.length = 0;
    online = true;
    throws = false;
    off = registerShareSender({
      isOnline: () => online,
      send: (frame) => {
        if (throws) {
          throw new Error("closed");
        }
        sent.push(frame);
      },
    });
  });

  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it("resolves ok on the broadcast carrying its nonce, and by reason on a rejection", async () => {
    const first = sendShareMessage("c1", "link-a");
    settleShareFrame({ type: "message-broadcast", nonce: sent[0]!.nonce });
    expect(await first).toEqual({ ok: true });
    const second = sendShareMessage("c1", "link-b");
    settleShareFrame({ type: "message-rejected", nonce: sent[1]!.nonce, reason: "slow-mode" });
    expect(await second).toEqual({ ok: false, reason: "slow-mode" });
  });

  it("is offline without sending when the socket is not online", async () => {
    online = false;
    expect(await sendShareMessage("c1", "x")).toEqual({ ok: false, reason: "offline" });
    expect(sent).toHaveLength(0);
  });

  it("a send that throws is a failure on the row, not a stuck spinner", async () => {
    throws = true;
    expect(await sendShareMessage("c1", "x")).toEqual({ ok: false, reason: "offline" });
  });

  it("a retry after a lost answer carries the same nonce, so the server cannot post the link twice", async () => {
    const lost = sendShareMessage("c9", "same-link");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await lost).toEqual({ ok: false, reason: "timeout" });
    const retry = sendShareMessage("c9", "same-link");
    expect(sent[1]!.nonce).toBe(sent[0]!.nonce);
    settleShareFrame({ type: "message-broadcast", nonce: sent[1]!.nonce });
    expect(await retry).toEqual({ ok: true });
    // answered: the next send of the same text is a new message
    void sendShareMessage("c9", "same-link");
    expect(sent[2]!.nonce).not.toBe(sent[0]!.nonce);
  });
});
