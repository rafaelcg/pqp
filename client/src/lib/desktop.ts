export interface PqpDesktop {
  platform: string;
  isElectron: true;
  hasCustomTitleBar: boolean;
  onToggleMute(cb: () => void): () => void;
  /** Subscribe to Cmd/Ctrl+Shift+D deafen toggle from the app menu. */
  onToggleDeafen?(cb: () => void): () => void;
  /** In-app path under `/app` (main process maps `pqp://` → `/app/...`). */
  onDeepLink(cb: (appPath: string) => void): () => void;
  getPendingDeepLink(): Promise<string | null>;
  /**
   * Present only in shells that answer display-media requests. Older shells
   * predate the handler, so absence means "too old to share a screen" rather
   * than "unknown" — see `desktopPredatesScreenShare`.
   */
  canShareScreen?: true;
  /**
   * Present when the share picker itself asks "share this computer's audio?"
   * Absence means an older picker that treats `audioRequested` as the whole
   * switch, so the page must ask first — or not request audio at all.
   */
  sharePickerOffersAudio?: true;
  /**
   * What a screen capture can do in THIS shell, said by the shell.
   *
   * Absent in every build before 0.1.6, so absence is not "cannot": it means
   * fall back to the two flags above plus `platform`, which is what the client
   * did for every shell until now. See `DesktopShareCapabilities`.
   */
  capabilities?: DesktopShareCapabilities;
  /** Older shells predate theming, so this may be absent. */
  setTheme?(theme: "dark" | "light"): void;
  /** Persist the UI locale in the main process and rebuild the app menu. */
  setLocale?(locale: "en" | "pt-BR"): Promise<string | null>;
  /** Dock / taskbar mention count. Older shells predate notifications. */
  setBadgeCount?(count: number): void;
  /**
   * Show an OS notification from the main process rather than the renderer,
   * which is the only side that can raise the window when it is clicked.
   */
  notify?(payload: {
    title: string;
    body: string;
    /** Collapses repeats from the same channel onto one notification. */
    tag: string;
    /** In-app path under `/app` to open on click. */
    path: string;
  }): void;
  onNotificationClick?(cb: (appPath: string) => void): () => void;
  /**
   * Present only in shells that open Clerk in the system browser. Absence
   * means keep the in-app modal — the hosted client runs inside older
   * binaries, same as `canShareScreen`.
   */
  startDesktopAuth?(
    mode: "sign-in" | "sign-up",
  ): Promise<{ ok: boolean; url: string }>;
  cancelDesktopAuth?(): Promise<void>;
  getDesktopAuthStatus?(): Promise<{ active: boolean; url: string | null }>;
  getPendingDesktopAuthTicket?(): Promise<string | null>;
  onDesktopAuthTicket?(cb: (ticket: string) => void): () => void;
  onDesktopAuthEnded?(cb: (reason: "expired" | "cancelled") => void): () => void;
  /**
   * Global push-to-talk. Hand the shell an Electron accelerator (see
   * `push-to-talk-accelerator.ts`) or `null` to let go of it. Resolves with
   * whether the OS accepted the registration; a key another app already owns
   * comes back `false` and push-to-talk stays in-window only. Older shells
   * predate the bridge, so both may be absent.
   */
  bindPushToTalk?(accelerator: string | null): Promise<boolean>;
  /** Presses and releases of the bound key while another app is focused. */
  onPushToTalk?(cb: (held: boolean) => void): () => void;
  /**
   * Mirror the call state into the main process so the tray icon and menu
   * can say it. Idle is all three false.
   */
  setVoiceState?(state: DesktopVoiceState): void;
  /** Mute, deafen and leave requested from the tray menu. */
  onVoiceCommand?(cb: (command: DesktopVoiceCommand) => void): () => void;
}

/**
 * What the desktop shell says its own screen capture can do.
 *
 * WHY THE SHELL SAYS IT AND THE PAGE DOES NOT WORK IT OUT. Until 0.1.6 the
 * client inferred the two things that matter from `platform`: Windows means
 * loopback audio, anything else means silence. That inference was right, and it
 * was still the wrong design, because the page was reasoning about a binary it
 * cannot see — the hosted client runs inside whatever build the user installed.
 * The failure that proved it was not audio at all: the watch party asks for a
 * browser-tab surface, which is the clean audio path in a browser and does not
 * exist in this shell, and the capture was refused outright rather than falling
 * back to a window.
 *
 * So the shell states its own abilities and the page reads them. Every field is
 * a fact about the installed binary, and an OLD shell has none of this object,
 * which is a perfectly good answer too: keep doing what we did before.
 */
