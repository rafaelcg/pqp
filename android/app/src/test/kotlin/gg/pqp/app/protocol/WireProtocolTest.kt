package gg.pqp.app.protocol

import gg.pqp.app.core.DevTokenProvider
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

    /**
     * The handshake is the one part of the protocol with no zod schema: the
     * socket's first three frames are matched on a raw string in
     * `server/src/ws/index.ts` before any schema is involved. Pinned against
     * that file instead.
     */
    private val handshakeFrames = setOf("auth", "ready", "pong", "ping")

    private val declared: Set<String> by lazy {
        RepoSources.frameTypeLiterals(chat) +
            RepoSources.frameTypeLiterals(signaling) +
            handshakeFrames
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
     * The room transport name.
     *
     * `join-voice-room` declares `transports: ["mesh"]` so the server can
     * refuse *before* creating a peer. Spell it wrong and a mesh-only client
     * lands in a LiveKit room as somebody who can neither hear nor be heard.
     */
    @Test
    fun `the mesh transport name matches shared`() {
        val transports = RepoSources.enumValues(
            "packages/shared/src/signaling.ts",
            "voiceRoomTransportSchema",
        )
        assertTrue(
            "voiceRoomTransportSchema no longer offers \"mesh\"",
            transports.contains("mesh"),
        )
        val controller = RepoSources.androidSources.getValue("VoiceController.kt")
        assertTrue(
            "VoiceController no longer declares the mesh transport on join-voice-room",
            controller.contains("""JsonPrimitive("mesh")"""),
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
