package gg.pqp.app.voice

import gg.pqp.app.core.ApiException
import gg.pqp.app.protocol.RepoSources
import java.io.File
import java.io.IOException
import java.net.SocketTimeoutException
import javax.net.ssl.SSLHandshakeException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The four ways an SFU join fails, and the sentence each one earns.
 *
 * Every case here was previously the same sentence, "Não foi possível conectar
 * ao servidor de voz desta chamada", which is what a report of "voice does not
 * work on Android" was made of: a 403 on the token mint, a 409 saying the room
 * is peer-to-peer, a media box nothing could reach and a handshake that timed
 * out were indistinguishable from each other on the phone and left nothing on
 * the server for three of the four.
 *
 * The classification is pure precisely so it can be pinned here rather than
 * discovered on somebody's phone.
 */
class SfuJoinFailureTest {

    private fun api(status: Int, message: String? = "boom") =
        ApiException(status, message)

    // --- what the server said ---

    /**
     * THE ORDERING THAT MATTERS. `ApiException` extends `IOException`, so a
     * classification that tested `IOException` first would call every refusal
     * the server ever wrote an unreachable network, and retry all of them.
     */
    @Test
    fun `a refusal is not mistaken for a network failure`() {
        val refusal: Throwable = api(403, "Unknown or mismatched voice peer")
        assertTrue("the fixture must really be an IOException", refusal is IOException)
        assertEquals(SfuFailureKind.TokenRefused, classifySfuFailure(refusal).kind)
    }

    @Test
    fun `the token mint's refusals carry their status and the server's own sentence`() {
        val failure = classifySfuFailure(api(404, "Channel not found"))
        assertEquals(SfuFailureKind.TokenRefused, failure.kind)
        assertEquals(404, failure.status)
        assertEquals("Channel not found", failure.detail)
    }

    /**
     * 409 is `POST /api/voice/token` saying "This room runs peer-to-peer": the
     * room's pin is not visible to the instance that served the request, or the
     * room was unpinned between `welcome` and the mint. A state disagreement,
     * not a broken network, and retrying it in eight hundred milliseconds
     * changes nothing.
     */
    @Test
    fun `a 409 is the room disagreeing about its transport`() {
        val failure = classifySfuFailure(api(409, "This room runs peer-to-peer"))
        assertEquals(SfuFailureKind.TransportMismatch, failure.kind)
        assertFalse(failure.retryable)
    }

    /**
     * 502 "Voice backend unavailable" and 503 "SFU backend not configured" are
     * the server failing rather than refusing, so they read as unreachable and
     * are worth one more go.
     */
    @Test
    fun `a 5xx from the mint is unreachable and is retried`() {
        listOf(500, 502, 503).forEach { status ->
            val failure = classifySfuFailure(api(status))
            assertEquals("status $status", SfuFailureKind.Unreachable, failure.kind)
            assertTrue("status $status", failure.retryable)
        }
    }

    /**
     * The per-user write bucket is capacity 30 refilling at 2/s, so a backoff
     * clears it. The only refusal worth a second attempt.
     */
    @Test
    fun `429 is the one refusal that is retried`() {
        val failure = classifySfuFailure(api(429, "Slow down"))
        assertEquals(SfuFailureKind.TokenRefused, failure.kind)
        assertTrue(failure.retryable)
    }

    @Test
    fun `401 and 403 are not retried`() {
        assertFalse(classifySfuFailure(api(401, "Unauthorized")).retryable)
        assertFalse(classifySfuFailure(api(403, "Forbidden")).retryable)
    }

    // --- what the network or the SDK said ---

    /**
     * The shapes `Room.connect` and OkHttp actually raise on the hosted
     * deployment: a refused or timed-out signalling socket to
     * `wss://sfu.pqp.gg`, a TLS handshake that failed, and livekit-android's
     * own `ConnectException` when ICE never completes inside its 20 s ceiling
     * (modelled here as a plain exception, because the SDK type is not on the
     * unit-test classpath).
     */
    @Test
    fun `an unreachable media server is unreachable, and says what threw`() {
        val io = classifySfuFailure(SocketTimeoutException("timeout"))
        assertEquals(SfuFailureKind.Unreachable, io.kind)
        assertTrue(io.retryable)
        assertEquals("SocketTimeoutException: timeout", io.detail)

        val tls = classifySfuFailure(SSLHandshakeException("trust anchor"))
        assertEquals(SfuFailureKind.Unreachable, tls.kind)
        assertEquals("SSLHandshakeException: trust anchor", tls.detail)

        val sdk = classifySfuFailure(RuntimeException("could not establish PC connection"))
        assertEquals(SfuFailureKind.Unreachable, sdk.kind)
        assertEquals("RuntimeException: could not establish PC connection", sdk.detail)
    }

