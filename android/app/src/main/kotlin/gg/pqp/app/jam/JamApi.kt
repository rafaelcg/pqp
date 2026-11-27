package gg.pqp.app.jam

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.jam.record.CreateJamUploadRequest
import gg.pqp.app.jam.record.JamSongResponse
import gg.pqp.app.jam.record.JamUploadTicket
import gg.pqp.app.social.OkResponse
import gg.pqp.app.social.deleteJson
import gg.pqp.app.social.getJson
import gg.pqp.app.social.postJson
import java.io.IOException
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink

/*
 * The jam routes this build uses (the REST table at the top of
 * `packages/shared/src/jam.ts`), as extensions on [ApiClient] for the reason
 * `SocialApi` gives: the plumbing there is what these need. Reading, voting,
 * the in-mix switch, the adjustments of a track, the edit of a song and its cover, and the two
 * deletes. Creating a song and adding a track are `record/JamPostApi.kt`.
 */

/**
 * The `jam_channels` flag for [serverId]. Off on any failure: an unflagged
 * server must look exactly as it did before, so a lookup that did not answer
 * draws nothing rather than a row that may 404. A cancelled lookup is not a
 * failure and is rethrown.
 */
suspend fun ApiClient.jamConfig(serverId: String): JamConfig =
    try {
        getJson("/api/jam/config", mapOf("serverId" to serverId))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        JamConfig.Off
    }

/** `GET /api/channels/:channelId/jam-songs`, newest bump first. */
suspend fun ApiClient.jamSongs(
    channelId: String,
    cursor: String? = null,
    limit: Int = JamLimits.PAGE_SIZE,
): JamSongListResponse {
    val query = buildMap {
        put("limit", limit.coerceIn(1, JamLimits.PAGE_MAX).toString())
        if (cursor != null) put("cursor", cursor)
    }
    return getJson("/api/channels/$channelId/jam-songs", query)
}

/** `GET /api/jam-songs/:songId`: the song, its tracks with fresh media URLs, and what the caller may do. */
suspend fun ApiClient.jamSong(songId: String): JamSongDetailResponse = getJson("/api/jam-songs/$songId")

