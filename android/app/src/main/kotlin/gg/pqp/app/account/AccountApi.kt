package gg.pqp.app.account

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * The two rights the privacy policy promises, as endpoints.
 *
 * Extensions on `ApiClient` for the same reason the social ones are: the fresh
 * token, the cancellable call and the `{"error": …}` body turned into an
 * `ApiException` are exactly what these need and none of it has to change.
 */

/**
 * `GET /api/me/export`, as bytes.
 *
 * Not decoded here on purpose. The export is the server's own JSON document
 * with its own shape and its own filename, and the only thing this client does
 * with it is hand it to whatever the user picked in the system file picker.
 * Parsing it into Kotlin would be inventing a second copy of a schema nothing
 * here reads.
 */
suspend fun ApiClient.exportMyData(): ByteArray =
    execute(Request.Builder().url(url("/api/me/export")).get()).use { it.body.bytes() }

/**
 * `DELETE /api/me`. Irreversible, and real: there is no soft-delete flag
 * anywhere behind this.
 *
 * The 409 is turned into [AccountDeletionBlocked] rather than an error string,
 * because it is not an error message. It is a list of things to go and do, each
 * with two remedies, and the screen renders it by name.
 */
suspend fun ApiClient.deleteMyAccount(confirm: String) {
    val body = PqpJson.encodeToString(
        DeleteAccountRequest.serializer(),
        DeleteAccountRequest(confirm),
    )
    try {
        execute(
            Request.Builder()
                .url(url("/api/me"))
                .delete(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ).close()
    } catch (refusal: ApiException) {
        throw refusal.asBlockedOrItself()
    }
}

/**
 * A 409 carrying `code: "owned_servers"`, read out of the raw body.
 *
 * Defensive about the shape rather than strict: a malformed `servers` array
 * must still surface the server's sentence, because the alternative is a delete
 * button that fails silently, which is worse than no delete button at all.
 */
private fun ApiException.asBlockedOrItself(): Throwable {
    if (status != 409 || code != "owned_servers") return this
    val rows = (body?.get("servers") as? JsonArray).orEmpty()
        .mapNotNull { element ->
            runCatching {
                PqpJson.decodeFromJsonElement(BlockingOwnedServer.serializer(), element)
            }.getOrNull()
        }
    val sentence = serverMessage
        ?: body?.get("error")?.jsonPrimitive?.contentOrNull
        ?: return this
    return AccountDeletionBlocked(sentence, rows)
}

private fun JsonArray?.orEmpty(): List<kotlinx.serialization.json.JsonElement> =
    this ?: emptyList()

@kotlinx.serialization.Serializable
private data class DeleteAccountRequest(val confirm: String)
