import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPeerConnectionManager,
  meshScreenBitrate,
} from "./peer-connection-manager";
import {
  DEFAULT_SCREEN_UPLOAD_BUDGET_BPS,
  SCREEN_BUDGET_SAMPLE_MS,
} from "./screen-upload-budget";
import { DEFAULT_VIDEO_QUALITY, screenBitrateFor } from "./video-quality";

/**
 * What the encoder is told, and whether saying no to it can break a call.
 *
 * These are the two questions the rest of this module's behaviour cannot be
 * reasoned about from a diff. A fake `RTCPeerConnection` is enough for both:
 * nothing here exercises SDP, ICE or media, only which numbers reach
 * `setParameters` and what happens when that rejects. Everything real about
 * WebRTC stays out of scope on purpose, because a fake that tried to model it
 * would be testing itself.
 *
 * SEPARATE FROM `peer-connection-manager.test.ts` because that file's fake
 * models track plumbing and has no `getParameters` on its senders. Bolting a
 * parameters surface onto it would make every test there carry state that only
 * these ones read.
 */

interface FakeSender {
  track: { id: string; kind: string } | null;
  params: RTCRtpSendParameters;
  setParameters: ReturnType<typeof vi.fn>;
  getParameters: () => RTCRtpSendParameters;
  replaceTrack: ReturnType<typeof vi.fn>;
}

const senders: FakeSender[] = [];
/** Set by a test to make every `setParameters` reject, as a browser may. */
let rejectSetParameters = false;

function makeSender(track: { id: string; kind: string }): FakeSender {
  const sender: FakeSender = {
    track,
    params: { encodings: [{}] } as RTCRtpSendParameters,
    getParameters: () => sender.params,
    setParameters: vi.fn(async (next: RTCRtpSendParameters) => {
      if (rejectSetParameters) {
        throw new Error("InvalidStateError");
      }
      sender.params = next;
    }),
    replaceTrack: vi.fn(async (next: { id: string; kind: string } | null) => {
      sender.track = next;
    }),
  };
  senders.push(sender);
  return sender;
}

class FakePeerConnection {
  senders: FakeSender[] = [];
  signalingState = "stable";
  iceConnectionState = "new";
  connectionState = "new";
  localDescription = { sdp: "fake", type: "offer" };
  remoteDescription = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;

