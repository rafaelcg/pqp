package gg.pqp.app.core

import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * The connection check: five yes/no questions a stuck client can answer for
 * itself, in the order a person would debug them, each with the fix in plain
 * words. The Android half of `client/src/lib/connection-doctor.ts`; same
 * checks, same verdict rules, same advice, so a report pasted into the QG
 * reads the same whichever app it came from.
 *
 * WHY. "Fica conectando" (2 Sep 2026) on somebody's PC app and phone app, on
 * two networks. The API was healthy for everybody else. From the client that
 * could have been a refused session, a token fetch that never returns (Clerk
 * blocked by a DNS filter), a firewall that lets HTTPS through but not
 * WebSockets, or a network with no path to a TURN relay. All four look
 * identical on screen: a spinner. This tells them apart.
 *
 * Each check is bounded; the whole run is a few seconds, never a hang. The
 * verdicts are pure functions of the results so the mapping is testable on
 * the JVM without a phone.
 */
enum class CheckId(val wire: String) {
    Api("api"),
    Token("token"),
    Socket("socket"),
    Stun("stun"),
    Turn("turn"),
}

enum class CheckVerdict { Ok, Fail, Skip }

data class CheckResult(
    val id: CheckId,
    val verdict: CheckVerdict,
    /** Short machine detail for the copyable report. Never localized. */
    val detail: String,
    val ms: Long,
)

enum class Advice(val wire: String) {
    None("none"),
    SignInAgain("signInAgain"),
    ApiUnreachable("apiUnreachable"),
    TokenStuck("tokenStuck"),
    SocketBlocked("socketBlocked"),
    RelayBlocked("relayBlocked"),
    NoUdp("noUdp"),
}

data class DoctorReport(
    val results: List<CheckResult>,
    /** The one thing to do first, derived from the results. */
    val advice: Advice,
    /** ISO 8601, UTC. */
    val at: String,
)

/** What an ICE gathering run turned up. */
data class IceProbeResult(val host: Boolean, val srflx: Boolean, val relay: Boolean)

/**
 * Gathers ICE candidates against [servers] and reports which kinds showed up.
 * `relayOnly` sets the relay transport policy, so the only candidate that
 * can appear is one that went through TURN. The WebRTC implementation lives
 * in `voice/IceProbe.kt`; this seam is what keeps the runner testable.
 */
fun interface IceProber {
    suspend fun probe(servers: List<IceServer>, relayOnly: Boolean, timeoutMs: Long): IceProbeResult
}

/** The realtime socket as the transport sees it right now. */
data class SocketSnapshot(
    val state: RealtimeState,
    val lastClose: RealtimeClose?,
    val unauthorizedStreak: Int,
)

object ConnectionDoctor {
    const val STEP_TIMEOUT_MS = 8_000L

    /** Where a STUN probe goes when the API offered no STUN server at all. */
    const val FALLBACK_STUN = "stun:stun.cloudflare.com:3478"

    /** Pure: what to tell the person, given the five answers. */
    fun adviseFrom(results: List<CheckResult>, unauthorizedStreak: Int): Advice {
        val by = results.associateBy { it.id }
        val api = by[CheckId.Api]
        val token = by[CheckId.Token]
        val socket = by[CheckId.Socket]
        val stun = by[CheckId.Stun]
        val turn = by[CheckId.Turn]
        return when {
            api?.verdict == CheckVerdict.Fail -> Advice.ApiUnreachable
            token?.verdict == CheckVerdict.Fail ->
                if (token.detail == "timeout") Advice.TokenStuck else Advice.SignInAgain
            socket?.verdict == CheckVerdict.Fail ->
                if (RealtimeClient.refusedForGood(unauthorizedStreak)) Advice.SignInAgain else Advice.SocketBlocked
            turn?.verdict == CheckVerdict.Fail && stun?.verdict == CheckVerdict.Fail -> Advice.NoUdp
            turn?.verdict == CheckVerdict.Fail -> Advice.RelayBlocked
            else -> Advice.None
        }
    }

