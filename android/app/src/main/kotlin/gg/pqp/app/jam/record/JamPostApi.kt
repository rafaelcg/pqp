package gg.pqp.app.jam.record

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.SessionStore
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.JamTrackWithSong
import gg.pqp.app.social.postJson
import java.io.File
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import okio.source

/*
 * The three steps of adding a track (the header of `packages/shared/src/jam.ts`,
 * "THE UPLOAD FLOW"), plus creating the song a first take goes into:
 *
 *   1. `POST /api/jam-songs/:songId/uploads`, a presigned PUT and an `uploadId`;
 *   2. PUT the bytes straight to the bucket with EXACTLY the asked
 *      `Content-Type` and a `Content-Length` of exactly `byteSize` (both are
 *      signed into the URL);
 *   3. `POST /api/jam-songs/:songId/tracks` naming the upload. Retrying it with
 *      the same `audioUploadId` returns the same track, so a retry after a
 *      connection that died with the answer in flight is safe.
 *
 * The audio is FLAC (`audio/flac`, in `JAM_AUDIO_CONTENT_TYPES`): lossless, so a
 * take moves no sample on any client.
 */

@Serializable
data class CreateJamSongRequest(
    val title: String,
    val artist: String? = null,
    val joinMode: String? = null,
    val wantedInstruments: List<String>? = null,
    val nonce: String? = null,
)

@Serializable
data class JamSongResponse(val song: JamSongSummary)

@Serializable
data class CreateJamUploadRequest(val kind: String, val contentType: String, val byteSize: Long)

@Serializable
data class JamUploadTicket(val uploadId: String, val uploadUrl: String, val expiresAt: String = "")

/** `addJamTrackSchema`. No defaults on purpose: every number is sent, so a field equal to the schema's default is not silently dropped. */
@Serializable
data class AddJamTrackRequest(
    val instrument: String,
    val label: String?,
    val audioUploadId: String,
    val durationMs: Int,
    val offsetMs: Double,
    val trimStartMs: Double,
    val trimEndMs: Double,
    val gain: Double,
    val peaks: List<Double>,
)

/** What the studio needs from the network, in one seam so its view model runs on the JVM. */
interface JamPostBackend {
    suspend fun createSong(channelId: String, body: CreateJamSongRequest): JamSongSummary
    suspend fun ticket(songId: String, contentType: String, byteSize: Long): JamUploadTicket
    suspend fun put(ticket: JamUploadTicket, file: File, contentType: String, onProgress: (sent: Long) -> Unit)
    suspend fun addTrack(songId: String, body: AddJamTrackRequest): JamTrackWithSong

    /** The studio cleaning up a song it made and never filled; 409 when a take is in it. */
    suspend fun deleteSongIfEmpty(songId: String)
}

class SessionJamPostBackend(private val session: SessionStore) : JamPostBackend {
    private val api: ApiClient get() = session.api

    override suspend fun createSong(channelId: String, body: CreateJamSongRequest): JamSongSummary =
        api.postJson<JamSongResponse>(
            "/api/channels/$channelId/jam-songs",
            PqpJson.encodeToString(CreateJamSongRequest.serializer(), body),
        ).song

    override suspend fun ticket(songId: String, contentType: String, byteSize: Long): JamUploadTicket =
        api.postJson(
            "/api/jam-songs/$songId/uploads",
            PqpJson.encodeToString(CreateJamUploadRequest.serializer(), CreateJamUploadRequest("audio", contentType, byteSize)),
        )

    override suspend fun put(ticket: JamUploadTicket, file: File, contentType: String, onProgress: (sent: Long) -> Unit) {
        val type = contentType.toMediaType()
        val body = object : RequestBody() {
            override fun contentType() = type
            override fun contentLength() = file.length()
            override fun writeTo(sink: BufferedSink) {
                file.source().use { source ->
                    var sent = 0L
                    val buffer = okio.Buffer()
                    while (true) {
                        val n = source.read(buffer, 64 * 1024)
                        if (n < 0) break
                        sink.write(buffer, n)
                        sent += n
                        onProgress(sent)
                    }
                }
            }
        }
        val request = Request.Builder().url(ticket.uploadUrl).put(body).header("Content-Type", contentType).build()
        // The one call here that blocks: explicitly off the main thread (see `AttachmentApi.upload`).
        withContext(Dispatchers.IO) {
            val call = session.http.newCall(request)
            // Leaving the studio cancels the coroutine, and the PUT stops with it instead of finishing a file nobody will claim.
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

    override suspend fun addTrack(songId: String, body: AddJamTrackRequest): JamTrackWithSong =
        api.postJson("/api/jam-songs/$songId/tracks", PqpJson.encodeToString(AddJamTrackRequest.serializer(), body))

    override suspend fun deleteSongIfEmpty(songId: String) {
        api.execute(Request.Builder().url(api.url("/api/jam-songs/$songId", mapOf("ifEmpty" to "true"))).delete()).close()
    }
}

/** What went wrong with a post, in the terms the screen says (`jam.error.*` on the web). */
enum class PostFailure { Off, Closed, InstrumentNotWanted, SongFull, AuthorLimit, TooLarge, StorageOff, RateLimited, Network, Gone, Other }

fun postFailureOf(e: Throwable): PostFailure {
    if (e is ApiException) {
        return when (e.serverMessage) {
            "jam_channels_off" -> PostFailure.Off
            "jam_song_closed" -> PostFailure.Closed
            "jam_instrument_not_wanted" -> PostFailure.InstrumentNotWanted
            "jam_song_full" -> PostFailure.SongFull
            "jam_author_track_limit" -> PostFailure.AuthorLimit
            "jam_upload_too_large" -> PostFailure.TooLarge
            "jam_storage_off" -> PostFailure.StorageOff
            "jam_rate_limited" -> PostFailure.RateLimited
            else -> when (e.status) {
                404 -> PostFailure.Gone
                413 -> PostFailure.TooLarge
                429 -> PostFailure.RateLimited
                else -> PostFailure.Other
            }
        }
    }
    return if (e is IOException) PostFailure.Network else PostFailure.Other
}
