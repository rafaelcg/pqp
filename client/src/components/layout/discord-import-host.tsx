import { useEffect, useRef, useState } from "react";
import type { Channel, Server } from "@pqp/shared";
import { DiscordImportMergeDialog } from "@/components/layout/discord-import-merge-dialog";
import { subscribeDiscordImport } from "@/lib/discord-import-launcher";

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