    /**
     * One line per check, for pasting into a support chat. The same shape as
     * the web's `formatReport`, with the platform line where the browser puts
     * its user agent.
     */
    fun formatReport(report: DoctorReport, appVersion: String, platform: String): String {
        val lines = buildList {
            add("pqp connection check ${report.at} ($appVersion)")
            report.results.forEach { result ->
                val verdict = when (result.verdict) {
                    CheckVerdict.Ok -> "OK "
                    CheckVerdict.Fail -> "FAIL"
                    CheckVerdict.Skip -> "SKIP"
                }
                val ms = if (result.ms > 0) " ${result.ms}ms" else ""
                add("$verdict ${result.id.wire.padEnd(6)} ${result.detail}$ms".trimEnd())
            }
            add("advice: ${report.advice.wire}")
            if (platform.isNotBlank()) add(platform)
        }
        return lines.joinToString("\n")
    }

    fun isoNow(): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date())
    }

    fun describe(error: Throwable): String = when (error) {
        is TimeoutCancellationException -> "timeout"
        else -> error.javaClass.simpleName.ifBlank { error.message.orEmpty() }
    }
}

/**
 * Runs the five checks, in order, handing each result over as it lands.
 *
 * Everything it touches is injected: the HTTP client, the token provider, a
 * snapshot of the socket, the ICE list and the prober. That is what lets the
 * runner itself be exercised on the JVM with a fake of each, and what keeps
 * it from knowing anything about a `Context`.
 */
