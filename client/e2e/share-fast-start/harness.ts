/**
 * The share fast-start rig's page. One page is either the PRESENTER or a
 * VIEWER, and both go through the product's own LiveKit session
 * (`connectLiveKit`), so the room options, the publish options, the simulcast
 * plan, the adaptive-stream binding and the delivery rules under test are the
 * real ones, not a copy.
 *
 * Presenter: a looping 1080p30 clip (`gen.mjs`, ffmpeg `testsrc2` with
 * temporal grain, so it costs bits the way a film does) played into a hidden
 * `<video>` and captured with `captureStream()`, tagged `motion` like a real
 * share, and handed to `publishScreen`.
 *
 * Viewer: mounts the share the way the stage does (`StageVideo` in
 * `call-stage.tsx`: an `h-full w-full object-contain` element bound with
 * `bindRemoteVideo`) inside a box of `?stage=WxH` CSS pixels, and samples the
 * subscriber's `inbound-rtp` four times a second.
 *
 * Query: `role=presenter|viewer`, `url`, `token`, `room`, `identity`,
 * `stage=1280x720`, `relay=1` (force every peer connection through TURN, so
 * the rig can shape this viewer's downlink), `fast=1` (the
 * `share_fast_start_quality` flag on), `src=/path.mp4`.
 *
 * `window.__sfs` holds the events and samples for the Playwright spec.
 */
import { RemoteTrackPublication } from "livekit-client";
import { connectLiveKit, type LiveKitSession } from "@/lib/livekit-session";
import { bindRemoteVideo } from "@/lib/remote-video-binding";
import { setShareFastStartQuality } from "@/lib/share-fast-start";
import type { RemotePeer } from "@/lib/peer-connection-manager";

interface ViewerSample {
  t: number;
  w: number | null;
  h: number | null;
  fps: number | null;
  kbps: number | null;
  framesDecoded: number;
  keyFrames: number;
  pli: number;
  elW: number;
  elH: number;
}

interface PresenterSample {
  t: number;
  layers: {
    rid: string | null;
    w: number | null;
    h: number | null;
    fps: number | null;
    kbps: number | null;
    limit: string | null;
    active: boolean | null;
  }[];
}

declare global {
  interface Window {
    __sfs: {
      role: string;
      t0: number;
      events: { t: number; name: string; data?: unknown }[];
      samples: (ViewerSample | PresenterSample)[];
      settings: { t: number; width?: number; height?: number; quality?: number; disabled?: boolean }[];
      ready: boolean;
      error: string | null;
    };
  }
}

const params = new URLSearchParams(window.location.search);
const role = params.get("role") ?? "viewer";
const t0 = performance.now();
window.__sfs = { role, t0, events: [], samples: [], settings: [], ready: false, error: null };
const now = () => Math.round(performance.now() - t0);
const mark = (name: string, data?: unknown) => window.__sfs.events.push({ t: now(), name, data });

setShareFastStartQuality(params.get("fast") === "1");

// Every peer connection the SDK opens, so the meter can read getStats without
// reaching into the session. `relay=1` also forces TURN, which is the only leg
// of a viewer's path the rig can shape from inside the media server container.
const pcs: RTCPeerConnection[] = [];
const NativePC = window.RTCPeerConnection;
const forceRelay = params.get("relay") === "1";
class HookedPC extends NativePC {
  constructor(config?: RTCConfiguration) {
    super(forceRelay ? { ...config, iceTransportPolicy: "relay" } : config);
    pcs.push(this);
  }
  // The SDK re-applies its own configuration once the join response names
  // the ICE servers, which would put the policy back to "all".
  override setConfiguration(config?: RTCConfiguration) {
    super.setConfiguration(forceRelay ? { ...config, iceTransportPolicy: "relay" } : config);
  }
}
window.RTCPeerConnection = HookedPC as unknown as typeof RTCPeerConnection;

