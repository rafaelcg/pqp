# M6 rehearsal: two API machines on staging (2026-09-13)

Milestone M6 of [`docs/plans/MULTI_INSTANCE_VOICE.md`](./MULTI_INSTANCE_VOICE.md), step 1: rehearse two `pqp-api-staging` machines per `docs/STAGING.md` §"Rehearsing two machines", with `LIVEKIT_*` set. **Production `pqp-api` was never touched.**

Starting state: `pqp-api-staging` was already running with `CLUSTER_BUS=postgres`, `VOICE_REGISTRY=postgres` and `LIVEKIT_*` (pointed at the self-hosted box, `216-238-108-42.sslip.io`) — all three predate this rehearsal (in place since at least 2026-09-08 per `CLAUDE.md` pitfall history). `fly secrets list -a pqp-api-staging` confirmed the names; no values were printed. `GET /ready` before the rehearsal: `{"ok":true,"checks":{"postgres":{"ok":true},"pool":{"ok":true},"livekit":{"ok":true,"host":"216-238-108-42.sslip.io"},"storage":{"ok":true},"liveHls":{"ok":true}}}`. One machine (`7811d002a0d648`, `young-brook-8027`).

So this rehearsal tested exactly what M6 asks: **adding a second machine** on top of flags that were already proven safe on one. It did not test turning the bus/registry/SFU on for the first time.

## How the two-user checks were actually driven

`docs/STAGING.md` describes two Clerk browser profiles and DevTools. This run used the load-test auth path instead (`LOAD_TEST_TOKEN`, `server/src/auth/load-test.ts`) with two throwaway identities, each request/socket pinned to a specific machine with Fly's `fly-force-instance-id` header, driven by a small Node/`ws` script (not `tools/watch-party-load`, not a load test — a handful of deliberate actions per identity). This proves every **signaling and registry** mechanism precisely (welcome frames, transport pins, roster, resume, drain), but two consequences follow directly from never opening a real LiveKit media connection:

- The moderator-mute check (5.7 in the plan / step 7 of the doc) and the eviction-resweep check (5.4 / step 5.4) both act on **real LiveKit participants**, which this harness never created. Both are called out as not fully verified below.
- Everything else — pin, roster, resume, drain, cross-instance chat/watch-party fan-out — is signaling-only and was verified exactly as a real client would see it.

## Commands, in order

```bash
# 1. Starting state
fly secrets list -a pqp-api-staging      # confirmed LIVEKIT_*, CLUSTER_BUS, VOICE_REGISTRY already present
curl -s https://pqp-api-staging.fly.dev/ready | jq .
fly machines list -a pqp-api-staging     # 1 machine

# 2. Auto-stop off, min 2, from a throwaway branch (never merged)
#    (worktree .claude/worktrees/m6-toml, branch ops/m6-rehearsal-toml)
#    fly.staging.toml: auto_stop_machines "stop" -> "off", min_machines_running 0 -> 2
gh workflow run deploy-staging.yml --ref ops/m6-rehearsal-toml
gh run watch 34780168435 --exit-status   # green

# 3. Two machines
fly scale count 2 --region gru -a pqp-api-staging --yes
fly machines list -a pqp-api-staging     # young-brook-8027 (existing) + dawn-wildflower-925 (new)

# 4. Verification checks (below)

# 5. Rolling restart, one machine at a time (checks 8/9 below double as this)
fly machine restart 7811d222a4d618 -a pqp-api-staging
fly machine restart 7811d002a0d648 -a pqp-api-staging

# 6. Always: scale back, revert the config, redeploy the committed file
fly scale count 1 --region gru -a pqp-api-staging --yes   # destroyed dawn-wildflower-925
git checkout origin/main -- fly.staging.toml && git commit && git push   # on ops/m6-rehearsal-toml
gh workflow run deploy-staging.yml --ref staging          # restores the committed fly.staging.toml
fly machines list -a pqp-api-staging     # back to 1

# cleanup: load-test rows this run created
psql ... -c "DELETE FROM servers WHERE name LIKE 'M6%';"                        # 15 rows
psql ... -c "DELETE FROM users WHERE clerk_id LIKE 'load\_test\_user\_m6%';"    # 89 rows
```

