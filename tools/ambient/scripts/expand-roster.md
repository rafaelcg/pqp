# Expanding the roster — the exact operator steps

Ten communities were added to `personas.yaml` alongside the five that were
already live. This is the runbook for putting them into production without
taking the five down, and without losing the twenty-five credentials that are
already out there.

Read `docs/ambient-deploy.md` first if the cast has never been deployed — this
document assumes the five are already running and only covers **adding to** them.

| What is being added | Count |
|---|---|
| Communities | 10 (roster goes 5 → 15) |
| Characters | 51 (roster goes 25 → 76) |
| Servers to create | 10 |
| Directory listings | 15 (the five get `community_language` set too) |

**The one thing that can go badly wrong** is step 2. `secrets/characters.json`
is the only copy of every character's token, the file is written whole on each
run, and the twenty-five that already exist cannot be read back out of the
database. If you provision the new fifty-one on a machine whose copy of that
file is missing or stale, the file you upload afterwards will be missing the
first twenty-five and the original cast goes silent. Step 2 is written to make
that impossible; do not shortcut it.

---

## 0. Before anything: prove the config loads

No database, no secrets, nothing installed but node.

```bash
cd tools/ambient
npm install
npm test                       # the config loader, the guardrails, the roster itself
```

The `personas.yaml` block of that suite is the one that matters here: it asserts
every community has a category, a tagline and a language, that no persona id is
repeated anywhere in the file (a collision would give two characters one
account), that every room can seat a scene, and that the money room bans
investment advice at the room *and* at every persona.

Then look at two of the new rooms with your own eyes, using fixture dialogue and
posting nothing:

```bash
node src/runner.js --once --canned --dry-run --force --community deu-merge
node src/runner.js --once --canned --dry-run --force --community the-away-end
```

`--force` ignores the activity windows so this works at any hour. The second one
must print **English** — that is the whole of the `language:` feature reaching
the generation prompt, and it is visible here before anything is deployed.

## 1. Build the server, once

`provision.mjs` and `seed-servers-db.mjs` import the server's own compiled
services rather than reimplementing them.

```bash
cd <repo root>
pnpm --filter @pqp/shared build && pnpm --filter @pqp/server build
```

## 2. Restore the existing tokens file, THEN provision

