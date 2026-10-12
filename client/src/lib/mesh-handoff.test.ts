import { describe, expect, it } from "vitest";
import { planMeshHandoff } from "./mesh-handoff";
import type { RemotePeer } from "./peer-connection-manager";

/**
 * The bookkeeping behind a promotion that nobody notices: which copy of each
 * peer to play while the room moves from the mesh to the SFU, and when a
 * mesh connection can go. The two rules that matter most are pinned here:
 * nobody is ever played twice, and nobody goes silent because their mesh
 * connection was closed before the SFU had them.
 */

function stream(label: string): MediaStream {
  return { id: label } as unknown as MediaStream;
}

function peer(peerId: string, extra: Partial<RemotePeer> = {}): RemotePeer {
  return {
    peerId,
    connectionState: "connected",
    stream: null,
    screenStream: null,
    cameraStream: null,
    screenAudioStream: null,
    ...extra,
  };
}

describe("planMeshHandoff", () => {
  it("is the SFU's own list, untouched, once the mesh is gone", () => {
    const sfu = [peer("a", { stream: stream("sfu-a") })];
    const plan = planMeshHandoff(sfu, []);
    expect(plan.peers).toBe(sfu);
    expect(plan.retire).toEqual([]);
  });

  it("keeps playing the mesh while the SFU has nobody yet", () => {
    const mesh = [
      peer("a", { stream: stream("mesh-a") }),
      peer("b", { stream: stream("mesh-b") }),
    ];
    const plan = planMeshHandoff([], mesh);
    expect(plan.peers.map((p) => p.stream?.id)).toEqual(["mesh-a", "mesh-b"]);
    expect(plan.retire).toEqual([]);
  });

  it("keeps the mesh voice of a peer who is on the SFU but not yet heard there", () => {
    // Connected to the room, mic not subscribed yet: closing the mesh now is
    // exactly the silence this module exists to remove.
    const plan = planMeshHandoff(
      [peer("a", { connectionState: "connecting" })],
      [peer("a", { stream: stream("mesh-a") })],
    );
    expect(plan.peers).toHaveLength(1);
    expect(plan.peers[0]!.stream?.id).toBe("mesh-a");
    expect(plan.peers[0]!.connectionState).toBe("connected");
    expect(plan.retire).toEqual([]);
  });

  it("switches a peer to the SFU and retires its mesh the moment the SFU carries its voice", () => {
    const plan = planMeshHandoff(
      [peer("a", { stream: stream("sfu-a") })],
      [peer("a", { stream: stream("mesh-a") })],
    );
    expect(plan.peers).toHaveLength(1);
    expect(plan.peers[0]!.stream?.id).toBe("sfu-a");
    expect(plan.retire).toEqual(["a"]);
  });

  it("never plays the same voice twice", () => {
    const plan = planMeshHandoff(
      [peer("a", { stream: stream("sfu-a") })],
      [
        peer("a", {
          stream: stream("mesh-a"),
          screenStream: stream("mesh-a-screen"),
        }),
      ],
    );
    // The share has not arrived over the SFU yet, so the mesh connection
    // stays for the picture, but the voice already comes from the SFU only.
    expect(plan.peers).toHaveLength(1);
    expect(plan.peers[0]!.stream?.id).toBe("sfu-a");
    expect(plan.peers[0]!.screenStream?.id).toBe("mesh-a-screen");
    expect(plan.retire).toEqual([]);
  });

  it("waits for the share and the camera before retiring a presenter's mesh", () => {
    const mesh = [
      peer("a", {
        stream: stream("mesh-a"),
        screenStream: stream("mesh-a-screen"),
        cameraStream: stream("mesh-a-camera"),
      }),
    ];
    const partial = planMeshHandoff(
      [peer("a", { stream: stream("sfu-a"), screenStream: stream("sfu-a-screen") })],
      mesh,
    );
    expect(partial.retire).toEqual([]);
    expect(partial.peers[0]!.cameraStream?.id).toBe("mesh-a-camera");

    const full = planMeshHandoff(
      [
        peer("a", {
          stream: stream("sfu-a"),
          screenStream: stream("sfu-a-screen"),
          cameraStream: stream("sfu-a-camera"),
        }),
      ],
      mesh,
    );
    expect(full.retire).toEqual(["a"]);
    expect(full.peers[0]!.screenStream?.id).toBe("sfu-a-screen");
  });

  it("retires a silent mesh entry once that peer is on the SFU", () => {
    // A listener with no mic: the mesh carried only OUR voice to them, which
    // the SFU now does.
    const plan = planMeshHandoff([peer("a")], [peer("a")]);
    expect(plan.retire).toEqual(["a"]);
  });

  it("keeps the tiles people are looking at in their order, then adds the SFU's newcomers", () => {
    const plan = planMeshHandoff(
      [peer("c", { stream: stream("sfu-c") }), peer("a")],
      [peer("a", { stream: stream("mesh-a") }), peer("b", { stream: stream("mesh-b") })],
    );
    expect(plan.peers.map((p) => p.peerId)).toEqual(["a", "b", "c"]);
  });
});
