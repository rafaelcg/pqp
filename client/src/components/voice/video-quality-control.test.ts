import { describe, expect, it } from "vitest";
import {
  callControlsMayIdle,
  presentersToAsk,
  requestsOfUs,
  showsVideoQualityControl,
  videoQualityMenuOpen,
  type QualityPeer,
} from "./video-quality-control";

describe("showsVideoQualityControl", () => {
  it("appears once the camera is on", () => {
    expect(
      showsVideoQualityControl({
        isCameraOn: true,
        isSharingScreen: false,
        hasIncomingVideo: false,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("appears for a screen share with the camera off", () => {
    // THE CASE THE BUG REPORT CAME FROM. The setting governs the screen sender
    // now, and the person presenting with no webcam on is the one who most
    // wants it. Under the old camera-only rule the control was hidden from
    // exactly them.
    expect(
      showsVideoQualityControl({
        isCameraOn: false,
        isSharingScreen: true,
        hasIncomingVideo: false,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("appears for somebody who is only WATCHING somebody else's video", () => {
    // THE REPORTED BUG, AS A UNIT. A screen share sent from the iOS app looked
    // like 360p on the web client watching it. The watcher had no video control
    // on the call at all — this function hid it, because they were sending
    // nothing — so they went to Settings, found the one quality selector the
    // product has, moved it from 360p to 1080p, and nothing changed. It could
    // not have: that selector governs this machine's own senders, and in a mesh
    // the picture you receive is the one the sender encoded.
    //
    // A viewer still gets no knob here, because WebRTC has none to give them.
    // What they get is the control opening with the receiving half alone: the
    // size that is actually arriving, and whose choice it was.
    expect(
      showsVideoQualityControl({
        isCameraOn: false,
        isSharingScreen: false,
        hasIncomingVideo: true,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("is absent when the call carries no video in either direction", () => {
    expect(
      showsVideoQualityControl({
        isCameraOn: false,
        isSharingScreen: false,
        hasIncomingVideo: false,
        collapsed: false,
      }),
    ).toBe(false);
  });

  it("stays out of the collapsed strip whatever is being sent", () => {
    expect(
      showsVideoQualityControl({
        isCameraOn: true,
        isSharingScreen: true,
        hasIncomingVideo: false,
        collapsed: true,
      }),
    ).toBe(false);
  });
});

describe("videoQualityMenuOpen", () => {
  it("is open when asked for and the control is there", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: true,
        isSharingScreen: false,
        hasIncomingVideo: false,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("closes itself when the last outgoing video stops under it", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: false,
        isSharingScreen: false,
        hasIncomingVideo: false,
        collapsed: false,
      }),
    ).toBe(false);
  });

  it("stays open when the camera goes off mid-share", () => {
    // The control still governs the share, so yanking the menu away here would
    // be the popover-over-nothing bug in reverse: removing a button that is
    // still on screen.
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: false,
        isSharingScreen: true,
        hasIncomingVideo: false,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("closes itself when the stage collapses under it", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: true,
        isSharingScreen: true,
        hasIncomingVideo: false,
        collapsed: true,
      }),
    ).toBe(false);
  });

  it("stays open for a watcher after their own camera goes off", () => {
    // Turning your camera off while somebody is presenting to you leaves the
    // menu with something to say — what is arriving — so yanking it away would
    // be the popover-over-nothing bug in reverse.
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: false,
        isSharingScreen: false,
        hasIncomingVideo: true,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("stays shut when nobody asked", () => {
    expect(
      videoQualityMenuOpen({
        requested: false,
        isCameraOn: true,
        isSharingScreen: true,
        hasIncomingVideo: false,
        collapsed: false,
      }),
    ).toBe(false);
  });
});

describe("callControlsMayIdle", () => {
  const base = {
    autoHide: true,
    anyVideo: true,
    collapsed: false,
    menuOpen: false,
  };

  it("fades a video call's bar as it always did", () => {
    expect(callControlsMayIdle(base)).toBe(true);
  });

  it("never fades while the quality menu is open", () => {
    expect(callControlsMayIdle({ ...base, menuOpen: true })).toBe(false);
  });

  it("keeps the pre-existing terms: touch, no video, collapsed", () => {
    expect(callControlsMayIdle({ ...base, autoHide: false })).toBe(false);
    expect(callControlsMayIdle({ ...base, anyVideo: false })).toBe(false);
    expect(callControlsMayIdle({ ...base, collapsed: true })).toBe(false);
  });
});

/**
 * Who the asking half of the menu is about, in each direction.
 *
 * Both lists are derived from what has actually arrived rather than from the
 * roster's claims, and both have a case where the obvious implementation says
 * something false: a peer who is in `screenSharePeerIds` but whose stream has
 * not turned up is not somebody you can ask, and a withdrawn request is not a
 * request for `auto`.
 */
describe("presentersToAsk", () => {
  const peer = (over: Partial<QualityPeer>): QualityPeer => ({
    peerId: "p1",
    displayName: "Ana",
    screenStream: null,
    ...over,
  });
  const stream = {} as MediaStream;

  it("lists only the peers whose screen is really arriving", () => {
    const rows = presentersToAsk([
      peer({ peerId: "p1", screenStream: stream }),
      peer({ peerId: "p2", screenStream: null }),
    ]);
    expect(rows.map((row) => row.peerId)).toEqual(["p1"]);
  });

  it("reports auto for a presenter nobody has asked anything of", () => {
    // Same value as a withdrawal on purpose: "I have not asked" and "never
    // mind" are the same state, and giving them two representations is how a
    // tick ends up next to a rung nobody chose.
    const [row] = presentersToAsk([peer({ screenStream: stream })]);
    expect(row!.ourRequest).toBe("auto");
  });

  it("carries our standing ask through", () => {
    const [row] = presentersToAsk([
      peer({ screenStream: stream, ourScreenQualityRequest: "1080p" }),
    ]);
    expect(row!.ourRequest).toBe("1080p");
  });
});

describe("requestsOfUs", () => {
  const peer = (over: Partial<QualityPeer>): QualityPeer => ({
    peerId: "p1",
    displayName: "Ana",
    screenStream: null,
    ...over,
  });

  it("names who asked and for what", () => {
    const rows = requestsOfUs([peer({ requestedScreenQuality: "1080p" })]);
    expect(rows).toEqual([
      { peerId: "p1", displayName: "Ana", quality: "1080p" },
    ]);
  });

  it("says nothing about a peer who has asked for nothing", () => {
    expect(requestsOfUs([peer({ requestedScreenQuality: null })])).toEqual([]);
    expect(requestsOfUs([peer({})])).toEqual([]);
    // A withdrawal reaches the manager as `auto` and is stored as null, but a
    // peer on an older build could put `auto` on the wire as a value. "Ana
    // asked for Auto" is a sentence about nothing.
    expect(requestsOfUs([peer({ requestedScreenQuality: "auto" })])).toEqual([]);
  });

  it("does not require the asker to be sending us anything", () => {
    // Asymmetric on purpose, and it is not an oversight: somebody watching your
    // share with their own camera off is the ordinary case, and they are
    // exactly the person who asks.
    const rows = requestsOfUs([
      peer({ screenStream: null, requestedScreenQuality: "720p" }),
    ]);
    expect(rows).toHaveLength(1);
  });
});
