# pqp-jam-media-edge: public jam media at the edge

A Cloudflare Worker that serves the audio, video and covers of **public jams**
from R2, at a hostname on our zone (proposed `jam-media.pqp.gg`), through the
colo cache. It is decision D2 of the Jam marketing plan.

Why: public jam media used to be read by the browser straight from the bucket's
own endpoint, which is not a Cloudflare cached hostname on our zone, so
Cloudflare's CSAM Scanning Tool had nothing to look at. With this Worker the
bytes pass through our zone. **What that does and does not buy is narrower than
it sounds**, and it is written down once, honestly, in
[`docs/CONTENT_SAFETY.md`](../../docs/CONTENT_SAFETY.md) §"Public jams" and
[`docs/JAM_PUBLIC.md`](../../docs/JAM_PUBLIC.md) §"What is and is not scanned".
Read the section "What the CSAM tool does and does not cover" below before
telling anybody this "scans jams".

Not part of the pnpm workspace, for the same reasons `tools/hls-edge` is not
(its own `package.json`, its own install, its own CI step in `ci.yml`).

## The switch

Nothing points at this Worker until the API does:

| API env | Behaviour |
|---|---|
| `JAM_PUBLIC_MEDIA_BASE_URL` unset (today) | public reads hand out presigned bucket URLs, exactly as before |
| `JAM_PUBLIC_MEDIA_BASE_URL=https://jam-media.pqp.gg` | public reads hand out `https://jam-media.pqp.gg/jam-media/<token>?e=<exp>&s=<sig>` |

That variable is read per call (`jamPublicMediaBaseUrl`), so it needs no restart
beyond whatever your env change already costs. **Unsetting it is the rollback.**
The Worker needs no rollback of its own: with the variable unset nothing sends
it a request.

## The URL shape and the token scheme

`GET|HEAD /jam-media/<token>?e=<unix seconds>&s=<signature>`, minted by
`jamPublicMediaUrl` in `server/src/services/jam-public-media.ts`. This was
already the scheme the API implements, and the Worker accepts exactly it:

- `<token>` is the object key, **encrypted**: base64url of a 12-byte IV, the
  AES-256-GCM ciphertext, and the 16-byte tag, under the raw bytes of
  `HMAC-SHA256(S, "aes-key")`. The URL names nothing: a channel song's key is
  `jam/<server id>/...`, and a presigned URL would show that server id even
  when the starter hid the origin.
- `e` is the expiry, unix seconds. `s` is `base64url(HMAC-SHA256(S, "<token>\n<e>"))`.
- `S` is the **derived** secret, `base64url(HMAC-SHA256(CLERK_SECRET_KEY,
  "pqp-jam-public-media"))`. The Worker holds it as `JAM_PUBLIC_MEDIA_SECRET`;
  it never holds the Clerk key.
- The token for one object never changes (the IV is derived from the key), so
  one object is one cache entry, and every visitor inside a ten-minute window
  is handed the same URL.

**Why a signed path token and not a short-lived presigned URL or a public
prefix.** It is the simplest option that cannot expose a private jam's media:

- *A public prefix rule* ("everything under `jam/public/` is public") fails the
  moment a channel song is made public, because its objects live under
  `jam/<server id>/` and stay there. It would also make "published" mean "in a
  folder", which `unpublish` and a withdrawn consent do not change.
- *A presigned bucket URL* is what we have today and is the thing being
  replaced: it points at the bucket host, not at our zone.
- *A signed token the API mints* ties "this object may be served" to the
  moment the API built a public read, which is the one place that already
  decides what is public (`jam-public-sql.ts`). The Worker has no database,
  holds no list of songs and cannot be wrong about which are published, because
  it never decides: it only refuses what the API did not sign. A private
  (channel only) jam's media is presigned directly by the private routes and is
  never given a token. An unpublished or removed part drops out of every read at
  once, so no new token is ever minted for it.

What the Worker checks, in order, on every request, **before any cache is
looked at**: (1) `e` is 1 to 12 digits and the token is base64url; (2) `s`
equals the HMAC, compared in constant time; (3) `e` is not in the past; (4) the
token decrypts; (5) the key starts with `jam/` and has no empty, `.` or `..`
segment, no backslash and no control character. Nothing else in the bucket (the
same bucket holds attachments, avatars, stories, Baú media) is reachable, even
with a correctly signed URL, and a test pins it.

Then the type is checked: only the types a jam can hold (flac, webm, ogg, mp4,
mpeg audio; webm and mp4 video; jpeg, png, webp) are served, whatever the key
says. Something under `jam/` that is anything else (say, text/html) is a 404.
An object stored with no type, or `application/octet-stream`, falls back to its
extension.