`CLUSTER_BUS`, `VOICE_REGISTRY` and `LIVEKIT_*` were left exactly as found (pre-existing; not this rehearsal's to add or remove).

## Step 1: `voice.hello` self-echo and config hash (plan §9)

Both machines logged, on boot, matching `configHash=23a2ad0c5727946f`:

```
app[7811d002a0d648] [pqp] voice.registryEnabled instance=... configHash=23a2ad0c5727946f
app[7811d002a0d648] [pqp] bus.selfEcho instance=... configHash=23a2ad0c5727946f
app[7811d222a4d618] [pqp] voice.registryEnabled instance=... configHash=23a2ad0c5727946f
app[7811d222a4d618] [pqp] bus.selfEcho instance=... configHash=23a2ad0c5727946f
```

Zero `bus.selfEchoMissing`, zero `voice.configDrift` for the whole rehearsal (`grep -c` both `0`). **Pass.**

## Checks (docs/STAGING.md "Rehearsing two machines", steps 1-9)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Bus/registry alive on both, matching config | **Pass** | `bus.selfEcho` both instances, same hash; see above |
| 2 | Two sockets on two machines | **Pass** | Both identities connected with `fly-force-instance-id` pinning them to distinct machine ids |
| 3 | Chat and presence cross | **Pass** | `message-create` on A's machine produced `message-broadcast` on B's socket (other machine) |
| 4 | A LiveKit room spans the machines | **Pass** | 10-member server ("large"); B's `welcome` said `transport:"livekit"` and listed A's peer; `fly logs`: `voice.transportPinned channelId=... transport=livekit reason=large` from **both** machine ids; zero `voice-join-refused`, zero `voice.meshGuardForcedSfu` anywhere in the run |
| 5 | The counters climb | **Pass, with a caveat** | `voice.cluster.framesRelayed`/`framesReceived` were non-zero on **both** machines (10/2 and 8/1) — but the operator's local `~/.config/pqp/staging-load-test.env` copy of `ADMIN_METRICS_TOKEN` does not match the token actually deployed on `pqp-api-staging` today (an external `curl` with it got `404 Not found`, i.e. the machine-token branch rejected it, not a routing problem). Verified instead by running the same query **from inside each machine** via `fly ssh console` using the container's own `$ADMIN_METRICS_TOKEN`. No secret value was printed. **Rotate/resync the local copy** — see Blockers. |
| 6 | A small room (DM, and a small server) stays mesh across machines | **Pass** | DM call: B's `welcome` said `transport:"mesh"`. Small server (<10 members): same, plus `fly logs`: `voice.transportPinned ... transport=mesh reason=small` and `voice.meshPinAdopted` from the joining machine |
| 7 | A moderator mute holds across machines | **Not verified — see Blockers** | `POST /api/servers/:id/members/:userId/voice-mute` returned `502 "The voice server did not accept the mute. They may not be publishing audio right now."` This is the server behaving exactly as documented (`server/src/api/index.ts`: LiveKit mute calls `RoomServiceClient` against a real published track) — the harness never opened a real LiveKit media session, so there was no track to mute. Needs two real browsers/WebRTC, not signaling-only identities. |
| 8 | A resume crosses (machine A restarted) | **Pass (on a corrected rerun — see note)** | `fly machine restart 7811d222a4d618`: logs show `[shutdown] SIGINT — draining`, `ws.drainBatch batch=1 remaining=0 total=1`, `ws.drained closed=1 total=1`, all within 2s. `/health` (forced to that machine) went `200`→`503` during the drain window. The client's unforced reconnect landed and resumed with `resumed:true` and the **same peer id**; `fly logs`: `voice.resumeAdopted ... ownerAlive=false orphaned=true` from the instance that adopted it. |
| 9 | The other machine too | **Pass** | Same pattern restarting `7811d002a0d648`: drain batch, `ws.drained closed=1 total=1`, resume adopted with the same peer id on the surviving instance. |
| 10 | A real deploy | **Not run as a distinct step** | Per the task's own instructions, the rolling-restart mechanics (drain, resume) were covered by checks 8/9 via `fly machine restart` rather than a `gh workflow run deploy-staging.yml` while at two machines. The two actual `deploy-staging.yml` runs in this rehearsal (the toml-in / toml-out deploys) each happened while staging was at **one** machine, so the CI dual-version-probe / machine-count-assertion path was not exercised at count 2 here. |

**A note on check 8's first attempt.** The very first combined run (before it was split up) reported `resumed:false` on machine A's restart. That was a **test-authoring bug, not a product bug**: the combined script had A and B detour through a DM call and the small server (checks 6a/6b) *after* joining the large LiveKit room, which — correctly — evicted their large-room seats before the restart ever happened, so there was nothing live left to resume. Rerunning checks 7-9 in isolation, with A and B held continuously in the large room, produced the clean pass recorded above. Filed here because it is exactly the kind of "flag that changes the code path was not the flag the test exercised" mistake `CLAUDE.md` already tracks two of (pitfalls 9 and 12) — this one was in the rehearsal harness, not in `server/`.

## Additional checks beyond the doc's numbered list

- **5.7, watch party visible across instances.** A 3-member room, A (machine A) sent `set-watch-party` (`videoId: dQw4w9WgXcQ, status: playing, rev: 1`); B (machine B) received the matching `watch-party` frame with the same `videoId`/`rev` well inside the 8s wait. **Pass.**
- **5.4, eviction resweep runs on exactly one instance.** **Not verified.** Exercising it meaningfully needs a real LiveKit participant for `RoomServiceClient.listParticipants`/`removeParticipant` to act on; triggering `/voice-disconnect` against a signaling-only identity would only prove the `voice_resweeps` claim-table code path runs, not that eviction did anything, and confirming "exactly one claim per 5s tick" needs sustained observation across the up-to-15-minute resweep window that this rehearsal's time budget did not allow after the debugging spent on the harness's own auth bug (below). Listed as a blocker.
- **5.5, conversation rings.** Not in `docs/STAGING.md`'s ten-step list; not tested here.

## An unrelated finding worth recording: harness auth bug, not a server bug

Early runs 401'd intermittently on `GET /api/me` for the `usera`/`userb` identities. Chased for a while (added retries, suspected a Fly-proxy/`fly-force-instance-id` interaction) before finding the real cause: the harness's own identity suffix was `A`/`B` (uppercase), and `LOAD_TEST_TOKEN`'s suffix alphabet is lowercase-only (`/^[a-z0-9_-]{1,32}$/`, `server/src/auth/load-test.ts`), so `loadTestIdentity` correctly rejected it every time as a malformed suffix — indistinguishable from an ordinary 401 with the current server behavior. Fixed by lowercasing the harness's own suffixes. No server change needed; noted here only because it cost real rehearsal time and would cost anyone else the same.

## Blockers before production runs two machines

1. **Moderator mute (step 7) and eviction resweep (5.4) need a rehearsal with real LiveKit media**, not signaling-only identities — e.g., two actual browsers, or pointing `tools/watch-party-load`'s harness (which does publish real tracks) at two machines instead of one. Until one of those runs clean, "a moderator mute holds across machines" and "exactly one resweep owner" are unverified for the two-machine case specifically (both are already covered by the flag-on single-machine test suite; this is about the *second machine*).
2. **`~/.config/pqp/staging-load-test.env`'s `ADMIN_METRICS_TOKEN` is stale** relative to what's deployed on `pqp-api-staging` — rotate it (or pull the current value) so the load-test/dashboard runbooks can query `/api/admin/metrics` directly instead of needing an SSH workaround.
3. **No two-machine `deploy-staging.yml` rolling deploy was exercised end to end** (CI's dual-version probe and machine-count assertion, at count 2, on staging). The drain/resume mechanics themselves are proven via checks 8/9's direct `fly machine restart`; the CI-orchestrated path is not.
4. **Conversation rings (5.5) across instances**: not covered by `docs/STAGING.md`'s checklist and not tested here.
5. Everything above is otherwise clean: no config drift, no mesh-refused, no split room, both directions of resume, chat and watch-party fan-out both cross instances, cluster counters climb on both machines.

## Context worth flagging, found while reading `origin/main`'s `CLAUDE.md` for this task

The API/WS stack (`pqp-api`) has a decision on record (2026-09-13) to move off Fly to a Vultr box in `gru`, with Fly kept as a 30-day rollback (`docs/deploy-vultr.md`, gated on `vars.DEPLOY_TARGET`). That is unrelated to this rehearsal (staging stays on Fly here, as instructed) but is relevant to M6's own next step: if `pqp-api` production moves to Vultr before the Fly `fly scale count 2` flip happens, the registry/bus mechanism this rehearsal exercised will need the equivalent rehearsal against whatever multi-machine story Vultr ends up using, not necessarily `fly.toml`'s rolling-deploy plumbing.

---

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LptYkv7RTzV6WVQNEWNYUv
