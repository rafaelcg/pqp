# File attachments

Uploaded files live in **S3-compatible object storage**, never on the API's disk — Railway's
filesystem is ephemeral, so anything written there is gone on the next redeploy. Production is
**Cloudflare R2**; local dev and self-hosters point the same driver at **MinIO**. One code path,
two deployments.

Bytes never pass through the Node process. The server signs URLs and the browser talks to
storage directly, which keeps a 10 MiB upload off the API's memory and off Railway's egress bill.

Background on why R2 and not Postgres large objects: [`DECISIONS.md`](./DECISIONS.md).

## The flow

1. Client `POST /api/channels/:channelId/attachments`
   `{ filename, contentType, byteSize, width?, height? }`. `width` / `height` are display-only
   pixel hints the browser reads off the image before it uploads, so a message can reserve the
   right box instead of reflowing when the picture decodes.
2. Server checks channel access, checks the content type against the allowlist and the size
   against the cap, inserts a `message_attachments` row with `message_id NULL` and a
   **server-generated** storage key, and returns `{ attachmentId, uploadUrl, expiresAt }`.
   The key is never client-supplied — a client that picks its own key can overwrite another
   user's object.
3. Client `PUT`s the file straight to `uploadUrl`. Both `Content-Type` **and** `Content-Length`
   are signed into that URL, so a body of a different type or a different length fails the
   signature. The upload URL is good for 15 minutes.
4. Client sends `message-create` over `/ws` with `attachmentIds`.
5. Server **claims** the rows in the same transaction as the message insert, requiring
   `uploader_id` = sender, `channel_id` = the target channel, and `message_id IS NULL`. The
   `HEAD` that confirms each object runs **before** that transaction opens, on the pool: it is
   an HTTP round trip with a ten second timeout, and held between `BEGIN` and `COMMIT` a bucket
   that blackholes packets would park a pooled connection idle-in-transaction for the whole
   timeout — a handful of concurrent image sends then drain the pool and a storage outage
   becomes an API outage. An attachment that fails the HEAD is dropped from the message rather
   than silently accepted.
6. On every read, the server mints a presigned GET per attachment row and embeds it as `url`.
   Presigning is pure HMAC with no network call, so this is cheap enough to do per row per read.

Step 5 is also where **image safety scanning** happens, when it is configured — concurrently
with that HEAD, for the same reason it is there rather than inside the transaction. An
attachment the scanner refuses is dropped exactly like one whose object was never uploaded, so
an unsafe image is never visible for any length of time. It is off by default and every
attachment then records `scan_status = 'unscanned'`, which is not a pass.
See [`CONTENT_SAFETY.md`](./CONTENT_SAFETY.md) — including what is *not* scanned, and what the
operator has to apply for.

Signing is hand-rolled SigV4 in `server/src/lib/s3.ts` using `node:crypto` only. No SDK: the AWS
S3 client pulls ~50 packages into the Railway image for one operation, in a repo that runs raw
`node:http` with no framework.

### Size is enforced twice

**At mint**, by signing `Content-Length` into the presigned PUT. The store compares the length
on the wire against the length in the signature, so a row that declared 12 KB cannot be used to
park 5 GiB in the bucket. Note what the rejection *is*: a signature mismatch (`403
SignatureDoesNotMatch`), not a size check, so it only holds for a store that reconstructs
`content-length` verbatim into the string-to-sign.

**At claim**, by `HEAD`ing the object. This is not redundant. It is the only thing that tells
"never uploaded" apart from "uploaded", it catches an object stored as something other than what
was signed (`head.contentType !== row.content_type`), and it covers any S3-compatible store that
ignores the signed length. An attachment that fails it is dropped; the row is left unclaimed for
the sweeper.

Two things are worth knowing before trusting either:

- **The signed length is verified against R2 as well as MinIO** (2026-08-07). The concern was
  real — R2 sits behind Cloudflare's edge, which is exactly the kind of proxy that re-frames
  request bodies — so it was tested rather than assumed: a URL minted for one byte, sent 4096,
  is refused and nothing lands in the bucket. Run it yourself with
  `S3_TEST_ENDPOINT`/`S3_TEST_BUCKET`/`S3_TEST_ACCESS_KEY_ID`/`S3_TEST_SECRET_ACCESS_KEY`/
  `S3_TEST_REGION=auto` against `server/src/lib/s3.test.ts`; all 19 pass against a real bucket,
  including keys with spaces and parentheses.

## Off by default

With no S3 env configured the feature is entirely absent — the same shape GIF search uses.
`GET /api/attachments/config` answers `{"enabled":false,"maxBytes":10485760}` and the composer
hides the attach button. Nothing 500s, nothing renders half-wired. (`maxBytes` rides along in
both states so the file picker can reject an over-size file against this deployment's own cap
rather than discovering it on a 413.)