  addTrack(track: { id: string; kind: string }) {
    const sender = makeSender(track);
    this.senders.push(sender);
    return sender as unknown as RTCRtpSender;
  }
  removeTrack() {}
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return [];
  }
  async createOffer() {
    return { type: "offer", sdp: "fake" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "fake" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  setConfiguration() {}
  close() {}
  async getStats() {
    return new Map();
  }
}

/**
 * A video track that can be asked how big it is.
 *
 * `getSettings` is here because the screen tuning now has to divide the capture
 * down to the size the menu names, and the divisor can only come from the
 * track's own dimensions: a hard-coded one would mean 360p on a 1080p monitor
 * and 480p on a 1440p one.
 */
const videoTrack = (id: string, height = 1080) => ({
  id,
  kind: "video",
  getSettings: () => ({ width: Math.round((height * 16) / 9), height }),
});

/** A stream carrying exactly one video track, which is all these paths read. */
function fakeStream(id: string, height = 1080): MediaStream {
  const track = videoTrack(id, height);
  return {
    id,
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
}

const original = globalThis.RTCPeerConnection;

beforeEach(() => {
  senders.length = 0;
  rejectSetParameters = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection =
    FakePeerConnection;
});

afterEach(() => {
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = original;
  vi.restoreAllMocks();
});

/** The parameters last accepted by a sender, whichever call won. */
const lastParams = (sender: FakeSender) =>
  sender.setParameters.mock.calls.at(-1)?.[0] as
    | RTCRtpSendParameters
    | undefined;

const cameraSenders = () => senders.filter((s) => s.track?.id === "camera");
const screenSenders = () => senders.filter((s) => s.track?.id === "screen");

describe("camera sender tuning", () => {
  it("gives a camera a ceiling and a framerate preference", async () => {
    // Before this existed the camera sender was added and never touched, so it
    // ran with no ceiling at all against a shared bandwidth estimate.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setCameraMaxBitrate(900_000);
    manager.connectToPeer("a-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));

    const params = lastParams(cameraSenders()[0]!);
    expect(params?.degradationPreference).toBe("maintain-framerate");
    expect(params?.encodings[0]?.maxBitrate).toBe(900_000);
    expect(params?.encodings[0]?.maxFramerate).toBe(30);
  });

  it("gives the same ceiling to somebody who joins mid-call", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setCameraMaxBitrate(700_000);
    manager.connectToPeer("a-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));
    manager.connectToPeer("b-remote");

    await Promise.resolve();
    expect(cameraSenders()).toHaveLength(2);
    for (const sender of cameraSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(700_000);
    }
  });

  it("divides the room, instead of giving every viewer a full copy", async () => {
    // THE BUG THIS FIXES, recorded in docs/HANDOVER.md on 25 Aug and left
    // alone since. A mesh uploads one copy per viewer and the camera divided
    // nothing, so a four-way call permitted about 4.46 Mbps of camera off one
    // machine. The screen has divided the room since it was written.
    const manager = createPeerConnectionManager("z-local", () => {});
    for (const id of ["a", "b", "c", "d"]) {
      manager.connectToPeer(`${id}-remote`);
    }
    await manager.setLocalCameraStream(fakeStream("camera"));
    await Promise.resolve();

    const live = cameraSenders().filter((sender) => sender.track !== null);
    expect(live).toHaveLength(4);
    const total = live.reduce(
      (sum, sender) => sum + (lastParams(sender)?.encodings[0]?.maxBitrate ?? 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(DEFAULT_SCREEN_UPLOAD_BUDGET_BPS);
    manager.dispose();
  });

  it("leaves the chosen ceiling alone when the room is small enough to afford it", async () => {
    // Dividing must not become a second, invisible quality setting. Two
    // viewers of a 5 Mbps budget is 2.5 Mbps a copy, so a 700 kbps choice is
    // what the person gets.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setCameraMaxBitrate(700_000);
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));
    await Promise.resolve();

    for (const sender of cameraSenders().filter((s) => s.track !== null)) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(700_000);
    }
    manager.dispose();
  });

  it("splits one uplink with a share instead of both claiming all of it", async () => {
    // `tuneCameraSender`'s own comment described the symptom before there was
    // a fix: "the two video senders then bid against each other for one
    // bandwidth estimate with nothing arbitrating, which is how a camera ends
    // up at 240p while the share looks fine". They ride one uplink and
    // `availableOutgoingBitrate` measures that whole uplink, so handing it all
    // to the screen double-commits the link.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));
    await manager.setLocalScreenStream(fakeStream("screen"));
    await Promise.resolve();

    const perPeer = DEFAULT_SCREEN_UPLOAD_BUDGET_BPS / 2;
    const camera =
      lastParams(cameraSenders().filter((s) => s.track !== null)[0]!)
        ?.encodings[0]?.maxBitrate ?? 0;
    const screen =
      lastParams(screenSenders().filter((s) => s.track !== null)[0]!)
        ?.encodings[0]?.maxBitrate ?? 0;

    expect(camera).toBeGreaterThan(0);
    expect(screen).toBeGreaterThan(0);
    // Together they fit in one viewer's share, which is the whole point.
    expect(camera + screen).toBeLessThanOrEqual(perPeer + 1);
    // And the screen, being the more expensive picture, gets the larger slice.
    expect(screen).toBeGreaterThan(camera);
    manager.dispose();
  });

  it("splits the same whichever sender started first", async () => {
    // FOUND IN REVIEW, and it was the common ordering that broke: people share
    // first and turn the camera on afterwards. Nothing retuned the screen on
    // that edge, so it kept the whole share and the pair asked for 133 % of
    // it — the double-commit this change exists to remove.
    const both = async (order: "camera" | "screen") => {
      const manager = createPeerConnectionManager("z-local", () => {});
      manager.connectToPeer("a-remote");
      manager.connectToPeer("b-remote");
      if (order === "camera") {
        await manager.setLocalCameraStream(fakeStream("camera"));
        await manager.setLocalScreenStream(fakeStream("screen"));
      } else {
        await manager.setLocalScreenStream(fakeStream("screen"));
        await manager.setLocalCameraStream(fakeStream("camera"));
      }
      await Promise.resolve();
      const pick = (id: string) =>
        lastParams(senders.filter((x) => x.track?.id === id)[0]!)?.encodings[0]
          ?.maxBitrate ?? 0;
      const out = { screen: pick("screen"), camera: pick("camera") };
      manager.dispose();
      return out;
    };
    const cameraFirst = await both("camera");
    const shareFirst = await both("screen");
    expect(shareFirst).toEqual(cameraFirst);
    // And together they are exactly one viewer's share, not more.
    expect(shareFirst.screen + shareFirst.camera).toBe(
      DEFAULT_SCREEN_UPLOAD_BUDGET_BPS / 2,
    );
  });

  it("hands the screen its slice back when the camera goes off", async () => {
    // The other edge. Leaving the screen on the two-way split with no camera
    // beside it left a third of the link idle.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    await manager.setLocalCameraStream(fakeStream("camera"));
    await manager.setLocalCameraStream(null);
    await Promise.resolve();

    expect(
      lastParams(senders.filter((x) => x.track?.id === "screen")[0]!)
        ?.encodings[0]?.maxBitrate,
    ).toBe(DEFAULT_SCREEN_UPLOAD_BUDGET_BPS / 2);
    manager.dispose();
  });

  it("splits in proportion to what each picture costs", async () => {
    // Pinned as a ratio, not just "the screen gets more": an Auto screen is
    // 3 Mbps and an Auto camera 1.5, so two thirds and one third. A 90/10
    // split would satisfy a looser assertion and mean something else.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    await manager.setLocalCameraStream(fakeStream("camera"));
    await Promise.resolve();

    const pick = (id: string) =>
      lastParams(senders.filter((x) => x.track?.id === id)[0]!)?.encodings[0]
        ?.maxBitrate ?? 0;
    expect(pick("screen") / pick("camera")).toBeCloseTo(2, 1);
    manager.dispose();
  });

  it("splits from one pair of numbers, not two that only agree by luck", async () => {
    // FOUND IN REVIEW. The two halves used to derive "what the camera asked
    // for" from different places — the screen's half read the screen's rung,
    // the camera's half read `cameraMaxBitrate` — and agreed only because one
    // control feeds both today. A camera set apart from the screen's rung is
    // what tells them apart: on Auto both are 1.5 Mbps and the bug is
    // invisible, which is why the ratio test could not see it.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    manager.setScreenQuality("1080p");
    manager.setCameraMaxBitrate(400_000);
    await manager.setLocalScreenStream(fakeStream("screen"));
    await manager.setLocalCameraStream(fakeStream("camera"));
    await Promise.resolve();

    const pick = (id: string) =>
      lastParams(senders.filter((x) => x.track?.id === id)[0]!)?.encodings[0]
        ?.maxBitrate ?? 0;
    // Whatever the two rungs are, the pair fits one viewer's share exactly.
    expect(pick("screen") + pick("camera")).toBe(
      DEFAULT_SCREEN_UPLOAD_BUDGET_BPS / 2,
    );
    manager.dispose();
  });

  it("leaves a 1:1 call's senders on what the person chose", async () => {
    // #340 established that one connection is the browser's to govern, and a
    // 1:1 room is never sampled, so `screenBudgetBps` there is an unmeasured
    // constant. Slicing it would cap a deliberate 1080p at a number nobody
    // measured.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.setScreenQuality("1080p");
    await manager.setLocalScreenStream(fakeStream("screen"));
    await manager.setLocalCameraStream(fakeStream("camera"));
    await Promise.resolve();

    expect(
      lastParams(senders.filter((x) => x.track?.id === "screen")[0]!)
        ?.encodings[0]?.maxBitrate,
    ).toBe(4_000_000);
    expect(
      lastParams(senders.filter((x) => x.track?.id === "camera")[0]!)
        ?.encodings[0]?.maxBitrate,
    ).toBe(1_500_000);
    manager.dispose();
  });

  it("moves both senders when the rung changes", async () => {
    // The camera's slice is derived from what the screen asked for, so a rung
    // change that moved only the screen left the camera stale.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    await manager.setLocalCameraStream(fakeStream("camera"));
    await Promise.resolve();
    const before =
      lastParams(senders.filter((x) => x.track?.id === "camera")[0]!)
        ?.encodings[0]?.maxBitrate ?? 0;

    manager.setScreenQuality("360p");
    await Promise.resolve();
    const after =
      lastParams(senders.filter((x) => x.track?.id === "camera")[0]!)
        ?.encodings[0]?.maxBitrate ?? 0;

    // A cheaper screen leaves the camera a bigger slice.
    expect(after).toBeGreaterThan(before);
    manager.dispose();
  });

  it("moves the ceiling on a live call without touching the track", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));
    const sender = cameraSenders()[0]!;

    manager.setCameraMaxBitrate(2_500_000);
    await Promise.resolve();

    expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(2_500_000);
    // The whole point of doing it this way: no re-capture, so the webcam light
    // never blinks and no video is dropped.
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(sender.track?.id).toBe("camera");
  });

  it("leaves a working camera when the encoder refuses the parameters", async () => {
    // The worst case of this whole change must be "no improvement", never
    // "no video". A browser that rejects setParameters gets browser defaults.
    rejectSetParameters = true;
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");

    await expect(
      manager.setLocalCameraStream(fakeStream("camera")),
    ).resolves.toBeUndefined();
    expect(cameraSenders()[0]?.track?.id).toBe("camera");
    // And it is not silent, which is how the missing ceiling went unnoticed.
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not re-tune every sender when the ceiling has not moved", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));
    const before = cameraSenders()[0]!.setParameters.mock.calls.length;

    manager.setCameraMaxBitrate(1_500_000);
    manager.setCameraMaxBitrate(1_500_000);
    await Promise.resolve();

    expect(cameraSenders()[0]!.setParameters.mock.calls.length).toBe(before);
  });
});

