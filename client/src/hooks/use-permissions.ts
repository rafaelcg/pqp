import { useCallback, useEffect, useState } from "react";
import {
  hasPermission,
  parsePermissions,
  type PermissionBit,
} from "@pqp/shared";
import { fetchMemberPermissions } from "@/lib/api";

export function usePermissions(serverId: string | null) {
  const [serverBits, setServerBits] = useState(0n);
  const [channelBits, setChannelBits] = useState<Record<string, bigint>>({});
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!serverId) {
      setServerBits(0n);
      setChannelBits({});
      setVersion(0);
      return;
    }
    let cancelled = false;
    void fetchMemberPermissions(serverId)
      .then((snapshot) => {
        if (cancelled) {
          return;
        }
        setServerBits(parsePermissions(snapshot.server));
        const next: Record<string, bigint> = {};
        for (const [channelId, bits] of Object.entries(snapshot.channels)) {
          next[channelId] = parsePermissions(bits);
        }
        setChannelBits(next);
        setVersion(snapshot.version);
      })
      .catch(() => {
        if (!cancelled) {
          setServerBits(0n);
          setChannelBits({});
          setVersion(0);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  const can = useCallback(
    (bit: PermissionBit | bigint, channelId?: string | null) => {
      const mask =
        channelId && channelBits[channelId] !== undefined
          ? channelBits[channelId]!
          : serverBits;
      return hasPermission(mask, bit);
    },
    [channelBits, serverBits],
  );

  return { can, version, serverBits };
}
