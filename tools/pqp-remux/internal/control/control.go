// Package control is `pqp-remux`'s multi-session control plane: the "small
// HTTP surface a supervisor on the egress box exposes, fronting one
// pqp-remux subscriber per session" that
// packages/shared/src/hls-remux-control.ts (L1.5, PR #580) describes from
// `pqp-api`'s side. This is L1.6 (docs/plans/LL_HLS.md, section 7):
//
//  1. The control API itself: POST /sessions, DELETE /sessions/:id,
//     GET /sessions, every request HMAC-signed exactly the way
//     hls-remux-control.ts's doc comment specifies -- see signing.go, which
//     is a byte-for-byte port of remuxControlSignaturePayload's payload
//     string and REMUX_CONTROL_CLOCK_SKEW_MS's 60s window.
//  2. Per-session management: this process holds N concurrent
//     session.Session + subscriber.Session pairs in one Go process (never
//     spawns a subprocess -- registry.go, managed_session.go, pipeline.go).
//  3. The watchdog (docs/plans/LL_HLS.md §5): a stall detector faster than
//     the conventional path's, a one-restart-then-demote ladder, and the
//     keyframe-stall escalation that stops a session outright rather than
//     let a segment accumulate forever with no IDR to close it on. See
//     watchdog.go's evaluateWatchdog, which is pure (no clock, no IO) so it
//     is testable with a fake pipeline clock, per this task's own
//     acceptance bar.
//  4. One origin path shape for parts and playlists: every session's media
//     (init.mp4, playlist.m3u8, part-N.m4s, seg-N.m4s and their audio-*
//     twins) is served under /s/<sessionId>/... on the SAME listener as the
//     control routes above, so L2.3's edge Worker has one thing to proxy to
//     regardless of how many sessions are live. See server.go's
//     handleMedia.
//
// Every route in this package (control AND media) binds to CONTROL_LISTEN,
// loopback by default (127.0.0.1:8090), for the identical reason
// internal/serve's own doc comment gives for its LISTEN default: nothing
// here authenticates a *viewer* -- the HMAC signing below authenticates
// pqp-api's control calls, not a browser's playlist/part requests -- so
// pqp-api is expected to reach this box over its private network address or
// a firewalled port, never expose CONTROL_LISTEN itself to the internet.
// See the README's "Control API" section for the full deployment picture.
//
// A note on "byte-for-byte" and forward compatibility: remuxSessionInfoSchema
// in hls-remux-control.ts is a plain z.object({...}) with no .strict(),
// so pqp-api's own remuxSessionInfoSchema.parse(...) silently strips any
// JSON field this package returns that the TS schema does not name (Zod's
// documented default behaviour). SessionInfo below returns every field the
// schema requires PLUS a handful the L1.6 task description asks
// GET /sessions to report (state, demoted, audioHealth, lastIdrAgeMs) that
// the wire contract has not grown yet -- see types.go's SessionInfo doc
// comment. Today those extra fields are only useful to a human reading a
// raw GET /sessions response (or a future contract revision); nothing in
// hls-remux.ts (PR #580's client) reads them yet, and that is expected, not
// a bug in this package.
package control