describe("screen budget across a growing room", () => {
  it("splits by the room everyone is about to be in, not the one they were in", async () => {
    // REGRESSION. The re-tune fired from inside `createPeerConnection`, which
    // runs before the caller files the new peer, so `peers.size` was one short
    // and every existing sender stayed budgeted for a smaller room for the
    // rest of the call.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    manager.connectToPeer("c-remote");
    await Promise.resolve();

    expect(screenSenders()).toHaveLength(3);
    for (const sender of screenSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
        meshScreenBitrate(3),
      );
    }
  });

  it("hands the budget back when somebody leaves", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    manager.connectToPeer("c-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    manager.removePeer("c-remote");
    await Promise.resolve();

    const remaining = screenSenders().filter((s) => s.track !== null);
    for (const sender of remaining.slice(0, 2)) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
        meshScreenBitrate(2),
      );
    }
  });

  it("gives a re-share the same ceiling as the first one", async () => {
    // The reported bug was a *second* share, so the peer count the second
    // `setLocalScreenStream` tunes with is worth pinning: a stop-and-restart
    // must not leave the new sender budgeted for a room that is not there.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    await manager.setLocalScreenStream(null);
    await manager.setLocalScreenStream(fakeStream("screen"));

    expect(lastParams(screenSenders().at(-1)!)?.encodings[0]?.maxBitrate).toBe(
      meshScreenBitrate(1),
    );
  });

  it("never asks a measured link for more than it has, at any room size", () => {
    // THE BUG THIS PINS, and it is specifically a weak-connection bug, which
    // is to say a bug for most of this app's users. A 600 kbps per-copy floor
    // used to sit under the division. Against the old constant 5 Mbps budget
    // it never fired (5 Mbps across the seven remote peers a mesh can hold is
    // 714 kbps, already over it), so nobody had seen what it does once the
    // budget is a *measurement*: a room cut to the 1 Mbps minimum floored
    // every copy back up to 600 kbps and asked a measured 1 Mbps link for
    // 4.2 Mbps. That is the over-commit this module exists to prevent, and it
    // fired only when the link had already been measured as weak.
    const budget = 1_000_000;
    for (const viewers of [2, 3, 5, 7]) {
      const perCopy = meshScreenBitrate(viewers, "auto", budget);
      expect(perCopy * viewers).toBeLessThanOrEqual(budget);
    }
  });

  it("changes nothing for a room running on the un-measured default", () => {
    // The other half of the argument for removing the floor: it was dormant.
    // Every room on the starting budget gets exactly what it got before.
    expect(meshScreenBitrate(2, "auto", 5_000_000)).toBe(2_500_000);
    expect(meshScreenBitrate(7, "auto", 5_000_000)).toBe(714_286);
  });

  it("clamps a call to the chosen ceiling rather than the raw share", () => {
    // Which is why the peer-count arithmetic could never explain a bad DM: the
    // clamp, not the division, is what a small call actually runs into.
    expect(meshScreenBitrate(1)).toBe(3_000_000);
    expect(meshScreenBitrate(2)).toBe(2_500_000);
    expect(meshScreenBitrate(3)).toBeLessThan(2_500_000);
  });
});

