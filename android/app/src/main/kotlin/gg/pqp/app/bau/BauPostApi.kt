package gg.pqp.app.bau

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.postJson
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody

/**
 * Publishing, as endpoints. Everything below answers 403 to anybody without
 * `MANAGE_SERVER` and 404 while the instance flag is off; the compose button
 * is only drawn when both are known to be fine ([BauComposeGate]), and the
 * refusal is still handled, because the permission can change under an open
 * screen.
 */

suspend fun ApiClient.createBauPost(serverId: String, request: CreateBauPostRequest): BauPost =
    postJson<CreateBauPostResponse>(
        "/api/servers/$serverId/home/posts",
        PqpJson.encodeToString(CreateBauPostRequest.serializer(), request),
    ).post

suspend fun ApiClient.mintBauMedia(serverId: String, request: MintBauMediaRequest): MintBauMediaResponse =
    postJson(
        "/api/servers/$serverId/home/media",
        PqpJson.encodeToString(MintBauMediaRequest.serializer(), request),
    )

suspend fun ApiClient.claimBauMedia(serverId: String, uploadId: String): ClaimBauMediaResponse =
    postJson(
        "/api/servers/$serverId/home/media/claim",
        PqpJson.encodeToString(ClaimBauMediaRequest.serializer(), ClaimBauMediaRequest(uploadId)),
    )

/**
 * A picked file, all the way to a claimed upload id: the same mint, PUT, claim
 * dance chat attachments do (`AttachmentApi`), against the Baú's own routes.
 *
 *  1. mint: the server signs a PUT for exactly this type and length;
 *  2. PUT: the bytes go straight to storage, never through the API;
 *  3. claim: the server HEADs the object and marks it verified.
 *
 * The id it returns is not attached to anything yet; it rides on the create
 * call as `mediaUploadId`, which is what claims it onto a post.
 *
 * FROM A FILE, NOT A BYTE ARRAY. Chat attachments are capped at 10 MiB and
 * read whole; a Baú clip can be 100 MiB, and an array that size is an
 * out-of-memory kill on a mid-range phone. The file also settles the one fact
 * the signature depends on: the length minted and the length sent are the same
 * `File.length()`.
 *
 * The PUT is built against the raw client for the reason `AttachmentApi.upload`
 * gives: storage refuses a request that also carries our Bearer header.
 */
class BauMediaUploader(private val api: ApiClient) {

    suspend fun upload(serverId: String, file: File, contentType: String, filename: String): String {
        val minted = api.mintBauMedia(
            serverId,
            MintBauMediaRequest(contentType = contentType, byteSize = file.length(), filename = filename),
        )
        put(minted.uploadUrl, contentType, file)
        return api.claimBauMedia(serverId, minted.uploadId).uploadId
    }

    private suspend fun put(uploadUrl: String, contentType: String, file: File) {
        val request = Request.Builder()
            .url(uploadUrl)
            .put(file.asRequestBody(contentType.toMediaTypeOrNull()))
            .header("Content-Type", contentType)
            .build()
        withContext(Dispatchers.IO) {
            api.http.newCall(request).execute().use { response ->
                check(response.isSuccessful) { "Upload refused with HTTP ${response.code}" }
            }
        }
    }
}