## Local dev against MinIO

MinIO ships in `docker-compose.yml` behind a profile, with a one-shot that creates the bucket:

```bash
docker compose --profile storage up -d postgres minio minio-init
```

`minio-init` exits 0 once the bucket exists and is a no-op on re-up. It is not optional garnish:
a fresh MinIO has **no buckets**, and without it the first upload 404s from a URL the server
signed perfectly well, which reads like a signing bug and is not one.

Then in the root `.env` (dev credentials, matching the compose file):

```
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=pqp-attachments
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=pqpminio
S3_SECRET_ACCESS_KEY=pqpminio-dev-secret
S3_FORCE_PATH_STYLE=true
```

Restart the server (`pnpm dev`) and check it took:

```bash
curl -s -H "Authorization: Bearer dev-local-token" \
  http://localhost:3001/api/attachments/config
# {"enabled":true,"maxBytes":10485760}
```

**The header is not optional.** Every `/api` route resolves a Bearer token before it reaches the
router — there is no public-route allowlist — so a bare `curl` answers `401
{"error":"Unauthorized"}` no matter how correctly storage is configured, which reads as "the
feature is broken" at the exact moment you are checking whether it works. `dev-local-token` is
only accepted when `DEV_AUTH_BYPASS=true` (and never when `NODE_ENV=production`); with Clerk
running, copy the `Authorization` header off any `/api` request in the browser's network tab.

`enabled:false` in that response means the server did not see the `S3_*` values — check they are
in the **root** `.env` and that the server was restarted, since the config is read per call from
the process environment.

Objects are browsable at the MinIO console, <http://localhost:9001>, with the same
user/password. Handy for confirming a PUT actually landed rather than guessing from the UI.

**`S3_FORCE_PATH_STYLE=true` is required for MinIO.** It addresses buckets by path
(`host/bucket/key`) rather than by subdomain, and a signature built for the wrong addressing
style fails with `SignatureDoesNotMatch` — not a 404, so the error does not point at the cause.

**MinIO allows all CORS origins by default**, so a browser PUT works locally with no setup. That
is exactly why the first hosted deploy breaks: R2 does not.

### Running the API inside compose

The `app` service takes the same `S3_*` vars, passed through from your shell or `.env`. One
catch: `S3_ENDPOINT` is both the host baked into the presigned URL the **browser** uploads to
and the host the **API container** HEADs before claiming, so a single name has to resolve from
both. `localhost` does not — it means the container itself. Use the machine's LAN IP, or run the
API on the host with `pnpm dev`, where `http://localhost:9000` satisfies both.

## Cloudflare R2 in production

### 1. Bucket

Cloudflare Dashboard → **R2** → **Create bucket**, e.g. `pqp-attachments`. Leave it **private**;
reads are presigned. A public bucket would make every attachment permanently world-readable
regardless of the private channel it was posted in.

### 2. API token

**R2** → **Manage R2 API Tokens** → **Create API token**, permission **Object Read & Write**,
scoped to that one bucket. Cloudflare shows the Access Key ID, the Secret Access Key (once), and
the S3 endpoint. Copy all three now.

### 3. Railway variables

| Variable | Value |
|---|---|
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | your bucket name |
| `S3_REGION` | `auto` |
| `S3_ACCESS_KEY_ID` | from the R2 API token |
| `S3_SECRET_ACCESS_KEY` | from the R2 API token |
| `S3_FORCE_PATH_STYLE` | `false` |
| `S3_PUBLIC_BASE_URL` | optional — custom domain in front of the bucket |
| `MAX_ATTACHMENT_BYTES` | optional — defaults to `10485760` |
| `ATTACHMENT_URL_TTL_SECONDS` | optional — defaults to `43200` (12h) |

The key and secret are credentials. They belong on the API only — **never** in a `VITE_` variable
or a GitHub Actions secret used for the Pages build, both of which end up readable in the public
bundle.

`S3_REGION=auto` is not cosmetic: the region string is part of the SigV4 credential scope, so a
different value signs a request R2 will reject. R2 accepts both path-style and virtual-hosted
addressing, so `S3_FORCE_PATH_STYLE` is genuinely optional there — but if you are staring at a
`SignatureDoesNotMatch` with everything else correct, flipping it is the cheapest thing to try.

EU-jurisdiction buckets use `https://<account-id>.eu.r2.cloudflarestorage.com`. Take the endpoint
Cloudflare shows you rather than assembling it by hand.

### 4. Bucket CORS — this is the one that gets you