describe("the quality choice reaches the screen sender", () => {
  it("gives a 1080p share more than the old hard-coded 2.5 Mbps", () => {
    // THE REPORTED BUG, pinned. "I selected 1080p, shared, it was blurry": the
    // choice moved the camera and nothing else, and the screen sender ran on a
    // constant no setting could reach.
    expect(meshScreenBitrate(1, "1080p")).toBe(4_000_000);
    expect(meshScreenBitrate(1, "1080p")).toBeGreaterThan(2_500_000);
  });

  it("orders the five settings, and separates every one of them", () => {
    const rungs = ["360p", "480p", "720p", "auto", "1080p"] as const;
    const rates = rungs.map((rung) => meshScreenBitrate(1, rung));
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    expect(new Set(rates).size).toBe(rungs.length);
  });

  it("lets the chosen ceiling win over an empty room's budget", () => {
    // The room has bandwidth going spare and the user still said 480p. A
    // budget that could overrule that would make the control a suggestion.
    expect(meshScreenBitrate(1, "480p")).toBe(1_000_000);
    expect(meshScreenBitrate(1, "480p")).toBeLessThan(
      meshScreenBitrate(1, "auto"),
    );
  });

  it("lets a crowded room's budget win over a generous choice", () => {
    // And the other direction, because a mesh presenter uploads one copy per
    // peer: picking 1080p in an eight-way call cannot be allowed to ask one
    // domestic uplink for 32 Mbps.
    expect(meshScreenBitrate(8, "1080p")).toBeLessThan(
      meshScreenBitrate(1, "1080p"),
    );
    expect(meshScreenBitrate(8, "1080p")).toBe(meshScreenBitrate(8, "auto"));
  });

  it("keeps every room a mesh can actually hold above 600 kbps a copy", () => {
    // WAS "never drops a share below the floor". The 600 kbps per-copy floor
    // is gone (see `meshScreenBitrate` for why: against a *measured* budget it
    // asked a 1 Mbps link for up to 4.2 Mbps). What survives is the property
    // the floor was written to protect, and it turns out not to have needed
    // the floor: a mesh holds `MESH_VOICE_LIMIT` (8) people, so seven remote
    // peers, and the starting budget divided seven ways is 714 kbps.
    for (const rung of ["auto", "1080p", "720p", "480p", "360p"] as const) {
      for (const peers of [1, 2, 4, 7]) {
        expect(meshScreenBitrate(peers, rung)).toBeGreaterThanOrEqual(600_000);
      }
    }
  });

  it("divides honestly past the mesh's own size, rather than inventing a floor", () => {
    // Sixteen peers is not a room this app can open (the mesh caps at 8), but
    // it is the shape the old floor test used, and the answer now is the
    // honest one: the budget divided, not a number that would have the room
    // ask for 9.6 Mbps of a 5 Mbps budget.
    expect(meshScreenBitrate(16, "auto")).toBe(312_500);
    expect(meshScreenBitrate(16, "auto") * 16).toBeLessThanOrEqual(5_000_000);
  });

  it("leaves every crowded room exactly where it was before the raise", () => {
    // The point of choosing 4 Mbps rather than more: the 5 Mbps budget still
    // binds from two peers up, so the raise reaches small calls only. If this
    // fails, somebody moved the budget and changed group calls by accident.
    for (const peers of [2, 3, 4, 6, 8]) {
      expect(meshScreenBitrate(peers, "1080p")).toBe(
        Math.round(Math.max(600_000, 5_000_000 / peers)),
      );
    }
  });

  it("defaults to auto when no quality is passed at all", () => {
    // Every pre-existing caller passes one argument. They must keep meaning
    // what they meant.
    expect(meshScreenBitrate(4)).toBe(meshScreenBitrate(4, "auto"));
  });

  it("keeps the mesh cap and the ladder's top rung agreed", () => {
    // Two constants in two modules that must not drift: the mesh's own hard cap
    // and the most any quality may ask for. If they part company, one of them
    // silently stops doing anything.
    expect(screenBitrateFor("1080p")).toBe(4_000_000);
  });

  it("moves a live share's ceiling without touching the capture", async () => {
    // Mid-call, the same promise the camera makes: no re-publish, so the OS
    // picker never reappears and the share never blinks out for its viewers.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const sender = screenSenders()[0]!;

    manager.setScreenQuality("1080p");
    await Promise.resolve();

    expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
      meshScreenBitrate(1, "1080p"),
    );
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(sender.track?.id).toBe("screen");
  });

  it("carries the choice to a share that starts after it", async () => {
    // The order people actually do it in: set the quality, then share. The
    // manager has to hold the choice, not merely react to a live sender.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setScreenQuality("360p");
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    expect(lastParams(screenSenders()[0]!)?.encodings[0]?.maxBitrate).toBe(
      meshScreenBitrate(1, "360p"),
    );
  });

  it("carries the choice to somebody who joins mid-share", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setScreenQuality("1080p");
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    manager.connectToPeer("b-remote");

    await Promise.resolve();
    expect(screenSenders()).toHaveLength(2);
    for (const sender of screenSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
        meshScreenBitrate(2, "1080p"),
      );
    }
  });

  it("does not re-tune every sender when the choice has not moved", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const before = screenSenders()[0]!.setParameters.mock.calls.length;

    manager.setScreenQuality("720p");
    manager.setScreenQuality("720p");
    await Promise.resolve();

    expect(screenSenders()[0]!.setParameters.mock.calls.length).toBe(
      before + 1,
    );
  });

  it("divides the picture down to the size the label names", async () => {
    // THE REPORTED BUG. Measured at the receiver in a server voice channel:
    // every rung below 1080p arrived as 1920x1080, because the choice moved
    // `maxBitrate` and nothing else. A ceiling on its own does not make a
    // smaller picture, it makes the same picture worse, which is exactly what
    // "I picked 360p and it did not look like 360p" describes.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const sender = screenSenders()[0]!;

    manager.setScreenQuality("360p");
    await Promise.resolve();

    expect(lastParams(sender)?.encodings[0]?.scaleResolutionDownBy).toBeCloseTo(
      3,
      2,
    );
    // And no re-capture to do it, so the OS picker never reappears.
    expect(sender.replaceTrack).not.toHaveBeenCalled();
  });

  it("divides by what this screen is, not by a number", async () => {
    // A 1440p monitor asked for 360p needs a divisor of 4 where a 1080p one
    // needs 3. Same label, same picture, different hardware.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setScreenQuality("360p");
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen", 1440));

    expect(
      lastParams(screenSenders()[0]!)?.encodings[0]?.scaleResolutionDownBy,
    ).toBeCloseTo(4, 2);
  });

  it("gives the full picture back when the choice goes back up", async () => {
    // The failure this guards is a divisor that is only ever written on the way
    // down: 360p then 1080p would leave a 3x scale in place forever, and the
    // menu would become a one-way trip.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const sender = screenSenders()[0]!;

    manager.setScreenQuality("360p");
    await Promise.resolve();
    manager.setScreenQuality("1080p");
    await Promise.resolve();

    expect(lastParams(sender)?.encodings[0]?.scaleResolutionDownBy).toBe(1);

    manager.setScreenQuality("auto");
    await Promise.resolve();
    // Auto is not "no divisor": it asks for 720 lines out of a 1080-line
    // capture, the same as the named rung, and spends its own 3 Mbps on them.
    expect(lastParams(sender)?.encodings[0]?.scaleResolutionDownBy).toBeCloseTo(
      1.5,
      2,
    );
  });

  it("leaves a working share when the encoder refuses the parameters", async () => {
    // Raising a ceiling must not be able to cost anybody their share.
    rejectSetParameters = true;
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");

    await expect(
      manager.setLocalScreenStream(fakeStream("screen")),
    ).resolves.toBeUndefined();
    expect(screenSenders()[0]?.track?.id).toBe("screen");
  });
});

