/**
 * The one door to the Discord layout import, for any surface that wants to
 * open it.
 *
 *     openDiscordImport({ serverId })   // into a server that already exists
 *     openDiscordImport()               // the create dialog, on the paste step
 *
 * A surface (the server settings row, a notice card, a campaign link) calls
 * this and does not own a dialog: `DiscordImportHost`, mounted once in the app
 * shell, listens and draws the right one. The name and the shape are a
 * contract other surfaces build on, so keep them stable.
 *
 * `serverId` only does anything while the runtime flag `discord_import_existing`
 * is on for that server and the person may manage it; the dialog's own first
 * request says so (a 404 or 403) and the host shows it plainly rather than
 * pretending the door was never there. Callers that draw a button should ask
 * `fetchDiscordImportConfig(serverId)` first, as the settings row does.
 */

export interface OpenDiscordImportOptions {
  /** Import INTO this server. Absent: a new community, from the create dialog. */
  serverId?: string | null;
  /** Pre-fills the paste box (a bare code or a `discord.new/...` link). */
  source?: string | null;
}

export interface DiscordImportRequest {
  serverId: string | null;
  source: string | null;
}

type Listener = (request: DiscordImportRequest) => void;

const listeners = new Set<Listener>();
// A call made before the host has mounted (a deep link handled at boot) is
// kept and handed to the first listener, instead of being lost.
let pending: DiscordImportRequest | null = null;

export function openDiscordImport(options: OpenDiscordImportOptions = {}): void {
  const request: DiscordImportRequest = {
    serverId: options.serverId ?? null,
    source: options.source ?? null,
  };
  if (listeners.size === 0) {
    pending = request;
    return;
  }
  for (const listener of [...listeners]) {
    listener(request);
  }
}

/** For the host. Returns the unsubscribe. */
export function subscribeDiscordImport(listener: Listener): () => void {
  listeners.add(listener);
  if (pending) {
    const request = pending;
    pending = null;
    listener(request);
  }
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: forget listeners and anything held for a host that never came. */
export function resetDiscordImportLauncherForTests(): void {
  listeners.clear();
  pending = null;
}
