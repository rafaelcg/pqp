import { useEffect, useRef, useState } from "react";
import type { Channel, Server } from "@pqp/shared";
import { deferredPanel } from "@/components/deferred";
import { subscribeDiscordImport } from "@/lib/discord-import-launcher";

// Drawn only after somebody asks for the import; its preview and the create
// dialog behind it are not part of the shell.
const DiscordImportMergeDialog = deferredPanel(() =>
  import("@/components/layout/discord-import-merge-dialog").then((m) => ({
    default: m.DiscordImportMergeDialog,
  })),
);

/**
 * Listens for `openDiscordImport(...)` (`@/lib/discord-import-launcher`) and
 * draws what it asked for. Mounted once in the app shell, so a surface that
 * wants the import (the settings row, a notice card) never owns a dialog.
 *
 * - With a `serverId`: the merge dialog for that server, if the viewer is in it.
 * - Without: `onOpenCreate`, the create dialog on its paste step.
 */
export function DiscordImportHost({
  servers,
  onOpenCreate,
  onMerged,
  onOpenChannel,
}: {
  servers: Server[];
  onOpenCreate: (source: string | null) => void;
  onMerged: (serverId: string, channels: Channel[]) => void;
  onOpenChannel: (serverId: string, channelId: string) => void;
}) {
  const [request, setRequest] = useState<{ serverId: string; source: string | null } | null>(
    null,
  );
  const onOpenCreateRef = useRef(onOpenCreate);
  onOpenCreateRef.current = onOpenCreate;

  useEffect(
    () =>
      subscribeDiscordImport((next) => {
        if (next.serverId) {
          setRequest({ serverId: next.serverId, source: next.source });
        } else {
          onOpenCreateRef.current(next.source);
        }
      }),
    [],
  );

  const server = request ? servers.find((s) => s.id === request.serverId) : null;
  if (!request || !server) {
    return null;
  }
  return (
    <DiscordImportMergeDialog
      key={request.serverId}
      serverId={server.id}
      serverName={server.name}
      startSource={request.source}
      onClose={() => setRequest(null)}
      onMerged={onMerged}
      onOpenChannel={onOpenChannel}
    />
  );
}
