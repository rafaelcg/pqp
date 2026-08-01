import type { VoiceBackendType } from "@pqp/shared";

/**
 * Which media path the client should use.
 *
 * The server is the source of truth (`GET /api/voice/backend`) so switching to
 * an SFU needs no client rebuild. `VITE_VOICE_BACKEND=mesh` is a build-time
 * escape hatch that forces peer-to-peer even when an SFU is available — useful
 * for debugging or opting a deployment out.
 */
export function isMeshForced(): boolean {
  return import.meta.env.VITE_VOICE_BACKEND === "mesh";
}

export function getVoiceBackendOverride(): VoiceBackendType | undefined {
  return import.meta.env.VITE_VOICE_BACKEND as VoiceBackendType | undefined;
}