// What adaptive stream (and anything else) asks the SFU for, as it is sent.
const proto = RemoteTrackPublication.prototype as unknown as {
  emit: (event: string, ...args: unknown[]) => boolean;
};
const originalEmit = proto.emit;
proto.emit = function (event: string, ...args: unknown[]) {
  if (event === "updateSettings" && (this as RemoteTrackPublication).kind === "video") {
    const s = args[0] as { width?: number; height?: number; quality?: number; disabled?: boolean };
    window.__sfs.settings.push({
      t: now(),
      width: s.width,
      height: s.height,
      quality: s.quality,
      disabled: s.disabled,
    });
  }
  return originalEmit.call(this, event, ...args);
};

function session(): Parameters<typeof connectLiveKit>[0]["session"] {
  return {
    backend: "livekit",
    url: params.get("url") ?? "ws://127.0.0.1:7880",
    token: params.get("token") ?? "",
    room: params.get("room") ?? "sfs",
    identity: params.get("identity") ?? role,
  };
}

/**
 * `src=display`: a real `getDisplayMedia` capture (Chrome's fake display
 * device under `--use-fake-device-for-media-stream`). Its picture is simple,
 * but unlike a `captureStream()` of a clip it rescales on `applyConstraints`
 * the way a real screen capture does, which is what a republish under a new
 * height relies on.
 */
async function displayTrack(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { ideal: 30, max: 30 } },
    audio: false,
  });
  const [track] = stream.getVideoTracks();
  if (!track) throw new Error("no display track");
  return track;
}

async function presenter() {
  if (params.get("src") === "display") {
    const track = await displayTrack();
    track.contentHint = "motion";
    mark("sourcePlaying", track.getSettings());
    return publishAndSample(track);
  }
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = params.get("src") ?? "/e2e/share-fast-start/media-cache/src.mp4";
  video.style.cssText = "position:fixed;left:0;top:0;width:320px;height:180px;opacity:0.01";
  document.body.append(video);
  await video.play();
  mark("sourcePlaying", { w: video.videoWidth, h: video.videoHeight });
  const stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
  const [track] = stream.getVideoTracks();
  if (!track) throw new Error("no video track from the clip");
  track.contentHint = "motion";
  return publishAndSample(track);
}

async function publishAndSample(track: MediaStreamTrack) {
  const lk: LiveKitSession = await connectLiveKit({
    session: session(),
    lookupIdentity: () => undefined,
    onPeersChanged: () => undefined,
    onError: (message) => mark("error", message),
  });
  mark("connected");
  await lk.publishScreen(new MediaStream([track]));
  mark("published");
  window.__sfs.ready = true;
  let prev = new Map<string, { bytes: number; ts: number }>();
  setInterval(async () => {
    const layers: PresenterSample["layers"] = [];
    const next = new Map<string, { bytes: number; ts: number }>();
    for (const pc of pcs) {
      const actives = new Map<string, boolean>();
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        for (const enc of sender.getParameters().encodings ?? []) {
          actives.set(enc.rid ?? "", enc.active !== false);
        }
      }
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type !== "outbound-rtp" || s.kind !== "video") return;
        const key = `${s.ssrc}`;
        const was = prev.get(key);
        next.set(key, { bytes: s.bytesSent, ts: s.timestamp });
        layers.push({
          rid: s.rid ?? null,
          w: s.frameWidth ?? null,
          h: s.frameHeight ?? null,
          fps: s.framesPerSecond ?? null,
          kbps: was ? Math.round(((s.bytesSent - was.bytes) * 8) / (s.timestamp - was.ts)) : null,
          limit: s.qualityLimitationReason ?? null,
          active: actives.get(s.rid ?? "") ?? null,
        });
      });
    }
    prev = next;
    window.__sfs.samples.push({ t: now(), layers });
  }, 1000);
}

