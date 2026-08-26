package gg.pqp.app.attachments

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * `GET /api/attachments/config`.
 *
 * Both fields ride along in both states on purpose: `maxBytes` is present even
 * when the feature is off, so a picker can reject an over-size file against
 * this deployment's own cap instead of discovering it as a 413.
 *
 * Defaulted so that an older server, or a response this client does not fully
 * understand, reads as "off" rather than throwing. Off is the honest answer for
 * a deployment with no `S3_*` configured, which is most self-hosts.
 */
@Serializable
data class AttachmentConfig(
    val enabled: Boolean = false,
    val maxBytes: Long = DEFAULT_MAX_ATTACHMENT_BYTES,
)

/** Body of `POST /api/channels/:channelId/attachments`. */
@Serializable
data class CreateAttachmentRequest(
    val filename: String,
    val contentType: String,
    val byteSize: Long,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class CreateAttachmentResponse(
    val attachmentId: String,
    val uploadUrl: String,
    val expiresAt: String = "",
)

/**
 * The three calls an upload takes, and the one of them that must not look like
 * the others.
 *
 * Minting goes through [ApiClient] like everything else. The **PUT does not**:
 * it is addressed to object storage, not to this API, and it is signed in the
 * query string. Sending our `Authorization: Bearer` header along with it makes
 * S3 refuse the request outright as doubly authenticated, so the upload is
 * built against the raw OkHttp client instead of borrowing the one wrapper that
 * would helpfully add the header.
 */
class AttachmentApi(private val api: ApiClient) {

    suspend fun config(): AttachmentConfig =
        api.decode(api.execute(Request.Builder().url(api.url("/api/attachments/config")).get()))

    suspend fun mint(
        channelId: String,
        request: CreateAttachmentRequest,
    ): CreateAttachmentResponse {
        val body = PqpJson.encodeToString(CreateAttachmentRequest.serializer(), request)
        return api.decode(
            api.execute(
                Request.Builder()
                    .url(api.url("/api/channels/$channelId/attachments"))
                    .post(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
            ),
        )
    }

    /**
     * PUT the bytes straight to storage.
     *
     * Both `Content-Type` **and** `Content-Length` are signed into the URL, so
     * a body of a different type or a different length fails the signature
     * rather than being stored. OkHttp sets the length from the array; the type
     * has to match the one that was minted exactly, which is why the caller
     * passes the same string it declared rather than re-deriving it here.
     *
     * The failure is thrown, not swallowed. An upload that quietly did not
     * happen becomes an attachment the claim drops, and a message that arrives
     * with a picture missing and no explanation anywhere.
     *
     * Explicitly on the IO dispatcher, because this is the one call in the app
     * that blocks: every caller is a `viewModelScope.launch`, which is
     * `Dispatchers.Main`, and a socket read there is
     * `NetworkOnMainThreadException`. `ApiClient.execute` avoids it by being
     * callback-based; this does not have that luxury and must say so.
     */
    suspend fun upload(uploadUrl: String, contentType: String, bytes: ByteArray) {
        val request = Request.Builder()
            .url(uploadUrl)
            .put(bytes.toRequestBody(contentType.toMediaTypeOrNull()))
            .header("Content-Type", contentType)
            .build()

        withContext(Dispatchers.IO) {
            api.http.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "Upload refused with HTTP ${response.code}" }
            }
        }
    }
}