`provision.mjs` is idempotent by label and **merges** rather than overwrites:
it reads whatever is already in the output file, keeps every entry, skips any
persona whose `character_accounts` row already exists (counted as "already
provisioned", not rotated), and only appends the ones it actually mints. A
second run over the full config therefore adds the fifty-one new characters and
leaves the twenty-five original tokens untouched — **provided the file it reads
is the real one.**

So put the real one back first, from the secret that is already deployed:

```bash
cd tools/ambient
mkdir -p secrets

# The live tokens, straight out of the Fly secret they were uploaded as.
fly ssh console -a pqp-ambient -C 'cat /secrets/characters.json' > secrets/characters.json
chmod 600 secrets/characters.json

# Sanity: 25 entries, and the ones you remember are in there.
node -e 'const t=require("./secrets/characters.json").characters; console.log(Object.keys(t).length, "tokens"); console.log(["cacau","kzin","prof-elias"].map(k=>k+"="+!!t[k]).join(" "))'
```

If that file cannot be recovered, **stop**. The recovery is
`node scripts/provision.mjs --rotate all`, which mints a fresh token for all 76
and requires a redeploy; it is a fine outcome, but it is a decision, not a step.

Now the dry run, which mints nothing:

```bash
DATABASE_URL='postgres://…' node scripts/provision.mjs --config personas.yaml --dry-run
```

Expect **25 already provisioned** and **51 would mint**. Any line beginning
`!` ("account exists but no token here") means step 2's restore did not work —
go back and fix it rather than continuing.

Then do it:

```bash
DATABASE_URL='postgres://…' node scripts/provision.mjs --config personas.yaml
```

It prints `51 minted, 0 rotated, 25 already provisioned.` and rewrites
`secrets/characters.json` with all 76. Verify before moving on:

```bash
node -e 'console.log(Object.keys(require("./secrets/characters.json").characters).length)'   # 76
DATABASE_URL='postgres://…' node scripts/provision.mjs --list | tail -5
```

Batching is supported if you would rather do it in pieces —
`--only bruno-cetico,vivi-ship,tonho` — and each batch merges into the same file.

## 3. Create the ten servers

`seed-servers-db.mjs` needs only `DATABASE_URL` (the API-based sibling needs a
Clerk session token, which expires in sixty seconds and will not survive fifteen
servers). It is find-or-create by name under the owner, so re-running it
completes rather than clones.

```bash
DATABASE_URL='postgres://…' node scripts/seed-servers-db.mjs \
  --config personas.yaml --owner-tag 'raf#8683' \
  --community deu-merge,deploy-na-sexta,the-away-end
```

`--community` now takes a comma-separated list, so do the ten in two or three
batches and read the output between them. Each community prints its channels,
its cast size, and a loud `!` line if any persona has no character account —
which is the symptom of a skipped step 2 and is much easier to fix now than as
a room whose scheduler picks a persona that cannot speak.

Then the rest, and the five for good measure (idempotent — it will say
`server exists` and re-apply the channel topics):

```bash
DATABASE_URL='postgres://…' node scripts/seed-servers-db.mjs \
  --config personas.yaml --owner-tag 'raf#8683'
```

This rewrites `tools/ambient/state/servers.json` with all fifteen placements.
That file is a matched pair with `personas.yaml` and is baked into the runner's
image — it must be regenerated **before** the deploy in step 6, never after.

## 4. List them in the directory

Listing is the public act and it is deliberately a separate command. The
category, tagline and language now come from `personas.yaml` — the hardcoded map
that used to live in this script is gone, so there is nothing to edit here.

```bash
DATABASE_URL='postgres://…' node scripts/opt-in-communities.mjs --dry-run
```

Read all fifteen lines. Check the categories are the shelf you meant and that
`the-away-end` is the only `en`. Then:

```bash
DATABASE_URL='postgres://…' node scripts/opt-in-communities.mjs
```

It sets `is_community`, `community_category`, `community_tagline` and
`community_language` in one UPDATE per room, and prints
`15 listed, 0 skipped.` A `skip … not in state/servers.json` means step 3 was
not run for that key; a `skip … no category` means the config entry is missing
one and nothing was written for it.

The directory itself still needs `COMMUNITIES_ENABLED=true` on the API. If it is
not set, everything above is inert — the rows are correct and no route reads
them. That is a separate, deliberate decision; see `docs/CONTENT_SAFETY.md`
§Communities.

## 5. Update the tokens secret

This is the merge, and it is one command because step 2 already did the merging
on disk: `secrets/characters.json` now holds all 76.

```bash
cd <repo root>
fly secrets set \
  AMBIENT_CHARACTER_TOKENS="$(base64 < tools/ambient/secrets/characters.json)" \
  -a pqp-ambient
```

Setting a secret restarts the machine, which is also how the runner picks up the
new file — there is no reload path and there does not need to be.

Back up `secrets/characters.json` wherever you keep the current one. It is
gitignored, it is mode 0600, and it is still the only copy.

## 6. Deploy the runner

```bash
fly deploy --config tools/ambient/fly.toml --dockerfile tools/ambient/Dockerfile --ha=false
fly machines list -a pqp-ambient          # must be exactly one
fly logs -a pqp-ambient
```

The first log line is `runner.start` and it names every community and the total
persona count. Expect `communities=[…15 keys…] personas=76 identity=character`.
`identity=dev` there means the tokens file did not mount and every character is
about to try the dev bypass — stop and fix step 5.

## 7. Watch the money and the rooms

Fifteen communities is three times the traffic the cost estimate in
`docs/ambient-deploy.md` was written for. The runner logs `costUsd` per scene
and a running total on shutdown; check the first day against the ~$4/month
figure and scale the expectation, or shard with `--community` across two
machines if the per-machine ceiling starts to bind.

The rooms worth reading first are the two with the tightest guardrails:
`fim-do-mes`, where every persona carries its own ban list because a money room
is one question away from financial advice, and `falta-uma-serie`, where the
whole nutrition and pharmacology vocabulary is banned at the room. A
`line.dropped reason=banned-topic:…` in the log is the system working; a scene
that reaches the channel and gives advice is not, and the kill switch is
`fly secrets set AMBIENT_KILL_SWITCH=1 -a pqp-ambient`.

---

## Rollback

Nothing here is destructive, and the three levers are independent:

| To undo | Command |
|---|---|
| Stop the new rooms talking | `fly secrets set AMBIENT_KILL_SWITCH=1 -a pqp-ambient` (stops **all** of them) |
| Unlist one room | `UPDATE servers SET is_community = false WHERE id = '…';` |
| Unlist one room as the operator | `UPDATE servers SET is_community_suspended = true WHERE id = '…';` — outranks the owner |
| Silence one character | `node scripts/provision.mjs --revoke <id>` |

Deleting the servers is not on this list on purpose. Unlisting is reversible in
a second and takes the room out of every read path; deleting a room full of
messages is not the same class of act.