export interface DesktopShareCapabilities {
  /** The main process answers `getDisplayMedia` with a real picker. */
  displayMedia: boolean;
  /**
   * `"loopback"` where the shell can hand over the machine's output (Windows
   * only: Chromium's loopback device is WASAPI), `"none"` where it cannot. On
   * `"none"` the page must not ask for audio: a display-audio request the
   * embedder cannot satisfy fails the whole capture, video included.
   */
  systemAudio: "loopback" | "none";
  /**
   * The shell honours `restrictOwnAudio` on the capture request, i.e. it keeps
   * this app's own playback (everybody's voices) out of the tap. False is a
   * shell saying it cannot, and the page then never offers computer audio.
   */
  restrictOwnAudio: boolean;
  /** The shell's own picker asks about computer audio, so the page need not. */
  pickerOffersAudio: boolean;
  /** The shell's version, for diagnostics. Null when it could not be read. */
  version: string | null;
}

export interface DesktopVoiceState {
  inCall: boolean;
  muted: boolean;
  deafened: boolean;
}

export type DesktopVoiceCommand = "toggleMute" | "toggleDeafen" | "leave";

export function getDesktop(): PqpDesktop | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.pqpDesktop;
}

export function isDesktopApp(): boolean {
  return getDesktop()?.isElectron === true;
}

/** i18next `context` for permission copy that must not say "browser" in Electron. */
export function desktopContext(): { context: "desktop" } | undefined {
  return isDesktopApp() ? { context: "desktop" } : undefined;
}

/**
 * True in a desktop shell too old to capture a screen.
 *
 * WHY ABSENCE IS THE TEST. The shell gained
 * `setDisplayMediaRequestHandler` in 92ab7f7, which never reached a tagged
 * release — so every installed build was one that Chromium happily gave a
 * `getDisplayMedia` to and then had no embedder to answer it. The rejection
 * looks identical to a browser that cannot capture at all, and the client
 * said so, which was wrong and unactionable: the user's app *can* do this,
 * theirs is just old.
 *
 * The shell loads the live web client, so a client deployed today runs inside
 * a shell built weeks ago. Feature-detecting the shell is therefore the only
 * honest way to tell those two failures apart, and a missing key is a
 * perfectly good detector: old shells cannot have opted in to a flag that did
 * not exist when they were built.
 *
 * False in a browser. A browser that cannot share is genuinely unsupported and
 * already has its own wording; telling somebody on Firefox to update a desktop
 * app they do not have would be worse than the bug this replaces.
 */
export function desktopPredatesScreenShare(): boolean {
  const desktop = getDesktop();
  if (desktop === undefined) {
    return false;
  }
  // Either signal is enough. `capabilities.displayMedia` is what a current
  // shell says; `canShareScreen` is what 0.1.3 through 0.1.5 said and what the
  // hosted client still meets every day. A shell that says neither is old, and
  // saying "update the app" to somebody whose app CAN share is the mistake this
  // whole function exists to avoid.
  return (
    desktop.capabilities?.displayMedia !== true && desktop.canShareScreen !== true
  );
}

/**
 * The shell's screen-capture abilities, or null in a browser / an old shell.
 *
 * Null is not "cannot share": it is "this shell does not say", and every caller
 * has to keep the answer it had before the object existed.
 */
export function desktopShareCapabilities(): DesktopShareCapabilities | null {
  return getDesktop()?.capabilities ?? null;
}

/**
 * Normalize a deep-link payload to an `/app` path.
 * Accepts either a mapped path (`/app/...`) or a raw `pqp://` URL.
 */
export function deepLinkToAppPath(input: string): string {
  if (!input) {
    return "/app";
  }
  if (input.startsWith("/app")) {
    return input;
  }
  if (input.startsWith("/")) {
    return `/app${input === "/" ? "" : input}`;
  }
  if (!input.startsWith("pqp://")) {
    return `/app/${input.replace(/^\/+/, "")}`;
  }
  try {
    const parsed = new URL(input);
    const host = parsed.hostname;
    const rest = parsed.pathname.replace(/^\/+|\/+$/g, "");
    const segments = [host, rest].filter(Boolean).join("/");
    if (!segments || segments === "open" || segments === "app") {
      return "/app";
    }
    if (segments.startsWith("app/")) {
      return `/${segments}`;
    }
    return `/app/${segments}`;
  } catch {
    return "/app";
  }
}