suspend fun ApiClient.voteJamTrack(trackId: String): JamVoteResponse =
    decode(
        execute(
            Request.Builder()
                .url(url("/api/jam-tracks/$trackId/vote"))
                .put("{}".toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    )

suspend fun ApiClient.unvoteJamTrack(trackId: String): JamVoteResponse = deleteJson("/api/jam-tracks/$trackId/vote")

/** The in-mix switch: the song's author's or a moderator's alone. */
suspend fun ApiClient.setJamTrackInMix(trackId: String, inMix: Boolean): JamTrackWithSong =
    updateJamTrack(trackId, UpdateJamTrackRequest(inMix = inMix))

/**
 * Edit a track: its volume, its place in time and what is cut off its ends. The TRACK's AUTHOR's alone (403 for anybody
 * else, 403 `jam_channels_off` with the flag off, 422 `jam_trim_invalid` for trims that do not fit the file).
 */
suspend fun ApiClient.updateJamTrack(trackId: String, request: UpdateJamTrackRequest): JamTrackWithSong =
    decode(
        execute(
            Request.Builder()
                .url(url("/api/jam-tracks/$trackId"))
                .patch(
                    PqpJson.encodeToString(UpdateJamTrackRequest.serializer(), request)
                        .toRequestBody(ApiClient.JSON_MEDIA_TYPE),
                ),
        ),
    )

/** `PATCH /api/jam-songs/:songId`: the title and the artist. The song's author or a moderator, flag on. */
suspend fun ApiClient.updateJamSong(songId: String, patch: SongPatch): JamSongSummary =
    decode<JamSongResponse>(
        execute(
            Request.Builder()
                .url(url("/api/jam-songs/$songId"))
                .patch(PqpJson.encodeToString(JsonObject.serializer(), patch.toJson()).toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    ).song

/** Step 1 of a cover: a presigned PUT for exactly [byteSize] bytes of [contentType]. */
suspend fun ApiClient.jamCoverTicket(songId: String, contentType: String, byteSize: Long): JamUploadTicket =
    postJson(
        "/api/jam-songs/$songId/uploads",
        PqpJson.encodeToString(CreateJamUploadRequest.serializer(), CreateJamUploadRequest("cover", contentType, byteSize)),
    )

/** Step 3 of a cover: claim the uploaded object as the song's picture. */
suspend fun ApiClient.setJamCover(songId: String, uploadId: String): JamSongSummary =
    decode<JamSongResponse>(
        execute(
            Request.Builder()
                .url(url("/api/jam-songs/$songId/cover"))
                .put("""{"uploadId":"$uploadId"}""".toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
        ),
    ).song

/** Take the picture off. The one cover write the flag does not gate. */
suspend fun ApiClient.removeJamCover(songId: String): JamSongSummary =
    decode<JamSongResponse>(execute(Request.Builder().url(url("/api/jam-songs/$songId/cover")).delete())).song

suspend fun ApiClient.deleteJamTrack(trackId: String) {
    execute(Request.Builder().url(url("/api/jam-tracks/$trackId")).delete()).close()
}

suspend fun ApiClient.deleteJamSong(songId: String) {
    execute(Request.Builder().url(url("/api/jam-songs/$songId")).delete()).close()
}

/**
 * Step 2 of a cover: PUT the bytes straight to the bucket with EXACTLY the asked `Content-Type` and a `Content-Length`
 * of exactly `byteSize` (both are signed into the URL). The one call here that blocks, so it is off the main thread, and
 * leaving the coroutine cancels the request instead of finishing a picture nobody will claim.
 */
internal suspend fun putJamCover(
    http: OkHttpClient,
    uploadUrl: String,
    jpeg: ByteArray,
    onProgress: (Float) -> Unit,
) {
    val type = JamCover.SEND_TYPE.toMediaType()
    val body = object : RequestBody() {
        override fun contentType() = type
        override fun contentLength() = jpeg.size.toLong()
        override fun writeTo(sink: BufferedSink) {
            var sent = 0
            while (sent < jpeg.size) {
                val n = minOf(COVER_CHUNK, jpeg.size - sent)
                sink.write(jpeg, sent, n)
                sent += n
                onProgress(sent.toFloat() / jpeg.size)
            }
        }
    }
    val request = Request.Builder().url(uploadUrl).put(body).header("Content-Type", JamCover.SEND_TYPE).build()
    withContext(Dispatchers.IO) {
        val call = http.newCall(request)
        val handle = coroutineContext[Job]?.invokeOnCompletion { if (it != null) call.cancel() }
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw IOException("Upload refused with HTTP ${response.code}")
            }
        } finally {
            handle?.dispose()
        }
    }
}

private const val COVER_CHUNK = 16 * 1024

// --- take notices (docs/JAM_PUBLIC.md, "Telling the starter") ---

/** `GET /api/jam-public/config`: the flag `jam_public`, which the whole notice machinery sits behind. */
suspend fun ApiClient.jamPublicConfig(): JamPublicMeConfig = getJson("/api/jam-public/config")

/** `GET /api/jam-public/inbox`: the outside takes waiting for this account's answer, on every song it started. */
suspend fun ApiClient.jamPublicInbox(): JamPublicInboxResponse = getJson("/api/jam-public/inbox")

/** `GET /api/jam-public/notices`: the open items (empty while `jam_take_notices` or `jam_public` is off). */
suspend fun ApiClient.jamTakeNotices(): JamTakeNoticesResponse = getJson("/api/jam-public/notices")

/** `POST /api/jam-public/notices/ack`: the item is spent. Allowed with the flag off: it is the person's own row. */
suspend fun ApiClient.ackJamTakeNotice(id: String) {
    postJson<OkResponse>(
        "/api/jam-public/notices/ack",
        PqpJson.encodeToString(AckJamTakeNoticeRequest.serializer(), AckJamTakeNoticeRequest(id)),
    )
}

/** `GET /api/jam-songs/:id/public`: the starter's (or a participant's) read of the song's public state. Null for anybody else. */
suspend fun ApiClient.jamPublication(songId: String): JamPublication? =
    getJson<JamPublicationResponse>("/api/jam-songs/$songId/public").publication

/** Where a song lives (server and channel), for the deep link that has only its id. */
suspend fun ApiClient.jamSongPlace(songId: String): JamSongPlace.Place =
    getJson<JamSongPlace>("/api/jam-songs/$songId").song

/** The deep link a "Copiar link" hands out: the web's route for the same song. */
fun jamSongLink(baseUrl: String, serverId: String, channelId: String, songId: String): String =
    "${baseUrl.trimEnd('/')}/app/server/$serverId/channel/$channelId/song/$songId"