    @Test
    fun `a throwable with no message still produces a usable detail`() {
        assertEquals("IOException: no message", classifySfuFailure(IOException()).detail)
    }

    /**
     * `LiveKitEngine`'s own "No voice channel to mint an SFU token for": this
     * client lost track of the call. Nothing to retry, and nothing the network
     * did.
     */
    @Test
    fun `losing the channel is a refusal rather than a network failure`() {
        val failure = classifySfuFailure(IllegalStateException("No voice channel"))
        assertEquals(SfuFailureKind.TokenRefused, failure.kind)
        assertFalse(failure.retryable)
    }

    /**
     * The whole sequence ran past `JOIN_TIMEOUT_MS`. Its own class, and never
     * retried: the budget is spent, and a fourth attempt would be a person
     * waiting past the deadline they were already told about.
     */
    @Test
    fun `a timeout is its own class and ends the attempt`() = runBlocking {
        val thrown = runCatching {
            withTimeout(1) { kotlinx.coroutines.delay(1_000) }
        }.exceptionOrNull()
        assertTrue(thrown is TimeoutCancellationException)
        val failure = classifySfuFailure(thrown!!)
        assertEquals(SfuFailureKind.TimedOut, failure.kind)
        assertFalse(failure.retryable)
        Unit
    }

    // --- the retry schedule ---

    /**
     * Bounded, and bounded twice: by the attempt count here and by the single
     * `JOIN_TIMEOUT_MS` the engine wraps the whole sequence in. The sum of the
     * waits has to leave room for the attempts themselves inside that budget,
     * or the retry turns a 45 s failure into a 45 s failure that never tried
     * twice.
     */
    @Test
    fun `the backoff grows and then stops`() {
        assertEquals(800L, sfuRetryDelayMs(1))
        assertEquals(2_400L, sfuRetryDelayMs(2))
        assertEquals(0L, sfuRetryDelayMs(SFU_CONNECT_ATTEMPTS))
        assertEquals(0L, sfuRetryDelayMs(99))
        assertEquals(0L, sfuRetryDelayMs(0))

        val total = (1 until SFU_CONNECT_ATTEMPTS).sumOf { sfuRetryDelayMs(it) }
        assertTrue("the waits alone must not eat the join deadline", total < 5_000L)
    }

    @Test
    fun `three attempts, no more`() {
        assertEquals(3, SFU_CONNECT_ATTEMPTS)
    }

    // --- the log line ---

    /**
     * The line Rafael is asked to pull off a phone with `adb logcat`. Fixed
     * field order, fixed field count, `-` for anything absent: a line whose
     * shape moves is a line nobody can grep, and this is the only record that
     * exists for a TLS or ICE failure, which never reaches the server at all.
     */
    @Test
    fun `the log line has every field, in order, always`() {
        val full = SfuFailure(SfuFailureKind.TokenRefused, "Channel not found", 404)
            .logLine("chan-1", "peer-9", 2)
        assertEquals(
            "sfu-join-failed kind=TokenRefused status=404 attempt=2 " +
                "channel=chan-1 peer=peer-9 detail=Channel not found",
            full,
        )

        val sparse = SfuFailure(SfuFailureKind.Unreachable, "IOException: no message")
            .logLine(null, null, 1)
        assertEquals(
            "sfu-join-failed kind=Unreachable status=- attempt=1 " +
                "channel=- peer=- detail=IOException: no message",
            sparse,
        )
        val fields = Regex("""\b\w+=""")
        assertEquals(
            "a line with fewer fields is a line the grep in the PR body misses",
            fields.findAll(full).count(),
            fields.findAll(sparse).count(),
        )
    }

    // --- one sentence per class, all the way to the resource file ---

    @Test
    fun `every failure kind has its own refusal`() {
        val refusals = SfuFailureKind.entries.map(::refusalFor)
        assertEquals(
            "two failure kinds collapsed onto one refusal, which is the bug this replaced",
            refusals.size,
            refusals.toSet().size,
        )
    }

