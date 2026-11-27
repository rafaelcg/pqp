package gg.pqp.app.jam

import android.content.Context
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.mapNotNull

/**
 * Everything the jam screens read from the outside world, in one seam, so the
 * view models run on the JVM against a fake (`JamWallViewModelTest`).
 */
interface JamBackend {
    val viewerId: String?

    /** The seven jam frames, decoded; every other frame is dropped here. */
    val frames: Flow<JamFrame>
    val connection: Flow<RealtimeState>

    suspend fun config(serverId: String): JamConfig
    suspend fun songs(channelId: String, cursor: String? = null, limit: Int = JamLimits.PAGE_SIZE): JamSongListResponse
    suspend fun song(songId: String): JamSongDetailResponse
    suspend fun vote(trackId: String, voted: Boolean): JamVoteResponse
    suspend fun setInMix(trackId: String, inMix: Boolean): JamTrackWithSong
    suspend fun deleteTrack(trackId: String)
    suspend fun deleteSong(songId: String)

    /** The track's author's edit of its volume, place in time and trims. */
    suspend fun updateTrack(trackId: String, request: UpdateJamTrackRequest): JamTrackWithSong

    /** The song's title and artist: its author or a moderator. */
    suspend fun updateSong(songId: String, patch: SongPatch): JamSongSummary

    /**
     * A cover's first two steps: a ticket for exactly these bytes and the PUT to the bucket, with [onProgress] as the
     * fraction sent. Returns the upload id, which [setCover] claims.
     */
    suspend fun uploadCover(songId: String, jpeg: ByteArray, onProgress: (Float) -> Unit): String
    suspend fun setCover(songId: String, uploadId: String): JamSongSummary
    suspend fun removeCover(songId: String): JamSongSummary

    /**
     * The song's public state, read for its starter or a participant (null for anybody else, and while public jam is
     * off): what the share button needs to know ("is there a public page a stranger can open"), and whether outside parts
     * are accepted by themselves. A default so a fake that does not care need not say.
     */
    suspend fun publication(songId: String): JamPublication? = null

    /** The jam channel takes the socket's primary slot: its frames are fanned out to its viewers. */
    fun join(channelId: String)

    /** Give the primary slot back, if it is still ours (a chat opened since keeps its own). */
    fun leave(channelId: String)
}

/** The live backend: the session's API and socket. */
class SessionJamBackend(private val session: SessionStore) : JamBackend {
    override val viewerId: String?
        get() = (session.phase.value as? SessionPhase.Ready)?.me?.id

    override val frames: Flow<JamFrame>
        get() = session.realtime.frames
            .filter { JamFrame.isJam(it) }
            .mapNotNull { JamFrame.decode(it) }

    override val connection: Flow<RealtimeState> get() = session.realtime.state

    override suspend fun config(serverId: String) = session.api.jamConfig(serverId)
    override suspend fun songs(channelId: String, cursor: String?, limit: Int) =
        session.api.jamSongs(channelId, cursor, limit)

    override suspend fun song(songId: String) = session.api.jamSong(songId)
    override suspend fun vote(trackId: String, voted: Boolean) =
        if (voted) session.api.voteJamTrack(trackId) else session.api.unvoteJamTrack(trackId)

    override suspend fun setInMix(trackId: String, inMix: Boolean) = session.api.setJamTrackInMix(trackId, inMix)
    override suspend fun deleteTrack(trackId: String) = session.api.deleteJamTrack(trackId)
    override suspend fun deleteSong(songId: String) = session.api.deleteJamSong(songId)

    override suspend fun updateTrack(trackId: String, request: UpdateJamTrackRequest) =
        session.api.updateJamTrack(trackId, request)

    override suspend fun updateSong(songId: String, patch: SongPatch) = session.api.updateJamSong(songId, patch)

    override suspend fun uploadCover(songId: String, jpeg: ByteArray, onProgress: (Float) -> Unit): String {
        val ticket = session.api.jamCoverTicket(songId, JamCover.SEND_TYPE, jpeg.size.toLong())
        putJamCover(session.http, ticket.uploadUrl, jpeg, onProgress)
        return ticket.uploadId
    }

    override suspend fun publication(songId: String) = session.api.jamPublication(songId)

    override suspend fun setCover(songId: String, uploadId: String) = session.api.setJamCover(songId, uploadId)
    override suspend fun removeCover(songId: String) = session.api.removeJamCover(songId)

    override fun join(channelId: String) {
        session.realtime.joinChannel(channelId)
    }

    override fun leave(channelId: String) {
        session.realtime.leaveChannel(channelId)
    }
}

/**
 * The newest bump this device saw per jam channel: a per-device convenience,
 * losing it costs one dot. Plain preferences, every access guarded.
 */
class JamSeenStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("pqp.jam", Context.MODE_PRIVATE)

    fun lastSeenMs(channelId: String): Long? =
        runCatching { prefs.getLong(KEY + channelId, 0L) }.getOrDefault(0L).takeIf { it > 0 }

    fun markSeen(channelId: String, ms: Long) {
        runCatching { prefs.edit().putLong(KEY + channelId, ms).apply() }
    }

    private companion object {
        const val KEY = "seen."
    }
}
