package gg.pqp.app.jam

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.PqpJson
import gg.pqp.app.social.deleteJson
import gg.pqp.app.social.getJson
import kotlinx.coroutines.CancellationException
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/*
 * The jam routes this build uses (the REST table at the top of
 * `packages/shared/src/jam.ts`), as extensions on [ApiClient] for the reason
 * `SocialApi` gives: the plumbing there is what these need. Reading, voting,
 * the in-mix switch and the two deletes. Creating a song and adding a track are
 * not here: recording is on the computer for now.
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
    decode(
        execute(
            Request.Builder()
                .url(url("/api/jam-tracks/$trackId"))
                .patch(
                    PqpJson.encodeToString(UpdateJamTrackRequest.serializer(), UpdateJamTrackRequest(inMix))
                        .toRequestBody(ApiClient.JSON_MEDIA_TYPE),
                ),
        ),
    )

suspend fun ApiClient.deleteJamTrack(trackId: String) {
    execute(Request.Builder().url(url("/api/jam-tracks/$trackId")).delete()).close()
}

suspend fun ApiClient.deleteJamSong(songId: String) {
    execute(Request.Builder().url(url("/api/jam-songs/$songId")).delete()).close()
}

/** The deep link a "Copiar link" hands out: the web's route for the same song. */
fun jamSongLink(baseUrl: String, serverId: String, channelId: String, songId: String): String =
    "${baseUrl.trimEnd('/')}/app/server/$serverId/channel/$channelId/song/$songId"