    /**
     * And every one of those refusals reaches a *different* sentence.
     *
     * Read out of `PqpApp.kt` and the two resource files rather than asserted
     * against a Kotlin copy of them, for the reason in [RepoSources]: a `when`
     * branch that quietly points two refusals at the same `stringResource` is
     * exactly the regression this change exists to prevent, and it compiles.
     */
    @Test
    fun `every SFU refusal shows a distinct sentence in both languages`() {
        val ui = RepoSources.read("android/app/src/main/kotlin/gg/pqp/app/ui/PqpApp.kt")
        val locals = Regex("""val\s+(\w+)\s*=\s*stringResource\(R\.string\.(\w+)\)""")
            .findAll(ui)
            .associate { it.groupValues[1] to it.groupValues[2] }
        val branches = Regex("""Refusal\.(\w+)\s*->\s*(\w+)""")
            .findAll(ui)
            .associate { it.groupValues[1] to it.groupValues[2] }

        val sfuRefusals = listOf(
            "VoiceBackendUnreachable",
            "VoiceTokenRefused",
            "VoiceTransportMismatch",
            "VoiceBackendTimedOut",
        )
        val keys = sfuRefusals.map { refusal ->
            val local = branches[refusal]
                ?: error("PqpApp.kt has no toast branch for Refusal.$refusal")
            locals[local] ?: error("$local is not a stringResource in PqpApp.kt")
        }
        assertEquals("two SFU refusals point at the same string", keys.size, keys.toSet().size)

        listOf(
            "android/app/src/main/res/values/strings.xml",
            "android/app/src/main/res/values-pt-rBR/strings.xml",
        ).forEach { path ->
            val text = File(RepoSources.root, path).readText()
            val sentences = keys.map { key ->
                Regex("""<string\s+name="$key">(.*?)</string>""", RegexOption.DOT_MATCHES_ALL)
                    .find(text)
                    ?.groupValues
                    ?.get(1)
                    ?: error("$path has no <string name=\"$key\">")
            }
            assertEquals("$path reuses one sentence", sentences.size, sentences.toSet().size)
        }
    }

    /**
     * The refusal for an unreachable media server must not be the one for a
     * refused token, whatever a future edit does to either.
     */
    @Test
    fun `unreachable and refused stay different refusals`() {
        assertNotEquals(
            refusalFor(SfuFailureKind.Unreachable),
            refusalFor(SfuFailureKind.TokenRefused),
        )
    }

    // --- the double report that ate every LiveKit error ---

    /**
     * THE BUG THIS CHANGE FIXES, PINNED AT THE SOURCE.
     *
     * A failing connect reports itself twice: `RTCEngine.onError` raises
     * `Room.onFailToConnect` for anything thrown while the connection state is
     * CONNECTING, which emits `RoomEvent.FailedToConnect`, and `Room.connect`
     * then throws the same failure with more in it. Both used to call `fail`,
     * `fail` is one-shot, and the collector usually won: the exception that
     * says whether the signalling socket, TLS or ICE was the problem went into
     * a `catch` that could no longer do anything with it, and a retry was
     * impossible because the call had already been left.
     *
     * A call-graph assertion read off the source, like `TransportChangeTest`'s,
     * and for the same reason: there is no JVM-testable seam here (both branch
     * bodies take a `RoomEvent` built by the SDK around a live `Room`), and the
     * whole suite would go on passing with the guard deleted.
     */
    @Test
    fun `the event collector defers to a handshake that is in flight`() {
        val engine = RepoSources.stripComments(
            RepoSources.read("android/app/src/main/kotlin/gg/pqp/app/voice/LiveKitEngine.kt"),
        )
        listOf("is RoomEvent.Disconnected ->", "is RoomEvent.FailedToConnect ->").forEach { marker ->
            val start = engine.indexOf(marker)
            assertTrue("LiveKitEngine no longer handles $marker", start >= 0)
            val rest = engine.substring(start + marker.length)
            val end = rest.indexOf("is RoomEvent.")
                .let { if (it < 0) rest.indexOf("else ->") else it }
                .let { if (it < 0) rest.length else it }
            assertTrue(
                "$marker must not report a failure while a connect attempt owns the outcome; " +
                    "it is what swallowed every LiveKit connect exception this client produced",
                rest.substring(0, end).contains("handshakesInFlight"),
            )
        }
    }
}