**R2 buckets have no CORS policy by default, and a browser cannot PUT to a bucket without one.**
This is the single most common way this feature fails, and it fails in a way that points nowhere
useful: `POST /api/channels/:id/attachments` returns 200, the API logs are completely silent
(the upload never touches the API), and the browser console shows a CORS/network error on a URL
that is perfectly valid. Nothing is wrong with the signature.

Dashboard → your bucket → **Settings** → **CORS Policy** → **Add CORS policy**:

(Or from the CLI — note wrangler takes Cloudflare's own shape, **not** the S3-style array the
dashboard wants, and silently rejects the latter:
`wrangler r2 bucket cors set <bucket> --file cors.json --force` with
`{"rules":[{"allowed":{"origins":[…],"methods":["PUT","GET","HEAD"],"headers":["content-type"]},"exposeHeaders":["ETag"],"maxAgeSeconds":3600}]}`.)

```json
[
  {
    "AllowedOrigins": [
      "https://pqp-3yr.pages.dev",
      "https://pqp.gg"
    ],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Field by field, because every one of these has bitten someone:

- **`AllowedOrigins`** — the exact scheme + host + port of the page doing the upload, not the API
  origin. List every client origin: the Pages deployment, your custom domain, and
  `http://localhost:5173` if you develop a local client against the hosted API. A trailing slash
  or a missing `https://` silently matches nothing.
- **`AllowedMethods`** — `PUT` is the one that matters; it is the upload. `GET`/`HEAD` cost
  nothing and cover a client that fetches bytes with `fetch()` (a download button, a canvas
  read). An `<img src>` load is not a CORS request and works without them.
- **`AllowedHeaders`** must include `content-type`. The presigned PUT signs the Content-Type, so
  the browser sends it, so the preflight asks permission for it — and a policy that omits it
  rejects every upload. The PUT signs `content-length` as well, and that one does **not** belong
  here: it is a forbidden header name, set by the browser from the body and unsettable by script,
  so it never appears in `Access-Control-Request-Headers`. If the signing code is ever changed to
  sign `x-amz-*` headers, those do have to be listed.
- **`ExposeHeaders`** — only needed if client JS reads the response header. Harmless to keep.

The policy lives on the **bucket**, not on the API token, and applies to a custom domain in front
of it as well. Changes take effect within about a minute.

### 5. Verify

```bash
curl -s -H "Authorization: Bearer <clerk-session-token>" \
  https://<your-api-host>/api/attachments/config
# {"enabled":true,"maxBytes":10485760}
```

The token is required — `/api` has no unauthenticated routes, and without the header this is a
`401 {"error":"Unauthorized"}` that says nothing about storage. `dev-local-token` will not work
here: the bypass is ignored whenever `NODE_ENV=production`. Take a real session token from the
`Authorization` header of any `/api` request in the browser's network tab.

Then upload an image from a real browser on the production origin. A curl PUT proves the
signature but proves nothing about CORS, which only a browser enforces — so a working curl and a
broken app is the expected symptom of a missing policy, not a contradiction.

## Limits

| Limit | Value | Where |
|---|---|---|
| Max size per file | 10 MiB | `MAX_ATTACHMENT_BYTES`, default `10485760` |
| Max attachments per message | 10 | `MAX_ATTACHMENTS_PER_MESSAGE` (shared) |
| Filename length | 255 | `attachmentFilenameSchema` (shared) |
| Declared image dimension | 65535 px | `ATTACHMENT_MAX_DIMENSION` (shared) |
| Upload URL lifetime | 15 min | `UPLOAD_URL_TTL_SECONDS` (server constant) |
| Unclaimed row grace | 1 hour | `ORPHAN_GRACE` (server constant) |

`MAX_ATTACHMENT_BYTES` can only **lower** the cap. The shared schema rejects a mint request above
10 MiB before the server's configured value is ever consulted, so raising it past that needs a
change in `packages/shared/src/attachments.ts` and a rebuild, not just an env var.

### Content types

An allowlist, not a denylist, because the failure mode is serving hostile content from our own
origin:

```
image/png  image/jpeg  image/gif  image/webp  image/avif
video/mp4  video/webm
audio/mpeg audio/ogg   audio/wav
application/pdf
text/plain
```

Deliberately absent: `image/svg+xml` and `text/html`. Both are documents that execute script.

Two separate lists guard this. `ATTACHMENT_MIME_ALLOWLIST` decides what may be uploaded;
`isImageContentType()` decides what may go in an `<img>`, and it enumerates the five raster
formats rather than testing an `image/` prefix — a prefix test would also match `image/svg+xml`.
Widening the upload allowlist must never silently widen what renders inline.

Anything that is not an inline image gets `response-content-disposition=attachment` on its
presigned GET, so no user-uploaded file can ever render as a document in a browser tab on our
domain.

## Read URLs and expiry

