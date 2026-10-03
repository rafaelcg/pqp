/**
 * The REAL watch player (`HlsWatchPlayer`, its two hls.js instances, the
 * camera corner and every control on it) mounted on `hls-server.mjs`'s
 * synthetic film and camera, with a meter that reads what the viewer SEES.
 *
 * THE METER DOES NOT ASK THE PLAYER. Every frame of both pictures carries its
 * number on the shared content timeline as a barcode (`gen.mjs`); this page
 * draws each `<video>`'s current frame onto a canvas and reads it back. So
 * `drift` below is the difference between the two pictures on screen, with no
 * hls.js state, PROGRAM-DATE-TIME or code under test in the loop. The player's
 * own reading (`window.pqpCameraSync()`, when the build has it) is recorded
 * beside it, so the two can be compared.
 *
 * Query: `?mode=live|ll&base=http://127.0.0.1:8787&sync=on|off&lang=pt-BR`.
 * `window.__cameraSync` holds the samples for the Playwright spec.
 */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { setWatchCameraSync } from "@/lib/camera-sync";
import { I18nProvider } from "@/lib/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/index.css";

const FPS = 25;
const BITS = 20;

const params = new URLSearchParams(window.location.search);
const base = params.get("base") ?? "http://127.0.0.1:8787";
const mode = (params.get("mode") ?? "live") as "live" | "ll";
// The `watch_camera_sync` flag, as the app shell sets it from the server's
// config (`?sync=off` is the flag off, the camera exactly as before).
setWatchCameraSync(params.get("sync") !== "off");

interface Sample {
  at: number;
  film: number | null;
  cam: number | null;
  /** cam - film, ms: positive is a camera AHEAD of the film. */
  driftMs: number | null;
  filmPaused: boolean | null;
  camPaused: boolean | null;
  camRate: number | null;
  filmRate: number | null;
  visible: boolean;
  player: unknown;
}

declare global {
  interface Window {
    __cameraSync: {
      samples: Sample[];
      epoch: number | null;
      mark: (label: string) => void;
      marks: { at: number; label: string }[];
    };
    pqpCameraSync?: () => unknown;
  }
}

window.__cameraSync = {
  samples: [],
  epoch: null,
  marks: [],
  mark(label) {
    this.marks.push({ at: Date.now(), label });
  },
};

/** The frame number in the barcode, or null when it does not read cleanly. */
function readBarcode(video: HTMLVideoElement, canvas: HTMLCanvasElement): number | null {
  const width = video.videoWidth;
  if (!width || video.readyState < 2) {
    return null;
  }
  canvas.width = width;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  // Row 12 of the 24 px band, scaled 1:1 from the intrinsic frame.
  context.drawImage(video, 0, 12, width, 1, 0, 0, width, 1);
  const row = context.getImageData(0, 0, width, 1).data;
  const block = width / BITS;
  let value = 0;
  for (let bit = 0; bit < BITS; bit += 1) {
    const x = Math.floor(block * bit + block / 2);
    const luma = (row[x * 4]! + row[x * 4 + 1]! + row[x * 4 + 2]!) / 3;
    if (luma > 160) {
      value += 2 ** bit;
    } else if (luma > 90) {
      return null;
    }
  }
  return value;
}

function videos(): { film: HTMLVideoElement | null; cam: HTMLVideoElement | null } {
  const cam = document.querySelector<HTMLVideoElement>(
    '[data-testid="watch-camera-pip"] video',
  );
  const film =
    Array.from(document.querySelectorAll<HTMLVideoElement>("video")).find(
      (video) => !video.closest('[data-testid="watch-camera-pip"]'),
    ) ?? null;
  return { film, cam };
}

function formatContent(frames: number | null): string {
  if (frames === null) {
    return "--:--.--";
  }
  const seconds = frames / FPS;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds - minutes * 60).toFixed(2).padStart(5, "0")}`;
}

function Meter() {
  const [last, setLast] = useState<Sample | null>(null);
  const canvas = useRef(document.createElement("canvas"));
  useEffect(() => {
    void fetch(`${base}/control`)
      .then((response) => response.json())
      .then((state: { epoch: number }) => {
        window.__cameraSync.epoch = state.epoch;
      })
      .catch(() => {});
    const timer = window.setInterval(() => {
      const { film, cam } = videos();
      const filmFrame = film ? readBarcode(film, canvas.current) : null;
      const camFrame = cam ? readBarcode(cam, canvas.current) : null;
      const sample: Sample = {
        at: Date.now(),
        film: filmFrame,
        cam: camFrame,
        driftMs:
          filmFrame !== null && camFrame !== null
            ? ((camFrame - filmFrame) * 1000) / FPS
            : null,
        filmPaused: film ? film.paused : null,
        camPaused: cam ? cam.paused : null,
        camRate: cam ? cam.playbackRate : null,
        filmRate: film ? film.playbackRate : null,
        visible: document.visibilityState === "visible",
        player: window.pqpCameraSync?.() ?? null,
      };
      window.__cameraSync.samples.push(sample);
      setLast(sample);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div
      data-testid="camera-sync-meter"
      className="pointer-events-none fixed left-2 top-12 z-[100] rounded bg-black/80 px-2 py-1 font-mono text-xs leading-5 text-white"
    >
      <div>filme   {formatContent(last?.film ?? null)}</div>
      <div>câmera  {formatContent(last?.cam ?? null)}</div>
      <div>
        diferença{" "}
        {last?.driftMs === null || last?.driftMs === undefined
          ? "--"
          : `${last.driftMs > 0 ? "+" : ""}${(last.driftMs / 1000).toFixed(2)} s`}
      </div>
      <div className="text-white/60">câmera x{last?.camRate?.toFixed(3) ?? "-"}</div>
    </div>
  );
}

function Harness() {
  const box = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  return (
    <div ref={box} className="fixed inset-0 bg-black">
      <HlsWatchPlayer
        src={`${base}/film.m3u8`}
        cameraSrc={`${base}/cam.m3u8`}
        layout="cinema"
        mode={mode}
        partTargetMs={1000}
        mediaTitle="Sessão de teste"
        fullscreen={{
          active: fullscreen,
          toggle: () => {
            if (document.fullscreenElement) {
              void document.exitFullscreen();
            } else {
              void box.current?.requestFullscreen();
            }
          },
        }}
      />
      <Meter />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <TooltipProvider>
        <Harness />
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>,
);