class ConnectionChecks(
    private val http: OkHttpClient,
    private val apiUrl: String,
    private val tokens: TokenProvider,
    private val socket: () -> SocketSnapshot,
    private val iceServers: suspend () -> List<IceServer>,
    /** Null on a build with no WebRTC, which skips the two ICE checks. */
    private val prober: IceProber?,
    private val stepTimeoutMs: Long = ConnectionDoctor.STEP_TIMEOUT_MS,
) {
    suspend fun run(onResult: (CheckResult) -> Unit = {}): DoctorReport {
        val results = mutableListOf<CheckResult>()
        fun land(result: CheckResult) {
            results += result
            onResult(result)
        }

        // 1. Is the API reachable at all over HTTPS? Any status counts, the
        // same as on the web: the question is reachability, not health. A
        // 503 here is a server with a dead database pool, which is a real
        // answer and not "cannot be reached", and the code goes in the
        // report either way. `/health` rather than the web's
        // `/api/voice/backend` because the CORS reason the web has for
        // avoiding it does not exist on a native client, and `/health` is
        // the one route that needs no token, so it separates "the network"
        // from "the sign-in" cleanly.
        val api = timed { health() }
        land(
            CheckResult(
                id = CheckId.Api,
                verdict = if (api.value != null) CheckVerdict.Ok else CheckVerdict.Fail,
                detail = api.value?.let { "HTTP $it" } ?: api.error?.let(ConnectionDoctor::describe).orEmpty(),
                ms = api.ms,
            ),
        )

        // 2. Can we get a session token in reasonable time?
        val token = timed { withTimeout(stepTimeoutMs) { tokens.currentToken() } }
        val hasToken = !token.value.isNullOrEmpty()
        land(
            CheckResult(
                id = CheckId.Token,
                verdict = if (hasToken) CheckVerdict.Ok else CheckVerdict.Fail,
                detail = when {
                    hasToken -> "present"
                    token.error != null -> ConnectionDoctor.describe(token.error)
                    else -> "null"
                },
                ms = token.ms,
            ),
        )

        // 3. The realtime socket, as the transport sees it right now.
        val snapshot = socket()
        val close = snapshot.lastClose
        land(
            CheckResult(
                id = CheckId.Socket,
                verdict = if (snapshot.state == RealtimeState.Ready) CheckVerdict.Ok else CheckVerdict.Fail,
                detail = snapshot.state.name.lowercase() +
                    (close?.let { " (last close ${it.code}${if (it.reason.isNotBlank()) " ${it.reason}" else ""})" } ?: ""),
                ms = 0,
            ),
        )

        // 4 + 5. Can this network reach a STUN server and a TURN relay?
        val prober = prober
        if (prober == null) {
            land(CheckResult(CheckId.Stun, CheckVerdict.Skip, "no WebRTC", 0))
            land(CheckResult(CheckId.Turn, CheckVerdict.Skip, "no WebRTC", 0))
        } else {
            val servers = if (hasToken) {
                timed { withTimeout(stepTimeoutMs) { iceServers() } }.value ?: emptyList()
            } else {
                emptyList()
            }
            val stunServers = servers.filter { s -> s.urlList.any { it.startsWith("stun:") } }
            val turnServers = servers.filter { s -> s.urlList.any { it.startsWith("turn") } }

            val stun = timed {
                prober.probe(
                    stunServers.ifEmpty { listOf(IceServer(JsonPrimitive(ConnectionDoctor.FALLBACK_STUN))) },
                    relayOnly = false,
                    timeoutMs = stepTimeoutMs,
                )
            }
            land(
                CheckResult(
                    id = CheckId.Stun,
                    verdict = if (stun.value?.srflx == true) CheckVerdict.Ok else CheckVerdict.Fail,
                    detail = stun.value?.let { "host=${it.host} srflx=${it.srflx}" }
                        ?: stun.error?.let(ConnectionDoctor::describe).orEmpty(),
                    ms = stun.ms,
                ),
            )

            if (turnServers.isEmpty()) {
                land(CheckResult(CheckId.Turn, CheckVerdict.Skip, if (hasToken) "no relay configured" else "no token", 0))
            } else {
                val turn = timed { prober.probe(turnServers, relayOnly = true, timeoutMs = stepTimeoutMs) }
                land(
                    CheckResult(
                        id = CheckId.Turn,
                        verdict = if (turn.value?.relay == true) CheckVerdict.Ok else CheckVerdict.Fail,
                        detail = turn.value?.let { "relay=${it.relay}" }
                            ?: turn.error?.let(ConnectionDoctor::describe).orEmpty(),
                        ms = turn.ms,
                    ),
                )
            }
        }

        return DoctorReport(
            results = results.toList(),
            advice = ConnectionDoctor.adviseFrom(results, snapshot.unauthorizedStreak),
            at = ConnectionDoctor.isoNow(),
        )
    }

    /** `GET /health`, answering the status code. No token: the route needs none. */
    private suspend fun health(): Int {
        val client = http.newBuilder()
            .callTimeout(stepTimeoutMs, TimeUnit.MILLISECONDS)
            .build()
        val request = Request.Builder()
            .url("$apiUrl/health")
            .header("Cache-Control", "no-store")
            .get()
            .build()
        val call = client.newCall(request)
        return suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(
                object : Callback {
                    override fun onFailure(call: Call, e: IOException) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                    }

                    override fun onResponse(call: Call, response: Response) {
                        val code = response.use { it.code }
                        if (continuation.isActive) continuation.resume(code)
                    }
                },
            )
        }
    }

    private class Timed<T>(val value: T?, val error: Throwable?, val ms: Long)

    private suspend fun <T> timed(block: suspend () -> T): Timed<T> {
        val started = System.currentTimeMillis()
        return try {
            Timed(block(), null, System.currentTimeMillis() - started)
        } catch (cancelled: CancellationException) {
            if (cancelled is TimeoutCancellationException) {
                Timed(null, cancelled, System.currentTimeMillis() - started)
            } else {
                throw cancelled
            }
        } catch (error: Throwable) {
            Timed(null, error, System.currentTimeMillis() - started)
        }
    }
}
