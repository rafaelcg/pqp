package gg.pqp.app.core

import java.io.IOException
import java.net.UnknownHostException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The connection check's verdicts, its report, and the runner itself.
 *
 * The verdict mapping is what the support case turns on: five answers in, one
 * sentence out, and that sentence has to name the right fix for each shape of
 * failure or the whole thing is a slower spinner. Each shape below is the one
 * a real network produces, and the expected advice is the web's
 * (`client/src/lib/connection-doctor.ts`, `adviseFrom`), because a person
 * with the PC app and the phone app on the same bad network must be told the
 * same thing by both.
 *
 * The runner is exercised with a fake of each thing it touches. HTTP goes
 * through an OkHttp interceptor rather than `ApiClientTest`'s JDK server,
 * because the only fact under test here is "did the call answer or throw",
 * and an interceptor can throw an `UnknownHostException` on demand, which a
 * real socket cannot be made to do reliably.
 */
class ConnectionDoctorTest {

    private fun ok(id: CheckId, detail: String = "ok") = CheckResult(id, CheckVerdict.Ok, detail, 12)
    private fun fail(id: CheckId, detail: String = "fail") = CheckResult(id, CheckVerdict.Fail, detail, 34)
    private fun skip(id: CheckId, detail: String = "skip") = CheckResult(id, CheckVerdict.Skip, detail, 0)

    private fun allOk() = listOf(
        ok(CheckId.Api, "HTTP 200"),
        ok(CheckId.Token, "present"),
        ok(CheckId.Socket, "ready"),
        ok(CheckId.Stun, "host=true srflx=true"),
        ok(CheckId.Turn, "relay=true"),
    )

    private fun with(vararg overrides: CheckResult): List<CheckResult> {
        val by = overrides.associateBy { it.id }
        return allOk().map { by[it.id] ?: it }
    }

    // --- the verdict mapping, one failure shape at a time ---

    @Test
    fun `everything answering is no advice`() {
        assertEquals(Advice.None, ConnectionDoctor.adviseFrom(allOk(), unauthorizedStreak = 0))
    }

