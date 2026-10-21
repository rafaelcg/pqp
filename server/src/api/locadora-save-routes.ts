import { z } from "zod";
import {
  locadoraGameKeySchema,
  locadoraSaveCommitBodySchema,
  locadoraSaveRestoreBodySchema,
  locadoraSaveUploadBodySchema,
} from "@pqp/shared";
import {
  beginUpload,
  clearSaves,
  commitUpload,
  deleteSave,
  downloadSave,
  listSaves,
  restoreSave,
  saveContext,
  saveStatus,
} from "../apps/locadora-saves.js";
import { HttpError, readJsonBody } from "../lib/http.js";
import type { Router } from "../lib/router.js";

/**
 * SAVES NA CONTA, Locadora's account-side saves (flag `locadora_save_sync`,
 * per server, default off; `apps/locadora-saves.ts`, docs/EMULATOR_ROOM.md
 * rule 7). Every route names the app session it is asked from (`sessionId`,
 * in the query or the body) and answers 404 unless the caller holds a player
 * seat in that live Locadora session and the flags are on for its server. With
 * the flag off, the reads and the deletes keep working for 30 days for an
 * account that used it (`read-only`); the writes do not.
 *
 * Only the pqp page calls these (the bridge host), with the person's token.
 * The app frame never sees them, a token or a user id.
 *
 *  - `GET    /api/apps/pqp-locadora/saves/status?sessionId=`          mode, salt, usage
 *  - `GET    /api/apps/pqp-locadora/saves?sessionId=&gameKey=`        one game's saves
 *  - `POST   /api/apps/pqp-locadora/saves/upload`                     presigned PUTs, 409 `stale_rev`, 413 `quota`
 *  - `POST   /api/apps/pqp-locadora/saves/uploads/:uploadId/commit`   HEAD check, rev + 1
 *  - `GET    /api/apps/pqp-locadora/saves/:saveId/download?sessionId=` presigned GETs
 *  - `POST   /api/apps/pqp-locadora/saves/:saveId/restore`            the newest older battery save
 *  - `DELETE /api/apps/pqp-locadora/saves/:saveId?sessionId=`
 *  - `DELETE /api/apps/pqp-locadora/saves?sessionId=[&gameKey=]`      one game's, or every save
 */

const BASE = "/api/apps/pqp-locadora/saves";
const sessionIdSchema = z.string().uuid();

function sessionFrom(url: URL): string {
  const parsed = sessionIdSchema.safeParse(url.searchParams.get("sessionId"));
  if (!parsed.success) throw new HttpError(404, "Not found");
  return parsed.data;
}

export function registerLocadoraSaveRoutes(router: Router): void {
  router.get(`${BASE}/status`, async ({ url, user }) => {
    return saveStatus(await saveContext(user.id, sessionFrom(url), { write: false }));
  });

  router.get(BASE, async ({ url, user }) => {
    const context = await saveContext(user.id, sessionFrom(url), { write: false });
    const gameKey = locadoraGameKeySchema.parse(url.searchParams.get("gameKey"));
    return { saves: await listSaves(context, gameKey) };
  });

  router.post(`${BASE}/upload`, async ({ req, user }) => {
    const body = locadoraSaveUploadBodySchema.parse(await readJsonBody(req));
    return beginUpload(await saveContext(user.id, body.sessionId, { write: true }), body);
  });

  router.post(`${BASE}/uploads/:uploadId/commit`, async ({ req, user }, { uploadId }) => {
    const body = locadoraSaveCommitBodySchema.parse(await readJsonBody(req));
    return commitUpload(await saveContext(user.id, body.sessionId, { write: true }), uploadId!);
  });

  router.get(`${BASE}/:saveId/download`, async ({ url, user }, { saveId }) => {
    return downloadSave(await saveContext(user.id, sessionFrom(url), { write: false }), saveId!);
  });

  router.post(`${BASE}/:saveId/restore`, async ({ req, user }, { saveId }) => {
    const body = locadoraSaveRestoreBodySchema.parse(await readJsonBody(req));
    return { save: await restoreSave(await saveContext(user.id, body.sessionId, { write: true }), saveId!, body.baseRev) };
  });

  router.delete(`${BASE}/:saveId`, async ({ url, user }, { saveId }) => {
    return deleteSave(await saveContext(user.id, sessionFrom(url), { write: false }), saveId!);
  });

  router.delete(BASE, async ({ url, user }) => {
    const context = await saveContext(user.id, sessionFrom(url), { write: false });
    const raw = url.searchParams.get("gameKey");
    return clearSaves(context, raw === null ? null : locadoraGameKeySchema.parse(raw));
  });
}