Read URLs are presigned per read and live for `ATTACHMENT_URL_TTL_SECONDS` (default 12h). They
are not stored anywhere.

A tab left open past the TTL would show a broken image, so the client handles `<img>` `onError`
by refetching a fresh URL from `GET /api/attachments/:attachmentId/url` — authenticated and
access-checked. It self-heals; there is nothing to configure.

The two rejected alternatives, so nobody re-proposes them:

- **Public bucket** — makes every attachment permanently world-readable regardless of the private
  channel it was posted in.
- **Authenticated proxy route** — `<img src>` cannot send a `Bearer` header, and putting the
  Clerk JWT in a query string leaks it into access logs and `Referer` headers.

Shortening the TTL narrows the leak window if a URL is shared; it does not weaken the UX, because
of the refetch above.

## Retention and the sweeper

`message_attachments.message_id` is **`ON DELETE SET NULL`, not `CASCADE`**. That is what lets a
single sweeper cover two different kinds of garbage:

(A third kind is deliberately out of its reach: a row with `quarantined_at` set was refused by
the scanner, is unclaimed forever by construction, and would otherwise be deleted an hour after
it became the only evidence that the upload happened. `sweepQuarantinedAttachments` owns those,
on a 30-day clock — and never touches an illegal-content match at any age.
See [`CONTENT_SAFETY.md`](./CONTENT_SAFETY.md).)

- **Never claimed** — a URL was minted and the user never sent the message.
- **Orphaned** — the message it belonged to was deleted.

Both end up as a row with `message_id IS NULL`, and the sweeper deletes the rows and their
objects:

```sql
WHERE message_id IS NULL AND created_at < now() - interval '1 hour'
```

Two consequences worth knowing before you file a bug:

- An upload has **one hour** to be attached to a message. A composer left open longer than that
  loses its staged file, and the client has to mint a new URL.
- Deleting a message does **not** free the bytes immediately — up to an hour later.

### Deleted channels and servers

`message_attachments.channel_id` is `ON DELETE CASCADE`, so deleting a channel — or a server,
which cascades to its channels — removes the attachment rows outright, and the sweeper can never
help: its predicate is `message_id IS NULL`, which cannot match a row that no longer exists.

So both delete paths read the storage keys **before** the delete and drop the objects after it
lands (`deleteChannel` / `deleteServer` in `server/src/services/servers.ts`). The bucket deletes
are fired in batches of 8 and never awaited: the rows are already gone, so nothing can be
retried and nothing depends on the outcome, and blocking would put one round trip per attachment
in front of the response and let an unreachable bucket fail a delete that already committed. A
failed key is logged as `[attachments] leaked object <key>`.

One bound is deliberate: at most **5000** objects per delete. The key read happens on the request
path, so it cannot pull an unbounded set into memory; past that the objects leak, which is the
same cost problem the sweeper already accepts on a failed delete. Leaked keys are unguessable and
the bucket is private, so this is a bill, not an exposure.

Also on boot: the server runs one sweep immediately after `initDb()` (unawaited, so an
unreachable bucket cannot delay `listen()`) on top of the hourly interval. A process that
redeploys more often than the interval would otherwise never sweep once in its lifetime.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/api/attachments/config` returns 401 `{"error":"Unauthorized"}` | No `Authorization: Bearer …` header — every `/api` route needs one, storage or not |
| Attach button missing, `/api/attachments/config` says `enabled:false` | `S3_ENDPOINT` / `S3_BUCKET` / keys not set on the API |
| `POST …/attachments` 200, PUT fails in the browser, API logs silent | Bucket CORS policy missing or missing `content-type` in `AllowedHeaders` |
| `SignatureDoesNotMatch` on every URL | Wrong `S3_REGION` (R2 needs `auto`), or wrong `S3_FORCE_PATH_STYLE` for the service |
| `SignatureDoesNotMatch` on one PUT that other uploads survive | The body is not the length that was minted — `Content-Length` is signed, and a mid-flight file edit or a re-used URL is the usual cause |
| PUT 404s on a URL the server just signed | Bucket does not exist — locally, `minio-init` did not run |
| PUT rejected on content type | Client sent a `Content-Type` other than the one that was signed |
| Attachment silently missing from a sent message | It failed the HEAD at claim time: never uploaded, stored as a type other than the one signed, or over the cap — or the scanner refused it, or could not run and this deployment fails closed (`SELECT scan_status, scan_labels FROM message_attachments WHERE id = …`) |
| Every image upload stopped attaching at once, `scan_status` reads `error` | A configured scanner is unreachable or its key was revoked, and `CONTENT_SCAN_FAIL_MODE` is `closed`. That is the intended behaviour; fix the provider, do not flip the mode |
| Image broke after a tab sat open all day | Presigned GET expired and the refetch path is not wired |
