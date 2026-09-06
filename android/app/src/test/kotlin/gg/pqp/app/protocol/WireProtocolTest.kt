package gg.pqp.app.protocol

import gg.pqp.app.core.DevTokenProvider
import gg.pqp.app.core.VoiceLeaveBeacon
import gg.pqp.app.core.VoiceSessionRequest
import gg.pqp.app.core.VoiceSessionResponse
import kotlinx.serialization.descriptors.elementNames
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
            // voice
            "welcome",
            "peer-joined",
            "peer-left",
            "voice-roster",
            "voice-room-full",
            "voice-transport-unsupported",
            "offer",
            "answer",
            "ice-candidate",
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
            listOf("text", "voice", "category"),
            RepoSources.enumValues(api, "channelTypeSchema"),
        )
        assertTrue(
            RepoSources.enumValues(api, "channelKindSchema").contains("server"),
        )
    }
}
