import type { IceServerConfig } from "@pqp/shared";

/**
 * Build ICE server list for WebRTC.
 * Prefer TURN_* env on the API (not baked into the Pages bundle).
 * Falls back to public STUN + Metered Open Relay so mesh voice works across NATs
 * when no private TURN is configured.
 */
export function getIceServers(): IceServerConfig[] {
  const servers: IceServerConfig[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const turnUrl = process.env.TURN_URL ?? process.env.VITE_TURN_URL;
  const turnUsername =
    process.env.TURN_USERNAME ?? process.env.VITE_TURN_USERNAME;
  const turnCredential =
    process.env.TURN_CREDENTIAL ?? process.env.VITE_TURN_CREDENTIAL;

  if (turnUrl && turnUsername && turnCredential) {
    const urls = turnUrl.split(",").map((u) => u.trim()).filter(Boolean);
    servers.push({
      urls: urls.length === 1 ? urls[0]! : urls,
      username: turnUsername,
      credential: turnCredential,
    });
    return servers;
  }

  // Public Open Relay (Metered) — demo-grade TURN so production mesh works
  // without private credentials. Replace with TURN_* for production scale.
  servers.push(
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  );

  return servers;
}
