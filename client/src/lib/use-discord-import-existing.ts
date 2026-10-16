import { useEffect, useState } from "react";
import { fetchDiscordImportConfig } from "@/lib/api";

/**
 * Whether "import a Discord layout into THIS server" is open for a server:
 * the per-server runtime flag `discord_import_existing` plus Manage Server,
 * answered by `GET /api/servers/:id/discord-import/config` (the same read the
 * settings row makes). The notice card asks it so its button, and the words
 * under it, match the dialog it will open (`lib/discord-import-notice.ts`).
 *
 * `null` while the answer is on its way: the card waits rather than drawing
 * one wording and swapping to the other. A failed read is `false`, the
 * create-new import every server has always had.
 *
 * One answer per server per page load, shared by everything that asks; a
 * flip on the dashboard reaches a server on the next load, which is soon
 * enough for a card whose rules already say "a few weeks old".
 */
const answers = new Map<string, boolean>();
const inflight = new Map<string, Promise<boolean>>();

export function loadDiscordImportExisting(
  serverId: string,
  fetcher: (id: string) => Promise<{ enabled: boolean }> = fetchDiscordImportConfig,
): Promise<boolean> {
  const known = answers.get(serverId);
  if (known !== undefined) {
    return Promise.resolve(known);
  }
  let pending = inflight.get(serverId);
  if (!pending) {
    pending = fetcher(serverId)
      .then((config) => config.enabled === true)
      .catch(() => false)
      .then((enabled) => {
        answers.set(serverId, enabled);
        inflight.delete(serverId);
        return enabled;
      });
    inflight.set(serverId, pending);
  }
  return pending;
}

/** Test seam. */
export function resetDiscordImportExistingForTests(): void {
  answers.clear();
  inflight.clear();
}

export function useDiscordImportExisting(
  serverId: string | null,
  active: boolean,
): boolean | null {
  const [state, setState] = useState<{ serverId: string; enabled: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (!serverId || !active) {
      return;
    }
    let cancelled = false;
    void loadDiscordImportExisting(serverId).then((enabled) => {
      if (!cancelled) {
        setState({ serverId, enabled });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [serverId, active]);

  // The answer names its server, so a render after a switch never reads the
  // previous server's.
  return active && serverId && state?.serverId === serverId ? state.enabled : null;
}
