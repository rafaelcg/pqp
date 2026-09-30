import { getDesktop, type DesktopShareHealth } from "./desktop";
import type { ShareGuardHandle } from "./share-guard-runtime";
import {
  deriveShareSample,
  readShareEncodeStats,
  type ShareEncodeStats,
  type ShareGuardSnapshot,
} from "./share-high-motion-guard";

/**
 * `pqpShareHealth()`: what a live screen share is doing, from the console.
 *
 * Built for one question, asked on a machine that cannot be debugged from
 * here: is the share slow because the CAPTURE is behind or because the
 * ENCODER is, and is the encoder a hardware one. Every field below answers
 * part of it, and none of it needs the `share_high_motion_guard` flag: the
 * source is registered for every share, and reading it costs two stats calls
 * one second apart, only when somebody types the command.
 *
 *   - `captureFps` (what the capture handed the sender) far under `sentFps`
 *     and `requestedFps`, with `limitedBy` none and a small `encodeMs`: the
 *     capture is starved.
 *   - `limitedBy: "cpu"`, or `encodeMs` close to its frame slot: the encoder.
 *   - `hardwareEncode: false` (an OpenH264 or libvpx name in `encoder`) on a
 *     machine that has a GPU: hardware encode is not being used, and the shell
 *     block says why (`gpu.videoEncode`).
 */

export interface ShareHealthSource {
  transport: "sfu" | "mesh";
  /** Whether `share_high_motion_guard` is on for this share. */
  guardEnabled: boolean;
  track(): MediaStreamTrack | null;
  readReports(): Promise<Array<Iterable<unknown>>>;
  guard(): ShareGuardHandle | null;
  /** What `enforceCaptureFrameRate` found at the start of the share, when it ran. */
  captureCheck(): {
    requested: number;
    reported: number | null;
    enforced: boolean;
    after: number | null;
  } | null;
}

let source: ShareHealthSource | null = null;

export function setShareHealthSource(next: ShareHealthSource | null): void {
  source = next;
}

export interface ShareHealthReport {
  transport: "sfu" | "mesh";
  codec: string | null;
  encoder: string | null;
  /** True for a hardware encoder, false for a software one, null when the browser does not say. */
  hardwareEncode: boolean | null;
  sentFps: number | null;
  captureFps: number | null;
  requestedFps: number | null;
  encodeMs: number | null;
  limitedBy: string | null;
  width: number | null;
  height: number | null;
  kbps: number | null;
  targetKbps: number | null;
  trackSettings: { frameRate: number | null; width: number | null; height: number | null };
  captureCheck: ReturnType<ShareHealthSource["captureCheck"]>;
  guard: { enabled: boolean } & Partial<ShareGuardSnapshot>;
  shell: DesktopShareHealth | null;
}

const SOFTWARE_ENCODER = /openh264|libvpx|libaom|software|ffmpeg|dav1d|svt/i;

