import { useCallback, useEffect, useRef, useState } from "react";
import {
  hasPermission,
  parsePermissions,
  type PermissionBit,
} from "@pqp/shared";
import { fetchMemberPermissions } from "@/lib/api";
import {
  shouldApplyPermissionsVersion,
  shouldWipePermissionsOnFetchFailure,
} from "@/lib/permissions-refresh";

export function usePermissions(serverId: string | null) {
  const [serverBits, setServerBits] = useState(0n);
  const [channelBits, setChannelBits] = useState<Record<string, bigint>>({});
  const [version, setVersion] = useState(0);
  const [bump, setBump] = useState(0);
  const versionRef = useRef(0);
  versionRef.current = version;
  const heldServerIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!serverId) {
      setServerBits(0n);
      setChannelBits({});
      setVersion(0);
      versionRef.current = 0;
      heldServerIdRef.current = null;
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
        versionRef.current = snapshot.version;
        heldServerIdRef.current = serverId;
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        if (
          !shouldWipePermissionsOnFetchFailure(
            heldServerIdRef.current,
            serverId,
          )
        ) {
          return;
        }
        setServerBits(0n);
        setChannelBits({});
        setVersion(0);
        versionRef.current = 0;
        heldServerIdRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, bump]);

  const refresh = useCallback((incomingVersion?: number) => {
    if (!shouldApplyPermissionsVersion(versionRef.current, incomingVersion)) {
      return;
    }
    setBump((current) => current + 1);
  }, []);

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

  return { can, version, serverBits, refresh };
}
