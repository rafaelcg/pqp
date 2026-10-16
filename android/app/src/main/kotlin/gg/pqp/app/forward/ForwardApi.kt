package gg.pqp.app.forward

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.getJson
import gg.pqp.app.social.postJson
import java.util.WeakHashMap

/**
 * Encaminhar, as endpoints. Extensions on [ApiClient] like the Baú's and the
 * social ones: the plumbing already there is all they need.
 */

/** `GET /api/forwards/config`: `{ enabled }`, the runtime flag `forward_messages`. */
suspend fun ApiClient.forwardConfig(): ForwardConfig = getJson("/api/forwards/config")

/**
 * `POST /api/forwards`. Answers 200 once the request itself was valid, with one
 * result per target; a refusal per target is in `results`, not an exception.
 * Request-level failures (404 flag off or source gone, 422 not forwardable, 429)
 * throw [ApiException].
 */
suspend fun ApiClient.createForward(request: CreateForwardRequest): CreateForwardResponse =
    postJson(
        "/api/forwards",
        PqpJson.encodeToString(CreateForwardRequest.serializer(), request),
    )

/**
 * Whether the Encaminhar action is offered, asked per use rather than once per
 * session: this is a runtime flag an operator flips from a dashboard, and the
 * phone should follow it within a minute, not at the next cold start.
 *
 * OFF ON ANY FAILURE. A 404 (the instance predates the route) and a transport
 * failure both read as off, and only a real answer is kept, for [TTL_MS]. A
 * failure is never cached, so a phone that opened its first chat in a tunnel
 * gets the real answer on the next open. The flag gates creation only; cards
 * already in history keep drawing with it off.
 */
object ForwardConfigs {

    const val TTL_MS = 60_000L

    private data class Entry(val enabled: Boolean, val at: Long)

    private val cache = WeakHashMap<ApiClient, Entry>()

    suspend fun enabled(
        api: ApiClient,
        now: () -> Long = System::currentTimeMillis,
        fetch: suspend () -> ForwardConfig = { api.forwardConfig() },
    ): Boolean {
        synchronized(cache) { cache[api] }?.let { if (now() - it.at < TTL_MS) return it.enabled }
        val config = try {
            fetch()
        } catch (failure: ApiException) {
            // A 404 is "no such route, or the flag is off": a real answer.
            if (failure.status == 404) ForwardConfig() else return false
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return false
        }
        synchronized(cache) { cache[api] = Entry(config.enabled, now()) }
        return config.enabled
    }

    /** Tests only. */
    internal fun clear() = synchronized(cache) { cache.clear() }
}