/** Hardware or software, from what the browser says about the encoder. */
export function classifyEncoder(
  encoder: string | null,
  powerEfficient: boolean | null,
): boolean | null {
  if (powerEfficient !== null) {
    return powerEfficient;
  }
  if (encoder === null) {
    return null;
  }
  return !SOFTWARE_ENCODER.test(encoder);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readOnce(
  src: ShareHealthSource,
): Promise<ShareEncodeStats | null> {
  const reports = await src.readReports();
  let worst: ShareEncodeStats | null = null;
  for (const report of reports) {
    const reading = readShareEncodeStats(report, Date.now());
    if (
      reading &&
      (worst === null || (reading.frameWidth ?? 0) >= (worst.frameWidth ?? 0))
    ) {
      worst = reading;
    }
  }
  return worst;
}

function trackSettings(track: MediaStreamTrack | null) {
  try {
    const settings = track?.getSettings() ?? {};
    return {
      frameRate: typeof settings.frameRate === "number" ? settings.frameRate : null,
      width: typeof settings.width === "number" ? settings.width : null,
      height: typeof settings.height === "number" ? settings.height : null,
    };
  } catch {
    return { frameRate: null, width: null, height: null };
  }
}

export async function collectShareHealth(
  waitMs = 1000,
): Promise<ShareHealthReport | null> {
  const src = source;
  if (!src) {
    return null;
  }
  const first = await readOnce(src);
  await pause(waitMs);
  const second = await readOnce(src);
  const sample = second ? deriveShareSample(first, second) : null;
  const settings = trackSettings(src.track());
  const handle = src.guard();
  let shell: DesktopShareHealth | null = null;
  try {
    shell = (await getDesktop()?.shareHealth?.()) ?? null;
  } catch {
    shell = null;
  }
  return {
    transport: src.transport,
    codec: second?.codec ?? null,
    encoder: second?.encoderImplementation ?? null,
    hardwareEncode: classifyEncoder(
      second?.encoderImplementation ?? null,
      second?.powerEfficientEncoder ?? null,
    ),
    sentFps: sample?.fps ?? null,
    captureFps: sample?.sourceFps ?? null,
    requestedFps: settings.frameRate,
    encodeMs: sample?.encodeMs ?? null,
    limitedBy: sample?.limitedBy ?? null,
    width: second?.frameWidth ?? null,
    height: second?.frameHeight ?? null,
    kbps: sample?.kbps ?? null,
    targetKbps: sample?.targetKbps ?? null,
    trackSettings: settings,
    captureCheck: src.captureCheck(),
    guard: handle
      ? { enabled: true, ...handle.snapshot() }
      : { enabled: src.guardEnabled },
    shell,
  };
}

function fixed(value: number | null, digits = 0): string {
  return value === null ? "?" : value.toFixed(digits);
}

export function formatShareHealth(report: ShareHealthReport | null): string {
  if (!report) {
    return "pqpShareHealth: no screen share is live.";
  }
  const lines = [
    `share health (${report.transport})`,
    `  codec          ${report.codec ?? "?"}`,
    `  encoder        ${report.encoder ?? "?"}  (${
      report.hardwareEncode === null
        ? "hardware or software unknown"
        : report.hardwareEncode
          ? "hardware"
          : "software"
    })`,
    `  resolution     ${fixed(report.width)}x${fixed(report.height)}`,
    `  fps            sent ${fixed(report.sentFps, 1)} | capture ${fixed(report.captureFps, 1)} | asked ${fixed(report.requestedFps, 1)}`,
    `  encode         ${fixed(report.encodeMs, 1)} ms/frame`,
    `  bitrate        ${fixed(report.kbps)} kbps (target ${fixed(report.targetKbps)})`,
    `  limited by     ${report.limitedBy ?? "?"}`,
    `  track          ${fixed(report.trackSettings.width)}x${fixed(report.trackSettings.height)} @ ${fixed(report.trackSettings.frameRate, 1)}`,
  ];
  if (report.captureCheck) {
    lines.push(
      `  capture rate   asked ${report.captureCheck.requested}, reported ${fixed(report.captureCheck.reported, 1)}${
        report.captureCheck.enforced ? `, re-applied -> ${fixed(report.captureCheck.after, 1)}` : ""
      }`,
    );
  }
  if (report.guard.enabled && report.guard.level) {
    lines.push(
      `  guard          on, level ${report.guard.level.index} (${report.guard.level.step}, max ${report.guard.level.maxFps} fps${
        report.guard.level.maxHeight ? `, ${report.guard.level.maxHeight}p` : ""
      }), ${report.guard.steps ?? 0} steps, ${report.guard.flaps ?? 0} flaps${report.guard.sticky ? ", staying down" : ""}`,
    );
  } else {
    lines.push(`  guard          ${report.guard.enabled ? "on" : "off"}`);
  }
  if (report.shell) {
    lines.push(
      `  shell          ${report.shell.platform}, electron ${report.shell.versions.electron ?? "?"}, chrome ${report.shell.versions.chrome ?? "?"}`,
      `  gpu            video_encode ${report.shell.gpu.videoEncode ?? "?"}, video_decode ${report.shell.gpu.videoDecode ?? "?"}, compositing ${report.shell.gpu.gpuCompositing ?? "?"}`,
      `  priority       ${report.shell.priority.boost}, ${report.shell.priority.processes} processes`,
    );
  }
  return lines.join("\n");
}

export interface ShareHealthConsole {
  (): Promise<ShareHealthReport | null>;
  /** Hold the guard on a level by hand (0 is the top, null returns to it). Needs the guard flag on. */
  force: (level: number | null) => Promise<string>;
  help: () => string;
}

const HELP = [
  "pqpShareHealth()          print what the live share is doing (codec, encoder, fps, limit, size, bitrate)",
  "pqpShareHealth.force(n)   put the guard on step n (0 = full quality); needs the share_high_motion_guard flag",
  "  read it like this: capture fps far under asked fps with limited by none = the capture is behind;",
  "  limited by cpu or encode near its frame slot = the encoder is behind; a software encoder = no GPU encode.",
].join("\n");

const api = Object.assign(
  async () => {
    const report = await collectShareHealth();
    // eslint-disable-next-line no-console
    console.log(formatShareHealth(report));
    return report;
  },
  {
    async force(level: number | null) {
      const handle = source?.guard() ?? null;
      if (!handle) {
        return "pqpShareHealth.force: the guard is not running on this share (flag off, or no share).";
      }
      const next = await handle.force(level);
      return `guard on step ${next.index} (${next.step}, max ${next.maxFps} fps${
        next.maxHeight ? `, ${next.maxHeight}p` : ""
      })`;
    },
    help: () => HELP,
  },
) satisfies ShareHealthConsole;

export function installShareHealth(): void {
  if (typeof window === "undefined" || window.pqpShareHealth) {
    return;
  }
  window.pqpShareHealth = api;
}
