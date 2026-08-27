package gg.pqp.app.core

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody

/**
 * A refusal the UI can say something about.
 *
 * Every error body in this API is `{"error": string}`, so the server's own
 * sentence is carried through rather than replaced: only the server knows
 * whether an invite was expired, revoked, exhausted, or the caller banned.
 *
 * [body] is the whole thing, undecoded, because a few refusals carry more than
 * a sentence and the caller has to *act* on it. `DELETE /api/me` answers 409
 * with the communities blocking deletion listed by name; reducing that to its
 * message would leave somebody to go and work out for themselves which
 * community is the problem, which is exactly what the server took the trouble
 * to avoid.
 */
class ApiException(
    val status: Int,
    val serverMessage: String?,
    val code: String? = null,
    val body: JsonObject? = null,
) : IOException(serverMessage ?: "HTTP $status") {
    val isUnauthorized: Boolean get() = status == 401
    val isAgeGated: Boolean get() = status == 403
}

class ApiClient(
    private val tokens: TokenProvider,
    val http: OkHttpClient = defaultHttpClient(),
    @PublishedApi internal val json: Json = PqpJson,
    private val baseUrl: String = Backend.apiUrl,
) {
    suspend fun me(): Me = get("/api/me")

    suspend fun submitAgeCheck(dateOfBirth: String): String {
        val body = json.encodeToString(AgeDeclaration.serializer(), AgeDeclaration(dateOfBirth))
        return post<AgeCheckResponse>("/api/me/age-check", body).ageGate
    }

    suspend fun servers(): List<ServerSummary> =
        get<ServersResponse>("/api/servers").servers

    suspend fun createServer(name: String): CreateServerResponse {
        val body = json.encodeToString(CreateServerRequest.serializer(), CreateServerRequest(name))
        return post("/api/servers", body)
    }

    /**
     * `DELETE /api/servers/:serverId`. Owner only, and irreversible: the
     * channels, every message in them and every membership go with it.
     *
     * The body is `{"ok": true}` and nothing reads that flag, so the response
     * is closed rather than decoded. A refusal still arrives as an
     * [ApiException] carrying the server's own sentence, which is the only
     * thing that knows whether the caller stopped being the owner meanwhile.
     */
    suspend fun deleteServer(serverId: String) {
        execute(Request.Builder().url(url("/api/servers/$serverId")).delete()).close()
    }

    /**
     * `POST /api/servers/:serverId/leave`.
     *
     * Refused with a 400 for an owner, in the server's own words, because
     * leaving would strand the community with nobody who can administer it.
     * Show that sentence rather than a local guess about why.
     */
    suspend fun leaveServer(serverId: String) {
        execute(
            Request.Builder()
                .url(url("/api/servers/$serverId/leave"))
                .post("{}".toRequestBody(JSON_MEDIA_TYPE)),
        ).close()
    }

    suspend fun channels(serverId: String): List<Channel> =
        get<ChannelsResponse>("/api/servers/$serverId/channels").channels

    /**
     * Oldest-first, always. `before` walks backwards through history while
     * `hasMore`; only one cursor may be set per call, which the server enforces
     * with a 400 rather than picking one.
     */
    suspend fun messages(
        channelId: String,
        limit: Int = 50,
        before: String? = null,
        after: String? = null,
    ): MessagesResponse = get(
        "/api/channels/$channelId/messages",
        buildMap {
            put("limit", limit.coerceIn(1, 100).toString())
            before?.let { put("before", it) }
            after?.let { put("after", it) }
        },
    )

    /**
     * Redeem an invite code and answer with the server it let us into.
     *
     * A refusal is a 400 carrying the server's own sentence, and it is the only
     * thing that knows which refusal it was: expired, revoked, out of uses, or
     * the caller banned. Show it verbatim; a friendlier local paraphrase would
     * be a guess.
     */
    suspend fun joinInvite(code: String): JoinInviteResponse =
        post("/api/invites/$code/join", "{}")

    /**
     * A fresh read URL for one attachment.
     *
     * The URL baked into a message is presigned and expires, so a channel left
     * open for longer than `ATTACHMENT_URL_TTL_SECONDS` is a channel whose
     * videos will not play. The web client answers the first media error by
     * re-minting exactly once (`fetchAttachmentUrl` in `attachment-grid.tsx`)
     * and this is the same contract, bounded the same way: a second failure is
     * a real failure and gets said out loud rather than retried forever.
     */
    suspend fun attachmentUrl(attachmentId: String): String =
        get<AttachmentUrlResponse>("/api/attachments/$attachmentId/url").url

    suspend fun iceServers(): List<IceServer> =
        get<IceServersResponse>("/api/ice-servers").iceServers

    suspend fun voiceBackend(): String =
        get<VoiceBackendResponse>("/api/voice/backend").backend

    // --- plumbing ---

    private suspend inline fun <reified T> get(
        path: String,
        query: Map<String, String> = emptyMap(),
    ): T {
        val url = url(path, query)
        val response = execute(Request.Builder().url(url).get())
        return decode(response)
    }

    private suspend inline fun <reified T> post(path: String, body: String): T {
        val request = Request.Builder()
            .url(url(path))
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
        return decode(execute(request))
    }

    fun url(path: String, query: Map<String, String> = emptyMap()): HttpUrl {
        val base = (baseUrl + path).toHttpUrlOrNull()
            ?: throw IllegalArgumentException("Not a URL: $baseUrl$path")
        if (query.isEmpty()) return base
        return base.newBuilder().apply {
            query.forEach { (key, value) -> addQueryParameter(key, value) }
        }.build()
    }

    /**
     * Resolves a **fresh** token per request, then hands the call to OkHttp.
     *
     * The suspension is cancellable and cancels the call, so a screen that goes
     * away mid-request does not leave a socket held open behind it.
     *
     * **The body is read here, on OkHttp's own dispatcher thread, and the
     * response handed back carries an in-memory copy of it.** That is not an
     * optimisation, it is the fix for a bug that made every long channel look
     * empty.
     *
     * `continuation.resume` resumes on the *coroutine's* dispatcher, and every
     * caller of this is a `viewModelScope.launch`, which is `Dispatchers.Main`.
     * So `response.body.string()` in `decode` ran on the main thread, and
     * `SocketInputStream.read` there is a `NetworkOnMainThreadException`.
     *
     * It only ever fired on *large* responses, which is what made it look like
     * a network fault. A small body is already sitting in okio's buffer by the
     * time the headers have been parsed, so reading it touches no socket and
     * StrictMode never sees anything; a body past that buffer has to go back to
     * the socket for the rest and throws. The boundary was around 5 KB, so a
     * short channel loaded and a real one did not.
     *
     * Reading it here means no caller can reach the socket from the wrong
     * thread, whatever it does with the response afterwards. `close()` and
     * `use {}` on the returned response stay correct and become no-ops.
     */
    suspend fun execute(builder: Request.Builder): Response {
        val token = tokens.currentToken()
        if (token != null) builder.header("Authorization", "Bearer $token")
        builder.header("Accept", "application/json")

        val call = http.newCall(builder.build())
        val response = suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    if (!continuation.isActive) {
                        response.close()
                        return
                    }
                    val buffered = try {
                        response.use {
                            val bytes = it.body.bytes()
                            it.newBuilder()
                                .body(bytes.toResponseBody(it.body.contentType()))
                                .build()
                        }
                    } catch (e: IOException) {
                        continuation.resumeWithException(e)
                        return
                    }
                    continuation.resume(buffered)
                }
            })
        }

        if (!response.isSuccessful) {
            val raw = runCatching { response.body.string() }.getOrNull()
            response.close()
            val parsed = raw?.let { runCatching { json.decodeFromString<ApiError>(it) }.getOrNull() }
            val body = raw?.let {
                runCatching { json.decodeFromString(JsonObject.serializer(), it) }.getOrNull()
            }
            throw ApiException(response.code, parsed?.error, parsed?.code, body)
        }
        return response
    }

    inline fun <reified T> decode(response: Response): T = response.use {
        json.decodeFromString<T>(it.body.string())
    }

    companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        /**
         * One client for HTTP, WebSocket and image loading, which is what lets
         * them share a connection pool and one DNS cache.
         *
         * There is deliberately **no call timeout**: OkHttp's `callTimeout`
         * bounds the whole exchange, and a WebSocket *is* one exchange, so a
         * ceiling here would kill every socket on schedule. `docs/IOS.md`
         * records that exact failure on URLSession, where it looked like a live
         * connection that silently dropped everything it was asked to send.
         * Reads are bounded by `pingInterval` instead.
         */
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}

@kotlinx.serialization.Serializable
data class AgeDeclaration(val dateOfBirth: String)

@kotlinx.serialization.Serializable
data class AgeCheckResponse(val ageGate: String)