describe("the screen budget follows what the connections measure", () => {
  const M = 1_000_000;

  /** What every fake connection's selected pair will report this tick. */
  let uplinkBps: number | null = null;

  function statsReport() {
    const rows = new Map<string, unknown>();
    if (uplinkBps !== null) {
      rows.set("P", {
        type: "candidate-pair",
        id: "P",
        nominated: true,
        state: "succeeded",
        availableOutgoingBitrate: uplinkBps,
      });
    }
    return rows;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    uplinkBps = null;
    FakePeerConnection.prototype.getStats = async () => statsReport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** One sampling tick, with the stats promises given room to settle. */
  async function tick() {
    await vi.advanceTimersByTimeAsync(SCREEN_BUDGET_SAMPLE_MS);
  }

  it("starts every share on the default budget, before any sample", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    for (const sender of screenSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
        meshScreenBitrate(2, DEFAULT_VIDEO_QUALITY, DEFAULT_SCREEN_UPLOAD_BUDGET_BPS),
      );
    }
    manager.dispose();
  });

  it("cuts every sender when the link turns out to be short", async () => {
    // End to end: a three-person call, two viewers, on a 3 Mbps uplink. Each
    // connection's estimator reports its half of the pipe; the room's budget
    // becomes the pipe, and each copy gets half of that instead of 2.5 Mbps.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    uplinkBps = 1.5 * M;
    await tick();

    for (const sender of screenSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(1.5 * M);
    }
    manager.dispose();
  });

  it("raises past the old constant when every link reports room", async () => {
    // Fibre, four viewers. Under the constant each copy got 1.25 Mbps with
    // the link barely touched. Give it a few ticks of "more than this".
    const manager = createPeerConnectionManager("z-local", () => {});
    for (const id of ["a", "b", "c", "d"]) {
      manager.connectToPeer(`${id}-remote`);
    }
    await manager.setLocalScreenStream(fakeStream("screen"));

    uplinkBps = 20 * M;
    for (let i = 0; i < 6; i += 1) {
      await tick();
    }

    for (const sender of screenSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBeGreaterThan(
        meshScreenBitrate(4, DEFAULT_VIDEO_QUALITY, DEFAULT_SCREEN_UPLOAD_BUDGET_BPS),
      );
    }
    manager.dispose();
  });

  it("still lets the chosen rung win over a generous link", async () => {
    // The budget can only lift a share as far as the person asked for.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.setScreenQuality("360p");
    await manager.setLocalScreenStream(fakeStream("screen"));

    uplinkBps = 50 * M;
    for (let i = 0; i < 6; i += 1) {
      await tick();
    }

    expect(lastParams(screenSenders()[0]!)?.encodings[0]?.maxBitrate).toBe(
      screenBitrateFor("360p"),
    );
    manager.dispose();
  });

  it("does not re-tune when the reading is inside the wobble", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const before = screenSenders().map((s) => s.setParameters.mock.calls.length);

    uplinkBps = 2.45 * M;
    await tick();
    await tick();

    expect(screenSenders().map((s) => s.setParameters.mock.calls.length)).toEqual(
      before,
    );
    manager.dispose();
  });

  it("forgets the measurement when the share ends, and stops sampling", async () => {
    // A laptop that moved from ethernet to café wifi between two shares is the
    // ordinary case: a reading from the last share must not carry over.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    uplinkBps = 1.5 * M;
    await tick();
    expect(lastParams(screenSenders()[0]!)?.encodings[0]?.maxBitrate).toBe(1.5 * M);

    await manager.setLocalScreenStream(null);
    const getStats = vi.spyOn(FakePeerConnection.prototype, "getStats");
    await tick();
    expect(getStats).not.toHaveBeenCalled();

    await manager.setLocalScreenStream(fakeStream("screen-2"));
    const fresh = senders.filter((s) => s.track?.id === "screen-2");
    expect(fresh).toHaveLength(2);
    for (const sender of fresh) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
        meshScreenBitrate(2, DEFAULT_VIDEO_QUALITY, DEFAULT_SCREEN_UPLOAD_BUDGET_BPS),
      );
    }
    manager.dispose();
  });

  it("does not touch a 1:1 call's ceiling, whatever the link reports", async () => {
    // FOUND IN REVIEW, and it is the most common call shape there is. The
    // budget controller has nothing to coordinate with one connection, and
    // clamping the ceiling to a measured dip would leave the browser unable
    // to re-open the flow at its own pace.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const before = lastParams(screenSenders()[0]!)?.encodings[0]?.maxBitrate;

    uplinkBps = 400_000;
    await tick();
    await tick();
    await tick();

    expect(lastParams(screenSenders()[0]!)?.encodings[0]?.maxBitrate).toBe(before);
    manager.dispose();
  });

  it("releases the clamp when a crowded room empties back down to one viewer", async () => {
    // A ceiling the crowd needed, left on a link that is no longer carrying
    // copies of anything, would be the same over-correction in reverse.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    uplinkBps = 700_000;
    await tick();
    const clamped = lastParams(screenSenders()[0]!)?.encodings[0]?.maxBitrate ?? 0;
    expect(clamped).toBeLessThan(
      meshScreenBitrate(2, DEFAULT_VIDEO_QUALITY, DEFAULT_SCREEN_UPLOAD_BUDGET_BPS),
    );

    manager.removePeer("b-remote");
    await tick();

    const survivor = screenSenders().filter((s) => s.track !== null)[0]!;
    expect(lastParams(survivor)?.encodings[0]?.maxBitrate).toBe(
      meshScreenBitrate(1, DEFAULT_VIDEO_QUALITY, DEFAULT_SCREEN_UPLOAD_BUDGET_BPS),
    );
    manager.dispose();
  });

  it("stops sampling on dispose", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    manager.dispose();

    const getStats = vi.spyOn(FakePeerConnection.prototype, "getStats");
    await tick();
    expect(getStats).not.toHaveBeenCalled();
  });
});