async function viewer() {
  const [w, h] = (params.get("stage") ?? "1280x720").split("x").map(Number);
  const box = document.createElement("div");
  box.style.cssText = `width:${w}px;height:${h}px;position:relative;background:#000`;
  document.body.style.margin = "0";
  document.body.append(box);
  let mounted: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  const onPeers = (peers: RemotePeer[]) => {
    const share = peers.find((p) => p.screenStream)?.screenStream ?? null;
    if (share === mounted) return;
    mounted = share;
    // A republished share is a new stream: the stage unmounts the old
    // picture and mounts the new one, and so does this page.
    if (video) {
      video.remove();
      video = null;
    }
    if (!share) {
      mark("screenGone");
      return;
    }
    mark("screenStream");
    video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    // StageVideo: `h-full w-full` plus object-contain.
    video.style.cssText = "width:100%;height:100%;object-fit:contain;display:block";
    box.append(video);
    bindRemoteVideo(video, share);
    mark("attached", { elW: video.clientWidth, elH: video.clientHeight });
    const v = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { width: number; height: number }) => void) => void;
    };
    v.requestVideoFrameCallback?.((_n, meta) => mark("firstFrame", { w: meta.width, h: meta.height }));
    // The decoded size as the viewer sees it, every 250 ms, independent of
    // which inbound-rtp the stats loop picks after a republish.
    const element = video;
    const tick = () => {
      if (element !== video) return;
      if (element.videoHeight) {
        const last = window.__sfs.events.findLast?.((e) => e.name === "size");
        const data = last?.data as { h?: number } | undefined;
        if (data?.h !== element.videoHeight) {
          mark("size", { w: element.videoWidth, h: element.videoHeight });
        }
      }
      setTimeout(tick, 250);
    };
    tick();
  };
  await connectLiveKit({
    session: session(),
    lookupIdentity: () => undefined,
    onPeersChanged: onPeers,
    onError: (message) => mark("error", message),
  });
  mark("connected");
  window.__sfs.ready = true;
  let prev: { id: string; bytes: number; ts: number } | null = null;
  setInterval(async () => {
    let best: RTCInboundRtpStreamStats | null = null;
    const wanted = mounted?.getVideoTracks()[0]?.id ?? null;
    for (const pc of pcs) {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") {
          const r = s as RTCInboundRtpStreamStats & { trackIdentifier?: string };
          if (wanted && r.trackIdentifier && r.trackIdentifier !== wanted) return;
          if (!best || (r.bytesReceived ?? 0) > (best.bytesReceived ?? 0)) best = r;
        }
      });
    }
    const r = best as RTCInboundRtpStreamStats | null;
    if (!window.__sfs.events.some((e) => e.name === "path") && r) {
      for (const pc of pcs) {
        const stats = await pc.getStats();
        stats.forEach((s) => {
          if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
            const local = stats.get(s.localCandidateId) as { candidateType?: string } | undefined;
            const cfg = pc.getConfiguration();
            mark("path", {
              local: local?.candidateType,
              rttMs: Math.round((s.currentRoundTripTime ?? 0) * 1000),
              policy: cfg.iceTransportPolicy,
              servers: (cfg.iceServers ?? []).map((x) => x.urls),
            });
          }
        });
      }
    }
    const sample: ViewerSample = {
      t: now(),
      w: r?.frameWidth ?? null,
      h: r?.frameHeight ?? null,
      fps: r?.framesPerSecond ?? null,
      kbps:
        r && prev && prev.id === r.id
          ? Math.round((((r.bytesReceived ?? 0) - prev.bytes) * 8) / (r.timestamp - prev.ts))
          : null,
      framesDecoded: r?.framesDecoded ?? 0,
      keyFrames: (r as { keyFramesDecoded?: number } | null)?.keyFramesDecoded ?? 0,
      pli: r?.pliCount ?? 0,
      elW: video?.clientWidth ?? 0,
      elH: video?.clientHeight ?? 0,
    };
    prev = r ? { id: r.id, bytes: r.bytesReceived ?? 0, ts: r.timestamp } : prev;
    window.__sfs.samples.push(sample);
  }, 250);
}

(role === "presenter" ? presenter() : viewer()).catch((err: unknown) => {
  window.__sfs.error = String(err);
  mark("error", String(err));
});