`src/media-token.ts` is a Web Crypto port of `openJamPublicMediaUrl` (the
server's reference, which its own tests pin). Two crypto backends and two
codebases agree through `test/golden.json`: URLs minted by the REAL server code,
opened by this Worker's tests, and re-minted byte for byte by
`server/src/services/jam-public-media-edge.test.ts`. A drift on either side
fails CI, not production.

## How long a removal takes

The Worker has no database, so it cannot learn about a removal. The bound is
the URL's own expiry, and it is stated here so nobody has to work it out during
an incident.

| What happened | Stops being served |
|---|---|
| Unpublish (starter, moderator, operator), a part removed, a consent changed to "no", a block, a report-hide, a quarantine | **within 60 minutes**. The API stops handing out the URL at once (every public read drops it). A URL already handed out works until its `e`, which is the start of its ten-minute window plus 60 minutes, so 50 to 60 minutes after it was minted and never more than 60 minutes after the removal, because a mint cannot be later than the removal. Same bound a presigned URL has today. |
| The object is deleted from the bucket (deleting a track or song, an account deletion) | **within 10 minutes**: an uncached object is a 404 at once, a cached copy lives `CACHE_TTL_SECONDS` (600) and is never refreshed by a hit, and a browser is told `max-age` of at most 600 and never past the URL's expiry. |
| Emergency, all media | `MEDIA_SERVING=off` answers every request 503 before any credential or cache work, effective as soon as the variable change deploys (seconds). Rotating `JAM_PUBLIC_MEDIA_SECRET` to any other value does the same with a 403 and also kills every URL still in a browser; restore the real derived value to bring media back. |
| Emergency, one object | There is no per-object deny list on purpose (a list is a second source of truth that can be wrong). Delete the object from the bucket (10 minutes), and if that is too slow, use the switch above. |

If an hour is ever too long for the unpublish case, the lever is
the constant `JAM_PUBLIC_MEDIA_TTL_SECONDS` in
`server/src/services/jam-public-media.ts` (a server change, not a Worker one,
and it moves the presigned path too): shortening it shortens the bound one for
one and costs clients a re-read of the song sooner.

## Range, types, caching, CORS

- **Range.** One `bytes=` range is honoured: `a-b`, `a-`, `-n`. Past-the-end is
  clamped; a start past the end is a 416 with `Content-Range: bytes */<size>`.
  Several ranges, another unit or a malformed header are ignored and the whole
  object is served, which RFC 9110 allows (a 416 for a header it merely did not
  understand sends `<audio>` into a retry loop). `Accept-Ranges: bytes` always.
- **A cold request** is answered straight from R2 (a ranged read for a range:
  seeking a 100 MiB video never pulls 100 MiB) and the whole object is put in
  the colo cache in the background when it is at most 64 MiB. A cold whole GET
  is teed to the client and the cache in one pass. A hit answers a `Range` with
  a 206 out of the stored 200 (the Cache API does that; it refuses to `put` a
  206, so the Worker never tries). One background fill per object per isolate.
- **Cache key** is the path, never the query (`e` and `s` change; the object does
  not). The credential is still checked first on every request.
- **Headers.** `Content-Type` as stored, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Resource-Policy: cross-origin` (the player is on another
  origin), `ETag`, and `Cache-Control: public, max-age=N` with
  `N = min(600, seconds until the URL expires)`. Errors are `no-store`.
- **CORS** for `CORS_ALLOWED_ORIGINS` (`https://jam.pqp.gg,https://pqp.gg`), with
  `Vary: Origin` always and `Range` allowed in a preflight. An origin off the
  list still gets the media (an `<audio>` or `<video>` tag needs no CORS) but no
  CORS header. CORS is added per response and never stored in the cache.
- **Methods:** GET, HEAD, OPTIONS. Anything else is a 405. The R2 binding is
  only ever `get` and `head` (bindings cannot be made read-only in config, so a
  test fails if the code calls anything else). `/health` answers `ok`.
- Status codes: 400 malformed, 403 bad signature or expired (the body says
  which), 404 not there or not a servable type, 405, 416, 503 switch off, no
  secret or no bucket (loud, never cached, never a 404), 502 R2 fault.
- Logs: one JSON line per rejection, miss and fault; not per hit.

## Layout

| File | |
|---|---|
| `src/index.ts` | The entry. workerd refuses any export but the handler, so it is only that |
| `src/handler.ts` | Routing, the cache-or-bucket decision, headers, CORS |
| `src/media-token.ts` | The URL check, a port of `openJamPublicMediaUrl` |
| `src/range.ts` | Parsing and resolving one byte range |
| `test/index.test.mjs` | Against fakes of R2 and the Cache API; imports the compiled `dist/` |
| `test/golden.json` | URLs minted by the real server code |
| `wrangler.jsonc` | Bindings, vars, route (`jam-media.pqp.gg`), a `staging` env |

```bash
cd tools/jam-media-edge
npm install
npm test            # tsc, then node --test (about a second)
npm run check       # tsc --noEmit
npm run dry-run     # wrangler deploy --dry-run: bundles, deploys nothing
```

Local run against a simulated bucket (nothing leaves the machine):

```bash
npx wrangler r2 object put pqp-attachments/jam/public/song/a.flac \
  --file ./some.flac --content-type audio/flac --local --persist-to .wrangler/state
npx wrangler dev --local --port 8799 --persist-to .wrangler/state \
  --var JAM_PUBLIC_MEDIA_SECRET:devsecret
# mint a URL for it (any 32-byte-ish secret; this is the same scheme as the server):
node -e 'const c=require("crypto"),s="devsecret",k="jam/public/song/a.flac",e=Math.floor(Date.now()/1000)+3000;
const iv=c.createHmac("sha256",s).update("iv\n"+k).digest().subarray(0,12);
const ci=c.createCipheriv("aes-256-gcm",c.createHmac("sha256",s).update("aes-key").digest(),iv);
const t=Buffer.concat([iv,ci.update(k),ci.final(),ci.getAuthTag()]).toString("base64url");
console.log("/jam-media/"+t+"?e="+e+"&s="+c.createHmac("sha256",s).update(t+"\n"+e).digest("base64url"))'
curl -s -D - -H "Range: bytes=0-99" "http://localhost:8799<the path above>" -o /dev/null
```

## The runbook

Nothing here has been deployed. These are the steps, in order. Steps 1 to 4
change nothing for anybody; step 5 is the switch.

### 0. Prerequisites

- The `pqp.gg` zone is in the same Cloudflare account as the `pqp-attachments`
  bucket. A Worker custom domain and an R2 binding both need that.
- `jam_public` stays off throughout. This whole rollout is safe with it off:
  with the flag off no public read exists to hand out a URL. Do the Cloudflare
  work first, flip the env var, **then** the flag.

### 1. The secret (never written down anywhere)

The Worker's secret is the API's **derived** key, not `CLERK_SECRET_KEY`.
Derive it where the Clerk key already lives (the API box, in a shell that has
loaded `/opt/pqp/.env`), and pipe it so it is never printed or pasted into a
file:

```bash
# on the API box
node -e 'process.stdout.write(require("crypto").createHmac("sha256", process.env.CLERK_SECRET_KEY).update("pqp-jam-public-media").digest("base64url"))'
```

Then on a machine logged in to Cloudflare, paste that one value at the prompt:

```bash
cd tools/jam-media-edge
npm install
npx wrangler login                                  # once
npx wrangler secret put JAM_PUBLIC_MEDIA_SECRET     # paste the derived value
```

**If `CLERK_SECRET_KEY` is ever rotated, this secret changes with it.** Re-derive
and `secret put` again in the same sitting, or every public jam goes silent with
403s. (The API and the Worker must hold the same derived value; that is the only
coupling.)

### 2. Deploy the Worker

```bash
npx wrangler deploy --env=""     # the top-level (production) config
```

`wrangler.jsonc` declares the route as a **custom domain**
(`jam-media.pqp.gg`), so this also creates the DNS record and certificate on the
zone. If a DNS record named `jam-media` already exists, delete it first or the
deploy refuses.

### 3. Prove it before any viewer is pointed at it

```bash
curl -s https://jam-media.pqp.gg/health                                  # ok
curl -s -w ' %{http_code}\n' https://jam-media.pqp.gg/jam-media/x        # {"error":"malformed"} 400
curl -s -w ' %{http_code}\n' "https://jam-media.pqp.gg/jam-media/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?e=9999999999&s=AAAA"
#   {"error":"bad-signature"} 403   (a 503 "unconfigured" means the secret is not set)
```

Then a real URL: with the API pointed here on **staging** first
(`npx wrangler deploy --env staging`, and `secret put ... --env staging`, its own secret derived from staging's Clerk
key, bucket `pqp-attachments-staging`), publish a jam, read it, and check a
range request returns a 206 and the second one is a cache hit (no R2 read in
`wrangler tail`).

### 4. Cloudflare dashboard steps (Rafael)

1. **Caching → Configuration → CSAM Scanning Tool → Configure** on the `pqp.gg`
   zone: enter a monitored email address. It is the address Cloudflare writes to
   on a detection (a daily digest with the file paths). Accept the Service
   Specific Terms (use "solely for the purposes of preventing the spread of
   CSAM"). Free; no NCMEC credentials needed.
2. **Workers & Pages → pqp-jam-media-edge → Settings → Domains & Routes**:
   confirm `jam-media.pqp.gg` is listed as a Custom Domain and the DNS tab of
   the zone shows its record as proxied (orange cloud). The CSAM tool is a
   zone setting and only content served through the zone's proxy and cache is in
   scope.
3. **Open a Cloudflare support ticket** asking, in plain words, whether content
   a Worker stores with the Cache API (`caches.default`) and serves on a custom
   domain of the zone is in scope of the CSAM Scanning Tool, and whether it
   covers audio or video. The public documentation does not answer either
   (see the next section). Until that is answered in writing, treat the answer
   as **not known**.
4. Optional: a Cloudflare **Notification** (Notifications → add) so the daily
   digest also reaches the shared inbox, not only one person.
5. Do **not** add a Cache Rule for this host: the Worker owns its own caching,
   and a rule would double-cache responses the Worker has already bounded.
6. Do not enable `r2.dev` for `pqp-attachments`, and keep the bucket's own S3
   endpoint private (it is: reads are presigned or through this Worker).

### 5. Switch the API over

On the API box, set `JAM_PUBLIC_MEDIA_BASE_URL=https://jam-media.pqp.gg` in the
env and recreate the containers the way any env change goes
(`docs/deploy-vultr.md`; `api-a` then `api-b`). It is read per call, so there is
no migration: the next public read hands out edge URLs, and URLs already out
keep working until they expire (they are presigned bucket URLs, valid at most an
hour).

### 6. Watch it

`wrangler tail pqp-jam-media-edge` (or the Worker's Logs tab). Healthy is a
trickle of `jamMedia.miss` and nothing else. Worth alarming on:
`jamMedia.rejected` with `reason: "bad-signature"` in volume (secret mismatch
after a Clerk rotation), `jamMedia.bucketNotConfigured`, `jamMedia.originError`,
`jamMedia.refusedType` (something under `jam/` that is not media).

### Rollback

1. **Unset `JAM_PUBLIC_MEDIA_BASE_URL` on the API.** Public reads immediately
   hand out presigned bucket URLs again. URLs already issued to the edge expire
   within the hour.
2. If the Worker itself is misbehaving and cannot wait for step 1, set
   `MEDIA_SERVING` to `off` (Workers → pqp-jam-media-edge → Settings → Variables,
   or edit `wrangler.jsonc` and `npx wrangler deploy --env=""`): every request is a 503 at
   once.
3. To remove it entirely: `npx wrangler delete --env=""` (after step 1). The bucket and
   the API are untouched.

## What the CSAM tool does and does not cover

From Cloudflare's documentation, read 2026-11-14
(<https://developers.cloudflare.com/cache/reference/csam-scanning/> and the
announcement post <https://blog.cloudflare.com/the-csam-scanning-tool>):

- It "compares content served for your website through the Cloudflare cache to
  known lists of CSAM". Cloudflare's own summary: "our tool scans your cached
  content for potential CSAM, creating a fuzzy hash of each image".
- The documentation names **images** ("identify and block images identified as
  CSAM"). It does not mention video or audio anywhere, lists no supported file
  types and no size limits. **Audio and video are therefore not documented as
  covered, and this repo does not claim they are.** The announcement post adds
  that the software "can only scan images that are at rest in memory on a
  machine, not those that are streaming", which is a reason to doubt a range
  response of a video is ever hashed.
- It is **zone scoped** and about content **served through the cache**. The
  documentation says nothing about Workers, the Cache API or R2, so whether a
  Worker's `caches.default` entry counts is **not documented**. This Worker is
  built so the question is answerable "yes" (our zone, our hostname, the colo
  cache), but "built so it could be" is not "confirmed". Step 4.3 asks.
- On a match: an email once a day with the file paths, and "if possible, a
  block is placed to prevent further serving of the matched content". It is a
  serving-path control, not an upload-path one: it cannot stop bytes landing in
  R2.

What pqp does about public jam bytes without this tool is in
`docs/JAM_PUBLIC.md` (covers and video frames go through the image scanner
before they are public; **public audio is not scanned by anything**).
