package gg.pqp.app.protocol

import gg.pqp.app.core.DevTokenProvider
import gg.pqp.app.core.RealtimeClient
import gg.pqp.app.core.VoiceLeaveBeacon
import gg.pqp.app.core.VoiceSessionRequest
import gg.pqp.app.core.VoiceSessionResponse
import kotlinx.serialization.descriptors.elementNames
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Android client against the protocol it claims to speak.
 *
 * Read `RepoSources` first for why these compare against `packages/shared`
 * rather than against constants in this module.
 */
class WireProtocolTest {

    private val chat = "packages/shared/src/chat.ts"
    private val signaling = "packages/shared/src/signaling.ts"
    private val api = "packages/shared/src/api.ts"
    private val auth = "packages/shared/src/auth.ts"
    private val wsIndex = "server/src/ws/index.ts"
    private val voiceBackend = "packages/shared/src/voice-backend.ts"
    private val apiIndex = "server/src/api/index.ts"

    /**
     * The handshake is the one part of the protocol with no zod schema: the
     * socket's first three frames are matched on a raw string in
     * `server/src/ws/index.ts` before any schema is involved. Pinned against
     * that file instead.
     */
    private val handshakeFrames = setOf("auth", "ready", "pong", "ping")

    /**
     * Every frame the shared package declares, plus the handshake.
     *
     * The whole of `packages/shared/src` and not a named pair of files: the
     * schemas get split up over time (`friend-activity` now lives in
     * `friends.ts`), and a stale filename list reports a correct handler as an
     * undeclared frame, which is a false alarm on the exact test whose value is
     * that it never cries wolf.
     */
    private val declared: Set<String> by lazy {
        RepoSources.sharedFrameTypeLiterals() + handshakeFrames
    }

