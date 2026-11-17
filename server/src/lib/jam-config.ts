import { JAM_ERRORS, type JamConfig } from "@pqp/shared";
import { z } from "zod";
import { isEnabled } from "./flags.js";
import { isStorageConfigured } from "./s3.js";

/**
 * Whether jam channels are on for a server: the runtime flag `jam_channels`
 * (default off, per-server override, `JAM_CHANNELS` as its environment
 * default). Served by `GET /api/jam/config?serverId=` and read per request, so
 * the operator's switch is answered by the very next call.
 *
 * Off gates CREATING and CHANGING: a jam channel, and every song and track
 * write (docs/JAM.md has the line). It never hides anything: jams that exist
 * stay readable and playable.
 *
 * `serverId` absent or not a uuid is read as absent, and the answer is the
 * global value.
 *
 * `uploads` is whether object storage is configured here, independent of the
 * flag: a deployment with no `S3_*` can create a song and never a track.
 */
const serverIdSchema = z.string().uuid();

export function jamConfigForServer(rawServerId: string | null): JamConfig {
  const parsed = serverIdSchema.safeParse(rawServerId);
  const serverId = parsed.success ? parsed.data : null;
  return {
    enabled: jamChannelsEnabled(serverId),
    uploads: isStorageConfigured(),
  };
}

export function jamChannelsEnabled(serverId: string | null): boolean {
  return isEnabled("jam_channels", { serverId });
}

/** The `error` token of the 403 a write answers while the flag is off. */
export const JAM_CHANNELS_OFF = JAM_ERRORS.off;
