/**
 * The page side of the app-frame suite, bundled by `build.ts` into `page.js`.
 * It mounts the REAL `mountAppFrame` (and so the real bridge host and the real
 * `frame-src` policy) with a fake session transport, and exposes just enough on
 * `window.__e2e` for a spec to drive it.
 */
import { FakeTransport, baseApp } from "@/lib/apps/bridge-host.fixture";
import { mountAppFrame, type AppFrameController, type AppFrameStatus } from "@/lib/apps/frame-controller";
import { ensureAppFramePolicy } from "@/lib/apps/frame-policy";
import type { AppRuntimeConfig, AppUserDirectory } from "@/lib/apps/types";

interface MountOptions {
  entry: string;
  appsOrigin: string;
  extraOrigins?: string[];
  helloTimeoutMs?: number;
  localFiles?: boolean;
}

/** Names for the two seats the fixture snapshot holds; no avatar, so nothing is fetched. */
const users: AppUserDirectory = {
  resolve: (userId) =>
    userId === "11111111-1111-4111-8111-111111111111"
      ? { displayName: "Raf", avatarUrl: null }
      : userId === "22222222-2222-4222-8222-222222222222"
        ? { displayName: "Bia", avatarUrl: null }
        : null,
};

const statuses: AppFrameStatus[] = [];
/** Attacks (or documents) that told the page they ran; see `frames/hostile.js`. */
const ran: string[] = [];
window.addEventListener("message", (event) => {
  const data = event.data as { e2e?: string; attack?: string } | null;
  if (data && data.e2e === "ran" && typeof data.attack === "string") ran.push(data.attack);
});
const transport = new FakeTransport();
let controller: AppFrameController | null = null;
const loads: number[] = [];

function mount(options: MountOptions) {
  const app: AppRuntimeConfig = baseApp({
    id: "coop",
    version: "1.0.0",
    entry: { url: options.entry },
    state: { maxBytes: 4096, maxWritesPerSecond: 10, writers: "participants" },
    events: { maxPerSecond: 10, maxBytes: 256 },
    capabilities: options.localFiles
      ? { share: "none", localFiles: { allowed: true, accept: [".gba", ".nes"], maxBytes: 1024 * 1024 } }
      : { share: "none", localFiles: { allowed: false } },
  });
  const container = document.getElementById("root")!;
  controller = mountAppFrame({
    container,
    app,
    appsOrigin: options.appsOrigin,
    title: "Test app",
    transport,
    users,
    locale: () => "pt-BR",
    extraFrameOrigins: options.extraOrigins,
    helloTimeoutMs: options.helloTimeoutMs ?? 60_000,
    onStatus: (status) => statuses.push(status),
  });
  const iframe = container.querySelector("iframe");
  let count = 0;
  iframe?.addEventListener("load", () => {
    count += 1;
    loads[0] = count;
  });
}

/** A frame the page makes itself, with no policy involved: what a page without the fix would do. */
function rawSandboxFrame(src: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("allow", "");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.src = src;
  document.getElementById("root")!.append(iframe);
}

/** An embed the client legitimately makes, observed: did it load, or did the policy refuse it. */
function embed(kind: "src" | "blank" | "srcdoc" | "blob", value: string): Promise<{ loaded: boolean; violated: boolean }> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    let violated = false;
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (event.effectiveDirective === "frame-src" || event.violatedDirective.startsWith("frame-src")) violated = true;
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const finish = (loaded: boolean) => {
      document.removeEventListener("securitypolicyviolation", onViolation);
      resolve({ loaded: loaded && !violated, violated });
    };
    iframe.addEventListener("load", () => setTimeout(() => finish(true), 50));
    iframe.addEventListener("error", () => finish(false));
    document.getElementById("root")!.append(iframe);
    if (kind === "src") iframe.src = value;
    else if (kind === "srcdoc") iframe.srcdoc = value;
    else if (kind === "blob") iframe.src = URL.createObjectURL(new Blob([value], { type: "text/html" }));
    // "blank": no src at all, the way a library makes a scratch frame
    setTimeout(() => finish(false), 4000);
  });
}

declare global {
  interface Window {
    __e2e: {
      statuses: AppFrameStatus[];
      transport: FakeTransport;
      loads: number[];
      ran: string[];
      mount(options: MountOptions): void;
      destroy(): void;
      policy(appsOrigin: string, extraOrigins?: string[]): boolean;
      rawSandboxFrame(src: string): void;
      embed: typeof embed;
    };
  }
}

window.__e2e = {
  statuses,
  transport,
  loads,
  ran,
  mount,
  destroy: () => controller?.destroy(),
  policy: (appsOrigin, extraOrigins) => ensureAppFramePolicy({ appsOrigin, extraOrigins }),
  rawSandboxFrame,
  embed,
};
