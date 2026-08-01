# Decisions

Choices that shape work not yet built. Recorded so a later session does not silently
re-litigate them.

## Attachments: Cloudflare R2 (2026-08-01)

Uploads go to Cloudflare R2 over the S3 API. The server mints presigned upload URLs so bytes
never pass through the API process.

**Why.** Railway's filesystem is ephemeral — anything written to disk is lost on redeploy, so
local disk is not an option for the hosted deployment. R2 has no egress fees and the project is
already on Cloudflare for Pages. Postgres large objects were the alternative; rejected because
they bloat the database and every backup, for the one kind of data that least needs
transactional storage.

**Implications.**
- New Railway env: an R2 bucket name, account id, access key id, secret. Never in a `VITE_` var.
- Self-hosters point the same S3 driver at MinIO or any S3-compatible service, so the
  open-source story stays intact without a second code path.
- Presigned PUT for upload, and either presigned GET or a public bucket with unguessable keys
  for reads. Prefer presigned GET — a public bucket makes every attachment permanently world
  readable regardless of the channel it was posted in, which contradicts private channels.
- Enforce a size cap and an allowlist of content types **server-side when minting the URL**, not
  only in the client.
- Store attachment metadata in Postgres (`message_attachments`): message id, key, content type,
  size, width/height for images. The object store holds bytes; the database stays the index.

## DMs: 1:1 and group from one model (2026-08-01)

Build direct messages with a model that covers both 1:1 and group conversations from the start,
rather than shipping 1:1 and migrating later.

**Why.** The migration from a two-participant assumption to N participants touches permissions,
the sidebar, naming, unread and notifications all at once — the same surfaces twice. Doing it
once is more work now and less work in total.

**Implications.**
- `channels.server_id` becomes nullable, or conversations become their own table. Whichever is
  chosen, the entire message / WebSocket / unread / mention stack should be reused unchanged —
  a parallel messaging path is how this feature turns into a rewrite.
- A participants table with no roles. Group DMs have no owner in Discord's model; anyone can add
  anyone, and that is a deliberate simplification worth copying.
- Naming: a DM has no name. The UI derives it from the other participants, which means the
  sidebar needs the participant list, not just a title.
- Needs user search by handle first (gap #17) — there is currently no way to find someone you do
  not already share a server with.
- Blocking and DM privacy controls (gap #19) stop being optional the moment DMs exist.