    @Test
    fun `an unreachable API is the first thing to say, whatever else failed`() {
        val results = with(
            fail(CheckId.Api, "UnknownHostException"),
            fail(CheckId.Token, "timeout"),
            fail(CheckId.Socket, "reconnecting"),
            fail(CheckId.Stun),
            fail(CheckId.Turn),
        )
        assertEquals(Advice.ApiUnreachable, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 5))
    }

    @Test
    fun `a token that never arrives is a blocked sign-in service`() {
        val results = with(fail(CheckId.Token, "timeout"), fail(CheckId.Socket, "refused"))
        assertEquals(Advice.TokenStuck, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 0))
    }

    @Test
    fun `a token that comes back null is a session that needs signing in again`() {
        val results = with(fail(CheckId.Token, "null"), fail(CheckId.Socket, "refused"))
        assertEquals(Advice.SignInAgain, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 0))
    }

    @Test
    fun `a dead socket with a token is a blocked socket`() {
        val results = with(fail(CheckId.Socket, "reconnecting (last close 1006)"))
        assertEquals(Advice.SocketBlocked, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 0))
        assertEquals(Advice.SocketBlocked, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 1))
    }

    /**
     * The 4401 rule. One refusal is a stale token and the socket is about to
     * try again; two in a row is a session the server will not have back, and
     * "try another network" would be the wrong advice.
     */
    @Test
    fun `a socket refused twice in a row is a session that needs signing in again`() {
        val results = with(fail(CheckId.Socket, "refused (last close 4401 Unauthorized)"))
        assertEquals(
            Advice.SignInAgain,
            ConnectionDoctor.adviseFrom(results, unauthorizedStreak = RealtimeClient.REFUSED_FOR_GOOD),
        )
    }

    @Test
    fun `no relay candidate is a blocked relay`() {
        val results = with(fail(CheckId.Turn, "relay=false"))
        assertEquals(Advice.RelayBlocked, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 0))
    }

    @Test
    fun `no STUN candidate and no relay is a network with no UDP`() {
        val results = with(fail(CheckId.Stun, "host=true srflx=false"), fail(CheckId.Turn, "relay=false"))
        assertEquals(Advice.NoUdp, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 0))
    }

    /**
     * STUN alone failing is not advice on its own: some networks answer TURN
     * over TCP 443 and nothing else, and a call works there. The web draws the
     * same line.
     */
    @Test
    fun `no STUN candidate with a working relay is still fine`() {
        val results = with(fail(CheckId.Stun, "host=true srflx=false"))
        assertEquals(Advice.None, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 0))
    }

    @Test
    fun `skipped ICE checks are not failures`() {
        val results = with(skip(CheckId.Stun, "no WebRTC"), skip(CheckId.Turn, "no relay configured"))
        assertEquals(Advice.None, ConnectionDoctor.adviseFrom(results, unauthorizedStreak = 0))
    }

    // --- the report ---

    /**
     * The shape the web's `formatReport` produces, so a support reply that
     * reads one can read the other: a header, one line per check with a
     * fixed-width verdict and id, the advice, and the platform.
     */
    @Test
    fun `the report is plain text in the web's shape`() {
        val report = DoctorReport(
            results = with(
                fail(CheckId.Socket, "reconnecting (last close 4401 Unauthorized)"),
                skip(CheckId.Turn, "no relay configured"),
            ),
            advice = Advice.SignInAgain,
            at = "2026-09-02T18:00:00.000Z",
        )
        val text = ConnectionDoctor.formatReport(report, "android 1.2.3", "Android 15 Google Pixel 8")
        val lines = text.split("\n")
        assertEquals(
            listOf(
                "pqp connection check 2026-09-02T18:00:00.000Z (android 1.2.3)",
                "OK  api    HTTP 200 12ms",
                "OK  token  present 12ms",
                "FAIL socket reconnecting (last close 4401 Unauthorized) 34ms",
                "OK  stun   host=true srflx=true 12ms",
                "SKIP turn   no relay configured",
                "advice: signInAgain",
                "Android 15 Google Pixel 8",
            ),
            lines,
        )
        assertFalse("A report is plain text, not markup", text.contains("<"))
    }

    @Test
    fun `an empty platform line is left out rather than left blank`() {
        val report = DoctorReport(allOk(), Advice.None, "2026-09-02T18:00:00.000Z")
        val text = ConnectionDoctor.formatReport(report, "android 1.2.3", "")
        assertFalse(text.endsWith("\n"))
        assertEquals("advice: none", text.split("\n").last())
    }

    // --- the runner, with a fake of everything it touches ---

    private fun http(handler: (Interceptor.Chain) -> Response) =
        OkHttpClient.Builder().addInterceptor { chain -> handler(chain) }.build()

    private fun answering(status: Int) = http { chain ->
        Response.Builder()
            .request(chain.request())
            .protocol(Protocol.HTTP_1_1)
            .code(status)
            .message("")
            .body("{}".toResponseBody())
            .build()
    }

    private fun prober(srflx: Boolean, relay: Boolean) = IceProber { _, relayOnly, _ ->
        if (relayOnly) IceProbeResult(host = false, srflx = false, relay = relay) else IceProbeResult(host = true, srflx = srflx, relay = false)
    }

    private val stunAndTurn = listOf(
        IceServer(JsonPrimitive("stun:stun.example:3478")),
        IceServer(JsonPrimitive("turn:turn.example:3478"), username = "u", credential = "secret-credential"),
    )

    private fun checks(
        http: OkHttpClient = answering(200),
        tokens: TokenProvider = TokenProvider { "a.session.token" },
        socket: SocketSnapshot = SocketSnapshot(RealtimeState.Ready, null, 0),
        iceServers: List<IceServer> = stunAndTurn,
        prober: IceProber? = prober(srflx = true, relay = true),
        stepTimeoutMs: Long = 200,
    ) = ConnectionChecks(
        http = http,
        apiUrl = "http://127.0.0.1:1",
        tokens = tokens,
        socket = { socket },
        iceServers = { iceServers },
        prober = prober,
        stepTimeoutMs = stepTimeoutMs,
    )

    @Test
    fun `a healthy client gets five OKs and no advice, in order, as they land`() = runTest {
        val landed = mutableListOf<CheckId>()
        val report = checks().run { landed += it.id }
        assertEquals(CheckId.entries.toList(), landed)
        assertEquals(CheckId.entries.toList(), report.results.map { it.id })
        assertTrue(report.results.all { it.verdict == CheckVerdict.Ok })
        assertEquals("HTTP 200", report.results[0].detail)
        assertEquals(Advice.None, report.advice)
    }

    /**
     * A 503 is the API saying its database is down. That is reachable, and
     * the code in the report is the useful fact; "cannot be reached" would
     * send somebody off to check their wifi.
     */
    @Test
    fun `any HTTP answer counts as reachable`() = runTest {
        val report = checks(http = answering(503)).run()
        assertEquals(CheckVerdict.Ok, report.results[0].verdict)
        assertEquals("HTTP 503", report.results[0].detail)
    }

    @Test
    fun `a host that does not resolve is an unreachable API`() = runTest {
        val report = checks(http = http { throw UnknownHostException("api.pqp.gg") }).run()
        val api = report.results.first { it.id == CheckId.Api }
        assertEquals(CheckVerdict.Fail, api.verdict)
        assertEquals("UnknownHostException", api.detail)
        assertEquals(Advice.ApiUnreachable, report.advice)
    }

    @Test
    fun `a token provider that never answers is reported as a timeout`() = runTest {
        val report = checks(tokens = TokenProvider { awaitCancellation() }).run()
        val token = report.results.first { it.id == CheckId.Token }
        assertEquals(CheckVerdict.Fail, token.verdict)
        assertEquals("timeout", token.detail)
        assertEquals(Advice.TokenStuck, report.advice)
    }

    /**
     * With no token the ICE list cannot be fetched (the route needs one), so
     * STUN falls back to a public server and TURN is skipped and says why.
     */
    @Test
    fun `no token skips the relay check rather than blaming the network`() = runTest {
        var probed: List<IceServer>? = null
        val prober = IceProber { servers, relayOnly, _ ->
            if (!relayOnly) probed = servers
            IceProbeResult(host = true, srflx = true, relay = false)
        }
        val report = checks(tokens = TokenProvider { null }, prober = prober).run()
        val turn = report.results.first { it.id == CheckId.Turn }
        assertEquals(CheckVerdict.Skip, turn.verdict)
        assertEquals("no token", turn.detail)
        assertEquals(listOf(ConnectionDoctor.FALLBACK_STUN), probed?.flatMap { it.urlList })
        assertEquals(Advice.SignInAgain, report.advice)
    }

    @Test
    fun `a socket that is not ready carries its last close code into the report`() = runTest {
        val snapshot = SocketSnapshot(
            state = RealtimeState.Refused,
            lastClose = RealtimeClose(4401, "Unauthorized", 0),
            unauthorizedStreak = 2,
        )
        val report = checks(socket = snapshot).run()
        val socket = report.results.first { it.id == CheckId.Socket }
        assertEquals(CheckVerdict.Fail, socket.verdict)
        assertEquals("refused (last close 4401 Unauthorized)", socket.detail)
        assertEquals(Advice.SignInAgain, report.advice)
    }

    @Test
    fun `no relay candidate is a blocked relay and no STUN either is no UDP`() = runTest {
        val relayOnly = checks(prober = prober(srflx = true, relay = false)).run()
        assertEquals(Advice.RelayBlocked, relayOnly.advice)
        assertEquals("relay=false", relayOnly.results.first { it.id == CheckId.Turn }.detail)

        val nothing = checks(prober = prober(srflx = false, relay = false)).run()
        assertEquals(Advice.NoUdp, nothing.advice)
    }

    @Test
    fun `a build with no WebRTC skips both ICE checks`() = runTest {
        val report = checks(prober = null).run()
        assertEquals(CheckVerdict.Skip, report.results.first { it.id == CheckId.Stun }.verdict)
        assertEquals(CheckVerdict.Skip, report.results.first { it.id == CheckId.Turn }.verdict)
        assertEquals(Advice.None, report.advice)
    }

    /**
     * The report gets pasted into a public channel. The token value, the
     * relay credential and the API address must not be in it: the details
     * are fixed words ("present", "null", "timeout"), never the thing itself.
     */
    @Test
    fun `the report carries no token, no credential and no URL`() = runTest {
        val report = checks().run()
        val text = ConnectionDoctor.formatReport(report, "android 1.2.3", "Android 15")
        assertFalse(text.contains("a.session.token"))
        assertFalse(text.contains("secret-credential"))
        assertFalse(text.contains("127.0.0.1"))
        assertFalse(text.contains("turn.example"))
        assertTrue(text.contains("token  present"))
    }

    @Test
    fun `a probe that throws is a failed check, not a crashed run`() = runTest {
        val prober = IceProber { _, _, _ -> throw IOException("no network") }
        val report = checks(prober = prober).run()
        assertEquals(CheckVerdict.Fail, report.results.first { it.id == CheckId.Stun }.verdict)
        assertEquals("IOException", report.results.first { it.id == CheckId.Stun }.detail)
        assertEquals(Advice.NoUdp, report.advice)
    }
}