    @Test
    fun `the shared schemas still declare the frames this test reasons about`() {
        // A guard on the parser, not on the protocol. If the regex ever stops
        // matching, every assertion below would pass vacuously.
        assertTrue(
            "Parsed no frame types out of $chat",
            RepoSources.frameTypeLiterals(chat).size > 5,
        )
        assertTrue(
            "Parsed no frame types out of $signaling",
            RepoSources.frameTypeLiterals(signaling).size > 5,
        )
        assertTrue(
            "server/src/ws/index.ts no longer answers a ping with a pong",
            RepoSources.read(wsIndex).contains("""type: "pong"""") &&
                RepoSources.read(wsIndex).contains("""type: "ready""""),
        )
    }

    /**
     * Every type string this client puts on the wire is a frame the server
     * declares.
     *
     * A frame the server does not recognise is dropped in silence: there is no
     * ack and no error frame, so an outbound typo is invisible at runtime
     * forever. This is the check that makes it visible at build time.
     */
    @Test
    fun `every frame the app sends exists in the shared protocol`() {
        val sent = RepoSources.frameTypesSent()
        assertTrue("Found no outbound frames in the Android sources", sent.isNotEmpty())

        val unknown = sent - declared
        assertEquals(
            "These frame types are sent by the Android client and declared nowhere in " +
                "packages/shared or server/src/ws. The server drops an unrecognised frame " +
                "silently, so this never shows up at runtime.",
            emptySet<String>(),
            unknown,
        )
    }

    /**
     * Every type string this client dispatches on is a frame the server sends.
     *
     * This is the direction that catches a **rename**. A `when` on a String
     * ignores `message-broadcastt` exactly as quietly as it ignores a frame
     * type this client has never heard of, so a renamed frame on the server
     * turns into a screen that simply stops updating.
     */
    @Test
    fun `every frame the app handles exists in the shared protocol`() {
        val handled = RepoSources.frameTypesHandled()
        assertTrue("Found no `when (… \"type\")` blocks in the Android sources", handled.isNotEmpty())

        val unknown = handled - declared
        assertEquals(
            "These frame types have a `when` branch in the Android client and are declared " +
                "nowhere in packages/shared or server/src/ws. Either the server renamed the " +
                "frame (and this branch is now dead) or the branch was a typo from the start.",
            emptySet<String>(),
            unknown,
        )
    }

    /**
     * The branches that are load-bearing, named so that deleting one fails.
     *
     * Deliberately a floor and not the whole set: this client is a subset of
     * the protocol on purpose, and `B11` in `docs/ANDROID_PLAN.md` lists the
     * frames it does not read yet. Adding one there is a feature; losing one
     * from here is a regression.
     */
    @Test
    fun `the frames the app cannot work without are still handled`() {
        val required = setOf(
            // chat
            "message-broadcast",
            "message-update",
            // Both spellings are live. `message-delete` is what the server
            // broadcasts; `message-deleted` is the older name and is still
            // relayed, so an instance on either side of that change leaves
            // deleted messages on screen if only one is handled.
            "message-delete",
            "message-deleted",
            "typing-broadcast",
            // The two refusals. Without them a message the server would not
            // land looked sent, on the phone, until the app was restarted.
            "message-rejected",
            "sanction-notice",
            // voice
            "welcome",
            "peer-joined",
            "peer-updated",
            "peer-left",
            "voice-roster",
            // The compact roster. Losing this branch does not break the call:
            // the server keeps sending whole rosters to anything that does not
            // negotiate the capability. It breaks the phone's data bill, which
            // is invisible from here, so the branch is named rather than left
            // to whoever notices.
            "voice-roster-delta",
            "voice-room-full",
            "voice-transport-unsupported",
            // The mid-call promotion. Losing this branch while `WIRE_CAPS`
            // still asks for the frame is the worst outcome in this file: the
            // server stops releasing the seat in exchange for the promise, so
            // the person stays on everybody's roster in a room whose media
            // they cannot reach. A visible drop became a silent dead call.
            "voice-transport-changed",
            // The mid-call SPEAK revoke. In a mesh room this client is the
            // only enforcement, so losing the branch is an open microphone.
            "voice-speak-changed",
            "offer",
            "answer",
            "ice-candidate",
            // the Baú's one live frame
            "community-home-update",
            // handshake
            "ready",
        )
        val handled = RepoSources.frameTypesHandled()
        assertEquals(
            "Frames the app has stopped handling",
            emptySet<String>(),
            required - handled,
        )
    }

    /**
     * Frames the server sends that this client reads on purpose and does
     * nothing with. Each entry says why, because the only acceptable reason to
     * be on this list is that acting on the frame would be wrong or pointless
     * on Android, not that nobody got to it yet.
     *
     * Kept small on purpose. Every frame here is a product gap somebody can see
     * from the web, and the test below fails the moment one of them gains a
     * branch, so the list cannot go stale in that direction either.
     */
    private val deliberatelyIgnored: Map<String, String> = mapOf(
        // Sent only in answer to a `join-voice-room` that carried a
        // `resumePeerId`, and this client never sends one: a socket drop
        // rebuilds the call from scratch (VoiceController.followConnection).
        "voice-join-refused" to "Android never resumes a peer id, so this refusal is never addressed to it",
        // Only ever answers a `set-camera`, which Android does not send.
        "camera-denied" to "Android has no camera publishing, so nothing here can be denied",
        // Who is online in the channel. Android draws no member list yet.
        "presence-update" to "no roster surface on the phone to render it in",
        // The incremental form of the same list, and opt-in: the server sends
        // it only to a client that negotiated deltas, which Android does not.
        "presence-delta" to "never negotiated, and the same missing roster surface as presence-update",
        // Threads exist on the web only; the phone has no thread view.
        "thread-update" to "no thread surface on the phone",
        // Permissions are enforced server-side and this client draws no
        // manager controls, so a version bump has nothing to invalidate.
        "permissions-update" to "no permission-gated controls on the phone to refresh",
        // Polls render as their message body; votes and closes are web only.
        "poll-update" to "no poll surface on the phone",
        // Watch party is a desktop feature by design (docs/ANDROID.md).
        "watch-party" to "no watch party on the phone",
        // The watch party EVENT: its name, host, co-hosts, state and options,
        // resolved per recipient. Same reason as the line above and as the
        // scheduling reminder below: the phone has no watch party surface at
        // all, so there is nothing for a party's state to change.
        "watch-party-update" to "no watch party surface on the phone",
        // Watch party scheduling reminder ("T-10 minutes" / "now live"), sent
        // individually per subscriber. No reminders surface on the phone yet.
        "channel-session-reminder" to "no watch party scheduling surface on the phone",
        // Coalesced emoji burst counts for a channel's live reactions. No
        // reaction-overlay surface on the phone yet.
        "live-reactions" to "no live reactions surface on the phone",
        // The two live-HLS frames. `voice-stream` is the playlist for the
        // room's current screen share; `channel-live` is the sidebar's "this
        // room is live" plus its seatless watcher count. Both are behind
        // LIVE_HLS_ENABLED, both feed a watch surface the phone does not
        // draw, and Android watches a share over WebRTC when it is in the
        // call. Neither has ever had a branch here: the entries were missing
        // rather than the frames being handled, and this test could not say
        // so because Gradle had cached `testDebugUnitTest` past every change
        // to `packages/shared`, which is not one of its declared inputs.
        "voice-stream" to "no HLS watch surface on the phone",
        "channel-live" to "no live badge or seatless watch surface on the phone",
    )

    /**
     * Every frame the server can send is either handled or on the list above.
     *
     * This is the test that was missing. The two checks above are one-way:
     * "everything handled exists" and "these named frames are still handled".
     * Neither says anything about a frame the server *started* sending, which
     * is how `message-rejected` (PR #204) and `peer-updated` (PR #189) shipped
     * with no branch on Android and no red anywhere. A `when` on a String
     * ignores a new frame exactly as quietly as a renamed one.
     */
    @Test
    fun `every frame the server sends is handled or deliberately ignored`() {
        val server = RepoSources.serverFrameTypes()
        assertTrue("Parsed too few server-to-client frames: $server", server.size > 10)
        val handled = RepoSources.frameTypesHandled()

        assertEquals(
            "The server sends these frames and the Android client has no `when` branch for " +
                "any of them. Either handle the frame or add it to `deliberatelyIgnored` with " +
                "a reason. Doing neither is how a refused message looked sent for months.",
            emptySet<String>(),
            server - handled - deliberatelyIgnored.keys,
        )
        assertEquals(
            "These frames are on the ignore list and also handled. Delete the entry.",
            emptySet<String>(),
            deliberatelyIgnored.keys.intersect(handled),
        )
        assertEquals(
            "These frames are on the ignore list and the server no longer sends them. " +
                "Delete the entry.",
            emptySet<String>(),
            deliberatelyIgnored.keys - server,
        )
    }

    /**
     * The refusal tokens. `MessageRejectReason.fromWire` returns null for a
     * token it does not know and the composer then says "failed to send", so a
     * token added on the server is not a crash, but it is a worse sentence.
     */
    @Test
    fun `the message reject reasons match shared`() {
        assertEquals(
            RepoSources.enumValues(chat, "messageRejectReasonSchema").toSet(),
            gg.pqp.app.ui.screens.MessageRejectReason.entries.map { it.wire }.toSet(),
        )
    }

    /**
     * The dev bypass token, which is a literal in two repos' worth of code and
     * a 401 with no explanation when the two disagree.
     */
    @Test
    fun `the dev bypass token matches shared`() {
        assertEquals(
            RepoSources.stringConstant(auth, "DEV_AUTH_TOKEN"),
            DevTokenProvider.DEV_AUTH_TOKEN,
        )
    }

    /**
     * The history page ceiling.
     *
     * `ApiClient.messages` clamps with `coerceIn(1, 100)` and 100 is
     * `MESSAGE_PAGE_MAX`. Asserted against the Kotlin *source* because the
     * clamp is inline; `ApiClientTest` then proves the clamp actually reaches
     * the query string, which is the half this cannot see.
     */
    @Test
    fun `the message page ceiling matches MESSAGE_PAGE_MAX`() {
        val max = RepoSources.numberConstant(api, "MESSAGE_PAGE_MAX")
        val client = RepoSources.androidSources.getValue("ApiClient.kt")
        val found = Regex("""coerceIn\(1,\s*(\d+)\)""").find(client)
            ?: error("ApiClient.kt no longer clamps the page size with coerceIn(1, …)")
        assertEquals(max, found.groupValues[1].toInt())
    }

    /**
     * The two close codes that are refusals rather than blips.
     *
     * 4401 must stop the reconnect loop (retrying a rejected credential in a
     * tight loop is how an address gets rate-limited) and 4429 must slow it
     * down. Both are hand-copied out of `server/src/ws/index.ts`.
     */
    @Test
    fun `the socket close codes match the server`() {
        val server = RepoSources.read(wsIndex)
        val serverCodes = Regex("""socket\.close\((\d{4}),""")
            .findAll(server)
            .map { it.groupValues[1].toInt() }
            .toSet()
        assertEquals(
            "server/src/ws/index.ts no longer closes with 4401 and 4429",
            setOf(4401, 4429),
            serverCodes,
        )

        val realtime = RepoSources.androidSources.getValue("RealtimeClient.kt")
        assertTrue(
            "RealtimeClient no longer knows the unauthorized close code",
            realtime.contains("CLOSE_UNAUTHORIZED = 4401"),
        )
        assertTrue(
            "RealtimeClient no longer knows the rate-limit close code",
            realtime.contains("CLOSE_RATE_LIMITED = 4429"),
        )
    }

    /**
     * The age gate is three literals, and getting one wrong strands the app on
     * a screen the server will never let it leave.
     */
    @Test
    fun `the age gate literals match shared`() {
        val states = RepoSources.enumValues(api, "ageGateStatusSchema")
        assertEquals(listOf("pending", "passed", "blocked"), states)

        val session = RepoSources.androidSources.getValue("SessionStore.kt")
        states.forEach { state ->
            if (state == "pending") return@forEach // reached as the `else` branch, deliberately
            assertTrue(
                "SessionStore no longer mentions the age-gate state \"$state\"",
                session.contains("\"$state\""),
            )
        }
    }

    /**
     * The room transport names, both of them.
     *
     * `join-voice-room` declares what this client can run so the server can
     * refuse *before* creating a peer. Spell one wrong and it is dropped from
     * the declaration silently, which is not a refusal but the opposite of one:
     * **the server reads an absent or short `transports` array as permission
     * for the transports it does not see named, and an absent field entirely as
     * "both"**. Either way somebody lands in a room they cannot hear.
     *
     * Both literals are asserted, in both directions, for that reason: the
     * schema still has to offer them, and the client still has to name them.
     */
    @Test
    fun `the room transport names match shared`() {
        val transports = RepoSources.enumValues(
            "packages/shared/src/signaling.ts",
            "voiceRoomTransportSchema",
        )
        val controller = RepoSources.androidSources.getValue("VoiceController.kt")

        listOf("mesh", "livekit").forEach { transport ->
            assertTrue(
                "voiceRoomTransportSchema no longer offers \"$transport\"",
                transports.contains(transport),
            )
            assertTrue(
                "VoiceController no longer declares the \"$transport\" transport on " +
                    "join-voice-room. The server treats a transport this client does not " +
                    "name as one it cannot run, so dropping it here silently locks Android " +
                    "out of every room the server puts on it.",
                controller.contains("""JsonPrimitive("$transport")"""),
            )
        }

        // The other half of the same fact: `welcome` states the room's
        // transport and `voiceTransportKindFor` is the only thing that reads
        // it. A literal that drifts out of step there refuses a room this
        // client can perfectly well run.
        val kinds = RepoSources.androidSources.getValue("VoiceTransport.kt")
        assertTrue(
            "voiceTransportKindFor no longer recognises the \"livekit\" transport",
            kinds.contains(""""livekit" -> VoiceTransportKind.LiveKit"""),
        )
    }

    /**
     * The promotion frame, field for field and reason for reason.
     *
     * `VoiceController.onTransportChanged` reads four keys off this frame by
     * name, out of an undecoded `JsonObject`. A renamed key does not fail to
     * compile and does not throw: it reads as null, and the plan quietly
     * declines to move. Since the server has already stopped releasing this
     * seat, declining is a seat on the roster with no media behind it.
     *
     * The reasons are only the sentence, so a new one is not a failure. It is
     * checked anyway because `promotionNoticeFor` has an `else` branch, and an
     * `else` is exactly what makes a new reason invisible.
     */
    @Test
    fun `the promotion frame matches shared`() {
        val keys = RepoSources.objectKeys(signaling, "voiceTransportChangedMessageSchema")
        listOf("type", "voiceChannelId", "transport", "reason", "participants").forEach { key ->
            assertTrue(
                "voiceTransportChangedMessageSchema no longer carries \"$key\". " +
                    "VoiceController.onTransportChanged reads it by name off a raw JsonObject, " +
                    "so a rename reads as null and the promotion is silently not followed.",
                keys.contains(key),
            )
        }

        // Parsed out of the schema's inline `z.enum([...])` rather than a
        // named const, so the reason list is read where it actually lives.
        val reasons = Regex("""reason:\s*z\.enum\(\[([^\]]*)]""")
            .find(RepoSources.stripComments(RepoSources.read(signaling)))
            ?.groupValues
            ?.get(1)
            ?.let { Regex(""""([^"]+)"""").findAll(it).map { m -> m.groupValues[1] }.toSet() }
            ?: emptySet()

        assertEquals(
            "The promotion reasons changed. `promotionNoticeFor` in TransportChange.kt maps " +
                "them onto three sentences and falls back to \"the room grew\", which stays " +
                "true of any new reason. Check the fallback still reads right, then update " +
                "this list.",
            setOf("cameras", "screens", "room-full", "room-size", "stale-pin"),
            reasons,
        )
    }

    /**
     * THE CAPABILITIES THIS BUILD ASKS FOR, against the places that answer.
     *
     * Both are opt-in per socket and both fail in silence when the string is
     * wrong. `voice-roster-delta` fails cheaply: the server keeps sending
     * whole rosters, the app works, and the phone quietly pays for ~99 kB
     * frames it does not need. `voice-transport-changed` fails *expensively*
     * in the other direction: the server stops releasing the seat of a socket
     * that declared it, so a build whose string is right but whose handler is
     * missing leaves the person on everybody's roster in a room whose media
     * they cannot reach.
     *
     * That is CLAUDE.md pitfall 9 in both directions, so the strings are
     * pinned against every other copy rather than trusted. Four hand-copies of
     * each literal: `@pqp/shared`'s schema, the server's `SOCKET_CAPS`, the
     * web client's `WIRE_CAPS`, and this app's. Three of them are read off
     * disk here.
     *
     * Exact equality on the list, not `contains`, so adding an entry without
     * its handler fails here and has to be argued for in the diff.
     */
    @Test
    fun `the capabilities this build negotiates match the server and the web client`() {
        val caps = listOf("voice-roster-delta", "voice-transport-changed")

        for (cap in caps) {
            assertTrue(
                "$signaling no longer declares the $cap frame, so this app is negotiating " +
                    "a capability that does not exist any more.",
                RepoSources.frameTypeLiterals(signaling).contains(cap),
            )
            assertTrue(
                "server/src/ws/sockets.ts no longer names \"$cap\" in SOCKET_CAPS. The server " +
                    "matches this string exactly, and a rename there is silent on both sides.",
                RepoSources.read("server/src/ws/sockets.ts").contains("\"$cap\""),
            )
            assertTrue(
                "client/src/lib/realtime.ts no longer declares \"$cap\". The two clients must " +
                    "ask for the same string; a phone left behind is a phone paying for frames " +
                    "the browser stopped receiving, or sitting in a call it cannot hear.",
                RepoSources.read("client/src/lib/realtime.ts").contains("\"$cap\""),
            )
        }

        assertTrue(
            "server/src/ws/index.ts no longer reads `caps` off the auth frame, so nothing " +
                "this handshake declares is heard at all.",
            RepoSources.stripComments(RepoSources.read(wsIndex)).contains("caps"),
        )

        assertEquals(
            "RealtimeClient.WIRE_CAPS is the promise this build makes about which frames " +
                "it can apply. Add an entry only alongside its handler.",
            caps,
            RealtimeClient.WIRE_CAPS,
        )
    }

    /**
     * The promise and the handler, tied together in the direction that hurts.
     *
     * `voice-transport-changed` is the one capability whose absent handler is
     * worse than never having asked, because the server withholds the
     * `voice-transport-unsupported` release in exchange for the declaration.
     * The test above pins the string; this one pins that the branch it
     * promises exists and still does the two things the promise is made of.
     *
     * WHAT THIS CANNOT PROVE, said here rather than left to be discovered.
     * No JVM test can show that media actually moves: `LiveKitEngine` needs a
     * `Context`, a token from the API and a real SFU. So the honest shape of
     * this check is a call-graph assertion, and it has a hole: a handler that
     * kept both calls but returned before reaching them would still pass. It
     * catches the two regressions that actually happen, deleting the branch
     * and stubbing it out, and it does not catch a deliberate adversary. The
     * device-level verification this stands in for is in `docs/ANDROID.md`,
     * "A room promoted mid-call is followed".
     */
    @Test
    fun `declaring the promotion capability means the frame is handled`() {
        val cap = "voice-transport-changed"
        if (!RealtimeClient.WIRE_CAPS.contains(cap)) return
        assertTrue(
            "RealtimeClient.WIRE_CAPS declares \"$cap\" and no Android source has a `when` " +
                "branch for it. The server answers that declaration by NOT releasing this " +
                "seat when a room is promoted, so the call becomes a seat on the roster with " +
                "no media behind it: silent, and invisible from every screen.",
            RepoSources.frameTypesHandled().contains(cap),
        )

        val controller = RepoSources.androidSources.getValue("VoiceController.kt")
        assertTrue(
            "VoiceController has a branch for \"$cap\" that never consults " +
                "`transportChangePlan`. Every rule about which promotions to follow lives " +
                "there and is tested in TransportChangeTest; a branch that skips it is a " +
                "branch with no rules.",
            controller.contains("transportChangePlan("),
        )
        assertTrue(
            "VoiceController handles \"$cap\" without calling `swapTransport(plan.transport)`. " +
                "That call IS the move: it disposes the mesh engine and builds the LiveKit " +
                "one. Without it this build declares it will follow a promotion, the server " +
                "keeps its seat instead of releasing it, and the person sits in a room whose " +
                "media they cannot reach.",
            controller.contains("swapTransport(plan.transport)"),
        )
        assertTrue(
            "VoiceController handles \"$cap\" without starting the new engine against the " +
                "peer id it already had. A promotion is not a rejoin: the seat, the peer id " +
                "and the roster entry are kept, and `engine.start(plan.peerId` is what keeps " +
                "them.",
            controller.contains("engine.start(plan.peerId"),
        )
    }

    /**
     * And the handshake actually carries them.
     *
     * Separate from the test above on purpose. A correct `WIRE_CAPS` that
     * never reaches `onOpen` is the same outcome as no capability at all, and
     * neither the app nor the server would say a word about it.
     */
    @Test
    fun `the auth frame declares the capabilities this build can apply`() {
        val frame = RealtimeClient.authFrame("token-123")

        assertEquals("auth", frame["type"]?.jsonPrimitive?.content)
        assertEquals("token-123", frame["token"]?.jsonPrimitive?.content)
        assertEquals(
            "The auth frame must declare exactly RealtimeClient.WIRE_CAPS",
            RealtimeClient.WIRE_CAPS,
            frame["caps"]?.jsonArray?.map { it.jsonPrimitive.content },
        )
    }

    /**
     * `POST /api/voice/token`, field for field.
     *
     * This is the one request in the voice path with no frame schema behind it
     * and no runtime symptom when it is wrong: the server parses the body with
     * zod, so a renamed request field is a 400 the moment somebody joins an SFU
     * room, and a renamed *response* field decodes to a Kotlin default: an
     * empty `url` and an empty `token`, which present as the SFU being
     * unreachable rather than as a protocol mismatch.
     *
     * Exact equality in both directions, unlike [ModelShapeTest]'s
     * subset check, because these two objects are small and total: the client
     * needs every field the server sends and sends every field it needs.
     */
    @Test
    fun `the voice session request and response match shared`() {
        assertEquals(
            "voiceSessionRequestSchema in $voiceBackend and VoiceSessionRequest disagree",
            RepoSources.objectKeys(voiceBackend, "voiceSessionRequestSchema").toSet(),
            VoiceSessionRequest.serializer().descriptor.elementNames.toSet(),
        )
        assertEquals(
            "voiceSessionSchema in $voiceBackend and VoiceSessionResponse disagree",
            RepoSources.objectKeys(voiceBackend, "voiceSessionSchema").toSet(),
            VoiceSessionResponse.serializer().descriptor.elementNames.toSet(),
        )
        // `backend` is an enum nested inside the object rather than a named
        // schema, so it is read straight out of the text. It is the value
        // `LiveKitEngine` is the implementation of; a second one appearing here
        // means a backend this client would connect to and not understand.
        val backends = Regex("""backend:\s*z\.enum\(\[([^\]]*)]""")
            .find(RepoSources.stripComments(RepoSources.read(voiceBackend)))
            ?.let { match ->
                Regex(""""([^"]+)"""").findAll(match.groupValues[1])
                    .map { it.groupValues[1] }
                    .toList()
            }
            ?: error("voiceSessionSchema no longer declares a backend enum")
        assertEquals(listOf("livekit"), backends)
    }

    /**
     * The leave beacon, which the server matches by hand.
     *
     * `handleVoiceLeaveBeacon` runs *before* auth resolution and reads the body
     * with `typeof body.resumePeerId === "string"` rather than with a schema.
     * There is no zod object to compare against and no error to observe: a
     * misspelled field is a 204 that does nothing, and the ghost it leaves in
     * everybody else's roster is the only symptom.
     */
    @Test
    fun `the voice leave beacon fields match the server`() {
        val server = RepoSources.read(apiIndex)
        VoiceLeaveBeacon.serializer().descriptor.elementNames.forEach { field ->
            assertTrue(
                "server/src/api/index.ts no longer reads \"$field\" off the leave beacon body",
                server.contains("body.$field"),
            )
        }
        assertTrue(
            "The server no longer serves POST /api/voice/leave",
            server.contains("\"/api/voice/leave\""),
        )
    }

    /**
     * The two channel enums, which are different fields with overlapping-
     * looking values. `kind` is what the row *is*; `type` is what it carries.
     */
    @Test
    fun `the channel enums match shared`() {
        assertEquals(
            listOf("text", "voice", "category", "watch_party"),
            RepoSources.enumValues(api, "channelTypeSchema"),
        )
        assertTrue(
            RepoSources.enumValues(api, "channelKindSchema").contains("server"),
        )
    }
}
