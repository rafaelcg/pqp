import { z } from "zod";
import { isEnabled } from "./flags.js";

/**
 * Whether the emulator room is on for a server: the runtime flag
 * `emulator_room` (default off, per-server override, `EMULATOR_ROOM` as its
 * environment default). Served by `GET /api/emulator/config?serverId=` and
 * read per request, so the operator's switch is answered by the very next call.
 *
 * This is the whole server side of the feature, on purpose. The emulator runs
 * in the player's browser, a game file is picked from the player's own disk and
 * never reaches any route here, and nothing is stored. See docs/EMULATOR_ROOM.md.
 *
 * `serverId` absent or not a uuid is read as absent: the answer is the global
 * value.
 */
const serverIdSchema = z.string().uuid();

export interface EmulatorConfig {
  enabled: boolean;
}

export function emulatorConfigForServer(rawServerId: string | null): EmulatorConfig {
  const parsed = serverIdSchema.safeParse(rawServerId);
  const serverId = parsed.success ? parsed.data : null;
  return { enabled: isEnabled("emulator_room", { serverId }) };
}
