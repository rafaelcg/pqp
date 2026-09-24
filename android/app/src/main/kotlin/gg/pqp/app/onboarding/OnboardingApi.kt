package gg.pqp.app.onboarding

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.Backend
import gg.pqp.app.core.Channel
import gg.pqp.app.core.Invite
import gg.pqp.app.core.Me
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.ServerSummary
import java.io.IOException
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * The endpoints first run needs and nothing else on Android called yet.
 *
 * Extensions on [ApiClient] rather than members, the way `AccountApi.kt` adds
 * its two: they are one feature's calls, and the client's body stays about
 * plumbing.
 */

/** `PATCH /api/me`. Only the keys that changed go on the wire. */
@Serializable
data class UpdateMeRequest(
    val displayName: String? = null,
    val username: String? = null,
    val avatarUrl: String? = null,
)

suspend fun ApiClient.updateMe(request: UpdateMeRequest): Me {
    val body = PqpJson.encodeToString(UpdateMeRequest.serializer(), request)
    return decode(
        execute(
            Request.Builder()
                .url(url("/api/me"))
                .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    )
}

@Serializable
private data class OnboardedPatch(val onboardedAt: String)

/**
 * `PATCH /api/me/preferences` with `onboardedAt`, which closes the wizard on
 * every device. The body is the merged preferences and nothing reads it.
 */
suspend fun ApiClient.markOnboarded(nowIso: String) {
    val body = PqpJson.encodeToString(OnboardedPatch.serializer(), OnboardedPatch(nowIso))
    execute(
        Request.Builder()
            .url(url("/api/me/preferences"))
            .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
    ).close()
}

// ------------------------------------------------------------ invite preview

/** `publicInvitePreviewSchema` in `packages/shared/src/api.ts`. */
@Serializable
data class InvitePreview(
    val serverName: String,
    val iconUrl: String? = null,
    val memberCount: Int = 0,
)

@Serializable
private data class InvitePreviewResponse(val invite: InvitePreview? = null)

/**
 * `GET /api/public/invites/:code`: the server an invite opens, before the
 * person has an account.
 *
 * NO AUTH HEADER, and deliberately not through [ApiClient.execute], which
 * attaches one. The route is public and sits before the Bearer resolution, so
 * a stale token could only turn a preview into a 401 (pitfall 16 in
 * `CLAUDE.md` is that exact shape).
 *
 * Every failure is "no preview", never an error: 404 (unknown, revoked,
 * expired, or an API without the route yet), 429 from the anonymous limiter,
 * a dropped connection, or a body that is not the shape above. The screens
 * then show their generic copy, and nothing else depends on it.
 */
suspend fun fetchInvitePreview(
    http: OkHttpClient,
    code: String,
    apiUrl: String = Backend.apiUrl,
): InvitePreview? {
    if (!gg.pqp.app.invites.InviteLinks.isUsableCode(code)) return null
    val url = "$apiUrl/api/public/invites/$code".toHttpUrlOrNull() ?: return null
    val call = http.newCall(
        Request.Builder().url(url).header("Accept", "application/json").get().build(),
    )
    val raw = suspendCancellableCoroutine<String?> { continuation ->
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (continuation.isActive) continuation.resume(null)
            }

            override fun onResponse(call: Call, response: Response) {
                val text = response.use {
                    if (it.isSuccessful) runCatching { it.body.string() }.getOrNull() else null
                }
                if (continuation.isActive) continuation.resume(text)
            }
        })
    } ?: return null
    return parseInvitePreview(raw)
}

/** `{ invite: InvitePreview }`, validated; anything else is no preview. */
fun parseInvitePreview(raw: String): InvitePreview? =
    runCatching { PqpJson.decodeFromString(InvitePreviewResponse.serializer(), raw).invite }
        .getOrNull()
        ?.takeIf { it.serverName.isNotBlank() }

// ------------------------------------------------------------ discord import

@Serializable
private data class DiscordImportSource(val source: String)

/**
 * The part of `DiscordImportPlan` (`packages/shared/src/discord-import.ts`)
 * the preview draws. The server keeps the rest and re-derives it on apply
 * from the same source, so nothing here is sent back.
 */
@Serializable
data class DiscordImportPlan(
    val serverName: String,
    val iconUrl: String? = null,
    val channels: List<DiscordImportChannel> = emptyList(),
    val roles: List<DiscordImportRole> = emptyList(),
)

@Serializable
data class DiscordImportChannel(
    val templateId: Long,
    val parentTemplateId: Long? = null,
    val type: String,
    val name: String,
    val position: Int = 0,
    val isPrivate: Boolean = false,
)

@Serializable
data class DiscordImportRole(val name: String)

@Serializable
data class DiscordImportResult(
    val server: ServerSummary,
    val channels: List<Channel> = emptyList(),
    val invite: Invite? = null,
)

suspend fun ApiClient.previewDiscordImport(source: String): DiscordImportPlan =
    postJson("/api/import/discord/preview", source)

suspend fun ApiClient.applyDiscordImport(source: String): DiscordImportResult =
    postJson("/api/import/discord/apply", source)

private suspend inline fun <reified T> ApiClient.postJson(path: String, source: String): T {
    val body = PqpJson.encodeToString(DiscordImportSource.serializer(), DiscordImportSource(source))
    return decode(
        execute(
            Request.Builder()
                .url(url(path))
                .post(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    )
}
